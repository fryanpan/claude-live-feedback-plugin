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

## A1 · `server.ts` — the route chain and the HTML shells

10,827 lines. One PR, alone, five commits — one per extracted family, in the
order they appear in the chain. **Effort L.**

| Commit | Becomes | Moves | Importers |
|---|---|---|---|
| 1 | `routes/auth-share.ts` (~640) | the sign-in, session and share-link routes | none — chained by `??` from `createServer` |
| 2 | `routes/docs.ts` (~570) | the doc, thread and bind routes | none |
| 3 | `routes/meetings-calendar.ts` (~1300) | the meeting, transcript and calendar routes | none |
| 4 | `routes/ops.ts` (~260) | deploy, plugin-refresh, uptime and release routes | none |
| 5 | `shells.ts` (~1640) | `renderHubShell`, `renderSigninShell`, `renderLanding`, `renderProjectPage`, `serveStatic` | `renderHubShell` and `renderSigninShell` are already exported and used by the tests |

Each handler takes an explicit context object, following
`routes/task-routes-context.ts` — do not capture the `createServer` closure.
Preserve the matching order exactly; the chain is walked top to bottom and a
route that moves can start answering a path that reached a different one.
`routes/workspaces.ts` documents why it needs four entry points, and the same
will be true here.

Layer: HTTP. Final directory: `routes/` and `server/src/` respectively.

## A2 · the board stores

| File | Becomes | Moves | Importers | Effort |
|---|---|---|---|---|
| `tasks.ts` (6,915) | `task-agents.ts` (~1300) | `attachAgent`, `heartbeat`, `leadSeatHealth`, `queueComment` | none — `TaskStore` delegates | L |
| | `task-goals.ts` (~1000) | `setGoalList`, `renameGoal`, `reorderGoals`, `setTaskGoal` | none | |
| | `workspace-store.ts` (~700) | `createWorkspace`, `renameWorkspace`, `setLeadAgent` | none | |
| `task-projection.ts` (1,035) | `task-row.ts` (~250) | `projectTask` | `review-queue.ts`, `share/redact-hub-events.ts`, `review-items/derive.ts`, plus four test files | S |

Three commits for `tasks.ts`, one for `task-projection.ts`. `tasks.ts` has 35
importing files, so the class must keep its public surface: each extraction
declares the narrow persistence interface it actually needs, the way
`review-items/store.ts` declares its nine members, and `TaskStore` forwards.
The owner readers `ownerKindReader` and `claimSessionReader` belong beside the
existing `task-owner.ts` rather than in `task-row.ts`.

Layer: services, with `task-row.ts` in domain. Final directory: `board/`.

## A3 · the doc stores

| File | Becomes | Moves | Importers | Effort |
|---|---|---|---|---|
| `rooms.ts` (6,314) | `doc-edit-ops.ts` (~1000) | `setDocContent`, `findAndReplace`, `createSuggestion`, `deleteSection` | none — `Rooms` delegates | L |
| | `doc-threads.ts` (~1200) | `postComment`, `resolve`, `reanchor`, `listThreads` | none | |
| | `rooms-workspaces.ts` (~1100) | `buildWorkspaceTree`, `archiveReview`, `attachFile` | none | |
| `binds.ts` (986) | `bind-diff.ts` (~350) | `bindDiff` and its browse and working-tree modes | `server.ts` import line only | M |
| | `workspace-refresh.ts` (~350) | `refreshWorkspace`, `setWorkspaceGroups`, `refreshDiffMeta`, `writeMeta` | `server.ts` import line only | |

Five commits. The room lifecycle — `getOrCreate`, `evictIdleRooms`, `flush`
and the file bindings — stays in `rooms.ts`; it is what the three extractions
are operations on. `refreshWorkspace` must keep the explicit-wins precedence
rule: a group-less refresh once overwrote agent-supplied groups because
"refresh derived fields" treated them as derived.

