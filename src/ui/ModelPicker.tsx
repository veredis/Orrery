import { useEffect, useRef, useState } from "react";
import type { MatrixClient, Room } from "matrix-js-sdk";
import type { AgentIdentity, AgentModelOption } from "../agents/types";
import { HERMES_PROVIDER_SLUGS, hermesCommands } from "../agents/hermes";
import { sendCommand } from "../matrix/actions";
import type { TimelineModel } from "../matrix/timeline";
import type { AgentState } from "./hooks";
import { Popover } from "./common";
import { I } from "./icons";
import { toast } from "./state";


interface Props {
    client: MatrixClient;
    room: Room;
    agent: AgentIdentity;
    state: AgentState;
    model: TimelineModel | null;
}

/**
 * Model and reasoning controls. Everything here goes through Hermes' own Matrix commands; the label
 * only changes when Hermes confirms the switch ("Model switched to …"), never optimistically.
 */
export function ModelPicker({ client, room, agent, state, model }: Props) {
    const btn = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState<{ model?: string; effort?: string; since: number } | null>(null);
    const isHermes = agent.kind === "hermes";

    // The list comes from config.json (Hermes's catalogue) plus any menu Hermes already posted here.
    // Orrery never asks for Hermes's reaction menu itself: that posts an emoji-reaction message every
    // Matrix client (Element included) shows.
    const picker = state.lastPicker;

    // Resolve pending switches from Hermes' replies.
    useEffect(() => {
        if (!pending || !model) return;
        const after = model.items.filter((i) => i.agent && i.ts >= pending.since - 1000);
        for (const it of after) {
            const v = it.agentView;
            if (pending.model && v?.type === "model-switched") {
                if (v.model === pending.model) toast(`${agent.name} is now using ${v.model}`);
                setPending(null);
                return;
            }
            if (pending.effort && (v?.type === "reasoning-set" || v?.type === "reasoning-reset")) {
                setPending(null);
                return;
            }
            if (!v && (it.kind === "text" || it.kind === "notice")) {
                // Hermes answered with something else — most likely an error explaining why.
                toast(`${agent.name}: ${it.body.split("\n")[0].slice(0, 160)}`, "error");
                setPending(null);
                return;
            }
        }
        const t = setTimeout(() => {
            setPending(null);
            toast(`${agent.name} didn't confirm the change. Check the conversation for details.`, "error");
        }, 90_000);
        return () => clearTimeout(t);
    }, [pending, model, agent.name]);

    const options: AgentModelOption[] = [];
    const seen = new Set<string>();
    for (const o of [...(agent.extraModels ?? []), ...(picker?.options ?? [])]) {
        const k = `${o.model}|${o.provider ?? o.providerLabel ?? ""}`;
        if (seen.has(o.model) || seen.has(k)) continue;
        seen.add(o.model);
        options.push(o);
    }
    const groups = new Map<string, AgentModelOption[]>();
    for (const o of options) {
        const g = o.providerLabel ?? o.provider ?? "Other";
        groups.set(g, [...(groups.get(g) ?? []), o]);
    }

    const choose = async (o: AgentModelOption) => {
        setOpen(false);
        if (o.model === state.model) return;
        setPending({ model: o.model, since: Date.now() });
        try {
            // One typed command; never a reaction on Hermes's menu.
            const provider = o.provider ?? (o.providerLabel ? HERMES_PROVIDER_SLUGS[o.providerLabel] : undefined);
            await sendCommand(client, room.roomId, hermesCommands.switchModel({ ...o, provider }));
        } catch (e) {
            setPending(null);
            toast((e as Error).message, "error");
        }
    };
    const setEffort = async (level: string) => {
        setPending({ effort: level, since: Date.now() });
        try {
            await sendCommand(client, room.roomId, level === "reset" ? "!reasoning reset" : hermesCommands.reasoning(level));
        } catch (e) {
            setPending(null);
            toast((e as Error).message, "error");
        }
    };

    const effortNow = (state.effort ?? "").replace(/\s*\(default\)/, "").trim();
    const label = pending?.model
        ? `Switching to ${pending.model}…`
        : pending?.effort
          ? `Setting effort to ${pending.effort}…`
          : state.model
            ? `${state.model}${effortNow ? ` · ${effortNow}` : ""}`
            : isHermes
              ? "Choose model"
              : "";

    return (
        <>
            <button ref={btn} className="model-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={!isHermes}>
                <span className="truncate">{agent.name}</span>
                {label && <span className="model truncate">{label}</span>}
                {pending ? <div className="spinner" style={{ width: 13, height: 13 }} /> : isHermes && <I.chevDown />}
            </button>
            {open && (
                <Popover anchor={btn.current} onClose={() => setOpen(false)}>
                    <div className="menu-label">Model</div>
                    {!options.length && <div className="menu-item muted">No models configured. Add them to config.json (extraModels).</div>}
                    {[...groups.entries()].map(([g, opts]) => (
                        <div key={g}>
                            <div className="menu-label" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 600, fontSize: 12 }}>{g}</div>
                            {opts.map((o) => (
                                <button key={o.model} className="menu-item" role="menuitemradio" aria-checked={o.model === state.model} onClick={() => choose(o)}>
                                    <div className="grow">
                                        <div style={{ fontFamily: "var(--mono)", fontSize: 13 }}>{o.model}</div>
                                        {o.note && <div className="desc">{o.note}</div>}
                                    </div>
                                    {o.model === state.model && <I.check className="check" />}
                                </button>
                            ))}
                        </div>
                    ))}
                    {(agent.reasoningLevels?.length ?? 0) > 0 && (
                        <>
                            <div className="menu-sep" />
                            <div className="menu-label"><I.brain width={13} /> Reasoning effort</div>
                            <div style={{ padding: "4px 8px 8px", display: "grid", gap: 8 }}>
                                <div className="seg" role="radiogroup" aria-label="Reasoning effort">
                                    {agent.reasoningLevels!.map((l) => (
                                        <button key={l} role="radio" aria-checked={effortNow === l} className={effortNow === l ? "on" : ""} onClick={() => setEffort(l)} disabled={!!pending}>
                                            {l}
                                        </button>
                                    ))}
                                </div>
                                <div className="hint">
                                    {state.effort ? <>Current: <b>{state.effort}</b>{state.effortScope ? ` (${state.effortScope})` : ""}. </> : null}
                                    Changes apply to this conversation from the next message.{" "}
                                    <button className="btn ghost sm" style={{ height: 22, padding: "0 6px" }} onClick={() => setEffort("reset")}>Reset</button>
                                </div>
                            </div>
                        </>
                    )}
                    <div className="menu-sep" />
                    <div className="hint" style={{ padding: "4px 10px 8px" }}>
                        A change sends one short <code>!model</code> or <code>!reasoning</code> command to {agent.name} in this conversation and applies only here. Orrery hides it; other Matrix apps such as Element show it as a normal message. Local models load on demand in LM Studio.
                    </div>
                </Popover>
            )}
        </>
    );
}
