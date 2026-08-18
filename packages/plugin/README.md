# claude-workspaces

Point-and-comment real-time feedback for Claude Code agents, packaged as
a Claude Code plugin. Ships MCP tools, `/feedback` slash commands, a
PreToolUse auto-approve hook, and the live review surfaces (markdown
doc editor + injectable widget) as a single install.

## What you get

- **MCP tools for the agent** — `list_docs`, `list_threads`, `get_thread`,
  `post_reply`, `resolve_thread`, `reopen_thread`, `push_edit`,
  `observe_url`. The agent watches for new comments and replies in place.
- **Markdown review surface** — `/review/<docId>` for live-editing
  markdown with anchored text-range comments (Tiptap + Yjs).
- **Git diff review** — `create_diff_review(repo, base)` renders a
  GitHub-PR-style unified diff (per-file tree, old/new line numbers,
  Diff ↔ whole-file toggle) with live line-anchored comment threads.
  Default mode diffs against the live working tree — the agent keeps
  editing and the reviewer's diff re-renders in ~1s; pass `target` to
  pin a finished range instead.
- **Injectable widget** — one `<script>` tag turns any HTML page or
  dev-server into a commentable surface.
- **Slash commands** — `/feedback-serve`, `/feedback-threads`.
- **PreToolUse hook** — auto-approves `mcp__claude-in-chrome__navigate`
  for hostnames you explicitly trust. Zero defaults ship.

## Requirements

- [Claude Code](https://code.claude.com/docs) ≥ 2.0.70 (plugin v2 format).
- Node ≥ 18 (for `npx`, which runs the MCP server on demand).
- [Bun](https://bun.sh) on the host that runs the feedback HTTP/WS
  server. Reviewers' devices (phone, teammate's laptop) don't need Bun.

## Install

```bash
claude plugin marketplace add fryanpan/claude-workspaces-plugin
claude plugin install claude-workspaces@claude-workspaces
```

That's the entire client install. The plugin's `plugin.json`, `.mcp.json`,
`hooks/hooks.json`, and `commands/*.md` wire themselves — you do **not**
need to edit your project's `settings.json`. The MCP server is pulled
from [npm](https://www.npmjs.com/package/@fryanpan/claude-workspaces-mcp)
via `npx` on first use.

To run the **browser review surfaces** (markdown + widget), you still
need a clone on the machine that'll host the server:

```bash
git clone https://github.com/fryanpan/claude-workspaces-plugin.git
cd claude-workspaces-plugin
bun install
bun run dev
```

Reviewers connect to the printed Tailscale / LAN URL from any device —
no install on their side.

To enable auto-approval for Chrome navigation, create a
`.claude/live-feedback.json` in whichever project(s) you want it active:

```json
{
  "trustedPreviewDomains": ["<your-tailnet>.ts.net", "local"]
}
```

Find your tailnet suffix with
`tailscale status --json | jq -r .CurrentTailnet.MagicDNSSuffix`.
No defaults ship — the file has to exist and list hostnames for the
hook to fire.

## Update

```bash
claude plugin marketplace update claude-workspaces
claude plugin update claude-workspaces@claude-workspaces
```

Commands, hooks, and the MCP tool surface are pinned to the plugin's
`version` in `.claude-plugin/plugin.json`. `npx` always fetches the
matching `@fryanpan/claude-workspaces-mcp` from npm on demand, so you never
have a stale MCP binary.

## Uninstall

```bash
claude plugin uninstall claude-workspaces@claude-workspaces
claude plugin marketplace remove claude-workspaces
```

## Versioning

- Plugin version lives in `.claude-plugin/plugin.json` and is mirrored
  in `.claude-plugin/marketplace.json` at the repo root.
- SemVer: patch for bugfixes, minor for new commands/tools, major for
  breaking changes to the MCP surface or settings schema.
- Claude Code pins each installed version in
  `~/.claude/plugins/cache/claude-workspaces/claude-workspaces/<version>/`
  and only upgrades on explicit `claude plugin update`.

## Running the feedback server

The MCP server auto-starts on demand via the plugin's `.mcp.json`. For
the browser review surfaces, run the HTTP server separately:

```bash
cd /path/to/claude-workspaces-plugin
bun run dev
```

Picks a free port and prints URLs:

```
 local:      http://localhost:<port>
 tailscale:  http://<this-host>.<tailnet>.ts.net:<port>
 lan:        http://<this-host>.local:<port>
```

Use whichever URL reaches the reviewing device. Tailscale and LAN paths
assume you're on the same private network as the host — no public
tunnels, no certs. For a phone-simulator viewport on desktop append
`&mobile=iphone16pm` (also `iphone16`, `iphonese`, `pixel8`).

## Commands

- `/feedback-serve` — start the feedback HTTP/WS server from inside Claude.
- `/feedback-threads <docId>` — list open threads on a doc.

## Skills

- `embedding-feedback-widget` — Claude auto-invokes this when asked to
  generate HTML mockups, sample pages, or dev-server demos. It
  encodes the rules around `docId` reuse, multi-page context filtering,
  and `setContext({ view })` for dynamic surfaces (modals, tabs, SPA
  state). You don't call it directly; just ask Claude to make a
  mockup and this skill fires.
- `diff-review` — fires when the reviewer asks to "review a diff" /
  a branch / work in progress. Covers `create_diff_review` (repo +
  base → live working-tree review URL; optional `target` to pin),
  sharing the `entryUrl`, handling line-comment events per file,
  `exclude`-ing vendored paths on big diffs, and `delete_workspace`
  cleanup.
- `editing-review-docs` — auto-invokes before Claude edits a `.md`
  file. Checks `list_docs` to see if the file is bound to a live
  review doc, and if so routes edits through `find_and_replace` /
  `rewrite_thread_region` / `insert_blocks_after_thread` /
  `delete_block_at_anchor` / `delete_blocks_in_range` / `delete_section`
  so the reviewer sees changes land surgically rather than as a full
  reflow.

## Widget integration

```html
<script src="http://localhost:8787/widget.iife.js"></script>
<script>
  FeedbackWidget.init({
    serverUrl: 'ws://localhost:8787',
    docId: 'your-app-name',
    user: new URLSearchParams(location.search).get('as'),
  });
</script>
```

Swap `localhost` for the host's Tailscale or LAN hostname when connecting
from a phone or teammate's laptop.

## Release flow (maintainers)

1. Bump `version` in `packages/plugin/.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json`, and `packages/mcp/package.json`
   in lockstep.
2. `bun run build:mcp` to refresh `packages/mcp/dist/`.
3. `bun run publish:mcp` (wraps `npm publish` inside `packages/mcp`).
4. `git commit`, tag `v<n>`, push.

Users pick up commands/hooks/manifest changes via `claude plugin update`
and the new MCP binary via `npx` (no user action required).

## Roadmap

- **Team presence** — multi-cursor awareness is wired on the Yjs side;
  UI still to come.
