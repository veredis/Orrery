import { useEffect, useState } from "react";
import { logout, useMatrix } from "../matrix/session";
import { getSecurityStatus, recoverWithKey, setUpRecovery, type SecurityStatus, notifySecurityChanged, waitForVerified } from "../matrix/recovery";
import { updatePrefs } from "../matrix/prefs";
import { browserRecognizerAvailable, micErrorMessage, preloadWhisper, type WhisperModel } from "../voice/dictation";
import { ttsSupported } from "../voice/tts";
import { usePrefs } from "./hooks";
import { ask, copyText } from "./common";
import { I } from "./icons";
import { toast, updateSettings, useUI, type Theme } from "./state";
import { startSelfVerification } from "./Verification";
import { checkForUpdates, checkWebUpdate, desktopUpdatesAvailable, downloadUpdate, installUpdate, releaseUrl, useUpdate, webUpdatesAvailable } from "../desktop/updates";

function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string }) {
    return <button className="toggle" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export function SettingsPage() {
    const s = useUI((x) => x.settings);
    // A waiting update goes to the top, where the sidebar's "Update" badge leads.
    const updateState = useUpdate((x) => x.status?.state);
    const updateWaiting = updateState === "available" || updateState === "downloading" || updateState === "downloaded";
    return (
        <section className="main">
            <div className="page">
                <div className="page-inner" style={{ maxWidth: 760 }}>
                    <h1>Settings</h1>
                    {updateWaiting && <UpdatesSection />}
                    <SecuritySection />
                    <div className="card settings-section">
                        <h2>Appearance</h2>
                        <div className="setting-row">
                            <div><span className="t">Theme</span><span className="hint">Dark is the default.</span></div>
                            <div className="seg" role="radiogroup" aria-label="Theme">
                                {(["dark", "light", "system"] as Theme[]).map((t) => (
                                    <button key={t} className={s.theme === t ? "on" : ""} onClick={() => updateSettings({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>
                                ))}
                            </div>
                        </div>
                        <div className="setting-row">
                            <div><span className="t">Show agent control messages</span><span className="hint">Display raw <code>!model</code>/<code>!reasoning</code> commands and Hermes's menus in the timeline.</span></div>
                            <Toggle on={s.showControlMessages} onChange={(v) => updateSettings({ showControlMessages: v })} label="Show control messages" />
                        </div>
                    </div>
                    <div className="card settings-section">
                        <h2>Composer & voice to text</h2>
                        <div className="setting-row">
                            <div><span className="t">Enter sends</span><span className="hint">Off: Enter adds a line and Ctrl+Enter sends.</span></div>
                            <Toggle on={s.enterToSend} onChange={(v) => updateSettings({ enterToSend: v })} label="Enter sends" />
                        </div>
                        <div className="setting-row">
                            <div>
                                <span className="t">Voice-to-text engine</span>
                                <span className="hint">
                                    {s.dictationEngine === "local" || !browserRecognizerAvailable()
                                        ? "On-device Whisper turns your speech into editable text on this device. Audio is never uploaded or sent as a voice message. The first use loads a ~80 MB model (cached afterwards)."
                                        : "Browser speech service: faster live text, but your browser sends the audio to its provider (Google for Chrome and Android) for recognition."}
                                </span>
                            </div>
                            <div className="seg" role="radiogroup" aria-label="Voice-to-text engine">
                                <button className={s.dictationEngine === "local" ? "on" : ""} onClick={() => updateSettings({ dictationEngine: "local" })}>On-device</button>
                                <button className={s.dictationEngine === "browser" ? "on" : ""} disabled={!browserRecognizerAvailable()} title={browserRecognizerAvailable() ? "" : "Not available in this app/browser"} onClick={() => updateSettings({ dictationEngine: "browser" })}>Browser (cloud)</button>
                            </div>
                        </div>
                        {(s.dictationEngine === "local" || !browserRecognizerAvailable()) && (
                            <div className="setting-row">
                                <div><span className="t">Speech-recognition model</span><span className="hint">Base is more accurate; Tiny is faster on slower phones. English only.</span></div>
                                <div className="seg">
                                    {([["onnx-community/whisper-base.en", "Base"], ["onnx-community/whisper-tiny.en", "Tiny"]] as [WhisperModel, string][]).map(([m, l]) => (
                                        <button key={m} className={s.whisperModel === m ? "on" : ""} onClick={() => updateSettings({ whisperModel: m })}>{l}</button>
                                    ))}
                                </div>
                            </div>
                        )}
                        <MicTest />
                        <div className="setting-row">
                            <div><span className="t">Read replies aloud</span><span className="hint">{ttsSupported() ? "Adds a speaker button to agent replies (text to speech with this device's voices)." : "Not supported here."}</span></div>
                            <Toggle on={s.readAloud && ttsSupported()} onChange={(v) => updateSettings({ readAloud: v })} label="Read aloud" />
                        </div>
                        <div className="setting-row">
                            <div><span className="t">Notifications</span><span className="hint">Notify when an agent replies while Orrery is in the background. Message text is not shown.</span></div>
                            <Toggle
                                on={s.notifications}
                                label="Notifications"
                                onChange={async (v) => {
                                    if (v && "Notification" in window && Notification.permission !== "granted") {
                                        const p = await Notification.requestPermission();
                                        if (p !== "granted") return toast("Notifications are blocked for Orrery.", "error");
                                    }
                                    updateSettings({ notifications: v });
                                }}
                            />
                        </div>
                    </div>
                    <OrganisationSection />
                    {!updateWaiting && <UpdatesSection />}
                    <AboutSection />
                </div>
            </div>
        </section>
    );
}

function MicTest() {
    const model = useUI((x) => x.settings.whisperModel);
    const [msg, setMsg] = useState<string | null>(null);
    return (
        <div className="setting-row">
            <div><span className="t">Check microphone & model</span><span className="hint">{msg ?? "Asks for microphone permission and loads the speech model now."}</span></div>
            <button
                className="btn sm"
                onClick={async () => {
                    try {
                        setMsg("Requesting microphone…");
                        const st = await navigator.mediaDevices.getUserMedia({ audio: true });
                        st.getTracks().forEach((t) => t.stop());
                        setMsg("Microphone OK. Loading model…");
                        await preloadWhisper(model, (p) => setMsg(`Microphone OK. Loading model ${Math.round(p)}%…`));
                        setMsg("Ready: microphone allowed and on-device model loaded.");
                    } catch (e) {
                        setMsg((e as { name?: string }).name ? micErrorMessage(e) : `Model failed to load: ${(e as Error).message}`);
                    }
                }}
            >
                <I.mic width={14} /> Test
            </button>
        </div>
    );
}

function SecuritySection() {
    const client = useMatrix((x) => x.client)!;
    const [st, setSt] = useState<SecurityStatus | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const refresh = () => getSecurityStatus(client).then(setSt, (e) => toast(e.message, "error"));
    useEffect(() => {
        void refresh();
        const t = setInterval(refresh, 8000);
        return () => clearInterval(t);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const recover = async () => {
        const key = await ask({
            title: "Verify with your recovery key",
            body: "Your recovery key (also called security key) was shown when you set up encryption, e.g. in Element. It unlocks your message history on this device. Orrery keeps it in memory only for this step.",
            input: { label: "Recovery key", placeholder: "EsT… …", multiline: true },
            confirm: "Verify",
        });
        if (typeof key !== "string") return;
        setBusy("Unlocking keys…");
        try {
            const res = await recoverWithKey(client, key, (d, t) => setBusy(`Restoring message keys ${d}/${t}…`));
            setBusy("Confirming…");
            const ok = await waitForVerified(client);
            const restored = res ? ` Restored ${res.imported} of ${res.total} message keys.` : "";
            if (ok) toast(`Device verified.${restored}`);
            else toast(`Recovery key accepted, but this device doesn't show as verified yet.${restored} Try again in a moment, or verify from another device.`, "error");
            notifySecurityChanged();
        } catch (e) {
            toast((e as Error).message, "error");
        } finally {
            setBusy(null);
            void refresh();
        }
    };
    const setup = async () => {
        const pw = await ask({ title: "Set up encryption recovery", body: "Your server needs your account password to publish new signing keys. Use this only if you have never set up a recovery key (Orrery checks).", input: { label: "Account password" }, confirm: "Continue" });
        if (typeof pw !== "string") return;
        setBusy("Creating keys…");
        try {
            const rk = await setUpRecovery(client, pw);
            await ask({ title: "Save your recovery key", body: <><p>Store this in your password manager now. It is the only way to read encrypted history on a new device. Orrery does not keep a copy.</p><pre style={{ whiteSpace: "pre-wrap", fontSize: 14, fontFamily: "var(--mono)" }}>{rk}</pre><button className="btn sm" onClick={() => copyText(rk)}>Copy</button></>, confirm: "I saved it" });
        } catch (e) {
            toast((e as Error).message, "error");
        } finally {
            setBusy(null);
            void refresh();
        }
    };

    return (
        <div className="card settings-section">
            <h2 className="row"><I.shield width={18} /> Security & encryption</h2>
            {!st ? <div className="row"><div className="spinner" /> Checking…</div> : (
                <>
                    <dl className="kv" style={{ fontSize: 14 }}>
                        <dt>Signed in as</dt><dd>{client.getUserId()}</dd>
                        <dt>This device</dt><dd>{st.deviceId}</dd>
                        <dt>Device status</dt><dd>{st.deviceVerified ? <span className="pill ok">Verified</span> : <span className="pill warn">Not verified</span>}</dd>
                        <dt>Recovery set up</dt><dd>{st.secretStorageKey ? "Yes" : "No"}</dd>
                        <dt>Key backup</dt><dd>{st.backupVersion ? (st.backupActive ? `On (v${st.backupVersion})` : `Exists (v${st.backupVersion}), not connected here`) : "None"}</dd>
                    </dl>
                    {busy && <div className="row"><div className="spinner" /> {busy}</div>}
                    {!st.deviceVerified && (
                        <div className="hint">Verify this device to read messages sent before it signed in and to let your other devices trust it. New messages work either way.</div>
                    )}
                    <div className="row" style={{ flexWrap: "wrap" }}>
                        {st.secretStorageKey && (!st.deviceVerified || !st.backupActive) && <button className="btn primary sm" disabled={!!busy} onClick={recover}><I.lock width={14} /> Use recovery key</button>}
                        {st.crossSigningOnAccount && !st.deviceVerified && <button className="btn sm" disabled={!!busy} onClick={() => startSelfVerification(client)}><I.shield width={14} /> Verify with another device</button>}
                        {!st.crossSigningOnAccount && !st.secretStorageKey && <button className="btn sm" disabled={!!busy} onClick={setup}>Set up recovery</button>}
                    </div>
                </>
            )}
            <div className="setting-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <div><span className="t">Sign out</span><span className="hint">Removes this device from your account and erases its local keys and cache. Other devices are unaffected.</span></div>
                <button className="btn sm danger" onClick={async () => {
                    const extra = st && !st.backupActive ? " This device's message keys aren't backed up, so messages only readable here may become unreadable." : "";
                    if (await ask({ title: "Sign out of Orrery on this device?", body: `You can sign back in any time.${extra}`, confirm: "Sign out", danger: true })) await logout();
                }}><I.logout width={14} /> Sign out</button>
            </div>
        </div>
    );
}

function OrganisationSection() {
    const client = useMatrix((x) => x.client)!;
    const prefs = usePrefs();
    if (!prefs.projects.length && !prefs.archived.length) return null;
    return (
        <div className="card settings-section">
            <h2>Projects & archive</h2>
            {prefs.projects.map((p) => (
                <div className="setting-row" key={p.id}>
                    <div><span className="t"><I.folder width={14} /> {p.name}</span></div>
                    <button className="btn sm ghost" onClick={async () => { if (await ask({ title: `Delete project “${p.name}”?`, body: "Its conversations stay in your chat list.", confirm: "Delete", danger: true })) void updatePrefs(client, (pr) => { pr.projects = pr.projects.filter((x) => x.id !== p.id); }); }}>Delete</button>
                </div>
            ))}
            {prefs.archived.map((id) => (
                <div className="setting-row" key={id}>
                    <div><span className="t">{client.getRoom(id)?.name ?? id}</span><span className="hint">Archived</span></div>
                    <button className="btn sm" onClick={() => updatePrefs(client, (pr) => { pr.archived = pr.archived.filter((x) => x !== id); })}>Restore</button>
                </div>
            ))}
        </div>
    );
}

function UpdatesSection() {
    const s = useUI((x) => x.settings);
    const st = useUpdate((x) => x.status);
    const [webMsg, setWebMsg] = useState<string | null>(null);
    if (!desktopUpdatesAvailable()) {
        if (!webUpdatesAvailable()) return null;
        return (
            <div className="card settings-section">
                <h2>Updates</h2>
                <div className="setting-row">
                    <div><span className="t">Orrery {__APP_VERSION__}</span><span className="hint">{webMsg ?? "The web app updates itself: a new version installs in the background and the page reloads once. Your drafts are kept."}</span></div>
                    <button className="btn sm" onClick={async () => {
                        setWebMsg("Checking…");
                        try { setWebMsg((await checkWebUpdate()) === "updating" ? "Installing the new version. The page will reload in a moment." : "You're on the newest version."); }
                        catch { setWebMsg("Couldn't check right now. Try again when you're online."); }
                    }}><I.retry width={14} /> Check now</button>
                </div>
            </div>
        );
    }
    const state = st?.state ?? "idle";
    const current = st?.current ?? __APP_VERSION__;
    const line: Record<string, string> = {
        idle: "Updates come from Orrery's GitHub releases.",
        checking: "Checking for updates…",
        latest: "You're on the newest version.",
        available: `Orrery ${st?.version} is available.`,
        downloading: `Downloading Orrery ${st?.version}… ${st?.percent ?? 0}%`,
        downloaded: `Orrery ${st?.version} is ready. Orrery will restart to finish; your sign-in and chats are kept.`,
        error: st?.error ?? "Update failed.",
        unsupported: "In-app updates work in the installed app. This copy can't update itself.",
    };
    const busy = state === "checking" || state === "downloading";
    return (
        <div className="card settings-section">
            <h2>Updates</h2>
            <div className="setting-row">
                <div>
                    <span className="t">Orrery {current}</span>
                    <span className="hint" role="status" style={state === "error" ? { color: "var(--danger)" } : undefined}>
                        {line[state]}
                        {st?.version && (state === "available" || state === "downloaded") && (
                            <> <a href={releaseUrl(st.version)} target="_blank" rel="noreferrer noopener">What's new</a></>
                        )}
                    </span>
                    {state === "downloading" && <div className="update-bar" aria-hidden="true"><span style={{ width: `${st?.percent ?? 0}%` }} /></div>}
                </div>
                {state === "available" ? (
                    <button className="btn sm primary" onClick={() => void downloadUpdate()}><I.download width={14} /> Update</button>
                ) : state === "downloaded" ? (
                    <button className="btn sm primary" onClick={() => void installUpdate()}><I.retry width={14} /> Restart to update</button>
                ) : state !== "unsupported" ? (
                    <button className="btn sm" disabled={busy} onClick={() => void checkForUpdates()}><I.retry width={14} /> {busy ? "Working…" : "Check for updates"}</button>
                ) : null}
            </div>
            {state !== "unsupported" && (
                <div className="setting-row">
                    <div><span className="t">Check automatically</span><span className="hint">Look for a new version at launch and every 6 hours. Nothing downloads or installs until you click.</span></div>
                    <Toggle on={s.autoCheckUpdates} onChange={(v) => updateSettings({ autoCheckUpdates: v })} label="Check for updates automatically" />
                </div>
            )}
        </div>
    );
}

function AboutSection() {
    return (
        <div className="card settings-section">
            <h2>About</h2>
            <div className="hint" style={{ fontSize: 13.5 }}>
                Orrery {__APP_VERSION__} (build {__APP_BUILD__}){window.orreryDesktop ? ` · desktop ${window.orreryDesktop.version}` : ""} — an AI-first Matrix client. Free software under the GNU AGPL v3 or later; built on matrix-js-sdk and the
                Matrix Rust crypto SDK (Apache-2.0), React, highlight.js, marked, DOMPurify and Transformers.js with Whisper models. Source and licence notices ship with the app.
            </div>
        </div>
    );
}
