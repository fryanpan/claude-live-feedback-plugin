#!/usr/bin/env bash
# Install the live-feedback server as a launchd-managed service.
#
# Runs as a per-user LaunchAgent (loads on login, not at boot). Survives
# Claude Code session restarts, terminal logout, and Mac reboot. Auto-restarts
# on crash. Run once per machine.
#
# Uninstall with scripts/launchd/uninstall.sh.

set -euo pipefail

# /usr/sbin for lsof. Without it, the foreground-kill step silently no-ops
# because BSD lsof lives at /usr/sbin/lsof, not /usr/bin/lsof.
PATH="/usr/bin:/bin:/usr/sbin:${PATH:-}"

LABEL="com.fryanpan.live-feedback"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# `pwd -P` resolves through symlinks. macOS launchd processes given a
# symlinked WorkingDirectory can wedge in `getcwd()` walking parent inodes
# across a non-default /Volumes mount — observed via `sample` showing the
# parent bun stuck in __getcwd → open$NOCANCEL for the full sample window,
# never reaching `pickFreePort` or `spawn`. Pass the real path so the
# child process can `getcwd()` cleanly.
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
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
# needs to be the one binding 8787. macOS BSD xargs doesn't support -r, so
# guard on a non-empty PID list before invoking kill.
kill_port_8787() {
    local sig="$1"
    local pids
    pids="$(lsof -nP -ti:8787 -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "${pids}" ]; then
        # shellcheck disable=SC2086
        kill -"${sig}" ${pids} 2>/dev/null || true
        return 0
    fi
    return 1
}

if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[install] killing foreground server on :8787"
    kill_port_8787 TERM || true
    # Poll up to 5s for the port to free up before escalating to KILL.
    for _ in 1 2 3 4 5; do
        if ! lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
        kill_port_8787 KILL || true
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
echo -n "[install] waiting for :8787"
for i in $(seq 1 15); do
    if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
        echo " — up"
        break
    fi
    echo -n "."
    sleep 1
done

if ! lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
    echo
    echo "[install] WARNING: port 8787 not listening after 15s."

    # Diagnose: a launchd-spawned process that can't read the repo CWD (e.g.,
    # if the repo lives under /Volumes/<something>/ and bun doesn't have Full
    # Disk Access) wedges in getcwd() with EPERM. The symptom is empty
    # stdout/stderr logs because bun never reaches console.log.
    if [ -z "$(cat "${LOG_DIR}/${LABEL}.out.log" 2>/dev/null)" ] &&
       [ -z "$(cat "${LOG_DIR}/${LABEL}.err.log" 2>/dev/null)" ]; then
        case "${REPO_DIR}" in
            /Volumes/*)
                echo "[install]"
                echo "[install] Empty logs + repo under /Volumes/ — looks like TCC is blocking"
                echo "[install] the launchd-spawned bun from reading the repo. Grant Full Disk"
                echo "[install] Access to bun:"
                echo "[install]"
                echo "[install]   System Settings → Privacy & Security → Full Disk Access → '+' →"
                echo "[install]   ${BUN_BIN}"
                echo "[install]"
                echo "[install] Then re-run this script. Background: shell-spawned processes"
                echo "[install] inherit Terminal's TCC scope; launchd-spawned ones start fresh."
                ;;
            *)
                echo "[install] check logs: tail -f ${LOG_DIR}/${LABEL}.err.log"
                ;;
        esac
    else
        echo "[install] check logs: tail -f ${LOG_DIR}/${LABEL}.err.log"
    fi
    exit 2
fi

echo "[install] supervised PID: $(lsof -nP -ti:8787 -sTCP:LISTEN | head -n1)"
echo "[install] done. Verify: curl -sS http://localhost:8787/ -o /dev/null -w '%{http_code}\\n'"
