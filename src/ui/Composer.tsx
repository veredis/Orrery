import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk";
import type { ChatItem } from "../matrix/timeline";
import { editText, sendFile, sendText } from "../matrix/actions";
import { DictationSession, browserRecognizerAvailable, micSupported, type DictationState } from "../voice/dictation";
import { drafts, toast, useUI } from "./state";
import { I } from "./icons";
import { VoiceWave } from "./VoiceWave";
import { Popover, ask } from "./common";

/** Phone-sized or touch-first screens get the attach menu; desktop goes straight to the file picker. */
const isPhoneLayout = () => innerWidth <= 860 || matchMedia("(pointer: coarse)").matches;

export interface ComposerMode {
    reply?: ChatItem;
    edit?: ChatItem;
}

interface Props {
    client: MatrixClient;
    room: Room;
    agentName?: string;
    agentRoom: boolean;
    working: boolean;
    mode: ComposerMode;
    setMode(m: ComposerMode): void;
    onStop(): void;
    onSent(): void;
    registerFocus(fn: () => void): void;
    registerDictation(fn: () => void): void;
    externalFiles: File[];
    clearExternalFiles(): void;
}


export function Composer(p: Props) {
    const { client, room } = p;
    const settings = useUI((s) => s.settings);
    const [text, setText] = useState(() => drafts.get(room.roomId));
    const [files, setFiles] = useState<File[]>([]);
    const [sending, setSending] = useState(false);
    const [drag, setDrag] = useState(false);
    const [dict, setDict] = useState<{ state: DictationState; detail?: string; started: number; interim?: string; modelPct?: number } | null>(null);
    const micLevel = useRef(0);
    const session = useRef<DictationSession | null>(null);
    const ta = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const cameraInput = useRef<HTMLInputElement>(null);
    const photoInput = useRef<HTMLInputElement>(null);
    const attachBtn = useRef<HTMLButtonElement>(null);
    const [attachOpen, setAttachOpen] = useState(false);
    const [, force] = useState(0);

    // per-room draft
    useEffect(() => {
        setText(drafts.get(room.roomId));
        setFiles([]);
        session.current?.cancel();
        setDict(null);
    }, [room.roomId]);
    useEffect(() => {
        const t = setTimeout(() => drafts.set(room.roomId, p.mode.edit ? "" : text), 250);
        return () => clearTimeout(t);
    }, [text, room.roomId, p.mode.edit]);
    useEffect(() => {
        if (p.mode.edit) {
            setText(p.mode.edit.body);
            requestAnimationFrame(() => ta.current?.focus());
        }
    }, [p.mode.edit]);
    useEffect(() => {
        if (p.externalFiles.length) {
            setFiles((f) => [...f, ...p.externalFiles]);
            p.clearExternalFiles();
        }
    }, [p.externalFiles]); // eslint-disable-line react-hooks/exhaustive-deps

    useLayoutEffect(() => {
        const el = ta.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, innerHeight * 0.4)}px`;
    }, [text, dict?.state]);

    const prefill = useUI((s) => s.prefill);
    useEffect(() => {
        if (prefill === null) return;
        setText(prefill);
        useUI.setState({ prefill: null });
        requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(prefill.length, prefill.length); });
    }, [prefill]);

    useEffect(() => {
        p.registerFocus(() => ta.current?.focus());
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // tick the dictation timer
    useEffect(() => {
        if (dict?.state !== "recording") return;
        const t = setInterval(() => force((x) => x + 1), 500);
        return () => clearInterval(t);
    }, [dict?.state]);

    const insertText = useCallback((t: string) => {
        if (!t) return;
        const el = ta.current;
        setText((cur) => {
            const start = el?.selectionStart ?? cur.length;
            const end = el?.selectionEnd ?? cur.length;
            const before = cur.slice(0, start);
            const after = cur.slice(end);
            const sep = before && !/\s$/.test(before) ? " " : "";
            const next = before + sep + t + (after && !/^\s/.test(after) ? " " : "") + after;
            requestAnimationFrame(() => {
                const pos = (before + sep + t).length;
                el?.focus();
                el?.setSelectionRange(pos, pos);
            });
            return next;
        });
    }, []);

    const startDictation = useCallback(async () => {
        if (session.current) return;
        if (!micSupported()) {
            toast("This browser can't record audio for voice to text.", "error");
            return;
        }
        const engine = settings.dictationEngine === "browser" && browserRecognizerAvailable() ? "browser" : "local";
        const s = new DictationSession(engine, settings.whisperModel, {
            onState: (state, detail) => {
                if (detail === "max-duration") {
                    void stopDictation();
                    return;
                }
                setDict((d) => (state === "idle" ? null : { started: d?.started ?? Date.now(), ...d, state, detail }));
                if (state === "error") {
                    session.current = null;
                    if (detail) toast(detail, "error");
                    setTimeout(() => setDict((d) => (d?.state === "error" ? null : d)), 100);
                }
            },
            // Arrives every audio block (~375/s): keep it out of React state; the wave reads it per frame.
            onLevel: (rms) => (micLevel.current = rms),
            onInterim: (interim) => setDict((d) => (d ? { ...d, interim } : d)),
            onModelProgress: (pct) => setDict((d) => (d ? { ...d, modelPct: pct } : d)),
        });
        session.current = s;
        micLevel.current = 0;
        setDict({ state: "requesting", started: Date.now() });
        try {
            await s.start();
        } catch {
            session.current = null;
            setDict(null);
        }
    }, [settings.dictationEngine, settings.whisperModel]); // eslint-disable-line react-hooks/exhaustive-deps

    const stopDictation = useCallback(async () => {
        const s = session.current;
        if (!s) return;
        session.current = null;
        const transcript = await s.stop();
        setDict(null);
        if (transcript) insertText(transcript);
        else toast("Didn't catch anything — try again a little closer to the mic.");
    }, [insertText]);

    const cancelDictation = useCallback(() => {
        session.current?.cancel();
        session.current = null;
        setDict(null);
        ta.current?.focus();
    }, []);

    // Register the keyboard-shortcut toggle. The braces matter: returning the toggle from the effect
    // would make React call it as the cleanup, i.e. start the microphone on unmount.
    useEffect(() => {
        p.registerDictation(() => (session.current ? void stopDictation() : void startDictation()));
        return () => p.registerDictation(() => undefined);
    }, [startDictation, stopDictation]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => () => session.current?.cancel(), []);

    const canSend = (text.trim().length > 0 || files.length > 0) && !sending && !dict;

    const submit = async () => {
        if (!canSend) return;
        const body = text.trim();
        setSending(true);
        try {
            if (p.mode.edit && !p.agentRoom) {
                await editText(client, room.roomId, p.mode.edit.event, body);
            } else {
                for (const f of files) await sendFile(client, room, f);
                if (body) {
                    const pending = sendText(client, room.roomId, body, { replyTo: p.mode.reply?.event });
                    setText("");
                    drafts.set(room.roomId, "");
                    await pending;
                }
            }
            setText("");
            setFiles([]);
            drafts.set(room.roomId, "");
            p.setMode({});
            p.onSent();
        } catch (e) {
            const err = e as { name?: string; message?: string };
            // Unknown devices etc.: the SDK keeps the event as "not sent" with a retry option.
            toast(err.message ?? "Couldn't send", "error");
            if (body && !text) setText(body);
        } finally {
            setSending(false);
            requestAnimationFrame(() => ta.current?.focus());
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (settings.enterToSend || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
        } else if (e.key === "Escape") {
            if (p.mode.reply || p.mode.edit) {
                p.setMode({});
                if (p.mode.edit) setText("");
            }
        }
    };

    const addFiles = async (list: FileList | File[]) => {
        const arr = [...list];
        const big = arr.filter((f) => f.size > 95 * 1024 * 1024);
        if (big.length) toast("Files over ~95 MB can't be sent through this server.", "error");
        const ok = arr.filter((f) => f.size <= 95 * 1024 * 1024);
        if (ok.length > 5 && !(await ask({ title: `Attach ${ok.length} files?`, confirm: "Attach" }))) return;
        setFiles((f) => [...f, ...ok]);
    };
    const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.length) void addFiles(e.target.files);
        e.target.value = "";
    };

    const onPaste = (e: React.ClipboardEvent) => {
        const fs = [...e.clipboardData.files];
        if (fs.length) {
            e.preventDefault();
            void addFiles(fs);
        }
    };

    const elapsed = dict ? Math.floor((Date.now() - dict.started) / 1000) : 0;
    const placeholder = p.agentRoom ? `Ask ${p.agentName ?? "your agent"} anything…` : `Message ${room.name}…`;
    const cloudVoice = settings.dictationEngine === "browser" && browserRecognizerAvailable();

    return (
        <div className="composer-wrap">
            <div
                className={`composer ${drag ? "drag" : ""}`}
                onDragOver={(e) => {
                    if (e.dataTransfer.types.includes("Files")) {
                        e.preventDefault();
                        setDrag(true);
                    }
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setDrag(false);
                    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
                }}
            >
                {p.mode.reply && (
                    <div className="reply-bar">
                        <I.reply width={14} />
                        <span className="grow truncate">Replying to {p.mode.reply.agent?.name ?? "message"}: {p.mode.reply.body.slice(0, 80)}</span>
                        <button className="icon-btn sm" onClick={() => p.setMode({})} aria-label="Cancel reply"><I.x /></button>
                    </div>
                )}
                {p.mode.edit && (
                    <div className="edit-bar">
                        <I.edit width={14} />
                        <span className="grow truncate">{p.agentRoom ? "Edit and resend — sends as a new prompt (agents don't re-read edits)" : "Editing message"}</span>
                        <button className="icon-btn sm" onClick={() => { p.setMode({}); setText(""); }} aria-label="Cancel edit"><I.x /></button>
                    </div>
                )}
                {files.length > 0 && (
                    <div className="attachments">
                        {files.map((f, i) => (
                            <div className="att" key={i}>
                                {f.type.startsWith("image/") ? <img src={URL.createObjectURL(f)} alt="" onLoad={(e) => URL.revokeObjectURL((e.target as HTMLImageElement).src)} /> : <I.file width={18} />}
                                <span className="truncate grow">{f.name}</span>
                                <button className="icon-btn sm" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}><I.x /></button>
                            </div>
                        ))}
                    </div>
                )}

                {dict && dict.state !== "error" ? (
                    <div className={`dictation ${dict.state}`} aria-live="polite">
                        {dict.state === "recording" && <div className="rec-dot" aria-label="Recording" />}
                        {dict.state === "requesting" && <div className="spinner" />}
                        {dict.state === "transcribing" && <div className="spinner" />}
                        {dict.state === "recording" ? (
                            // Desktop keeps a short direction (or live text from the browser engine); phones show only the wave.
                            <span className="label voice-hint">{dict.interim ? <i>{dict.interim}</i> : "Speak, then press ✓"}</span>
                        ) : (
                            <span className="label">
                                {dict.state === "requesting" && "Waiting for microphone…"}
                                {dict.state === "transcribing" && (dict.modelPct !== undefined && dict.modelPct < 100 ? `Loading speech model ${Math.round(dict.modelPct)}%…` : "Turning speech into text…")}
                            </span>
                        )}
                        {dict.state === "recording" && <VoiceWave level={micLevel} />}
                        <span className={`voice-chip ${cloudVoice ? "cloud" : ""}`} title={cloudVoice ? "Audio is sent to the browser's speech provider" : "Audio stays on this device"}>{cloudVoice ? "Cloud" : "On-device"}</span>
                        {dict.state === "recording" && <span className="timer">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>}
                        <button className="icon-btn" onClick={cancelDictation} title="Cancel dictation (Esc)" aria-label="Cancel dictation"><I.x /></button>
                        {dict.state === "recording" && (
                            <button className="send-btn" onClick={() => void stopDictation()} title="Stop and turn into text" aria-label="Stop and turn speech into text"><I.check /></button>
                        )}
                    </div>
                ) : (
                    <>
                        <textarea
                            ref={ta}
                            rows={1}
                            value={text}
                            placeholder={placeholder}
                            onChange={(e) => setText(e.target.value)}
                            onKeyDown={onKeyDown}
                            onPaste={onPaste}
                            aria-label="Message"
                            enterKeyHint={settings.enterToSend ? "send" : "enter"}
                            spellCheck
                        />
                        <div className="composer-bar">
                            <button
                                ref={attachBtn}
                                className={`icon-btn ${attachOpen ? "active" : ""}`}
                                title="Attach files"
                                aria-label="Attach files"
                                aria-haspopup={isPhoneLayout() ? "menu" : undefined}
                                aria-expanded={isPhoneLayout() ? attachOpen : undefined}
                                // Phones get a menu (camera, photo library incl. Google Photos, files); desktop opens the file picker directly.
                                onClick={() => (isPhoneLayout() ? setAttachOpen((o) => !o) : fileInput.current?.click())}
                            >
                                <I.clip />
                            </button>
                            <input ref={fileInput} type="file" multiple hidden onChange={onPicked} />
                            <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={onPicked} />
                            <input ref={photoInput} type="file" accept="image/*,video/*" multiple hidden onChange={onPicked} />
                            {attachOpen && (
                                <Popover anchor={attachBtn.current} onClose={() => setAttachOpen(false)} placement="above" className="attach-menu">
                                    {(
                                        [
                                            [I.camera, "Camera", "Take a photo", cameraInput],
                                            [I.image, "Photos", "Gallery and Google Photos", photoInput],
                                            [I.clip, "Files", "Documents and other files", fileInput],
                                        ] as const
                                    ).map(([Icon, label, desc, input]) => (
                                        <button key={label} className="menu-item" role="menuitem" onClick={() => { setAttachOpen(false); input.current?.click(); }}>
                                            <span className="attach-ico"><Icon /></span>
                                            <span className="grow">
                                                <span className="attach-label">{label}</span>
                                                <span className="desc">{desc}</span>
                                            </span>
                                        </button>
                                    ))}
                                </Popover>
                            )}
                            <div className="grow" />
                            <button
                                className="voice-btn"
                                title={`Voice to text (${cloudVoice ? "browser speech service — audio goes to its provider" : "on-device, audio never leaves this device"}). Speak, then edit the text before sending. Ctrl+Shift+Space`}
                                aria-label="Voice to text"
                                onClick={() => void startDictation()}
                            >
                                <I.voiceText />
                                <span className="voice-label">Voice to text</span>
                            </button>
                            {p.working && !canSend ? (
                                <button className="send-btn stop" onClick={p.onStop} title={`Stop ${p.agentName ?? "agent"}`} aria-label="Stop the agent"><I.stop /></button>
                            ) : (
                                <button className="send-btn" disabled={!canSend} onClick={() => void submit()} title="Send (Enter)" aria-label="Send">
                                    {sending ? <div className="spinner" style={{ borderTopColor: "#fff" }} /> : <I.send />}
                                </button>
                            )}
                        </div>
                    </>
                )}
            </div>
            <div className="composer-foot">
                {room.hasEncryptionStateEvent() ? "End-to-end encrypted" : "Not encrypted"} · {settings.enterToSend ? "Enter to send, Shift+Enter for a new line" : "Ctrl+Enter to send"}
            </div>
        </div>
    );
}
