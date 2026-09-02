# Files over 500 lines

The bar: **every file over 500 lines has either been broken up, or has an
explicit exception written here.** This page is the record of that decision, one
row per file. `bun run loc:audit` fails when a file crosses the limit without a
row, and CI runs it alongside the other gates.

A `Split` verdict names a seam — which functions become which new file — and is
work that is queued, not done. The audit does not enforce verdicts, only that
every oversized file has one: a listed `Split` passes. The point of the gate is
that a **new** god file cannot appear with nobody writing down why.

Regenerate the raw list with:

```bash
find packages \( -name '*.ts' -o -name '*.css' \) \
  -not -path '*/node_modules/*' -not -path '*/dist/*' \
  | xargs wc -l | awk '$1>500' | sort -rn
```

Audited 2026-09-02 at `3a39db67`, and re-audited after A1 landed. **153 files**
over 500 lines: 58 source and 95 test. **34 Split**, **119 Exception**.

Test files are judged by a narrower rule, in their own table below: a long test
file is an exception unless two *unrelated harnesses* share it. Many `describe`
blocks over one set of fixtures is one harness, however long the file gets.

---

## packages/server

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/server/src/server.ts` | 7131 | Split | A1 took five families out (see below); what is left is `createServer` itself — the closure that builds every collaborator and the request wrapper that walks the chain. The next seam is the composition, not the routes: A4 moves env resolution and adapter construction to `server-config.ts` / `server-deps.ts`, after which the remaining route blocks (agents, chat-audit, reviews, workspaces-resource, static and page routes) are extractable the same way the five were. **L** |
| `packages/server/src/routes/docs.ts` | 1972 | Split | Extracted whole from `server.ts` in A1 and deliberately not re-cut on the way out: the move was verified by keeping every route byte-identical and in order, and re-cutting in the same PR would have destroyed that property. The seam is already visible — three exported entry points, one per chain position — and the third, `handleDocResourceRoutes` (the `/api/docs/:id/...` block, ~1,200 lines), splits along `rest ===` families into `doc-resource.ts`, `doc-threads-routes.ts` and `doc-edit-routes.ts` the way `routes/tasks.ts` split into six. **M** |
| `packages/server/src/shells.ts` | 930 | Exception | One job: the HTML this server renders before any bundle runs. Every shell is a complete document with its own `<style>`, which is the point — nothing here may depend on an asset that has not loaded. Splitting per page would separate each shell from the `escape` / `landingShell` / `HTML_SHELL_HEADERS` trio all five share, and the file has no logic to test apart from the strings. |
| `packages/server/src/routes/auth-share.ts` | 781 | Exception | Two families that look separable and are not: the share routes' refusals are stated in terms of the session the auth routes mint, and the order between them is behaviour (the browser-write refusal sits above every share route so a mint added later is covered by construction). A split would need the boundary written down in two headers instead of one, and the chain position asserted twice. |
| `packages/server/src/routes/meetings-calendar.ts` | 562 | Exception | Just over the line, and one chain position: every `/api/docs/<id>/meetings...` pattern must be tried before the doc catch-all. Splitting meetings from calendar would make that one ordering constraint span two files for 62 lines of relief. |
| `packages/server/src/tasks.ts` | 6880 | Split | `class TaskStore` runs 2255–6880 over four responsibilities; `review-items/` is the in-file precedent that extraction works. Agent presence and delivery queues (`attachAgent`, `heartbeat`, `leadSeatHealth`, `queueComment`) → `task-agents.ts` ~1300; goal-list machinery (`setGoalList`, `renameGoal`, `reorderGoals`, `setTaskGoal`) → `task-goals.ts` ~1000; the workspace registry (`createWorkspace`, `renameWorkspace`, `setLeadAgent`) → `workspace-store.ts` ~700. **L** |
| `packages/server/src/rooms.ts` | 6301 | Split | `class Rooms` is 641–6227 and mixes three jobs behind one `this`. Document mutation (`setDocContent`, `findAndReplace`, `createSuggestion`, `deleteSection`) → `doc-edit-ops.ts` ~1000; comments and threads (`postComment`, `resolve`, `reanchor`, `listThreads`) → `doc-threads.ts` ~1200; the workspace/bind/archive surface (`buildWorkspaceTree`, `archiveReview`, `attachFile`) → `rooms-workspaces.ts` ~1100. The room lifecycle (`getOrCreate`, `evictIdleRooms`, `flush`) stays. **L** |
| `packages/server/src/voice.ts` | 2109 | Split | Two free-function groups sit above `VoiceRouter` with explicit args and no shared state: prompt building and reply parsing (`buildVoicePrompt`, `parseVoiceReply`, `renderResourceBlock`) → `voice-prompt.ts` ~450, and the write guardrail (`VOICE_ACTIONS`, `resolveVoiceAction`) → `voice-action.ts` ~350. **S** |
| `packages/server/src/meeting-task-capture.ts` | 1348 | Split | Three responsibilities. The LLM contract (`buildTaskCapturePrompt`, `parseTaskCaptureReply`, the `*_PROMPT_RULE` constants) → `meeting-capture-prompt.ts` ~380; the transcript guards (`tickMentionsCandidate`, `phraseSpokenOnTick`, `captureWindow`) → `meeting-capture-guards.ts` ~200; `runTaskCapture` and the extractor stay ~600. **M** |
| `packages/server/src/meeting-notes-merge.ts` | 1067 | Split | Ownership (`createNotesOwnership`, `classifyOwnership`, `reclaimAfterInPlaceEdit`) → `notes-ownership.ts` ~250 and section reading (`findNotesSection`, `itemsOfMarkdown`, `readNotesSection`) → `notes-section.ts` ~250 are each answerable without the merge; `planNotesMerge` / `mergeNotesSection` stay ~550. **M** |
| `packages/server/src/deploy.ts` | 1058 | Split | The durable trace already has its own banner at line 668: `writeDeployLog`, `readDeployLog`, `confirmDeployBoot`, `spawnDeployVerifier` touch only the filesystem and the clock, never git or launchd → `deploy-log.ts` ~250, leaving the decision (`decideDeploy`) and the executor (`runDeploy`, `launchctlRestart`) ~800. **S** |
| `packages/server/src/meeting-notes.ts` | 1039 | Split | `createPauseTicker` with `TickScheduler` / `realTickScheduler` (lines 84–277) is a two-clock detector that knows nothing about notes → `pause-ticker.ts` ~190. `beginNotesSession` and the compose/correction contracts stay ~800. **S** |
| `packages/server/src/task-projection.ts` | 1035 | Split | `projectTask` (265–417) is the pure Task→board-row projection with no `Rooms` dependency, and the owner readers (`ownerKindReader`, `claimSessionReader`) belong beside the existing `task-owner.ts`. Extract `task-row.ts` ~250, leaving the room lifecycle (`ensureWorkspace`, `refresh`, `scheduleSnapshot`) ~650. **S** |
| `packages/server/src/bin.ts` | 1013 | Split | Two thirds is env resolution plus the "the ONLY place a real X is constructed" seams for a dozen subsystems. Split into `server-config.ts` (env → one typed config, ~350) and `server-deps.ts` (config → the network-touching seams, ~350), leaving arg parsing, `acquirePort` and the startup banner ~300. **M** |
| `packages/server/src/meeting-notes-doc.ts` | 986 | Split | Clean halves at line 586. Yjs section surgery (`replaceNotesSection`, `retagSpeakerInNotes`, `reattributeNotesSection`, `demoteBodyHeadings`) → `notes-section-write.ts` ~470; the server glue (`NotesLedger`, `applyNotesUpdate`, `withServerNotesSinks`) stays ~400. **S** |
| `packages/server/src/binds.ts` | 986 | Split | The header claims folder and diff share one skeleton, but `bindFolder` is ~50 lines against `bindDiff`'s 285 with its own browse and working-tree modes → `bind-diff.ts` ~350. Post-bind maintenance (`refreshWorkspace`, `setWorkspaceGroups`, `refreshDiffMeta`, `writeMeta`) is a third job → `workspace-refresh.ts` ~350. **M** |
| `packages/server/src/stall-nudge.ts` | 867 | Exception | One `StallNudger`: the tick, the arming stamps, and addressing. The held-item nudge (`nudgeFilers`) reuses the same tick, `reachable`, and stamp file, so lifting it out would duplicate all three. |
| `packages/server/src/ready-nudge.ts` | 843 | Exception | One `ReadyWorkNudger`. Most of the file is the not-sending rules (`armed`, `NudgeTally`) that only make sense against the frame they suppress. |
| `packages/server/src/review-queue.ts` | 831 | Split | Two jobs. `asksPerson` / `findAsk` / `extractAsk` with `sentenceQuestion`, `codeSpans` and `stripEmphasis` (~250) is a pure text predicate with no queue concept → `ask-detection.ts`; `reviewThreadItems` / `taskReviewItems` / `reviewItemRows` stay ~580. **S** |
| `packages/server/src/voice-resolve.ts` | 762 | Split | Resolution and composition are unrelated. `composeStatus` with `ago`, `quote`, `listTitles` and `capWords` (~190) writes the spoken status answer → `voice-status.ts`; `tokenize` / `rankTitles` / `resolveByTitle` / `navigationAsk` stay as the utterance resolver ~570. **S** |
| `packages/server/src/middleware/host-guard.ts` | 756 | Exception | One question — may this request proceed on this host. `collabScope` deliberately answers through `shareScopeAllows` rather than a second allowlist, because the allowlist that drifts open is the breach; `classifyHost` and the scope check are two halves of one decision. |
| `packages/server/src/home-brief.ts` | 743 | Exception | One feature end to end: `HomeBriefStore` plus the pure pipeline `briefEvents` → `deterministicBrief` / `buildBriefPrompt` → `acceptBrief`. The network half already lives in `ThreadSummarizer`. |
| `packages/server/src/transcribe-assemblyai.ts` | 735 | Exception | One protocol client end to end: `streamingUrl` builds the v3 session and `createAssemblyAiEngine` speaks the Begin/Turn/Termination sequence; `expiryFrom` and `resolveAssemblyAiKey` serve only that socket. |
| `packages/server/src/recall-calendar.ts` | 721 | Split | Two vendors in one file. `resolveGoogleOauthCreds`, `createGoogleOauthApp`, `createKeychainRefreshTokenVault` and `readKeychainAccount` (~190) are the Google OAuth and token-vault concern → `google-oauth.ts`; `createRecallCalendarClient`, `CalendarConnectionStore` and `CalendarSyncConsumer` stay ~530. **S** |
| `packages/server/src/meeting-protocol.ts` | 655 | Exception | One class, `MeetingRelay`. The `/audio/<docId>` socket *is* the meeting lifecycle, so open, frames, and every ending path have to sit together to end it exactly once. |
| `packages/server/src/recall.ts` | 599 | Exception | One vendor client: `recallConfigFromEnv`, `buildCreateBotBody`, `createRecallClient`. The callback-URL helpers exist only because Recall dials us back. |
| `packages/server/src/client-release.ts` | 593 | Exception | One lifecycle for the numbered release directory: `publishClientRelease`, `currentClientRelease`, `readPublishLedger`, and `prepareClientRelease` — which is the decision the other three exist to make. |
| `packages/server/src/activity.ts` | 582 | Split | Two jobs sharing a file. The process-wide actor registry (`registerOwnerIdentity`, `linkIdentity`, `setIdentityRoster`, `resolveActor`, `classifyActor` and their `reset*` seams, ~240) → `actor-identity.ts`; the append-only event schema (`eventId`, `payloadDigest`, `buildEventDoc`, `appendActivity`) stays ~340. **M** — `classifyActor` has importers outside this file. |
| `packages/server/src/recall-meeting.ts` | 572 | Exception | One class, `RecallMeetingRelay`: invite, webhook status, and the dialled transcript socket are three channels of one bot lifecycle. |
| `packages/server/src/sse.ts` | 566 | Exception | One fan-out. `SseHub` holds `byDoc` and the bounded `replay`; `openSseStream` is the socket that consumes both, including the `replay.gap` path. |
| `packages/server/src/identities.ts` | 557 | Exception | One store — the `Identities` class over `identities.json` — plus its sanitizer and the single projection `userForIdentity`. |
| `packages/server/src/summarize.ts` | 549 | Exception | One outbound-API owner, `ThreadSummarizer`. `generate`, `generateHomeBrief` and `backfill` share the key resolution, `post`, and the debounce maps that stop three browsers paying three times. |
| `packages/server/src/meetings.ts` | 516 | Exception | One durable record: the append-only transcript and index paths, the `listMeetings` / `readTranscript` folds over them, and `MeetingStore` as the live handle on the same files. |

## packages/markdown-app

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/markdown-app/src/styles.css` | 12042 | Split | Not a line-count split. `renderHubShell`, `renderSigninShell` and the review `index.html` are three pages with three separate JS bundles that all load this one stylesheet, so every hub visitor downloads the editor and diff CSS. The hub block is contiguous and self-labelled — 25 `HUB ·` sub-banners from 958 to 6287, with its own breakpoints — and the sign-in block runs 11727–EOF. Cut `hub.css` ~5330 and `signin.css` ~316. **M**, cascade order preserved per page. This strengthens the no-EOF-append rule rather than breaking it: hub and editor branches stop sharing a file. |
| `packages/markdown-app/src/hub/hub-board-model.ts` | 1397 | Exception | One model, the board itself: what a row is (`HubTask`, `ownerKind`, `statusLabel`), which section it lands in (`taskVisible`, `boardSections`, `goalSection`), how much work a goal has left (`boardEffort`, `goalEffortLabel`) and where a drag drops it (`dropTarget`, `stepTarget`). Split out of `hub-model.ts` (B1). Cutting it further would separate a row's shape from the ordering rule that reads it, which is the pair `byBoardOrder` exists to keep in one place. |
| `packages/markdown-app/src/hub/hub-review-model.ts` | 1262 | Exception | One queue end to end: what a review item is, the ranking that puts everything waiting on a person into one list (`reviewQueue`, `decisionQueue`, `humanBlockerRows`), the walkthrough that walks it (`advanceWalk`, `walkHandoff`), and the wording each row and card wears (`reviewHeadline`, `askedMeta`). Split out of `hub-model.ts` (B1). The ranking and the wording are asserted against each other — a row's title is derived from the same ask the rank reads — so a further cut would need both halves imported back. |
| `packages/markdown-app/src/hub/hub-presence-model.ts` | 1019 | Exception | One strip of chrome fed by one clock: who is here (`presenceChips`, `leadSeatLabel`), what is running (`pluginDriftNotice`, `clientDriftNotice`, `uptimeSummary`), what has happened (`describeEvent`, `activityRows`) and where the hub is standing (`navFromPath`, `homeSinceLabel`). The remainder of `hub-model.ts` after B1's other two cuts. `timeAgo` dates a presence chip, a release and a trail row alike, so a further cut would put that one clock behind an import in three places. |
| `packages/markdown-app/src/hub/hub-actions.ts` | 640 | Exception | Every REST write the board performs, bound once to an explicit `HubActionDeps` instead of captured from `main()`'s closure, plus `HubState` — the projection those writes mutate — and the three primitives every verb ends in (`send`, `fetchJson`, `showToast`). Split out of `hub-app.ts` (B1). Splitting the verbs from the state they write, or from the toast that reports a refusal, would put the blast radius back behind an import. |
| `packages/markdown-app/src/hub/hub-app.ts` | 2538 | Exception | The hub's entry: it builds the shell, holds `main()`'s one `HubState`, and owns the renders and the address bar. B1 lifted the REST writes to `hub-actions.ts`, the review queue's controller to `hub-review-controller.ts` and the live path to `hub-live-wiring.ts`, each behind a named deps object. What is left is the render layer and the boot sequence, which share `state` and every `render*` closure by construction — a further cut would pass the whole closure as an argument and call it a seam. |
| `packages/markdown-app/src/hub/hub-detail-render.ts` | 1145 | Exception | One panel: who has the task (`assigneePicker`), what it says (`detailFields`, `bodySlot`), what it cost (`effortFields`, `effortComputationLines`), what it points at (`renderTaskLinks`, `renderRelatedLinks`) and what happened to it (`activityRow`, `renderTransitionRow`). Split out of `hub-render.ts` (B1). Larger than the plan's ~900 estimate because the doc-title hydration helpers and `assigneePicker` came with it — both are used only by this panel, and leaving them behind would have pointed `hub-render.ts` back at this file. |
| `packages/markdown-app/src/hub/hub-render.ts` | 770 | Exception | The hub's shell chrome after B1: the topbar, the lead-agent strip, the archived list, the goal detail panel, the quick actions, the review banner, the Home brief and the activity view. Eight small regions that share the shell's own idioms and nothing else; the three regions with a vocabulary of their own are now `hub-detail-render.ts`, `hub-discussion-render.ts` and `hub-review-render.ts`. |
| `packages/markdown-app/src/meeting-strip.ts` | 1953 | Split | The DOM-free protocol layer above `mountMeetingStrip` (`rollTranscript`, `diffTurnWords`, `parseMeetingServerMessage`, `meetingSocketUrl`) → `meeting-protocol.ts` ~440 is a clean lift; the start-chooser popover (`buildChooser`, `buildAdvancedPanel`, `sendTune`) → `meeting-chooser.ts` ~350 is a second, leaving the socket state machine. **M** |
| `packages/markdown-app/src/app.ts` | 1918 | Split | `mountMarkdown()` runs 190–1639 with its own banners. The formatting group is already top-level and self-contained (`wireFormatBar`, `wireTableMenu`, `applyWidthPref`, 1680–1918) → `editor-toolbar.ts` ~250; the VIEW/EDIT and SUGGESTING banners (1504–1618) → `doc-modes.ts` ~250; the meeting mount block (456–560) → `doc-meeting-mount.ts` ~200. **M** |
| `packages/markdown-app/src/review-chrome.ts` | 1492 | Split | `mountReviewChrome` carries three things its own banners already separate: the composer and full-screen thread view (`openComposer`, `renderThreadView`, `submitThreadReply`) → `review-composer.ts` ~330; the panel chrome (`wireThreadRangeClicks`, the resizable side panels at 1307) → `chrome-panels.ts` ~140; the shared DOM helpers fenced at 1388 (`el`, `showToast`, `makeBtn`) → `chrome-dom.ts` ~110. **M** |
| `packages/markdown-app/src/threads.ts` | 1157 | Split | Lines 436–1157 are card rendering (`renderThread`, `decisionRow`, `itemCard`, `answeredRecord`), already consumed standalone by the balloon column through `ThreadPanel.renderThread`, and a separate job from panel state (`setThreads`, `setActive`, `filtered`, `revealThread`). Extract `thread-card.ts` ~700. **M** |
| `packages/markdown-app/src/redline/markup-margin.ts` | 996 | Split | `mountMarkupMargin` is one 730-line closure with three jobs: balloon builders (`buildSuggestionBalloon`, `buildDelBalloon`, `addCollapseButton`) → `balloon-cards.ts` ~250; geometry (`positionBalloons`, `relayout`, `restackThroughMorph`) joins the existing `balloon-layout.ts` ~250; mobile sheets (`mountDeletionSheet`, `mountSuggestionSheet`) → `margin-sheets.ts` ~85. **M** |
| `packages/markdown-app/src/voice-capture.ts` | 705 | Exception | One gesture controller: `createVoiceCapture` and the hold rules (`SPACE_HOLD_ARM_MS`, `spaceHoldTargetsPage`) plus the messages that hold produces. All of it is the hold-to-talk surface. |
| `packages/markdown-app/src/diff-nav.ts` | 598 | Exception | One sidebar renderer with two views sharing the toggle, `viewKey` and `diffNavSignature`. The all-files half is ~110 lines and cannot be understood apart from the toggle that selects it. |
| `packages/markdown-app/src/meeting-advanced.ts` | 581 | Exception | One panel. The `AdvancedControl` descriptors exist only to drive `buildAdvancedSection`, and the canonical specs already live in core's `meeting-tuning.ts`. |
| `packages/markdown-app/src/code/code-editor.ts` | 550 | Exception | One CodeMirror surface: `createCodeEditor` returning `CodeSurface`, with the gutter and decoration internals that only that editor instantiates. |
| `packages/markdown-app/src/suggest-input.ts` | 510 | Exception | One ProseMirror plugin. `SuggestInput` and the handlers it installs all mutate the same `suggestInputKey` state. |

