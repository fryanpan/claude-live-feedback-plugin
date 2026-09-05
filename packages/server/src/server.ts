import { join } from 'node:path';
import {
  type DocType,
  type Thread,
  type User,
  type WebhookPayload,
  agentIdForName,
  attachmentIdOf,
  contentKind,
} from '@feedback/core';
import { createAccessDeps } from './access-deps.ts';
import { releaseActivityLock } from './activity-lock.ts';
import { AgentNoteRing } from './agent-notes.ts';
import { AgentWatches } from './agent-watches.ts';
import { AllowRuleProposals } from './allow-rules.ts';
import { ARTIFACT_CHECK_ACTOR, ArtifactChecker } from './artifact-check.ts';
import { backfillAttachmentFiling } from './attachment-backfill.ts';
import {
  createLegacyAgentWarner,
  agentTokenKey as deriveAgentTokenKey,
} from './auth/agent-token.ts';
import { DEFAULT_BOARD_WORKSPACE_NAME, createBoardMembership } from './board-membership.ts';
import { type BrowserSentryConfig } from './browser-sentry.ts';
import { ChatAudit } from './chat-audit.ts';
import { maybeCompress, maybeNotModified } from './compress.ts';
import { DispatchRegistry } from './dispatch-registry.ts';
import { DocStore } from './doc-store.ts';
import { createEffortScoring } from './effort-scoring.ts';
import { taskDeepLink } from './home-brief.ts';
import { createHomePane } from './home-pane.ts';
import { spokenReviewComment } from './huddle.ts';
import { Identities } from './identities.ts';
import { createIdentitySetup } from './identity-setup.ts';
import { type LookupDoc, boardLookupDocs } from './meeting-lookup.ts';
import { withServerNotesSinks } from './meeting-notes-doc.ts';
import { MeetingRelay } from './meeting-protocol.ts';
import { MEETING_CAPTURE_ACTOR } from './meeting-task-capture.ts';
import { MeetingStore } from './meetings.ts';
import { isAllowedBrowserOrigin } from './middleware/browser-origin.ts';
import { isGatedWrite, signInRequiredBody } from './middleware/write-gate.ts';
import { spokenLinkRef } from './notes-link-intent.ts';
import {
  PARK_MIGRATION_ACTOR,
  type ParkMigrationResult,
  migrateParkedRows,
} from './park-migration.ts';
import { parkNoteText } from './park-note.ts';
import { publicBaseUrl } from './public-host.ts';
import { createPushAnnounce } from './push-announce.ts';
import type { NudgeTally } from './ready-nudge.ts';
import { CalendarConnectionStore, CalendarSyncConsumer } from './recall-calendar.ts';
import { RecallMeetingRelay } from './recall-meeting.ts';
import { unreachableCallbackReason } from './recall.ts';
import { scanSettledDocRefs } from './refs-backfill.ts';
import { createOriginPolicy, createRequestAdmission } from './request-admission.ts';
import { createRequestAttribution } from './request-attribution.ts';
import { listArchivedReviews, readDocArchiveManifest } from './review-archive.ts';
import { createReviewGate } from './review-gate.ts';
import type { ReviewThreadItem } from './review-queue.ts';
import {
  type AgentIdentityRoutesContext,
  handleAgentIdentityRoutes,
} from './routes/agent-identity.ts';
import { type ArchiveRoutesContext, createArchiveRoutes } from './routes/archive.ts';
import { type AuthShareRoutesContext, handleAuthShareRoutes } from './routes/auth-share.ts';
import { type ChatAuditRoutesContext, handleChatAuditRoutes } from './routes/chat-audit-routes.ts';
import type { DocRoutesContext } from './routes/docs-routes-context.ts';
import {
  handleDocCreateListRoutes,
  handleDocPromoteRoute,
  handleDocResourceRoutes,
} from './routes/docs.ts';
import {
  type MeetingCalendarRoutesContext,
  handleMeetingCalendarRoutes,
} from './routes/meetings-calendar.ts';
import {
  type OpsRoutesContext,
  handleOpsMetricsRoute,
  handleOpsRoutes,
  handleSummaryBackfillRoute,
  handleWebhookLogRoute,
} from './routes/ops.ts';
import {
  type RecallWebhookRoutesContext,
  handleRecallWebhookRoute,
} from './routes/recall-webhook.ts';
import { type ReviewFileRoutesContext, handleReviewFileRoutes } from './routes/review-files.ts';
import { createShellStatic } from './routes/shell-static.ts';
import {
  type TaskRoutesContext,
  handleDispatchAndNoteRoutes,
  handleTaskRoutes,
} from './routes/tasks.ts';
import { createUpgradeStream } from './routes/upgrade-stream.ts';
import {
  type WorkspaceRoutesContext,
  handleWorkspaceAttachmentRoutes,
  handleWorkspaceDeleteRoute,
  handleWorkspaceGoalRoutes,
  handleWorkspaceRoutes,
} from './routes/workspaces.ts';
import { captureServerError, routePatternForSpan, withRouteSpan } from './sentry.ts';
import type { ServerOptions } from './server-options.ts';
import { Shares } from './share/shares.ts';
import { SharingGate } from './share/sharing-gate.ts';
import { type UpgradeData, createSocketHandlers } from './socket-handlers.ts';
import { claimReplayMarks, saveReplayMarks } from './sse-marks.ts';
import { HTTP_IDLE_TIMEOUT_SEC, SseBus } from './sse.ts';
import { createStallWiring } from './stall-wiring.ts';
import { TaskProjection, taskBodyDocId } from './task-projection.ts';
import { type FiredOccurrence, createTaskScheduler } from './task-scheduler.ts';
import {
  DEFAULT_PARALLELISM_CAP,
  type ParallelismCapChange,
  type Task,
  TaskStore,
} from './tasks.ts';
import { ThreadRequestDedup } from './thread-request-dedup.ts';
import type { TranscriptionEngine } from './transcribe.ts';
import { UptimeMonitor } from './uptime.ts';
import { VoiceRouter } from './voice.ts';
import { type WebhookLogEntry, createWebhookDispatcher } from './webhooks.ts';

const DEFAULT_PORT = Number(process.env.PORT ?? 8787);

/** Attribution for a write that arrived with no author at all. Deliberately
 *  NOT Bryan: an unattributed action must never gain his authority just
 *  because a field was missing. */

const ANONYMOUS_ACTOR: User = {
  id: 'anon-unattributed',
  name: 'Anonymous',
  kind: 'anon',
  color: '#8a8a8a',
};

import { BOARD_FEEDBACK_DOC_ID } from './doc-ids.ts';
import {
  HTML_SHELL_HEADERS,
  appCacheControl,
  readAppAssetManifest,
  renderBoardShell,
  renderSigninShell,
  serveStaticUnder,
} from './shells.ts';

/**
 * Re-exported: these were declared in this file until the HTML shells moved
 * to `shells.ts`, and the tests and `bin.ts` address them here. The
 * definitions live there now; this keeps the public surface where callers
 * already point.
 */
export {
  HTML_SHELL_HEADERS,
  BOARD_FEEDBACK_DOC_ID,
  appCacheControl,
  readAppAssetManifest,
  renderBoardShell,
  renderSigninShell,
  serveStaticUnder,
};

export type { ServerOptions };

/**
 * `revisedRange` off a request body: the offsets into the NEW detail that a
 * caller says changed.
 *
 * One parser for both revise routes — the ticket one and the doc-thread one.
 * It was inline in the ticket route when it was the only one; copying it
 * would have been two places free to disagree about what a legal span is,
 * which is the drift this file has been bitten by before. An absent range is
 * legal and means "derive it".
 */
function parseRevisedRange(
  raw: unknown,
): { ok: true; range?: { start: number; end: number } } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  const r = raw as { start?: unknown; end?: unknown } | null;
  const start = r?.start;
  const end = r?.end;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return { ok: false, error: 'revisedRange must be {start, end} offsets with start <= end' };
  }
  return { ok: true, range: { start, end } };
}

export interface ServerHandle {
  port: number;
  docStore: DocStore;
  /** The board task store — workspaces, tasks, the transition gate. */
  tasks: TaskStore;
  /** The ydoc projection of the task store (ws:<id> board rooms + task
   *  body rooms). Exposed so tests can force a reassert. */
  projection: TaskProjection;
  /** Per-agent durable watch sets (agent-watches.ts). Exposed so tests can
   *  read the store the route wrote, not only the route's answer. */
  agentWatches: AgentWatches;
  /** The fleet address book (identities.ts) — people and agents. Exposed
   *  for the same reason `agentWatches` is. */
  identities: Identities;
  /** Open builder dispatches and their worktree watchers
   *  (dispatch-registry.ts). Exposed for the same reason `agentWatches` is. */
  dispatches: DispatchRegistry;
  shares: Shares | null;
  /** Hang up every websocket and SSE stream whose share is no longer live.
   *  Runs on a 60s interval; exposed so tests exercise the real sweep. */
  sweepDeadShares: () => void;
  /**
   * The startup pass that moves rows off the removed `parked` state onto
   * triage plus a comment (park-migration.ts).
   *
   * A promise rather than a function, because it is fired once at start and
   * the handle's job is to let a caller AWAIT it. Without that a test — or a
   * boot-time reader — races a write that is already in flight, and the flake
   * would look like a migration that sometimes does not run.
   */
  parkMigration: Promise<ParkMigrationResult>;
  /** One pass of the ready-work wake (ready-nudge.ts). Runs on a 60s
   *  interval; exposed so tests exercise the real pass. */
  nudgeReadyWork: () => void;
  /** One pass of the stall wake (stall-nudge.ts). Runs on a 60s interval;
   *  exposed so tests exercise the real pass. */
  nudgeStalls: () => void;
  /** One pass of the scheduled-task loop (task-scheduler.ts), returning the
   *  occurrences it fired. Runs on a 30s interval; exposed for the same
   *  reason the two wakes are — a test drives the real pass. */
  runScheduler: () => FiredOccurrence[];
  /**
   * The wake's own falsifiability counter — what it suppressed, by condition,
   * against what it actually delivered.
   *
   * Exposed on the handle so the number has a destination besides the stamp
   * file it is persisted in. It does not need a reader to be USEFUL, which is
   * the design: the verdict fires itself through the nudger's reporter when
   * the seven-day window closes. See `NUDGE_TALLY_WINDOW_MS` in
   * ready-nudge.ts for the stopping rule and who acts on it.
   */
  readyNudgeTally: () => NudgeTally;
  /** The external-access master switch — read/flip it without HTTP. */
  sharingGate: SharingGate;
  webhookLog: WebhookLogEntry[];
  stop: () => Promise<void>;
}

