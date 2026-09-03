# Split plan — the 33 files marked `Split`

[exceptions.md](exceptions.md) records the verdict on every file over 500
lines. This page is the execution plan for the 33 it marks `Split`: what each
file becomes, where the pieces land, who has to be updated, and which pull
request the work belongs to.

The layer names used here are defined in [overview.md](overview.md). Read that
first — a split that lands in the wrong layer is worse than no split.

## How to read a row

- **Becomes** — the new files, with the directory they are created in today.
- **Moves** — the exported symbols that leave the parent file.
- **Importers** — call sites outside the parent that must change. "None" means
  the parent keeps its public surface and delegates, which is what
  `review-items/` did to `TaskStore`.
- **Effort** — carried over from `exceptions.md`: **S** under a day, **M** a
  day or two, **L** more, with real risk.

## Where the pieces land

Split output is created **next to its parent**, or in an existing sibling
directory where one already exists (`routes/`, `hub/`, `redline/`). New
directories are not created by a split, with one exception noted in B6.

That is deliberate. A split is judgement work and a directory move is a
`git mv` plus a path rewrite, so doing the split first means the optional move
in **group F** relocates a coherent family rather than a god file. Every row
below names the layer directory it would end up in if group F is taken, so
that group needs no fresh decisions — it is mechanical.

## The two lanes

**Lane A is `packages/server`. Lane B is everything else.** The two lanes
share no files and can run at the same time, with two exceptions flagged in
the rows: **B2 must land after A1**, and **A8 must land after A6**.

Within Lane A the PRs are sequential. A1 moves roughly 4,400 lines out of
`server.ts`, so anything else editing that file conflicts. After A1 lands,
later Lane A PRs may touch `server.ts` **only** to update an import path.

Ordered by 90-day churn: `server.ts` 233 commits, `hub-app.ts` 102,
`hub-render.ts` 95, `hub-model.ts` 89, `tasks.ts` 88, `rooms.ts` 72,
`styles.css` 158. The highest-churn work is first in each lane, because every
week it waits is another week of merge conflicts against it.

---

# Lane A — `packages/server`

## A1 · `server.ts` — the route chain and the HTML shells — DONE

10,827 lines before, **7,131 after**. One PR, five commits — one per
extracted family, in the order they appear in the chain. **Effort L.**

The estimates below were wrong in two rows and the errors cancelled:
`routes/docs.ts` is 1,972 lines rather than ~570 (the `/api/docs/:id/...`
resource block alone is ~1,200) and `routes/meetings-calendar.ts` is 562
rather than ~1,300. The total moved is what the plan predicted.

| Commit | Becomes | Moves | Importers |
|---|---|---|---|
| 1 | `routes/auth-share.ts` (781) | the sign-in, session and share-link routes | none — chained by `??` from `createServer` |
| 2 | `routes/docs.ts` (1972) | the doc, thread and bind routes | none |
| 3 | `routes/meetings-calendar.ts` (562) | the meeting, transcript and calendar routes | none |
| 4 | `routes/ops.ts` (281) | metrics, plugin-refresh, push and deploy routes | none |
| 5 | `shells.ts` (930) | `renderHubShell`, `renderSigninShell`, `renderLanding`, `renderProjectPage`, `serveStatic` | none — `server.ts` re-exports the four names the tests and `bin.ts` address it by |

Each handler takes an explicit context object, following
`routes/task-routes-context.ts` — do not capture the `createServer` closure.
Preserve the matching order exactly; the chain is walked top to bottom and a
route that moves can start answering a path that reached a different one.
`routes/workspaces.ts` documents why it needs four entry points, and that
turned out to be true here too: `routes/docs.ts` needs three and
`routes/ops.ts` two, because each family sits in more than one chain
position.

There are no uptime or release routes to move. Uptime is a field on the
metrics reply and the release is a field on `GET /api/deploy`, which is also
where the deploy's own verification verdict is read back.

Layer: HTTP. Final directory: `routes/` and `server/src/` respectively.

## A2 · the board stores — DONE

| File | Became | Moved | Measured |
|---|---|---|---|
| `tasks.ts` (6,915) | `workspace-store.ts` | `createWorkspace`, `renameWorkspace`, `setWorkspaceRetired`, `deleteWorkspace`, `setLeadAgent`, `attachDoc` | 569 (est. ~700) |
| | `task-agents.ts` | `attachAgent`, `heartbeat`, `leadSeatHealth`, `mergeAgent`, the voice and comment queues | 1,506 (est. ~1300) |
| | `task-goals.ts` | `setGoalList`, `renameGoal`, `addGoal`, `reorderGoals`, `setTaskGoal` | 811 (est. ~1000) |
| `task-projection.ts` (1,035) | `task-row.ts` | `projectTask`, `projectBody`, `taskBodyDocId` | 309 (est. ~250) |

`tasks.ts` ends at **4,714** from 6,915, and `task-projection.ts` at 743.
Four commits, one per file. `TaskStore` keeps its public surface — 35 files
import it — through forwarders, and each extraction declares the narrow
persistence interface it needs the way `review-items/store.ts` does.

**What the estimates missed, and it is the same thing three times.** A store
verb is not separable from the pure helpers it reads: `isRetired`,
`publicAttachment`, `sequenceAfter` and their neighbours had to move WITH the
verbs, because an extracted file may not import a value from the file that
imports it. That is why `task-agents.ts` came out 200 lines over and
`task-goals.ts` 190 under — the helpers followed the verbs rather than the
plan's method lists. `tasks.ts` imports them back and re-exports them, so no
caller outside changed.

Two things stayed behind deliberately. `goalIdExists` and `syncGoalRows` are
read by task verbs that did not move, so the store keeps them and the goal
bands ask through the interface. The sidecar writers (`persistAttachments`,
`scheduleAttachmentsSave`, the `rmSync` paths) stayed with `persist()` — same
layer — and are reached as named persistence members rather than imported.

