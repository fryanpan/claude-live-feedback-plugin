#!/usr/bin/env bash
# Stop and remove the claude-workspaces launchd service.

set -euo pipefail

LABEL="com.fryanpan.claude-workspaces"
DOMAIN="gui/$(id -u)"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [ ! -f "${PLIST_DEST}" ]; then
    echo "[uninstall] plist not present at ${PLIST_DEST} — nothing to do."
    exit 0
fi

echo "[uninstall] bootout ${DOMAIN}/${LABEL}"
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true

echo "[uninstall] removing ${PLIST_DEST}"
rm -f "${PLIST_DEST}"

echo "[uninstall] done. Logs preserved at ${HOME}/Library/Logs/${LABEL}.{out,err}.log"
