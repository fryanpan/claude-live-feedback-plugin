# live-feedback

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
- **Injectable widget** — one `<script>` tag turns any HTML page or
  dev-server into a commentable surface.
- **Slash commands** — `/feedback-serve`, `/feedback-threads`.
- **PreToolUse hook** — auto-approves `mcp__claude-in-chrome__navigate`
  for hostnames you explicitly trust. Zero defaults ship.

## Requirements

- [Claude Code](https://code.claude.com/docs) ≥ 2.0.70 (plugin v2 format).
- [Bun](https://bun.sh) on the host machine — the MCP server and the hook
  both run as `bun` scripts.
- A clone of
  [fryanpan/claude-live-feedback-plugin](https://github.com/fryanpan/claude-live-feedback-plugin).
  The MCP server lives alongside the plugin in that monorepo, so the
  current release expects the whole repo checked out. A self-contained
  release is on the roadmap.

## Install

```bash
# 1. Clone the repo (stays wherever you like)
git clone https://github.com/fryanpan/claude-live-feedback-plugin.git
cd claude-live-feedback-plugin
bun install

# 2. Add the repo as a local marketplace
claude plugin marketplace add .

# 3. Install the plugin
claude plugin install live-feedback@claude-live-feedback
```

That's it. The plugin's `plugin.json`, `.mcp.json`, `hooks/hooks.json`,
and `commands/*.md` are all wired automatically — you do **not** need to
edit your project's `settings.json`.

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
cd /path/to/claude-live-feedback-plugin
git pull
claude plugin marketplace update claude-live-feedback
claude plugin update live-feedback@claude-live-feedback
```

## Uninstall

```bash
claude plugin uninstall live-feedback@claude-live-feedback
claude plugin marketplace remove claude-live-feedback
```

## Versioning

- Plugin version lives in `.claude-plugin/plugin.json` and is mirrored
  in `.claude-plugin/marketplace.json` at the repo root.
- SemVer: patch for bugfixes, minor for new commands/tools, major for
  breaking changes to the MCP surface or settings schema.
- Claude Code pins each installed version in
  `~/.claude/plugins/cache/claude-live-feedback/live-feedback/<version>/`
  and only upgrades on explicit `claude plugin update`.

## Running the feedback server

The MCP server auto-starts on demand via the plugin's `.mcp.json`. For
the browser review surfaces, run the HTTP server separately:

```bash
cd /path/to/claude-live-feedback-plugin
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

## Roadmap

- **Self-contained release** — today the plugin depends on the sibling
  `packages/server` in the monorepo. A future release will either bundle
  the MCP binary into the plugin or publish it as an npm package so the
  plugin works off a plain `claude plugin marketplace add fryanpan/...`
  from a fresh shell with no clone required.
- **Team presence** — multi-cursor awareness is wired on the Yjs side;
  UI still to come.
