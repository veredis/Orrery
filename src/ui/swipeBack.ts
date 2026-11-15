// Phone navigation back to the conversation list:
//  - swipe right from anywhere in an open chat; the chat slides with your finger and the list is
//    revealed underneath (released past a third of the width, or flicked, it completes);
//  - Android's own back gesture/button also returns to the list instead of leaving the app.
import { useEffect, type RefObject } from "react";
import { useUI } from "./state";

const PHONE = () => innerWidth <= 860;
// Places where a sideways drag already means something (editing text, scrolling code or tables,
// menus and dialogs).
const SKIP = "textarea, input, select, pre, table, .code-block, .popover, .sheet-backdrop, .modal-backdrop, .lightbox, .activity, [data-no-swipe]";

/** Pops the chat off the phone's back stack (or just shows the list). */
export function backToList() {
    if (history.state?.orreryChat) history.back();
    else useUI.setState({ mobileView: "list" });
}

function scrollsSideways(el: Element | null, stop: Element): boolean {
    for (; el && el !== stop; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth + 1 && el.scrollLeft > 0) {
            const o = getComputedStyle(el).overflowX;
            if (o === "auto" || o === "scroll") return true;
        }
    }
    return false;
}

export function useSwipeBack(workspace: RefObject<HTMLDivElement | null>, inChat: boolean) {
    // Android back gesture → conversation list.
    useEffect(() => {
        if (!inChat || !PHONE()) return;
        if (!history.state?.orreryChat) history.pushState({ ...(history.state ?? {}), orreryChat: true }, "");
        const onPop = () => useUI.setState({ mobileView: "list" });
        addEventListener("popstate", onPop);
        return () => removeEventListener("popstate", onPop);
    }, [inChat]);

    useEffect(() => {
        const ws = workspace.current;
        if (!ws || !inChat) return;
        let sx = 0, sy = 0, st = 0, dx = 0;
        let mode: "idle" | "maybe" | "drag" | "off" = "idle";
        let main: HTMLElement | null = null;
        let side: HTMLElement | null = null;
        const width = () => ws.clientWidth || innerWidth;

        const paint = (x: number, animate: boolean) => {
            const t = animate ? "transform .22s cubic-bezier(.2,.8,.2,1)" : "none";
            if (main) {
                main.style.transition = t;
                main.style.transform = x ? `translateX(${x}px)` : "";
            }
            if (side) {
                side.style.transition = animate ? `${t}, opacity .22s` : "none";
                const p = Math.min(1, x / width());
                side.style.transform = `translateX(${(-24 * (1 - p)).toFixed(2)}%)`;
                side.style.opacity = String(0.55 + 0.45 * p);
            }
        };
        const reset = () => {
            ws.classList.remove("swiping");
            for (const el of [main, side]) if (el) el.style.transition = el.style.transform = el.style.opacity = "";
            main = side = null;
            mode = "idle";
        };

        const onStart = (e: TouchEvent) => {
            if (!PHONE() || e.touches.length !== 1) return (mode = "off"), undefined;
            const target = e.target as Element;
            const m = ws.querySelector<HTMLElement>(":scope > div > .main");
            if (!m || !m.contains(target) || target.closest(SKIP) || scrollsSideways(target, m) || String(getSelection() ?? "")) {
                mode = "off";
                return;
            }
            main = m;
            side = ws.querySelector<HTMLElement>(":scope > .sidebar");
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            st = performance.now();
            dx = 0;
            mode = "maybe";
        };
        const onMove = (e: TouchEvent) => {
            if (mode === "off" || mode === "idle") return;
            const x = e.touches[0].clientX - sx;
            const y = e.touches[0].clientY - sy;
            if (mode === "maybe") {
                if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) return (mode = "off"), undefined; // scrolling
                if (x < -10) return (mode = "off"), undefined; // leftwards: not ours
                if (x < 14 || x < Math.abs(y) * 1.4) return;
                mode = "drag";
                ws.classList.add("swiping");
                sx += 14; // start following from here so the chat doesn't jump
            }
            e.preventDefault();
            dx = Math.max(0, e.touches[0].clientX - sx);
            paint(dx, false);
        };
        const onEnd = () => {
            if (mode !== "drag") return void (mode = "idle");
            const w = width();
            const v = dx / Math.max(1, performance.now() - st); // px/ms
            if (dx > w / 3 || (v > 0.5 && dx > 40)) {
                paint(w, true);
                let finished = false;
                const done = () => {
                    if (finished) return;
                    finished = true;
                    reset();
                    backToList();
                };
                main?.addEventListener("transitionend", done, { once: true });
                setTimeout(done, 300); // in case transitionend never fires
            } else {
                paint(0, true);
                const m = main;
                setTimeout(() => main === m && reset(), 240);
            }
            mode = "idle";
        };

        ws.addEventListener("touchstart", onStart, { passive: true });
        ws.addEventListener("touchmove", onMove, { passive: false });
        ws.addEventListener("touchend", onEnd);
        ws.addEventListener("touchcancel", onEnd);
        return () => {
            ws.removeEventListener("touchstart", onStart);
            ws.removeEventListener("touchmove", onMove);
            ws.removeEventListener("touchend", onEnd);
            ws.removeEventListener("touchcancel", onEnd);
            reset();
        };
    }, [workspace, inChat]);
}
