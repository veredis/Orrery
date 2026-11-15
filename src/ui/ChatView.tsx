import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ReceiptType, type MatrixClient, type Room } from "matrix-js-sdk";
import type { ChatItem, TimelineModel } from "../matrix/timeline";
import type { AgentIdentity, ToolStep } from "../agents/types";
import { hermesCommands } from "../agents/hermes";
import { leaveAndForget, renameRoom, sendCommand } from "../matrix/actions";
import { updatePrefs } from "../matrix/prefs";
import { agentStateFrom, usePrefs, useRoomTasks, useTimeline, type AgentState } from "./hooks";
import { ActivityStrip, Message, type MessageHandlers } from "./Message";
import { Composer, type ComposerMode } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { Avatar, Popover, ask, duration } from "./common";
import { I } from "./icons";
import { openRoom, toast, useUI } from "./state";
import { backToList } from "./swipeBack";
import { roomAgent } from "../agents/registry";
import { modelLabel, trackModels } from "../agents/modelTrack";

type Row =
    | { kind: "day"; key: string; label: string }
    | { kind: "item"; key: string; item: ChatItem; steps?: ToolStep[]; isLastAgent?: boolean; streaming?: boolean; modelUsed?: string }
    | { kind: "chip"; key: string; text: string; mine: boolean }
    | { kind: "result"; key: string; text: string; icon: "model" | "brain" | "info" };

function dayLabel(ts: number) {
    const d = new Date(ts);
    const today = new Date();
    const y = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
}

function buildRows(model: TimelineModel, showControl: boolean, working: boolean): { rows: Row[]; liveSteps: ToolStep[] } {
    const rows: Row[] = [];
    const used = trackModels(model.items).byItem;
    let lastDay = "";
    let stepBuf: ToolStep[] = [];
    let lastAgentIdx = -1;
    for (const item of model.items) {
        const day = new Date(item.ts).toDateString();
        if (day !== lastDay) {
            rows.push({ kind: "day", key: `d-${day}`, label: dayLabel(item.ts) });
            lastDay = day;
        }
        const v = item.agentView;
        if (item.isControl) {
            const cmd = item.body.trim();
            if (showControl || !/^[!/](model|reasoning)\b/i.test(cmd)) rows.push({ kind: "chip", key: item.id, text: cmd, mine: item.mine });
            continue;
        }
        if (v) {
            switch (v.type) {
                case "tool-progress":
                    stepBuf.push(...v.steps);
                    continue;
                case "model-picker":
                    if (showControl) rows.push({ kind: "result", key: item.id, text: `Model menu · current ${v.current ?? "unknown"}`, icon: "model" });
                    continue;
                case "model-switched":
                    rows.push({ kind: "result", key: item.id, text: `Switched to ${v.model}${v.providerLabel ? ` · ${v.providerLabel}` : ""}`, icon: "model" });
                    continue;
                case "reasoning-set":
                    rows.push({ kind: "result", key: item.id, text: `Reasoning effort: ${v.effort} (${v.scope === "session" ? "this conversation" : "global"})`, icon: "brain" });
                    continue;
                case "reasoning-reset":
                    rows.push({ kind: "result", key: item.id, text: "Reasoning effort reset to the global default", icon: "brain" });
                    continue;
                case "reasoning-status":
                    if (showControl) rows.push({ kind: "result", key: item.id, text: `Reasoning effort: ${v.effort ?? "?"} (${v.scope ?? ""})`, icon: "brain" });
                    continue;
                case "status":
                case "control-reply":
                    if (showControl || v.type === "control-reply") rows.push({ kind: "result", key: item.id, text: v.text, icon: "info" });
                    continue;
            }
        }
        if (item.agent && v?.type !== "approval" && v?.type !== "orrery") {
            rows.push({ kind: "item", key: item.id, item, steps: stepBuf.length ? stepBuf : undefined, modelUsed: modelLabel(used.get(item.id)) || undefined });
            stepBuf = [];
            lastAgentIdx = rows.length - 1;
            continue;
        }
        if (item.mine && !item.isControl) stepBuf = [];
        rows.push({ kind: "item", key: item.id, item });
    }
    if (lastAgentIdx >= 0) {
        const r = rows[lastAgentIdx] as Extract<Row, { kind: "item" }>;
        r.isLastAgent = true;
        // Hermes streams by editing its reply; show a caret while the turn is still running.
        if (working && r.item.edited && Date.now() - r.item.ts < 10 * 60_000) r.streaming = true;
    }
    return { rows, liveSteps: working ? stepBuf : [] };
}

