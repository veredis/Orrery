import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { existsSync, readFileSync } from "node:fs";

// Strict CSP for production builds (dev needs inline HMR scripts). Homeserver origins are arbitrary
// HTTPS (or loopback for local development), so connect-src allows https: plus loopback.
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-src 'none'",
].join("; ");
const cspPlugin = {
    name: "orrery-csp",
    apply: "build" as const,
    transformIndexHtml: (html: string) =>
        html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

// config.json: the desktop build always ships the generic config/default.json; the web build and the
// dev server use your own local/config.json when it exists (git-ignored; see config/README.md).
function configPlugin(mode: string) {
    const local = mode !== "production" && existsSync("local/config.json");
    const source = () => readFileSync(local ? "local/config.json" : "config/default.json", "utf8");
    return {
        name: "orrery-config",
        configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(s: string): void }, next: () => void) => void): void } }) {
            server.middlewares.use((req, res, next) => {
                if (!req.url?.split("?")[0].endsWith("/config.json")) return next();
                res.setHeader("Content-Type", "application/json");
                res.end(source());
            });
        },
        generateBundle(this: { emitFile(f: { type: "asset"; fileName: string; source: string }): void }) {
            this.emitFile({ type: "asset", fileName: "config.json", source: source() });
        },
    };
}

// `--mode web` builds the hosted PWA (served under ORRERY_BASE, default /orrery/).
// The default build is used by the Electron shell, which serves dist/ from orrery://app/.
export default defineConfig(({ mode }) => {
    const base = mode === "web" ? process.env.ORRERY_BASE ?? "/orrery/" : "/";
    return {
        base,
        plugins: [
            react(),
            cspPlugin,
            configPlugin(mode),
            VitePWA({
                // New versions take over immediately: a refresh (or reopening the app) shows the update.
                registerType: "autoUpdate",
                injectRegister: false,
                includeAssets: ["icons/*.png", "icons/*.svg"], // config.json is emitted by orrery-config and precached via globPatterns
                manifest: {
                    id: base,
                    name: "Orrery",
                    short_name: "Orrery",
                    description: "AI-first Matrix workspace for Hermes and your agents",
                    theme_color: "#14111f",
                    background_color: "#0e0c16",
                    display: "standalone",
                    display_override: ["window-controls-overlay", "standalone"],
                    orientation: "any",
                    start_url: base,
                    scope: base,
                    categories: ["productivity", "social"],
                    icons: [
                        { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
                        { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
                        { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
                    ],
                    shortcuts: [{ name: "New chat", url: `${base}?action=new`, icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] }],
                },
                workbox: {
                    // App shell + crypto wasm are precached; speech models are cached on first use.
                    globPatterns: ["**/*.{js,css,html,svg,png,wasm,json,woff2}"],
                    globIgnores: ["models/**", "ort/**", "assets/ort-wasm*"],
                    maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
                    skipWaiting: true,
                    clientsClaim: true,
                    cleanupOutdatedCaches: true,
                    navigateFallbackDenylist: [/^\/_matrix/, /^\/\.well-known/],
                    // Speech models are cached once by Transformers.js itself ("transformers-cache");
                    // a second service-worker cache would double the storage (~150 MB instead of ~76 MB).
                },
            }),
        ],
        define: {
            __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
            // Shown in Settings → About so you can tell which build is running.
            __APP_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"),
        },
        optimizeDeps: { exclude: ["@matrix-org/matrix-sdk-crypto-wasm", "@huggingface/transformers"] },
        worker: { format: "es" },
        build: { target: "es2022", outDir: mode === "web" ? "dist-web" : "dist", sourcemap: mode !== "web", chunkSizeWarningLimit: 4000 },
        server: { port: 5173, strictPort: true },
        test: { environment: "node" },
    };
});
