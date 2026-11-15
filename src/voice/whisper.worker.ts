/// <reference lib="webworker" />
// On-device Whisper transcription. Models and ONNX runtime are served from this app's own origin;
// remote model downloads are disabled, so audio and text never leave the device.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { splitAtPauses, worthTranscribing } from "./segment";

type Req = { id: number; type: "load"; model: string; base: string } | { id: number; type: "transcribe"; model: string; base: string; audio: Float32Array };

let current: { model: string; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

// Static hosts with an SPA fallback answer missing optional files (e.g. processor_config.json) with
// index.html and status 200, which Transformers.js would try to parse as model config. Turn those
// into the 404 they really are.
const modelFetch = async (input: string | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const url = typeof input === "string" ? input : input.href;
    if (res.ok && /\/models\//.test(url) && (res.headers.get("content-type") ?? "").includes("text/html")) {
        return new Response(null, { status: 404, statusText: "Not Found" });
    }
    return res;
};

function configure(base: string) {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    // Root-relative on purpose: Transformers.js treats an http(s) URL here as a *remote* location,
    // and with remote models disabled it would then conclude the audio processor is missing.
    env.localModelPath = new URL("models/", base).pathname;
    env.useBrowserCache = true;
    env.fetch = modelFetch;
    const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
    if (onnx.wasm) {
        onnx.wasm.wasmPaths = { mjs: `${base}ort/ort-wasm-simd-threaded.asyncify.mjs`, wasm: `${base}ort/ort-wasm-simd-threaded.asyncify.wasm` };
        onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    }
}

function load(model: string, base: string, onProgress?: (p: number) => void) {
    if (current?.model === model) return current.asr;
    configure(base);
    const files = new Map<string, number>();
    const asr = pipeline("automatic-speech-recognition", model, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (p: { status: string; file?: string; progress?: number }) => {
            if (p.status === "progress" && p.file && typeof p.progress === "number") {
                files.set(p.file, p.progress);
                const vals = [...files.values()];
                onProgress?.(vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1));
            }
        },
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
    current = { model, asr };
    asr.catch(() => (current = null));
    return asr;
}

self.onmessage = async (e: MessageEvent<Req>) => {
    const req = e.data;
    try {
        const asr = await load(req.model, req.base, (p) => self.postMessage({ id: req.id, type: "progress", progress: p }));
        if (req.type === "load") {
            self.postMessage({ id: req.id, type: "ready" });
            return;
        }
        const t0 = performance.now();
        // Long recordings: cut at pauses into pieces under 30 s (see segment.ts).
        const parts: string[] = [];
        for (const seg of splitAtPauses(req.audio)) {
            if (!worthTranscribing(seg)) continue;
            const out = (await asr(seg)) as { text: string } | { text: string }[];
            const t = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
            if (t) parts.push(t);
        }
        const text = parts.join(" ");
        self.postMessage({ id: req.id, type: "result", text, ms: Math.round(performance.now() - t0) });
    } catch (err) {
        self.postMessage({ id: req.id, type: "error", error: (err as Error).message ?? String(err) });
    }
};
