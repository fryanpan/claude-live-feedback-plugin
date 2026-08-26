# Activity Data Completeness

How far back the hands-on activity event stream (`data/activity.jsonl`) is
valid and complete, by event family. Written for the Weekly Review (WR) agent
that consumes this stream.

## TL;DR

| Event family | Complete from | Source | Notes |
|---|---|---|---|
| `comment` / `reply` | **2026-04-17** | Backfill from `.ydoc` snapshots | Every comment carries `ts` + `author` in the CRDT, so it backfills exactly. |
| `resolve` | 2026-04-17 (current-state only) | Backfill | Only threads *currently* resolved emit one `resolve` at their last-activity time. Resolve/reopen churn before the snapshot is not recoverable. |
| `reopen` | **go-live forward only** | Live capture | A CRDT snapshot holds only current state, so historical reopens can't be reconstructed. Live capture records every reopen from go-live. |
| `read_session` / `doc_open` | **go-live forward only** | Live capture (browser) | Scroll/interaction was never recorded historically — these are NOT backfillable. |

"Go-live" = the date this feature (hands-on activity event stream) lands on
`main`.

## Comment-family completeness (backfilled)

The backfill (`packages/server/src/activity-backfill.ts`) scans every `.ydoc`
in `data/` and `data/_archive/`, reads each doc's threads, and emits
`comment` / `reply` / `resolve` events with the same deterministic `eventId`
scheme live capture uses — so a re-run dedupes (identical ids) and never
double-counts.

- **Earliest person comment in the data: `2026-04-17T22:20:37Z`** — which
  coincides with WR's clean-data window start (~2026-04-17). The window is
  not lossy on the near edge: there's simply no person-comment data before it.
- Comment-family events are complete and valid from 2026-04-17 to now, for
  every doc whose `.ydoc` still exists (live data dir + archive).

### Per-week person comment volume (Apr 17 -> Jun 15, week buckets by Monday UTC)

| Week (Mon) | person `comment` | person `reply` |
|---|---|---|
| 2026-04-13 | 11 | 2 |
| 2026-04-20 | 30 | 4 |
| 2026-04-27 | 19 | 7 |
| 2026-05-04 | 48 | 12 |
| 2026-05-11 | 121 | 15 |
| 2026-05-18 | 65 | 6 |
| 2026-05-25 | 44 | 3 |
| 2026-06-01 | 94 | 14 |
| 2026-06-08 | 73 | 14 |
| 2026-06-15 | 1 | 0 |

(The 2026-04-13 bucket holds only the Apr 17 tail of that week — the clean-data
window starts mid-week.)

## Validation against WR's target

WR provided a validation target: **549 Bryan comments, Apr 17 -> Jun 13
(~22.4h of review)**. The backfill, restricted to person actors and the
Apr 17 -> Jun 13 window, produces:

- **person `comment` (distinct thread starts): 497**
- **person `reply`: 75**
- **person `comment` + `reply`: 572**

572 (all person comment-family) and 497 (distinct comment threads) bracket
WR's 549 — i.e. the backfill lands squarely in the expected ballpark. The
small spread is expected: "549 comments" depends on whether replies are
counted as comments, and on a couple of docs whose `.ydoc` may have been
deleted (a deleted doc takes its threads with it — the backfill is complete
only over `.ydoc` files that still exist).

Total backfilled events across all docs (no actor/window filter): **1288**
(`comment` 521, `reply` 498, `resolve` 269) over 220 `.ydoc` files, 89 of
which carry threads.

## Known gaps / caveats

1. **`read_session` / `doc_open` have no history.** Scroll + interaction were
   never recorded before this feature. These are complete only from go-live
   forward. Do not infer reading time before go-live from this stream.
2. **`reopen` is not backfillable** and `resolve` is current-state-only. A
   thread resolved-then-reopened-then-resolved before the snapshot shows up as
   a single `resolve` (or none, if currently open). Treat pre-go-live
   resolve/reopen counts as a floor, not exact.
3. **Resolver identity is approximate in backfill.** The CRDT snapshot doesn't
   store who resolved a thread, so backfilled `resolve` events attribute to
   the thread's creator. Live-captured resolves carry the actual actor.
4. **Deleted docs are invisible.** The backfill can only see `.ydoc` files that
   still exist on disk. A doc deleted via `delete_doc` took its threads with
   it; those comments will be missing from the backfill.
5. **`producedBy.sessionId` is best-effort.** It's populated only when
   `create_review_doc` / `bind_folder` were called with an explicit
   `producedBy: { sessionId }`. For all historical docs (and any created
   without it), `producedBy.sessionId` is `null` and `agentId` is derived from
   the owner cwd basename.

## Re-running the backfill

```
bun run activity:backfill            # writes to ./data/activity.jsonl
bun run activity:backfill ./data --dry-run   # stats only, no writes
```

Idempotent: deterministic `eventId`s mean a re-run produces the same lines, so
WR can dedupe by `eventId` if the backfill is appended more than once.

## Owner attribution: identity links

`isOwner` on each row comes from `isOwnerActor`, which recognises the identity
id `known-bryan`, the exact name `Bryan`, and any email identity registered
from `CW_OWNER_EMAIL`. An anonymous browser session matches none of those: it
arrives with a minted `anon-*` id and whatever name the person typed. Measured
on the live stream, six such ids carried 1,120 events that were all recorded
`isOwner: false`, so every owner-activity read was low by that much and nothing
reported it.

The fix is an explicit id-to-identity link, not a second name literal. A name
is a claim the browser makes about itself and nothing verifies it — matching a
looser one would start attributing somebody else's rows to the owner, which is
worse than the under-count, because nothing downstream can tell it happened.

Links live in `<dataDir>/identity-links.json` (gitignored: the real file names
a person's session ids, and this repo is public). Add one with:

```
bun run identity:link <actorId> <identityId> --note "which device / when"
bun run identity:link --list
```

The server reads the file at construction, so a new link takes effect at the
next restart. **Nothing already written to `activity.jsonl` changes on its
own** — a link governs rows written from then on.

### Repairing rows already written

```
bun run activity:repair-owner ./data           # dry run: what would change
bun run activity:repair-owner ./data --write   # rewrite, keeping a .bak
```

It recomputes `isOwner` on every row from the row's own `actorId` / `actorName`
and writes nothing else — `eventId`, `actorId` and the recorded name are left
alone, because the link says whose id that is, not that the stream observed
something different. Idempotent, and it copies the log to a timestamped `.bak`
before rewriting.

**A backfill re-run is not a substitute.** `activity:backfill` rebuilds only
the comment family from `.ydoc` snapshots; `read_session` and `doc_open` never
existed in a CRDT and are not reconstructable at all. On the measured corpus
those two types are 711 of the 1,120 affected rows, so a re-run repairs under
half of them. The backfill also appends, leaving two rows with one `eventId`
and letting the reader's dedupe policy decide which wins.

`activity:backfill` does load the same link file, so rows it emits from here on
carry the corrected attribution.
