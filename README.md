# claude-live-feedback-plugin

**Point-and-comment review for Claude Code agents.**

Agents are faster than humans at writing code and prose, but humans still have to review what they produce. This plugin makes that review loop real-time and specific: you point at something — a sentence in a markdown doc, a button in a mockup, a section of your dev server — type what's wrong with it, and the agent sees the comment as a live event, edits the thing, and you see the change a second later. Same mental model as a pair-programmer at your shoulder.

## What's in the box

- **Markdown review** — a browser-based WYSIWYG editor backed by a file on disk. Open `/review/<docId>?as=<name>` from any device on your Tailnet or LAN. Comments anchor to text ranges and survive concurrent edits via CRDT. Bidirectional disk sync keeps your repo's `.md` in lockstep with the live editor.
- **UX / mockup widget** — one `<script>` tag (web component, shadow-DOM isolated) drops comment threads onto any HTML page. Anchors include page URL + optional view state so one `docId` can span a multi-page site or SPA.
- **Agent tool surface** — an MCP server the plugin installs into Claude Code. Agent can `get_doc`, `find_and_replace`, `rewrite_thread_region`, `insert_blocks_after_thread`, `seed_doc`, `attach_file`, and more.
- **Claude Code channel** — thread events (`thread.created` / `thread.replied` / `thread.resolved` / `thread.reopened`) arrive in the agent's session as `<channel source="live-feedback" ...>` messages. The agent reacts the same way it would to any peer ping.

## Architecture

```mermaid
flowchart LR
  subgraph Reviewer["Reviewer (any device on your network)"]
    Browser["Browser: Tiptap editor<br/>OR widget on a mockup"]
  end

  subgraph Host["Host machine"]
    Server["HTTP + WebSocket server<br/>(Bun)"]
    Yjs["Yjs rooms<br/>(CRDT state)"]
    Disk[(.md files)]
    Persist[(Yjs updates<br/>on disk)]
  end

  subgraph CC["Claude Code session"]
    Agent["Claude agent"]
    MCP["live-feedback-mcp<br/>(stdio)"]
  end

  Browser <-->|WebSocket<br/>(y-protocol sync)| Yjs
  Server --- Yjs
  Yjs <-->|bidirectional sync<br/>+ debounced| Disk
  Yjs --> Persist
  Server -->|SSE<br/>thread events| MCP
  MCP -->|notifications/claude/channel| Agent
  Agent -->|MCP tool calls<br/>(edit, reply, resolve)| MCP
  MCP -->|REST| Server
```

Yjs is the source of truth at runtime. Disk is authoritative at rest: every prose change flushes to the `.md` file within ~1 second, and external edits to that file (VS Code, git pull, another agent) flow back into the live doc within ~1 second via `fs.watch`. Claude sees comments as channel events pushed via the MCP's `notifications/claude/channel` capability.

## Install

### One-time setup (on the host machine that'll run the review server)

```bash
git clone https://github.com/fryanpan/claude-live-feedback-plugin.git
cd claude-live-feedback-plugin
bun install
bun run bootstrap    # wires up npm link, adds marketplace, installs plugin at user scope
```

That script does:
1. `cd packages/mcp && npm link` — so `live-feedback-mcp` resolves on your PATH.
2. `claude plugin marketplace add .` — adds this repo as a local marketplace.
3. `claude plugin install live-feedback@claude-live-feedback --scope user` — enables the plugin for every Claude Code session on this machine.

### Enable channel events in Claude Code (one-line shell edit)

Claude Code requires an explicit opt-in per session for plugins that emit channel events. Add this flag to however you launch `claude`:

```bash
--dangerously-load-development-channels plugin:live-feedback@claude-live-feedback
```

e.g. in your `~/.zshrc`:

```zsh
claude() {
  /path/to/claude \
    --dangerously-load-development-channels plugin:live-feedback@claude-live-feedback \
    "$@"
}
```

Then `source ~/.zshrc` and relaunch Claude Code.

## Run

```bash
bun run dev
```

Starts the feedback server + watches source files for live reload. Prints URLs for every way to reach it:

```
 local:      http://localhost:<port>
 tailscale:  http://<host>.<tailnet>.ts.net:<port>
 lan:        http://<host>.local:<port>
```

Open any URL in a browser. To review a markdown file from your repo:

```bash
# In a Claude Code session
attach_file({ docId: "my-review", path: "/abs/path/to/doc.md" })
# Then open:  http://.../review/my-review?as=<name>
```

## Skills shipped with the plugin

- **`embedding-feedback-widget`** — fires when the agent is asked to generate a mockup or sample page. Wires the widget with the right `docId` / `setContext` pattern.
- **`editing-review-docs`** — fires before the agent edits a `.md` file. Checks whether the file is under live review and routes edits through MCP tools instead of `Edit`/`Write` if so, preventing divergence.

Plus two slash commands: `/feedback-serve`, `/feedback-threads`.

## Access model

No public tunnels. Reviewers reach the host over **Tailscale** (private WireGuard mesh, "MagicDNS" handles the hostname) or on the same **local network** (mDNS / LAN IP). If you want public access, add a tunnel of your choice (Cloudflare, ngrok, Caddy) — the server is just HTTP.

## Status

Working alpha, used for small reviews between me and my own agents. See [docs/product/vision.md](docs/product/vision.md) for the fuller problem framing and [docs/product/plans/mvp-plan.md](docs/product/plans/mvp-plan.md) for what shipped.

Current limitations:
- Plugin is installed from a local clone; not yet published. `npm link` bridges it for now. `npm publish` of the `@fryanpan/live-feedback-mcp` binary would let remote users skip the clone.
- Inline marks (bold/italic/link) round-trip as plain text through the file serializer.
- Cross-block ranges on `rewrite_thread_region` are rejected; fall back to `find_and_replace`.

## License

[MIT](LICENSE)