export function createServer(opts: ServerOptions = {}): ServerHandle {
  const port = opts.port ?? DEFAULT_PORT;
  const hostname = opts.hostname;
  const dataDir = opts.dataDir ?? join(process.cwd(), 'data');
  const slowRequestMs = opts.slowRequestMs ?? 500;
  const clientReleaseRootDir = opts.clientReleaseRootDir ?? null;
  const widgetDist = opts.widgetDistDir ?? null;
  const markdownAppDist = opts.markdownAppDistDir ?? null;
  /**
   * Browser Sentry config for every shell this server renders or rewrites.
   * `null` — not an empty DSN — when unconfigured, which is what makes the
   * "no DSN, no tags, no script, no SDK, no outbound request" chain start
   * from one check rather than five. See browser-sentry.ts.
   */
  const browserSentry: BrowserSentryConfig | null = opts.sentryDsn
    ? { dsn: opts.sentryDsn, release: opts.sentryRelease ?? null }
    : null;
  const demosDir = opts.demosDir ?? null;

  // Who may reach this server, over which hostname: the sharing registry,
  // the share-link store, the master switch and the three Access verifiers,
  // built from the settings `server-config.ts` resolved. See server-deps.ts —
  // `createServer` composes them, it does not derive them.
  const {
    shares,
    shareLinks,
    shareLinkHosts,
    shareLinkBaseHost,
    shareLinkVerifier,
    sharingGate,
    cookieKey,
    boardShareTarget,
    cfAccessVerifier,
    staticAccessVerifier,
    accessTunnelHosts,
    collabAccessVerifier,
    proxiedTrustedEmails,
    proxiedTrustedVerifier,
    proxiedTrustedHosts,
    recallCallbackHost,
  } = createAccessDeps({
    dataDir,
    opts,
    // Forward reference on purpose: the task store is built below, and
    // `boardShareTarget` is only ever asked at request time.
    isBoard: (workspaceId) => taskStore.getWorkspace(workspaceId) !== undefined,
  });

  const sse = new SseBus();
  // Pick up where the last clean shutdown left off, so a deploy is silent on
  // every channel nothing happened on. Discarded automatically if that process
  // died instead of stopping — see sse-marks.ts for why that direction is the
  // safe one.
  sse.restoreMarks(claimReplayMarks(dataDir));
  const webhookLog: WebhookLogEntry[] = [];
  const webhooks = createWebhookDispatcher({
    onLog: (e) => {
      webhookLog.push(e);
      if (webhookLog.length > 1000) webhookLog.shift();
    },
  });
  // `withReviewUrl` is a hoisted function declaration; it captures
  // `server` lazily and is only invoked during requests / thread events,
  // after Bun.serve has assigned. Same instance is reused for SSE +
  // webhook payloads via the DocStore decorator.
  // Generation is opt-IN at this seam: no summarizer, no outbound call, ever.
  // See ServerOptions.summarizer for why constructing one here was wrong.
  const summarizer = opts.summarizer ?? null;
  const pluginRefresher = opts.pluginRefresher ?? null;
  const deployer = opts.deployer ?? null;
  // Same opt-in seam: no engine here means no socket can start a billed
  // streaming session. See ServerOptions.transcription.
  const meetingStore = new MeetingStore(dataDir, {
    // The raw companion's tie back to the doc: bound path and title as they
    // are at meeting start and stop. A thunk over `docStore`, which is
    // constructed below; a meeting can only start long after it exists.
    docInfo: (docId) => {
      const path = docStore.boundPathOf(docId);
      const title = docStore.peekMeta(docId)?.title;
      return { ...(path ? { path } : {}), ...(title ? { title } : {}) };
    },
  });
  const meetingRelay = new MeetingRelay({
    store: meetingStore,
    engines: Array.isArray(opts.transcription)
      ? opts.transcription
      : opts.transcription
        ? [opts.transcription as TranscriptionEngine]
        : [],
    // The server supplies the notes sink — the write into the meeting doc —
    // and the context resolver (doc title, board task titles). Thunks, not
    // references: the doc store and the task store are constructed below, and both
    // exist long before any meeting can start.
    notes: opts.meetingNotes
      ? withServerNotesSinks(opts.meetingNotes, {
          docStore: () => docStore,
          tasks: () => taskStore,
          // Two readers. The legacy-transcript removal, which must not take a
          // `Raw transcript` heading out of a doc bound into somebody's
          // working tree, where the old note-taker never wrote one. And the
          // notes ledger's durable half (`notes-ledger-store.ts`), which is
          // what keeps a deploy mid-meeting from opening a second notes
          // section — without a data dir the ledger is memory alone.
          dataDir,
          // The capture pipeline's board writes, and the "go do it" wake —
          // the same immediate addressed delivery an answered review item
          // gets. Both close over consts declared below; a meeting can only
          // start long after createServer has returned.
          captureBoard: () => taskStore,
          // Where "pull up last week's notes" looks. Board docs and when
          // each last carried a meeting; the meeting's own doc is dropped
          // by the caller, since "the last meeting" means the one before.
          lookup: { docs: (workspaceId, exceptDocId) => lookupDocs(workspaceId, exceptDocId) },
          onTaskReady: (wake) =>
            readyNudger.taskReady({
              workspaceId: wake.workspaceId,
              taskId: wake.taskId,
              taskTitle: wake.title,
            }),
          // "Link that to the existing task", heard: the row gains the same
          // ref `link_refs` writes, so the meeting is findable from the row
          // and unlinking has something to remove. Link changes emit no store
          // event, so the projection is refreshed by hand — the same pattern
          // the link-refs route uses.
          linkTaskToDoc: (taskId, docId) => {
            const linked = taskStore.linkRef(taskId, spokenLinkRef(docId));
            if (!linked.ok) {
              console.error(`[meeting-tasks] spoken link refused for ${taskId}: ${linked.error}`);
              return;
            }
            if (linked.changed) taskProjection.ensureWorkspace(linked.task.workspaceId);
          },
          // A huddle doc is HELD by a board workspace rather than owned by one
          // (no `setId`), which is where "create a task" said aloud used to
          // go quiet: the capture had no board. The doc's back-target is the
          // same answer the doc page's back arrow gives.
          boardOf: (docId) => backTargetFor(docId)?.id,
          // "Ask the team whether…" — filed exactly as the Review float's
          // press is, with the question attached, by the meeting assistant.
          onReviewAsk: async ({ docId, question, requester }) => {
            const filed = await fileReviewRequest(
              docId,
              {
                id: MEETING_CAPTURE_ACTOR.id,
                name: MEETING_CAPTURE_ACTOR.name,
                kind: 'known',
                color: ANONYMOUS_ACTOR.color,
              },
              spokenReviewComment(question, requester),
            );
            if (!filed) console.error(`[meeting-tasks] review ask on ${docId}: doc not found`);
          },
        })
      : null,
    // Lifecycle only. The words never touch this bus — see meeting-protocol.
    broadcast: (docId, payload) => sse.broadcast(docId, payload),
  });
  /**
   * The bot path into the SAME pipeline. It gets the relay's own notes deps
   * rather than a second set built from the same options: two sets would be
   * two ownership ledgers over one doc's notes section, and the ledger is
   * what stops a tick from eating what a person typed.
   */
  /**
   * Is the address we would hand Recall one this server itself refuses?
   *
   * Computed here rather than in bin.ts because the effective host lists are
   * here — `proxiedTrustedHosts` above is already the post-verifier one — and
   * because a server spun up any other way (staging, a test) deserves the
   * same answer. Null means nothing known says the callbacks are unreachable.
   */
  const recallUnreachable = unreachableCallbackReason({
    wsBase: opts.meetingBot?.config.publicWsBase ?? null,
    callbackHost: recallCallbackHost,
    accessGatedHosts: [...proxiedTrustedHosts, ...(opts.accessTunnelHosts ?? [])],
  });
  if (recallUnreachable) console.error(`[meetings] bots are OFF: ${recallUnreachable}`);
  const recallRelay = new RecallMeetingRelay({
    store: meetingStore,
    notes: meetingRelay.notesDeps,
    client: opts.meetingBot ?? null,
    unreachable: recallUnreachable,
    broadcast: (docId, payload) => sse.broadcast(docId, payload),
    // The bot's words DO touch this bus — unlike the microphone's — because a
    // bot has no socket to any browser. Transient: live fan-out, no buffer,
    // no id, so the replay window stays the doc's (see SseBus).
    broadcastTransient: (docId, payload) => sse.broadcastTransient(docId, payload),
  });
  /**
   * Calendar meeting-join, beside the relay whose invite path a join click
   * takes. The store survives restarts because the webhook consumer must
   * recognise the connected calendar after one, and a join that lasted only
   * until the next deploy would orphan the doc it opened.
   */
  const calendarStore = opts.calendarBot ? new CalendarConnectionStore(dataDir) : null;
  const calendarSync =
    opts.calendarBot && calendarStore
      ? new CalendarSyncConsumer({
          client: opts.calendarBot.client,
          store: calendarStore,
          // A cancelled meeting somebody joined: the bot goes home through
          // the same leave the doc's own button uses.
          onCancelledJoin: async (_eventId, docId) => {
            await recallRelay.leave(docId);
          },
        })
      : null;
  /**
   * CSRF states for the Google connect flow, minted at /connect and spent at
   * /callback. In memory on purpose: a state that did not survive a restart
   * only costs the person one more click on Connect.
   */
  const calendarOauthStates = new Map<string, number>();
  // Late-bound because DocStore is constructed before the task store and the
  // projection it needs. Nothing can fire through it until a room exists,
  // which is after both.
  let onDocRoomEvent: ((docId: string, payload: WebhookPayload) => void) | null = null;
  const docStore = new DocStore({
    dataDir,
    sse,
    webhooks,
    decorateDocMeta: withReviewUrl,
    onRoomEvent: (docId, payload) => onDocRoomEvent?.(docId, payload),
    ...(summarizer ? { summarizer } : {}),
  });
  // Materialize the shared board-feedback doc at startup rather than letting
  // the first widget connection conjure it. A room created by a `/y/<id>`
  // connect has no title and no type, so it reads as a ghost in list_docs —
  // and this one is meant to be found and watched by an agent that never
  // visited a board.
  docStore.getOrCreate(BOARD_FEEDBACK_DOC_ID, {
    type: 'mockup',
    title: 'Board feedback (all workspaces)',
  });
  // Server-side half of the double-submit fix: the doc composer's in-flight
  // guard stops ONE call site from ever sending the repeat, this catches
  // whatever gets through anyway (a request that landed but read as a
  // client-side failure, a future caller that reintroduces the race).
  const threadRequestDedup = new ThreadRequestDedup<Thread | null>();
  // The board task store (plan §3.2/§3.3): server-owned workspaces + tasks,
  // persisted as per-workspace sidecars under <dataDir>/workspaces/.
  const taskStore = new TaskStore({
    dataDir,
    ...(opts.heartbeatFreshMs !== undefined ? { heartbeatFreshMs: opts.heartbeatFreshMs } : {}),
    ...(opts.observedWorkFreshMs !== undefined
      ? { observedWorkFreshMs: opts.observedWorkFreshMs }
      : {}),
  });
  // Which docs each agent identity is watching — the durable memory behind
  // the MCP child's session-scoped SSE subscriptions, so a respawned session
  // can re-wire them instead of silently starting from `[]`. See
  // agent-watches.ts.
  const agentWatches = new AgentWatches({ dataDir });

  /**
   * A watch key is live when the thing it names still exists: a doc room, or
   * for `ws:<id>` a board workspace / review. Anything else is a subscription
   * the child would open against a 404 forever.
   *
   * Closure-level rather than route-local because two routes need the same
   * answer — the watches list, and the attach response that reports how many
   * watches this session actually has. Two copies would be two definitions of
   * "live" free to drift, on a pair of readings that only mean anything when
   * they agree.
   */
  const watchKeyExists = (key: string): boolean => {
    if (docStore.docExists(key)) return true;
    if (!key.startsWith('ws:')) return false;
    const wsId = key.slice('ws:'.length);
    return (
      taskStore.getWorkspace(wsId) !== undefined ||
      docStore.list().some((m) => m.workspaceId === wsId)
    );
  };
  if (agentWatches.loadError) {
    console.error(`[agent-watches] ${agentWatches.loadError}`);
  }

  // The per-agent memory of turn / denial notes (agent-notes.ts). In-process
  // only: the durable copy is the note pinned to the row it landed on.
  const agentNotes = new AgentNoteRing();
  // The repeated-denial watcher (allow-rules.ts): a third denial of one
  // shape in a week files a paste-ready allow rule as a review item. It
  // reads the task notes the routes below append and writes nothing but its
  // own sidecar — never a settings file.
  const allowRules = new AllowRuleProposals(dataDir);
  /**
   * The board's docs as a lookup ask sees them — the three narrow questions
   * `boardLookupDocs` asks, answered from this server's own stores. The
   * rules about what qualifies live there, where they are tested.
   */
  function lookupDocs(workspaceId: string, exceptDocId: string): LookupDoc[] {
    return boardLookupDocs(
      {
        docIds: (id) => taskStore.getWorkspace(id)?.docIds,
        docTitle: (docId) => docStore.peekMeta(docId)?.title,
        // Oldest first, so the newest meeting is the tail.
        lastMeetingAt: (docId) => meetingStore.list(docId).at(-1)?.startedAt,
      },
      workspaceId,
      exceptDocId,
    );
  }

  /** A denial's own agent, as the author of the item it triggered — so the
   *  card says who was blocked, the way a comment-borne ask names its poster. */
  function proposeAllowRule(
    task: Task,
    note: { kind: string; text: string; agent: string; at: number },
  ): void {
    if (note.kind !== 'denial') return;
    let filed: ReturnType<AllowRuleProposals['onDenial']>;
    try {
      filed = allowRules.onDenial(
        taskStore,
        { agent: note.agent, text: note.text, ts: note.at },
        task,
      );
    } catch {
      // The hook's path: a note that landed must not turn into a 500 because
      // the proposal behind it could not be written.
      return;
    }
    if (!filed) return;
    // Same two steps the review-item route takes: re-project so the board
    // room carries the item, and announce so the queue hears about it.
    taskProjection.ensureWorkspace(filed.task.workspaceId);
    announceTaskReview(filed.task, filed.item, {
      id: agentIdForName(note.agent),
      name: note.agent,
      kind: 'known',
      color: ANONYMOUS_ACTOR.color,
    });
  }
  // Which builder worktrees are working which tasks — the witness that keeps
  // the stall loop from waking a lead over a row whose builder is busy in a
  // checkout the board cannot see. See dispatch-registry.ts.
  //
  // A dispatch on a task that is `done` or archived is over, whatever the
  // registry's own evidence says — the builder's checkout often lingers on
  // disk after its PR merges, so the path check alone kept counting slots
  // for finished work (board, 2026-08-31: `inUse 12 / free 0`, all twelve
  // holders done). The predicate is handed to the registry rather than
  // applied here so EVERY reader — the cap view, the dispatch refusal, the
  // stall gate's watching set, `/api/dispatches` — sees the same pruned set;
  // a task the store cannot find is left to the workspace join below, which
  // cannot attribute it to a board and so never counts it.
  const dispatches = new DispatchRegistry({
    dataDir,
    isTaskOver: (taskId) => {
      const task = taskStore.getTask(taskId);
      return task !== undefined && (task.status === 'done' || task.archivedAt !== undefined);
    },
    ...(opts.dispatchWatchFactory !== undefined ? { watchFactory: opts.dispatchWatchFactory } : {}),
  });
  if (dispatches.loadError) {
    console.error(`[dispatch] ${dispatches.loadError}`);
  }
  if (dispatches.prunedAtBoot.length > 0) {
    console.log(
      `[dispatch] closed ${dispatches.prunedAtBoot.length} stale dispatch(es) at boot: ${dispatches.prunedAtBoot.join(', ')}`,
    );
  }
  // The row reaching `done` or the archive IS the dispatch's terminal
  // statement — the registry hears it here, so a builder that never sent
  // `close_dispatch` (an older bundle, a crash after the merge) cannot leave
  // its slot held. Prune-on-read above would catch it eventually; this
  // catches it at the moment the board learns.
  taskStore.onEvent((ev) => {
    if ((ev.type === 'task.transitioned' && ev.to === 'done') || ev.type === 'task.archived') {
      dispatches.close(ev.taskId);
    }
  });

  /**
   * Every OPEN dispatch whose task belongs to `workspaceId`, excluding
   * `excludeTaskId` — pass the dispatch's own task there when checking
   * whether IT would push the board over its cap, since re-registering the
   * same task replaces its slot rather than taking a second one.
   *
   * `dispatches` is one registry for the whole server (task ids are unique
   * across boards), so this is the join back to "which board" every caller
   * that wants a per-workspace count needs. A dispatch for a task the store
   * no longer has (soft-deleted, or a stale record from before a restart)
   * cannot be attributed to any board and is silently excluded — the same
   * "coordination state, not user content" posture dispatch-registry.ts
   * already takes with a vanished worktree.
   */
  const dispatchesInWorkspace = (
    workspaceId: string,
    excludeTaskId?: string,
  ): ReturnType<typeof dispatches.list> =>
    dispatches
      .list()
      .filter(
        (d) =>
          d.taskId !== excludeTaskId && taskStore.getTask(d.taskId)?.workspaceId === workspaceId,
      );

  /**
   * The board's parallelism cap as every reader sees it: the number, whether
   * it is the shipped default, how many slots are spent and by whom, and how
   * many are free. ONE builder for the settings route, the cap route, the
   * dispatch refusal, the workspace read and the two nudges — so "in use"
   * cannot mean open dispatches on one surface and in-progress rows on
   * another. A slot is an OPEN DISPATCH (`register_dispatch`): a builder the
   * lead never registered holds none, which is why the lead skill makes
   * registering the dispatch rule rather than a courtesy.
   *
   * Holders carry the task id, its title and the agent's display name — all
   * workspace content, visible to every member by the board's own rule — and
   * never the worktree path, which is host-machine fact (`/api/dispatches`
   * has a visitor check for exactly that; this view is served without one).
   * `undefined` for a board that does not exist.
   */
  const parallelismCapView = (
    workspaceId: string,
    excludeTaskId?: string,
  ):
    | {
        cap: number;
        isDefault: boolean;
        default: number;
        inUse: number;
        free: number;
        holders: Array<{ taskId: string; title?: string; agentName?: string }>;
        /** Who last moved the cap, when, from what — absent until somebody has. */
        lastChange?: ParallelismCapChange;
      }
    | undefined => {
    const read = taskStore.parallelismCap(workspaceId);
    if (!read) return undefined;
    const holders = dispatchesInWorkspace(workspaceId, excludeTaskId).map((d) => {
      const title = taskStore.getTask(d.taskId)?.title;
      return {
        taskId: d.taskId,
        ...(title !== undefined ? { title } : {}),
        ...(d.agentName !== undefined ? { agentName: d.agentName } : {}),
      };
    });
    return {
      cap: read.value,
      isDefault: read.isDefault,
      default: DEFAULT_PARALLELISM_CAP,
      inUse: holders.length,
      free: Math.max(0, read.value - holders.length),
      holders,
      ...(read.lastChange !== undefined ? { lastChange: read.lastChange } : {}),
    };
  };
  /**
   * The cap as a wake names it: the number and, once somebody has moved it,
   * who, when and from what. Both nudgers put this beside the rows they hold
   * for the cap, so "held for the parallelism cap" and "set by X 2h ago" land
   * in the same sentence rather than sending the lead to find out.
   */
  const capSummary = (read: {
    cap?: number;
    value?: number;
    lastChange?: ParallelismCapChange;
  }): { value: number; lastChange?: ParallelismCapChange } => ({
    value: read.cap ?? read.value ?? DEFAULT_PARALLELISM_CAP,
    ...(read.lastChange !== undefined ? { lastChange: read.lastChange } : {}),
  });

  /** One sentence naming who holds the slots, for a refusal or a note. */
  const holdersClause = (
    holders: ReadonlyArray<{ taskId: string; title?: string; agentName?: string }>,
  ): string =>
    holders
      .map(
        (h) =>
          `${h.agentName ?? 'an unnamed agent'} on ${h.title !== undefined ? `"${h.title}"` : h.taskId}`,
      )
      .join(', ');

  // The per-agent unfiled-ask counters the daily chat audit publishes, kept
  // so a session can read its own number back. The audit is the only writer
  // — the server cannot see chat — see chat-audit.ts for the honest limits.
  const chatAudit = new ChatAudit({ dataDir });
  if (chatAudit.loadError) {
    console.error(`[chat-audit] ${chatAudit.loadError}`);
  }

  // The push announcement and the review-item quality gate are built LATER,
  // once `resolveWorkspaceForDoc` and the task projection exist — see
  // `createPushAnnounce` / `createReviewGate` further down. Their functions
  // are only ever called from a route or a hook, so the callers above that
  // name one (`proposeAllowRule`, `stallVerdict`) reach it at request time.

  // Effort scoring — see effort-scoring.ts. Built ABOVE the subscription
  // that calls it, so `scoreEffortEstimate` is declared before its first
  // use: on main it was a hoisted function declaration and the order could
  // not bite, and a `const` in the temporal dead zone would throw if a task
  // event ever fired during init. The projection it re-projects through is
  // built further down, so it arrives as a thunk.
  const { scoreEffortEstimate, rescoreStaleEffortEstimates, stopEffortRescore } =
    createEffortScoring({
      taskStore,
      refreshWorkspace: (workspaceId) => taskProjection.refresh(workspaceId),
      opts,
    });
  // Effort-estimate scoring: re-score a ticket in the background whenever
  // its words — or its goal — change. `task.created`, `task.retitled` and
  // `task.body_edited` are the three doors a title or a body move through —
  // `applyTitle`'s own doc names the seven routes that converge on them —
  // so subscribing here rather than at each route is what makes every one
  // of those routes get scoring for free, batch creation included.
  // `task.regrouped` is the fourth: the goal's own title is part of what the
  // scorer weighs (see `scoreEffortEstimate` above), so moving a ticket to a
  // DIFFERENT goal is a change to the scorer's input even when the title and
  // body never moved. `task.regrouped` also fires on a pure reorder within
  // the same goal (order changed, goal did not) — `fromGoal !== toGoal` is
  // what tells the two apart, so a reorder alone triggers no extra call.
  taskStore.onEvent((ev) => {
    if (ev.type === 'task.created') {
      scoreEffortEstimate(ev.task);
      return;
    }
    if (
      ev.type === 'task.retitled' ||
      ev.type === 'task.body_edited' ||
      (ev.type === 'task.regrouped' && ev.fromGoal !== ev.toGoal)
    ) {
      const task = taskStore.getTask(ev.taskId);
      if (task) scoreEffortEstimate(task);
    }
  });
  // Every store event rides the existing SSE pipeline on the workspace
  // channel (`ws~<workspaceId>`, the same channel doc thread events use for
  // reviews) — no new transport (§3.6). The audit log
  // append happens inside the store's emit, not here.
  //
  // ONE exclusion: `task.noted` never rides the stream. An attached MCP
  // child relays every task.* frame it has no line for as a channel message
  // to its session, so a broadcast note would wake every other agent on the
  // board once per turn of the agent that posted it — and two agents each
  // holding a row would wake each other without end. Nothing on the stream
  // needs it: the ydoc projection carries the notes and the audit log has
  // the event. Excluded here, on the server, because a bundle-side filter
  // only takes effect for sessions that have restarted onto it.
  taskStore.onEvent((ev) => {
    if (ev.type === 'task.noted') return;
    const { type, ...rest } = ev;
    sse.broadcast(`ws~${ev.workspaceId}`, { event: type, ...rest });
  });
  // The second half of the liveness gate, and the half a time window cannot
  // supply: a delivery rides `ws~<workspaceId>`, so if nobody holds that
  // stream it lands nowhere. An agent that died thirty seconds after its last
  // write is still inside every freshness window and is already gone; only
  // the open socket knows.
  //
  // This can only ever make the gate MORE conservative — the store ANDs it
  // with observed freshness, so a subscriber alone never counts as live.
  // That direction is deliberate and it is the safe one: browsers watch the
  // same channel as agents, so a probe read as sufficient would let an open
  // tab impersonate a working agent, and the utterance would be broadcast to
  // a listener that cannot act on it and lost. Queued is late; delivered to
  // nobody is gone.
  taskStore.setDeliveryProbe((workspaceId) => sse.count(`ws~${workspaceId}`) > 0);
  // …and the stronger, agent-specific form of the same question. `count`
  // cannot tell an agent from a browser tab, so it may only ever narrow a
  // delivery decision; this one is keyed by the agentId the agent's own MCP
  // child puts on its stream, so it may widen one.
  taskStore.setAgentStreamProbe((workspaceId, agentId) =>
    sse.agentsOn(`ws~${workspaceId}`).has(agentId),
  );
  // The ydoc projection (§3.3): ws:<workspaceId> board rooms the server
  // writes and defends (foreign writes reverted), plus task:<taskId> body
  // rooms. init() runs after both stores hydrated, so the sidecar is
  // authoritative for gated fields on restart.
  const taskProjection = new TaskProjection({ docStore, tasks: taskStore });
  taskProjection.init();

  // Provenance stamping at the store's one choke point: every create whose
  // origin names a doc records the doc's settled content revision, whichever
  // route (or the meeting capture) filed it.
  taskStore.setDocRevisionReader((docId) => docStore.settledContentRevision(docId));
  // …and the return half: a settled edit burst on a doc flags the open rows
  // derived from an earlier revision of it. Flagging emits no store event
  // (§3.6's table is exhaustive), so the projection refresh happens here,
  // the same pattern as the links route.
  docStore.onContentRevision = (docIds, revision) => {
    const touched = new Set(taskStore.flagStaleFromDocEdit(docIds, revision));
    // The settled doc's prose is the linkage record: any task/goal link the
    // edit wrote (or that was never mined) becomes a structured ref now, so
    // the Docs field on the row side stays true without a second call. Ids
    // arrive as canonical + alias; scanning the first that resolves scans
    // the one doc they both name.
    const scanned = new Set<string>();
    for (const docId of docIds) {
      const canonical = docStore.resolveDocId(docId);
      if (scanned.has(canonical)) continue;
      scanned.add(canonical);
      for (const wsId of scanSettledDocRefs(docStore, taskStore, canonical)) touched.add(wsId);
    }
    for (const workspaceId of touched) {
      taskProjection.ensureWorkspace(workspaceId);
    }
  };

  // The done-artifact check (artifact-check.ts): a move to done gets the
  // row's links verified after the transition commits — a dead PR link or a
  // vanished doc surfaces as a system comment on the task's discussion, the
  // park-note pattern. Advisory end to end: nothing here can block, slow, or
  // fail a transition, and a lookup that cannot answer stays quiet.
  const artifactChecker = new ArtifactChecker({
    getTask: (id) => taskStore.getTask(id),
    record: (id, result) => void taskStore.recordArtifactCheck(id, result),
    // A doc exists if a live room holds it or an archive manifest does —
    // archiving is the board's reversible removal, so a retired doc still
    // counts as delivered. Review members archive under a set manifest, not
    // a per-doc one, so both archive shapes are consulted.
    docStatus: (docId) => {
      if (docStore.list().some((m) => m.docId === docId)) return 'live';
      if (readDocArchiveManifest(dataDir, docId) !== null) return 'archived';
      if (listArchivedReviews(dataDir).some((m) => m.docIds.includes(docId))) return 'archived';
      return 'missing';
    },
    postMissingNote: async (task, text) => {
      taskProjection.ensureTaskBody(task);
      // Same actor-shape cast as the park migration's comment: the server's
      // own identity, rendered as a known author rather than an anonymous one.
      await docStore.postComment(
        taskBodyDocId(task.id),
        null,
        { ...ARTIFACT_CHECK_ACTOR, kind: 'known' } as unknown as User,
        text,
        { kind: 'subject' },
        // Machine-written and short: not worth an outbound summary call.
        { generate: false },
      );
    },
    ...(opts.artifactCheckFetch !== undefined ? { fetchImpl: opts.artifactCheckFetch } : {}),
    ...(opts.artifactCheckTimeoutMs !== undefined
      ? { timeoutMs: opts.artifactCheckTimeoutMs }
      : {}),
    log: (line) => console.error(line),
  });
  artifactChecker.install(taskStore);
  // The doc<->board membership map: which boards hold a doc, who may reach it
  // through one, and whether an agent's watch set actually covers them. One
  // subject, one module (`board-membership.ts`); `createServer` composes it
  // and does not derive any of it.
  //
  // Composed HERE, above the stall wiring, because everything it reads is
  // already built — `docStore`, both stores, and the access deps at the top of
  // this function. That is what lets `boardsForDoc` and `backTargetFor` go
  // into the wiring below as VALUES rather than as thunks over a block
  // declared later in the file.
  const {
    shareWorkspacesOf,
    collabMemberOf,
    shareLinkMemberOf,
    redeemShareLink,
    boardsForDoc,
    boardIndexForListing,
    boardsForDocIndexed,
    homeForDocIndexed,
    watchCoverageFor,
    backTargetFor,
    fileUnderBoardWorkspace,
    unfileFromDefault,
    unlinkFromEveryBoardWorkspace,
  } = createBoardMembership({
    docStore,
    taskStore,
    taskProjection,
    shares,
    shareLinks,
    boardShareTarget,
    proxiedTrustedEmails,
  });

  // The stall / ready-work wiring — both per-board snapshots, the two
  // nudgers, the lead-presence monitor, the ready clock's store subscription
  // and the comment-queue bridge. One documented subsystem
  // (docs/architecture/stall-detection.md), so it is one module:
  // `stall-wiring.ts`. `createServer` composes it and arms the nudgers below;
  // it does not derive any of it.
  //
  // ONE member of the context is a FUNCTION rather than a value —
  // `reviseCallFor` — because the review gate is built further down this file
  // than this line, and it is only ever reached from a request or an event.
  // Passing it deferred is what lets this stay here: the gate is built where
  // it is because it needs `resolveWorkspaceForDoc` and the task projection,
  // and hoisting it to satisfy a declaration order would trade one ordering
  // constraint for a worse one.
  //
  // `boardsForDoc` and `backTargetFor` used to be thunks for the same
  // reason and are now values: the membership map they come from is composed
  // above this line, so there is nothing left to defer.
  const stallWiring = createStallWiring({
    taskStore,
    taskProjection,
    docStore,
    sse,
    dispatches,
    agentWatches,
    dataDir,
    parallelismCapView,
    capSummary,
    boardsForDoc,
    backTargetFor,
    reviseCallFor: (address) => reviseCallFor(address),
    ...(opts.readyNudgeIdleMs !== undefined ? { readyNudgeIdleMs: opts.readyNudgeIdleMs } : {}),
    ...(opts.stallNudgeQuietMs !== undefined ? { stallNudgeQuietMs: opts.stallNudgeQuietMs } : {}),
    ...(opts.stallBuilderSilentMultiplier !== undefined
      ? { stallBuilderSilentMultiplier: opts.stallBuilderSilentMultiplier }
      : {}),
    ...(opts.stallNudgeRepeatMs !== undefined
      ? { stallNudgeRepeatMs: opts.stallNudgeRepeatMs }
      : {}),
    ...(opts.stallEscalateMs !== undefined ? { stallEscalateMs: opts.stallEscalateMs } : {}),
    ...(opts.heldReviewItemMs !== undefined ? { heldReviewItemMs: opts.heldReviewItemMs } : {}),
    ...(opts.noteAskJudge !== undefined ? { noteAskJudge: opts.noteAskJudge } : {}),
  });
  const { leadPresence, readyNudger, stallNudger } = stallWiring;

  // The scheduled-task loop (docs/architecture/scheduled-tasks.md). Built
  // beside the two nudgers because it is the third thing on this server that
  // runs on a clock rather than on a request, and armed with them below.
  // `schedulerNow` is a seam for the same reason `stallNudgeQuietMs` is one:
  // the feature IS a comparison against a clock, so a test that could not move
  // the clock would have to burn real minutes to assert anything.
  const taskScheduler = createTaskScheduler(taskStore, {
    ...(opts.schedulerNow !== undefined ? { now: opts.schedulerNow } : {}),
  });
  // The late binding `DocStore` was constructed with: the bridge needs the task
  // store and the projection, which are built after `DocStore` is.
  onDocRoomEvent = stallWiring.onDocRoomEvent;

  // ── Home pane: per-person read markers + the "What's New?" brief ─────────
  // One subject, one module (`home-pane.ts`); `createServer` composes it here
  // because everything the pane reads — the stores, the doc store and the
  // summarizer seam — is in hand by this line, and the routes below take the
  // same four names off it that they used to take off this closure.
  const { homeBriefs, reviewItemsFor, homeQueueTotal, homePayload } = createHomePane({
    dataDir,
    taskStore,
    docStore,
    summarizer,
  });
  /**
   * Rewrite a task's description through its live `task:<id>` body room, with
   * everything the act owes: the room exists, the snapshot the board and
   * `next_tasks` read is fresh immediately rather than on the debounce, and —
   * when the caller said who it is — an attributed `task.body_edited` row.
   *
   * ONE function because there are TWO routes: `POST /api/tasks/:id/body` and
   * `POST /api/docs/task:<id>/content`. The second one used to reach
   * `docStore.setDocContent` directly and got none of this, which is how a
   * rewrite through `set_doc_content` destroyed a capture with nothing
   * recorded while both the caller and the board saw success.
   *
   * The preservation into `quote` is deliberately NOT here. It lives at
   * `TaskStore.updateBodySnapshot`, the choke point every writer of a body
   * fragment passes through — including `find_and_replace` on the same docId
   * and a person typing on the board, neither of which comes through this
   * function. Putting it here would rebuild the exact gap being closed, one
   * layer up.
   */
  const rewriteTaskBody = (
    task: Task,
    markdown: string,
    opts: {
      actor?: { id: string; name: string; kind?: string };
      title?: string;
      reason?: string;
    },
  ): { ok: true } | { ok: false; error: string } => {
    const docId = taskProjection.ensureBodyDoc(task);
    const res = docStore.setDocContent(docId, markdown);
    if (!res.ok) return res;
    taskProjection.flushBodySnapshot(task.id);
    // Attribution is the one half a route can lack: `POST /api/docs/:id/content`
    // has never required an author, and an audit row naming nobody is worse
    // than the honest absence of one. The words are safe either way — the
    // snapshot flush above has already preserved them.
    if (opts.actor) {
      taskStore.noteBodyEdited(task.id, {
        actor: opts.actor,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
      });
    }
    return { ok: true };
  };
  // Deploy readiness (§3.12 commit 11): uptime is measured from the same
  // events.jsonl the audit trail lives in. The monitor stamps
  // server.started now (bounding whatever outage this boot ended) and
  // beats server.tick so an idle workspace's log still has gap-analysis
  // density. Markers bypass taskStore.emit on purpose — §3.6's table has
  // no server.* rows, and SSE/MCP subscribers must not see a beat every
  // five minutes.
  const uptimeMonitor = new UptimeMonitor({
    dataDir,
    tasks: taskStore,
    ...(opts.uptimeTickMs !== undefined ? { tickMs: opts.uptimeTickMs } : {}),
  });
  uptimeMonitor.start();
  // Voice routing (§3.8): lookups take the Haiku fast path when a completer
  // was injected; changes go to the attached agent (or the on-disk queue).
  const voiceRouter = new VoiceRouter({
    tasks: taskStore,
    ...(opts.voiceComplete ? { complete: opts.voiceComplete } : {}),
    // What a doc in view HOLDS, read through the one review-item builder this
    // server already has. Voice must not grow a second notion of "what is
    // waiting on a person here": that shape is owned by review-queue.ts and
    // is being reworked, and a private copy would drift the day it lands.
    // The router only ever calls this for a docId it has already proved is
    // attached to the workspace.
    docResource: (workspaceId, docId) => {
      const workspace = taskStore.getWorkspace(workspaceId);
      if (!workspace) return undefined;
      const meta = docStore.peekMeta(docId);
      // Title, else the file's BASENAME — never the path. Same rule, and the
      // same reason, as the review-items route: a label is workspace content,
      // a host path is not, and this text leaves the machine.
      const title = meta?.title || meta?.relPath?.split('/').pop();
      return {
        ...(title ? { title } : {}),
        reviewItems: reviewItemsFor(workspace)
          // A queue row now hangs on EITHER a comment or a ticket (#254). Only
          // the comment-shaped ones address a `docId`/`threadId`/`commentId`,
          // and only those are things this DOC holds — a ticket review item is
          // answered against `taskId`/`reviewItemId` and belongs to the task
          // surface, not to a doc in view. Narrowed with a predicate rather
          // than a bare `.filter`, because `.filter` alone leaves the union
          // intact and the field reads below would not compile.
          .filter(
            (item): item is ReviewThreadItem => item.kind !== 'task-review' && item.docId === docId,
          )
          .map((item) => ({
            threadId: item.threadId,
            commentId: item.commentId,
            // Whether `answerReviewItem` can stamp an answer onto it, which is
            // true exactly when the comment carries the declaration. Read from
            // the item rather than discovered from that function's error
            // string: it decides which existing room write voice calls, and a
            // plain open question (the `unreplied` band — since the membership
            // narrowing, direct asks only rather than most of the queue)
            // gets a plain threaded reply instead of a silent deferral.
            answerable: item.review !== undefined,
            ask: item.ask,
            askedBy: item.askedBy,
            // The labels a spoken pick is matched against, with the ids the
            // answer is stamped with — the same pair a tapped button sends.
            ...(item.review?.options?.length
              ? { options: item.review.options.map((o) => ({ id: o.id, label: o.label })) }
              : {}),
          })),
      };
    },
    // A doc's LABEL, for matching "the Akash review doc" against what the
    // board calls it. Title, else the file's basename — never the path, for
    // the reason given twice above.
    docTitle: (_workspaceId, docId) => {
      const meta = docStore.peekMeta(docId);
      // Title, else the file's NAME. The review-items route stops at
      // `relPath`'s basename because a share visitor reads it; this label
      // reaches only the local speaker's ack and the classification prompt,
      // and a bare filename ("expansion-plan.md") is what a doc bound without
      // a title is called everywhere else. Directories never come along.
      const file = (meta?.relPath ?? meta?.sourceUrl ?? '').split('/').pop();
      return meta?.title || (file ? file.replace(/\.[a-z0-9]+$/i, '') : undefined) || undefined;
    },
    // What is waiting on a person, board-wide, for "brief status" — the SAME
    // rows the Home queue renders, so the count voice says is the count the
    // reader sees when they look.
    queue: (workspaceId) => {
      const workspace = taskStore.getWorkspace(workspaceId);
      if (!workspace) return [];
      return reviewItemsFor(workspace).map((item) => ({
        title: item.title,
        ask: item.ask,
        askedBy: item.askedBy,
      }));
    },
    // The room store itself, for the two text verbs. Voice calls
    // `postComment` — the one choke point every reply path in this server
    // already funnels through — and `answerReviewItem` exactly as it stands,
    // so a spoken comment and a typed one are the same write, fire the same
    // events, and reach a watching agent identically.
    docStore,
    // A task's discussion room, CREATED if this process has not served it
    // yet. Body rooms are lazy, so on a freshly restarted server the room for
    // a task nobody has opened does not exist and a comment aimed straight at
    // `task:<id>` is dropped with a `null` the caller reads as "no such doc".
    taskCommentDoc: (taskId) => {
      const task = taskStore.getTask(taskId);
      return task ? taskProjection.ensureBodyDoc(task) : undefined;
    },
  });

  /** A path segment, decoded, answering itself rather than throwing on `%`. */
  const safeDecodeSegment = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  /**
   * The Review ask, filed: a subject thread on the doc carrying `text` from
   * `author`, and the doc stamped as review-requested naming that thread so
   * the float can offer another ask once it is resolved. One function for
   * both triggers — the float's press and the meeting assistant hearing
   * "ask the team whether…" — so a spoken ask and a tapped one land as the
   * same thing. Null when the doc does not exist.
   */
  const fileReviewRequest = async (
    docId: string,
    author: User,
    text: string,
  ): Promise<{ threadId: string; requestedAt?: number } | null> => {
    const thread = await docStore.postComment(
      docId,
      null,
      author,
      text,
      { kind: 'subject' },
      { generate: false },
    );
    if (!thread) return null;
    const stamped = docStore.setReviewRequested(docId, author.name, thread.id);
    return { threadId: thread.id, ...(stamped.ok ? { requestedAt: stamped.requestedAt } : {}) };
  };

  /**
   * ── Addressing: one prefix, and the compat layer that keeps the old ones
   * answering. ──
   *
   * Every resource lives under the workspace it belongs to:
   *
   *   /workspaces/<workspaceId>                     the board
   *   /workspaces/<workspaceId>/docs/<docId>        a doc, of any content kind
   *   /workspaces/<workspaceId>/mockups/<docId>     a mockup's own HTML
   *   /workspaces/<workspaceId>/reviews/<reviewId>  a review, → its entry doc
   *
   * `/review/<docId>` and `/mockup/<docId>` are the addresses these used to
   * have. They still answer, and they always will: those URLs sit in comment
   * threads, in bookmarks, and in `entryUrl` values returned by plugin bundles
   * running in sessions nobody can restart. A 404 there reads, to the person
   * holding the link, exactly like the review having been deleted.
   */

  /** 302 with the query string preserved. `?mobile=<preset>` rides on it. */
  const redirectTo = (path: string, search: string): Response =>
    new Response(null, { status: 302, headers: { location: `${path}${search}` } });

  /**
   * The doc's own id, for a request that addressed it by a readable alias.
   *
   * The `/api/docs/<id>/…` block canonicalizes for the ~30 subroutes inside
   * it. This is for the doc routes matched OUTSIDE that block — they exist
   * because they must run before it or without a room, and each one is a
   * place where "the alias works everywhere" quietly stopped being true.
   * `doc-id-routes.test.ts` walks the whole surface by alias so the next one
   * added without this goes red rather than out.
   *
   * Unknown ids pass through unchanged, so a 404 still reads as "no such
   * doc" rather than becoming a different error on the way.
   */
  const canonicalDocId = (addressed: string): string => docStore.get(addressed)?.docId ?? addressed;

  /**
   * The workspace to address a doc under, or null when nothing holds it.
   *
   * Deliberately `backTargetFor`'s resolution rather than
   * `taskStore.workspaceOfDoc`: a review is filed as ONE row under its review
   * id, so a member doc is never in any `docIds` and the direct lookup answers
   * null for every file in every review — which is most of the docs there are.
   * Widening `workspaceOfDoc` itself would widen SHARE SCOPING with it, and
   * that is a security decision rather than an addressing one.
   */
  const resolveWorkspaceForDoc = (docId: string): string | null =>
    backTargetFor(docId, attachmentIdOf(docStore.peekMeta(docId) ?? {}))?.id ?? null;

  // Browser push, and the review-item quality gate that decides whether an
  // item may be announced at all. Built HERE rather than beside the other
  // stores because the gate needs `resolveWorkspaceForDoc` and the task
  // projection, and the gate takes `announceReviewItem` rather than the
  // routes calling it — so "judged, then announced" is the wiring rather
  // than a rule two callers have to remember. See review-gate.ts.
  const { pushStore, pushNotifier, announceReviewItem } = createPushAnnounce({
    dataDir,
    externalBaseUrl,
    opts,
  });
  const {
    announceTaskReview,
    announceThreadReview,
    recordedThreadHold,
    gateThreadDeclaration,
    reviseCallFor,
    judgeReviewItem,
    judgeTaskDecision,
    judgeThreadReview,
    mergedHold,
    regateDecisionWords,
    heldFields,
    askBackOnItem,
  } = createReviewGate({
    docStore,
    taskStore,
    taskProjection,
    sse,
    opts,
    j,
    externalBaseUrl,
    threadUrl,
    resolveWorkspaceForDoc,
    announceReviewItem,
  });

  /**
   * File every attachment set that predates `fileUnderBoardWorkspace` onto a
   * workspace, once per boot and never twice. See attachment-backfill.ts for
   * why this is needed and why it is safe to re-run; the short version is that
   * 20 of the 23 sets in the live data dir were created before filing existed,
   * and a set with no workspace has no address under `/workspaces/<id>/…`.
   */
  const runAttachmentBackfill = (): void => {
    const res = backfillAttachmentFiling({
      docs: () => docStore.list(),
      isFiled: (attachmentId) => taskStore.workspaceOfDoc(attachmentId) !== null,
      file: (attachmentId) => fileUnderBoardWorkspace(attachmentId),
    });
    if (res.filed.length > 0) {
      console.log(
        `[attachments] filed ${res.filed.length} previously unfiled attachment set(s) onto a workspace:`,
        res.filed.map((r) => `${r.attachmentId}→${r.workspaceId}`).join(', '),
      );
    }
    if (res.failed.length > 0) {
      console.error(
        `[attachments] could not file: ${res.failed.join(', ')} (will retry next boot)`,
      );
    }
  };
  runAttachmentBackfill();

  /**
   * The origin policy every CORS decision and the cross-origin write gate
   * read, plus the wrapper that stamps the headers — see
   * request-admission.ts. Composed here because `createIdentitySetup` below
   * takes `policyFor` as an input.
   */
  const { policyFor, applyCors } = createOriginPolicy({
    opts,
    proxiedTrustedHosts,
    proxiedTrustedVerifier,
  });

  // --- Email-keyed identity --- see identity-setup.ts. The roster, the
  // sign-in stores and the four predicates that answer "who is this
  // request" — one module because a session cookie and a widget token name
  // the same session and every liveness rule has to apply to both.
  const {
    identities,
    activityLock,
    emailCodes,
    sessionRevocations,
    codeSender,
    requireEmailAuth,
    requireSignInToWrite,
    accessOnlyBrowserHosts,
    emailCodeSignIn,
    webhookReplayGuard,
    emailSessionKey,
    widgetTokenKey,
    widgetBearerOf,
    widgetTokenIdentityFor,
    clientKeyFor,
    isSecureRequest,
    sessionIdentityFor,
    refreshSession,
  } = createIdentitySetup({
    dataDir,
    opts,
    cookieKey,
    setTaskStoreAgentRoster: (roster) => taskStore.setAgentRoster(roster),
    // Forward reference on purpose: `server` is bound below, and every
    // predicate here is only ever asked during a request.
    requestAddress: (req) => server.requestIP(req)?.address,
    policyFor,
  });

  /**
   * Who may reach this server, over which hostname, and as whom — see
   * request-admission.ts. Built HERE rather than beside the origin policy
   * because `accessOnlyBrowserHosts` comes out of the identity setup just
   * above, and that setup takes `policyFor` as an input: the two halves of
   * this one subject sit on either side of it.
   */
  const { admit } = createRequestAdmission({
    opts,
    j,
    shares,
    sharingGate,
    boardShareTarget,
    cfAccessVerifier,
    staticAccessVerifier,
    collabAccessVerifier,
    shareLinkVerifier,
    proxiedTrustedVerifier,
    accessTunnelHosts,
    proxiedTrustedHosts,
    shareLinkHosts,
    recallCallbackHost,
    accessOnlyBrowserHosts,
    proxiedTrustedEmails,
    shareWorkspacesOf,
    collabMemberOf,
    shareLinkMemberOf,
    redeemShareLink,
    safeDecodeSegment,
    withReviewUrl,
    recallRelay,
    // Forward reference on purpose: `server` is bound below, and the peer
    // address is only ever asked during a request. Same shape, and the same
    // reason, as the identity setup's own `requestAddress` above.
    requestAddress: (req) => server.requestIP(req)?.address,
  });

  /**
   * What an open socket does — see socket-handlers.ts. The partner of the
   * upgrade run: that decides a socket may open and what is stamped on it,
   * this is the trio Bun calls afterwards. Composed with the other factories
   * because all three stores it reads are built above; the stores themselves
   * are passed, never anything read out of them, so every frame sees the
   * state as it is when the frame arrives.
   */
  const socketHandlers = createSocketHandlers({ docStore, meetingRelay, recallRelay });

  /**
   * Whose name goes on a write — see request-attribution.ts. Composed
   * directly below admission because that is the order the two RUN in: the
   * gate proves who the boundary saw, and attribution ranks those proofs
   * against what the body claims. It is the one member of this split that
   * chains rather than composes — its per-request input is the admission
   * result, so it cannot be called until the gate has answered.
   */
  const { attributeRequest } = createRequestAttribution({
    identities,
    taskStore,
    sessionIdentityFor,
    widgetBearerOf,
    widgetTokenIdentityFor,
    j,
  });

  /**
   * Which page or asset an address gets — see routes/shell-static.ts. Composed
   * HERE rather than beside the other helpers because `emailCodeSignIn`
   * comes out of the identity setup just above, and the landing page's
   * counter comes out of the Home pane above that.
   */
  const { serveShellRoutes } = createShellStatic({
    widgetDist,
    markdownAppDist,
    demosDir,
    dataDir,
    docStore,
    taskStore,
    browserSentry,
    emailCodeSignIn,
    j,
    isValidDocId,
    redirectTo,
    resolveWorkspaceForDoc,
    withReviewUrl,
    reviewItemsFor,
    homeQueueTotal,
    defaultBoardWorkspaceName: DEFAULT_BOARD_WORKSPACE_NAME,
  });

  /**
   * The requests that end in a connection rather than a body — see
   * routes/upgrade-stream.ts. Composed HERE because `requireSignInToWrite` comes out
   * of the identity setup above and `policyFor` out of the origin policy
   * above that; everything else it reads is a store built with the rest.
   *
   * `server` is a forward reference, the same shape `requestAddress` uses two
   * blocks down: `Bun.serve` has not returned yet, and it is narrowed to
   * `upgrade` so this module can take a connection over and nothing else.
   */
  /**
   * The agent-stream proof, shared by the three routes that speak it: the
   * mint, the durable watch set, and the multiplexed stream. Derived lazily
   * from the one key file, cached like every other protocol key here.
   */
  let agentTokenKeyCache: string | null = null;
  const agentTokenKeyFor = (): string => {
    agentTokenKeyCache ??= deriveAgentTokenKey(cookieKey());
    return agentTokenKeyCache;
  };
  const requireAgentToken = opts.requireAgentToken ?? false;
  /** One warning per agent id per route for the whole process life. */
  const warnLegacyAgentCaller = createLegacyAgentWarner();

  const { serveUpgradeAndStreamRoutes } = createUpgradeStream({
    server: { upgrade: (req, options) => server.upgrade(req, options) },
    docStore,
    taskStore,
    sse,
    agentWatches,
    watchKeyExists,
    recallRelay,
    policyFor,
    requireSignInToWrite,
    isValidDocId,
    canonicalDocId,
    fileUnderBoardWorkspace,
    j,
    requestAddress: (req) => server.requestIP(req)?.address,
    agentTokenKey: agentTokenKeyFor,
    requireAgentToken,
    warnLegacyAgentCaller,
  });
  /**
   * What the operator routes read instead of this closure's scope. Built
   * once — every collaborator in it is long-lived.
   */
  const opsRoutesCtx: OpsRoutesContext = {
    docStore,
    pluginRefresher,
    deployer,
    pushStore,
    pushNotifier,
    webhookLog,
    j,
    safeJson,
    requestAddress: (req) => server.requestIP(req)?.address,
  };

  /** A review's own files — thread roll-up, grouped diff, tree, lazy opens. */
  const reviewFileRoutesCtx: ReviewFileRoutesContext = { docStore, j, safeJson };

  /** The chat-audit counters — one store, read and written by two routes. */
  const chatAuditRoutesCtx: ChatAuditRoutesContext = { chatAudit, j, safeJson };

  /** Recall's signed webhook — bot status changes and calendar sync events,
   *  which arrive on the same endpoint because webhooks are workspace-level
   *  at the vendor. */
  const recallWebhookRoutesCtx: RecallWebhookRoutesContext = {
    recallRelay,
    calendarSync,
    webhookReplayGuard,
    meetingBotWebhookSecret: opts.meetingBotWebhookSecret,
    j,
  };

  /** The archive family — the four archive/unarchive routes and the
   *  review-only delete the board delete two positions below still calls. */
  const archiveRoutesCtx: ArchiveRoutesContext = {
    docStore,
    taskStore,
    taskProjection,
    dataDir,
    j,
    safeJson,
    unlinkFromEveryBoardWorkspace,
    canonicalDocId,
  };
  const { deleteReview, handleArchiveRoutes } = createArchiveRoutes(archiveRoutesCtx);

  /** What the two agent-id-keyed routes read instead of this closure's
   *  scope — the watch set, the roster and the store a merge moves. */
  const agentIdentityRoutesCtx: AgentIdentityRoutesContext = {
    agentWatches,
    identities,
    taskStore,
    j,
    safeJson,
    requestAddress: (req) => server.requestIP(req)?.address,
    watchKeyExists,
    watchCoverageFor,
    canonicalDocId,
    agentTokenKey: agentTokenKeyFor,
    requireAgentToken,
    warnLegacyAgentCaller,
  };

  /**
   * What the meeting, transcript and calendar routes read instead of this
   * closure's scope. Built once — every collaborator in it is long-lived.
   */
  const meetingCalendarRoutesCtx: MeetingCalendarRoutesContext = {
    docStore,
    taskStore,
    meetingStore,
    meetingRelay,
    recallRelay,
    calendarStore,
    calendarSync,
    calendarBot: opts.calendarBot,
    calendarOauthStates,
    dataDir,
    j,
    isValidDocId,
    fileUnderBoardWorkspace,
  };

  /**
   * What the doc, thread and bind routes read instead of this closure's
   * scope. Built once — every collaborator in it is long-lived.
   */
  const docRoutesCtx: DocRoutesContext = {
    docStore,
    taskStore,
    taskProjection,
    webhooks,
    leadPresence,
    readyNudger,
    threadRequestDedup,
    summarizer,
    dataDir,
    j,
    safeJson,
    ANONYMOUS_ACTOR,
    isValidDocId,
    canonicalDocId,
    backTargetFor,
    resolveWorkspaceForDoc,
    withReviewUrl,
    boardIndexForListing,
    boardsForDocIndexed,
    homeForDocIndexed,
    fileUnderBoardWorkspace,
    unlinkFromEveryBoardWorkspace,
    threadUrl,
    fileReviewRequest,
    judgeThreadReview,
    announceThreadReview,
    recordedThreadHold,
    gateThreadDeclaration,
    heldFields,
    rewriteTaskBody,
    parseRevisedRange,
    workspacesOfDoc: shareWorkspacesOf,
  };

  /**
   * What the sign-in, session and share routes read instead of this closure's
   * scope. Built once — every collaborator in it is long-lived.
   */
  const authShareRoutesCtx: AuthShareRoutesContext = {
    docStore,
    sse,
    taskStore,
    shares,
    shareLinks,
    shareLinkBaseHost,
    sharingGate,
    identities,
    emailCodes,
    sessionRevocations,
    codeSender,
    requireEmailAuth,
    requireSignInToWrite,
    emailCodeSignIn,
    defaultBoardWorkspaceName: DEFAULT_BOARD_WORKSPACE_NAME,
    // The operator allowlist doubles as the audience a `share_link` with no
    // `allowDomains` admits. Same list, same source; see the field's doc.
    defaultShareAudience: [...proxiedTrustedEmails],
    j,
    safeJson,
    clientKeyFor,
    emailSessionKey,
    widgetTokenKey,
    isSecureRequest,
    policyFor,
    sessionIdentityFor,
  };

  /**
   * What the task routes read instead of this closure's scope. Built once —
   * every collaborator in it is long-lived — and handed to the handlers with
   * the per-request half (the URL, the visitor, the author) alongside.
   */
  const taskRoutesCtx: TaskRoutesContext = {
    taskStore,
    taskProjection,
    docStore,
    dispatches,
    agentNotes,
    readyNudger,
    j,
    safeJson,
    ANONYMOUS_ACTOR,
    parseRevisedRange,
    announceTaskReview,
    askBackOnItem,
    boardIndexForListing,
    heldFields,
    holdersClause,
    boardsForDocIndexed,
    judgeReviewItem,
    judgeTaskDecision,
    mergedHold,
    parallelismCapView,
    proposeAllowRule,
    regateDecisionWords,
    rewriteTaskBody,
    workspacesOfDoc: shareWorkspacesOf,
  };
  /**
   * The same split for the workspace routes — see ./routes/workspaces.ts.
   * Built once, for the same reason: every collaborator in it is long-lived,
   * and the per-request half travels with each call.
   */
  const workspaceRoutesCtx: WorkspaceRoutesContext = {
    taskStore,
    taskProjection,
    docStore,
    sse,
    homeBriefs,
    agentWatches,
    voiceRouter,
    dataDir,
    clientReleaseRootDir,
    opts,
    j,
    safeJson,
    isValidDocId,
    externalBaseUrl,
    withReviewUrl,
    homePayload,
    reviewItemsFor,
    parallelismCapView,
    resolveWorkspaceForDoc,
    fileUnderBoardWorkspace,
    unfileFromDefault,
    workspacesOfDoc: shareWorkspacesOf,
    watchKeyExists,
  };

  const server = Bun.serve<UpgradeData>({
    port,
    // Unset means Bun's own default (every interface) — unchanged for every
    // caller but `scripts/staging.ts`, which is the only one that passes a
    // value. See `ServerOptions.hostname` above for why.
    ...(hostname ? { hostname } : {}),
    // Explicit because the DEFAULT is what broke the event streams: Bun's is
    // 10 seconds, the SSE keepalive ran on 20, and so every stream idled out
    // before its own guard could write. Paired with `SSE_KEEPALIVE_MS` and
    // asserted against it in `sse-keepalive.test.ts` — the two numbers only
    // mean anything together. Bun throws above 255.
    //
    // This governs HTTP connections. Websockets take `websocket.idleTimeout`
    // (default 120s) and Bun pings them itself, which is why the `/y/*`
    // editing sockets were never affected — measured idle-surviving 30s on
    // the unfixed build, while SSE died at 9.7s.
    idleTimeout: HTTP_IDLE_TIMEOUT_SEC,
    // `server` is gone from this signature and from `route`'s: the three
    // websocket upgrades were the only things in the route table that read
    // it, and they now reach it through the narrowed forward reference the
    // upgrade-stream factory holds. Bun still passes it; nothing here wants
    // it.
    async fetch(req) {
      const startedAt = performance.now();
      const pathname = new URL(req.url).pathname;
      // A docId-addressed request may HYDRATE that doc, and hydration reads
      // the doc's bound file. That read used to run on the main thread, where
      // a cloud-sync folder that had stopped answering parked the whole
      // server — every route, not just this one (see slow-fs.ts). Doing it
      // here, on the thread pool and under a deadline, means the synchronous
      // hydrate inside the route either finds the bytes already in hand or
      // finds the path quarantined and parks the doc without touching it.
      const prewarmUrl = new URL(req.url);
      const prewarmIds = docIdsAddressedBy(prewarmUrl);
      if (prewarmIds.length > 0) {
        await Promise.all(prewarmIds.map((id) => docStore.prewarmHydration(id)));
      }
      // Server-side Sentry (a no-op passthrough when unconfigured — see
      // sentry.ts): one span per request, named by route PATTERN never raw
      // path, continuing the browser's trace when it sent one so a page load
      // reads end to end. A throw inside `route()` is reported with the same
      // route-pattern context, then rethrown unchanged — this wrapper only
      // observes, it does not change what a request returns.
      let routed: Response | undefined;
      try {
        routed = await withRouteSpan(req, pathname, () => route(req));
      } catch (err) {
        captureServerError(err, { route: routePatternForSpan(pathname), method: req.method });
        throw err;
      }
      // Compress BEFORE the CORS merge so the encoding headers ride out on the
      // same response the wrapper copies; `maybeCompress` skips anything whose
      // content-type isn't on its allowlist (see compress.ts for why that gate
      // is narrow — a live stream must never be buffered to compress it).
      //
      // `maybeNotModified` runs first: when the client already holds the body,
      // gzipping it is the one case where the CPU buys nothing, and a 304 has
      // no body for `maybeCompress` to act on anyway.
      // `undefined` means the request became a websocket — nothing to decorate.
      if (routed === undefined) return undefined;
      const response = applyCors(
        req,
        refreshSession(req, await maybeCompress(req, maybeNotModified(req, routed))),
      );
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= slowRequestMs) {
        // Path only — the query can carry a person's name (`?user=`), and
        // the line is for a grep over durations, not a record of who asked.
        console.error(
          `[timing] ${req.method} ${pathname} ${Math.round(elapsedMs)}ms ` +
            `status=${response.status} bytes=${response.headers.get('content-length') ?? '?'}`,
        );
      }
      return response;

      // Hoisted, so the wrapper above can call it first. The whole route
      // table lives in here unchanged.
      async function route(req: Request): Promise<Response | undefined> {
        const url = new URL(req.url);
        const { pathname } = url;

        // --- CORS preflight ---
        // The canonical embed loads the widget bundle from this server but
        // runs on a different origin (e.g. an Astro dev server on :4321).
        // Every REST call from the widget is therefore cross-origin and
        // browsers preflight non-simple requests (POST + JSON body) with an
        // OPTIONS. Reply once here so we don't have to thread the response
        // through every route handler.
        // The wrapper above attaches the CORS headers when the origin is
        // allowed. A disallowed origin gets a bare 204 with no
        // Access-Control-Allow-* — which is exactly how the browser learns no.
        if (req.method === 'OPTIONS') {
          return new Response(null, { status: 204 });
        }

        // --- Cross-origin WRITE gate ---
        // Withholding CORS headers only hides the RESPONSE. A "simple request"
        // — POST with content-type text/plain — is never preflighted, so the
        // browser sends it and the write lands; the page just can't read the
        // reply. safeJson() parses the body whatever the content-type says, so
        // that was a working CSRF write: post comments as someone else, or
        // create a doc bound to any file on the machine.
        //
        // GET stays open on purpose. Its response is already withheld by CORS,
        // and refusing it would break <script>/<img>-style loads of the widget
        // bundle from arbitrary dev sites (those send no Origin at all).
        if (
          req.method !== 'GET' &&
          req.method !== 'HEAD' &&
          !isAllowedBrowserOrigin(req.headers.get('origin'), policyFor(req))
        ) {
          return j(403, { error: 'origin_not_allowed' });
        }

        // ── Request admission ── see request-admission.ts.
        // The gate ANSWERS this request or hands back what it proved. A
        // refused answer carries no per-request value with it, so nothing
        // below can read a visitor off a request that never got in — the
        // union is what makes that a compile error rather than a review note.
        const gate = await admit(req, { pathname });
        if (!gate.admitted) return gate.response;
        const { visitor, visitorShareId, visitorMemberKey, metaFor } = gate;

        // --- REST: email login ---
        // Reachability (the host gate, Access, a share session) and identity
        // (who you are) stay orthogonal: a local host still bypasses the host
        // guard — it may REACH the server — and still has to say who it is.
        // These routes are what "saying who you are" means.
        //
        // They sit AFTER the host decision on purpose, so a share visitor
        // reaches them only if `shareScopeAllows` lets them, and it does not:
        // a share visitor is already proven by Cloudflare Access, and this is
        // not a second way to claim an identity on a share host.
        // ── Request attribution ── see request-attribution.ts.
        // Chained after admission rather than composed beside it, because its
        // input is what the gate just proved. Called from the position the
        // widget-token gate held — that gate lives inside, and its 401 has to
        // land exactly here. `attributed: false` carries no helpers at all, so
        // no route can name an author on a request whose token was refused.
        const attribution = attributeRequest(req, gate);
        if (!attribution.attributed) return attribution.response;
        const {
          widgetIdentity,
          provenIdentityFor,
          authorFor,
          refuseCategoryAuthor,
          withTaskChips,
          browserProvedNobody,
        } = attribution;

        // --- Sign-in write gate ---
        // Every ordinary write — a comment, a task edit, a review answer, a
        // doc bind — passes through here, because every one of them is a
        // non-GET and every route on this server lives below this line. The
        // predicate is method-keyed rather than a route list on purpose: a
        // list is a thing that silently stops being complete.
        //
        // Reads are untouched, agents are untouched (see write-gate.ts for
        // what tells them apart and what that boundary is worth), and the
        // refusal carries the URL that fixes it — a bare 401 is
        // indistinguishable from a bug, and the client turns this body into
        // a sign-in prompt.
        //
        // Order: below the widget-token gate so a valid token counts as
        // proof, and below the host/Access gates so an Access visitor's
        // verified email is already in hand.
        if (requireSignInToWrite && isGatedWrite(req.method, pathname) && browserProvedNobody()) {
          return j(401, signInRequiredBody());
        }

        // --- Sign-in, session and share links (routes/auth-share.ts) ---
        // Extracted whole and called from the position the block occupied, so
        // nothing above or below it overtakes anything. See that file's header
        // for the two places the order inside it is load-bearing.
        {
          const handled = await handleAuthShareRoutes(authShareRoutesCtx, {
            req,
            url,
            pathname,
            widgetIdentity,
            browserProvedNobody,
            provenIdentityFor,
          });
          if (handled) return handled;
        }

        // --- Recall's bot status-change webhook --- see
        // ./routes/recall-webhook.ts. Called from the position the block
        // held: it must stay IMMEDIATELY above the `/recall/` websocket
        // upgrade below, because that upgrade's own test is
        // `startsWith('/recall/')` and would answer a status POST with the
        // token lookup's 404. That adjacency is behaviour — keep these two
        // adjacent.
        {
          const handled = await handleRecallWebhookRoute(recallWebhookRoutesCtx, {
            req,
            pathname,
          });
          if (handled) return handled;
        }

        // ── Upgrade and stream ── see routes/upgrade-stream.ts.
        // Six blocks that end in a long-lived connection rather than a body:
        // the three websocket upgrades and the three SSE openers. Called from
        // the position the run held, so the `/recall/` upgrade still sits
        // IMMEDIATELY below the status webhook above it — that adjacency is
        // load-bearing and the comment on the webhook says why. Null means no
        // block there claimed this address, which is the same fall-through the
        // run did in place; `upgraded` is the one outcome that must reach Bun
        // as `undefined`, and this is the only place that spells it.
        const streamed = serveUpgradeAndStreamRoutes({
          req,
          url,
          pathname,
          visitor,
          visitorShareId,
          visitorMemberKey,
          browserProvedNobody,
        });
        if (streamed) {
          if (streamed.kind === 'upgraded') return undefined;
          return streamed.response;
        }

        // --- REST: run the summary backfill on request --- see
        // ./routes/ops.ts. Same chain position as before the split: above the
        // metrics route, which is the next call below.
        {
          const handled = await handleSummaryBackfillRoute(opsRoutesCtx, {
            req,
            pathname,
            visitor,
            authorFor,
          });
          if (handled) return handled;
        }

        // --- REST: what this process currently costs ---
        //
        // The 2026-08-29 jetsam kill left nothing to read: the server was at
        // 2.6 GB and the only evidence of how it got there was the absence of
        // the process. `DocStore.stats()` is also written to the log every five
        // minutes; this route is the same numbers on demand, so the NEXT
        // incident can be sampled over time instead of reconstructed.
        //
        // Counts only — no doc ids, no paths, no titles. That is what makes
        // it safe to leave un-gated for anyone already past the front door,
        // and it still refuses a share visitor: an external reviewer invited
        // to one document has no business reading how many others exist.
        {
          const handled = handleOpsMetricsRoute(opsRoutesCtx, {
            req,
            pathname,
            visitor,
            authorFor,
          });
          if (handled) return handled;
        }

        // --- REST: docs, created and listed — ./routes/docs.ts ---
        {
          const handled = await handleDocCreateListRoutes(docRoutesCtx, {
            req,
            url,
            pathname,
            visitor,
            authorFor,
            refuseCategoryAuthor,
            metaFor,
            withTaskChips,
          });
          if (handled) return handled;
        }

        // --- REST: workspaces (the board's own routes) — ./routes/ ---
        // A board is created here, read here, and every field on it is
        // written here: its Home queue, its next-work answer, its settings,
        // its lead, and the docs and huddles filed onto it. They run HERE, in
        // the position they were written in: the chain's order is behaviour,
        // and `routes/workspaces.ts` keeps it.
        {
          const handled = await handleWorkspaceRoutes(workspaceRoutesCtx, {
            req,
            pathname,
            url,
            visitor,
            authorFor,
          });
          if (handled) return handled;
        }

        // --- REST: tasks (plan §3.10) — ./routes/ ---
        // Every handler over there hand-copies body fields into the store
        // call. A field that isn't copied is silently discarded while the
        // request still returns 200 — so every param has an HTTP-level test
        // in task-routes.test.ts (the `groups` lesson). They run HERE, in the
        // position they were written in: the chain's order is behaviour, and
        // `routes/tasks.ts` keeps it.
        {
          const handled = await handleTaskRoutes(taskRoutesCtx, {
            req,
            pathname,
            url,
            visitor,
            authorFor,
            refuseCategoryAuthor,
          });
          if (handled) return handled;
        }
        // --- REST: goal bands and the ordered goal list --- see
        // ./routes/workspace-goals.ts. Same chain position as before the
        // split: below the task routes, above the thread promote.
        {
          const handled = await handleWorkspaceGoalRoutes(workspaceRoutesCtx, {
            req,
            pathname,
            url,
            visitor,
            authorFor,
          });
          if (handled) return handled;
        }
        // --- REST: promote a thread to a task — ./routes/docs.ts ---
        {
          const handled = await handleDocPromoteRoute(docRoutesCtx, {
            req,
            url,
            pathname,
            visitor,
            authorFor,
            refuseCategoryAuthor,
            metaFor,
            withTaskChips,
          });
          if (handled) return handled;
        }
        // --- REST: durable agent watches, and the agent merge --- see
        // ./routes/agent-identity.ts. Same chain position as before the
        // split: after the promote route, before the builder dispatches.
        {
          const handled = await handleAgentIdentityRoutes(agentIdentityRoutesCtx, {
            req,
            pathname,
            visitor,
            authorFor,
          });
          if (handled) return handled;
        }
        // --- REST: builder dispatches, and a session's notes on the row it
        // holds --- see ./routes/dispatch-and-notes.ts. Same chain position
        // as before the split: after the agent merge route, before chat-audit.
        {
          const handled = await handleDispatchAndNoteRoutes(taskRoutesCtx, {
            req,
            pathname,
            url,
            visitor,
            authorFor,
            refuseCategoryAuthor,
          });
          if (handled) return handled;
        }
        // --- REST: chat-audit counters --- see ./routes/chat-audit-routes.ts.
        // Same chain position as before the split: after the builder
        // dispatches, before the operator routes.
        {
          const handled = await handleChatAuditRoutes(chatAuditRoutesCtx, {
            req,
            pathname,
            visitor,
          });
          if (handled) return handled;
        }
        // --- Operator routes: plugin refresh, push and deploy — ./routes/ops.ts ---
        // Same chain position as before the split: after the chat-audit
        // routes, before the agent attachments.
        {
          const handled = await handleOpsRoutes(opsRoutesCtx, {
            req,
            pathname,
            visitor,
            authorFor,
          });
          if (handled) return handled;
        }
        // --- REST: agent attachments (§4) --- see
        // ./routes/workspace-attachments.ts. Same chain position as before
        // the split: after the deploy routes, before the archive pair.
        {
          const handled = await handleWorkspaceAttachmentRoutes(workspaceRoutesCtx, {
            req,
            pathname,
            url,
            visitor,
            authorFor,
          });
          if (handled) return handled;
        }
        // --- REST: archive and unarchive, for a review and for one doc ---
        // see ./routes/archive.ts. Same chain position as before the split:
        // after the agent attachments, before the board delete.
        {
          const handled = await handleArchiveRoutes({ req, pathname, url, visitor });
          if (handled) return handled;
        }
        // --- REST: the board delete --- see ./routes/workspace-delete.ts.
        // It stays BELOW `DELETE /api/reviews/:id`, which is the whole reason
        // that route exists: a board id reaching the review-only verb must
        // answer not-found rather than being destroyed. `deleteReview` rides
        // along on the request because it is built here, not in the context.
        {
          const handled = await handleWorkspaceDeleteRoute(workspaceRoutesCtx, {
            req,
            pathname,
            url,
            visitor,
            authorFor,
            deleteReview,
          });
          if (handled) return handled;
        }
        // --- REST: a review's own files --- see ./routes/review-files.ts.
        // Same chain position as before the split: after the board delete,
        // before the meeting and calendar routes.
        {
          const handled = await handleReviewFileRoutes(reviewFileRoutesCtx, {
            req,
            url,
            pathname,
            visitor,
            metaFor,
            withTaskChips,
          });
          if (handled) return handled;
        }
        // --- Meetings, transcripts and the calendar — ./routes/meetings-calendar.ts ---
        // Called from the position the block occupied: every
        // `/api/docs/<id>/meetings...` pattern has to be tried before the
        // doc catch-all below, which would otherwise swallow all of them.
        {
          const handled = await handleMeetingCalendarRoutes(meetingCalendarRoutesCtx, {
            req,
            url,
            pathname,
            visitor,
          });
          if (handled) return handled;
        }
        // --- REST: one doc and its threads — ./routes/docs.ts ---
        {
          const handled = await handleDocResourceRoutes(docRoutesCtx, {
            req,
            url,
            pathname,
            visitor,
            authorFor,
            refuseCategoryAuthor,
            metaFor,
            withTaskChips,
          });
          if (handled) return handled;
        }

        // --- Web log --- see ./routes/ops.ts. Same chain position as before
        // the split: under the doc resource routes, above the shell tail.
        {
          const handled = handleWebhookLogRoute(opsRoutesCtx, {
            req,
            pathname,
            visitor,
            authorFor,
          });
          if (handled) return handled;
        }

        // ── Shell and static serving ── see routes/shell-static.ts.
        // The tail of the router: an HTML shell, a built asset, a mockup's
        // own file, or a redirect to the address that has one. Null means no
        // block there claimed this address, which is the same fall-through
        // the run did in place, and it lands on the 404 below.
        const shell = serveShellRoutes({ req, url, pathname, visitor });
        if (shell) return shell;

        return new Response('not found', { status: 404 });
      }
    },
    // ── Socket handlers ── see socket-handlers.ts. A19 decided the socket
    // may open and what is stamped on it; this is what Bun calls for the
    // life of that connection. `close` is synchronous on purpose — the
    // drain in `stop` below fires it inside `server.stop(true)`, while the
    // stores its writes land in are still up.
    websocket: socketHandlers,
  });

  // The effort re-scoring pass starts HERE, after the port is bound, not
  // where it is defined. `createServer` THROWS when the port is taken, and
  // `bin.ts` answers by constructing a whole new server on the next port —
  // so a pass kicked off during construction runs once for every attempt,
  // from stores belonging to servers nobody kept, all writing the same data
  // directory. Observed on a dev box where 8788 was already held: two passes
  // over the same 99 rows, and the abandoned one still calling the API.
  // Reaching this line is what makes a server real.
  void rescoreStaleEffortEstimates();

  /**
   * The base every human-facing URL this server emits is built on.
   *
   * One function, so the operator override cannot reach some links and miss
   * others. That is not hypothetical tidiness: the links are the deliverable
   * of a TLS deploy — a `reviewUrl` still pointing at `http://<host>:<port>`
   * sends the reader back to the origin the deploy existed to leave, where
   * the browser refuses the microphone. Missing one call site would look
   * entirely fine until someone pressed the mic on that particular link.
   *
   * A function rather than a captured constant because `server.port` is only
   * known after `Bun.serve` resolves port 0.
   */
  function externalBaseUrl(): string {
    return opts.publicBaseUrl ?? publicBaseUrl(server.port ?? port);
  }

  /**
   * The link an agent hands over after posting a report — the URL that opens
   * where the thread now lives.
   *
   * Measured cost of not having it: 52,340 words — 40% of every word in the
   * user's chat window over 38 hours — were agent-to-agent reports relayed
   * through his terminal rather than posted on the task they belonged to.
   * The rule to post on the task already ships. What did not exist was a
   * cheap way to then TELL a peer where it went: the write succeeded and
   * returned no link, so handing over a pointer meant assembling one from
   * parts against a base URL the agent may not know — while answering in
   * chat cost nothing. This is the same fix `reviewGapAdvice` makes for a
   * thin review item: what the author needs next travels back on the success
   * response, rather than being something they are expected to know.
   *
   * Absolute, unlike `taskDeepLink`'s own relative output, and that
   * difference is the point: the brief renders on the page it points at, but
   * this URL is being pasted somewhere else entirely. It goes through
   * `externalBaseUrl()` for the reason that function exists — one base, so
   * an operator override cannot reach some links and miss others.
   *
   * Covers BOTH surfaces a thread can live on, and the second one is not a
   * nicety: the thread that asked you for something is very often a comment
   * on a markdown attachment, not a task. A version of this that answered
   * only for `task:` docs would hand back nothing on the commonest reply
   * path — reintroducing, one surface over, exactly the friction the whole
   * change exists to remove.
   *
   * OWNER ONLY, and deliberately more conservative than today's sharing
   * needs. Per-doc shares were removed (`POST /api/share/link` answers 410
   * `per_doc_sharing_removed`), so every visitor that can reach this code is
   * workspace-scoped and already holds the id this would tell them — the
   * guard closes no leak that is currently open. It stays because the value
   * is a URL capability and the cost of keeping it owner-only is nil, so the
   * default should already be right on the day doc-scoped visitors come
   * back. Returns undefined for an unknown doc, so callers can spread it.
   */
  function threadUrl(docId: string, isVisitor: boolean): string | undefined {
    if (isVisitor) return undefined;
    if (docId.startsWith('task:')) {
      const workspaceId = taskStore.workspaceOfDoc(docId);
      if (!workspaceId) return undefined;
      const taskId = docId.slice('task:'.length);
      return `${externalBaseUrl()}${taskDeepLink(workspaceId, taskId)}`;
    }
    // Reuse `withReviewUrl` rather than rebuild the /review/ path here: it
    // already branches on doc type (a mockup is not served from /review/),
    // and one builder is the same reason `externalBaseUrl` is one function.
    const meta = docStore.peekMeta(docId);
    return meta ? withReviewUrl(meta).reviewUrl : undefined;
  }

  // Decorate doc metadata with a `reviewUrl` that's actually reachable from
  // other devices on the tailnet / LAN. Markdown docs render at /review/...;
  // mockup docs bound to a file on disk render at /mockup/<docId> — same
  // one-call-one-URL contract as markdown. Mockup docs without a sourceUrl
  // (e.g. dev-server surfaces hosted elsewhere) get no URL — there's nothing
  // for us to serve.
  function withReviewUrl<T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
    /**
     * The doc's board, when the caller already knows it. A LISTING knows it:
     * it resolves every row's board from one shared index (see
     * `homeForDocIndexed`) instead of paying `resolveWorkspaceForDoc`'s
     * per-row scan. `undefined` means "not supplied" and keeps the original
     * behaviour; `null` is a real answer meaning no board holds this doc, so
     * the two cannot be collapsed.
     */
    precomputedHome?: string | null,
  ): T & { reviewUrl?: string } {
    const base = externalBaseUrl();
    // The ONE place a resource URL is minted, which is why the whole fleet's
    // addresses move with this function. A doc is addressed under the
    // workspace holding it; a doc nothing holds keeps the old address, which
    // still answers — better a working legacy URL than a link into a
    // workspace that does not exist.
    const home =
      precomputedHome !== undefined ? precomputedHome : resolveWorkspaceForDoc(meta.docId);
    const ws = home ? `${base}/workspaces/${encodeURIComponent(home)}` : null;
    const id = encodeURIComponent(meta.docId);
    if (contentKind(meta.type) !== 'none') {
      // Every doc kind with server-held content (markdown/code/diff) shares
      // the SPA route; the app branches the editor on the doc's type at boot.
      return { ...meta, reviewUrl: ws ? `${ws}/docs/${id}` : `${base}/review/${id}` };
    }
    if (meta.type === 'mockup' && meta.sourceUrl) {
      return { ...meta, reviewUrl: ws ? `${ws}/mockups/${id}` : `${base}/mockup/${id}` };
    }
    return meta;
  }

  // A share can also lapse without anyone revoking it. Revocation hangs up
  // immediately (see DELETE /api/share/:id); expiry has no such moment, so
  // sweep. 60s means a lapsed visitor keeps their socket for at most a
  // minute — HTTP already refuses them the whole time, so nothing new is
  // reachable, they just haven't been hung up on yet.
  const SHARE_SWEEP_MS = 60_000;
  /** Exactly what the interval does, named so tests drive the real thing
   *  rather than a re-implementation of it. */
  const sweepDeadShares = (): void => {
    if (!shares) return;
    const isLive = (id: string) => shares.findLive(id) !== null;
    docStore.closeSocketsForDeadShares(isLive);
    // Websockets aren't the only long-lived grant — an SSE stream is
    // authorized once at open too, and would otherwise keep delivering
    // comments to a visitor whose share has lapsed.
    sse.closeForDeadShares(isLive);
  };
  const shareSweep = shares
    ? setInterval(() => {
        try {
          sweepDeadShares();
        } catch {
          // A sweep failure must never take the server down with it.
        }
      }, SHARE_SWEEP_MS)
    : null;
  // Never hold the process (or a test runner) open.
  shareSweep?.unref?.();

  // Armed here rather than in bin.ts, because the wake is a property of a
  // running board and not of the production deployment — a staging server
  // or an embedded one should behave the same way. `start` unrefs its own
  // timer, so this can never keep a process alive.
  readyNudger.start();
  stallNudger.start();
  taskScheduler.start(opts.schedulerTickMs ?? undefined);

  // Rows still carrying the removed `parked` state come onto the new spelling
  // for it here — triage, plus a comment holding the date and the reason. See
  // park-migration.ts for why the comment is written before the fields are
  // cleared, and why that makes the pass idempotent.
  //
  // Fired without awaiting and with its own catch: a board that cannot write
  // one comment must still come up. Nothing downstream reads its result, and
  // an unmigrated row simply stays parked until the next start.
  const parkMigration = migrateParkedRows({
    store: taskStore,
    note: (fields, from) =>
      parkNoteText({
        ...(fields.parkedUntil !== undefined ? { until: fields.parkedUntil } : {}),
        ...(fields.parkedReason !== undefined ? { reason: fields.parkedReason } : {}),
        ...(from !== 'triage' ? { from } : {}),
        migrated: true,
      }),
    comment: async (task, text) => {
      taskProjection.ensureTaskBody(task);
      const posted = await docStore.postComment(
        taskBodyDocId(task.id),
        null,
        { ...PARK_MIGRATION_ACTOR, kind: 'known' } as unknown as User,
        text,
        { kind: 'subject' },
        { generate: false },
      );
      return posted !== null;
    },
  })
    .then((res) => {
      if (res.migrated.length > 0) {
        console.log(`[tasks] parked → triage: migrated ${res.migrated.length} row(s)`);
      }
      for (const s of res.skipped) {
        console.error(`[tasks] parked → triage: left ${s.taskId} alone — ${s.reason}`);
      }
      return res;
    })
    .catch((err): ParkMigrationResult => {
      console.error('[tasks] parked → triage migration failed:', err);
      return { migrated: [], skipped: [] };
    });

  return {
    port: server.port ?? port,
    docStore,
    tasks: taskStore,
    projection: taskProjection,
    agentWatches,
    identities,
    dispatches,
    shares,
    sweepDeadShares,
    // Exactly what the interval does, exposed for the same reason
    // `sweepDeadShares` is: a test drives the real thing rather than a
    // re-implementation of it.
    // The startup pass that moved rows off the removed `parked` state, so a
    // test can await the real thing instead of racing it.
    parkMigration,
    nudgeReadyWork: () => readyNudger.tick(),
    // Same contract as `nudgeReadyWork`: a test drives the real loop rather
    // than a re-implementation of what it is believed to do.
    nudgeStalls: () => stallNudger.tick(),
    // Same contract again: a test drives the real scheduler pass and reads
    // back what it fired, rather than re-implementing the loop.
    runScheduler: () => taskScheduler.tick(),
    readyNudgeTally: () => readyNudger.tally(),
    sharingGate,
    webhookLog,
    stop: async () => {
      if (shareSweep) clearInterval(shareSweep);
      // Release before anything else can fail: a lock left behind by a clean
      // shutdown would make the next repair refuse for no reason. It is
      // reclaimed as stale on a crash either way, but only after a pid check
      // somebody has to trust.
      releaseActivityLock(activityLock);
      // Before anything else that tears state down: a tick mid-shutdown
      // would read a store that is being flushed and wake a lead about a
      // server that is going away.
      readyNudger.stop();
      stallNudger.stop();
      taskScheduler.stop();
      leadPresence.stop();
      // The boot re-scoring pass runs for as long as there are stale rows, so
      // a short-lived server (every test) can still be mid-loop here. Setting
      // the flag is enough: the loop checks it either side of each call, so
      // it stops before the next write rather than being torn out mid-write.
      stopEffortRescore();
      // Close the worktree watchers with the loop that read them; the
      // persisted dispatch set survives for the next process to re-arm.
      dispatches.stop();
      uptimeMonitor.stop();
      // The sockets come down HERE, not at the end. `stop(true)` force-closes
      // every open connection instead of leaving keep-alive HTTP and
      // websockets to drain — without it each server this process ever
      // started keeps its sockets to the grave (measured 2026-08-30: +733
      // kernel PCBs per server-suite run, and a machine-wide ENOBUFS at the
      // end of a night of them).
      //
      // Force-closing fires every `close(ws)` handler SYNCHRONOUSLY inside
      // this call, and those handlers write: a meeting's flushes its last
      // sentence into the doc. So they have to run while the subsystems
      // below are still live — after `docStore.flush()` that write would have
      // nowhere left to land.
      server.stop(true);
      // Close the books on any live meeting, so a restart never finds a doc
      // marked as recording by a socket that died with the process. Awaited
      // because the close handlers above start their teardowns async, and
      // their notes belong in the rooms this flushes next.
      await meetingRelay.dispose();
      // And the bots. A bot left in a call after this process is gone bills
      // two vendors and delivers nothing — see RecallMeetingRelay.dispose.
      await recallRelay.dispose();
      // Flush pending body snapshots into the store BEFORE the store's own
      // flush, so the last keystrokes in a task body reach the sidecar.
      taskProjection.stop();
      // Flush pending sidecar writes so a clean shutdown never loses board
      // state that was still inside the debounce window.
      taskStore.stop();
      // Same contract for the docs themselves: run the rooms' pending 200ms
      // .ydoc saves and ~800ms bound-file write-backs. SIGTERM reaches here
      // via bin.ts, and before this call it lost exactly as much just-typed
      // content as SIGKILL (measured 0/100 kept on a burst killed 103ms
      // after the last keystroke, on both signals).
      // Stop the sweeps BEFORE flushing: an eviction landing mid-flush would
      // drop a room the flush is about to write.
      docStore.stop();
      docStore.flush();
      // Hand the next process each channel's final event id. Without it every
      // subscriber's cursor is unrecognisable after the restart and every
      // stream opens with a `replay.gap` that has nothing behind it.
      saveReplayMarks(dataDir, sse.marks());
    },
  };
}

