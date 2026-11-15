import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ClientEvent, MatrixEventEvent, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import { useMatrix } from "../matrix/session";
import { buildTimeline, lastMessageEvent, type TimelineModel } from "../matrix/timeline";
import { readPrefs, type OrreryPrefs } from "../matrix/prefs";
import { listAgents, roomAgent } from "../agents/registry";
import { isControlCommand, type AgentIdentity, type AgentModelOption } from "../agents/types";
import { classifyHermesMessage } from "../agents/hermes";
import { deriveTasks, type AgentTask } from "../agents/tasks";
import { trackModels } from "../agents/modelTrack";

const PREVIEW_HIDDEN = new Set(["model-picker", "model-switched", "reasoning-set", "reasoning-reset", "reasoning-status", "control-reply", "tool-progress"]);

export function useClient(): MatrixClient {
    return useMatrix((s) => s.client)!;
}

/** Re-render on any of the given client events (rAF-batched). */
function useClientTick(client: MatrixClient | null, events: string[], filter?: (...args: unknown[]) => boolean): number {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!client) return;
        let queued = false;
        const handler = (...args: unknown[]) => {
            if (filter && !filter(...args)) return;
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => {
                queued = false;
                setTick((t) => t + 1);
            });
        };
        for (const e of events) client.on(e as never, handler as never);
        return () => {
            for (const e of events) client.off(e as never, handler as never);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, events.join()]);
    return tick;
}

export function usePrefs(): OrreryPrefs {
    const client = useMatrix((s) => s.client);
    const v = useMatrix((s) => s.roomsVersion);
    return useMemo(() => readPrefs(client), [client, v]);
}

export function useAgents(): AgentIdentity[] {
    const client = useMatrix((s) => s.client);
    const prefs = usePrefs();
    return useMemo(() => listAgents(client, prefs.agents), [client, prefs]);
}

export interface RoomSummary {
    room: Room;
    name: string;
    last?: MatrixEvent;
    ts: number;
    unread: number;
    highlight: number;
    agent?: AgentIdentity;
    invite: boolean;
    pinned: boolean;
    project?: string;
    working: boolean;
}

export function useRooms(): RoomSummary[] {
    const client = useMatrix((s) => s.client);
    const v = useMatrix((s) => s.roomsVersion);
    const prefs = usePrefs();
    const agents = useAgents();
    return useMemo(() => {
        if (!client) return [];
        const me = client.getUserId()!;
        return client
            .getRooms()
            .filter((r) => (r.getMyMembership() === "join" || r.getMyMembership() === "invite") && !r.isSpaceRoom())
            .filter((r) => !prefs.archived.includes(r.roomId))
            .map((room) => {
                const agent = roomAgent(room, agents, prefs.rooms[room.roomId]?.agent);
                // The preview skips plumbing: "!model"-style commands and Hermes's model/reasoning menus.
                const last = lastMessageEvent(room, (ev) => {
                    const body = ev.getContent()?.body;
                    if (typeof body !== "string") return false;
                    if (!agent || ev.getSender() !== agent.userId) return isControlCommand(body);
                    if (agent.kind !== "hermes") return false;
                    const t = classifyHermesMessage(body)?.type;
                    return !!t && PREVIEW_HIDDEN.has(t);
                });
                // "working" = the agent has 👀 on my latest message and hasn't finished.
                let working = false;
                if (agent) {
                    const evs = room.getLiveTimeline().getEvents();
                    const mineLast = [...evs].reverse().find((e) => e.getSender() === me && e.getType() === "m.room.message");
                    if (mineLast) {
                        const rx = evs.filter((e) => e.getType() === "m.reaction" && !e.isRedacted() && e.getSender() === agent.userId && e.getRelation()?.event_id === mineLast.getId()).map((e) => e.getRelation()?.key);
                        working = rx.includes("👀") && !rx.includes("✅") && !rx.includes("❌");
                    }
                }
                return {
                    room,
                    name: room.name || "Untitled",
                    last,
                    ts: Math.max(0, last?.getTs() ?? room.getLastActiveTimestamp() ?? 0),
                    unread: room.getUnreadNotificationCount() ?? 0,
                    highlight: room.getUnreadNotificationCount("highlight" as never) ?? 0,
                    agent,
                    invite: room.getMyMembership() === "invite",
                    pinned: prefs.pinned.includes(room.roomId),
                    project: prefs.rooms[room.roomId]?.project,
                    working,
                };
            })
            .sort((a, b) => b.ts - a.ts);
    }, [client, v, prefs, agents]);
}