`mergeAgent` moved to `task-agents.ts` rather than `workspace-store.ts`
despite walking every board: everything it touches is an attachment, a
comment queue or the lead seat, and splitting it the other way would have
made the two files import each other.

Layer: services, with `task-row.ts` in domain. Final directory: `board/`.

## A3 · the doc stores — DONE

| File | Became | Moved | Measured |
|---|---|---|---|
| `rooms.ts` (6,314) | `doc-edit-ops.ts` | `setDocContent`, `findAndReplace`, the suggestion verbs, the anchored inserts and deletes, `autoReanchor` | 463 (est. ~1000) |
| | `doc-threads.ts` | `postComment`, `resolve`, `reopen`, `reanchor`, `listThreads`, and the review payload a thread carries | 755 (est. ~1200) |
| | `rooms-workspaces.ts` | `buildWorkspaceTree`, the grouped diff and all-files views, `openContextFile`, `archiveReview`, `archiveDoc` | 1,040 (est. ~1100) |
| `binds.ts` (986) | `bind-meta.ts` | `BindHost`, `memberDocId`, `writeMeta`, `setStaleFlag`, `setGroupMeta`, `refreshDiffMeta` | 225 (not planned) |
| | `bind-diff.ts` | `bindDiff` and its browse and working-tree modes | 399 (est. ~350) |
| | `workspace-refresh.ts` | `refreshWorkspace`, `setWorkspaceGroups` | 341 (est. ~350) |

`rooms.ts` ends at **4,801** from 6,314 and `binds.ts` at **112**, which takes
it off the over-limit list entirely. Six commits, one per file. Every
importer's line is unchanged: `Rooms` keeps its public surface through
forwarders, and `binds.ts` re-exports what moved under the names it published.

**`attachFile` did not move, and the plan was wrong to group it with the
workspace surface.** It is the head of the file-binding machinery — the mtime
poll, the debounced write-back, the conflict reconcile, the home guard — and
every path in it reaches into the room's `ydoc` and its persist timers. That
is the next seam in `rooms.ts` (`file-binding.ts`, ~900 lines), and it needs a
room handle designed for it rather than a line range.

**The plan's binds.ts split was not possible as written.** `bindDiff` and
`refreshWorkspace` both call the same small meta writers, and `refreshWorkspace`
calls `bindDiff` itself, so splitting them two ways would have made the two
files import each other. `bind-meta.ts` is the leaf that makes the split legal:
the writers and the `BindHost` slice moved there first, in their own commit, and
both flows are written in its terms.

Two things stayed with `rooms.ts` deliberately. The summary machinery
(`backfillSummaries`, `applyThreadSummary`, `scheduleSummary`) reads the room
map, the doc index and the eviction rules, which are the lifecycle's own
concern. `bindFolder` stayed in `binds.ts` because it is now a translation of
`bindDiff` in browse mode, and moving it would have left the file as nothing
but re-exports.

`isHubOwnedRoom` moved to `doc-ids.ts` rather than into any of the new files:
it reads `HUB_ROOM_PREFIXES` and both `rooms.ts` and the workspace surface ask
it, so the alternative was a value cycle. It sits one line from
`isReservedDocId`, which answers the neighbouring question off the same list.

Layer: services, unchanged.

## A4 · boot and composition — DONE

| File | Became | Moved | Measured |
|---|---|---|---|
| `bin.ts` (1,025) | `server-config.ts` | env and argv → one typed config, with the misconfiguration refusals | 444 (est. ~350) |
| | `server-deps.ts` | every "the ONLY place a real X is constructed" seam, with the log line that says whether it was | 371 (est. ~350) |

`bin.ts` ends at **379**, which is argv parsing, the Sentry process handlers,
the port wait, the `createServer` call, the boot banner and the shutdown hook —
the things that are about running a process rather than about configuring one.
Two commits, one per file.

The two halves are "what to build" and "build it". That is why the
misconfiguration warnings went with the config rather than staying in the
entry point: a `CF_ACCESS_TUNNEL_HOSTS` list without an Access application in
front of it is not a value plus a warning, it is a value that was refused, and
the refusal is part of resolving it. The log lines in `server-deps.ts` are the
mirror image — each says which adapter was built, or the one command that
would build it.

**Verified by booting both.** The pre-split `bin.ts` and the post-split one
were each started on a throwaway port and data dir; their boot output is
identical line for line, and `/`, `/api/docs` and `/api/deploy` answer 200,
200 and 501 on both. Worth doing because a boot script is the one file whose
behaviour the suites mostly do not reach.

One deliberate change beyond the move: `dataDir` comes out of the config as a
`string` rather than `string | undefined`. It was optional only because the
flag reader is, and two later readers repeated the whole resolver call to work
around it.

Layer: entry.

## A5 · the meeting family — DONE

| File | Became | Moved | Measured |
|---|---|---|---|
| `meeting-task-capture.ts` (1,348) | `meeting-capture-prompt.ts` | the five intent rules, `buildTaskCapturePrompt`, `parseTaskCaptureReply` and the three length caps | 330 (est. ~380) |
| | `meeting-capture-guards.ts` | every "did the transcript vouch for it" predicate, the overlap window they are asked about, and the word helpers they share | 310 (est. ~200) |
| `meeting-notes-merge.ts` (1,067) | `notes-ownership.ts` | the ledger, `classifyOwnership`, `readNotesSection`, `reclaimAfterInPlaceEdit`, `agentOwnedElements` | 172 (est. ~250) |
| | `notes-section.ts` | the item model, `findNotesSection`, the flatteners, `stripSectionHeading` | 218 (est. ~250) |
| `meeting-notes.ts` (1,039) | `pause-ticker.ts` | `createPauseTicker`, `TickScheduler`, `realTickScheduler`, both durations | 210 (est. ~190) |
| `meeting-notes-doc.ts` (986) | `notes-section-write.ts` | every verb that writes into a live section, plus the tag-run rewriter they share | 498 (est. ~470) |

Six commits, one per extracted file, plus this one. The four parents end at
794, 758, 870 and 524 against estimates of 600, 550, 800 and 400. Every name
each parent exported it still exports, by re-export, so no caller and no test
changed.

