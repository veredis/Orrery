// Headless end-to-end probe against the real homeserver and Hermes, using the same matrix-js-sdk +
// Rust crypto stack as the app. It signs in as a temporary device, works in a dedicated encrypted
// test room, records event *shapes* to .harness/ (gitignored), and deletes its device on exit.
//
// Settings come from local/harness.json (git-ignored) or the environment:
//   { "homeserver": "https://matrix.example.org", "user": "alice",
//     "passwordFile": "/home/alice/secrets/matrix.password", "wslDistro": "Ubuntu-24.04" }
//   ORRERY_HS, ORRERY_HARNESS_USER, ORRERY_HARNESS_PASSWORD_FILE, ORRERY_HARNESS_WSL
// The password is read from that file (inside WSL when wslDistro is set) and is never printed.
// Usage: node scripts/harness/hermes-e2e.mjs [steps...]
//   steps: hello model reasoning tool approval switch existing   (default: hello)
import "fake-indexeddb/auto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createClient, ClientEvent, RoomEvent, SyncState, MatrixEventEvent } from "matrix-js-sdk";
import { logger } from "matrix-js-sdk/lib/logger.js";
logger.setLevel("warn");

const local = existsSync("local/harness.json") ? JSON.parse(readFileSync("local/harness.json", "utf8")) : {};
const HS = process.env.ORRERY_HS ?? local.homeserver ?? "http://127.0.0.1:8008";
const USER = process.env.ORRERY_HARNESS_USER ?? local.user;
const PASSWORD_FILE = process.env.ORRERY_HARNESS_PASSWORD_FILE ?? local.passwordFile;
const WSL = process.env.ORRERY_HARNESS_WSL ?? local.wslDistro;
if (!USER || !PASSWORD_FILE) throw new Error("set user and passwordFile in local/harness.json (see the header of this file)");
const steps = process.argv.slice(2).length ? process.argv.slice(2) : ["hello"];
const ROOM_NAME = "Orrery harness";
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPassword() {
    if (!WSL) return readFileSync(PASSWORD_FILE, "utf8").trim();
    const r = spawnSync("wsl", ["-d", WSL, "--", "cat", PASSWORD_FILE], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout.trim()) throw new Error("could not read password file");
    return r.stdout.trim();
}