Every markdown-app seam above moves symbols within one entry's import graph, so
the shipped bundle is unchanged.

## packages/core

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/core/src/prose.ts` | 2847 | Split | Markdown⇄Yjs conversion (`parseMarkdownBlocks`, `serializeFragmentToMarkdown`, `applyMarkdownToFragment`) → `prose-markdown.ts` ~1100; find/replace and range editing (`locateMatches`, `findAndReplace`, `rewriteRange`) → `prose-edit.ts` ~800; the anchor and block-deletion API already fenced by its own banner at 2540 (`createAgentAnchor`, `deleteBlocksInRange`, `autoReanchorDoc`) → `prose-blocks.ts` ~700. **M** |
| `packages/core/src/review-item.ts` | 1769 | Split | Pure and import-free apart from `wordCount`, so the seams are cheap: input validation and its limits (`REVIEW_LIMITS`, `checkReviewPayload`, `reviewGapAdvice`) → `review-item-check.ts` ~400 and the wire readers (`readReviewPayload`, `readTaskReviewItem`) → `review-item-wire.ts` ~250, leaving the payload lifecycle (`applyReviewRevision`, `withdrawReview`, `reviewItemState`). **S** |
| `packages/core/src/goal-effort.ts` | 1086 | Split | Its own header names the chunks. Calibration (`computeEffortRatios`, `computeEffortCalibration`, `shrinkEffortRatio`, `quantile`) → `effort-calibration.ts` ~400; display (`formatEffortSeconds`, `formatEffortDate`) → `effort-format.ts` ~70; the rollup `summarizeGoalEffort` and the per-task derivations stay ~600. **S** |
| `packages/core/src/task-wire.ts` | 759 | Exception | One wire contract, all data: `Task` alone is ~415 documented lines, plus `TASK_STATUSES`, `Ref`, `ArtifactCheck` and the single `byBoardOrder`. Splitting it would put one row's shape in two files, which is the drift the file exists to prevent. |
| `packages/core/src/speaker-tags.ts` | 619 | Exception | One tag format end to end: `speakerTagHref` and `parseSpeakerTagHref` define it, and `findSpeakerTags` / `normalizeSpeakerTags` / `reattributeSpeakerTags` are the operations on it over a shared `SpeakerTagMatch`. |
| `packages/core/src/suggest-ops.ts` | 572 | Exception | One registry and its mutations over a Y.Doc: `scanSuggestions` builds the read model that `acceptSuggestion` / `rejectSuggestion` / `resolveAllSuggestions` then act on, all through the shared `resolveOne`. |
| `packages/core/src/types.ts` | 558 | Exception | One cohesive type registry — `DocType`, `DocMeta`, the `Anchor` union, `Thread` / `Comment`, `WebhookPayload` — with a single function, `contentKind`, which is the table the rest branch on. |

## packages/mcp

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/mcp/src/mcp.ts` | 5563 | Split | Two things bolted together at line 2396. The `ListToolsRequestSchema` handler (351–2395) is a declarative array of 94 tool schemas with no logic; the `CallToolRequestSchema` handler is a 94-case dispatch switch. Move the registry verbatim to `tool-schemas.ts` ~2045 — that piece genuinely is one cohesive table, it just does not belong beside the dispatcher — then split the switch by domain the way `routes/` did (~700–800 each). `PLUGIN_VERSION` must stay reachable from `mcp.ts`. **M** |
| `packages/mcp/src/nudge-line.ts` | 510 | Exception | One responsibility, the wording of the hub's wake events. `readyIdleLine`, `stalledLine`, `reviewItemHeldLine` and `reviewAnsweredLine` share `truncate` and `humanDuration`, and the point is that the wording is asserted in one place. |

