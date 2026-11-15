// Speech-to-text dictation. Produces editable text for the composer; it never creates or uploads
// an audio message.
//
// Engines:
//  - "local":   Whisper running on this device (WASM). Private: audio never leaves the device.
//  - "browser": the browser's built-in recognizer (Web Speech API). In Chrome and on Android this
//               streams your audio to Google's speech service. Not available in the desktop app.

export type DictationEngine = "local" | "browser";
export type DictationState = "idle" | "requesting" | "recording" | "transcribing" | "error";
export type WhisperModel = "onnx-community/whisper-base.en" | "onnx-community/whisper-tiny.en";

export interface DictationHandlers {
    onState(state: DictationState, detail?: string): void;
    onLevel?(rms: number): void;
    onInterim?(text: string): void;
    onModelProgress?(pct: number): void;
}

const MAX_SECONDS = 300;
const TARGET_RATE = 16000;

type SpeechRecognitionCtor = new () => {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
    onerror: ((e: { error: string }) => void) | null;
    onend: (() => void) | null;
};
const SR = (globalThis as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor })
    .SpeechRecognition ?? (globalThis as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;

export const browserRecognizerAvailable = () => !!SR && !window.orreryDesktop;
export const micSupported = () => !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";

// ---------------------------------------------------------------- whisper worker client
let worker: Worker | null = null;
let seq = 0;
const waiters = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; progress?: (p: number) => void }>();
function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e: MessageEvent<{ id: number; type: string; text?: string; error?: string; progress?: number }>) => {
            const w = waiters.get(e.data.id);
            if (!w) return;
            if (e.data.type === "progress") return w.progress?.(e.data.progress ?? 0);
            waiters.delete(e.data.id);
            if (e.data.type === "error") w.reject(new Error(e.data.error));
            else w.resolve(e.data.text ?? "");
        };
        worker.onerror = (e) => {
            for (const w of waiters.values()) w.reject(new Error(e.message || "Speech engine crashed"));
            waiters.clear();
            worker = null;
        };
    }
    return worker;
}
function callWorker(msg: Record<string, unknown>, progress?: (p: number) => void, transfer: Transferable[] = []): Promise<unknown> {
    const id = ++seq;
    return new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject, progress });
        getWorker().postMessage({ ...msg, id, base: new URL(import.meta.env.BASE_URL, location.href).href }, transfer);
    });
}
export function preloadWhisper(model: WhisperModel, progress?: (p: number) => void): Promise<unknown> {
    return callWorker({ type: "load", model }, progress);
}

const VOICE_USED_KEY = "orrery.voice.used";
/**
 * Once voice to text has been used on this device, load the model quietly in the background
 * shortly after launch, so the mic is ready when tapped instead of loading on demand.
 * Devices that never used it don't download anything.
 */
export function warmUpWhisperIfUsed(model: WhisperModel, delayMs = 4000): () => void {
    let used = false;
    try {
        used = localStorage.getItem(VOICE_USED_KEY) === "1";
    } catch {
        /* ignore */
    }
    if (!used) return () => undefined;
    const t = setTimeout(() => void preloadWhisper(model).catch(() => undefined), delayMs);
    return () => clearTimeout(t);
}

function resample(chunks: Float32Array[], fromRate: number): Float32Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const input = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
        input.set(c, o);
        o += c.length;
    }
    if (fromRate === TARGET_RATE) return input;
    const ratio = fromRate / TARGET_RATE;
    const out = new Float32Array(Math.floor(total / ratio));
    for (let i = 0; i < out.length; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(Math.floor((i + 1) * ratio), total);
        let sum = 0;
        for (let j = start; j < end; j++) sum += input[j];
        out[i] = sum / Math.max(end - start, 1);
    }
    return out;
}

export function micErrorMessage(e: unknown): string {
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError")
        return "Microphone access is blocked. Allow the microphone for Orrery in your browser or system settings, then try again.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
    if (name === "NotReadableError") return "The microphone is in use by another app.";
    return (e as Error)?.message || "Couldn't start the microphone.";
}

// ---------------------------------------------------------------- session
export class DictationSession {
    private stream: MediaStream | null = null;
    private ctx: AudioContext | null = null;
    private node: AudioWorkletNode | null = null;
    private chunks: Float32Array[] = [];
    private rate = 48000;
    private timer: number | null = null;
    private recognizer: InstanceType<SpeechRecognitionCtor> | null = null;
    private finalText = "";
    private interimText = "";
    private recEnded: (() => void) | null = null;
    private cancelled = false;
    readonly startedAt = Date.now();

