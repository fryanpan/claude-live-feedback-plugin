#!/usr/bin/env bash
# Install the claude-workspaces server as a launchd-managed service.
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

LABEL="com.fryanpan.claude-workspaces"
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

# wait_for_bootout + bootstrap_with_retry. Kept in a separate file so tests can
# drive them against a stub launchctl; see the header there for the outage that
# put them in.
# shellcheck source=scripts/launchd/bootstrap-retry.sh
. "${SCRIPT_DIR}/bootstrap-retry.sh"

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

# The external origin the server should build its human-facing links on, when
# something in front of it terminates TLS. Baked into the plist at install
# time because launchd agents inherit no shell environment.
#
#   CW_PUBLIC_BASE_URL=https://<host> scripts/launchd/install.sh
#
# Empty (the default) keeps the current behaviour exactly: links are built
# from the discovered hostname and the listening port, over plain http.
# Re-running the installer without it therefore REVERTS the setting, which is
# the intended rollback path — see docs/process/tailnet-https.md.
# Dual-read so a shell or a runbook still holding the old spelling keeps
# working; the new name wins when both are set.
PUBLIC_BASE_URL="${CW_PUBLIC_BASE_URL:-${LF_PUBLIC_BASE_URL:-}}"

# Link-mode sharing hostname, same contract as the base URL: baked into the
# plist because launchd inherits no shell environment, and empty (the default)
# keeps link mode off. Re-running the installer without it reverts sharing —
# which is exactly what happened at the claude-workspaces rename, so pass it
# every time on a deployment that shares.
SHARE_PUBLIC_HOSTNAME="${CF_SHARE_PUBLIC_HOSTNAME:-}"

# Collaboration hostnames reachable from outside the tailnet: served through
# the tunnel, gated by a Cloudflare Access application over each hostname, and
# scoped to the share surface rather than the privileged one. Same contract as
# the two above — baked into the plist, empty by default, and re-running the
# installer without them reverts the setting.
#
#   CF_ACCESS_TUNNEL_HOSTS=workspaces.example.com \
#   CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com \
#   CF_ACCESS_AUD=<the Access application's AUD tag> \
#     scripts/launchd/install.sh
#
# All three or none: the server IGNORES the host list unless the team domain
# and the AUD are both set, because a listed hostname with no Access
# application in front of it would be the API exposed to the tunnel. The
# installer says so rather than leaving it to be discovered as a 403.
ACCESS_TUNNEL_HOSTS="${CF_ACCESS_TUNNEL_HOSTS:-}"
ACCESS_TEAM_DOMAIN="${CF_ACCESS_TEAM_DOMAIN:-}"
ACCESS_AUD="${CF_ACCESS_AUD:-}"
if [ -n "${ACCESS_TUNNEL_HOSTS}" ] && { [ -z "${ACCESS_TEAM_DOMAIN}" ] || [ -z "${ACCESS_AUD}" ]; }; then
    echo "error: CF_ACCESS_TUNNEL_HOSTS needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD too." >&2
    echo "       Without an Access application in front of those hostnames the server" >&2
    echo "       would serve them to anyone who can reach the tunnel, so it refuses to" >&2
    echo "       honour the list — they would answer 403. Set all three, or none." >&2
    exit 1
fi

# The operator's OWN public hostnames: through the tunnel, behind an Access
# application, and then the whole product — not the share surface. A third
# list, separate from TRUSTED_HOSTS and from the collaboration list above,
# because it grants the most. Same contract: baked into the plist, empty by
# default, reverted by a reinstall without it, and the same all-or-none rule
# with the team domain and the AUD. Dual-read like the base URL — the domain
# plan spells it `LF_`; the new name wins when both are set.
#
#   CW_PROXIED_TRUSTED_HOSTS=workspaces.example.com \
#   CF_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com \
#   CF_ACCESS_AUD=<the Access application's AUD tag> \
#     scripts/launchd/install.sh
PROXIED_TRUSTED_HOSTS="${CW_PROXIED_TRUSTED_HOSTS:-${LF_PROXIED_TRUSTED_HOSTS:-}}"
if [ -n "${PROXIED_TRUSTED_HOSTS}" ] && { [ -z "${ACCESS_TEAM_DOMAIN}" ] || [ -z "${ACCESS_AUD}" ]; }; then
    echo "error: CW_PROXIED_TRUSTED_HOSTS needs CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD too." >&2
    echo "       Without an Access application in front of those hostnames the server" >&2
    echo "       would serve the WHOLE product to anyone who can reach the tunnel, so it" >&2
    echo "       refuses to honour the list — they would answer 403. Set all three, or none." >&2
    exit 1
fi

echo "[install] label:    ${LABEL}"
echo "[install] repo:     ${REPO_DIR}"
echo "[install] bun:      ${BUN_BIN}"
echo "[install] plist:    ${PLIST_DEST}"
echo "[install] logs:     ${LOG_DIR}/${LABEL}.{out,err}.log"
echo "[install] links:    ${PUBLIC_BASE_URL:-<discovered host>:<port> over http}"
echo "[install] sharing:  ${SHARE_PUBLIC_HOSTNAME:-<link mode off>}"
echo "[install] collab:   ${ACCESS_TUNNEL_HOSTS:-<off>}"
echo "[install] operator: ${PROXIED_TRUSTED_HOSTS:-<off>}"

DOMAIN="gui/$(id -u)"

# Stop and remove any existing instance so re-running is idempotent.
if "${LAUNCHCTL}" print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "[install] existing service found — bootout first"
    "${LAUNCHCTL}" bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
    # The bootout returns before launchd has finished with the job, and
    # bootstrapping into that gap is what produced the 2026-08-17 outage.
    wait_for_bootout "${DOMAIN}/${LABEL}"
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
    -e "s|{{PUBLIC_BASE_URL}}|${PUBLIC_BASE_URL}|g" \
    -e "s|{{SHARE_PUBLIC_HOSTNAME}}|${SHARE_PUBLIC_HOSTNAME}|g" \
    -e "s|{{ACCESS_TUNNEL_HOSTS}}|${ACCESS_TUNNEL_HOSTS}|g" \
    -e "s|{{PROXIED_TRUSTED_HOSTS}}|${PROXIED_TRUSTED_HOSTS}|g" \
    -e "s|{{ACCESS_TEAM_DOMAIN}}|${ACCESS_TEAM_DOMAIN}|g" \
    -e "s|{{ACCESS_AUD}}|${ACCESS_AUD}|g" \
    "${TEMPLATE}" > "${PLIST_DEST}"

if ! bootstrap_with_retry "${DOMAIN}" "${PLIST_DEST}"; then
    exit 3
fi

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
