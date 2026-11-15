import { useMemo, useRef, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { SyncState } from "matrix-js-sdk";
import { useMatrix } from "../matrix/session";
import { createConversation, leaveAndForget, renameRoom } from "../matrix/actions";
import { newId, updatePrefs } from "../matrix/prefs";
import { previewText } from "../matrix/timeline";
import { useAgents, useAllTasks, usePrefs, useRooms, type RoomSummary } from "./hooks";
import { Avatar, Popover, ask, relTime } from "./common";
import { BrandMark, I } from "./icons";
import { openRoom, setSection, toast, useUI } from "./state";
import { useUpdate } from "../desktop/updates";

export async function newChat(client: MatrixClient, agentUserId?: string, name = "New chat") {
    try {
        const roomId = await createConversation(client, { name, agentUserId });
        // The room appears once sync delivers it.
        for (let i = 0; i < 40 && !client.getRoom(roomId); i++) await new Promise((r) => setTimeout(r, 150));
        openRoom(roomId);
        return roomId;
    } catch (e) {
        toast(`Couldn't create the conversation: ${(e as Error).message}`, "error");
    }
}

function RoomRow({ s, active, client }: { s: RoomSummary; active: boolean; client: MatrixClient }) {
    const [menu, setMenu] = useState(false);
    const btn = useRef<HTMLButtonElement>(null);
    const prefs = usePrefs();
    const preview = s.invite ? "Invitation" : s.last ? previewText(s.last) : "No messages yet";
    return (
        <div className="room-row" style={{ position: "relative" }}>
            <button
                className={`room-item ${active ? "active" : ""}`}
                onClick={() => openRoom(s.room.roomId)}
                onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu(true);
                }}
                aria-current={active ? "page" : undefined}
            >
                <Avatar name={s.name} id={s.room.roomId} agent={!!s.agent && s.room.getJoinedMemberCount() <= 2} />
                <div className="meta">
                    <div className="row" style={{ gap: 6 }}>
                        <span className="name truncate grow">{s.name}</span>
                        {s.working ? <span className="working" title="Agent is working"><div className="spinner" style={{ width: 12, height: 12 }} /></span> : <span className="preview ts">{s.ts > 0 ? relTime(s.ts) : ""}</span>}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                        <span className="preview truncate grow">{preview}</span>
                        {s.unread > 0 && !active && <span className="unread">{s.unread > 99 ? "99+" : s.unread}</span>}
                    </div>
                </div>
            </button>
            <button ref={btn} className="icon-btn sm more" style={{ position: "absolute", right: 6, top: 8 }} aria-label={`Options for ${s.name}`} onClick={() => setMenu(true)} hidden={!menu && false}>
                <I.more />
            </button>
            {menu && (
                <Popover anchor={btn.current} onClose={() => setMenu(false)} align="right">
                    {s.invite && (
                        <button className="menu-item" onClick={() => { setMenu(false); client.joinRoom(s.room.roomId).then(() => openRoom(s.room.roomId), (e) => toast(e.message, "error")); }}>
                            <I.check /> Accept invitation
                        </button>
                    )}
                    <button className="menu-item" onClick={() => { setMenu(false); void updatePrefs(client, (p) => { p.pinned = s.pinned ? p.pinned.filter((r) => r !== s.room.roomId) : [...p.pinned, s.room.roomId]; }); }}>
                        <I.pin /> {s.pinned ? "Unpin" : "Pin to top"}
                    </button>
                    <button className="menu-item" onClick={async () => { setMenu(false); const n = await ask({ title: "Rename conversation", input: { label: "Name", value: s.name } }); if (typeof n === "string") renameRoom(client, s.room.roomId, n).catch((e) => toast(e.message, "error")); }}>
                        <I.edit /> Rename
                    </button>
                    {prefs.projects.map((pr) => (
                        <button key={pr.id} className="menu-item" onClick={() => { setMenu(false); void updatePrefs(client, (p) => { p.rooms[s.room.roomId] = { ...p.rooms[s.room.roomId], project: s.project === pr.id ? undefined : pr.id }; }); }}>
                            <I.folder /> {s.project === pr.id ? `Remove from ${pr.name}` : `Move to ${pr.name}`}
                        </button>
                    ))}
                    <div className="menu-sep" />
                    <button className="menu-item" onClick={() => { setMenu(false); void updatePrefs(client, (p) => { p.archived = [...p.archived, s.room.roomId]; }); toast(`Archived “${s.name}” — find it in Settings → Archived`); }}>
                        <I.folder /> Archive
                    </button>
                    <button className="menu-item" style={{ color: "var(--danger)" }} onClick={async () => { setMenu(false); if (await ask({ title: `Leave “${s.name}”?`, body: "It disappears from your account on all devices. Other members keep their copy.", confirm: "Leave", danger: true })) leaveAndForget(client, s.room.roomId).catch((e) => toast(e.message, "error")); }}>
                        <I.logout /> Leave
                    </button>
                </Popover>
            )}
        </div>
    );
}

