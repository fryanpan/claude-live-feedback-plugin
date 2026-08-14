# Learnings

Technical discoveries that should persist across sessions for this project.

## An MCP source fix doesn't reach peers until the tracked bundle is rebuilt

- **PR #69 declared the `groups` param in `create_diff_review`'s inputSchema
  (`packages/mcp/src/mcp.ts`) but never rebuilt `packages/plugin/mcp/index.js`
  — so no peer ever got the fix.** Peers load the MCP server via
  `.mcp.json` → `node ${CLAUDE_PLUGIN_ROOT}/mcp/index.js`, i.e. the
  **tracked, committed bundle**, NOT the TypeScript source. That bundle is
  regenerated only by `bun run build:mcp` (which writes both
  `packages/mcp/dist/mcp.js` and `packages/plugin/mcp/index.js`). Editing
  `mcp.ts` and merging changes nothing peers can see; the bundle on `main`
  was last rebuilt two PRs earlier (#59) and still lacked `groups`. The
  "peer picks it up on next session restart" reasoning was doubly wrong — a
  restart reloads the *stale committed bundle*, so even restarting didn't
  help.
- **Rule: any PR that touches `packages/mcp/src/**` MUST run
  `bun run build:mcp` and commit the regenerated
  `packages/plugin/mcp/index.js` in the same PR.** `packages/mcp/dist/` is
  gitignored (not shipped); `packages/plugin/mcp/index.js` is the shipped
  artifact and IS tracked — verify it's in `git status` before pushing.
  Grep the diff for the schema/description change in `index.js`, not just in
  `mcp.ts`. Same class as "the route layer silently drops params": the fix
  lived one layer away from where it's consumed.
- The two client bundles differ in how they ship: `markdown-app/dist` is
  **untracked** and rebuilt at deploy time on the server (served
  per-request), so a markdown-app change is rebuild-on-the-box; the MCP
  bundle is **tracked** and travels through git to each peer's plugin cache,
  so it must be committed. Don't conflate them.

## Yjs attribute TYPES reach prosemirror untouched — a string ≠ a number

- **Every heading parsed from markdown rendered as `<h1>` because we stored
  `level` as `String(level)`.** Tiptap's Heading picks its tag with
  `this.options.levels.includes(node.attrs.level)` against the NUMBERS
  `[1..6]`, and y-prosemirror passes Yjs attributes through to
  `schema.node(name, attrs)` verbatim — no coercion. `'2'` fails the
  `includes` check, so the node falls back to `levels[0]` = `h1` and H1/H2/H3
  all render the same size. It looked like a *reparse* bug (reparse re-seeds
  from disk, so it re-introduced the string) and it "fixed itself" when a
  human re-set the heading in the toolbar — because prosemirror writes the
  NUMBER back. Rule: when a Yjs attribute feeds a prosemirror node attr,
  match the type the extension expects exactly; every reader here already did
  `Number(...)`, which is exactly why the bug hid for so long.
- **Yjs stores any JSON value in an attribute; only its TS types insist on
  strings** (`Y.XmlElement<KV>` defaults `KV` to `{[k:string]: string}`).
  Type the element as `Y.XmlElement<{ level: number }>` rather than casting
  the value.
- **Legacy state needs a migration, not just a writer fix.** Docs already
  persisted in `.ydoc` keep the string; `normalizeHeadingLevels(doc)` runs on
  room load so existing docs repair themselves without a reparse.
- **Verify at the layer the bug lives in.** The block model and the
  `/content` API were CORRECT the whole time — only the rendered editor was
  wrong. The test that proves the fix builds a real Tiptap editor over the
  Yjs doc (`Collaboration.configure({document: ydoc})`, no provider needed)
  and asserts `editor.getHTML()` contains `<h2>`. Reverting the writer to
  `String(level)` makes it fail — an assertion on the Yjs attribute alone
  would not have.

## A destructive re-seed orphans threads it never needed to touch

- **`fragment.delete(0, len) + push(freshBlocks)` (the old reparse/reconcile
  apply path) destroys the `Y.XmlText` identity of EVERY block**, so every
  thread anchor in the doc breaks — including threads on paragraphs the
  rewrite never touched. `applyMarkdownToFragment` diffs at block granularity
  (LCS over each block's serialized markdown) and only replaces the blocks
  that actually changed, so untouched blocks keep their identity and their
  RelativePositions keep resolving. The snippet-match `autoReanchorDoc` sweep
  stays as the backstop for anchors *inside* a rewritten block.
- **A prelim (not-yet-integrated) `Y.XmlElement` has no readable children** —
  `toArray()` walks `_start`, which is null until the type belongs to a doc.
  Serializing freshly-parsed blocks to key them therefore returns empty
  strings. Integrate a throwaway copy in a scratch `Y.Doc` to read them (and
  parse a second time for the blocks you actually insert — an integrated Yjs
  type cannot be re-parented).

## Don't let the editor tools write raw control bytes into source

- A NUL byte landed in `prose.ts` from a sentinel string I meant to write as
  a leading space (`` `\x00unserializable` ``), which turns the file "binary"
  to grep and would have failed review. Same class as the biome
  `noControlCharactersInRegex` trip earlier. Use plain ASCII sentinels
  (`__unserializable_block_${i}__`); if grep starts reporting "Binary file
  matches" on a source file you just edited, that's what happened.

## The route layer silently drops params unit tests can't see

- **Every REST handler in server.ts hand-copies body fields into the rooms
  call — a new param needs THREE additions (MCP tool, route, rooms), and
  the route is the one nothing type-checks.** `groups` was added to the MCP
  tool schema and to `bindDiff`, but not forwarded by `POST /api/diffs`:
  the API accepted it, returned ok:true, and discarded it. Unit tests
  passed (they call `bindDiff` directly); the outside agent reported
  success TWICE (it trusted the 200). Only probing the live server's
  resulting state exposed it. Rules: (1) when adding a param to a rooms
  method, grep the route that fronts it in the same change; (2) write at
  least one HTTP-level test through the real route per new param; (3) a
  peer agent's "it worked" means "the call didn't error" — verify the
  server-side EFFECT before believing a success report (same lesson as
  diagnose-before-recommending, inverted).
- **Related: don't let your own maintenance operations clobber
  caller-supplied state.** A group-less refresh re-bind overwrote
  agent-supplied groups with the heuristic because "refresh derived
  fields" treated groups as derived. Fields that are sometimes derived and
  sometimes caller-authored need an explicit precedence rule (explicit
  wins; refresh only fills gaps).

## A negative test needs a positive control or it proves nothing

- **A probe that asserts "the secret isn't there" is worthless until you've
  shown the probe can see anything at all.** Checking whether `/y/<docId>`
  leaks doc metadata to a share visitor, a raw `WebSocket` reported clean on
  every field — because a raw socket never completes the Yjs sync handshake.
  20 bytes arrived and the doc's own text never did, so every "false" was
  vacuous. Adding one line (`WS has doc text?`) flipped the result: the
  leak was real and total. Reuse the repo's own client (`connectDoc` in
  `packages/server/test/ws.test.ts`: `lib0/encoding`, `lib0/decoding`,
  `y-protocols/sync`) rather than hand-rolling a protocol client.
- Same failure mode caught twice more in one session: a traversal test with
  `expect()` inside a `try` whose `catch` swallowed the failure (a test that
  could never fail — the escape genuinely leaked), and two "the fix changed
  the ordering" tests that passed by alphabetical accident. **Rule: every
  test whose assertion is an absence must first assert a presence** — the
  socket synced, the stream delivered an event while access was live, the
  owner's copy still has the field. Then prove non-vacuity by breaking the
  fix and watching it fail.

## Anything in the Yjs doc is readable by every peer, including share visitors

- **Redacting a REST payload closes one door out of two.** `DocMeta`'s
  `sourceUrl` / `owner` / `workspaceRoot` / `producedBy` describe the host
  machine, and `redactMetaForVisitor` stripped them from
  `GET /api/docs/<id>` — but they also lived in the ydoc `meta` map, and Yjs
  sync is a **state exchange, not a per-connection projection**. There is no
  supported way to withhold part of a doc from one peer, so a field that
  must not reach a visitor cannot live in the CRDT at all. Those four keys
  now live in a `<docId>.private.json` sidecar
  (`packages/server/src/private-meta.ts`).
- **Check who actually READS a value before assuming it has to be synced.**
  All four were server-only; the one client reader (`code-app.ts`'s
  syntax-highlighting fallback) already preferred the REST payload. The
  client only *observed* the meta map as a change signal.
- Two things the move needed that are easy to miss: (1) the sidecar rides
  the SAME debounced write as the `.ydoc` (`saveToDisk`), because two
  persistence paths drift and a doc that loses its `sourceUrl` stops
  writing back to disk **silently**; (2) every already-persisted `.ydoc`
  carries the keys, so loading a room must LIFT them out — reading alone
  leaves them in the state the next visitor syncs — and force a snapshot,
  since the lift's transaction runs before `wireEvents` is listening.
- **A long-lived grant needs a revocation path per transport.** Websockets
  were covered; SSE (`/events/<docId>`) was not, and Access-mode shares
  never enforced their TTL at all (`findByHostname` ignores `expiresAt`
  where link mode's `findLive` doesn't). When auditing "what can a revoked
  visitor still reach", enumerate every connection that is authorized ONCE
  at open, not per request.

## Diff review (type='diff') — immutable content changes the rules

- **A diff review is "bind_folder where the file list comes from `git diff`
  and the bytes come from `git show target:path`".** One doc per changed
  file grouped under workspaceId = reviewId buys the tree UI, thread stack,
  SSE watch, delete_workspace, and cleanup for free. Content pinned to a
  commit hash needs NO mtime poll, NO write-back, and anchors can never
  drift — most of the sync machinery is deliberately not wired.
- **@codemirror/merge's `collapseUnchanged` computes its ranges ONLY at
  StateField init** (`CollapsedRanges.init(buildCollapsedRanges)`); the
  update path only ever removes ranges. Our editors mount before the Yjs
  websocket delivers content, so the field initialized over an empty doc
  and nothing ever collapsed. Fix: re-init the merge compartment
  (`Compartment.reconfigure` with fresh extensions) on the first real
  content change. General rule: any CM extension that derives state via
  `Field.init(...)` is stale for docs that stream in after mount.
- **Viewport-virtualized DOM lies to counting queries.** `querySelectorAll
  ('.cm-changedLine').length === 0` at scroll-top proved nothing — CM only
  renders the viewport. Scroll to the region (or use state, not DOM) before
  concluding a decoration is missing. Also: match deletion widgets to
  chunks by `view.posAtDOM(widget)`, never by DOM order — off-viewport
  widgets aren't in the DOM at all.
- **`createThreadByFind` resolved only against the prose fragment**, so
  agent-side `create_thread` returned no-match on every code/diff doc
  (empty fragment) — a gap dating from the code surface (PR #55). Flat
  content docs need their own find path against `content.toString()` with
  line-snapped anchors. When a doc kind stores content in a different Yjs
  surface, grep every `prose.*(ydoc)` call site for the missing branch.
- **Old/new dual line numbers**: new = `lineNumbers()`; old = a custom
  gutter mapping posB→posA by accumulating chunk size deltas (pure,
  unit-tested `oldLineForPos`); deleted lines live inside widget DOM where
  no gutter reaches — stamp `data-old-line` on `.cm-deletedLine` divs and
  render via CSS `::before content: attr(...)`. Gutter ORDER follows
  extension order: the old-number gutter must precede `lineNumbers()` in
  the same extension list to render on the left.

## A unit test can be true and still prove nothing about the caller

- **`isWhitespaceOnlyChange('a b', 'ab') === false` passed from the first
  commit, and the feature still hid a real code change.** Nothing ever
  called the function with whole strings: `presentableDiff` reports
  `foo bar` → `foobar` as a change whose two slices are exactly `' '` and
  `''`, and both squash to empty. The classifier said "whitespace", the
  filter suppressed it, and the line vanished from the diff entirely with
  the default-on toggle. The assertion was TRUE and USELESS — it tested an
  input shape production never produces. Rule: when a predicate is applied
  to *slices of* something, test it through the thing that slices, not on
  hand-written whole values. The fix classifies the enclosing LINES.
- **Three adversarial rounds each found a distinct real defect**, all of
  the same family (whitespace-insensitive diffing is lossy) but at
  different layers: slice-vs-line, whitespace inside a string literal
  (`"a  b"` → `"a b"` changes what the program prints), and
  indentation-significant languages (reindenting a Python statement moves
  it into an `if` block). `git diff -w` and every hide-whitespace view
  built on it get the last two wrong. Guards: classify on lines; skip
  changes starting inside a quoted span; default the whole feature OFF for
  `.py`/`.yaml`/`Makefile`-class files. Each guard is deliberately
  ONE-DIRECTIONAL — it can only keep MORE visible, so its failure mode is
  noise rather than a hidden change.
- **Don't stop at the first clean-looking review.** Rounds 2 and 3 only
  existed because round 1's fix was non-trivial. Conversely, know when to
  stop: round 4 would restate the inherent limitation, which is now
  handled where it actually bites and documented where it doesn't.

## Suppressing a diff chunk silently breaks anything that counts chunks

- **`oldLineForPos` reconstructs base line numbers by accumulating the size
  delta of every chunk before a position** — so a change the whitespace
  filter drops contributes no delta, and every old line number after a
  reindent is wrong by the width of the indent. Silently: the gutter keeps
  rendering plausible numbers. Suppressed changes must be RECORDED and fed
  back into the mapping, not discarded.
- Three distinct cases, only found by checking every line of a realistic
  fixture against the base text: (1) reindent — same line count, maps 1:1;
  (2) blank line added — line counts differ, so NO base number (repeating
  the line above asserts an identity that doesn't exist); (3) the line
  *after* an insertion — maps into the MIDDLE of a base line, which is the
  tell that it has no counterpart. Guard: only claim a base line when the
  mapped position IS that line's start.
- **The test that caught (2) and (3) asserts a relationship, not values**:
  for every line, if the gutter shows a number, the base line at that
  number must be the same line of code. Per-line expected-value assertions
  would have been written to match the buggy output.
- `hidden` regions are read once per VISIBLE LINE by the gutter, so
  rebuilding + sorting the merged region list there is a per-frame cliff on
  a large reformatted file. Memoized on the source arrays by identity —
  which only works because the filter REPLACES the array each recompute
  instead of mutating it in place. Mutating a cache key is a trap.

## Concurrent agent+human edits are CRDT-safe; disk reconcile was not

- **Agent edits don't clobber a live human editor — the in-memory path is
  already safe.** Every agent edit tool (`findAndReplace`, `rewriteRange`,
  `insertAfterRange`, `insertBlocksAfterAnchor`) runs as a targeted Yjs
  transaction on the SAME `room.ydoc` the browser syncs to over the
  websocket. Concurrent agent + browser edits therefore CRDT-merge, they
  don't overwrite. A peer reported "agent find_and_replace clobbered my
  edits"; reproduced the scenario in `ws.test.ts` and it does NOT clobber.
  Don't reach for a lock/reject scheme — it would fight the real-time
  co-editing goal. The reported loss was actually the serializer bug below.
- **The real clobber vector was `reconcileFromDisk`'s destructive
  delete-all+push.** When the bound file changed on disk AND the live doc
  had its own un-flushed edits, the old reconcile blindly replaced the
  whole fragment with disk content, discarding the human's in-progress
  work. Fix (PR for the two-bug report): a pure, unit-tested
  `decideReconcile(disk, lastWritten, currentSerialized)` returning
  `in-sync | catch-up | apply | conflict`. On `conflict` keep the live
  edits (editor = runtime source of truth), reassert them to disk via the
  debounced writer, and record a `syncError` (recoverable with
  `reparse_from_disk`). General rule: a destructive `fragment.delete(0,len)
  + push` from an external source must first check whether the live doc
  diverged since the last write — if it did, that's a conflict, not a
  one-way apply.
- **mtime-poll detection misses same-mtime writes — don't write a test that
  saves faster than the filesystem's mtime granularity.** The disk→doc poll
  detects changes by `statSync().mtimeMs`. Rapid back-to-back saves can land
  in the same mtime tick on a coarse temp filesystem, so the second write is
  invisible. A rename-survival test that did three saves with no spacing was
  ~50% flaky (failed at the 2nd save) on BOTH the pre-change and changed
  trees — pre-existing, surfaced only because a single local run looked
  green. Fix: force a strictly-increasing mtime in the test (`utimesSync`);
  real editor saves are seconds apart so distinct mtimes are realistic. When
  a test fails intermittently, measure the baseline flakiness on unmodified
  HEAD (run it 5×) BEFORE assuming your change caused it.

## Serializer must recurse for nested lists (round-trip fidelity)

- **The markdown serializer flattened nested lists + multi-paragraph list
  items into one space-joined line, destroying structure on write-back.**
  `listItems()` did `textContent(child)` for EVERY child of a `listItem`
  joined by a space — but a `listItem` holds a paragraph PLUS optional
  nested `bulletList`/`orderedList` children and extra paragraphs (the
  y-prosemirror shape). A human's nested "Notes & Questions" section was
  irrecoverably flattened on the doc→disk→doc path. Fix: a recursive
  `serializeList(node, depth)` (2-space indent per level) + an
  indentation-stack parser (`parseListAt` / `consumeItemChildren`) so BOTH
  ends round-trip. Lesson: any serializer for a recursive document schema
  must itself recurse — a flat `textContent` join silently eats nesting,
  and the parser must read the same indentation convention back or the
  round-trip still loses data on the next reload.

## Stateful services + hydration

- Yjs state hydration ≠ binding hydration. Loading `.ydoc` files restores
  doc state but does not re-wire the `observeDeep` listener that schedules
  disk write-back. PR #28 fixed `hydrateFromDisk` to call `attachFile` for
  any markdown doc whose `sourceUrl` resolves on disk. Lesson: any time we
  add a state-hydration path, audit every listener that the live attach
  flow wires up — silent half-attached states are extremely hard to
  diagnose because reads keep working.

## fs.watch is the wrong primitive for disk→doc sync

- **A file-level `fs.watch` goes deaf after the first rename-based save.**
  `fs.watch(file)` is bound to the file's *inode* at watch-creation time
  (kqueue on macOS, inotify on Linux). Editors — and Claude Code's own
  `Edit` tool — save via write-temp-then-`rename`, which atomically
  replaces the inode. The watch fires one final event and then is
  permanently stale: only the FIRST external edit ever reaches the live
  doc. Deterministic, reproduced on both Bun and Node. This is the bug
  behind "I edited the bound .md and it stopped syncing" reports (PR #46).
- **The fixes that *look* right are platform-divergent.** Re-arming the
  watcher on the `rename` event works on macOS but still drops the 2nd
  save on Linux; watching the parent directory + filtering by basename
  works on macOS but proved unreliable under Bun-on-Linux. Don't trust a
  watcher fix that only passed on your Mac — Linux CI will catch it.
- **Resolution: poll the file's mtime instead** (PR #46 ships a 500ms
  `statSync().mtimeMs` poll, `unref()`'d so it never blocks process/test
  exit). Immune to inode swaps, platform, and runtime; ~1s latency matches
  the doc's sync contract. `scheduleFileWrite` stamps its own write's mtime
  so the write-back isn't mistaken for an external edit. General rule: if
  you need reliable cross-platform file-change detection, reach for an
  mtime poll, not `fs.watch`.
- **Recovery tool:** `reparse_from_disk(docId)` MCP tool force-pulls disk
  into the live doc in place (no URL re-bind). The server method/route had
  existed for a while but no MCP tool wrapped it — so docs referenced a
  tool that couldn't be called. When you add a server route meant for
  agents, add the MCP tool in the same change.

## find_and_replace gotchas

- Empties a containing block but doesn't remove it. If a replacement
  drains the only content of a blockquote / list item / paragraph, the
  block stays as an empty shell. Workarounds: use the block-deletion API
  (`delete_block_at_anchor` / `delete_blocks_in_range` / `delete_section`,
  added in PR #6) when you mean to remove a block, or do a clean
  serialization pass at the swap point. Tracked: backlog tasks for an
  inline auto-cleanup behavior.
- Can't split list items. `replace='item-a\n\nitem-b'` produces a paragraph
  break inside one list item, not a sibling item. Backlog: a dedicated
  `insert_list_item_after_text` or `insert_blocks_after_thread` extension.
- Can't add new inline marks. Replacement strings with `**bold**` /
  `*italic*` / `[link](url)` syntax land as literal characters, not marks.
  Backlog: a dedicated `apply_mark` tool.

## A "we're working on it" UI state must be grounded in the work, not inferred

- **A pending/loading state the client INFERS will lie, and the lie is
  always in the direction of promising something that never arrives.** The
  first cut of "Generating summary…" inferred in-flight generation from
  three client-visible facts (a doc-wide `summariesEnabled` flag + stale
  stored summary + recent `lastActivity`). Every one of those was true in
  cases where NO generation was queued: share-visitor writes are gated
  (`generate: !visitor`, so `scheduleSummary` is never reached), and thread
  CREATION queues a call whose result can only change the topic — the
  no-replies discussion line is deterministic by design, so the card
  promised a sentence, waited 5s, and fell back to "No replies yet". Fix:
  the server writes `summaryPendingTs` into the thread's Yjs map at the
  exact point it QUEUES the call, and the client reads that. **Grain
  matters: "this server does X" is not "X is happening for this item".**
- **Time-bound the marker, and treat expiry as a clock event.** The window
  is what turns a failed API call back into the deterministic lines instead
  of a spinner nobody clears. But nothing in the ydoc changes at expiry, so
  no observer fires — the card needs its own timer, that timer must always
  be armed for the EARLIEST pending deadline (a first-come "one is already
  scheduled" guard leaves a sooner-expiring card spinning), and it must be
  cleared in `destroy()` or it repaints the previous doc's threads over the
  next mount, which reuses the same DOM.
- Also retire a marker older than `lastActivity`: newer activity that
  queued nothing means the promised summary describes a state already gone.

## A corrective retry can DELETE the thing it was asked to fix

- **The word-cap retry was allowed to empty a summary line, because an
  empty line costs zero words and therefore satisfies the budget the retry
  was sent to satisfy.** `buildRetryNudge` returned null for
  `discussion: ""`, so the "compliant" blank answer beat a long-but-real
  first answer. Downstream, `threadLines` does `stored.discussion ||
  base.discussion`, so the card fell back to the raw latest comment — the
  verbatim snippet generation exists to REMOVE — and because the stored
  hash was current, nothing ever retried it. Found in production with one
  affected thread, three days after the retry shipped with four passing
  tests.
- Two guards, both one-directional: a retry may not blank a line the first
  answer filled (keep whichever answer HAS the line), and an empty
  discussion on a thread that has replies is itself a reason to ask again.
- **General rule: when you add a "fix it" round trip, state what the second
  answer must still CONTAIN, not only what it must not exceed.** Any
  validation phrased purely as an upper bound is satisfied by emptiness.

## "The store has it" is not "the surface can show it"

- **A reply to a resolved thread left the thread resolved, and the drawer's
  default Open tab drops resolved threads entirely** (`filtered()` in
  `threads.ts`), so a reviewer's reply three minutes after an agent resolved
  was invisible to them. It was reported as **"comments seem to be going
  missing"** — and a peer's first instinct was to check for data loss, which
  there wasn't: `list_threads` had all 26 threads with every word. Nothing is more
  corrosive to trust in a review surface than content that exists in the
  store and cannot be reached from the UI, because the failure presents as
  the worst possible bug (loss) while every backend check comes back clean.
- **The fix belongs at the one choke point**: `schemaPostReply` has exactly
  one caller (`Rooms.postComment`), and all three reply paths — browser REST,
  MCP `post_reply`, widget — funnel through it. A person's reply reopens; an
  agent's does not, because agents post closing notes ("done, removed it in
  <sha>") after a human resolves and resurrecting a just-closed thread is its
  own bug. `classifyActor` (activity.ts) already draws that line — reuse it
  rather than inventing a second notion of "is this an agent".
- **Residual, deliberately not fixed: the reverse ordering.** If the person's
  reply lands and the agent resolves *afterwards*, the reply is hidden again.
  The tempting guard — "don't let an agent resolve when the newest comment is
  a person's" — describes the NORMAL case (human asks, agent fixes, agent
  resolves), so it would block almost every legitimate resolve. A real fix
  needs a `resolvedAt` and an "activity since resolve" display rule.
- Status fields that gate visibility need an explicit way back IN, and the
  test for one belongs at the route layer: `postComment` is reachable three
  ways and the route is the layer no unit test covers.

## A touch gesture has TWO endings, and `pointercancel` is the common one

- **The comment pill was dead on mobile after the first scroll**, because
  `isDragging` (set on `pointerdown` over the doc, and checked by every path
  that can SHOW the pill — `positionPill`, prosemirror's `selectionUpdate`,
  the view-mode `selectionchange` fallback) was cleared only by `pointerup`.
  Mobile browsers fire **`pointercancel` instead of `pointerup`** whenever a
  touch is taken over by a system gesture: scrolling with a finger on the
  text (every session, within seconds), or iOS handing a long-press to its
  own selection UI. One cancelled touch wedged the flag for the rest of the
  page load, and nothing surfaced it — Bryan reported it as "no inline
  comments on mobile?", i.e. as a MISSING FEATURE rather than a bug.
- **Rule: if you set a flag on `pointerdown`, clear it on `pointerup` AND
  `pointercancel`.** A `touchcancel` companion is unnecessary — a browser
  without pointer events wouldn't have fired the `pointerdown` either.
- **A flag that gates an affordance's only entry point needs a watchdog.**
  The failure is silent and total, so `trackGesture` also self-settles after
  6s if neither terminator arrives. Deliberately one-directional: settling
  early can only SHOW the pill next to a real selection, where the
  alternative is a dead affordance.
- **A happy-dom unit test on the tracker cannot prove app.ts wires it** (the
  bug was entirely in the wiring). What proved it: build the bundle in a
  throwaway worktree, serve it on its own port + data dir, and run the same
  probe against the pre-fix and fixed bundles — `pointerdown` +
  `pointercancel` with no `pointerup`, then a selection. Pre-fix: pill
  hidden, still hidden on retry. Fixed: visible both times. Never rebuild
  `packages/markdown-app/dist` in the primary checkout to test an unmerged
  change — prod serves that directory per-request, so the "test build" is a
  deploy to the fleet.

## A prod restart reloads server code but NOT the served app bundle

- **A feature can be fully merged, the server restarted, and every browser
  still runs the pre-feature client.** The markdown-app is served from
  `packages/markdown-app/dist` (untracked, minified); prod
  (`serve.ts --no-watch`) deliberately runs no bundler, on the assumption
  "dist is built once at deploy time" — but nothing enforced that a deploy
  rebuilt it. Generated thread summaries (PR #105) merged at 12:39; dist was
  last built 11:37; the 1:46 restart reloaded the SERVER (which generated and
  stored summaries) while every card kept rendering raw snippets, because the
  served `app.js` had no summary code at all. Diagnosis tell: server REST
  state is correct, browser behavior is pre-feature → compare
  `dist/BUILD_INFO.txt` against the merge time FIRST. Note the bundle is
  minified, so grepping dist for source identifiers proves nothing — grep for
  string literals (`get("summary")`) or trust BUILD_INFO.
- Fix (this PR): prod `serve.ts` rebuilds the widget + markdown-app bundles
  once at startup, before the server spawns — restart == deploy. A failed
  build logs loudly and serves the existing dist (stale beats down).

## Reviewing an unmerged build: run a staging instance, never rebuild in the primary checkout

- **`bun run staging`, from a linked worktree.** It builds the widget +
  markdown-app bundles in that worktree and starts the server on port 8788
  with a throwaway `data-staging/` dir. Prod keeps serving 8787 with its own
  data the entire time. This is what makes "get feedback before the PR
  merges" possible at all — previously the only way to see a branch's client
  changes was to merge it.
- **Two guardrails, both load-bearing, both encoded in the script rather than
  in someone's memory.** (1) It refuses to run from the primary checkout,
  because prod serves `packages/markdown-app/dist` from there *per request* —
  building bundles in the primary checkout is a deploy to the whole fleet, not
  a test build. Detection is `--git-dir == --git-common-dir`, which is true
  only in the main checkout. (2) It starts the server via
  `packages/server/src/bin.ts` (which takes `--port` / `--data-dir`) and NEVER
  via `scripts/serve.ts`, because `serve.ts` publishes the live port to the
  file the live-feedback MCP uses for discovery — running it would silently
  repoint every agent in the fleet at the staging build.
- **Pointing an agent at staging** needs `FEEDBACK_BASE_URL=http://<host>:8788`
  in its launch environment; the MCP checks that override before discovery.
  Read once at session start, so it needs a restart with the env set — same
  constraint as `FEEDBACK_AGENT_NAME`.
- **Staging data does not migrate.** Tasks and docs created there die with the
  data dir. So the shape is: evaluate on staging pre-merge, then do the real
  work once, after the merge. Don't ask a reviewer to enter real content twice.

## Prod no longer serves the client out of a working tree — publish, then switch

- **Two entries above say prod serves `packages/markdown-app/dist` from the
  primary checkout *per request*. That stopped being true** when prod started
  copying the built bundles into an immutable numbered release under the state
  root (`~/.local/state/live-feedback/client`, `LF_CLIENT_ROOT` to override)
  and serving that. A `git checkout` in the repo can no longer change what a
  browser loads. What survives unchanged: that checkout is prod's **deploy
  source**, so bundles built there still ship at the next restart — which is
  why `bun run staging` still refuses to run from it.
- **Any "swap what's being served" operation needs an intermediate nobody
  reads.** Copy into a dot-prefixed staging dir, `rename(2)` it into place (a
  release then exists completely or not at all), and move the `current`
  pointer by renaming a fresh symlink over it. Copying into the live directory
  has a window where the served tree is half-populated; there is no amount of
  ordering that removes it. The server is handed the RESOLVED release path, so
  no request can resolve half a path either side of a swap.
- **Release ids must sort in publish order.** The first cut used a
  seconds-granularity timestamp plus a random suffix, so "keep the newest N"
  was a coin flip between same-second releases and the prune test failed
  intermittently-by-construction. Millisecond stamp + a fixed-width counter.
- The full picture of what reaches whom, and how, is
  [delivery.md](delivery.md) — read that before answering "why doesn't my peer
  have this yet".

## Server lifecycle on the Mac Mini

- The live-feedback server has no auto-restart story today. If it crashes
  while Bryan is mobile, his bound docs stop accepting new edits via the
  /review URL (browser shows reconnect loop with `data:` flicker). Restart
  recovers state from `.ydoc` files cleanly. PR #31 ships a launchd
  supervisor; PR #33 fixes the install-time gotchas (see below).
- `bun --watch` does NOT reliably reload on changes to deeply-imported
  files. After landing a server-side fix, restart manually
  (`pkill -f bin.ts && bun run dev`) to verify it's loaded.

## macOS launchd + non-default home volume

- **TCC blocks launchd-spawned processes from reading `/Volumes/<X>/Users/...`
  by default**, even if the user's actual home directory lives there (via
  `/Users/<name>` symlink). Symptom: launchd reports the service "running"
  but the process never writes to stdout/stderr, never binds its port,
  never spawns children. `sample <pid>` shows 100% time in
  `__open_nocancel` because the kernel is returning `EPERM` on `getcwd()`
  ancestor walks and the language runtime retries instead of surfacing.
  Confirm with a minimal test plist running `/bin/sh -c "pwd"` — you'll
  see `getcwd: cannot access parent directories: Operation not permitted`.
  Fix: System Settings → Privacy & Security → Full Disk Access → add the
  binary (e.g. `~/.bun/bin/bun`). Shell-spawned processes inherit
  Terminal's TCC scope and don't hit this — only launchd does.
- **`launchctl bootstrap gui/$(id -u)` is the modern entry point.**
  `launchctl load/unload` is deprecated on macOS 11+; `kickstart -k` is
  the modern way to force-restart a supervised service.
- **`KeepAlive` must include `SuccessfulExit=false`** to avoid a restart
  loop when the service exits cleanly (e.g. on `pkill -TERM`). Pair with
  `Crashed=true` so launchd respawns after a real crash.

## File-binding semantics

- `create_review_doc` is idempotent and re-runnable. Calling it again on
  an existing docId with the same `path` re-runs `attachFile`, which
  re-wires the `observeDeep` listener without re-seeding from disk
  (the seed path is gated on empty fragment). Useful as a recovery tool
  for half-attached docs.
- `attachFile` only re-seeds from disk when the in-memory fragment is
  empty. Once seeded, the in-memory state wins; disk content only
  re-enters via `fs.watch` change events or explicit
  `reparse_from_disk(docId)`.

## Markdown editor footguns

- CSS Grid `1fr` = `minmax(auto, 1fr)`, where `auto` is content-driven.
  Any cell with `1fr` can grow past viewport if its content has long
  unbreakable strings. Use `minmax(0, 1fr)` to force shrink-to-fit.
  Cost a full mobile-overflow PR cycle (PR #22 vs PR #23) to root-cause.
- URLs sent to Bryan must NOT be wrapped in markdown bold/italic/links.
  Some of his clients autolink URLs but don't render markdown, so
  `**https://x.com**` becomes a clickable link that includes the trailing
  `**` and 404s. Always send a bare URL on its own line.

## Bound-doc sync contract (the answer to "is disk-editing a bound file safe?")

- Third time a fleet peer needed this spelled out, so: **disk writes into a
  bound .md merge cleanly when the live doc is idle** (500ms mtime poll →
  `decideReconcile` → block-level LCS apply; thread anchors and pending
  suggestions on unchanged blocks survive). **Against un-flushed live edits
  they LOSE by design** (editor = runtime source of truth): the file is
  reasserted from the live doc and a `syncError` is recorded on the binding
  — detected, not silent, but the write is gone. So: MCP edit tools by
  default on bound docs; direct Write/Edit only when nobody's live, and
  check `syncError` after.
- `reparse_from_disk` is **recovery-only**, never "make my disk write
  stick": if the flush reasserted between your write and the reparse, the
  reparse faithfully pulls the OLD bytes back. Known gap: reparse drops
  pending suggestions in rewritten blocks silently (backlog).
- **Diff-review .md members are bound LAZILY** — a companion doc (with
  write-back) exists only once someone opens that file's redline/File view.
  Unopened members are plain files; normal tools are fine. `list_docs`
  shows which companions exist.
- Backlog (peer request): emit a `syncError` event on the doc's watch
  channel (docId, relPath, dropped sids) so a lost write announces itself
  the way comment events do.
- `FEEDBACK_AGENT_NAME` is read ONCE at MCP-child start from the session's
  LAUNCH environment — an MCP reconnect picks up new tool schemas but never
  a new name. Attribution changes require a full session restart with the
  env set (launcher config, not an agent-side action).

## Multi-agent workflow implementation (balloons + suggestions pattern)

- **The recipe that shipped two features with <30 min human hands-on:**
  one persistent worktree; a Workflow of sequential TDD implement-agents
  (one per planned commit, each passing structured `{commit, testsPass,
  concerns}` context to the next); a parallel 3-lens review (dimension
  prompts tailored to the feature's real risks); a fix agent that VERIFIES
  findings before fixing; then, outside the workflow: orchestrator re-runs
  the full suites itself, independent `codex review` pass, merge main into
  the branch, PR. Cheaper models on mechanical commits/reviews, strongest
  model on the incident-prone paths. The layers genuinely disagree —
  Codex caught what the 3-lens pass rated advisory (added-vs-empty-base)
  or missed (proposal isolation, inline-mark loss); 8 real pre-merge bugs
  total across the two runs. Keep both layers even when one is clean.
- Long-running feature branches that APPEND to shared files (styles.css)
  conflict at merge; merge main into the branch before the final
  commit/PR, and resolve both-appended-at-EOF conflicts by keeping both
  blocks and re-closing the braces (check `{`/`}` balance).

## A leak gate that can't see still exits 0 — and reports it as a pass

- **The pre-push scanner's registry half was dead for weeks and nothing said
  so.** `FLEET_REGISTRY` pointed at a fleet repo path that a rename had
  removed, so `find_registry()` returned None, zero project names compiled,
  and every push passed the project-name check by not running it. The one
  guard that existed printed "no patterns configured" only when the pattern
  list was **completely** empty — and the 15 hand-curated denylist patterns
  kept it non-empty, so the guard never fired. The canonical copy in the fleet
  repo had the same bug mirrored: right registry path, denylist path pointing
  at a file that didn't exist. Each half worked in exactly one copy.
- **Rule: a missing source must fail, not warn.** A stderr line in a pre-push
  hook scrolls past under normal push output. "Expected" is inferred rather
  than declared — if *either* source resolved, this is a configured machine
  and both are expected, so a missing one is exit 2; if *neither* resolved,
  it's a stranger's clone with no config to be missing, so skip cleanly.
- **Resolve moving paths from a candidate list, current first.** Both of these
  paths moved once already. A candidate list turns the next rename into a
  fallback instead of a silent no-op.
- **An env override must be authoritative, never the head of the fallback
  chain.** `SCRUB_REGISTRY=/fixture` falling back to the real machine config
  would let a self-test pass against the wrong data — the same "I scanned
  something, just not what you think" failure, one level up.
- **`scripts/scrub-selftest.py` is the part that keeps it fixed.** Nine cases
  against temp fixtures, each planting something the scanner MUST find or
  asserting a specific refusal, wired into CI *and* into the hook itself
  (CI never runs the hook, and the hook is where the gate actually lives).
  Verified non-vacuous by mutation: deleting the `public: true` drop fails one
  case, turning the refusal back into a pass fails three.
- **How this was found is the reusable part:** the scan came back clean, and
  instead of believing it I fed the scanner a pattern it was supposed to
  catch. It didn't catch it. Same lesson as "a negative test needs a positive
  control", now with a production instance — and note the earlier report of
  "regex layer clean" was doubly wrong, because `scrub-check.py` takes file
  paths or `--diff-range` and **ignores stdin**, so piping content at it
  scans nothing and exits 0.

## A self-test is green until it runs on a machine that isn't yours

- **The fix for the gate above shipped with two bugs, and every one of its
  eleven cases passed on my machine.** A peer ran the same suite in the
  canonical repo and two failed immediately. The entire difference: **this
  repo has no `registry.yaml` at its root and that one does**, so
  `find_registry()`'s repo-local branch never executed here and executed every
  time there. The bugs weren't subtle — the local lookup ran *before* the
  `SCRUB_REGISTRY` override, so a self-test pointing at a fixture silently read
  the real fleet registry, found none of its planted names, and reported clean.
  **A positive control scanning the wrong data is worse than no control**, and
  it is the exact failure an authoritative override exists to prevent, one
  level above the bug being fixed. Rule: when a code path is gated on an
  environmental fact (a file exists at the repo root, a platform, a config
  present), the suite must construct BOTH shapes — here, `git init` a temp repo
  with a `registry.yaml` in it — because the shape you develop in is the one
  you will never test.
- **Some rows are unreachable from the environment by design, and that's where
  dead code hides.** The second bug — a stranger's clone getting every push
  refused, citing config paths that were never theirs — needed "no machine
  config, but this repo tracks its own registry". No env override can produce
  it: an authoritative override *suppresses* the repo-local lookup, which is
  the point of it. So "just run it in the other repo shape" cannot cover it.
  The fix is a seam: `decide_sources(registry, fleet_registry, denylist,
  require_sources)` is pure and table-tested over all eight combinations, with
  the end-to-end cases layered on top. **A branch reachable only in the field
  is untested by construction.**
- **Two spellings of "not found" is a bug generator.** `None` from the
  resolver and "a path that doesn't exist" from the old constants coexisted;
  each downstream guard picked a different one, and the escape-hatch branch
  became unreachable while reading as correct. One spelling, held everywhere.
- **Infer "is this machine configured" from machine-level facts only.** A
  repo-local `registry.yaml` arrives with the clone, so counting it as evidence
  turns every stranger into a fleet machine with a broken install.
- **The file a scanner skips is the file where the leak gets written.**
  `scrub-check.py` is in its own `SKIP_PATHS` (it quotes denylist keywords as
  examples, so scanning it blocks its own propagation) — and a private project
  name had been sitting in it, in this public repo, as the example for the
  word-boundary regex. Guaranteed-unscanned is exactly where an example name
  goes. Audit skip-listed files by hand, on a schedule, since no gate will.
- **A false positive on a REMOVAL is the worst false positive available.** The
  Haiku layer blocked the push of the commit that deleted that name, reading
  the `-` line as content going public. Blocking the fix is how a gate teaches
  people to reach for `SCRUB_SKIP=1`. The prompt now judges added lines only,
  verified both directions (an added leak still exits 1).

## gh pr merge --delete-branch switches your working copy to main

- When the branch being deleted is the CURRENT branch of the main
  checkout, `gh pr merge N --squash --delete-branch` checks out main
  locally (and tries to pull, which fails on a diverged local main with
  "Not possible to fast-forward" — harmless). The REMOTE merge succeeded;
  but your working tree just silently changed branches, so files appear to
  "revert" to pre-branch content. Bit us twice in one session. Run the
  merge from a checkout that is NOT on the branch, or expect the switch.
