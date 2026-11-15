import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import type { MatrixClient } from "matrix-js-sdk";
import { renderMarkdown, sanitize } from "../lib/markdown";
import { mediaUrl, type MediaRef } from "../matrix/media";
import { useUI } from "./state";
import { I } from "./icons";

// ---------------------------------------------------------------- avatar
const HUES = [262, 285, 230, 200, 320, 160, 30, 350];
export function Avatar({ name, id, size, agent }: { name: string; id: string; size?: "sm" | "lg"; agent?: boolean }) {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
    const hue = HUES[Math.abs(h) % HUES.length];
    const initials = name.replace(/^[@!#]/, "").trim().slice(0, 1).toUpperCase() || "?";
    return (
        <div className={`avatar ${size ?? ""} ${agent ? "agent" : ""}`} style={agent ? undefined : { background: `linear-gradient(135deg, hsl(${hue} 55% 52%), hsl(${hue + 25} 50% 38%))` }} aria-hidden="true">
            {agent ? <I.sparkle width={size === "sm" ? 13 : 17} height={size === "sm" ? 13 : 17} /> : initials}
        </div>
    );
}

// ---------------------------------------------------------------- markdown
export function Markdown({ text, html, streaming }: { text: string; html?: string; streaming?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const out = html ? sanitize(html) : renderMarkdown(text);
    const onClick = async (e: React.MouseEvent) => {
        const btn = (e.target as HTMLElement).closest(".code-copy") as HTMLButtonElement | null;
        if (btn) {
            const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
            await copyText(code);
            btn.textContent = "Copied";
            setTimeout(() => (btn.textContent = "Copy"), 1400);
            return;
        }
        const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
        if (a?.href && window.orreryDesktop) {
            e.preventDefault();
            void window.orreryDesktop.openExternal(a.href);
        }
    };
    return <div ref={ref} className={`md ${streaming ? "stream-caret" : ""}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: out }} />;
}

export async function copyText(text: string) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
    }
}

// ---------------------------------------------------------------- media
export function useMedia(client: MatrixClient, ref: MediaRef | null): { url?: string; error?: string } {
    const [state, setState] = useState<{ url?: string; error?: string }>({});
    useEffect(() => {
        let live = true;
        if (!ref) return;
        mediaUrl(client, ref).then(
            (url) => live && setState({ url }),
            (e: Error) => live && setState({ error: e.message }),
        );
        return () => {
            live = false;
        };
    }, [client, ref?.mxc]); // eslint-disable-line react-hooks/exhaustive-deps
    return state;
}

// ---------------------------------------------------------------- dialogs
interface DialogSpec {
    title: string;
    body?: ReactNode;
    input?: { label: string; value?: string; placeholder?: string; multiline?: boolean };
    confirm?: string;
    cancel?: string;
    danger?: boolean;
    resolve(v: string | boolean | null): void;
}
const useDialog = create<{ spec: DialogSpec | null }>(() => ({ spec: null }));
export function ask(spec: Omit<DialogSpec, "resolve">): Promise<string | boolean | null> {
    return new Promise((resolve) => useDialog.setState({ spec: { ...spec, resolve } }));
}
export function DialogHost() {
    const spec = useDialog((s) => s.spec);
    const [val, setVal] = useState("");
    useEffect(() => setVal(spec?.input?.value ?? ""), [spec]);
    if (!spec) return null;
    const close = (v: string | boolean | null) => {
        useDialog.setState({ spec: null });
        spec.resolve(v);
    };
    const submit = () => close(spec.input ? val.trim() || null : true);
    return (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(null)} onKeyDown={(e) => e.key === "Escape" && close(null)}>
            <div className="modal" role="dialog" aria-modal="true" aria-label={spec.title}>
                <h3>{spec.title}</h3>
                {spec.body && <div className="hint" style={{ fontSize: 14, color: "var(--text-2)" }}>{spec.body}</div>}
                {spec.input && (
                    <label className="field">
                        {spec.input.label}
                        {spec.input.multiline ? (
                            <textarea className="input" rows={4} autoFocus value={val} placeholder={spec.input.placeholder} onChange={(e) => setVal(e.target.value)} />
                        ) : (
                            <input className="input" autoFocus value={val} placeholder={spec.input.placeholder} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
                        )}
                    </label>
                )}
                <div className="modal-actions">
                    <button className="btn ghost" onClick={() => close(null)}>{spec.cancel ?? "Cancel"}</button>
                    <button className={`btn ${spec.danger ? "danger solid" : "primary"}`} onClick={submit} autoFocus={!spec.input}>
                        {spec.confirm ?? "OK"}
                    </button>
                </div>
            </div>
        </div>
    );
}

export function Toasts() {
    const toasts = useUI((s) => s.toasts);
    return (
        <div className="toasts" role="status" aria-live="polite">
            {toasts.map((t) => (
                <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
                    {t.kind === "error" ? <I.alert width={16} style={{ color: "var(--danger)", flex: "none" }} /> : <I.check width={16} style={{ color: "var(--ok)", flex: "none" }} />}
                    <span>{t.text}</span>
                </div>
            ))}
        </div>
    );
}

export function Lightbox() {
    const src = useUI((s) => s.lightbox);
    if (!src) return null;
    return (
        <div className="lightbox" onClick={() => useUI.setState({ lightbox: null })} role="dialog" aria-label="Image preview">
            <img src={src} alt="" />
        </div>
    );
}

/**
 * Small anchored popover; on phones it becomes a bottom sheet (CSS). `placement="above"` keeps it a
 * compact card floating above the anchor on every screen size (the composer's attach menu).
 */
export function Popover({
    anchor,
    onClose,
    children,
    align = "left",
    placement = "below",
    className = "",
}: {
    anchor: HTMLElement | null;
    onClose(): void;
    children: ReactNode;
    align?: "left" | "right";
    placement?: "below" | "above";
    className?: string;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; maxHeight: number } | null>(null);
    // Rendered into <body> with fixed positioning: inside the top bar it would be trapped in the
    // bar's stacking context (backdrop-filter) and drawn underneath the timeline.
    useLayoutEffect(() => {
        if (!anchor) return;
        const place = () => {
            const r = anchor.getBoundingClientRect();
            const w = ref.current?.offsetWidth ?? 320;
            const left = Math.max(8, align === "right" ? r.right - w : Math.min(r.left, innerWidth - w - 8));
            if (placement === "above") {
                setPos({ bottom: innerHeight - r.top + 8, left, maxHeight: Math.max(160, r.top - 16) });
                return;
            }
            const top = r.bottom + 6;
            setPos({ top, left, maxHeight: Math.max(160, innerHeight - top - 12) });
        };
        place();
        addEventListener("resize", place);
        return () => removeEventListener("resize", place);
    }, [anchor, align, placement]);
    useEffect(() => {
        if (!anchor) return;
        const onDoc = (e: MouseEvent) => {
            if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        setTimeout(() => document.addEventListener("mousedown", onDoc));
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDoc);
            document.removeEventListener("keydown", onKey);
        };
    }, [anchor, onClose]);
    return createPortal(
        <>
            <div className={`sheet-backdrop mobile-only ${placement === "above" ? "light" : ""}`} onClick={onClose} />
            <div
                ref={ref}
                className={`popover ${placement === "above" ? "above" : ""} ${className}`}
                style={{
                    top: pos?.top ?? (pos?.bottom === undefined ? 0 : "auto"),
                    bottom: pos?.bottom ?? "auto",
                    left: pos?.left ?? 0,
                    maxHeight: pos?.maxHeight,
                    visibility: pos ? "visible" : "hidden",
                }}
                role="menu"
            >
                {children}
            </div>
        </>,
        document.body,
    );
}

export function timeLabel(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
export function relTime(ts: number): string {
    const d = Date.now() - ts;
    if (d < 60_000) return "now";
    if (d < 3600_000) return `${Math.floor(d / 60_000)}m`;
    if (d < 86400_000) return `${Math.floor(d / 3600_000)}h`;
    if (d < 7 * 86400_000) return new Date(ts).toLocaleDateString([], { weekday: "short" });
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
export function duration(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}
