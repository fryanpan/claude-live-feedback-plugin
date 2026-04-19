# claude-live-feedback-plugin

## Goal

Make giving feedback to LLM agents as fast as pointing and saying "this." So fast that you and the agent can iterate on a piece of work in real-time, the way two co-located engineers would.

See [docs/product/vision.md](docs/product/vision.md) for the full problem and the three surfaces this project is building (markdown/diagram review, UX mockup review, live dev-server review).

## Status

MVP in review. Design spec at [docs/superpowers/specs/2026-04-17-live-feedback-design.md](docs/superpowers/specs/2026-04-17-live-feedback-design.md); plan at [docs/product/plans/mvp-plan.md](docs/product/plans/mvp-plan.md).

Stack: TypeScript + Bun, Yjs over WebSocket, vanilla Custom Elements + Shadow DOM for the injectable widget, Tiptap (ProseMirror) + y-prosemirror for the WYSIWYG markdown surface.

**Access model:** no public tunnels. The host machine exposes the
feedback server on `localhost:<port>`; reviewers open it via the host's
**Tailscale** hostname (private network) or its `.local` / LAN IP
(same-wifi devices). `bun run scripts/serve.ts` prints all three URLs.
Public access is an explicit opt-in users would layer on themselves.

## License

[MIT](LICENSE)
