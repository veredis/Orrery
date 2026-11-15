// Cross-device organisation (pins, projects, per-chat agent) lives in Matrix account data so it
// follows the account between Windows and the phone. Note: account data is not end-to-end
// encrypted; it holds names and IDs only, never message content.
import type { MatrixClient } from "matrix-js-sdk";
import type { AgentIdentity } from "../agents/types";

export const PREFS_TYPE = "dev.orrery.prefs";

export interface Project {
    id: string;
    name: string;
    icon?: string;
}
export interface RoomSettings {
    project?: string;
    agent?: string;
    /** remembered model hint, purely a cache of what Hermes last reported */
    lastModel?: string;
}
export interface OrreryPrefs {
    v: 1;
    pinned: string[];
    projects: Project[];
    rooms: Record<string, RoomSettings>;
    agents: AgentIdentity[];
    archived: string[];
}

export const emptyPrefs = (): OrreryPrefs => ({ v: 1, pinned: [], projects: [], rooms: {}, agents: [], archived: [] });

export function readPrefs(client: MatrixClient | null): OrreryPrefs {
    const ev = client?.getAccountData(PREFS_TYPE as never);
    const c = (ev?.getContent() ?? {}) as Partial<OrreryPrefs>;
    return { ...emptyPrefs(), ...c, rooms: { ...(c.rooms ?? {}) } };
}

let chain: Promise<unknown> = Promise.resolve();
/** Serialised read-modify-write so quick successive edits don't clobber each other. */
export function updatePrefs(client: MatrixClient, fn: (p: OrreryPrefs) => void): Promise<void> {
    const run = chain.then(async () => {
        const p = readPrefs(client);
        fn(p);
        await client.setAccountData(PREFS_TYPE as never, p as never);
    });
    chain = run.catch(() => undefined);
    return run;
}

export const newId = () => Math.random().toString(36).slice(2, 10);
