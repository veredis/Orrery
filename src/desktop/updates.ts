// App updates as seen by the UI.
//  - Desktop (Electron): the main process checks GitHub Releases, downloads and installs on request.
//  - Web/PWA: the service worker fetches new versions by itself; "Check now" just asks it to look.
import { create } from "zustand";

export type UpdateState = "idle" | "checking" | "available" | "latest" | "downloading" | "downloaded" | "error" | "unsupported";
export interface UpdateStatus {
    state: UpdateState;
    current: string;
    version?: string;
    date?: string;
    percent?: number;
    error?: string;
}

export const RELEASES_URL = "https://github.com/veredis/Orrery/releases";
export const releaseUrl = (v: string) => `${RELEASES_URL}/tag/v${encodeURIComponent(v)}`;

const AUTO_FIRST_MS = 20_000;
const AUTO_EVERY_MS = 6 * 60 * 60 * 1000;

export const useUpdate = create<{ status: UpdateStatus | null }>(() => ({ status: null }));
const api = () => window.orreryDesktop?.updates;
export const desktopUpdatesAvailable = () => !!api();

/** Subscribe to the desktop updater; with `autoCheck`, look shortly after launch and every 6 hours. */
export function initDesktopUpdates(autoCheck: boolean, onFound?: (v: string) => void): () => void {
    const u = api();
    if (!u) return () => undefined;
    let last: UpdateState | undefined;
    const apply = (s: UpdateStatus) => {
        if (s.state === "available" && last !== "available" && s.version) onFound?.(s.version);
        last = s.state;
        useUpdate.setState({ status: s });
    };
    const off = u.onStatus(apply);
    void u.status().then(apply).catch(() => undefined);
    const quietCheck = () => {
        const st = useUpdate.getState().status?.state;
        if (!st || st === "idle" || st === "latest" || st === "error") void u.check().catch(() => undefined);
    };
    const timers: number[] = [];
    if (autoCheck) {
        timers.push(window.setTimeout(quietCheck, AUTO_FIRST_MS));
        timers.push(window.setInterval(quietCheck, AUTO_EVERY_MS));
    }
    return () => {
        off();
        timers.forEach((t) => clearTimeout(t));
    };
}

export const checkForUpdates = () => api()?.check();
export const downloadUpdate = () => api()?.download();
export const installUpdate = () => api()?.install();

// ---------------------------------------------------------------- web (service worker)
let webReg: ServiceWorkerRegistration | undefined;
export const setWebRegistration = (r: ServiceWorkerRegistration | undefined) => void (webReg = r);
export const webUpdatesAvailable = () => !!webReg;

/** Ask the service worker to look for a new version. A new one installs and reloads the page by itself. */
export async function checkWebUpdate(): Promise<"updating" | "latest"> {
    if (!webReg) return "latest";
    await webReg.update();
    return webReg.installing || webReg.waiting ? "updating" : "latest";
}
