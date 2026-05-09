# Changelog

## 0.0.2 — 2026-05-09

### New

- **Cloudflare Access Share** — publish any review surface to an external team for a bounded TTL window. New MCP tools `share_doc` / `list_shares` / `unshare`, a `/feedback-share` slash command, and a thin `bun share` CLI. The server gets per-host JWT verification (audience resolved from the share registry) so each share-`<slug>` subdomain has its own AUD. Default TTL 72h. See [`docs/product/sharing.md`](docs/product/sharing.md) for setup. Markdown surface only in this release; `share_site` (dev server) and `share_mockup` (static HTML) are scoped for the next pass.
- **Block-deletion API** — three new MCP tools that fix the "no way to remove a whole block" gap (which previously forced agents into 12-call `find_and_replace` cleanups that left empty-paragraph residue):
  - `delete_block_at_anchor(docId, { threadId | anchorId })` — remove the block an anchor points at.
  - `delete_blocks_in_range(docId, startFind, endFind, …)` — remove every top-level block from start to end. Block-inclusive: a partial match deletes the whole containing block.
  - `delete_section(docId, heading, { level?, occurrence? })` — heading-aware: remove a heading + every following top-level block until the next heading at level ≤ that heading's.

### Improved

- **Mobile** — markdown app is responsive end-to-end: sidebar gating, prose breakpoints, mobile dropdown for set-grouped docs, root-cause CSS Grid overflow fix (`minmax(0, 1fr)`), tighter typography, design guidelines codified in [`docs/product/design-mobile.md`](docs/product/design-mobile.md).
- **Editor** — back link from `/review/<docId>` to landing, richer landing list with open-count badges + last-activity sort.
- **Server** — persists Yjs rooms across restart; new rooms flush to disk immediately.
- **Core** — YAML frontmatter round-trips cleanly through Yjs (no more drifting blank lines).
- **Widget** — resolved threads hide by default (both pins and panel list) with a toggle.

### Plugin / fleet

- New `claude-hive-peer` rule: the plugin onboards as a peer when running in the claude-hive network (`set_summary` on startup, `to_stable_id` for messaging, channel-message handling).
- New `LLM Turn Efficiency` conventions in `workflow-conventions.md` (batch tool calls, combine comms with work, chain bash with `&&`, prefer dedicated tools over CLI).
- `ticket-agent` skill removed (superseded by claude-hive peer protocol).
- `live-feedback-default` rule, `public-content-scrubbing` rule, `security-posture` rule, `ship-it` skill added (template propagation).
- `editing-review-docs` skill: documented the `find_and_replace` empty-block gotcha (replacement that empties a containing block leaves the empty block behind — clean up at swap time, or use the new block-deletion API).

### Docs

- README voice-passed end-to-end (Bryan's voice, dropped strawman placeholders, install section reformatted with proper code fences).
- New `docs/product/sharing.md` walkthrough for the share feature.
- New `docs/product/decisions.md` entry overriding the 2026-04-19 "no public tunnels" stance for the explicit-share use case (default access remains Tailscale/LAN).

## 0.0.1 — 2026-04 (initial MVP, never formally tagged)

- Markdown review surface: Tiptap + Yjs WYSIWYG editor, file-backed (`create_review_doc(docId, path)` is the canonical creation path), bidirectional disk sync via `fs.watch` + debounced 800ms write-back.
- Comment threads with text-range + element anchors that survive concurrent edits.
- MCP server with the editing primitives: `find_and_replace`, `rewrite_thread_region`, `insert_after_thread`, `insert_blocks_after_thread`, `create_anchor` / `edit_at_anchor` / `delete_anchor` / `insert_blocks_at_anchor`, `reparse_from_disk`.
- Claude Code channel integration: thread events arrive as `<channel source="live-feedback" ...>` messages.
- Injectable widget: vanilla web component (Shadow DOM), one `<script>` tag drops comment threads onto any HTML page or dev server.
- Slash commands: `/feedback-serve`, `/feedback-threads`.
- Pre-tool-use hook auto-approves preview navigation to trusted hostnames.

## License

MIT — see [LICENSE](LICENSE).
