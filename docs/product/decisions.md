# Product Decisions

Big decisions that future sessions should respect or revisit deliberately.

## 2026-04-17 — Public repo, branch protection on main
- All changes via PR, even single-file fixes.
- Bryan authorized public visibility because the tool is broadly useful (similar to notion-channel-mcp, github-claude-channel).

## 2026-04-17 — Lightweight widget injection
- The widget that ships into mockups and dev servers must be vanilla JS / web components only.
- Reason: it has to inject into anyone's site without conflicting with their framework choice.
- Bundle size is a hard constraint — measure and report on every PR that touches widget code.

## 2026-04-17 — Server stack: TypeScript + Bun
- Same pattern as notion-channel-mcp and github-claude-channel.
- No public tunnel. The server binds to localhost; reviewers reach it
  over the host's Tailscale or LAN hostname. See the 2026-04-19 entry
  below.

## 2026-04-17 — Realtime collaboration framework: Yjs
- Chosen over Liveblocks (SaaS lock-in), Automerge (weaker editor ecosystem), and building minimal (NIH).
- Transport: y-websocket over the project's Bun server (not a separate y-websocket-server process — we own the WS endpoint).
- Persistence: Yjs docs serialized to `data/<docId>.ydoc` on disk. Crude but works for MVP.
- Editor binding: y-codemirror.next for Surface 1's markdown editor.
- Revisit if: (a) Yjs alone blows the widget bundle budget beyond recovery, or (b) we need auth semantics Yjs can't represent naturally.

## 2026-04-17 — Widget runtime: Vanilla Custom Elements + Shadow DOM (no Lit)
- Confirmed over Lit (even though Lit is tiny). CLAUDE.md's "no framework deps" rule applies to the widget; vanilla is the safest interpretation.
- If DX hurts badly once we're mid-build, revisit — Lit would be an acceptable fallback with a small bundle hit.

## 2026-04-17 — Anchor strategy: layered
- Text-range anchors use Yjs `RelativePosition` — auto-adjusts across edits, free with the CRDT.
- Element anchors use a multi-attribute fingerprint scored against DOM (port of the health-tool algorithm, score ≥40/100 required).
- Broken anchors → Orphan panel. Users re-anchor by clicking a new target.
- Explicitly rejected: semantic/AI reanchoring (overkill for MVP), pure CSS selector (fragile), pure pixel coords (fragile to layout).

## 2026-04-17 — Linear / ticket integration is host-side
- This repo ships a generic webhook dispatch. The integrating project (health-tool, family-bike-map, whatever) supplies a URL and handles Linear/other side-effects there.
- Reference implementation lives under `cookbook/` — not imported by core, just copy-paste fodder.
- Reason: different projects have different ticket workflows; keeping this repo opinion-free makes it reusable.

## 2026-04-17 — Identity model for MVP
- `?as=bryan` and `?as=agent` query params pick a known identity.
- No param → `Anon-<short-random>` stored in localStorage.
- No real auth. Security boundary is Tailscale (only tailnet members
  can reach the host) or the LAN (only same-wifi devices). Shared-link
  obscurity within that boundary is fine.

## 2026-04-17 — Widget bundle budget: 40 KB gzipped
- Enforced via `scripts/check-widget-size.js` in CI. Builds fail above the limit.
- Yjs alone is ~40KB; we may need to split Yjs out as a CDN peer-dep if the budget breaks. Document the break rather than silently exceeding.

## 2026-05-07 — Cloudflare Access share for explicit external-team review (overrides the 2026-04-19 stance for this case)
- Default access remains Tailscale/LAN (the 2026-04-19 decision below
  still holds for normal review). What's new: an explicit, agent-driven
  publish step (`share_doc` MCP tool / `bun share` CLI) that creates a
  per-share Cloudflare Access app gated by email domain (e.g.
  `@partner-org.example`) for a bounded window (default 72h).
- Driver: Bryan started working with an external team that doesn't share
  a tailnet and needs to review markdown docs / interactive mockups /
  dev servers for a few days at a time. Adding everyone to the tailnet
  is the wrong tool for ephemeral external review.
- Architecture: MCP-first (the share command runs against the
  long-running live-feedback server, not as a foreground bun process);
  cloudflared runs as a launchd service alongside the existing
  notion-bridge / sentry-bridge tunnels; per-repo team config in
  `.claude/live-feedback.json`; TTL-based persistent shares with
  manual `unshare` for early teardown.
- See `docs/product/plans/cf-access-share-plan.md` for the plan and
  `docs/product/sharing.md` for the user-facing guide.

## 2026-04-19 — Access model: Tailscale or LAN, no public tunnels
- The feedback server binds to `localhost:<port>`. Reviewers reach it
  via the host's Tailscale hostname (e.g. `<host>.ts.net`)
  or its `.local` / LAN IP on the same wifi.
