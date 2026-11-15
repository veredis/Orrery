import { useCallback, useEffect, useRef, useState } from "react";
import { EventType, RoomEvent, SyncState, type MatrixEvent, type Room } from "matrix-js-sdk";
import { boot, logout, retrySync, useMatrix } from "../matrix/session";
import { loadConfig, syncConfigAgents } from "../agents/registry";
import { isControlCommand } from "../agents/types";
import { renameRoom } from "../matrix/actions";
import { SECURITY_CHANGED, getSecurityStatus } from "../matrix/recovery";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import { warmUpWhisperIfUsed } from "../voice/dictation";
import { initDesktopUpdates } from "../desktop/updates";
import { useAgents, useAllTasks, useOnline, type AgentState } from "./hooks";
import { Login } from "./Login";
import { Sidebar, newChat } from "./Sidebar";
import { ChatView } from "./ChatView";
import { ActivityPanel, AgentsPage, TasksPage } from "./Panels";
import { SettingsPage } from "./Settings";
import { DialogHost, Lightbox, Toasts } from "./common";
import { VerificationDialog, useIncomingVerification } from "./Verification";
import { BrandMark, I } from "./icons";
import { applyTheme, openRoom, setSection, toast, useUI } from "./state";
import { useSwipeBack } from "./swipeBack";

export function App() {
    const status = useMatrix((s) => s.status);
    const fatal = useMatrix((s) => s.fatal);
    useEffect(() => {
        applyTheme(useUI.getState().settings.theme);
        loadConfig().then(() => boot()).catch((e) => useMatrix.setState({ status: "fatal", fatal: String(e?.message ?? e) }));
    }, []);

    let body;
    if (status === "booting" || status === "starting") body = <Splash text={status === "starting" ? "Syncing your conversations…" : "Starting…"} />;
    else if (status === "signed-out") body = <Login />;
    else if (status === "fatal")
        body = (
            <div className="screen-center">
                <div className="state-card card" style={{ padding: 24 }}>
                    <I.alert width={28} style={{ color: "var(--danger)" }} />
                    <h2>Orrery couldn't start</h2>
                    <p>{fatal}</p>
                    <div className="row"><button className="btn" onClick={() => location.reload()}>Try again</button><button className="btn danger" onClick={() => logout()}>Sign out</button></div>
                </div>
            </div>
        );
    else body = <Workspace />;
    return (
        <>
            {body}
            <DialogHost />
            <Toasts />
            <Lightbox />
            <VerificationDialog />
        </>
    );
}

function Splash({ text }: { text: string }) {
    return (
        <div className="screen-center">
            <div className="state-card">
                <BrandMark size={56} />
                <div className="row muted"><div className="spinner" /> {text}</div>
            </div>
        </div>
    );
}

