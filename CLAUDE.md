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

## Pre-push leak gate

This repo is **public**. `.githooks/pre-push` runs two scanners on every push and blocks the push if either flags a leak. The principle: once a push lands and a PR is opened, the content is public-record forever (PR descriptions and commits can't be removed) — so the gate fires before the push.

**Layer 1 — regex** (`scripts/scrub-check.py`): scans for hand-curated denylist patterns at `~/.config/conductor/scrub-denylist.txt` (family names, tax keywords, health specifics, etc.) and, if a `registry.yaml` exists at repo root or at `~/dev/ai-team-lead/`, for other project names from the registry.

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
