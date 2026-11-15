// Agent-facing view models. Adapters turn ordinary Matrix events into these; the UI never executes
// anything based on them except sending standard Matrix events (messages/reactions) on explicit
// user action, so a hostile message can at most *display* a card.

export type AgentKind = "hermes" | "orrery-v1" | "matrix-bot";
export type AgentRole = "coordinator" | "worker" | "reviewer" | "specialist";

export interface AgentModelOption {
    model: string;
    /** Hermes provider slug when known (lets us switch with a single typed command) */
    provider?: string;
    providerLabel?: string;
    note?: string;
    /** reaction key on the most recent picker, when this option came from one */
    pickerKey?: string;
}

export interface AgentIdentity {
    userId: string;
    name: string;
    kind: AgentKind;
    role: AgentRole;
    description?: string;
    /** models Hermes supports but its 10-slot Matrix picker may not list */
    extraModels?: AgentModelOption[];
    reasoningLevels?: string[];
}

export type ApprovalAction = "once" | "session" | "always" | "deny";
export interface ApprovalChoice {
    key: string;
    action: ApprovalAction;
    label: string;
}

export type AgentView =
    | { type: "model-picker"; current?: string; providerLabel?: string; options: AgentModelOption[] }
    | { type: "model-switched"; model: string; providerLabel?: string; details: string[] }
    | { type: "reasoning-status"; effort?: string; scope?: string; display?: string; levels: string[] }
    | { type: "reasoning-set"; effort: string; scope: "session" | "global" }
    | { type: "reasoning-reset" }
    | { type: "approval"; command: string; reason?: string; smartDeny: boolean; requestId?: string }
    | { type: "approval-expired"; command?: string }
    | { type: "tool-progress"; steps: ToolStep[] }
    | { type: "status"; text: string }
    | { type: "control-reply"; text: string }
    | { type: "orrery"; event: OrreryAgentEvent };

export interface ToolStep {
    icon: string;
    tool: string;
    preview?: string;
    output?: string;
    status?: "running" | "done" | "failed";
    language?: string;
}

/** dev.orrery.agent v1 — see docs/AGENT-EVENTS.md */
export interface OrreryAgentEvent {
    v: 1;
    kind: "status" | "tool_call" | "tool_result" | "approval_request" | "task" | "artifact" | "delegation";
    id?: string;
    task_id?: string;
    parent_task_id?: string;
    agent?: string;
    assignee?: string;
    status?: "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";
    title?: string;
    tool?: string;
    input?: string;
    output?: string;
    diff?: string;
    language?: string;
    progress?: { done: number; total: number };
    approval?: { request_id?: string; choices: { key: string; label: string; action?: string }[] };
    artifact?: { name: string; mxc?: string; mimetype?: string; url?: string };
}

export const CONTROL_COMMANDS = [
    "model", "reasoning", "stop", "new", "retry", "undo", "queue", "steer", "approve", "deny", "title", "verbose",
    "fast", "usage", "status", "tasks", "kanban", "compress", "resume", "goal", "subgoal", "bg", "btw", "help",
    "commands", "yolo", "sethome", "reset",
];

export function isControlCommand(body: string): boolean {
    const m = /^[!/]([a-z][\w-]*)\b/i.exec(body.trim());
    return !!m && CONTROL_COMMANDS.includes(m[1].toLowerCase());
}
