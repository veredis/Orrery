import type { MatrixClient } from "matrix-js-sdk";
import { decryptAttachment, type IEncryptedFile } from "matrix-encrypt-attachment";

// Media is fetched with the access token (authenticated media) and, for encrypted rooms, decrypted
// in memory. Results are cached as object URLs for the session.
const cache = new Map<string, Promise<string>>();
const MAX = 120;

export interface MediaRef {
    mxc: string;
    file?: IEncryptedFile;
    mimetype?: string;
}

export function mediaRefOf(content: Record<string, unknown>): MediaRef | null {
    const file = content.file as (IEncryptedFile & { url?: string }) | undefined;
    const info = content.info as { mimetype?: string } | undefined;
    if (file?.url) return { mxc: file.url, file, mimetype: info?.mimetype ?? (file as { mimetype?: string }).mimetype };
    if (typeof content.url === "string" && content.url.startsWith("mxc://")) return { mxc: content.url, mimetype: info?.mimetype };
    return null;
}

async function download(client: MatrixClient, ref: MediaRef): Promise<string> {
    if (!ref.mxc.startsWith("mxc://")) throw new Error("Unsupported media URL");
    const url = client.mxcUrlToHttp(ref.mxc, undefined, undefined, undefined, false, true, true);
    if (!url) throw new Error("Media URL unavailable");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${client.getAccessToken()}` }, credentials: "omit" });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    let data = await res.arrayBuffer();
    if (ref.file) data = await decryptAttachment(data, ref.file);
    // Never let the server choose an active content type; images/media only, everything else as octet-stream.
    const safeType = ref.mimetype && /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/[\w.+-]+)$/.test(ref.mimetype) ? ref.mimetype : "application/octet-stream";
    return URL.createObjectURL(new Blob([data], { type: safeType }));
}

export function mediaUrl(client: MatrixClient, ref: MediaRef): Promise<string> {
    const key = ref.mxc;
    let p = cache.get(key);
    if (!p) {
        p = download(client, ref);
        p.catch(() => cache.delete(key));
        cache.set(key, p);
        if (cache.size > MAX) {
            const oldest = cache.keys().next().value!;
            void cache.get(oldest)?.then((u) => URL.revokeObjectURL(u)).catch(() => undefined);
            cache.delete(oldest);
        }
    }
    return p;
}

export async function saveMedia(client: MatrixClient, ref: MediaRef, filename: string): Promise<void> {
    const url = await mediaUrl(client, ref);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.replace(/[\\/:*?"<>|]/g, "_");
    a.click();
}
