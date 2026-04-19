#!/usr/bin/env bash
# One-time setup for a Cloudflare named tunnel under your own domain.
# After this runs, every `scripts/register-preview.ts` invocation gets a
# stable subdomain like `abc123.tunnel.yourdomain.com` — no more random
# trycloudflare URLs per session.
#
# You need:
#   - A domain on Cloudflare (e.g. fryanpan.com)
#   - cloudflared installed + authenticated (`cloudflared tunnel login`)
#
# Example:
#   ./scripts/setup-named-tunnel.sh tunnel.fryanpan.com
#
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "usage: $0 <base-domain>    e.g. tunnel.fryanpan.com"
  exit 1
fi

BASE="$1"
TUNNEL_NAME="live-feedback"
LIVE_DIR="$HOME/.live-feedback"
CONFIG="$LIVE_DIR/config.json"

mkdir -p "$LIVE_DIR"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. On macOS: brew install cloudflared"
  exit 1
fi

if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "You need to run 'cloudflared tunnel login' first (opens browser)."
  exit 1
fi

# Idempotent: if a tunnel with this name already exists, reuse it.
TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1; exit}')"
if [ -z "$TUNNEL_ID" ]; then
  echo "Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$(cloudflared tunnel list | awk -v n="$TUNNEL_NAME" '$2==n {print $1; exit}')"
fi
echo "Tunnel ID: $TUNNEL_ID"

# Route DNS for the base wildcard. You also need a manual step in the
# Cloudflare dashboard to create the wildcard CNAME (script handles it
# if cloudflared's DNS API has the zone).
echo "Routing DNS for *.$BASE → $TUNNEL_ID.cfargotunnel.com ..."
set +e
cloudflared tunnel route dns "$TUNNEL_NAME" "*.$BASE"
set -e

# Write config file
CF_CONFIG="$HOME/.cloudflared/$TUNNEL_NAME.yml"
cat > "$CF_CONFIG" <<EOF
tunnel: $TUNNEL_NAME
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: "*.$BASE"
    service: http://localhost:9900
    originRequest:
      disableChunkedEncoding: false
      noHappyEyeballs: true
      connectTimeout: 30s
  - service: http_status:404
EOF
echo "Wrote cloudflared config: $CF_CONFIG"

# Record the user's base domain for register-preview.ts to read
cat > "$CONFIG" <<EOF
{
  "baseDomain": "$BASE",
  "tunnelName": "$TUNNEL_NAME",
  "tunnelId": "$TUNNEL_ID",
  "routerPort": 9900
}
EOF
echo "Wrote user config: $CONFIG"

cat <<'DONE'

Setup done. Two processes need to run on this machine:

  1. The router (reverse-proxies *.tunnel.<base> → the right local port)
       bun run packages/router/src/router.ts

  2. The Cloudflare tunnel (sends the internet → the router)
       cloudflared tunnel --config ~/.cloudflared/live-feedback.yml run

Start both (tmux / pm2 / launchctl — your choice), then for each
feedback session:

       bun run scripts/register-preview.ts

and you'll get a stable https://<slug>.<your-base>/ URL.

Add "<your-base>" to .claude/live-feedback.json trustedPreviewDomains
so claude-in-chrome navigate goes through without per-URL prompts.
DONE