**`readNotesSection` went with the ledger, not with the section readers.** The
plan filed it under `notes-section.ts`; it reads through `classifyOwnership` to
say which items are a person's, and `reclaimAfterInPlaceEdit` reads through
`findNotesSection` to find them, so the planned arrangement makes the two new
files import each other. Ownership imports section, one way.

**The guards came out bigger than the plan and the prompt smaller**, for the
same reason: the three named guards share `significantWords` and the stopword
list with three more (`requestMatchesCandidate`, `spokenLineFor`,
`speakerOnTick`), so all six travelled rather than leaving one private helper
in two files. Four structural helpers in `notes-section.ts` (`headingText`,
`isList`, `marker`, `sectionItems`) are exported for the same reason — the
merge planner still calls them — but stay off `meeting-notes-merge.ts`'s own
surface.

`relabelNotesSection` and `appendResearchPlaceholder` were not in the plan's
list for `notes-section-write.ts` and moved anyway: they sit inside the same
run of section surgery and share its tag-run rewriter and text-node
collectors.

Layer: `pause-ticker.ts`, both capture halves and `notes-section.ts` are
domain; `notes-ownership.ts` and `notes-section-write.ts` are services with
the rest of the family.

## A6 · voice and the review queue — DONE

| File | Became | Moved | Measured |
|---|---|---|---|
| `voice.ts` (2,109) | `voice-prompt.ts` | the utterance vocabulary, `buildVoicePrompt`, `parseVoiceReply`, `renderResourceBlock`, `VOICE_ACTIONS` | 499 (est. ~450) |
| | `voice-action.ts` | `VoiceActor`, `VoiceActionPlan`, `resolveVoiceAction`, `speakerLicensesAction`, `pickReviewItem` | 357 (est. ~350) |
| `voice-resolve.ts` (762) | `voice-status.ts` | `composeStatus`, `ago`, `quote`, `listTitles`, `capWords`, `countWords`, the status shapes | 187 (est. ~190) |
| `review-queue.ts` (831) | `ask-detection.ts` | `asksPerson`, `findAsk`, `extractAsk`, `sentenceQuestion`, `codeSpans`, `stripEmphasis` | 249 (est. ~250) |

Four commits, one per row. The three parents end at **1,318**, **588** and
**602**. Every extracted file is pure; `VoiceRouter` stays the service.

**The ask matcher is now unsplittable, which was the point.** `extractAsk`
calls `findAsk` and there is no second pattern in the file to drift from it.

**`VOICE_ACTIONS` went to `voice-prompt.ts`, not to the guardrail this plan
filed it under, and the reason is a dependency rather than a preference.**
The system prompt lists the five action shapes and `parseVoiceReply` refuses
a verb outside them — both in `voice-prompt.ts` — while `resolveVoiceAction`
switches over the already-parsed verb and never reads the list. Filing the
list with the guardrail would have made the prompt file import a value from a
file that imports values back, which is the cycle A2 and A3 each hit.

**The vocabulary had to move with the prompt for the same reason.**
`VoiceContext`, `VoiceResource`, the `VoiceReviewItem` family and
`reviewItemKey` are read by the renderer AND by the guardrail, and an
extracted file may not import a value from the file that imports it, so they
sit in the leaf. That is what took `voice-prompt.ts` to 499 rather than 450.
`VoiceActor` went the other way, to `voice-action.ts`: the guardrail's fourth
condition is about `actor.kind` and the prompt never renders a speaker.

**Two module-private helpers became exported and one did not move.**
`sameOriginPath` and `refNavigation` are called by the router, so they are
now part of `voice-prompt.ts`'s surface. `choiceAnchor` stayed with the
router — it keys a pending question, not an action. Inside
`ask-detection.ts` nothing new was exported: `sentenceQuestion`, `codeSpans`
and `stripEmphasis` had no caller outside the parent before the split and
have none now.

**`parseVoiceContext` stayed in `voice.ts`** while its type left. Its only
caller is `routes/workspace-settings.ts`, which reads it as the route's input
sanitizer, and moving it would have pushed `voice-prompt.ts` over 500 lines —
a split that creates a fresh row in `exceptions.md` has not finished.

**`voice-resolve.ts` now imports nothing at all.** `StatusTask` was the only
reader of `TaskStatus`, so the resolver came out of this as pure over strings,
which is what its header always claimed.

Layer: domain, except `VoiceRouter` which stays a service. Final directory:
`voice/` for the four voice files, `board/` for `ask-detection.ts`.

## A7 · the operational adapters — DONE

| File | Became | Moved | Measured |
|---|---|---|---|
| `activity.ts` (582) | `actor-identity.ts` | `classifyActor`, `authorFields`, `isOwnerActor`, the owner registry, the identity links, the roster handle and every `reset*` seam | 305 (est. ~240) |
| `deploy.ts` (1,058) | `deploy-log.ts` | `writeDeployLog`, `readDeployLog`, `confirmDeployBoot`, `expireDeployVerification`, `spawnDeployVerifier`, and the record's four types | 282 (est. ~250) |
| `recall-calendar.ts` (721) | `google-oauth.ts` | `resolveGoogleOauthCreds`, `createGoogleOauthApp`, `createKeychainRefreshTokenVault`, `readKeychainAccount` | 222 (est. ~190) |

Three commits, one per extraction, plus this one. The three parents end at
**301**, **817** and **470** — which takes `activity.ts` and
`recall-calendar.ts` off the over-limit list entirely, so their rows in
`exceptions.md` are gone rather than marked done.

**The importer set was 26, not 25, and the sweep found the extra one.**
`classify-actor-malformed.test.ts` is not in either count in the row above.
Rewriting every import with one mechanical pass over `packages/**/*.ts` — a
regex on the import specifier, splitting each list into what stays and what
goes — reached it without anyone having to remember it existed. The type
checker then found nothing, which is the outcome that pass is for.