const ROOM_EVENTS = [RoomEvent.Timeline, RoomEvent.LocalEchoUpdated, RoomEvent.Redaction, RoomEvent.TimelineReset, MatrixEventEvent.Decrypted, RoomEvent.Name];

export function useTimeline(room: Room | null, agents: AgentIdentity[]): TimelineModel | null {
    const client = useMatrix((s) => s.client);
    const tick = useClientTick(client, ROOM_EVENTS, (...args) => {
        // Decrypted events carry the event first; timeline events carry (event, room).
        const ev = args[0] as MatrixEvent | undefined;
        const r = args[1] as Room | undefined;
        if (r && "roomId" in (r as object)) return r.roomId === room?.roomId;
        return !ev?.getRoomId || ev.getRoomId() === room?.roomId;
    });
    return useMemo(() => (room && client ? buildTimeline(room, client.getUserId()!, agents) : null), [room, client, agents, tick]);
}

export interface AgentState {
    model?: string;
    providerLabel?: string;
    effort?: string;
    effortScope?: string;
    lastPicker?: { eventId: string; ts: number; options: AgentModelOption[] };
    working: boolean;
    pendingApprovals: number;
}

export function agentStateFrom(model: TimelineModel | null, tasks: AgentTask[]): AgentState {
    const st: AgentState = { working: false, pendingApprovals: 0 };
    if (!model) return st;
    for (const it of model.items) {
        const v = it.agentView;
        if (!v) continue;
        if (v.type === "model-picker") {
            st.model = v.current ?? st.model;
            st.providerLabel = v.providerLabel ?? st.providerLabel;
            st.lastPicker = { eventId: it.id, ts: it.ts, options: v.options };
        } else if (v.type === "model-switched") {
            st.model = v.model;
            st.providerLabel = v.providerLabel ?? st.providerLabel;
        } else if (v.type === "reasoning-status") {
            st.effort = v.effort;
            st.effortScope = v.scope;
        } else if (v.type === "reasoning-set") {
            st.effort = v.effort;
            st.effortScope = v.scope === "session" ? "this conversation" : "global";
        } else if (v.type === "reasoning-reset") {
            st.effort = undefined;
            st.effortScope = "global config";
        }
    }
    // A new session (`!new`) drops session-only overrides, so take model and effort from the replayed history.
    const now = trackModels(model.items).current;
    st.model = now.model;
    st.effort = now.effort;
    st.effortScope = now.effort ? (now.effortSession ? "this conversation" : "global config") : undefined;
    st.working = tasks.some((t) => t.status === "running" || t.status === "waiting");
    st.pendingApprovals = tasks.filter((t) => t.pendingApproval).length;
    return st;
}

export function useRoomTasks(room: Room | null, model: TimelineModel | null, agent: AgentIdentity | undefined): AgentTask[] {
    return useMemo(() => (room && model ? deriveTasks(room, model, agent) : []), [room, model, agent]);
}

/** Tasks across all joined rooms (for the board). */
export function useAllTasks(): AgentTask[] {
    const client = useMatrix((s) => s.client);
    const v = useMatrix((s) => s.roomsVersion);
    const agents = useAgents();
    const prefs = usePrefs();
    const decryptTick = useClientTick(client, [MatrixEventEvent.Decrypted]);
    return useMemo(() => {
        if (!client) return [];
        const me = client.getUserId()!;
        const out: AgentTask[] = [];
        for (const room of client.getRooms()) {
            if (room.getMyMembership() !== "join") continue;
            const agent = roomAgent(room, agents, prefs.rooms[room.roomId]?.agent);
            if (!agent) continue;
            out.push(...deriveTasks(room, buildTimeline(room, me, agents), agent));
        }
        return out.sort((a, b) => b.startedAt - a.startedAt);
    }, [client, v, agents, prefs, decryptTick]);
}

export function useOnline(): boolean {
    return useSyncExternalStore(
        (cb) => {
            addEventListener("online", cb);
            addEventListener("offline", cb);
            return () => {
                removeEventListener("online", cb);
                removeEventListener("offline", cb);
            };
        },
        () => navigator.onLine,
    );
}

export function useMediaQuery(q: string): boolean {
    return useSyncExternalStore(
        (cb) => {
            const m = matchMedia(q);
            m.addEventListener("change", cb);
            return () => m.removeEventListener("change", cb);
        },
        () => matchMedia(q).matches,
    );
}

export { ClientEvent };
