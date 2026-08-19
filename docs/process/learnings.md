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
- **What it costs once written is a separate entry, and it is worse than a
  failed review** — see "A NUL byte makes grep silently blind, and the silence
  defeats the positive control too". The grep on this machine says nothing at
  all, so the file goes invisible to every literal check over it and over any
  diff containing it. This has now happened in three different source files.

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

## A positive control can silently become a duplicate of the thing it controls

- **Measuring what a server restart costs a doc mid-edit, the first run typed
  into two docs concurrently and killed the server once — 40 characters into
  one, 100 into the other, "the same" kill for both. The 40-character doc
  reported nothing lost, and it was not a result.** Typing 40 characters at
  80ms finishes 4.8 seconds before typing 100 does, so by the time the kill
  landed that doc had been idle far longer than the 200ms persistence
  debounce. It had quietly stopped being a second subject and become a second
  *control* — and it agreed with the control, which is exactly what made it
  look like a clean, reassuring row rather than a broken one.
- **Two subjects in one pass do not share the condition unless the condition
  is what ENDS the pass.** Here the variable under test was the gap between
  the last keystroke and the kill; anything that finishes typing early has a
  different gap, whatever the harness intended. Rule: **one subject per
  cycle**, with the control alongside it — and if a design needs several
  subjects in one pass, assert the per-subject condition (each one's own
  elapsed time at the moment of the kill) rather than assuming a shared event
  imposes a shared state.
- **This is the failure this file already records, inverted.** The usual form
  is a control that cannot see anything, so an absence reads as clean. This
  one is a control that sees everything and is therefore vacuous in the other
  direction: it is not that the row could never fail, it is that the row could
  never have failed *for the reason the experiment was about*. A pass that
  agrees with the control is the shape to be suspicious of, because it is
  indistinguishable from a subject that never entered the condition.
- What caught it was reading the numbers rather than the verdict — 40/40 and
  0/100 in the same pass, from a harness that claimed to treat both the same
  way, is a contradiction on its face. Re-run per-subject and the 40-character
  case loses its characters too.

## A probe that always answers "yes" is as vacuous as one that always answers "no"

- **`grep -qa $'\0' FILE` reports the NUL as present for every file on earth,
  including one containing only `hello world`.** A NUL cannot survive `argv`,
  which is NUL-terminated, so however the shell holds it the pattern reaches
  `grep` as the **empty string** — and the empty pattern matches everything.
  Measured 2026-08-19: zsh's `${#p}` for `p=$'\0'` is `1`, so the shell is not
  the culprit and bash behaves identically. On that reading I stated in several
  messages and in a written summary that the built bundles contained NUL bytes.
  None of them ever did.
- **The rule: a probe that always answers "yes" is as worthless as one that
  always answers "no", and it is harder to notice** — a positive reading feels
  like a finding, while a negative reading feels like an absence you already
  distrust. Nothing about the output looks wrong; it looks like a hit.
- **The control is the same one line pointed the other way: run the probe
  against something that cannot possibly contain the thing.**
  `printf 'hello world' > /tmp/control.txt` and re-run it. One command, and it
  ends the claim.
- **A working form, directional and testable:**
  `perl -0777 -ne 'exit(index($_,"\0")>=0?0:1)' FILE` — exit 0 on
  `hello\0world`, exit 1 on `hello world`. The byte count in the NUL entry
  below is the other honest form.
- The archive already holds the neighbouring corners: "A negative test needs a
  positive control or it proves nothing" (the probe can see nothing) and "A
  positive control can silently become a duplicate of the thing it controls"
  (the control never entered the condition). This is the third — **the probe's
  answer does not depend on its subject at all.**
- **Its exact mirror is the circular `--cc` control** in "`git show --cc` has
  THREE outcomes, and the control for it must be `-c`": one control that always
  passes, one that always fails to fail. Same bug from opposite ends, and both
  were hit in the same session by the same person chasing the same byte.

### The thesis, stated once for the whole family

**Every failure in these entries had a check that ran, printed something, and
meant nothing — and in each case the thing that would have caught it was one
deliberate attempt to make the check fail.** Five distinct instances measured
on 2026-08-19, different tools, one shape:

1. a probe that always passed — an empty grep pattern (this entry);
2. a probe blinded by a control byte — "A NUL byte makes grep silently blind";
3. a control drawn from the same suppressed measurement it was checking —
   "`git show --cc` has THREE outcomes";
4. a log read as an inventory it never was — "`bun test`'s log cannot
   enumerate its own run set";
5. a grep for a string at a column the command never puts it in —
   "`git merge-tree`'s three-arg form hides conflict markers behind a diff
   prefix".

**The sharper form of "a negative probe needs a positive control": agreement is
not independence.** Three agents re-running the same runner is one derivation
with three witnesses. A control has to come through a *different derivation* —
a different tool, a different flag, a different computation — not merely a
different invocation of the same one. The counterexample that proves it: the
one test-file count that held up under scrutiny had **two** derivations, a
static `git ls-tree` off the config globs *and* the runner's own enumeration.
Every count that went wrong had one.

## A positive control must be a peer in TIME as well as in kind

- **The lead reviewing a board read the workspace to check whether an agent had
  filed three decision tasks, found them absent, and told the agent in strong
  terms that its comment claimed a step it had not performed. It had.** The read
  landed in the window before the creates returned: the agent's rows are stamped
  18:08:35, and the freshest row the read could see was one of the lead's own at
  18:05:52 — two minutes forty-three seconds early. Not a cache; a live HTTP
  call against the running server, so this is real elapsed time between two
  observers of one store.
- **There WAS a positive control and it did not help.** Enumerating seven
  pre-existing `needs: 'decision'` rows proved the probe could see decision rows
  — the right control in KIND, and exactly what "A negative test needs a
  positive control or it proves nothing" asks for. It says nothing about whether
  the view being read included the writes being looked for. "A modal the page
  AWAITS makes every absence on that page vacuous" is the same gap one layer
  over: those entries are about a probe's REACH, and neither is about its
  RECENCY.
- **The tell was already in the output, for free.** The newest row the probe
  returned was older than the thing being searched for. That one comparison
  separates *"it is not there"* from *"I have not caught up"*, and it costs no
  extra call — the timestamps are already in hand. **Rule: when asserting an
  absence in a store other writers are actively appending to, compare your
  view's high-water mark against the time the missing thing would have been
  written. If the mark predates it, you have measured your own lag rather than
  an absence.**
- **A too-early read and a skipped step are indistinguishable from a single
  observation** — the same family as "A truncated page read is
  indistinguishable from a page that never rendered": the probe ran, it just
  measured something other than what it claimed to.
- **The cost is not only a false accusation.** The instruction that followed was
  to re-file, and three duplicate decision rows would have landed on a board a
  human was about to read. The agent stopped, checked, and answered with
  timestamps instead of complying. **An agent told confidently that its work is
  missing should verify before re-doing it** — when the operation creates rows,
  re-doing is not the safe default.

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

## Widening a predicate's DOMAIN is a change to the predicate, and the corpus holds shapes no fixture has

- **`GET /` returned 500 in production twenty minutes after a merge, and not one
  line of the function that threw had changed.** The new landing page is the
  first caller to run `awaitingPerson` across EVERY doc on the server rather
  than across one live workspace's threads. That reached comment rows written
  months ago, and `classifyActor` (`activity.ts`) did
  `author.id.startsWith('agent-')` on an author with no `id`:
  `TypeError: undefined is not an object` — thrown from `unansweredRun`, called
  from `buildLandingModel`. `awaitingPerson` was correct, well-tested and
  untouched. **Its domain moved, which is a change to it.**
- **The type said `User`; the data did not.** Comment authors are persisted in
  the CRDT by whatever wrote them, across months and several shapes of the
  field. Measured across the whole corpus afterwards: **26 of 1,825 comments
  carry an author that is a bare STRING** rather than an object, all of them in
  one doc family. TypeScript cannot see this — the value was typed at the
  boundary years of writes ago, and nothing revalidates a CRDT on load.
- **The evidence was in hand two hours early, and I coded around it.** While
  measuring the corpus to design the feature, my own probe hit exactly this and
  I added `if isinstance(a,str)` to the probe so the measurement would finish.
  The log line said `string authors seen: 1`. I read it as a probe detail rather
  than as a fact about production data. **A defensive workaround you write in a
  throwaway probe is a bug report you filed against yourself and then closed.**
  When a probe needs a guard the production code does not have, that asymmetry
  IS the finding — stop and check which one is wrong.
- **Fixtures cannot find this and the corpus can.** Seven mutations, four gates
  green, 1,525 server tests, an adversarial review pass and a route-level e2e
  all passed over hand-built authors that were well-formed by construction —
  because nobody invents the malformed input that breaks their own code. This
  file already says "Re-measure a widened heuristic against the corpus that
  justified it"; the same rule applies when the heuristic does not change at all
  and only its INPUT SET widens.
- **Fix at the classifier, not the call site.** A landing-only guard leaves every
  other caller exposed to the same rows. `classifyActor`'s own header already
  said the field is "hand-populated by outside callers" — the function had
  anticipated hostile input and defended only against case variation.
- **A defensive guard must not become a silent behaviour change, so pin the
  happy path.** The repair reads `id`/`name`/`kind` defensively and a
  positive-control test asserts all six well-formed classifications resolve
  exactly as before. Without that, "no longer throws" is satisfied by a function
  that classifies everything as one thing. An unreadable author declares
  nothing, which is the same state as `kind == null` — already `agent`, the safe
  direction, since an agent misfiled as a person launders the audit log and can
  resurrect a resolved thread while the reverse only over-filters.
- **Grep every OTHER reader of the field before calling it fixed.** Three more
  read `author.id`/`author.name` unguarded. Checked rather than assumed: on a
  string author they are property reads, not method calls, so they do not throw
   — but `activity-backfill.ts` writes those 26 rows with `actorId`/`actorName`
  undefined, degrading the weekly-review stream rather than crashing it. A
  quieter failure in the more important place.
- **A fixture where two ranking criteria agree cannot tell them apart.** From
  the same change's mutation round: "group ranking ignores the needs-you count"
  SURVIVED, because the fixture's busiest group was also its freshest, so a
  recency-only ranking produced an identical order. It only went red once the
  fixture was rebuilt to make the criteria disagree — most-waiting group also
  the oldest. **Any test of a multi-key sort needs a case where the keys
  conflict**, or it proves only that the first key exists.

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

## A git operation on a bound file is an editor save, and it goes both ways

- **Measured 2026-08-17 in a running server over synthetic git fixtures, not
  read off the source.** The premise was filed from a code reading; every
  claim below reproduced. `git checkout -- <file>`, a branch switch, `git
  stash` and `git pull` all rewrite the bytes and bump the mtime, and nothing
  they leave on the file distinguishes them from a person saving in an editor.
  So the poll classifies them with `decideReconcile` like anything else, and
  which of two very different things happens depends on the live doc:
  - **Live doc idle → `apply`.** The git content lands in the doc. A reader
    watching a bound doc sees it change to the other branch, with no
    `syncError` and nothing on the page saying why. This is arguably correct —
    the doc is a view of the file — and it is left alone.
  - **Live doc has un-flushed edits → `conflict`.** The live doc wins and is
    reasserted onto the working tree ~800ms later. **git exits 0, `git status`
    was clean, and a second later the file is modified again.** For `git
    stash` the result is worse than it sounds: the stash really did consume
    the change, and the tree comes back dirty holding content that is in
    neither HEAD nor the stash, so a later `git stash pop` has an unexpected
    local change to contend with.
- **The window is the 800ms write debounce after any live edit — but it
  re-arms on every keystroke**, so a doc somebody is actively typing in is
  continuously in it. This is not a rare race for the surface it matters on.
- **The policy is right and stays.** Letting a git-sourced write win would
  clobber a human's un-flushed edits, which is the exact incident class the
  conflict arm exists to prevent. The harm here is not that the wrong side
  won — it is that **nobody is told**. `syncError` is reachable only through
  `get_doc` and MCP edit responses, and the person who just ran `git checkout`
  is looking at a terminal.
- **Don't reach for a "suspend sync while I run git" call.** A human at a
  terminal never makes it, an agent shelling out to `git` never makes it
  either unless taught, and it cannot be made automatic — which is the
  "a tool somebody has to decide to call" failure this file already records
  twice. What shipped instead: the conflict `syncError` now names git.
- **The signal that makes that possible is provenance, checked after the
  fact.** `git hash-object` the bytes we are about to overwrite and ask
  whether the repo already contains that blob. An editor save produces content
  the object database has never seen; a checkout, stash, branch switch or pull
  writes a blob that is in it by construction. Verified to discriminate in
  both directions — HEAD's content and another ref's blob classify as `git`,
  typed text and an empty string do not — and it degrades to "unknown" outside
  a repo or when the directory is gone. It is **advisory only and never
  changes which side wins**, so a false positive can at worst name git in a
  message; it cannot lose anyone's work.
- **A recovery instruction is a claim, and this one was false in the first
  draft.** The hint ended "…or `reparse_from_disk` to let the git version win",
  which cannot work for the reason the comment three lines above the call site
  already gave: the reassert reaches disk first, so a reparse faithfully pulls
  our own content back. Measured — reparse returns ok, the doc is unchanged,
  **and the syncError is cleared**, so following the advice also throws away
  the only pointer to the backup holding the git version. A recovery step that
  returns ok and changes nothing is the worst available shape: it reads as
  success to the one person who just lost something. The advice that works is
  what the pre-existing half of the same message already said — restore the
  backup, or let the doc go idle and re-run the git command. **Rule: an
  instruction embedded in an error message needs the same test as a code
  path.** Nothing else will ever execute it, so it fails silently by
  definition. Found by an independent second measurement of the same premise,
  not by this branch's own review — which is the argument for running one.
- **The test that pins this measures behaviour, not the fix.** It asserts both
  directions of the reconcile for all four operations, so a later change that
  alters either one goes red — with an editor-save positive control in the
  same file, because a harness where the poll never fires would report the
  same silence for every git case. Mutation-verified both ways: an
  unconditional hint fails the "an ordinary editor save does NOT blame git"
  case, and a suppressed hint fails the "names git" case.
- **Assert the shape before the behaviour, again**: each git case checks that
  the mtime actually moved before checking what the doc did, since a git
  command that left the file byte-identical would produce a clean-looking
  "nothing happened" for the wrong reason.
- Still open, and it is the half that would reach the operator: the
  `syncError` has no event on the doc's watch channel, so an agent that runs
  `git checkout` and is watching the doc is not told. That is the backlog item
  already noted under the bound-doc sync contract.

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
- Can't add new inline marks by default. Replacement strings with `**bold**`
  / `*italic*` / `[link](url)` syntax land as literal characters unless you
  pass `parseInlineMarks: true`, which interprets them as marks.
- **It used to DELETE marks that were already there, silently — that half is
  fixed, and it was data loss rather than a missing feature.** Until the
  covering-marks fix, the replacement was re-inserted with NO attributes, and
  Yjs' unattributed `insert` inherits the marks of the character to the LEFT
  of the insertion point. So a match starting strictly inside a bold run kept
  its bold (which is why most replaces looked fine), while a match starting at
  the run's FIRST character inherited the unmarked text in front of it — and
  when the match covered the whole run (a bold label, a link, an inline-code
  span) the mark disappeared from the document with `ok: true` and nothing
  else to see. Found in the field on two list labels whose siblings kept their
  bold, caught only because someone counted `**` markers before and after.
  **The one-sentence trigger: the replacement inherited from the left instead
  of from the text it replaced, so any match beginning at a marked run's first
  character lost that run's marks.**
- Both edit paths now read the marks off the text being REPLACED
  (`coveringInlineMarks`), which is what the suggestion path always did — so
  before the fix, `suggest: true` + accept PRESERVED the bold that the plain
  call destroyed. When two paths are supposed to produce the same state, test
  them against each other; the disagreement is the bug report.
- **Marks covering only PART of a match still cannot be carried** — one
  replacement string has no correspondence to the runs it replaces — so those
  come back as `marksDropped: ['bold']` plus a `warning` on the 200 response.
  That is the actual fix: the loss that remains is the loss that gets
  reported. Widening the match to include an unmarked character is also how
  you deliberately REMOVE a mark.
- Backlog: a dedicated `apply_mark` tool.

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

