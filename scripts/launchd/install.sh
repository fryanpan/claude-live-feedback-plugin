#!/usr/bin/env bash
# Install the live-feedback server as a launchd-managed service.
#
# Runs as a per-user LaunchAgent (loads on login, not at boot). Survives
# Claude Code session restarts, terminal logout, and Mac reboot. Auto-restarts
# on crash. Run once per machine.
#
# Uninstall with scripts/launchd/uninstall.sh.

set -euo pipefail

LABEL="com.fryanpan.live-feedback"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATE="${SCRIPT_DIR}/${LABEL}.plist.template"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"

# Resolve bun: prefer ~/.bun/bin/bun (the official installer's path), fall back
# to PATH, fail loudly if neither works. launchd does NOT run login shells, so
# relying on a PATH that only your shell config sets up will leave the service
# unable to find bun.
if [ -x "${HOME}/.bun/bin/bun" ]; then
    BUN_BIN="${HOME}/.bun/bin/bun"
elif command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
else
    echo "error: bun not found. Install from https://bun.sh first." >&2
    exit 1
fi
BUN_DIR="$(dirname "${BUN_BIN}")"

echo "[install] label:    ${LABEL}"
echo "[install] repo:     ${REPO_DIR}"
echo "[install] bun:      ${BUN_BIN}"
echo "[install] plist:    ${PLIST_DEST}"
echo "[install] logs:     ${LOG_DIR}/${LABEL}.{out,err}.log"

DOMAIN="gui/$(id -u)"

# Stop and remove any existing instance so re-running is idempotent.
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "[install] existing service found — bootout first"
    launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
fi

# Stop any foreground server squatting on the port. The supervised instance
# needs to be the one binding 8788. macOS BSD xargs doesn't support -r, so
# guard on a non-empty PID list before invoking kill.
kill_port_8788() {
    local sig="$1"
    local pids
    pids="$(lsof -nP -ti:8788 -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "${pids}" ]; then
        # shellcheck disable=SC2086
        kill -"${sig}" ${pids} 2>/dev/null || true
        return 0
    fi
    return 1
}

if lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[install] killing foreground server on :8788"
    kill_port_8788 TERM || true
    # Poll up to 5s for the port to free up before escalating to KILL.
    for _ in 1 2 3 4 5; do
        if ! lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    if lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1; then
        kill_port_8788 KILL || true
        sleep 1
    fi
fi

mkdir -p "$(dirname "${PLIST_DEST}")" "${LOG_DIR}"

# Substitute placeholders. Use a delimiter unlikely to appear in paths.
sed \
    -e "s|{{REPO_DIR}}|${REPO_DIR}|g" \
    -e "s|{{BUN_BIN}}|${BUN_BIN}|g" \
    -e "s|{{BUN_DIR}}|${BUN_DIR}|g" \
    -e "s|{{HOME_DIR}}|${HOME}|g" \
    -e "s|{{LOG_DIR}}|${LOG_DIR}|g" \
    "${TEMPLATE}" > "${PLIST_DEST}"

launchctl bootstrap "${DOMAIN}" "${PLIST_DEST}"

# Wait up to 15s for the service to start listening so the install reports the
# right state. The serve.ts supervisor binds the port within a few seconds in
# the normal case; longer means something's wrong.
echo -n "[install] waiting for :8788"
for i in $(seq 1 15); do
    if lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1; then
        echo " — up"
        break
    fi
    echo -n "."
    sleep 1
done

if ! lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1; then
    echo
    echo "[install] WARNING: port 8788 not listening after 15s."
    echo "[install] check logs: tail -f ${LOG_DIR}/${LABEL}.err.log"
    exit 2
fi

echo "[install] supervised PID: $(lsof -nP -ti:8788 -sTCP:LISTEN | head -n1)"
echo "[install] done. Verify: curl -sS http://localhost:8788/ -o /dev/null -w '%{http_code}\\n'"