- `bun run scripts/serve.ts` prints all three URL forms on startup.
- Rejected: Cloudflare Tunnel (added complexity — named tunnel,
  DNS zone, cert, a local reverse-proxy router — for a private preview
  use case that doesn't need public-internet reachability). The
  trade-off is that reviewers must be on the tailnet or same LAN.
- Team expansion path: add teammates to the same Tailscale tailnet.
  No code changes needed; `serverUrl` is already a hostname the widget
  uses as-is.
- Public exposure remains an explicit user opt-in they can layer on
  themselves (tunnel, reverse proxy, whatever) — outside this repo's
  scope.

## 2026-04-19 — Editor: Tiptap (ProseMirror) + y-prosemirror, not CodeMirror
- Initial MVP used CodeMirror 6 + y-codemirror.next with a split raw /
  rendered preview. Bryan asked for WYSIWYG markdown on the first
  review pass — editing the rendered output directly, with standard
  keyboard and toolbar interactions for headings/lists/etc.
- Switched to Tiptap 3 with StarterKit (headings, lists, blockquote,
  inline code, code blocks, link) + tiptap-markdown for import/export
  + @tiptap/extension-collaboration for Yjs sync.
- Content storage moved from `Y.Text content` to
  `Y.XmlFragment prose`; legacy docs are migrated on first open via a
  `meta.seeded` sentinel so we never double-seed across reloads.
- `ySyncPluginKey` must be imported from `@tiptap/y-tiptap`, NOT from
  `y-prosemirror` — Tiptap's Collaboration extension registers its
  plugin under the @tiptap/y-tiptap key, and using y-prosemirror's
  gets a different key instance, so getState() always returned
  undefined and the Comment button always reported "no selection".
  This footgun cost two debug sessions; noting for future sessions.

## 2026-06-06 — Concurrent-edit safety: merge (CRDT) + non-destructive disk reconcile
- A peer reported an agent's `find_and_replace` clobbering a human's
  in-progress browser edits on a bound doc. Root-cause investigation
  showed the in-memory path is already safe: every agent edit
  (`findAndReplace`, `rewriteRange`, `insertAfterRange`,
  `insertBlocksAfterAnchor`) runs as a targeted Yjs transaction on the
  same live doc the browser syncs to, so concurrent edits CRDT-merge —
  they do not overwrite. Pinned by a ws.test.ts test (browser edits one
  paragraph while the agent rewrites another; both survive on disk).
- Chose **merge over lock/reject** for the agent-vs-human contract.
  Locking or reject-on-conflict would fight the product's core goal
  (real-time co-editing); CRDT merge already delivers it.
- The real server-side data-loss vector was `reconcileFromDisk`, which
  destructively replaced the whole live fragment whenever the file
  diverged on disk — clobbering un-flushed live edits if an external
  write collided with them. Centralized the policy in a pure, unit-tested
  `decideReconcile()`: when an external change collides with un-flushed
  live edits, **keep the live edits** (the editor is the runtime source of
  truth) and reassert them to disk; record a `syncError` so the dropped
  external change is observable and recoverable via `reparse_from_disk`.
- Nested-list serialization uses a **2-space-per-level indent** convention,
  read back by leading-space count, so the serialize→parse round-trip is
  lossless. Picked 2 spaces (vs 4) to match the editor's typical output;
  the parser accepts any indentation increase as a deeper level so
  human-authored 4-space markdown still nests correctly.

## 2026-07-10 — Editor link-open (Cmd+Click) + table editing UI
- **Links stay non-navigable on a plain click** (`openOnClick:false`) so the
  cursor can be placed inside a link to edit it; a **Cmd/Ctrl+Click opens** the
  link in a new tab instead. Bound as a DOM `click` listener on the editor view
  (works in both edit and view mode) rather than via the Link extension's
  built-in open, which has no modifier-gated mode. Script-bearing schemes
  (`javascript:`/`data:`/`vbscript:`) are filtered by a pure `safeLinkHref()`;
  everything else (http(s), mailto, tel, relative, anchors) opens.
- **Table create/edit uses `@tiptap/extension-table` (prosemirror-tables)** —
  the framework was already a dependency and wired into the editor; only UI was
  missing. Per Bryan's constraint we did NOT hand-roll a table engine. Added a
  `▦` format-bar button opening a contextual popover: "Insert table" (3×3 with
  header row) always, plus row/column add + delete-row/column/table when the
  cursor is inside a table. Items come from a pure `tableMenuItems(inTable)`
  helper; each dispatches the matching Tiptap chain command. The popover is a
  fixed-position element in `<body>` so it escapes the format bar's
  `overflow:hidden`. Tables round-trip to disk as GFM via the existing
  `serializeTable`/`mkTable` path in `packages/core/prose.ts`.

## SPA navigation: MountScope.listen() over raw `{ signal }` (2026-07-17)

- **Decision:** `MountScope` exposes a `listen(target, type, handler, opts)`
  helper that registers the DOM listener with `{ signal }` AND records an
  explicit `removeEventListener` cleanup, rather than the plan's original
  "register listeners with `{ signal: scope.signal }` directly."
- **Why:** The test env (happy-dom 15.11.7) ignores `options.signal` in
  `addEventListener` (`EventTarget.js` only reads `once`/`capture`), so
  signal-based teardown is untestable there — and Tasks 3/5/6 tests all assert
  "no fire after dispose." Upgrading happy-dom risks a ripple across 27 test
  files. The helper makes teardown work identically in happy-dom, old browsers,
  and modern ones; the redundant remove is a harmless no-op where the signal
  already fired. `signal` stays public for fetch/AbortController-aware libs.
- **Impact:** Every per-doc listener in Tasks 3/5/6 uses `scope.listen(...)`
  instead of `{ signal: scope.signal }`. Reversible.

## SPA navigation: single setActiveFile in diff-nav.ts (2026-07-17)

- **Decision:** `setActiveFile(docId)` lives only in diff-nav.ts (not also
  workspace-tree.ts as the plan's Task 4 listed). The router imports it from
  there.
- **Why:** Both nav surfaces render into the SAME containers (#set-pane-list
  and the mobile #doc-menu) with the same `/review/<docId>` href shape, so the
  active-marker move is one identical DOM operation. Duplicating it (or
  re-exporting) adds code without behavior. It also no-ops when the target
  docId isn't present, so it's safe to call regardless of which surface
  rendered the tree.
- **Impact:** Reversible. If the two surfaces ever diverge in container/href
  shape, split then.

## 2026-08-03 — Diff-review live editors: companion doc for `.md`, editable flat for code

Chose approach C (companion `type:'markdown'` doc per changed `.md` member +
editable flat `content` for code members) over flipping member doc types or
dual-surface docs. Rationale: `contentKind` drives every server branch
(`get_doc`, thread find paths, reconcile), so changing a member's type
silently rewires the agent API and orphans content-offset threads; a
companion doc reuses the whole prose sync stack and the only new machinery —
flat write-back with a conflict arm — is required for code editing anyway.
`.md` members do NOT get flat write-back (single-writer per file: edits flow
through the companion doc). Reversible; revisit if the two-doc UX confuses.

## 2026-08-17 — A task's discussion keeps threading, and has exactly ONE composer

**The report.** Bryan: *"why do I have two reply boxes at the bottom of each
task…are we supporting threaded replies unnecsarily?"* He was right about the
surface: `renderDiscussion` appended a reply box inside every thread and then a
new-thread box under all of them, so the ordinary single-thread task ended in
two stacked boxes whose only difference was placeholder text. N threads meant
N+1 boxes.

**What reproducing changed.** The premise that threading on a task is
decorative did not survive contact with the board. Measured across all 96 tasks
in this workspace:

| | count |
|---|---|
| tasks with 0 threads | 62 |
| tasks with exactly 1 thread | 32 |
| tasks with 2 threads | 2 |
| tasks with 3+ threads | 0 |
| **task threads that are `text-range`-anchored, with a snippet** | **34 of 37** |
| task threads that are `subject`-anchored | 3 |

So multi-thread tasks are rare — but threads that point at a specific passage
of the description are the overwhelming norm, because that is what an agent's
`create_thread(docId: 'task:<id>', find: …)` produces. Only the browser's own
"start a thread" path writes `anchor: {kind: 'subject'}`, and it accounts for
all three of the unanchored ones. Task threads were doing exactly what document
threads do; **the surface was throwing the anchor away** and then asking the
reader to disambiguate piles it had just made indistinguishable.

**Decision: option 2 — keep threading, make one composer.** Rejected:

- *One flat conversation per task.* It reads as the simplest answer only while
  you believe the threads are arbitrary. It would flatten 34 anchored threads,
  discard an anchor an agent set deliberately, and change what `resolve_thread`
  means on a task from "this point is settled" to "this task's whole discussion
  is settled" — a store-model change smuggled in behind a UI fix.
- *Differentiate the labels.* Accepts N+1 boxes and tries to fix them with
  words, which is the state that was just described as oddly complex.

**What ships.** Each thread quotes the passage it is anchored to and carries a
`Reply` button that points the single composer at it. The composer sits at the
bottom and names its target above the box (`Replying to "…"` / `Starting a new
thread`), with `New thread` to switch away. The default target is the queue's
aim if there is one, else the last thread on screen — which on the common
single-thread task is the only reply anyone means, and makes that case behave
exactly as it did minus the second box.

**Nothing in the store changed.** No route, no anchor kind, no thread model.
Agents still post through `create_thread` on `task:<id>` and their threads
render better, not differently. Resolved threads stay visible and stay
replyable — that visibility is deliberate, and hiding a thread with an
unread reply in it is a bug this project has already shipped once.

Reversible. **If you are about to add a second always-present composer, this is
the state it produced.**

## 2026-08-17 — A workspace is the unit of sharing; per-doc sharing is removed

**Decision (Bryan, verbatim):** "Remove all code for sharing docs, reviews and
so on individually. Share a workspace. And for anything already shared, please
work with owning agent to attach it to a workspace or work with the agent to
wind down the share."

**What went:** the `share_doc` MCP tool, `POST /api/share/doc`, `share_link`'s
`docId` argument, `Shares.createShareDoc`, `CreateShareDocReq`, and
`ShareSurface`'s `'doc'` member. `Share.workspaceId` is now required, and
`shareScopeAllows` refuses everything — including the app shell — for a target
that names no workspace. The "target.docId is always in scope" base case in
the gate WAS the per-doc grant; removing it is what makes the removal
structural rather than cosmetic.

**What stayed, and why it is not per-doc machinery:** visitor identity, the
private-meta sidecar and `redactMetaForVisitor`, `redactHubEvents`, the
Access-mode gate and `cf-api`, TTL enforcement, `link-session`, the
`sharing.json` master switch, `set_share_ttl` / `unshare` / `list_shares` /
`set_sharing_enabled`. Every one of them is needed *more* by workspace
sharing, which reaches more content per grant. They sit in
`packages/server/src/share/` because that is where sharing lives, not because
they were doc-scoped.

**Nothing had to be wound down.** Measured before removing anything: prod's
`data/shares.json` was `[]`, `sharing.json` was `{"enabled": false}`, and the
launchd service sets only `CF_SHARE_PUBLIC_HOSTNAME` — no `CF_ACCOUNT_ID` or
`CF_ACCESS_TEAM_DOMAIN`, so `cfApi` is null and no Cloudflare Access app could
ever have been created to outlive the local registry. The registry file is the
only place a share was ever persisted.

**Legacy records are dropped, not honoured.** `Shares.load` filters out any
record with no `workspaceId` and rewrites the file, because the gate reads the
registry rather than the code that wrote it — removing the mint path alone
would have retired the feature everywhere except where it is exercised.

**Older callers get a sentence, not a 404.** Every peer keeps calling the
shared `:8787` routes with the payload ITS bundle sends. `POST
/api/share/doc` and a `docId` in `POST /api/share/link` both answer 410
`per_doc_sharing_removed` with the replacement named. The guard tests for the
`docId` KEY rather than a truthy value, because the old bundle sends the same
five-field body for a workspace share with `docId: undefined` — which
`JSON.stringify` drops, so an old peer's workspace shares keep working.

**Not settled here, deliberately:** whether a folder bind / diff review
*grouping* counts as a "workspace" for sharing, or whether only a hub board
does. The product's own vocabulary calls groupings "doc groupings" and
reserves "workspace" for a hub board, which would read "reviews … individually"
as covering them too — but that change requires every review to be reachable
through a board first, and that is a product prerequisite rather than a
deletion. Tracked separately.

## 2026-08-21 — Serialization churn: the normal form is the contract; churn is one-time, not prevented

Ask 5 of the mechanical-edits task: write-back reflows line
wraps (a one-entry insert produced a +26/-47 diff), and a table nested under a
bullet flattens on round-trip. The asks were stable serialization, or
warn-or-refuse on structures the round-trip cannot preserve.

**Decision: defer stable serialization; document the normal form as the
contract; known-lossy constructs are named below. A cheap warn flag is
follow-up work, not part of this decision. Refuse-on-lossy is rejected.**

**Why stable serialization is a rewrite, not a fix.**
`serializeFragmentToMarkdown` (`packages/core/src/prose.ts:1492`) emits a
normal form — one line per paragraph. Soft line wraps are not represented in
the ProseMirror/Yjs schema at all, so "preserving" them is not a serializer
option: it means changing the schema, the parser
(`parseMarkdownBlocks`, prose.ts:1135), the serializer, AND the editor
round-trip together. That is a project, and one whose payoff is cosmetic diff
noise on the first edit only.

**Why the churn is one-time.** The hydrate path
(`packages/server/src/rooms.ts:1709-1730`) already recognizes "pure
normalization drift" — a disk file that parses to exactly the live doc — and
deliberately leaves the original disk bytes untouched until a real edit
happens. So a never-edited bound doc pays nothing, and the +26/-47 reflow is
the one-time normalization any hard-wrapped doc pays on its FIRST real
write-back. After that, the doc is in normal form and subsequent diffs are
minimal.

**Known-lossy constructs (documented, not prevented):**
- Soft line wraps: reflowed to one line per paragraph on first write-back.
  Content is preserved; only wrapping changes.
- Tables nested under list items: `serializeList`'s continuation branch
  (prose.ts:1812) CAN emit an indented table, but `parseMarkdownBlocks`
  cannot re-parse an indented table inside a list item — so the next
  round-trip flattens it. This is a parse-side gap; a fix would live in the
  parser, and is not scheduled.

**Refuse-on-lossy is rejected** because it would block binding exactly the
docs people most want reviewed — real-world markdown is hard-wrapped and
list-heavy. A refusal converts cosmetic churn into a hard workflow stop.

**Follow-up (cheap partial, not implemented here):** at bind time, compute
`willReflow = prose.normalizeMarkdown(diskText) !== diskText` — the exact
comparison hydrate already performs — stash it on the file binding, and
surface it in the `create_review_doc` response and the `doc_status` payload
with a one-line note ("first write-back will reflow line wrapping; content is
preserved"). That turns the surprise into a heads-up for the cost of one
string compare that already runs.

**What would change the decision:** churn that is NOT one-time (a doc in
normal form still producing spurious diffs — that would be a bug, not this
decision); a reviewer workflow where the first-edit diff noise blocks review
(e.g. diff-review over a bound doc where +26/-47 buries the real change); or
the table-under-bullet flatten hitting real docs often enough that the
parse-side fix pays for itself.

## 2026-08-25 — Unfiled-ask counter: the audit's published number, not a live measurement

The per-session-usage task asked for a per-session number an agent can query about
itself: asks that appeared in chat without a matching filed review item. Two
open questions were left to the implementer; both calls below are reversible.

**Where the counter lives: server-side, as published audit output.** The
server cannot see chat — chat happens in each session's terminal, and the
server sees only MCP tool calls and browser events. The only party that can
judge "an ask appeared in chat without a matching review item" is the daily
chat audit, an agent that mines `~/.claude/projects/**/*.jsonl` transcripts.
So the audit is the single writer (`publish_chat_audit` →
`POST /api/chat-audit`) and a session's self-query
(`get_unfiled_ask_count` → `GET /api/chat-audit/<agent>`) reads the same
stored row back. One number, one implementation — the done criterion "the
daily audit references the same number" is satisfied structurally, because
there is no second computation to drift. The honest cost, stated in the tool
description rather than hidden: freshness is audit cadence, not real time,
and `today: null` means "no audit has covered today yet".

A live server-side counter was rejected as a fiction: it would require the
server to read host-local transcript files and classify asks — a new NLP
layer the task explicitly ruled out, coupled to one machine's paths, and
still blind to compacted sessions.

**What counts as an ask: the audit's current heuristic, unchanged.** The
server validates shape (non-negative integer, a real agent name, YYYY-MM-DD
day) and stores what the audit judged. No server-side ask classifier exists
or is planned.

**Mechanics.** Append-only JSONL at `<dataDir>/chat-audit.jsonl`
(`packages/server/src/chat-audit.ts`), matching the activity.jsonl pattern:
corrections are new rows, latest row per agent wins, nothing is rewritten —
soft-delete compliant. Rows are keyed by display name (CW_AGENT_NAME),
normalized case/whitespace-insensitively, because that is the one identity
the transcript-reading audit and the env-reading MCP session both hold; the
bare name "agent" is refused, same as task ownership. `day` uses the
server's local calendar (audit, sessions, and server share one machine).

**What would change the decision:** the audit gaining a code heuristic (then
the server could run it and the counter could go live-ish); a fleet spanning
machines (then per-machine local-day and transcript paths both break); or
per-session attribution mattering more than per-agent (rows already carry an
optional `sessionId` — the read would grow a filter, not a new store).

## 2026-08-29 — Status lives on the task's Activity tab; comments are for asks and replies

Bryan, 2026-08-29: *"let's get status updates off the comment feed and into
the activity tab instead — there's too much crap in the comments"*, and the
task's Activity tab should be *"all task events as well as agent end of turn
updates in one feed"*, showing *"the full end of turn update instead of short
versions"*. Four reversible calls, shipped together on `feat/activity-feed`:

1. **`TaskNote.kind` gains `'status'`** beside `turn` and `denial` — an
   explicit milestone an agent posts with the new `post_status(text,
   taskId?)` verb (`POST /api/tasks/:id/notes`, or `/api/agent-notes` to
   pin it to the current in-progress row). Same store, same cap, same
   projection; nothing new to rebuild analyses from.
2. **Notes feed the stall clock, not the board trail.** `keep-moving.ts`
   counts a task's newest note (any kind) as movement, read from
   `task.notes` directly. `task.noted` stays OUT of the workspace event
   stream and IN the hub's `TRAIL_NOISE`, so the board-wide trail stays
   quiet; only the task's own Activity tab renders notes. The ready-idle
   board clock is untouched — a note is the session talking, not the board
   moving, and that wake exists to catch exactly that.
3. **The Stop hook posts the FULL end-of-turn message**, scrubbed the way
   the one-liner was (markdown kept; every line reduced: URLs → `[url]`,
   hosts/paths → basename or `[url]`, token prefixes and Bearer →
   `[token]`, emails → `[email]`; fences kept but reduced line by line);
   `NOTE_TEXT_MAX` rises 2000 → 4000 with an ellipsis on the cut. Behind
   the named shapes sits a catch-all (security review, 2026-08-29): a 20+
   alphanumeric run with 3+ digits, a 32+ base64 word with `/` or `+`, and
   the value of any secret-named key or assignment (`DB_PASSWORD=`,
   `api_key:`, `authToken=`) come out as `[redacted]`; a token split over a
   line break is reduced on both halves; blank lines inside a fence are
   kept. The Home activity pane shows only a note's first prose line (200
   chars); the full text is on the task's Activity tab, which takes phrase
   comments like a doc.
4. **Status replaces progress comments.** The skills, the hive-peer rule and
   the keep-moving protocol now say: status goes through `post_status` or
   arrives by itself from the hook; a comment (`post_reply`,
   `create_thread`, a review item) is an ask, a decision, or a reply to a
   person.

**What would change the decision:** notes needing to reach the lead as
events (then `task.noted` joins the stream with its own noise class); the
4000-char cap clipping reports people actually read on the tab (raise it,
or fold); or the stall clock counting a chatty-but-stuck agent as moving
(then only `status` notes count, and the hook's turn notes go back to being
telemetry).

## 2026-08-29 — A repeated auto-mode denial becomes ONE allow-rule review item; nothing writes settings

Auto mode re-blocks the same command after every chat approval, so the
third `git push` block in a week is the first one again. The plugin's
PermissionDenied hook already posts each block as a `denial` note carrying
only the command's shape, and the pane shows it; what was missing was the
exit from the loop. Reversible calls, all in `packages/server/src/allow-rules.ts`:

1. **Threshold 3 in 7 days, per (agent, shape).** `ALLOW_RULE_THRESHOLD` /
   `ALLOW_RULE_WINDOW_MS`. One denial is a slip, two a coincidence, three a
   loop. Counted from a tally the server keeps beside the workspace files,
   not from either copy of the note: the per-agent ring is in-process,
   capped at 20 notes of every kind and gone on restart, and the task notes
   are capped at 200 per row from the old end — a busy row posts a turn
   note every turn, so a week's denials on a chatty task can be evicted
   before the third arrives (codex review caught this on the first cut).
2. **One `decision` item per pair, on the task the third denial landed on.**
   Headline `Allow "<shape>" for <agent> without asking?`; detail says what
   was blocked, how often, on which tasks, and carries the paste-ready
   `{ "permissions": { "allow": ["Bash(<shape>:*)"] } }` for
   `~/.claude/settings.json` or the repo's `.claude/settings.json`, plus one
   sentence on what it does NOT unlock. A non-Bash tool proposes the tool
   name; the bare `Bash` shape (a command the hook could not reduce) proposes
   nothing, because `Bash` alone would allow everything.
3. **Dedupe and the `never` answer are read from the item itself.** The
   sidecar (`<dataDir>/allow-rule-proposals.json`) holds each pair's denial
   timestamps inside the window and which item was last filed; whether that
   item is still open, or was answered "Never propose again", is read from
   the review item — one record, the one a person touched. After "Keep
   blocking" the tally restarts at the answer, so the question returns only
   after three blocks the person had not yet seen.
4. **No code path writes a settings file.** The rule is text in the detail;
   pasting is the person's act, and an agent asked to do it says no. That is
   what keeps "truly dangerous commands still stop" true.

`docs/architecture/stall-detection.md` is unaffected: a filed item is an
ordinary review item to the stall clock, and a denial note already counted
as movement before this.

**What would change the decision:** the threshold proving noisy (raise it,
or widen the window); a person wanting the rule applied for them (that is a
product decision about who holds the allowlist, not a bug here); or the
sidecar and the items drifting (then the sidecar goes and the pair is found
by scanning the items' headlines).

## 2026-08-29 — Review items pass a quality gate; a hold is pending, never a refusal

Bryan, 2026-08-29: *"Don't refuse, but let's have a criteria for what makes
a good review item. Something we can change in the settings. It's a natural
language prompt. If the review item an agent adds is not good enough, make
the item pending. Let the agent know they should edit it. And include this
in the stall monitor. If a review item's been unacceptable for more than 5
minutes. Complain."* The criteria are a per-workspace string
(`reviewItemCriteria`, default in `packages/core/src/review-judge-prompt.ts`:
headline in the reader's words, stakes and what to look at, a cost on every
option, links inline, no raw ids or acronyms), read and written through
`PUT /api/workspaces/:id/settings` and the `set_review_item_criteria` tool.
No hub text field: the settings UI has only a select and a checkbox today,
and a textarea pattern is its own piece of work. Reversible calls:

1. **A judge failure is a pass.** No key, `CW_REVIEW_GATE=0`, timeout
   (8s), HTTP error, or an unparseable reply all record
   `verdict: 'unavailable'` and let the item through, logged once per cause.
   The gate exists to raise the floor on asks; an outage that stopped
   agents filing asks would cost more than every bad item it ever caught.
   One call, no retries — a retry doubles the latency on the filing path
   for the case where the answer is "pass anyway".
2. **Held is not open — and neither is "being judged".** `reviewState.open`
   and the Home queue both exclude held items, so the answerable count, the
   brief, and the review strip are right by construction rather than by a
   second filter. The item is stamped `pending` before the judge is asked,
   so the seconds the call takes are not seconds the reader can answer an
   item about to be held; a `pending` found on disk at boot becomes
   `unavailable` (a call nobody will answer is a judge failure, rule 1). The item stays on
   the ticket with the judge's reason ("Held: … — the agent has been asked
   to revise"), because the reader should see that a question is coming.
2b. **The criteria live in the settings panel, and the reader can overrule
   the judge.** Both were missing when the gate first shipped, and a UX
   review on staging caught them: the prompt every agent was measured
   against was reachable only from an MCP tool and a raw PUT, and the held
   note had zero interactive elements against the answerable card's two.
   The panel now carries the prompt as an editable multi-line field showing
   the default when unset (`review-criteria.ts`), and the note carries
   "Ask me anyway" (`…/release`), which records an `ok` verdict naming the
   person rather than inventing a fourth verdict — a release IS a pass, on
   the reader's authority instead of the judge's, and everything downstream
   already knows what a pass means. A failed READ of the criteria disables
   the field rather than emptying it: an empty box a reader then saves
   would write empty criteria over the board's real ones.
3. **Five minutes, then one complaint per item.** `CW_HELD_ITEM_MINUTES`
   (default 5, Bryan's number). Past it, the filer is nudged once per item
   per server process and the lead's `workspace.stalled` frame carries the
   item; the item's ticket enters the stall stamp so nothing re-fires on
   the next pass. Revise-and-pass clears both; a fresh hold on the same
   item is nudged afresh.
4. **The summarizer's key is the judge's key.** Same Keychain entry, same
   consent class: what leaves the machine is text an agent already wrote
   for a shared board. The generic `ANTHROPIC_API_KEY` stays un-honoured,
   as for the summarizer.
5. **The filer's agent id is store-only** (`filedBy`), like every actor id:
   the projection carries the verdict and the display name, so the wake can
   be addressed without an id reaching a share visitor.

**What would change the decision:** the judge holding good items often
enough that agents stop filing (loosen the default criteria, or make the
hold advisory); a board wanting the gate to REFUSE (that is Bryan's call to
reverse, not a knob); or the 5-minute nudge proving noisy for an agent
mid-turn (lengthen it — the filer already heard once, in the tool result).


## 2026-08-30 — One call per tick carries every intent; no router, no N extractors

Every new voice capability (research-by-voice, correct-a-note-by-voice) would
otherwise be another LLM call on every tick. The choice was: one cheap router
that classifies the tick and runs only the passes it names, N always-on
extractors, or one combined call that routes and extracts in the same reply.
**The combined call wins, and it is cheaper at five intents than today's two
always-on passes are at two.**

**Why.** A tick's prompt is ~95% shared context — 431 tokens of notes system
prompt, 345 of capture system prompt, 30 board titles for the composer, 40
candidate rows for the extractor, the notes so far — against a ~50-token
transcript window. What scales with intents is how many times that context is
re-sent, which is precisely what separate extractors do. Measured on a
scripted meeting driven through the real Haiku composer and extractor
(Haiku 4.5, $1/$5 per MTok, ~200 ticks per meeting-hour):

| shape | in/tick | out/tick | $/meeting-hour |
|---|---:|---:|---:|
| notes alone (floor) | 1424 | 278 | 0.56 |
| today: two always-on passes | 2593 | 318 | **0.84** |
| one combined call, 2 intents | 2047 | 322 | 0.73 |
| five always-on extractors | 3618 | 361 | 1.08 |
| router + gated passes, 5 intents | 2501 | 323 | 0.82 |
| **combined call, 5 intents, with the overlap below** | 2311 | 386 | **0.85** |

An intent added to the combined call costs ~58 input and ~21 output tokens —
about three cents a meeting-hour. The same intent as its own always-on pass
costs seven to twenty-seven. Prompt caching cannot close that gap: Haiku
4.5's minimum cacheable prefix is 4096 tokens and every prompt here is under
2900, so a `cache_control` marker would silently do nothing.

**A tick carries several purposes at once, and the answer is never pick-one.**
Every pass answers on every tick; the reply has a key per intent and an empty
value is the ordinary answer. This is where the router lost on evidence
rather than on price. Measured over 11 ticks against the shipped extractor as
ground truth, a router written in the same house style, returning a LIST of
passes and told to prefer over-firing, named "tasks" on 5 of the 7 ticks where
capture actually found something — and **both misses were multi-purpose
ticks where it named a different label**: one named "decisions" and dropped a
task reference, the other named "research" and dropped a request. It never
failed to fire; it ranked, and the runner-up died. One classifier over one
window has to rank, so that bias is structural, not a prompt bug. Even gating
everything away its floor is $0.64 — so the offer was a third of every new
intent in exchange for at most 19 cents a meeting-hour.

**A purpose can also span two ticks, so the window carries a one-tick
overlap.** The previous tick's turns ride along, marked as already noted:
their content is in the notes already, but an intent that begins in them and
finishes in the new speech is the pass's to act on. This is not a routing
question — it is live today with no routing involved, and it is a bug. With
the shipped one-tick window, "…that is the real cost." / "Can you file a
ticket for that one?" files a row titled *"file a ticket for that one, a small
spike would do"*, and "we should file tickets for the next few things I
mention" followed by the things in the next tick loses the ask entirely.
Widening the window fixes both (*"File a ticket for tree rebuild on every
keystroke"*; both requests, correctly titled), and recovers a split correction
that a one-tick window returns nothing for. It costs ~90 input tokens a tick,
under two cents a meeting-hour — the one cent between $0.84 and $0.85 above.

A per-tick gate is worse than useless here: on the trigger-first pair the
router fired on the tick with no content and declined the tick that had it.

**What this obliges the implementation to do.**
- **Notes are the first key, and keys parse independently.** Today a failed
  capture costs its links and the notes still compose; one reply must not make
  a refusal or a truncation lose the notes. A missing key means "found
  nothing", `max_tokens` covers notes plus extras, and the session's
  carry-on-failure path stays.
- **Pin the schema.** Measured drift across three runs: `"who"` for `"by"`,
  `"original"` for `"line"`, tasks nested as `{"items":[]}`. Sub-schemas blur
  in a long prompt. Use structured outputs and keep parsing tolerant. The
  deterministic guards (`tickMentionsCandidate`, `requestMatchesCandidate`,
  `speakerOnTick`) are unchanged and still run on whatever parses — note that
  the overlap widens the vocabulary they vouch against by one tick, which is
  the intended effect and not a loosening of the rule.
- **Task links need a placeholder.** Capture runs before compose today so the
  composer can cite a created row's URL. One call cannot cite a URL for a row
  it is proposing in the same reply: the model emits a placeholder and the
  server substitutes it after find-or-create.
- **Each new intent clears an eval, not a token count.** Notes quality under a
  crowded prompt was sampled, not measured.

**What would change the decision:** a model whose cacheable prefix sits under
these prompts (then N calls stop re-paying for context and the shapes
converge); intents that need genuinely different context rather than the same
tick (then they are separate calls whatever the routing); or a measured drop
in notes quality as intents accumulate, which is the failure this trades
against and the reason each one is gated on an eval.

**Measured 2026-08-30**: one 3-minute scripted meeting (11 ticks, one sample
per tick) plus three two-tick boundary scenarios, through the real Haiku
composer and extractor with real usage fields and `count_tokens`; notes
plateaued at 1136 chars, board of 40 rows. Transcription is $0.27 per
meeting-hour with speaker labels, so these passes are already three times the
meeting's transcription bill.

## 2026-08-31 — Research by voice confirms on the board, not in the terminal

Two intents were added to the capture call — a research ask ("go look into
that") and a lookup ask ("pull in last week's notes"). The lookup only reads,
so it needed nothing new. The research ask spends: an agent goes away and
burns tokens on a report, so it must be confirmed. The question was where the
confirmation lives.

**It is a decision review item on a row filed into triage** — chosen over a
pending line in the meeting notes, and over a terminal question. Two reasons,
both of them about enforcement rather than politeness:

- **The gate already exists and is not a promise.** An open review item makes
  `ready-gate.ts` report `awaiting-answer`, and triage is not a band dispatch
  runs. So nothing can pick the row up until it is answered, whatever any
  prompt says. A pending line in the notes has no such property: it asks the
  next agent to be careful.
- **The answer path already exists.** `decision.answered` wakes the board's
  lead through `ReadyWorkNudger.reviewAnswered`; a notes-only pending state
  would need a new watcher, and a terminal question only exists while somebody
  is watching a terminal.

The row is filed with NO goal on purpose. A band would make it dispatchable
the moment the item was answered either way, which is the one thing the
confirmation is for.

**Measured cost** (`scripts/intent-prompt-cost.ts`, `count_tokens` on the
capture model): the capture system prompt goes 482 → 630 → 716 input tokens —
+148 for research, +86 for lookup, **+234 per tick**, ≈ $0.047 per
meeting-hour at ~200 ticks, taking $0.84 to about $0.89. That is roughly twice
the ~58-tokens-per-intent figure the 2026-08-30 decision priced an intent at,
because both rules carry the example phrasings that teach an ask nobody states
explicitly. The decision's conclusion is unchanged and its margin is large: as
five separate always-on passes these two would have cost seven to twenty-seven
times more.

**What would change it:** a "not now" answer currently leaves the row in
triage for a person to archive. If declined research rows accumulate visibly,
react to `decision.answered` and archive the row on the `not-now` option —
deliberately not built now, because an auto-archive on a mis-read answer is
the harder thing to undo.
