// Minimal, audited bridge. No Node APIs are exposed to the web app.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orreryDesktop", {
    platform: process.platform,
    version: process.versions.electron,
    sealSecret: (plain) => ipcRenderer.invoke("orrery:seal", String(plain)),
    unsealSecret: (sealed) => ipcRenderer.invoke("orrery:unseal", String(sealed)),
    openExternal: (url) => ipcRenderer.invoke("orrery:open-external", String(url)),
    // In-app updates: the page can only ask; the main process decides where updates come from.
    updates: {
        status: () => ipcRenderer.invoke("orrery:update-status"),
        check: () => ipcRenderer.invoke("orrery:update-check"),
        download: () => ipcRenderer.invoke("orrery:update-download"),
        install: () => ipcRenderer.invoke("orrery:update-install"),
        onStatus: (cb) => {
            const h = (_e, s) => cb(s);
            ipcRenderer.on("orrery:update", h);
            return () => ipcRenderer.removeListener("orrery:update", h);
        },
    },
});