**`isOwnerActor` and `authorFields` travelled with the five named symbols.**
`isOwnerActor` reads `OWNER_IDS` and `resolveIdentityId`; `authorFields` is
the defensive reader that both it and `classifyActor` call. Leaving either
behind would have pointed the new file back at its parent, which is the cycle
A2, A3 and A6 each hit. `ActorKind` moved for the same reason and
`activity.ts` re-exports it, so `Event`'s own shape still reads from one
import.

**The deploy record's TYPES moved with the trace, and that was not in the
plan.** `DeployResult`, `DeployStatus`, `DeployVerification` and `BusyDoc`
describe a file three processes write and read without ever meeting — the
deploy stamps `pending` before the restart kills it, the restarted server
stamps `healthy`, a detached watchdog stamps `boot-failed`. That makes them a
wire format belonging with the readers and writers, not an internal type of
the runner. `VERIFY_BOOT_TIMEOUT_MS` went with them because it is the deadline
written into the record. `deploy.ts` imports all five back and re-exports
them, so no caller that names `DeployResult` changed.

`bootFailedResult` is newly exported rather than moved-and-private:
`Deployer.last` derives the same verdict at read time and stayed with the
runner, and its own comment says the two must never tell different stories.

**`google-oauth.ts` needed no back-import at all** — nothing below the seam in
`recall-calendar.ts` reads any of it — with one exception that is worth
recording. `clip`, a two-line clipper for a failed response's body, is called
by both halves, and it was already written out by hand a third time in
`recall.ts`. It is now exported from `recall.ts`, which both files already
import and which imports neither, and all three sites call it. That is the
only line changed beyond the move.

Layer: `actor-identity.ts` is a service; `deploy-log.ts` and `google-oauth.ts`
are adapters. Final directory: `ops/` and `meeting/`.

## A8 · the server test split — DONE

| File | Became | Moved | Measured |
|---|---|---|---|
| `test/voice-smooth.test.ts` (729) | `test/voice-smooth-model.test.ts` | nine describes of pure helpers — `navigationAsk`, `resolveByTitle`, `parseOrdinal`, `pickByLabel`, `answerBody`, `statusAsk`, `composeStatus` and the word counters — leaving the route harness that stands up `createServer` | 287, parent at 493 |

One commit, plus this one. Nine describes rather than the eight the plan
counted: `navigationAsk` has two, one for the phrasing and one for the board
qualifier.

The split is what says which LAYER broke when a promise stops holding — a red
model file means the rule is wrong, a red route file over a green model file
means the wiring is. The model half also runs in milliseconds without binding
a port.

**Both halves keep their own copy of the three title fixtures** — the target,
the near-twin that makes "akash review" ambiguous, and the one-word decoy.
That is fixture SHAPE rather than a contract between the halves: the route
file binds them as real documents, the model file ranks them as bare strings,
and neither would notice the other changing a word. Each file's comment now
says which it is. The test count is unchanged, 41 before and 18 + 23 after.

Landing after A6 mattered: `composeStatus` moved to `voice-status.ts` there
and the model half imports it from that file.

---

# Lane B — everything else

## B1 · the hub — **DONE**

Highest churn in the repo after `server.ts`. Nine commits, one per extracted
file, in this order. **Effort M, M, L.**

Landed as ten commits in one PR. What differed from the plan below:

- `hub-model.ts` is gone rather than reduced — the presence half was the
  remainder, so the third cut is a rename. Line counts came out 1397 / 1262 /
  1019 against the estimated 1200 / 1100 / 1200.
- `hub-detail-render.ts` is ~1120 rather than ~900. `assigneePicker` and the
  doc-title hydration helpers had no caller left outside the panel, and
  leaving them behind would have pointed `hub-render.ts` back at the file it
  had just handed work to.
- `hub-live-wiring.ts` is ~280 rather than ~600. The plan counted the loaders
  the listeners call; those stayed in the entry, because the review controller
  and the boot sequence call them too.
- The three `hub-app.ts` files each export a `create*` / `wire*` function
  taking one deps object. The entry destructures the result at the point the
  declarations used to sit, so evaluation order is unchanged and every call
  site — including the ones that pass a verb as a handler value — reads as it
  did.

| File | Becomes (in `hub/`) | Moves |
|---|---|---|
| `hub/hub-model.ts` (3,645) | `hub-board-model.ts` (~1200) | `boardSections`, `boardEffort`, `dropTarget` |
| | `hub-review-model.ts` (~1100) | `reviewQueue`, `decisionQueue`, `advanceWalk` |
| | `hub-presence-model.ts` (~1200) | `presenceChips`, `pluginDriftNotice`, `describeEvent` |
| `hub/hub-render.ts` (2,707) | `hub-detail-render.ts` (~900) | `detailFields`, `effortFields`, `renderRelatedLinks` |
| | `hub-discussion-render.ts` (~650) | `flattenComments`, `discussionStream`, `commentRow` |
| | `hub-review-render.ts` (~500) | `panelReviewQueue`, `panelAnswerRequest`, `reviewItemRow` |
| `hub/hub-app.ts` (3,594) | `hub-actions.ts` (~600) | `transitionTask`, `assignTask`, `placeTask`, `addGoal` |
| | `hub-review-controller.ts` (~700) | `openReviewItem`, `startWalkthrough`, `answerDecision` |
| | `hub-live-wiring.ts` (~600) | the ydoc observers, SSE listeners and catch-up |

The model and render splits are mechanical: those symbols are already
top-level exports with unit tests, and the importers are `hub-app.ts` and the
two hub test files. `hub-app.ts` is not mechanical — `main()` is a ~3,000-line
closure over one `HubState`, and lifting a function out means naming what it
captured. Pass an explicit deps object; that is the work.

Add a tenth commit for the test split: move the last six describes of
`test/hub-render.test.ts` (4,078 lines) — the ones that `readFileSync`
`styles.css` and `hub-app.ts` and assert on source text — into
`test/hub-source-contract.test.ts`. **Effort S.** Those describes are the
reason the file cannot be read as one harness, and they are also the ones
whose paths B2 breaks.

