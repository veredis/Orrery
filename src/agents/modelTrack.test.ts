import { describe, expect, it } from "vitest";
import type { ChatItem } from "../matrix/timeline";
import { classifyHermesMessage } from "./hermes";
import { isControlCommand, type AgentIdentity } from "./types";
import { modelLabel, trackModels } from "./modelTrack";

const hermes = { userId: "@hermes:example.org", name: "Hermes", kind: "hermes" } as AgentIdentity;
let n = 0;
const me = (body: string) => ({ id: `e${++n}`, kind: "text", body, mine: true, isControl: isControlCommand(body), agentView: null }) as unknown as ChatItem;
const bot = (body: string) => ({ id: `e${++n}`, kind: "text", body, mine: false, agent: hermes, isControl: false, agentView: classifyHermesMessage(body) }) as unknown as ChatItem;

// Formats as Hermes posts them (see hermes.test.ts).
const menu = (m: string) => `⚙ **Model Configuration**\nCurrent model: \`${m}\`\nProvider: ChatGPT or Codex Subscription\n\nReact to choose a model:\n1️⃣ \`${m}\` — ChatGPT or Codex Subscription`;
const switched = (m: string, global = false) => `Model switched to \`${m}\`\nProvider: ChatGPT or Codex Subscription\n${global ? "" : "_(session only — add `--global` to persist)_"}`;
const effortStatus = "🧠 **Reasoning Settings**\n\n**Effort:** `medium (default)`\n**Scope:** global config\n**Display:** off";
const effortSet = (e: string) => `🧠 ✓ Reasoning effort set to \`${e}\` (session only — add \`--global\` to persist)`;

describe("trackModels", () => {
    it("labels each reply with the model and effort in effect when it was sent", () => {
        const items = [me("!model"), bot(menu("gpt-6.1-sol")), me("!reasoning"), bot(effortStatus), me("hi"), bot("Hello!"),
            me("!model gpt-6.1-terra --provider openai-codex"), bot(switched("gpt-6.1-terra")), me("!reasoning high"), bot(effortSet("high")), me("again"), bot("Hi again")];
        const { byItem, current } = trackModels(items);
        expect(modelLabel(byItem.get(items[5].id))).toBe("gpt-6.1-sol · medium");
        expect(modelLabel(byItem.get(items[11].id))).toBe("gpt-6.1-terra · high");
        expect(current).toEqual({ model: "gpt-6.1-terra", effort: "high", effortSession: true });
    });

    it("fills in earlier replies from the first report, but not across a switch", () => {
        const items = [me("hi"), bot("Hello!"), me("!model"), bot(menu("gpt-6.1-sol"))];
        expect(trackModels(items).byItem.get(items[1].id)).toEqual({ model: "gpt-6.1-sol", effort: undefined });

        const switchedFirst = [me("hi"), bot("Hello!"), me("!model x"), bot(switched("gpt-6.1-terra")), me("!model"), bot(menu("gpt-6.1-terra"))];
        expect(modelLabel(trackModels(switchedFirst).byItem.get(switchedFirst[1].id))).toBe("");
    });

    it("drops session-only overrides when a new session starts", () => {
        const items = [bot(menu("gpt-6.1-sol")), bot(effortStatus), me("!model x"), bot(switched("gpt-6.1-terra")), bot(effortSet("high")), me("!new"), me("hi"), bot("Fresh")];
        const { byItem, current } = trackModels(items);
        expect(modelLabel(byItem.get(items[7].id))).toBe("gpt-6.1-sol · medium");
        expect(current.effortSession).toBe(false);
    });

    it("keeps global switches across new sessions", () => {
        const items = [bot(switched("gpt-6.1-terra", true)), me("!new"), me("hi"), bot("Fresh")];
        expect(trackModels(items).byItem.get(items[3].id)?.model).toBe("gpt-6.1-terra");
    });

    it("gives no label when the conversation never says", () => {
        const items = [me("hi"), bot("Hello!")];
        expect(modelLabel(trackModels(items).byItem.get(items[1].id))).toBe("");
    });
});
