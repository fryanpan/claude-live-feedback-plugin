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

`list_docs`, `list_threads`, `get_thread`, `post_reply`,
`resolve_thread`, `reopen_thread`, `push_edit`, `observe_url`.

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
