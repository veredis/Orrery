// Test-only Matrix homeserver for UI development, bound to 127.0.0.1. Rooms are UNENCRYPTED and all
// data is in memory. A scripted "Hermes" replays the message formats captured from the real bot
// (processing reactions, tool progress, approvals, model picker, reasoning) so the agent UI can be
// exercised without touching the real Synapse or Hermes. Never point real credentials at it.
//   node scripts/mock-homeserver.mjs   →  http://127.0.0.1:8448   user: tester / password: orrery-test
import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 8448);
const SERVER = "mock.local";
const ME = `@tester:${SERVER}`;
const BOT = `@hermes:${SERVER}`;
const PASSWORD = "orrery-test";

let pos = 0;
const events = []; // {pos, roomId, ev}
const accountData = new Map();
const roomAccountData = new Map();
const rooms = new Map(); // roomId -> {name}
let waiters = [];
const tokens = new Set();
let botModel = { model: "gpt-6.1-sol", provider: "ChatGPT or Codex Subscription" };
let botEffort = "medium (default)";

function push(roomId, ev) {
    ev.event_id ??= `$${randomUUID()}`;
    ev.origin_server_ts ??= Date.now();
    ev.unsigned ??= {};
    events.push({ pos: ++pos, roomId, ev });
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
    return ev.event_id;
}
const state = (roomId, type, state_key, content, sender = ME) => push(roomId, { type, state_key, content, sender });
const msg = (roomId, sender, body, extra = {}) => push(roomId, { type: "m.room.message", sender, content: { msgtype: "m.text", body, ...extra } });
const react = (roomId, sender, target, key) => push(roomId, { type: "m.reaction", sender, content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } } });
const redact = (roomId, sender, target) => push(roomId, { type: "m.room.redaction", sender, redacts: target, content: { redacts: target } });

function makeRoom(name, { direct = true } = {}) {
    const roomId = `!${randomUUID().slice(0, 12)}:${SERVER}`;
    rooms.set(roomId, { name });
    state(roomId, "m.room.create", "", { creator: ME, room_version: "11" });
    state(roomId, "m.room.member", ME, { membership: "join", displayname: "Tester" }, ME);
    state(roomId, "m.room.power_levels", "", { users: { [ME]: 100, [BOT]: 50 } });
    if (name) state(roomId, "m.room.name", "", { name });
    state(roomId, "m.room.member", BOT, { membership: "join", displayname: "Hermes", is_direct: direct }, BOT);
    return roomId;
}

// ---------------------------------------------------------------- seed data
const general = makeRoom("General");
const dev = makeRoom("Development");
makeRoom("Research");
makeRoom("Agents");
const p1 = msg(dev, ME, "Write a TypeScript debounce helper with a cancel method.");
react(dev, BOT, p1, "👀");
msg(dev, BOT, "📖 read_file: src/lib/util.ts");
msg(
    dev,
    BOT,
    "Here's a small, typed debounce with `cancel()`:\n\n```ts\nexport function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {\n  let t: ReturnType<typeof setTimeout> | undefined;\n  const d = (...a: A) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...a), ms);\n  };\n  d.cancel = () => clearTimeout(t);\n  return d;\n}\n```\n\n- Trailing-edge only\n- `cancel()` drops a pending call",
);
react(dev, BOT, p1, "✅");
const p2 = msg(general, ME, "What's on my plate today?");
react(general, BOT, p2, "👀");
msg(general, BOT, "You have **two** open items:\n\n1. Review the Frigate retention change\n2. Reply to the Matrix bridge question\n\nWant me to draft the reply?");
react(general, BOT, p2, "✅");
accountData.set("m.direct", { [BOT]: [general, dev] });
// The agent is registered in account data, the same way the app stores agents for real accounts.
const codex = (model) => ({ model, provider: "openai-codex", providerLabel: "ChatGPT or Codex Subscription" });
accountData.set("dev.orrery.prefs", {
    v: 1, pinned: [], projects: [], rooms: {}, archived: [],
    agents: [{ userId: BOT, name: "Hermes", kind: "hermes", role: "coordinator", description: "Scripted Hermes (mock)",
        extraModels: [...["gpt-6.1-sol", "gpt-6.1-sol-900k", "gpt-6.1-terra", "gpt-6-luna"].map(codex), { model: "hermes/qwen-4b-agent", provider: "lmstudio", providerLabel: "LM Studio" }] }],
});