interface Props {
    client: MatrixClient;
    room: Room;
    agents: AgentIdentity[];
    onAgentState(st: AgentState | null): void;
}

export function ChatView({ client, room, agents, onAgentState }: Props) {
    const prefs = usePrefs();
    const agent = roomAgent(room, agents, prefs.rooms[room.roomId]?.agent);
    const model = useTimeline(room, agents);
    const tasks = useRoomTasks(room, model, agent);
    const state = useMemo(() => agentStateFrom(model, tasks), [model, tasks]);
    const showControl = useUI((s) => s.settings.showControlMessages);
    const activityOpen = useUI((s) => s.activityOpen);
    const highlight = useUI((s) => s.highlightEventId);
    const [mode, setMode] = useState<ComposerMode>({});
    const [paginating, setPaginating] = useState(false);
    const [scrolled, setScrolled] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
    const menuBtn = useRef<HTMLButtonElement>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const focusComposer = useRef<() => void>(() => undefined);
    const toggleDictation = useRef<() => void>(() => undefined);

    useEffect(() => onAgentState(agent ? state : null), [state, agent, onAgentState]);
    useEffect(() => setMode({}), [room.roomId]);

    const current = tasks[tasks.length - 1];
    const working = !!current && (current.status === "running" || current.status === "waiting");
    const { rows, liveSteps } = useMemo(() => (model ? buildRows(model, showControl, working) : { rows: [], liveSteps: [] }), [model, showControl, working]);

    // stick-to-bottom scrolling
    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [rows.length, model, liveSteps.length]);
    useEffect(() => {
        stick.current = true;
        requestAnimationFrame(() => scroller.current && (scroller.current.scrollTop = scroller.current.scrollHeight));
    }, [room.roomId]);
    useEffect(() => {
        if (!highlight) return;
        const el = document.getElementById(`ev-${highlight}`);
        if (el) {
            stick.current = false;
            el.scrollIntoView({ block: "center", behavior: "smooth" });
            el.animate([{ background: "var(--accent-soft)" }, { background: "transparent" }], { duration: 1800 });
        }
        useUI.setState({ highlightEventId: null });
    }, [highlight, rows.length]);

    const paginate = useCallback(async () => {
        if (paginating || !model?.canPaginate) return;
        const el = scroller.current;
        const prevH = el?.scrollHeight ?? 0;
        setPaginating(true);
        try {
            await client.scrollback(room, 40);
        } catch (e) {
            toast(`Couldn't load older messages: ${(e as Error).message}`, "error");
        } finally {
            setPaginating(false);
            requestAnimationFrame(() => {
                if (el) el.scrollTop += el.scrollHeight - prevH;
            });
        }
    }, [client, room, model?.canPaginate, paginating]);

    const onScroll = () => {
        const el = scroller.current!;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        setScrolled(el.scrollTop > 4);
        if (el.scrollTop < 200) void paginate();
    };

    // read receipts while visible
    const lastId = model?.items[model.items.length - 1]?.event;
    useEffect(() => {
        if (!lastId?.getId() || lastId.status || document.hidden) return;
        const t = setTimeout(() => client.sendReadReceipt(lastId, ReceiptType.Read).catch(() => undefined), 600);
        return () => clearTimeout(t);
    }, [client, lastId]);

    // keyboard: Ctrl+Shift+Space dictation, / focuses composer
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.shiftKey && e.code === "Space") {
                e.preventDefault();
                toggleDictation.current();
            } else if (e.key === "/" && !(e.target as HTMLElement).closest("input,textarea,[contenteditable]")) {
                e.preventDefault();
                focusComposer.current();
            }
        };
        addEventListener("keydown", onKey);
        return () => removeEventListener("keydown", onKey);
    }, []);

    const h: MessageHandlers = useMemo(
        () => ({
            onReply: (item) => {
                setMode({ reply: item });
                focusComposer.current();
            },
            onEdit: (item) => setMode({ edit: item }),
            onRetry: () => sendCommand(client, room.roomId, hermesCommands.retry()).catch((e) => toast(e.message, "error")),
            onJump: (id) => useUI.setState({ highlightEventId: id }),
        }),
        [client, room.roomId],
    );

    const stop = () => sendCommand(client, room.roomId, hermesCommands.stop()).then(() => toast(`Asked ${agent?.name ?? "the agent"} to stop`), (e) => toast(e.message, "error"));

    const empty = model && !model.items.some((i) => i.kind !== "membership" && i.kind !== "room-state");
    const pinned = prefs.pinned.includes(room.roomId);

    const doExport = async () => {
        setMenuOpen(false);
        const lines = [`# ${room.name}`, "", `Exported from Orrery on ${new Date().toLocaleString()}. Only messages loaded on this device are included.`, ""];
        const used = trackModels(model?.items ?? []).byItem;
        for (const it of model?.items ?? []) {
            if (it.kind === "membership" || it.kind === "room-state" || it.isControl || (it.agentView && it.agentView.type !== "approval")) continue;
            const m = modelLabel(used.get(it.id));
            const who = it.agent ? `${it.agent.name}${m ? ` (${m})` : ""}` : it.mine ? "You" : room.getMember(it.sender)?.name ?? it.sender;
            lines.push(`### ${who} — ${new Date(it.ts).toLocaleString()}`, "", it.kind === "undecryptable" ? "_(encrypted message not available on this device)_" : it.body || `_(${it.kind})_`, "");
        }
        const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
        const file = new File([blob], `${room.name.replace(/[\\/:*?"<>|]/g, "_")}.md`, { type: "text/markdown" });
        if (navigator.canShare?.({ files: [file] }) && /Android|iPhone/i.test(navigator.userAgent)) {
            await navigator.share({ files: [file], title: room.name }).catch(() => undefined);
        } else {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = file.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }
    };

    const menu = (
        <Popover anchor={menuBtn.current} onClose={() => setMenuOpen(false)} align="right">
            <button className="menu-item" onClick={async () => { setMenuOpen(false); const n = await ask({ title: "Rename conversation", input: { label: "Name", value: room.name } }); if (typeof n === "string") renameRoom(client, room.roomId, n).catch((e) => toast(e.message, "error")); }}>
                <I.edit /> Rename
            </button>
            <button className="menu-item" onClick={() => { setMenuOpen(false); void updatePrefs(client, (p) => { p.pinned = pinned ? p.pinned.filter((r) => r !== room.roomId) : [...p.pinned, room.roomId]; }); }}>
                <I.pin /> {pinned ? "Unpin" : "Pin"}
            </button>
            {prefs.projects.length > 0 && (
                <>
                    <div className="menu-label">Move to project</div>
                    {[{ id: "", name: "No project" }, ...prefs.projects].map((pr) => (
                        <button key={pr.id} className="menu-item" onClick={() => { setMenuOpen(false); void updatePrefs(client, (p) => { p.rooms[room.roomId] = { ...p.rooms[room.roomId], project: pr.id || undefined }; }); }}>
                            <I.folder /> {pr.name} {(prefs.rooms[room.roomId]?.project ?? "") === pr.id && <I.check className="check" />}
                        </button>
                    ))}
                </>
            )}
            <div className="menu-sep" />
            {agent?.kind === "hermes" && (
                <button className="menu-item" onClick={async () => { setMenuOpen(false); if (await ask({ title: `Start a fresh ${agent.name} session here?`, body: `${agent.name} forgets this conversation's context (its long-term memory is unaffected). The message history stays visible.`, confirm: "Start fresh" })) sendCommand(client, room.roomId, hermesCommands.newSession()).catch((e) => toast(e.message, "error")); }}>
                    <I.sparkle /> New session in this chat
                </button>
            )}
            <button className="menu-item" onClick={doExport}><I.export /> Export as Markdown</button>
            <div className="menu-sep" />
            <button className="menu-item" style={{ color: "var(--danger)" }} onClick={async () => {
                setMenuOpen(false);
                if (await ask({ title: "Leave this conversation?", body: "It will be removed from your account on every device. Other members keep their copy. This can't be undone from Orrery.", confirm: "Leave", danger: true })) {
                    await leaveAndForget(client, room.roomId).catch((e) => toast(e.message, "error"));
                    openRoom(null);
                }
            }}>
                <I.logout /> Leave conversation
            </button>
        </Popover>
    );

    return (
        <section className="main" aria-label={room.name}>
            <header className={`topbar ${scrolled ? "scrolled" : ""}`}>
                <button className="icon-btn mobile-only" aria-label="Back to conversations" onClick={backToList}><I.chevLeft /></button>
                <button className="icon-btn desktop-only" aria-label="Toggle sidebar" title="Toggle sidebar" onClick={() => useUI.setState((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))}><I.sidebar /></button>
                <div className="grow row" style={{ minWidth: 0 }}>
                    {agent ? (
                        <ModelPicker client={client} room={room} agent={agent} state={state} model={model} />
                    ) : (
                        <div style={{ minWidth: 0, paddingLeft: 6 }}>
                            <div className="title truncate">{room.name}</div>
                            <div className="sub truncate">{room.getJoinedMemberCount()} members</div>
                        </div>
                    )}
                </div>
                {agent && <span className="sub desktop-only truncate" style={{ maxWidth: 200 }} title={room.name}>{room.name}</span>}
                {room.hasEncryptionStateEvent() ? <span title="End-to-end encrypted" className="muted" style={{ display: "inline-flex" }}><I.lock width={15} /></span> : <span className="pill warn" title="Messages in this room are not end-to-end encrypted">Unencrypted</span>}
                <button className={`icon-btn ${activityOpen ? "active" : ""}`} title="Agent activity" aria-label="Agent activity" onClick={() => useUI.setState((s) => ({ activityOpen: !s.activityOpen }))}>
                    <I.activity />
                    {state.pendingApprovals > 0 && <span className="dot" style={{ position: "absolute", marginLeft: 18, marginTop: -16, color: "var(--warn)" }} />}
                </button>
                <button ref={menuBtn} className="icon-btn" aria-label="Conversation options" onClick={() => setMenuOpen((o) => !o)}><I.more /></button>
                {menuOpen && menu}
            </header>

            <div className="timeline" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions"
                onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
                onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDroppedFiles([...e.dataTransfer.files]); } }}>
                {empty ? (
                    <EmptyChat agent={agent} encrypted={room.hasEncryptionStateEvent()} onPick={(t) => useUI.setState({ prefill: t })} />
                ) : (
                    <div className="timeline-inner">
                        {model?.canPaginate && (
                            <button className="btn ghost sm load-older" onClick={paginate} disabled={paginating}>
                                {paginating ? <div className="spinner" /> : null} {paginating ? "Loading…" : "Load earlier messages"}
                            </button>
                        )}
                        {rows.map((r) => (
                            <Fragment key={r.key}>
                                {r.kind === "day" && <div className="day-sep">{r.label}</div>}
                                {r.kind === "chip" && <div className="control-chip" style={{ alignSelf: r.mine ? "flex-end" : "flex-start" }} title="Agent command"><I.terminal width={12} />{r.text}</div>}
                                {r.kind === "result" && (
                                    <div className="control-result">
                                        {r.icon === "model" ? <I.sparkle width={14} style={{ color: "var(--accent-2)" }} /> : r.icon === "brain" ? <I.brain width={14} style={{ color: "var(--accent-2)" }} /> : <I.alert width={14} />}
                                        <span>{r.text}</span>
                                    </div>
                                )}
                                {r.kind === "item" && (
                                    <Message client={client} room={room} item={r.item} replyItem={r.item.replyTo ? model?.byId.get(r.item.replyTo) : undefined} steps={r.steps} streaming={r.streaming} isLastAgent={r.isLastAgent} modelUsed={r.modelUsed} h={h} />
                                )}
                            </Fragment>
                        ))}
                        {working && current && (
                            <div className="msg assistant">
                                <Avatar name={agent?.name ?? "Agent"} id={agent?.userId ?? ""} agent />
                                <div className="content">
                                    {liveSteps.length > 0 && <ActivityStrip steps={liveSteps} live />}
                                    <div className="working-row">
                                        <div className="orbit-loader" aria-hidden="true"><i /><b /></div>
                                        <span>
                                            {current.status === "waiting" ? `${agent?.name} is waiting for your approval` : `${agent?.name ?? "Agent"} is working`} · <Elapsed since={current.startedAt} />
                                        </span>
                                        <button className="btn ghost sm" onClick={stop}><I.stop width={12} /> Stop</button>
                                    </div>
                                </div>
                            </div>
                        )}
                        {current?.status === "failed" && !working && current === tasks[tasks.length - 1] && agent?.kind === "hermes" && (
                            <div className="agent-note"><I.alert width={14} style={{ color: "var(--danger)" }} /> {agent.name} reported a failure on the last request. <button className="btn sm" onClick={h.onRetry}><I.retry width={13} /> Retry</button></div>
                        )}
                    </div>
                )}
            </div>
            <Composer
                client={client}
                room={room}
                agentName={agent?.name}
                agentRoom={!!agent}
                working={working}
                mode={mode}
                setMode={setMode}
                onStop={stop}
                onSent={() => { stick.current = true; }}
                registerFocus={(fn) => (focusComposer.current = fn)}
                registerDictation={(fn) => (toggleDictation.current = fn)}
                externalFiles={droppedFiles}
                clearExternalFiles={() => setDroppedFiles([])}
            />
        </section>
    );
}

