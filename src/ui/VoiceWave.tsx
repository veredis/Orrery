// Flowing voice visual for voice to text: layered sine ribbons whose height follows the
// microphone level. The level arrives very often (every audio block), so it is read from a ref and
// eased per animation frame instead of re-rendering React; that keeps the motion smooth.
import { useEffect, useRef, type MutableRefObject } from "react";

const RIBBONS = [
    // frequency (waves across the width), speed (rad/s), relative amplitude, opacity, line width
    { f: 1.6, s: 2.6, a: 1, o: 1, w: 2.4 },
    { f: 2.3, s: -3.4, a: 0.7, o: 0.55, w: 1.8 },
    { f: 3.1, s: 4.2, a: 0.45, o: 0.35, w: 1.4 },
];

export function VoiceWave({ level }: { level: MutableRefObject<number> }) {
    const canvas = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const cv = canvas.current;
        if (!cv) return;
        const ctx = cv.getContext("2d");
        if (!ctx) return;
        const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
        let raf = 0;
        let amp = 0;
        let last = performance.now();
        let phase = 0;

        const css = getComputedStyle(cv);
        const c1 = css.getPropertyValue("--accent-2").trim() || "#b39bff";
        const c2 = css.getPropertyValue("--accent").trim() || "#8f6bff";

        const draw = (now: number) => {
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            const dpr = window.devicePixelRatio || 1;
            const w = cv.clientWidth;
            const h = cv.clientHeight;
            if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
                cv.width = Math.round(w * dpr);
                cv.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            // Speech RMS is small (≈0.01–0.2); compress it so quiet and loud speech both read well.
            const target = Math.min(1, Math.sqrt(Math.max(0, level.current)) * 2.4);
            // Rise quickly, fall gently: lively without flicker.
            const k = target > amp ? 1 - Math.exp(-dt * 14) : 1 - Math.exp(-dt * 4);
            amp += (target - amp) * k;
            if (!reduceMotion) phase += dt;

            const mid = h / 2;
            const maxA = h / 2 - 2;
            const floor = 0.08; // a gentle ripple even in silence, so it reads as "listening"
            const grad = ctx.createLinearGradient(0, 0, w, 0);
            grad.addColorStop(0, c2);
            grad.addColorStop(0.5, c1);
            grad.addColorStop(1, c2);
            ctx.strokeStyle = grad;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";

            for (const r of RIBBONS) {
                const A = maxA * r.a * (floor + (1 - floor) * amp);
                ctx.globalAlpha = r.o;
                ctx.lineWidth = r.w;
                ctx.beginPath();
                const step = 3;
                for (let x = 0; x <= w; x += step) {
                    const t = x / w;
                    const env = Math.sin(Math.PI * t) ** 1.6; // taper to the ends
                    const y = mid + Math.sin(t * Math.PI * 2 * r.f + phase * r.s) * A * env;
                    if (x === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            raf = requestAnimationFrame(draw);
        };
        raf = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(raf);
    }, [level]);

    return <canvas ref={canvas} className="voice-wave" aria-hidden="true" />;
}
