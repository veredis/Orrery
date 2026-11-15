// Minimal static server for the PWA build (dist-web), mounted at /orrery/ like the Tailscale Serve path.
// Real 404s (no SPA fallback, matching Tailscale's file server). Binds to loopback by default.
//   node scripts/serve-web.mjs [--port 4180] [--isolate]
// --isolate adds COOP/COEP so on-device speech recognition can use several CPU threads.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] || 4180) || 4180;
const isolate = args.includes("--isolate");
const root = path.resolve(import.meta.dirname, "..", "dist-web");
const MOUNT = "/orrery/";
const TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".onnx": "application/octet-stream", ".txt": "text/plain",
};

http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/orrery") {
        res.writeHead(301, { Location: MOUNT });
        return res.end();
    }
    if (!url.pathname.startsWith(MOUNT)) {
        res.writeHead(404);
        return res.end("Not found");
    }
    let rel = decodeURIComponent(url.pathname.slice(MOUNT.length)) || "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        return res.end("Not found");
    }
    const headers = {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": fs.statSync(file).size,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": /\/assets\//.test(url.pathname) ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (isolate) Object.assign(headers, { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" });
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`Orrery PWA on http://127.0.0.1:${port}${MOUNT}${isolate ? " (cross-origin isolated)" : ""}`));
