# Project: claude-workspaces-plugin

Make giving feedback to LLM agents as fast as pointing and saying "this" —
real-time iteration across three review surfaces: markdown + diagrams, UX
mockups, and live dev servers, with comment threads that survive edits. Read
[docs/product/vision.md](docs/product/vision.md) before non-trivial work.

**Stack:** TypeScript + Bun server; Cloudflare Tunnel; the injectable widget
is vanilla JS / web components only (no framework deps — it must not conflict
with host sites); agent integration is MCP tools + HTTP webhooks. TypeScript
strict mode. Widget bundle size is a hard constraint — measure and report it
on every PR that touches widget code.

## Architecture summaries — linked, never inlined

Start at [overview](docs/architecture/overview.md) — the packages, the layers
inside each and which way imports may point, plus the main data flows. Read it
before non-trivial work.

Per-subsystem summaries live in [docs/architecture/](docs/architecture/):
[meeting-assistant](docs/architecture/meeting-assistant.md) (live
transcription + notes on a pause-or-cadence clock),
[stall-detection](docs/architecture/stall-detection.md) (board wakes and
their economics),
[goal-projection](docs/architecture/goal-projection.md) (the goal bar, the
remainder, and when a goal lands) and
[security](docs/architecture/security.md) (trust boundaries, the gates that
enforce them, where secrets live, the deploy and webhook surfaces). Read the
relevant one before touching its subsystem.
Deliberately not `@`-imported — they cost no context until needed; keep it
that way and add new subsystem docs to the list here.

## Conventions

- Lead with goals, not implementation, in top-level docs.
- Public repo, branch protection on main — all changes via PR.
- **Never hard delete user content — soft delete** (Bryan, 2026-08-17,
  project-wide). The `.ydoc` is the durable record analyses are rebuilt from.
  Use `archive_review` / `archive_doc` (reversible); `delete_doc` and
  `purge:true` destroy — calling them is a decision, never a default.
  Transient files (old releases, `.tmp`) are correctly hard-deleted.
  Mechanics and which verb does what: grep learnings.md "Soft delete".
- When narrowing an existing verb, keep accepting the old payload if a caller
  exists that you cannot restart — the shared server's REST routes. Bryan
  waived compatibility shims for prototype-phase surfaces (2026-08-18).
- **Don't append CSS at EOF of `packages/markdown-app/src/styles.css`** — put
  rules in the `/* ===== SECTION ===== */` banner they belong to, and inside
  the half-file WORKSPACE HUB banner in the per-surface
  `/* ##### HUB · … ##### */` sub-banner that names it
  (`grep -n '##### HUB' packages/markdown-app/src/styles.css` lists them);
  parallel branches that both append at EOF conflict every time.
- **Edit Bryan's bound docs directly; don't default to `suggest: true`.**
  Concurrent editing is the norm; reserve suggestions for judgment calls.
