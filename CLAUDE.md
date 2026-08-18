# Project: claude-workspaces-plugin

## The Goal

Make giving feedback to LLM agents as fast as pointing and saying "this." So fast that Bryan and the agent can iterate on a piece of work in real-time, the way two co-located engineers would.

See [docs/product/vision.md](docs/product/vision.md) for full context — read it before starting any non-trivial work.

## What This Project Is Building

A toolkit for synchronous, multi-user review of three surfaces during agent-driven development:

1. **Markdown + diagram review** — render a markdown file with mermaid diagrams in a browser via Cloudflare tunnel; comments anchored to text ranges; live collaborative edits with redlining UX.
2. **UX mockup review** — lightweight widget injectable into any mockup; element-anchored comments; live-reload preserves comment threads.
3. **Live dev server review** — same widget on a running dev server; agent edits source code, live-reload pushes changes back; comment threads survive.

Plus an "all open comment threads" panel so orphaned comments don't get lost when anchors break.

## Stack

- **Server:** TypeScript + Bun (matches notion-channel-mcp / github-claude-channel pattern)
- **Tunnel:** Cloudflare Tunnel for stable public URLs
- **Widget (injectable into any dev site):** Vanilla JS / web components only — no React/Vue/Svelte deps. Must not conflict with the host site's framework.
- **Realtime collaboration:** TBD — Yjs, Liveblocks, Automerge, or build minimal. See `docs/research/` for evaluation.
- **Agent integration:** MCP server tools + HTTP webhooks. Agents don't need UI; they need clean APIs to observe and act.

## Origin

The feedback widget that ships Linear tickets in `~/dev/health-tool` and `~/dev/family-bike-map` is the starting point. This repo is the next major iteration — the production-feedback flow stays as-is in those repos; this is for the development-time live-loop flow.

## Key Hard Things

(See vision.md for full context.)

- Anchor stability under edits (DOM and text)
- Comment thread tracking when anchors break
- Realtime collaborative editing framework choice
- Lightweight injection without breaking host sites
- Agent-friendly API surface
- Best-in-breed redlining UX

## Conventions

- Lead with goals, not implementation. Top-level docs answer "what becomes possible" before "how it works."
- Public repo with branch protection on main — all changes via PR.
- **Never hard delete user content. Soft delete.** (Bryan, 2026-08-17, asked
  and answered as a project-wide rule: *"Generally don't do hard delete. Use
  soft delete."*) A removal must be reversible, and the reason is not caution
  in the abstract — **the `.ydoc` is the durable record, not a cache.**
  `docs/process/activity-data-completeness.md` states the Weekly Review agent's
  guarantee as valid *"for every doc whose `.ydoc` still exists (live data dir +
  archive)"*, and `data/activity.jsonl` is a DERIVED index that
  `activity-backfill.ts` rebuilds from those ydocs. So a hard delete does not
  merely remove a document — it silently truncates the historical window an
  analysis depends on, and no surface anywhere reports that it happened.
  `reopen` / `read_session` / `doc_open` are live-capture only and are not
  reconstructable at all, so that log must not be pruned per-doc either.
  - The mechanism already exists and is half-built: `data/_archive/` works
    because `hydrateFromDisk` reads only the top level of the data dir (so an
    archived doc stops loading, and stops costing memory and a poll) while
    `activity-backfill.ts` explicitly scans `_archive` (so it still feeds
    analysis). What is missing is a writer — nothing moves anything there.
    `stagePersisted` / `unstagePersisted` in `rooms.ts` is an existing
    reversible-rename primitive of the same shape.
  - `purgePersisted` (`rooms.ts`) is the hard path — `rmSync` on the `.ydoc`
    plus the private-meta sidecar — and `delete_doc` / `delete_workspace` reach
    it. Calling it is a decision, never a default.
  - **The rule is about user content and history, not about transient files.**
    Pruning old client releases and cleaning up `.tmp`/staging paths are correct
    as hard deletes. Stated in this direction deliberately: a rule read too
    broadly leaves litter, while one read too narrowly destroys a record nobody
    can rebuild.
  - When you narrow what an existing delete verb does, change its MEANING and
    keep accepting the old payload. Old plugin bundles keep calling it from
    sessions that have not restarted — see "Removing an MCP tool cannot break a
    peer" in [docs/process/learnings.md](docs/process/learnings.md).
    **Scope, added 2026-08-18: Bryan has waived compatibility shims for
    surfaces still in the prototyping phase** — something nobody outside this
    machine depends on yet can simply change shape, and carrying a shim for it
    buys nothing. The bullet stays in force for **the shared server's REST
    routes**, which is where the hazard actually lives: an old bundle keeps
    calling the route it was built against, from a session that has not
    restarted, and gets a failure it cannot explain from its own version. So
    the question at a narrowing is never "is this verb old" — it is *"is there
    a caller I cannot restart"*.