/**
 * Every docId a request might address, from anywhere in its URL.
 *
 * This used to be a list of five path prefixes, and the list was the bug: it
 * covered `/events/`, `/y/`, `/review/`, `/audio/` and `/mockup/` while the
 * canonical `/workspaces/<ws>/docs/<docId>` address and every `/api` route
 * that names a doc in its path went the unprewarmed way and hydrated on the
 * main thread. A prefix list also has to be maintained: a route added later
 * is silently uncovered, and nothing fails until a bound file stops
 * answering.
 *
 * So this walks the path instead of matching the front of it. Every segment
 * that could be a docId is offered to the prewarm, which looks each one up in
 * the doc index and does nothing for the ones it does not know — so a
 * workspace slug or a verb like `archive` costs a Map lookup and no syscall.
 * Being liberal here is safe in exactly the way being conservative was not:
 * an extra candidate reads a file the request was likely to read anyway, a
 * missing one puts a blocking read back on the main thread.
 *
 * There is no body-reading companion to this, and there was briefly: a
 * function that pulled `docId` out of a JSON body for the routes that address
 * a doc there rather than in the URL. It could never run. `isValidDocId`
 * accepts any ordinary URL-safe word, so `api` and `docs` are candidates and
 * the list this returns is empty only for `/` itself. Those body-addressed
 * routes are the bind and attach pair, and they are covered where it
 * actually holds — they call `attachFileAsync`, which does its own pooled
 * read before it touches the doc.
 */
