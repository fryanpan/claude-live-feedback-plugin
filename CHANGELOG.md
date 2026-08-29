# Changelog

## 0.1.0 — 2026-08-29

The first release since 0.0.2, covering about 500 commits. What was a
markdown-review widget is now a small product: a hub of workspaces where
people and Claude Code agents share a task board, a queue of things that
need a person's answer, live-transcribed meetings, and review surfaces for
docs, mockups, and dev servers.

### Renamed: live-feedback → claude-workspaces

- The plugin, the MCP server, the repo, and the copy people read are all
  called **Claude Workspaces** now (#220, #233, #237). Channel events arrive
  as `<channel source="claude-workspaces" …>`; sessions running an older
  bundle still emit `source="live-feedback"` until they restart.
- The plugin bundles its MCP server (no npm-link step), starts without
  `node` on `PATH`, and updates itself in place — any peer can call
  `request_plugin_refresh` (#35, #102, #145).

### Workspaces hub

- **Goal-governed task board.** Every board has goals in priority order;
  tasks belong to a goal band or the Backlog, and every task belongs to
  somebody. Rows carry status, assignee, dependencies, and a description
  written as a compact user story; drag to reorder, edit the title and
  description in place, park a task until a date, retire a board without
  destroying it (#112, #121, #136, #333, #319).
- **Home queue of review items.** An agent *declares* a review item —
  a decision with options, a question, a request to look — and it lands on
  the person's Home queue with a walkthrough that answers one item and
  advances to the next. The What's New brief digests recent activity;
  every item says who asked and who answered (#124, #223, #240, #254,
  #448).
- **Task detail with comments.** A task, a goal, a review item, and a note
  all take threaded markdown comments; a person's plain reply answers the
  review item it lands on. Every task, goal, item, and thread has a URL
  that works (#135, #250, #389, #418, #443).
- **Activity feed.** End-of-turn hooks post one line per agent turn (and
  per permission denial) to the agent's current task, and Home shows each
  task's recent activity (#442, #445).
- The landing page lists active workspaces and which ones are waiting on
  you; an open board notices when the server has a newer build (#209, #383).

### Meetings

- **Live transcription.** Open a doc, press one button, talk. Words land
  in a strip along the bottom of the doc as they are spoken; the transcript
  is durable (#408).
- **Pause-driven notes.** Meeting notes compose themselves into the doc at
  the natural pauses in the conversation, and saying "file a ticket for
  that" files the ticket (#410, #417). Design summary in
  [`docs/architecture/meeting-assistant.md`](docs/architecture/meeting-assistant.md).
- **Planning huddles from the board.** "New task" and "Start a planning
  huddle" quick actions on the board, with per-person washes on recently
  edited rows so a huddle can see who touched what (#450).

### Docs

- **Review docs with threads that survive edits.** Comment anchors hold
  through concurrent editing and reparse; a person's reply reopens a
  resolved thread; thread cards carry a generated summary (Haiku, opt-in)
  and a mood, and long threads open in a dialog (#63, #90, #103, #105,
  #111, #230, #306).
- **Suggested edits and redlining.** Agents can suggest rather than edit;
  suggestions render as Word-style balloons with accept/reject, and a
  diff review shows markdown changes as redlines (#66, #79, #80, #83).
- **Diff and folder review.** `create_diff_review(repo, base)` renders a
  live working-tree diff with line comments and a grouped changed-files
  sidebar; `bind_folder` scans a tree into per-file review docs with a
  CodeMirror surface for source files (#55, #59, #77, #101).
- **Mockups and dev servers.** `bind_mock` serves an HTML mockup at
  `/mockup/<docId>` with the widget injected; the widget auto-inits from
  attributes and gets a 44px touch floor; its built bundle is no longer
  committed (#14, #42, #171, #372).
- Editor: tables, links, images, nested lists, and blockquotes round-trip
  cleanly; composers are live markdown editors (#60, #64, #285, #295).

### Voice

- Hold Space to speak, anywhere on a page; a docked mic reads back its own
  dictation (#222, #304, #317).
- Voice acts on the resource in view — status, assignee, comments, review
  answers — resolves vague names by title and goals by rank, and files a
  task by talking to the board. A lookup that resolves nothing falls back
  to the lead agent (#147, #255, #438, #439, #447).

### Sharing and sign-in

- A board is the unit of sharing. Share links are signed capability URLs,
  gated at a Cloudflare edge Worker and re-checked at the app, with a TTL
  and a master switch for external access (#88, #99, #308, #424, #436).
- Email code sign-in with a name asked exactly once; sessions never expire
  but are revocable, and revocation fails closed when the denylist cannot
  be read. The mailer has per-client rate limits and hourly abuse ceilings
  (#363, #423, #427, #428, #429).
- Widget sign-in for dev-server embeds uses a session-bound, origin-bound
  token; the server stops trusting arbitrary browser origins; one stable
  identity per participant, agent or person (#96, #433, #440).

### Agent integration

- MCP tools for the board and the queue (`create_tasks`, `next_tasks`,
  `task_transition`, `add_review_item`, `answer_review_item`,
  `create_thread` / `post_reply`, `set_workspace_lead`, `share_link`) beside
  the doc-editing primitives from 0.0.x; doc watches survive a restart
  (#229, #370).
- **Stall detection and board nudges.** The server watches every open row
  and wakes the lead when ready work goes quiet, when an answer lands, or
  when an ask exists nowhere the owner reads — once per board per window
  ([`docs/architecture/stall-detection.md`](docs/architecture/stall-detection.md);
  #325, #404–#411).
- **Skills ship with the plugin.** `working-in-a-workspace` (the task
  standard, sharing progress on the board, the 50-word chat rule),
  `leading-a-workspace`, `diff-review`, `embedding-widget`,
  `editing-review-docs`, and `live-review-meeting` (#125, #272, #400).

### Delivery

- `POST /api/deploy` pulls, restarts, and records the release; prod serves
  an immutable client build and a healthy restart cannot republish a stale
  one (#119, #198, #338).
- `bun run staging` runs a branch on its own port with throwaway data.
- CI gates the plugin version: a plugin PR must move the version past
  `main`, two open PRs cannot claim the same number, and the tracked MCP
  bundle is rebuilt and checked for drift (#102, #191, #341).
- A pre-push leak gate (regex denylist plus a Haiku pass) scans everything
  before it leaves the machine (#30, #113, #399).

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
