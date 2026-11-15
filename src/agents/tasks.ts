// Task derivation. A "task" is one request a person sent to an agent, followed by everything the
// agent did for it (tool steps, approvals) up to its reply. Status comes from the agent's own
// processing reactions (Hermes: 👀 working, ✅ done, ❌ failed), so the board reflects real backend
// state — nothing is simulated. Agents that emit dev.orrery.agent task events add/override tasks.
import type { Room } from "matrix-js-sdk";
import type { ChatItem, TimelineModel } from "../matrix/timeline";
import type { AgentIdentity, ToolStep } from "./types";

export type TaskStatus = "waiting" | "running" | "done" | "failed" | "sent";

export interface AgentTask {
    id: string;
    roomId: string;
    roomName: string;
    title: string;
    agent?: AgentIdentity;
    assignee?: string;
    status: TaskStatus;
    startedAt: number;
    finishedAt?: number;
    steps: { item: ChatItem; steps: ToolStep[] }[];
    approvals: ChatItem[];
    pendingApproval?: ChatItem;
    reply?: ChatItem;
    prompt?: ChatItem;
    /** explicit status from a dev.orrery.agent `task` event; wins over reactions */
    reported?: TaskStatus;
    progress?: { done: number; total: number };
}

export function approvalPending(item: ChatItem): boolean {
    // Hermes seeds its choice reactions and redacts them once answered/expired.
    return item.agentView?.type === "approval" && item.agentReactionKeys.length > 0 && !item.myApprovalKey;
}

export function deriveTasks(room: Room, model: TimelineModel, agent: AgentIdentity | undefined): AgentTask[] {
    const tasks: AgentTask[] = [];
    let cur: AgentTask | null = null;
    for (const item of model.items) {
        if (item.mine && !item.isControl && (item.kind === "text" || item.kind === "image" || item.kind === "file") && agent) {
            cur = {
                id: item.id,
                roomId: room.roomId,
                roomName: room.name,
                title: (item.body || item.kind).split("\n")[0].slice(0, 120),
                agent,
                status: item.processing === "done" ? "done" : item.processing === "failed" ? "failed" : item.processing === "working" ? "running" : "sent",
                startedAt: item.ts,
                steps: [],
                approvals: [],
                prompt: item,
            };
            tasks.push(cur);
            continue;
        }
        if (!cur || !item.agent) continue;
        const v = item.agentView;
        if (v?.type === "tool-progress") cur.steps.push({ item, steps: v.steps });
        else if (v?.type === "approval") {
            cur.approvals.push(item);
            if (approvalPending(item)) cur.pendingApproval = item;
        } else if (v?.type === "orrery") {
            const e = v.event;
            if (e.kind === "tool_call" || e.kind === "tool_result")
                cur.steps.push({ item, steps: [{ icon: "🛠", tool: e.tool ?? "tool", preview: e.input, output: e.output, status: e.status === "failed" ? "failed" : e.status === "done" ? "done" : "running" }] });
            if (e.assignee) cur.assignee = e.assignee;
            if (e.kind === "task") {
                if (e.title) cur.title = e.title.slice(0, 120);
                if (e.progress) cur.progress = e.progress;
                const map: Record<string, TaskStatus> = { queued: "running", running: "running", waiting: "waiting", done: "done", failed: "failed", cancelled: "failed" };
                if (e.status && map[e.status]) cur.reported = map[e.status];
            }
        } else if (!v && (item.kind === "text" || item.kind === "notice" || item.kind === "image" || item.kind === "file")) {
            if (!cur.reply || item.replyTo === cur.id) cur.reply = item;
            cur.finishedAt = item.ts;
        }
    }
    for (const t of tasks) {
        if (t.pendingApproval && t.status !== "done" && t.status !== "failed") t.status = "waiting";
        // No processing reactions (agent without lifecycle reactions): a reply means done.
        if (t.status === "sent" && t.reply) t.status = "done";
        if (t.reported) t.status = t.reported;
    }
    return tasks;
}
