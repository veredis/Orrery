// Fixtures are verbatim Hermes messages captured from the live E2EE harness run (scripts/harness).
import { describe, expect, it } from "vitest";
import { approvalChoicesFromKeys, classifyHermesMessage, hermesCommands, parseToolProgress, processingState } from "./hermes";
import { isControlCommand } from "./types";

const MODEL_PICKER = `⚙ **Model Configuration**
Current model: \`gpt-6.1-sol\`
Provider: ChatGPT or Codex Subscription

React to choose a model:
1️⃣ \`gpt-6.1-sol\` — ChatGPT or Codex Subscription
2️⃣ \`gpt-6.1-sol-900k\` — ChatGPT or Codex Subscription
3️⃣ \`gpt-6-astra\` — ChatGPT or Codex Subscription
🔟 \`gpt-5.6-sol\` — ChatGPT or Codex Subscription`;

const SWITCHED = `Model switched to \`gpt-6.1-sol\`
Provider: ChatGPT or Codex Subscription
Context: 500,000 tokens
Max output: 128,000 tokens
Capabilities: reasoning, tools, vision, PDF, structured output
_(session only — add \`--global\` to persist)_`;

const REASONING = `🧠 **Reasoning Settings**

**Effort:** \`medium (default)\`
**Scope:** global config
**Display:** off

_Usage:_ \`/reasoning <none|minimal|low|medium|high|xhigh|max|ultra|reset|show|hide> [--global]\``;

const APPROVAL = `⚠️ **Hermes wants to run a command that needs your OK**
\`\`\`
sudo -n rm -rf /var/lib/orrery-approval-probe-nonexistent
\`\`\`
Why it was flagged: delete in root path

If you don't answer within 5 minutes it will NOT run.

Reply \`!approve session\` to approve this pattern for the session, \`!approve always\` to approve permanently, \`!approve\` to execute once, or \`!deny\` to cancel.

You can also click the reaction to approve:
✅ = approve once
🌀 = approve for this session
♾️ = approve always
❎ = deny`;

const TOOL = "💻 terminal\n```\nsudo -n rm -rf /var/lib/orrery-approv...\n```";

describe("classifyHermesMessage", () => {
    it("parses the model picker with provider slugs", () => {
        const v = classifyHermesMessage(MODEL_PICKER);
        expect(v?.type).toBe("model-picker");
        if (v?.type !== "model-picker") return;
        expect(v.current).toBe("gpt-6.1-sol");
        expect(v.providerLabel).toBe("ChatGPT or Codex Subscription");
        expect(v.options).toHaveLength(4);
        expect(v.options[0]).toMatchObject({ pickerKey: "1️⃣", model: "gpt-6.1-sol", provider: "openai-codex" });
        expect(v.options[3]).toMatchObject({ pickerKey: "🔟", model: "gpt-5.6-sol" });
    });

    it("parses a model switch confirmation", () => {
        const v = classifyHermesMessage(SWITCHED);
        expect(v).toMatchObject({ type: "model-switched", model: "gpt-6.1-sol", providerLabel: "ChatGPT or Codex Subscription" });
        if (v?.type === "model-switched") expect(v.details).toContain("Context: 500,000 tokens");
    });

    it("parses reasoning status, set and reset", () => {
        const s = classifyHermesMessage(REASONING);
        expect(s).toMatchObject({ type: "reasoning-status", effort: "medium (default)", scope: "global config", display: "off" });
        if (s?.type === "reasoning-status") expect(s.levels).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
        expect(classifyHermesMessage("🧠 ✓ Reasoning effort set to `high` (session only — add `--global` to persist)\n_(takes effect on next message)_")).toEqual({
            type: "reasoning-set",
            effort: "high",
            scope: "session",
        });
        expect(classifyHermesMessage("🧠 ✓ Session reasoning override cleared; falling back to global config.")).toEqual({ type: "reasoning-reset" });
    });

    it("parses an approval request without treating it as executable", () => {
        const v = classifyHermesMessage(APPROVAL);
        expect(v).toMatchObject({ type: "approval", command: "sudo -n rm -rf /var/lib/orrery-approval-probe-nonexistent", reason: "delete in root path" });
    });

    it("recognises tool progress but not ordinary replies", () => {
        expect(classifyHermesMessage(TOOL)).toEqual({ type: "tool-progress", steps: [{ icon: "💻", tool: "terminal", preview: "sudo -n rm -rf /var/lib/orrery-approv...", language: undefined }] });
        expect(classifyHermesMessage("ORRERY-OK 2jruvt")).toBeNull();
        expect(classifyHermesMessage("```text\norrery-tool-probe\nLinux\n```")).toBeNull();
        expect(classifyHermesMessage("👍 sure, on it")).toBeNull();
        expect(classifyHermesMessage("Ran the exact command. Exit code: `0`; no output.")).toBeNull();
    });

    it("distinguishes an expired picker from a status line", () => {
        expect(classifyHermesMessage("⏳ This model picker expired — send !model again")?.type).toBe("control-reply");
        expect(classifyHermesMessage("⏳ Still working…")?.type).toBe("status");
    });
});

describe("helpers", () => {
    it("maps approval reactions in a stable order and drops unknown keys", () => {
        expect(approvalChoicesFromKeys(["❎", "♾️", "✅", "🌀", "🎉"]).map((c) => c.action)).toEqual(["once", "session", "always", "deny"]);
    });
    it("derives processing state from Hermes reactions", () => {
        expect(processingState(["👀"])).toBe("working");
        expect(processingState(["👀", "✅"])).toBe("done");
        expect(processingState(["👀", "❌"])).toBe("failed");
        expect(processingState([])).toBeNull();
    });
    it("builds typed commands", () => {
        expect(hermesCommands.switchModel({ model: "hermes/qwen-4b-agent", provider: "lmstudio" })).toBe("!model hermes/qwen-4b-agent --provider lmstudio");
        expect(hermesCommands.reasoning("high")).toBe("!reasoning high");
        expect(isControlCommand("!model")).toBe(true);
        expect(isControlCommand("please run !model")).toBe(false);
    });
    it("parses multi-step progress", () => {
        expect(parseToolProgress("🔎 web_search: \"matrix spec\"\n📖 read_file: notes.md")?.map((s) => s.tool)).toEqual(["web_search", "read_file"]);
    });
});