## packages/widget

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/widget/src/widget.ts` | 1320 | Split | `FeedbackWidgetEl` holds three unrelated method clusters: auth and session (`loadStoredAuth`, `authedPost`, `composerSignIn`) ~230 → `widget-auth.ts`; element picking and the composer (`enterFeedbackMode`, `hitTest`, `openComposerForElement`) ~200 → `widget-picker.ts`; thread render, pins and popover (`renderThreads`, `positionPins`, `showThreadPopover`) ~290 → `widget-threads.ts`. The shipped bundle is unchanged — every piece stays reachable from the custom element. **M**, since methods must become functions taking the element. |

## packages/plugin

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/plugin/hooks/lib/agent-notes.ts` | 653 | Split | The redaction engine and the hook plumbing are separable. `stripInline`, `redactOpaque`, `isSecretName`, `reduceProseLine`, `commandShape`, `looksOpaque` (~390) → `note-redact.ts`; `readAgentName`, `decideTurnNote`, `postNote`, `runHook` (~260) stay. Both stay inside `packages/plugin` — no monorepo imports. **S** |

---

## Test files

95 test files exceed 500 lines. Two hold two unrelated harnesses; the other 93
are exceptions, listed after them. The recurring shape across the exceptions is
one feature tested at two or three *layers* — pure predicate, then store, then
real HTTP route — sharing the same fixture builders. That is one harness.

