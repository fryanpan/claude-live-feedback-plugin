# Plan: Doc lifecycle — owner tracking + daily stale-doc triage

## Goal

Stop obsolete review docs from piling up (177 had accumulated). Most docs
live ~30 min then become obsolete; occasionally one waits multiple days on
Bryan. So we don't auto-delete on a timer — we **ask the owning agent once a
day** which of its idle-open docs to keep, and it `delete_doc`s the rest.

Decided with Bryan 2026-06-06: target = **owning agent via claude-hive**;
idle threshold **>24h**; daily cadence.

## Measurable outcomes

- [x] `delete_doc` exists with an open-thread guardrail (PR #48, shipped).
- [ ] Every doc records its **owner** (creating agent) and **lastActivityAt**.
- [ ] `list_docs` returns owner + lastActivityAt.
- [ ] A daily job messages each owning agent its docs idle >24h, asking which
      to keep; unowned/unreachable docs fall back to a digest to Bryan.

## Key finding (verified)

The live-feedback MCP child's `process.cwd()` is the agent's project dir
(confirmed: job-search, ai-team-lead, personal-crm, writing-assistant). That
is exactly how claude-hive keys peers (`from_cwd`). So **owner = cwd** maps
directly to a live peer via `list_peers` — no per-agent config needed.
(`.mcp.json` hardcodes `FEEDBACK_AUTHOR: "agent"` for everyone, so author
identity can't distinguish owners; cwd can.)

## Increment 1 — Foundation (server + MCP)  ← this PR

- `DocMeta`: add `owner?: string` (cwd) + `lastActivityAt?: number`.
- `getOrCreate`: set `owner` from init; init `lastActivityAt = createdAt`.
- `wireEvents`: bump `lastActivityAt` on prose updates; thread create/reply
  also bumps it.
- `list()` / `GET /api/docs`: include both fields.
- `POST /api/docs` accepts `owner`.
- MCP `create_review_doc` + `bind_mock`: pass `owner: process.cwd()`.
- Tests: owner round-trips; lastActivityAt advances on edit.

## Increment 2 — Daily triage agent (SHIPPED)

Built as a **local launchd job** (`com.fryanpan.doc-triage`, fires 09:00 daily)
that runs `scripts/triage/run-doc-triage.sh` → a headless `claude -p` with the
claude-hive channel. Cloud routines can't reach `localhost:8787` or the local
claude-hive network, so it must run on the Mac Mini. Verified headless
`claude -p --dangerously-load-development-channels server:claude-hive` reaches
claude-hive. Install with `scripts/launchd/install-triage.sh`. The triage logic
lives in `scripts/triage/doc-triage-prompt.md`; it only ASKS owners, never
deletes. Dry-run confirmed idle detection, owner grouping, peer/conductor
lookup, and the orphan→conductor-digest fallback all work.

**Future enhancement (noted, not built):** when `owner` is absent (legacy
docs), fall back to the doc's `sourceUrl` project/git-root to find the owning
peer, instead of going straight to the conductor digest. The dry-run showed a
legacy doc whose `sourceUrl` lived in a project with live peers — it could have
routed as an owner-ping. New docs carry `owner`, so this only helps the legacy
tail.

### Original design notes

A daily scheduled agent (via the `schedule` skill / cron):
1. `GET /api/docs`; select docs with `now - lastActivityAt > 24h`.
2. Group by `owner` (cwd). `mcp__claude-hive__list_peers(machine)`; match
   `owner` → peer `cwd`; `send_message(to_stable_id, ...)`:
   "These docs you created are idle >24h: [...]. Reply which to keep; I'll
   `delete_doc` the rest (open-thread ones are skipped unless you force)."
3. Fallback — owner unknown, or no live peer matches → one digest message to
   Bryan/the conductor listing the orphans.

### Open items for increment 2 (resolve before building)

- **Does a scheduled/cron run have claude-hive?** The system note warns
  interactively-authenticated MCP servers may be absent in headless runs.
  If absent, the job can't `send_message` → fall back to the Bryan digest as
  the primary path, or run the job inside a persistent session instead of
  cron. Verify first.
- **Cadence/time-of-day** for the daily run — Bryan's call.
- A doc whose owner agent has permanently ended: digest to Bryan.

## Risk notes

- Owner is best-effort (cwd at create time); legacy docs have none → digest
  fallback. Reversible.
- Never auto-delete in increment 2 — always ask. `delete_doc`'s open-thread
  guardrail is the backstop.
