import { useMemo, useState } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk";
import type { AgentTask, TaskStatus } from "../agents/tasks";
import type { AgentIdentity } from "../agents/types";
import { hermesCommands } from "../agents/hermes";
import { sendCommand } from "../matrix/actions";
import { updatePrefs } from "../matrix/prefs";
import { useMatrix } from "../matrix/session";
import { roomAgent } from "../agents/registry";
import { agentStateFrom, useAgents, useAllTasks, usePrefs, useRoomTasks, useRooms, useTimeline } from "./hooks";
import { ApprovalCard, ToolSteps } from "./Message";
import { Avatar, ask, duration, relTime } from "./common";
import { I } from "./icons";
import { openRoom, toast, useUI } from "./state";
import { newChat } from "./Sidebar";

const STATUS_LABEL: Record<TaskStatus, string> = { waiting: "Needs you", running: "Running", done: "Done", failed: "Failed", sent: "Sent" };

export function StatusIcon({ s }: { s: TaskStatus }) {
    return (
        <span className={`status-ico ${s}`} aria-label={STATUS_LABEL[s]}>
            {s === "running" ? <div className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : s === "waiting" ? <I.shield /> : s === "done" ? <I.check /> : s === "failed" ? <I.x /> : <I.send />}
        </span>
    );
}

