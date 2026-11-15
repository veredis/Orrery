// Fetches the on-device speech models (Whisper, ONNX, int8) and the ONNX Runtime WASM files into
// public/ so dictation works fully offline and never sends audio anywhere. Run once: npm run models
import { createWriteStream, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODELS = (process.env.ORRERY_WHISPER_MODELS ?? "onnx-community/whisper-base.en,onnx-community/whisper-tiny.en").split(",");
const FILES = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
];
const root = join(import.meta.dirname, "..", "public");

for (const model of MODELS) {
    for (const f of FILES) {
        const dest = join(root, "models", model, f);
        if (existsSync(dest) && statSync(dest).size > 0) continue;
        mkdirSync(dirname(dest), { recursive: true });
        const url = `https://huggingface.co/${model}/resolve/main/${f}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
        console.log(`fetched ${model}/${f} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
    }
}

const ortDist = join(import.meta.dirname, "..", "node_modules", "onnxruntime-web", "dist");
mkdirSync(join(root, "ort"), { recursive: true });
for (const f of readdirSync(ortDist)) {
    if (/^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(f)) copyFileSync(join(ortDist, f), join(root, "ort", f));
}
console.log("speech models and ONNX runtime ready in public/");
