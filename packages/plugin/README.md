# Live Feedback (Claude Code plugin)

Point-and-comment real-time feedback for LLM agents, delivered as a Claude
Code plugin. Wraps the Yjs-backed feedback server, the MCP tool surface,
the injectable widget, and the PreToolUse auto-approve hook in a single
install.

## What you get

- **MCP tools for the agent** — `list_docs`, `list_threads`, `get_thread`,
  `post_reply`, `resolve_thread`, `reopen_thread`, `push_edit`,
  `observe_url`. The agent can watch for new comments and reply in place.
- **Injectable widget** — one `<script>` tag turns any HTML page or
  dev-server into a commentable surface. Comments appear in the user's
  browser and in the agent's thread list simultaneously.
- **Markdown review surface** — `/review/<docId>` for live-editing
  markdown with anchored text-range comments (Tiptap + Yjs).
- **Webhook dispatch** — every thread event POSTs a standard payload to
  a URL of your choice so you can route to Linear, Slack, or whatever.
- **PreToolUse hook** — auto-approves `mcp__claude-in-chrome__navigate`
  when the target host is in your declared trusted-domain list. Zero
  defaults, so you never accidentally auto-approve someone else's tunnel.

## Install (local path — until published)

In the user's project's `.claude/settings.json`:

```jsonc
{
  "enabledPlugins": {
    "live-feedback": {
      "source": "/abs/path/to/claude-live-feedback-plugin/packages/plugin"
    }
  },
  "permissions": {
    "allow": [
      "mcp__claude-in-chrome__navigate",
      "mcp__claude-in-chrome__computer",
      "mcp__claude-in-chrome__read_page"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__claude-in-chrome__navigate",
        "hooks": [
          {
            "type": "command",
            "command": "bun run $CLAUDE_PROJECT_DIR/.claude/hooks/auto-approve-preview-nav.ts"
          }
        ]
      }
    ]
  }
}
```

Then create `.claude/live-feedback.json` in the project to declare which
hostnames the agent is allowed to navigate to without prompting:

```json
{
  "trustedPreviewDomains": ["<your-tailnet>.ts.net", "local"]
}
```

Find your tailnet suffix with `tailscale status --json | jq -r .CurrentTailnet.MagicDNSSuffix`.
Adding `local` covers `.local` mDNS hostnames on the same wifi.

**No shared defaults.** The plugin ships with nothing in the trust list
so you can't accidentally auto-approve a hostname that isn't yours.

## Running the feedback server

```
bun run scripts/serve.ts
```

Picks a free port, starts the server, and prints three URL forms:

```
 local:      http://localhost:<port>
 tailscale:  http://<this-host>.<tailnet>.ts.net:<port>
 lan:        http://<this-host>.local:<port>   (and any LAN IPv4)
```

Open the one that reaches the device you're reviewing from. No tunnels,
no DNS, no certs. The project assumes reviewers are on the same
**Tailscale network** or **local network** as the host — that's the
whole access-control model.

For a simulated phone viewport on a desktop browser, append
`&mobile=iphone16pm` (or `iphone16`, `iphonese`, `pixel8`).

## Commands

- `/feedback review <docId>` — open a markdown review surface at that doc
- `/feedback serve` — start the feedback server in the current project
- `/feedback threads <docId>` — list open threads on a doc from the CLI

## Widget integration

In any dev server's HTML (or index.html of your app):

```html
<script src="http://localhost:8787/widget.iife.js"></script>
<script>
  FeedbackWidget.init({
    serverUrl: 'ws://localhost:8787',
    docId: 'your-app-name',
    user: new URLSearchParams(location.search).get('as')
  });
</script>
```

On a remote device (phone, teammate's laptop) you'd point `serverUrl`
at the host's Tailscale or LAN hostname instead of `localhost`. The
widget injects
a `<claude-feedback-widget>` Custom Element with a Shadow DOM — no
framework or CSS conflicts with the host page.

## Why a plugin

- **One-line install** for any Claude Code user. They opt in the plugin,
  the MCP tools, hook, skills, and settings defaults all land together.
- **No manual MCP registration** — the plugin references the bundled
  `packages/server/src/mcp.ts` stdio binary directly.
- **Hooks ride along** — users don't need to copy-paste the PreToolUse
  config; enabling the plugin registers it.

## Roadmap

- Publishing to a plugin registry (today install is local-path only).
- Slide-out bottom-sheet composer for mobile (the current composer docks
  fine but a native-feeling sheet would be better on touch).
- Team preview mode — when multiple people on the same tailnet point at
  the same host, surface a presence list and per-user cursors in the
  editor (awareness protocol is already wired; UI pending).
