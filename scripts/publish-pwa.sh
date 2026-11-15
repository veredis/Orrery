#!/usr/bin/env bash
# Publish (or unpublish) the Orrery PWA at https://<your-tailnet-host>/orrery/ — run inside WSL.
#
#   bash publish-pwa.sh            copy dist-web, (re)start the local static server, add the /orrery Serve path
#   bash publish-pwa.sh --remove   remove the /orrery path and stop the static server (Matrix paths untouched)
#   bash publish-pwa.sh --status   show the server state and the current Serve config
#
# What it changes:
#   - ~/orrery-web/: the built PWA plus a small static server (scripts/orrery-web-server.py)
#   - a user service, orrery-web.service, serving those files on 127.0.0.1:$PORT only
#   - ONE extra Tailscale Serve path, /orrery, proxying to that loopback port
# Tailscale Serve is tailnet-only: just your own devices running Tailscale can open it.
# This script NEVER enables Funnel (public internet). If Funnel is on for the host it stops and
# says so, so that /orrery is never published publicly by accident; switching Funnel off belongs to
# whoever manages the Matrix network setup, not to this script.
# No credentials, no APIs, nothing from the browser executes on Onyx. It never runs
# `serve reset` and never touches the existing /_matrix/* and /.well-known paths.
# (Tailscale only lets root serve a folder directly, so the files go through a loopback proxy,
# like the Matrix paths do.)
set -euo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
TS_BIN="${TS_BIN:-$HOME/matrix/tailscale/tailscale}"
TS_SOCK="${TS_SOCK:-$XDG_RUNTIME_DIR/tailscaled-matrix.sock}"
PROJECT="${ORRERY_PROJECT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SRC="${ORRERY_DIST:-$PROJECT/dist-web}"
BASE="${ORRERY_WEB_DIR:-$HOME/orrery-web}"
DEST="$BASE/site"
PORT="${ORRERY_WEB_PORT:-8089}"
UNIT="orrery-web.service"
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
ts() { "$TS_BIN" --socket="$TS_SOCK" "$@"; }

# Prints the host:port entries that have Funnel (public access) switched on; empty when none.
funnel_on() {
    ts serve status --json 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
cfg = json.loads(raw) if raw else {}
print(" ".join(k for k, v in (cfg.get("AllowFunnel") or {}).items() if v))'
}

case "${1:-}" in
--status)
    systemctl --user --no-pager status "$UNIT" 2>/dev/null | head -5 || true
    ts serve status
    on="$(funnel_on)" || { echo "Could not read the Tailscale Serve config; is tailscaled-matrix running?" >&2; exit 1; }
    [ -n "$on" ] && echo "WARNING: Funnel (public internet) is ON for: $on"
    exit 0
    ;;
--remove)
    on="$(funnel_on)" || { echo "Could not read the Tailscale Serve config; is tailscaled-matrix running?" >&2; exit 1; }
    if [ -n "$on" ]; then
        # Funnel is on: remove only the /orrery handler, leaving the Funnel switch as it is.
        echo "Note: Funnel is ON for $on; removing /orrery without changing that." >&2
        ts funnel --https=443 --set-path=/orrery off || true
    else
        ts serve --https=443 --set-path=/orrery off || true
    fi
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    echo "Removed /orrery and stopped $UNIT. Remaining Serve config:"
    ts serve status
    exit 0
    ;;
esac

on="$(funnel_on)" || { echo "Could not read the Tailscale Serve config; is tailscaled-matrix running?" >&2; exit 1; }
if [ -n "$on" ]; then
    echo "Funnel (public internet access) is ON for: $on" >&2
    echo "Not publishing: /orrery would be reachable from the public internet. This script never" >&2
    echo "toggles Funnel; switch the host to tailnet-only Serve first, then run it again." >&2
    exit 2
fi

[ -f "$SRC/index.html" ] || { echo "No build at $SRC — run 'npm run build:web' in the Orrery project first." >&2; exit 1; }
grep -q '/orrery/' "$SRC/index.html" || { echo "$SRC was not built for /orrery/ (use npm run build:web)." >&2; exit 1; }
if ss -ltn "sport = :$PORT" | grep -q LISTEN && ! systemctl --user is-active --quiet "$UNIT"; then
    echo "Port $PORT is already used by something else; set ORRERY_WEB_PORT." >&2
    exit 1
fi

mkdir -p "$DEST" "$(dirname "$UNIT_FILE")"
# Mirror the build; --delete removes files from older versions.
if command -v rsync >/dev/null; then
    rsync -a --delete "$SRC/" "$DEST/"
else
    rm -rf "$DEST.tmp" && cp -a "$SRC" "$DEST.tmp" && rm -rf "$DEST" && mv "$DEST.tmp" "$DEST"
fi
install -m 0644 "$PROJECT/scripts/orrery-web-server.py" "$BASE/server.py"
chmod -R go-w "$BASE"

cat >"$UNIT_FILE" <<EOF
[Unit]
Description=Orrery PWA static files (loopback only, behind tailnet-only Serve /orrery)

[Service]
ExecStart=/usr/bin/python3 $BASE/server.py --root $DEST --port $PORT
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null 2>&1
systemctl --user restart "$UNIT"
for _ in $(seq 1 20); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/orrery/" && break; sleep 0.25; done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/orrery/" || { echo "Static server did not start; see: journalctl --user -u $UNIT" >&2; exit 1; }

ts serve --bg --yes --set-path=/orrery "http://127.0.0.1:$PORT/orrery"
echo
ts serve status
HOST="$(ts status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
echo
echo "Orrery PWA: https://${HOST:-<your-host>}/orrery/"
echo "Undo with:  bash $0 --remove"
