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
  rules in the `/* ===== SECTION ===== */` banner they belong to; parallel
  branches that both append at EOF conflict every time.
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
don't recite it from memory. `bunx biome check --write` fixes formatting;
pre-existing `noExplicitAny` warnings stay. Per diff: `packages/mcp/src/**`
→ `bun run build:mcp` + commit the bundle; `packages/plugin/**` → version
bump (below); touching neither adds nothing.

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

`POST /api/deploy` from the box does it all (pull `--ff-only`, restart,
record; `GET` reads it back). Manual fallback when the server is down:

```bash
git pull --ff-only origin main    # in the PRIMARY checkout — prod's deploy source
launchctl kickstart -k gui/$(id -u)/com.fryanpan.claude-workspaces   # NOT ...live-feedback
cat ~/.local/state/claude-workspaces/client/current/release.json
```

Done when `release.json`'s `sourceRef` matches the commit you shipped — a
healthy restart over an unpulled checkout republishes the OLD client. A bound
doc with un-flushed edits refuses the deploy (`force` accepts the loss).

## Staging — review a branch before merge

`bun run staging` from a LINKED worktree (it refuses the primary checkout —
prod's deploy source): :8788, throwaway data dir; prod stays on 8787. Agent:
`FEEDBACK_BASE_URL=http://<host>:8788` at launch; data never migrates to prod.

## Pre-push leak gate (public repo)

`.githooks/pre-push` runs a regex scanner (denylist + registry project names)
on every push, and a Haiku scanner only on pushes to fryanpan-owned remotes
(`SCRUB_HAIKU_FORCE=1` forces it elsewhere). One config source resolving
without the other FAILS the push (exit 2 — broken install); neither resolving
skips cleanly (`SCRUB_REQUIRE_SOURCES=1` makes even that hard). The scanner
takes paths / `--diff-range` / `--staged` and ignores stdin (piping scans
nothing, exits 0). Setup once: `git config core.hooksPath .githooks`. Bypass
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
