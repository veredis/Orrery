#!/usr/bin/env python3
"""Static file server for the Orrery PWA, meant to sit behind the tailnet-only Tailscale Serve /orrery path.

- Binds to 127.0.0.1 only; Tailscale Serve is the only way in.
- GET/HEAD of files under --root only: no directory listings, no uploads, nothing executes.
- Sends COOP/COEP so the PWA is cross-origin isolated (multi-threaded on-device speech recognition).
- Accepts paths with or without the /orrery prefix, whichever way Tailscale forwards them.
"""
import argparse
import os
import posixpath
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

PREFIX = "/orrery"
TYPES = {
    ".webmanifest": "application/manifest+json",
    ".wasm": "application/wasm",
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".onnx": "application/octet-stream",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
}


class Handler(SimpleHTTPRequestHandler):
    server_version = "orrery-web"
    sys_version = ""
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **TYPES}

    def _rel(self):
        path = posixpath.normpath(unquote(urlsplit(self.path).path))
        if path == PREFIX or path.startswith(PREFIX + "/"):
            path = path[len(PREFIX):]
        path = path.lstrip("/")
        if path in ("", "."):
            path = "index.html"
        if path.startswith("..") or "\x00" in path:
            return None
        return path

    def send_head(self):
        rel = self._rel()
        full = os.path.realpath(os.path.join(self.directory, rel)) if rel else None
        root = os.path.realpath(self.directory)
        if not full or not full.startswith(root + os.sep) or not os.path.isfile(full):
            self.send_error(404)
            return None
        self.path = "/" + os.path.relpath(full, root).replace(os.sep, "/")
        return super().send_head()

    def list_directory(self, path):  # never list directories
        self.send_error(404)
        return None

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        name = self.path.rsplit("/", 1)[-1]
        if name in ("index.html", "sw.js", "manifest.webmanifest", "config.json", "registerSW.js") or not name:
            self.send_header("Cache-Control", "no-cache")
        elif "/assets/" in self.path:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        super().end_headers()

    def log_request(self, code="-", size="-"):  # keep journald quiet: errors only
        if str(getattr(code, "value", code)).startswith(("4", "5")):
            super().log_request(code, size)

    def do_POST(self):
        self.send_error(405)

    do_PUT = do_DELETE = do_PATCH = do_POST


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--port", type=int, default=8089)
    a = ap.parse_args()
    handler = lambda *x, **k: Handler(*x, directory=a.root, **k)  # noqa: E731
    ThreadingHTTPServer(("127.0.0.1", a.port), handler).serve_forever()


if __name__ == "__main__":
    main()
