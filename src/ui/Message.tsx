import { memo, useState } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk";
import type { ChatItem } from "../matrix/timeline";
import { mediaRefOf, saveMedia } from "../matrix/media";
import { react, redact } from "../matrix/actions";
import { approvalChoicesFromKeys } from "../agents/hermes";
import type { ApprovalChoice, OrreryAgentEvent, ToolStep } from "../agents/types";
import { Avatar, Markdown, ask, copyText, timeLabel, useMedia } from "./common";
import { I } from "./icons";
import { toast, useUI } from "./state";
import { speak, ttsSupported, useSpeech } from "../voice/tts";

export interface MessageHandlers {
    onReply(item: ChatItem): void;
    onEdit(item: ChatItem): void;
    onRetry(): void;
    onJump(eventId: string): void;
}

function displayName(room: Room, userId: string): string {
    return room.getMember(userId)?.name ?? userId.replace(/^@/, "").split(":")[0];
}

// ---------------------------------------------------------------- media
function MediaContent({ client, item }: { client: MatrixClient; item: ChatItem }) {
    const ref = mediaRefOf(item.content);
    const { url, error } = useMedia(client, item.kind === "image" ? ref : null);
    const info = item.content.info as { size?: number; w?: number; h?: number } | undefined;
    if (item.kind === "image") {
        if (error) return <div className="undecryptable"><I.alert width={16} /> Image unavailable ({error})</div>;
        const aspect = info?.w && info?.h ? `${info.w} / ${info.h}` : undefined;
        return url ? (
            <img className="media-img" src={url} alt={item.body} style={{ aspectRatio: aspect }} onClick={() => useUI.setState({ lightbox: url })} />
        ) : (
            <div className="media-img" style={{ width: 260, aspectRatio: aspect ?? "4 / 3", display: "grid", placeItems: "center" }}><div className="spinner" /></div>
        );
    }
    const size = info?.size ? `${(info.size / 1024 / 1024).toFixed(info.size > 1e6 ? 1 : 2)} MB` : "";
    return (
        <div className="file-card">
            <div className="ico"><I.file width={18} /></div>
            <div className="grow">
                <div className="truncate" style={{ fontWeight: 600, fontSize: 14 }}>{(item.content.filename as string) ?? item.body}</div>
                <div className="hint">{[item.kind, size].filter(Boolean).join(" · ")}</div>
            </div>
            {ref && (
                <button className="icon-btn sm" title="Download" onClick={() => saveMedia(client, ref, (item.content.filename as string) ?? item.body ?? "file").catch((e) => toast(e.message, "error"))}>
                    <I.download />
                </button>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- tool steps
export function ToolSteps({ steps }: { steps: ToolStep[] }) {
    return (
        <div className="steps">
            {steps.map((s, i) => (
                <div className="step" key={i}>
                    <div className="ico">{s.icon}</div>
                    <div className="tool">{s.tool}{s.status === "failed" && <span className="pill danger" style={{ marginLeft: 8 }}>failed</span>}</div>
                    {s.preview && <pre>{s.preview}</pre>}
                    {s.output && <pre style={{ color: "var(--text-3)" }}>{s.output}</pre>}
                </div>
            ))}
        </div>
    );
}

export function ActivityStrip({ steps, live }: { steps: ToolStep[]; live?: boolean }) {
    if (!steps.length) return null;
    const tools = [...new Set(steps.map((s) => s.tool))];
    return (
        <details className="activity-strip" open={live}>
            <summary>
                {live ? <div className="spinner" /> : <I.terminal width={14} />}
                <span>
                    {live ? "Working — " : "Used "}
                    {tools.slice(0, 3).join(", ")}
                    {tools.length > 3 ? ` +${tools.length - 3}` : ""}
                    {steps.length > 1 ? ` · ${steps.length} steps` : ""}
                </span>
                <I.chevRight className="chev" style={{ marginLeft: "auto" }} />
            </summary>
            <ToolSteps steps={steps} />
        </details>
    );
}

// ---------------------------------------------------------------- approvals
export function ApprovalCard({ client, room, item }: { client: MatrixClient; room: Room; item: ChatItem }) {
    const v = item.agentView;
    const [sent, setSent] = useState<ApprovalChoice | null>(null);
    if (v?.type !== "approval") return null;
    const choices = approvalChoicesFromKeys(item.agentReactionKeys);
    const mine = item.myApprovalKey ? approvalChoicesFromKeys([item.myApprovalKey])[0] : sent;
    const pending = choices.length > 0 && !mine;
    const choose = async (c: ApprovalChoice) => {
        if (c.action === "always") {
            const ok = await ask({
                title: "Always allow this kind of command?",
                body: <>Hermes will run commands matching this pattern without asking again. You can revoke it in Hermes's configuration.<pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{v.command}</pre></>,
                confirm: "Always allow",
                danger: true,
            });
            if (!ok) return;
        }
        // The decision travels the agent's own control path (a reaction on its prompt). Hermes checks
        // that the reactor is the allowlisted requester; this client never runs anything itself.
        setSent(c);
        try {
            await react(client, room.roomId, item.id, c.key);
        } catch (e) {
            setSent(null);
            toast(`Couldn't send your decision: ${(e as Error).message}`, "error");
        }
    };
    return (
        <div className={`approval ${pending ? "" : "resolved"}`} role="group" aria-label="Approval request">
            <div className="approval-head">
                <div className="ico"><I.shield width={17} /></div>
                <div className="grow">
                    <div>{pending ? `${item.agent?.name ?? "Agent"} needs your approval` : mine ? `You chose: ${mine.label}` : "Approval closed"}</div>
                    <div className="hint" style={{ fontWeight: 400 }}>{v.reason ? `Flagged: ${v.reason}` : "Command flagged by the agent's safety check"} · {timeLabel(item.ts)}</div>
                </div>
            </div>
            <div className="approval-body">
                <pre>{v.command || "(no command text)"}</pre>
                {!pending && !mine && <div className="hint">This prompt was answered elsewhere or has expired. Nothing was run from here.</div>}
                {sent && !item.myApprovalKey && <div className="hint row"><div className="spinner" /> Sending to {item.agent?.name ?? "agent"}…</div>}
            </div>
            {pending && (
                <div className="approval-actions">
                    {choices.filter((c) => c.action !== "deny").map((c) => (
                        <button key={c.key} className={`btn sm ${c.action === "once" ? "primary" : ""}`} onClick={() => choose(c)}>{c.label}</button>
                    ))}
                    {choices.filter((c) => c.action === "deny").map((c) => (
                        <button key={c.key} className="btn sm danger" onClick={() => choose(c)}>{c.label}</button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- dev.orrery.agent events
function OrreryCard({ e }: { e: OrreryAgentEvent }) {
    const status = e.status ?? (e.kind === "tool_result" ? "done" : "running");
    return (
        <div className="activity-strip" style={{ padding: "10px 12px", display: "grid", gap: 6 }}>
            <div className="row" style={{ fontSize: 13 }}>
                <span className={`pill ${status === "failed" ? "danger" : status === "done" ? "ok" : "accent"}`}>{e.kind.replace("_", " ")}</span>
                <b className="grow truncate">{e.title ?? e.tool ?? e.task_id ?? "Agent event"}</b>
                {e.assignee && <span className="hint">→ {e.assignee}</span>}
                {e.progress && <span className="hint">{e.progress.done}/{e.progress.total}</span>}
            </div>
            {e.input && <pre className="step" style={{ margin: 0 }}>{e.input}</pre>}
            {e.output && <pre style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 12, whiteSpace: "pre-wrap" }}>{e.output}</pre>}
            {e.diff && <Markdown text={"```diff\n" + e.diff + "\n```"} />}
        </div>
    );
}

// ---------------------------------------------------------------- message
interface Props {
    client: MatrixClient;
    room: Room;
    item: ChatItem;
    replyItem?: ChatItem;
    steps?: ToolStep[];
    streaming?: boolean;
    isLastAgent?: boolean;
    /** e.g. "gpt-6.1-terra · medium" */
    modelUsed?: string;
    h: MessageHandlers;
}

function MessageImpl({ client, room, item, replyItem, steps, streaming, isLastAgent, modelUsed, h }: Props) {
    const speakingId = useSpeech((s) => s.speakingId);
    const readAloud = useUI((s) => s.settings.readAloud);
    const isAgent = !!item.agent;
    const v = item.agentView;

    if (item.kind === "membership" || item.kind === "room-state") return <StateLine room={room} item={item} />;
    if (item.kind === "redacted") return <div className={`msg ${item.mine ? "user" : "assistant"}`}><div className="undecryptable"><I.trash width={14} /> Message deleted</div></div>;
    if (v?.type === "approval") return <ApprovalCard client={client} room={room} item={item} />;
    if (v?.type === "orrery") return <OrreryCard e={v.event} />;

    const name = item.agent?.name ?? displayName(room, item.sender);
    const isMedia = ["image", "file", "audio", "video"].includes(item.kind);
    const body =
        item.kind === "undecryptable" ? (
            <div className="undecryptable" title={String(item.event.decryptionFailureReason ?? "")}>
                <I.lock width={15} /> Can't decrypt this message on this device yet. Verify this device or restore key backup in Settings → Security.
            </div>
        ) : isMedia ? (
            <MediaContent client={client} item={item} />
        ) : (
            <Markdown text={item.kind === "emote" ? `*${name} ${item.body}*` : item.body} html={isAgent ? undefined : item.html} streaming={streaming} />
        );

    const actions = (
        <div className="msg-actions" role="toolbar" aria-label="Message actions">
            {!isMedia && item.body && (
                <button className="icon-btn sm" title="Copy" onClick={() => copyText(item.body).then(() => toast("Copied"))}><I.copy /></button>
            )}
            <button className="icon-btn sm" title="Reply" onClick={() => h.onReply(item)}><I.reply /></button>
            {isAgent && readAloud && ttsSupported() && item.body && (
                <button className={`icon-btn sm ${speakingId === item.id ? "active" : ""}`} title={speakingId === item.id ? "Stop reading" : "Read aloud"} onClick={() => speak(item.id, item.body)}><I.speaker /></button>
            )}
            {isAgent && isLastAgent && <button className="icon-btn sm" title="Regenerate (asks the agent to retry)" onClick={h.onRetry}><I.retry /></button>}
            {item.mine && item.kind === "text" && <button className="icon-btn sm" title="Edit" onClick={() => h.onEdit(item)}><I.edit /></button>}
            {item.mine && !item.pending && (
                <button
                    className="icon-btn sm"
                    title="Delete"
                    onClick={async () => {
                        if (await ask({ title: "Delete this message?", body: "It will be removed for everyone in this conversation.", confirm: "Delete", danger: true }))
                            redact(client, room.roomId, item.id).catch((e) => toast(e.message, "error"));
                    }}
                >
                    <I.trash />
                </button>
            )}
        </div>
    );

    const quote = replyItem && (
        <div className="reply-quote" onClick={() => h.onJump(replyItem.id)} title="Jump to message">
            <b>{replyItem.agent?.name ?? displayName(room, replyItem.sender)}</b> {replyItem.body.slice(0, 160)}
        </div>
    );
    const reactions = item.reactions.filter((r) => !(item.agent === undefined && item.mine && item.agentReactionKeys.includes(r.key) && r.senders.length === 1));

    if (item.mine) {
        return (
            <div className="msg user" id={`ev-${item.id}`}>
                {actions}
                <div className="user-col">
                    <div className="bubble">
                        {quote}
                        {body}
                    </div>
                    <div className="msg-meta">
                        {item.pending === "sending" && <><div className="spinner" style={{ width: 11, height: 11 }} /> Sending</>}
                        {item.pending === "failed" && (
                            <span style={{ color: "var(--danger)" }}>
                                Not sent · <button className="btn ghost sm" onClick={() => client.resendEvent(item.event, room)}>Retry</button>{" "}
                                <button className="btn ghost sm" onClick={() => client.cancelPendingEvent(item.event)}>Discard</button>
                            </span>
                        )}
                        {item.processing === "failed" && <span className="pill danger">failed</span>}
                        {item.edited && <span>edited</span>}
                        {!item.pending && <span>{timeLabel(item.ts)}</span>}
                    </div>
                    <Reactions client={client} room={room} item={item} groups={reactions} />
                </div>
            </div>
        );
    }

    if (!isAgent) {
        return (
            <div className="msg peer" id={`ev-${item.id}`}>
                {actions}
                <Avatar name={name} id={item.sender} />
                <div className="content" style={{ display: "grid", justifyItems: "start", minWidth: 0 }}>
                    <div className="who">{name}<span className="time">{timeLabel(item.ts)}</span></div>
                    <div className="bubble">{quote}{body}</div>
                    <Reactions client={client} room={room} item={item} groups={reactions} />
                </div>
            </div>
        );
    }

    return (
        <div className={`msg assistant ${item.kind === "notice" ? "notice" : ""}`} id={`ev-${item.id}`}>
            {actions}
            <Avatar name={name} id={item.sender} agent />
            <div className="content">
                <div className="who">
                    {name}
                    {modelUsed && <span className="model-used" title={`Model and reasoning effort in effect for this reply, as reported by ${name} in this conversation`}>({modelUsed})</span>}
                    <span className="time">{timeLabel(item.ts)}{item.edited && !streaming ? " · edited" : ""}</span>
                </div>
                {steps && steps.length > 0 && <ActivityStrip steps={steps} />}
                {quote && replyItem && !replyItem.mine && quote}
                {body}
                <Reactions client={client} room={room} item={item} groups={reactions.filter((r) => !item.agentReactionKeys.includes(r.key))} />
            </div>
        </div>
    );
}
export const Message = memo(MessageImpl);

function Reactions({ client, room, item, groups }: { client: MatrixClient; room: Room; item: ChatItem; groups: ChatItem["reactions"] }) {
    if (!groups.length) return null;
    return (
        <div className="reactions">
            {groups.map((g) => (
                <button
                    key={g.key}
                    className={`reaction ${g.myEventId ? "mine" : ""}`}
                    title={g.senders.join(", ")}
                    onClick={() => (g.myEventId ? redact(client, room.roomId, g.myEventId) : react(client, room.roomId, item.id, g.key)).catch((e) => toast(e.message, "error"))}
                >
                    {g.key} {g.senders.length > 1 ? g.senders.length : ""}
                </button>
            ))}
        </div>
    );
}

function StateLine({ room, item }: { room: Room; item: ChatItem }) {
    const ev = item.event;
    const who = displayName(room, ev.getStateKey() ?? item.sender);
    let text = "";
    switch (ev.getType()) {
        case "m.room.member": {
            const m = ev.getContent().membership;
            const prev = ev.getPrevContent().membership;
            if (m === "join" && prev !== "join") text = `${who} joined`;
            else if (m === "invite") text = `${displayName(room, item.sender)} invited ${who}`;
            else if (m === "leave" && prev === "join") text = `${who} left`;
            else return null;
            break;
        }
        case "m.room.name": text = `Renamed to “${ev.getContent().name ?? ""}”`; break;
        case "m.room.encryption": text = "End-to-end encryption enabled"; break;
        case "m.room.create": text = "Conversation created"; break;
        default: return null;
    }
    return <div className="state-line">{ev.getType() === "m.room.encryption" && <I.lock width={12} />}{text}</div>;
}
