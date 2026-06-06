#!/usr/bin/env bash
# Install the daily live-feedback doc-triage job as a launchd LaunchAgent.
#
# Fires once a day (09:00 local by default — edit the plist template's
# StartCalendarInterval and re-run) and spawns a headless Claude run that pings
# each owning agent about its review docs idle >24h. It only ASKS owners to
# clean up — it never deletes docs itself.
#
# Idempotent: re-run after editing the template or the prompt. Uninstall with:
#   launchctl bootout gui/$(id -u)/com.fryanpan.doc-triage
set -euo pipefail

PATH="/usr/bin:/bin:/usr/sbin:${PATH:-}"

LABEL="com.fryanpan.doc-triage"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
TEMPLATE="${SCRIPT_DIR}/${LABEL}.plist.template"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"

# Resolve the claude CLI. launchd doesn't run a login shell, so we need an
# absolute path. ~/.local/bin/claude is the official installer's location.
if [ -x "${HOME}/.local/bin/claude" ]; then
    CLAUDE_BIN="${HOME}/.local/bin/claude"
elif command -v claude >/dev/null 2>&1; then
    CLAUDE_BIN="$(command -v claude)"
else
    echo "error: claude CLI not found (looked in ~/.local/bin and PATH)." >&2
    exit 1
fi
CLAUDE_DIR="$(dirname "${CLAUDE_BIN}")"

echo "[install-triage] label:  ${LABEL}"
echo "[install-triage] repo:   ${REPO_DIR}"
echo "[install-triage] claude: ${CLAUDE_BIN}"
echo "[install-triage] plist:  ${PLIST_DEST}"

DOMAIN="gui/$(id -u)"

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "[install-triage] existing job found — bootout first"
    launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
fi

mkdir -p "$(dirname "${PLIST_DEST}")" "${LOG_DIR}"

sed \
    -e "s|{{REPO_DIR}}|${REPO_DIR}|g" \
    -e "s|{{CLAUDE_BIN}}|${CLAUDE_BIN}|g" \
    -e "s|{{CLAUDE_DIR}}|${CLAUDE_DIR}|g" \
    -e "s|{{HOME_DIR}}|${HOME}|g" \
    -e "s|{{LOG_DIR}}|${LOG_DIR}|g" \
    "${TEMPLATE}" > "${PLIST_DEST}"

launchctl bootstrap "${DOMAIN}" "${PLIST_DEST}"

echo "[install-triage] loaded. Next fire: 09:00 local (per StartCalendarInterval)."
echo "[install-triage] Run now to test:  launchctl kickstart -k ${DOMAIN}/${LABEL}"
echo "[install-triage] Logs: ${LOG_DIR}/${LABEL}.{out,err}.log"
echo "[install-triage] Uninstall: launchctl bootout ${DOMAIN}/${LABEL}"