function Elapsed({ since }: { since: number }) {
    const [, t] = useState(0);
    useEffect(() => {
        const i = setInterval(() => t((x) => x + 1), 1000);
        return () => clearInterval(i);
    }, []);
    return <>{duration(Date.now() - since)}</>;
}

function EmptyChat({ agent, encrypted, onPick }: { agent?: AgentIdentity; encrypted: boolean; onPick(t: string): void }) {
    const s = agent
        ? [
              { t: "Plan my day", d: "Summarise what's on my plate and suggest an order" },
              { t: "Review some code", d: "I'll paste a diff — find bugs and risky changes" },
              { t: "Research a topic", d: "Compare options and cite sources" },
              { t: "Delegate to Claude Code", d: "Have a coding agent implement and test a change" },
          ]
        : [];
    return (
        <div className="empty">
            <div className="empty-inner">
                <Avatar name={agent?.name ?? "?"} id={agent?.userId ?? "x"} size="lg" agent={!!agent} />
                <h2>{agent ? `What should ${agent.name} work on?` : "Say hello"}</h2>
                <p>{!agent ? "This conversation is empty." : encrypted ? "Messages are end-to-end encrypted between this device and the agent." : "This conversation is not encrypted — the homeserver can read it."}</p>
                {s.length > 0 && (
                    <div className="suggestions">
                        {s.map((x) => (
                            <button key={x.t} className="suggestion" onClick={() => onPick(`${x.t}: `)}>
                                <b>{x.t}</b>
                                <span>{x.d}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