function Workspace() {
    const client = useMatrix((s) => s.client)!;
    const sync = useMatrix((s) => s.sync);
    const syncError = useMatrix((s) => s.syncError);
    const softLoggedOut = useMatrix((s) => s.softLoggedOut);
    const online = useOnline();
    const { section, roomId, mobileView, activityOpen, sidebarCollapsed } = useUI();
    const agents = useAgents();
    const tasks = useAllTasks();
    const [, setAgentState] = useState<AgentState | null>(null);
    const [unverified, setUnverified] = useState(false);
    const onAgentState = useCallback((s: AgentState | null) => setAgentState(s), []);
    const workspaceRef = useRef<HTMLDivElement>(null);
    useIncomingVerification(client);
    // Make this deployment's configured agents available to every Orrery the user signs in to.
    useEffect(() => void syncConfigAgents(client).catch(() => undefined), [client]);
    // Voice to text: if used on this device before, load the speech model in the background after launch.
    const engine = useUI((s) => s.settings.dictationEngine);
    const whisperModel = useUI((s) => s.settings.whisperModel);
    useEffect(() => (engine === "local" ? warmUpWhisperIfUsed(whisperModel) : undefined), [engine, whisperModel]);
    // Desktop app: watch for new releases (installing always needs a click in Settings → Updates).
    const autoCheckUpdates = useUI((s) => s.settings.autoCheckUpdates);
    useEffect(() => initDesktopUpdates(autoCheckUpdates, (v) => {
        if (useUI.getState().section !== "settings") toast(`Orrery ${v} is available. Open Settings to install it.`);
    }), [autoCheckUpdates]);

    const room = roomId ? client.getRoom(roomId) : null;
    const validRoom = room && (room.getMyMembership() === "join" || room.getMyMembership() === "invite") ? room : null;
    const primary = agents.find((a) => a.role === "coordinator") ?? agents[0];

    // Pick a sensible conversation on first load (desktop).
    useEffect(() => {
        if (!validRoom && innerWidth > 860) {
            const first = client.getRooms().filter((r) => r.getMyMembership() === "join").sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp())[0];
            if (first) useUI.setState({ roomId: first.roomId });
        }
        const params = new URLSearchParams(location.search);
        if (params.get("action") === "new") void newChat(client, primary?.userId);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-check whenever trust can change: after a verification, on crypto updates, and when
    // switching sections (e.g. coming back from Settings).
    useEffect(() => {
        let alive = true;
        const check = () =>
            getSecurityStatus(client).then((s) => alive && setUnverified(!s.deviceVerified && s.crossSigningOnAccount), () => undefined);
        void check();
        const events = [CryptoEvent.UserTrustStatusChanged, CryptoEvent.DevicesUpdated, CryptoEvent.KeyBackupStatus] as const;
        events.forEach((e) => client.on(e as never, check as never));
        window.addEventListener(SECURITY_CHANGED, check);
        return () => {
            alive = false;
            events.forEach((e) => client.off(e as never, check as never));
            window.removeEventListener(SECURITY_CHANGED, check);
        };
    }, [client, section]);

    // Title "New chat" conversations from their first prompt; notify on agent replies in the background.
    useEffect(() => {
        const onTimeline = (ev: MatrixEvent, r: Room | undefined, toStart?: boolean) => {
            if (toStart || !r || ev.getType() !== EventType.RoomMessage || ev.getRelation()?.rel_type === "m.replace") return;
            const me = client.getUserId();
            const body = ev.getContent().body as string | undefined;
            if (ev.getSender() === me && r.name === "New chat" && body && !isControlCommand(body) && Date.now() - ev.getTs() < 60_000) {
                const title = body.replace(/\s+/g, " ").trim().split(" ").slice(0, 7).join(" ").replace(/[.,:;!?]+$/, "");
                if (title) void renameRoom(client, r.roomId, title.length > 48 ? `${title.slice(0, 47)}…` : title).catch(() => undefined);
            }
            const agent = agents.find((a) => a.userId === ev.getSender());
            if (agent && document.hidden && useUI.getState().settings.notifications && "Notification" in window && Notification.permission === "granted" && Date.now() - ev.getTs() < 30_000) {
                const n = new Notification(`${agent.name} replied`, { body: r.name, tag: r.roomId, silent: false });
                n.onclick = () => {
                    focus();
                    openRoom(r.roomId);
                };
            }
        };
        client.on(RoomEvent.Timeline, onTimeline as never);
        return () => {
            client.off(RoomEvent.Timeline, onTimeline as never);
        };
    }, [client, agents]);

    // Global shortcuts
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.ctrlKey || e.metaKey;
            if (mod && e.shiftKey && e.key.toLowerCase() === "o") {
                e.preventDefault();
                void newChat(client, primary?.userId);
            } else if (mod && e.key.toLowerCase() === "k") {
                e.preventDefault();
                useUI.setState({ sidebarCollapsed: false, mobileView: "list" });
                setSection("chats");
                setTimeout(() => document.getElementById("room-search")?.focus(), 30);
            } else if (e.key === "Escape" && useUI.getState().activityOpen && !document.querySelector(".modal-backdrop")) {
                useUI.setState({ activityOpen: false });
            } else if (mod && e.shiftKey && e.key.toLowerCase() === "a") {
                e.preventDefault();
                useUI.setState((s) => ({ activityOpen: !s.activityOpen }));
            }
        };
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, [client, primary]);

    useEffect(() => {
        if (sync === SyncState.Error) {
            const t = setTimeout(retrySync, 4000);
            return () => clearTimeout(t);
        }
    }, [sync]);

    const live = tasks.filter((t) => t.status === "waiting").length;
    const showActivity = activityOpen && section === "chats" && !!validRoom;
    const cls = [
        "workspace",
        showActivity ? "with-activity" : "",
        sidebarCollapsed ? "sidebar-collapsed" : "",
        mobileView === "chat" && section === "chats" && validRoom ? "m-chat" : "m-list",
        section !== "chats" ? "page-mode" : "",
    ].join(" ");
    useSwipeBack(workspaceRef, mobileView === "chat" && section === "chats" && !!validRoom);

    let main;
    if (section === "agents") main = <AgentsPage />;
    else if (section === "tasks") main = <TasksPage />;
    else if (section === "settings") main = <SettingsPage />;
    else if (validRoom) main = <ChatView key={validRoom.roomId} client={client} room={validRoom} agents={agents} onAgentState={onAgentState} />;
    else
        main = (
            <section className="main">
                <div className="empty">
                    <div className="empty-inner">
                        <BrandMark size={64} />
                        <h2>Good to see you</h2>
                        <p>Start a new chat with {primary?.name ?? "an agent"}, or pick a conversation.</p>
                        <button className="btn primary" onClick={() => newChat(client, primary?.userId)}><I.plus /> New chat</button>
                    </div>
                </div>
            </section>
        );

    const banner = !online ? (
        <div className="banner warn"><I.wifiOff width={16} /><span className="grow">You're offline. Messages will send when the connection returns.</span></div>
    ) : softLoggedOut ? (
        <div className="banner danger"><I.alert width={16} /><span className="grow">This session was signed out by the server.</span><button className="btn sm" onClick={() => logout()}>Sign in again</button></div>
    ) : sync === SyncState.Error || sync === SyncState.Reconnecting ? (
        <div className="banner warn"><div className="spinner" /><span className="grow">Reconnecting to your homeserver{syncError ? ` (${syncError})` : ""}…</span><button className="btn sm" onClick={retrySync}>Retry now</button></div>
    ) : unverified && section === "chats" ? (
        <div className="banner info"><I.shield width={16} /><span className="grow">Verify this device to read older encrypted messages.</span><button className="btn sm" onClick={() => setSection("settings")}>Verify</button><button className="icon-btn sm" aria-label="Dismiss" onClick={() => setUnverified(false)}><I.x /></button></div>
    ) : null;

    return (
        <div className={cls} ref={workspaceRef}>
            <Sidebar />
            <div style={{ display: "contents" }}>
                {banner && <div style={{ position: "fixed", top: "calc(60px + var(--safe-t))", left: "50%", transform: "translateX(-50%)", zIndex: 35, width: "min(640px, calc(100% - 24px))" }}>{banner}</div>}
                {main}
            </div>
            {showActivity && validRoom && <ActivityPanel client={client} room={validRoom} />}
            <nav className="mobile-tabs" aria-label="Sections">
                {([["settings", I.settings, "Settings"], ["agents", I.bot, "Agents"], ["tasks", I.tasks, "Tasks"], ["chats", I.chat, "Chats"]] as const).map(([s, Icon, label]) => (
                    <button key={s} className={section === s ? "active" : ""} onClick={() => { setSection(s); if (s === "chats") useUI.setState({ mobileView: "list" }); }} aria-current={section === s ? "page" : undefined}>
                        <Icon />
                        {label}
                        {s === "tasks" && live > 0 && <span className="badge">{live}</span>}
                    </button>
                ))}
            </nav>
        </div>
    );
}

export { toast };
