// Hermes Agent adapter. Hermes speaks plain Matrix: markdown text, emoji reactions as controls, and
// `!command` aliases. Formats below were captured from the live Hermes v0.23 Matrix gateway (see
// tests/fixtures/hermes-events.json) and match its en locale catalog.
import type { AgentModelOption, AgentView, ApprovalAction, ApprovalChoice, ToolStep } from "./types";

/** Hermes provider display labels -> provider slugs (hermes_cli/providers.py _LABEL_OVERRIDES). */
export const HERMES_PROVIDER_SLUGS: Record<string, string> = {
    "ChatGPT or Codex Subscription": "openai-codex",
    "LM Studio": "lmstudio",
    "Nous Portal": "nous",
    "Custom endpoint": "custom",
    "Mixture of Agents": "moa",
    "AWS Bedrock": "bedrock",
    "Google Vertex AI": "vertex",
    "Ollama Cloud": "ollama-cloud",
    OpenRouter: "openrouter",
    Anthropic: "anthropic",
};

export const HERMES_APPROVAL_KEYS: Record<string, ApprovalAction> = {
    "✅": "once",
    "🌀": "session",
    "♾️": "always",
    "♾": "always",
    "❌": "deny",
    "❎": "deny",
};
const APPROVAL_LABELS: Record<ApprovalAction, string> = {
    once: "Allow once",
    session: "Allow for session",
    always: "Always allow",
    deny: "Deny",
};
export const HERMES_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function approvalChoicesFromKeys(keys: string[]): ApprovalChoice[] {
    const seen = new Set<ApprovalAction>();
    const out: ApprovalChoice[] = [];
    for (const key of keys) {
        const action = HERMES_APPROVAL_KEYS[key];
        if (!action || seen.has(action)) continue;
        seen.add(action);
        out.push({ key, action, label: APPROVAL_LABELS[action] });
    }
    const order: ApprovalAction[] = ["once", "session", "always", "deny"];
    return out.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
}

const firstFence = (s: string) => /```[\w-]*\n([\s\S]*?)\n?```/.exec(s)?.[1];

/** Tool progress bubble: one or more "<icon> <tool>[: preview]\n```\n<args>\n```" blocks. */
export function parseToolProgress(body: string): ToolStep[] | null {
    const re = /(^|\n)(\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*)\s+([a-z][\w.-]*(?::[\w.-]+)*)(?::\s*([^\n]*))?(?:\n```([\w-]*)\n([\s\S]*?)\n?```)?/gu;
    const steps: ToolStep[] = [];
    let consumed = 0;
    for (const m of body.matchAll(re)) {
        // A bare "<emoji> word" line is ordinary chat ("👍 sure"); progress lines carry args.
        if (m[6] === undefined && m[4] === undefined) return null;
        const preview = (m[6] ?? m[4] ?? "").trim().replace(/^"|"$/g, "");
        steps.push({ icon: m[2], tool: m[3], preview: preview || undefined, language: m[5] || undefined });
        consumed += m[0].length;
    }
    // Only treat as progress when the message is essentially nothing but tool lines.
    if (!steps.length || consumed < body.trim().length * 0.8) return null;
    return steps;
}

export function classifyHermesMessage(body: string): AgentView | null {
    const text = body.trim();
    if (!text) return null;
    if (/^⚙\s*\*\*Model Configuration\*\*/.test(text)) {
        const current = /Current model: `([^`]+)`/.exec(text)?.[1];
        const providerLabel = /^Provider: (.+)$/m.exec(text)?.[1]?.trim();
        const options: AgentModelOption[] = [];
        for (const line of text.split("\n")) {
            const m = /^(\S+)\s+`([^`]+)`\s+—\s+(.+?)(?:\s+·\s+(.*))?$/.exec(line.trim());
            if (!m) continue;
            const label = m[3].trim();
            options.push({ pickerKey: m[1], model: m[2], providerLabel: label, provider: HERMES_PROVIDER_SLUGS[label], note: m[4] });
        }
        return { type: "model-picker", current, providerLabel, options };
    }
    const switched = /^(?:⚙\s*)?(?:✓\s*)?Model switched(?: to)?:?\s*`([^`]+)`/.exec(text);
    if (switched) {
        const lines = text.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
        const providerLabel = lines.find((l) => l.startsWith("Provider:"))?.slice(9).trim();
        return { type: "model-switched", model: switched[1], providerLabel, details: lines.filter((l) => !l.startsWith("Provider:")) };
    }
    if (/^🧠\s*\*\*Reasoning Settings\*\*/.test(text)) {
        const usage = /\/reasoning <([^>]+)>/.exec(text)?.[1];
        const levels = usage ? usage.split("|").filter((l) => !["reset", "show", "hide"].includes(l)) : HERMES_REASONING_LEVELS;
        return {
            type: "reasoning-status",
            effort: /\*\*Effort:\*\*\s*`([^`]+)`/.exec(text)?.[1],
            scope: /\*\*Scope:\*\*\s*(.+)/.exec(text)?.[1]?.trim(),
            display: /\*\*Display:\*\*\s*(.+)/.exec(text)?.[1]?.trim(),
            levels,
        };
    }
    const effortSet = /^🧠\s*✓\s*Reasoning effort set to `([^`]+)`(.*)/s.exec(text);
    if (effortSet) return { type: "reasoning-set", effort: effortSet[1], scope: /session only/.test(effortSet[2]) ? "session" : "global" };
    if (/^🧠\s*✓\s*Session reasoning override cleared/.test(text)) return { type: "reasoning-reset" };
    if (/needs your OK\*\*/.test(text) && text.startsWith("⚠️")) {
        return {
            type: "approval",
            command: firstFence(text) ?? "",
            reason: /Why it was flagged:\s*(.+)/.exec(text)?.[1]?.trim(),
            smartDeny: /Smart DENY/.test(text),
        };
    }
    if (/^⌛\s*Approval timed out/.test(text)) return { type: "approval-expired", command: firstFence(text) };
    if (/^⏳ This model picker expired|^That reaction is not/.test(text)) return { type: "control-reply", text };
    if (/^⏳|still working…|Still working/.test(text) && text.length < 200) return { type: "status", text };
    const steps = parseToolProgress(text);
    if (steps) return { type: "tool-progress", steps };
    return null;
}

/** Map processing reactions Hermes places on the user's message. */
export function processingState(keysFromAgent: string[]): "working" | "done" | "failed" | null {
    if (keysFromAgent.includes("❌")) return "failed";
    if (keysFromAgent.includes("✅")) return "done";
    if (keysFromAgent.includes("👀")) return "working";
    return null;
}

export const hermesCommands = {
    listModels: () => "!model",
    switchModel: (o: AgentModelOption) => (o.provider ? `!model ${o.model} --provider ${o.provider}` : `!model ${o.model}`),
    reasoning: (level: string, global = false) => `!reasoning ${level}${global ? " --global" : ""}`,
    reasoningStatus: () => "!reasoning",
    stop: () => "!stop",
    retry: () => "!retry",
    newSession: () => "!new",
    status: () => "!status",
    tasks: () => "!tasks",
};