Layer: services. Final directory: `docs/`.

## A4 · boot and composition

| File | Becomes | Moves | Importers | Effort |
|---|---|---|---|---|
| `bin.ts` (1,013) | `server-config.ts` (~350) | environment resolution into one typed config | none — `bin.ts` is an entry point with no importers | M |
| | `server-deps.ts` (~350) | the "the ONLY place a real X is constructed" seams | none | |

Two commits. This is the composition root the layer rule depends on: after it,
"reads env" and "constructs a real adapter" are two named files rather than
two thirds of a script. Arg parsing, `acquirePort` and the startup banner stay
in `bin.ts` (~300).

Layer: entry. Final directory: `config/` for `server-config.ts`;
`server-deps.ts` and `bin.ts` stay at `server/src/`.

## A5 · the meeting family

| File | Becomes | Moves | Importers | Effort |
|---|---|---|---|---|
| `meeting-task-capture.ts` (1,348) | `meeting-capture-prompt.ts` (~380) | `buildTaskCapturePrompt`, `parseTaskCaptureReply`, the `*_PROMPT_RULE` constants | tests | M |
| | `meeting-capture-guards.ts` (~200) | `tickMentionsCandidate`, `phraseSpokenOnTick`, `captureWindow` | tests | |
| `meeting-notes-merge.ts` (1,067) | `notes-ownership.ts` (~250) | `createNotesOwnership`, `classifyOwnership`, `reclaimAfterInPlaceEdit` | `meeting-notes.ts`, tests | M |
| | `notes-section.ts` (~250) | `findNotesSection`, `itemsOfMarkdown`, `readNotesSection` | `meeting-notes-doc.ts`, tests | |
| `meeting-notes.ts` (1,039) | `pause-ticker.ts` (~190) | `createPauseTicker`, `TickScheduler`, `realTickScheduler` | tests use `ManualScheduler` against this contract | S |
| `meeting-notes-doc.ts` (986) | `notes-section-write.ts` (~470) | `replaceNotesSection`, `retagSpeakerInNotes`, `reattributeNotesSection`, `demoteBodyHeadings` | tests | S |

Seven commits. `reclaimAfterInPlaceEdit` sits at the bottom of
`meeting-notes-merge.ts`, below `mergeNotesSection`, not with the other two
ownership functions — move all three regardless; they answer one question.
`pause-ticker.ts` is the two-clock detector and knows nothing about notes,
which is the point: read
[meeting-assistant.md](meeting-assistant.md) before touching the clock.

Layer: `pause-ticker.ts`, the guards and the prompt builders are domain; the
rest stay services. Final directory: `meeting/`.

## A6 · voice and the review queue

| File | Becomes | Moves | Importers | Effort |
|---|---|---|---|---|
| `voice.ts` (2,109) | `voice-prompt.ts` (~450) | `buildVoicePrompt`, `parseVoiceReply`, `renderResourceBlock` | tests | S |
| | `voice-action.ts` (~350) | `VOICE_ACTIONS`, `resolveVoiceAction` | `voice-actions.test.ts` | |
| `voice-resolve.ts` (762) | `voice-status.ts` (~190) | `composeStatus`, `ago`, `quote`, `listTitles`, `capWords` | `voice.ts`, `voice-smooth.test.ts` | S |
| `review-queue.ts` (831) | `ask-detection.ts` (~250) | `asksPerson`, `findAsk`, `extractAsk`, `sentenceQuestion`, `codeSpans`, `stripEmphasis` | `review-migration.ts`, `review-queue.test.ts` | S |

Four commits. The ask detector and its extractor must keep sharing one
address pattern — they drifted apart once, and the drift clipped the very
question the feature existed to surface. One matcher, used by both.

Layer: domain, except `VoiceRouter` which stays a service. Final directory:
`voice/` for the three voice files, `board/` for `ask-detection.ts`.

## A7 · the operational adapters