export function Sidebar() {
    const client = useMatrix((s) => s.client)!;
    const sync = useMatrix((s) => s.sync);
    const rooms = useRooms();
    const prefs = usePrefs();
    const agents = useAgents();
    const tasks = useAllTasks();
    const activeRoom = useUI((s) => s.roomId);
    const section = useUI((s) => s.section);
    const [q, setQ] = useState("");
    const [closed, setClosed] = useState<Record<string, boolean>>({});
    const primary = agents.find((a) => a.role === "coordinator") ?? agents[0];
    const live = tasks.filter((t) => t.status === "running" || t.status === "waiting").length;
    const update = useUpdate((x) => x.status?.state);

    const filtered = useMemo(() => {
        const s = q.trim().toLowerCase();
        return s ? rooms.filter((r) => r.name.toLowerCase().includes(s) || previewText(r.last).toLowerCase().includes(s)) : rooms;
    }, [rooms, q]);
    const invites = filtered.filter((r) => r.invite);
    const pinned = filtered.filter((r) => r.pinned && !r.invite);
    const byProject = new Map<string, RoomSummary[]>();
    for (const r of filtered) if (!r.pinned && !r.invite && r.project && prefs.projects.some((p) => p.id === r.project)) byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]);
    const loose = filtered.filter((r) => !r.pinned && !r.invite && !(r.project && byProject.has(r.project)));

    const me = client.getUser(client.getUserId()!);
    const syncColor = sync === SyncState.Syncing || sync === SyncState.Prepared ? "var(--ok)" : sync === SyncState.Error || sync === SyncState.Reconnecting ? "var(--warn)" : "var(--text-4)";

    const addProject = async () => {
        const name = await ask({ title: "New project", body: "Projects group related conversations. They sync to your other devices.", input: { label: "Project name", placeholder: "e.g. Home lab" }, confirm: "Create" });
        if (typeof name === "string") void updatePrefs(client, (p) => { p.projects.push({ id: newId(), name }); });
    };

    const list = (rs: RoomSummary[]) => rs.map((s) => <RoomRow key={s.room.roomId} s={s} active={s.room.roomId === activeRoom && section === "chats"} client={client} />);

    return (
        <nav className="sidebar" aria-label="Conversations">
            <div className="sidebar-head">
                <div className="brand grow"><BrandMark /> Orrery</div>
                <button className="icon-btn mobile-only" aria-label="New chat" onClick={() => newChat(client, primary?.userId)}><I.edit /></button>
            </div>
            <div className="sidebar-actions">
                <button className="btn new-chat desktop-only" onClick={() => newChat(client, primary?.userId)} title="New chat (Ctrl+Shift+O)">
                    <I.plus /> New chat{primary ? ` with ${primary.name}` : ""} <span className="kbd-hint"><kbd>Ctrl</kbd> <kbd>⇧</kbd> <kbd>O</kbd></span>
                </button>
                <div className="search-box">
                    <I.search />
                    <input id="room-search" className="input" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" />
                </div>
            </div>
            <div className="room-scroll">
                {!rooms.length && <div className="hint" style={{ padding: 12 }}>No conversations yet. Start one with “New chat”.</div>}
                {q && !filtered.length && <div className="hint" style={{ padding: 12 }}>No conversation matches “{q}”. Message search works inside a conversation.</div>}
                {invites.length > 0 && <><div className="section-label">Invitations</div>{list(invites)}</>}
                {pinned.length > 0 && <><div className="section-label"><I.pin width={12} /> Pinned</div>{list(pinned)}</>}
                {(prefs.projects.length > 0 || !q) && (
                    <div className="section-label">
                        Projects
                        <button className="icon-btn sm" aria-label="New project" title="New project" onClick={addProject}><I.plus /></button>
                    </div>
                )}
                {prefs.projects.map((p) => (
                    <div key={p.id}>
                        <button className={`project-head ${closed[p.id] ? "closed" : ""}`} onClick={() => setClosed((c) => ({ ...c, [p.id]: !c[p.id] }))}
                            onContextMenu={async (e) => {
                                e.preventDefault();
                                const n = await ask({ title: `Rename project “${p.name}”`, input: { label: "Name", value: p.name } });
                                if (n === null) return;
                                void updatePrefs(client, (pr) => {
                                    if (typeof n === "string" && n) pr.projects = pr.projects.map((x) => (x.id === p.id ? { ...x, name: n } : x));
                                });
                            }}>
                            <I.chevDown className="chev" /> <I.folder /> <span className="grow truncate" style={{ textAlign: "left" }}>{p.name}</span>
                            <span className="muted" style={{ fontSize: 12 }}>{byProject.get(p.id)?.length ?? 0}</span>
                        </button>
                        {!closed[p.id] && <div className="project-body">{list(byProject.get(p.id) ?? [])}</div>}
                    </div>
                ))}
                {!prefs.projects.length && !q && <div className="hint" style={{ padding: "0 10px 4px" }}>Group chats into projects with ＋.</div>}
                {loose.length > 0 && <><div className="section-label">Chats</div>{list(loose)}</>}
            </div>
            <div className="sidebar-foot">
                <button className={`nav-item ${section === "agents" ? "active" : ""}`} onClick={() => setSection("agents")}><I.bot /> Agents <span className="count muted">{agents.length}</span></button>
                <button className={`nav-item ${section === "tasks" ? "active" : ""}`} onClick={() => setSection("tasks")}><I.tasks /> Tasks {live > 0 && <span className="count pill accent">{live} active</span>}</button>
                <button className={`nav-item ${section === "settings" ? "active" : ""}`} onClick={() => setSection("settings")}><I.settings /> Settings {(update === "available" || update === "downloaded") && <span className="count pill accent">Update</span>}</button>
                <div className="me-row" title={`${client.getUserId()} · ${sync ?? "starting"}`}>
                    <Avatar name={me?.displayName ?? client.getUserId()!} id={client.getUserId()!} size="sm" />
                    <span className="grow truncate" style={{ fontSize: 13, color: "var(--text-2)" }}>{me?.displayName ?? client.getUserId()}</span>
                    <span className="sync-dot" style={{ background: syncColor }} aria-label={`Sync ${sync ?? "starting"}`} />
                </div>
            </div>
        </nav>
    );
}
