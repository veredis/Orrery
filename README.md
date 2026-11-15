# Orrery

An AI-first Matrix client for **Hermes Agent** and other agents. Conversations feel like a personal AI workspace rather than a chat app: live working state,
tool timelines, approval cards, a real model picker, a task board and on-device voice to text.
Underneath, every message is still an end-to-end encrypted Matrix event in your own rooms on your
own homeserver.

- **Windows desktop app** (Electron) with one-click in-app updates from GitHub Releases
- **Installable web app (PWA)** for Android phones and any modern browser, hosted next to your homeserver
- Works with any Matrix homeserver (Synapse, Conduit, …) and with Element side by side: Orrery is just
  another verified device on your account

See [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for what is fully working, partial or depends on the agent.

---

## Install

### Windows

1. Download `Orrery-Setup-<version>.exe` from the [latest release](https://github.com/veredis/Orrery/releases/latest)
   and run it. It installs per user; no admin rights are needed. The installer isn't code-signed yet,
   so Windows SmartScreen may ask: click **More info → Run anyway**.
2. Enter your Matrix server, username and password.
3. Open **Settings → Security → Use recovery key** (or **Verify with another device** and accept in
   Element). Until then, older encrypted messages can't be read on the new device.

**Updates:** Orrery checks GitHub for a new release at launch and every 6 hours (you can turn this off
in **Settings → Updates**). When one is out, Settings shows an **Update** badge: click **Update**, then
**Restart to update**. Nothing downloads or installs without your click, each download is checked
against the release's SHA-512 before it runs, and your sign-in, keys and settings are kept.

### Phone or browser (PWA)

The web app is self-hosted: build it and serve it from your own server (see
[Hosting the web app](#hosting-the-web-app)). Then open its address in Chrome and use
**⋮ → Add to Home screen → Install**. It updates itself: a new version installs in the background and
the page reloads once (drafts are kept).

### Adding your agents

**Agents → Add agent**, enter the agent's Matrix ID (for example `@hermes:example.org`) and say whether
it's a Hermes Agent. Agents are stored in your Matrix account data, so every Orrery you sign in to
knows them. Self-hosters can also preconfigure agents in `local/config.json` (see
[config/README.md](config/README.md)).

### Everyday features

| | |
|---|---|
| **New chat** | `Ctrl+Shift+O`, or the button at the top of the sidebar. It creates an encrypted DM with the agent. |
| **Voice to text** | The **Voice to text** button (mic with text lines) or `Ctrl+Shift+Space`. Speak, then press ✓: your speech becomes text where your cursor was, for you to edit before sending. It is never sent as a voice message, and with the default on-device engine the audio never leaves the device. |
| **Model / reasoning** | Click the agent name in the top bar, which shows e.g. `my-model · medium`. A change sends one short `!model` or `!reasoning` command to Hermes in that conversation; Orrery hides it, Element shows it as text. |
| **Approvals** | When Hermes asks to run a flagged command, an approval card appears. The buttons send Hermes's own approval reactions. |
| **Stop / Retry** | Stop appears while an agent is working. Retry is on the last agent reply. |
| **Activity** | `Ctrl+Shift+A` opens the activity panel: current model, tool steps, approvals and history. |
| **Tasks** | A board of everything you've asked agents to do: Needs you / In progress / Done / Failed. |
| **Projects, pins, archive** | From the conversation's ⋯ menu. They sync across devices through your Matrix account data. |
| **Export** | ⋯ → Export as Markdown (messages loaded on this device). |
| **Search** | `Ctrl+K` filters conversations. |
| **Phone gestures** | Swipe right anywhere in a conversation to go back to the list. |

---

## Development

Requirements: Node 22+ and npm.

```bash
npm install
```

```bash
npm run models
```

`npm run models` downloads the Whisper speech models into `public/models`. It's needed once per checkout.

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on http://localhost:5173 |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit tests (Hermes adapter on captured messages, Markdown sanitiser, speech segmentation) |
| `npm run build` | Desktop bundle in `dist/` (base `/`, generic config) |
| `npm run build:web` | PWA bundle in `dist-web/` (base `/orrery/`, override with `ORRERY_BASE`; uses `local/config.json`) |
| `npm run electron` | Run the desktop shell against `dist/` |
| `npm run dist:win` | License notices, build, then the Windows installer in `release/` (not published) |
| `npm run release` | Build and publish a GitHub release (see [Releasing](#releasing)) |
| `npm run harness` | Live end-to-end probe against a real Hermes (see below) |

### Your own settings

Anything specific to your deployment lives in the git-ignored `local/` folder:

- `local/config.json`: default homeserver and preconfigured agents for your web app and dev server
  ([config/README.md](config/README.md)). Desktop releases never include it.
- `local/harness.json`: account for the live harness.

### Testing without a real server

`node scripts/mock-homeserver.mjs` starts a loopback-only fake homeserver on `127.0.0.1:8448`
(user `tester`, password `orrery-test`). Its scripted Hermes replays the real bot's formats:
processing reactions, tool progress, approvals, model picker and reasoning. Rooms are unencrypted,
and everything is in memory. Point the sign-in screen's server at `http://127.0.0.1:8448`.

`node scripts/serve-web.mjs [--isolate]` serves `dist-web` at `http://127.0.0.1:4180/orrery/` with real
404s. `--isolate` adds COOP/COEP.

`npm run harness` signs in to a **real** account headlessly as a temporary device named
"Orrery harness (temporary)". It exchanges encrypted messages with Hermes in a room called
"Orrery harness", records the message formats into `.harness/` (git-ignored), and deletes the device
at the end. The account comes from `local/harness.json`; the password is read from a file and never
printed.

To test in-app updates locally, serve a newer build's `latest.yml` and installer over loopback and
start the installed app with `ORRERY_UPDATE_FEED=http://127.0.0.1:<port>/` (and optionally
`ORRERY_USER_DATA=<folder>` for a separate profile).

### Releasing

Releases are built on your machine and uploaded with your GitHub CLI sign-in (`gh auth login`):

```bash
npm version patch
```

```bash
npm run release
```

`npm version` bumps the version, commits and tags it (use `minor` or `major` as needed).
`npm run release` checks that the tree is clean and the tag matches, pushes the commit and tag, builds
the installer and publishes the release with `latest.yml`. Installed copies then offer the update.

### Hosting the web app

`npm run build:web` produces a static PWA in `dist-web/` for the `/orrery/` path. Serve it over HTTPS
next to your homeserver with these headers, so voice to text can use several CPU threads:
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`.
Don't cache `index.html`, `sw.js`, `manifest.webmanifest` or `config.json`.

`scripts/publish-pwa.sh` is one way to do it on a [Tailscale](https://tailscale.com) host: run in WSL
or Linux, it mirrors `dist-web` to `~/orrery-web/site`, runs `scripts/orrery-web-server.py` as the user
service `orrery-web.service` on `127.0.0.1:8089`, and adds one tailnet-only **Tailscale Serve** path,
`/orrery`. It never enables Funnel (public internet) and refuses to publish if Funnel is on. `--status`
shows the Serve config; `--remove` removes the path and stops the server.

### Configuration

`kind` is `hermes` (native Hermes formats), `orrery-v1` (agents speaking
[`dev.orrery.agent`](docs/AGENT-EVENTS.md)) or `matrix-bot` (plain chat). See
[config/README.md](config/README.md) for the full format.

---

## Design notes

### Why not a fork of Element Web?

Orrery is built on the same SDKs as Element — `matrix-js-sdk` plus the Matrix Rust crypto — rather than
as a fork:

1. **The product shape is different.** Element is a general team-chat client: room directory, spaces,
   widgets, calls, threads and admin UI run through a very large codebase. An agent workspace would mean
   replacing almost every screen while still carrying Element's structure.
2. **Maintenance cost.** A deep fork must be rebased on Element's frequent releases, with conflicts
   landing in the security-sensitive encryption and verification code. Using the SDK packages directly
   gets those fixes through a version bump.
3. **Security surface.** Orrery exposes less: no widgets, no iframes, no arbitrary HTML from agents. A
   small client with a strict CSP is easier to audit than a trimmed fork.

What is kept: the same encryption implementation (`@matrix-org/matrix-sdk-crypto-wasm`), cross-signing,
key backup, recovery keys and SAS emoji verification.

### Security model

- **Agent output is untrusted.** Markdown is rendered through `marked` and DOMPurify with a strict
  allowlist. Raw HTML from agents is escaped, and links are limited to http(s) and mailto, opened
  externally. A strict CSP is applied (no inline scripts, no frames, no plugins).
- **No privileged channel.** The UI can only send normal Matrix messages and reactions, and only on
  your click. Approvals are Hermes's own reactions, checked by Hermes. There is no shell, terminal or
  computer-use API in the client. Messages from other users are never treated as agent cards.
- **Secrets.** Nothing is stored in the source, logs or docs. On Windows the session token is
  DPAPI-sealed; in the browser it is sealed with a non-extractable AES-GCM key. The recovery key
  stays in memory only while it is being used.
- **Desktop shell.** The window is sandboxed, with context isolation and no Node in the renderer. The
  preload exposes only secret sealing, "open link externally" and update check/download/install; the
  page can't choose where updates come from. Navigation and new windows are blocked, and permissions
  are limited to microphone (audio only) and notifications.
- **Updates** come only from this repository's GitHub releases over HTTPS and are verified against
  the SHA-512 in `latest.yml` before installing.
- **Notifications** say which agent replied and in which conversation, never the message text.

### Layout

```
src/matrix/   session, secure storage, timeline model, actions, media, recovery
src/agents/   agent registry, Hermes adapter, task derivation, event types
src/voice/    dictation (AudioWorklet capture → on-device Whisper worker), text-to-speech
src/desktop/  in-app updates (desktop) and service-worker update checks (web)
src/ui/       React UI (workspace, chat, composer, model picker, panels, settings)
electron/     desktop shell (main, preload, updater)
config/       generic runtime config shipped in builds
scripts/      icons, model fetch, licenses, release, mock homeserver, PWA server/publisher, live harness
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Can't decrypt this message on this device yet" | Settings → Security → **Use recovery key** (or **Verify with another device**). The key backup then restores older keys. |
| Signed out with "this device was removed" | The device was deleted, e.g. from Element's session list. Sign in again, then verify. |
| "Can't reach the homeserver" | Check the address and your connection. If your server is on a private network or tailnet (e.g. Tailscale), that network must be on for this device, with its DNS enabled. |
| "Reconnecting to your homeserver…" banner | Network interruption. It retries automatically; **Retry now** forces it. |
| Model list missing a model | Add it to the agent's `extraModels` in `local/config.json` and rebuild the web app; it syncs to your other Orrery apps when you sign in there. |
| "Microphone access is blocked" | Allow the microphone for Orrery: on Android, in site settings; on Windows, in Privacy → Microphone. |
| Voice to text slow on the phone | Settings → Composer & voice to text → model **Tiny**. |
| Windows SmartScreen warning | The installer isn't code-signed yet. More info → Run anyway. |
| "Couldn't reach GitHub" in Settings → Updates | The update check needs internet access to github.com. Try again later; Orrery keeps working meanwhile. |
| Web app shows an old version | Settings → Updates → **Check now**, or close and reopen it. Settings → About shows the build time. |

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md) and `THIRD-PARTY-LICENSES.txt`.
