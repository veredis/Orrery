import {
    AutoDiscovery,
    ClientEvent,
    createClient,
    HttpApiEvent,
    IndexedDBStore,
    MatrixClient,
    PendingEventOrdering,
    RoomEvent,
    SyncState,
} from "matrix-js-sdk";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage";
import { create } from "zustand";
import { b64, clearSession, loadSession, saveSession, type StoredSession } from "./secure-store";
import { getConfig } from "../agents/registry";

export type AppStatus = "booting" | "signed-out" | "starting" | "ready" | "fatal";

interface MatrixState {
    status: AppStatus;
    client: MatrixClient | null;
    sync: SyncState | null;
    syncError: string | null;
    fatal: string | null;
    /** bumped whenever room list relevant state changes */
    roomsVersion: number;
    softLoggedOut: boolean;
}

export const useMatrix = create<MatrixState>(() => ({
    status: "booting",
    client: null,
    sync: null,
    syncError: null,
    fatal: null,
    roomsVersion: 0,
    softLoggedOut: false,
}));

// ---------------------------------------------------------------- secret storage key cache
// The recovery key is held only in memory for the duration of a recovery operation.
let cachedSecretKey: { keyId: string | null; key: Uint8Array<ArrayBuffer> } | null = null;
export function provideSecretStorageKey(key: Uint8Array<ArrayBuffer> | null, keyId: string | null = null): void {
    cachedSecretKey = key ? { key, keyId } : null;
}

const cryptoCallbacks = {
    getSecretStorageKey: async (opts: { keys: Record<string, SecretStorageKeyDescription> }): Promise<[string, Uint8Array<ArrayBuffer>] | null> => {
        if (!cachedSecretKey) return null;
        const ids = Object.keys(opts.keys);
        const keyId = cachedSecretKey.keyId && ids.includes(cachedSecretKey.keyId) ? cachedSecretKey.keyId : ids[0];
        return keyId ? [keyId, cachedSecretKey.key] : null;
    },
    cacheSecretStorageKey: (keyId: string, _info: SecretStorageKeyDescription, key: Uint8Array<ArrayBuffer>) => {
        cachedSecretKey = { keyId, key };
    },
};

// ---------------------------------------------------------------- helpers
export function deviceDisplayName(): string {
    const ua = navigator.userAgent;
    if (window.orreryDesktop) return `Orrery Desktop (${window.orreryDesktop.platform === "win32" ? "Windows" : window.orreryDesktop.platform})`;
    if (/Android/i.test(ua)) return "Orrery (Android)";
    if (/iPhone|iPad/i.test(ua)) return "Orrery (iOS)";
    return `Orrery Web (${/Edg\//.test(ua) ? "Edge" : /Firefox/.test(ua) ? "Firefox" : /Chrome/.test(ua) ? "Chrome" : "Browser"})`;
}

export function normaliseHomeserverInput(input: string): string {
    let s = input.trim();
    if (!s) throw new Error("Enter your homeserver address.");
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    const u = new URL(s);
    if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
        throw new Error("Use HTTPS for remote homeservers. Plain HTTP is only allowed for localhost.");
    }
    return u.origin + u.pathname.replace(/\/+$/, "");
}

/** Resolve a homeserver URL, following .well-known when present. */
export async function resolveHomeserver(input: string): Promise<string> {
    const url = normaliseHomeserverInput(input);
    try {
        const res = await fetch(`${url}/.well-known/matrix/client`, { credentials: "omit" });
        if (res.ok) {
            const wk = (await res.json()) as { "m.homeserver"?: { base_url?: string } };
            const base = wk["m.homeserver"]?.base_url;
            if (base) return normaliseHomeserverInput(base);
        }
    } catch {
        /* no well-known: fall through */
    }
    const versions = await fetch(`${url}/_matrix/client/versions`, { credentials: "omit" }).catch(() => null);
    if (!versions?.ok) {
        // last resort: treat input as a server name
        const disc = await AutoDiscovery.findClientConfig(new URL(url).host).catch(() => null);
        const base = disc?.["m.homeserver"]?.base_url;
        if (base) return normaliseHomeserverInput(base);
        throw new Error("Couldn't reach a Matrix homeserver at that address. If it's your tailnet server, check that Tailscale is on.");
    }
    return url;
}

export function friendlyError(e: unknown): string {
    const err = e as { errcode?: string; data?: { error?: string; retry_after_ms?: number }; httpStatus?: number; message?: string; name?: string };
    if (err?.errcode === "M_FORBIDDEN") return "Incorrect username or password.";
    if (err?.errcode === "M_LIMIT_EXCEEDED") {
        const s = Math.ceil((err.data?.retry_after_ms ?? 60000) / 1000);
        return `Too many attempts. The server asks you to wait about ${s} seconds.`;
    }
    if (err?.errcode === "M_USER_DEACTIVATED") return "This account has been deactivated.";
    if (err?.name === "ConnectionError" || err?.name === "TypeError") return "Can't reach the homeserver. Check that Tailscale is on for this device (with Tailscale DNS enabled).";
    return err?.data?.error || err?.message || "Something went wrong.";
}