Layers: models, renderers, controllers, in that order. Final directory: `hub/`
throughout — no move needed.

## B2 · `styles.css` — **DONE**

12,042 lines, 158 commits in 90 days. **Effort M.** One PR, two commits.

Landed as planned: `hub.css` (5,364) and `signin.css` (185), leaving
`styles.css` at 6,545. What differed, and what the work found:

- **Link order is load-bearing, and it is not the obvious one.** The hub
  block sat about a twelfth of the way into styles.css, so nearly all of that
  file followed it and won every tie between two rules of equal specificity.
  The board shell therefore loads `hub.css` FIRST. Loading it last flips
  about thirty of those ties — `.acti-pill` starts beating `.comment-pill` at
  430px, a dozen composer surfaces take the board's padding instead of the
  editor's. Loading it first flips exactly one, the back arrow's hover
  colour, which a new `.hub-topbar .back-link:hover` rule now pins so no file
  order decides it. `signin.css` was already at the end, so it loads last.
- **The read-only bar is not sign-in UI.** `.signin-bar`,
  `.signin-bar--floating` and `.signin-required-go` live under the sign-in
  banner but are mounted by the board and the editor, and by no page less
  than /signin. They went out with signin.css, the notice lost every rule it
  had on both other pages, and the render comparison caught it — 1,007
  differing elements. They are back in styles.css under a banner that says
  what they are.

- **`signin.css` stops at the sign-in block's end, not at EOF.** The
  first-arrival identity prompt sits below it and belongs to the board and
  the editor — both bundles reference its four classes, sign-in's references
  none — so it stayed in `styles.css`. That is why the file is 256 rather
  than the estimated ~316.
- **Only two pages get lighter, not three.** The plan's premise was that
  splitting the hub block stops a hub visitor downloading the editor's CSS.
  It does not: the hub block is hub-only, but the hub also reaches design
  tokens, the top bar, voice, the comment pill, the markdown composer, the
  toast, the connection banner, the identity prompt and the utilities — all
  of which stay shared. The editor and sign-in stop downloading the board;
  the board downloads what it always did, in two files.
- **The next cut is measured and named.** Rendering four board views and the
  editor in headless Chrome and asking, per rule, whether it matches anything
  on the page — cross-checked against the class names in each entry bundle —
  puts about **2,459 lines** in blocks the editor alone reaches: main layout,
  the review-set sidebar, the file tree, the reassign menu, code blocks,
  tables, meeting record chrome, the over-doc sheet, the full-screen thread
  view, the code-review and diff-review surfaces, and the inline thread
  cards. Moving those into a `doc.css` would leave a genuinely shared base
  every page keeps loading. That is a third file and a design decision, so
  B2 did not take it.
- **The source-shape ratchet went UP by twelve**, to 79. Twelve suites pin
  rules on both sides of the seam and now read both files. The alternative —
  one loop over a list of filenames — would have hidden those reads from
  `test:audit` rather than removed them.

| Becomes | Moves | Importers to update |
|---|---|---|
| `hub.css` (~5330) | the contiguous hub block, 25 `HUB ·` sub-banners from line 1056, including its own `≤1100px` and `≤720px` breakpoints | `scripts/build.ts` (hashed asset list and the copy step), `core`'s `SHELL_ASSETS`, `renderHubShell` |
| `signin.css` (~316) | the sign-in block from line 11727 to end of file | `scripts/build.ts`, `renderSigninShell` |

**Must land after A1.** The shell renderers that emit the `<link>` tags live
inside `server.ts` today and move to `shells.ts` in A1; landing B2 first would
put a Lane B change into `server.ts`.

Preserve cascade order per page. This is not a line-count split: three pages
with three separate JS bundles all load this one stylesheet, so every hub
visitor currently downloads the editor and diff CSS. It also strengthens the
no-append-at-EOF rule rather than breaking it, because hub and editor branches
stop sharing a file.

Verify at 1180x820 and 430px per `docs/product/design-mobile.md`, and check
that `check:build-id` still moves — a stylesheet split that leaves a page
loading the wrong file will not fail any test.

## B3 · the document surface — **DONE**

Nine commits, not the ten planned. `app.ts` 1,918 → 1,505,
`review-chrome.ts` 1,492 → 1,080, `threads.ts` 1,157 → 418 and
`markup-margin.ts` 996 → 718, across seven new files under `doc/` and two
under `redline/`. Every suite passes and the bundle gained exactly the new
modules and lost none.

What the work turned up:

- **The bundle assertion held, and was worth making.** Comparing the two
  sourcemaps' `sources` arrays across the first commit showed 1,143 modules
  identical and exactly one added. A file-name diff of `dist/` would not have
  shown that: every entry is content-hashed, so the names move whether or not
  the module set does.
- **Two of the three `app.ts` seams were closures, not top-level code**, and
  the difference decides the shape. The format bar came out as plain functions.
  The mode switches had to come out as a controller owning `editMode` and
  `suggesting`, because both are read and written on four paths — otherwise
  the split would have produced two writers for one interlock.
- **A card's state must be read live, never snapshotted.** `renderThread`
  reads which thread is active inside handlers that run when a caret is
  tapped, long after the card was built. The host it now takes exposes every
  field as a call for that reason; a plain object of values would have been
  correct at render time and wrong at tap time, which is the kind of bug that
  survives a green suite.
- **`positionBalloons` and `relayout` did NOT join `balloon-layout.ts`,** and
  the plan was wrong to say they should. That file holds the pure stacking
  algorithm — anchors in, y-positions out, testable without a DOM.
  `positionBalloons` measures four elements' bounding rects and reads the
  margin's private rendered-balloon union; `relayout` calls the deletion
  grouper, the thread filter and the renderer in order and is the margin's
  orchestration point, with eight dependencies for nine lines. Moving either
  would make the algorithm depend on the margin's DOM and on a type the margin
  does not export — the dependency pointing backwards. The margin keeps its
  own geometry; `balloon-cards.ts` and `margin-sheets.ts` still came out.
