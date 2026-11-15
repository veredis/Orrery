// Device verification and key recovery, using matrix-js-sdk's Rust crypto (the same implementation
// Element uses). Nothing here resets existing keys: we only import from secret storage, or create
// recovery when the account has none at all.
import type { MatrixClient } from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api";
import type { KeyBackupRestoreResult } from "matrix-js-sdk/lib/crypto-api";
import { provideSecretStorageKey } from "./session";

export interface SecurityStatus {
    deviceId: string;
    deviceVerified: boolean;
    crossSigningOnAccount: boolean;
    crossSigningReadyHere: boolean;
    secretStorageKey: boolean;
    backupVersion: string | null;
    backupActive: boolean;
}

/** Tell open views (e.g. the "verify this device" banner) to re-check after a verification. */
export const SECURITY_CHANGED = "orrery:security-changed";
export function notifySecurityChanged(): void {
    window.dispatchEvent(new Event(SECURITY_CHANGED));
}

/** After signing this device, the trust status can take a moment to update locally. */
export async function waitForVerified(client: MatrixClient, ms = 8000): Promise<boolean> {
    const crypto = client.getCrypto()!;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const dv = await crypto.getDeviceVerificationStatus(client.getUserId()!, client.getDeviceId()!);
        if (dv?.crossSigningVerified) return true;
        await new Promise((r) => setTimeout(r, 400));
    }
    return false;
}

export async function getSecurityStatus(client: MatrixClient): Promise<SecurityStatus> {
    const crypto = client.getCrypto()!;
    const me = client.getUserId()!;
    const deviceId = client.getDeviceId()!;
    const [dv, csOnAccount, csReady, ssKey, backupInfo, activeBackup] = await Promise.all([
        crypto.getDeviceVerificationStatus(me, deviceId),
        crypto.userHasCrossSigningKeys(me, true),
        crypto.isCrossSigningReady(),
        client.secretStorage.getDefaultKeyId(),
        crypto.getKeyBackupInfo().catch(() => null),
        crypto.getActiveSessionBackupVersion(),
    ]);
    return {
        deviceId,
        deviceVerified: !!dv?.crossSigningVerified,
        crossSigningOnAccount: csOnAccount,
        crossSigningReadyHere: csReady,
        secretStorageKey: !!ssKey,
        backupVersion: backupInfo?.version ?? null,
        backupActive: !!activeBackup,
    };
}

/**
 * Verify this device with the account's recovery key: unlock secret storage, import the
 * cross-signing keys, sign this device, then enable and restore key backup so older encrypted
 * messages become readable. The key is held in memory only for the duration of the call.
 */
export async function recoverWithKey(
    client: MatrixClient,
    recoveryKey: string,
    onProgress?: (done: number, total: number) => void,
): Promise<KeyBackupRestoreResult | null> {
    const crypto = client.getCrypto()!;
    let key: Uint8Array<ArrayBuffer>;
    try {
        key = decodeRecoveryKey(recoveryKey.trim());
    } catch {
        throw new Error("That isn't a valid recovery key. It looks like groups of letters and numbers, e.g. “EsTc …”.");
    }
    const keyId = await client.secretStorage.getDefaultKeyId();
    if (!keyId) throw new Error("This account has no secret storage set up, so there is nothing to recover from.");
    const keyInfo = await client.secretStorage.getKey(keyId);
    if (!keyInfo || !(await client.secretStorage.checkKey(key, keyInfo[1]))) throw new Error("That recovery key doesn't match this account.");
    provideSecretStorageKey(key, keyId);
    try {
        await crypto.bootstrapCrossSigning({});
        await crypto.crossSignDevice(client.getDeviceId()!).catch(() => undefined);
        let result: KeyBackupRestoreResult | null = null;
        const info = await crypto.getKeyBackupInfo();
        if (info) {
            await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
            await crypto.checkKeyBackupAndEnable();
            result = await crypto.restoreKeyBackup({
                progressCallback: (p) => {
                    if (p.stage === "load_keys") onProgress?.(p.successes + p.failures, p.total);
                },
            });
        }
        return result;
    } finally {
        provideSecretStorageKey(null);
        notifySecurityChanged();
    }
}

/**
 * First-time setup for an account with no cross-signing/recovery at all. Requires the account
 * password (the server asks for it to publish signing keys). Returns the new recovery key, which
 * the user must store; it is never saved by Orrery.
 */
export async function setUpRecovery(client: MatrixClient, password: string): Promise<string> {
    const crypto = client.getCrypto()!;
    if ((await crypto.userHasCrossSigningKeys(client.getUserId()!, true)) || (await client.secretStorage.getDefaultKeyId())) {
        throw new Error("This account already has encryption keys. Use your existing recovery key or verify from another device instead.");
    }
    let recoveryKey = "";
    await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async (makeRequest) => {
            await makeRequest({ type: "m.login.password", identifier: { type: "m.id.user", user: client.getUserId()! }, password } as never);
        },
    });
    await crypto.bootstrapSecretStorage({
        createSecretStorageKey: async () => {
            const k = await crypto.createRecoveryKeyFromPassphrase();
            recoveryKey = k.encodedPrivateKey ?? "";
            return k;
        },
        setupNewKeyBackup: true,
    });
    return recoveryKey;
}
