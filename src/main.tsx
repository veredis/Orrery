import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { logger } from "matrix-js-sdk/lib/logger";
import { App } from "./ui/App";
import { setWebRegistration } from "./desktop/updates";
import "./ui/styles.css";

// Keep the SDK quiet: its debug logs can include room and event identifiers.
(logger as unknown as { setLevel?(l: string): void }).setLevel?.(import.meta.env.DEV ? "info" : "warn");

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);

// Installable PWA (not used inside the desktop shell, which bundles everything).
if (import.meta.env.PROD && !window.orreryDesktop && "serviceWorker" in navigator) {
    import("virtual:pwa-register").then(({ registerSW }) => {
        // autoUpdate: a new version installs, takes control and reloads the page once. Drafts are
        // saved per conversation, so nothing typed is lost. Also check hourly while the app stays open.
        // Older builds kept a duplicate copy of the speech models; free that space.
        void caches?.delete("orrery-speech-models").catch(() => undefined);
        registerSW({
            immediate: true,
            onRegisteredSW(_url, reg) {
                setWebRegistration(reg);
                if (reg) setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
            },
        });
    });
}