| File | Lines | Verdict | Reason / seam |
|---|---|---|---|
| `packages/markdown-app/test/hub-render.test.ts` | 3882 | Exception | Twelve describes over one harness: the module-scope `task()` factory and the `root` beforeEach, asserting rendered DOM. The six that `readFileSync` `styles.css` and hub source and assert on text moved to `hub-source-contract.test.ts` in B1 — they were the second harness this row named. |
| `packages/server/test/voice-smooth.test.ts` | 729 | Split | Lines 55–293 are eight describes of pure helpers (`navigationAsk`, `resolveByTitle`, `parseOrdinal`, `composeStatus`) with no server at all, while `voice, smoothly (route)` stands up `createServer` in its own `beforeAll`. Move the eight helper describes to `voice-smooth-model.test.ts`. **M** |

The remaining 93 are exceptions. Each row names the one harness its cases share.

| File | Lines | Reason |
|---|---|---|
| `packages/markdown-app/test/hub-model.test.ts` | 2331 | All describes are pure model functions fed by the one module-scope `task()` factory. |
| `packages/markdown-app/test/meeting-strip.test.ts` | 2102 | The four parser describes are the strip's own helpers; the other 18 go through `mount()` with `FakeSocket` / `FakeBot`. |
| `packages/server/test/meeting-notes.test.ts` | 2045 | Every describe drives the notes pipeline off the module-scope `ManualScheduler`. |
| `packages/markdown-app/test/markup-margin.test.ts` | 1670 | All 17 describes mount through `mountSurface` / `mountMargin` and share the `afterEach` teardown list. |
| `packages/core/test/prose.test.ts` | 1645 | Every describe seeds a `Y.XmlFragment` via `seedDoc()` and its two anchor helpers. |
| `packages/markdown-app/test/review-walkthrough.test.ts` | 1544 | All describes build fixtures with `task()` / `threadItem()` and render through `renderHomeReview` against the shared `root`. |
| `packages/server/test/review-item-gate.test.ts` | 1480 | A single top-level describe over one real server and the SSE `listenFrames` harness. |
| `packages/core/src/review-item.test.ts` | 1399 | All 22 describes exercise the review-item payload vocabulary off the `decision()` / `review()` builders. |
| `packages/server/test/review-queue.test.ts` | 1377 | Every describe feeds `comment()` / `thread()` fixtures into the queue functions. |
| `packages/server/test/meeting-task-capture.test.ts` | 1376 | All describes share `boardStub()` / `extractorOf()` and drive one capture pipeline. |
| `packages/core/src/goal-effort.test.ts` | 1322 | Every describe builds effort inputs with `ok()` / `task()` / `closed()` / `identity()`. |
| `packages/server/test/host-guard.test.ts` | 1301 | 16 describes, all pure predicates over the one module-scope `LOCAL` host fixture. |
| `packages/server/test/task-routes.test.ts` | 1185 | One top-level describe; every nested suite uses the same `beforeAll` server and tmpdir. |
| `packages/server/test/meeting-notes-doc.test.ts` | 1149 | All describes build a Y.Doc via `docFrom()` and read it back with `markdownOf()`. |
| `packages/server/test/host-scope.test.ts` | 992 | Both describes stand up the real route table over `makeMockCfApi()` — one guard, two share modes. |
| `packages/server/test/server.test.ts` | 990 | Each describe builds the same tmpdir and `createServer` handle; the `decideReconcile` suite is a helper of that code path. |
| `packages/server/test/voice.test.ts` | 960 | A single describe over one real server with an injected `complete`. |
| `packages/server/test/workspace-lead.test.ts` | 947 | Every describe constructs a `TaskStore`, or a server over one, for the same lead-seat contract. |
| `packages/server/test/review-item-routes.test.ts` | 943 | The module-scope `handle` / `base` server plus `mkdoc()` / `seedThread()` feed all nine describes. |
| `packages/markdown-app/test/voice-capture.test.ts` | 939 | The four pure describes are helpers of the same capture module; the rest share `FakeRecognition` and `holdSpace()`. |
| `packages/server/test/ready-nudge-routes.test.ts` | 932 | A single describe over one real board, stream, and the `listenFrames` / `waitForFrames` harness. |
| `packages/server/test/ready-nudge.test.ts` | 917 | All describes run the nudger through the module-scope `board()` and `harness()` fake world. |
| `packages/server/test/task-tool-routes.test.ts` | 899 | One describe, one `beforeAll` server, four routes. |
| `packages/server/test/stall-nudge.test.ts` | 890 | All describes drive the stall pass through `board()` and `harness()`. |
| `packages/server/test/transcribe-assemblyai.test.ts` | 880 | Every describe runs the mapping over the module-scope `FakeSocket` and `harness()`. |
| `packages/server/test/mcp-durable-watches.test.ts` | 856 | All three describes spawn the shipped MCP bundle through the `McpChild` class against a real server. |
| `packages/server/test/review-item-comments.test.ts` | 847 | A single describe over one real server. |
| `packages/server/test/attachments.test.ts` | 831 | Pure, store and route describes all exercise one `AgentAttachment` record shape with shared `readAudit` / `listen` helpers. |
| `packages/server/test/deploy-runner.test.ts` | 790 | Every describe builds deps via `fakeGit()` / `deps()` / `fakeWait()`. |
| `packages/server/test/meeting-notes-merge.test.ts` | 789 | All describes build a doc with `docFrom()` and edit it with the shared `typeBullet` / `editBullet` helpers. |
| `packages/markdown-app/test/thread-card.test.ts` | 784 | Nine describes, all through `mountPanel()` and `makeThread()`. |
| `packages/server/test/hub-share.test.ts` | 778 | A single describe over one server with `connectDoc` / `readSseUntil` helpers. |
| `packages/server/test/summarize.test.ts` | 776 | Every describe injects `fakeFetch()` into a `ThreadSummarizer` over `thread()` fixtures. |
| `packages/mcp/test/review-item-tools.test.ts` | 774 | All describes speak JSON-RPC to the one spawned bundle child via `call()` / `last()`. |
| `packages/markdown-app/test/thread-morph.test.ts` | 752 | Every describe mounts via `mountCard()` and inspects `recordAnimations()`. |
| `packages/server/test/bind-diff.test.ts` | 744 | Both describes build the same `makeFixtureRepo()` git fixture; `makeRooms` extends it rather than replacing it. |
| `packages/server/test/goal-ids.test.ts` | 739 | Every describe seeds a `TaskStore`, or a server over one, for the same goal-id contract. |
| `packages/server/test/link-share.test.ts` | 735 | One describe, one `beforeAll` server, nested share-mode suites. |
| `packages/server/test/meeting-socket.test.ts` | 717 | Seven describes, each a real server plus the shared `AudioClient` class, varying only engine config. |
| `packages/server/test/goal-reorder.test.ts` | 692 | Store and route describes both seed goals with `bands()` / `seededGoalList()`. |
| `packages/server/test/stall-nudge-routes.test.ts` | 689 | A single describe over one real board plus `listenFrames` / `waitForFrames`. |
| `packages/server/test/home-brief.test.ts` | 687 | Every describe feeds `ev()` / `input()` rows into the brief pipeline, store included. |
| `packages/plugin/test/agent-notes.test.ts` | 681 | All describes drive the one pure hook module with `fakeFetch()` / `sentBody()`. |
| `packages/server/test/sse-replay.test.ts` | 660 | Every describe exercises an `SseHub` stream through the shared `listenFrames()` and `settle()`. |
| `packages/server/test/refresh-workspace.test.ts` | 658 | All three describes build a `Rooms` through the module-scope `makeRooms(dataDir)` and `git()` helpers. |
| `packages/server/test/auth-write-gate.test.ts` | 656 | Every case, HTTP and y-sync socket alike, boots through the one `boot(requireSignInToWrite)` harness. |
| `packages/server/test/voice-hardening.test.ts` | 646 | The prompt, resolver and handle describes share the file's `PERSON` / `AGENT` / `INJECTION` fixtures with the one end-to-end describe. |
| `packages/server/test/decision-routes.test.ts` | 636 | One describe with one `beforeAll` server; every assertion reads an effect back over the same REST base. |
| `packages/markdown-app/test/hub-detail-css.test.ts` | 632 | Every describe parses the same `CSS` string through the shared `rule()` / `media()` helpers. |
| `packages/server/test/task-import.test.ts` | 629 | The parser describes and the route describe both exercise `parseTrackerMarkdown` on the same synthetic tracker fixture. |
| `packages/server/test/goal-rename.test.ts` | 627 | Store and route describes share the `bands()` / `boardFor()` goal-id fixture builders. |
| `packages/server/test/sentry-server.test.ts` | 617 | All describes drive `src/sentry.ts` against the module-scope `startCaptureServer()` harness. |
| `packages/server/test/agent-watches.test.ts` | 615 | Store and route describes share the `AgentWatches` data-dir fixture. |
| `packages/server/test/comment-durability.test.ts` | 610 | Both describes use the shared `listenFrames()` / `settle()` SSE harness against the agent comment queue. |
| `packages/markdown-app/test/plan-gate.test.ts` | 605 | One describe on `mountPlanGate` over the shared `root` / `stubFetch` / `stubTimers` seam. |
| `packages/server/test/parallelism-cap.test.ts` | 601 | Both describes assert the same workspace cap through the shared frame harness. |
| `packages/server/test/owner-kind.test.ts` | 599 | The pure `resolveOwnerKind` tables and the HTTP describes are two declared layers of one decision over shared fixtures. |
| `packages/core/test/thread-summary.test.ts` | 599 | Every describe builds its subject with the module-scope `makeThread()` ydoc builder. |
| `packages/server/test/meeting-e2e.test.ts` | 588 | One describe over the `ManualScheduler` / `AudioClient` / `waitFor` harness. |
| `packages/server/test/doc-eviction.test.ts` | 587 | Both describes drive the same injected-clock Rooms eviction fixture and the shared `onDisk()` reader. |
| `packages/server/test/collab-host.test.ts` | 582 | All three describes depend on the module-scope `jwks` / `signJwt` `beforeAll` and boot the same server shape. |
| `packages/server/test/task-review-queue.test.ts` | 581 | Module-scope `handle` / `base` plus `seedWorkspace` / `seedDecision` feed every describe. |
| `packages/server/test/task-review-item-routes.test.ts` | 579 | A single describe and one `beforeAll` server; every case is a write route read back over HTTP. |
| `packages/core/test/summary-generated.test.ts` | 578 | All describes are pure summary-module functions over the shared `thread()` builder. |
| `packages/server/test/agent-coverage.test.ts` | 573 | One top-level describe around the watch-coverage route; the nested block reuses the same server fixture. |
| `packages/server/test/meetings.test.ts` | 571 | Four describes, each constructing the same `MeetingStore`-on-disk fixture in an identical `beforeAll`. |
| `packages/core/test/suggest-ops.test.ts` | 571 | Every describe builds a Y.Doc with `docFrom()` and reads it back with `serialize()`. |
| `packages/server/test/recall-meeting.test.ts` | 559 | One describe over the `FakeRecall` / `ManualScheduler` / `transcriptFrame()` vendor harness. |
| `packages/mcp/test/nudge-line.test.ts` | 559 | All describes call the pure `*Line()` renderers with inline row literals; no setup exists to be disjoint. |
| `packages/widget/test/widget-auth.test.ts` | 550 | Every describe runs against the module-scope `stubGlobals()` / `importWidget()` widget harness. |
| `packages/markdown-app/test/thread-modal.test.ts` | 549 | All describes mount through the shared `mount()` harness and its `comment()` / `thread()` builders. |
| `packages/server/test/proxied-trusted-host.test.ts` | 547 | All describes depend on the module-scope `jwks` / `signJwt` `beforeAll` and the shared `get()` helper. |
| `packages/server/test/task-review-items.test.ts` | 545 | A single describe over one `TaskStore` fixture and the shared `payload()` builder. |
| `packages/server/test/grouping-share-removed.test.ts` | 545 | One describe using the shared `makeMockCfApi()` Cloudflare stub and one server. |
| `packages/server/test/meeting-notes-correction.test.ts` | 543 | Predicate describes and the real notes-doc describes all build their subject with `docFrom()` / `NOTES()`. |
| `packages/server/test/recall-callback-gate-http.test.ts` | 542 | Every describe uses the module-scope `spinUp()` / `callback()` / `signBody()` two-hostname harness. |
| `packages/server/test/stall-gate.test.ts` | 538 | Every describe calls the module-scope `evaluate()` over rows from `task()`; no server anywhere. |
| `packages/markdown-app/test/goal-actions.test.ts` | 537 | Pure model describes and DOM-panel describes share `task()` / `handlers()` / `sectionOf()` for one feature. |
| `packages/markdown-app/test/activity-model.test.ts` | 536 | All describes are pure Home-activity functions over the shared `task()` / `note()` / `groups()` builders. |
| `packages/server/test/share-grouping-scope.test.ts` | 533 | One describe over the shared `connectDoc()` / `git()` fixture and a single `beforeAll` server. |
| `packages/markdown-app/test/thread-modal-chrome.test.ts` | 529 | Every describe mounts the review chrome via `harness()` on the same `mountChromeDom()` / `fakeSurface()` base. |
| `packages/server/test/voice-actions.test.ts` | 525 | One describe, one `beforeAll` server; all cases route spoken verbs through it. |
| `packages/server/test/projection.test.ts` | 525 | One describe over the shared `connectDoc()` / `listen()` / `auditLines()` Yjs-client harness. |
| `packages/server/test/artifact-check.test.ts` | 522 | Classifier, store and server-wiring describes are the layers of one check and share `prRef` / `fetchStub`. |
| `packages/server/test/git-ops-vs-bound.test.ts` | 521 | Both describes build a real git repo with the shared `git()` / `cleanEnv()` helpers; `classifyExternalContent` is the bound-doc path's own classifier, not a foreign subsystem. |
| `packages/server/test/tasks.test.ts` | 519 | `TaskStore` and the small `Ref` describe share the one store and dataDir fixture. |
| `packages/server/test/effort-estimate-gate.test.ts` | 519 | A single describe with one stub-estimator server fixture. |
| `packages/server/test/cross-origin-routes.test.ts` | 517 | Both describes stand up a real server and probe it from the module-scope `EVIL` origin for the `CANARY` body; the trusted host and the public share host are two modes of one guard, not two harnesses. |
| `packages/server/test/sync-clobber.test.ts` | 517 | Both describes exercise the same write-back clobber path over the shared `makeRooms()` / `writeExternal()` fixtures, one directly and one over HTTP. |
| `packages/markdown-app/test/mobile-review.test.ts` | 512 | Every describe uses the shared `harness()` mount plus `comment()` / `thread()` / `orphanThread()`. |
| `packages/server/test/home-routes.test.ts` | 506 | All four describes construct their server via the one `makeHarness(summarizer?)` factory. |
| `packages/markdown-app/test/write-gate.test.ts` | 503 | Every describe uses the module-scope `beforeEach` DOM reset with `docShell()` / `hubShell()`. |
| `packages/server/test/dispatch-routes.test.ts` | 502 | One describe over the shared `listenFrames` / `waitForFrames` fake-watcher server harness. |