function docIdsAddressedBy(url: URL): string[] {
  const found: string[] = [];
  const add = (raw: string | null | undefined): void => {
    if (!raw) return;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return;
    }
    // `/mockup/<docId>.html` is the one address that carries an extension.
    const bare = decoded.replace(/\.html?$/i, '');
    if (!isValidDocId(bare) || found.includes(bare)) return;
    found.push(bare);
  };
  for (const segment of url.pathname.split('/')) add(segment);
  add(url.searchParams.get('docId'));
  return found;
}

function isValidDocId(s: string): boolean {
  // Allow a reasonable set of URL-safe chars. Disallow leading dot so IDs
  // can't masquerade as hidden files on disk. Length cap protects the
  // filename from being pathological. `~` is permitted because workspace
  // member docIds encode the relPath's `/` separators as `~`
  // (`${workspaceId}:${relPath.replaceAll('/', '~')}` in doc-store.ts), so any
  // file in a subdirectory of a bound folder needs `~` to be reachable via
  // the /api/docs/:docId routes. `~` is RFC 3986 unreserved (URL-safe) and a
  // valid filename char, matching the .ydoc-on-disk naming.
  if (!s || s.startsWith('.')) return false;
  return /^[a-zA-Z0-9_.:~\-]{1,100}$/.test(s);
}

function j(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    // CORS is added by the per-request wrapper in createServer, which knows
    // the Origin. This used to stamp a wildcard `*` origin on every reply.
    headers: { 'content-type': 'application/json' },
  });
}

// The canonical embed loads the widget bundle from this server but runs the
// host page on a different origin (e.g. an Astro dev server on a different
// port). Every REST call from the widget is therefore cross-origin and needs
// CORS. The widget posts comments without credentials (auth is via the
// request body's `author` field, not cookies), so `*` is safe and avoids
// the per-request-Origin echo dance.
async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