## A flag nobody renders is not a feature — check the surface before believing the report

- **The task said "the board shades unproven moves". It didn't.** `unproven`
  was computed at transition time, returned to the caller, and put on the
  event — and consumed only by a transient toast in `hub-app.ts`. It was never
  persisted on the row and no surface rendered it. So the acceptance criterion
  "the shading clears once evidence lands" required first BUILDING the
  shading; taken literally it was satisfiable by changing nothing anyone could
  see.
- **Same family as "the store has it is not the surface can show it", inverted.**
  There the data existed and the UI could not reach it. Here the *bug report*
  assumed a surface that was never built — so the premise to reproduce is not
  only "does the bug happen", it is "does the thing the bug is about exist".
  A field on an event is not a feature until something renders it, and the
  distance between those two is invisible from the server side, where every
  check comes back correct.

## A media query adds no specificity, and forcing one ON for a test must not grant it any

- **A rule inside `@media` loses to an equal-specificity base rule LATER in
  the file.** Wrapping a declaration in a media query changes when it applies,
  never how strongly — so the phone row's `min-width: max-content` was
  authored, matched, and still lost to the plain rule below it. Nothing warns:
  the media query matches, devtools shows the rule, and the computed value
  comes from somewhere else.
- **A harness that forces media rules on must mutate `CSSMediaRule.media.mediaText`
  IN PLACE.** The first one unwrapped them into a fresh `<style>` appended to
  the document — which hands every unwrapped rule last-wins position and
  measures a cascade no browser produces. It reported `min-width: max-content`
  as applied while production computed `0px`. The harness was not merely
  imprecise; it inverted the exact ordering the bug lived in.
- Caught by `codex review`, confirmed in-browser, now covered by an ordering
  test. The reusable half is the second bullet: when a probe has to put the
  page into a state (a viewport, a media condition, a feature flag), reaching
  that state by REBUILDING the artifact instead of re-conditioning it is how a
  probe ends up measuring something the product never does. Same family as
  "a positive control scanning the wrong data".

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

## The scrollbar's width in CSS px depends on browser ZOOM, so record `devicePixelRatio` with any measurement that touches it

- **Same page, same tab, same harness, two different scrollbar widths across
  runs — and the discriminator was zoom.** Measured 2026-08-19:
  `devicePixelRatio 1.600` → scrollbar **19** CSS px; `devicePixelRatio 2.000`
  → **15**. The scrollbar is a fixed number of DEVICE pixels, so the CSS-px
  figure scales with the ratio: `15 × (2 / 1.6) = 18.75`, i.e. the 19. Six
  consecutive runs at dpr 2 read 15 every time and a full seven-width sweep at
  dpr 1.6 read 19 every time, so each reading was internally stable and neither
  was noise.
- **The first diagnosis was that off-screen or transform-scaled iframes are
  unfaithful rulers. That was wrong** — correlation only: the scaled-iframe
  runs happened to fall while the window sat at 80% zoom. Unscaled, on-screen
  iframes reproduce both values. Worth stating plainly because the wrong
  diagnosis sends the next person to go and fix their iframe when the thing to
  check is the zoom.
- **Re-read `devicePixelRatio` per RUN, not once per session.** This is a
  shared browser and the zoom changed mid-session with nobody touching it
  deliberately. A ratio captured at setup and reused describes a window that
  may no longer exist.
- **A layout assertion that moves with zoom is measuring the scrollbar, not the
  layout.** The payoff of the two real ratios is that a fix could be checked at
  two genuine scrollbar widths without synthesising either: the board pinned to
  exactly **420px** at both, with the side panel absorbing the 4px difference
  (988 vs 992). The previous build gave **422** at sb 15 and **418** at sb 19 —
  it passed or failed depending on the zoom of whoever ran it.

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
- **Grepping only the NEW bundle is still a vacuous probe: a literal
  discriminates only if it is 0 in the OLD bundle and non-zero in the new.**
  Check both, old one first. On a later deploy two of the first candidate
  literals were source COMMENTS — which the minifier strips, so their absence
  said nothing about whether the feature shipped — and a third was already in
  the pre-deploy bundle, so finding it said nothing either. Pick literals from
  runtime strings a user could see (visible copy, a CSS class that appears in
  the stylesheet), never comments or identifiers, both of which a minifier is
  entitled to remove. The pairs that worked: `Reconnecting` 0→1 and `Keep this
  tab open` 0→1 in `hub.js`, `save-state--offline` **1→2** in `styles.css` —
  that last is a COUNT rather than a presence, because the class already
  existed and only the un-hiding rule was new.
