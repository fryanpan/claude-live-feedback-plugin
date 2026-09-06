---
allowed-tools: Bash(curl *)
description: List open comment threads on a claude-workspaces doc
argument-hint: [docId] [workspaceId]
---

## Context

- Running feedback server port: !`/usr/bin/lsof -iTCP -sTCP:LISTEN 2>/dev/null | /usr/bin/grep -E "bun" | /usr/bin/head -3`
- Threads: !`/usr/bin/curl -s "http://127.0.0.1:${FEEDBACK_PORT:-8787}/workspaces/${2:-default}/docs/${1:-default}/threads?status=open"`

## Your task

Summarize any open threads on the doc `$1` under the board `$2`. A doc is
addressed under the board that owns it, so both are needed — `get_workspace`
names the board this session is attached to. For each
thread, print:

- Thread ID
- Author + created-at
- Anchor snippet (the text or element that was commented on)
- Comments in order, each with author + body

If there are no open threads, say so. If the server isn't running, tell
the user to run `/feedback-serve` first.
