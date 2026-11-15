// Works out which model and reasoning effort produced each agent reply.
//
// Hermes doesn't tag its messages with the model, so this replays the conversation: model menus
// ("Current model: …"), "Model switched to …" and reasoning replies. Session-only overrides end
// when a new session starts (`!new` / `!reset`). Replies before the first report in a session take
// the model and effort that report shows, unless something was switched in between. When nothing
// in the conversation says, the reply gets no label rather than a guess.
import type { ChatItem } from "../matrix/timeline";

export interface ModelUsed {
    model?: string;
    effort?: string;
}

const NEW_SESSION = /^[!/](new|reset)\b/i;
const cleanEffort = (e?: string) => e?.replace(/\s*\(default\)\s*$/i, "").trim() || undefined;

export interface ModelTrack {
    /** model and effort for each agent reply, by item id */
    byItem: Map<string, ModelUsed>;
    /** what's in effect now; effortSession when the effort is this session's override */
    current: ModelUsed & { effortSession?: boolean };
}

export function trackModels(items: ChatItem[]): ModelTrack {
    let sessionModel: string | undefined;
    let globalModel: string | undefined;
    let sessionEffort: string | undefined;
    let globalEffort: string | undefined;
    // Replies in this session still waiting for a first report, with what they couldn't know yet.
    let backfill: { id: string; needModel: boolean; needEffort: boolean }[] = [];
    let modelChanged = false;
    let effortChanged = false;
    const byItem = new Map<string, ModelUsed>();

    const resolveBackfill = (model: string | undefined, effort: string | undefined) => {
        for (const b of backfill) {
            const u = byItem.get(b.id)!;
            if (b.needModel && model && !modelChanged) u.model = model;
            if (b.needEffort && effort && !effortChanged) u.effort = effort;
        }
        backfill = backfill.filter((b) => {
            const u = byItem.get(b.id)!;
            return (b.needModel && !u.model && !modelChanged) || (b.needEffort && !u.effort && !effortChanged);
        });
    };

    for (const it of items) {
        if (it.isControl && NEW_SESSION.test(it.body.trim())) {
            sessionModel = sessionEffort = undefined;
            backfill = [];
            modelChanged = effortChanged = false;
            continue;
        }
        const v = it.agentView;
        if (v?.type === "model-picker" && v.current) {
            if (sessionModel) sessionModel = v.current;
            else globalModel = v.current;
            resolveBackfill(v.current, undefined);
        } else if (v?.type === "model-switched") {
            modelChanged = true;
            if (v.details.some((d) => /session only/i.test(d))) sessionModel = v.model;
            else {
                globalModel = v.model;
                sessionModel = undefined;
            }
        } else if (v?.type === "reasoning-status") {
            const e = cleanEffort(v.effort);
            if (e) {
                if (/global/i.test(v.scope ?? "")) {
                    globalEffort = e;
                    sessionEffort = undefined;
                } else sessionEffort = e;
                resolveBackfill(undefined, e);
            }
        } else if (v?.type === "reasoning-set") {
            effortChanged = true;
            if (v.scope === "session") sessionEffort = v.effort;
            else {
                globalEffort = v.effort;
                sessionEffort = undefined;
            }
        } else if (v?.type === "reasoning-reset") {
            effortChanged = true;
            sessionEffort = undefined;
        } else if (it.agent?.kind === "hermes" && !v && it.kind !== "membership" && it.kind !== "room-state") {
            const used: ModelUsed = { model: sessionModel ?? globalModel, effort: sessionEffort ?? globalEffort };
            byItem.set(it.id, used);
            if (!used.model || !used.effort) backfill.push({ id: it.id, needModel: !used.model && !modelChanged, needEffort: !used.effort && !effortChanged });
        }
    }
    return { byItem, current: { model: sessionModel ?? globalModel, effort: sessionEffort ?? globalEffort, effortSession: !!sessionEffort } };
}

/** "gpt-6.1-terra · medium", or "" when nothing is known. */
export function modelLabel(u?: ModelUsed): string {
    return [u?.model, u?.effort].filter(Boolean).join(" · ");
}