- **The card builders needed one callback and nothing else** — no view, no
  column, no margin state. That is what lets the same suggestion builder
  render into the phone's bottom sheet, and it is why that cut was cheap while
  the geometry one was not.
- **The test-audit ratchet does not see `.ts` source reads.** Its pattern
  requires the path literal to end in `/src/`, `/dist/`, `.css` or `.js`, so a
  test reading `../src/app.ts` has never been counted. Repointing
  `huddle-entry.test.ts` at two files therefore moved no number. Left alone:
  widening it would add a large backlog of existing sites in a commit that is
  about something else.

## B4 · the meeting strip

| File | Becomes | Moves | Effort |
|---|---|---|---|
| `meeting-strip.ts` (1,953) | `meeting-protocol.ts` (~440) | `rollTranscript`, `diffTurnWords`, `parseMeetingServerMessage`, `meetingSocketUrl` | M |
| | `meeting-chooser.ts` (~350) | `buildChooser`, `buildAdvancedPanel`, `sendTune` | |

Two commits. The socket state machine stays in `meeting-strip.ts`. Note the
name collision: `packages/server/src/meeting-protocol.ts` already exists and
is a different thing — the server's `MeetingRelay`. Two files, one name, in
two packages is survivable but worth a header comment on each saying so.

Layers: transport, then controller. Final directory: `meeting/`.

## B5 · `core` — DONE

Nine extraction commits and a docs commit, in one PR. The plan asked for
seven; the two extra are leaf modules that had to come out first, and both
are the same move `bind-meta.ts` made in A3.

| File | Became | Moved | Measured |
|---|---|---|---|
| `prose.ts` (2,847) | `prose-fragment.ts` | `getProseFragment`, `walkProse`, `TextSegment`, `headingLevelOf`, `preview`, the relative-position resolvers | 188 (not planned) |
| | `prose-markdown.ts` | `parseMarkdownBlocks`, `serializeFragmentToMarkdown`, `applyMarkdownToFragment` and the whole block/inline grammar | 1,183 (est. ~1100) |
| | `prose-edit.ts` | `locateMatches`, `findAndReplace`, `rewriteRange`, `insertAfterRange` and the mark machinery | 857 (est. ~800) |
| | `prose-blocks.ts` | `createAgentAnchor`, `deleteBlocksInRange`, `autoReanchorDoc` and the rest of the anchor and block-deletion API | 712 (est. ~700) |
| `review-item.ts` (1,772) | `review-item-wire.ts` | `readReviewPayload`, `readTaskReviewItem`, `normalizeReviewType`, `foldLegacyBody` | 333 (est. ~250) |
| | `review-item-check.ts` | `REVIEW_LIMITS`, `checkReviewPayload`, `reviewGapAdvice`, `reviewPayloadMessage` | 471 (est. ~400) |
| `goal-effort.ts` (1,086) | `effort-task.ts` | every per-ticket derivation: `estimateNumbers`, `effortClosedAt`, the two actuals, `goalPaceWindowDays` | 361 (not planned) |
| | `effort-calibration.ts` | `computeEffortRatios`, `computeEffortCalibration`, `shrinkEffortRatio`, `quantile`, the priors and the trusted band | 442 (est. ~400) |
| | `effort-format.ts` | `formatEffortSeconds`, `formatGoalEffortSeconds`, `formatEffortDate` | 97 (est. ~70) |

`prose.ts` ends at **83**, `review-item.ts` at **1,030** and `goal-effort.ts`
at **333**. No import line anywhere outside `packages/core/src` changed — the
diff touches twelve files and every one of them is in that directory.

**The hard constraint decided the shape, and it costs an extra file each
time.** `core` is imported by every other package, so `prose.ts` has to
re-export everything it exported as one module. That makes it import the
files it was split into — and any primitive left behind in it would then be
imported BACK by them, which is the cycle A2 and A3 both hit. So the shared
primitives go out first, into a leaf nothing in the family may import:
`prose-fragment.ts` for the fragment walk and the position resolvers, and
`effort-task.ts` for the per-ticket derivations that chunk 3 and chunk 4 both
read. Neither was in the plan and neither was avoidable: `computeEffortCalibration`
calls six of `effort-task.ts`'s functions and `summarizeGoalEffort` calls
seven.

**`prose.ts` is now a surface and nothing else.** Once the primitives left,
there was no remainder — which is the one outcome A3 avoided for `binds.ts`
and the right one here, because the alternative was picking a family to leave
behind and pointing the other three at it. The file is a header naming the
dependency order plus re-exports written out **by name**. Not `export *`:
four private helpers (`preview`, `textContent`, `insertDeltaInto`,
`splitTableRow`) had to be exported from their own modules so their siblings
could reach them, and `export *` would have put all four into the `prose`
namespace, where they have never been. Asserted rather than assumed — 32
runtime exports on `prose.ts` and 32 on `index.ts`'s `prose` object, name for
name identical to the pre-split module, checked after every commit.

**`review-item.ts` keeps its types and hands them back as a type-only
import.** Both extracted files are written in terms of `ReviewPayload` and its
neighbours, and `ReviewPayload` alone is ~147 lines of contract documentation
sitting next to the verbs that implement it. `import type` erases under
`verbatimModuleSyntax`, so at runtime both files are leaves and nothing
imports the file that imports it. The alternative — a third file holding ~600
lines of type declarations — is a bigger change than the split it would
enable.

**The two review-item commits are in the reverse of the plan's order.** The
gate reads a payload with the same two coercions the readers do
(`isPlainObject`, `normalizeReviewType`), so extracting the gate first would
have left it importing them from the file that imports it — a cycle for the
length of one commit. Extracted second, it imports a module that already
exists.

**`formatGoalEffortSeconds` moved with the other two formatters** though the
row names only `formatEffortSeconds` and `formatEffortDate`. It is the coarse
sibling, it calls `formatEffortSeconds`, and it is a second function rather
than a flag precisely because the two roundings answer different questions —
leaving it behind would have split that argument across two files.