const tmp = createClient({ baseUrl: HS });
const res = await tmp.loginRequest({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: USER },
    password: readPassword(),
    initial_device_display_name: "Orrery harness (temporary)",
});
log("logged in device", res.device_id);
const me = res.user_id;
const server = me.split(":")[1];
const HERMES = `@hermes:${server}`;
const client = createClient({ baseUrl: HS, accessToken: res.access_token, userId: me, deviceId: res.device_id, timelineSupport: true });
const captured = [];
let exitCode = 0;
try {
    await client.initRustCrypto({ useIndexedDB: false });
    await client.startClient({ initialSyncLimit: 10, lazyLoadMembers: true, threadSupport: false });
    await new Promise((resolve) => client.on(ClientEvent.Sync, (s) => s === SyncState.Prepared && resolve()));
    log("sync prepared;", client.getRooms().length, "rooms");

    const seen = new Map();
    const record = async (ev, room) => {
        await client.decryptEventIfNeeded(ev);
        const c = ev.getContent();
        const entry = {
            id: ev.getId(), room: room?.name, sender: ev.getSender(), type: ev.getType(), encrypted: ev.isEncrypted(),
            decryptFail: ev.isDecryptionFailure(), ts: ev.getTs(), msgtype: c.msgtype, relates: c["m.relates_to"],
            body: typeof c.body === "string" ? c.body : undefined, hasHtml: !!c.formatted_body,
            newBody: c["m.new_content"]?.body, keys: Object.keys(c),
        };
        seen.set(entry.id, entry);
        captured.push(entry);
        if (ev.getSender() !== me) log(`  <- ${entry.type}${entry.msgtype ? "/" + entry.msgtype : ""}`, JSON.stringify((entry.body ?? entry.newBody ?? entry.relates?.key ?? "").slice(0, 160)));
    };
    client.on(RoomEvent.Timeline, (ev, room, toStart) => { if (!toStart && room?.name === activeName) void record(ev, room); });
    client.on(MatrixEventEvent.Decrypted, () => {});

    let activeName = ROOM_NAME;
    let room = client.getRooms().find((r) => r.name === ROOM_NAME && r.getMyMembership() === "join");
    if (!room) {
        const { room_id } = await client.createRoom({
            name: ROOM_NAME, preset: "trusted_private_chat", invite: [HERMES], is_direct: true,
            initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
        });
        log("created room", room_id);
        for (let i = 0; i < 60 && !(room = client.getRoom(room_id)); i++) await sleep(500);
    }
    for (let i = 0; i < 60 && room.getMember(HERMES)?.membership !== "join"; i++) await sleep(1000);
    log("hermes membership:", room.getMember(HERMES)?.membership, "encrypted:", await client.getCrypto().isEncryptionEnabledInRoom(room.roomId));

    const waitFor = async (pred, ms = 180000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            const hit = captured.find(pred);
            if (hit) return hit;
            await sleep(500);
        }
        throw new Error("timeout waiting for event");
    };
    const send = async (body) => {
        const { event_id } = await client.sendTextMessage(room.roomId, body);
        log("->", body.slice(0, 80), event_id);
        return { event_id, t: Date.now() };
    };
    const fromHermesAfter = (t, test) => (e) => e.sender === HERMES && e.ts >= t - 2000 && test(e);
    const react = (eventId, key) => client.sendEvent(room.roomId, "m.reaction", { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key } });

    for (const step of steps) {
        log("== step", step);
        if (step === "hello") {
            const nonce = Math.random().toString(36).slice(2, 8);
            const { event_id, t } = await send(`Reply with exactly this and nothing else: ORRERY-OK ${nonce}`);
            const reply = await waitFor(fromHermesAfter(t, (e) => e.type === "m.room.message" && (e.body ?? "").includes(nonce) || (e.newBody ?? "").includes(nonce)));
            log("hello OK, decrypted reply received; processing reactions:", captured.filter((e) => e.type === "m.reaction" && e.relates?.event_id === event_id).map((e) => e.relates.key).join(" "));
            void reply;
        } else if (step === "model") {
            const { t } = await send("!model");
            await waitFor(fromHermesAfter(t, (e) => (e.body ?? "").includes("Model Configuration")));
            await sleep(4000);
        } else if (step === "reasoning") {
            const { t } = await send("!reasoning");
            await waitFor(fromHermesAfter(t, (e) => e.type === "m.room.message"));
            await sleep(4000);
        } else if (step === "tool") {
            const { t } = await send("Use your terminal tool to run `echo orrery-tool-probe && uname -s` and tell me the exact output.");
            await waitFor(fromHermesAfter(t, (e) => (e.body ?? e.newBody ?? "").includes("orrery-tool-probe") && !(e.body ?? "").includes("terminal")), 240000).catch(() => log("no final tool reply seen"));
            await sleep(6000);
        } else if (step === "approval") {
            const { t } = await send("Please run this exact shell command with your terminal tool, without modification: sudo -n rm -rf /var/lib/orrery-approval-probe-nonexistent");
            const prompt = await waitFor(fromHermesAfter(t, (e) => (e.body ?? "").includes("needs your OK")), 240000);
            await sleep(3000);
            const seeded = captured.filter((e) => e.type === "m.reaction" && e.sender === HERMES && e.relates?.event_id === prompt.id).map((e) => e.relates.key);
            log("approval prompt seeded reactions:", seeded.join(" "));
            const deny = seeded.find((k) => k === "❌" || k === "❎") ?? "❌";
            const t2 = Date.now();
            await react(prompt.id, deny);
            log("sent deny reaction", deny);
            await waitFor(fromHermesAfter(t2, (e) => e.type === "m.room.message"), 120000).catch(() => log("no post-deny message"));
            await sleep(5000);
        } else if (step === "switch") {
            // Switch to another *Codex* model through the picker reaction, verify, then switch back.
            const { t } = await send("!model");
            const picker = await waitFor(fromHermesAfter(t, (e) => (e.body ?? "").includes("Model Configuration")));
            const lines = picker.body.split("\n");
            const cur = /Current model: `([^`]+)`/.exec(picker.body)?.[1];
            const alt = lines.map((l) => /^(\S+)\s+`([^`]+)`\s+—\s+(.*)$/.exec(l)).find((m) => m && m[2] !== cur && /codex|openai/i.test(m[3]));
            if (!alt) { log("no alternative codex model; skipping"); continue; }
            await sleep(2500);
            const t2 = Date.now();
            await react(picker.id, alt[1]);
            log("picked", alt[2], "via", alt[1]);
            const conf = await waitFor(fromHermesAfter(t2, (e) => e.type === "m.room.message"), 60000);
            log("confirmation:", conf.body?.slice(0, 200));
            const t3 = Date.now();
            await send(`!model ${cur} --provider openai-codex`);
            const back = await waitFor(fromHermesAfter(t3, (e) => e.type === "m.room.message"), 60000);
            log("restored:", back.body?.slice(0, 200));
        } else if (step === "effort") {
            for (const cmd of ["!reasoning high", "!reasoning reset"]) {
                const { t } = await send(cmd);
                await waitFor(fromHermesAfter(t, (e) => e.type === "m.room.message"), 60000);
                await sleep(1500);
            }
        } else if (step === "restore") {
            for (const cmd of ["!model", "!model gpt-6.1-sol --provider openai-codex", "!model"]) {
                const { t } = await send(cmd);
                const r = await waitFor(fromHermesAfter(t, (e) => e.type === "m.room.message"), 90000);
                log("reply:", (r.body ?? "").split("\n").slice(0, 2).join(" / "));
                await sleep(8000);
            }
        } else if (step === "existing") {
            for (const name of ["General", "Development", "Research", "Agents"]) {
                const r = client.getRooms().find((x) => x.name === name);
                log(name, r ? `joined=${r.getMyMembership()} encrypted=${await client.getCrypto().isEncryptionEnabledInRoom(r.roomId)} members=${r.getJoinedMemberCount()}` : "not found");
            }
        }
    }
} catch (e) {
    exitCode = 1;
    log("FAILED:", e.message);
} finally {
    mkdirSync(".harness", { recursive: true });
    writeFileSync(`.harness/events-${Date.now()}.json`, JSON.stringify(captured, null, 1));
    client.stopClient();
    await client.logout(true).catch((e) => log("logout failed", e.message));
    log("device removed; captured", captured.length, "events");
    process.exit(exitCode);
}