// ---------------------------------------------------------------- activity panel (per conversation)
export function ActivityPanel({ client, room }: { client: MatrixClient; room: Room }) {
    const agents = useAgents();
    const prefs = usePrefs();
    const agent = roomAgent(room, agents, prefs.rooms[room.roomId]?.agent);
    const model = useTimeline(room, agents);
    const tasks = useRoomTasks(room, model, agent);
    const st = agentStateFrom(model, tasks);
    const [openTask, setOpenTask] = useState<string | null>(null);
    const recent = [...tasks].reverse().slice(0, 25);
    const current = recent[0];
    const shown = openTask ? tasks.find((t) => t.id === openTask) : current;

    return (
        <aside className="activity" aria-label="Agent activity">
            <div className="activity-head">
                <h3 className="grow">Activity</h3>
                <button className="icon-btn" aria-label="Close activity" onClick={() => useUI.setState({ activityOpen: false })}><I.x /></button>
            </div>
            <div className="activity-body">
                {agent ? (
                    <div className="panel-card">
                        <div className="row">
                            <Avatar name={agent.name} id={agent.userId} agent />
                            <div className="grow">
                                <div style={{ fontWeight: 650 }}>{agent.name}</div>
                                <div className="hint truncate">{agent.userId}</div>
                            </div>
                            {st.working ? <span className="pill accent"><span className="dot pulse" /> working</span> : <span className="pill ok">idle</span>}
                        </div>
                        <dl className="kv">
                            <dt>Model</dt><dd title={st.model}>{st.model ?? "Not reported yet"}</dd>
                            {st.providerLabel && <><dt>Provider</dt><dd>{st.providerLabel}</dd></>}
                            <dt>Reasoning</dt><dd>{st.effort ?? "default"}</dd>
                            <dt>Role</dt><dd>{agent.role}</dd>
                        </dl>
                        {agent.kind === "hermes" && (
                            <div className="row" style={{ flexWrap: "wrap" }}>
                                <button className="btn sm" onClick={() => sendCommand(client, room.roomId, hermesCommands.status()).catch((e) => toast(e.message, "error"))}>Status</button>
                                <button className="btn sm" onClick={() => sendCommand(client, room.roomId, hermesCommands.tasks()).catch((e) => toast(e.message, "error"))}>Background tasks</button>
                                {st.working && <button className="btn sm danger" onClick={() => sendCommand(client, room.roomId, hermesCommands.stop()).catch((e) => toast(e.message, "error"))}>Stop</button>}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="panel-card"><div className="hint">No agent in this conversation. Add one from the Agents page to see its activity here.</div></div>
                )}

                {shown && (
                    <div className="panel-card">
                        <h4><StatusIcon s={shown.status} /> {shown === current ? "Latest request" : "Request"}</h4>
                        <div style={{ fontSize: 14, fontWeight: 600 }}>{shown.title}</div>
                        <div className="hint">
                            {STATUS_LABEL[shown.status]} · started {relTime(shown.startedAt)}
                            {shown.finishedAt ? ` · took ${duration(shown.finishedAt - shown.startedAt)}` : ""}
                            {shown.assignee ? ` · assigned to ${shown.assignee}` : ""}
                        </div>
                        {shown.steps.length > 0 ? (
                            <div style={{ margin: "0 -12px" }}><ToolSteps steps={shown.steps.flatMap((s) => s.steps)} /></div>
                        ) : (
                            <div className="hint">No tool calls reported for this request.</div>
                        )}
                        {shown.approvals.map((a) => <ApprovalCard key={a.id} client={client} room={room} item={a} />)}
                        {shown.reply && <button className="btn sm" onClick={() => useUI.setState({ highlightEventId: shown.reply!.id })}>Jump to result</button>}
                    </div>
                )}

                {recent.length > 1 && (
                    <div className="panel-card">
                        <h4>History</h4>
                        {recent.map((t) => (
                            <button key={t.id} className="task-row" onClick={() => setOpenTask(t.id)} aria-pressed={shown?.id === t.id}>
                                <StatusIcon s={t.status} />
                                <div style={{ minWidth: 0 }}>
                                    <div className="t truncate">{t.title}</div>
                                    <div className="s">{relTime(t.startedAt)}{t.steps.length ? ` · ${t.steps.reduce((n, s) => n + s.steps.length, 0)} tool steps` : ""}</div>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
                <div className="hint" style={{ padding: "0 4px" }}>
                    Activity is read from the agent's own Matrix messages and reactions. Hermes reports tool calls (not their full output) and approval prompts; command output appears only when the agent includes it in its reply.
                </div>
            </div>
        </aside>
    );
}

// ---------------------------------------------------------------- tasks board
export function TasksPage() {
    const tasks = useAllTasks();
    const [filter, setFilter] = useState<string>("all");
    const agents = useAgents();
    const shown = filter === "all" ? tasks : tasks.filter((t) => t.agent?.userId === filter);
    const cols: { s: TaskStatus[]; title: string; empty: string }[] = [
        { s: ["waiting"], title: "Needs you", empty: "No approvals waiting." },
        { s: ["running", "sent"], title: "In progress", empty: "Nothing running." },
        { s: ["done"], title: "Done", empty: "No finished tasks loaded." },
        { s: ["failed"], title: "Failed", empty: "No failures." },
    ];
    return (
        <section className="main">
            <div className="page">
                <div className="page-inner">
                    <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
                        <div className="grow">
                            <h1>Tasks</h1>
                            <p className="lead">Every request you've sent an agent, with its live status from the agent itself.</p>
                        </div>
                        <div className="seg" role="radiogroup" aria-label="Filter by agent">
                            <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All agents</button>
                            {agents.map((a) => <button key={a.userId} className={filter === a.userId ? "on" : ""} onClick={() => setFilter(a.userId)}>{a.name}</button>)}
                        </div>
                    </div>
                    <div className="board">
                        {cols.map((c) => {
                            const list = shown.filter((t) => c.s.includes(t.status));
                            return (
                                <div className="board-col" key={c.title}>
                                    <h3><StatusIcon s={c.s[0]} /> {c.title} <span className="muted" style={{ marginLeft: "auto", fontWeight: 500 }}>{list.length}</span></h3>
                                    {!list.length && <div className="hint" style={{ padding: "4px 6px" }}>{c.empty}</div>}
                                    {list.slice(0, 60).map((t) => <TaskCard key={t.id} t={t} />)}
                                </div>
                            );
                        })}
                    </div>
                    <p className="hint">
                        Tasks come from conversations loaded on this device (recent history of each room). Statuses are Hermes's own 👀 / ✅ / ❌ markers and approval prompts.
                        Agents that send <code>dev.orrery.agent</code> task events (see docs/AGENT-EVENTS.md) can also report owners, progress and delegated workers here.
                    </p>
                </div>
            </div>
        </section>
    );
}

function TaskCard({ t }: { t: AgentTask }) {
    const stepCount = t.steps.reduce((n, s) => n + s.steps.length, 0);
    return (
        <button className="task-card" onClick={() => { openRoom(t.roomId, t.id); useUI.setState({ activityOpen: true }); }}>
            <div className="t">{t.title}</div>
            <div className="m">
                <span className="pill">{t.roomName}</span>
                {t.assignee && <span className="pill accent">→ {t.assignee.replace(/^@/, "").split(":")[0]}</span>}
                {t.progress && <span className="pill">{t.progress.done}/{t.progress.total}</span>}
                <span>{relTime(t.startedAt)}</span>
                {stepCount > 0 && <span>{stepCount} steps</span>}
                {t.finishedAt && <span>{duration(t.finishedAt - t.startedAt)}</span>}
            </div>
        </button>
    );
}

// ---------------------------------------------------------------- agents page
export function AgentsPage() {
    const client = useMatrix((s) => s.client)!;
    const agents = useAgents();
    const rooms = useRooms();
    const tasks = useAllTasks();
    const prefs = usePrefs();
    const byAgent = useMemo(() => {
        const m = new Map<string, { rooms: number; live: number; done: number }>();
        for (const a of agents) m.set(a.userId, { rooms: rooms.filter((r) => r.agent?.userId === a.userId).length, live: 0, done: 0 });
        for (const t of tasks) {
            const e = t.agent && m.get(t.agent.userId);
            if (!e) continue;
            if (t.status === "running" || t.status === "waiting") e.live++;
            if (t.status === "done") e.done++;
        }
        return m;
    }, [agents, rooms, tasks]);

    const addAgent = async () => {
        const id = await ask({ title: "Add an agent", body: "Enter the Matrix ID of a bot or agent account. Orrery treats its messages as agent output (rendered as assistant replies, never executed).", input: { label: "Matrix ID", placeholder: "@hermes:example.org" }, confirm: "Add" });
        if (typeof id !== "string") return;
        if (!/^@[^:]+:.+$/.test(id)) return toast("That doesn't look like a Matrix ID (@name:server).", "error");
        const name = (await ask({ title: "Display name", input: { label: "Name", value: id.slice(1).split(":")[0] } })) as string | null;
        const hermes = (await ask({
            title: "Is this a Hermes Agent?",
            body: "Hermes agents get the model picker, reasoning effort, approvals and task tracking. Other bots are shown as plain assistant replies.",
            confirm: "Yes, Hermes",
            cancel: "No, another bot",
        })) === true;
        await updatePrefs(client, (p) => {
            p.agents = [...p.agents.filter((a) => a.userId !== id), { userId: id, name: name || id, kind: hermes ? "hermes" : "matrix-bot", role: hermes && !p.agents.some((a) => a.role === "coordinator") ? "coordinator" : "specialist" }];
        });
    };

    return (
        <section className="main">
            <div className="page">
                <div className="page-inner">
                    <div className="row" style={{ flexWrap: "wrap" }}>
                        <div className="grow">
                            <h1>Agents</h1>
                            <p className="lead">Independent agents you can talk to. A conversation is a Matrix room; an agent is an account that answers in it.</p>
                        </div>
                        <button className="btn" onClick={addAgent}><I.plus /> Add agent</button>
                    </div>
                    <div className="grid-cards">
                        {agents.map((a) => {
                            const s = byAgent.get(a.userId)!;
                            const userAdded = prefs.agents.some((x) => x.userId === a.userId);
                            return (
                                <div className="card agent-card" key={a.userId}>
                                    <div className="head">
                                        <Avatar name={a.name} id={a.userId} size="lg" agent />
                                        <div className="grow" style={{ minWidth: 0 }}>
                                            <div className="name">{a.name}</div>
                                            <div className="hint truncate">{a.userId}</div>
                                        </div>
                                        <span className="pill accent">{a.role}</span>
                                    </div>
                                    {a.description && <div className="hint">{a.description}</div>}
                                    <div className="row hint" style={{ gap: 14 }}>
                                        <span>{s.rooms} chats</span>
                                        <span>{s.live} active</span>
                                        <span>{s.done} done</span>
                                    </div>
                                    <div className="row">
                                        <button className="btn sm primary" onClick={() => newChat(client, a.userId)}><I.plus width={14} /> New chat</button>
                                        {userAdded && (
                                            <button className="btn sm ghost" onClick={() => updatePrefs(client, (p) => { p.agents = p.agents.filter((x) => x.userId !== a.userId); })}>Remove</button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    <div className="card settings-section">
                        <h2>How multi-agent work shows up</h2>
                        <div className="hint" style={{ fontSize: 13.5 }}>
                            <p style={{ margin: "0 0 8px" }}><b>Hermes</b> is the coordinator. When it delegates (for example to Claude Code through its <code>claude-code</code> skill), the delegation appears as tool steps in the conversation's activity and on the Tasks board, and the result arrives as Hermes's reply — review it and answer in the same chat to send feedback.</p>
                            <p style={{ margin: "0 0 8px" }}><b>Specialist agents</b> with their own Matrix accounts can be added here; each gets its own conversations, tasks and activity.</p>
                            <p style={{ margin: 0 }}>Agents that emit the versioned <code>dev.orrery.agent</code> events can report task owners, progress, diffs and artifacts explicitly. Hermes does not emit them yet, so Orrery reads Hermes's native messages instead.</p>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}

export function AgentShortcut({ agent }: { agent: AgentIdentity }) {
    const client = useMatrix((s) => s.client)!;
    return <button className="btn sm" onClick={() => newChat(client, agent.userId)}>Chat with {agent.name}</button>;
}
