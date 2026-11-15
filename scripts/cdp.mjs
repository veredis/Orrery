// Dev helper: inspect a running Orrery desktop window over a *local* DevTools port
// (start Electron with --remote-debugging-port=9333). Usage:
//   node scripts/cdp.mjs eval "<js expression>"
//   node scripts/cdp.mjs shot out.png
//   node scripts/cdp.mjs logs
const [, , cmd, arg] = process.argv;
const port = process.env.CDP_PORT ?? "9333";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
});
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
    } else if (msg.method) events.push(msg);
};
const send = (method, params = {}) =>
    new Promise((r) => {
        const i = ++id;
        pending.set(i, r);
        ws.send(JSON.stringify({ id: i, method, params }));
    });

// Device emulation lasts only as long as this DevTools connection, so apply it per command.
if (process.env.CDP_VIEWPORT) {
    const [w, h] = process.env.CDP_VIEWPORT.split("x").map(Number);
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
    await new Promise((r) => setTimeout(r, 600));
}

if (cmd === "eval" || cmd === "evalfile") {
    const expression = cmd === "evalfile" ? (await import("node:fs")).readFileSync(arg, "utf8") : arg;
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const ex = res.result?.exceptionDetails;
    if (ex) console.log("EXCEPTION", ex.exception?.description ?? ex.text);
    else console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 2));
} else if (cmd === "shot") {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const fs = await import("node:fs");
    fs.writeFileSync(arg ?? "shot.png", Buffer.from(res.result.data, "base64"));
    console.log("saved", arg);
} else if (cmd === "logs") {
    await send("Runtime.enable");
    await send("Log.enable");
    await new Promise((r) => setTimeout(r, 1500));
    for (const e of events) {
        if (e.method === "Runtime.consoleAPICalled") console.log(e.params.type, e.params.args.map((a) => a.value ?? a.description).join(" "));
        if (e.method === "Runtime.exceptionThrown") console.log("EXC", e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text);
        if (e.method === "Log.entryAdded") console.log("LOG", e.params.entry.level, e.params.entry.text);
    }
} else if (cmd === "resize") {
    const [w, h] = (arg ?? "375x812").split("x").map(Number);
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
    console.log("resized");
} else if (cmd === "installable") {
    const res = await send("Page.getInstallabilityErrors");
    const man = await send("Page.getAppManifest");
    console.log(JSON.stringify({ errors: res.result?.installabilityErrors, manifestErrors: man.result?.errors, manifestUrl: man.result?.url }, null, 2));
} else if (cmd === "reset") {
    await send("Emulation.clearDeviceMetricsOverride");
}
ws.close();