    constructor(private engine: DictationEngine, private model: WhisperModel, private h: DictationHandlers) {}

    async start(): Promise<void> {
        this.h.onState("requesting");
        if (this.engine === "browser") return this.startBrowser();
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
        } catch (e) {
            this.h.onState("error", micErrorMessage(e));
            throw e;
        }
        if (this.cancelled) return this.release();
        void preloadWhisper(this.model, this.h.onModelProgress).catch(() => undefined);
        try {
            localStorage.setItem(VOICE_USED_KEY, "1");
        } catch {
            /* storage unavailable: just no background warm-up next time */
        }
        this.ctx = new AudioContext();
        // Some phones create the context suspended; capture would then start late or never.
        if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined);
        this.rate = this.ctx.sampleRate;
        await this.ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}audio-capture.worklet.js`);
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(this.ctx, "orrery-capture");
        this.node.port.onmessage = (e: MessageEvent<{ pcm: Float32Array; rms: number }>) => {
            this.chunks.push(e.data.pcm);
            this.h.onLevel?.(e.data.rms);
        };
        src.connect(this.node);
        // The worklet must be pulled by the graph; route it to a muted gain so nothing is audible.
        const mute = this.ctx.createGain();
        mute.gain.value = 0;
        this.node.connect(mute).connect(this.ctx.destination);
        this.timer = window.setTimeout(() => this.h.onState("recording", "max-duration"), MAX_SECONDS * 1000);
        this.h.onState("recording");
    }

    private startBrowser(): void {
        if (!SR) {
            this.h.onState("error", "This browser has no built-in speech recognizer. Use on-device voice to text instead.");
            return;
        }
        const rec = new SR();
        rec.lang = navigator.language || "en-US";
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = (e) => {
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const r = e.results[i];
                if (r.isFinal) this.finalText += r[0].transcript;
                else interim += r[0].transcript;
            }
            this.interimText = interim;
            this.h.onInterim?.((this.finalText + interim).trim());
        };
        rec.onerror = (e) => {
            if (e.error === "aborted") return;
            this.h.onState("error", e.error === "not-allowed" ? micErrorMessage({ name: "NotAllowedError" }) : `Speech recognition error: ${e.error}`);
        };
        rec.onend = () => this.recEnded?.();
        this.recognizer = rec;
        rec.start();
        this.h.onState("recording");
    }

    /** Stop listening and return the transcript (empty string if nothing was heard). */
    async stop(): Promise<string> {
        if (this.engine === "browser") {
            const rec = this.recognizer;
            if (!rec) return "";
            await new Promise<void>((resolve) => {
                this.recEnded = resolve;
                rec.stop();
                setTimeout(resolve, 2500);
            });
            this.h.onState("idle");
            return (this.finalText + " " + this.interimText).trim();
        }
        const chunks = this.chunks;
        const rate = this.rate;
        this.release();
        const audio = resample(chunks, rate);
        if (audio.length < TARGET_RATE * 0.3) {
            this.h.onState("idle");
            return "";
        }
        this.h.onState("transcribing");
        try {
            const text = (await callWorker({ type: "transcribe", model: this.model, audio }, this.h.onModelProgress, [audio.buffer])) as string;
            this.h.onState("idle");
            return cleanTranscript(text);
        } catch (e) {
            this.h.onState("error", `Transcription failed: ${(e as Error).message}`);
            return "";
        }
    }

    /** Discard everything; nothing is transcribed or kept. */
    cancel(): void {
        this.cancelled = true;
        this.recognizer?.abort();
        this.recognizer = null;
        this.release();
        this.chunks = [];
        this.h.onState("idle");
    }

    private release(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.node?.port.close();
        this.node?.disconnect();
        this.node = null;
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        void this.ctx?.close().catch(() => undefined);
        this.ctx = null;
        this.chunks = [];
    }
}

/** Whisper emits placeholders for silence/noise; drop them. */
export function cleanTranscript(text: string): string {
    return text
        .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|INAUDIBLE|SOUND|silence)\]/gi, "")
        .replace(/\((?:music|silence|inaudible)\)/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}