- **Verify UI at 1180x820 (iPad landscape — Bryan's main device) AND 430px**
  per [docs/product/design-mobile.md](docs/product/design-mobile.md). Tiers:
  mobile ≤1100, tablet/laptop 1101–1920 (iPad and MacBook alike — the scarce
  axis there is HEIGHT, ~750px usable), 4K above. Width cannot identify a
  device (zoom moves it): per-device truth goes in a stored preference, never
  a media query. Grep learnings.md "zoom" for the measured failures.
- PR after each task is done; a cohesive feature is ONE PR with ordered
  commits, not a fragment per file.
- **Mockups and sketches never enter the repo** — write the HTML outside the
  working tree and serve it with `bind_mock(docId, sourceHtmlPath)`.

## The four gates — run all of them before you push

```bash
bunx vitest run                 # unit + client suites
bun test packages/server/test   # server suite (NOT covered by vitest)
bun run typecheck               # tsc --noEmit; vitest does not typecheck
bun run lint                    # biome; nothing else formats
```

Four separate gates; each catches what the others cannot — read this list,
don't recite it from memory. What a test has to do to be worth its runtime —
behaviour not source shape, poll-until not sleep, no wall-clock assertions —
is [.claude/rules/testing-standards.md](.claude/rules/testing-standards.md),
whose mechanical half is `bun run test:audit` (ratcheted, runs in CI).
`bunx biome check --write` fixes formatting; pre-existing `noExplicitAny`
warnings stay. Per diff: `packages/mcp/src/**` → `bun run build:mcp` + commit
the bundle; `packages/plugin/**` → version bump (below); touching neither
adds nothing.

## Releasing the plugin

The full delivery model is [docs/process/delivery.md](docs/process/delivery.md)
— read it before answering "why doesn't my peer / my browser have this yet".

- Diff touches `packages/plugin/**` → bump the patch in THREE places, same
  value: `packages/plugin/.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, and `PLUGIN_VERSION` in
  `packages/mcp/src/mcp.ts` (the handshake literal — the site that actually
  drifts; asserted by launcher.test.ts only after `bun run build:mcp`).
- **Bump nothing when the diff touches neither `packages/plugin/**` nor
  `packages/mcp/src/**`** — a needless bump manufactures a total merge order
  across unrelated branches.
- CI: `check:plugin-version` fails a plugin PR that doesn't move the version
  past origin/main, and checks other open PRs for the same number (lowest PR
  number holds it; a failed lookup SKIPS LOUDLY — read the log). Merge in
  ascending version order. Story: delivery.md "Version numbers collide".
- CI rebuilds `packages/plugin/mcp/index.js` and fails on drift. **Never
  hand-resolve its merge conflicts** — take either side, `bun run build:mcp`,
  commit the result.
- Delivery: prod refreshes the plugin cache itself (≤30 min, or
  `request_plugin_refresh`); a peer's SESSION restart is the peer's own step,
  and the order is update THEN restart. Manual update: `command claude plugin
  update claude-workspaces@claude-workspaces` (bare `claude` is a shell
  wrapper that mangles subcommands).
- The board's presence strip names which ATTACHED sessions are behind; an
  empty `behind` list is never fleet-wide clearance.

## Deploying prod — an agent action: do it, don't ask (Bryan, 2026-08-17)

`POST /api/deploy` from the box does it all (pull `--ff-only`, `bun install
--frozen-lockfile`, restart, record; `GET` reads it back). The restart is
recorded as an INTENT: `GET /api/deploy` shows `verification` — `pending`
until the restarted server confirms its own boot, `boot-failed` if it never
does (a 200 on the POST is not delivery; read the verdict). Manual fallback
when the server is down (run `bun install` yourself after the pull):

```bash
# in PROD'S OWN checkout — see "Where prod lives" below. NOT Bryan's working copy.
cd ~/Library/Application\ Support/claude-workspaces/repo
git pull --ff-only origin main
launchctl kickstart -k gui/$(id -u)/com.fryanpan.claude-workspaces   # NOT ...live-feedback
cat ~/Library/Application\ Support/claude-workspaces/client/current/release.json
```

### Where prod lives — all of it on the boot disk (2026-09-01)

Everything the service needs sits under
`~/Library/Application Support/claude-workspaces/`: `repo/` (prod's own
checkout, tracking `origin/main`), `data/` (the `.ydoc` corpus — set by
`CW_DATA_DIR`), `client/` (releases — set by `CW_CLIENT_ROOT`), and
`bin/bun`. Dev checkouts and worktrees stay on `/Volumes/Data`.

**TCC attaches per BINARY, not per volume.** The rule is that the executable
must live on the boot disk and hold Full Disk Access; what it reads afterwards
follows that grant. A launchd job whose bun is `bin/bun` reads `/Volumes/Data`
fine — verified by booting a full launchd server with `WorkingDirectory` on
Data, which built and served normally. Do not write, or repeat, "launchd
cannot read /Volumes/Data": that claim came from probing with `/bin/cat`,
which holds no grant, and it is how this section read on the day it was
written.

- **Prod's deploy source is whatever checkout the plist's `WorkingDirectory`
  names** — nothing else defines it, because `bin.ts` derives `repoRoot` from
  its own file location. Moving prod means editing that key.
- The primary checkout is no longer prod's deploy source, so a mid-edit or
  unpulled working tree can no longer ship the wrong client. **This, not TCC,
  is the durable reason the move was worth doing.**
- **The move reduced the grant dependency; it did not remove it.** Without the
  grant prod still boots and serves the board — repo, corpus, releases, logs,
  bun and `~/.ssh` are all boot disk. Three things would still break:
  the **discovery file** (`~/.local`, `~/.claude` and `~/.bun` are symlinks
  onto `/Volumes/Data`, so `~/.claude/claude-workspaces/server.json` is a Data
  path and every MCP client resolves prod through it), **bound docs and
  folders rooted in Data repos**, and the plugin-cache refresh. Symlinking
  `~/.claude/claude-workspaces` to boot-disk storage would remove the first —
  it works under launchd, but it is NOT currently installed. Audit every new
  `homedir()` path against this.
- **Whether the grant survives a reboot is OPEN.** Nothing observed on
  2026-09-01 spanned one (`kern.boottime` was Aug 31 23:20 throughout). A
  `/bin/cat` probe that *hung* in the morning returned a clean `Operation not
  permitted` that afternoon — two failure modes on one binary in a single boot
  session, still **unexplained**. Leading hypothesis, unconfirmed: a TCC write
  made when the plist change was approved. Do not let this get retold as
  settled.
- Diagnosing it: `launchctl submit` a probe **using the same binary the
  service runs**, and pair it with a positive control on a path you expect to
  work. A system binary like `/bin/cat` is not a proxy for bun — it will
  report a block the service does not have, which is exactly the false
  negative that sent this migration after the wrong bug.

Done when `release.json`'s `sourceRef` matches the commit you shipped AND the
deploy's `verification` reads `healthy` — a healthy restart over an unpulled
checkout republishes the OLD client, and `release.json` advances even when the
server then crashes on boot. A bound doc with un-flushed edits refuses the
deploy (`force` accepts the loss); a failed `bun install` refuses the restart
(`install-failed` — the server keeps running on the old code).

## Staging — review a branch before merge

`bun run staging` from a LINKED worktree (it refuses the primary checkout —
the guard is `--git-dir == --git-common-dir`, and it still holds: prod no
longer deploys from there, but building bundles in the primary working copy
is its own accident): :8788, throwaway data dir; prod stays on 8787. Agent:
`FEEDBACK_BASE_URL=http://<host>:8788` at launch; data never migrates to prod.

## Pre-push leak gate (public repo)

`.githooks/pre-push` runs a regex scanner (denylist + registry project names)
on every push, and a Haiku scanner only on pushes to fryanpan-owned remotes
(`SCRUB_HAIKU_FORCE=1` forces it elsewhere). One config source resolving
without the other FAILS the push (exit 2 — broken install); neither resolving
skips cleanly (`SCRUB_REQUIRE_SOURCES=1` makes even that hard). The scanner
takes paths / `--diff-range` / `--staged` and ignores stdin (piping scans
nothing, exits 0). Git-addressed modes scan the PUSHED BLOB, not the working
tree; `.ydoc`/`.jsonl`/`.csv`/`.svg`/`.xml`/images/extension-less files are
always scanned and cannot be allowlisted; `scrub-allow` counts only as a
trailing comment. Setup once: `git config core.hooksPath .githooks`. Bypass
sparingly: `SCRUB_SKIP=1`, or `SCRUB_SKIP_HAIKU=1` for Haiku alone.

**Linear:** Team Bryan Chan (BRY), team ID
`01328a7f-d761-4176-8bbf-004a397dc6f7`

## Learnings archive — grep it, don't load it

`docs/process/learnings.md` is the incident archive, deliberately not
`@`-inlined (~41k tokens). Grep it before acting when: something looks broken
or impossible; a check reports clean and you're about to trust it; a plugin
update or deploy seems unlanded; you're about to delete, overwrite, restore,
or force anything; CI is red on something your diff never touched.

```bash
grep -n -A12 -i '<topic>' docs/process/learnings.md
```

**Promotion rule:** anything that must fire *without* being looked up gets
promoted into this file or `.claude/rules/`; the promoted set stays under
~1k tokens total.

Promoted killer items (the archive has the full stories):

- **Bound docs make git operations lossy while live** — a git write to a
  bound file is an editor save; the doc wins and reasserts ~800ms later while
  git exits 0. Let bound docs idle ~1s before git ops; never Write/Edit a
  bound `.md` — MCP edit tools only.
- **A conflicted PR has ZERO check-runs** — `mergeStateStatus: DIRTY` + 0
  checks means merge main into the branch, not "CI hasn't started".
- **Check which tree you're in before writing** — `git rev-parse
  --show-toplevel`; a shell whose worktree was deleted silently lands in the
  primary checkout, prod's deploy source.
- **A negative probe needs a positive control**, and reproduce a reported
  impossibility before building the fix — task premises have been false.
