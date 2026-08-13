# Project: claude-live-feedback-plugin

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
- TypeScript strict mode.
- Widget bundle size is a hard constraint — measure and report it on every PR that touches widget code.
- **Don't append new CSS at the end of `packages/markdown-app/src/styles.css`.** It's a single ~2,700-line file organized into `/* ===== SECTION ===== */` banners, and parallel branches that both append at EOF conflict every time. Put rules in the banner section they belong to; a genuinely new feature gets a new banner next to related sections, not at the bottom.
- **Edit Bryan's bound docs directly; don't default to `suggest: true`.** Concurrent editing is the norm — he's in the doc while you work and expects your changes to land. Reserve `suggest: true` for judgment calls where a one-tap approve/reject genuinely beats a silent rewrite (voice, framing, a claim you're unsure of). Mechanical fixes, typos, and anything he explicitly asked for go in as plain edits.
- **Mobile UX is load-bearing.** Bryan reviews on his phone. Any UI change touching the editor, widget, or landing page must follow [docs/product/design-mobile.md](docs/product/design-mobile.md) — verify at 430px wide before shipping.

## Releasing the plugin (bump the version on every PR)

Peers install by version. `claude plugin update` compares the version string and
copies nothing when it hasn't moved — **while still reporting success**. An
unbumped change is invisible on both ends: green push here, unchanged plugin
there. That is how 25 feature commits sat undelivered between 2026-05-09 and
2026-08-10.

- **Bump the patch version on every PR.** Both manifests, identical values:
  `packages/plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
  Minor/major bumps are Bryan's call; patch is the default and needs no discussion.
- **CI enforces the dangerous half.** `bun run check:plugin-version` fails when a
  PR touches `packages/plugin/**` without moving the version forward, or when the
  two manifests disagree. It is not a warning — the build goes red.
- **The MCP bundle is checked the same way.** CI rebuilds it and fails if the
  committed `packages/plugin/mcp/index.js` differs from a fresh build, because
  peers load that artifact rather than the TypeScript source. Any PR touching
  `packages/mcp/src/**` must run `bun run build:mcp` and commit the result.
  This is why CI pins its Bun version — bundler output moves between releases.
- After merging a plugin change, `claude plugin update live-feedback@claude-live-feedback`
  is what actually delivers it to a session.

## Reviewing a branch before it merges (`bun run staging`)

Peers and people can review an unmerged build without merging it. From a **linked worktree** (not the primary checkout):

```bash
bun run staging            # builds this worktree's bundles, serves :8788 with a throwaway data dir
```

Prod stays on 8787 with its own data throughout. The script refuses to run from the primary checkout, because prod serves `packages/markdown-app/dist` from there per-request — building bundles in the primary checkout is a deploy to the fleet, not a test build. It also starts the server via `bin.ts` rather than `scripts/serve.ts`, because `serve.ts` publishes the live port that the live-feedback MCP discovers, which would silently repoint every agent in the fleet at the staging build.

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
