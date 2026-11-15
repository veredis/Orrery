// Interactive emoji (SAS) verification with another of your devices, e.g. Element on the phone.
import { useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { CryptoEvent, VerificationPhase, VerificationRequestEvent, VerifierEvent, type ShowSasCallbacks, type VerificationRequest } from "matrix-js-sdk/lib/crypto-api";
import { notifySecurityChanged } from "../matrix/recovery";
import { create } from "zustand";
import { I } from "./icons";
import { toast } from "./state";

const useVerif = create<{ request: VerificationRequest | null; incoming: boolean }>(() => ({ request: null, incoming: false }));

export async function startSelfVerification(client: MatrixClient) {
    try {
        const request = await client.getCrypto()!.requestOwnUserVerification();
        useVerif.setState({ request, incoming: false });
    } catch (e) {
        toast(`Couldn't start verification: ${(e as Error).message}`, "error");
    }
}

export function useIncomingVerification(client: MatrixClient | null) {
    useEffect(() => {
        if (!client) return;
        const onReq = (request: VerificationRequest) => {
            // Only offer self-verification (our own other devices); ignore others' requests here.
            if (request.otherUserId !== client.getUserId()) return;
            useVerif.setState({ request, incoming: true });
        };
        client.on(CryptoEvent.VerificationRequestReceived, onReq);
        return () => {
            client.off(CryptoEvent.VerificationRequestReceived, onReq);
        };
    }, [client]);
}

export function VerificationDialog() {
    const { request, incoming } = useVerif();
    const [, setTick] = useState(0);
    const [sas, setSas] = useState<ShowSasCallbacks | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!request) return;
        const onChange = () => {
            setTick((t) => t + 1);
            const v = request.verifier;
            if (v && !v.hasBeenCancelled) {
                v.on(VerifierEvent.ShowSas, (s) => setSas(s));
                if (incoming) v.verify().catch(() => undefined);
            }
            if (request.phase === VerificationPhase.Done) {
                toast("This device is verified");
                notifySecurityChanged();
                setTimeout(close, 900);
            }
            if (request.phase === VerificationPhase.Cancelled) setTimeout(close, 1500);
        };
        request.on(VerificationRequestEvent.Change, onChange);
        onChange();
        return () => {
            request.off(VerificationRequestEvent.Change, onChange);
        };
    }, [request, incoming]);

    if (!request) return null;
    function close() {
        useVerif.setState({ request: null });
        setSas(null);
        setBusy(false);
    }
    const cancel = () => {
        void request.cancel().catch(() => undefined);
        close();
    };
    const phase = request.phase;

    const start = async () => {
        setBusy(true);
        try {
            const verifier = await request.startVerification("m.sas.v1");
            verifier.on(VerifierEvent.ShowSas, (s) => setSas(s));
            await verifier.verify();
        } catch (e) {
            if (!request.cancellationCode) toast(`Verification failed: ${(e as Error).message}`, "error");
        } finally {
            setBusy(false);
        }
    };

    let body;
    if (phase === VerificationPhase.Cancelled) body = <p>Verification was cancelled{request.cancellationCode ? ` (${request.cancellationCode})` : ""}.</p>;
    else if (phase === VerificationPhase.Done) body = <p><I.check width={16} /> Verified.</p>;
    else if (sas?.sas.emoji) {
        body = (
            <>
                <p>Confirm these emoji appear on your other device, in the same order.</p>
                <div className="sas-grid">
                    {sas.sas.emoji.map(([e, name], i) => <div key={i}><span>{e}</span>{name}</div>)}
                </div>
                <div className="modal-actions">
                    <button className="btn danger" onClick={() => { sas.mismatch(); close(); }}>They don't match</button>
                    <button className="btn primary" onClick={() => { setBusy(true); void sas.confirm(); }} disabled={busy}>They match</button>
                </div>
            </>
        );
    } else if (incoming && (phase === VerificationPhase.Requested)) {
        body = (
            <>
                <p>Another of your devices wants to verify this one. Only accept if you just started this.</p>
                <div className="modal-actions">
                    <button className="btn ghost" onClick={cancel}>Ignore</button>
                    <button className="btn primary" onClick={() => request.accept().catch((e) => toast(e.message, "error"))}>Accept</button>
                </div>
            </>
        );
    } else if (phase === VerificationPhase.Ready) {
        body = (
            <>
                <p>Your other device is ready. Compare emoji to finish.</p>
                <div className="modal-actions">
                    <button className="btn primary" onClick={start} disabled={busy}>{busy ? <div className="spinner" /> : null} Compare emoji</button>
                </div>
            </>
        );
    } else {
        body = (
            <div className="row"><div className="spinner" /><p>{incoming ? "Waiting for your other device…" : "Open Element (or another signed-in app) on one of your devices and accept the verification request."}</p></div>
        );
    }

    return (
        <div className="modal-backdrop">
            <div className="modal" role="dialog" aria-modal="true" aria-label="Verify this device">
                <div className="row"><I.shield width={20} style={{ color: "var(--accent-2)" }} /><h3 className="grow">Verify this device</h3><button className="icon-btn sm" onClick={cancel} aria-label="Close"><I.x /></button></div>
                {body}
            </div>
        </div>
    );
}
