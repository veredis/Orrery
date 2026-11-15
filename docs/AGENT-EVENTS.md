# `dev.orrery.agent` — agent event format, version 1

Orrery shows agent activity (tool calls, approvals, tasks, delegation) as structured cards. It reads
two sources:

1. **Hermes's native Matrix messages.** Orrery recognises the formats Hermes already sends (model
   picker, model switch, reasoning settings, tool progress, approval prompts, processing reactions
   👀/✅/❌). Hermes needs no changes. The adapter is `src/agents/hermes.ts`, and its tests in
   `src/agents/hermes.test.ts` use messages captured from the live bot.
2. **This versioned format**, for agents that want to describe their work explicitly. It is optional
   and additive. Any Matrix bot can adopt it without breaking other clients.

## Envelope

An agent attaches a `dev.orrery.agent` object to an ordinary `m.room.message` (msgtype `m.text` or
`m.notice`). It always includes a human-readable `body`, so Element and other clients still show
something sensible:

```json
{
  "msgtype": "m.notice",
  "body": "🔧 Running tests (12/40)",
  "dev.orrery.agent": {
    "v": 1,
    "kind": "tool_call",
    "id": "call_7f3",
    "task_id": "task_42",
    "tool": "terminal",
    "title": "Running tests",
    "input": "npm test",
    "status": "running",
    "progress": { "done": 12, "total": 40 }
  }
}
```

In encrypted rooms the whole content, including `dev.orrery.agent`, is end-to-end encrypted like any
other message.

Orrery only reads the field from **configured agents**: those listed in `config.json` or added on the
Agents page. The same field from anyone else is ignored and shown as plain text.

## Fields

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | Required. Unknown versions are ignored and the `body` is shown instead. |
| `kind` | string | Required. One of `status`, `tool_call`, `tool_result`, `approval_request`, `task`, `artifact`, `delegation`. |
| `id` | string | Stable ID of this item. Later events with the same `id` update it. |
| `task_id` / `parent_task_id` | string | Group events into a task, and link sub-tasks to their parent. |
| `agent` / `assignee` | Matrix user ID | Who emitted the event, and who now owns the work (for delegation). |
| `status` | string | `queued`, `running`, `waiting`, `done`, `failed` or `cancelled`. |
| `title` | string | Short label for the card. |
| `tool`, `input`, `output`, `language` | string | Tool name, arguments, result, and the code language for highlighting. |
| `diff` | string | Unified diff, rendered with syntax highlighting. |
| `progress` | `{done, total}` | Determinate progress. |
| `approval` | `{request_id, choices:[{key,label,action}]}` | An approval request (see below). |
| `artifact` | `{name, mxc?, mimetype?, url?}` | A produced file, either uploaded media (`mxc`) or a link. |

Unknown fields are ignored, so they can be added without bumping `v`. Removing or changing the
meaning of a field requires `v: 2`.

## Rendering and safety rules (client side)

- All text fields are untrusted. They are shown as text or sanitised Markdown, never as HTML, and
  never executed.
- Orrery **never** runs anything because of an event. The only things it sends are ordinary Matrix
  messages and reactions, and only when the user explicitly clicks.
- Links are limited to `http(s)` and `mailto` and open in the system browser.

## Approvals

In this client version, an `approval_request` from a `dev.orrery.agent` agent is **displayed only**.
Hermes approvals (Hermes's native prompt) get the full approval card with buttons. Each button sends
the reaction key Hermes itself offers (✅ once, 🌀 session, ♾️ always, ❎ deny), so Hermes's own
approval checks stay in charge.

An agent that adopts approval buttons later **must** do its own verification:
- Accept a decision only from the user it is working for, by checking the reaction's `sender`.
- Accept it only for an outstanding `request_id`.
- In encrypted rooms, check the sending device is verified.

The client cannot enforce any of this for the agent.

## Tasks board

The Tasks page is built from real room data. Each prompt you send to an agent becomes a task. Its
status comes from the agent's processing reactions (👀 working, ✅ done, ❌ failed), and a pending
approval puts it in **Needs you**. `task` events with a `task_id` add explicit titles, owners
(`assignee`) and progress. Nothing is simulated: with no agent activity, the board is empty.
