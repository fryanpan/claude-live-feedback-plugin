---
allowed-tools: Bash(bun run *), Bash(pgrep *), Bash(lsof *)
description: Start the live-feedback server; prints localhost / tailscale / LAN URLs
---

## Context

- Running server? !`/usr/bin/pgrep -fl "packages/server/src/bin.ts" | /usr/bin/head -3 || echo "no"`

## Your task

Start the feedback server via `bun run scripts/serve.ts`. The script:

1. Picks a free port (default start 8787).
2. Spawns the feedback server as a child process.
3. Prints three URL forms so the user can pick whichever reaches their
   device:
   - `http://localhost:<port>` — this machine only
   - `http://<tailscale-host>:<port>` — for anyone on the tailnet
   - `http://<lan-host>.local:<port>` — for anyone on the same wifi

This project intentionally does **not** use a public tunnel. Reviews
happen over Tailscale or the local network. Private by default.

After starting, suggest the user try:

```
http://<tailscale-or-lan-host>:<port>/review/<docId>?as=bryan
```

For a simulated phone viewport on a desktop browser, append
`&mobile=iphone16pm`.
