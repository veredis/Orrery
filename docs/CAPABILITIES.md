# Orrery — capability summary

Legend:
- ✅ **Full**: implemented and exercised.
- 🟡 **Partial**: works, with a stated limit.
- 🔌 **Backend-dependent**: Orrery does its part, but the result depends on what the agent or homeserver supports.

## How it's tested

| Check | Method |
|---|---|
| E2EE round trip with a real Hermes | `npm run harness`: a headless client (matrix-js-sdk + Rust crypto, as in the app) signs in as a temporary device, exchanges encrypted messages with Hermes and records the formats: processing reactions, tool progress, approval prompts, the model picker and reasoning effort. The device is deleted afterwards. |
| Hermes message formats | Unit tests on messages captured verbatim from a live bot. |
| Agent UI end to end | Production builds against the loopback mock homeserver, which replays Hermes's formats, driven in headless Edge and in the desktop app: chat, working state with Stop, tool steps, approvals, model picker, reasoning levels, Tasks badge, phone layout at 412×915. |
| On-device speech | Synthetic speech through the bundled Whisper in the desktop app, and a Chromium fake microphone through the full composer in the PWA, including recordings over 2 minutes (split at pauses). |
| PWA | Built for `/orrery/` and checked in Edge: service worker active, precache filled, cross-origin isolated, no installability errors. |
| In-app updates | An installed build updating to a newer one from a local feed: check, download with progress, checksum verification, silent install and relaunch. |

**Not covered by automated tests:** recovery-key and SAS verification with real devices, a physical
microphone, and installing on a physical phone. Check those on your own setup.

## Capabilities

### Matrix and security
| | Status | Notes |
|---|---|---|
| Password sign-in, `.well-known` discovery | ✅ | HTTPS required except for loopback. |
| E2EE (Rust crypto, same as Element) | ✅ | Refuses to start without encryption rather than silently downgrading. |
| Verify with recovery key / another device (SAS emoji) | 🟡 | Implemented with the SDK's standard flows; not covered by automated tests (see above). |
| Key backup restore of older messages | 🟡 | Runs after recovery-key verification, with progress. Same caveat. |
| First-time recovery setup | ✅ | Offered only when the account has no keys at all. Never resets existing keys. |
| Session sealing (DPAPI / AES-GCM) | ✅ | |
| Revoked device / signed out elsewhere | ✅ | Returns to sign-in with an explanation. |
| Sync, offline banner, reconnect, retry | ✅ | Cached sync for fast start. |
| History and scrollback | ✅ | "Load earlier messages". Undecryptable events are explained, not hidden. |
| Threads | 🟡 | Thread replies show inline; there is no separate thread view. |

### Conversations
| | Status | Notes |
|---|---|---|
| New chat with an agent (encrypted DM) | ✅ | Auto-titled from the first prompt. |
| Search | 🟡 | Filters conversations by name and latest message. Full-text search inside encrypted history isn't possible server-side and isn't implemented locally. |
| Pin, projects, archive, rename, leave | ✅ | Synced through account data `dev.orrery.prefs`. That data is **not** end-to-end encrypted: it holds room IDs, project names and your agent list only. |
| Markdown, tables, syntax highlighting, copy buttons | ✅ | Sanitised; agent HTML is never trusted. |
| Attachments: picker, drag and drop, paste | ✅ | Encrypted upload in encrypted rooms. 95 MB cap, since many proxies and homeservers refuse more than 100 MB. |
| Reply, edit, delete, reactions | ✅ | In agent rooms, "edit" sends a corrected new message, because Hermes doesn't act on edits. |
| Persistent drafts | ✅ | Per conversation, on this device. |
| Export | ✅ | Markdown of the messages loaded on this device. |
| Light / dark / system theme | ✅ | |
| Notifications | ✅ | Agent and conversation name only, never message text. |

### Agent experience
| | Status | Notes |
|---|---|---|
| Working state, elapsed time, tool timeline | ✅ | From Hermes's 👀 / ✅ / ❌ reactions and tool-progress messages. |
| Token-by-token streaming | 🔌 | Hermes posts complete messages. Orrery shows a live working state, and streams text only if an agent sends incremental edits. |
| Stop / Retry / New session | 🔌 | Sends Hermes's `!stop`, `!retry`, `!new`. The effect depends on Hermes. |
| Approvals | ✅ / 🔌 | Card with Allow once / session / always / Deny. Each button sends Hermes's own reaction, and Hermes enforces it. "Always" asks for confirmation first. |
| Model picker | ✅ / 🔌 | The list comes from the agent's `extraModels` plus any model menu Hermes posted. A switch sends one typed `!model <id> --provider <slug>` in that conversation, and the top bar shows the model and reasoning effort. Element shows those commands as normal messages. |
| Reasoning effort | ✅ / 🔌 | `!reasoning <none…ultra>` and reset, per conversation. |
| Per-chat agent | ✅ | Picked automatically from room membership, or set explicitly. |
| Agent registry | ✅ | Agents from the deployment's config plus ones added in the app, stored in account data so every Orrery you use knows them. |
| Tasks board | 🟡 | Built only from real room data: prompts, reactions, approvals and `dev.orrery.agent` task events. Hermes's own `!kanban` board isn't imported yet. |
| Multi-agent | 🟡 | Roles and the versioned [`dev.orrery.agent`](AGENT-EVENTS.md) v1 schema. Approval buttons for v1 agents are display-only. |

### Voice
| | Status | Notes |
|---|---|---|
| Voice to text (dictation into editable text) | ✅ | On-device Whisper (base.en / tiny.en). Audio never leaves the device and is never sent as a voice message. Up to 5 minutes; long recordings are split at pauses. |
| Browser speech service (optional) | 🟡 | Off by default and clearly marked as cloud (Google in Chrome and on Android). Not available in the desktop app. |
| Read aloud (TTS) | 🟡 | Uses the system voices. Android may use Google's TTS engine, depending on phone settings. |

### Platforms
| | Status | Notes |
|---|---|---|
| Windows desktop | ✅ | NSIS installer, per user. Not code-signed yet (SmartScreen asks once). |
| In-app updates (desktop) | ✅ | From GitHub Releases: check (automatic or manual), download with progress, SHA-512 verification, restart to install. Every step after checking needs a click. |
| PWA (Android / browsers) | ✅ | Self-hosted, installable, cross-origin isolated (multi-threaded voice to text), updates itself. |
| Native Android package | ❌ | Not built. The PWA installs as an app and avoids a second codebase. A Trusted Web Activity wrapper could be added later. |
| macOS / Linux desktop | ❌ | Not built or tested yet. The shell is cross-platform Electron, but the updater and packaging are only set up for Windows. |
