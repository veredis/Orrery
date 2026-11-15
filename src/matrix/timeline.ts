import { EventStatus, EventType, type MatrixEvent, type Room } from "matrix-js-sdk";
import { classifyHermesMessage, processingState } from "../agents/hermes";
import { agentFor } from "../agents/registry";
import { isControlCommand, type AgentIdentity, type AgentView, type OrreryAgentEvent } from "../agents/types";

export type ItemKind =
    | "text" | "notice" | "emote" | "image" | "file" | "audio" | "video"
    | "undecryptable" | "redacted" | "membership" | "room-state";

export interface ReactionGroup {
    key: string;
    senders: string[];
    myEventId?: string;
}

export interface ChatItem {
    id: string;
    event: MatrixEvent;
    sender: string;
    ts: number;
    kind: ItemKind;
    body: string;
    html?: string;
    content: Record<string, unknown>;
    edited: boolean;
    editEventId?: string;
    replyTo?: string;
    threadRoot?: string;
    reactions: ReactionGroup[];
    /** reaction keys placed by agents on this event (processing lifecycle, seeded controls) */
    agentReactionKeys: string[];
    agent?: AgentIdentity;
    agentView: AgentView | null;
    /** a `!command` sent by a person */
    isControl: boolean;
    mine: boolean;
    pending?: "sending" | "failed";
    processing: "working" | "done" | "failed" | null;
    /** set on approval items: my reaction key, if I already answered */
    myApprovalKey?: string;
}

const SHOWN_STATE = new Set<string>([EventType.RoomMember, EventType.RoomName, EventType.RoomEncryption, EventType.RoomCreate]);

function kindOf(ev: MatrixEvent): ItemKind | null {
    if (ev.isRedacted()) return "redacted";
    if (ev.isDecryptionFailure()) return "undecryptable";
    const type = ev.getType();
    if (type === EventType.RoomMessage) {
        const mt = ev.getContent().msgtype as string | undefined;
        switch (mt) {
            case "m.notice": return "notice";
            case "m.emote": return "emote";
            case "m.image": return "image";
            case "m.file": return "file";
            case "m.audio": return "audio";
            case "m.video": return "video";
            default: return "text";
        }
    }
    if (type === EventType.RoomMessageEncrypted) return ev.isBeingDecrypted() || ev.shouldAttemptDecryption() ? null : "undecryptable";
    if (SHOWN_STATE.has(type)) return type === EventType.RoomMember ? "membership" : "room-state";
    return null;
}

export interface TimelineModel {
    items: ChatItem[];
    byId: Map<string, ChatItem>;
    canPaginate: boolean;
}