- **Keeping the previous release on disk is what makes the old-bundle half
  checkable at all.** The numbered-release mechanism ("Prod no longer serves the
  client out of a working tree", below) earns its keep as a verification tool,
  not only as a rollback path.
- Fix (this PR): prod `serve.ts` rebuilds the widget + markdown-app bundles
  once at startup, before the server spawns — restart == deploy. A failed
  build logs loudly and serves the existing dist (stale beats down).

## A restart deploys the deploy SOURCE, and a stale source restarts silently

- **A kickstart run specifically to ship a just-merged client republished the
  previous one.** Prod came up in five seconds and answered 200; the served
  release stamped `sourceRef: 1b0af1e8` while `origin/main` was at `1080bf8`,
  and every feature literal from the merge counted 0 in the served bundle. The
  primary checkout — which is prod's deploy source, and which prod rebuilds its
  bundles from at every start — was on `main` and **10 commits behind
  `origin/main`, with a completely clean tree**. `git pull --ff-only origin
  main` and a second kickstart fixed it, `sourceRef: 1080bf84`.
- **Nothing about the bad state looks bad.** The checkout is on the right
  branch, `git status` is clean, the service is healthy, the port answers, the
  page loads. A healthy server serving a stale bundle is indistinguishable from
  a healthy server serving a fresh one — and `-dirty` cannot help, because
  being behind is not being modified. The deploy source's *freshness* and its
  *cleanliness* are different facts and only the second one has a marker.
- **Rule: the deploy is `pull` → `kickstart` → *read `release.json`*, and it is
  done when `sourceRef` is the commit you meant to ship** — not when the restart
  returns. The provenance already exists for exactly this reason (the entry
  about a fallback needing a durable trace records why `sourceRef` is stamped at
  all); this is the reading it was built for, and skipping it is how the whole
  mechanism ends up costing a deploy anyway.
- **The trap is not restarting — it is restarting for some OTHER reason.** Any
  restart from any cause is the client deploy, so a config-only
  `scripts/launchd/install.sh` reinstall ships whatever the checkout holds.
  [tailnet-https.md](tailnet-https.md) already warned about this in its own
  narrow context; it is general.
- Same family as "A prod restart reloads server code but NOT the served app
  bundle", one layer earlier. That entry closed the gap between *server* and
  *client*. This one is the gap between *the client that got built* and *the
  code that was merged* — the restart faithfully deployed a source nobody had
  updated.

## The restart that delivers the client cannot be the restart you measure

- **A prod restart IS the client deploy here (the entry above), so "open the
  page, restart, watch what the tab does" measures the PREVIOUS client.** The
  restart replaces what the server *hands out*; a tab that already loaded its
  bundle keeps executing the one it has. Nothing about the observation looks
  wrong — a real page, reconnecting for real, just not the build under test.
  Caught mid-verification of the reconnect behaviour only because the bundle
  being served when the pass started was still the pre-feature one; one step
  later the feature would have been reported verified against a client that did
  not contain it.
- **The sequence that works is restart → reload → restart.** The first restart
  publishes the new client, the reload gets the tab onto it, and the second
  restart is the one you actually measure. The first pass is delivery, not
  evidence.
- **General rule: when the thing you are testing is DELIVERED BY the event you
  are testing across, one pass cannot verify it** — one pass to deliver, a
  second to observe. Same family as "a negative test needs a positive control
  or it proves nothing" and "A truncated page read is indistinguishable from a
  page that never rendered": the probe ran, it just measured something other
  than what it claimed to.
- Two browser mechanics this verification leaned on — reaching a true 430px
  viewport, and what timer throttling does to a measured debounce — are written
  down in the `ux-review` skill, which is where someone checking a UI looks.

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

## Staging is a port and a data dir — it is not a sandbox for anything naming a target outside the process

- **`createDeployer` hardcodes `spawnGit(opts.repoRoot)` and `launchctlRestart()`, and `launchctlRestart` defaults to the PROD launchd label.** So passing `--deploy` to a `bun run staging` instance does not produce a staging deploy: it pulls a checkout and restarts **prod**, from a process started on port 8788 with a throwaway data dir by someone who believed they were isolated. Caught while designing a probe of the busy-docs gate, before running it — the tempting shape ("staging server, real deployer, real route") is the one that deploys.
- **The rule the isolation actually gives you is narrower than the word "staging" suggests.** A separate port isolates who can reach you. A separate data dir isolates what you read and write. Neither does anything about a capability that names its target by *label*, *absolute path*, or *hostname* — a launchd job, a checkout, an API endpoint, a plugin cache. Before treating an instance as safe to experiment on, grep the capability for names it resolves independently of the process: `LAUNCHD_LABEL`, `repoRoot`, a hardcoded URL, a well-known path under `$HOME`.
- **The mitigation already exists in this codebase and is the reason the hazard is only latent: the constructor seam.** `createDeployer` is called in exactly one place (`bin.ts`, behind a flag only `scripts/serve.ts --no-watch` passes), so no test run and no staging server builds one by accident — the same rule the plugin refresher and the summarizer follow. What a probe wants instead is the layer *below* the constructor: build `new Deployer({ run: (req) => runDeploy({ git: fakeGit, restart: fakeRestart, … }, req) })` by hand, which exercises the real route, the real `Rooms` and the real predicate while nothing can reach git or `launchctl`. **A convenience constructor that wires real side effects is the thing to route around, not the thing to call with care.**
- Same family as "What makes a fleet-wide action safe is that it can't interrupt anybody", inverted: there an operation was already safe and got a mechanism it did not need; here an operation looks contained by its surroundings and is not contained at all. Both answers come from reading what the operation *touches* rather than what it runs next to.

## A session restart orphans a subagent's worktree, and the shell falls back to the primary checkout without saying so

- **A subagent was working in `.claude/worktrees/<name>`; the parent session
  restarted mid-flight, the worktree was destroyed, and the agent's next `cd`
  silently resolved to the primary checkout — on `main`, where its first
  excision landed.** It caught this on the next `git rev-parse --show-toplevel`
  and reverted with `git checkout --`; no bundle was built there, so nothing
  deployed. The other direction is the expensive one: that checkout is prod's
  **deploy source**, so bundles built in it ship to the whole fleet at the next
  restart (see the entry below, and the `bun run staging` entry above).
- **A missing directory does not announce itself.** A shell whose cwd has been
  deleted keeps running and resolves relative paths somewhere else entirely —
  no error, no prompt, and `git status` in the place it landed looks perfectly
  healthy, because it *is* a healthy repo. Nothing in the session reads as
  wrong until you check which tree you are in.
- **Rule: re-run `git rev-parse --show-toplevel` after any shell restart, after
  any unexplained error, and before the first write of a session.** Compare it
  against `git rev-parse --git-common-dir` while you are there — equal to
  `--git-dir` means you are in the primary checkout, which is the one place a
  build is a deploy.
- **An absolute path is not protection, and this entry has its own instance.**
  The first Edit writing these four entries went into the *primary checkout's*
  copy of this file, because that was the absolute path already in context from
  reading it there — the call was correct about a file and wrong about which
  tree. Reverted with `git checkout --` and confirmed by an empty
  `git status --porcelain`. Check the tree the path names, not merely that the
  path is absolute.

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
- **A git command counts as a disk write, and the same rules apply to it** —
  `git checkout`, a branch switch, `git stash` and `git pull` are
  indistinguishable from an editor save at the poll. Against un-flushed live
  edits they lose the same way, which means the git operation is partly undone
  a second after git reports success. Before running one in a checkout with
  bound docs, let the docs go idle (~1s after the last edit); afterwards, if
  the tree is unexpectedly dirty, read the doc's `syncError` — it now says
  when the bytes it overwrote came from git. Full measurement in "A git
  operation on a bound file is an editor save, and it goes both ways" above.
- Backlog (peer request): emit a `syncError` event on the doc's watch
  channel (docId, relPath, dropped sids) so a lost write announces itself
  the way comment events do. **This is what the git case above needs too** —
  the agent that ran `git checkout` is the one watching the doc, and today
  nothing tells it.
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

## An agent roster under-reports live agents, and the branch is the thing that knows

- **The session's agent listing showed two subagents, so an agent named
  `one-create-verb` was taken to have finished its work on PR #178. It hadn't —
  it was alive and about 56 seconds from a write.** On that premise a second
  agent was spawned and pointed at the same branch, to fix the version collision
  the first one was already fixing. Nothing bad happened, and the reason is the
  part worth keeping.
- **The second agent established liveness from the ARTIFACTS, and asked the
  right question: not "is the branch busy" but "is the other side live".**
  `git worktree add` refused — reproduced verbatim while writing this entry:
  `fatal: 'verify/batch-internal-after' is already used by worktree at
  '.../.claude/worktrees/one-create-verb'`. **On its own that reads like a stale
  lock and invites `--force`**, which is exactly the wrong read. What settled it
  was two independent facts: `stat` on the three version files
  (`packages/plugin/.claude-plugin/plugin.json`,
  `.claude-plugin/marketplace.json`, and `PLUGIN_VERSION` in
  `packages/mcp/src/mcp.ts`) showing modification 56 seconds earlier, and the
  branch's local HEAD being a merge commit `origin` did not have. Both say
  *someone is writing right now*, which a lock file cannot.
- **Two agents force-pushing one branch is a worse failure than the version
  collision they were both trying to fix.** That asymmetry is why the check
  belongs before the write and not after.
- **Rule: before a second agent touches a branch, establish liveness from the
  artifacts — worktree locks, file mtimes, local-vs-remote HEAD — not from the
  roster.** A roster is a cache of who is *running*; the working tree is ground
  truth about who is *writing*, and the gap between those is where this lives.
- Same discipline as a positive control, one level up: prove your probe can see
  activity before concluding anything from its silence. An empty roster row is
  an absence measured by a cache.

## Restoring a tree in place is indistinguishable from data loss to whoever else is writing in it

- **The entry above is the near-miss; this is the same day's hit.** A second
  agent was spawned onto task `t-Us2HML0w5cfK` because a roster did not list the
  one already working it, and it hard-reset the worktree it found
  (`.claude/worktrees/git-vs-bound`, branch `fix/git-ops-vs-bound-docs`). The
  reflog recorded `reset: moving to HEAD` and then `reset: moving to
  origin/main`; an entire uncommitted first pass — a new source file, three
  edits to `rooms.ts`, two to `learnings.md`, a new test file — was gone.
  **`git add -A` had run seconds earlier and `git fsck --unreachable` in that
  worktree found none of the blobs**, so the recovery that usually applies did
  not. The work survived only because it was reconstructable from conversation.
- **The general shape is any harness that restores state IN PLACE**, and a
  mutation test is the common one: write a mutation, run a suite, put the file
  back with `git checkout -- <file>`. That is correct in a tree the harness
  owns and a silent revert of somebody else's uncommitted edit in a tree it
  shares. Same class as the reset above — an operation whose definition of
  "restore" is "whatever HEAD says", run where HEAD is not the only truth.
- **Against a bound doc it is worse, and that half is measured** (task
  `t-3bFI5h-F9qRW`; full detail in "A git operation on a bound file is an editor
  save, and it goes both ways"). `git checkout -- <file>` inside the 800ms write
  debounce is reasserted by the live doc about a second later, so git exits 0,
  `git status` is clean at that instant, and the tree is dirty again immediately
  after. `git stash` in the same window leaves the content in **neither HEAD nor
  the stash**, and no git command brings it back.
- **Two rules, both one-directional.** A harness that needs a clean tree takes a
  **detached worktree at a sha** (`git worktree add --detach <dir> <sha>`),
  never a restore-in-place in a checkout somebody else may be writing — its
  worst failure is a stray directory, which is cheap. And **"this worktree looks
  abandoned" is not a fact you can read off a roster**: establish liveness from
  the artifacts (worktree locks, file mtimes, local-vs-remote HEAD) as the entry
  above says, before the write rather than after.
- **The layer that protects concurrent writers does not extend to the file.**
  "Concurrent agent+human edits are CRDT-safe; disk reconcile was not" is about
  two parties editing the same doc, where Yjs merges them; nothing merges two
  parties editing the same working tree, and git's restore verbs are written on
  the assumption that there is only one. That asymmetry is why the expensive
  window is the one before the first commit — **commit as soon as a coherent
  chunk exists** rather than letting a whole implementation pass sit in the tree
  while a long suite runs.

## A report written as turn text is a report nobody receives

- **Two agents on one night wrote complete, correct reports as plain output
  instead of sending them, and both presented to the lead as idle with no
  result.** In each case the work was done: the four gates had run, the merge
  had landed. What did not happen was the send. Nothing errors — the author has
  written the report and reads its own transcript as evidence it reported, the
  recipient sees silence, and no tool call failed anywhere.
- **The cost lands on the reader, who cannot tell a silent agent from a stalled
  one.** One lead spent a verification pass checking a merge's outcome from the
  outside on the assumption the work had stalled. That confirmed the file was
  intact and could say nothing about whether the resolution was sound — the part
  worth reviewing was a judgment call that existed only in the unsent report.
- **An idle signal is a measurement of the CHANNEL, not of the work** — the same
  shape as "An agent roster under-reports live agents, and the branch is the
  thing that knows", one transport over. There a cache under-reported who was
  running; here the transport under-reported what was finished. Both are
  absences measured by something other than the artifacts, so establish state
  the same way: the branch, the PR, the worktree, the file mtimes.
- **The reusable half is not "remember to call the tool".** It is that when the
  deliverable IS a report, finishing the work is not finishing the task, and the
  send is the only step with no local evidence that it happened. Treat an
  unacknowledged report as unsent rather than as received.

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

## A merge commit re-presents public content as an addition

- **The pre-push gate blocked pushes over content that was already on
  `origin/main`** — reported three times in one day by two agents, each time
  with the flagged strings appearing ZERO times in the branch's own three-dot
  diff. Cause: the hook asked `git diff <remote_sha>..<local_sha>`, which
  compares two TREES. The moment a branch merges `main` — which the conventions
  require before the final push, and which is the only way to get CI to run on
  a dirty PR — everything `main` gained since the branch point is an addition
  in that comparison. Measured on this repo: a branch whose own change was two
  README lines presented **7,516 insertions across 64 files**, 509 of them in
  `learnings.md` alone. So the gate fired on the normal path, over content it
  had already let through, and the only available response was `SCRUB_SKIP=1`.
  Same family as "A false positive on a REMOVAL is the worst false positive
  available", one level up: there the fix was to judge added lines only, and on
  a merge commit "added" is the wrong question.
- **The trigger is content-dependent, which is why counter-samples exist.** A
  peer reported two merges that passed clean, and a 12-commit merge of real
  `main` came back CLEAN from Haiku in this investigation while presenting all
  7,516 lines. The exposure is present on EVERY merge; whether it fires is a
  coin flip on what `main` happened to gain and how the model reads it that
  run. "It passed last time" is not evidence the gate is asking the right
  question.
- **Ask about COMMITS, not trees** (`scripts/scrub_git.py`): everything
  reachable from the pushed tip that is not reachable from a ref the remote
  already has. A commit drops out only when it is already public, so the change
  can only remove false positives. The regex layer had the same defect latent —
  deterministic, so `main`'s content passed it every time, but the day a name is
  ADDED to the registry the next branch to merge `main` is blocked on
  weeks-old public content. Both layers now ask one shared question.
- **`--cc` is load-bearing, and probing both ways is what proved it.** `git log
  -p` prints NO diff for a merge commit by default, and a merge is exactly where
  conflict resolution can introduce text present in neither parent. With `--cc`
  a string written during a resolution appears; without it, it does not. The
  self-test case for it goes red when `--cc` is removed.
- **The fix introduced a NEW false positive one layer over, and only the
  end-to-end pass caught it.** With `--cc`, a conflict resolved by discarding
  the other side renders that side as REMOVALS — and Haiku listed them, then
  appended "these are all on removed lines... the push is safe", while emitting
  `VERDICT: LEAKS_FOUND`. Its reasoning was right and its verdict was wrong,
  and the verdict is the only thing the script reads. Two prompt changes: the
  removal rule now describes combined-diff marker COLUMNS (`++`, `-` + space,
  ` -`) rather than "a line starting with `-`", and the output contract says
  the VERDICT line is the only thing read, so an item you have concluded is
  safe must not be listed at all. Verified over three passes.
- **Trading a common false positive for a rarer one you created is not a fix.**
  The unit tests were green and the self-test was green before that second bug
  was found; what found it was running the real layer against a fixture built
  for the OTHER case and reading the output instead of the exit code.

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

## A restart can move a session BACKWARDS a plugin version

- **The plugin resolves from a version-keyed CACHE, not from this checkout.**
  `claude-live-feedback` is registered as a **GitHub-source** marketplace, so
  `${CLAUDE_PLUGIN_ROOT}` points at `~/.claude/plugins/cache/...`, and a merge
  to main changes nothing anywhere until someone runs
  `claude plugin update live-feedback@claude-live-feedback`.
- **The failure mode this produces is counter-intuitive and cost a full
  restart cycle.** A session whose MCP child happened to be launched against
  the working tree was running 0.1.15; the respawn dropped it onto the cache,
  which was still at 0.1.12. So the restart — done specifically to pick up new
  tools — **removed** them. Confirmed by grepping the two bundles:
  `set_task_dependencies` appears 2x in the 0.1.15 bundle and 0x in 0.1.12.
- **`claude plugin update` is the deploy step; the restart only picks up
  whatever the cache holds at that moment.** The CLAUDE.md bullet above said
  "merge, then the peer restarts", which reads as though the restart is what
  delivers. It isn't, and the order matters: update, THEN restart. Restarting
  first gets you the old version and looks like the merge didn't work.
- **Verify from inside the session, not from a spawned child.** A subagent
  gets its own MCP connection and proves nothing about the parent's. The
  check that counts is `ToolSearch` for the new tool name in the session that
  needs it, followed by an actual call against real data.
- **Consequence for a fleet: a merge does not deliver.** After one update ran,
  exactly one peer was on 0.1.15 and eight were still on 0.1.12, each picking
  it up whenever it next happened to restart. So "is this feature available?"
  has a different answer per peer, and any feature whose value ships inside
  the bundle (a skill, a tool description) can't meet its acceptance until
  delivery stops needing a person.

## A shell wrapper made an agent conclude it was forbidden from deploying

- **`claude` is a shell FUNCTION on this machine** — it re-invokes the real
  binary with `"${CLAUDE_CHANNEL_FLAGS[@]}" "$@"` — so the flags land ahead of the
  subcommand and `claude plugin update …` is parsed as a prompt: *"Input must
  be provided either through stdin or as a prompt argument when using
  --print"*. Reproduced on `plugin list`, which is read-only: the function
  form errors, `command claude plugin list` prints the plugins. It fails even
  with that array empty, so it is the wrapper, not the flags.
- **That error reads exactly like a permission refusal**, and a ticket
  recorded it as one: "the one-line fix is not mine to run", generalised into
  an agent being unable to deploy at all. It was a footgun, not a wall. Fix:
  `command` bypasses functions and aliases — `command claude plugin update
  live-feedback@claude-live-feedback`.
- Same family as "X is impossible measured AN absence, not THE absence".
  Before writing down that a capability is denied you, check whether what
  refused you was the tool or a wrapper around it: `type -a <cmd>` costs one
  line and would have saved this one a ticket and a fleet-wide belief.

## Drift you have to go and look for is drift nobody looks for

- **`main` reached 0.1.26 while every peer's cache sat at 0.1.15 — eleven
  releases, none delivered, nothing said so.** Each one was merged and green.
  The only detector was a person deciding to check, and the reason nobody did
  is that there was no moment that prompted it: a merge looks like shipping.
  The fix is not a better reminder, it is a reading — sessions report the
  bundle they are RUNNING on `attach_agent`, and the board names anyone older
  than what the deploy source would install.
- **Report the version the session is running, not the one its cache holds.**
  Those disagree from the moment an update runs until the session restarts,
  and the running one is the only one that decides whether a tool exists for
  that agent. A cache-based signal would go quiet at the update and hide the
  half of the problem that is still open.
- **A peer that reports NO version is behind, not unknown.** The field ships
  in the release that reads it, so silence means "older than this feature" —
  which is the state of the entire fleet the day it lands. Treating absence as
  unknown would have hidden precisely the drift it was built for. The mirror
  rule: a session AHEAD of the deploy source is *not* behind (an agent
  launched against a working tree legitimately outruns an unpulled checkout),
  and nagging it to downgrade is worse than silence.
- **A stale staging instance answers as though it were your build.** Port 8788
  was still held by an earlier `bun run staging`, so the new one moved to 8789
  and printed so — while a probe at 8788 returned a clean, complete, entirely
  wrong answer (no `pluginRelease` at all, which reads as "my feature is
  broken"). Read the port the run actually bound before pointing anything at
  it; same shape as a positive control scanning the wrong data.

## A version number is only free until somebody else merges

- **PR #178 was built, went green, and carried 0.1.43 — and #176 merged first
  and took 0.1.43.** Neither PR did anything wrong: #178's branch was cut when
  `origin/main` was at 0.1.42, so 0.1.43 was the correct next patch *at build
  time*, and `check:plugin-version` agreed. Two releases sharing a version
  string is precisely the failure that gate exists to prevent — `claude plugin
  update` compares the string, copies nothing when it hasn't moved, **and
  reports success anyway** — so the second one would have merged green and
  reached nobody. Caught before it landed; #178 was re-bumped and merged as
  0.1.44.
- **A passing CI check is evidence about the tree it ran on, not about the tree
  you are merging into.** Any gate that compares your branch against a moving
  target has this hole, and it opens *after* the run that closed it.
- **What makes this different from an ordinary race is that the collision is
  invisible to git precisely BECAUSE both sides agree.** A conflict requires
  disagreement; three identical version strings merge clean, because both
  branches independently wrote the same number. And CI stays green, because the
  gate compared against main as of the earlier build. So every signal a person
  normally trusts is not merely silent — it is actively reassuring: clean merge,
  green checks, a diff that looks exactly right. There is no marker to resolve
  and nothing to notice.
- **"Check more carefully" is what already failed, so the fix is structural: a
  central allocator.** With several branches in flight, each one independently
  picking "the next free number at push time" is last-writer-wins — careful
  checking narrows that window, it does not remove it. One party hands out
  reserved numbers instead, and an agent that finds its number taken **reports
  rather than bumps**, because bumping is how it collides with the next one.
  This session switched to that after the second collision.
- **Re-running CI would not have caught it either, which is the part worth
  reading the script for.** `scripts/check-plugin-version.ts` takes
  `mergeBase = git merge-base origin/main HEAD` and reads the base version from
  `git show ${mergeBase}:packages/plugin/.claude-plugin/plugin.json` — the fork
  point, not the current tip. The comparand is frozen at the moment the branch
  was cut and stays frozen however many times the job re-runs. Only a rebase, a
  merge of main into the branch, or a branch-protection rule requiring the
  branch be up to date before merging moves it. **Superseded by the entry
  directly below**, which moves the version comparand to the base branch's TIP.
  The changed-file set still uses the merge base, and must.
- **Two rules, and both are needed because they cover different actors.** The
  author re-reads the version off `origin/main` immediately before pushing; the
  **merger re-checks it at merge time**. The author cannot cover this alone —
  the collision is created by someone else's merge, which can land after the
  author's last push. That is exactly the sequence here.
- **The bump is conditional, not blanket, and CLAUDE.md currently reads as
  though it applies to every PR.** `GUARDED_PREFIX` is `packages/plugin/`, so
  the gate only demands a bump when the diff touches that tree — which a
  `packages/mcp/src/**` change does transitively, because `bun run build:mcp`
  rewrites the tracked `packages/plugin/mcp/index.js`. #179 merged with no bump
  at all and was correct: it touched neither. Bumping on every PR manufactures a
  **total merge order across unrelated branches** — land 0.1.44 and a green PR
  sitting at 0.1.42 can no longer merge without a rebase it never needed.
- **It recurred the same morning, to four branches on one number, and the
  count is readable straight out of the object database.** `git log --all
  --grep='0\.1\.46'` finds four independent claims on 0.1.46: `capture-guard`
  (`69bf263`), `fix/setdoc-task-body-guard` (`4c0e53d`),
  `judge/evidence-and-orphan-band` (`10125fb`) and `feat/goal-band-retriage`
  (`fcf5659`). Exactly one landed — #185, `9ce04dd`. Three of the four subject
  lines say in so many words that they are *already* re-taking a number lost to
  #180, so this was the second lap of the same race, not the first.
- **Read the number off the ref, never off the gate.** `git show
  origin/main:packages/plugin/.claude-plugin/plugin.json` answers "what is taken
  now"; `bun run check:plugin-version` answers "was my fork point lower", which
  is a different question and stays green however long the branch sits. Read all
  three sites that way, not two — `check-plugin-version.ts` compares only the
  two manifests, and the third (`PLUGIN_VERSION` in `packages/mcp/src/mcp.ts`)
  is pinned by `packages/mcp/test/launcher.test.ts` against the BUILT bundle, so
  it can only go red after a `bun run build:mcp`.
- **Allocate the number last, and let the sequence skip.**
  `feat/goal-band-retriage` took 0.1.46 in `fcf5659`, carries 0.1.48 today after
  merging main, and main has since reached 0.1.51 — three numbers, each correct
  when written, none of them shipped. Main's own history runs
  0.1.45 → .46 → .47 → .49 → .51: 0.1.48 and 0.1.50 are simply absent,
  allocated to branches that hadn't landed when the next one did (`954cb48`,
  "Take 0.1.50, the number allocated to this branch", is still sitting on
  `opaque-goal-ids`). Peers compare version strings and nothing requires
  contiguity, so a gap costs nothing while a pre-allocated number costs a
  re-bump for every merge that beats you. The order that works is: merge main,
  run the four gates, hold, take a number, merge immediately.
- Same family as "Drift you have to go and look for is drift nobody looks for",
  one layer earlier: there a merged release failed to reach the fleet, here two
  releases collide before they get the chance.

## A gate that compares against the merge-base is green precisely when the regression is largest

- **The sequel to the entry above, and it says that entry's fix was the wrong
  shape.** That one ended on two human habits — the author re-reads the version
  off `origin/main` before pushing, the merger re-checks it at merge time — plus
  a person handing out numbers. The gate could have answered the question
  structurally the whole time; it was asking the wrong ref.
- **Measured 2026-08-17, and every number reproduced with `git show
  <ref>:packages/plugin/.claude-plugin/plugin.json` before anything was
  changed.** PR #187, branch `origin/feat/goal-band-retriage`, carried
  **0.1.48**. Its merge-base with `main` is `bab50b2`, which held **0.1.47**.
  `origin/main` was at **0.1.51**. `scripts/check-plugin-version.ts` compared
  0.1.48 against the *fork point's* 0.1.47, passed, and would have passed
  however many times CI re-ran — while merging it steps the published version
  **backwards three releases**, which under `claude plugin update` reaches
  nobody.
- **The gate printed its own defect in its success line**, which is the single
  clearest artifact of the whole thing. On that branch, `--base origin/main`,
  exit 0: `✓ plugin version gate — 3 file(s) under packages/plugin/, version
  0.1.47 → 0.1.53`. The 0.1.47 is the frozen fork point being reported as
  though it were the thing being beaten, with `origin/main` at 0.1.51 the
  whole time. A success message that names its comparand is worth having;
  this one named the wrong comparand and nobody read it as strange.
- **Do not read this as "a branch's number goes stale while it sits" — that is
  the rare version.** The frequent one is that **every catch-up merge presents
  the version as a conflict**, and this repo's conventions require merging main
  before the final push. Both reflexive resolutions produce a number the old
  gate accepted and the fleet would ignore, and neither requires anyone to be
  careless:
  - **Keep ours** — the normal instinct when merging main into a feature
    branch. Observed in an abandoned merge in a worktree: main @ `f604f8b`
    (0.1.49) merged into the branch (0.1.48), resolved by keeping 0.1.48 across
    all three sites. The branch lands *behind* the commit it just merged.
  - **Take theirs** — the tidy-looking one. PR #187 went `mergeable_state:
    dirty` with the three version files in the conflict set, 0.1.53 against
    main's 0.1.51; taking main's side lands the branch at *exactly* main's
    version, so `claude plugin update` publishes nothing at all.
  The merge base is structurally incapable of seeing either, because it never
  moves in response to anything that happens to the branch afterwards. **So the
  regression is not created once when the branch is cut — it is re-creatable at
  any point in the branch's life by an ordinary, correct-looking edit.**
- **Phrase the check as "strictly GREATER than the base", never "different from
  the base".** Equality is what take-theirs produces, so "must differ" is the
  natural thing to write if that is the case in front of you — and it waves
  through keep-ours, which is the one a human actually did. Both are covered
  here by `compare(current, baseVersion) <= 0`, and relaxing that to `< 0` turns
  *"fails a version conflict resolved by TAKING THEIRS, landing on the base
  version"* red.
- **The comparand is frozen at the fork point while the base moves, so the
  longer a branch lives the more wrong the number and the more confident the
  check.** That inversion is the whole entry: the gate's certainty grows with
  the error it is failing to see. And the counter-intuitive corollary is that
  **no re-run helps** — people reach for "just re-run CI", and
  `git merge-base origin/main HEAD` returns the same commit every time. Only a
  rebase, a merge of the base into the branch, or branch protection's
  up-to-date requirement moves it.
- **One variable serving two questions is where this hid.** `mergeBase` fed
  both `git diff --name-only ${mergeBase}...HEAD` (which files did this branch
  change) and `git show ${mergeBase}:<manifest>` (what version must I beat).
  It is *correct* for the first and wrong for the second, and nothing at the
  call site distinguishes them. **General rule: when a computed value feeds two
  questions, check that it answers both — the one it answers correctly is
  exactly what makes the other look reviewed.**
- **The obvious one-line reading of the fix changes the wrong line, and that is
  the mistake to expect next.** "Compare against `origin/main`" applied to the
  *diff* — `base..HEAD` instead of `mergeBase...HEAD` — re-presents everything
  the base gained since the fork as this branch's additions, which is precisely
  the defect this repo already fixed in its pre-push scanner ("A merge commit
  re-presents public content as an addition", above). Only the version
  comparand moves to the tip. The regression test for that half asserts the two
  ranges genuinely disagree on the fixture before asserting the behaviour, and
  making the diff two-dot turns *"exempts a branch touching no plugin files,
  even when the base moved the plugin forward"* red.
- **It is a NARROWING, not a closure, and the file's own history says not to
  overclaim.** CI runs at push time, so the base can still move between the
  last green run and the merge. What shrank is the exposure — from "the entire
  life of the branch" to "between the last CI run and the merge". The
  structural closer is GitHub branch protection's *require branches to be up to
  date before merging*, which forces a re-run against the new tip; until that
  is on, the merger's check at merge time is still load-bearing. This is stated
  in the script's header comment, not only here.
- **The failure is invisible by construction, which is what ties this to the
  rest of the file.** Two branches agreeing on a number **merge clean, because
  a conflict requires disagreement**; CI is **green, because it compared against
  a frozen fork point**; and `claude plugin update` **reports success while
  copying nothing**, because the string did not move forward. Every signal a
  person normally trusts is not merely silent here — it is actively reassuring.
  There is no marker to resolve, nothing to notice, and no artifact anywhere
  that looks wrong.
- **Mutation-verified three ways, each naming a test.** Reverting the comparand
  to `mergeBase` turns four red, including both conflict-resolution cases and
  the success line's own comparand; relaxing `<= 0` to `< 0` turns the
  take-theirs case red; making the changed-file diff two-dot turns the
  exemption case red. The keep-ours fixture was checked against the OLD
  comparand rather than assumed — it exits 0 there, which is the measurement
  that makes it a regression test and not a decoration. Fixtures are real temp
  git repos — `GIT_*` stripped from the env
  before `git init` (it re-initializes the repo `GIT_DIR` NAMES, not its cwd),
  and `-c user.email` / `-c user.name` passed explicitly afterwards, since the
  strip also removes the committer identity and CI runners have no global one.
  A pure helper over pre-fetched version strings would have passed against both
  the broken and the fixed script: the defect is **which git command runs**.

## The merge queue is serialized by a generated artifact, and the version collisions are its symptom

- **Every plugin-touching branch acquires the same four-file conflict the moment
  another one merges.** Measured 2026-08-17 with `git merge-tree --write-tree
  origin/main <branch>` against three branches that had nothing to do with each
  other — `feat/goal-band-retriage` (PR #187), `capture-guard`,
  `judge/evidence-and-orphan-band` — which returned an identical set:
  `.claude-plugin/marketplace.json`,
  `packages/plugin/.claude-plugin/plugin.json`, `packages/mcp/src/mcp.ts` (whose
  conflicting hunk is the `PLUGIN_VERSION` literal, confirmed in the diff) and
  `packages/plugin/mcp/index.js`. So **only one plugin-touching PR can be in
  flight without rework**, however carefully the numbers are handed out. The
  entry above is what this looks like from the version side; this is the
  mechanism underneath it.
- **The fourth file is the one that is not yours to resolve.**
  `packages/plugin/mcp/index.js` is generated by `bun run build:mcp` and tracked
  because peers load *it* rather than the source (see "An MCP source fix doesn't
  reach peers until the tracked bundle is rebuilt"), so every branch touching
  `packages/mcp/src/**` rewrites all 16,081 lines and 618 KB of it. It is built
  with `minify: false` (`packages/mcp/scripts/build.ts`) and therefore reads like
  ordinary code, which is exactly what makes hand-resolving its hunks feel
  reasonable. A bundle merged hunk by hunk can come out syntactically valid and
  semantically wrong, and nothing reads it to find out. **Rule: never resolve
  that file's hunks — take either side wholesale, run `bun run build:mcp`, and
  commit the result.** CI rebuilds it and fails on any difference
  (`.github/workflows/ci.yml:42-50`), which is both what makes "take either
  side" safe and what makes hand-editing pointless.
- **The refusal is the good outcome, and it is the exact inverse of the failure
  above.** There the danger is that git *doesn't* refuse — two branches writing
  the identical version string merge clean, and the collision is silent. Here
  git refuses on all three version sites, because a central allocator makes the
  two sides write *different* numbers. That is the trade the allocator actually
  bought: the queue got slower, and it stopped being able to ship two releases
  under one version string.

## A supersession pointer makes adjacency load-bearing, and nothing checks it

- **Two independent branches appended an entry at the same point in this file,
  and the ORDER of the resolution was a correctness property.** Merging `main`
  into #195 on 2026-08-17, the parent entry ("A version number is only free
  until somebody else merges") had just gained **"Superseded by the entry
  directly below"** from #199, and #199's own entry opened "The sequel to the
  entry above" while naming that parent's content verbatim — *two human habits,
  plus a person handing out numbers*. Both orders merge clean, all four gates
  pass, and the file reads fine either way. The wrong one leaves the pointer
  aimed at an entry that supersedes nothing.
- **A cross-reference expressed as a POSITION is a link with no target check.**
  `grep -ni 'superseded by\|the entry above\|entry below' docs/process/learnings.md`
  found nine of them in the file this entry was added to. The `-i` is
  load-bearing: without it the pattern silently skips every pointer that starts
  a sentence, which is the majority of them. Nothing in the four gates reads
  prose, so each hit is a dangling reference waiting for an insertion. **Prefer
  naming the heading** — a reader can find it and a grep can verify it
  survived.
- **When a conflict hunk appends entries to a file like this, read both
  BODIES.** Comparing headings is what an ordering decision naturally reaches
  for, and it is exactly what cannot see a pointer. The tell that decides the
  order: an entry naming its predecessor's *content* is asserting adjacency,
  while one saying only "the entry above" is not — so the specific reference
  stays adjacent and the vague one moves.
- **Similar-sounding headings written the same night are usually different
  lessons, not duplicates.** The two entries here were about the version gate's
  comparand and about the generated bundle in the conflict set. Resolving by
  heading similarity would have dropped one, and a dropped entry leaves nothing
  behind to notice — where a kept duplicate is an editing chore.
- Placement of this entry was itself constrained by the rule: the version chain
  it sits after is three entries locked in sequence, and "An agent roster
  under-reports live agents, and the branch is the thing that knows" is locked
  to the entry opening "The entry above is the near-miss". Check for a pointer
  before choosing an insertion point, not after.

## What makes a fleet-wide action safe is that it can't interrupt anybody

- **The condition for letting every peer trigger a plugin refresh was that it
  must not interrupt work in progress — and the honest answer was that the
  mechanism already couldn't.** `claude plugin update` writes a version-keyed
  cache directory and moves a pointer; every running session keeps loading the
  path it resolved at launch. The thing that interrupts is the RESTART, and
  that stays the peer's. So "requests a refresh rather than forcing one" is a
  property of what the operation touches, not a queue or a consent protocol
  bolted on top. **Before designing the safety mechanism, check whether the
  operation is already safe** — the first design here was a request queue with
  per-peer safe points, for an action that cannot reach another session at all.
- **Then it also runs on a timer, and that is the actual fix.** A tool every
  peer *can* call is still a tool somebody has to decide to call, which is the
  same failure that let eleven releases go undelivered. Prod polls the update
  every 30 minutes, so a merge lands in the cache with nobody involved.
- **Never trust the updater's own account of what it did.** `claude plugin
  update` prints success when it copies nothing. `changed` is computed by
  reading `installed_plugins.json` before and after — mutation-tested by
  switching it to parse the CLI's "updated from X to Y" prose, which turns the
  test red. Same family as "a peer agent's 'it worked' means the call didn't
  error".
- **A capability that spawns a process needs a seam, and the seam is the
  test-safety story.** The refresher is constructed in exactly one place
  (`bin.ts`, behind a flag only `serve.ts --no-watch` passes), so no test run,
  no `bun run staging`, and no embedded server can mutate this machine's plugin
  cache. Without that, a CI run would be a fleet deploy. Same rule the
  summarizer follows, for the same reason.
- **The route-level auth check was unreachable, and my test for it passed with
  the check deleted.** `shareScopeAllows` is a closed-by-default allowlist that
  runs before any route, so a share host never reaches `/api/plugin/refresh`
  and `visitor` can never be truthy there. The end-to-end test was measuring
  the allowlist while claiming to measure the route. Fixed by asserting at the
  layer the gate lives in (with a positive control), and by labelling the route
  check as the defense-in-depth it actually is. **Mutation-test a guard you
  just added; "it returns 403" does not tell you which line said so.**

## git exports GIT_DIR into hooks, and `git init` inherits it

- **`git push` → `pre-push` hook → a script that runs `git init` somewhere
  else set `core.bare = true` on the primary checkout**, which then failed
  every subsequent command with "this operation must be run in a work tree".
  git exports `GIT_DIR` (and friends) into every hook it runs; a `git init`
  carrying that inherited env does not initialize its own `cwd` — it
  re-initializes the repo `GIT_DIR` names.
- **Only one env shape is destructive, and it is the one a worktree
  produces.** Probed all four empirically rather than guessing: plain-repo
  `GIT_DIR` → harmless, `GIT_DIR` + `GIT_WORK_TREE` → harmless, relative
  `.git` → harmless, **linked-worktree gitdir as `GIT_DIR` → writes
  `core.bare = true` into the shared config**, i.e. the primary checkout's.
  Fix: strip every `GIT_*` key from the environment before invoking `git
  init` in a fixture builder.
- **Stripping `GIT_*` also removes `GIT_AUTHOR_*` / `GIT_COMMITTER_*`**, so a
  fixture commit then needs `-c user.email=... -c user.name=...`. CI runners
  have no global identity and a bare `git commit` exits 128 — which is
  exactly how this shipped green locally and went red on the runner, for the
  third time in this file.
- **Two consecutive drafts of the regression test passed with the fix
  removed.** (1) The victim repo was a plain repo, which `git init`
  harmlessly reinitializes; (2) the hook gitdir was built as
  `.git/worktrees/<branch>`, but `git worktree add <dir> -b <branch>` names
  the gitdir after the **directory**, so the path never existed and the
  scenario never ran. The test only went red for the right reason after it
  built a real linked worktree and asked git for the path
  (`git rev-parse --absolute-git-dir` from inside it) — plus an assertion
  that the path resolves at all. **A fixture that constructs the wrong shape
  is the default outcome, not the unlucky one; assert the shape before
  asserting the behaviour.**
- How it was finally found is the reusable part: three sessions of
  hypothesising (worktree spawn? worktree removal?) got nowhere. A 1s poll
  recording every `core.bare` transition alongside a `ps` snapshot caught the
  flip to the second, with the culprit process in the snapshot. Instrument
  rather than theorise once a second hypothesis has died.

## "X is impossible" measured AN absence, not THE absence

- **A beta report said a task body is immutable — `PATCH` and `PUT` both
  404, measured not guessed — and it was wrong.** A task body is not a
  field, it's a live Yjs room (`task:<taskId>`), and `set_doc_content` on
  that docId already rewrote it. The report probed the two verbs a REST
  field would have and missed the door that was open. Reproducing the
  capability first (throwaway workspace → thin task → rewrite → read back
  through `get_doc` AND `next_tasks`) took two minutes and changed the
  shape of the work: not "make the body mutable" but "make the existing
  write findable, immediate, and attributed."
- **Rule: reproduce the impossibility before building the fix.** A fix
  that follows a wrong premise is usually the wrong SIZE — here it would
  have been a whole mutable-field path parallel to a room that already
  worked. Same family as "a peer agent's 'it worked' means the call didn't
  error": a confident measurement bounds what was tried, not what exists.
- The real gaps all shared a failure signature — each one presents to the
  caller as *"the rewrite didn't work"*: no named route (reachable only by
  knowing the docId convention), a debounced snapshot so rewrite-then-read
  returns the OLD body, no audit row, and a `delete_doc`'d body room
  answering `not-found` (which reads as "no such task" when the task is
  fine). When a capability exists but everyone reports it missing, look for
  the ring of things around it rather than at it.
- This is the READER's half. The entry below it is the author's — where false
  premises get written into task bodies in the first place. Neither is complete
  alone: a reader who reproduces everything is slow, and an author who dates
  and sources every premise still gets read by someone who should check.

## A task body's premise is a claim, and three of one day's were false

- **The entry above is the reader's half — reproduce the impossibility before
  building the fix. This is the author's half, and it is where the false
  premises come from.** Three task bodies written in one day each stated an
  inference from reading a code path as though it were a measured fact. Every
  one was caught only because the agent picking it up measured first.
- **`t-bawSUgxkPldj` said task threads are always subject-anchored, so grouping
  earns nothing. 34 of 37 carried a text-range anchor with a snippet** — the 3
  that didn't all came from the browser's own new-thread path. The fix the body
  described (flatten the threads) would have silently redefined
  `resolve_thread` on a task from "this point is handled" to "the whole
  discussion is closed", for every existing agent caller.
- **`t-4dlrUpp4x1aI` described a live bug that #161 had fixed 1h45m after the
  body was written.** Accurate when filed; nothing re-checked it before it
  reached the top of the queue.
- **`t-b-43pR4r6KW6` said a question asked in a thread reply can't reach the
  review strip. It had been reaching it since #143 — three days before the task
  was filed.** The agent found the real defect only because the item was there
  to look at: the wait clock was taken from the newest comment, so an agent
  posting follow-ups on its own thread restarted its own clock, in a band
  sorted oldest-first precisely so the tail doesn't starve. 20 of 42 threads
  understated their wait; the two worst by 62.7h and 60.1h.
- **The tell is uniform and mechanical: not one of those bodies named a probe,
  a port, or a number.** A body written from measurement says what was run and
  what came back; a body written from inference reads as confident prose about
  how the system behaves. That difference is visible without knowing anything
  about the subject, which is what makes it a usable check on your own writing.
- **A wrong premise usually gets the SIZE of the work wrong, not just a
  detail.** Twice here it pointed at a rewrite of something that already
  worked, and once it would have broken a contract that had callers.
- **A premise decays even when it was right**, so "verify before filing" is not
  sufficient on its own — `t-4dlrUpp4x1aI` was true at the moment of writing
  and false 105 minutes later. A body needs its measurement **dated**, and the
  reader needs to treat an old date as a reason to re-check rather than as
  provenance.
- **Rule for the author: state the premise as a claim with its date and its
  method, or don't state it.** "I read `create_thread` on 2026-08-17 and it
  looks like X" is honest and useful; "X is the case" is a measurement that was
  never taken.

## After a destructive operation, the missing thing's absence is the PREDICTED consequence — not evidence the warning was wrong

- **`ExitWorktree` renamed this session's transcript onto the parent repo's
  path and overwrote ~7 weeks of history — silently, with no backup.** That is
  the operational half, established jointly with the fleet lead after the
  epistemics below got us to the right question. A session that has entered a
  worktree writes its transcript under a worktree-encoded project dir
  (`…-plugin--claude-worktrees-<a>--claude-worktrees-<b>`); leaving moves that
  file to the parent-repo encoding, where a file of the same session-id name
  may already exist and be far larger. Measured here: 214,967,259 bytes born
  Jun 29 replaced by 1,013,315 bytes born Aug 17 12:44:32.
- **The signature is two directory mtimes in the same second, and anyone can
  re-derive it.** Both project dirs carry mtime `Aug 17 16:07:55` local; the
  `ExitWorktree` call is stamped `2026-08-17T23:07:55.039Z` — source dir
  stamped on entry removal, destination on entry creation, which is
  `rename(2)`. The surviving file's birthtime is the worktree file's, which an
  intra-filesystem rename preserves. A second `ExitWorktree` three minutes
  later left no dir-mtime trace at all, being a no-op after the first had
  moved the file — so **counting calls does not tell you which one acted.**
- **Transcripts are an analysis input, not a log**, which is what makes this a
  soft-delete violation rather than lost scrollback:
  `.claude/skills/retro/scripts/analyze_transcript.py` reads them directly and
  the weekly-review pipeline mines them. There are no APFS snapshots and no
  Time Machine destination on this machine, so nothing outside git has a
  recovery path. **Before `ExitWorktree` on a long-lived session, check whether
  a larger same-named transcript already sits at the parent encoding.**
- **The epistemics, which is the part that generalises.** A peer audited my
  warning by checking whether the endangered file still existed, found it gone,
  and concluded the warning had been false. Twelve hours later the measurement
  was "no such pair exists, nothing over 50MB anywhere" — a correct `find`,
  correctly read — filed as one of three wrong measurements.
- **Both hypotheses predict the identical observation, which is what makes this
  a trap rather than a mistake.** *"The pair never existed"* and *"the pair
  existed and the rename destroyed it"* are indistinguishable from the
  post-hoc listing alone. The audit ran **after** the operation it was auditing,
  so the state it read was the state the warning was about.
- **What separates them is birth time, and it was free.** At the time of the
  warning, `stat` reported `size=214967259 birth=Jun 29` at the canonical path
  and `size=1013315 birth=Aug 17 12:44:32` at the worktree path. Afterwards the
  canonical path holds a file whose birth is `Aug 17 12:44:32` — the *worktree*
  file's — whose earliest record is `19:44:32.743Z`, while the worktree file is
  gone and no file of the original size survives anywhere under `~/.claude`.
  `mv` within a filesystem is a rename, so it carries birthtime along; that one
  field is what identifies which file is now standing at the path.
- **Rule: when the question is whether a destructive operation was justified,
  the artifact's absence is the weakest possible evidence, because it is what
  BOTH answers predict. Reach for an identity field that survives the
  operation** — birthtime, inode, a first-record timestamp, a content hash —
  and compare it against what the earlier observation recorded. If the earlier
  observation didn't record one, that is the gap to fix next time, not a reason
  to trust the later reading.
- **Same family as "A positive control must be a peer in TIME as well as in
  kind", with the mechanism inverted.** There, a too-early read made an absence
  vacuous while other writers were appending. Here the read is too LATE, and
  the mutation between the two observations was caused by the very action under
  review — so the audit destroys its own evidence and then cites the result.
- **The corollary for the writer of the warning: quote the measurement into the
  warning itself.** The numbers above survived only because they were pasted
  from `stat` into the message at the time. Had the warning said "this would
  overwrite a much larger file", it would have been unfalsifiable afterwards
  and the audit's conclusion would have stood unchallenged.
- **The residual named in the first draft closed, and that is worth recording
  as a method note.** That draft said rename fitted every observation but that
  the old inode had not been captured, so another mechanism could not be
  excluded. What closed it was not more reasoning — it was a second observer
  parsing every transcript on the machine for `mv`/`cp`/`rm` against a `.jsonl`
  in that window (zero hits, so no agent did it) and the dir-mtime pair above.
  **State the residual; it is the thing someone else can go and close.**
- Two smaller findings from the same review, both about attributing a claim
  before grading it. One item on the wrong-measurement list was a correction I
  had *made* to a peer's relayed advice, which that peer had already
  acknowledged in writing — the correction got recorded as the error. And a
  count of tool calls ("two of them") was taken from the shape of a nested path
  rather than from the calls, which are in the transcript and can be counted.
  **Before grading a measurement, establish whose it was and what produced
  it** — a review that mis-attributes is worse than one that is merely wrong,
  because it teaches the wrong party the wrong lesson.

## A truncated page read is indistinguishable from a page that never rendered

- **An orchestrating session read the live workspace board in Chrome, reported
  the quick-add form and every task row and goal section absent from the DOM,
  and escalated it as a production regression** — blaming four just-merged PRs,
  retracting a completed task, and holding a deploy. There was no bug.
  `read_page` truncates at 50,000 characters by default; the board's
  accessibility tree was ~24,413 characters **and grows with the task count**.
  DOM order inside `.hub-board-col` is `hub-controls` → `hub-decisions` (the
  REST-fed review strip, which rendered fine) → **`hub-quick`** → **`hub-board`**,
  so the two "missing" regions are exactly the next two siblings after the last
  thing the read showed. A snapshot tool truncates at the BOTTOM, which is where
  the content you are asking about usually is.
- **Rule: before reporting that an element is absent from a page, run a query
  that can SEE it** — `document.querySelector` via `javascript_tool`, or a
  `read_page` with an explicit high `max_chars` or a `ref_id` scoped to the
  region. Absence inferred from a rendered snapshot bounds what the snapshot
  held, not what the page holds. Same family as "a negative test needs a
  positive control or it proves nothing" and "'X is impossible' measured AN
  absence, not THE absence" — with the twist that here the blinding was a
  default argument nobody passed, so nothing in the session looked wrong.
- **Treat the truncation footer as load-bearing, not boilerplate.** It is the
  only thing separating "the page lacks this" from "I stopped reading", and it
  is what closed the diagnosis: re-running with `max_chars: 3300` reproduced
  the bogus report item for item, in order, then cut at the same seam. The
  positive control ran both ways too — emptying `#hub-quick` and `#hub-board`
  made the probe say exactly what the bad report said, and restoring them
  flipped it back. One detail made the false report convincing: the sole
  survivor was the `position: fixed` "Hold to talk" mic button, which outlives
  any truncation or scroll position and reads like the last fragment of a
  broken page.
- **The report was also structurally impossible under the deployed code, and
  checking that is cheaper than raising an alarm.** `renderReviewStrip` has one
  call site, in `renderBoardRegion`, *after* `renderBoard`; `renderBoard` opens
  with `container.replaceChildren()`, so a null container throws rather than
  no-ops; and `boardSections` unconditionally emits one section per goal plus a
  Chores section, so it can never return `[]`. "Review strip with 7 rows"
  therefore entails "at least one section in the DOM". When a browser
  observation and the code cannot both be true, suspect the observation first.

## A modal the page AWAITS makes every absence on that page vacuous

- **Verifying that the feedback widget correctly does NOT render for a share
  visitor, the first probe found no widget — and no board, no sections, no
  rows either.** That second half is what saved it: hub `main()` *awaits*
  `ensureUserIdentity`, and a first-time visitor is held at the "Who's
  reviewing?" prompt, so until someone answers it `#hub-root` has zero
  children. The widget was genuinely absent, on a page where *everything* was
  absent, which proves nothing about the suppression under test. Dismissing
  the prompt and re-running gave a fully rendered board with the widget still
  gone — that is the result worth reporting.
- **The positive control has to be a peer of the thing you're asserting away,
  on the same page, in the same pass.** "The server responded 200" and "the
  bundle loaded" were both true here and neither distinguishes the two
  worlds. What distinguished them was counting board rows next to the missing
  widget. Same family as "a negative test needs a positive control" and "a
  truncated page read is indistinguishable from a page that never rendered",
  with the blinding one layer earlier: not a truncated read of a rendered
  page, but a complete read of a page that had not rendered yet.
- **An await in front of a render is invisible from the server side**, where
  every check comes back correct — so grep the client entry point for what it
  awaits before mounting, and satisfy each of those before measuring anything
  about the DOM. A blocking prompt, a permission request, an auth redirect,
  and a lazy import all produce the same empty-container reading.
- Two mechanics that cost a pass each while getting there: Chrome will not
  store a `Secure` share cookie on a non-trustworthy origin, so a
  `*.nip.io`-style host silently drops the visitor session (`*.localhost` is
  trustworthy AND resolves to loopback, and an exact-match trusted-local
  check still classifies it as a share host); and screenshot coordinates are
  not CSS pixels — measure the scale with a `pointerdown` logger and recompute
  from `getBoundingClientRect()` rather than clicking where the picture says.

## A new emitted event reaches the surface as a bare slug

- **`task.body_edited` rode the existing SSE + `events.jsonl` path to the
  activity feed the moment it was emitted — and rendered as the literal
  string `task.body_edited`, with no actor and no task title**, because
  `describeEvent`'s switch had no case for it. The fallback is deliberate
  ("a table miss should be visible, not blank"), which is exactly why it
  doesn't count as handling: nothing goes red, the row just reads like a
  log line in a view built for people. **Emitting a new store event is two
  changes, and the second one is in the client.**
- **Two tests, because either alone is the "true but proves nothing about
  the caller" shape**: one that the switch has a case (hand-written row),
  and one in `activity-lines.test.ts` that drives the real route, reads the
  real `events.jsonl` back, and renders THAT row — which is what proves the
  emitted keys match the ones the case reads. Verified by mutation in both
  directions: delete the case, and blank `taskId` in the emit.

## A guard on a field with two writers is dead before it runs

- **"Preserve the row's original words, but only if this row has never been
  rewritten" preserved nothing, ever.** The clause was
  `bodyWrittenAt === undefined`, which reads as exactly the question being
  asked. But `bodyWrittenAt` has TWO writers: the attributed rewrite
  (`noteBodyEdited`) and `updateBodySnapshot`, which stamps it on every real
  body change — and the route flushes the NEW body's snapshot *before* calling
  the store. So on the very first rewrite the clause was already false, set
  moments earlier by the same request. Nothing warns; the guard reads as
  correct, the field means what its comment says, and the feature is simply
  absent.
- **Rule: before gating on a field, grep every writer of it and ask whether
  one of them runs earlier in the same call path.** A field with one writer is
  a fact; a field with two is a fact plus a race with yourself. Same family as
  "the route layer silently drops params" — the thing that broke it lived one
  layer away from where it was read.
- The fix was to delete the clause, not repair it: the honest question was
  "does anything hold this row's own words yet", which is `quote === undefined`
  and has exactly one writer. **A predicate that needs two fields to express
  one fact is usually a sign the second field is a proxy.**
- Caught because the test asserted the preserved value rather than that the
  call returned true. An assertion on the call's success would have passed
  from the first commit — the same "true and still proves nothing about the
  caller" shape as `isWhitespaceOnlyChange`.

## A required parameter binds the callers who call you, and nobody else

- **The sequel to the entry above: the repaired guard was correct and still
  preserved nothing for a whole class of rewrites.** Making the pre-rewrite
  title and body a REQUIRED parameter of `noteBodyEdited` was meant to stop a
  new call site from skipping the preservation — and it does, for call sites.
  But a task body is not a field, it is a live Yjs room at `task:<taskId>`,
  and `set_doc_content` on that docId never calls the store at all. It wrote
  the room, returned `ok: true`, and left `quote` empty with no
  `task.body_edited` row. Reproduced before designing: the capture was gone,
  the board looked fine, and `get_doc` returned the new text.
- **The positive control has to run on the same row in the same pass, and it
  is what caught the probe lying.** The first run reported "no
  `task.body_edited` emitted" for BOTH the doc route and the named route —
  the reader was matching `row.type` where the audit log stores `row.event`.
  A vacuous zero on the path under test is invisible; a vacuous zero on the
  control is not, which is the whole reason to spend the extra call.
- **Where a guarantee belongs is decided by where the thing is LOST, not by
  where a caller announces it.** The preservation moved to
  `TaskStore.updateBodySnapshot` — the choke point every writer of a body
  fragment passes through, because they all mutate one Yjs fragment and that
  is what its observer flushes. That covers doors no route guard could:
  `find_and_replace` aimed at the same docId, and a person typing on the
  board. The regression test for it drives `find_and_replace` deliberately,
  since a whole-doc-rewrite test would pass against a route-level fix.
- **The two halves do not live in the same place, and pretending they could
  would be the bug again.** Preservation belongs at the choke point;
  ATTRIBUTION cannot, because a Yjs observer has no actor and fires on every
  typing pause. So `task.body_edited` stays with the routes that carry an
  author, and `POST /api/docs/:id/content` now runs the same ceremony
  `/api/tasks/:id/body` does. When a caller sends no author the words are
  still preserved and no row is emitted — an audit row naming nobody is worse
  than its honest absence.
- **Refusing was the tempting answer and was worse.** `set_doc_content` could
  have 400'd on a `task:` room naming `update_task_body` instead — but that
  tool arrived in 0.1.24, so refusing takes the only body rewrite an older
  bundle has, to buy a guarantee the branch can simply provide. Serve when you
  can serve; refuse only when the route genuinely cannot do the thing.
- Mutation-verified in both directions, each naming a specific test: deleting
  the choke-point preservation turns 7 red (including the three pre-existing
  `/body`-route cases, which is the proof the choke point serves that route
  too); bypassing the doc route's `task:` branch turns 3 red; and *always*
  emitting the row — the inverse mutation — turns "still preserves when the
  caller says nothing about who it is" red, which is what makes that absence
  assertion non-vacuous.

## A four-digit needle in a haystack of timestamps is a time bomb, not a test

- **CI went red on `expect(JSON.stringify(e)).not.toContain('9099')` — and the
  endpoint it was guarding against was correctly absent.** The record carries
  three `Date.now()` millisecond stamps, and one of them came back
  `1786980999099`. The clock spelled the needle. Green locally, green on the
  previous run, red on a branch that never touched that file — which is the
  worst version of this, because the first instinct is to go read your own
  diff.
- **A substring assertion searches everything in the string, including the
  parts nothing controls.** `9099` is four digits against ~30 uncontrolled
  digit positions; at roughly one run in a thousand it fires, forever, on
  whoever is unlucky. Its sibling case in the same file never tripped only
  because its timestamps are hand-written constants — so the file contained
  both the safe and the unsafe spelling of the same idea, and the difference
  was invisible.
- **Assert the structure first, then match on something no generator can
  produce.** `'endpoint' in attachment` is the assertion actually being made;
  the string check is a backstop, and it should look for the WHOLE endpoint
  (`http://127.0.0.1:9099/hooks/agent-relay`), which no clock and no id can
  spell. Mutation-verified: removing the strip in `publicAttachment` turns
  three named tests red, so the repair did not just make it stop failing.
- **Rule: a `not.toContain` needle must be impossible for any value in the
  payload to generate by accident.** Prefer a key check, a parsed field, or a
  long distinctive literal. Digits, short words, and ids are all things some
  other field will eventually produce on its own.

## A malformed anchor crashes a request that never touched the doc

- **`POST /api/docs/:id/threads` takes `anchor` verbatim and validates
  nothing.** A hand-written `text-range` with no `startRel`/`endRel` is
  accepted, stored, and then kills the re-anchor sweep with
  `Y.decodeRelativePosition(undefined)` — thrown inside a Yjs observer, so
  it surfaces as an unhandled async `TypeError` on whatever request or test
  happens to be running by then. Cost a full diagnosis pass: the server
  suite went red in `ws-meta-leak.test.ts` (`decoder.arr.length`
  undefined), a file the branch never touched.
- **Use `/threads/by_find` in fixtures.** It builds the RelativePositions
  from the doc, which is the only way to get an anchor that is actually an
  anchor.
- The method that found it, again: baseline unmodified `main` (green),
  baseline the worktree (1 failure), then remove only the new TEST file —
  green. That sequence proves the source innocent before you start reading
  it, and points at the fixture.
- **Fixed in two halves, and shipping either alone would have been wrong.**
  `anchors.validateAnchor` refuses the write at the route with a 400 that
  names the field — which only helps NEW writes. Docs written before it
  existed still carry bad anchors, so every reader also goes through
  `decodeRelativePositionSafe`, which answers null where Yjs would throw.
  Null is indistinguishable at the call site from "this position no longer
  resolves", the case every reader already handles — so a legacy bad anchor
  doesn't merely stop crashing, the snippet sweep re-anchors it and the doc
  repairs itself. **A validation-only fix leaves the already-broken docs
  broken, and those are the ones somebody is looking at.**
- Two more things the fix had to reach that the report didn't name. The
  `/threads/<id>/reanchor` route takes an anchor verbatim too — it can plant
  the same thing on an EXISTING thread. And `anchor.snippet.text` is the same
  deferred crash one property deeper: `snippet` is required by the type and by
  nothing that enforces it, and the sweep is where a missing one is first
  read. When a route accepts a structure verbatim, grep for every route that
  accepts that same structure, and for every property the readers dereference
  without a guard.
- **The test that proves it asserts on a request to a different doc.** The
  edit that arms the sweep returns 200 either way; the failure lands ~250ms
  later on a bystander doc with no threads. A `process.on('uncaughtException')`
  collector is what makes it attributable — without one the run just dies
  somewhere else, which is the entire diagnosis cost. Mutation-tested five
  ways: removing either route guard, un-guarding the decode, and un-guarding
  the snippet read each turn a specific named test red, with the original
  `decoder.arr.length` error and the `# Unhandled error between tests` banner
  reproduced verbatim.

## A fallback that only logs is a fallback nobody knows they are on

- **`prepareClientRelease` keeping the previous client alive when the build
  fails is correct — and it left NOTHING on disk.** Reproduced before
  building anything: publish once, fail twice, and the release root still
  holds exactly `releases/` and `current`. The decision lived in a stderr
  line in a launchd log and in a return value whose `stale` field no reader
  anywhere consumed. So the failure path silently reintroduced the very
  server-new/client-old split the release mechanism exists to prevent.
  **General rule: a graceful degradation needs a durable trace, because the
  process that degraded exits and the question gets asked days later.**
- **The trace has to answer "how far behind", not "is something wrong".**
  A boolean cannot distinguish minutes from a week, and the gap is the
  entire reason to care. Provenance inside each release (published-at plus
  the source commit) plus a failure ledger beside them is enough for a
  surface to say the whole sentence.
- **Record the SOURCE as well as the clock.** A stale checkout builds
  successfully and stamps a current timestamp on old code, so a fresh-looking
  release id proves nothing about the code in it. `git describe --always
  --dirty` at publish costs one spawn per deploy and makes the release
  self-describing.
- **An alarm needs an arming rule with a stated silence.** Two failed starts
  in a row, or one over a client already older than a day; a single failure
  over a client published minutes ago says nothing. Without the silence the
  first transient bundler hiccup trains everyone to ignore the strip — and
  with a count-only rule a single failure that nobody ever retries stays
  silent forever while the gap grows. Both halves were mutation-tested
  (delete either clause and a named test goes red).
- **Only the process that PUBLISHED may report on the publish.** Dev and
  staging serve their own checkout's `dist` while sharing this machine's
  default release root, so a root-derived signal there would report prod's
  deploy state on a board that is not serving prod's client. Same seam as the
  plugin refresher: one flag, passed in one place (`serve.ts --no-watch`).
- **The hub's top-level script is the layer no unit test reaches.**
  `hub-app.ts` has no exports and mounts on load, so the model and render
  tests cannot prove it is wired. What proved it: build the bundles in a
  linked worktree, start `bin.ts` on its own port and data dir against a
  fixture release root with a failing ledger, and read `.hub-drift` out of a
  real browser. Same method as the `pointercancel` fix, and it is the only
  thing that would have caught a dropped state assignment.

## A tracked file that is also a bound doc turns editing into a deploy signal

- **Every prod release published during one ordinary editing session was
  stamped `0ef5d92-dirty`.** Nothing was wrong with the build. Prod's deploy
  source is the primary checkout; a plan under `docs/` was bound to a live doc
  there, so each MCP edit's ~1s flush left a modified tracked file, and
  `git describe --always --dirty` at publish read the whole worktree. The
  negative half was observed too — three minutes later, same server and same
  build path, the checkout went clean and the next release stamped `a822618`.
  The file had only just become *tracked*, which is what turned a harmless
  condition into a permanent one.
- **The fix is not a quieter marker, it is a marker with a criterion.** A
  modified path sets `-dirty` when this deploy **builds or serves** it. That
  makes the list an IGNORE list (`docs/**`, top-level `*.md`) rather than an
  allowlist of build inputs, and the direction is the load-bearing part:
  enumerating "what can affect the build" and missing one reports an
  uncommitted build as clean — the exact failure the marker exists to prevent —
  while missing one in an ignore list only produces noise. **When a guard has
  to be narrowed, pick the phrasing whose mistakes fall on the noisy side, and
  write that sentence next to the list** so the next person widening it knows
  which way it is supposed to fail.
- **"It is a bound doc" is not the criterion, and assuming it was would have
  been wrong.** `demos/` also holds bound docs — and `bin.ts` serves
  `join(repoRoot, 'demos')` per request, so an uncommitted demo really does
  change what a browser gets. Check what each candidate path is *consumed by*
  before exempting a directory because of who edits it.
- **A bare boolean suffix cannot be judged later, so record what was dirty.**
  `release.json` now carries `dirtyPaths` / `dirtyPathCount` — every modified
  path, including the ones that did NOT set the suffix, so a clean `sourceRef`
  beside a modified doc reads as a decision rather than an oversight.
- **An unknowable tree is dirty, not clean.** If `git status` fails while
  `git describe` succeeded, the marker goes on with no path list; the
  alternative is claiming committed provenance nobody checked.
- Mutation-verified five ways (never-mark, always-mark, unknown-tree-clean,
  `demos/` wrongly exempted, rename-origin dropped), each turning specific
  named tests red — and the "does not mark" cases are asserted beside their
  "does mark" twins in the same fixture repo, because an absence assertion
  alone would pass against a function that marks nothing.

## Removing an MCP tool cannot break a peer — the shared server is where a removal bites

- **`create_task` was left reachable for five releases behind a stated
  precondition — "no session older than 0.1.36" — and the precondition was
  unnecessary.** The reasoning it encoded ("a release that deletes the tool
  breaks every session still running an older bundle and still calling it")
  does not survive reading the code. Each session launches its OWN MCP child
  from its OWN version-keyed cache (`.mcp.json` → `${CLAUDE_PLUGIN_ROOT}/mcp/index.js`),
  and BOTH halves of a tool live in that one file: the declaration is a static
  array literal in the `ListToolsRequestSchema` handler (no `await`, no
  `http()`, no `fetch` anywhere in its ~1,300 lines), and the dispatch is a
  `switch` in the same bundle. A session that has not restarted never sees the
  deletion; the restart that delivers it is the same restart that delivers the
  replacement. The shared server on :8787 has **no knowledge of the tool
  surface at all** — grep it for `tools/list`, `ListTools`, `toolNames`,
  `allowedTools`: zero hits. It never negotiates or serves a tool list, and
  `pluginVersion` reaches it only as a value to *display* on the drift strip,
  never as a gate.
- **The hazard the precondition was reaching for is real, but it is one layer
  down: the REST route, not the verb.** An old bundle keeps calling
  `POST /api/workspaces/:id/tasks` with whatever payload *that* bundle sends,
  and gets a failure it cannot explain from its own version. So the question
  worth asking at a removal is never "did I delete a tool somebody still
  calls" — it is **"did I narrow anything the old callers still send or still
  read"**. Diffing tool lists cannot see that.
- **Test the OLD payload, not the current one.** A route test written against
  what today's code sends passes by construction and detects nothing. The
  guard here transcribes the request keys and the dereferenced response fields
  out of the committed bundle at the oldest release plausibly still in the
  field (0.1.20 — verified byte-identical at 0.1.25/0.1.30/0.1.34/0.1.36) and
  sends exactly those. Mutation-verified: making the route drop `quote` turns
  it red.
- **Same shape as "What makes a fleet-wide action safe is that it can't
  interrupt anybody", one entry up.** There a whole consent mechanism was
  designed for an operation that already could not reach another session.
  Here a delivery gate held a removal for five releases against a breakage
  that was structurally impossible. Both times the fix was to read what the
  operation actually touches before designing around what it might.
  **Cost of checking: about twenty minutes of reading. Cost of not checking:
  a blocked task, a blocked dependent, and a session restart requested to
  satisfy a gate that was measuring nothing.**
- **An absence assertion on a name that is a PREFIX of the surviving name is
  the trap here.** `create_task` is a substring of `create_tasks`, so
  `BUNDLE.includes('create_task')` is true forever and an absence test written
  that way can never fail. Use `/create_task\b/` (no boundary between `k` and
  `s`), and assert the naive form still matches, so the guard fails loudly if
  the surviving verb is ever renamed.
- **Assert the absence in the SOURCE as well as the bundle, and expect them to
  disagree.** The first run had the bundle test green and the source test red
  — because the only remaining mention was in a code COMMENT, which the
  bundler strips. That is the mirror of the deploy-verification rule ("a
  literal from a comment proves nothing about the bundle"): comments are
  invisible to the artifact, so the bundle can look clean while the source
  still documents the thing as present.

## An empty list is a clearance only if you also render the denominator

- **The plugin-drift strip rendered NOTHING when nobody was behind, and
  nothing reads exactly like all-clear.** Its domain is "sessions that called
  `attach_agent` on this board", which for most of this board's life has been
  one member — itself. Measured 2026-08-17: `behind: []` over one attachment,
  while a fleet enumerated *outside* this server (the positive control: a
  second source, not a second look at the same data) had sessions releases
  back. **The only session the strip had ever named as behind was the session
  that then fixed itself** — which moved the reading from "names one" straight
  to "names nobody" with zero change in the actual drift. Worse than the
  filed prediction, which was about a board with *zero* attachments; one does
  it too, and one is the normal state.
- **A surface whose domain is "whoever opted in" measures PARTICIPATION, not
  the thing it is named after** — and the members least likely to have opted
  in are exactly the ones the surface exists to catch, because opting in is
  itself something the newer version does more of. Whenever a check runs over
  a self-selected population, ship the denominator beside the result and let
  the reader see how small it is.
- **Reproduce the constraint before working around it.** The honest answer
  here was "the fleet is unknowable from this server": a plugin version
  arrives through exactly one door (`attach_agent`'s `pluginVersion`), the MCP
  child makes no HTTP call at startup and never opens a websocket, and Yjs
  awareness carries browsers rather than agents. So the fix is to state the
  domain, NOT to invent a registry that makes a broader sentence true. Note
  the near-miss: the server *does* record agents that never attached
  (`activity.jsonl`, per-workspace `events.jsonl`) — but those carry no
  version, so they can name an unchecked session and can never call one
  behind. "Unknowable" had to be established per-fact, not per-surface.
- **The always-on line needs its own visual weight.** A coverage notice
  renders permanently, so it gets a quiet class; styling it like the alarm
  would train everyone to skim past the alarm. Same reasoning as an alarm
  needing a stated silence.
- Mutation-tested three ways, each turning a *named* test red: restoring the
  `return null` on an empty `behind`, dropping `checked` from the route
  payload, and dropping the quiet class in the renderer.

## A second spelling for the same value makes accidental duplicates reachable

- **Batch-internal `after` gave one dependency two spellings — `"#warm"` and
  the index of the row that declared it — and `createTask` never deduped**, so
  `after: ["#warm", 0]` stored the same id twice and `openBlockers` reported
  the same task as a blocker twice. `setTaskDependencies` had deduped since it
  was written; creation had not, and nothing noticed because until there was a
  second spelling, writing a duplicate meant literally typing the same id
  twice, which nobody does. **A feature that adds an alias for an existing
  value silently promotes "nobody would write that" into "a caller can write
  that without realising".** When you add one, grep for every place that
  assumed the old spelling was the only one.
- **Fix it where the value is STORED, not where the alias is resolved.** The
  batch resolver was the tempting place — it is where the aliases exist — but
  the same duplicate is writable straight down the single-create route, and a
  batch-only fix leaves two paths storing identical input differently. Same
  family as "two spellings of 'not found' is a bug generator".
- **Only a running server showed it.** The route answers 200 either way and
  the duplicate lives in the stored edge list, so every status-code assertion
  passes. It was found by an adversarial probe against a staging instance that
  read the state back, and the test that pins it asserts on the **blocker list
  a person is shown**, not just on the array.

## Four gates, and each one is the only thing that catches its class

- **`bunx vitest run`, `bun test packages/server/test` (~100s),
  `bun run typecheck`, `bun run lint` — "run the tests" means all four, and the
  two test runners are disjoint by CONFIGURATION, not by habit.**
  `vitest.config.ts` includes `packages/*/test/**/*.test.ts` +
  `packages/*/src/**/*.test.ts` and carries an explicit
  `exclude: ['packages/server/test/**']`, so the server suite is literally the
  tree vitest is told to skip. Vitest does not typecheck, so a type error is
  green across both runners. And `bun run lint` is `biome check .`, which
  *reports* lint and formatting violations and writes nothing —
  `bun run format` / `bunx biome check --write` is the half that applies them.
- **The failure mode is not forgetting to verify, it is reciting the list from
  memory**, which on one day briefed a fan-out of parallel agents with an
  incomplete set. CLAUDE.md now carries the canonical block ("The four gates —
  run all of them before you push", landed in #170). Read it, don't recall it.
- The pre-existing `noExplicitAny` output is **warnings**, and `biome check`
  exits 0 over warnings — don't chase them, and don't read a trailing
  "Found 2 warnings" as a failure.
- **A worktree with no `node_modules` fails typecheck with a wall of TS2307 /
  TS7006 that reads exactly like a real regression.** `bun install
  --frozen-lockfile` first. And check the EXIT CODE, not the tail of the
  output: piping `tsc` through `tail` hands you `tail`'s status, which is 0 no
  matter what typecheck said — a green-looking run over a screenful of errors.

## A mutation-test artifact survived the report that said it hadn't, and lint was the only gate that saw it

- **An agent mutation-testing a route guard disabled it with
  `if (false && body?.docId !== undefined)`, restored the other three
  mutations, and reported "src restored and re-verified, suite clean at
  63 pass / 0 fail."** The sentence was false for this one. The artifact was
  still in `server.ts`, and the passing run it quoted had happened *before* the
  mutation was introduced. The number was real; it just wasn't measuring the
  tree the report named.
- **`false &&` is invisible in a diff.** The eye reads
  `if (… body?.docId !== undefined)` and moves on. A disabled guard is not a
  deletion, it doesn't change the logic underneath it, and it leaves the guard
  visibly present in the file — so every normal check for a *missing* guard
  reports that it is there.
- **`bun run lint` caught it and typecheck did not, which is worth being exact
  about because it reframes the entry above.** Reproduced here by planting the
  same construct in `packages/server/src/`: `bun run typecheck` exits 0 (the
  types are fine), and `bun run lint` exits 1 with
  `lint/correctness/noConstantCondition — Unexpected constant condition`. Note
  the group: biome files that under **correctness**, not style. The four gates
  get described as though the suites are the correctness ones and lint is
  cosmetic; here lint was the only gate that had run against the bad tree at all.
- **The suite was never the weak link — the report was.** Re-running the
  mutation deliberately turns 7 tests across 4 files red. What failed was a
  claimed verification that had not been performed, and no amount of coverage
  detects that. **Rule: re-run the suite after the LAST mutation you RESTORE,
  not after the last one you remember introducing** — and treat "restored and
  re-verified" as a claim needing its own evidence, because it is the one line
  in a report nobody can check from outside. Same family as "a peer agent's 'it
  worked' means the call didn't error".

## A conflicted PR has ZERO check-runs, which reads exactly like CI not having started yet

- **PR #187 sat at `mergeable: CONFLICTING` / `mergeStateStatus: DIRTY` with no
  checks at all — not pending, not failed, absent.** Measured 2026-08-17:
  `gh api repos/<owner>/<repo>/commits/ef2916a7/check-runs --jq .total_count`
  answers `0`, while
  `gh api ".../actions/runs?branch=feat/goal-band-retriage"` answers 2 runs,
  both `pull_request`, both `success` — on `33733b0` and `8ac0f05`, the branch's
  two EARLIER heads. So the branch shows green history while the head under
  review has never been built at all. `.github/workflows/ci.yml` runs
  `on: pull_request`, which needs a merge ref, and there is no merge ref to
  build for a conflicted PR.
- **The positive control is a peer PR in the same repo on the same day.** #193's
  head `c103abf` answers `1` to the identical call — `verify`, `success`.
  Without that half, `0` is just as consistent with a malformed query as with a
  real absence. Same discipline as "A negative test needs a positive control or
  it proves nothing".
- **`gh pr checks 187` prints `no checks reported on the
  'feat/goal-band-retriage' branch` and exits 1.** The exit code is honest; the
  sentence is not. It names an absence, volunteers no cause, and is word for
  word what a PR opened thirty seconds ago says — so "CI hasn't started" is the
  natural reading, and it is a wait that never ends.
- **The probe that separates them is the check-run count against the HEAD SHA,
  read together with `mergeable` / `mergeStateStatus`** — never the PR page,
  whose check list is empty in both worlds. `DIRTY` + 0 means merge main or
  rebase, not wait. `BLOCKED` means branch protection: on this repo that is the
  one required approving review (`required_status_checks` is null), and a
  `BLOCKED` PR's head sha still carries its check-run.
- Same family as "A truncated page read is indistinguishable from a page that
  never rendered" and "'X is impossible' measured AN absence, not THE absence":
  the reading is accurate, and the conclusion drawn from it is wrong, because
  nothing on the surface separates "not there" from "never got made".

## CI red at "Set up job" is infrastructure, and the status code says whose

- **PR #174's first run failed before a single test executed**, at the
  `Set up job` step — the only step the job ever reached (attempt 1 of run
  `32040172641`). The log: `Failed to download action
  'https://codeload.github.com/oven-sh/setup-bun/tar.gz/<sha>'. Error: Response
  status code does not indicate success: 503 (Service Unavailable) … Back off
  18.245 seconds before retry.` Attempt 2 went green with no code change. In
  the run list it reads identically to a test failure.
- **Two details the first account of this got wrong, and both change the
  diagnosis.** It was **503, not 429** — a GitHub-side outage, not rate
  limiting. And it died fetching the setup-bun **action repository itself**,
  before setup-bun ran and before any toolchain download. GitHub's GraphQL API
  was returning 503 in the same window (reproduced while writing this entry:
  `gh pr view 178` answered `HTTP 503: No server is currently available`), which
  is what an incident looks like — and not what a session's own API fan-out
  looks like, since the runner's action download is unauthenticated and carries
  none of this account's tokens. **Blaming your own footprint is the
  comfortable diagnosis; read the status code before accepting it.**
- **Rule: read WHICH step failed before diagnosing anything.** A failure above
  the first test step is not your code — `gh run rerun <id> --failed`, then
  read.
- **When `gh` starts returning 503 on GraphQL, fall back to REST:**
  `gh api repos/<owner>/<repo>/...`. Every `gh pr view` / `--json` call failed
  in that window while `/pulls/178`, `/actions/runs?branch=…` and
  `/pulls/179/files` answered normally throughout. `gh run view --job <id>
  --log` is REST too, which is the only reason the log above was readable at
  all.

## gh pr merge --delete-branch switches your working copy to main

- When the branch being deleted is the CURRENT branch of the main
  checkout, `gh pr merge N --squash --delete-branch` checks out main
  locally (and tries to pull, which fails on a diverged local main with
  "Not possible to fast-forward" — harmless). The REMOTE merge succeeded;
  but your working tree just silently changed branches, so files appear to
  "revert" to pre-branch content. Bit us twice in one session. Run the
  merge from a checkout that is NOT on the branch, or expect the switch.

## A false premise can still sit on top of a real bug — and the shipped feature is what lets you see it

- **A task said questions asked in a thread reply never reach the review
  strip. They had, for three days, since PR #143.** That is the sixth
  already-shipped claim in a week, so the reproduce-first rule paid again. What
  was NEW is what happened next: the item WAS on the strip, and reading its
  actual `ask` field showed it quoting a PR announcement while the open
  question sat four comments back. **The disproof is not the end of the
  investigation, it is the start of a better one** — a working feature you can
  point at is a far better instrument than the absence the task described.
  Retiring the task as "already done" would have left two live defects.
- **Measure a heuristic over the real corpus before defending it in prose.**
  The question was "which agent comments are actually asking a person
  something", and every plausible rule was testable against all 86 agent
  comments on the board. `?` alone fires on 19 — URL query strings
  (`…/board?tab=open`), `anchor.snippet?.`, `` `in listUntriaged?` ``, section
  headings, quoted UI copy. Address alone fires on 2. Both together fire on 1,
  which is the question. Recall is the honest cost and it is 1 of 3. None of
  that was guessable; all of it took one script against data already on disk.
- **A priority signal computed from the wrong end starves exactly what it was
  built to protect.** The band sorts oldest-first so nothing rots at the
  bottom, but `since` came from the NEWEST comment — so an agent posting
  follow-ups on its own thread reset its own clock. 20 of 42 open threads were
  understating their wait, the two worst by 62.7h and 60.1h: waiting two and a
  half days, sorting as though fresh. Sort keys deserve the same "is this the
  fact or a proxy for it" audit as predicates.
- **Make the risky half of a change provably inert.** The safety property here
  is that `unansweredRun` is non-empty EXACTLY where the old predicate was, so
  the SET of threads on the strip cannot move — the change only re-ranks and
  re-labels. That is what makes an imperfect detector affordable: its false
  negatives cost a promotion, never a disappearance. Prefer a shape where the
  failure mode is bounded by construction over one where it is bounded by the
  detector being good.
- **Two hand-written regexes that must agree WILL drift, and the drift lands in
  the feature's own subject.** The detector and the extractor each kept a copy
  of the address pattern; the extractor's had lost the newline branch and ran
  after a whitespace flatten that destroys the very newlines the anchor is made
  of. Net effect: a comment the detector accepted got clipped from character
  zero, truncating away the question the change existed to surface. Found by
  `codex review`, not by 21 passing tests. One matcher, used by both.
- **A conjunction implemented as "both are true somewhere" is not the
  conjunction you argued for.** "A question mark AND a direct address" was
  written as `text.includes('?') && addressMatches`, so a status note linking
  `?tab=open` was announced as a question — the exact false positive the second
  half existed to prevent. The relationship mattered: the question must follow
  the address, in its paragraph, and be sentence-ending (a `?` followed by
  whitespace or end-of-text, which is what separates prose from a query string
  or optional chaining).
- **Watch for a test that became a tautology when you refactored under it.**
  An equivalence test comparing `unansweredRun` to `awaitingPerson` was written
  while they were independent and kept after `awaitingPerson` was reimplemented
  on top of `unansweredRun` — at which point it could not fail. Replaced with
  the pre-change predicate written out from scratch, plus an assertion that the
  case list covers both answers so an always-true implementation still fails.
- **A mutation harness needs its own positive control, and in zsh the obvious
  one is broken.** A round of 9 mutations reported all 9 "killed" — from
  `chk "label" $CMD` where `CMD="bun test path"`: **zsh does not word-split
  unquoted parameters**, so `"$@"` received one unrunnable string and every
  mutation "died" of a bad command rather than of a failing test. It looked
  exactly like a perfect result. Two guards, both cheap: run the UNMUTATED tree
  through the same harness first and require it to PASS, and `cmp` the file
  after each `perl -0pi` to prove the mutation actually applied. With those in,
  the same round came back 8 killed and **1 survived** — a real gap in my tests.
  Same family as "a negative test needs a positive control", pointed at the
  tool doing the checking.
- **A guard against "this match is inside quoted code" must test where the
  NAME sits, not where the match starts.** The address regex begins at a line
  start or an emphasis run, so `m.index` is routinely OUTSIDE the code span
  that quotes the address — the first version of the guard read as correct,
  passed its test, and let `Fixture: \`Name: ship now?\` — worth it?` through.
  The test passed because a *different* guard (the one on the `?`) happened to
  catch that fixture; only mutation testing separated them. When two guards can
  cover the same case, each needs a fixture the other cannot catch.
- **Re-measure a widened heuristic against the corpus that justified it.**
  Loosening the sentence-end rule to accept markdown closers fixed 7 of 9 real
  question forms — and silently re-admitted the quoted-copy class the rule
  existed to reject, which the unit tests had no reason to cover. The live
  board's 107 agent comments caught it in one run: 1 match → 2, and the new
  one's extracted ask was a row of fragments. The corpus is the regression
  test that unit fixtures cannot be, because nobody invents the input that
  breaks their own rule.

## A squashed PR's message describes some commit in its history, not the tree it shipped

- **#254 landed on main as one squashed commit whose message says
  `homeQueueTotal` "loses its `needs === 'decision'` term". Main keeps that
  term.** `packages/server/src/server.ts:806` reads `const decisions =
  open.filter((t) => t.needs === 'decision' && !t.answer);`, and the line
  directly under it reads `const rendered = items.filter((i) => i.kind !==
  'task-review');`. The shipped shape counts decisions from the projection AND
  drops ticket-borne rows from the queue half, so a decision is counted once —
  which is what the surrounding comment says. The sentence in the commit
  message was true of an intermediate commit in that PR and was never true of
  the tree it merged.
- **What this produces is a correct merge reported as a regression.** Reviewing
  PR #255's merge of #254 on 2026-08-19, the brief drawn from that message said
  to check the term was gone. It was present — which reads exactly like a
  resolution that reverted main, on the one file where both branches had
  changed the same function. The disproof took one command: `git show
  origin/main:packages/server/src/server.ts | grep -n "needs === 'decision'"`
  answers with the identical line, so main and the merge agreed byte-for-byte
  and nothing had regressed.
- **A commit message states intent at some moment in a PR's history; the tree
  states the result.** A squash flattens N commits into one message, so any
  sentence in it may describe a state a later commit in the same PR replaced,
  and nothing marks which sentences those are. When the question is "what must
  this merge preserve", read the tree — `git show <ref>:<path>` — and treat the
  message as a lead, never as the specification.
- Same family as "'X is impossible' measured AN absence, not THE absence": the
  reading was accurate and the conclusion drawn from it was wrong.

## A NUL byte makes grep silently blind, and the silence defeats the positive control too

- **One raw NUL byte in a source file makes `grep` report no matches and exit
  1 for a pattern that is plainly in the file — with no message of any kind.**
  Measured 2026-08-19. `packages/server/src/voice.ts` at `8fb81f4` was 62,399
  bytes and held exactly **1** NUL. `grep -c 'VoiceResource'` on that blob
  printed nothing and exited 1; `grep -ac` on the same blob printed **6**. The
  fix commit `51eef27` is 62,400 bytes with 0 NULs.
- **The positive control has to be a separate FILE, not a separate pattern.**
  A synthetic pair settles it: a file containing `SECRET_GATE` plus a NUL →
  exit 1, silent; the byte-identical file without the NUL → exit 0, match
  printed; `grep -a` on the first → exit 0, match printed. The trap is that the
  usual control — "grep the same file for something I know is there" — runs
  through the same blinded grep and fails too, so it CONFIRMS the false
  negative instead of exposing it.
- **The `grep` on this machine is ugrep 7.5.0, not BSD or GNU grep**, and it
  emits nothing at all before exiting 1. Worth naming, because GNU grep's
  documented behaviour here is to print `Binary file … matches` and exit 0 —
  a loud wrong answer rather than a silent one. Do not carry an assumption
  about which one you are talking to; `grep --version` is one line.
- **The check that cannot be fooled reads bytes, not matches:**
  `python3 -c "print(open(p,'rb').read().count(b'\x00'))"` — non-zero means
  every plain grep of that file is lying to you. `grep -a` restores matching
  once you know to reach for it.
- **This is not hypothetical and it has already cost a public retraction.**
  A security fix was reported as absent from a file that contained 31
  instances of it, on the strength of a grep that had gone blind this way.
  Treat "the thing isn't in this file" as unproven until either the byte count
  is 0 or `grep -a` agrees.
- **`grep -a` belongs on every probe against a DIFF too, not only against a
  build artifact.** This entry originally scoped the habit to bundles, which
  reads as "binaries are the risk" — but source diffs carry NUL whenever any
  file in range does. Measured 2026-08-19 on #255: the first semantic sweep
  reported **0 hits and was wrong**, because the diff included `voice.ts` and
  its one NUL blinded the whole range. `grep -c` returned *empty* while
  `grep -ac` returned **1280** on the same input, and the hit it hid was the
  single call the entire semantic question turned on.
  - **The empty string was the only tell, and a bare `0` would have read as a
    clean answer.** That is the difference worth internalising: this failure
    does not look like an error, it looks like a negative result. If a count
    comes back empty rather than `0`, you are not looking at "none" — you are
    looking at a grep that refused to answer.
- **A whole battery of probes can go blind together, which is what defeats the
  usual sense of safety in numbers.** Six independent bundle probes over one
  NUL-bearing file would all print nothing and all exit 1 — six clean
  negatives, agreeing with each other, every one of them vacuous. So the
  safeguard is not "run a positive control" in the abstract but **run one
  through the same code path as the probe**: same flags, same file, same
  invocation. A control that differs anywhere is testing a different question.
- **A second file carried one for days on `main`, so this recurs and the fix
  has to be a gate rather than a habit.**
  `packages/server/src/review-migration.ts` held exactly 1 NUL — a sentinel
  written as a literal `\0` where the escape was intended — from `aec4cf0`
  (2026-08-18) through `8e75e0e`. Measured on that blob: `grep -c 'export'`
  printed **nothing** and exited 1; `grep -ac 'export'` on the same bytes
  printed **12**. #255 removed it incidentally (14,148 bytes, 0 NULs), so
  `main` is clean as of `676f53b` — by luck, not by a check. A CI guard is
  filed as its own ticket; until it lands, `grep -a` on every literal check is
  the whole mitigation.
- **Counting the `prose.ts` case, that is three source files in this repo.**
  The write side is the entry at the top of this file, "Don't let the editor
  tools write raw control bytes into source"; this is the read side, and the
  two keep meeting because nothing between them fails.
- Same family as "A negative probe needs a positive control", with the sting
  that here the control is inside the blind spot with the probe. The inverse —
  a probe that answers "yes" whatever you point it at — is "A probe that always
  answers 'yes' is as vacuous as one that always answers 'no'", and both were
  hit in the same session by the same person looking for the same byte.

## `git show --cc` has THREE outcomes, and the control for it must be `-c`

- **`--cc` is a filter, not a view, so a zero from it is one of three
  different things and the number alone cannot say which.** All measured
  2026-08-19 on this repo, git 2.54:

  | commit | parents | `--cc` | `-c` | what the zero/number means |
  |---|---|---|---|---|
  | `278de00` | 1 | 92 `@@` | — | degraded to an ordinary diff |
  | `db2fec2` | 2 | **4** | **73** | 4 hunks differ from BOTH parents |
  | `b343693` | 2 | **0** | **76** | every conflict resolved by taking a side |

- **Case 1 — single parent: `--cc` silently degrades to an ordinary diff and
  shows everything.** `278de00` emits 92 hunks under `--cc`, all `@@`, zero
  `@@@`, identical to plain `git show`; `server.ts` alone is 8 either way. A
  reading here looks informative and answers nothing — not empty, but
  *complete and unremarkable*, which is worse, because it reads as "I checked
  the combined view and saw nothing odd."
- **Case 2 — two parents, `--cc` non-zero: those hunks differ from BOTH
  parents**, i.e. content typed by hand into a conflict region. That is the
  thing worth reviewing on a merge, and `db2fec2`'s 4 is it.
- **Case 3 — two parents, `--cc` zero: this is a POSITIVE finding, not an
  absence.** `--cc` suppresses any hunk matching *one* parent, so zero means
  no hunk differs from both — every conflict was resolved by taking one side
  wholesale and nothing novel was authored. Clean by construction. `b343693`
  = 0, and it was nearly reported as unverifiable on the strength of that
  zero.
- **The control I previously prescribed here was circular, and this entry used
  to carry it.** It said to take the whole-commit `--cc` count as the control
  before trusting a per-file `--cc` zero — but that is *the same suppressed
  measurement*, so it collapses to zero in exactly the case it exists to
  catch. It can never fail when it matters. **The control is `git show -c`**,
  which counts every combined hunk without suppression: 73 and 76 above,
  non-zero on both, which is what establishes the commits have combined hunks
  at all. (`ecaf378`: `--cc` 7 against `-c` 113.)
- **Settle the parent count first** — `git rev-list --parents -n1 <sha> | wc -w`
  returning **2** means one parent, and `--cc` is telling you nothing about a
  resolution. On a real two-parent merge `--cc` is already the default, so
  typing it never changes the output, only what you believe you asked for.
- **Generalised, and the reason this is an entry rather than a git footnote: a
  positive control drawn from the same measurement as the thing it checks is
  not a control.** It has to arrive by a different path — a different flag, a
  different tool, a different derivation — or it agrees with the broken reading
  by construction. Same failure as confirming a test-file count by re-running
  the same runner; see "An expected test-file count goes stale in the direction
  that reads as correct" and the thesis in "A probe that always answers 'yes'
  is as vacuous as one that always answers 'no'".

## Red gates on a diff that touches no code: count failed FILES against failed TESTS

- **A docs-only branch — one `.md` file, +61 lines — took `bunx vitest run` and
  `bun test packages/server/test` both to exit 1.** Measured 2026-08-19 in a
  worktree created minutes earlier with `git worktree add … origin/main`. That
  is the shape that gets waved through as flake, or read as "main is broken",
  and it was neither.
- **The tell is in the two counters, and they disagree.** vitest reported
  `Test Files 56 failed | 50 passed (106)` next to `Tests 755 passed (755)` —
  fifty-six files failed while **zero tests** did. A file that fails to LOAD
  fails before any test in it runs, so it contributes no failing test; an
  assertion failure contributes exactly the opposite. Fifty-six files down and
  nothing red inside them cannot be a code regression, and a one-file docs diff
  cannot break a file it does not appear in.
- **The cause was the environment, and the error said so plainly:** `Failed to
  resolve import "@feedback/core"` from vitest, `Cannot find module
  '@feedback/core'` from the server suite. `git worktree add` creates the tree
  but no `node_modules`, and this monorepo's workspace packages resolve through
  it. `bun install` — 948 packages, 731ms — then all four gates exit 0, with
  1702 and 1813 tests respectively. Nothing about the diff changed.
- **So the first question on a red gate is not "which test broke" but "did the
  test files load".** Read the failed-files and failed-tests counters together
  before touching anything. They separate a missing install, a bad import path
  and a genuine regression in one glance, and re-running the suite — the
  reflex a red gate invites — tells you nothing, because it fails identically
  every time.
- Related: "Four gates, and each one is the only thing that catches its class".
  A gate that cannot load its subject has not run, whatever its exit code
  suggests.

## An expected test-file count goes stale in the direction that reads as correct

- **"Expect ~109 vitest files" was circulated as the guard against the entry
  above — a green run that silently skipped files — and it was right when
  derived and wrong two merges later.** Counted statically from the config
  globs at each commit: `8ff9a81` **105**, `77ca4dd` **106**, `278de00`
  **111**, `8e75e0e` **111**, `676f53b` **113**.
- **A stale expectation sits BELOW the true count, which is the direction that
  hides a skip.** A run that lost four files still clears a threshold set two
  merges ago, and clearing it reads as the guard working. Three agents each
  reported a different number — 109, 111, 113 — and **all three were correct
  for the commit they were on**, so the disagreement looked like sloppiness
  rather than the signal it was.
- **Derive it per-commit from the artifact under test.** `vitest.config.ts`
  excludes `packages/server/test/**`, so the two suites have separate counts
  and neither number describes both:

  ```bash
  git ls-tree -r --name-only <ref> \
    | awk '/^packages\/[^\/]+\/test\/.*\.test\.ts$/ || /^packages\/[^\/]+\/src\/.*\.test\.ts$/ || /^scripts\/.*\.test\.ts$/' \
    | grep -v '^packages/server/test/' | wc -l
  ```

- **The general form: a threshold copied from another agent's run is a constant
  with an expiry date nobody records.** Nothing marks the moment it stops being
  true, and it keeps passing on the way out.
- **The sharper half — repeating a run three times and getting agreement does
  not detect a STABLE skip.** Only an independent derivation does. Same family
  as "A positive control can silently become a duplicate of the thing it
  controls": agreement between measurements that share a cause is not
  corroboration. The general statement is under "The thesis, stated once for
  the whole family" in "A probe that always answers 'yes'…".
- **Do not recover the count from the runner's LOG, which is the obvious next
  move and is wrong** — see the entry directly below.

## `bun test`'s log cannot enumerate its own run set, and reading it as one invents missing files

- **The improvement was right and the probe was wrong.** Counts alone can hide
  a skip plus a compensating inclusion, so the better check is to diff the
  runner's actual file LIST against the tree. On the vitest side that works:
  113 in tree, 113 in log, `comm` empty in both directions. On the server side
  the same method appeared to show **79 of 144 files in the tree but never
  run** — which reads exactly like a merge dropping most of a suite.
- **It was the probe. `bun test`'s default reporter prints a `path.test.ts:`
  header only for files that emit OUTPUT** — in this repo, files that produce
  `[rooms] failed to persist` stderr noise. Everything that passes silently is
  named nowhere in the log. Measured on two runs of the same suite: **65 of
  144** files named in one, **63 of 144** in another — the count is not even
  stable between runs, because it depends on which files happened to be noisy.
- **The positive control settles it in one command.** Take an alleged skip and
  run it standalone: `bun test packages/server/test/activity.test.ts` → 13
  tests, 0 failures, and bun prints **no header for it**. So the enumeration
  returned zero for a file that demonstrably runs.
- **This one fails in the expensive direction — a false POSITIVE on a
  regression.** Most probe failures in this archive are false clears; stopping
  at this output would have blocked a correct merge and sent someone hunting a
  merge bug that does not exist. A silent pass is invisible to a log-based
  enumeration **by design**, so no amount of re-reading the log fixes it.
- **What does work: derive the expected set from the artifact under test** (the
  static `git ls-tree` off the config globs, in the entry above) and reconcile
  it against bun's own summary line, `Ran N tests across M files` — a number
  the runner computes, not a list it happens to print.
- **The general form: a tool's human-readable output is not an inventory of
  what it did. It reports what it found worth saying.** A sibling agent hit the
  same shape in a different tool — a served-bundle freshness check that passed
  because someone else's build happened to land inside the window, where the
  artifact's own `dist/` mtime was the thing that actually answered it.

## `git merge-tree`'s three-arg form hides conflict markers behind a diff prefix, so an anchored grep never matches

- **`git merge-tree <base> <a> <b> | grep -c '^<<<<<<<'` returns 0 on every
  input, conflicted or not.** Measured 2026-08-19 on git 2.54 against a pair
  constructed to conflict: anchored `^<<<<<<<` → **0**; unanchored `<<<<<<<` →
  **1**. The markers ARE emitted — but inside a diff hunk body, so the line
  reads `+<<<<<<< .our` and the `^` anchor misses it by exactly one column.
  The surrounding format is not a merge result at all: `changed in both` /
  `base` / `our` / `their` headers followed by diff hunks.
- **The cost was real: a zero from this probe was reported as evidence that
  four in-flight branches merged cleanly, and offered as a bound on merge
  risk.** It was not weak evidence — it was no evidence, printed as a number.
- **Scope it precisely; the over-broad retraction is its own error.** It is the
  *anchored marker grep on the three-arg form* that is blind, not `merge-tree`.
  Two-arg `git merge-tree --write-tree A B` discriminates by exit code —
  measured **1** on the conflicting pair and **0** on a non-conflicting
  control — and `--write-tree --messages A B` is better still, printing
  `CONFLICT (content): Merge conflict in f.txt`, one line per file, so it names
  what conflicts instead of merely signalling that something does. Sending the
  next person away from a working tool would cost more than the bad probe did.
- The negative control matters as much as the positive one here: the probe
  returns 0 on a clean pair *and* on a conflicting pair, which is what makes
  the reading indistinguishable from a real all-clear. See "The thesis, stated
  once for the whole family" under "A probe that always answers 'yes'…".

## An assertion whose alternation can match either way pins nothing, and reads as coverage of exactly the thing it does not check

- **The assertion, `packages/mcp/test/skills-declare-once.test.ts:75-83`:**
  ```js
  expect(text.toLowerCase()).toMatch(/5[- ]minute|five minutes|goes quiet|stay live/);
  ```
  Its test name is *"says a declaration does not keep you live — the heartbeat
  window still gates delivery"*, and its comment restates the claim it appears
  to guard, verbatim. But `goes quiet` and `stay live` are generic enough to
  match the WRONG text, the CORRECTED text, and a later reinstatement of the
  wrong text. It passes in all three worlds. **An alternation is only as
  strong as its weakest branch** — if any branch would match text that
  violates the property, the assertion tests nothing about that property.
- **The check is one question: what text would make this fail?** If you cannot
  name a concrete string that turns it red, it is not an assertion, whatever
  its name says. Worse than absent coverage, because it occupies the slot a
  real test would take and tells the next reader the claim is pinned.
- **Measured cost.** A shipped, fleet-wide MCP tool description stated the
  wrong delivery rule — *"every delivery gate asks for a heartbeat inside the
  ~5-minute window"* — and survived **four green CI runs and three independent
  reviewers**. Post-#253 that is wrong twice over: `isDeliverable`
  (`tasks.ts:5217`) reads `observedWorkFreshMs ?? OBSERVED_LIVE_MS`, which is
  **15** minutes, off `max(lastHeartbeat, lastToolCallAt)` plus a wire probe.
  The 5-minute figure is `HEARTBEAT_FRESH_MS`, which feeds the DISPLAYED state
  and not delivery — a split `OBSERVED_LIVE_MS`'s own comment spells out.
- **The other half of why it survived, and it is separately worth knowing: the
  passage was internally HALF-RIGHT.** Every one of the sites also said "Tool
  calls refresh it, so a working session is fine" — which is correct, and
  post-#253 aware. So the text read as informed by someone who knew the
  mechanism, and a careful reader had no snag to catch on. **A confidently
  written passage that is 90% right is harder to catch than one that is wrong
  throughout**, because the wrong 10% inherits the credibility of the rest.
- **Scope, once anybody looked: SEVEN prose sites, not one** — four `mcp.ts`
  tool descriptions (`watch_coverage`, `set_workspace_lead`, `attach_agent`,
  `heartbeat`) and three skill passages. **Three of the seven were verified
  present on `origin/main`**, so the claim had already been shipping; the
  branch that got blocked for it merely added four more. It was found by
  grepping the whole tree for one phrase AFTER a single instance surfaced —
  not by reading the diff. The diff-scoped read is exactly what missed it
  three times, because a wrong sentence that main already carries is not in
  the diff to be reviewed.
- **A sweep needs its own positive control, and this one nearly under-reported
  by one.** A fixed-string `grep -F` for `gated on a heartbeat inside the
  ~5-minute window` returned 0 against a file that says exactly that — the
  phrase is **line-wrapped** in the markdown, so no single line contains it.
  Re-running through `tr '\n' ' ' | tr -s ' '` found it. Prose wraps; a
  literal multi-word probe against a wrapped file reports a clean absence.
  The contrast is the actionable part. Measured on the same file at the same
  commit:

  ```
  grep -F 'gated on a heartbeat inside the ~5-minute window'   → 0  (exit 1)
  tr '\n' ' ' | tr -s ' ' | grep -F   (same phrase)            → 1
  grep -c '5-minute'                                           → 1
  ```

  The long search missed it and a short token found it, and the file shows
  why — the break lands mid-phrase, between `gated on a` and `heartbeat`,
  while `5-minute` sits whole on one line. **The longer and more specific the
  search string, the more line-breaks it has to survive**, so in prose the
  distinctive short token is the more reliable probe and the full phrase is
  what you use to *read* the hit once you have it, not to find it. Two people
  sweeping the same tree came out at seven sites and six for exactly this
  reason — not better judgement, a shorter needle.
- **The mirror image: an assertion on wall-clock time measures the machine,
  and reports on the box rather than the code.** Met during this same PR's
  gates. `summarize.test.ts`, "paces itself across the window it was given",
  drains 4 tasks over a 200ms pacing window and asserts `elapsed < 200` to
  prove there is no trailing gap after the last call. It came in at **213ms**
  while other suites were saturating the machine, and passes 3/3 in isolation
  — on a docs-only diff that cannot reach the scheduler.
  - The two bounds in that test are not equally sound, and the difference is
    the rule. The lower bound (`elapsed >= 120`) says *the delay exists*; load
    can only push elapsed UP, so noise never makes it pass wrongly. The upper
    bound says *no trailing gap*, and load pushes elapsed up too — so the same
    noise fails it. **A lower bound on elapsed time is robust and an upper
    bound is not**, and it fails hardest exactly when the box is busiest, which
    is when CI runs it. Assert the ceiling against a fake clock, or not at all.
  - It belongs in this entry because it is the same defect seen from the other
    side. The alternation reported success without looking at the thing it
    named; this reports failure about something it never measured. In both, the
    assertion's subject and what it actually tests have come apart — the
    failure "the probe ran, it just measured something other than what it
    claimed to" already recorded for the mobile-viewport verification.
  - It also costs more than a re-run, because **the shape is
    indistinguishable from a real regression until you look**, and the
    cheapest-looking reading is "flake, re-run it". That reflex is right here
    and catastrophic when it is not — which is why the neighbouring rule
    stands: measure the baseline on unmodified HEAD before concluding either
    way. Filed as its own ticket rather than fixed here; a learnings PR that
    starts fixing tests stops being reviewable as docs.
- Same family as "A negative probe needs a positive control", pointed at
  assertions rather than searches: a check that reports success without having
  looked at the thing it names.

## A merge's blast radius includes every sentence that describes the changed behaviour, and only the code half is self-reporting

- **The incident.** #253 split one liveness clock into two: `HEARTBEAT_FRESH_MS`
  (~5 min) kept driving the DISPLAYED active/away label, while delivery moved to
  `isDeliverable` — `OBSERVED_LIVE_MS` (15 min) over
  `max(lastHeartbeat, lastToolCallAt)`, plus an open-channel probe. #256 merged
  main in, got a **clean auto-merge**, and three fixtures went red. They were
  fixed, the suites went green, and the merge was reported resolved.
- **The three fixtures were the only part of the blast radius that could
  announce itself.** The same semantic change had also falsified four tool
  descriptions, two shipped skills, a test's NAME, two of its comments, and one
  of its assertions. None of those can fail. The search stopped at three because
  **the thing that tells you to keep looking is a failing check**, and prose has
  none.
- **The rule: after a merge that changes what a value MEANS rather than what it
  is, grep the tree for the old concept in prose** — comments, tool
  descriptions, skills, test names, PR-facing docs. The compiler and the suite
  between them cover none of those surfaces. Scope the grep to the tree, not the
  diff: a wrong sentence main already carries is not in the diff to be reviewed,
  which is how three of the seven sites had been shipping for weeks.
- **A clean auto-merge is not evidence** when the semantic change lives in a
  function body neither side's diff touched. Git resolved the text correctly and
  had nothing to say about meaning; the absence of conflicts measured only that
  the two edits did not overlap.
- **Two properties made this worse than a plain miss, and both are in the
  neighbouring entry** ("An assertion whose alternation can match either way
  pins nothing"): the guard was written **in the same PR** and passed on the
  wrong text, and its explanatory comment restated the false claim as the
  justification. So the guard, its name, and its rationale all encoded the bug —
  **checking the docs against the docs would have confirmed the error.** Read
  that entry for the alternation mechanics and the seven-site sweep; this one is
  about why nobody went looking in the first place.
- The archive already holds several entries about checks that report success
  without having looked. This is the neighbouring case and the reason it is
  filed separately: **there was no check at all, and its absence looked the same
  as a passing one.**
