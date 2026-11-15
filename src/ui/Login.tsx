import { useState } from "react";
import { friendlyError, login, useMatrix } from "../matrix/session";
import { lastIdentity } from "../matrix/secure-store";
import { getConfig } from "../agents/registry";
import { BrandMark } from "./icons";

export function Login() {
    const prev = lastIdentity();
    const ended = useMatrix((s) => s.softLoggedOut);
    const [hs, setHs] = useState(prev?.homeserverUrl ?? getConfig().default_homeserver);
    const [user, setUser] = useState(prev?.userId ?? "");
    const [pw, setPw] = useState("");
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [showServer, setShowServer] = useState(!hs);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
            await login(hs, user, pw);
        } catch (ex) {
            setErr(friendlyError(ex));
            setBusy(false);
        }
    };

    return (
        <div className="screen-center">
            <div className="login">
                <div className="login-hero">
                    <BrandMark size={56} />
                    <h1>Welcome to Orrery</h1>
                    <p>Your AI workspace on Matrix — encrypted chats with Hermes and your agents.</p>
                </div>
                <form className="card" onSubmit={submit} autoComplete="on">
                    <label className="field">
                        Username
                        <input className="input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="alice or @alice:example.org" value={user} onChange={(e) => setUser(e.target.value)} required autoFocus />
                    </label>
                    <label className="field">
                        Password
                        <input className="input" name="password" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
                    </label>
                    {showServer ? (
                        <label className="field">
                            Homeserver
                            <input className="input" name="homeserver" inputMode="url" autoCapitalize="none" spellCheck={false} placeholder="matrix.example.org" value={hs} onChange={(e) => setHs(e.target.value)} required />
                            <span className="hint">Your Matrix server: the address you use with Element or another Matrix app.</span>
                        </label>
                    ) : (
                        <div className="hint">
                            Server: <b>{hs.replace(/^https?:\/\//, "")}</b>{" "}
                            <button type="button" className="btn ghost sm" onClick={() => setShowServer(true)}>Change</button>
                        </div>
                    )}
                    {err && <div className="err" role="alert">{err}</div>}
                    {!err && ended && <div className="err" role="status">You were signed out by the server — this device was removed or its session ended. Sign in again to continue.</div>}
                    <button className="btn primary block" disabled={busy} style={{ height: 44 }}>
                        {busy ? <><div className="spinner" style={{ borderTopColor: "#fff" }} /> Signing in…</> : "Sign in"}
                    </button>
                </form>
                <div className="login-foot">Signing in adds a new device to your account. Verify it afterwards in Settings → Security to read older encrypted messages.</div>
            </div>
        </div>
    );
}
