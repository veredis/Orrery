// Orrery desktop shell. Serves the built web app from a private orrery://app origin so that the
// app gets a stable secure origin (IndexedDB, crypto, service-worker-free), strict CSP and
// cross-origin isolation (multi-threaded speech recognition). The renderer is fully sandboxed:
// no Node integration. The only bridge is a tiny preload exposing secret sealing (OS keychain via
// safeStorage / DPAPI), opening external links in the system browser, and in-app updates
// (check / download / install from GitHub Releases; see updater.cjs).
"use strict";
const { app, BrowserWindow, protocol, net, ipcMain, safeStorage, shell, session, Menu, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { registerUpdateIpc } = require("./updater.cjs");

const SCHEME = "orrery";
const ORIGIN = `${SCHEME}://app`;
const DIST = path.join(__dirname, "..", "dist");
const isDev = process.env.ORRERY_DEV_URL; // e.g. http://localhost:5173 for live development

// Testing aid: run with a separate profile (sign-in, keys, settings) instead of the normal one.
if (process.env.ORRERY_USER_DATA && path.isAbsolute(process.env.ORRERY_USER_DATA)) app.setPath("userData", process.env.ORRERY_USER_DATA);

protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w) {
            if (w.isMinimized()) w.restore();
            w.focus();
        }
    });
}

app.setAppUserModelId("dev.orrery.app");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".onnx": "application/octet-stream",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
};

function serveApp(request) {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(DIST, rel));
    // Path traversal guard: only files under dist/ are served.
    if (!file.startsWith(DIST + path.sep)) return new Response("Forbidden", { status: 403 });
    let target = file;
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        // SPA fallback for navigations only; missing assets are real 404s.
        if (path.extname(rel)) return new Response("Not found", { status: 404 });
        target = path.join(DIST, "index.html");
    }
    return net.fetch(pathToFileURL(target).toString()).then(
        (res) =>
            new Response(res.body, {
                status: 200,
                headers: {
                    "Content-Type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
                    // Cross-origin isolation lets the speech model use several CPU threads.
                    "Cross-Origin-Opener-Policy": "same-origin",
                    "Cross-Origin-Embedder-Policy": "credentialless",
                    "Cross-Origin-Resource-Policy": "same-origin",
                    "X-Content-Type-Options": "nosniff",
                    "Referrer-Policy": "no-referrer",
                    "Cache-Control": "no-cache",
                },
            }),
    );
}

function isOurOrigin(u) {
    try {
        const url = new URL(u);
        if (isDev) return url.origin === new URL(isDev).origin;
        // Node's URL reports the origin of custom schemes as "null", so compare scheme and host.
        return url.protocol === `${SCHEME}:` && url.host === "app";
    } catch {
        return false;
    }
}

function openExternalSafe(u) {
    try {
        const url = new URL(u);
        if (["https:", "http:", "mailto:"].includes(url.protocol)) void shell.openExternal(url.toString());
    } catch {
        /* ignore malformed */
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1320,
        height: 860,
        minWidth: 380,
        minHeight: 520,
        title: "Orrery",
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e0c16" : "#f7f6fb",
        icon: path.join(__dirname, "..", "build", "icon.png"),
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webviewTag: false,
            spellcheck: true,
            backgroundThrottling: false,
        },
    });
    win.once("ready-to-show", () => win.show());

    // Never navigate the app window away from the app; open links in the system browser instead.
    win.webContents.on("will-navigate", (e, url) => {
        if (!isOurOrigin(url)) {
            e.preventDefault();
            openExternalSafe(url);
        }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("blob:") && isOurOrigin(url.slice(5))) return { action: "allow" };
        openExternalSafe(url);
        return { action: "deny" };
    });
    win.webContents.on("context-menu", (_e, params) => {
        const items = [];
        if (params.misspelledWord) {
            for (const s of params.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
            if (items.length) items.push({ type: "separator" });
        }
        if (params.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
        else if (params.selectionText) items.push({ role: "copy" });
        if (params.linkURL && /^https?:|^mailto:/.test(params.linkURL)) {
            items.push({ type: "separator" }, { label: "Open link in browser", click: () => openExternalSafe(params.linkURL) });
        }
        if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
    });

    void win.loadURL(isDev ? isDev : `${ORIGIN}/`);
    return win;
}

// ---------------------------------------------------------------- secret sealing (OS keychain)
ipcMain.handle("orrery:seal", (e, plain) => {
    if (!isOurOrigin(e.senderFrame.url)) throw new Error("denied");
    if (typeof plain !== "string") throw new Error("bad input");
    if (!safeStorage.isEncryptionAvailable()) return null; // renderer falls back to its own sealing
    return safeStorage.encryptString(plain).toString("base64");
});
ipcMain.handle("orrery:unseal", (e, sealed) => {
    if (!isOurOrigin(e.senderFrame.url)) throw new Error("denied");
    if (typeof sealed !== "string") throw new Error("bad input");
    return safeStorage.decryptString(Buffer.from(sealed, "base64"));
});
ipcMain.handle("orrery:open-external", (e, url) => {
    if (!isOurOrigin(e.senderFrame.url)) throw new Error("denied");
    openExternalSafe(url);
});
registerUpdateIpc(isOurOrigin);

app.whenReady().then(() => {
    protocol.handle(SCHEME, serveApp);

    const ses = session.defaultSession;
    // Microphone (for dictation) and notifications only, and only for our own origin.
    const ALLOWED = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen"]);
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
        const ok = ALLOWED.has(permission) && isOurOrigin(details.requestingUrl ?? wc.getURL());
        if (permission === "media" && ok) {
            const types = details.mediaTypes ?? [];
            cb(types.every((t) => t === "audio"));
            return;
        }
        cb(ok);
    });
    ses.setPermissionCheckHandler((_wc, permission, origin) => ALLOWED.has(permission) && isOurOrigin(origin));
    ses.setDevicePermissionHandler(() => false);
    // No speech or other data goes to Google: Chromium's built-in cloud speech API is not wired up
    // in Electron, and the app reports the browser recognizer as unavailable there.

    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