| File | Becomes | Moves | Importers | Effort |
|---|---|---|---|---|
| `activity.ts` (582) | `actor-identity.ts` (~240) | `registerOwnerIdentity`, `linkIdentity`, `setIdentityRoster`, `resolveActor`, `classifyActor` and their `reset*` seams | 14 source files and 11 test files — the largest importer set in the plan | M |
| `deploy.ts` (1,058) | `deploy-log.ts` (~250) | `writeDeployLog`, `readDeployLog`, `confirmDeployBoot`, `spawnDeployVerifier` | `bin.ts` import line | S |
| `recall-calendar.ts` (721) | `google-oauth.ts` (~190) | `resolveGoogleOauthCreds`, `createGoogleOauthApp`, `createKeychainRefreshTokenVault`, `readKeychainAccount` | `bin.ts` and `server.ts` import lines | S |

Three commits. `activity.ts` is a process-wide registry, so the extraction
must not create a second module-level state: `actor-identity.ts` owns the maps
and `activity.ts` imports them, never the reverse. Do the import rewrite with
a single mechanical pass and let the type checker find the misses.

Layer: `actor-identity.ts` is a service; `deploy-log.ts` and `google-oauth.ts`
are infra. Final directory: `ops/` and `meeting/`.

## A8 · the server test split

| File | Becomes | Moves | Effort |
|---|---|---|---|
| `test/voice-smooth.test.ts` (729) | `test/voice-smooth-model.test.ts` | the eight describes of pure helpers — `navigationAsk`, `resolveByTitle`, `parseOrdinal`, `composeStatus` — leaving the route harness that stands up `createServer` | M |

One commit. **Must land after A6**, because `composeStatus` moves to
`voice-status.ts` there and this file imports it. Stage the new file before
trusting `bun run test:audit`: an untracked test file is invisible to it and
CI is not.

---

# Lane B — everything else

## B1 · the hub

Highest churn in the repo after `server.ts`. Nine commits, one per extracted
file, in this order. **Effort M, M, L.**

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

## B2 · `styles.css`

12,042 lines, 158 commits in 90 days. **Effort M.** One PR, two commits.

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

## B3 · the document surface

| File | Becomes | Moves | Effort |
|---|---|---|---|
| `app.ts` (1,918) | `editor-toolbar.ts` (~250) | `wireFormatBar`, `wireTableMenu`, `applyWidthPref` — already top-level at 1698–1918 with no importers outside `app.ts` | M |
| | `doc-modes.ts` (~250) | the VIEW/EDIT and SUGGESTING blocks | |
| | `doc-meeting-mount.ts` (~200) | the meeting mount block | |
| `review-chrome.ts` (1,492) | `review-composer.ts` (~330) | `openComposer`, `renderThreadView`, `submitThreadReply` | M |
| | `chrome-panels.ts` (~140) | `wireThreadRangeClicks` and the resizable side panels | |
| | `chrome-dom.ts` (~110) | `el`, `showToast`, `makeBtn` | |
| `threads.ts` (1,157) | `thread-card.ts` (~700) | `renderThread`, `decisionRow`, `itemCard`, `answeredRecord` | M |
| `redline/markup-margin.ts` (996) | `redline/balloon-cards.ts` (~250) | `buildSuggestionBalloon`, `buildDelBalloon`, `addCollapseButton` | M |
| | into the existing `redline/balloon-layout.ts` (~250) | `positionBalloons`, `relayout`, `restackThroughMorph` | |
| | `redline/margin-sheets.ts` (~85) | `mountDeletionSheet`, `mountSuggestionSheet` | |

Ten commits. `renderThread` is already consumed standalone by the balloon
column through `ThreadPanel.renderThread`, which is the seam; panel state
(`setThreads`, `setActive`, `filtered`, `revealThread`) stays. The
`markup-margin.ts` pieces are methods of a 730-line closure, so each becomes a
function taking the elements it needs.

