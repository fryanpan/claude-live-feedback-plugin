---
allowed-tools: Bash(curl *)
description: List open comment threads on a live-feedback doc
argument-hint: [docId]
---

## Context

- Running feedback server port: !`/usr/bin/lsof -iTCP -sTCP:LISTEN 2>/dev/null | /usr/bin/grep -E "bun" | /usr/bin/head -3`
- Threads: !`/usr/bin/curl -s "http://127.0.0.1:${FEEDBACK_PORT:-8787}/api/docs/${1:-default}/threads?status=open"`

## Your task

Summarize any open threads on the doc `$1` (default `default`). For each
thread, print:

- Thread ID
- Author + created-at
- Anchor snippet (the text or element that was commented on)
- Comments in order, each with author + body

If there are no open threads, say so. If the server isn't running, tell
the user to run `/feedback-serve` first.
