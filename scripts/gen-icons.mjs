// Renders the brand mark SVG to the PNG sizes the PWA manifest and Windows installer need.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const svg = readFileSync(join(root, "public/icons/icon.svg"), "utf8");
// Maskable: full-bleed background with the mark inside the 80% safe zone.
const maskable = svg
    .replace('<rect width="64" height="64" rx="16" fill="url(#g)"/>', '<rect width="64" height="64" fill="url(#g)"/>')
    .replace(/<ellipse|<circle/, (m) => `<g transform="translate(6.4 6.4) scale(.8)">${m}`)
    .replace("</svg>", "</g></svg>");
const render = (src, size) => new Resvg(src, { fitTo: { mode: "width", value: size } }).render().asPng();
mkdirSync(join(root, "build"), { recursive: true });
writeFileSync(join(root, "public/icons/icon-192.png"), render(svg, 192));
writeFileSync(join(root, "public/icons/icon-512.png"), render(svg, 512));
writeFileSync(join(root, "public/icons/maskable-512.png"), render(maskable, 512));
writeFileSync(join(root, "build/icon.png"), render(svg, 512));
console.log("icons generated");