Every seam here moves symbols within one entry's import graph, so the shipped
bundles are unchanged. Assert that: `check:build-id` should move because bytes
moved, and no bundle should gain or lose a module.

Layers: controllers and renderers. Final directory: `doc/` for the `app.ts`
and `review-chrome.ts` output, `redline/` already correct.

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

## B5 · `core`

| File | Becomes | Moves | Importers | Effort |
|---|---|---|---|---|
| `prose.ts` (2,847) | `prose-markdown.ts` (~1100) | `parseMarkdownBlocks`, `serializeFragmentToMarkdown`, `applyMarkdownToFragment` | re-export from `prose.ts`; `rooms.ts` calls these through `prose.` | M |
| | `prose-edit.ts` (~800) | `locateMatches`, `findAndReplace`, `rewriteRange` | same | |
| | `prose-blocks.ts` (~700) | `createAgentAnchor`, `deleteBlocksInRange`, `autoReanchorDoc` | same | |
| `review-item.ts` (1,769) | `review-item-check.ts` (~400) | `REVIEW_LIMITS`, `checkReviewPayload`, `reviewGapAdvice` | `core/index.ts` re-export | S |
| | `review-item-wire.ts` (~250) | `readReviewPayload`, `readTaskReviewItem` | same | |
| `goal-effort.ts` (1,086) | `effort-calibration.ts` (~400) | `computeEffortRatios`, `computeEffortCalibration`, `shrinkEffortRatio`, `quantile` | same | S |
| | `effort-format.ts` (~70) | `formatEffortSeconds`, `formatEffortDate` | same | |

Seven commits. `core` is imported by every other package, so keep
`core/src/index.ts` and the `prose` namespace object exporting exactly what
they export today. If a consumer's import line has to change, the split is
wrong. `goal-effort.ts` names its own chunks in its header, so use those
names; the doc comments explaining the priors stay with the arithmetic and are
what [goal-projection.md](goal-projection.md) points at.

Layers: document model and domain rules. Final directory: `core/src/` — no
move.

## B6 · `mcp.ts`

5,563 lines, 155 commits. **Effort M.** One PR, four commits.

| Commit | Becomes | Moves |
|---|---|---|
| 1 | `tool-schemas.ts` (~2045) | the `ListToolsRequestSchema` handler: a declarative array of 94 tool schemas with no logic |
| 2–4 | `tools/docs.ts`, `tools/tasks.ts`, `tools/workspace.ts` (~700–800 each) | the `CallToolRequestSchema` switch, split by domain the way `routes/` was |

This is the one place a split creates a directory: `packages/mcp/src/tools/`.
The dispatch is a 94-case switch, and three files of one shape each read
better than three more siblings in a flat directory of 20.

`PLUGIN_VERSION` must stay reachable from `mcp.ts` — it is the handshake
literal, and `launcher.test.ts` asserts it only after `bun run build:mcp`. The
diff touches `packages/mcp/src/**`, so run `bun run build:mcp` and commit
`packages/plugin/mcp/index.js`. It does **not** touch `packages/plugin/**`
source, so no version bump. Verify by grepping the rebuilt bundle for a
literal from the change plus a negative control — a green build step can still
ship nothing.

## B7 · `widget.ts`

1,320 lines. **Effort M**, because methods must become functions taking the
element. One PR, three commits.

| Becomes | Moves |
|---|---|
| `widget-auth.ts` (~230) | `loadStoredAuth`, `authedPost`, `composerSignIn` |
| `widget-picker.ts` (~200) | `enterFeedbackMode`, `hitTest`, `openComposerForElement` |
| `widget-threads.ts` (~290) | `renderThreads`, `positionPins`, `showThreadPopover` |

Everything stays reachable from the custom element, so the shipped bundle is
unchanged — but run `bun run build:widget && bun run check:widget-size` and
report the number in the PR body. The budget is 40 KB gzipped and it is a hard
constraint.

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
