// In-app updates for the installed Windows app, from this project's GitHub Releases.
//
// Nothing happens without the user: the app only *checks* (when they click "Check for updates",
// or at launch if "Check automatically" is on). Downloading and installing each need a click.
// Each download is verified against the SHA-512 in the release's latest.yml before it runs.
// The renderer can only ask for check / download / install; it can't choose the URL or file.
"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");

/** @type {{ state: string, current: string, version?: string, date?: string, percent?: number, error?: string }} */
let status = { state: "idle", current: app.getVersion() };
let updater = null;

function set(patch) {
    status = { ...status, ...patch, current: app.getVersion() };
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("orrery:update", status);
}

function friendly(err) {
    const m = String(err?.message ?? err ?? "");
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR_/i.test(m)) return "Couldn't reach GitHub. Check your internet connection.";
    if (/404|Cannot find latest|No published versions/i.test(m)) return "No published release was found yet.";
    if (/sha512 checksum mismatch/i.test(m)) return "The download didn't match its checksum, so it was discarded. Try again.";
    return m.split("\n")[0].slice(0, 200) || "Update failed.";
}

function getUpdater() {
    if (updater) return updater;
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true; // a downloaded update also installs on a normal quit
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null; // no update logs on disk

    // Local testing only: ORRERY_UPDATE_FEED=http://127.0.0.1:PORT/ serves latest.yml + installer.
    const feed = process.env.ORRERY_UPDATE_FEED;
    if (feed) {
        const u = new URL(feed);
        const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
        if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) autoUpdater.setFeedURL({ provider: "generic", url: u.href });
    }

    autoUpdater.on("checking-for-update", () => set({ state: "checking", error: undefined }));
    autoUpdater.on("update-available", (i) => set({ state: "available", version: i.version, date: i.releaseDate }));
    autoUpdater.on("update-not-available", () => set({ state: "latest", version: undefined }));
    autoUpdater.on("download-progress", (p) => set({ state: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (i) => set({ state: "downloaded", version: i.version, percent: 100 }));
    autoUpdater.on("error", (e) => set({ state: "error", error: friendly(e) }));
    updater = autoUpdater;
    return updater;
}

/** Updates work only in the installed app (not in development or the unpacked folder build). */
function supported() {
    return app.isPackaged && process.platform === "win32" && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function registerUpdateIpc(isOurOrigin) {
    const guard = (e) => {
        if (!isOurOrigin(e.senderFrame.url)) throw new Error("denied");
    };
    ipcMain.handle("orrery:update-status", (e) => {
        guard(e);
        return supported() ? status : { ...status, state: "unsupported" };
    });
    ipcMain.handle("orrery:update-check", async (e) => {
        guard(e);
        if (!supported()) return { ...status, state: "unsupported" };
        if (["checking", "downloading", "downloaded"].includes(status.state)) return status;
        try {
            await getUpdater().checkForUpdates();
        } catch (err) {
            set({ state: "error", error: friendly(err) });
        }
        return status;
    });
    ipcMain.handle("orrery:update-download", async (e) => {
        guard(e);
        if (!supported() || status.state !== "available") return status;
        set({ state: "downloading", percent: 0 });
        try {
            await getUpdater().downloadUpdate();
        } catch (err) {
            set({ state: "error", error: friendly(err) });
        }
        return status;
    });
    ipcMain.handle("orrery:update-install", (e) => {
        guard(e);
        if (!supported() || status.state !== "downloaded") return false;
        // Silent install over the current one, then relaunch. Settings, sign-in and keys are kept:
        // they live in the user profile, not in the install folder.
        setImmediate(() => getUpdater().quitAndInstall(true, true));
        return true;
    });
}

module.exports = { registerUpdateIpc };
