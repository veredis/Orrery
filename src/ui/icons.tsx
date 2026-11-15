// Inline icon set (stroke icons, 24px grid).
import type { SVGProps } from "react";

const P = (d: string | string[]) => (props: SVGProps<SVGSVGElement>) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        {(Array.isArray(d) ? d : [d]).map((x, i) => <path key={i} d={x} />)}
    </svg>
);

export const I = {
    plus: P("M12 5v14M5 12h14"),
    search: P(["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "m21 21-4.3-4.3"]),
    send: P(["M12 19V5", "m5 12 7-7 7 7"]),
    stop: (p: SVGProps<SVGSVGElement>) => <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>,
    mic: P(["M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z", "M19 11a7 7 0 0 1-14 0", "M12 18v3"]),
    // Voice to text: a microphone turning into lines of text (dictation, never a voice message).
    voiceText: P(["M8 13.5a2.5 2.5 0 0 0 2.5-2.5V6a2.5 2.5 0 0 0-5 0v5A2.5 2.5 0 0 0 8 13.5z", "M13 10.5a5 5 0 0 1-10 0", "M8 15.5V19", "M15.5 7H21", "M15.5 11.5H21", "M15.5 16H19"]),
    camera: P(["M14.5 4h-5L7.5 6.5H5A2 2 0 0 0 3 8.5v9A2 2 0 0 0 5 19.5h14a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2.5z", "M12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"]),
    image: P(["M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", "M8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "m21 15-5-5L5 20"]),
    clip: P("m21.4 11.1-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8"),
    x: P(["M18 6 6 18", "m6 6 12 12"]),
    check: P("M20 6 9 17l-5-5"),
    chevDown: P("m6 9 6 6 6-6"),
    chevRight: P("m9 6 6 6-6 6"),
    chevLeft: P("m15 6-6 6 6 6"),
    menu: P(["M4 6h16", "M4 12h16", "M4 18h16"]),
    sidebar: P(["M4 5h16v14H4z", "M9 5v14"]),
    more: P(["M12 12h.01", "M19 12h.01", "M5 12h.01"]),
    copy: P(["M9 9h11v11H9z", "M5 15H4V4h11v1"]),
    edit: P(["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"]),
    reply: P(["m9 14-5-5 5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"]),
    retry: P(["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5"]),
    trash: P(["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6"]),
    pin: P(["M12 17v5", "M9 3h6l-1 5 4 4H6l4-4z"]),
    folder: P("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"),
    bot: P(["M12 3v3", "M5 8h14v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z", "M9 13h.01", "M15 13h.01", "M9.5 17h5"]),
    tasks: P(["M4 5h4v14H4z", "M10 5h4v9h-4z", "M16 5h4v6h-4z"]),
    activity: P("M3 12h4l3-8 4 16 3-8h4"),
    settings: P(["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"]),
    chat: P("M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"),
    lock: P(["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"]),
    shield: P(["M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6z", "m9 12 2 2 4-4"]),
    alert: P(["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"]),
    terminal: P(["m4 17 6-6-6-6", "M12 19h8"]),
    file: P(["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6"]),
    download: P(["M12 3v12", "m7 10 5 5 5-5", "M5 21h14"]),
    speaker: P(["M11 5 6 9H2v6h4l5 4z", "M15.5 8.5a5 5 0 0 1 0 7", "M19 5a10 10 0 0 1 0 14"]),
    export: P(["M12 3v12", "m17 8-5-5-5 5", "M5 21h14"]),
    sun: P(["M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"]),
    moon: P("M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"),
    logout: P(["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "m16 17 5-5-5-5", "M21 12H9"]),
    brain: P(["M9.5 2A2.5 2.5 0 0 0 7 4.5v.4A3 3 0 0 0 4 8a3 3 0 0 0 .5 5A3.5 3.5 0 0 0 8 18.5 2.5 2.5 0 0 0 12 20V4.5A2.5 2.5 0 0 0 9.5 2z", "M14.5 2A2.5 2.5 0 0 1 17 4.5v.4A3 3 0 0 1 20 8a3 3 0 0 1-.5 5 3.5 3.5 0 0 1-3.5 5.5A2.5 2.5 0 0 1 12 20"]),
    sparkle: P(["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z", "M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"]),
    wifiOff: P(["M2 2l20 20", "M8.5 16.5a5 5 0 0 1 7 0", "M5 12.6a10 10 0 0 1 5.2-2.7", "M16.8 10.4A10 10 0 0 1 19 12.6", "M12 20h.01"]),
};

export function BrandMark({ size = 30 }: { size?: number }) {
    return (
        <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
            <defs>
                <linearGradient id="og" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#a98bff" />
                    <stop offset="1" stopColor="#4b2bd6" />
                </linearGradient>
            </defs>
            <rect width="64" height="64" rx="16" fill="url(#og)" />
            <ellipse cx="32" cy="32" rx="22" ry="9" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="2.2" transform="rotate(-28 32 32)" />
            <ellipse cx="32" cy="32" rx="13" ry="22" fill="none" stroke="#fff" strokeOpacity=".3" strokeWidth="2" transform="rotate(-28 32 32)" />
            <path d="M32 21.5c1 6.7 3.8 9.5 10.5 10.5-6.7 1-9.5 3.8-10.5 10.5-1-6.7-3.8-9.5-10.5-10.5 6.7-1 9.5-3.8 10.5-10.5z" fill="#fff" />
            <circle cx="50.5" cy="22" r="3.6" fill="#ffd27a" />
            <circle cx="21" cy="49" r="2.6" fill="#fff" fillOpacity=".85" />
        </svg>
    );
}