**What the row got wrong about the seams was small and in one direction.**
`findAndReplace` reads as a dependency of the block-deletion family in a grep
and is not one: every hit is a doc comment, and the compiler confirmed it by
refusing the import as unused. The same was true of `rewriteRange` and
`insertBlocksAfterAnchor` in each other's headers. Grep over a file this
heavily commented finds the prose, not the calls.

Moved code is byte-identical apart from import headers and added `export`
keywords, verified by diffing each extracted slab against the same line range
of the parent's previous commit. One line differs beyond that:
`insertDeltaInto`'s signature, which biome rewrapped because the `export`
keyword pushed it past the line width.

Layers: document model and domain rules. Final directory: `core/src/` — no
move.

## B6 · `mcp.ts` — the registry and the 94-case dispatch — DONE

5,569 lines before, **1,426 after**. One PR, four commits — the registry,
then one per domain family. **Effort M.**

| Commit | Became | Moved | Measured |
|---|---|---|---|
| 1 | `tool-schemas.ts` | the `ListToolsRequestSchema` handler's table: 94 tool schemas, no logic | 2,012 (est. ~2,045) |
| 2 | `tools/docs.ts` | 52 arms: docs, threads, reviews, suggestions, anchors, watches, shares | 819 (est. ~700–800) |
| 3 | `tools/tasks.ts` | 25 arms: rows, goals, review items, links — and the four helpers only they read | 1,070 (est. ~700–800) |
| 4 | `tools/workspace.ts` | 17 arms: boards, the lead seat, attachments, the operator verbs | 528 (est. ~700–800) |

This is the one place a split created a directory: `packages/mcp/src/tools/`.
Each family is a function taking `(name, args, ctx)` and answering `undefined`
for a name that is not its own, so `mcp.ts` chains the three with `??` and the
last link — `err(\`unknown tool: ${name}\`)` — is where the switch's `default`
went. Dependencies arrive in an explicit context following
`routes/task-routes-context.ts`, because `mcp.ts` connects a stdio transport
at the bottom of the file: importing it back would be an import that runs
that.

`PLUGIN_VERSION` stays defined in `mcp.ts` and reaches `tools/workspace.ts`
through the context rather than being re-spelled. `launcher.test.ts` asserts
it through the built bundle and still passes.

**The estimate for `tools/tasks.ts` was 35% low, and the reason is the one A2
found: helpers follow the verbs.** `TaskPayload`, `taskCreatedSummary`,
`heldResult` and the two review-item lookups have no reader outside the board
arms, so they moved with them — about 140 lines the row did not count.
`tools/workspace.ts` came out under for the opposite reason: its arms are
mostly two-line route calls.

### Deviations

- **The context is built per tool call, not once at module load.** Half of
  what it names — the watch registry and the functions over it — is declared
  BELOW the handler in `mcp.ts`, and a module-level object literal up there
  would read those `const`s inside their temporal dead zone.
- **`RestoreState` moved to `watch-coverage.ts`.** Both readers are now
  outside `mcp.ts` — the restore-notice renderer that was already there, and
  `list_watched_docs` in `tools/docs.ts` — and neither may import an entry
  point. This is the one shared helper the split touched, the way B5's row
  said to record it.
- **Three helpers take the context as a first argument**, because they used to
  close over `http` and `AUTHOR`: `recordReviewAnswer`, `resolveReviewItemId`
  and `setBoardRetired`. Seven call sites gained a `ctx`. These seven lines,
  plus two that biome re-wrapped once the dedent changed what fits on a line,
  are the ONLY moved lines that differ. Everything else is byte-identical,
  verified by diffing each extracted slab against the same line range of the
  parent's previous commit with a two-space dedent.
- **The version WAS bumped, against this row's instruction.** The row said no
  bump because the diff touches no `packages/plugin/**` source — but
  `check-plugin-version.ts` guards the path prefix `packages/plugin/`, and the
  rebuilt bundle `packages/plugin/mcp/index.js` is under it. The gate fails
  the PR without a bump; every prior bundle-rebuilding PR bumped. **B8 rebuilds
  the same bundle and must sequence its own number after this one.**
- **A test harness was added: `test/harness/mcp-source.ts`.** Fourteen tests in
  the package assert on `mcp.ts` as TEXT, because it exports nothing
  importable. Left alone, their `readFileSync` would have silently narrowed
  from "does the server do this?" to "does this one file do this?" — the
  failure a split is most likely to cause and least likely to announce. They
  now read the five files joined in source order.
- **`tool-wiring.test.ts` reads `case` at four spaces or six.** Four is inside
  a domain function, six was inside the request handler while the dispatch
  spanned both. A bounded range rather than `\s+`, so a `case` nested deeper
  cannot pass for a tool.
- **All three `tools/` files are over 500 lines and have exception rows.** The
  plan predicted 700–800 each and did not say what that meant for the audit.
  Each is one dispatch family over one shared context; the length is a count
  of tools, not of coupling.

Layer: HTTP client / tool surface. Final directory: `mcp/src/` — no move.

## B7 · `widget.ts` — DONE

1,320 lines before, **598 after**. One PR, three commits. **Effort M**,
because methods had to become functions taking the element.

| Becomes | Moves | Measured |
|---|---|---|
| `widget-auth.ts` | `loadStoredAuth`, `authedPost`, `composerSignIn` and the rest of the popup-token handshake | 284 (est. ~230) |
| `widget-picker.ts` | `enterFeedbackMode`, `hitTest`, `openComposerForElement` | 232 (est. ~200) |
| `widget-threads.ts` | `renderThreads`, `positionPins`, `showThreadPopover` | 297 (est. ~290) |

The three estimates were close and the one that missed did so for the reason
A2 found: a verb is not separable from the state it reads. `widget-auth.ts`
came out 54 over because `httpBase`, `serverOrigin`, `setAuth`, `clearAuth`,
`startSignIn`, `updateAuthUi` and `requireSignIn` all had to move with the
three named methods — they are the same handshake, and leaving any of them
behind would have made the parent import a value from the file that imports
it.