// ---------------------------------------------------------------- scripted Hermes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PICKER_MODELS = ["gpt-6.1-sol", "gpt-6.1-sol-900k", "gpt-6.1-terra", "gpt-6-luna"];
const KEYS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣"];
async function hermes(roomId, ev) {
    const body = (ev.content?.body ?? "").trim();
    if (body === "!model") {
        const lines = PICKER_MODELS.map((m, i) => `${KEYS[i]} \`${m}\` — ChatGPT or Codex Subscription`).join("\n");
        msg(roomId, BOT, `⚙ **Model Configuration**\nCurrent model: \`${botModel.model}\`\nProvider: ${botModel.provider}\n\nReact to choose a model:\n${lines}`);
        return;
    }
    const sw = /^!model (\S+)(?: --provider (\S+))?/.exec(body);
    if (sw) {
        botModel = { model: sw[1], provider: sw[2] === "lmstudio" ? "LM Studio" : "ChatGPT or Codex Subscription" };
        msg(roomId, BOT, `Model switched to \`${sw[1]}\`\nProvider: ${botModel.provider}\nContext: 500,000 tokens\n_(session only — add \`--global\` to persist)_`);
        return;
    }
    if (body === "!reasoning") {
        msg(roomId, BOT, `🧠 **Reasoning Settings**\n\n**Effort:** \`${botEffort}\`\n**Scope:** global config\n**Display:** off\n\n_Usage:_ \`/reasoning <none|minimal|low|medium|high|xhigh|max|ultra|reset|show|hide> [--global]\``);
        return;
    }
    const re = /^!reasoning (\S+)/.exec(body);
    if (re) {
        if (re[1] === "reset") {
            botEffort = "medium (default)";
            msg(roomId, BOT, "🧠 ✓ Session reasoning override cleared; falling back to global config.");
        } else {
            botEffort = re[1];
            msg(roomId, BOT, `🧠 ✓ Reasoning effort set to \`${re[1]}\` (session only — add \`--global\` to persist)\n_(takes effect on next message)_`);
        }
        return;
    }
    if (body.startsWith("!")) {
        msg(roomId, BOT, `\`${body.split(" ")[0]}\` acknowledged (mock).`);
        return;
    }
    await sleep(400);
    react(roomId, BOT, ev.event_id, "👀");
    await sleep(900);
    if (/delete|rm -rf|approval/i.test(body)) {
        msg(roomId, BOT, "💻 terminal\n```\nsudo rm -rf /var/lib/example-cache\n```");
        await sleep(600);
        const ap = msg(
            roomId,
            BOT,
            "⚠️ **Hermes wants to run a command that needs your OK**\n```\nsudo rm -rf /var/lib/example-cache\n```\nWhy it was flagged: delete in root path\n\nIf you don't answer within 5 minutes it will NOT run.\n\nReply `!approve session` to approve this pattern for the session, `!approve always` to approve permanently, `!approve` to execute once, or `!deny` to cancel.\n\nYou can also click the reaction to approve:\n✅ = approve once\n🌀 = approve for this session\n♾️ = approve always\n❎ = deny",
        );
        for (const k of ["✅", "🌀", "♾️", "❎"]) react(roomId, BOT, ap, k);
        pendingApproval.set(ap, { roomId, prompt: ev.event_id });
        return;
    }
    msg(roomId, BOT, `🔎 web_search: "${body.slice(0, 40)}"`);
    await sleep(1500);
    msg(roomId, BOT, `**Mock reply** (model \`${botModel.model}\`, effort \`${botEffort}\`).\n\nYou said:\n\n> ${body.slice(0, 300)}\n\n| Item | Value |\n|---|---|\n| length | ${body.length} |\n| words | ${body.split(/\s+/).length} |`);
    react(roomId, BOT, ev.event_id, "✅");
}
const pendingApproval = new Map();
function onReaction(roomId, ev) {
    const rel = ev.content?.["m.relates_to"];
    const ap = pendingApproval.get(rel?.event_id);
    if (!ap || ev.sender !== ME) return;
    pendingApproval.delete(rel.event_id);
    const denied = rel.key === "❎";
    setTimeout(() => {
        msg(roomId, BOT, denied ? "The command was denied and did not run." : "Approved — ran the command. Exit code: `0`.");
        react(roomId, BOT, ap.prompt, denied ? "❌" : "✅");
    }, 500);
}

