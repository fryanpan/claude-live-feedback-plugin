# @fryanpan/live-feedback-mcp

Thin MCP stdio server that proxies tool calls to a running
[live-feedback](https://github.com/fryanpan/claude-live-feedback-plugin)
HTTP/WS server. Agents launch this binary over stdio; state is
authoritative in the main server.

## Installation / usage

You don't install this directly — it's invoked by the
[`live-feedback` Claude Code plugin](../plugin/) through `npx`. The
plugin's `.mcp.json` contains:

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

## Tools exposed

Doc state: `list_docs`, `get_doc`, `seed_doc`, `attach_file`.

Editing:
- `find_and_replace`, `rewrite_thread_region`,
  `insert_after_thread`, `insert_blocks_after_thread`,
  `create_anchor` / `edit_at_anchor` / `delete_anchor`.
- `delete_block_at_anchor` — remove the block an anchor points at.
- `delete_blocks_in_range` — remove every top-level block between two
  find strings (block-inclusive — partial match deletes the whole
  containing block).
- `delete_section` — heading-aware: remove a heading plus everything
  until the next heading at ≤ same level.

Threads: `list_threads`, `get_thread`, `post_reply`, `resolve_thread`,
`reopen_thread`.

Channel / observation: `watch_doc`, `unwatch_doc`,
`list_watched_docs`, `observe_url`.

See source at [`src/mcp.ts`](src/mcp.ts) for the exact JSON schemas.

## Environment

- `FEEDBACK_BASE_URL` — defaults to `http://localhost:8787`
- `FEEDBACK_AUTHOR` — `bryan`, `agent`, or any free-form id

## Release

```bash
# from the repo root
bun run build:mcp           # builds packages/mcp/dist/mcp.js
bun run publish:mcp         # cd packages/mcp && npm publish
```

The bundle is self-contained (no runtime node_modules). Works under
Node ≥ 18 and Bun.

## Local dev without publishing

```bash
cd packages/mcp
npm link
```

This makes `npx @fryanpan/live-feedback-mcp` resolve to your local
workspace, so the plugin's `.mcp.json` keeps working while you iterate
on the tool surface.