**`TAG` and `IGNORE_ATTR` moved to `widget-picker.ts` for the same reason,
and `isInOwnChrome` went with them.** Both constants answer one question in
two directions: `hitTest` asks whether a pointer landed on the widget's own
chrome, `isInOwnChrome` asks whether a mutation record came from it. The
parent imports all three names back, as `tasks.ts` does in A2.

**The element keeps a `renderThreads()` method** forwarding into
`widget-threads.ts`. "Everything stays reachable from the custom element" is
not decoration here — the panel test drives a synchronous render by calling
it rather than waiting on the rAF, and it was the one thing in the suite that
noticed the split.

**Bundle: 40,935 bytes gzipped before, 40,898 after, against a 40,960 budget.
The split BOUGHT headroom rather than spending it** — the file started 25
bytes under the limit. Top-level functions minify to one-letter names where
class methods have to keep their property names, so moving nine methods out
of the class more than paid for the import headers. Verified by content, not
by exit code: `showThreadPopoverForThread`, `openComposerForElement` and
`validateStoredAuth` shipped verbatim in the old bundle (2, 2 and 3
occurrences) and are absent from the new one, while `cfw:authToken`,
`claude-feedback-widget` and `About this page` — one literal from each new
module — appear once in both.

## B8 · `agent-notes.ts`

653 lines in `packages/plugin/hooks/lib/`. **Effort S.** One PR, one commit.

| Becomes | Moves |
|---|---|
| `note-redact.ts` (~390) | `stripInline`, `redactOpaque`, `isSecretName`, `reduceProseLine`, `commandShape`, `looksOpaque` |

`readAgentName`, `decideTurnNote`, `postNote` and `runHook` stay. Both files
stay inside `packages/plugin` — the hooks run from the installed plugin
directory and cannot import across the monorepo.

The diff touches `packages/plugin/**`, so **bump the patch version in all
three places**: `packages/plugin/.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, and `PLUGIN_VERSION` in
`packages/mcp/src/mcp.ts`. Sequence this against B6, which rebuilds the same
bundle.

---

# Group F — directory moves (optional, last)

These realise the layer directories from [overview.md](overview.md) for files
that are **not** on the split list. Nothing depends on them. Each is a
`git mv` plus a path rewrite, and the cost below is the number of import lines
in `src` and `test` that name a file in the set.

| # | Directory | Files | Import lines |
|---|---|---|---|
| F1 | `server/src/board/` | the `task-*` family, `tasks.ts`, `keep-moving.ts`, `stall-*.ts`, `ready-*.ts`, `review-queue.ts`, `review-judge.ts`, `review-archive.ts`, `effort-estimator.ts`, `dispatch-registry.ts` | 250 |
| F2 | `server/src/meeting/` | `meeting-*.ts`, `meetings.ts`, `recall*.ts`, `transcribe*.ts`, `attach-notes.ts`, `assemblyai-retention.ts` | 114 |
| F3 | `server/src/docs/` | `rooms.ts`, `binds.ts`, `doc-*.ts`, `sse*.ts`, `yjs-protocol.ts`, `room-timings.ts`, `diff-groups.ts`, `git-diff.ts`, `fs-scan.ts` | 93 |
| F4 | `server/src/ops/` | `deploy*.ts`, `client-release.ts`, `plugin-*.ts`, `uptime.ts`, `log-*.ts`, `push-*.ts`, `sentry.ts`, `browser-sentry.ts` | 59 |
| F5 | `server/src/config/` | `data-dir.ts`, `public-host.ts`, `port-bind.ts`, `safe-path.ts`, `allow-rules.ts`, `private-meta.ts` | 16 |
| F6 | `server/src/voice/` | `voice.ts`, `voice-resolve.ts` and their split output | 11 |
| F7 | `markdown-app/src/doc/` | `app.ts`, `editor.ts`, `review-chrome.ts`, `threads.ts`, `thread-*.ts`, `review-*.ts`, `preview.ts`, `edit-*.ts` | 85 |
| F8 | `markdown-app/src/meeting/` | `meeting-*.ts`, `speaker-*.ts` | 34 |

Take them one directory per PR, smallest first, and run all four gates on each
— an import rewrite is exactly the change that type-checks clean in one
package and breaks another. `review-items/`, `routes/`, `share/`, `auth/`,
`middleware/`, `hub/`, `redline/`, `code/` and `signin/` already sit where
they belong and are not in this group.

---

# Findings against `exceptions.md`

The audit was taken at `3a39db67`; this plan was checked at `3e18e542`. Every
`Split` verdict holds — each named function exists, at roughly the line the
row claims, and none of the 33 turned out to be a single cohesive file. Three
things worth recording, none of which changes a verdict:

- **The line numbers have drifted and will keep drifting.** `server.ts` is
  10,827 lines against the recorded 10,794, `tasks.ts` 6,915 against 6,880,
  `rooms.ts` 6,314 against 6,301, and `createServer` starts at 1,168 rather
  than 1,158. Read the row for the seam it names, not the range.
- **`reclaimAfterInPlaceEdit` is not adjacent to the other two ownership
  functions.** It sits at line 1,020 of `meeting-notes-merge.ts`, below
  `mergeNotesSection`, while `createNotesOwnership` and `classifyOwnership`
  are at 261 and 289. The seam is still right; the extraction is two hunks,
  not one.
- **`exceptions.md` misses one HTML renderer.** The `server.ts` row names four
  for `shells.ts`; there is a fifth, `renderSigninShell`, exported at line
  10,180 and called at 9,427. It is the sign-in page's shell, it is what B2's
  `signin.css` link tag lives in, and leaving it behind would split the shell
  family across two files. Added to A1 above; the row in `exceptions.md` is
  left as written, since the verdict and the seam are both still right.
- **`meeting-protocol.ts` would exist twice** once B4 lands — once in
  `packages/server/src` for `MeetingRelay`, once in
  `packages/markdown-app/src` for the strip's parsers. Different packages, so
  it compiles, but each needs a header comment naming the other.
