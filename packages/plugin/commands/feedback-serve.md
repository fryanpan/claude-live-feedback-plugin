---
allowed-tools: Bash(bun run *), Bash(cd *), Bash(pgrep *), Bash(kill *)
description: Start the live-feedback server (with a Cloudflare quick tunnel) for this project
---

## Context

- Repo root: !`/bin/pwd`
- Server already running? !`/usr/bin/pgrep -fl "packages/server/src/bin.ts" | /usr/bin/head -3 || echo "no"`
- Existing tunnel? !`/usr/bin/pgrep -fl "cloudflared tunnel --url" | /usr/bin/head -1 || echo "no"`

## Your task

Start the live-feedback server with a throwaway Cloudflare quick tunnel so
the user can share the URL with teammates or open in their phone browser.

Run `bun run scripts/start-tunneled.ts` in the background and watch its
log for the `https://<random>.trycloudflare.com` URL. Print the three
canonical routes:

```
 Markdown review:   <url>/review/<docId>?as=bryan
 Demo mockup:       <url>/demos/mockup
 Widget bundle:     <url>/widget.iife.js
```

If the server is already running on a port, don't start a new one —
just print the existing URL. If a `.claude/live-feedback.json` in this
project lists a tunnel domain (e.g. `tunnel.fryanpan.com`) and the user
has the stable-tunnel setup, prefer that over a quick tunnel.

## Notes

- If `cloudflared` is not installed, tell the user: `brew install cloudflared`.
- If the port is in use, the server auto-picks the next free one.
- Stop everything with: `kill $(pgrep -f 'packages/server/src/bin.ts') $(pgrep -f 'cloudflared tunnel --url')`