// ---------------------------------------------------------------- HTTP
function send(res, status, body) {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    });
    res.end(JSON.stringify(body));
}
const readBody = (req) =>
    new Promise((r) => {
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => {
            try {
                r(d ? JSON.parse(d) : {});
            } catch {
                r({});
            }
        });
    });

function roomSnapshot(roomId, since) {
    const all = events.filter((e) => e.roomId === roomId);
    const fresh = all.filter((e) => e.pos > since);
    if (!fresh.length) return null;
    const isState = (e) => e.ev.state_key !== undefined;
    return {
        state: { events: since === 0 ? [] : [] },
        timeline: { events: (since === 0 ? all : fresh).map((e) => e.ev), limited: false, prev_batch: `p${since}` },
        ephemeral: { events: [] },
        account_data: { events: [...(roomAccountData.get(roomId) ?? new Map())].map(([type, content]) => ({ type, content })) },
        unread_notifications: { notification_count: 0, highlight_count: 0 },
        summary: { "m.joined_member_count": 2, "m.heroes": [BOT] },
        _isState: isState,
    };
}

async function handleSync(url, res) {
    const since = Number((url.searchParams.get("since") ?? "s0").slice(1)) || 0;
    const timeout = Math.min(Number(url.searchParams.get("timeout") ?? 0), 10000);
    if (pos <= since && timeout > 0) await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, timeout);
    });
    const join = {};
    for (const roomId of rooms.keys()) {
        const snap = roomSnapshot(roomId, since);
        if (snap) {
            delete snap._isState;
            join[roomId] = snap;
        }
    }
    send(res, 200, {
        next_batch: `s${pos}`,
        rooms: { join, invite: {}, leave: {} },
        account_data: { events: since === 0 || true ? [...accountData].map(([type, content]) => ({ type, content })) : [] },
        to_device: { events: [] },
        device_lists: { changed: [], left: [] },
        device_one_time_keys_count: { signed_curve25519: 50 },
        "org.matrix.msc2732.device_unused_fallback_key_types": ["signed_curve25519"],
        device_unused_fallback_key_types: ["signed_curve25519"],
        presence: { events: [] },
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    if (req.method === "OPTIONS") return send(res, 200, {});
    if (p === "/.well-known/matrix/client") return send(res, 404, { errcode: "M_NOT_FOUND" });
    if (p === "/_matrix/client/versions") return send(res, 200, { versions: ["v1.1", "v1.5", "v1.11"], unstable_features: {} });
    if (p === "/_matrix/client/v3/login" && req.method === "GET") return send(res, 200, { flows: [{ type: "m.login.password" }] });
    if (p === "/_matrix/client/v3/login") {
        const b = await readBody(req);
        const user = b.identifier?.user ?? b.user ?? "";
        if (!/^@?tester(:mock\.local)?$/.test(user) || b.password !== PASSWORD) return send(res, 403, { errcode: "M_FORBIDDEN", error: "Invalid username or password" });
        const token = `mock_${randomUUID()}`;
        tokens.add(token);
        return send(res, 200, { user_id: ME, access_token: token, device_id: `MOCK${randomUUID().slice(0, 6).toUpperCase()}`, home_server: SERVER });
    }
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!auth) {
        console.log(`401 missing token: ${req.method} ${p}`);
        return send(res, 401, { errcode: "M_MISSING_TOKEN", error: "Missing access token" });
    }
    if (!tokens.has(auth)) {
        console.log(`401 unknown token: ${req.method} ${p}`);
        return send(res, 401, { errcode: "M_UNKNOWN_TOKEN", error: "Unknown token", soft_logout: false });
    }
    if (p.endsWith("/logout")) console.log(`logout: ${p}`);

    let m;
    if (p === "/_matrix/client/v3/sync") return handleSync(url, res);
    if (p === "/_matrix/client/v3/logout") return tokens.delete(auth), send(res, 200, {});
    if ((m = /^\/_matrix\/client\/v3\/user\/[^/]+\/filter$/.exec(p))) return send(res, 200, { filter_id: "1" });
    if ((m = /^\/_matrix\/client\/v3\/user\/[^/]+\/filter\/[^/]+$/.exec(p))) return send(res, 200, {});
    if ((m = /^\/_matrix\/client\/v3\/user\/[^/]+\/account_data\/([^/]+)$/.exec(p))) {
        const type = decodeURIComponent(m[1]);
        if (req.method === "PUT") {
            accountData.set(type, await readBody(req));
            pos++; // wake long-polling syncs so the change is delivered
            const w = waiters;
            waiters = [];
            w.forEach((f) => f());
            return send(res, 200, {});
        }
        return accountData.has(type) ? send(res, 200, accountData.get(type)) : send(res, 404, { errcode: "M_NOT_FOUND" });
    }
    if ((m = /^\/_matrix\/client\/v3\/user\/[^/]+\/rooms\/([^/]+)\/account_data\/([^/]+)$/.exec(p))) {
        const r = decodeURIComponent(m[1]);
        if (!roomAccountData.has(r)) roomAccountData.set(r, new Map());
        roomAccountData.get(r).set(decodeURIComponent(m[2]), await readBody(req));
        return send(res, 200, {});
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/.exec(p))) {
        const roomId = decodeURIComponent(m[1]);
        const type = decodeURIComponent(m[2]);
        const content = await readBody(req);
        const ev = { type, sender: ME, content };
        const id = push(roomId, ev);
        if (type === "m.room.message" && content.msgtype) void hermes(roomId, ev);
        if (type === "m.reaction") onReaction(roomId, ev);
        return send(res, 200, { event_id: id });
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/redact\/([^/]+)\/([^/]+)$/.exec(p))) {
        return send(res, 200, { event_id: redact(decodeURIComponent(m[1]), ME, decodeURIComponent(m[2])) });
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/([^/]+)\/?([^/]*)$/.exec(p)) && req.method === "PUT") {
        return send(res, 200, { event_id: state(decodeURIComponent(m[1]), decodeURIComponent(m[2]), decodeURIComponent(m[3] ?? ""), await readBody(req)) });
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(messages|members|joined_members)$/.exec(p))) {
        if (m[2] === "messages") return send(res, 200, { chunk: [], start: url.searchParams.get("from") ?? "p0" });
        const roomId = decodeURIComponent(m[1]);
        const members = events.filter((e) => e.roomId === roomId && e.ev.type === "m.room.member").map((e) => e.ev);
        if (m[2] === "members") return send(res, 200, { chunk: members });
        return send(res, 200, { joined: Object.fromEntries(members.map((e) => [e.state_key, { display_name: e.content.displayname }])) });
    }
    if ((m = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(leave|forget|read_markers|typing\/.*|receipt\/.*)$/.exec(p))) {
        if (m[2] === "leave") rooms.delete(decodeURIComponent(m[1]));
        return send(res, 200, {});
    }
    if (p === "/_matrix/client/v3/createRoom") {
        const b = await readBody(req);
        const roomId = makeRoom(b.name ?? "");
        return send(res, 200, { room_id: roomId });
    }
    if ((m = /^\/_matrix\/client\/v3\/profile\/([^/]+)/.exec(p))) {
        const u = decodeURIComponent(m[1]);
        return send(res, 200, { displayname: u === BOT ? "Hermes" : "Tester" });
    }
    if (p === "/_matrix/client/v3/pushrules/") return send(res, 200, { global: {} });
    if (p === "/_matrix/client/v3/capabilities") return send(res, 200, { capabilities: {} });
    if (p === "/_matrix/client/v3/keys/upload") return send(res, 200, { one_time_key_counts: { signed_curve25519: 50 } });
    if (p === "/_matrix/client/v3/keys/query") return send(res, 200, { device_keys: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {}, failures: {} });
    if (p === "/_matrix/client/v3/keys/claim") return send(res, 200, { one_time_keys: {}, failures: {} });
    if (p.startsWith("/_matrix/client/v3/sendToDevice")) return send(res, 200, {});
    if (p.startsWith("/_matrix/client/v3/room_keys/version")) return send(res, 404, { errcode: "M_NOT_FOUND", error: "No backup" });
    if (p === "/_matrix/client/v3/voip/turnServer") return send(res, 200, {});
    if (p.startsWith("/_matrix/client/v1/media/config") || p.startsWith("/_matrix/media/v3/config")) return send(res, 200, { "m.upload.size": 100 * 1024 * 1024 });
    if (req.method === "GET") return send(res, 404, { errcode: "M_UNRECOGNIZED", error: `mock: ${p}` });
    return send(res, 200, {});
});
server.listen(PORT, "127.0.0.1", () => console.log(`mock homeserver on http://127.0.0.1:${PORT}  (user tester / ${PASSWORD})`));
