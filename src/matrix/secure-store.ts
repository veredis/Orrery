// Session secret storage.
//
// The access token and the key that encrypts the Rust crypto IndexedDB store are never written in
// plain text. In the desktop app they are sealed with Electron safeStorage (Windows DPAPI, bound to
// the Windows user). In browsers/PWA they are sealed with a non-extractable AES-GCM key kept in
// IndexedDB (the same "pickle key" approach Element Web uses): script on this origin can use the key
// but cannot export it, and the raw secret never lands in localStorage.

export interface StoredSession {
    homeserverUrl: string;
    userId: string;
    deviceId: string;
    accessToken: string;
    /** base64 32-byte key for the Rust crypto store */
    cryptoStoreKey: string;
}

interface SealedRecord {
    v: 1;
    kind: "desktop" | "webcrypto";
    homeserverUrl: string;
    userId: string;
    deviceId: string;
    iv?: string;
    sealed: string;
}

const LS_KEY = "orrery.session.v1";
const LAST_KEY = "orrery.last-identity.v1";
const DB_NAME = "orrery-keys";

declare global {
    interface Window {
        orreryDesktop?: {
            platform: string;
            version: string;
            sealSecret(plain: string): Promise<string | null>;
            unsealSecret(sealed: string): Promise<string | null>;
            openExternal(url: string): Promise<void>;
            updates?: {
                status(): Promise<import("../desktop/updates").UpdateStatus>;
                check(): Promise<import("../desktop/updates").UpdateStatus>;
                download(): Promise<import("../desktop/updates").UpdateStatus>;
                install(): Promise<boolean>;
                onStatus(cb: (s: import("../desktop/updates").UpdateStatus) => void): () => void;
            };
        };
    }
}

export const b64 = {
    enc(bytes: Uint8Array): string {
        let s = "";
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s);
    },
    dec(str: string): Uint8Array<ArrayBuffer> {
        const bin = atob(str);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    },
};

function idb<T>(fn: (store: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode): Promise<T> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, 1);
        open.onupgradeneeded = () => open.result.createObjectStore("keys");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("keys", mode);
            const req = fn(tx.objectStore("keys"));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            tx.oncomplete = () => db.close();
        };
    });
}

async function pickleKey(create: boolean): Promise<CryptoKey | null> {
    const existing = await idb<CryptoKey | undefined>((s) => s.get("pickle"), "readonly");
    if (existing || !create) return existing ?? null;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idb((s) => s.put(key, "pickle"), "readwrite");
    return key;
}

export async function saveSession(session: StoredSession): Promise<void> {
    const secret = JSON.stringify({ t: session.accessToken, k: session.cryptoStoreKey });
    const base = { v: 1 as const, homeserverUrl: session.homeserverUrl, userId: session.userId, deviceId: session.deviceId };
    let record: SealedRecord;
    const desktop = window.orreryDesktop;
    const sealed = desktop ? await desktop.sealSecret(secret) : null;
    if (sealed) {
        record = { ...base, kind: "desktop", sealed };
    } else {
        const key = await pickleKey(true);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key!, new TextEncoder().encode(secret)));
        record = { ...base, kind: "webcrypto", iv: b64.enc(iv), sealed: b64.enc(ct) };
    }
    localStorage.setItem(LS_KEY, JSON.stringify(record));
}

export async function loadSession(): Promise<StoredSession | null> {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    try {
        const rec = JSON.parse(raw) as SealedRecord;
        let plain: string | null = null;
        if (rec.kind === "desktop") {
            plain = (await window.orreryDesktop?.unsealSecret(rec.sealed)) ?? null;
        } else {
            const key = await pickleKey(false);
            if (key && rec.iv) {
                const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(rec.iv) }, key, b64.dec(rec.sealed));
                plain = new TextDecoder().decode(pt);
            }
        }
        if (!plain) return null;
        const { t, k } = JSON.parse(plain) as { t: string; k: string };
        return { homeserverUrl: rec.homeserverUrl, userId: rec.userId, deviceId: rec.deviceId, accessToken: t, cryptoStoreKey: k };
    } catch (e) {
        console.warn("Orrery: stored session could not be unsealed", (e as Error).name);
        return null;
    }
}

/** Non-secret identity of the last session (for showing "signed out" context). */
export function peekSessionIdentity(): { userId: string; homeserverUrl: string; deviceId: string } | null {
    try {
        const rec = JSON.parse(localStorage.getItem(LS_KEY) ?? "null") as SealedRecord | null;
        return rec ? { userId: rec.userId, homeserverUrl: rec.homeserverUrl, deviceId: rec.deviceId } : null;
    } catch {
        return null;
    }
}

export async function clearSession(): Promise<void> {
    // Remember who was signed in (not secret) so the sign-in form can be prefilled.
    const who = peekSessionIdentity();
    if (who) localStorage.setItem(LAST_KEY, JSON.stringify({ userId: who.userId, homeserverUrl: who.homeserverUrl }));
    localStorage.removeItem(LS_KEY);
    try {
        await idb((s) => s.delete("pickle"), "readwrite");
    } catch {
        /* ignore */
    }
}

/** The last account used on this device (user ID and homeserver only), for prefilling sign-in. */
export function lastIdentity(): { userId: string; homeserverUrl: string } | null {
    const cur = peekSessionIdentity();
    if (cur) return cur;
    try {
        return JSON.parse(localStorage.getItem(LAST_KEY) ?? "null");
    } catch {
        return null;
    }
}
