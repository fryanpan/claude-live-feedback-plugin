# @fryanpan/live-feedback-mcp

Thin MCP stdio server that proxies tool calls to a running
[live-feedback](https://github.com/fryanpan/claude-live-feedback-plugin)
HTTP/WS server. Agents launch this binary over stdio; state is
authoritative in the main server.

## Installation

You don't install this directly — it's invoked by the `live-feedback`
Claude Code plugin. The plugin's `.mcp.json` resolves this binary via
the npm registry:

```json
{
  "mcpServers": {
    "live-feedback": {
      "command": "npx",
      "args": ["-y", "@fryanpan/live-feedback-mcp@latest"]
    }
  }
}
```

If you want the loop end-to-end, install the full plugin:

```sh
git clone https://github.com/fryanpan/claude-live-feedback-plugin.git
cd claude-live-feedback-plugin
bun install
bun run bootstrap
```

## What it exposes

The MCP surface is intentionally primitive — agents compose these into whatever review workflow they need. Adding a bespoke tool per integration is a smell.

**Doc state**
- `list_docs` — list all docs the server knows about (returns `reviewUrl` per markdown doc).
- `get_doc(docId)` — flat plain-text + per-block markdown + thread metadata.
- `seed_doc(docId, markdown)` — one-shot populate an empty doc.
- `attach_file(docId, path)` — bind a doc to a `.md` file on disk; bidirectional sync via `fs.watch` and debounced writes.

**Editing**
- `find_and_replace(docId, find, replace, { contextBefore?, contextAfter?, occurrence? })` — text edits across all block types including table cells.
- `rewrite_thread_region(docId, threadId, replacement)` — replace exactly the range a comment is anchored to.
- `insert_after_thread(docId, threadId, text)` / `insert_blocks_after_thread(docId, threadId, markdown)` — append after a comment's host block. Block form accepts GFM.

**Anchors (agent-issued, survive intermediate edits)**
- `create_anchor(docId, find, { contextBefore?, contextAfter?, occurrence?, label? })` — pin a position by content.
- `edit_at_anchor(docId, anchorId, { kind: 'replace' | 'insert_after', text })` — edit at the pinned position.
- `delete_anchor(docId, anchorId)` — clean up.

**Threads**
- `list_threads(docId, { status? })` — open / resolved / all.
- `get_thread(docId, threadId)`.
- `post_reply(docId, threadId, text)`.
- `resolve_thread(docId, threadId)` / `reopen_thread(docId, threadId)`.

**Channel / observation**
- `watch_doc(docId)` — subscribe to thread events; they arrive in your Claude Code session as `<channel source="live-feedback" ...>` messages via `notifications/claude/channel`.
- `unwatch_doc(docId)`.
- `list_watched_docs()`.
- `observe_url(docId)` — get the SSE URL for non-channel clients.

See [`src/mcp.ts`](https://github.com/fryanpan/claude-live-feedback-plugin/blob/main/packages/mcp/src/mcp.ts) for exact JSON schemas.

## Environment

- `FEEDBACK_BASE_URL` — defaults to discovery via `~/.claude/live-feedback/server.json` (written by the supervisor on startup), then `http://localhost:8787` as a last resort.
- `FEEDBACK_AUTHOR` — `bryan`, `agent`, or any free-form id used as the reply author.

## Channel capability

The server advertises `experimental: { 'claude/channel': {} }` and pushes thread events as `notifications/claude/channel`. Claude Code requires per-session opt-in:

```sh
claude --channels plugin:live-feedback@claude-live-feedback   # production
claude --dangerously-load-development-channels plugin:live-feedback@claude-live-feedback   # local-dev
```

## Releasing this package

```bash
# from repo root
bun run build:mcp           # → packages/mcp/dist/mcp.js
bun run publish:mcp         # cd packages/mcp && npm publish
```

The bundle is self-contained — `@modelcontextprotocol/sdk` is bundled in, runtime has zero external `node_modules` after install. Works under Node ≥ 18 and Bun.

## Local dev without publishing

```bash
cd packages/mcp
npm link
```

Makes `live-feedback-mcp` resolve on `PATH` so the plugin's `.mcp.json` keeps working while you iterate on the tool surface. Note: the `.mcp.json` shipped in the plugin uses the published-on-npm path; if you want it to use your local link instead, replace `npx -y @fryanpan/live-feedback-mcp@latest` with `live-feedback-mcp` (no args).

## License

[MIT](https://github.com/fryanpan/claude-live-feedback-plugin/blob/main/LICENSE)