---

## Split queue

Ordered by how much a split reduces the chance that an ordinary PR lands in a
god file: commits over the last 90 days first, size second. Churn is the column
that matters — `recall-calendar.ts` has a clean seam and one commit in three
months, so splitting it buys almost nothing.

| # | File | Lines | Commits (90d) | Size |
|---|---|---|---|---|
| 1 | `packages/server/src/server.ts` | 7131 | 233 | L |
| 2 | `packages/markdown-app/src/styles.css` | 12042 | 158 | M |
| 3 | `packages/mcp/src/mcp.ts` | 5563 | 156 | M |
| 4 | `packages/markdown-app/src/hub/hub-app.ts` | 3594 | 102 | L |
| 5 | `packages/markdown-app/src/hub/hub-render.ts` | 2707 | 95 | M |
| 6 | `hub-board-model.ts` + `hub-review-model.ts` + `hub-presence-model.ts` (was `hub-model.ts`, split in B1) | 3645 | 89 | M |
| 7 | `packages/server/src/tasks.ts` | 6880 | 87 | L |
| 8 | `packages/server/src/rooms.ts` | 6301 | 71 | L |
| 9 | `packages/markdown-app/src/app.ts` | 1918 | 55 | M |
| 10 | `packages/server/src/bin.ts` | 1013 | 50 | M |
| 11 | `packages/server/src/task-projection.ts` | 1035 | 43 | S |
| 12 | `packages/markdown-app/src/review-chrome.ts` | 1492 | 24 | M |
| 13 | `packages/markdown-app/src/threads.ts` | 1157 | 20 | M |
| 14 | `packages/markdown-app/src/meeting-strip.ts` | 1953 | 18 | M |
| 15 | `packages/core/src/review-item.ts` | 1769 | 18 | S |
| 16 | `packages/core/src/prose.ts` | 2847 | 16 | M |
| 17 | `packages/server/src/review-queue.ts` | 831 | 15 | S |
| 18 | `packages/widget/src/widget.ts` | 1320 | 13 | M |
| 19 | `packages/server/src/meeting-notes.ts` | 1039 | 12 | S |
| 20 | `packages/server/src/voice.ts` | 2109 | 11 | S |
| 21 | `packages/server/src/meeting-notes-doc.ts` | 986 | 11 | S |
| 22 | `packages/server/src/activity.ts` | 582 | 11 | M |
| 23 | `packages/server/src/binds.ts` | 986 | 9 | M |
| 24 | `packages/markdown-app/src/redline/markup-margin.ts` | 996 | 9 | M |
| 25 | `packages/server/src/meeting-task-capture.ts` | 1348 | 6 | M |
| 26 | `packages/server/src/meeting-notes-merge.ts` | 1067 | 5 | M |
| 27 | `packages/server/src/deploy.ts` | 1058 | 4 | S |
| 28 | `packages/core/src/goal-effort.ts` | 1086 | 4 | S |
| 29 | `packages/server/src/voice-resolve.ts` | 762 | 2 | S |
| 30 | `packages/plugin/hooks/lib/agent-notes.ts` | 653 | 2 | S |
| 31 | `packages/server/src/recall-calendar.ts` | 721 | 1 | S |
| 32 | `packages/markdown-app/test/hub-render.test.ts` | 4078 | — | S |
| 33 | `packages/server/test/voice-smooth.test.ts` | 729 | — | M |

The top eight are where the pain is: they carry 991 of the 1350 commits in this
queue. Rows 1 through 8 are worth filing as tickets now; below row 20 a split is
tidiness, and is best done by whoever is already editing the file.
