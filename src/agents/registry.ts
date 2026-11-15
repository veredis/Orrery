import type { MatrixClient, Room } from "matrix-js-sdk";
import type { AgentIdentity } from "./types";
import { HERMES_REASONING_LEVELS } from "./hermes";
import { readPrefs, updatePrefs } from "../matrix/prefs";

export interface RuntimeConfig {
    default_homeserver: string;
    brand?: string;
    agents?: Partial<AgentIdentity & { user_id: string }>[];
    /** Old homeserver URL → new one: saved sessions are moved over on start (same server, new address). */
    homeserver_moves?: Record<string, string>;
}

// Overridden by config.json (see config/README.md).
let config: RuntimeConfig = { default_homeserver: "" };
export async function loadConfig(): Promise<RuntimeConfig> {
    try {
        const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: "no-cache" });
        if (res.ok) config = { ...config, ...((await res.json()) as RuntimeConfig) };
    } catch {
        /* defaults */
    }
    return config;
}
export const getConfig = () => config;

function fromConfig(): AgentIdentity[] {
    return (config.agents ?? []).map((a) => ({
        userId: (a.userId ?? a.user_id)!,
        name: a.name ?? "Agent",
        kind: a.kind ?? "matrix-bot",
        role: a.role ?? "specialist",
        description: a.description,
        extraModels: a.extraModels,
        reasoningLevels: a.reasoningLevels ?? (a.kind === "hermes" ? HERMES_REASONING_LEVELS : undefined),
    }));
}

/** Agents = configured agents + ones the user registered (account data), de-duplicated. */
export function listAgents(client: MatrixClient | null, userAgents: AgentIdentity[] = []): AgentIdentity[] {
    const map = new Map<string, AgentIdentity>();
    for (const a of [...fromConfig(), ...userAgents]) if (a.userId) map.set(a.userId, { ...map.get(a.userId), ...a });
    for (const a of map.values()) if (a.kind === "hermes" && !a.reasoningLevels) a.reasoningLevels = HERMES_REASONING_LEVELS;
    // Fill in display names from the homeserver profile cache when we have them.
    if (client) for (const a of map.values()) {
        const u = client.getUser(a.userId);
        if (u?.displayName && a.name === "Agent") a.name = u.displayName;
    }
    return [...map.values()];
}

/**
 * Copy agents from this deployment's config.json into the user's account data, so every Orrery they
 * use (e.g. the desktop app from GitHub releases, which ships without agents) knows them too.
 * Only writes when something changed.
 */
export async function syncConfigAgents(client: MatrixClient): Promise<void> {
    const wanted = fromConfig().filter((a) => a.userId);
    if (!wanted.length) return;
    const have = new Map(readPrefs(client).agents.map((a) => [a.userId, a]));
    const strip = (a: AgentIdentity) => JSON.stringify({ ...a, reasoningLevels: undefined });
    if (wanted.every((a) => have.has(a.userId) && strip(have.get(a.userId)!) === strip(a))) return;
    await updatePrefs(client, (p) => {
        for (const a of wanted) {
            const { reasoningLevels: _r, ...rest } = a;
            p.agents = [...p.agents.filter((x) => x.userId !== a.userId), JSON.parse(JSON.stringify(rest)) as AgentIdentity];
        }
    });
}

export function agentFor(userId: string | undefined, agents: AgentIdentity[]): AgentIdentity | undefined {
    if (!userId) return undefined;
    return agents.find((a) => a.userId === userId);
}

/** The agent a conversation is "with": explicit per-room choice, else the first agent member. */
export function roomAgent(room: Room | null | undefined, agents: AgentIdentity[], explicit?: string): AgentIdentity | undefined {
    if (!room) return undefined;
    if (explicit) {
        const a = agentFor(explicit, agents);
        if (a) return a;
    }
    const members = room.getMembers().filter((m) => m.membership === "join" || m.membership === "invite");
    for (const a of agents) if (members.some((m) => m.userId === a.userId)) return a;
    return undefined;
}