// ---------------------------------------------------------------- lifecycle
export async function login(homeserverInput: string, username: string, password: string): Promise<void> {
    const homeserverUrl = await resolveHomeserver(homeserverInput);
    const tmp = createClient({ baseUrl: homeserverUrl });
    const user = username.trim().replace(/^@/, "").split(":")[0];
    const res = await tmp.loginRequest({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: username.trim().startsWith("@") ? username.trim() : user },
        password,
        initial_device_display_name: deviceDisplayName(),
    });
    const session: StoredSession = {
        homeserverUrl: res.well_known?.["m.homeserver"]?.base_url
            ? normaliseHomeserverInput(res.well_known["m.homeserver"].base_url)
            : homeserverUrl,
        userId: res.user_id,
        deviceId: res.device_id,
        accessToken: res.access_token,
        cryptoStoreKey: b64.enc(crypto.getRandomValues(new Uint8Array(32))),
    };
    await saveSession(session);
    await startSession(session);
}

let running: MatrixClient | null = null;

async function startSession(session: StoredSession): Promise<void> {
    useMatrix.setState({ status: "starting", fatal: null, softLoggedOut: false });
    const store = new IndexedDBStore({
        indexedDB: window.indexedDB,
        localStorage: window.localStorage,
        dbName: `orrery-sync:${session.userId}`,
    });
    const client = createClient({
        baseUrl: session.homeserverUrl,
        accessToken: session.accessToken,
        userId: session.userId,
        deviceId: session.deviceId,
        store,
        timelineSupport: true,
        cryptoCallbacks,
        verificationMethods: ["m.sas.v1"],
    });
    try {
        await store.startup();
    } catch (e) {
        console.warn("Orrery: sync cache unavailable, continuing without it", e);
    }
    try {
        await client.initRustCrypto({
            storageKey: b64.dec(session.cryptoStoreKey),
            cryptoDatabasePrefix: `orrery-crypto:${session.userId}:${session.deviceId}`,
        });
    } catch (e) {
        // Never silently continue without encryption: the user's rooms are encrypted.
        useMatrix.setState({
            status: "fatal",
            fatal: `Encryption could not start on this device (${(e as Error).message}). Your keys were not changed. Sign out and back in to create a fresh device.`,
        });
        return;
    }
    const bump = () => useMatrix.setState((s) => ({ roomsVersion: s.roomsVersion + 1 }));
    let bumpQueued = false;
    const queueBump = () => {
        if (bumpQueued) return;
        bumpQueued = true;
        requestAnimationFrame(() => {
            bumpQueued = false;
            bump();
        });
    };
    client.on(ClientEvent.Sync, (state, _prev, data) => {
        useMatrix.setState({ sync: state, syncError: state === SyncState.Error ? (data?.error?.message ?? "Sync failed") : null });
        if (state === SyncState.Prepared) useMatrix.setState({ status: "ready" });
        queueBump();
    });
    client.on(ClientEvent.Room, queueBump);
    client.on(ClientEvent.DeleteRoom, queueBump);
    client.on(ClientEvent.AccountData, queueBump);
    client.on(RoomEvent.Timeline, queueBump);
    client.on(RoomEvent.Name, queueBump);
    client.on(RoomEvent.MyMembership, queueBump);
    client.on(RoomEvent.Receipt, queueBump);
    client.on(HttpApiEvent.SessionLoggedOut, () => {
        // The server no longer accepts this device's token (signed out elsewhere, or the device was
        // deleted). The device and its keys are gone server-side, so drop the local copy and ask the
        // user to sign in again rather than spinning forever.
        client.stopClient();
        client.removeAllListeners();
        // A stopped client can still have retries in flight; never let a stale one end a newer session.
        if (running !== client) return;
        running = null;
        void (async () => {
            try {
                await client.clearStores();
            } catch {
                /* ignore */
            }
            await clearSession();
            useMatrix.setState({ status: "signed-out", client: null, sync: null, softLoggedOut: true });
        })();
    });
    running = client;
    useMatrix.setState({ client });
    await client.startClient({
        initialSyncLimit: 30,
        lazyLoadMembers: true,
        threadSupport: false,
        pendingEventOrdering: PendingEventOrdering.Detached,
        pollTimeout: 30000,
    });
}

export async function boot(): Promise<void> {
    const session = await loadSession();
    if (!session) {
        useMatrix.setState({ status: "signed-out" });
        return;
    }
    // The server was renamed (same Synapse, same accounts and tokens): follow it to the new address.
    const moved = getConfig().homeserver_moves?.[session.homeserverUrl.replace(/\/+$/, "")];
    if (moved && moved !== session.homeserverUrl) {
        session.homeserverUrl = moved;
        await saveSession(session);
    }
    await startSession(session);
}

/** Sign out: deletes this device on the server, then wipes local stores. */
export async function logout(): Promise<void> {
    const client = running;
    running = null;
    if (client) {
        client.stopClient();
        try {
            await client.logout(true);
        } catch (e) {
            console.warn("Orrery: server logout failed; clearing local session anyway", (e as Error).name);
        }
        try {
            await client.clearStores();
        } catch {
            /* ignore */
        }
    }
    await clearSession();
    useMatrix.setState({ status: "signed-out", client: null, sync: null, softLoggedOut: false });
}

/** Restart sync after a network error or resume. */
export function retrySync(): void {
    running?.retryImmediately();
}
