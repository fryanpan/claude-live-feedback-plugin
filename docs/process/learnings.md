# Learnings

Technical discoveries that should persist across sessions for this project.

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