export function buildTimeline(room: Room, myUserId: string, agents: AgentIdentity[]): TimelineModel {
    const live = room.getLiveTimeline();
    const events = [...live.getEvents(), ...room.getPendingEvents()];
    const reactions = new Map<string, Map<string, ReactionGroup>>();
    const agentKeys = new Map<string, string[]>();
    const edits = new Map<string, MatrixEvent>();

    for (const ev of events) {
        if (ev.isRedacted() || ev.status === EventStatus.CANCELLED) continue;
        const rel = ev.getRelation();
        if (ev.getType() === EventType.Reaction && rel?.rel_type === "m.annotation" && rel.event_id && rel.key) {
            const byKey = reactions.get(rel.event_id) ?? new Map<string, ReactionGroup>();
            const g = byKey.get(rel.key) ?? { key: rel.key, senders: [] };
            const sender = ev.getSender()!;
            if (!g.senders.includes(sender)) g.senders.push(sender);
            if (sender === myUserId) g.myEventId = ev.getId() ?? undefined;
            byKey.set(rel.key, g);
            reactions.set(rel.event_id, byKey);
            if (agentFor(sender, agents)) agentKeys.set(rel.event_id, [...(agentKeys.get(rel.event_id) ?? []), rel.key]);
        } else if (rel?.rel_type === "m.replace" && rel.event_id) {
            const prev = edits.get(rel.event_id);
            if (!prev || prev.getTs() <= ev.getTs()) edits.set(rel.event_id, ev);
        }
    }

    const items: ChatItem[] = [];
    const byId = new Map<string, ChatItem>();
    for (const ev of events) {
        const type = ev.getType();
        if (type === EventType.Reaction) continue;
        const rel = ev.getRelation();
        if (rel?.rel_type === "m.replace") continue;
        const kind = kindOf(ev);
        if (!kind) continue;
        const id = ev.getId() ?? ev.getTxnId() ?? `${ev.getTs()}`;
        const sender = ev.getSender() ?? "";
        const edit = edits.get(id);
        const editValid = edit && edit.getSender() === sender;
        const base = (ev.getOriginalContent?.() ?? ev.getContent()) as Record<string, unknown>;
        const content = editValid ? ((edit.getContent()["m.new_content"] as Record<string, unknown>) ?? base) : (ev.getContent() as Record<string, unknown>);
        const body = typeof content.body === "string" ? content.body : "";
        const html = content.format === "org.matrix.custom.html" && typeof content.formatted_body === "string" ? content.formatted_body : undefined;
        const agent = agentFor(sender, agents);
        const mine = sender === myUserId;
        const rx = reactions.get(id);
        const aKeys = agentKeys.get(id) ?? [];
        let agentView: AgentView | null = null;
        if (agent && (kind === "text" || kind === "notice")) {
            const orrery = content["dev.orrery.agent"] as OrreryAgentEvent | undefined;
            if (orrery && orrery.v === 1 && typeof orrery.kind === "string") agentView = { type: "orrery", event: orrery };
            else if (agent.kind === "hermes") agentView = classifyHermesMessage(stripReplyFallback(body));
        }
        const relatesTo = content["m.relates_to"] as { "m.in_reply_to"?: { event_id?: string }; rel_type?: string; event_id?: string } | undefined;
        const item: ChatItem = {
            id,
            event: ev,
            sender,
            ts: ev.getTs(),
            kind,
            body: stripReplyFallback(body),
            html: html ? stripHtmlReplyFallback(html) : undefined,
            content,
            edited: !!editValid,
            editEventId: editValid ? (edit.getId() ?? undefined) : undefined,
            replyTo: relatesTo?.["m.in_reply_to"]?.event_id ?? (ev.getContent()["m.relates_to"] as typeof relatesTo)?.["m.in_reply_to"]?.event_id,
            threadRoot: ev.getContent()["m.relates_to"] && (ev.getContent()["m.relates_to"] as { rel_type?: string }).rel_type === "m.thread"
                ? (ev.getContent()["m.relates_to"] as { event_id?: string }).event_id : undefined,
            reactions: rx ? [...rx.values()] : [],
            agentReactionKeys: aKeys,
            agent,
            agentView,
            isControl: !agent && (kind === "text" || kind === "notice") && isControlCommand(body),
            mine,
            pending: ev.status === EventStatus.NOT_SENT ? "failed" : ev.status && ev.status !== EventStatus.SENT ? "sending" : undefined,
            processing: mine ? processingState(aKeys) : null,
        };
        if (agentView?.type === "approval" && rx) {
            for (const g of rx.values()) if (g.myEventId) item.myApprovalKey = g.key;
        }
        items.push(item);
        byId.set(id, item);
    }
    return { items, byId, canPaginate: !!live.getPaginationToken("b" as never) };
}

/** Matrix reply fallbacks ("> <@user> quoted\n\n") are legacy; strip them for display. */
export function stripReplyFallback(body: string): string {
    if (!body.startsWith("> ")) return body;
    const lines = body.split("\n");
    let i = 0;
    while (i < lines.length && lines[i].startsWith("> ")) i++;
    if (i < lines.length && lines[i] === "") i++;
    return lines.slice(i).join("\n");
}
function stripHtmlReplyFallback(html: string): string {
    return html.replace(/^<mx-reply>[\s\S]*?<\/mx-reply>/, "");
}

/** Plain-text preview for room lists / notifications. */
export function previewText(ev: MatrixEvent | undefined): string {
    if (!ev) return "";
    if (ev.isRedacted()) return "Message deleted";
    if (ev.isDecryptionFailure()) return "Encrypted message";
    const c = ev.getContent();
    switch (c.msgtype) {
        case "m.image": return "🖼 Image";
        case "m.file": return `📎 ${c.body ?? "File"}`;
        case "m.audio": return "🎵 Audio";
        case "m.video": return "🎞 Video";
    }
    const body = typeof c.body === "string" ? stripReplyFallback(c.body) : "";
    return body.replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim().slice(0, 140);
}

export function lastMessageEvent(room: Room, skip?: (ev: MatrixEvent) => boolean): MatrixEvent | undefined {
    const evs = room.getLiveTimeline().getEvents();
    for (let i = evs.length - 1; i >= 0; i--) {
        const ev = evs[i];
        if (ev.getType() === EventType.RoomMessage && ev.getRelation()?.rel_type !== "m.replace") {
            if (skip?.(ev)) continue;
            return ev;
        }
        if (ev.getType() === EventType.RoomMessageEncrypted) return ev;
    }
    return undefined;
}