- TypeScript strict mode.
- Widget bundle size is a hard constraint — measure and report it on every PR that touches widget code.
- **Don't append new CSS at the end of `packages/markdown-app/src/styles.css`.** It's a single ~2,700-line file organized into `/* ===== SECTION ===== */` banners, and parallel branches that both append at EOF conflict every time. Put rules in the banner section they belong to; a genuinely new feature gets a new banner next to related sections, not at the bottom.
- **Edit Bryan's bound docs directly; don't default to `suggest: true`.** Concurrent editing is the norm — he's in the doc while you work and expects your changes to land. Reserve `suggest: true` for judgment calls where a one-tap approve/reject genuinely beats a silent rewrite (voice, framing, a claim you're unsure of). Mechanical fixes, typos, and anything he explicitly asked for go in as plain edits.
- **Mobile UX is load-bearing.** Bryan reviews on his phone. Any UI change touching the editor, widget, or landing page must follow [docs/product/design-mobile.md](docs/product/design-mobile.md) — verify at 430px wide before shipping.

## When to open a PR

- **PR after each task is done.** (Bryan, 2026-08-18: *"It's fine to PR after
  each task is done."*) Finishing a task is the moment to open the PR — don't
  bank several tasks into one push waiting for a tidier moment.
- **A cohesive feature is ONE PR with ordered commits, not a fragment per
  file.** The two rules above meet at the unit of work: one *task* gets one PR,
  and if a feature genuinely spans several commits, they ride in that one PR in
  the order they should be read. Splitting one coherent change into many small
  PRs costs a review pass each and hides the shape of the thing.
- **Mockups and sketches never enter the repo.** (Bryan verbatim: *"mockups,
  sketches, and so on never enter repo — serve with bind mock."*) Write the
  HTML somewhere outside the working tree and serve it with `bind_mock(docId,
  sourceHtmlPath)`; the reviewer gets a URL and comment threads, and the repo
  gets no artifact to prune later. A mockup committed once becomes a tracked
  file somebody has to keep building — and if it sits in the primary checkout
  it also makes every prod release stamp `-dirty` while anyone edits it.


## The four gates — run all of them before you push

```bash
bunx vitest run                 # unit + client suites
bun test packages/server/test   # server suite (NOT covered by vitest)
bun run typecheck               # tsc --noEmit; vitest does not typecheck
bun run lint                    # biome; nothing else formats
```

They are **four separate gates and each one catches what the others cannot** —
`vitest` does not typecheck, `typecheck` does not lint, and none of them
format. A single over-long string has taken CI red on its own.

Written down here because the failure mode is not forgetting to verify, it is
**reciting the list from memory** — which on one day briefed eight agents with
an incomplete set. Read it, don't recall it. `bunx biome check --write` fixes
formatting; leave the pre-existing `noExplicitAny` **warnings** alone, they are
warnings and not failures.

A PR that touches `packages/mcp/src/**` adds `bun run build:mcp` plus the
committed bundle, and a PR that touches `packages/plugin/**` adds the version
bump — both below. A PR that touches neither adds nothing.

## Releasing the plugin (bump the version when the diff touches the plugin)

Peers install by version. `claude plugin update` compares the version string and
copies nothing when it hasn't moved — **while still reporting success**. An
unbumped change is invisible on both ends: green push here, unchanged plugin
there. That is how 25 feature commits sat undelivered between 2026-05-09 and
2026-08-10.

- **Bump the patch version when your diff touches `packages/plugin/**`. THREE
  places, identical values** —
  `packages/plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
  and the `PLUGIN_VERSION` constant in `packages/mcp/src/mcp.ts` (the serverInfo
  a client sees in the initialize handshake, and — since the drift notice — the
  version each session reports to its board on `attach_agent`; one constant, so
  those two can never disagree). This entry said "both manifests"
  until a bump that followed it exactly still shipped a stale handshake
  version; the third site is the one that has actually drifted in the field,
  three minor releases behind. `packages/mcp/test/launcher.test.ts` asserts
  the handshake against plugin.json, so the miss goes red rather than out —
  but only after `bun run build:mcp`, since the test drives the BUNDLE.
  Minor/major bumps are Bryan's call; patch is the default and needs no discussion.
- **CI enforces the dangerous half.** `bun run check:plugin-version` fails when a
  PR touches `packages/plugin/**` without moving the version forward, or when the
  two manifests disagree. It is not a warning — the build goes red.
- **A PR that touches neither `packages/plugin/**` nor `packages/mcp/src/**`
  bumps nothing, and that is correct rather than an oversight.** The gate's
  `GUARDED_PREFIX` is `packages/plugin/`; a `packages/mcp/src/**` change counts
  transitively, because `bun run build:mcp` rewrites the tracked
  `packages/plugin/mcp/index.js`. A server-only or markdown-app-only change ships
  no plugin and needs no release. Bumping regardless is not free caution — it
  manufactures a **total merge order across unrelated branches**, so landing
  0.1.44 leaves a green PR sitting at 0.1.42 unable to merge without a rebase it
  never needed. This bullet exists because the heading above read "on every PR"
  for months and agents dutifully bumped changes that shipped nothing.
- **When several branches are in flight, the number is a merge-queue position —
  ask the merger for it, don't read it off main.** Three branches independently
  pushed 0.1.46 on 2026-08-17 with main at 0.1.45, and **nothing went red**:
  identical strings merge clean because both sides agree, and at the time
  `check:plugin-version` compared against the *fork point*, which stays frozen
  however many times the job re-runs. **That half is now fixed** — the gate
  compares against `origin/main`'s TIP, so a stale number goes red instead of
  green (see "A gate that compares against the merge-base is green precisely
  when the regression is largest" in learnings.md). It is a narrowing, not a
  closure: CI runs at push time, so main can still move between your last green
  run and the merge. And re-reading main before you push still does not help
  with the other half — the branch you are about to collide with has not merged,
  so main cannot tell you about it. Whoever owns the merges hands out numbers
  and merges in ascending order; **an agent that finds its number taken reports
  rather than bumps**, because bumping is how it collides with the next one.
  This matters past tidiness: a merge order that steps the number backwards
  leaves peers silently
  un-updated, since `claude plugin update` copies nothing when the string has not
  moved forward and reports success anyway.
- **The MCP bundle is checked the same way.** CI rebuilds it and fails if the
  committed `packages/plugin/mcp/index.js` differs from a fresh build, because
  peers load that artifact rather than the TypeScript source. Any PR touching
  `packages/mcp/src/**` must run `bun run build:mcp` and commit the result.
  This is why CI pins its Bun version — bundler output moves between releases.
- **The update no longer waits for anyone to remember it.** Prod runs
  `claude plugin update claude-workspaces@claude-workspaces` at boot and every 30
  minutes (`LF_PLUGIN_REFRESH_MINUTES`), so a merge reaches this machine's cache
  on its own. Any peer can also ask for it now with `request_plugin_refresh` —
  it is safe to expose because the update rewrites a version-keyed cache and
  never touches a running session. Dev and staging deliberately can't do it
  (they're copies of the deploy source); there the route answers 501.
- **A peer's SESSION restart is still the peer's, and the order is still
  load-bearing: update, THEN restart.** (This is the one restart an agent cannot
  run for someone else. Restarting the prod *server* is a different act on a
  different artifact and it IS yours — see the bullet below.) The cache path is
  version-keyed and a running session
  resolved it at launch, so restarting first pulls whatever the cache already
  holds — which has demonstrably moved a session *backwards*, from a working-tree
  0.1.15 to a cached 0.1.12, in the same restart that was meant to deliver new
  tools. See "A restart can move a session BACKWARDS a plugin version" in
  [docs/process/learnings.md](docs/process/learnings.md).
- **A merge still does not reach the fleet by itself.** Peers sit on different
  versions until each one next restarts, so anything whose value ships inside
  the bundle — a skill, a tool description — is not delivered by merging it.
  What changed is that the *fetch* now happens without a person; the pickup
  does not.
- **The board now says who is behind**, so this stops being something a person
  has to remember to check. Every session reports the bundle it is RUNNING on
  `attach_agent`, and the workspace's presence strip names any session older
  than the version this server's deploy source would install. That is the
  answer to "does my peer have this yet" — read it there rather than asking.
  Two honest limits. "Released" means *this checkout's manifest*, so a
  checkout nobody pulled reports its own staleness as current. And the strip
  only sees **sessions that attached to that board** — a peer that never
  attached is absent, not current, and there is no server-wide session
  registry to widen it with (a plugin version reaches the server through
  `attach_agent` and nowhere else). So the strip now always states its
  denominator — "no attached session is behind 0.1.40 (1 checked)" — because
  an empty list rendered as silence, and silence read as a fleet-wide
  all-clear while most of the fleet was several releases back. **An empty
  `behind` list is not a fleet-wide clearance — never let one alone satisfy a
  delivery gate.** (Removing a *tool* needs no such gate at all; see the entry
  below it in learnings.md. What does bite is narrowing something old callers
  still send or read on the shared server, and the strip cannot tell you who
  those callers are.) See "The strip reads a board, not the fleet" in
  [docs/process/delivery.md](docs/process/delivery.md).
- **An agent CAN run the update; the shell makes it look otherwise.** On this
  machine `claude` resolves to a shell function that injects flags ahead of the
  subcommand, so `claude plugin update …` is parsed as a prompt and dies with
  "Input must be provided either through stdin or as a prompt argument when
  using --print". That reads exactly like a permission refusal, and it was
  written up in a ticket as one. `command` bypasses functions and aliases, so
  the invocation that works is `command claude plugin update
  claude-workspaces@claude-workspaces`. The peer's session restart is still the
  human step; restarting prod is not.
  (The server's own refresh never hits this — it spawns the resolved binary
  path with an argv array and no shell, which is why a fixed argv and no shell
  are load-bearing there rather than stylistic.)

- **Restarting prod is an agent action. Do it; don't ask, and don't route it
  through Bryan.** (Bryan, 2026-08-17, reversing the older "the production
  restart is Bryan's call" rule that used to sit in this file and still sat in
  the diff-review plan.) The command is
  `launchctl kickstart -k gui/$(id -u)/com.fryanpan.live-feedback`.
- **The restart deploys whatever the primary checkout is parked on, so pulling
  comes FIRST.** Prod rebuilds the browser bundles from its deploy source at
  every start, and that source is the primary checkout — not `origin/main`. On
  2026-08-17 a kickstart run to deploy a just-merged client came up in five
  seconds, answered 200, and republished the **previous** client, because the
  checkout was sitting 10 commits behind `origin/main` with a clean tree.
  Nothing anywhere said so: a healthy server serving a stale bundle looks
  exactly like a healthy server serving a fresh one. The deploy is therefore
  three steps and the last two are not optional —

  ```bash
  git pull --ff-only origin main      # in the PRIMARY checkout, prod's deploy source
  launchctl kickstart -k gui/$(id -u)/com.fryanpan.live-feedback
  cat ~/.local/state/live-feedback/client/current/release.json
  ```

  — and the deploy is done when that `release.json`'s `sourceRef` matches the
  commit you meant to ship, not when the restart returns. Verify a feature
  literal in the served bundle too, old-bundle-first, per "A prod restart
  reloads server code but NOT the served app bundle" in
  [docs/process/learnings.md](docs/process/learnings.md).
- **`POST /api/deploy` does those three steps as one operation, from the box.**
  It pulls (`merge --ff-only` only — never a rebase, never a reset), restarts,
  and writes the outcome to disk, because the restart kills the process that
  would otherwise have reported on it. `GET /api/deploy` reads that record back
  and is safe to call any time; reading is not deploying. **There is
  deliberately no "just restart" verb** — a restart over an unpulled checkout
  rebuilds the same bundles and prints a successful deploy, which is exactly the
  failure the bullet above describes, so the route makes it unexpressible.
  - It answers only to a **loopback peer address**, not to the `Host` header —
    a LAN and a tailnet client were both measured reaching this server sending
    `Host: localhost`, so a Host-based gate would be spoofable by the callers
    it excludes. Run it from the box. Dev and staging answer 501 on purpose.
  - **A bound document with un-flushed edits refuses the deploy** (`force` to
    override, and it is a real override — it accepts the loss). Bryan,
    2026-08-18, asked and answered: *keep refuse by default.* A pull is an
    editor save as far as a bound doc is concerned, so against un-flushed edits
    the live doc wins and reasserts ~800ms later — git exits 0, `git status` is
    clean at that instant, and the tree is dirty again a second afterwards.
    Refusing names the files; proceeding loses them silently.
  - The manual three steps above still work and are still the fallback when the
    server is down — which is the one case the route cannot cover, since it
    needs the server it is about to restart.

**The whole delivery model is written down once, in
[docs/process/delivery.md](docs/process/delivery.md)**: how the plugin travels
(GitHub marketplace), which artifacts are tracked vs built on the box, why a
prod restart is the browser deploy, and which restart delivers which artifact.
Read it before answering "why doesn't my peer / my browser have this yet".

## Reviewing a branch before it merges (`bun run staging`)

Peers and people can review an unmerged build without merging it. From a **linked worktree** (not the primary checkout):

```bash
bun run staging            # builds this worktree's bundles, serves :8788 with a throwaway data dir
```

Prod stays on 8787 with its own data throughout. The script refuses to run from the primary checkout, because that checkout is prod's deploy source: every prod start rebuilds the bundles there and publishes them as the client release the whole fleet loads, so a "test build" there ships at the next restart. It also starts the server via `bin.ts` rather than `scripts/serve.ts`, because `serve.ts` publishes the live port that the live-feedback MCP discovers, which would silently repoint every agent in the fleet at the staging build.

To put an *agent* on staging: `FEEDBACK_BASE_URL=http://<host>:8788` in its launch env (read once at session start, so it needs a restart). Staging data never migrates to prod — evaluate pre-merge, do the real work once, after.

## Pre-push leak gate

This repo is **public**. `.githooks/pre-push` runs two scanners on every push and blocks the push if either flags a leak. The principle: once a push lands and a PR is opened, the content is public-record forever (PR descriptions and commits can't be removed) — so the gate fires before the push.

**Layer 1 — regex** (`scripts/scrub-check.py`): scans for hand-curated denylist patterns and, from `registry.yaml` (repo root, else the fleet copy), the names of projects the registry has not cleared. Two keys clear a name, and the difference matters: `public: true` means the GitHub repo is public *today* (a fact other tooling relies on — it must stay literally true), and `mentionable: true` means the operator has cleared the name for public mention while the repo is still private. The gate only ever asks "is this name safe to say", so both drop out; the split exists so answering that never requires asserting a repo is public when it isn't. Both sources resolve from a candidate list, current path first — `~/.config/team-lead/scrub-denylist.txt` then `~/.config/conductor/`, and `~/dev/ai-team-lead/registry.yaml` then the pre-rename path.

**A missing source fails the push (exit 2) — it does not warn.** If either source resolves, this machine is expected to have both, so a missing one is a broken install rather than an absent config. If neither resolves (a stranger's clone), it skips cleanly; `SCRUB_REQUIRE_SOURCES=1` makes even that hard. This is deliberate: the registry half of this gate was dead for weeks because a renamed path made `find_registry()` return None while the denylist kept the pattern list non-empty, so the old "no patterns configured" guard never fired and every push passed the project-name check by not running it.

**`bun run check:scrub-gate` proves the gate can still see** — nine cases against temp fixtures (`SCRUB_REGISTRY` / `SCRUB_DENYLIST` override authoritatively, so it never reads the real config). It runs in CI *and* at the top of the pre-push hook, because CI never runs the hook and the hook is where the gate lives. Note the scanner takes file paths, `--diff-range`, `--staged`, or `--scan-all-tracked`; it **ignores stdin**, so piping content at it scans nothing and exits 0.

**Layer 2 — Haiku** (`scripts/scrub-haiku.py`): sends the diff to `claude-haiku-4-5-20251001` with a strict scanner prompt. Catches unrecognized real names, contextual identifiers, financial/health specifics in personal context, OAuth tokens, etc. Auto-runs only on pushes to `github.com/fryanpan/` remotes. Reads its key from the macOS Keychain (`scrub-haiku-api-key`), falling back to `SCRUB_HAIKU_API_KEY` or `ANTHROPIC_API_KEY`. Set up once with `security add-generic-password -a "$USER" -s scrub-haiku-api-key -w` (omit the value; it prompts, so the key stays out of shell history). API failure → warn + pass (regex layer still ran).

**Setup once after clone:**
```bash
git config core.hooksPath .githooks
```

Bypass: `SCRUB_SKIP=1 git push ...` (both layers), `SCRUB_SKIP_HAIKU=1 git push ...` (Haiku only). Use sparingly.

## Linear

- Team: Bryan Chan (BRY)
- Team ID: 01328a7f-d761-4176-8bbf-004a397dc6f7

@docs/process/learnings.md
