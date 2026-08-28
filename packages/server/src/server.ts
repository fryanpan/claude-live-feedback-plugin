import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import {
  type Anchor,
  type DocMeta,
  type DocType,
  type ReviewPayload,
  type TaskReviewItem,
  type Thread,
  type User,
  type WebhookPayload,
  agentIdCandidates,
  anchors,
  answerFromReply,
  checkReviewPayload,
  contentKind,
  emailIdentityId,
  isEmailLike,
  pendingDeclaration,
  readReviewPayload,
  reviewGapAdvice,
  reviewIdOf,
  reviewPayloadMessage,
  suggestOps,
  summaryHash,
} from '@feedback/core';
import { needsCall } from '@feedback/core/summary-prompt';
import type { Server as BunServer } from 'bun';
import { acquireActivityLock, releaseActivityLock } from './activity-lock.ts';
import { classifyActor, registerOwnerIdentity } from './activity.ts';
import {
  AgentWatches,
  SHARED_AGENT_IDS,
  SHARED_IDENTITY_ERROR,
  SHARED_IDENTITY_MESSAGE,
  isValidAgentId,
  isValidWatchKey,
} from './agent-watches.ts';
import { ARTIFACT_CHECK_ACTOR, ArtifactChecker } from './artifact-check.ts';
import { type CodeSender, createLogCodeSender } from './auth/code-sender.ts';
import { CODE_TTL_MS, EmailCodes } from './auth/email-code.ts';
import {
  SESSION_COOKIE,
  clearedSessionCookieHeader,
  sessionKey as deriveSessionKey,
  sessionCookieHeader as emailSessionCookieHeader,
  mintSession,
  sessionNeedsRefresh,
  verifySession as verifyEmailSession,
} from './auth/session.ts';
import { ChatAudit, isSharedAgentName, localDay } from './chat-audit.ts';
import { clientReleaseStatus } from './client-release.ts';
import { maybeCompress, maybeNotModified } from './compress.ts';
import type { Deployer } from './deploy.ts';
import { RESERVED_DOC_PREFIXES } from './doc-ids.ts';
import { showFile } from './git-diff.ts';
import {
  type BriefCoverage,
  type BriefInput,
  HomeBriefStore,
  acceptBrief,
  briefCoverage,
  briefEvents,
  briefIsFresh,
  buildBriefPrompt,
  deterministicBrief,
  effectiveSince,
  readEventRows,
  readerKey,
  taskDeepLink,
} from './home-brief.ts';
import { Identities, type IdentityRecord, userForIdentity } from './identities.ts';
import { loadIdentityLinks } from './identity-links.ts';
import {
  type LandingModel,
  type LandingProjectLink,
  type LandingWorkspaceInput,
  type LandingWorkspaceRow,
  buildLandingModel,
} from './landing.ts';
import { linkTitlesFor } from './link-titles.ts';
import { withServerNotesSinks } from './meeting-notes-doc.ts';
import type { MeetingNotesOptions } from './meeting-notes.ts';
import { MeetingRelay } from './meeting-protocol.ts';
import { MeetingStore } from './meetings.ts';
import {
  LOOPBACK_HOSTS,
  corsHeadersFor,
  isAllowedBrowserOrigin,
} from './middleware/browser-origin.ts';
import { type CfAccessOptions, createCfAccessVerifier } from './middleware/cf-access.ts';
import { clientAddressKey } from './middleware/client-address.ts';
import {
  type ShareTarget,
  classifyHost,
  collabScope,
  isLoopbackAddress,
  isTrustedLocalHost,
  shareScopeAllows,
} from './middleware/host-guard.ts';
import { injectWidget } from './mockup-widget.ts';
import {
  PARK_MIGRATION_ACTOR,
  type ParkMigrationResult,
  migrateParkedRows,
} from './park-migration.ts';
import { parkNoteText } from './park-note.ts';
import type { PluginRefresher } from './plugin-refresh.ts';
import { agentsBehind, checkableAttachments, readReleasedPluginVersion } from './plugin-release.ts';
import { localHostnames, publicBaseUrl } from './public-host.ts';
import { type PushFetch, PushNotifier, reviewItemNotification } from './push-notify.ts';
import { PushStore, loadOrCreateVapidKeys } from './push-store.ts';
import { evaluateReadyWork } from './ready-gate.ts';
import {
  type NudgeTally,
  READY_IDLE_DEFAULT_MS,
  READY_NUDGE_STAMP_FILENAME,
  ReadyWorkNudger,
  type ReadyWorkSnapshot,
} from './ready-nudge.ts';
import { listArchivedDocs, listArchivedReviews, readDocArchiveManifest } from './review-archive.ts';
import { backfillReviewFiling } from './review-backfill.ts';
import { type ReviewItemRow, type ReviewThreadItem, reviewItemRows } from './review-queue.ts';
import { type FeedbackWs, Rooms, type WorkspaceDirNode, type WorkspaceFileNode } from './rooms.ts';
import { isWithinRoot } from './safe-path.ts';
import { CfApi } from './share/cf-api.ts';
import {
  SHARE_COOKIE,
  loadCookieKey,
  readCookie,
  sessionCookieHeader,
  verifySession,
} from './share/link-session.ts';
import { redactHubEventForVisitor } from './share/redact-hub-events.ts';
import {
  redactMetaForVisitor,
  redactWorkspaceFilesForVisitor,
  redactWorkspaceTreeForVisitor,
  relativeReviewUrl,
} from './share/redact-meta.ts';
import { Shares } from './share/shares.ts';
import { SharingGate } from './share/sharing-gate.ts';
import type { Share, ShareConfig } from './share/types.ts';
import { sanitizeVisitorAuthor } from './share/visitor-identity.ts';
import { claimReplayMarks, saveReplayMarks } from './sse-marks.ts';
import { HTTP_IDLE_TIMEOUT_SEC, SseHub, openSseStream } from './sse.ts';
import { type StallVerdict, evaluateStalls } from './stall-gate.ts';
import { STALL_NUDGE_STAMP_FILENAME, StallNudger, type StallSnapshot } from './stall-nudge.ts';
import { KEYCHAIN_SERVICE, ThreadSummarizer } from './summarize.ts';
import { indexBatchKeys, resolveRowRefs } from './task-batch-refs.ts';
import {
  BAD_OPTIONS_ERROR,
  BAD_REF_ERROR,
  createdVisibility,
  parseLinks,
  parseNeeds,
  parseOptions,
  parseTaskCreate,
} from './task-create.ts';
import { applyImport, importBanner, importMarkerFor, parseTrackerMarkdown } from './task-import.ts';
import {
  ASSIGNEE_REQUIRED_ERROR,
  ASSIGNEE_REQUIRED_HANDOVER_MESSAGE,
  ASSIGNEE_REQUIRED_MESSAGE,
  BAD_ASSIGNEE_KIND_ERROR,
  BAD_ASSIGNEE_KIND_MESSAGE,
  parseAssigneeKind,
  resolveAssignee,
} from './task-owner.ts';
import { TaskProjection, taskBodyDocId, taskIdOfBodyDoc } from './task-projection.ts';
import { buildQueue, placeableGoals, summarizeGoals } from './task-queue.ts';
import { clipToWordBoundary } from './task-title.ts';
import {
  type GoalListEntry,
  type HubWorkspace,
  LEGACY_REVIEW_ITEM_ID,
  type Task,
  type TaskStatus,
  TaskStore,
  eventsLogPath,
  flattenGoals,
  isAttachmentRuntime,
  isRetired,
  isValidRef,
  retiredNotice,
  retiredRefusal,
  taskChip,
} from './tasks.ts';
import type { TranscriptionEngine } from './transcribe.ts';
import { SERVER_TICK_EVENT, UptimeMonitor, analyzeUptime } from './uptime.ts';
import { type VoiceComplete, VoiceRouter, parseVoiceContext } from './voice.ts';
import { type WebhookLogEntry, createWebhookDispatcher } from './webhooks.ts';
import { onClose, onMessage, onOpen } from './yjs-protocol.ts';

const DEFAULT_PORT = Number(process.env.PORT ?? 8787);

/** Rows one `POST /tasks/batch` will take. A burst out of a conversation is
 *  single digits; a hundred is a tracker, and that has its own import path. */
const MAX_BATCH_TASKS = 100;

/**
 * Structural validation for PUT /api/workspaces/:id/goals. Returns the
 * sanitized list, or null if any entry is malformed. Unknown keys are
 * dropped rather than persisted — the sidecar shape is a contract, not a
 * junk drawer. ONE subgoal level max (§3.2); a subgoal with subgoals is
 * malformed, not silently flattened.
 *
 * `id` is OPTIONAL and that is the create/keep switch (see `GoalListEntry`):
 * omitted means "create this band, mint me an id", present means "the band
 * you already have with this id". A present-but-empty id is still malformed —
 * it is a caller trying to say something, not a caller omitting the key, and
 * reading it as "create" would turn a bug into a silent new band.
 */
function parseGoalList(raw: unknown): GoalListEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const goals: GoalListEntry[] = [];
  for (const entry of raw) {
    const g = entry as Record<string, unknown>;
    if (g?.id !== undefined && (typeof g.id !== 'string' || g.id.length === 0)) return null;
    if (typeof g?.title !== 'string' || g.title.length === 0) return null;
    if (g.dueAt !== undefined && typeof g.dueAt !== 'number') return null;
    let subgoals: Array<{ id?: string; title: string; dueAt?: number }> | undefined;
    if (g.subgoals !== undefined) {
      if (!Array.isArray(g.subgoals)) return null;
      subgoals = [];
      for (const sub of g.subgoals) {
        const s = sub as Record<string, unknown>;
        if (s?.id !== undefined && (typeof s.id !== 'string' || s.id.length === 0)) return null;
        if (typeof s?.title !== 'string' || s.title.length === 0) return null;
        if (s.dueAt !== undefined && typeof s.dueAt !== 'number') return null;
        if (s.subgoals !== undefined) return null;
        subgoals.push({
          ...(s.id !== undefined ? { id: s.id as string } : {}),
          title: s.title,
          ...(s.dueAt !== undefined ? { dueAt: s.dueAt as number } : {}),
        });
      }
    }
    goals.push({
      ...(g.id !== undefined ? { id: g.id as string } : {}),
      title: g.title,
      ...(g.dueAt !== undefined ? { dueAt: g.dueAt as number } : {}),
      ...(subgoals !== undefined ? { subgoals } : {}),
    });
  }
  return goals;
}

/**
 * The one doc every hub's feedback widget writes to.
 *
 * Deliberately NOT per-workspace: a comment on the hub UI is about the
 * product, so it should reach the same agent from every hub rather than
 * whoever happens to own the workspace you were standing in. The anchor's
 * url carries which hub it came from.
 */
export const HUB_FEEDBACK_DOC_ID = 'lf-hub-feedback';

/**
 * The refusal a share route gives when handed a GROUPING id.
 *
 * A BOARD is the unit of sharing (Bryan, 2026-08-17: "Workspace only — a
 * review must be filed on a board before it can be shared"). A folder bind
 * and a diff review are reviews: they hold member docs, but they are not
 * boards, and until this they could each be shared on their own.
 *
 * 410 rather than 404 because the id is real and the caller is not wrong
 * about it — the capability is what went away. Older peers keep calling the
 * shared server with the payload THEIR bundle sends long after this one
 * stopped sending it, and a review id arrives in the same `workspaceId`
 * field a board id does, so a bare 404 would read as "your review vanished".
 * The hint has to name the replacement or the reply is just a wall.
 */
const GROUPING_SHARING_REMOVED = {
  error: 'grouping_sharing_removed',
  hint: 'A board is the unit of sharing. A folder bind or diff review cannot be shared on its own — file it on a board and share the board instead. Use the hubWorkspaceId that create_diff_review / bind_folder returns, or make a fresh board with create_workspace.',
} as const;

/**
 * The refusal a share route gives when handed the UNFILED board.
 *
 * Decided on the board: refuse. The Unfiled board is where every review
 * created WITHOUT naming a board lands — one shared catch-all for every
 * agent's strays. Sharing it would hand a visitor every stray review from
 * everyone, so the mint routes refuse it outright.
 *
 * 403 rather than 410: nothing was removed — the board exists and the route
 * works — this share is simply never allowed. The hint has to name the fix,
 * because the caller usually got here by binding without a hubWorkspaceId
 * and then sharing whatever id came back.
 */
const UNFILED_SHARING_REFUSED = {
  error: 'unfiled_board_not_shareable',
  hint: 'The Unfiled board collects every review bound without a board, from every agent — sharing it would share them all. So: file the review on a real board first, then share that board. Pass hubWorkspaceId when you bind (create_diff_review / bind_folder), or make a board with create_workspace and attach_doc the review to it.',
} as const;

/** The anchor's display snippet, whichever anchor kind carries it — an
 *  orphan keeps its original's snippet. */
function anchorSnippetText(anchor: Anchor): string | undefined {
  if (anchor.kind === 'subject') return undefined;
  if (anchor.kind === 'orphan') {
    return anchor.original.snippet?.text;
  }
  return anchor.snippet?.text;
}

/**
 * A comment's optional Review Item declaration, checked at the door.
 *
 * Every route that writes a comment calls this, because a payload that gets
 * past one of them is stored in the CRDT and renders on Bryan's Home queue
 * with a headline that does not fit two lines on a phone — which is the
 * defect the whole feature exists to remove, re-created by the feature.
 *
 * **Refuse rather than truncate.** Clipping a long headline is exactly what
 * produced the "titles are random detailed text" rows this replaces, and it
 * teaches the author nothing: the call returns 200, the row looks wrong, and
 * nobody connects the two. A 400 quoting every problem lands in a retrying
 * model's context, where it can be acted on.
 *
 * Returns `undefined` for an absent declaration — an ordinary comment is
 * still an ordinary comment, and the overwhelming majority are.
 *
 * `advice` is the non-refusing half: a payload that filed successfully but
 * left the card thin. It rides back on the 200 rather than being dropped
 * here, because an author who is never told writes the same thin item again.
 *
 * `text` is the comment the declaration arrived on. The checker needs it to
 * see a card whose links stayed behind in the comment — the reader acts from
 * the Home card, and the comment is not on it.
 */
function reviewFromBody(
  raw: unknown,
  text?: string,
): { ok: true; review?: ReviewPayload; advice?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  const check = checkReviewPayload(raw, { text });
  if (!check.ok) return { ok: false, error: reviewPayloadMessage(check) };
  const advice = reviewGapAdvice(check.gaps);
  // Stored via the reader so the agent-facing spellings (`review_type`,
  // 'question') land in the stored vocabulary and junk keys never persist.
  const review = readReviewPayload(raw);
  if (!review) return { ok: false, error: reviewPayloadMessage(check) };
  return { ok: true, review, ...(advice ? { advice } : {}) };
}

/** Attribution for a write that arrived with no author at all. Deliberately
 *  NOT Bryan: an unattributed action must never gain his authority just
 *  because a field was missing. */
const ANONYMOUS_ACTOR: User = {
  id: 'anon-unattributed',
  name: 'Anonymous',
  kind: 'anon',
  color: '#8a8a8a',
};

export interface ServerOptions {
  /**
   * CW_SHARING_DISABLED was set: external sharing starts OFF and the runtime
   * toggle refuses to reopen it. The switch to reach for while a security
   * review is in flight — nothing this process exposes can undo it.
   */
  sharingEnvLocked?: boolean;
  port?: number;
  dataDir?: string;
  /**
   * Email-keyed identity is IN EFFECT (`CW_REQUIRE_EMAIL_AUTH`). Default off,
   * and off means byte-for-byte today's behaviour.
   *
   * What the flag gates is the EFFECT of a session on authorship: with it
   * off, a request carrying a verified session cookie is attributed exactly
   * as it is attributed today — from the body, or through the guest
   * sanitizer. With it on, the server's own verdict outranks the claimed
   * body.
   *
   * What the flag deliberately does NOT gate is the `/api/auth/*` routes
   * themselves. They are additive — nothing today calls them, so a request
   * that never calls them is unchanged either way — and leaving them mounted
   * is what lets the login flow be exercised on a real deployment before the
   * switch is thrown. Minting a session changes nothing by itself.
   *
   * A request with NO session cookie behaves exactly as it does today,
   * whichever way the flag is set.
   */
  requireEmailAuth?: boolean;
  /**
   * Sentry DSN for the BROWSER apps (`CW_SENTRY_DSN`). Server config on the
   * box, never the public repo: a DSN is a public client key, but committing
   * it invites drive-by event spam and couples the repo to one org. Reaches
   * the browser as a meta tag in the served shells; absent means the client
   * never loads the Sentry SDK at all.
   */
  sentryDsn?: string;
  /**
   * The address whose email identity is the fleet OWNER (`CW_OWNER_EMAIL`).
   *
   * `isOwnerActor` is otherwise hardcoded to the two spellings that predate
   * email identity, and the moment the owner's identity becomes `user-<hash>`
   * that check stops matching and fails SILENTLY — no error, just an
   * owner-activity view that quietly reads empty. This is the input that
   * keeps it matching. See activity.ts.
   */
  ownerEmail?: string;
  /**
   * Delivers login codes. Defaults to the log sender — the code prints to the
   * server log, which is what makes the flow exercisable end to end before a
   * provider is picked. A sender that rejects becomes a 502, never a silent
   * 200. See auth/code-sender.ts.
   */
  codeSender?: CodeSender;
  /**
   * How long an attachment stays `live` without a heartbeat (default five
   * minutes, `HEARTBEAT_FRESH_MS`). A test seam: the whole away-lead half of
   * this server is unreachable otherwise, since a test cannot sleep five
   * minutes and asserting on `attachmentState` in isolation does not exercise
   * the routes that read it.
   */
  heartbeatFreshMs?: number;
  /**
   * How recently the server must have OBSERVED an agent for a delivery to
   * count as reaching it (default `OBSERVED_LIVE_MS`, fifteen minutes). The
   * separate seam matters: this is the window the coverage read and every
   * delivery gate actually test, and it is three times the heartbeat one, so
   * a test that shrinks only `heartbeatFreshMs` never leaves the live window
   * at all.
   */
  observedWorkFreshMs?: number;
  /**
   * Runs `claude plugin update` on this machine when a peer asks. Absent by
   * default and constructed in ONE place (bin.ts), so nothing that merely
   * spins a server up — every test, every embedded use — can mutate this
   * machine's plugin cache. Same seam rule as `summarizer`; here it also
   * means a CI run can never trigger a deploy.
   */
  pluginRefresher?: PluginRefresher;
  /**
   * Pulls this deployment's deploy source and restarts the service — as one
   * operation, because a restart over an unpulled checkout republishes the
   * same client and reports success. See deploy.ts.
   *
   * Absent by default and constructed in ONE place (bin.ts, behind a flag
   * only `scripts/serve.ts --no-watch` passes), so no test, no embedded
   * server and no `bun run staging` can pull or restart the fleet's server.
   * Same seam rule as `pluginRefresher`, and load-bearing twice over here:
   * this one writes to a git checkout.
   */
  deployer?: Deployer;
  /**
   * The client release root this deployment publishes into (see
   * client-release.ts), enabling the "your browser is running an old client"
   * signal on the board.
   *
   * Set in ONE place — scripts/serve.ts --no-watch, via bin.ts — because only
   * the process that PUBLISHES a release may report on it. `bun run dev` and
   * `bun run staging` serve their own checkout's dist while sharing this
   * machine's default release root, so reading it there would report prod's
   * deploy state on a server that is not serving prod's client. Same seam
   * rule as `pluginRefresher`.
   */
  clientReleaseRootDir?: string | null;
  /**
   * How far a description may lag the newest note on its task before the
   * work queue says so (see task-staleness.ts). Defaults to
   * `PREMISE_STALE_AFTER_MS`.
   *
   * Overridable because the arming rule is a comparison against wall-clock
   * gaps of DAYS, and a test cannot wait for one: the alternative is
   * backdating a task through a route built for it, which would add a
   * production surface whose only caller is a test.
   */
  premiseStaleAfterMs?: number;
  /**
   * How long ready, agent-owned work may sit untouched before the board
   * wakes its lead agent (default `READY_IDLE_DEFAULT_MS`, fifteen minutes;
   * `CW_READY_NUDGE_MINUTES` sets it on the box). A test seam for the same
   * reason `observedWorkFreshMs` is one — the whole feature is a comparison
   * against a wall-clock gap a test cannot wait out.
   */
  readyNudgeIdleMs?: number;
  /**
   * How long a row may go untouched before the board tells its lead it has
   * stalled (default `STALL_QUIET_DEFAULT_MS`, twenty minutes;
   * `CW_STALL_NUDGE_MINUTES` sets it on the box). A test seam for the same
   * reason `readyNudgeIdleMs` is one — the feature is a comparison against a
   * wall-clock gap no test can wait out.
   */
  stallNudgeQuietMs?: number;
  /**
   * How long a row must stay stalled before the wake says it AGAIN (default
   * `STALL_REPEAT_DEFAULT_MS`, four hours; `CW_STALL_REPEAT_HOURS` sets it on
   * the box).
   *
   * This was a test seam only, on the reasoning that escalation cadence is a
   * product decision rather than a deployment one. That was wrong about the
   * cost: a wake is not a notification, it is a lead session's whole turn, so
   * this number sets the standing token floor a fleet pays for boards where
   * nothing is changing. That floor has to be tunable at the speed a bill
   * arrives, which is faster than a release.
   *
   * Retuning it re-bills each board at most one wake, because the repeat
   * window is the divisor behind the arming stamp — a new value lands every
   * board in a different bucket exactly once. Expect that one-off on the tick
   * after a change and do not read it as a rate.
   */
  stallNudgeRepeatMs?: number;
  /** Stands in for the done-artifact check's GitHub lookup. Tests only —
   *  production asks api.github.com, unauthenticated. */
  artifactCheckFetch?: typeof fetch;
  /** Per-link budget for that check (default 5s). Tests only. */
  artifactCheckTimeoutMs?: number;
  /** Absolute path to the built widget dist dir, or null to skip. */
  widgetDistDir?: string | null;
  /** Absolute path to the built markdown-app dist dir. */
  markdownAppDistDir?: string | null;
  /** Absolute path to the demos dir (static HTML). */
  demosDir?: string | null;
  /**
   * Stands in for the call to the push service. Tests only.
   *
   * The seam exists because the link it covers is the one that cannot be
   * checked any other way: every unit around it can pass while nothing ever
   * calls the notifier, and the symptom of that is a notification nobody is
   * waiting for and so nobody misses.
   */
  pushFetch?: PushFetch;
  /**
   * Extra hostnames treated as LOCAL (bypass the host gate) beyond loopback,
   * the tailnet name, and this machine's LAN names. Requests arriving on any
   * other hostname are denied unless an active share owns that hostname —
   * see middleware/host-guard.ts. Tests use this to simulate a local caller.
   */
  trustedHosts?: string[];
  /**
   * Hostnames served through the Cloudflare tunnel that may reach the
   * COLLABORATION surface — the share surface, for whichever workspace the
   * path names — once Cloudflare Access has authenticated the visitor.
   *
   * A second list rather than a widening of `trustedHosts`, because the two
   * grant different things: a trusted host is another name for this machine
   * and classifies `local` (the whole product, unauthenticated), while an
   * entry here is a public address and classifies `collab` (Access token
   * required, share scope enforced, every operator verb refused). The
   * `cf-ray` veto that keeps a proxied request out of `local` is untouched.
   *
   * IGNORED unless `cfAccess` is configured with a static audience — see
   * `collabAccessVerifier` below. An opt-in host with no Access application
   * in front of it would be the whole API exposed to anyone who can reach the
   * tunnel, so the list fails closed rather than open.
   */
  accessTunnelHosts?: string[];
  /**
   * Browser origins allowed to call the API cross-origin, beyond the server's
   * own origin and loopback (which the widget on a dev server needs). Matched
   * exactly. Anything else gets no CORS headers, so the browser blocks it —
   * see middleware/browser-origin.ts.
   */
  allowedOrigins?: string[];
  /**
   * The external base URL this deployment is reached on, when something in
   * front terminates TLS (`tailscale serve` → this process on loopback).
   * Already normalized — bin.ts runs `normalizePublicBaseUrl` on
   * `LF_PUBLIC_BASE_URL` at boot so a typo fails there rather than here.
   *
   * Every human-facing URL the server emits (`reviewUrl`, `entryUrl`, the
   * import banner's `hubUrl`) is built from this when set. Unset — the
   * default, and every test that doesn't care — falls back to
   * `http://<discovered host>:<port>`, which is what a server with nothing
   * in front of it is actually reachable on.
   */
  publicBaseUrl?: string;
  /**
   * Cloudflare Access JWT verification config. When set, every non-OPTIONS
   * request must carry a valid `Cf-Access-Jwt-Assertion` header (or
   * `CF_Authorization` cookie) signed by the team's JWKS and matching the
   * given audience. When unset, the server runs unauthenticated — local
   * dev / Tailscale-only use is unchanged.
   *
   * When `share` is also set, the verifier only gates requests whose
   * Host header matches an active share — Tailscale traffic to the
   * canonical hostname stays unauthenticated.
   */
  cfAccess?: CfAccessOptions;
  /**
   * Cloudflare Access share machinery. When set, the server exposes
   * /api/share routes for creating/listing/revoking shares, instantiates
   * a CfApi client (uses `cfApi` directly if provided, else builds one
   * from `cfApiToken`), and wires the cf-access middleware's audience to
   * the shares registry so each share's hostname gets its own AUD.
   */
  share?: {
    config: ShareConfig;
    cfApiToken?: string;
    cfApi?: CfApi;
  };
  /**
   * Thread summarizer. **No default.** Omitting it leaves generation off
   * entirely: every card falls back to its deterministic lines and the
   * on-demand route answers 503.
   *
   * It used to default to `new ThreadSummarizer()`, which resolves the real
   * Keychain key and the real global `fetch` — so every one of the 40-odd
   * server test files that creates a thread fired a live, billed
   * api.anthropic.com call three seconds later, carrying its fixture comment
   * text off the machine. Measured: 21 outbound calls across one
   * `bun run test:server`, with the suite green throughout, because the
   * scheduled path is fire-and-forget. The only caller that should have a
   * summarizer is the one that starts the real server (`bin.ts`), so it is
   * the one that constructs it.
   */
  summarizer?: ThreadSummarizer;
  /**
   * Voice fast-path completer (§3.8). **No default**, same seam rule as the
   * summarizer above: omitting it disables the Haiku fast path entirely —
   * every voice utterance still gets an answer, routed to the attached agent
   * — and nothing that merely spins a server up can reach the network. Only
   * bin.ts constructs the real one (`haikuVoiceComplete`).
   */
  voiceComplete?: VoiceComplete;
  /**
   * Live-meeting transcription engine. **No default**, the same seam rule as
   * the summarizer and the voice completer above — and with the largest bill
   * of the three attached, because a streaming session is charged by the
   * minute for as long as a socket stays open. Omitting it makes
   * `/audio/<docId>` answer `unavailable` with reason `not_configured`, which
   * is a state the strip renders rather than a failure. Only `bin.ts`
   * constructs a real one (`createAssemblyAiEngine`).
   */
  transcription?: TranscriptionEngine;
  /**
   * Pause-driven meeting notes: composer, quiet threshold, optionally an
   * observing sink. **No default**, same seam rule as `transcription`
   * directly above — the real composer is an LLM call, and nothing that
   * merely spins a server up may construct one. Omitting it means meetings
   * record transcripts and compose nothing.
   *
   * The REAL sink is the server's own: composed notes are written into the
   * meeting doc's "Meeting notes" section through the Yjs fragment, and the
   * composer's context (doc title, open board task titles) is resolved here
   * too — see `meeting-notes-doc.ts`. A caller `onNotes` observes after the
   * doc write, it never replaces it.
   */
  meetingNotes?: MeetingNotesOptions;
  /**
   * Liveness-marker interval for the uptime measurement (§3.12 commit 11).
   * The monitor appends `server.tick` lines to every hub workspace's
   * events.jsonl so the gap analysis has density even on an idle board.
   * Overridable so tests never wait real minutes; default 5 minutes.
   */
  uptimeTickMs?: number;
}

const CT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // Without this the manifest ships as application/octet-stream and the
  // browser declines to install it — which presents as "Add to Home Screen
  // makes a bookmark, not an app", with nothing in the console about why.
  '.webmanifest': 'application/manifest+json',
};

/** Files the markdown-app build emits that must ALSO answer at the root
 *  path. See the route for why each one is here rather than under /app/. */
const ROOT_ALIASED_ASSETS = new Set([
  '/sw.js',
  '/sw.js.map',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
]);

/**
 * ── Watch coverage: the answer to "what am I MISSING?" ──────────────────────
 *
 * `list_watched_docs` answers "what am I watching", and the measured incident
 * is that the true answer to that question — six docs, all live — reads as an
 * all-clear while a voice note queues silently for a board the agent never
 * attached to. An agent cannot tell deafness from
 * silence, so it never thinks to ask.
 *
 * These types are what the watches route reports back so it can. Additive:
 * every field is new, so a bundle that predates them ignores an unknown key
 * and keeps working exactly as before.
 */
export interface CoverageQueue {
  queuedVoice: number;
}

/** One `ws:<id>` key in the agent's watch set, resolved. */
export interface CoverageWorkspaceRow {
  key: string;
  workspaceId: string;
  /** `board` — a workspace: tasks, a lead seat, attachments.
   *  `review` — a diff review / folder bind, which has none of those. */
  kind: 'board' | 'review';
  /** Board only. Attachment / lead / heartbeat are board facts; printing
   *  `attached: false` for a review would read as a gap that cannot exist. */
  name?: string;
  attached?: boolean;
  /** The displayed active/away label: a heartbeat inside the heartbeat
   *  window. NOT the delivery gate — see `live`. */
  heartbeatFresh?: boolean;
  /** Whether work actually reaches this agent here: recent observed work
   *  (heartbeat or tool call, whichever is later) plus an open channel. This
   *  is the one that answers "am I covered". */
  live?: boolean;
  lead?: boolean;
  queued?: CoverageQueue;
  queuedTotal?: number;
}

/**
 * A board this agent covers on paper but not in fact — the incident,
 * rendered as a row.
 *
 * "Not in fact" is deliberately wider than "has no attachment record". Every
 * delivery gate asks `hasLiveAttachment` / `hasLiveLeadAttachment`, i.e. is
 * there a heartbeat inside the freshness window — so an hour-old attachment
 * satisfies "attached" while the board's whole queue routes to nobody. The
 * first version of this readout tested for the record and was therefore
 * confidently wrong in the one state that matters: a declared lead whose
 * session went quiet, with work visibly piling up.
 */
export interface CoverageUnattachedBoard {
  workspaceId: string;
  name: string;
  /** The watched docs that put this board on the list. Empty when the agent
   *  reached it by holding the board's own `ws:<id>` key — which is what a
   *  declared lead holds, and holds instead of any doc key. */
  watchedDocs: string[];
  queued: CoverageQueue;
  queuedTotal: number;
  /** An attachment RECORD exists for this agent. Not the same as covered. */
  attached: boolean;
  /** …and its heartbeat is inside the heartbeat window, i.e. the board does
   *  not show it as away. Reported because it names which of the two things
   *  lapsed; it is NOT what admitted this row — rows are selected on the
   *  delivery gate, so `attached: true, heartbeatFresh: false` here means
   *  BOTH clocks ran out, not merely the heartbeat one. */
  heartbeatFresh: boolean;
  /** Who holds the lead seat, when anyone does. */
  leadAgentId?: string;
  /** Whether THAT agent is live by the same predicate `setLeadAgent`'s guard
   *  uses. False means the queue has no live addressee; true means somebody
   *  else is already draining it and taking the seat would evict a working
   *  peer — and would be refused. */
  leadLive: boolean;
}

export interface WatchCoverage {
  agentId: string;
  workspaces: CoverageWorkspaceRow[];
  unattachedBoards: CoverageUnattachedBoard[];
}

export interface ServerHandle {
  port: number;
  rooms: Rooms;
  /** The hub task store — workspaces, tasks, the transition gate. */
  tasks: TaskStore;
  /** The ydoc projection of the task store (ws:<id> board rooms + task
   *  body rooms). Exposed so tests can force a reassert. */
  projection: TaskProjection;
  /** Per-agent durable watch sets (agent-watches.ts). Exposed so tests can
   *  read the store the route wrote, not only the route's answer. */
  agentWatches: AgentWatches;
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

/**
 * ===== COMPAT: the review API answers at two prefixes =====
 *
 * A diff review and a bound folder are REVIEWS. They were built as a second
 * thing called a "workspace" and their endpoints are still spelled
 * `/api/workspaces/<id>/…`, which is the vocabulary this change removes: the
 * canonical name is now `/api/reviews/<setId>/…`.
 *
 * Every one of these routes therefore matches BOTH prefixes. This is the whole
 * of the alias — one helper, one comment — and it exists because the callers
 * are plugin bundles running inside sessions nobody can restart, plus browser
 * tabs that are already open. They keep calling the address they were built
 * against and would get a 404 they could not explain from their own version.
 *
 * The bare `DELETE /api/workspaces/<id>` is deliberately NOT in here: that one
 * route fronts two stores (a board or a review, dispatched by id) and is
 * handled on its own.
 */
const reviewApi = (sub: string): RegExp =>
  new RegExp(`^/api/(?:reviews|workspaces)/([^/]+)/${sub}$`);
const REVIEW_API = {
  refresh: reviewApi('refresh'),
  groups: reviewApi('groups'),
  grouped: reviewApi('grouped'),
  threads: reviewApi('threads'),
  files: reviewApi('files'),
  tree: reviewApi('tree'),
  contextFile: reviewApi('context-file'),
  editableFile: reviewApi('editable-file'),
} as const;
/** Review-only delete. `DELETE /api/workspaces/<id>` still fronts both. */
const REVIEW_DELETE = /^\/api\/reviews\/([^/]+)$/;

export function createServer(opts: ServerOptions = {}): ServerHandle {
  const port = opts.port ?? DEFAULT_PORT;
  const dataDir = opts.dataDir ?? join(process.cwd(), 'data');
  const clientReleaseRootDir = opts.clientReleaseRootDir ?? null;
  const widgetDist = opts.widgetDistDir ?? null;
  const markdownAppDist = opts.markdownAppDistDir ?? null;
  const demosDir = opts.demosDir ?? null;

  let shares: Shares | null = null;
  if (opts.share) {
    // Only build a Cloudflare client when Access mode is actually
    // configured. Link-mode sharing needs no Cloudflare credentials at all.
    const accountId = opts.share.config.cfAccountId;
    const cfApi =
      opts.share.cfApi ??
      (accountId ? new CfApi({ accountId, token: opts.share.cfApiToken ?? '' }) : undefined);
    shares = new Shares({
      dataDir,
      cfApi,
      config: opts.share.config,
    });
  }

  /**
   * The master switch for external access. Consulted on every request whose
   * Host is a share or link host, AHEAD of authentication — see the host
   * decision block below.
   */
  const sharingGate = new SharingGate({
    dataDir,
    envLocked: opts.sharingEnvLocked ?? false,
  });

  // HMAC key for link-mode session cookies. Generated on first use, mode
  // 600 — whoever can read it can mint a session for any share.
  let cookieKeyCache: string | null = null;
  const cookieKey = (): string => {
    cookieKeyCache ??= loadCookieKey(dataDir);
    return cookieKeyCache;
  };

  /** The shareId behind a link-mode session cookie, or null. */
  const linkSessionShareId = (req: Request): string | null => {
    if (!shares) return null;
    const shareId = verifySession(readCookie(req.headers.get('cookie'), SHARE_COOKIE), cookieKey());
    if (!shareId) return null;
    return shares.findLive(shareId)?.shareId ?? null;
  };

  /**
   * What a share may reach — or null, when it may reach nothing.
   *
   * A BOARD is the unit of sharing (Bryan, 2026-08-17). Minting a share of a
   * folder bind or diff review is refused at the route, but a record written
   * BEFORE that keeps its slug and its already-signed session cookies, so the
   * mint guard alone would retire the grant everywhere except where it is
   * actually exercised. This is that place: every serving path resolves a
   * share through here, and a share whose workspace is not a board resolves
   * to nothing.
   *
   * Deliberately not a drop in `Shares.load`, which is how the per-doc
   * removal did it. Two reasons: `Shares` has no way to ask what a board is
   * (only `taskStore` knows), and a load-time drop would destroy a row an
   * operator can still want to list and revoke. Removing a capability is not
   * deleting user content.
   */
  const boardShareTarget = (share: Share | null | undefined): ShareTarget | null => {
    if (!share?.workspaceId) return null;
    if (!taskStore.getWorkspace(share.workspaceId)) return null;
    return { workspaceId: share.workspaceId };
  };

  /** Resolve a link-mode session cookie to what it may reach, or null. */
  const linkSessionTarget = (req: Request): ShareTarget | null => {
    if (!shares) return null;
    const shareId = verifySession(readCookie(req.headers.get('cookie'), SHARE_COOKIE), cookieKey());
    if (!shareId) return null;
    // Re-checked every request, so revoking or expiring a share takes
    // effect immediately rather than when a browser's cookie lapses.
    const share = shares.findLive(shareId);
    if (!share || share.mode !== 'link') return null;
    return boardShareTarget(share);
  };

  // When shares is wired, automatically derive the cf-access audience from
  // the registry so each share-<slug> host can use its own AUD. Callers
  // can still override by passing cfAccess.audience explicitly.
  const cfAccessConfig =
    opts.cfAccess && shares
      ? { ...opts.cfAccess, audience: shares.audienceResolver }
      : opts.cfAccess;
  const cfAccessVerifier = cfAccessConfig ? createCfAccessVerifier(cfAccessConfig) : null;

  /**
   * The Access verifier for the collaboration hostnames — its OWN verifier,
   * built from the static env audience rather than the share registry's
   * per-hostname resolver.
   *
   * That separation is not tidiness, it is the only thing that makes the
   * feature work beside link sharing. When `shares` is wired, the resolver
   * above answers `null` for any host that is not a live share hostname, and
   * a collaboration host is by definition not one — so a shared verifier
   * would refuse every collab request with `no_share_for_host`. Cloudflare
   * issues one AUD per Access application, and the collaboration hostname has
   * its own application, so the static `CF_ACCESS_AUD` is the right tag for it.
   *
   * Null — and therefore the whole opt-in list ignored — unless BOTH a
   * hostname is listed and `cfAccess` carries a string audience. This is the
   * server-side half of the refusal; bin.ts also warns at boot. Two checks
   * because only this one is in the request path: an embedded caller that
   * never goes through bin.ts must fail closed too.
   */
  const accessTunnelHosts = opts.accessTunnelHosts ?? [];
  const collabAccessVerifier =
    accessTunnelHosts.length > 0 && opts.cfAccess && typeof opts.cfAccess.audience === 'string'
      ? createCfAccessVerifier(opts.cfAccess)
      : null;

  const sse = new SseHub();
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
  // webhook payloads via the Rooms decorator.
  // Generation is opt-IN at this seam: no summarizer, no outbound call, ever.
  // See ServerOptions.summarizer for why constructing one here was wrong.
  const summarizer = opts.summarizer ?? null;
  const pluginRefresher = opts.pluginRefresher ?? null;
  const deployer = opts.deployer ?? null;
  // Same opt-in seam: no engine here means no socket can start a billed
  // streaming session. See ServerOptions.transcription.
  const meetingStore = new MeetingStore(dataDir);
  const meetingRelay = new MeetingRelay({
    store: meetingStore,
    engine: opts.transcription ?? null,
    // The server supplies the notes sink — the write into the meeting doc —
    // and the context resolver (doc title, board task titles). Thunks, not
    // references: rooms and the task store are constructed below, and both
    // exist long before any meeting can start.
    notes: opts.meetingNotes
      ? withServerNotesSinks(opts.meetingNotes, {
          rooms: () => rooms,
          tasks: () => taskStore,
          // The capture pipeline's board writes, and the "go do it" wake —
          // the same immediate addressed delivery an answered review item
          // gets. Both close over consts declared below; a meeting can only
          // start long after createServer has returned.
          captureBoard: () => taskStore,
          onTaskReady: (wake) =>
            readyNudger.taskReady({
              workspaceId: wake.workspaceId,
              taskId: wake.taskId,
              taskTitle: wake.title,
            }),
        })
      : null,
    // Lifecycle only. The words never touch this hub — see meeting-protocol.
    broadcast: (docId, payload) => sse.broadcast(docId, payload),
  });
  // Late-bound because Rooms is constructed before the task store and the
  // projection it needs. Nothing can fire through it until a room exists,
  // which is after both.
  let onDocRoomEvent: ((docId: string, payload: WebhookPayload) => void) | null = null;
  const rooms = new Rooms({
    dataDir,
    sse,
    webhooks,
    decorateDocMeta: withReviewUrl,
    onRoomEvent: (docId, payload) => onDocRoomEvent?.(docId, payload),
    ...(summarizer ? { summarizer } : {}),
  });
  // Materialize the shared hub-feedback doc at startup rather than letting
  // the first widget connection conjure it. A room created by a `/y/<id>`
  // connect has no title and no type, so it reads as a ghost in list_docs —
  // and this one is meant to be found and watched by an agent that never
  // visited a hub.
  rooms.getOrCreate(HUB_FEEDBACK_DOC_ID, {
    type: 'mockup',
    title: 'Hub feedback (all workspaces)',
  });
  // The hub task store (plan §3.2/§3.3): server-owned workspaces + tasks,
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
  if (agentWatches.loadError) {
    console.error(`[agent-watches] ${agentWatches.loadError}`);
  }

  // The per-agent unfiled-ask counters the daily chat audit publishes, kept
  // so a session can read its own number back. The audit is the only writer
  // — the server cannot see chat — see chat-audit.ts for the honest limits.
  const chatAudit = new ChatAudit({ dataDir });
  if (chatAudit.loadError) {
    console.error(`[chat-audit] ${chatAudit.loadError}`);
  }

  // --- Push notifications ---------------------------------------------
  //
  // Devices enrolled for "a review item just landed". The store is cheap and
  // synchronous; the VAPID identity is not (it may have to mint a keypair),
  // so the notifier is built once, lazily, behind a cached promise. Building
  // it eagerly would make `createServer` async for a feature nobody has
  // necessarily turned on.
  const pushStore = new PushStore({ dataDir });
  if (pushStore.loadError) {
    console.error(`[push] ${pushStore.loadError}`);
  }
  let pushNotifierPromise: Promise<PushNotifier | null> | null = null;

  /**
   * The RFC 8292 `sub` claim: who a push service should contact about this
   * sender. This server's own origin is the standard non-email answer.
   *
   * Returns undefined on a plain-HTTP origin, and that disables the whole
   * feature rather than papering over it — a service worker cannot register
   * outside a secure context, so there is nothing on the other end to deliver
   * to. Prod sets CW_PUBLIC_BASE_URL to the HTTPS tailnet name for exactly
   * the reason `public-host.ts` gives about the microphone; the same override
   * is what makes push reachable.
   */
  function pushSubject(): string | undefined {
    const override = process.env.CW_PUSH_SUBJECT?.trim();
    if (override) return override;
    const base = externalBaseUrl();
    return base.startsWith('https://') ? base : undefined;
  }

  function pushNotifier(): Promise<PushNotifier | null> {
    pushNotifierPromise ??= (async () => {
      const subject = pushSubject();
      if (!subject) return null;
      try {
        return new PushNotifier({
          store: pushStore,
          keys: await loadOrCreateVapidKeys(dataDir),
          subject,
          log: (message) => console.error(`[push] ${message}`),
          ...(opts.pushFetch ? { fetch: opts.pushFetch } : {}),
        });
      } catch (err) {
        // A corrupt or unreadable key file. Say so once; the feature stays
        // off rather than re-minting and invalidating every enrolled device.
        console.error(`[push] disabled: ${(err as Error).message}`);
        return null;
      }
    })();
    return pushNotifierPromise;
  }

  /**
   * Announce a review item to every enrolled device.
   *
   * Deliberately fire-and-forget. The review item is already written by the
   * time this runs, and the caller is a route about to answer 200; making
   * that response wait on several third-party push services — or fail
   * because one of them is down — would trade the durable thing for the
   * announcement of it.
   */
  function announceReviewItem(input: {
    ask: string;
    context: string;
    askedBy: string;
    url: string | undefined;
    key: string;
  }): void {
    // No link, nothing to click. Criterion 2 of this feature is the click
    // landing on the item, so a notification without one is not worth sending.
    if (!input.url) return;
    void (async () => {
      try {
        const notifier = await pushNotifier();
        if (!notifier) return;
        await notifier.send(
          reviewItemNotification({ ...input, url: input.url as string, now: Date.now() }),
        );
      } catch (err) {
        console.error(`[push] announce failed: ${(err as Error).message}`);
      }
    })();
  }

  /** Where a comment-borne review item opens. A task discussion opens the
   *  TICKET — the board reveals the thread from its own state — while a doc
   *  thread opens the doc at the comment rather than at its top. */
  function reviewThreadLink(docId: string, threadId: string): string | undefined {
    const base = threadUrl(docId, false);
    if (!base) return undefined;
    if (docId.startsWith('task:')) return base;
    return `${base}?thread=${encodeURIComponent(threadId)}`;
  }

  /** What the reader is being asked ABOUT: the ticket's title for a task
   *  discussion, the doc's label otherwise. Same choice `reviewThreadItems`
   *  makes when it builds the queue row. */
  function reviewThreadContext(docId: string): string {
    if (docId.startsWith('task:')) {
      const task = taskStore.getTask(docId.slice('task:'.length));
      if (task) return task.title;
    }
    return rooms.get(docId)?.meta.title ?? 'A document';
  }

  /** One spelling of "a declaration just landed on a comment", for the three
   *  routes that can carry one. */
  function announceThreadReview(
    docId: string,
    threadId: string,
    review: ReviewPayload,
    author: User,
  ): void {
    announceReviewItem({
      ask: review.headline,
      context: reviewThreadContext(docId),
      askedBy: author.name,
      url: reviewThreadLink(docId, threadId),
      key: `${docId}:${threadId}`,
    });
  }

  /** The same, for a declaration that hangs on a TICKET rather than a
   *  comment. Both land in the reviewer's queue, so both are announced. */
  function announceTaskReview(task: Task, item: TaskReviewItem, author: User): void {
    announceReviewItem({
      ask: item.review.headline,
      context: task.title,
      askedBy: author.name,
      url: `${externalBaseUrl()}${taskDeepLink(task.workspaceId, task.id)}`,
      key: `${task.id}:${item.id}`,
    });
  }
  // Every store event rides the existing SSE pipeline on the workspace
  // channel (`ws~<workspaceId>`, the same channel doc thread events use for
  // reviews) — no new transport (§3.6). The audit log
  // append happens inside the store's emit, not here.
  taskStore.onEvent((ev) => {
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
  const taskProjection = new TaskProjection({ rooms, tasks: taskStore });
  taskProjection.init();

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
      if (rooms.list().some((m) => m.docId === docId)) return 'live';
      if (readDocArchiveManifest(dataDir, docId) !== null) return 'archived';
      if (listArchivedReviews(dataDir).some((m) => m.docIds.includes(docId))) return 'archived';
      return 'missing';
    },
    postMissingNote: async (task, text) => {
      taskProjection.ensureTaskBody(task);
      // Same actor-shape cast as the park migration's comment: the server's
      // own identity, rendered as a known author rather than an anonymous one.
      await rooms.postComment(
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

  /**
   * One board as the nudger reads it: who to wake, whether to wake them at
   * all, what is ready, WHAT THE PASS EXAMINED TO SAY SO, and when the board
   * last moved.
   *
   * The candidate set is the SAME computation `next_tasks` serves —
   * `buildQueue` — rather than a second reading of the same rules, and it is
   * now asked with `includeBlocked` so the gate sees every open row it is
   * deciding about. That is what makes `considered` a real denominator: a
   * pre-filtered list can only ever report the rows that survived it, so an
   * empty `ready` would read as an empty board rather than as a board whose
   * rows are all waiting on somebody.
   *
   * Which rows survive is `evaluateReadyWork`'s call — see `ready-gate.ts` for
   * why every one of those conditions is dependency state and none of them is
   * a clock. Two things stay here because they need the store:
   *
   *  - `ownerKind`, from the projection's roster reader, so the answer is the
   *    one the board draws rather than a guess from the assignee's name.
   *  - `reviewState`, which reports open questions AND unparseable ones
   *    separately. `listReviewItems` drops a corrupt row rather than throwing,
   *    so without the second number a ticket nobody can read is indistinguish-
   *    able from a ticket with nothing outstanding — and this is the one
   *    caller that ACTS on the difference.
   *
   * Nothing here has to filter out deliberately-deferred rows. Parking moves
   * a row to `triage` and `buildQueue` never lists triage, so a park is
   * invisible to this wake by construction rather than by a second rule that
   * could drift from the one `next_tasks` follows.
   */
  const readyWorkSnapshot = (workspace: HubWorkspace): ReadyWorkSnapshot => {
    const tasks = taskStore.listTasks(workspace.id);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const ownerKindOf = taskProjection.ownerKindReader(workspace.id);
    const verdict = evaluateReadyWork(
      // `goalRows` is what tells the gate which BANDS have been agreed to; a
      // row under a band still in triage is held (`goal-triage`) rather than
      // dropped, so the pass can report it instead of going quiet about it.
      buildQueue(tasks, workspace.goals, {
        includeBlocked: true,
        goalRows: taskStore.listGoalRows(workspace.id),
      }),
      {
        ownerKind: (id) => {
          const task = byId.get(id);
          // Impossible as long as the rows come from the list above, and it
          // throws rather than defaulting anyway: a default here would be a
          // guess about who owns a row, which is the one thing the gate must
          // never make up. The gate turns the throw into an undetermined row.
          if (!task) throw new Error(`no such task: ${id}`);
          return ownerKindOf(task);
        },
        reviewState: (id) => {
          const state = taskStore.reviewState(id);
          if (!state) throw new Error(`no such task: ${id}`);
          return state;
        },
      },
    );
    return {
      workspaceId: workspace.id,
      ...(workspace.leadAgentId !== undefined ? { leadAgentId: workspace.leadAgentId } : {}),
      retired: workspace.retiredAt !== undefined,
      ready: verdict.ready,
      considered: verdict.considered,
      held: verdict.held,
      undetermined: verdict.undetermined,
      // The store's durable half of the idle clock. Survives a restart, which
      // the in-process observations cannot — see ready-nudge.ts.
      lastActivityAt: tasks.reduce((max, t) => Math.max(max, t.updatedAt, t.createdAt), 0),
    };
  };
  const readyNudger = new ReadyWorkNudger({
    snapshot: () => taskStore.listWorkspaces().map(readyWorkSnapshot),
    lookup: (workspaceId) => {
      const ws = taskStore.getWorkspace(workspaceId);
      return ws ? readyWorkSnapshot(ws) : undefined;
    },
    // Addressed, never broadcast: a board-wide wake fanned out to every peer
    // is the cost `sendToAgent` exists to remove. `agentsOn` is the stronger
    // probe — it can tell an agent from a browser tab, which `count` cannot.
    canReach: (workspaceId, agentId) => sse.agentsOn(`ws~${workspaceId}`).has(agentId),
    send: (workspaceId, agentId, frame) =>
      sse.sendToAgent(`ws~${workspaceId}`, agentId, { ...frame }),
    idleMs: opts.readyNudgeIdleMs ?? READY_IDLE_DEFAULT_MS,
    // Prod restarts at every merge, so without this each deploy re-fired one
    // wake per idle board over facts their leads had already been told.
    stampFile: join(dataDir, READY_NUDGE_STAMP_FILENAME),
  });

  /**
   * One board as the stall loop reads it: which rows have stopped moving, which
   * are waiting on a person nobody has actually asked, and which could not be
   * read at all.
   *
   * The classification is `evaluateStalls` → `classifyOpenTasks`, the same
   * function the keep-moving report runs. That sharing is the point rather
   * than a convenience: the report is how this project decides whether the
   * keep-moving protocol is working, and a loop that judged "stalled"
   * differently would be measured by an instrument that disagreed with it.
   *
   * Four things have to be assembled here because they need the store:
   *
   *  - **Activity per row.** The classifier takes an event list and derives
   *    each row's last movement from it. The board's own `/events` feed has
   *    measurably MISSED row edits, so what is fed in is the rows' own
   *    timestamps — `updatedAt`, `bodyWrittenAt`, `titleWrittenAt` — which are
   *    written by every path that changes a row. That is a superset of what
   *    the feed would have carried, and it needs no file read per tick.
   *  - **Open questions.** `reviewState` reports open items AND unparseable
   *    ones separately, and this is a caller that ACTS on the difference: a
   *    ticket whose questions cannot be read is exactly the ticket whose
   *    unreadable question might have explained its silence, so it goes to the
   *    gate as unreadable rather than as clear.
   *  - **Who owns the row**, from the projection's roster reader, so the
   *    answer is the one the board draws rather than a guess from a name.
   *  - **Which goals dispatch.** The decisions band is the owner's own queue
   *    by its own description; everything else in the ranked list dispatches,
   *    and a goal outside the list is formal backlog that the dispatch rule
   *    would never start.
   *
   * Comments are resolved in a SECOND pass, and only over rows the first pass
   * called stuck. A comment is the row moving — a ticket whose whole decision
   * conversation is live on its thread is not quiet — but reading every board's
   * every thread once a minute would be the one expensive thing in this loop,
   * and the rows that would benefit are precisely the handful about to be
   * reported.
   */
  const stallVerdict = (workspace: HubWorkspace): StallVerdict => {
    const tasks = taskStore.listTasks(workspace.id);
    const ownerKindOf = taskProjection.ownerKindReader(workspace.id);
    const goals = flattenGoals(workspace.goals);
    // Matching on the owner's NAME would be wrong — it appears in ordinary
    // goal titles. Only the decisions band is his queue.
    const ownerBand = new Set(
      goals.filter((g) => /decision/i.test(`${g.id} ${g.title}`)).map((g) => g.id),
    );
    // A band nobody has agreed to yet dispatches nothing under it, so a row
    // sitting there is idle BY RULE and must not read as stalled — the same
    // verdict `backlog` carries, and the same one the ready gate reads as
    // `goal-triage`. The status lives on the goal ROWS; the ordered goal list
    // does not carry one.
    const triageGoals = new Set(
      taskStore
        .listGoalRows(workspace.id)
        .filter((g) => g.status === 'triage')
        .map((g) => g.id),
    );
    // A board that declares NO goals has no bands, so nothing on it is
    // backlog — `inGoalBand` in task-queue.ts states the same rule, and the
    // never-dispatch rule ranks rows against the goal list, so with no list
    // there is nothing to be outside of. Without this every row on a
    // goal-less board reads as unranked backlog and the loop goes silent over
    // exactly the boards that have no ranking to hide behind.
    const dispatchable =
      goals.length === 0
        ? new Set(tasks.map((t) => t.goal))
        : new Set(
            goals.map((g) => g.id).filter((id) => !ownerBand.has(id) && !triageGoals.has(id)),
          );

    const rows = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status as string,
      goal: t.goal,
      after: t.after,
      createdAt: t.createdAt,
      transitions: t.transitions,
      ownerKind: ownerKindOf(t) as string,
      updatedAt: t.updatedAt,
      ...(t.bodyWrittenAt !== undefined ? { bodyWrittenAt: t.bodyWrittenAt } : {}),
      ...(t.titleWrittenAt !== undefined ? { titleWrittenAt: t.titleWrittenAt } : {}),
    }));
    // Every row timestamp as an activity tick. Deliberately unfiltered by
    // actor: the question this feeds is "did anything touch this row", and an
    // unattributed tick beats a false silence.
    const events: Array<{ taskId: string; ts: number }> = [];
    for (const t of tasks) {
      for (const ts of [t.updatedAt, t.bodyWrittenAt, t.titleWrittenAt]) {
        if (typeof ts === 'number' && ts > 0) events.push({ taskId: t.id, ts });
      }
    }
    const reviewItems: Array<{ taskId: string; askedAt?: number }> = [];
    const unreadableReviewTaskIds = new Set<string>();
    for (const t of tasks) {
      const state = taskStore.reviewState(t.id);
      // Absent means the row vanished between the list and this read. Treated
      // as unreadable rather than as clear, for the same reason a throw is:
      // the one thing that could exonerate the row is the thing we do not have.
      if (!state) {
        unreadableReviewTaskIds.add(t.id);
        continue;
      }
      if (state.unreadable > 0) unreadableReviewTaskIds.add(t.id);
      if (state.open > 0) reviewItems.push({ taskId: t.id });
    }

    const now = Date.now();
    const input = {
      tasks: rows,
      events,
      reviewItems,
      bands: { dispatchable, ownerBand },
      unreadableReviewTaskIds,
      now,
      ...(opts.stallNudgeQuietMs !== undefined ? { quietMs: opts.stallNudgeQuietMs } : {}),
    };
    const first = evaluateStalls(input);
    const suspect = [...first.stalled, ...first.unfiled];
    if (suspect.length === 0) return first;
    // Second pass over the handful the first pass named. A room that was never
    // opened holds no threads and answers nothing, which is the right answer:
    // a row with no discussion has no comment activity to find.
    //
    // The same walk also collects the asks `reviewState` cannot see: a review
    // item filed as a payload ON A COMMENT lives in the room, not on the
    // ticket, yet it sits on the reader's Home queue exactly like a
    // ticket-borne one — so a row behind one is legitimately waiting, and the
    // loop woke a live lead over exactly this shape. Openness is
    // `pendingDeclaration`, the rule the queue itself reads: an answered
    // declaration or a resolved thread is nobody being waited on, and excuses
    // nothing.
    const threadActivity = new Map<string, number>();
    const commentAsks: Array<{ taskId: string; askedAt: number }> = [];
    for (const row of suspect) {
      let newest = 0;
      for (const thread of rooms.listThreads(taskBodyDocId(row.id))) {
        if (thread.lastActivity > newest) newest = thread.lastActivity;
        const declaring = pendingDeclaration(thread);
        if (declaring) commentAsks.push({ taskId: row.id, askedAt: declaring.ts });
      }
      if (newest > 0) threadActivity.set(row.id, newest);
    }
    if (threadActivity.size === 0 && commentAsks.length === 0) return first;
    return evaluateStalls({
      ...input,
      reviewItems: [...input.reviewItems, ...commentAsks],
      ...(threadActivity.size > 0 ? { threadActivity } : {}),
    });
  };
  const stallSnapshot = (workspace: HubWorkspace): StallSnapshot => {
    const verdict = stallVerdict(workspace);
    return {
      workspaceId: workspace.id,
      ...(workspace.leadAgentId !== undefined ? { leadAgentId: workspace.leadAgentId } : {}),
      retired: workspace.retiredAt !== undefined,
      stalled: verdict.stalled,
      unfiled: verdict.unfiled,
      considered: verdict.considered,
      undetermined: verdict.undetermined,
    };
  };
  const stallNudger = new StallNudger({
    snapshot: () => taskStore.listWorkspaces().map(stallSnapshot),
    // Addressed, never broadcast, and `agentsOn` rather than `count` for the
    // same reason the ready-work wake uses it: `count` cannot tell an agent
    // from an open browser tab, and a wake fanned out to every peer is the
    // cost addressed delivery exists to remove.
    canReach: (workspaceId, agentId) => sse.agentsOn(`ws~${workspaceId}`).has(agentId),
    send: (workspaceId, agentId, frame) =>
      sse.sendToAgent(`ws~${workspaceId}`, agentId, { ...frame }),
    ...(opts.stallNudgeRepeatMs !== undefined ? { repeatMs: opts.stallNudgeRepeatMs } : {}),
    // Prod restarts at every merge; without this each deploy would re-fire one
    // wake per board over rows their leads had already been told about.
    stampFile: join(dataDir, STALL_NUDGE_STAMP_FILENAME),
  });
  // Its own subscription rather than a branch inside the SSE bridge above,
  // and the ordering is the reason: the bridge is installed before this
  // object exists, so reaching back at it from there would be a reference
  // into a variable that is not initialized yet on any event the store
  // manages to emit in between.
  taskStore.onEvent((ev) => {
    // The board moved, so its idle clock restarts. Read from the SAME choke
    // point every other subscriber reads, rather than from a second list of
    // "events that count as activity" — one that would silently fall behind
    // the store the first time a mutator is added.
    //
    // ONE exclusion, stated as a PREFIX rather than as a list for the same
    // reason: `agent.*` is liveness (attached / detached / heartbeat), and
    // liveness is not the board moving. Counting it made the wake
    // self-cancelling, because the only lead a nudge can be DELIVERED to is
    // one holding a live stream — which is precisely the session attaching
    // and heartbeating. So the pings that proved the lead was there also
    // proved, to this clock, that the board did not need it.
    if (!ev.type.startsWith('agent.')) readyNudger.noteActivity(ev.workspaceId, ev.ts);
    // …and an answer is not merely activity. The lead is the party who acts
    // on answers, and making it wait out an idle window would deliver the
    // point of the feature fifteen minutes late.
    if (ev.type === 'decision.answered') {
      // Resolved HERE rather than inside the nudger: the nudger's snapshot
      // carries the ready set, and an answered row is usually not in it —
      // being blocked on that very answer is why it was asked. The title is
      // what makes the wake readable without a lookup on the far end, and the
      // links are what decide whether the line may offer a propagation
      // checklist — sent as they stand, empty included, because the renderer
      // has to tell an empty list from a frame that carries no row at all.
      const answered = ev.taskId ? taskStore.getTask(ev.taskId) : undefined;
      readyNudger.reviewAnswered({
        workspaceId: ev.workspaceId,
        taskId: ev.taskId,
        ...(answered?.title !== undefined ? { taskTitle: answered.title } : {}),
        ...(answered?.links !== undefined ? { taskLinks: answered.links } : {}),
        actorId: ev.actor?.id,
      });
    }
  });
  // A task's discussion lives in its body room, but an agent working a board
  // watches the WORKSPACE channel, not each task's doc — so a comment that
  // only fans out on the doc's own stream reaches nobody who is working. The
  // same event also moves the row's comment count, which nothing else would
  // refresh (the store never changes, so no task.* event fires).
  //
  // EVERY other doc room needs the same bridge, for the same reason and with
  // one extra hop. `rooms.broadcastToRoom` fans out on `ws~<meta.workspaceId>`
  // — the GROUPING tag a diff review or folder bind sets — and a board link is
  // not that tag, so a plain review doc filed on a board reached that board's
  // agent never. Measured: a session with six docs under `watch_doc` and a
  // seat on the board heard nothing from any of them on the board channel, and
  // silence from a subscription you never made is indistinguishable from
  // nobody having commented.
  //
  // Resolution happens HERE, at BROADCAST time, against `workspace.docIds` —
  // nothing is registered when a doc is created. That is what makes "and
  // anything created later" true with no new call, no new field and no
  // migration: `fileUnderHubWorkspace` already files every doc onto some
  // board, defaulting to Unfiled, so a doc that exists is a doc some board
  // holds.
  /** Does this comment author name this agent? Candidate-matched both ways,
   *  because the event's actor id and the attachment key demonstrably
   *  disagree in the field (see noteObservedWork in tasks.ts). */
  const commentAuthorIs = (agentId: string, author?: { id?: string; name?: string }): boolean => {
    if (!author) return false;
    const candidates = new Set<string>();
    for (const raw of [author.id, author.name]) {
      if (typeof raw !== 'string') continue;
      candidates.add(raw.trim().toLowerCase());
      for (const c of agentIdCandidates(raw)) candidates.add(c);
    }
    return candidates.has(agentId.trim().toLowerCase());
  };

  /**
   * The durable half of a comment's delivery (§ comment queue, mirrored from
   * voice): write one ADDRESSED row per owning agent before any frame goes
   * out, so a stream being down costs latency rather than the comment.
   *
   * Who owns a comment — the addressing decision, made here in one place:
   * the board's LEAD (declare-lead's contract is "everything on this board
   * reaches you") plus every agent whose DURABLE watch set holds
   * `ws:<workspaceId>` (the standing subscription that survives the stream
   * carrying it). Deliberately NOT per-doc watchers or "whoever attaches
   * first": attach and heartbeat — the only per-agent drains — are
   * board-scoped, and queuedVoice's missing lead-guard is the measured cost
   * of leaving a queue unaddressed. The author is excluded: an agent is not
   * owed a receipt for its own words.
   *
   * Only events that ARE a comment queue (thread.created / thread.replied,
   * which carry `comment`); resolve/reopen/suggestion verdicts are state
   * changes, not asks waiting on somebody.
   */
  const queueCommentRows = (
    workspaceId: string,
    docId: string,
    payload: WebhookPayload,
  ): Map<string, string> => {
    const rows = new Map<string, string>();
    if (payload.event !== 'thread.created' && payload.event !== 'thread.replied') return rows;
    // thread.replied carries the comment on the payload; thread.created fires
    // with `comment: undefined` and the opening comment inside the thread
    // (rooms.ts fireEvent call sites), so fall back to the newest one there.
    const comment =
      payload.comment ??
      (payload.event === 'thread.created'
        ? payload.thread?.comments?.[payload.thread.comments.length - 1]
        : undefined);
    if (!comment) return rows;
    const addressees = new Set<string>(agentWatches.agentsWatching(`ws:${workspaceId}`));
    const lead = taskStore.getWorkspace(workspaceId)?.leadAgentId;
    if (lead) addressees.add(lead);
    for (const agentId of addressees) {
      if (commentAuthorIs(agentId, comment.author)) continue;
      const id = taskStore.queueComment(workspaceId, {
        agentId,
        docId,
        threadId: payload.threadId,
        event: payload.event,
        author: { id: comment.author.id, name: comment.author.name },
        text: comment.text,
        payload,
      });
      if (id !== false) rows.set(agentId, id);
    }
    return rows;
  };

  /** An addressee holding the board stream just received (or is receiving)
   *  the live frame: start its ack grace, so the next heartbeat does not
   *  immediately re-send what is already in flight. */
  const markCommentRowsEmitted = (workspaceId: string, rows: Map<string, string>): void => {
    if (rows.size === 0) return;
    const on = sse.agentsOn(`ws~${workspaceId}`);
    for (const [agentId, rowId] of rows) {
      if (on.has(agentId)) taskStore.markCommentEmitted(workspaceId, rowId);
    }
  };

  onDocRoomEvent = (docId, payload) => {
    const rowId = taskIdOfBodyDoc(docId);
    if (rowId) {
      // A `task:` room belongs to a task OR to a goal — one prefix, two kinds
      // of row (see `ensureGoalBody`). Asking only `getTask` returned
      // undefined for every goal and took the early return, so a comment on a
      // goal reached nobody: no board broadcast, no agent watching the
      // workspace, no projection refresh to update the count.
      const workspaceId =
        taskStore.getTask(rowId)?.workspaceId ?? taskStore.getGoalRow(rowId)?.workspaceId;
      if (!workspaceId) return;
      const rows = queueCommentRows(workspaceId, docId, payload);
      sse.broadcast(`ws~${workspaceId}`, payload, (who) => {
        const rowId = who.agentId ? rows.get(who.agentId) : undefined;
        return rowId ? { ...payload, workspaceId, commentQueueId: rowId } : undefined;
      });
      markCommentRowsEmitted(workspaceId, rows);
      // Task path only: a plain doc thread moves no row, so refreshing the
      // projection for it would be a board-wide rewrite that changes nothing.
      taskProjection.refresh(workspaceId);
      return;
    }
    // Exactly one hop from review to board — the same non-transitive rule
    // `shareWorkspacesOf` spells out, so what an agent HEARS about a review
    // and what a share visitor may OPEN in it cannot drift apart.
    const reviewId = reviewIdOf(rooms.get(docId)?.meta ?? {});
    for (const board of hubBoardsForDoc(docId)) {
      const rows = queueCommentRows(board, docId, payload);
      // rooms.ts already broadcast on the review's own channel; a second
      // send here would deliver the same comment twice to one listener. The
      // review frames carried no row id, so those rows are acked off the
      // grace-window redelivery instead — late receipt beats double frame.
      if (board !== reviewId) {
        sse.broadcast(`ws~${board}`, payload, (who) => {
          const rowId = who.agentId ? rows.get(who.agentId) : undefined;
          return rowId ? { ...payload, workspaceId: board, commentQueueId: rowId } : undefined;
        });
      }
      markCommentRowsEmitted(board, rows);
    }
  };

  // ── Home pane: per-person read markers + the "What's New?" brief ─────────
  // (Approved design: docs/product/mockups/home-pane. Summaries cover
  // everything since the reader last marked caught up; instructions are
  // workspace-wide and editable; generation is the summarizer seam or
  // nothing — a server with no summarizer serves the deterministic brief.)
  const homeBriefs = new HomeBriefStore(dataDir);
  /** One generation in flight per workspace+reader: the client polls while
   *  `generating`, and N polls must cost one call, not N. */
  const homeBriefInflight = new Set<string>();

  /** The review items exactly as GET /review-items ships them.
   *  ONE builder for that route and for the brief's queue count, so the
   *  number the brief prints cannot drift from the queue rendered under it. */
  const reviewItemsFor = (workspace: HubWorkspace): ReviewItemRow[] =>
    reviewItemRows({
      tasks: taskStore.listTasks(workspace.id).map((t) => ({
        id: t.id,
        title: t.title,
        bodyDocId: taskBodyDocId(t.id),
        done: t.status === 'done',
        // The ticket's OWN review items — 0..n, and for a legacy decision task
        // the one row `listReviewItems` derives from `needs`/`options`/`answer`
        // without writing anything back. This is what lets a decision reach the
        // one route that answers "what is waiting on me"; before it, a board of
        // nothing but open decisions answered with an empty list.
        reviews: taskStore.listReviewItems(t.id),
      })),
      // Goals queue their discussions the same way. Without this a review
      // item declared on a goal — "does 'ten teams' mean ten that renew?" —
      // sits in a thread nothing tells the reader about, which is the whole
      // failure the queue exists to prevent, on the row that matters most.
      // No `reviews`: that array is a task field and a goal row has none.
      goals: taskStore.listGoalRows(workspace.id).map((g) => ({
        id: g.id,
        title: g.title,
        bodyDocId: taskBodyDocId(g.id),
        done: g.status === 'done',
      })),
      docs: workspace.docIds.map((docId) => {
        const meta = rooms.get(docId)?.meta;
        // Title, else the file's BASENAME — never `relPath` whole and
        // never `sourceUrl`. Those describe the host machine, and a
        // share visitor reads this route (§3.3): a label is workspace
        // content, a path is not.
        const base = meta?.relPath?.split('/').pop();
        return { docId, title: meta?.title || base || docId };
      }),
      source: {
        threadsOf: (docId) => rooms.listThreads(docId, { status: 'open' }),
        // Unfiltered, and only for the roster: who counts as a person
        // here must not depend on whether their thread is still open.
        allThreadsOf: (docId) => rooms.listThreads(docId),
      },
    });

  /**
   * How many items the Home queue holds right now. Feeds only the brief's
   * closing "is anything waiting" line.
   *
   * The number is a promise about the LIST rendered under it, so it counts
   * exactly what the browser's `reviewQueue` places and nothing else:
   *
   *  - comment-borne review rows (`task-thread` / `doc-thread`) — ALL of
   *    them, which is true again since 2026-08-21: membership moved into
   *    `reviewThreadItems` (a row is a declared item or a surviving direct
   *    ask), and the browser retired its undeclared shelf and places every
   *    row this route ships. Between those two changes this count briefly
   *    included inferred rows Home never drew — "something needs you" over a
   *    list that showed nothing,
   *  - open decisions, which Home draws from the board projection as its own
   *    `decision` rows.
   *
   * Person-owned blockers are deliberately NOT a term. A blocker is task
   * state, not a review item — the browser's `reviewQueue` stopped placing
   * blocker rows when the task panel's blocked note took them over, so a
   * count that still included them pointed the brief ("queued below") at a
   * queue that renders nothing.
   *
   * TICKET-borne rows (`kind: 'task-review'`) count too — Home places them
   * now (`reviewQueue` in hub-model.ts), which closed the measured gap where
   * a review item filed with `create_tasks` / `add_review_item` was shipped
   * by the route and rendered by nothing. The one exception is the DERIVED
   * `r-legacy` row: its legacy decision is already counted from the tasks
   * below, and the browser skips that row for the same reason, so counting
   * it here would say one question twice.
   *
   * The open-decision term is counted from the TASKS rather than from `items`,
   * even though `items` also carries a derived `r-legacy` row per open
   * decision. Same reason: `decisionQueue` in the browser is what draws those
   * rows, and it reads `needs`/`answer` off the projection. Counting the
   * derived rows instead would tie this number to a row Home does not read.
   * A decision is therefore counted once, never twice.
   */
  const homeQueueTotal = (workspace: HubWorkspace, items: ReviewItemRow[]): number => {
    const open = taskStore.listTasks(workspace.id).filter((t) => t.status !== 'done');
    const decisions = open.filter((t) => t.needs === 'decision' && !t.answer);
    const rendered = items.filter(
      (i) => i.kind !== 'task-review' || i.reviewItemId !== LEGACY_REVIEW_ITEM_ID,
    );
    return rendered.length + decisions.length;
  };

  const homeBriefInput = (workspace: HubWorkspace, since: number): BriefInput => {
    const events = briefEvents(readEventRows(dataDir, workspace.id), since);
    const items = reviewItemsFor(workspace);
    return {
      workspaceId: workspace.id,
      events,
      queue: { total: homeQueueTotal(workspace, items) },
      titleOf: (taskId) => taskStore.getTask(taskId)?.title,
    };
  };

  /** Fire-and-forget one generation; the client re-reads when it lands. */
  const generateHomeBriefFor = (
    workspace: HubWorkspace,
    person: string,
    marker: number,
    input: BriefInput,
    coverage: BriefCoverage,
  ): void => {
    const key = `${workspace.id}\u0000${readerKey(person)}`;
    if (homeBriefInflight.has(key)) return;
    homeBriefInflight.add(key);
    // The window the model is told about, the window the reader is shown, and
    // the rows the model is handed all come from ONE coverage value. They used
    // to be derived separately and disagreed: this said "the last 7 days"
    // while the digest cap had already cut what the model could see to hours.
    const prompt = buildBriefPrompt(input, homeBriefs.instructions(workspace.id), coverage);
    void (async () => {
      try {
        const accepted = acceptBrief((await summarizer?.generateHomeBrief(prompt)) ?? null);
        // A refused reply stores nothing: the deterministic brief stands, and
        // the next read simply tries again. Never store an empty brief over
        // a rendered one.
        if (accepted !== null) {
          homeBriefs.storeBrief(workspace.id, person, {
            markdown: accepted,
            since: marker,
            coversFrom: coverage.from,
            eventCount: input.events.length,
            generatedAt: Date.now(),
          });
        }
      } finally {
        homeBriefInflight.delete(key);
      }
    })();
  };

  /**
   * Everything GET /home answers, also returned by the instructions PUT so
   * the client repaints from one shape. Freshness keys on the MARKER (not
   * the derived window start, which for a never-read reader slides with the
   * clock and would re-queue a generation on every read) plus the count of
   * brief-relevant events — see BRIEF_EVENT_TYPES for why heartbeats are
   * excluded from that count.
   */
  const homePayload = (workspace: HubWorkspace, person: string, now: number) => {
    const marker = homeBriefs.lastReadAt(workspace.id, person);
    const since = effectiveSince(marker, now);
    const input = homeBriefInput(workspace, since);
    const stored = homeBriefs.brief(workspace.id, person);
    const coverage = briefCoverage(input.events, since);
    const fresh = briefIsFresh(stored, marker, input.events.length);
    // `generating` is grounded in work actually queued — it is true exactly
    // when a call is (or is being put) in flight, never inferred.
    let generating = false;
    if (!fresh && summarizer?.enabled) {
      generating = true;
      generateHomeBriefFor(workspace, person, marker, input, coverage);
    }
    // `coversFrom` is per BRIEF, not per payload, because the two briefs
    // genuinely cover different windows: the deterministic one counts every
    // event in the window, the generated one only the rows that survived the
    // digest cap. A stored brief carries the coverage it was written under —
    // one written before the field existed has no answer, and the window
    // start is the closest honest thing to say.
    const brief = fresh
      ? {
          markdown: stored.markdown,
          generatedAt: stored.generatedAt,
          coversFrom: stored.coversFrom ?? since,
          source: 'generated' as const,
        }
      : {
          markdown: deterministicBrief(input),
          generatedAt: now,
          coversFrom: since,
          source: 'deterministic' as const,
        };
    return {
      workspaceId: workspace.id,
      lastReadAt: marker,
      since,
      instructions: homeBriefs.instructions(workspace.id),
      brief,
      generating,
    };
  };
  /**
   * Rewrite a task's description through its live `task:<id>` body room, with
   * everything the act owes: the room exists, the snapshot the board and
   * `next_tasks` read is fresh immediately rather than on the debounce, and —
   * when the caller said who it is — an attributed `task.body_edited` row.
   *
   * ONE function because there are TWO routes: `POST /api/tasks/:id/body` and
   * `POST /api/docs/task:<id>/content`. The second one used to reach
   * `rooms.setDocContent` directly and got none of this, which is how a
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
    const docId = taskProjection.ensureBodyRoom(task);
    const res = rooms.setDocContent(docId, markdown);
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
      const meta = rooms.get(docId)?.meta;
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
          })),
      };
    },
    // The room store itself, for the two text verbs. Voice calls
    // `postComment` — the one choke point every reply path in this server
    // already funnels through — and `answerReviewItem` exactly as it stands,
    // so a spoken comment and a typed one are the same write, fire the same
    // events, and reach a watching agent identically.
    rooms,
    // A task's discussion room, CREATED if this process has not served it
    // yet. Body rooms are lazy, so on a freshly restarted server the room for
    // a task nobody has opened does not exist and a comment aimed straight at
    // `task:<id>` is dropped with a `null` the caller reads as "no such doc".
    taskCommentDoc: (taskId) => {
      const task = taskStore.getTask(taskId);
      return task ? taskProjection.ensureBodyRoom(task) : undefined;
    },
  });

  /**
   * Which workspaces an id belongs to, for SHARE SCOPING (§3.12 commit 8).
   * The id may be a doc room OR a review (folder bind / diff review), and
   * the answer is a SET because those two senses of "workspace" nest:
   *
   *   1. a member doc's own GROUPING     (`meta.workspaceId`)
   *   2. the HUB board the id is filed on directly — docs linked via
   *      attachDoc, each task's `task:<id>` body room, and a review id,
   *      which is how a review goes on a board as one row
   *   3. the HUB board that member's GROUPING is filed on — the hop that
   *      makes a review row on a shared board actually open. Without it a
   *      hub-scoped share saw the row and 403'd on everything behind it,
   *      because every member answers with the review id and the share
   *      carries the hub id.
   *
   * ONE rule for both halves of the guard, on purpose: the same function
   * tells the allowlist that a review belongs to a hub and tells it that
   * the review's members do. Two rules would agree today and diverge
   * later, and the one that diverges open is the breach.
   *
   * Exactly one hop from review to board — not a transitive closure.
   * Deliberately NOT the ws:<id> board room: its share allowance is spelled
   * out in host-guard, never a resolver side effect.
   */
  const shareWorkspacesOf = (rawId: string): string[] => {
    // Canonicalize FIRST. Boards hold a doc's own id, so an alias asked here
    // resolved to nothing and the share refused a document it covers — a
    // readable URL handed to an outside reviewer would simply not open. This
    // is the one resolver every share-scope predicate reads, which is why the
    // fix belongs here and not in each of them.
    const id = rooms.get(rawId)?.docId ?? rawId;
    const out = new Set<string>();
    const reviewId = reviewIdOf(rooms.get(id)?.meta ?? {});
    if (reviewId) out.add(reviewId);
    for (const board of hubWorkspacesHolding(id)) out.add(board);
    if (reviewId) for (const board of hubWorkspacesHolding(reviewId)) out.add(board);
    return Array.from(out);
  };

  /**
   * EVERY hub board an attachment is linked to — not the first one.
   *
   * `attachDoc` links, it does not move: only the default holding pen is
   * unfiled on the way (see `unfileFromDefault`), so a review deliberately
   * put on two real boards is on both. `taskStore.workspaceOfDoc` answers
   * with whichever the store iterates first, which for share scoping means
   * the visitors of every OTHER board holding it are refused the row their
   * own board shows them — the exact 403-on-your-own-share failure
   * `unfileFromDefault` records, surviving in the case it cannot fix,
   * because there both links are legitimate and neither may be dropped.
   *
   * `task:<id>` keeps the store's own resolution: a task body belongs to its
   * task's workspace, which is a field rather than a link, so it has one
   * answer by construction.
   */
  function hubWorkspacesHolding(attachmentId: string): string[] {
    if (attachmentId.startsWith('task:')) {
      const w = taskStore.workspaceOfDoc(attachmentId);
      return w ? [w] : [];
    }
    return taskStore
      .listWorkspaces()
      .filter((w) => w.docIds.includes(attachmentId))
      .map((w) => w.id);
  }

  /**
   * Every hub board a DOC's discussion actually reaches — the boards holding
   * the doc itself, plus the one review→board hop a diff review / folder
   * bind needs (its members carry the review tag, and the review is what
   * sits on the board as one row).
   *
   * Written once and used twice on purpose: `onDocRoomEvent` fans events out
   * over exactly this set, and the coverage readout reports gaps against
   * exactly this set. Two copies would agree today and drift later, and the
   * drift would be invisible in the worst direction — a probe that says
   * "covered" about a board the events never reach is the failure this
   * ticket exists to end, restated as a reassuring answer.
   */
  function hubBoardsForDoc(docId: string): Set<string> {
    const boards = new Set(hubWorkspacesHolding(docId));
    const reviewId = reviewIdOf(rooms.get(docId)?.meta ?? {});
    if (reviewId) for (const board of hubWorkspacesHolding(reviewId)) boards.add(board);
    return boards;
  }

  /**
   * The same three questions as `hubWorkspacesHolding` / `hubBoardsForDoc` /
   * `resolveWorkspaceForDoc`, answered for a WHOLE LISTING from one pass over
   * the workspaces instead of one pass per row.
   *
   * The per-id versions above allocate a fresh array of every board and scan
   * each one's `docIds`. That is the right shape for a single lookup and the
   * wrong shape for a listing. `GET /api/docs` asked twice per row — once for
   * the doc, once for the review-id fallback — so the work grew with the
   * SQUARE of the doc count, and docs no board holds paid for both halves —
   * which, once a server accumulates diff-review members, is most of them.
   *
   * That matters more than a slow response suggests, because Bun runs JS on
   * one thread: a listing that takes tens of seconds is tens of seconds in
   * which the server answers nothing else — no page, no board, no MCP call.
   * Nor does anything report it, since the process stays alive and stays
   * BOUND the whole time. A supervisor that asks whether the port is
   * listening, as the bind-health watchdog in `scripts/serve.ts` does, sees
   * a healthy server; it never asks whether the server answers.
   *
   * These read the same `taskStore` state the per-id versions read and are
   * kept beside them deliberately — two answers to one question drift, and
   * the drift here would be a wrong URL rather than a slow one.
   */
  function boardIndexForListing(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const w of taskStore.listWorkspaces()) {
      for (const id of w.docIds) {
        const boards = index.get(id);
        if (boards) boards.push(w.id);
        else index.set(id, [w.id]);
      }
    }
    return index;
  }

  /**
   * `hubWorkspacesHolding` against a prebuilt index.
   *
   * `task:` ids are deliberately absent from the index and fall through to
   * `workspaceOfDoc`, exactly as the per-id version routes them: a task room
   * is looked up by id rather than scanned for, and is never in any board's
   * `docIds` to begin with.
   */
  function heldByIndexed(index: Map<string, string[]>, attachmentId: string): string[] {
    if (attachmentId.startsWith('task:')) {
      const w = taskStore.workspaceOfDoc(attachmentId);
      return w ? [w] : [];
    }
    return index.get(attachmentId) ?? [];
  }

  /** `hubBoardsForDoc` against a prebuilt index. The caller already holds the
   *  row's meta, so the review id is read from it rather than re-fetched. */
  function hubBoardsForDocIndexed(index: Map<string, string[]>, meta: DocMeta): Set<string> {
    const boards = new Set(heldByIndexed(index, meta.docId));
    const reviewId = reviewIdOf(meta);
    if (reviewId) for (const board of heldByIndexed(index, reviewId)) boards.add(board);
    return boards;
  }

  /**
   * `resolveWorkspaceForDoc` against a prebuilt index.
   *
   * Mirrors `backTargetFor`'s `pick(a) ?? pick(b)` exactly, including that a
   * first board which fails the `getWorkspace` check does NOT fall through to
   * a second board holding the same id — it falls through to the review-id
   * lookup. (In practice the check cannot fail: `getWorkspace` reads the very
   * map `listWorkspaces` was built from. It is kept so this stays a
   * transcription of the original rather than a judgement about it.)
   */
  function homeForDocIndexed(index: Map<string, string[]>, meta: DocMeta): string | null {
    const pick = (id: string | undefined): string | null =>
      id && taskStore.getWorkspace(id) ? id : null;
    return (
      pick(heldByIndexed(index, meta.docId)[0]) ??
      pick(heldByIndexed(index, reviewIdOf(meta) ?? '')[0])
    );
  }

  /**
   * What is waiting for this board's lead, COUNTED WITHOUT DRAINING.
   *
   * The reader here is the non-destructive one: `listQueuedVoice`, not
   * `drainVoiceQueue`. That is not incidental. A probe that delivered while
   * reporting would be right exactly once and would then have consumed the
   * items the attach it was warning about was supposed to receive — this
   * ticket's own silent-loss bug, wearing the costume of the fix.
   */
  const queuedForLead = (workspaceId: string): CoverageQueue => ({
    queuedVoice: taskStore.listQueuedVoice(workspaceId).length,
  });
  const queueTotal = (q: CoverageQueue): number => q.queuedVoice;

  /**
   * The coverage readout for one agent's watch set.
   *
   * Two halves, answering two different questions:
   *
   *  - `workspaces` resolves each `ws:<id>` key the agent holds. A key can
   *    name a hub BOARD or a review GROUPING, and today nothing tells the
   *    agent which — so nothing tells it that a board key without an
   *    attachment hears the events but is invisible to every delivery gate.
   *  - `unattachedBoards` is the measured incident: boards this agent covers
   *    on paper but not in fact, each with the count of items queued for that
   *    board's lead. Six docs watched, zero attachments, four items waiting.
   *
   * TWO THINGS PUT A BOARD ON THAT LIST, and the second was missing while
   * this feature's whole point was to create agents of exactly that shape:
   *
   *  - a DOC key the agent holds that resolves to the board, and
   *  - the board's OWN `ws:<id>` key — which is all a declared lead holds. It
   *    holds no doc keys at all, so building the list from doc keys alone
   *    made the one agent this branch teaches the fleet to be the one agent
   *    the probe could not see.
   *
   * A `ws:<setId>` key still raises nothing. It resolves to the board the
   * review sits on, but the agent asked about the review, not about somebody
   * else's seat — and an alarm that fires on the innocent case is how a real
   * one stops being read.
   *
   * "Not in fact" means no LIVE attachment: no record, or a record whose
   * heartbeat has aged out. The gates ask the second question, so this must
   * too, or it reports covered about a board whose every gate answers away.
   */
  const watchCoverageFor = (agentId: string, keys: string[]): WatchCoverage => {
    /**
     * Attachment facts for one agent on one board.
     *
     * Two DIFFERENT questions, deliberately kept apart. `heartbeatFresh` is
     * the displayed active/away label: did this agent SAY it was alive inside
     * the heartbeat window. `live` is the delivery gate: has the server SEEN
     * it recently — heartbeat or tool call, whichever is later — and is the
     * channel open to carry anything.
     *
     * They were one field, and it read the label. The label's window is a
     * third of the delivery one, so an agent that had simply not called
     * `heartbeat` for a few minutes was reported as uncovered while every
     * request was reaching it perfectly — and the remedy it was then handed
     * is seat-claiming, whose entire hazard is evicting a working peer.
     */
    const liveness = (workspaceId: string, who: string) => {
      const att = taskStore.listAttachments(workspaceId).find((a) => a.agentId === who);
      return {
        attached: att !== undefined,
        heartbeatFresh: att !== undefined && att.state !== 'away',
        live: taskStore.hasLiveAttachmentFor(workspaceId, who),
      };
    };

    const workspaces: CoverageWorkspaceRow[] = [];
    /** boardId → the watched doc keys that put it there (empty for a board
     *  reached through its own `ws:` key). */
    const boardsInScope = new Map<string, string[]>();
    for (const key of keys) {
      if (!key.startsWith('ws:')) continue;
      const workspaceId = key.slice('ws:'.length);
      const board = taskStore.getWorkspace(workspaceId);
      if (!board) {
        // Not a board. The key survived the liveness prune, so some doc room
        // still carries this review id.
        workspaces.push({ key, workspaceId, kind: 'review' });
        continue;
      }
      const { attached, heartbeatFresh, live } = liveness(workspaceId, agentId);
      const queued = queuedForLead(workspaceId);
      workspaces.push({
        key,
        workspaceId,
        kind: 'board',
        name: board.name,
        attached,
        heartbeatFresh,
        live,
        lead: board.leadAgentId === agentId,
        queued,
        queuedTotal: queueTotal(queued),
      });
      if (!boardsInScope.has(workspaceId)) boardsInScope.set(workspaceId, []);
    }

    for (const key of keys) {
      if (key.startsWith('ws:')) continue;
      for (const boardId of hubBoardsForDoc(key)) {
        boardsInScope.set(boardId, [...(boardsInScope.get(boardId) ?? []), key]);
      }
    }
    const unattachedBoards: CoverageUnattachedBoard[] = [];
    for (const [workspaceId, watchedDocs] of boardsInScope) {
      const board = taskStore.getWorkspace(workspaceId);
      if (!board) continue;
      const mine = liveness(workspaceId, agentId);
      // A LIVE attachment is coverage; a record alone is not. Read the
      // DELIVERY predicate, not the displayed label — this row's whole claim
      // is "work is queuing that will not reach you", and an agent inside the
      // observed window is being reached.
      if (mine.live) continue;
      const queued = queuedForLead(workspaceId);
      const lead = board.leadAgentId;
      unattachedBoards.push({
        workspaceId,
        name: board.name,
        watchedDocs: [...watchedDocs].sort(),
        queued,
        queuedTotal: queueTotal(queued),
        attached: mine.attached,
        heartbeatFresh: mine.heartbeatFresh,
        ...(lead !== undefined ? { leadAgentId: lead } : {}),
        // Naming the incumbent is what stops the remedy being "take the
        // seat" on a board somebody else is actively working. This asks the
        // same predicate `setLeadAgent`'s own lead-held guard asks, which is
        // the point: read the heartbeat LABEL here and a working lead reports
        // as gone, so the advice says "take the seat" while the server's
        // guard refuses it — the reader is told to do a thing that then
        // silently does not happen.
        leadLive:
          lead !== undefined && lead !== agentId && taskStore.hasLiveLeadAttachment(workspaceId),
      });
    }
    // Loudest first: a board with items actually waiting is the one a reader
    // must not scroll past.
    unattachedBoards.sort((a, b) => b.queuedTotal - a.queuedTotal || a.name.localeCompare(b.name));
    return { agentId, workspaces, unattachedBoards };
  };

  /**
   * ── A WORKSPACE is a board. Everything else in it is content. ──
   *
   * A workspace (`taskStore`) has goals, tasks, a name, and a list of
   * ATTACHMENT ids in `docIds`. An attachment is a doc room id or a REVIEW id
   * — `POST /api/workspaces/:id/docs` has accepted both since it was written.
   * So a review goes on its workspace as ONE row and its members stay off,
   * because a hundred-file review is one unit of work, not a hundred.
   *
   * A REVIEW (`meta.setId`, returned as `reviewId` by `bindDiff`) is the tag
   * binding the member docs of one folder bind or diff review together. It is
   * content, not a container of tasks: it has no doc room of its own, and it
   * is read through `/api/reviews/<setId>/tree|threads`. `reviewIdOf` in
   * `@feedback/core` is the one place a member's review id is derived.
   *
   * Note the board page no longer LISTS attachments: the Docs and
   * Open-threads rails came out (Bryan, 2026-08-18, "remove docs and live
   * threads from the task list"), so `docIds` now feeds the review queue and
   * voice lookup rather than a sidebar.
   *
   * Every doc and every review belongs to a workspace (Bryan, 2026-08-13) —
   * and requiring one must not add a step. "Bind it, send Bryan the URL" is
   * ONE agent call, so a caller with no board in hand does not get an error
   * telling them to go create one first: what arrives unfiled lands on the
   * default board, and the id comes back in the same response so the caller
   * learns where it went.
   */
  const DEFAULT_HUB_WORKSPACE_NAME = 'Unfiled';

  /**
   * The default hub workspace, created on first need.
   *
   * Found by LOOKUP, never remembered in a variable: the store hydrates from
   * disk on boot, so a cached id would fragment into one "Unfiled" per restart
   * — which is the same as no workspace at all, one board per doc.
   */
  const defaultHubWorkspaceId = (): string => {
    const existing = taskStore.listWorkspaces().find((w) => w.name === DEFAULT_HUB_WORKSPACE_NAME);
    if (existing) return existing.id;
    const created = taskStore.createWorkspace(DEFAULT_HUB_WORKSPACE_NAME);
    // createWorkspace emits no event (nothing subscribes to a workspace that
    // doesn't exist yet), so bring the board room up by hand — same as the
    // POST /api/workspaces route.
    taskProjection.ensureWorkspace(created.id);
    return created.id;
  };

  /**
   * The board a doc's "back" affordance should return to, or null.
   *
   * Deliberately NOT `taskStore.workspaceOfDoc`, and the difference is the
   * whole reason this exists. That resolver answers a SHARE-SCOPE question and
   * is documented as non-transitive: a diff review / folder browse is filed on
   * a board as ONE row under its GROUPING id, so every member doc of every
   * review answers null there. Reusing it would fix back for plain docs and
   * leave it broken for exactly the surface Bryan reads most.
   *
   * Widening `workspaceOfDoc` itself would have widened share scoping with it,
   * which is a security decision and not this one — so the fallback lives here
   * and reaches only this field.
   *
   * A doc genuinely on two boards has two answers; the first is taken rather
   * than none, because "back to one of this doc's boards" beats "back to the
   * index of everything on the machine", which is what the arrow does today.
   */
  const backTargetFor = (docId: string, reviewId?: string): { id: string; name: string } | null => {
    const pick = (id: string | undefined): { id: string; name: string } | null => {
      if (!id) return null;
      const ws = taskStore.getWorkspace(id);
      return ws ? { id: ws.id, name: ws.name } : null;
    };
    return pick(hubWorkspacesHolding(docId)[0]) ?? pick(hubWorkspacesHolding(reviewId ?? '')[0]);
  };

  /**
   * Put an attachment — a doc room id OR a review id — on a hub workspace and
   * answer which one. Idempotent: something already attached keeps the board it
   * has (moving it is `attach_doc`'s job, not a side effect of re-binding, and
   * re-running `create_diff_review` on a live review is documented as safe). A
   * `requested` id that names no real board falls back to the default rather
   * than failing the bind — the whole point is that it always lands somewhere.
   */
  const fileUnderHubWorkspace = (attachmentId: string, requested?: string): string => {
    const existing = taskStore.workspaceOfDoc(attachmentId);
    if (existing) return existing;
    const target =
      requested && taskStore.getWorkspace(requested) ? requested : defaultHubWorkspaceId();
    taskStore.attachDoc(target, attachmentId);
    // attachDoc emits no store event; refresh the projection's docIds.
    taskProjection.ensureWorkspace(target);
    return target;
  };

  /**
   * Filing an attachment onto a real board takes it OUT of the default one.
   *
   * Without this, the usual agent flow — create it, then attach it — leaves it
   * linked to two hub workspaces, and `workspaceOfDoc` answers with whichever
   * the store iterates first. That is not cosmetic: it is what SHARE SCOPING
   * resolves against, so a workspace visitor was refused (403) on the very doc
   * the share was created for. The default board is a holding pen, not a second
   * home.
   */
  const unfileFromDefault = (attachmentId: string, keptHubWorkspaceId: string): void => {
    // `find`, never `defaultHubWorkspaceId()` — filing something must not
    // conjure a holding pen on a server that has never needed one.
    const holding = taskStore.listWorkspaces().find((w) => w.name === DEFAULT_HUB_WORKSPACE_NAME);
    if (!holding || holding.id === keptHubWorkspaceId) return;
    const res = taskStore.detachDoc(holding.id, attachmentId);
    if (res.ok && res.removed) taskProjection.ensureWorkspace(holding.id);
  };

  /**
   * A deleted doc — or a deleted REVIEW, which is deleted as one unit and is
   * one row on the board — leaves no link behind. This mattered little while
   * attaching was a deliberate act on a handful of docs; now that everything is
   * filed, a board would otherwise silently accumulate one tombstone per
   * deletion, invisible in the UI because a dangling id renders as nothing.
   */
  const unlinkFromEveryHubWorkspace = (attachmentId: string): void => {
    for (const w of taskStore.listWorkspaces()) {
      const res = taskStore.detachDoc(w.id, attachmentId);
      if (res.ok && res.removed) taskProjection.ensureWorkspace(w.id);
    }
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
  const canonicalDocId = (addressed: string): string => rooms.get(addressed)?.docId ?? addressed;

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
    backTargetFor(docId, reviewIdOf(rooms.get(docId)?.meta ?? {}))?.id ?? null;

  /**
   * The workspace to send THIS caller to for a doc.
   *
   * For a share visitor it is always the workspace they were shared, never
   * whichever workspace happens to hold the doc first. The guard has already
   * established the doc is in their scope by the time they reach a redirect,
   * and sending them anywhere else fails twice over: it names a workspace
   * nobody shared with them, and the guard then refuses the very URL we just
   * handed out — so an old `/review/<docId>` bookmark, which is the shape
   * every link in every existing comment thread has, would 403 for exactly
   * the people shares exist to serve.
   */
  const addressableWorkspaceFor = (docId: string, visitor: ShareTarget | null): string | null =>
    visitor?.workspaceId ?? resolveWorkspaceForDoc(docId);

  /**
   * Which member a review opens on: the meatiest change, matching the entry
   * `create_diff_review` returns. Alphabetical order would land the reviewer
   * on dotfile and config noise on any large review.
   */
  const reviewEntryDocId = (reviewId: string): string | null => {
    const members = rooms.list().filter((m) => reviewIdOf(m) === reviewId);
    if (members.length === 0) return null;
    const best = members.reduce((a, b) =>
      (b.diffAdditions ?? 0) + (b.diffDeletions ?? 0) >
      (a.diffAdditions ?? 0) + (a.diffDeletions ?? 0)
        ? b
        : a,
    );
    return best.docId;
  };

  /** The review app shell for a doc, or its 404. Null when no app is built. */
  const serveDocShell = (docId: string, url: URL): Response | null => {
    if (!markdownAppDist) return null;
    // Docs are file-backed and created upfront via POST /api/docs. Arriving
    // before an agent has done that gets a clean 404 — there is nothing the
    // app could render for a doc that does not exist.
    if (!rooms.get(docId)) {
      return new Response(renderReviewNotFound(docId), {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    // Device-frame simulation: `?mobile=<preset>` returns a shell hosting the
    // real page in an iframe sized to the preset, so media queries inside it
    // see the small width.
    const mobilePreset = url.searchParams.get('mobile');
    if (mobilePreset) {
      return new Response(renderDeviceFrame(mobilePreset, url), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return serveStatic(join(markdownAppDist, 'index.html'));
  };

  /**
   * Whether a doc is a mockup, and so must never be sent to the doc route.
   *
   * The editor shell renders from LF-held content, and a mockup has none —
   * its surface is a host page. Asked for one anyway, the shell loads, finds
   * nothing to show, and paints an empty page under a 200. That is the worst
   * failure shape available: the status says it worked, so nothing upstream
   * reports it and the reviewer is left assuming the mockup itself is broken.
   * Both doc routes therefore check this and redirect instead.
   *
   * Deliberately keyed on the doc's own type rather than `contentKind`: a
   * `workspace` room also holds no content surface, but its route is the
   * board, not a mockup.
   */
  const isMockupDoc = (docId: string): boolean => rooms.get(docId)?.meta.type === 'mockup';

  /**
   * A mockup's own HTML, streamed from the file the room is bound to — with
   * the comment widget added on the way out.
   *
   * The embed is attached HERE rather than written into the file, so a page
   * that a build step generates, or that git tracks, never has to carry review
   * scaffolding to be reviewable. See mockup-widget.ts for the incident that
   * moved it. A page that embeds the widget itself is served untouched.
   */
  const serveMockup = (docId: string): Response => {
    const notFound = () =>
      new Response(renderMockupNotFound(docId), {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    const room = rooms.get(docId);
    if (!room || room.meta.type !== 'mockup' || !room.meta.sourceUrl) return notFound();
    const res = serveStatic(room.meta.sourceUrl);
    if (!res) return notFound();
    // Only HTML gets rewritten; a mockup bound to anything else is served as-is.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith('text/html')) return res;
    return new Response(injectWidget(readFileSync(room.meta.sourceUrl, 'utf8'), room.meta.docId), {
      headers: res.headers,
    });
  };

  /**
   * File every review that predates `fileUnderHubWorkspace` onto a workspace,
   * once per boot and never twice. See review-backfill.ts for why this is
   * needed and why it is safe to re-run; the short version is that 20 of the
   * 23 reviews in the live data dir were created before filing existed, and a
   * review with no workspace has no address under `/workspaces/<id>/…`.
   */
  const runReviewBackfill = (): void => {
    const res = backfillReviewFiling({
      docs: () => rooms.list(),
      isFiled: (reviewId) => taskStore.workspaceOfDoc(reviewId) !== null,
      file: (reviewId) => fileUnderHubWorkspace(reviewId),
    });
    if (res.filed.length > 0) {
      console.log(
        `[reviews] filed ${res.filed.length} previously unfiled review(s) onto a workspace:`,
        res.filed.map((r) => `${r.reviewId}→${r.workspaceId}`).join(', '),
      );
    }
    if (res.failed.length > 0) {
      console.error(`[reviews] could not file: ${res.failed.join(', ')} (will retry next boot)`);
    }
  };
  runReviewBackfill();

  /**
   * CORS is decided once, here, for every response the handler produces,
   * rather than by `j()` — which has no request context and used to stamp
   * `Access-Control-Allow-Origin: *` on everything. See
   * middleware/browser-origin.ts for why that wildcard was a hole.
   */
  /**
   * The origin policy for a request. `localHostnames` mirrors the host gate's
   * own notion of "this machine", so a dev server reached over the tailnet or
   * the LAN — not just loopback — can still embed the widget.
   */
  const policyFor = (req: Request) => {
    // Scheme matters (http://x and https://x are different browser origins),
    // and behind cloudflared the socket is plain http while the browser is on
    // https — so trust the forwarded scheme when the proxy sets one.
    // ALLOWLISTED, not interpolated. This value is concatenated into a URL
    // string, so an unvalidated one rewrites the origin we compare against:
    // `x-forwarded-proto: https://evil.example.com#` makes
    // `new URL('https://evil.example.com#://feedback.example.com').origin`
    // the ATTACKER's origin, originMatch returns 'same-origin', and on the
    // share host — where same-origin is the only rule left — that is the
    // whole boundary gone. A proxy appending to an existing header
    // (`https://evil.example.com#, https`) does it too.
    //
    // Note the asymmetry this fixes: host-guard requires `cf-ray` before it
    // believes a proxy claim, while this trusted a bare header.
    const forwarded = req.headers.get('x-forwarded-proto');
    const scheme =
      forwarded === 'http' || forwarded === 'https'
        ? forwarded
        : new URL(req.url).protocol.replace(':', '');
    const host = req.headers.get('host') ?? '';
    // The dev-server allowances belong to the LOCAL surface, where nothing is
    // cookie-authenticated. A share host is not that: the visitor carries a
    // SameSite=Lax session cookie, and websockets ignore CORS entirely — so an
    // allowed origin that happened to be same-SITE with the share host would
    // carry that cookie into /y/<docId> and act as a logged-in visitor. A
    // share visitor loads the app FROM the share host, so same-origin is all
    // they ever need, and it's all they get.
    // Cached (60s TTL) — tailscaleHost() shells out, and this runs on every
    // write and every websocket handshake.
    const ourNames = localHostnames();
    const isLocalSurface = isTrustedLocalHost(host, {
      lanHosts: ourNames,
      extraHosts: opts.trustedHosts ?? [],
      viaProxy: req.headers.has('cf-ray'),
    });
    return {
      // Canonicalized, not concatenated. A proxy may forward Host with an
      // explicit default port (`feedback.example.com:443`) while the browser
      // sends `Origin: https://feedback.example.com` — a raw string compare
      // would then treat every legitimate request on the share host as
      // foreign and 403 its websocket. URL.origin drops the default port.
      requestOrigin: canonicalOrigin(scheme, host),
      localHostnames: isLocalSurface
        ? [...LOOPBACK_HOSTS, ...ourNames, ...(opts.trustedHosts ?? [])].filter((h) => h !== '')
        : [],
      allowedOrigins: isLocalSurface ? (opts.allowedOrigins ?? []) : [],
    };
  };

  // --- Email-keyed identity ---------------------------------------------
  // The roster and the challenge store. Both are cheap to construct and
  // neither reads anything at boot beyond `identities.json`, so they exist
  // whether or not `CW_REQUIRE_EMAIL_AUTH` is set — the flag governs what a
  // session MEANS, not whether a person can create one. See ServerOptions.
  const identities = new Identities({ dataDir });
  if (identities.loadError) {
    console.error(`[identities] ${identities.loadError}`);
  }
  // Teach the owner check which anonymous session ids belong to a known
  // person. Logged either way: a link file that failed to parse and one that
  // was never written both leave the map empty, and the difference is
  // invisible everywhere downstream — it shows up only as an activity stream
  // that under-attributes, months later. See identity-links.ts.
  // Advertise that this process appends to `<dataDir>/activity.jsonl`, so the
  // repair tool can verify the log has no live writer instead of trusting an
  // operator to have stopped us. BEST EFFORT on purpose: a leftover lock file
  // must never be able to stop the server from booting — that would turn a
  // stray file into an outage. The refusal lives on the repair side, where
  // refusing means "changed nothing". See activity-lock.ts.
  const activityLock = acquireActivityLock(dataDir, 'server');
  if (!activityLock.ok) {
    console.error(
      `[activity] ${activityLock.path} is held by pid ${activityLock.heldBy?.pid} ` +
        `(${activityLock.heldBy?.holder}); starting anyway. A repair running now cannot see us.`,
    );
  }
  const identityLinkLoad = loadIdentityLinks(dataDir);
  if (identityLinkLoad.error) {
    console.error(`[identities] ${identityLinkLoad.error}`);
  } else if (identityLinkLoad.loaded > 0) {
    console.log(`[identities] ${identityLinkLoad.loaded} identity link(s) loaded`);
  }
  const emailCodes = new EmailCodes();
  const codeSender = opts.codeSender ?? createLogCodeSender();
  const requireEmailAuth = opts.requireEmailAuth ?? false;
  // Teach the owner check the owner's email identity. Without this the check
  // keeps matching only `known-bryan` / "Bryan", and the day the owner's
  // identity becomes `user-<hash>` the owner-activity view quietly reads
  // empty with nothing anywhere reporting it. See activity.ts.
  if (opts.ownerEmail && isEmailLike(opts.ownerEmail)) {
    registerOwnerIdentity(emailIdentityId(opts.ownerEmail));
    // Named so the identity exists in the roster before its first write,
    // rather than appearing the first time the owner happens to log in.
    identities.upsertByEmail(opts.ownerEmail);
  } else if (opts.ownerEmail) {
    console.error(`[identities] CW_OWNER_EMAIL is not an address: ${opts.ownerEmail}`);
  }
  let emailSessionKeyCache: string | null = null;
  const emailSessionKey = (): string => {
    emailSessionKeyCache ??= deriveSessionKey(cookieKey());
    return emailSessionKeyCache;
  };

  /**
   * Which client the login rate limits count this request against.
   *
   * NOT `server.requestIP(req)` on its own: both of this deployment's reverse
   * proxies run on this machine and dial the server over loopback, so that
   * call answers `127.0.0.1` for every remote reviewer and collapsed all of
   * them into one shared budget. See middleware/client-address.ts for the
   * measurements and for why the header is read only from a loopback socket
   * and only from its rightmost entry.
   */
  const clientKeyFor = (req: Request): string =>
    clientAddressKey({
      socketAddress: server.requestIP(req)?.address,
      forwardedFor: req.headers.get('x-forwarded-for'),
    });

  /**
   * Whether this request really reached us over https.
   *
   * Read off `policyFor`, which is the ONE place that derives a scheme from
   * an allowlisted `x-forwarded-proto` — the server's own socket is always
   * plain http, so `new URL(req.url).protocol` would answer "http" for every
   * https visitor and strip `Secure` from every cookie they get. Reusing that
   * derivation also inherits its defence against header injection.
   */
  const isSecureRequest = (req: Request): boolean =>
    policyFor(req).requestOrigin.startsWith('https://');

  /**
   * The identity a request's session cookie attests to, or null.
   *
   * Four ways to be null and they are deliberately indistinguishable to the
   * caller: no cookie, a cookie that does not verify or has expired, an
   * identity the roster does not hold, and an identity whose sessions have
   * been revoked or archived. Every one of them means "not signed in".
   */
  const sessionIdentityFor = (req: Request): IdentityRecord | null => {
    const claims = verifyEmailSession(
      readCookie(req.headers.get('cookie'), SESSION_COOKIE),
      emailSessionKey(),
    );
    if (!claims) return null;
    const rec = identities.get(claims.identityId);
    if (!rec || rec.status !== 'active') return null;
    // Server-side revocation: a cookie minted before the watermark is dead
    // however long it says it lives.
    if (claims.issuedAt < rec.sessionsValidFrom) return null;
    return rec;
  };

  /**
   * Extend a live session in place — the "sliding" half of 90 days sliding.
   *
   * Done in the response wrapper rather than per route because "on use" means
   * every request, and a session that lapsed while somebody was reviewing
   * daily would be the one failure this design exists to avoid. Skipped when
   * the response already sets the cookie (login and logout own it), and
   * cheap: the refresh only fires once a day of the session has been spent.
   */
  const refreshSession = (req: Request, res: Response): Response => {
    const raw = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
    if (!raw) return res;
    const claims = verifyEmailSession(raw, emailSessionKey());
    if (!claims || !sessionNeedsRefresh(claims)) return res;
    if (res.headers.get('set-cookie')?.includes(`${SESSION_COOKIE}=`)) return res;
    const rec = sessionIdentityFor(req);
    if (!rec) return res;
    const headers = new Headers(res.headers);
    headers.append(
      'set-cookie',
      emailSessionCookieHeader(mintSession(rec.id), emailSessionKey(), {
        secure: isSecureRequest(req),
      }),
    );
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  const applyCors = (req: Request, res: Response): Response => {
    const headers = corsHeadersFor(req.headers.get('origin'), policyFor(req));
    if (!headers) return res;
    const merged = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: merged,
    });
  };

  // `kind` is what the ONE websocket handler below branches on: Bun routes
  // every upgraded path into the same `open`/`message`/`close`, so the audio
  // socket and the editing socket are told apart by what the upgrade
  // attached. Absent means the editing socket, which is every upgrade that
  // predates meetings.
  const server = Bun.serve<{ docId: string; kind?: 'yjs' | 'audio' }>({
    port,
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
    async fetch(req, server) {
      // `undefined` means the request became a websocket — nothing to decorate.
      const routed = await route(req, server);
      // Compress BEFORE the CORS merge so the encoding headers ride out on the
      // same response the wrapper copies; `maybeCompress` skips anything whose
      // content-type isn't on its allowlist (see compress.ts for why that gate
      // is narrow — a live stream must never be buffered to compress it).
      //
      // `maybeNotModified` runs first: when the client already holds the body,
      // gzipping it is the one case where the CPU buys nothing, and a 304 has
      // no body for `maybeCompress` to act on anyway.
      return routed === undefined
        ? undefined
        : applyCors(
            req,
            refreshSession(req, await maybeCompress(req, maybeNotModified(req, routed))),
          );

      // Hoisted, so the wrapper above can call it first. The whole route
      // table lives in here unchanged.
      async function route(
        req: Request,
        server: BunServer<{ docId: string; kind?: 'yjs' | 'audio' }>,
      ): Promise<Response | undefined> {
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

        // --- Cloudflare Access gate ---
        // When cfAccess is configured (server is reachable via a public
        // tunnel), gate the request. Two modes:
        //   - With shares wired: gate ONLY requests whose Host matches an
        //     active share. Tailscale/LAN traffic to the canonical hostname
        //     stays unauthenticated, so the agent's MCP tools can still
        //     hit /api/share over loopback.
        //   - Without shares: gate everything (legacy/test mode).
        // DEFAULT-DENY BY HOST. The tunnel forwards every hostname under the
        // share wildcard here, so "not a known share host" must mean REFUSE,
        // never "skip the gate" (which is what it used to mean — an unknown
        // tunnel hostname reached the whole API unauthenticated). Only our own
        // local names bypass; a share host is gated AND scoped; anything else
        // is denied even when Access isn't configured, so a half-configured
        // deployment fails closed instead of publishing the API.
        /**
         * Doc metadata as this caller may see it. On the tailnet that's all of
         * it; a share visitor gets an allowlisted subset — the full DocMeta
         * carries absolute paths on Bryan's machine and a tailnet hostname,
         * none of which is needed to render a review.
         */
        const metaFor = <T extends DocMeta>(meta: T): Record<string, unknown> => {
          const decorated = withReviewUrl(meta);
          if (!visitor) return decorated as unknown as Record<string, unknown>;
          return {
            ...redactMetaForVisitor(decorated, {
              workspaceScoped: Boolean(visitor.workspaceId),
            }),
            // Same path, no host, and under the workspace THIS visitor was
            // shared rather than whichever one holds the doc first.
            ...(relativeReviewUrl(decorated.reviewUrl, visitor.workspaceId) !== undefined
              ? { reviewUrl: relativeReviewUrl(decorated.reviewUrl, visitor.workspaceId) }
              : {}),
          };
        };

        /**
         * The identity this request has PROVEN, resolved at most once.
         *
         * Lazy because most requests never ask, and memoized because a write
         * route can call `authorFor` more than once and each call would
         * otherwise re-verify an HMAC.
         */
        let provenIdentity: IdentityRecord | null | undefined;
        const provenIdentityFor = (): IdentityRecord | null => {
          if (provenIdentity !== undefined) return provenIdentity;
          // Cloudflare Access first. It has already verified a signed claim
          // from an identity provider, which is a STRONGER proof than a code
          // we mailed — so an Access visitor skips the code entirely and
          // mints the same `user-<hash>` the code path would have. Composing
          // here rather than building a second verifier is the whole point:
          // the email was already being extracted (cf-access.ts) and thrown
          // away after authorizing, so the person stayed anonymous on a
          // surface that knew exactly who they were.
          if (accessEmail && isEmailLike(accessEmail)) {
            const rec = identities.upsertByEmail(accessEmail);
            provenIdentity = rec.status === 'active' ? rec : null;
            return provenIdentity;
          }
          provenIdentity = sessionIdentityFor(req);
          return provenIdentity;
        };

        /**
         * The author to attribute a write to.
         *
         * Until this commit the tailnet body was simply trusted — the comment
         * here said so — which meant `?as=bryan` on any URL minted
         * `known-bryan`, and `kind: 'known'` only ever meant "typed a name".
         * Now, when a request carries a VERIFIED session, the server's own
         * verdict outranks whatever the body claims. A caller may still say
         * who they are; they no longer get to say it about someone else.
         *
         * Order matters and each rung has a reason:
         *
         *  1. A proven identity, when email identity is in effect. It
         *     outranks the body precisely because the body is the thing it
         *     exists to stop being authoritative.
         *  2. A share visitor with nothing proven stays a `guest-` — that
         *     path is the template this work copies, not a thing it replaces,
         *     and link mode keeps minting guests.
         *  3. Otherwise the claimed body, exactly as today. This is the rung
         *     every agent, every MCP call and every un-authenticated browser
         *     lands on, so a request with no session behaves identically
         *     whichever way the flag is set.
         *
         * Rung 1 is behind `CW_REQUIRE_EMAIL_AUTH` (default off), so with the
         * flag off this function is byte-for-byte what it was.
         */
        const authorFor = (claimed: unknown): User | undefined => {
          if (requireEmailAuth) {
            const proven = provenIdentityFor();
            if (proven) return userForIdentity(proven);
          }
          if (visitor) {
            return sanitizeVisitorAuthor(claimed, {
              // The SHARE, not the doc: two links to the same doc are two
              // different audiences, and seeding from the doc id would give a
              // returning browser the same guest identity on both — attributing
              // comments on a freshly minted link to the old one's visitor.
              // The `?? ''` is unreachable: the guard refuses a target with
              // no workspaceId, so a visitor always has one. Typed optional
              // there so an old doc-only shape is refused at runtime rather
              // than only at compile time.
              shareKey: visitorShareId ?? visitor.workspaceId ?? '',
            });
          }
          return claimed as User | undefined;
        };

        /**
         * Thread→task surfacing (§3.12 commit 4): decorate a thread payload
         * with chips for the tasks that reference it — via `links` or via a
         * promotion `origin`. The chip is the §3.3 rule-2 visitor-safe shape,
         * so visitors get the decoration too. Omitted when empty (trimmed
         * results, §3.10) — every reader treats a missing `tasks` as none.
         */
        const withTaskChips = <T extends { id: string }>(docId: string, t: T): T => {
          const chips = taskStore.tasksReferencingThread(docId, t.id).map(taskChip);
          return chips.length > 0 ? { ...t, tasks: chips } : t;
        };

        // Set when this request comes from a SHARE visitor (either mode).
        // Everything below treats a non-null value as "untrusted outsider":
        // their claimed identity is rewritten and doc metadata is redacted.
        let visitor: ShareTarget | null = null;
        /** The share that authorized this request, stamped onto any websocket
         *  it upgrades so revocation can find and close it later. */
        let visitorShareId: string | null = null;
        /**
         * The email Cloudflare Access verified for this request, if any.
         *
         * Every branch below that runs a verifier fills this in, and nothing
         * reads it unless `CW_REQUIRE_EMAIL_AUTH` is on. A verified claim is
         * an identity; ABSENT it, the visitor stays a `guest-` exactly as
         * before — never unattributed, and never a fallback to whatever the
         * body claimed, because a share visitor's body is the thing the guest
         * namespace exists to distrust.
         */
        let accessEmail: string | null = null;
        {
          const decision = classifyHost(req.headers.get('host'), {
            // Cached (60s TTL) — this used to spawn `tailscale status` on
            // every single request.
            lanHosts: localHostnames(),
            extraHosts: opts.trustedHosts ?? [],
            // cloudflared forwards the visitor's Host verbatim, so a tunnel
            // visitor could otherwise claim `Host: localhost`. Cloudflare
            // stamps cf-ray on everything it proxies (overwriting any the
            // client sent), so its presence means "not from our LAN".
            viaProxy: req.headers.has('cf-ray'),
            // The opt-in collaboration hostnames, and the fact that Access
            // really is configured for them. Both are required before a
            // proxied host can classify anything but `deny` — see
            // `isAccessTunnelHost`.
            proxiedAccessHosts: accessTunnelHosts,
            accessFronted: collabAccessVerifier !== null,
            lookupShare: (h) => {
              // LIVE, not merely known: an expired share's hostname must stop
              // being a share hostname, or expiry never takes effect for
              // Access mode (see Shares.findLiveByHostname).
              return boardShareTarget(shares?.findLiveByHostname(h));
            },
            linkHost: shares?.publicHostname ?? null,
          });
          if (decision.kind === 'deny') {
            return j(403, { error: 'unknown_host' });
          }
          // --- External-access master switch ---
          // AHEAD of both auth paths on purpose: while sharing is off, a live
          // Access JWT, an unexpired session cookie and no credential at all
          // must be indistinguishable. Gating after auth would leak which
          // slugs are real to anyone still holding one.
          //
          // Only external hosts pass through here — `local` returned above
          // this point untouched, so the agent's MCP calls over loopback and
          // Bryan's own browser keep working while the outside door is shut.
          //
          // `collab` is in here with the other two: it is external reach by
          // the same definition, so the one switch that answers "is anything
          // reachable from outside right now?" has to cover it. One honest
          // limit — a collab request carries no shareId, so the hang-up sweep
          // that runs when the switch is flipped off (`closeSocketsForShare`)
          // cannot find its live sockets. Flipping the switch closes the door
          // to new requests immediately; an already-open collab websocket
          // survives until the process restarts.
          if (
            (decision.kind === 'share' || decision.kind === 'link' || decision.kind === 'collab') &&
            !sharingGate.isEnabled()
          ) {
            return j(403, { error: 'sharing_disabled' });
          }
          if (decision.kind === 'share') {
            if (!cfAccessVerifier) {
              // A share exists but we cannot verify Access tokens — refuse
              // rather than serve the doc to an unauthenticated visitor.
              return j(503, { error: 'access_not_configured' });
            }
            const result = await cfAccessVerifier(req);
            if (!result.ok) return j(result.status, { error: result.error });
            accessEmail = result.email ?? null;
            // Authenticated for THIS share — but Access only proves the
            // visitor's email domain, not what they may touch. Scope them to
            // the shared board: no doc enumeration, no workspace/diff
            // creation, no share administration.
            if (!shareScopeAllows(pathname, req.method, decision.target, shareWorkspacesOf)) {
              return j(403, { error: 'out_of_share_scope' });
            }
            visitor = decision.target;
            visitorShareId =
              shares?.findLiveByHostname(req.headers.get('host') ?? '')?.shareId ?? null;
          } else if (decision.kind === 'link') {
            // Redeeming a link is the ONLY thing reachable here without a
            // session — that request is what mints one.
            // Matched with the SAME regex the redeem route uses. A `startsWith`
            // prefix let any GET under /s/ skip the session check — inert today
            // because nothing else is mounted there and URL normalizes `..`,
            // but it becomes a hole the moment something is.
            const redeeming = req.method === 'GET' && /^\/s\/[^/]+$/.test(pathname);
            if (!redeeming) {
              const target = linkSessionTarget(req);
              if (!target) return j(401, { error: 'no_share_session' });
              if (!shareScopeAllows(pathname, req.method, target, shareWorkspacesOf)) {
                return j(403, { error: 'out_of_share_scope' });
              }
              visitor = target;
              visitorShareId = linkSessionShareId(req);
            }
          } else if (decision.kind === 'collab') {
            // The collaboration hostname: one stable public address, an
            // Access application in front of it, and the SHARE surface behind
            // it — scoped per request to whichever workspace the path names.
            //
            // Non-null by construction (the host could not have classified
            // collab otherwise), re-checked because "I could not verify"
            // must never mean "serve it".
            if (!collabAccessVerifier) {
              return j(503, { error: 'access_not_configured' });
            }
            const result = await collabAccessVerifier(req);
            if (!result.ok) return j(result.status, { error: result.error });
            accessEmail = result.email ?? null;
            // Access proves an identity Bryan admitted, not what they may
            // touch. `collabScope` is `shareScopeAllows` with the path's own
            // workspace as the target, so every operator verb a share visitor
            // is refused — the doc list, share administration, folder binds,
            // diff creation, delete, wholesale rewrite, the landing page — is
            // refused here by the same lines.
            const scope = collabScope(pathname, req.method, shareWorkspacesOf);
            if (!scope.allowed) return j(403, { error: 'out_of_share_scope' });
            // An outsider like any other: identity rewritten to a guest, doc
            // metadata redacted, `visitor`-gated routes closed. What it does
            // NOT get is a `visitorShareId` — there is no share behind it.
            visitor = scope.target;
          } else if (cfAccessVerifier && !shares) {
            // Legacy whole-server mode: cfAccess configured WITHOUT per-share
            // hostnames means the entire deployment sits behind Access, so
            // even a local-looking Host must present a token. (With shares
            // wired, local traffic is the agent's own MCP calls over loopback
            // and stays unauthenticated.)
            const result = await cfAccessVerifier(req);
            if (!result.ok) return j(result.status, { error: result.error });
            accessEmail = result.email ?? null;
          }
        }

        // --- REST: email login ---
        // Reachability (the host gate, Access, a share session) and identity
        // (who you are) stay orthogonal: a local host still bypasses the host
        // guard — it may REACH the server — and still has to say who it is.
        // These routes are what "saying who you are" means.
        //
        // They sit AFTER the host decision on purpose, so a share visitor
        // reaches them only if `shareScopeAllows` lets them, and it does not:
        // link mode keeps minting `guest-` identities and this is not a way
        // around that.
        if (pathname === '/api/auth/start' && req.method === 'POST') {
          const body = await safeJson(req);
          const email = typeof body?.email === 'string' ? body.email : '';
          const peer = clientKeyFor(req);
          const started = emailCodes.start(email, peer);
          if (!started.ok) {
            if (started.error === 'rate_limited') {
              return new Response(
                JSON.stringify({
                  error: 'rate_limited',
                  retryAfterSeconds: started.retryAfterSeconds,
                }),
                {
                  status: 429,
                  headers: {
                    'content-type': 'application/json',
                    'retry-after': String(started.retryAfterSeconds),
                  },
                },
              );
            }
            return j(400, { error: 'invalid_email' });
          }
          try {
            await codeSender.send({
              to: started.email,
              code: started.code,
              expiresInMinutes: Math.round(CODE_TTL_MS / 60_000),
            });
          } catch (err) {
            // 502 and NOT a silent 200. Answering ok here would put the
            // reviewer in front of a code box for a code that does not exist,
            // and the only evidence anywhere would be a log line nobody
            // reads. The challenge stays live — a retry re-sends rather than
            // stranding them — and the rate limit still counted this attempt,
            // which is what stops a broken provider becoming a retry loop.
            console.error(
              `[auth] could not send a login code via "${codeSender.name}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            return j(502, { error: 'code_send_failed' });
          }
          // NEVER the code. The response is read by whoever made the request,
          // and the whole point of mailing a code is that those are different
          // people until one proves otherwise.
          return j(200, {
            ok: true,
            email: started.email,
            expiresInSeconds: Math.max(0, Math.floor((started.expiresAt - Date.now()) / 1000)),
          });
        }

        if (pathname === '/api/auth/verify' && req.method === 'POST') {
          const body = await safeJson(req);
          const email = typeof body?.email === 'string' ? body.email : '';
          const code = typeof body?.code === 'string' ? body.code : '';
          const peer = clientKeyFor(req);
          const result = emailCodes.verify(email, code, peer);
          if (!result.ok) {
            if (result.error === 'rate_limited') {
              return j(429, {
                error: 'rate_limited',
                retryAfterSeconds: result.retryAfterSeconds,
              });
            }
            if (result.error === 'too_many_attempts') {
              return j(429, { error: 'too_many_attempts' });
            }
            if (result.error === 'invalid_email') return j(400, { error: 'invalid_email' });
            return j(401, { error: result.error });
          }
          const rec = identities.upsertByEmail(result.email);
          if (rec.status !== 'active') {
            // An archived identity proved control of its mailbox and still
            // may not sign in. Un-archiving is somebody's decision.
            return j(403, { error: 'identity_archived' });
          }
          return new Response(JSON.stringify({ ok: true, user: userForIdentity(rec) }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie': emailSessionCookieHeader(mintSession(rec.id), emailSessionKey(), {
                secure: isSecureRequest(req),
              }),
            },
          });
        }

        if (pathname === '/api/auth/session' && req.method === 'GET') {
          const rec = sessionIdentityFor(req);
          return j(200, {
            // Whether email identity is IN EFFECT, so a client can tell "not
            // signed in" from "signing in does not matter here yet".
            required: requireEmailAuth,
            authenticated: rec !== null,
            ...(rec ? { user: userForIdentity(rec) } : {}),
          });
        }

        if (pathname === '/api/auth/logout' && req.method === 'POST') {
          // This browser only. Ending a person's sessions everywhere is a
          // roster operation (`revokeSessions`), not a cookie one.
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie': clearedSessionCookieHeader({ secure: isSecureRequest(req) }),
            },
          });
        }

        // --- REST: shares ---
        if (pathname === '/api/share' && req.method === 'GET') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          return j(200, { shares: shares.list(), sharing: sharingGate.status() });
        }
        // Flip the master switch. Local-only, like the rest of /api/share*.
        // Turning it OFF also hangs up what is already connected: a websocket
        // and an SSE stream are authorized ONCE at open, so a visitor mid-review
        // would otherwise keep syncing and keep receiving comments on a doc
        // that is no longer reachable. Same lesson as share revocation.
        if (pathname === '/api/share/enabled' && req.method === 'POST') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const body = await safeJson(req);
          const enabled = body?.enabled;
          if (typeof enabled !== 'boolean') {
            return j(400, { error: 'enabled must be a boolean' });
          }
          const res = sharingGate.setEnabled(enabled);
          if (!res.ok) {
            return j(409, {
              error: res.error,
              hint: 'CW_SHARING_DISABLED is set in the environment. Remove it from the service definition and restart to allow runtime control.',
            });
          }
          let closedSockets = 0;
          let closedStreams = 0;
          if (!enabled) {
            for (const share of shares.list()) {
              closedSockets += rooms.closeSocketsForShare(share.shareId);
              closedStreams += sse.closeForShare(share.shareId);
            }
          }
          return j(200, {
            ok: true,
            sharing: sharingGate.status(),
            ...(closedSockets ? { closedSockets } : {}),
            ...(closedStreams ? { closedStreams } : {}),
          });
        }
        // `POST /api/share/doc` is GONE — a workspace is the unit of sharing.
        // It is answered explicitly rather than left to the 404 fall-through
        // because an older plugin bundle's `share_doc` still POSTs here with
        // its own payload, and the useful reply names the replacement instead
        // of reading as "your server is broken".
        if (pathname === '/api/share/doc' && req.method === 'POST') {
          return j(410, {
            error: 'per_doc_sharing_removed',
            hint: 'A workspace is the unit of sharing. File the doc on a workspace (attach_doc / bind_folder / create_diff_review) and call share_workspace or share_link with workspaceId.',
          });
        }
        // --- Redeem a share link ---
        // The slug is a bearer credential: exchange it for a signed session
        // cookie, then redirect to the doc. Deliberately gives nothing away
        // on failure — an unknown, expired, or malformed slug all look alike.
        const redeemMatch = pathname.match(/^\/s\/([^/]+)$/);
        if (redeemMatch && req.method === 'GET') {
          const slug = decodeURIComponent(redeemMatch[1] ?? '');
          const share = shares?.findBySlug(slug) ?? null;
          if (!share) {
            return new Response(renderLinkNotFound(), {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          // A share lands IN the board — never a review URL, never a lobby
          // (§2.5). Resolved at redemption like everything else, so a board
          // deleted after minting falls through to the same not-found.
          //
          // A legacy GROUPING share lands here too, and gets that same 404
          // rather than a named 410. The route's own rule is that an unknown,
          // an expired and a malformed slug are indistinguishable — telling a
          // stranger holding a leaked link that it was once real would give
          // away more than the removal takes back. The named 410 is for the
          // MINT routes, where the caller is a peer with a legitimate ask.
          if (!boardShareTarget(share)) {
            return new Response(renderLinkNotFound(), {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          const maxAge = Math.floor((share.expiresAt - Date.now()) / 1000);
          return new Response(null, {
            status: 302,
            headers: {
              location: `/workspaces/${encodeURIComponent(share.workspaceId)}`,
              'set-cookie': sessionCookieHeader(share.shareId, cookieKey(), maxAge),
              // Keep the slug out of any downstream Referer header.
              'referrer-policy': 'no-referrer',
            },
          });
        }

        // Mint a share link. Local-only: /api/share* is out of scope for a
        // visitor, so this can only be called from the machine or the tailnet.
        if (pathname === '/api/share/link' && req.method === 'POST') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const body = await safeJson(req);
          const workspaceId = body?.workspaceId as string | undefined;
          // A `docId` in the body is an OLDER BUNDLE's share_link asking for a
          // single-doc share. That grant is gone, and the dangerous reading of
          // this payload is "ignore the field you don't know and mint
          // something" — so it is refused by name, before anything is created.
          // Every peer keeps calling the shared server with the payload ITS
          // bundle sends, long after this one stopped sending it.
          if (body?.docId !== undefined) {
            return j(410, {
              error: 'per_doc_sharing_removed',
              hint: 'A workspace is the unit of sharing. Pass workspaceId (the doc must be filed on a workspace) — docId is no longer accepted.',
            });
          }
          if (!workspaceId) return j(400, { error: 'workspaceId required' });

          // Only a BOARD may be shared. A board is what `taskStore` answers
          // for; a review is what only `rooms` knows about. They arrive in
          // the SAME field — unlike the per-doc removal above, no shape of
          // the payload separates them — so the lookup IS the discriminator.
          const linkBoard = taskStore.getWorkspace(workspaceId);
          if (!linkBoard) {
            if (rooms.list().some((m) => m.workspaceId === workspaceId)) {
              return j(410, GROUPING_SHARING_REMOVED);
            }
            // Neither. Kept distinct from the 410 so that reply keeps meaning
            // "this exists and is no longer shareable" rather than becoming
            // the answer to every unrecognised id.
            return j(404, { error: 'workspace not found', workspaceId });
          }
          // And never the UNFILED board. Matched by NAME, because that is
          // how `defaultHubWorkspaceId()` itself finds it on every call —
          // the id is never cached, and any board answering that lookup can
          // receive other agents' stray reviews.
          if (linkBoard.name === DEFAULT_HUB_WORKSPACE_NAME) {
            return j(403, UNFILED_SHARING_REFUSED);
          }
          // A board share opens the board. There is no entry doc to choose,
          // and an older bundle sharing a board sends this key undefined,
          // which JSON.stringify drops.
          if (body?.entryDocId) {
            return j(400, {
              error: 'a board share opens the board — entryDocId is not supported',
            });
          }
          try {
            const share = shares.createShareLink({
              workspaceId,
              ttlSeconds: typeof body?.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
              label: typeof body?.label === 'string' ? body.label : undefined,
            });
            return j(200, { share });
          } catch (err) {
            const error = err instanceof Error ? err.message : 'create_share_failed';
            return j(400, { error });
          }
        }

        // Extend or shorten a live share. Local-only, same as creation.
        const ttlMatch = pathname.match(/^\/api\/share\/([^/]+)\/ttl$/);
        if (ttlMatch && req.method === 'POST') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const shareId = decodeURIComponent(ttlMatch[1] ?? '');
          const body = await safeJson(req);
          const ttlSeconds = body?.ttlSeconds;
          if (typeof ttlSeconds !== 'number') return j(400, { error: 'ttlSeconds required' });
          try {
            const share = shares.setTtl(shareId, ttlSeconds);
            return share ? j(200, { share }) : j(404, { error: 'share not found' });
          } catch (err) {
            return j(400, { error: err instanceof Error ? err.message : 'bad ttl' });
          }
        }

        // Share a whole workspace (folder bind / diff review) rather than one
        // doc: the visitor gets the file tree and every member, so the set
        // browses as a set. Scope is enforced in middleware/host-guard.ts.
        if (pathname === '/api/share/workspace' && req.method === 'POST') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const body = await safeJson(req);
          const workspaceId = (body?.workspaceId as string) ?? '';
          const allowDomains = (body?.allowDomains as string[]) ?? [];
          if (!workspaceId) return j(400, { error: 'workspaceId required' });
          if (!Array.isArray(allowDomains) || allowDomains.length === 0) {
            return j(400, { error: 'allowDomains must be a non-empty array' });
          }
          // Same board-only rule as the link route, and for the same reason:
          // the two modes differ only in how a visitor is authorized, never
          // in what may be shared.
          const accessBoard = taskStore.getWorkspace(workspaceId);
          if (!accessBoard) {
            if (rooms.list().some((m) => m.workspaceId === workspaceId)) {
              return j(410, GROUPING_SHARING_REMOVED);
            }
            return j(404, { error: 'workspace not found', workspaceId });
          }
          // Same Unfiled refusal as the link route — see there for why the
          // predicate is the board's name.
          if (accessBoard.name === DEFAULT_HUB_WORKSPACE_NAME) {
            return j(403, UNFILED_SHARING_REFUSED);
          }
          if (body?.entryDocId) {
            return j(400, {
              error: 'a board share opens the board — entryDocId is not supported',
            });
          }
          try {
            const share = await shares.createShareWorkspace({
              workspaceId,
              allowDomains,
              ttlSeconds: typeof body?.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
              name: typeof body?.name === 'string' ? body.name : undefined,
            });
            return j(200, { share });
          } catch (err) {
            const error = err instanceof Error ? err.message : 'create_share_failed';
            return j(502, { error });
          }
        }
        const shareIdMatch = pathname.match(/^\/api\/share\/([^/]+)$/);
        if (shareIdMatch && req.method === 'DELETE') {
          if (!shares) return j(404, { error: 'sharing not enabled' });
          const shareId = decodeURIComponent(shareIdMatch[1] ?? '');
          try {
            const result = await shares.deleteShare(shareId);
            // Authorization is checked per HTTP request, but a websocket is
            // authorized once at its upgrade — so without this, a visitor who
            // already had the doc open kept reading and writing it after the
            // share was revoked.
            const closed = result.ok ? rooms.closeSocketsForShare(shareId) : 0;
            // The SSE stream has the same "authorized once, then long-lived"
            // shape: a visitor with the review page still open would otherwise
            // keep receiving every new comment on a doc they can no longer load.
            const closedStreams = result.ok ? sse.closeForShare(shareId) : 0;
            return result.ok
              ? j(200, {
                  ok: true,
                  ...(closed ? { closedSockets: closed } : {}),
                  ...(closedStreams ? { closedStreams } : {}),
                })
              : j(404, { error: 'share not found' });
          } catch (err) {
            const error = err instanceof Error ? err.message : 'delete_share_failed';
            return j(502, { error });
          }
        }

        // --- WebSocket upgrade: a doc's live meeting audio ---
        //
        // Same guard as `/y/` below and for the same reason: CORS does not
        // apply to websockets, so without the Origin check any page the user
        // visits could open a microphone relay against any doc — and this one
        // spends money while it is open.
        if (pathname.startsWith('/audio/')) {
          if (!isAllowedBrowserOrigin(req.headers.get('origin'), policyFor(req))) {
            return j(403, { error: 'origin_not_allowed' });
          }
          const addressed = decodeURIComponent(pathname.slice('/audio/'.length));
          if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
          const docId = rooms.get(addressed)?.docId ?? addressed;
          // Unlike `/y/`, this never conjures a room: a meeting belongs to a
          // doc that already exists, and auto-creating one here would let a
          // typo start a billed session against a doc nobody can find.
          if (!rooms.get(docId)) return j(404, { error: 'doc not found' });
          const upgraded = server.upgrade(req, { data: { docId, kind: 'audio' as const } });
          if (!upgraded) return new Response('upgrade required', { status: 426 });
          return undefined;
        }

        // --- WebSocket upgrade ---
        if (pathname.startsWith('/y/')) {
          // CORS does not apply to websockets — the browser opens the socket and
          // hands the page the data regardless of what headers we set. So the
          // Origin check has to happen HERE, or any page the user visits can
          // sync (and mutate) any doc. Reproduced before this existed: a socket
          // sent with `Origin: https://evil.example.com` synced a real document.
          if (!isAllowedBrowserOrigin(req.headers.get('origin'), policyFor(req))) {
            return j(403, { error: 'origin_not_allowed' });
          }
          const addressed = decodeURIComponent(pathname.slice(3));
          if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
          // `ws.data.docId` is re-resolved on every frame, so it must be the
          // canonical id — a socket opened by alias would otherwise sync a
          // room of its own.
          const docId = rooms.get(addressed)?.docId ?? addressed;
          const type = url.searchParams.get('type') as DocType | null;
          const sourceUrl = url.searchParams.get('sourceUrl') ?? undefined;
          // Mockup docs auto-create on WS — the widget connects first with a
          // known type + sourceUrl (this covers the dev-server surface too;
          // the widget always identifies as 'mockup'). Markdown docs MUST be
          // created upfront via POST /api/docs (which auto-attaches a file).
          // The browser navigating to /review/<docId> before the agent has
          // created the doc gets a clean 404 from /review's own handler.
          if (!rooms.get(docId)) {
            if (type === 'mockup') {
              rooms.getOrCreate(docId, { type, sourceUrl });
              // The widget is the third creation path (next to POST /api/docs
              // and the MCP tools that front it), so it files its doc too —
              // otherwise a mockup that was only ever opened in a browser is
              // an orphan the hub can't see.
              fileUnderHubWorkspace(docId);
            } else {
              return j(404, { error: 'doc not found' });
            }
          }
          const upgraded = server.upgrade(req, {
            data: { docId, ...(visitorShareId ? { shareId: visitorShareId } : {}) },
          });
          if (!upgraded) return new Response('upgrade required', { status: 426 });
          return undefined;
        }

        // --- SSE (workspace-level): every thread event on any member doc of a
        // workspace/diff review, one stream — agents watch this instead of one
        // stream per file. ---
        const wsEventsMatch = pathname.match(/^\/events\/workspace\/([^/]+)$/);
        if (wsEventsMatch) {
          const workspaceId = decodeURIComponent(wsEventsMatch[1] ?? '');
          if (!isValidDocId(workspaceId)) return j(400, { error: 'bad workspaceId' });
          // A workspace channel exists for reviews (diff
          // reviews / folder binds) AND for hub workspaces — task.* events
          // broadcast on the same `ws~<id>` channel (§3.6).
          const exists =
            rooms.list().some((m) => m.workspaceId === workspaceId) ||
            taskStore.getWorkspace(workspaceId) !== undefined;
          if (!exists) return j(404, { error: 'workspace not found' });
          // A share visitor's stream carries the §3.3 visitor-contract view
          // of every hub event (display names, projected tasks) — the SSE
          // feed is the second door next to the ws room, and redacting one
          // transport but not the other is how the DocMeta leak shipped.
          // An agent's MCP child names itself here; a browser tab does not.
          // A visitor never counts as one — their stream is authorized by a
          // share, and letting a share-bearer claim an agentId would let an
          // outside tab impersonate the agent whose work it can see.
          const streamAgentId = visitor
            ? undefined
            : (url.searchParams.get('agentId') ?? undefined);
          return openSseStream(
            sse,
            `ws~${workspaceId}`,
            visitorShareId ?? undefined,
            visitor ? redactHubEventForVisitor : undefined,
            streamAgentId,
            sseLastEventId(req, url),
          );
        }
        // --- SSE ---
        if (pathname.startsWith('/events/')) {
          const addressed = decodeURIComponent(pathname.slice('/events/'.length));
          if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
          const eventsRoom = rooms.get(addressed);
          if (!eventsRoom) return j(404, { error: 'doc not found' });
          // The CHANNEL is the doc's own id: a watcher that opened the stream
          // by the readable name and a writer that fired on the canonical one
          // have to meet, and they only do if both spellings collapse here.
          return openSseStream(
            sse,
            eventsRoom.docId,
            visitorShareId ?? undefined,
            undefined,
            undefined,
            sseLastEventId(req, url),
          );
        }

        // --- REST: docs ---
        if (pathname === '/api/docs' && req.method === 'POST') {
          const body = await safeJson(req);
          const docId = (body?.docId as string) ?? '';
          if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
          const type = (body?.type as DocType) ?? 'markdown';
          const sourceUrl = body?.sourceUrl as string | undefined;
          // Every markdown doc is file-backed. POST /api/docs is the sole
          // creation path for markdown — sourceUrl is required, and the
          // server attaches the file (loads content + sets up bidirectional
          // disk sync) before returning. Mockup/dev docs are about
          // commenting on running surfaces, not about a markdown buffer,
          // so they don't need a file.
          // Diff docs are created only via POST /api/diffs, which resolves the
          // range and seeds content from git — a bare create can't do that.
          if (type === 'diff') {
            return j(400, {
              error: 'use /api/diffs',
              hint: 'Diff review docs are created per changed file by POST /api/diffs {repo, base, target}.',
            });
          }
          if ((type === 'markdown' || type === 'code') && !sourceUrl) {
            return j(400, {
              error: 'sourceUrl required',
              hint: 'Markdown and code review docs are backed by a file on disk. Pass sourceUrl: "/abs/path/to/file" in the POST body.',
            });
          }
          // The caller NAMES the doc; the server decides its id. `docId` in
          // the body is therefore a readable alias from here on — which is
          // also what closes the write-anywhere hole this route was: a
          // `task:<realTaskId>` body used to land on that task's live
          // description and file-bind it, 200 and no audit row. A caller
          // cannot address a server-owned namespace by a name it invents.
          const created = rooms.createForCaller(docId, {
            type,
            sourceUrl,
            title: body?.title as string | undefined,
            setId: body?.setId as string | undefined,
            webhookUrl: body?.webhookUrl as string | undefined,
            owner: body?.owner as string | undefined,
            workspaceId: body?.workspaceId as string | undefined,
            relPath: body?.relPath as string | undefined,
            workspaceRoot: body?.workspaceRoot as string | undefined,
            producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
          });
          if (!created.ok) {
            return j(400, {
              error: created.error,
              hint: `"${docId}" is in a namespace the server owns (${RESERVED_DOC_PREFIXES.join(', ')}). Pick a docId that isn't.`,
            });
          }
          const room = created.room;
          // Canonical from here down. Everything below keys on the doc's own
          // id, never the name the request arrived under — two callers using
          // the two spellings of one doc must not end up with two of anything.
          const canonicalId = room.docId;
          // Before the file attach, not after: the room already exists at this
          // point, and the 409 below returns early — filing afterwards would
          // leave a failed bind as the one doc this route can still strand
          // outside a workspace.
          const hubWorkspaceId = fileUnderHubWorkspace(
            canonicalId,
            body?.hubWorkspaceId as string | undefined,
          );
          let attached: ReturnType<typeof rooms.attachFile> | undefined;
          if (type === 'markdown' && sourceUrl) {
            attached = rooms.attachFile(canonicalId, sourceUrl);
            if (!attached.ok) return j(409, { error: 'attach_failed', attached });
          } else if (type === 'code' && sourceUrl) {
            attached = rooms.attachReadonlyFile(canonicalId, sourceUrl);
            if (!attached.ok) return j(409, { error: 'attach_failed', attached });
          }
          return j(200, {
            docId: room.docId,
            meta: withReviewUrl(room.meta),
            // Where the doc landed, in the same call that created it — a
            // caller who supplied no workspace still learns which one it got.
            hubWorkspaceId,
            ...(attached ? { attached } : {}),
          });
        }
        if (pathname === '/api/docs' && req.method === 'GET') {
          // `?workspaceId=` scopes the listing. Without honouring it here,
          // list_docs accepted the param and silently answered a board-scoped
          // question with every doc on the server. It matches either kind of
          // id a caller holds under the name "workspace": the review tag in
          // meta (folder binds, diff reviews) or a hub board the doc is filed
          // under — resolved via hubBoardsForDoc so the answer is the same
          // set the event fan-out and coverage readout already use.
          //
          // `?setId=` scopes it to one REVIEW instead. It exists because the
          // sidebar's legacy flat-set path had no way to ask: it fetched every
          // doc on the server — 4,205,683 bytes for 4,062 rows, measured
          // 2026-08-21 — and kept the 6 that shared its setId. Matching goes
          // through `reviewIdOf` so this route cannot answer differently from
          // the other set queries beside it (grouped diff, repo files, tree),
          // which means a doc restored from an archive carrying only the
          // deprecated `workspaceId` spelling is still found by its set.
          const workspaceId = url.searchParams.get('workspaceId');
          const setId = url.searchParams.get('setId');
          const all = rooms.list();
          // ONE pass over the workspaces for the whole listing. Both the
          // board filter and the reviewUrl below used to run their own scan
          // per row, which is what made an unscoped listing quadratic — and
          // on Bun's single JS thread a quadratic listing stops the server
          // answering anything else while it runs. See `boardIndexForListing`.
          const boardIndex = boardIndexForListing();
          const byWorkspace = workspaceId
            ? all.filter(
                (m) =>
                  m.workspaceId === workspaceId ||
                  hubBoardsForDocIndexed(boardIndex, m).has(workspaceId),
              )
            : all;
          const docs = setId ? byWorkspace.filter((m) => reviewIdOf(m) === setId) : byWorkspace;
          return j(200, {
            docs: docs.map((m) => withReviewUrl(m, homeForDocIndexed(boardIndex, m))),
          });
        }

        // --- REST: workspaces (hub create OR folder bind) ---
        // One resource, two shapes: `folderPath` binds a folder of files
        // (the review), `name` creates a hub Workspace —
        // a NEW first-class entity with a crypto-random id that tasks and
        // goals hang off (plan §3.12 commit 1). Nothing is migrated between
        // the two; attach_doc LINKS existing docs/reviews to a hub workspace.
        if (pathname === '/api/workspaces' && req.method === 'POST') {
          const body = await safeJson(req);
          const folderPath = body?.folderPath as string | undefined;
          if (!folderPath && typeof body?.name === 'string' && body.name.trim().length > 0) {
            // `body.goal` is the removed workspace-level text goal. Read
            // deliberately nowhere: bundles built before the removal still
            // send it, and refusing a field the server has stopped caring
            // about would fail a caller for saying something harmless.
            // Who leads the board. Explicit `leadAgentId` wins; otherwise the
            // CREATING agent takes the seat — which is the whole point of
            // "every workspace has a lead, always": the common path is an
            // agent minting a board for work it is about to do. A person
            // creating one leaves the seat open rather than being installed
            // as an agent lead; the first agent to attach claims it.
            const claimed = body?.leadAgentId;
            const author = authorFor(body?.author);
            const leadAgentId =
              typeof claimed === 'string' && claimed.trim().length > 0
                ? claimed.trim()
                : author && classifyActor(author) === 'agent'
                  ? author.id
                  : undefined;
            const workspace = taskStore.createWorkspace(body.name.trim(), {
              ...(leadAgentId !== undefined ? { leadAgentId } : {}),
            });
            // createWorkspace emits no event (nothing subscribes to a
            // workspace that doesn't exist yet), so the route brings the
            // board room up itself.
            taskProjection.ensureWorkspace(workspace.id);
            return j(200, { workspace });
          }
          if (!folderPath || typeof folderPath !== 'string') {
            return j(400, { error: 'folderPath (folder bind) or name (hub workspace) required' });
          }
          const res = rooms.bindFolder({
            folderPath,
            // `workspaceId` is what this body key was called before a review
            // stopped being a workspace; both are read, neither is required.
            setId: (body?.setId ?? body?.workspaceId) as string | undefined,
            title: body?.title as string | undefined,
            include: Array.isArray(body?.include) ? (body.include as string[]) : undefined,
            // Accepted by bindFolder and honoured by the scan since forever,
            // but this route never forwarded it — so bind_folder's exclude had
            // no effect end-to-end. It matters more now: refresh_workspace
            // persists and replays the exclude, which is meaningless if the
            // bind could never set one. (/api/diffs already forwarded it.)
            exclude: Array.isArray(body?.exclude) ? (body.exclude as string[]) : undefined,
            maxFiles: typeof body?.maxFiles === 'number' ? Number(body.maxFiles) : undefined,
            owner: body?.owner as string | undefined,
            producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
          });
          if (!res.ok) {
            // not-found → 404; reserved-namespace → 400 (the caller chose an
            // id it may not have, and no amount of narrowing fixes that);
            // too-many-files → 409 (guardrail, caller must narrow the folder
            // or raise maxFiles).
            const status =
              res.error === 'not-found' ? 404 : res.error === 'reserved-namespace' ? 400 : 409;
            return j(status, res);
          }
          // The GROUPING goes on the board, not its members: `res.workspaceId`
          // is the review id, and one row for the whole bind is the unit a
          // reader thinks in. See the vocabulary note above `fileUnderHubWorkspace`.
          const hubWorkspaceId = fileUnderHubWorkspace(
            res.workspaceId,
            body?.hubWorkspaceId as string | undefined,
          );
          return j(200, {
            ...res,
            // The review's id, under the name the CRDT already stores it as.
            // `workspaceId` (from ...res) carries the SAME value and is
            // deprecated for one release — a caller built before the rename
            // reads it by that name, and a key must never change MEANING.
            setId: res.workspaceId,
            hubWorkspaceId,
            files: res.files.map((f) => ({
              ...f,
              reviewUrl: withReviewUrl({ docId: f.docId, type: f.type }).reviewUrl,
            })),
          });
        }
        // --- REST: diff reviews ---
        // One doc per changed file, grouped as a workspace (= the review id).
        // Default mode diffs base → the WORKING TREE (live: docs bind to the
        // files on disk and re-render as the agent edits); pass `target` for a
        // review pinned to a commit. Returns per-file reviewUrls plus an
        // entryUrl (first changed file) the agent can hand to a human.
        if (pathname === '/api/diffs' && req.method === 'POST') {
          const body = await safeJson(req);
          const repoPath = body?.repo as string | undefined;
          const base = body?.base as string | undefined;
          const target = body?.target as string | undefined;
          if (!repoPath) {
            return j(400, {
              error:
                'repo is required. base optional: omit for a BROWSE workspace (no diff); pass base to diff against the working tree; base+target for a pinned range.',
            });
          }
          if (target && !base) {
            return j(400, { error: 'target requires base' });
          }
          const reviewId = body?.reviewId as string | undefined;
          if (reviewId !== undefined && !isValidDocId(reviewId)) {
            return j(400, { error: 'bad reviewId' });
          }
          const res = rooms.bindDiff({
            repoPath,
            base,
            target,
            reviewId,
            title: body?.title as string | undefined,
            exclude: Array.isArray(body?.exclude) ? (body.exclude as string[]) : undefined,
            groups: Array.isArray(body?.groups)
              ? (body.groups as Array<{ title: string; paths: string[]; details?: string }>)
              : undefined,
            maxFiles: typeof body?.maxFiles === 'number' ? Number(body.maxFiles) : undefined,
            owner: body?.owner as string | undefined,
            producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
          });
          if (!res.ok) {
            const status =
              res.error === 'not-found' || res.error === 'bad-ref'
                ? 404
                : res.error === 'empty-diff' ||
                    res.error === 'group-details-too-long' ||
                    res.error === 'bad-groups'
                  ? 400
                  : 409;
            return j(status, res);
          }
          const files = res.files.map((f) => ({
            ...f,
            reviewUrl: withReviewUrl({ docId: f.docId, type: f.type }).reviewUrl,
          }));
          // Land the reviewer on the MEATIEST change, not the first file
          // alphabetically (which is usually dotfile/config noise on a big
          // review). The in-page tree navigates to everything else.
          const entry = files.reduce(
            (best, f) =>
              (f.additions ?? 0) + (f.deletions ?? 0) >
              (best.additions ?? 0) + (best.deletions ?? 0)
                ? f
                : best,
            files[0],
          );
          // One row per REVIEW on the board, never one per changed file — the
          // members are reachable through the review's own tree. Idempotent, so
          // a re-run that omits `hubWorkspaceId` cannot sweep a live review out
          // of the board a reviewer already filed it on.
          const hubWorkspaceId = fileUnderHubWorkspace(
            res.reviewId,
            body?.hubWorkspaceId as string | undefined,
          );
          // `setId` is the same value as `reviewId`, under the name the CRDT
          // stores it as — both stay, and neither changes meaning.
          return j(200, {
            ...res,
            setId: res.reviewId,
            hubWorkspaceId,
            files,
            entryUrl: entry?.reviewUrl,
          });
        }
        // List bound workspaces with rolled-up triage signals (fileCount,
        // openThreads, allIdle, owner, lastActivityAt). The daily triage uses
        // this to treat a folder bind as one cleanup unit.
        if (pathname === '/api/workspaces' && req.method === 'GET') {
          return j(200, {
            workspaces: rooms.listWorkspaces(),
            // Hub workspaces (the boards) are a different thing from the
            // reviews above and stay in their own key rather than
            // being mixed into one list. They belong on this route because a
            // workspace the SERVER materialized for an unfiled doc has no
            // other way to be found: nobody was told its id at creation time.
            hubWorkspaces: taskStore.listWorkspaces().map((w) => ({
              id: w.id,
              name: w.name,
              docCount: w.docIds.length,
              createdAt: w.createdAt,
              // Present only when true, so a client that has never heard of
              // retirement reads exactly what it read before, and one that
              // has can filter on the key's presence.
              ...(isRetired(w) ? { retired: true, retiredAt: w.retiredAt } : {}),
            })),
          });
        }
        // --- REST: hub workspaces + tasks (plan §3.10) ---
        // Every handler below hand-copies body fields into the store call.
        // A field that isn't copied is silently discarded while the request
        // still returns 200 — so every param here has an HTTP-level test in
        // task-routes.test.ts (the `groups` lesson).
        const hubWsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
        if (hubWsMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(hubWsMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          // Goals with their counts, in priority order. The goals were always
          // in this payload and no MCP tool read it, so ordering lived in
          // each agent's head; the counts are what make the list answer
          // "where is the open work" without a second call per goal.
          return j(200, {
            workspace,
            // The rows argument is what lets each band carry its own status
            // (and done attribution) — the counts say where the open work is,
            // the status says what somebody declared about the band itself.
            goalSummary: summarizeGoals(
              taskStore.listTasks(workspaceId),
              workspace.goals,
              taskStore.listGoalRows(workspaceId),
            ),
            // The board has been stood down. Present only when it has, and
            // carrying prose rather than a flag, because the reader is
            // usually an agent deciding whether to work here and a boolean
            // gives it nothing to act on.
            ...(isRetired(workspace) ? { retired: retiredNotice(workspace) } : {}),
          });
        }
        // The human's queue, to the board's agent-side `next` below: every
        // open thread across this workspace's tasks and docs that is ASKING
        // a person something — an unanswered agent comment with a direct
        // question in it, OR a declared item nobody has answered, which
        // stays whatever else is said in the thread. A status note is not a
        // row (Bryan, 2026-08-21 — see `ReviewBand` in review-queue.ts).
        // Decisions are NOT here — the board already holds every task, so
        // shipping them again would put the priority rule in two places;
        // the client merges the two halves and orders them (see
        // `reviewQueue` in hub-model).
        //
        // One request rather than one per doc: a board with forty tasks is a
        // board with forty rooms, and the strip has to be right at first
        // paint or it is not a "what do I look at next" surface.
        const wsReviewMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/review-items$/);
        if (wsReviewMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsReviewMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          return j(200, { workspaceId, items: reviewItemsFor(workspace) });
        }
        // ── Home pane (§ approved home-pane design) ──────────────────────
        // GET: the brief + marker + instructions for ONE person. `user` is
        // required because everything in the payload is per person — an
        // anonymous read would silently share one marker between everyone.
        const wsHomeMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/home$/);
        if (wsHomeMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsHomeMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          const person = (url.searchParams.get('user') ?? '').trim();
          if (person === '') {
            return j(400, { error: 'user is required — the read marker and brief are per person' });
          }
          return j(200, homePayload(workspace, person, Date.now()));
        }
        // "Mark caught up": move the reader's marker. `at` supports undo —
        // the response names what it replaced, and posting that value back
        // restores it (0 = never read). A removal must be reversible.
        const wsHomeReadMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/home\/read$/);
        if (wsHomeReadMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsHomeReadMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          const body = await safeJson(req);
          const person = String(
            (body?.author as { name?: unknown } | undefined)?.name ?? '',
          ).trim();
          if (person === '') return j(400, { error: 'author.name is required' });
          const at =
            typeof body?.at === 'number' && Number.isFinite(body.at) && body.at >= 0
              ? body.at
              : Date.now();
          return j(200, { ok: true, ...homeBriefs.markRead(workspaceId, person, at) });
        }
        // "Save & Update Summary": the instructions persist workspace-wide
        // and apply to this summary and future summaries. Every cached brief
        // is dropped (they were written under the old instructions), and the
        // response is the full home payload so the caller repaints — with
        // `generating` true when a summarizer is wired, because the drop
        // makes every brief stale by construction.
        const wsHomeInstrMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/home\/instructions$/);
        if (wsHomeInstrMatch && req.method === 'PUT') {
          const workspaceId = decodeURIComponent(wsHomeInstrMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          const body = await safeJson(req);
          const person = String(
            (body?.author as { name?: unknown } | undefined)?.name ?? '',
          ).trim();
          if (person === '') return j(400, { error: 'author.name is required' });
          const instructions = typeof body?.instructions === 'string' ? body.instructions : '';
          if (instructions.trim() === '') {
            return j(400, { error: 'instructions are required — to reset, save the default text' });
          }
          homeBriefs.setInstructions(workspaceId, instructions);
          return j(200, homePayload(workspace, person, Date.now()));
        }
        // The work queue: priority order, dependency-aware, grouped into
        // waves that can run at once (§3.9 agent side).
        const wsNextMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/next$/);
        if (wsNextMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsNextMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          const limitRaw = url.searchParams.get('limit');
          // Same additive flag as `/tasks`, and the same default: an archived
          // row is not work to pick up, so it leaves the queue unless a caller
          // asks for it by name.
          const includeArchived = url.searchParams.get('includeArchived') === 'true';
          const rows = buildQueue(
            taskStore.listTasks(workspaceId, { includeArchived }),
            workspace.goals,
            {
              ...(url.searchParams.get('assignee')
                ? { assignee: url.searchParams.get('assignee') ?? '' }
                : {}),
              ...(limitRaw !== null && Number.isFinite(Number(limitRaw))
                ? { limit: Number(limitRaw) }
                : {}),
              includeBlocked: url.searchParams.get('includeBlocked') === 'true',
              // So each row can say whether its BAND has been agreed to. The
              // row is still listed either way — a lead reading the queue
              // should see the band and be able to disagree with it.
              goalRows: taskStore.listGoalRows(workspaceId),
              // The discussion the queue has always dropped. Every one of the
              // five known stale-premise pickups had a comment on the task
              // saying the premise had moved, and none of them reached the
              // next reader, because this route returned `body` and nothing
              // else. Passed as a reader rather than a map so `buildQueue`
              // stays pure and only the armed rows pay for their notes.
              discussion: (taskId) => taskProjection.discussionNotes(taskId),
              ...(opts.premiseStaleAfterMs !== undefined
                ? { staleAfterMs: opts.premiseStaleAfterMs }
                : {}),
            },
          );
          // WHO IS ALREADY ON EACH ROW, on the surface where the pickup
          // decision is actually made. `list_tasks` has carried
          // `ownerSession` for a while and this route did not, so the read
          // existed and was one call away from every dispatcher who needed
          // it — which on 2026-08-17 is how two sessions each built a
          // complete answer to the same board task (#186 merged, #190 thrown
          // away) with neither able to detect the other.
          //
          // Two fields because they answer two questions and the whole
          // failure was one signal being read as an answer to the other:
          // `ownerSession` is the session behind the row's OWNER, and
          // `claimedBy` is the session that last moved it into in-progress —
          // which is the only one that exists when nobody assigned it, since
          // a transition never touches `assignee`.
          //
          // Both are recency reads (heartbeat + observed work), never content
          // identity: a session that thinks for an hour produces no new
          // commit and must still read as taken. Informational only — nothing
          // here refuses anyone, because two agents on one row is sometimes
          // right.
          const ownerSessionOf = taskProjection.ownerSessionReader(workspaceId);
          const claimSessionOf = taskProjection.claimSessionReader(workspaceId);
          const byId = new Map(
            taskStore.listTasks(workspaceId, { includeArchived }).map((t) => [t.id, t]),
          );
          const withPresence = rows.map((row) => {
            const task = byId.get(row.id);
            if (!task) return row;
            const owner = ownerSessionOf(task);
            const claim = claimSessionOf(task);
            return {
              ...row,
              ...(owner !== undefined ? { ownerSession: owner } : {}),
              ...(claim !== undefined ? { claimedBy: claim } : {}),
            };
          });
          // The queue still ranks — a retired board's in-flight work is
          // finishable — but the caller is told what it is looking at BEFORE
          // it picks a row. This is the surface an agent hits when it asks
          // "what should I do next", so silence here is the lost night.
          return j(200, {
            workspaceId,
            tasks: withPresence,
            ...(isRetired(workspace) ? { retired: retiredNotice(workspace) } : {}),
          });
        }
        // Activity view (§3.9): the per-workspace events.jsonl audit log,
        // read back as rows. This is the surface where the after-the-fact
        // 80/95 review happens, built on the same file every subscriber saw
        // (§3.6: the audit log can never disagree with what subscribers saw).
        // Board load reports: one line per browser boot,
        // appended by the client after its first paint, read back newest-first
        // so "how slow was the board, and in which phase" is a recorded fact
        // rather than a memory of watching a spinner. No external service —
        // the report is a JSON object the client shaped, stamped here with
        // when it arrived and what sent it.
        const wsLoadMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/load-reports$/);
        if (wsLoadMatch) {
          const workspaceId = decodeURIComponent(wsLoadMatch[1] ?? '');
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace not found' });
          }
          const logPath = join(dataDir, 'workspaces', `${workspaceId}.load-reports.jsonl`);
          if (req.method === 'POST') {
            const body = await safeJson(req);
            if (!body || typeof body !== 'object') return j(400, { error: 'report required' });
            // Body first, stamps last: ts and ua are the server's own record
            // of when the report arrived and what sent it, and a body that
            // claims its own must not be able to overwrite them.
            const row = {
              ...body,
              ts: Date.now(),
              ...(req.headers.get('user-agent') ? { ua: req.headers.get('user-agent') } : {}),
            };
            // The sidecar flush that normally creates this dir is debounced,
            // so a report can arrive before it exists (same guard every other
            // writer in tasks.ts carries).
            mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
            appendFileSync(logPath, `${JSON.stringify(row)}\n`);
            return j(200, { ok: true });
          }
          if (req.method === 'GET') {
            let reports: unknown[] = [];
            if (existsSync(logPath)) {
              reports = readFileSync(logPath, 'utf8')
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .flatMap((line) => {
                  try {
                    return [JSON.parse(line)];
                  } catch {
                    // Same rule as the events log: a torn tail line must not
                    // take the whole read down.
                    return [];
                  }
                });
            }
            // Newest first, capped — the file grows, the read does not.
            reports = reports.slice(-50).reverse();
            return j(200, { workspaceId, reports });
          }
        }
        const wsAuditMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/events$/);
        if (wsAuditMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsAuditMatch[1] ?? '');
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace not found' });
          }
          const logPath = eventsLogPath(dataDir, workspaceId);
          let rows: Array<{ event?: unknown; ts?: unknown }> = [];
          if (existsSync(logPath)) {
            rows = readFileSync(logPath, 'utf8')
              .split('\n')
              .filter((line) => line.trim().length > 0)
              .flatMap((line) => {
                try {
                  return [JSON.parse(line) as { event?: unknown; ts?: unknown }];
                } catch {
                  // A torn tail line (crash mid-append) must not take the
                  // whole activity view down with it.
                  return [];
                }
              });
          }
          // Uptime (§3.12 commit 11): every line — real event or liveness
          // marker — is proof the server was alive when it was written, so
          // the gap analysis runs over ALL timestamps, before any filtering.
          const uptime = analyzeUptime(
            rows.map((r) => r.ts).filter((t): t is number => typeof t === 'number'),
            {
              now: Date.now(),
              ...(opts.uptimeTickMs !== undefined ? { tickMs: opts.uptimeTickMs } : {}),
            },
          );
          // Ticks are measurement substrate, not activity — strip them from
          // the review list (BEFORE the cap, so a week of beats can't crowd
          // real rows out of it). server.started stays: a restart is honest
          // activity.
          let events: unknown[] = rows.filter((r) => r.event !== SERVER_TICK_EVENT);
          // Cap the payload: the newest rows are the review's working set.
          if (events.length > 1000) events = events.slice(-1000);
          return j(200, { workspaceId, events, uptime });
        }
        // The workspace-level TEXT goal is GONE — the ordered goal LIST is
        // the one goal system now. This route stays because it is on the
        // SHARED server: plugin bundles built before the removal still call
        // it from sessions nobody can restart, and a 404 here is
        // indistinguishable from a bad workspace id while a 500 reads as an
        // outage. So it answers deliberately, and it answers 410 rather than
        // a 200 no-op: the caller is an agent that would otherwise record
        // "goal set" for a write that never happened, and the MCP client
        // surfaces a non-2xx body verbatim, which is how the sentence below
        // reaches whoever needs to read it.
        const wsGoalMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goal$/);
        if (wsGoalMatch && req.method === 'PUT') {
          return j(410, {
            deprecated: true,
            error:
              "the workspace-level text goal was removed — a workspace's goals are the ordered " +
              'goal LIST now. Use set_goal_list to write the bands, rename_goal to retitle one, ' +
              'reorder_goals to rank them, and set_task_goal to place work under one. Nothing ' +
              'was written by this call.',
          });
        }
        // retire_workspace / unretire_workspace: stand a board down, or bring
        // it back. Deliberately NOT a flag on DELETE — that route rmSyncs the
        // tasks sidecar and the events log, and this one writes a single
        // field on a record that is already serialized wholesale, so nothing
        // it does needs undoing beyond writing the field again.
        const wsRetiredMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/retired$/);
        if (wsRetiredMatch && req.method === 'PUT') {
          const workspaceId = decodeURIComponent(wsRetiredMatch[1] ?? '');
          const body = await safeJson(req);
          const retired = body?.retired;
          // Explicit both ways. A missing field defaulting to `true` would
          // make an empty body retire a board, which is the one direction
          // that must never happen by accident.
          if (typeof retired !== 'boolean') {
            return j(400, { error: 'retired must be true or false' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const reason = typeof body?.reason === 'string' ? body.reason : undefined;
          const res = taskStore.setWorkspaceRetired(workspaceId, retired, {
            actor: author,
            ...(reason !== undefined ? { reason } : {}),
          });
          if (!res.ok) return j(404, res);
          // The store emits, but the projection reads the workspace record
          // rather than the event payload, so the board room needs telling
          // that the record moved — otherwise the badge appears only when
          // some unrelated mutation next touches this workspace, which on a
          // board somebody just retired is never.
          taskProjection.ensureWorkspace(workspaceId);
          return j(200, res);
        }
        // rename_workspace. The name was set once at creation and nothing
        // changed it, which is how two live boards ended up sharing one — and
        // a name is how an agent picks which to work.
        const wsBoardRenameMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/rename$/);
        if (wsBoardRenameMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsBoardRenameMatch[1] ?? '');
          const body = await safeJson(req);
          const name = body?.name;
          if (typeof name !== 'string') return j(400, { error: 'name required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.renameWorkspace(workspaceId, name, { actor: author });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          taskProjection.ensureWorkspace(workspaceId);
          return j(200, res);
        }
        // set_workspace_lead: hand the board's lead-agent seat to someone
        // else. A standing assignment, not a session fact — the lead may be
        // away, and a goal edit still has an addressee to queue for.
        const wsLeadMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/lead$/);
        if (wsLeadMatch && req.method === 'PUT') {
          const workspaceId = decodeURIComponent(wsLeadMatch[1] ?? '');
          const body = await safeJson(req);
          const leadAgentId = body?.leadAgentId;
          if (typeof leadAgentId !== 'string' || leadAgentId.trim().length === 0) {
            return j(400, { error: 'leadAgentId required' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          // `takeover` is how a caller says it MEANS to displace a live lead.
          // Absent it, claiming a seat a live agent already holds is refused
          // (`declined: 'lead-held'`) rather than silently granted — an
          // eviction nobody was told about routes every lead-addressed
          // delivery to a session that has stopped expecting it. Old bundles
          // never send the field, and they get the refusal, which is the safe
          // side of the change.
          const takeover = body?.takeover === true;
          const res = taskStore.setLeadAgent(workspaceId, leadAgentId, {
            actor: author,
            // An id the workspace has NO attachment record of is refused with
            // `unknown-lead-agent` (400): a seat routed to nobody silently
            // stops every lead-addressed delivery. Self-declaration is exempt
            // in the store — the caller is by definition real.
            ...(takeover ? { takeover: true } : {}),
          });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          return j(200, res);
        }
        // Voice (§3.8): transcript + per-surface context in, route decision +
        // ack out. EVERY utterance gets an explicit ack naming what was heard
        // and which route handles it — the router owns that invariant; this
        // handler only validates and forwards (transcript VERBATIM).
        const wsVoiceMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/voice$/);
        if (wsVoiceMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsVoiceMatch[1] ?? '');
          const body = await safeJson(req);
          const transcript = typeof body?.transcript === 'string' ? body.transcript.trim() : '';
          if (transcript.length === 0) return j(400, { error: 'transcript required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const context = parseVoiceContext(body?.context);
          const res = await voiceRouter.handle(workspaceId, {
            transcript,
            ...(context !== undefined ? { context } : {}),
            actor: author,
          });
          if (!res.ok) return j(404, res);
          return j(200, res);
        }
        // attach_doc: link an existing doc or review to a hub workspace.
        const wsAttachMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/docs$/);
        if (wsAttachMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsAttachMatch[1] ?? '');
          const body = await safeJson(req);
          const addressed = body?.docId as string | undefined;
          if (!addressed || typeof addressed !== 'string')
            return j(400, { error: 'docId required' });
          // The link target must exist: either a doc room, or a REVIEW id (a
          // diff review / folder bind, attached as one unit). Only the first
          // kind canonicalizes — a review id names no room, so there is
          // nothing to resolve it to.
          const attachRoom = rooms.get(addressed);
          const docId = attachRoom?.docId ?? addressed;
          const exists =
            attachRoom !== undefined || rooms.list().some((m) => reviewIdOf(m) === docId);
          if (!exists) return j(404, { error: 'doc not found', docId });
          const res = taskStore.attachDoc(workspaceId, docId);
          if (!res.ok) return j(404, res);
          // A doc filed here is no longer unfiled.
          unfileFromDefault(docId, workspaceId);
          // attachDoc emits no store event; refresh the projection's docIds.
          taskProjection.ensureWorkspace(workspaceId);
          return j(200, { ok: true, workspace: taskStore.getWorkspace(workspaceId) });
        }
        // import_tasks_markdown (§3.10 / §3.12 commit 10): ingest a
        // hand-maintained tracker (group headings + status tables). The
        // DEFAULT is a dry-run that returns the mapping and touches nothing;
        // apply:true creates the goals + tasks and stamps the source file
        // with a banner + hub link so the old tracker can't quietly stay a
        // second source of truth (a stamped file refuses re-import).
        const wsImportMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/import-tasks$/);
        if (wsImportMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsImportMatch[1] ?? '');
          const body = await safeJson(req);
          const path = body?.path;
          if (typeof path !== 'string' || path.length === 0) {
            return j(400, { error: 'path required' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) return j(404, { error: 'workspace not found' });
          if (!existsSync(path)) return j(404, { error: 'file not found', path });
          const markdown = readFileSync(path, 'utf8');
          const alreadyImported = importMarkerFor(markdown);
          const mapping = parseTrackerMarkdown(markdown, workspace);
          if (body?.apply !== true) {
            return j(200, {
              dryRun: true,
              workspaceId,
              path,
              ...(alreadyImported !== null ? { alreadyImported } : {}),
              mapping,
            });
          }
          if (alreadyImported !== null) {
            return j(409, { error: 'already-imported', workspaceId: alreadyImported });
          }
          // An import inherits the importer's identity for every row that
          // names nobody, so an anonymous importer would file those rows under
          // the generic word — the one thing every other create refuses. The
          // test is per row and the refusal is whole: a tracker whose owner
          // column is filled in imports fine no matter who ran it, and one
          // that isn't fails before anything is written, so there is no
          // partial state to reason about. The dry run above stays allowed —
          // it creates nothing, and it's what you read while fixing this.
          if (mapping.tasks.some((row) => !resolveAssignee(row.assignee, author))) {
            return j(400, { error: ASSIGNEE_REQUIRED_ERROR, message: ASSIGNEE_REQUIRED_MESSAGE });
          }
          const res = applyImport(taskStore, workspaceId, mapping, { actor: author });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          // Stamp the source file. If the tracker is bound as a live doc,
          // pull the banner into the live doc too — reparse right after our
          // own write, so disk (which we just wrote) wins the race with the
          // doc's debounced flush.
          const hubUrl = `${externalBaseUrl()}/workspaces/${encodeURIComponent(workspaceId)}`;
          writeFileSync(
            path,
            importBanner({
              workspaceId,
              hubUrl,
              taskCount: res.tasksCreated.length,
              ts: Date.now(),
            }) + markdown,
          );
          const resolved = resolve(path);
          const bound = rooms
            .list()
            .find((m) => m.sourceUrl !== undefined && resolve(m.sourceUrl) === resolved);
          if (bound) rooms.reparseFromDisk(bound.docId);
          // Task/goal events already refreshed the projection; this covers a
          // mapping with zero new goals and zero tasks (nothing emitted).
          taskProjection.ensureWorkspace(workspaceId);
          return j(200, {
            ok: true,
            workspaceId,
            hubUrl,
            stamped: true,
            goalsCreated: res.goalsCreated,
            tasksCreated: res.tasksCreated,
            failures: res.failures,
            skipped: mapping.skipped,
            ignoredColumns: mapping.ignoredColumns,
            // Hand-copied, like every field above it — a mapping field that
            // isn't listed here is silently dropped on the apply path while
            // the dry-run (which spreads `mapping`) still shows it.
            warnings: mapping.warnings,
          });
        }
        const wsTasksMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/tasks$/);
        if (wsTasksMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsTasksMatch[1] ?? '');
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace not found' });
          }
          const status = url.searchParams.get('status') as TaskStatus | null;
          const tasks = taskStore.listTasks(workspaceId, {
            ...(status ? { status } : {}),
            ...(url.searchParams.get('goal') ? { goal: url.searchParams.get('goal') ?? '' } : {}),
            ...(url.searchParams.get('assignee')
              ? { assignee: url.searchParams.get('assignee') ?? '' }
              : {}),
            ...(url.searchParams.get('needs')
              ? { needs: url.searchParams.get('needs') as 'action' | 'decision' }
              : {}),
            // ADDITIVE, and the default is the narrowing: a caller built
            // before archiving existed keeps getting the rows it always got,
            // minus the ones somebody has since removed. That is the safe
            // direction — the failure it cannot produce is an old bundle
            // resurrecting a task its user archived.
            includeArchived: url.searchParams.get('includeArchived') === 'true',
          });
          // The kind the BOARD resolves, not just the one somebody declared.
          // An agent has no other way to ask "which of my rows read as an
          // unrecorded owner" — the resolved value lives in a ydoc it cannot
          // read, and the two answers differ exactly where it matters (an
          // undeclared row whose owner is an attached agent reads `agent`).
          const ownerKindOf = taskProjection.ownerKindReader(workspaceId);
          // And WHICH session that owner is, when one can be named. The kind
          // above says a row belongs to an agent; this says whether that
          // agent is still there, which is the difference between "somebody
          // owns this" and "somebody is on this". Absent when no attachment
          // vouches for the owner — a person, or an owner too generic to
          // resolve to one session.
          const ownerSessionOf = taskProjection.ownerSessionReader(workspaceId);
          return j(200, {
            workspaceId,
            tasks: tasks.map((t) => {
              const session = ownerSessionOf(t);
              return {
                ...t,
                ownerKind: ownerKindOf(t),
                ...(session !== undefined ? { ownerSession: session } : {}),
              };
            }),
          });
        }
        if (wsTasksMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsTasksMatch[1] ?? '');
          const body = await safeJson(req);
          // An unknown workspace is a 404 before anything about the task is
          // judged — otherwise a typo'd id comes back as a complaint about
          // the body, and the caller fixes the wrong thing.
          const targetBoard = taskStore.getWorkspace(workspaceId);
          if (!targetBoard) {
            return j(404, { error: 'workspace-not-found' });
          }
          // A retired board takes no new work, and it says so about the BOARD
          // rather than about the body — a caller told its title is fine and
          // its goal is unknown fixes the wrong thing. `createTask` refuses
          // this too (it is the choke point every filing path runs through);
          // answering here is what turns N identical row failures into one
          // sentence a caller can act on.
          if (isRetired(targetBoard)) {
            return j(409, { error: 'workspace-retired', message: retiredRefusal(targetBoard) });
          }
          // One reading of a create body, shared with the batch route below.
          const parsed = parseTaskCreate(body, authorFor(body?.author));
          if (!parsed.ok) {
            return j(400, {
              error: parsed.error,
              ...(parsed.message !== undefined ? { message: parsed.message } : {}),
            });
          }
          const res = taskStore.createTask(workspaceId, parsed.opts);
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          // The review item the body filed WITH the ticket, now that the
          // ticket has an id. `parseTaskCreate` already put the payload
          // through the same `checkReviewPayload` the store runs, so a
          // refusal here is unreachable and the ticket cannot land holding a
          // question the caller was told was rejected.
          if (parsed.review !== undefined) {
            const actor = authorFor(body?.author) ?? ANONYMOUS_ACTOR;
            const added = taskStore.addReviewItem(res.task.id, parsed.review, { actor });
            if (added.ok) announceTaskReview(added.task, added.item, actor);
            // `createTask` already emitted `task.created` — and therefore
            // already projected this ticket, a moment before it had any
            // review items. `addReviewItem` emits nothing, so without this the
            // board room carries the ticket with no `reviews` until some
            // unrelated store event happens to touch the workspace, which on a
            // quiet board is never. Same call the dedicated review-item route
            // makes for the same reason.
            taskProjection.ensureWorkspace(workspaceId);
          }
          // Dropped refs are reported, never swallowed: the caller finds out
          // what didn't survive without having to diff what it sent. Same
          // reasoning for `shapeGaps` — the decision WAS created and the
          // caller still learns which parts of the shape are missing.
          return j(200, {
            task: res.task,
            // What happened to the placement, and — only when nobody judged
            // it — the bands it could have been ranked into. The caller that
            // just generated this work is the one party that still knows why
            // it exists; handing it `goal: "chores"` and nothing else is what
            // let agent-generated work drift out of the goal structure.
            placement: {
              ...res.placement,
              ...(res.placement.placed
                ? {}
                : { goals: placeableGoals(taskStore.getWorkspace(workspaceId)?.goals ?? []) }),
            },
            ...(parsed.ignoredLinks.length > 0 ? { ignoredLinks: parsed.ignoredLinks } : {}),
            ...(res.shapeGaps !== undefined ? { shapeGaps: res.shapeGaps } : {}),
            ...(parsed.reviewAdvice !== undefined ? { reviewAdvice: parsed.reviewAdvice } : {}),
            // The row's ACTUAL visibility, stated plainly — `placed` above
            // answers goal placement, not whether any dispatch read returns
            // the row or where a filed ask went. See `createdVisibility`.
            ...(() => {
              const note = createdVisibility(res.task.status, parsed.review !== undefined);
              return note !== undefined ? { visibility: note } : {};
            })(),
          });
        }
        /**
         * Batch capture: a burst of ideas in ONE call, each landing owned and
         * placed, and the whole thing coming back in board order so the caller
         * can see the ranking it just produced without a second read.
         *
         * PER-ITEM failure, deliberately. An all-or-nothing batch turns one
         * typo into "which of these eight already landed?", and the answer to
         * that question is a read the caller shouldn't have to do — so a bad
         * row is reported by index and its neighbours still land. The two
         * whole-call refusals left are the ones where nothing could have
         * landed anyway: an unknown workspace, and a body with no rows in it.
         */
        const wsTasksBatchMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/tasks\/batch$/);
        if (wsTasksBatchMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsTasksBatchMatch[1] ?? '');
          const body = await safeJson(req);
          const batchBoard = taskStore.getWorkspace(workspaceId);
          if (!batchBoard) {
            return j(404, { error: 'workspace-not-found' });
          }
          // Whole-batch, before any row is read: on a retired board every row
          // fails for the same reason, and a hundred copies of one sentence
          // is not a better answer than the sentence.
          if (isRetired(batchBoard)) {
            return j(409, { error: 'workspace-retired', message: retiredRefusal(batchBoard) });
          }
          const rows = body?.tasks;
          if (!Array.isArray(rows) || rows.length === 0) {
            return j(400, { error: 'tasks must be a non-empty array of task bodies' });
          }
          // Refused, never truncated. A capture tool that silently keeps the
          // first N reports success for rows that don't exist, and the caller
          // has no way to know which — the failure this whole route is shaped
          // to avoid. The number is a burst-sized ceiling, not a capacity
          // limit: a batch this large is a tracker, and import_tasks_markdown
          // is the surface for one.
          if (rows.length > MAX_BATCH_TASKS) {
            return j(400, {
              error: 'too-many-tasks',
              message: `a batch takes at most ${MAX_BATCH_TASKS} rows; this one had ${rows.length}. Nothing was created — split it, or use import_tasks_markdown for a whole tracker.`,
            });
          }
          const createdBy = authorFor(body?.author);
          const createdIds = new Set<string>();
          const failures: Array<{
            index: number;
            title?: string;
            error: string;
            message?: string;
          }> = [];
          const ignoredLinks: Array<{ taskId: string; ignored: unknown[] }> = [];
          const shapeGaps: Array<{ taskId: string; gaps: unknown[] }> = [];
          /** Per row, because a burst files many tickets and "which one came
           *  out thin" is the only useful form of the answer. */
          const reviewAdvice: Array<{ taskId: string; advice: string }> = [];
          /** Each row's actual visibility, stated plainly — a triage row is
           *  returned by no dispatch read, and a filed review item is on the
           *  addressee's Home queue regardless. See `createdVisibility`. */
          const visibility: Array<{ taskId: string; note: string }> = [];
          /** Did any row attach a review item? The projection refresh those
           *  need happens once after the loop; see below. */
          let attachedReview = false;
          // Placement, collected per row and reported ONCE. Per-row it would
          // repeat the same band list a hundred times in a hundred-row burst;
          // the rows that need naming are the unplaced ones, so those are what
          // it names.
          const unplaced: string[] = [];
          // Batch-local dependency references. Keys are read once, up front,
          // so an ambiguous one is refused where it is DECLARED rather than
          // at every site that reads it; `idByIndex` fills in as rows land,
          // which is what lets a row that depends on a FAILED row fail too
          // instead of being created with the edge silently dropped.
          const { keyToIndex, keyErrors } = indexBatchKeys(rows);
          const idByIndex = new Map<number, string>();
          const refCtx = { keyToIndex, idByIndex, rowCount: rows.length };
          for (const [index, row] of rows.entries()) {
            // One caller, one identity: every row is attributed to whoever
            // sent the batch. A row naming its own author would be a second
            // way to spell attribution with no caller asking for it — and
            // `assignee` already answers the question people actually have,
            // which is who OWNS the row rather than who typed it.
            const title = (row as { title?: unknown } | null)?.title;
            const named = typeof title === 'string' ? { title } : {};
            const keyError = keyErrors.get(index);
            if (keyError) {
              failures.push({ index, ...named, ...keyError });
              continue;
            }
            const refs = resolveRowRefs(row, index, refCtx);
            if (!refs.ok) {
              failures.push({ index, ...named, error: refs.error, message: refs.message });
              continue;
            }
            // Hand the parser a row whose references are already real ids —
            // so the store's `unknown-after` gate and every rule downstream
            // of it are unchanged by this feature.
            const resolvedRow =
              refs.after === undefined && refs.afterEnforce === undefined
                ? row
                : {
                    ...(row as Record<string, unknown>),
                    ...(refs.after !== undefined ? { after: refs.after } : {}),
                    ...(refs.afterEnforce !== undefined ? { afterEnforce: refs.afterEnforce } : {}),
                  };
            const parsed = parseTaskCreate(resolvedRow, createdBy);
            if (!parsed.ok) {
              failures.push({
                index,
                ...named,
                error: parsed.error,
                ...(parsed.message !== undefined ? { message: parsed.message } : {}),
              });
              continue;
            }
            const res = taskStore.createTask(workspaceId, parsed.opts);
            if (!res.ok) {
              failures.push({
                index,
                ...named,
                error: res.error,
                ...(res.message !== undefined ? { message: res.message } : {}),
              });
              continue;
            }
            // Same as the single-create door, and NOT optional: both routes
            // read one body through `parseTaskCreate`, so a `review` honoured
            // by one and dropped by the other is the "accepted it, returned
            // 200, discarded it" bug this file's header is about.
            if (parsed.review !== undefined) {
              const actor = createdBy ?? ANONYMOUS_ACTOR;
              const added = taskStore.addReviewItem(res.task.id, parsed.review, { actor });
              if (added.ok) announceTaskReview(added.task, added.item, actor);
              attachedReview = true;
            }
            if (parsed.reviewAdvice !== undefined) {
              reviewAdvice.push({ taskId: res.task.id, advice: parsed.reviewAdvice });
            }
            {
              const note = createdVisibility(res.task.status, parsed.review !== undefined);
              if (note !== undefined) visibility.push({ taskId: res.task.id, note });
            }
            createdIds.add(res.task.id);
            idByIndex.set(index, res.task.id);
            if (!res.placement.placed) unplaced.push(res.task.id);
            if (parsed.ignoredLinks.length > 0) {
              ignoredLinks.push({ taskId: res.task.id, ignored: parsed.ignoredLinks });
            }
            if (res.shapeGaps !== undefined) {
              shapeGaps.push({ taskId: res.task.id, gaps: res.shapeGaps });
            }
          }
          // Once, after the loop rather than inside it — see the single-create
          // door for why any of it is needed. The row that actually needs it
          // is the LAST one carrying a review: every earlier one was projected
          // incidentally by the NEXT row's `task.created`, which is why a
          // one-row batch and the tail of an n-row batch were the only shapes
          // that showed the miss.
          if (attachedReview) taskProjection.ensureWorkspace(workspaceId);
          // Board order comes from the board, not from a second sort of our
          // own that happens to agree with it today.
          const tasks = taskStore.listTasks(workspaceId).filter((t) => createdIds.has(t.id));
          return j(200, {
            workspaceId,
            tasks,
            failures,
            // Absent when every row was placed — there is nothing to act on,
            // and a block that is always there is a block nobody reads.
            ...(unplaced.length > 0
              ? {
                  placement: {
                    unplaced,
                    goals: placeableGoals(taskStore.getWorkspace(workspaceId)?.goals ?? []),
                  },
                }
              : {}),
            ...(ignoredLinks.length > 0 ? { ignoredLinks } : {}),
            ...(shapeGaps.length > 0 ? { shapeGaps } : {}),
            ...(reviewAdvice.length > 0 ? { reviewAdvice } : {}),
            // Absent when every row is ordinarily visible — a note that is
            // always there is a note nobody reads.
            ...(visibility.length > 0 ? { visibility } : {}),
          });
        }
        // The single gate for status changes: attributed and
        // dependency-checked. 409 on an enforce-marked open dependency.
        const taskTransitionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
        if (taskTransitionMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskTransitionMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          const to = body?.to as TaskStatus | undefined;
          if (!author || !to) return j(400, { error: 'author + to required' });
          const res = taskStore.transition(taskId, to, {
            actor: author,
            note: body?.note as string | undefined,
            usage: body?.usage as { inputTokens: number; outputTokens: number } | undefined,
          });
          // `body.confirmed` (risk gate, removed 2026-08-18) and
          // `body.evidence` (removed 2026-08-25) are read by nothing now and
          // are deliberately NOT validated: peers on older bundles keep
          // sending them until they restart, and a request that starts
          // failing over a field the server no longer cares about is exactly
          // how a removal breaks a caller it never meant to touch.
          if (!res.ok) {
            // A gate refusal is a refusal, not a malformed request: same 409
            // an enforce-marked blocker returns, so callers have one shape
            // for "the gate said no".
            const refused = res.error === 'blocked';
            const status = res.error === 'not-found' ? 404 : refused ? 409 : 400;
            return j(status, res);
          }
          return j(200, res);
        }
        // Retired 2026-08-25 with the rest of evidence support, and kept as a
        // NO-OP rather than deleted. An old bundle reaches this route from a
        // session nobody here can restart, and the two failure modes a
        // deletion would hand it — a 404 from the fall-through, or a refusal
        // over a field the server stopped caring about — are both unreadable
        // from the caller's own version. So it answers the way it always did
        // for the two cases that were never about evidence (unknown task,
        // missing author) and records nothing for the rest. `ignored` is on
        // the response so a reader of a log can tell an accepted no-op from a
        // correction that landed.
        const taskEvidenceMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/evidence$/);
        if (taskEvidenceMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskEvidenceMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const task = taskStore.getTask(taskId) ?? taskStore.getGoalRow(taskId);
          if (!task) return j(404, { ok: false, error: 'not-found' });
          return j(200, {
            ok: true,
            ignored: true,
            task,
            message:
              'Evidence is no longer recorded on transitions. This call was accepted and nothing was written; evidence already stored on older transitions is untouched.',
          });
        }
        // Cross-references (§3.10 `.../links`): links are STORED on the
        // task; backlinks are COMPUTED per read, never stored, so the two
        // directions can't drift.
        const taskLinksMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/links$/);
        if (taskLinksMatch && req.method === 'GET') {
          const taskId = decodeURIComponent(taskLinksMatch[1] ?? '');
          const task = taskStore.getTask(taskId);
          if (!task) return j(404, { error: 'task not found' });
          return j(200, {
            taskId,
            links: task.links,
            backlinks: taskStore.backlinksFor({ kind: 'task', taskId }).map(taskChip),
          });
        }
        // The same question asked about an ARBITRARY ref. `backlinksFor`
        // always answered it; the HTTP surface could only pose it about a
        // task (above) or a doc/thread (`GET /api/docs/<id>/tasks`), so the
        // question the `url` kind was added for — "which tasks point at this
        // pull request" — had no route, and `diff` refs had none either.
        //
        // POST for a read is deliberate: a ref is a structured value whose
        // `url` kind carries a caller-supplied URL, and putting that in a
        // query string writes it into every access log and proxy on the path
        // for no gain. Nothing here mutates.
        if (pathname === '/api/refs/backlinks' && req.method === 'POST') {
          const body = await safeJson(req);
          const ref = body?.ref;
          // A malformed ref must NOT fall through to an empty answer: [] and
          // "I didn't understand you" are indistinguishable to the caller,
          // and the first one reads as "nothing points at this PR".
          if (!isValidRef(ref)) return j(400, { error: BAD_REF_ERROR });
          return j(200, { ref, tasks: taskStore.backlinksFor(ref).map(taskChip) });
        }
        // Titles for pasted workspace URLs — the comment renderer's lookup.
        // Batched (one call per render burst, not one per link) and read-only.
        // Members only: the share-scope middleware above never whitelists this
        // path, so a share visitor's client falls back to raw URLs rather
        // than reading titles across the whole server.
        if (pathname === '/api/links/titles' && req.method === 'POST') {
          const body = await safeJson(req);
          const urls = body?.urls;
          if (!Array.isArray(urls)) return j(400, { error: 'urls: string[] required' });
          // One board index per REQUEST, built only if a board-scoped doc URL
          // actually needs it — the membership question is the same one the
          // /api/docs listing answers, asked through the same index.
          let boardIndex: Map<string, string[]> | null = null;
          // `titles` + `statuses` at the top level — the old `{ titles }`
          // shape is preserved for clients on a pre-status bundle.
          return j(
            200,
            linkTitlesFor(
              urls.filter((u): u is string => typeof u === 'string'),
              {
                docMeta: (docId) => rooms.get(docId)?.meta,
                docInWorkspace: (docId, workspaceId) => {
                  const meta = rooms.get(docId)?.meta;
                  if (!meta) return false;
                  if (meta.workspaceId === workspaceId) return true;
                  boardIndex ??= boardIndexForListing();
                  return hubBoardsForDocIndexed(boardIndex, meta).has(workspaceId);
                },
                task: (taskId) => {
                  // Goals answer here too: they share the id namespace and
                  // the status machine, and a pasted goal link should read
                  // as its title + status like any other row.
                  const t = taskStore.getTask(taskId) ?? taskStore.getGoalRow(taskId);
                  return t
                    ? { title: t.title, workspaceId: t.workspaceId, status: t.status }
                    : undefined;
                },
                workspaceName: (workspaceId) => taskStore.getWorkspace(workspaceId)?.name,
              },
            ),
          );
        }
        if (taskLinksMatch && (req.method === 'POST' || req.method === 'DELETE')) {
          const taskId = decodeURIComponent(taskLinksMatch[1] ?? '');
          const body = await safeJson(req);
          const ref = body?.ref;
          if (!isValidRef(ref)) return j(400, { error: BAD_REF_ERROR });
          const res =
            req.method === 'POST'
              ? taskStore.linkRef(taskId, ref)
              : taskStore.unlinkRef(taskId, ref);
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          // Link changes emit no store event (§3.6's exhaustive table has no
          // row for them), so refresh the projection by hand — the same
          // pattern as createWorkspace/attachDoc above.
          taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, { ok: true, changed: res.changed, task: res.task });
        }
        // set_task_goal (§3.10): goal/subgoal + exact position — the write
        // half of triage and the board's regroup gesture. Every field here is
        // hand-copied; each has an HTTP-level test in task-tool-routes.test.ts.
        //
        // `riskTier` used to be validated here and forwarded to the store. It
        // is now IGNORED, not refused: an older peer sends it on every
        // placement until it restarts, and the 400 this route used to be able
        // to return would now fire on a field that means nothing. Accept the
        // old payload shape; there is an HTTP-level test that sends it.
        const taskGoalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/goal$/);
        if (taskGoalMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskGoalMatch[1] ?? '');
          const body = await safeJson(req);
          const goal = body?.goal;
          if (typeof goal !== 'string' || goal.length === 0) {
            return j(400, { error: 'goal required' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const batchId = body?.batchId;
          if (batchId !== undefined && typeof batchId !== 'string') {
            return j(400, { error: 'batchId must be a string' });
          }
          // `after` names the row this one lands behind, or null for the top
          // of the goal — the only spelling that can express a drop between
          // two rows sharing an `order`, which `position` cannot. Absent means
          // the caller is an older bundle still sending `position` alone.
          const after = body?.after;
          if (after !== undefined && after !== null && typeof after !== 'string') {
            return j(400, { error: 'after must be a task id or null' });
          }
          const res = taskStore.setTaskGoal(taskId, goal, {
            actor: author,
            position: typeof body?.position === 'number' ? Number(body.position) : undefined,
            ...(after !== undefined ? { after: after as string | null } : {}),
            batchId,
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          // A confirm-in-place (changed:false) mutates gated fields
          // (triagedAgainst, triagePendingTs) without emitting an event —
          // refresh the projection by hand, same as attachDoc.
          if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        // answer_decision (§3.10): record the VERBATIM answer. Does not
        // transition the task — status changes stay with the single gate.
        const taskAnswerMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/answer$/);
        if (taskAnswerMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskAnswerMatch[1] ?? '');
          const body = await safeJson(req);
          const text = body?.text;
          if (typeof text !== 'string' || text.length === 0) {
            return j(400, { error: 'text required' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          // `optionId` says which candidate the words came from. The words are
          // still the answer — an option is a shortcut to typing them, so this
          // route deliberately does NOT look the label up and substitute it.
          const optionId = body?.optionId;
          if (optionId !== undefined && typeof optionId !== 'string') {
            return j(400, { error: 'optionId must be a string' });
          }
          const res = taskStore.answerDecision(taskId, text, {
            actor: author,
            ...(optionId !== undefined ? { optionId } : {}),
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          return j(200, res);
        }
        // Undo. Answering is a single click with no confirmation, so there has
        // to be a way back — and the way back is a SOFT delete: the store moves
        // the answer to `answerHistory` rather than dropping it, and the
        // decision goes back to open. Matched BEFORE `/answer` would be a
        // mistake either way (that pattern is anchored), but it is written
        // first so the pair reads together.
        const taskAnswerUndoMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/answer\/undo$/);
        if (taskAnswerUndoMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskAnswerUndoMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.withdrawAnswer(taskId, { actor: author });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          return j(200, res);
        }
        // "Tell me more" — a question asked back at a decision INSTEAD of
        // answering it. Keeps the options from being a closed set: the row
        // stays open, stays counted, and the attached agent owes context.
        const taskMoreInfoMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/more-info$/);
        if (taskMoreInfoMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskMoreInfoMatch[1] ?? '');
          const body = await safeJson(req);
          const question = typeof body?.question === 'string' ? body.question.trim() : '';
          if (question.length === 0) return j(400, { error: 'question required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.requestMoreInfo(taskId, question, { actor: author });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          return j(200, res);
        }
        // ── A ticket's review items: 0..n, several possibly open at once ────
        //
        // The two routes ABOVE are untouched and stay that way. They are the
        // old doors, and a session running an old plugin bundle keeps calling
        // them from a process we cannot restart — `answerTaskReview` on the
        // derived `r-legacy` row delegates straight back into
        // `answerDecision`, so there is exactly one implementation of
        // "record a decision's answer" underneath both.
        //
        // What these add is the cardinality. A decision task used to BE a
        // decision — one `needs` flag and one embedded `options` array — so
        // the ticket title had to double as the question and a second open
        // question had nowhere to go. Now the question is a row with its own
        // headline and why, and `:reviewItemId` says which one an answer
        // lands on.
        const taskReviewAddMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review-items$/);
        if (taskReviewAddMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskReviewAddMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          // Unvalidated on purpose: `addReviewItem` runs `checkReviewPayload`,
          // and that IS the gate. A pre-check here would be a second copy of
          // the limits, free to drift from the one the card renders against.
          const res = taskStore.addReviewItem(taskId, body?.review, { actor: author });
          if (!res.ok) {
            return j(res.error === 'not-found' ? 404 : 400, {
              error: res.error,
              ...(res.message !== undefined ? { message: res.message } : {}),
            });
          }
          taskProjection.ensureWorkspace(res.task.workspaceId);
          announceTaskReview(res.task, res.item, author);
          // `reviewAdvice`, the same key a comment-borne declaration answers
          // with. The divergent `shapeGaps` vocabulary stays exactly where it
          // is for the callers that already read it — this is a new door, and
          // a new door has no old callers to keep.
          return j(200, {
            task: res.task,
            item: res.item,
            ...(res.advice !== undefined ? { reviewAdvice: res.advice } : {}),
          });
        }
        const taskReviewAnswerMatch = pathname.match(
          /^\/api\/tasks\/([^/]+)\/review-items\/([^/]+)\/answer$/,
        );
        if (taskReviewAnswerMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskReviewAnswerMatch[1] ?? '');
          const reviewItemId = decodeURIComponent(taskReviewAnswerMatch[2] ?? '');
          const body = await safeJson(req);
          const text = body?.text;
          if (typeof text !== 'string' || text.length === 0) {
            return j(400, { error: 'text required' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          // `answeredWith` is this entity's spelling of the legacy `optionId`:
          // provenance for a tapped answer, never a substitute for the words.
          const answeredWith = body?.answeredWith;
          if (answeredWith !== undefined && typeof answeredWith !== 'string') {
            return j(400, { error: 'answeredWith must be a string' });
          }
          const res = taskStore.answerTaskReview(taskId, reviewItemId, text, {
            actor: author,
            ...(answeredWith !== undefined ? { answeredWith } : {}),
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        const taskReviewInfoMatch = pathname.match(
          /^\/api\/tasks\/([^/]+)\/review-items\/([^/]+)\/more-info$/,
        );
        if (taskReviewInfoMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskReviewInfoMatch[1] ?? '');
          const reviewItemId = decodeURIComponent(taskReviewInfoMatch[2] ?? '');
          const body = await safeJson(req);
          const question = typeof body?.question === 'string' ? body.question.trim() : '';
          if (question.length === 0) return j(400, { error: 'question required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.requestMoreInfoOnReview(taskId, reviewItemId, question, {
            actor: author,
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        // set_task_dependencies: edit `after` / `afterEnforce` on a task that
        // already exists. Until this route, `after` could only be set at
        // creation — so a decision filed after the work it gates could never
        // be wired to it, every decision on a real board had an empty `after`,
        // and "is this blocking anything" was underivable. Replaces the whole
        // edge set (an edge has to be removable), and emits no store event, so
        // the projection is refreshed by hand — the renameTask contract.
        const taskAfterMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/after$/);
        if (taskAfterMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskAfterMatch[1] ?? '');
          const body = await safeJson(req);
          if (!Array.isArray(body?.after)) return j(400, { error: 'after must be an array' });
          if (body?.afterEnforce !== undefined && !Array.isArray(body.afterEnforce)) {
            return j(400, { error: 'afterEnforce must be an array' });
          }
          for (const id of [...body.after, ...((body.afterEnforce as unknown[]) ?? [])]) {
            if (typeof id !== 'string') return j(400, { error: 'task ids must be strings' });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.setDependencies(
            taskId,
            {
              after: body.after as string[],
              ...(body.afterEnforce !== undefined
                ? { afterEnforce: body.afterEnforce as string[] }
                : {}),
            },
            { actor: author },
          );
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        // In-place task title edit (§3.9: tap the title, Enter commits) —
        // and rewrite_task's title-only path. Emits an attributed
        // task.retitled when the title actually moves; the hand refresh
        // below stays because a no-op rename ("changed: false") emits
        // nothing. `reason` is optional and rides the audit row verbatim.
        const taskTitleMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/title$/);
        if (taskTitleMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskTitleMatch[1] ?? '');
          const body = await safeJson(req);
          const title = typeof body?.title === 'string' ? body.title.trim() : '';
          if (title.length === 0) return j(400, { error: 'title required' });
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
          const res = taskStore.renameTask(taskId, title, {
            actor: author,
            ...(reason ? { reason } : {}),
          });
          if (!res.ok) return j(404, res);
          taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        // update_task_body: replace a task's description after creation.
        // The body is a live `task:<id>` doc room, so this goes THROUGH that
        // room rather than at the store's snapshot field — a block-level
        // diff, so comment threads on paragraphs the rewrite didn't touch
        // keep their anchors, and anyone reading the task on the board sees
        // it change under them. Three things the doc route alone can't do,
        // and each of them looks like "the rewrite failed" from outside:
        // create the room on a workspace this process hasn't served yet,
        // flush the snapshot the board and next_tasks read, and put an
        // attributed row in the audit log.
        const taskBodyMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/body$/);
        if (taskBodyMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskBodyMatch[1] ?? '');
          const body = await safeJson(req);
          const markdown = typeof body?.markdown === 'string' ? body.markdown : '';
          // Optional: shaping retitles and rewrites in ONE act, so a clipped
          // capture title is not left behind by the pass that fixed its body.
          // A blank string is "no new title", never a request to blank one.
          const title = typeof body?.title === 'string' ? body.title.trim() : '';
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const task = taskStore.getTask(taskId);
          if (!task) return j(404, { ok: false, error: 'not-found' });
          if (!markdown.trim()) return j(400, { ok: false, error: 'empty' });
          const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
          const res = rewriteTaskBody(task, markdown, {
            actor: author,
            ...(title ? { title } : {}),
            ...(reason ? { reason } : {}),
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
          // No hand-refresh of the projection: unlike `/title` (which emits
          // nothing by design), this act DOES emit, and the projection's own
          // subscriber re-runs ensureWorkspace off the event.
          const rewritten = taskStore.getTask(taskId);
          return j(200, {
            ok: true,
            task: rewritten,
          });
        }
        // assign_task (§3.6 task.assigned): hand a task between the human and
        // the agent (or a named identity). Status is untouched — a hand-off
        // is not progress, and routing it through the transition gate would
        // make "you take this" require evidence.
        const taskAssigneeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/assignee$/);
        if (taskAssigneeMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskAssigneeMatch[1] ?? '');
          const body = await safeJson(req);
          const assignee = resolveAssignee(body?.assignee, undefined);
          // The create routes gate this; without the same gate here a board
          // could be walked back to the generic owner one hand-over at a time.
          // No author fallback: "hand it to whoever" is not a hand-over, and
          // silently assigning to the caller would do something else than what
          // they asked.
          if (!assignee) {
            return j(400, {
              error: ASSIGNEE_REQUIRED_ERROR,
              message: ASSIGNEE_REQUIRED_HANDOVER_MESSAGE,
            });
          }
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          // `assigneeKind` is forwarded here explicitly. The route layer is
          // the one nothing type-checks, and a param accepted by the tool and
          // dropped by the route answers 200 while doing nothing — this
          // codebase has shipped that exact bug. Refused rather than dropped
          // for the same reason: the plausible typo here is 'human', which is
          // a valid ASSIGNEE, and swallowing it would answer 200 while the
          // row lands undeclared.
          const handoverKind = parseAssigneeKind(body?.assigneeKind);
          if (!handoverKind.ok) {
            return j(400, {
              error: BAD_ASSIGNEE_KIND_ERROR,
              message: BAD_ASSIGNEE_KIND_MESSAGE,
            });
          }
          const res = taskStore.setAssignee(taskId, assignee, {
            actor: author,
            assigneeKind: handoverKind.assigneeKind,
          });
          if (!res.ok) return j(404, res);
          // A no-op emits nothing, so nothing would refresh the board room —
          // harmless here (nothing changed) but the changed path is covered
          // by the task.assigned event's own projection hook.
          if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
          // Echo what the board now says this owner IS. Without it the caller
          // learns only that the call didn't error — which is exactly what a
          // declaration that silently failed to land also reports.
          const ownerKind = taskProjection.ownerKindReader(res.task.workspaceId)(res.task);
          return j(200, { ...res, ownerKind });
        }
        // Set / move / clear a due date (§3.6 task.due_set). `dueAt` was
        // writable only at creation, so the detail panel rendered a date
        // nobody could correct. Bryan, 2026-08-18: "All fields must be human
        // editable."
        const taskDueMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/due$/);
        if (taskDueMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskDueMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          // `null` clears and a number sets. Anything else is REFUSED rather
          // than coerced: an unparseable date silently read as "clear" would
          // answer 200 while deleting the fact the caller meant to change.
          const raw = body?.dueAt;
          const dueAt =
            raw === null || raw === undefined
              ? null
              : typeof raw === 'number' && Number.isFinite(raw)
                ? raw
                : undefined;
          if (dueAt === undefined) {
            return j(400, { error: 'dueAt must be an epoch-ms number, or null to clear' });
          }
          const res = taskStore.setDueAt(taskId, dueAt, { actor: author });
          if (!res.ok) return j(404, res);
          if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        // Park a row: move it to `triage` and leave a comment saying why and
        // when to come back to it.
        //
        // The verb is older than its meaning. Parking used to be a state of
        // its own (`parkedUntil` on the row) until the owner's 2026-08-27
        // call that it duplicated triage — both say nobody is working this and
        // nobody has agreed it is work. The state went; the route stayed,
        // still on its old payload, because the shared server's REST callers
        // cannot be restarted (CLAUDE.md: narrowing a verb keeps accepting the
        // old shape).
        //
        // Which makes `parkedUntil: null` the delicate arm. It used to mean
        // "un-park now", and an old bundle still sends it that way — so it
        // must not be read as "park with no date", which would shove a live
        // row an old caller was trying to WAKE back into triage. It answers
        // 200 and does nothing, and says so. Parking with no date is spelled
        // by omitting the field, which no old caller does: the old MCP schema
        // required it.
        const taskParkMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/park$/);
        if (taskParkMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskParkMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const task = taskStore.getTask(taskId);
          if (!task) return j(404, { ok: false, error: 'not-found' });
          const present = body !== null && typeof body === 'object' && 'parkedUntil' in body;
          const raw = body?.parkedUntil;
          // Same strictness the /due route keeps, and for a sharper reason
          // now: an unparseable date read as anything at all would move the
          // row on a request the caller got wrong.
          if (present && raw !== null && !(typeof raw === 'number' && Number.isFinite(raw))) {
            return j(400, {
              error: 'parkedUntil must be an epoch-ms number, or null (the retired un-park)',
            });
          }
          if (present && raw === null) {
            return j(200, {
              ok: true,
              task,
              changed: false,
              commented: false,
              message:
                'Un-parking is retired — parking is now a move to triage plus a comment, so there is no deferral to lift. Move the row on with a status change when it is ready.',
            });
          }
          const until = present ? (raw as number) : undefined;
          const reason = typeof body?.reason === 'string' ? body.reason : undefined;
          // Read BEFORE the move: `task` is the live row, so its status is
          // already `triage` on the other side of the call.
          const wasStatus = task.status;
          const moved = taskStore.transition(taskId, 'triage', { actor: author });
          // `same-status` is the ordinary case — a second park on a row
          // already in triage — and it still earns its comment below. Anything
          // else is refused rather than half-done: a note claiming a deferral
          // on a row that did not move is worse than no note. (A goal row
          // cannot reach here at all: `getTask` above resolves tasks only, so
          // a goal id 404s, which is what this verb has always answered.)
          if (!moved.ok && moved.error !== 'same-status') return j(400, moved);
          const changed = moved.ok;
          // The comment lands either way. It is the whole of what the verb
          // records now, and a row already in triage is exactly the row a
          // second park has something new to say about.
          taskProjection.ensureTaskBody(task);
          const note = await rooms.postComment(
            taskBodyDocId(taskId),
            null,
            author,
            parkNoteText({
              ...(until !== undefined ? { until } : {}),
              ...(reason !== undefined ? { reason } : {}),
              ...(changed ? { from: wasStatus } : {}),
            }),
            { kind: 'subject' },
            // Machine-written and one line long: not worth an outbound call.
            { generate: false },
          );
          if (!changed) taskProjection.ensureWorkspace(task.workspaceId);
          return j(200, {
            ok: true,
            task: taskStore.getTask(taskId) ?? task,
            changed,
            commented: note !== null,
          });
        }
        // Soft-delete a row, and put it back (§3.6 task.archived /
        // task.restored). The board's ONLY removal: three fields on the task,
        // nothing moved on disk, the id and every thread hanging off it still
        // resolving. See `archivedAt` on the Task type.
        //
        // `reason` is optional here where a park's is merely encouraged — an
        // archive is often a one-tap "not this" from a keyboard, and refusing
        // it for want of a sentence would push people back to leaving dead
        // rows on the board, which is the thing being fixed.
        const taskArchiveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/archive$/);
        if (taskArchiveMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskArchiveMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.archiveTask(taskId, {
            actor: author,
            ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
          });
          if (!res.ok) return j(404, res);
          if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        const taskRestoreMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/restore$/);
        if (taskRestoreMatch && req.method === 'POST') {
          const taskId = decodeURIComponent(taskRestoreMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const res = taskStore.unarchiveTask(taskId, { actor: author });
          if (!res.ok) return j(404, res);
          if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
          return j(200, res);
        }
        // set_goal_list (§3.2 edit contract): replace the ordered board
        // sections. Structural validation happens HERE because the store
        // trusts its callers with shapes — a junk entry that reached the
        // sidecar would render as a broken section forever.
        const wsGoalsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goals$/);
        if (wsGoalsMatch && req.method === 'PUT') {
          const workspaceId = decodeURIComponent(wsGoalsMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const goals = parseGoalList(body?.goals);
          if (!goals) {
            return j(400, { error: 'goals must be [{id?, title, dueAt?, subgoals?}]' });
          }
          // `drop` is the caller's explicit "yes, remove that band even
          // though it holds work". A malformed value must NOT read as absent
          // — silently treating a string as no acknowledgement would turn a
          // typo into a refusal the caller cannot explain.
          const drop = body?.drop;
          if (
            drop !== undefined &&
            (!Array.isArray(drop) || drop.some((id) => typeof id !== 'string' || id.length === 0))
          ) {
            return j(400, { error: 'drop must be an array of goal ids' });
          }
          const res = taskStore.setGoalList(workspaceId, goals, {
            actor: author,
            ...(drop !== undefined ? { drop: drop as string[] } : {}),
          });
          if (!res.ok) {
            // The refusal is the whole feature, so it has to name the way
            // out: the MCP layer surfaces this body verbatim as the error
            // text an agent reads.
            // An id this board does not hold is the re-key gesture arriving
            // by its other spelling ("submit the list with a new id"), so the
            // message has to name both ways out rather than just saying no.
            const detail =
              res.error === 'unknown-goal-id'
                ? {
                    message:
                      `this board has no goal with id ${res.unknownIds
                        .map((id) => `"${id}"`)
                        .join(', ')}. ` +
                      'Goal ids are generated and permanent: to CREATE a band, send the entry ' +
                      'with no `id` at all and the new id comes back in `created`; to change a ' +
                      "band's title, use rename_goal, which cannot move a task. There is no " +
                      "way to give an existing band a different id, because a task's band IS " +
                      'its goal id — re-keying one is what strands everything filed under it.',
                  }
                : res.error === 'would-strand-tasks'
                  ? {
                      message:
                        'this replace would strand work filed under ' +
                        `${res.stranding
                          .map(
                            (s) =>
                              `"${s.title}" (${s.id}: ${s.openTasks} open, ${s.doneTasks} done)`,
                          )
                          .join('; ')}. ` +
                        'If you meant to RENAME a band, use rename_goal — it changes the title ' +
                        'in place and cannot move a task. If you meant to remove it, say so by ' +
                        'listing its id in `drop`; open tasks then land at the bottom of Backlog ' +
                        'and done tasks keep pointing at the removed id, both reported back.',
                    }
                  : {};
            return j(res.error === 'workspace-not-found' ? 404 : 400, { ...res, ...detail });
          }
          return j(200, res);
        }
        // rename_goal (§3.2): change a band's TITLE without touching its id.
        // Its own route rather than a flag on the PUT above, because the
        // whole value is that it cannot reach the replace path at all — a
        // task's band IS its goal id, and nothing here changes an id.
        const wsRenameMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goals\/rename$/);
        if (wsRenameMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsRenameMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const goalId = body?.goal;
          if (typeof goalId !== 'string' || goalId.length === 0) {
            return j(400, { error: 'goal must be a goal id' });
          }
          const title = body?.title;
          if (typeof title !== 'string' || title.trim().length === 0) {
            return j(400, { error: 'title must be a non-empty string' });
          }
          // `null` clears dueAt, a number sets it, absent leaves it alone —
          // three distinct meanings, so the parse keeps them distinct.
          const dueAt = body?.dueAt;
          if (dueAt !== undefined && dueAt !== null && typeof dueAt !== 'number') {
            return j(400, { error: 'dueAt must be a number, or null to clear it' });
          }
          const res = taskStore.renameGoal(
            workspaceId,
            goalId,
            {
              title: title.trim(),
              ...(dueAt !== undefined ? { dueAt: dueAt as number | null } : {}),
            },
            { actor: author },
          );
          if (!res.ok) {
            // `chores` is a 400, not a 404: it is a row the caller really
            // saw, so "no such goal" would send them hunting for a typo.
            const status =
              res.error === 'reserved-goal-id' ? 400 : res.error === 'goal-not-found' ? 404 : 404;
            return j(status, res);
          }
          return j(200, res);
        }
        // add_goal: append ONE band. Separate from the PUT above for the same
        // reason rename is — that one replaces the list, so a board adding a
        // band through it submits the list it last read and removes anything
        // another writer added in between.
        const wsAddGoalMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goals\/add$/);
        if (wsAddGoalMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsAddGoalMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const title = body?.title;
          if (typeof title !== 'string' || title.trim().length === 0) {
            return j(400, { error: 'title must be a non-empty string' });
          }
          const dueAt = body?.dueAt;
          if (dueAt !== undefined && typeof dueAt !== 'number') {
            return j(400, { error: 'dueAt must be a number' });
          }
          const after = body?.after;
          if (after !== undefined && (typeof after !== 'string' || after.length === 0)) {
            return j(400, { error: 'after must be a goal id' });
          }
          const res = taskStore.addGoal(
            workspaceId,
            {
              title: title.trim(),
              ...(dueAt !== undefined ? { dueAt: dueAt as number } : {}),
              ...(after !== undefined ? { after: after as string } : {}),
            },
            { actor: author },
          );
          if (!res.ok) {
            const status = res.error === 'rejected' ? 400 : 404;
            return j(status, res);
          }
          return j(200, res);
        }
        // reorder_goals (§3.2): the priority gesture, permutation-only. A
        // separate route from the PUT above because that one REPLACES the
        // list — the two params here (`order`, `parent`) are the whole
        // contract, and `parent` is exactly the kind of param a hand-copying
        // route drops while still answering 200, so both are asserted
        // end-to-end in goal-reorder.test.ts (the `groups` lesson).
        const wsReorderMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goals\/reorder$/);
        if (wsReorderMatch && req.method === 'POST') {
          const workspaceId = decodeURIComponent(wsReorderMatch[1] ?? '');
          const body = await safeJson(req);
          const author = authorFor(body?.author);
          if (!author) return j(400, { error: 'author required' });
          const order = body?.order;
          if (
            !Array.isArray(order) ||
            order.some((id) => typeof id !== 'string' || id.length === 0)
          ) {
            return j(400, { error: 'order must be an array of goal ids' });
          }
          const parent = body?.parent;
          if (parent !== undefined && (typeof parent !== 'string' || parent.length === 0)) {
            return j(400, { error: 'parent must be a goal id' });
          }
          const res = taskStore.reorderGoals(workspaceId, order as string[], {
            actor: author,
            ...(parent !== undefined ? { parent: parent as string } : {}),
          });
          if (!res.ok) {
            // The refusal has to be readable by the agent that hit it: the
            // MCP layer surfaces the raw body as the error text, so the ids
            // and what to do about them belong right here.
            const detail =
              res.error === 'order-mismatch'
                ? {
                    message:
                      'order must be exactly the goal ids at this scope. ' +
                      `unknown: [${res.unknownIds.join(', ')}]; ` +
                      // Named separately because the fix differs: an unknown
                      // id means re-read, a reserved one means drop it.
                      `reserved (never ordered — leave these out): [${res.reservedIds.join(', ')}]; ` +
                      `missing: [${res.missingIds.join(', ')}]; ` +
                      `duplicated: [${res.duplicateIds.join(', ')}]. ` +
                      `Re-read the list with GET /api/workspaces/${workspaceId} and send back every ` +
                      'row at this scope whose `reorderable` is true.',
                  }
                : {};
            return j(res.error === 'workspace-not-found' ? 404 : 400, { ...res, ...detail });
          }
          return j(200, res);
        }
        // promote_to_task (§3.10): thread → task. Captures the origin ref,
        // the latest HUMAN comment as the verbatim quote (an agent's closing
        // note must never become the quote), and drafts a title + body the
        // caller didn't supply. classifyActor draws the person/agent line —
        // the same one replies and transitions use.
        const promoteMatch = pathname.match(/^\/api\/docs\/([^/]+)\/threads\/([^/]+)\/promote$/);
        if (promoteMatch && req.method === 'POST') {
          const docId = canonicalDocId(decodeURIComponent(promoteMatch[1] ?? ''));
          const threadId = decodeURIComponent(promoteMatch[2] ?? '');
          const body = await safeJson(req);
          const workspaceId = body?.workspaceId;
          if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
            return j(400, { error: 'workspaceId required' });
          }
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace not found' });
          }
          const thread = rooms.getThread(docId, threadId);
          if (!thread) return j(404, { error: 'thread not found' });
          const humanComment = [...thread.comments]
            .reverse()
            .find((c) => classifyActor(c.author) === 'person');
          const quote =
            typeof body?.quote === 'string' && body.quote.length > 0
              ? body.quote
              : humanComment?.text;
          const snippet = anchorSnippetText(thread.anchor);
          const titleSource = (quote ?? snippet ?? 'Promoted thread').split('\n')[0] ?? '';
          const title =
            typeof body?.title === 'string' && body.title.trim().length > 0
              ? body.title.trim()
              : // A word boundary, not a character count. This clip used to be
                // `slice(0, 79)`, which is where the board's *"For tasks, I get
                // dumped o…"* came from — the GENERATOR produced that, not
                // whoever spoke it. The replacement is a prefix of the same
                // prefix, so it can only ever read better.
                clipToWordBoundary(titleSource, 80);
          const draftBody =
            typeof body?.body === 'string'
              ? body.body
              : [
                  `Promoted from a comment thread${snippet ? ` on "${snippet}"` : ''}.`,
                  ...(quote ? ['', `> ${quote}`] : []),
                ].join('\n');
          const promoteNeeds = parseNeeds(body?.needs);
          if (!promoteNeeds.ok) return j(400, { error: "needs must be 'action' | 'decision'" });
          const promoteOptions = parseOptions(body?.options);
          if (!promoteOptions.ok) return j(400, { error: BAD_OPTIONS_ERROR });
          const promoteLinks = parseLinks(body?.links);
          if (!promoteLinks.ok) return j(400, { error: BAD_REF_ERROR });
          // Same rule as a plain create: a promoted thread lands owned by
          // whoever promoted it unless the call names someone else.
          const promotedBy = authorFor(body?.author);
          const promoteKind = parseAssigneeKind(body?.assigneeKind);
          if (!promoteKind.ok) {
            return j(400, {
              error: BAD_ASSIGNEE_KIND_ERROR,
              message: BAD_ASSIGNEE_KIND_MESSAGE,
            });
          }
          const promoteOwner = resolveAssignee(body?.assignee, promotedBy);
          if (!promoteOwner) {
            return j(400, {
              error: ASSIGNEE_REQUIRED_ERROR,
              message: ASSIGNEE_REQUIRED_MESSAGE,
            });
          }
          const res = taskStore.createTask(workspaceId, {
            title,
            body: draftBody,
            assignee: promoteOwner,
            assigneeKind: promoteKind.assigneeKind,
            needs: promoteNeeds.needs,
            options: promoteOptions.options,
            // Forward undefined untouched: an omitted goal is what routes the
            // task through triage (an explicit 'chores' would skip it).
            goal: body?.goal as string | undefined,
            order: typeof body?.order === 'number' ? Number(body.order) : undefined,
            dueAt: typeof body?.dueAt === 'number' ? Number(body.dueAt) : undefined,
            links: promoteLinks.links,
            origin: { kind: 'thread', docId, threadId },
            ...(quote !== undefined ? { quote } : {}),
            actor: promotedBy ?? undefined,
          });
          if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
          return j(200, {
            task: res.task,
            // Third create path, same report. Promoting a thread has exactly
            // the same goal semantics as a create, so an agent that learns to
            // read `placement` on one and finds it missing on another is being
            // taught the field is unreliable.
            placement: {
              ...res.placement,
              ...(res.placement.placed
                ? {}
                : { goals: placeableGoals(taskStore.getWorkspace(workspaceId)?.goals ?? []) }),
            },
            ...(promoteLinks.ignored.length > 0 ? { ignoredLinks: promoteLinks.ignored } : {}),
            ...(res.shapeGaps !== undefined ? { shapeGaps: res.shapeGaps } : {}),
          });
        }
        // --- REST: durable agent watches ---
        // The MCP child's watch set, remembered here per agent identity so a
        // respawned child can ask for it back. The server never opens the
        // streams — it holds the list. GET is the restore path (prunes keys
        // whose doc is gone and says so); POST unions `add` / deletes
        // `remove`, never replaces, so two live sessions sharing one name
        // cannot clobber each other. See agent-watches.ts.
        const agentWatchesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/watches$/);
        if (agentWatchesMatch) {
          // Same defense-in-depth posture as the plugin routes below: a share
          // host never reaches here today (`shareScopeAllows` is a closed
          // allowlist), and this keeps a later allowlisting from exposing one
          // agent's subscription list to an external reviewer.
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const agentId = decodeURIComponent(agentWatchesMatch[1] ?? '');
          if (!isValidAgentId(agentId)) return j(400, { error: 'bad agentId' });
          if (SHARED_AGENT_IDS.has(agentId)) {
            return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
          }
          // A key is live when the thing it names still exists: a doc room, or
          // for `ws:<id>` a hub workspace / review. Anything else
          // is a subscription the child would open against a 404 forever.
          const watchKeyExists = (key: string): boolean => {
            if (rooms.get(key)) return true;
            if (!key.startsWith('ws:')) return false;
            const wsId = key.slice('ws:'.length);
            return (
              taskStore.getWorkspace(wsId) !== undefined ||
              rooms.list().some((m) => m.workspaceId === wsId)
            );
          };
          if (req.method === 'GET') {
            const listed = agentWatches.list(agentId, watchKeyExists);
            // ADDITIVE. `coverage` is a new key on an existing 200 body, so a
            // bundle built before it ignores it and behaves exactly as it did
            // — which matters here specifically because this is the restore
            // path every respawned child calls before it can do anything else.
            return j(200, {
              ...listed,
              coverage: watchCoverageFor(
                agentId,
                listed.watches.map((w) => w.key),
              ),
            });
          }
          if (req.method === 'POST') {
            const body = await safeJson(req);
            const rawAdd = Array.isArray(body?.add) ? (body?.add as unknown[]) : [];
            const rawRemove = Array.isArray(body?.remove) ? (body?.remove as unknown[]) : [];
            const badKey = [...rawAdd, ...rawRemove].find((k) => !isValidWatchKey(k));
            if (badKey !== undefined) {
              return j(400, { error: 'bad watch key', key: String(badKey) });
            }
            const name = typeof body?.name === 'string' ? body.name : undefined;
            // Store the doc's own id, whichever spelling the caller watched
            // by. A watch is DURABLE and its key is matched against board
            // membership to answer "is this agent covering that board" — so a
            // key stored as a readable alias would leave the board looking
            // unwatched, which is the alarm going quiet rather than the alarm
            // saying no. `ws:` keys resolve to themselves and pass through.
            const canonicalKeys = (keys: unknown[]): string[] =>
              (keys as string[]).map((k) => canonicalDocId(k));
            const res = agentWatches.update(agentId, {
              add: canonicalKeys(rawAdd),
              // Removal accepts either spelling for the same reason a read
              // does: the caller may only ever have held the readable one.
              remove: canonicalKeys(rawRemove),
              ...(name ? { name } : {}),
            });
            return j(200, res);
          }
          return j(405, { error: 'method not allowed' });
        }
        // --- REST: chat-audit counters ---
        // The daily chat audit publishes per-agent unfiled-ask counts here
        // (POST), and any session reads its own back (GET /:agent). The
        // server stores the audit's number rather than measuring anything —
        // it cannot see chat — so the count a session queries and the count
        // the audit reports are the same row. See chat-audit.ts.
        if (pathname === '/api/chat-audit') {
          // Same defense-in-depth posture as the agent-watches route: no
          // share host reaches here today, and this keeps a later
          // allowlisting from exposing fleet discipline numbers to an
          // external reviewer.
          if (visitor) return j(403, { error: 'not available to share visitors' });
          if (req.method === 'GET') {
            return j(200, { day: localDay(Date.now()), rows: chatAudit.latestPerAgent() });
          }
          if (req.method === 'POST') {
            const body = await safeJson(req);
            try {
              const res = chatAudit.publish({
                day: typeof body?.day === 'string' ? body.day : undefined,
                auditor: typeof body?.auditor === 'string' ? body.auditor : undefined,
                // The store re-validates every field before a byte lands, so
                // this cast narrows shape only, not trust.
                entries: Array.isArray(body?.entries)
                  ? (body?.entries as Parameters<ChatAudit['publish']>[0]['entries'])
                  : [],
              });
              return j(200, res);
            } catch (e) {
              return j(400, { error: e instanceof Error ? e.message : String(e) });
            }
          }
          return j(405, { error: 'method not allowed' });
        }
        const chatAuditMatch = pathname.match(/^\/api\/chat-audit\/([^/]+)$/);
        if (chatAuditMatch) {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
          const agent = decodeURIComponent(chatAuditMatch[1] ?? '').trim();
          if (!agent) return j(400, { error: 'bad agent name' });
          if (isSharedAgentName(agent)) {
            return j(400, {
              error: `"${agent}" is a shared identity — counts are kept per display name (CW_AGENT_NAME)`,
            });
          }
          const day = localDay(Date.now());
          return j(200, { agent, day, ...chatAudit.readFor(agent, day) });
        }
        // --- REST: plugin refresh ---
        // The other half of the drift signal: any peer that can read who is
        // behind can also ask the machine to fetch the new bundle. Safe to
        // expose to everyone in the workspace because it cannot interrupt
        // anyone — it rewrites a version-keyed cache, and a running session
        // keeps loading the path it resolved at launch. Peers take the new
        // version at their own next restart.
        if (pathname === '/api/plugin/refresh') {
          // Unreachable today — `shareScopeAllows` is an allowlist and this
          // path is not on it, so a share host is refused before any route
          // runs (host-guard.test.ts pins that). Kept, and kept AHEAD of the
          // capability check, so that allowlisting this path later cannot
          // silently open a deploy step to external reviewers, and so an
          // unconfigured deployment never answers a visitor with what it
          // would have done.
          if (visitor) return j(403, { error: 'not available to share visitors' });
          if (!pluginRefresher) {
            return j(501, {
              error:
                'plugin refresh not enabled on this server (dev and staging deliberately cannot spawn an update)',
            });
          }
          if (req.method === 'GET') return j(200, { refresh: pluginRefresher.last() });
          if (req.method === 'POST') return j(200, { refresh: await pluginRefresher.refresh() });
          return j(405, { error: 'method not allowed' });
        }
        // --- REST: deploy this server ---
        // Pull the deploy source and restart, as one operation. There is no
        // "just restart" verb here or anywhere below it: a restart re-runs
        // the supervisor out of the deploy source, so over an unpulled
        // checkout it rebuilds the same bundles, republishes the same client,
        // and prints a successful deploy. See deploy.ts.
        //
        // --- Push notifications ---
        //
        // Three verbs: what key to subscribe against, enrol a device, retire
        // one. Enrolment is per browser-per-device, so the hub calls these
        // from a settings toggle rather than at page load.
        if (pathname === '/api/push/key' && req.method === 'GET') {
          const notifier = await pushNotifier();
          return notifier
            ? j(200, { available: true, publicKey: notifier.publicKey() })
            : // Named rather than a bare false, because "why is the toggle
              // greyed out" has exactly one answer worth giving: this origin
              // is not one a service worker can register on.
              j(200, { available: false, reason: 'insecure-origin' });
        }
        if (pathname === '/api/push/subscriptions' && req.method === 'POST') {
          const body = await safeJson(req);
          const user = authorFor(body?.author);
          if (!user) return j(400, { error: 'author required' });
          const subscription = body?.subscription as
            | { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
            | undefined;
          if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys.auth) {
            return j(400, {
              error: 'subscription with endpoint + keys.p256dh + keys.auth required',
            });
          }
          try {
            pushStore.save(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
              },
              { userId: user.id, userName: user.name },
            );
          } catch (err) {
            return j(400, { error: (err as Error).message });
          }
          return j(200, { ok: true });
        }
        if (pathname === '/api/push/subscriptions' && req.method === 'DELETE') {
          const body = await safeJson(req);
          const endpoint = body?.endpoint as string | undefined;
          if (!endpoint) return j(400, { error: 'endpoint required' });
          // Soft, per the project rule — the row stays with `disabledAt` set,
          // and re-enabling on this device revives it rather than duplicating.
          pushStore.disable(endpoint, 'unsubscribed');
          return j(200, { ok: true });
        }

        // Unlike the refresh above, this one DOES interrupt: it ends this
        // process a moment after answering. That is why the response is sent
        // before the restart fires and why the result is written to disk —
        // the reporter does not survive to be asked again.
        if (pathname === '/api/deploy') {
          // Same shape and same reasoning as the refresh route's check: a
          // share host never reaches here (`shareScopeAllows` is a
          // closed-by-default allowlist that runs first, pinned by
          // host-guard.test.ts), so this is defense in depth against a later
          // allowlisting rather than the gate that stops a visitor today.
          if (visitor) return j(403, { error: 'not available to share visitors' });
          if (!deployer) {
            return j(501, {
              error:
                'deploy not enabled on this server (dev and staging deliberately cannot pull or restart the deploy source)',
            });
          }
          // Reading is not deploying: a board surface that shows deploy state
          // is served over the tailnet, and reporting what already happened
          // cannot restart anything. So the read stays at trusted-local, the
          // same level as every other operator read on this server.
          if (req.method === 'GET') return j(200, { deploy: deployer.last() });
          if (req.method === 'POST') {
            // Triggering one is different, and this is the narrow default.
            //
            // `local` in the host guard means "the Host header names one of
            // our own names", which covers every client on the tailnet and
            // the LAN — measured, not assumed. The refresh route next door is
            // safe at that width because it cannot interrupt anybody; a
            // deploy ends this process and drops every live editor socket on
            // the box, so it does not inherit that argument.
            //
            // Checked on the PEER ADDRESS rather than the Host header,
            // because the Host header is client-controlled: a LAN and a
            // tailnet client both reached this server sending
            // `Host: localhost` in the same measurement. See
            // `isLoopbackAddress`.
            //
            // TO LOOSEN (Bryan's call): drop this block and the route is
            // reachable by any trusted-local caller again. That is one
            // deletion, which is why the default is the narrow one — the
            // mistake it can make is refusing a caller who can retry from
            // the box, not restarting prod for somebody who should not have
            // been able to.
            if (!isLoopbackAddress(server.requestIP(req)?.address)) {
              return j(403, {
                error:
                  'deploy must be triggered from this machine (loopback only) — a deploy restarts the server and drops every live editor',
              });
            }
            const body = (await safeJson(req)) ?? {};
            const force = body.force === true;
            const requestedBy = typeof body.requestedBy === 'string' ? body.requestedBy : undefined;
            return j(200, {
              deploy: await deployer.deploy({ force, ...(requestedBy ? { requestedBy } : {}) }),
            });
          }
          return j(405, { error: 'method not allowed' });
        }
        // --- REST: agent attachments (§4) ---
        // AgentAttachment records live OUTSIDE every ydoc; this REST surface
        // is their only read path. `endpoint` is host-machine-describing, so
        // a share visitor's read is redacted (the private-meta pattern) and
        // the mutations are owner-only outright — a visitor attaching an
        // agent or forging a heartbeat is never legitimate.
        const wsAgentsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/attachments$/);
        if (wsAgentsMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(wsAgentsMatch[1] ?? '');
          if (!taskStore.getWorkspace(workspaceId)) {
            return j(404, { error: 'workspace not found' });
          }
          const attachments = visitor
            ? taskStore.listPublicAttachments(workspaceId)
            : taskStore.listAttachments(workspaceId);
          // Drift rides the same read the board already makes, so nobody has
          // to run a command to discover that a merge never reached them.
          // A plugin version is workspace-visible, not host-describing —
          // it says which tools an agent here can use, so a visitor sees it
          // for the same reason they see who is attached.
          const released = readReleasedPluginVersion();
          // The other half of "what is running where": the plugin drift above
          // is about the agents, this is about the browser the reader is
          // holding. A failed client build keeps the previous release live and
          // used to say so only on stderr, so the split widened in silence.
          //
          // Owner-only: `lastError` is a build error off this machine's disk
          // (absolute paths), and which release is live is a fact about the
          // host's deploy rather than workspace content — the same line the
          // `endpoint` redaction draws.
          const clientRelease =
            clientReleaseRootDir && !visitor ? clientReleaseStatus(clientReleaseRootDir) : null;
          return j(200, {
            workspaceId,
            attachments,
            ...(clientRelease ? { clientRelease } : {}),
            pluginRelease: {
              version: released,
              behind: agentsBehind(released, attachments).map((a) => ({
                agentId: a.agentId,
                ...(a.pluginVersion !== undefined ? { pluginVersion: a.pluginVersion } : {}),
              })),
              // How many sessions the `behind` list was computed OVER. It
              // ships beside the list because the list alone cannot be read:
              // empty means "none of the ones checked", and for this board
              // that has normally been one session — its own. Without the
              // denominator the surface renders participation as clearance.
              checked: checkableAttachments(attachments).length,
            },
          });
        }
        if (wsAgentsMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const workspaceId = decodeURIComponent(wsAgentsMatch[1] ?? '');
          const body = await safeJson(req);
          const agentId = body?.agentId;
          if (typeof agentId !== 'string' || agentId.trim().length === 0) {
            return j(400, { error: 'agentId required' });
          }
          const runtime = body?.runtime;
          if (!isAttachmentRuntime(runtime)) {
            return j(400, { error: 'runtime must be claude-code-local | managed-agent | webhook' });
          }
          const res = taskStore.attachAgent(workspaceId, {
            agentId: agentId.trim(),
            runtime,
            capabilities: Array.isArray(body?.capabilities)
              ? (body.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
              : undefined,
            endpoint: typeof body?.endpoint === 'string' ? body.endpoint : undefined,
            // The bundle this session is running. Absent from every peer
            // older than the release that added it — which is the signal,
            // not a gap to paper over with a default.
            pluginVersion:
              typeof body?.pluginVersion === 'string' && body.pluginVersion.trim().length > 0
                ? body.pluginVersion.trim()
                : undefined,
            // Per-process nonce (see AgentAttachment.processId): same nonce
            // means a live process re-attaching, so the drains respect the
            // ack grace; absent (an older bundle) keeps bypass-always.
            processId:
              typeof body?.processId === 'string' && body.processId.trim().length > 0
                ? body.processId.trim()
                : undefined,
          });
          if (!res.ok) return j(404, res);
          return j(200, res);
        }
        const wsAgentHeartbeatMatch = pathname.match(
          /^\/api\/workspaces\/([^/]+)\/attachments\/([^/]+)\/heartbeat$/,
        );
        if (wsAgentHeartbeatMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const workspaceId = decodeURIComponent(wsAgentHeartbeatMatch[1] ?? '');
          const agentId = decodeURIComponent(wsAgentHeartbeatMatch[2] ?? '');
          const body = await safeJson(req);
          const res = taskStore.heartbeat(workspaceId, agentId, {
            // Forwarded, not re-derived: the runtime knows when it last did
            // work; the route's job is only to not drop the field.
            toolCallAt: typeof body?.toolCallAt === 'number' ? Number(body.toolCallAt) : undefined,
          });
          if (!res.ok) return j(404, res);
          // Parked comments ride the observation, as ADDRESSED frames — the
          // response body would not do (the keepalive that carries most
          // heartbeats discards it), and a broadcast would bill every peer
          // for a message that names one of them. Each frame replays the
          // original payload plus this row's id; the receiving MCP's ack is
          // what clears it.
          //
          // `sendToAgent` returning 0 is a REAL answer — the agent holds no
          // stream (its keepalive still lands as plain HTTP while its SSE
          // reconnect fails) — and the hand-over above already stamped the
          // row emitted. Left stamped, the row waits out a full grace window
          // per heartbeat while never actually going anywhere: an
          // SSE-or-nothing loop wearing delivery bookkeeping. Same lesson as
          // setTriageDelivery above ("0 is a real answer"): roll the mark
          // back, so the NEXT heartbeat is a fresh attempt rather than a
          // grace-window wait. Rows the route cannot even frame (no replay
          // payload) are rolled back for the same reason — nothing was sent.
          for (const q of res.queuedComments ?? []) {
            let sent = 0;
            const original =
              q.payload && typeof q.payload === 'object'
                ? (q.payload as Record<string, unknown>)
                : undefined;
            if (original && typeof original.event === 'string') {
              const frame: Record<string, unknown> & { event: string } = {
                ...original,
                event: original.event,
                workspaceId,
                commentQueueId: q.id,
              };
              sent = sse.sendToAgent(`ws~${workspaceId}`, agentId, frame);
            }
            if (sent === 0) taskStore.clearCommentEmitted(workspaceId, q.id);
          }
          return j(200, res);
        }
        // The receipt that clears a queued comment — mirror of the voice ack
        // below, with the same idempotency: a replayed receipt for a row
        // already cleared answers 200 with cleared:false rather than an
        // error.
        const wsCommentAckMatch = pathname.match(
          /^\/api\/workspaces\/([^/]+)\/comment-queue\/([^/]+)\/ack$/,
        );
        if (wsCommentAckMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const workspaceId = decodeURIComponent(wsCommentAckMatch[1] ?? '');
          const entryId = decodeURIComponent(wsCommentAckMatch[2] ?? '');
          const cleared = taskStore.ackComment(workspaceId, entryId);
          return j(200, { ok: true, cleared });
        }
        // The receipt that makes a live voice delivery durable. The server
        // knows what it wrote to a socket and nothing more, so a row stays on
        // the queue until the receiving process says it has it. Idempotent: a
        // replayed receipt for a row already cleared answers 200 with
        // cleared:false rather than an error, because a retrying client
        // should not have to distinguish "gone because I acked it" from
        // "gone because someone else drained it".
        const wsVoiceAckMatch = pathname.match(
          /^\/api\/workspaces\/([^/]+)\/voice-queue\/([^/]+)\/ack$/,
        );
        if (wsVoiceAckMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const workspaceId = decodeURIComponent(wsVoiceAckMatch[1] ?? '');
          const entryId = decodeURIComponent(wsVoiceAckMatch[2] ?? '');
          const cleared = taskStore.ackVoiceRequest(workspaceId, entryId);
          return j(200, { ok: true, cleared });
        }
        const wsAgentDetachMatch = pathname.match(
          /^\/api\/workspaces\/([^/]+)\/attachments\/([^/]+)$/,
        );
        if (wsAgentDetachMatch && req.method === 'DELETE') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const workspaceId = decodeURIComponent(wsAgentDetachMatch[1] ?? '');
          const agentId = decodeURIComponent(wsAgentDetachMatch[2] ?? '');
          if (!taskStore.detachAgent(workspaceId, agentId)) {
            return j(404, { error: 'attachment not found' });
          }
          return j(200, { ok: true });
        }
        /** Boards that link this review, so an archive can put them back. */
        const boardsLinking = (attachmentId: string): string[] =>
          taskStore
            .listWorkspaces()
            .filter((w) => w.docIds?.includes(attachmentId))
            .map((w) => w.id);
        /**
         * Retire a review WITHOUT destroying it: its members' `.ydoc` files
         * move to `data/_archive/`, out of the top level `hydrateFromDisk`
         * reads and into the directory `activity-backfill` scans. Open threads
         * do not block it — a review is usually retired precisely because the
         * threads it still shows have stopped mattering.
         */
        const archiveReview = (setId: string, by: string, reason: string | undefined): Response => {
          const res = rooms.archiveReview(setId, {
            archivedBy: by,
            ...(reason !== undefined ? { reason } : {}),
            linkedWorkspaces: boardsLinking(setId),
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 409, res);
          // A board row pointing at a review that no longer loads is a dead
          // end, so archiving takes the row too — and the manifest remembers
          // which boards, so unarchiving puts it back rather than orphaning it.
          unlinkFromEveryHubWorkspace(setId);
          return j(200, res);
        };
        // Delete a REVIEW as one unit (all-or-nothing open-thread guardrail;
        // ?force=true to override). Member SOURCE files are left untouched,
        // same as DELETE /api/docs/:id.
        //
        // SOFT BY DEFAULT since 0.1.92. The guardrail and the response shape
        // are unchanged — what changed is what happens to the files once it
        // commits: they are archived, not purged. The old payload still works
        // and still means "retire this review"; `?purge=true` is the way to
        // ask for the destructive half, and asking is the point. The project
        // rule is that the `.ydoc` is the durable record the Weekly Review
        // analyses are rebuilt from, so purging is a decision, never a default.
        const deleteReview = (setId: string, force: boolean, purge: boolean): Response => {
          if (!purge) {
            // Apply the SAME open-thread guardrail before archiving, so a
            // caller that passed no `force` gets the refusal it has always
            // got rather than a surprise retirement.
            if (!force) {
              const blocked = rooms
                .list()
                .filter((m) => reviewIdOf(m) === setId)
                .map((m) => ({
                  docId: m.docId,
                  openThreads: rooms.listThreads(m.docId, { status: 'open' }).length,
                }))
                .filter((f) => f.openThreads > 0);
              if (blocked.length > 0) {
                return j(409, { ok: false, error: 'has-open-threads', files: blocked });
              }
            }
            return archiveReview(setId, 'delete_review', undefined);
          }
          const res = rooms.deleteWorkspace(setId, { force });
          if (res.ok) {
            // The review was one row on a board; deleting it must take the
            // row with it, the same way a deleted doc does.
            unlinkFromEveryHubWorkspace(setId);
            return j(200, res);
          }
          return j(res.error === 'has-open-threads' ? 409 : 404, res);
        };
        // Everything currently parked in `data/_archive/` with a manifest.
        // Read-only, and the answer to "what can I bring back".
        //
        // Both kinds, under separate keys. `docs` is ADDITIVE: an older bundle
        // reading `archived` still gets reviews and only reviews, so nothing
        // it already reads changes meaning — which is the rule for this
        // server's REST routes, where the caller is a plugin nobody can
        // restart. Keys rather than one merged list with a discriminator,
        // because the two manifests genuinely differ (a review has `docIds`
        // and a `root`; a doc is one id) and a caller almost always wants one
        // kind or the other.
        if (pathname === '/api/reviews/archived' && req.method === 'GET') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          return j(200, {
            archived: listArchivedReviews(dataDir),
            docs: listArchivedDocs(dataDir),
          });
        }
        const reviewArchiveMatch = pathname.match(/^\/api\/reviews\/([^/]+)\/archive$/);
        if (reviewArchiveMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const setId = decodeURIComponent(reviewArchiveMatch[1] ?? '');
          const body = await safeJson(req);
          const author = body?.author as { name?: string } | undefined;
          const reason = typeof body?.reason === 'string' ? (body.reason as string) : undefined;
          return archiveReview(setId, author?.name ?? 'unknown', reason);
        }
        const reviewUnarchiveMatch = pathname.match(/^\/api\/reviews\/([^/]+)\/unarchive$/);
        if (reviewUnarchiveMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const setId = decodeURIComponent(reviewUnarchiveMatch[1] ?? '');
          const body = await safeJson(req);
          const author = body?.author as { name?: string } | undefined;
          const res = rooms.unarchiveReview(setId, { archivedBy: author?.name ?? 'unknown' });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 409, res);
          // Put the review back on every board it was on when it was archived.
          for (const workspaceId of res.manifest.linkedWorkspaces) {
            if (taskStore.attachDoc(workspaceId, setId).ok)
              taskProjection.ensureWorkspace(workspaceId);
          }
          return j(200, res);
        }
        // The same pair for ONE free-standing doc. They sit HERE rather than in
        // the `/api/docs/:id/...` block below because that block opens with
        // `rooms.get(docId)` and 404s without a room — which is precisely the
        // state an archived doc is in, so an unarchive route inside it could
        // never be reached.
        const docArchiveMatch = pathname.match(/^\/api\/docs\/([^/]+)\/archive$/);
        if (docArchiveMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const docId = canonicalDocId(decodeURIComponent(docArchiveMatch[1] ?? ''));
          const body = await safeJson(req);
          const author = body?.author as { name?: string } | undefined;
          const reason = typeof body?.reason === 'string' ? (body.reason as string) : undefined;
          const res = rooms.archiveDoc(docId, {
            archivedBy: author?.name ?? 'unknown',
            ...(reason !== undefined ? { reason } : {}),
            linkedWorkspaces: boardsLinking(docId),
          });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 409, res);
          // A board row pointing at a doc that no longer loads is a dead end,
          // so archiving takes the row too — and the manifest remembers which
          // boards, so unarchiving puts it back rather than orphaning it.
          unlinkFromEveryHubWorkspace(docId);
          return j(200, res);
        }
        const docUnarchiveMatch = pathname.match(/^\/api\/docs\/([^/]+)\/unarchive$/);
        if (docUnarchiveMatch && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          // Deliberately NOT canonicalized: an archived doc has no room, so
          // there is nothing for an alias to resolve against. The canonical
          // id is what `list_archived_reviews` hands back, which is where a
          // caller gets one. Asserted in doc-id-routes.test.ts so the
          // asymmetry is a decision on the record rather than a surprise.
          const docId = decodeURIComponent(docUnarchiveMatch[1] ?? '');
          const body = await safeJson(req);
          const author = body?.author as { name?: string } | undefined;
          const res = rooms.unarchiveDoc(docId, { archivedBy: author?.name ?? 'unknown' });
          if (!res.ok) return j(res.error === 'not-found' ? 404 : 409, res);
          for (const workspaceId of res.manifest.linkedWorkspaces) {
            if (taskStore.attachDoc(workspaceId, docId).ok)
              taskProjection.ensureWorkspace(workspaceId);
          }
          return j(200, res);
        }
        const reviewDeleteMatch = pathname.match(REVIEW_DELETE);
        if (reviewDeleteMatch && req.method === 'DELETE') {
          // Review-only, and that is the point of the separate verb: a BOARD
          // id here answers not-found rather than being destroyed by a call
          // that meant to clean up a diff review.
          return deleteReview(
            decodeURIComponent(reviewDeleteMatch[1] ?? ''),
            url.searchParams.get('force') === 'true',
            url.searchParams.get('purge') === 'true',
          );
        }
        const wsDeleteMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
        if (wsDeleteMatch && req.method === 'DELETE') {
          const workspaceId = decodeURIComponent(wsDeleteMatch[1] ?? '');
          const force = url.searchParams.get('force') === 'true';
          // COMPAT — this ONE route fronts two stores, dispatching by id, and
          // it is the last place that does. A board is what it deletes now;
          // a review id still resolves because `delete_workspace(reviewId)` is
          // what every shipped plugin bundle and skill has always called, from
          // sessions nobody can restart. New callers use DELETE
          // /api/reviews/<setId> above, which cannot touch a board at all.
          // Ask the task store first: `rooms.deleteWorkspace` enumerates DOC
          // members, so a board — which has none — always came back not-found,
          // and a board created for a five-minute experiment was permanent.
          if (taskStore.getWorkspace(workspaceId)) {
            const openTasks = taskStore.openTaskCount(workspaceId) ?? 0;
            if (openTasks > 0 && !force) {
              return j(409, { ok: false, error: 'has-open-tasks', openTasks });
            }
            // Three steps, ordered so that nothing irreversible happens
            // while the operation can still fail. (1) STAGE the rooms' files
            // — a rename, so it proves they are removable and can be undone;
            // orphan .ydocs must not outlive the board, because once the
            // store entry is gone the id no longer resolves as a board and
            // nothing can come back for them. (2) Delete the board: the
            // commit point. (3) Only now tear the live rooms down, which
            // destroys each task's discussion threads and is therefore the
            // one step that must never run ahead of a refusal. Both failure
            // paths unstage, so a failed DELETE costs nothing at all — not
            // even to a restart that lands right after it.
            // Attached docs are untouched throughout: attachDoc is a LINK,
            // so a doc a deleted board merely cited keeps working.
            // Archived rows included: each still owns a `.ydoc`, and a stage
            // that skipped them would orphan those files under a board that
            // no longer exists — the exact outcome the staging step exists to
            // prevent.
            const taskIds = taskStore
              .listTasks(workspaceId, { includeArchived: true })
              .map((t) => t.id);
            if (!taskProjection.stageWorkspaceFiles(workspaceId, taskIds).ok) {
              taskProjection.unstageWorkspaceFiles(workspaceId, taskIds);
              return j(500, { ok: false, error: 'rooms-cleanup-failed' });
            }
            // force: the open-task guard was applied above.
            const hub = taskStore.deleteWorkspace(workspaceId, { force: true });
            if (!hub.ok) {
              taskProjection.unstageWorkspaceFiles(workspaceId, taskIds);
              // 'persist-failed' is a 500, not a 404: the board is still
              // there, and the caller must not read the refusal as "already
              // gone" and stop asking.
              return j(hub.error === 'persist-failed' ? 500 : 404, hub);
            }
            taskProjection.dropWorkspaceRooms(workspaceId, hub.taskIds);
            return j(200, { ok: true, deletedTasks: hub.deletedTasks });
          }
          return deleteReview(workspaceId, force, url.searchParams.get('purge') === 'true');
        }
        // File-tree view for a bound workspace: nested directory tree with
        // per-file unresolved-comment counts + folder roll-ups. Files are
        // decorated with reviewUrl by the rooms decorator (withReviewUrl).
        // All threads across a workspace (folder bind or diff review) in one
        // call — lets a watching agent poll a single endpoint per review
        // instead of one per member file. ?status=open|resolved filters.
        const wsThreadsMatch = pathname.match(REVIEW_API.threads);
        if (wsThreadsMatch && req.method === 'GET') {
          const setId = decodeURIComponent(wsThreadsMatch[1] ?? '');
          if (!rooms.list().some((m) => reviewIdOf(m) === setId)) {
            return j(404, { error: 'review not found', setId, workspaceId: setId });
          }
          const status = url.searchParams.get('status') as 'open' | 'resolved' | null;
          const threads = rooms
            .listWorkspaceThreads(setId, status ? { status } : undefined)
            .map((t) => withTaskChips(t.docId, t));
          // `workspaceId` carries the SAME value and is deprecated for one
          // release: callers built before the rename read it by that name.
          return j(200, { setId, workspaceId: setId, threads });
        }
        // Grouped-diff sidebar model: changed files organized into logical
        // groups (agent-supplied or heuristic). The default nav for diff
        // reviews.
        const wsGroupedMatch = pathname.match(REVIEW_API.grouped);
        if (wsGroupedMatch && req.method === 'GET') {
          const setId = decodeURIComponent(wsGroupedMatch[1] ?? '');
          const grouped = rooms.listGroupedDiff(setId);
          if (grouped.groups.length === 0) {
            return j(404, { error: 'no diff review found', setId, workspaceId: setId });
          }
          return j(200, grouped);
        }
        // Re-reconcile a workspace against disk: pick up files that changed
        // since the bind, flag members whose file is gone. Never re-mints a
        // docId, so every comment thread survives.
        const wsRefreshMatch = pathname.match(REVIEW_API.refresh);
        if (wsRefreshMatch && req.method === 'POST') {
          const setId = decodeURIComponent(wsRefreshMatch[1] ?? '');
          const res = rooms.refreshWorkspace(setId);
          if (res.ok) return j(200, res);
          return j(res.error === 'not-found' ? 404 : 400, res);
        }
        // Re-group a diff review's sidebar in place. An empty `groups` array
        // is meaningful (fall back to the heuristic); a MISSING one is a
        // caller mistake, so it 400s rather than silently regrouping.
        const wsGroupsMatch = pathname.match(REVIEW_API.groups);
        if (wsGroupsMatch && req.method === 'POST') {
          const setId = decodeURIComponent(wsGroupsMatch[1] ?? '');
          const body = await safeJson(req);
          const groups = body?.groups;
          if (!Array.isArray(groups)) return j(400, { error: 'groups array required' });
          const res = rooms.setWorkspaceGroups(
            setId,
            groups as Array<{ title: string; paths: string[]; details?: string }>,
          );
          if (res.ok) return j(200, res);
          return j(res.error === 'not-found' ? 404 : 400, res);
        }
        // Every file in the workspace's repo (changed ones marked) — the
        // "Show All Files" context view.
        const wsFilesMatch = pathname.match(REVIEW_API.files);
        if (wsFilesMatch && req.method === 'GET') {
          const setId = decodeURIComponent(wsFilesMatch[1] ?? '');
          const res = rooms.listRepoFiles(setId);
          if (!res.ok) return j(404, res);
          // `root` is an absolute host path and every reviewUrl carries the
          // tailnet hostname — neither belongs in a visitor's copy.
          return j(200, visitor ? redactWorkspaceFilesForVisitor(res, visitor.workspaceId) : res);
        }
        // Lazily open an unchanged repo file for context (read-only code doc
        // in the same workspace).
        const wsCtxMatch = pathname.match(REVIEW_API.contextFile);
        if (wsCtxMatch && req.method === 'POST') {
          const setId = decodeURIComponent(wsCtxMatch[1] ?? '');
          const body = await safeJson(req);
          const relPath = body?.relPath as string | undefined;
          if (!relPath) return j(400, { error: 'relPath required' });
          const res = rooms.openContextFile(setId, relPath);
          if (!res.ok) return j(res.error === 'bad-path' ? 400 : 404, res);
          return j(200, { docId: res.docId, meta: metaFor(res.meta) });
        }
        const wsEditMatch = pathname.match(REVIEW_API.editableFile);
        if (wsEditMatch && req.method === 'POST') {
          const setId = decodeURIComponent(wsEditMatch[1] ?? '');
          const body = await safeJson(req);
          const relPath = body?.relPath as string | undefined;
          if (!relPath) return j(400, { error: 'relPath required' });
          const res = rooms.openEditableFile(setId, relPath);
          if (!res.ok) {
            const status =
              res.error === 'bad-path' || res.error === 'not-markdown'
                ? 400
                : res.error === 'pinned'
                  ? 409
                  : 404;
            return j(status, res);
          }
          return j(200, { docId: res.docId, meta: metaFor(res.meta) });
        }
        const wsTreeMatch = pathname.match(REVIEW_API.tree);
        if (wsTreeMatch && req.method === 'GET') {
          const setId = decodeURIComponent(wsTreeMatch[1] ?? '');
          const tree = rooms.buildWorkspaceTree(setId);
          if (tree.tree.children.length === 0) {
            return j(404, { error: 'review not found', setId, workspaceId: setId });
          }
          // Same redaction as /files — see redactWorkspaceTreeForVisitor.
          return j(200, visitor ? redactWorkspaceTreeForVisitor(tree, visitor.workspaceId) : tree);
        }
        // --- A doc's meetings (read-only) ---
        //
        // Ahead of the `/api/docs/<id>/...` catch-all below, which would
        // otherwise swallow both. Deliberately NOT gated on the doc's room
        // existing: a transcript outlives the meeting and the notes agent
        // that reads it arrives afterwards, sometimes after the room has been
        // evicted. There is no write and no delete here — a transcript is the
        // least reconstructible thing this server holds, because the audio is
        // already gone.
        const meetingsMatch = pathname.match(/^\/api\/docs\/([^/]+)\/meetings$/);
        if (meetingsMatch && req.method === 'GET') {
          const addressed = decodeURIComponent(meetingsMatch[1] ?? '');
          if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
          // Same canonicalization the `/audio/` upgrade does, and for the same
          // reason: a doc is reachable by a readable alias, and the meetings
          // are filed under its own id. Reading by alias must find them.
          const docId = rooms.get(addressed)?.docId ?? addressed;
          const meetings = meetingStore.list(docId);
          const live = meetingStore.active(docId);
          return j(200, {
            docId,
            meetings,
            ...(live ? { recording: live.meetingId } : {}),
          });
        }
        const meetingMatch = pathname.match(/^\/api\/docs\/([^/]+)\/meetings\/([^/]+)$/);
        if (meetingMatch && req.method === 'GET') {
          const addressed = decodeURIComponent(meetingMatch[1] ?? '');
          const meetingId = decodeURIComponent(meetingMatch[2] ?? '');
          if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
          const docId = rooms.get(addressed)?.docId ?? addressed;
          const record = meetingStore.list(docId).find((m) => m.meetingId === meetingId);
          if (!record) return j(404, { error: 'meeting not found' });
          // `turns` stays the COUNT the index recorded; the settled lines are
          // their own field, so a caller reading one is never reading the
          // other by accident.
          return j(200, { ...record, transcript: meetingStore.transcript(docId, meetingId) });
        }

        const docMatch = pathname.match(/^\/api\/docs\/([^/]+)(?:\/(.*))?$/);
        if (docMatch) {
          const addressed = decodeURIComponent(docMatch[1] ?? '');
          const rest = docMatch[2] ?? '';
          if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
          const room = rooms.get(addressed);
          if (!room) return j(404, { error: 'doc not found' });
          // Canonicalize ONCE, here, and the ~30 subroutes below inherit both
          // halves of the alias contract: a readable name resolves, and
          // everything they key on (SSE channels, activity rows, thread ids,
          // filenames) uses the doc's own id. Rebinding the name `docId` is
          // deliberate — it is what makes the subroutes correct by default
          // rather than each one having to remember.
          const docId = room.docId;
          if (rest === '' && req.method === 'GET') {
            // Doc→task surfacing (§3.12 commit 4): chips for the tasks that
            // reference this doc — directly or via one of its threads.
            // Visitor-safe by construction (§3.3 rule 2); omitted when empty.
            const taskRefs = taskStore.tasksReferencingDoc(docId).map(taskChip);
            // Which hub workspace this doc is attached to, so the doc surface
            // can route voice utterances (§3.8: voice is not board-only).
            // OWNER ONLY: a workspace id is an unguessable URL capability, and
            // a doc-scoped visitor must not learn it from a member doc.
            const hubWs = visitor ? null : taskStore.workspaceOfDoc(docId);
            // Where the review app's `←` should go: the board that links this
            // doc, rather than the machine-wide landing page. OWNER ONLY for
            // the same reason `hubWorkspaceId` is — a board id is an
            // unguessable URL capability, and a share visitor must not learn
            // one from a member doc. Resolved through the review when the
            // doc is a member of a review, which is where `hubWorkspaceId`
            // deliberately stops.
            const backTo = visitor ? null : backTargetFor(docId, room.meta.workspaceId);
            return j(200, {
              meta: metaFor(room.meta),
              ...(taskRefs.length > 0 ? { tasks: taskRefs } : {}),
              ...(hubWs ? { hubWorkspaceId: hubWs } : {}),
              ...(backTo ? { backTo: { workspaceId: backTo.id, name: backTo.name } } : {}),
            });
          }
          if (rest === '' && req.method === 'DELETE') {
            const force = url.searchParams.get('force') === 'true';
            const res = rooms.deleteDoc(docId, { force });
            if (res.ok) {
              unlinkFromEveryHubWorkspace(docId);
              return j(200, res);
            }
            return j(res.error === 'has-open-threads' ? 409 : 404, res);
          }
          if (rest === 'threads' && req.method === 'GET') {
            const status = url.searchParams.get('status') as 'open' | 'resolved' | null;
            return j(200, {
              threads: rooms
                .listThreads(docId, status ? { status } : undefined)
                .map((t) => withTaskChips(docId, t)),
            });
          }
          // Task-chip resolution (§3.3 rule 2): how a chip inside a doc
          // resolves for a DOC-scoped invite, which never gets the workspace
          // board room. The chip is the visitor-safe shape (id, title,
          // status, assignee) — adding a field to it is a sharing decision.
          if (rest === 'tasks' && req.method === 'GET') {
            return j(200, { docId, tasks: taskStore.tasksReferencingDoc(docId).map(taskChip) });
          }
          const threadIdMatch = rest.match(/^threads\/([^/]+)(\/.*)?$/);
          if (threadIdMatch) {
            const threadId = decodeURIComponent(threadIdMatch[1] ?? '');
            const threadRest = threadIdMatch[2] ?? '';
            if (threadRest === '' && req.method === 'GET') {
              const t = rooms.getThread(docId, threadId);
              return t
                ? j(200, { thread: withTaskChips(docId, t) })
                : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/comments' && req.method === 'POST') {
              const body = await safeJson(req);
              const user = authorFor(body?.author);
              const text = body?.text as string | undefined;
              if (!user || !text) return j(400, { error: 'author + text required' });
              const declared = reviewFromBody(body?.review, text);
              if (!declared.ok) return j(400, { error: declared.error });
              // A person's plain reply IS the answer to the ask it lands on.
              //
              // Three surfaces render an Answer composer and post at
              // `/answer`; every other door a reply comes through — a task
              // panel's discussion composer, the widget, MCP `post_reply`, an
              // older bundle — arrives here. Measured across this project's
              // stored docs, that gap left 12 declarations unanswered with a
              // person's reply sitting under each one, which is what made the
              // queue read as ignored while the reader had in fact answered.
              //
              // `pendingDeclaration` and `answerFromReply` are core's, shared
              // with the queue and the doc panel, so what counts as pending
              // and what counts as an answer are decided in one place. A
              // reply that DECLARES its own ask is skipped: that is a new
              // question, not an answer to the old one.
              const priorThread = declared.review ? null : rooms.getThread(docId, threadId);
              const pending = priorThread ? pendingDeclaration(priorThread) : null;
              const folded =
                pending?.review && classifyActor(user) === 'person'
                  ? answerFromReply(pending.review, text)
                  : null;
              let t: Thread | null = null;
              if (pending && folded) {
                // The whole answer path, exactly as the explicit route uses
                // it — the stamps, the displaced-answer history, the reply,
                // the events. A second writer here is how the two spellings
                // of "answered" would drift.
                const res = await rooms.answerReviewItem(
                  docId,
                  threadId,
                  pending.id,
                  user,
                  text,
                  folded.optionId,
                  // Conditional on the item STILL being pending, re-checked
                  // inside the same synchronous stretch as the stamp. The read
                  // above is a claim about a moment already past; an
                  // unconditional write here would let a reply folded on that
                  // stale claim displace an answer somebody had meanwhile
                  // given, and displace it into history where nobody looks.
                  { generate: !visitor, onlyIfUnanswered: true },
                );
                if (res.ok) {
                  t = res.thread;
                  // Same nudge the explicit answer fires: an answer on a
                  // COMMENT moves no task row, so `decision.answered` never
                  // fires for it and the lead would otherwise not hear that
                  // the thing it was blocked on came back.
                  const foldedHome = resolveWorkspaceForDoc(docId);
                  if (foldedHome) {
                    readyNudger.reviewAnswered({ workspaceId: foldedHome, actorId: user.id });
                  }
                }
                // A refusal here is the loser of that race, never a reason to
                // drop the words: fall through and post the reply as the
                // ordinary comment it always was.
              }
              if (!t) {
                t = await rooms.postComment(docId, threadId, user, text, undefined, {
                  // A share visitor must not be able to spend the API key.
                  generate: !visitor,
                  ...(declared.review ? { review: declared.review } : {}),
                });
              }
              if (t && declared.review) announceThreadReview(docId, t.id, declared.review, user);
              const handoff = threadUrl(docId, Boolean(visitor));
              return t
                ? j(200, {
                    thread: t,
                    ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
                    ...(handoff ? { threadUrl: handoff } : {}),
                  })
                : j(404, { error: 'thread not found' });
            }
            // Answering a Review Item. Deliberately a thin wrapper over the
            // reply above rather than a second write path: `text` is always
            // the verbatim answer, and `optionId` only records which offered
            // option those words came from. A person who types their own
            // answer sends no id and is not answering any less.
            if (threadRest === '/answer' && req.method === 'POST') {
              const body = await safeJson(req);
              const user = authorFor(body?.author);
              const text = body?.text as string | undefined;
              const commentId = body?.commentId as string | undefined;
              if (!user || !text || !commentId) {
                return j(400, { error: 'author + text + commentId required' });
              }
              const res = await rooms.answerReviewItem(
                docId,
                threadId,
                commentId,
                user,
                text,
                typeof body?.optionId === 'string' ? body.optionId : undefined,
                { generate: !visitor },
              );
              if (!res.ok) {
                return j(res.error === 'no-doc' ? 404 : 400, { error: res.error });
              }
              // A review item on a COMMENT is the same ask as one on a
              // ticket, and its answer is the same thing to act on — but it
              // moves no task row, so `decision.answered` never fires for it
              // and the store-event bridge cannot see it. Wired here, at the
              // one route that records such an answer.
              const answerHome = resolveWorkspaceForDoc(docId);
              if (answerHome) {
                readyNudger.reviewAnswered({ workspaceId: answerHome, actorId: user.id });
              }
              return j(200, { thread: res.thread });
            }
            // Taking an answer back. The stamps move into the declaration's
            // `answerHistory` (soft delete — the words are user content) and
            // the reply comment stays in the thread. Un-stamping is what
            // re-offers the item on every surface: each queue derives
            // "waiting on you" from the stamps, so there is no second state
            // to sync. Same visitor gating as /answer — a share visitor's
            // click must not spend the API key.
            if (threadRest === '/answer/undo' && req.method === 'POST') {
              const body = await safeJson(req);
              const user = authorFor(body?.author);
              const commentId = body?.commentId as string | undefined;
              if (!user || !commentId) return j(400, { error: 'author + commentId required' });
              const res = rooms.undoReviewItemAnswer(docId, threadId, commentId, user, {
                generate: !visitor,
              });
              if (!res.ok) {
                return j(res.error === 'no-doc' ? 404 : 400, { error: res.error });
              }
              return j(200, { thread: res.thread });
            }
            if (threadRest === '/summary' && req.method === 'POST') {
              // On-demand generation. The scheduled path is debounced and
              // fire-and-forget; this one blocks and reports what happened,
              // because an agent asked for it and is waiting.
              if (visitor) return j(403, { error: 'not available to share visitors' });
              const t = rooms.getThread(docId, threadId);
              if (!t) return j(404, { error: 'thread not found' });
              if (!summarizer?.enabled) {
                return j(503, {
                  error: 'summaries disabled',
                  detail: `set CW_SUMMARIES=1 and add a key: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
                });
              }
              // Already summarized as it stands: answer with what is stored
              // rather than paying to regenerate the same two lines. The
              // scheduled path and the backfill both ask this question through
              // `needsCall`; an agent that polls this route was the one caller
              // that could bill on every retry. `force` is the deliberate
              // "that line is wrong, do it again" escape hatch.
              const force = (await safeJson(req))?.force === true;
              if (!force && !needsCall(t, t.summary)) {
                return j(200, { thread: t, summary: t.summary, cached: true });
              }
              const summary = await summarizer.generate(t);
              if (!summary) return j(503, { error: 'generation failed' });
              // Re-read before storing, exactly as the scheduled path does.
              // A reply that landed during the call moves `summaryHash`, so
              // storing this one would (a) report success for a summary
              // `threadLines` will ignore forever, and (b) overwrite a valid
              // summary the scheduled path may have just landed for the NEW
              // state — leaving nothing scheduled to repair it.
              const now = rooms.getThread(docId, threadId);
              if (!now) return j(404, { error: 'thread not found' });
              if (summaryHash(now) !== summary.hash) {
                return j(409, { error: 'thread changed during generation' });
              }
              const updated = rooms.applyThreadSummary(docId, threadId, summary);
              return updated
                ? j(200, { thread: updated, summary })
                : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/resolve' && req.method === 'POST') {
              const body = await safeJson(req);
              const author = authorFor(body?.author);
              // Resolve is a thread change, so it schedules a summary — and a
              // visitor must not be able to spend the API key by clicking it.
              const t = rooms.resolve(docId, threadId, author, { generate: !visitor });
              return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/reopen' && req.method === 'POST') {
              const body = await safeJson(req);
              const author = authorFor(body?.author);
              const t = rooms.reopen(docId, threadId, author, { generate: !visitor });
              return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/reanchor' && req.method === 'POST') {
              const body = await safeJson(req);
              const anchor = body?.anchor as Anchor | undefined;
              if (!anchor) return j(400, { error: 'anchor required' });
              // Same gate as thread creation: this route can plant a
              // malformed anchor on an EXISTING thread just as easily.
              const reanchorCheck = anchors.validateAnchor(anchor);
              if (!reanchorCheck.ok) return j(400, { error: reanchorCheck.error });
              const t = rooms.reanchor(docId, threadId, anchor);
              return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
            }
            if (threadRest === '/rewrite_region' && req.method === 'POST') {
              const body = await safeJson(req);
              const replacement = String(body?.replacement ?? '');
              const parseInlineMarks = body?.parseInlineMarks === true;
              if (body?.suggest === true) {
                const author = parseSuggestionAuthor(
                  visitor ? { author: authorFor(body?.author) } : body,
                );
                if (!author) return j(400, { error: 'author required when suggest is true' });
                const res = rooms.createSuggestionForThread(docId, threadId, {
                  replacement,
                  parseInlineMarks,
                  author,
                });
                return res.ok ? j(200, res) : j(409, res);
              }
              const res = rooms.rewriteThreadRegion(docId, threadId, replacement, {
                parseInlineMarks,
              });
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
            if (threadRest === '/insert_after' && req.method === 'POST') {
              const body = await safeJson(req);
              const text = String(body?.text ?? '');
              const res = rooms.insertAfterThread(docId, threadId, text);
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
            if (threadRest === '/insert_blocks_after' && req.method === 'POST') {
              const body = await safeJson(req);
              const markdown = String(body?.markdown ?? '');
              const placement = parsePlacement(body?.placement);
              if (placement === PLACEMENT_INVALID) {
                return j(400, { error: "placement must be 'after-block' or 'top-level'" });
              }
              const res = rooms.insertBlocksAfterThread(docId, threadId, markdown, { placement });
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
          }
          if (rest === 'threads' && req.method === 'POST') {
            const body = await safeJson(req);
            const user = authorFor(body?.author);
            const text = body?.text as string | undefined;
            const anchor = body?.anchor as Anchor | undefined;
            if (!user || !text || !anchor) {
              return j(400, { error: 'author + text + anchor required' });
            }
            // Validate BEFORE the write. An anchor whose startRel/endRel
            // don't decode is accepted silently by the CRDT and then kills
            // the re-anchor sweep from inside a Yjs observer, i.e. on
            // whatever request happens to be in flight minutes later. The
            // caller that wrote it has to be the one that hears about it.
            const anchorCheck = anchors.validateAnchor(anchor);
            if (!anchorCheck.ok) return j(400, { error: anchorCheck.error });
            const declared = reviewFromBody(body?.review, text);
            if (!declared.ok) return j(400, { error: declared.error });
            const t = await rooms.postComment(docId, null, user, text, anchor, {
              generate: !visitor,
              ...(declared.review ? { review: declared.review } : {}),
            });
            if (t && declared.review) announceThreadReview(docId, t.id, declared.review, user);
            const handoff = threadUrl(docId, Boolean(visitor));
            return t
              ? j(200, {
                  thread: t,
                  ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
                  ...(handoff ? { threadUrl: handoff } : {}),
                })
              : j(500, { error: 'could not create thread' });
          }
          if (rest === 'threads/by_find' && req.method === 'POST') {
            const body = await safeJson(req);
            const author = authorFor(body?.author);
            const text = body?.text as string | undefined;
            const find = body?.find ? String(body.find) : '';
            if (!author || !text || find.length === 0) {
              return j(400, { error: 'author + text + find required' });
            }
            const declared = reviewFromBody(body?.review, text);
            if (!declared.ok) return j(400, { error: declared.error });
            const res = await rooms.createThreadByFind(
              docId,
              {
                find,
                contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
                contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
                occurrence:
                  typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
              },
              author,
              text,
              // Visitor-authored text becomes the entire prompt on this route.
              { generate: !visitor, ...(declared.review ? { review: declared.review } : {}) },
            );
            if (res.ok && declared.review) {
              announceThreadReview(docId, res.thread.id, declared.review, author);
            }
            const findHandoff = threadUrl(docId, Boolean(visitor));
            return res.ok
              ? j(200, {
                  thread: res.thread,
                  ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
                  ...(findHandoff ? { threadUrl: findHandoff } : {}),
                })
              : j(409, res);
          }
          if (rest === 'content' && req.method === 'GET') {
            const doc = rooms.getDoc(docId);
            if (!doc) return j(404, { error: 'doc not found' });
            // `reader` marks this caller's copy of the doc as current-as-of-
            // now, which is what lets the stale-write guard below judge their
            // next whole-doc rewrite by order instead of the blunt time
            // window. Sent by get_doc since 0.1.113; older bundles omit it.
            const reader = url.searchParams.get('reader');
            if (reader) rooms.noteAgentRead(docId, reader);
            return j(200, doc);
          }
          // Cheap doc health check — metadata + counts, never the body.
          // Exists because get_doc has returned 320KB for one doc: an agent
          // that only needs "bound? wedged? how big?" must not have to pay
          // for (or overflow on) the content to find out.
          if (rest === 'status' && req.method === 'GET') {
            const status = rooms.getDocStatus(docId);
            if (!status) return j(404, { error: 'doc not found' });
            if (visitor) {
              // Same rule as `sourceUrl` in PRIVATE_META_KEYS: host-machine
              // paths are not workspace content. syncError goes with it —
              // its message can embed the bound path (backup locations,
              // parse errors naming the file).
              const { path: _path, syncError: _syncError, ...visitorSafe } = status;
              return j(200, visitorSafe);
            }
            return j(200, status);
          }
          // Whole-doc rewrite through the live doc — the safe replacement for
          // Write-the-bound-file + reparse_from_disk, which raced the
          // write-back and clobbered (see docs/research/2026-08-03 review).
          if (rest === 'content' && req.method === 'POST') {
            const body = await safeJson(req);
            const markdown = String(body?.markdown ?? '');
            if (markdown.length === 0) return j(400, { error: 'markdown is required' });
            // Stale-write guard (2026-08-26 incident): a whole-doc rewrite
            // built from a copy that predates a human's live edits destroys
            // those edits with a 200. The DEFAULT path is the protected one —
            // an old bundle that omits every new field still gets refused
            // when a human edited recently; only the explicit confirm field
            // opens the gate, and even then the backup below has already run.
            if (body?.confirmOverwriteHumanEdits !== true) {
              const reader = authorFor(body?.author)?.id;
              const stale = rooms.staleWriteCheck(docId, reader);
              if (stale) {
                return j(409, {
                  error: 'stale-write',
                  humanEditedAt: stale.humanEditedAt,
                  ...(stale.lastReadAt !== undefined ? { lastReadAt: stale.lastReadAt } : {}),
                  message:
                    `REFUSED: a human edited this doc at ${new Date(stale.humanEditedAt).toISOString()}` +
                    (stale.lastReadAt !== undefined
                      ? `, AFTER your last read at ${new Date(stale.lastReadAt).toISOString()}`
                      : ', within the last 10 minutes') +
                    ' — a full rewrite from your in-context copy would destroy their work.' +
                    ' Re-read the doc with get_doc, re-apply your change onto the CURRENT' +
                    ' content (prefer a scoped tool: find_and_replace, rewrite_thread_region,' +
                    ' edit_at_anchor), and only if a whole-doc rewrite is truly needed retry' +
                    ' set_doc_content with confirmOverwriteHumanEdits: true.',
                });
              }
            }
            // A `task:<id>` doc is a task's DESCRIPTION, not a free-standing
            // document, and rewriting one is an act the board has a name for.
            // Reachable here by anyone who knows the docId convention, so this
            // route runs the same ceremony `/api/tasks/:id/body` does rather
            // than writing the room and walking away. It is not refused: that
            // would take away the only body-rewrite a bundle older than
            // `update_task_body` (0.1.24) has, to buy a guarantee this branch
            // can simply provide.
            const bodyTaskId = taskIdOfBodyDoc(docId);
            const bodyTask = bodyTaskId ? taskStore.getTask(bodyTaskId) : undefined;
            if (bodyTask) {
              const author = authorFor(body?.author);
              const res = rewriteTaskBody(bodyTask, markdown, {
                ...(author ? { actor: author } : {}),
              });
              return res.ok ? j(200, { ok: true }) : j(409, res);
            }
            const res = rooms.setDocContent(docId, markdown);
            return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
          }
          if (rest === 'reparse_from_disk' && req.method === 'POST') {
            const res = rooms.reparseFromDisk(docId);
            return res.ok ? j(200, res) : j(409, res);
          }
          // Diff-review rendering data: the file's text at the BASE commit
          // (the target text is the doc's own content, streamed over Yjs).
          // Computed on demand from the repo; if the worktree has since been
          // cleaned up, baseText comes back null and the client falls back to
          // the full-file view, which needs nothing beyond the ydoc.
          if (rest === 'diff' && req.method === 'GET') {
            const meta = room.meta;
            if (meta.type !== 'diff') return j(400, { error: 'not a diff doc' });
            const { workspaceRoot, diffBase, diffTarget, relPath } = meta;
            const basePath = meta.diffOldPath ?? relPath;
            let baseText: string | null = null;
            let error: string | undefined;
            if (meta.diffStatus === 'added') {
              baseText = '';
            } else if (workspaceRoot && diffBase && basePath) {
              baseText = showFile(workspaceRoot, diffBase, basePath);
              if (baseText === null) error = 'base content unavailable (repo moved or pruned?)';
            } else {
              error = 'diff metadata incomplete';
            }
            return j(200, {
              baseText,
              status: meta.diffStatus,
              oldPath: meta.diffOldPath,
              base: diffBase,
              target: diffTarget,
              additions: meta.diffAdditions,
              deletions: meta.diffDeletions,
              ...(error ? { error } : {}),
            });
          }
          // Browser-originated reading activity (read_session / doc_open). The
          // markdown/code review surfaces POST interaction-bounded reading
          // sessions here; the server resolves doc/repo/producedBy and stamps
          // actor=person. Unknown types are ignored (400). See activity.ts.
          if (rest === 'activity' && req.method === 'POST') {
            const body = await safeJson(req);
            const type = body?.type as 'read_session' | 'doc_open' | undefined;
            if (type !== 'read_session' && type !== 'doc_open') {
              return j(400, { error: 'type must be read_session or doc_open' });
            }
            const payload = (body?.payload as Record<string, unknown> | undefined) ?? {};
            // Never DEFAULT to Bryan. This endpoint is in a share visitor's
            // scope, so an omitted author used to record their reading
            // activity as his — the one identity on the server that carries
            // any weight. An unattributed read is now unattributed.
            const author = authorFor(body?.author) ?? ANONYMOUS_ACTOR;
            const res = rooms.recordReadEvent(docId, type, payload, author);
            return res.ok ? j(200, { ok: true }) : j(404, res);
          }
          if (rest === 'agent_anchors' && req.method === 'POST') {
            const body = await safeJson(req);
            const find = String(body?.find ?? '');
            if (find.length === 0) return j(400, { error: 'find is required' });
            const res = rooms.createAgentAnchor(docId, {
              find,
              contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
              contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
              occurrence: typeof body?.occurrence === 'number' ? body.occurrence : undefined,
              label: body?.label ? String(body.label) : undefined,
            });
            return res.ok ? j(200, res) : j(409, res);
          }
          const anchorMatch = rest.match(/^agent_anchors\/([^/]+)(\/.*)?$/);
          if (anchorMatch) {
            const anchorId = decodeURIComponent(anchorMatch[1] ?? '');
            const anchorRest = anchorMatch[2] ?? '';
            if (anchorRest === '/edit' && req.method === 'POST') {
              const body = await safeJson(req);
              const kind = body?.kind as 'replace' | 'insert_after' | undefined;
              const text = String(body?.text ?? '');
              if (kind !== 'replace' && kind !== 'insert_after') {
                return j(400, { error: 'kind must be replace or insert_after' });
              }
              const res = rooms.editAtAgentAnchor(docId, anchorId, { kind, text });
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
            if (anchorRest === '/insert_blocks' && req.method === 'POST') {
              const body = await safeJson(req);
              const markdown = String(body?.markdown ?? '');
              if (markdown.length === 0) return j(400, { error: 'markdown is required' });
              const placement = parsePlacement(body?.placement);
              if (placement === PLACEMENT_INVALID) {
                return j(400, { error: "placement must be 'after-block' or 'top-level'" });
              }
              const res = rooms.insertBlocksAtAnchor(docId, anchorId, markdown, { placement });
              return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
            }
            if (anchorRest === '' && req.method === 'DELETE') {
              const removed = rooms.deleteAgentAnchor(docId, anchorId);
              return removed ? j(200, { ok: true }) : j(404, { error: 'anchor not found' });
            }
          }
          if (rest === 'find_and_replace' && req.method === 'POST') {
            const body = await safeJson(req);
            const find = String(body?.find ?? '');
            const replace = String(body?.replace ?? '');
            if (find.length === 0) return j(400, { error: 'find is required' });
            const contextBefore = body?.contextBefore ? String(body.contextBefore) : undefined;
            const contextAfter = body?.contextAfter ? String(body.contextAfter) : undefined;
            const occurrence =
              typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined;
            const replaceAll = body?.replaceAll === true;
            if (body?.suggest === true) {
              if (replaceAll) {
                // Bulk suggestions are out of scope: the suggestion model is
                // one proposal per span, each individually acceptable.
                return j(400, {
                  error: 'replaceAll cannot be combined with suggest — propose spans one at a time',
                });
              }
              const author = parseSuggestionAuthor(
                visitor ? { author: authorFor(body?.author) } : body,
              );
              if (!author) return j(400, { error: 'author required when suggest is true' });
              const res = rooms.createSuggestion(docId, {
                find,
                replace,
                contextBefore,
                contextAfter,
                occurrence,
                parseInlineMarks: body?.parseInlineMarks === true,
                author,
              });
              return res.ok ? j(200, res) : j(409, res);
            }
            const res = rooms.findAndReplace(docId, {
              find,
              replace,
              contextBefore,
              contextAfter,
              occurrence,
              replaceAll,
              parseInlineMarks: body?.parseInlineMarks === true,
            });
            // Piggy-back any pending sync trouble on the response: agents act
            // on edit results, not on get_doc, so this is where a conflict
            // actually gets seen.
            return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
          }
          // Suggested edits (redline-suggestions phase 2, commit 3): list/
          // accept/reject/resolve-all over the doc's pending proposals. See
          // `suggest: true` on find_and_replace / rewrite_region above for
          // creation.
          if (rest === 'suggestions' && req.method === 'GET') {
            return j(200, { suggestions: rooms.listSuggestions(docId) });
          }
          if (rest === 'suggestions/resolve_all' && req.method === 'POST') {
            const body = await safeJson(req);
            const action = body?.action as 'accept' | 'reject' | undefined;
            if (action !== 'accept' && action !== 'reject') {
              return j(400, { error: 'action must be accept or reject' });
            }
            const authorId = body?.authorId ? String(body.authorId) : undefined;
            const res = rooms.resolveAllSuggestions(docId, { action, authorId });
            return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(404, res);
          }
          const suggestionMatch = rest.match(/^suggestions\/([^/]+)\/(accept|reject)$/);
          if (suggestionMatch && req.method === 'POST') {
            const sid = decodeURIComponent(suggestionMatch[1] ?? '');
            const action = suggestionMatch[2];
            const res =
              action === 'accept'
                ? rooms.acceptSuggestion(docId, sid)
                : rooms.rejectSuggestion(docId, sid);
            return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(404, res);
          }
          if (rest === 'delete_block_at_anchor' && req.method === 'POST') {
            const body = await safeJson(req);
            const threadId = body?.threadId ? String(body.threadId) : undefined;
            const anchorId = body?.anchorId ? String(body.anchorId) : undefined;
            if ((threadId && anchorId) || (!threadId && !anchorId)) {
              return j(400, { error: 'exactly one of threadId or anchorId required' });
            }
            const res = threadId
              ? rooms.deleteBlockAtThread(docId, threadId)
              : rooms.deleteBlockAtAgentAnchor(docId, anchorId!);
            return res.ok ? j(200, res) : j(409, res);
          }
          if (rest === 'delete_blocks_in_range' && req.method === 'POST') {
            const body = await safeJson(req);
            const startFind = String(body?.startFind ?? '');
            const endFind = String(body?.endFind ?? '');
            if (startFind.length === 0 || endFind.length === 0) {
              return j(400, { error: 'startFind and endFind are required' });
            }
            const res = rooms.deleteBlocksInRange(docId, {
              startFind,
              endFind,
              contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
              contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
              startOccurrence:
                typeof body?.startOccurrence === 'number'
                  ? Number(body.startOccurrence)
                  : undefined,
              endOccurrence:
                typeof body?.endOccurrence === 'number' ? Number(body.endOccurrence) : undefined,
            });
            return res.ok ? j(200, res) : j(409, res);
          }
          if (rest === 'delete_section' && req.method === 'POST') {
            const body = await safeJson(req);
            const heading = String(body?.heading ?? '');
            if (heading.length === 0) return j(400, { error: 'heading is required' });
            const res = rooms.deleteSection(docId, {
              heading,
              level: typeof body?.level === 'number' ? Number(body.level) : undefined,
              occurrence:
                typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
            });
            return res.ok ? j(200, res) : j(409, res);
          }
          if (rest === 'hooks/fire' && req.method === 'POST') {
            // debug-fires the last thread update again
            const ts = rooms.listThreads(docId);
            if (ts.length === 0) return j(404, { error: 'no threads' });
            const last = ts[ts.length - 1]!;
            if (room.webhookUrl) {
              await webhooks.send(room.webhookUrl, {
                event: 'thread.replied',
                docId,
                threadId: last.id,
                thread: last,
                doc: withReviewUrl(room.meta),
                seq: ++room.seq,
              });
            }
            return j(200, { fired: !!room.webhookUrl });
          }
        }

        // --- Web log ---
        if (pathname === '/api/webhooks/log') {
          return j(200, { log: webhookLog.slice(-100) });
        }

        // --- Static: widget ---
        if (widgetDist && pathname.startsWith('/widget/')) {
          const p = join(widgetDist, pathname.slice('/widget/'.length));
          // serveStaticUnder, like /app/ and /demos/ — this was the one static
          // root built from the request path that skipped the containment
          // check. Inert today (URL normalizes `..` before we see it, and we
          // never decode the remainder), but /widget/ is on the SHARE
          // visitor's allowlist, so it is the last of the three that should
          // be relying on that.
          const resp = serveStaticUnder(widgetDist, p);
          if (resp) return resp;
        }
        if (
          widgetDist &&
          (pathname === '/widget.js' ||
            pathname === '/widget.iife.js' ||
            pathname === '/widget.esm.js')
        ) {
          const map: Record<string, string> = {
            '/widget.js': 'widget.esm.js',
            '/widget.esm.js': 'widget.esm.js',
            '/widget.iife.js': 'widget.iife.js',
          };
          const file = map[pathname]!;
          const p = join(widgetDist, file);
          const resp = serveStatic(p);
          if (resp) return resp;
        }

        // --- Web app files that must live at the ROOT path ---
        //
        // These are the same bytes served under /app/, aliased up a level
        // because the path they are fetched from is load-bearing rather than
        // cosmetic. A service worker's scope cannot exceed the directory it
        // was served from, so a worker at /app/sw.js could never handle a
        // notification click aimed at /workspaces/… . The manifest and icons
        // ride along because a Home Screen install reads them by absolute
        // path and one place for them is simpler than two.
        //
        // Deliberately NOT added to the share-host allowlist in
        // host-guard.ts: enrolling a workspace visitor's phone for push is a
        // scope decision nobody has made, and the allowlist is
        // closed-by-default precisely so it stays a decision.
        if (markdownAppDist && ROOT_ALIASED_ASSETS.has(pathname) && req.method === 'GET') {
          const resp = serveStaticUnder(markdownAppDist, join(markdownAppDist, pathname.slice(1)));
          if (resp) return resp;
        }

        // --- Workspace hub (plan §3.9/§3.10: /workspaces/:workspaceId) ---
        // The shell is server-rendered (like the landing page) so the route
        // works — and 404s crisply — whether or not the app bundle has been
        // built; the page's behavior all lives in /app/hub.js.
        // Every nav suffix serves the same shell: which destination renders is
        // the client's routing (`navFromPath` in hub-model), so all four are
        // deep-linkable — the board banner's "Go to Home", a phone bookmark
        // and a pasted link all land on the destination, not on the board with
        // a hint.
        //
        // The list must stay in step with `HubNav`, and the cost of it not
        // being is invisible from the client: `setNav` pushes these paths into
        // history, so a suffix missing here costs nothing until somebody
        // RELOADS or shares the URL, at which point they get a 404 on a link
        // the product handed them. That is exactly what `/tasks`, `/mine` and
        // `/activity` did between the nav landing and this line — measured on
        // a staging build, 404 on all three while `/home` answered 200.
        const hubPageMatch = pathname.match(
          /^\/workspaces\/([^/]+?)(?:\/(?:home|tasks|mine|activity))?$/,
        );
        if (hubPageMatch && req.method === 'GET') {
          const workspaceId = decodeURIComponent(hubPageMatch[1] ?? '');
          const workspace = taskStore.getWorkspace(workspaceId);
          if (!workspace) {
            return new Response(renderHubNotFound(workspaceId), {
              status: 404,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            });
          }
          return new Response(
            renderHubShell(workspace.id, workspace.name, {
              feedback: !visitor,
              ...(opts.sentryDsn ? { sentryDsn: opts.sentryDsn } : {}),
            }),
            { headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        }

        /**
         * --- Resources under the workspace they belong to ---
         *
         * `/workspaces/<workspaceId>/docs/<docId>`,
         * `/workspaces/<workspaceId>/mockups/<docId>`,
         * `/workspaces/<workspaceId>/reviews/<reviewId>`.
         *
         * The workspace segment is CONTEXT, not authorization. It tells the
         * page (and the reader) which workspace they are in, and it is what
         * the back arrow and the sidebar build their links from. It is
         * deliberately not checked against the doc's own filing: a doc moved
         * between workspaces would otherwise 404 every link already handed
         * out, and the check that does matter — is this visitor allowed to
         * see this resource — belongs to the share guard, which checks the
         * workspace AND the resource and is the only thing that should.
         */
        const wsResourceMatch = pathname.match(
          /^\/workspaces\/([^/]+)\/(docs|mockups|reviews)\/([^/]+)$/,
        );
        if (wsResourceMatch && req.method === 'GET') {
          const wsSeg = decodeURIComponent(wsResourceMatch[1] ?? '');
          const kind = wsResourceMatch[2] ?? '';
          const id = decodeURIComponent(wsResourceMatch[3] ?? '');
          if (kind === 'reviews') {
            // A review is a set of docs, not a page. Send the reader to the
            // member worth opening first — the same entry `create_diff_review`
            // picks, so the URL and the tool agree on where a review starts.
            const entry = reviewEntryDocId(id);
            if (!entry) {
              return new Response(renderReviewNotFound(id), {
                status: 404,
                headers: { 'content-type': 'text/html; charset=utf-8' },
              });
            }
            return redirectTo(
              `/workspaces/${encodeURIComponent(wsSeg)}/docs/${encodeURIComponent(entry)}`,
              url.search,
            );
          }
          if (!isValidDocId(id)) return j(400, { error: 'bad docId' });
          const canonical = rooms.get(id)?.docId ?? id;
          if (kind === 'mockups') return serveMockup(canonical);
          if (isMockupDoc(canonical)) {
            return redirectTo(
              `/workspaces/${encodeURIComponent(wsSeg)}/mockups/${encodeURIComponent(canonical)}`,
              url.search,
            );
          }
          const served = serveDocShell(canonical, url);
          if (served) return served;
        }

        // --- Markdown app (surface 1) ---
        //
        // COMPAT. `/review/<docId>` is where every doc used to live, and it
        // still answers — it redirects to the workspace path when the doc's
        // workspace can be resolved, and serves in place when it cannot. See
        // the compat block note above `resolveWorkspaceForDoc`.
        if (pathname.startsWith('/review/')) {
          const addressed = decodeURIComponent(pathname.slice('/review/'.length));
          if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
          // A captured review URL carries whatever id it was copied with: a
          // pre-migration doc's own id, or the readable alias of one minted
          // since. Both land on the same doc, and the redirect below rewrites
          // either into the canonical address.
          const docId = rooms.get(addressed)?.docId ?? addressed;
          // A mockup has no editor, so the doc route is the wrong destination
          // for one — see `isMockupDoc`. Hand it to the mockup route's own
          // resolution, which is the behaviour `/mockup/<docId>` already has.
          if (isMockupDoc(docId)) {
            const mockHome = addressableWorkspaceFor(docId, visitor);
            if (mockHome) {
              return redirectTo(
                `/workspaces/${encodeURIComponent(mockHome)}/mockups/${encodeURIComponent(docId)}`,
                url.search,
              );
            }
            return serveMockup(docId);
          }
          // The redirect is deliberately OUTSIDE the `markdownAppDist` guard
          // that wraps the serve below. Where a doc lives is a fact about
          // addressing; whether the browser app has been built is a fact
          // about this deployment. Tying the two together would make an old
          // URL 404 on a server that simply has no app bundle, which is a
          // different failure wearing the same status code.
          if (rooms.get(docId)) {
            const home = addressableWorkspaceFor(docId, visitor);
            if (home) {
              return redirectTo(
                `/workspaces/${encodeURIComponent(home)}/docs/${encodeURIComponent(docId)}`,
                url.search,
              );
            }
          }
          const served = serveDocShell(docId, url);
          if (served) return served;
        }
        if (markdownAppDist && pathname.startsWith('/app/')) {
          const p = join(markdownAppDist, pathname.slice('/app/'.length));
          const resp = serveStaticUnder(markdownAppDist, p);
          if (resp) return resp;
        }

        // --- Mockup HTML — bound to a docId via bind_mock / POST /api/docs
        //     with type='mockup'. Reads the file at the room's sourceUrl
        //     (any absolute path on disk) and streams it as text/html. The
        //     pre-bind_mock workflow required symlinking each new HTML
        //     into <plugin-repo>/demos/ — `/mockup/<docId>` replaces that
        //     dance and matches the contract of `/review/<docId>` for
        //     markdown docs: one MCP call, one URL, no filesystem juggling.
        //     Single-file mockups only — assets the HTML references via
        //     relative paths won't resolve since we don't serve the source
        //     directory. Use the existing /demos/ multi-page path for
        //     mockups that ship with sibling files.
        //     COMPAT, same rule as `/review/`: redirect to the workspace path
        //     when the mockup's workspace resolves, serve in place when it
        //     does not.
        if (pathname.startsWith('/mockup/')) {
          const slug = decodeURIComponent(pathname.slice('/mockup/'.length));
          // Tolerate `/mockup/<docId>.html` AND `/mockup/<docId>` — agents
          // share whichever URL feels natural.
          const addressed = slug.replace(/\.html?$/i, '');
          if (!isValidDocId(addressed)) return j(400, { error: 'bad docId' });
          const docId = rooms.get(addressed)?.docId ?? addressed;
          const home = rooms.get(docId) ? addressableWorkspaceFor(docId, visitor) : null;
          if (home) {
            return redirectTo(
              `/workspaces/${encodeURIComponent(home)}/mockups/${encodeURIComponent(docId)}`,
              url.search,
            );
          }
          return serveMockup(docId);
        }

        // --- Demos ---
        if (demosDir && pathname.startsWith('/demos/')) {
          let p = join(demosDir, pathname.slice('/demos/'.length));
          if (!extname(p)) p = join(p, 'index.html');
          const resp = serveStaticUnder(demosDir, p);
          if (resp) return resp;
        }

        // --- Landing ---
        if (pathname === '/') {
          const model = buildLandingModel(
            collectLandingWorkspaces(rooms, taskStore, (ws) =>
              homeQueueTotal(ws, reviewItemsFor(ws)),
            ),
            collectLandingProjects(rooms),
            Date.now(),
          );
          return new Response(renderLanding(model), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        // --- One project's artifacts, on demand ---
        // The landing page deliberately does not carry these. Work here is
        // proportional to the project somebody actually opened, not to every
        // room on the server.
        if (pathname.startsWith('/projects/')) {
          let owner: string;
          try {
            owner = decodeURIComponent(pathname.slice('/projects/'.length));
          } catch {
            return new Response('bad project', { status: 400 });
          }
          if (owner === '') return new Response('not found', { status: 404 });
          const artifacts = buildProjectArtifacts(rooms, withReviewUrl, owner);
          return new Response(renderProjectPage(owner, artifacts), {
            status: artifacts.length === 0 ? 404 : 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }

        return new Response('not found', { status: 404 });
      }
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === 'audio') {
          meetingRelay.onOpen(ws);
          return;
        }
        const typed = ws as unknown as FeedbackWs;
        const room = rooms.get(typed.data.docId);
        if (!room) {
          ws.close(1008, 'no room');
          return;
        }
        onOpen(room, typed);
      },
      message(ws, message) {
        if (ws.data.kind === 'audio') {
          if (typeof message === 'string') {
            meetingRelay.onText(ws, message);
            return;
          }
          const buf = message as unknown as ArrayBufferView;
          // COPIED, unlike the yjs path below: audio can be held in the
          // relay's pending queue across the handshake, and Bun is free to
          // reuse the receive buffer the moment this returns.
          meetingRelay.onAudio(
            ws,
            new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
          );
          return;
        }
        const typed = ws as unknown as FeedbackWs;
        const room = rooms.get(typed.data.docId);
        if (!room) return;
        let data: Uint8Array;
        if (typeof message === 'string') {
          data = new TextEncoder().encode(message);
        } else {
          // Bun's Buffer extends Uint8Array; copy to plain Uint8Array for y-protocols
          const buf = message as unknown as ArrayBufferView;
          data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        onMessage(room, typed, data);
      },
      close(ws) {
        if (ws.data.kind === 'audio') {
          meetingRelay.onClose(ws);
          return;
        }
        onClose(ws as unknown as FeedbackWs);
      },
    },
  });

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
   * on a markdown review doc, not a task. A version of this that answered
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
    const meta = rooms.get(docId)?.meta;
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
    rooms.closeSocketsForDeadShares(isLive);
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
      const posted = await rooms.postComment(
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
    rooms,
    tasks: taskStore,
    projection: taskProjection,
    agentWatches,
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
      uptimeMonitor.stop();
      // Close the books on any live meeting, so a restart never finds a doc
      // marked as recording by a socket that died with the process.
      meetingRelay.dispose();
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
      rooms.flush();
      // Hand the next process each channel's final event id. Without it every
      // subscriber's cursor is unrecognisable after the restart and every
      // stream opens with a `replay.gap` that has nothing behind it.
      saveReplayMarks(dataDir, sse.marks());
      server.stop();
    },
  };
}

function isValidDocId(s: string): boolean {
  // Allow a reasonable set of URL-safe chars. Disallow leading dot so IDs
  // can't masquerade as hidden files on disk. Length cap protects the
  // filename from being pathological. `~` is permitted because workspace
  // member docIds encode the relPath's `/` separators as `~`
  // (`${workspaceId}:${relPath.replaceAll('/', '~')}` in rooms.ts), so any
  // file in a subdirectory of a bound folder needs `~` to be reachable via
  // the /api/docs/:docId routes. `~` is RFC 3986 unreserved (URL-safe) and a
  // valid filename char, matching the .ydoc-on-disk naming.
  if (!s || s.startsWith('.')) return false;
  return /^[a-zA-Z0-9_.:~\-]{1,100}$/.test(s);
}

/** `scheme://host` with the default port normalized away, or the raw
 *  concatenation when it doesn't parse (which then simply matches nothing). */
/** The id a reconnecting SSE client last saw: the `Last-Event-ID` header a
 *  native EventSource sends back by itself once frames carry `id:` lines,
 *  else the `lastEventId` query param for hand-rolled fetch-stream consumers
 *  (the MCP watch loop). Absent/empty → a fresh subscription, no replay. */
function sseLastEventId(req: Request, url: URL): string | undefined {
  const v = req.headers.get('last-event-id') ?? url.searchParams.get('lastEventId');
  return v ? v : undefined;
}

function canonicalOrigin(scheme: string, host: string): string {
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return `${scheme}://${host}`;
  }
}

function j(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    // CORS is added by the per-request wrapper in createServer, which knows
    // the Origin. This used to stamp a wildcard `*` origin on every reply.
    headers: { 'content-type': 'application/json' },
  });
}

/** Attach the doc's pending syncError (if any) to a successful edit-tool
 *  response. Agents read edit results, not get_doc — so this is the surface
 *  where a disk↔doc conflict actually reaches whoever can fix it. */
function withSyncError(rooms: Rooms, docId: string, body: object): object {
  const syncError = rooms.getSyncError(docId);
  return syncError ? { ...body, syncError } : body;
}

/** Sentinel for a `placement` body value that is present but not one of the
 *  two known values — the route answers 400 rather than silently splicing at
 *  the default position (an insert in the wrong place is a structure edit
 *  the caller then has to hunt down and undo). */
const PLACEMENT_INVALID = Symbol('placement-invalid');

/** Parse an insert_blocks body's optional `placement`. Absent → undefined
 *  (core defaults to 'after-block', the historical behavior). */
function parsePlacement(
  value: unknown,
): 'after-block' | 'top-level' | undefined | typeof PLACEMENT_INVALID {
  if (value === undefined || value === null) return undefined;
  if (value === 'after-block' || value === 'top-level') return value;
  return PLACEMENT_INVALID;
}

/** Parse a `suggest: true` request body's `author` field into a
 *  SuggestionAuthor. Requires `id` + `name`; `color` defaults so a caller
 *  that omits it (unlikely — MCP always sends the full identity) still
 *  produces an attributable proposal instead of a 400. */
function parseSuggestionAuthor(
  body: Record<string, unknown> | null,
): suggestOps.SuggestionAuthor | null {
  const a = body?.author as { id?: unknown; name?: unknown; color?: unknown } | undefined;
  if (!a || typeof a.id !== 'string' || a.id.length === 0) return null;
  if (typeof a.name !== 'string' || a.name.length === 0) return null;
  return { id: a.id, name: a.name, color: typeof a.color === 'string' ? a.color : '#888888' };
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

/**
 * Serve a file only if it really sits under `root`.
 *
 * `/app/*` and `/demos/*` build their path out of the request URL. Today
 * that is safe by accident rather than by design — `new URL()` collapses
 * `..` segments before we ever see the pathname — but nothing in this file
 * says so, and one future caller that decodes or rewrites a path would turn
 * a static route into an arbitrary-file read on a host that is now publicly
 * reachable. Assert the containment where the read happens.
 */
export function serveStaticUnder(root: string, p: string): Response | null {
  // isWithinRoot realpaths both sides: `path.resolve` is purely LEXICAL, so a
  // symlink inside the root pointing anywhere on disk sails straight through a
  // string-prefix check. `demos/` in particular is a directory of Bryan's own
  // files, where a convenience symlink is entirely plausible. It answers
  // closed for a missing file or a dangling link — nothing to serve either way.
  if (!isWithinRoot(root, p)) return null;
  return serveStatic(p);
}

function serveStatic(p: string): Response | null {
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  const ct = CT[extname(p).toLowerCase()] ?? 'application/octet-stream';
  return new Response(buf, {
    headers: {
      'content-type': ct,
      // `no-cache` is kept: this fleet redeploys often and a browser quietly
      // running last week's bundle is the worse failure. What it means is
      // "revalidate before use", NOT "do not store" — but a revalidation needs
      // a validator, and there was none here, so the only answer the server
      // could give was the whole file again. Every board load re-sent every
      // byte of its CSS, its app bundle and the widget. The etag below is what
      // turns that into a 304.
      'cache-control': 'no-cache',
      // Hashed from the CONTENT rather than from mtime+size. A redeploy writes
      // these files fresh, so mtime moves on every deploy whether or not the
      // bytes did — which would throw away the cache precisely when nothing
      // changed. Content-derived, an unchanged bundle keeps its tag across
      // deploys and a changed one cannot keep it. Bun's hash is not
      // cryptographic and does not need to be: this answers "same bytes?",
      // and nothing downstream trusts it for anything else.
      etag: `"${Bun.hash(buf).toString(16)}"`,
    },
  });
}

function renderMockupNotFound(docId: string): string {
  const safe = escape(docId);
  return `<!doctype html><meta charset="utf-8"><title>Mockup not found · Workspaces</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Mockup not found</h1>
<p>No mockup is bound to <code>${safe}</code>, or its source file isn't readable.
Mockups are bound by an agent calling <code>bind_mock</code> with an absolute path
to an HTML file. Once bound, the file is served here without any symlink dance.</p>
<p>Ask the agent who shared this URL to call <code>bind_mock(docId, sourceHtmlPath)</code>, then refresh.</p>`;
}

/**
 * Shown when a share link doesn't resolve. Says nothing about WHY — unknown,
 * expired, and malformed all render the same page, so the endpoint can't be
 * used to probe which slugs exist.
 */
function renderLinkNotFound(): string {
  return `<!doctype html><meta charset="utf-8"><title>Link not available · Workspaces</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#222}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#555;margin:0}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}</style>
<h1>This link isn't available</h1>
<p>It may have expired or been revoked. Ask whoever shared it for a new one.</p>`;
}

/**
 * The hub page shell (§3.9). Tab title is `<workspace> · Workspaces` — the
 * browser tab is a workspace switcher, so the WORKSPACE leads and the product
 * name trails, where truncation can take it. (`hub-app.ts` extends the same
 * title with the open pane once the bundle runs.) Everything dynamic renders
 * client-side from the ws:<id> ydoc projection + REST; the shell only names
 * the workspace and loads the bundle.
 *
 * `feedback` embeds the comment widget, pointed at ONE well-known doc
 * (`HUB_FEEDBACK_DOC_ID`) rather than at a per-workspace one — feedback about
 * the hub UI is about the product, not about the workspace you happened to be
 * standing in, so it should reach the same place from every hub. The widget
 * auto-captures `location` as the anchor url, so the comment already says
 * which hub it came from; `view` adds the workspace NAME so the thread reads
 * without anyone resolving an id.
 *
 * `identity-scope="host"` is what makes the feedback ATTRIBUTED. The widget
 * normally keeps its identity under a `cfw:` prefix so it cannot touch a
 * third-party host page's storage — but this page is ours, and the hub has
 * already asked the reader their name (`ensureUserIdentity`, unprefixed keys).
 * Without this attribute the same page holds two identities for one human: the
 * presence strip greets the reader by the name they gave, while every comment
 * the widget posts from that same page is signed "Anonymous <animal>".
 * Observed in a browser on 2026-08-17.
 *
 * Declarative `<claude-feedback-widget>` rather than `FeedbackWidget.init` on
 * purpose: a module script is deferred, so a plain inline script calling
 * `init` would run before the module that defines it. The element upgrades on
 * parse and reads its own attributes.
 */
function renderHubShell(
  workspaceId: string,
  name: string,
  opts: { feedback: boolean; sentryDsn?: string } = { feedback: false },
): string {
  const safeName = escape(name);
  const safeId = escape(workspaceId);
  const sentryMeta = opts.sentryDsn
    ? `\n    <meta name="sentry-dsn" content="${escape(opts.sentryDsn)}" />`
    : '';
  // Deliberately NOT rendered for a share visitor. Every peer on a Yjs doc
  // syncs the whole doc, so one shared feedback doc would hand every hub
  // visitor every other workspace's feedback threads — including the hub
  // paths and quoted UI text they were anchored to. Same lesson as the
  // DocMeta sidecar: a field that must not reach a visitor cannot live in a
  // CRDT they sync. Keeping the widget off their page keeps them off the doc.
  const widget = opts.feedback
    ? `
    <script type="module" src="/widget.esm.js"></script>
    <claude-feedback-widget doc-id="${escape(HUB_FEEDBACK_DOC_ID)}" view="${safeName}" identity-scope="host"></claude-feedback-widget>`
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
    <title>${safeName} · Workspaces</title>
    <!-- Two shells, two copies. Kept in step with packages/markdown-app/index.html
         on purpose: an install started from the board and one started from a
         review doc have to produce the same web app, and on iOS the Home
         Screen install is what makes push available at all. -->
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta name="theme-color" content="#2e7dd7" />${sentryMeta}
    <link rel="stylesheet" href="/app/styles.css" />
    <!-- Open Props trial layer — after styles.css on purpose; see
         packages/markdown-app/index.html. -->
    <link rel="stylesheet" href="/app/tokens.css" />
  </head>
  <body class="hub-body">
    <div id="hub-root" data-workspace-id="${safeId}"></div>
    <script type="module" src="/app/hub.js"></script>${widget}
  </body>
</html>`;
}

function renderHubNotFound(workspaceId: string): string {
  const safe = escape(workspaceId);
  return `<!doctype html><meta charset="utf-8"><title>Workspace not found · Workspaces</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Workspace not found</h1>
<p>No hub workspace exists for <code>${safe}</code>. Hub workspaces are
created by an agent calling <code>create_workspace</code> (or
<code>POST /api/workspaces</code> with a name).</p>
<p><small><a href="/">all docs</a></small></p>`;
}

function renderReviewNotFound(docId: string): string {
  const safe = escape(docId);
  return `<!doctype html><meta charset="utf-8"><title>Doc not found · Workspaces</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Doc not found</h1>
<p>No review doc exists for <code>${safe}</code>. Markdown review docs are
created by an agent calling <code>POST /api/docs</code> with a
<code>sourceUrl</code> pointing at a markdown file on disk.</p>
<p>Ask the agent who shared this URL to create the doc, then refresh this page.</p>
<p><small><a href="/">all docs</a></small></p>`;
}

// --- Landing page: active workspaces; per-project artifact pages on demand ---
//
// `/` is a list of active workspaces to open up — see the header of
// `landing.ts` for what that sentence is quoting and what it deliberately
// leaves out. The project → artifacts model below serves `/projects/<owner>`,
// the on-demand index of review docs. It groups by PROJECT (the creating
// agent's cwd = doc.owner; 'ungrouped' when absent), and within a project
// lists ARTIFACTS. An artifact is one of:
//   - a workspace (bound folder/worktree; docs sharing a workspaceId) →
//     one expandable row with a rolled-up open-count badge and a nested file
//     list, each file linking to its reviewUrl
//   - a single markdown file, a code file, a mockup, or a dev server
// Each artifact carries its open-comment count and a kind glyph/label.

type ArtifactKind = 'workspace' | 'markdown' | 'code' | 'diff' | 'mockup';

interface LandingFile {
  name: string;
  reviewUrl?: string;
  openCount: number;
}

interface LandingArtifact {
  kind: ArtifactKind;
  /** Display name (file basename, workspace title, or docId fallback). */
  name: string;
  /** docId for standalone artifacts; workspaceId for workspaces. */
  id: string;
  reviewUrl?: string;
  openCount: number;
  threadCount: number;
  lastActivity: number;
  /** Nested file list (workspace artifacts only). */
  files?: LandingFile[];
}

// Glyph + human label per artifact kind. The glyph keeps the kinds visually
// distinct at a glance; the label disambiguates for screen readers / clarity.
const ARTIFACT_KIND: Record<ArtifactKind, { glyph: string; label: string }> = {
  workspace: { glyph: '📁', label: 'folder' },
  markdown: { glyph: '📄', label: 'markdown' },
  code: { glyph: '⟨⟩', label: 'code' },
  diff: { glyph: '±', label: 'diff' },
  mockup: { glyph: '🖼', label: 'mockup' },
};

function flattenTreeFileNodes(node: WorkspaceDirNode | WorkspaceFileNode): WorkspaceFileNode[] {
  if (node.type === 'file') return [node];
  return node.children.flatMap(flattenTreeFileNodes);
}

/** Flatten a workspace tree into a sorted file list for the landing nesting. */
function flattenWorkspaceFiles(node: WorkspaceDirNode | WorkspaceFileNode): LandingFile[] {
  if (node.type === 'file') {
    return [{ name: node.relPath, reviewUrl: node.reviewUrl, openCount: node.openCount }];
  }
  return node.children.flatMap(flattenWorkspaceFiles);
}

/**
 * The `/` model's inputs, computed from the live stores.
 *
 * `lastActivity` is the newest REAL event on the board: a task mutation
 * (`task.updatedAt` — bumped by every transition, assignment, evidence and
 * body rewrite), a comment on a task's discussion (`thread.lastActivity` on
 * the `task:<id>` room), or the board's creation. Deliberately
 * NOT `meta.lastActivityAt`, which is the `.ydoc` mtime wearing an activity
 * label — see rule 1 in the header of `landing.ts`.
 */
function collectLandingWorkspaces(
  rooms: Rooms,
  taskStore: TaskStore,
  // The landing route passes Home's own counter here (`reviewItemsFor` +
  // `homeQueueTotal`, both closure-bound in createServer), so the chip and
  // the queue it opens are one computation, not two that can drift.
  waitingOf?: (ws: HubWorkspace) => number,
): LandingWorkspaceInput[] {
  return taskStore.listWorkspaces().map((ws) => {
    let last = ws.createdAt;
    // Archived rows included: archiving IS activity on this board, and a
    // reading that dropped the row afterwards would step the timestamp
    // backwards the moment somebody tidied up.
    for (const task of taskStore.listTasks(ws.id, { includeArchived: true })) {
      if (task.updatedAt > last) last = task.updatedAt;
      for (const thread of rooms.listThreads(`task:${task.id}`)) {
        if (thread.lastActivity > last) last = thread.lastActivity;
      }
    }
    // A retired board contributes NO review items to this page — no chip on
    // its row, nothing into the bar or the Review-all chain. Retiring is the
    // owner saying "get this out of my way", and every one of those surfaces
    // steering the reader back in contradicts the act. Filtered here at the
    // source, not in the renderer: the count is simply never computed, so no
    // later consumer of this model can reintroduce it. Un-retiring brings
    // the items straight back — nothing about them was touched.
    const waiting = !isRetired(ws) && waitingOf ? waitingOf(ws) : 0;
    return {
      id: ws.id,
      name: ws.name,
      lastActivity: last,
      ...(isRetired(ws) ? { retired: true } : {}),
      ...(waiting > 0 ? { waiting } : {}),
    };
  });
}

/** Every project owner that has at least one review doc — the links behind
 *  the review-docs fold. Names only; the artifacts stay on the project page. */
function collectLandingProjects(rooms: Rooms): Array<{ owner: string; label: string }> {
  const owners = new Set<string>();
  for (const meta of rooms.list()) {
    // Infrastructure, not review content: the shared hub-feedback doc exists
    // on every install from startup, and `ws:`/`task:` rooms are surfaces the
    // server owns for the boards the page already lists.
    if (meta.docId === HUB_FEEDBACK_DOC_ID) continue;
    if (meta.docId.startsWith('ws:') || meta.docId.startsWith('task:')) continue;
    owners.add(meta.owner || 'ungrouped');
  }
  return Array.from(owners, (owner) => ({ owner, label: projectLabel(owner) }));
}

/**
 * One project's artifacts, built only when somebody opens that project.
 *
 * This is the old whole-server index, narrowed to a single owner: the same
 * rollup of workspace members into one expandable row, the same per-artifact
 * open counts. What changed is WHEN it runs — `buildWorkspaceTree` per
 * workspace and a nested file list per artifact was the bulk of both the 910
 * KB and the per-request work on a page that mostly nobody scrolled.
 */
function buildProjectArtifacts(
  rooms: Rooms,
  decorate: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ) => T & { reviewUrl?: string },
  owner: string,
): LandingArtifact[] {
  const workspaceArtifacts = new Map<string, LandingArtifact>();
  const artifacts: LandingArtifact[] = [];

  for (const meta of rooms.list()) {
    if (meta.docId === HUB_FEEDBACK_DOC_ID) continue;
    if (meta.docId.startsWith('ws:') || meta.docId.startsWith('task:')) continue;
    if ((meta.owner || 'ungrouped') !== owner) continue;

    const threads = rooms.listThreads(meta.docId);
    const openCount = threads.filter((t) => t.status === 'open').length;
    // Thread activity, never `meta.lastActivityAt` — see the header note in
    // landing.ts. That field is the `.ydoc` mtime and a snapshot rewrite
    // refreshes it, so it ranks by persistence noise.
    const lastActivity = threads.reduce((max, t) => Math.max(max, t.lastActivity), 0);

    if (meta.workspaceId) {
      let art = workspaceArtifacts.get(meta.workspaceId);
      if (!art) {
        const tree = rooms.buildWorkspaceTree(meta.workspaceId);
        const files = flattenWorkspaceFiles(tree.tree);
        // Clicking the workspace opens its entry file directly (the biggest
        // change for a diff review, first file otherwise); expansion is a
        // separate affordance in the renderer.
        const treeFiles = flattenTreeFileNodes(tree.tree);
        const entry = treeFiles.reduce(
          (best, f) =>
            (f.diffAdditions ?? 0) + (f.diffDeletions ?? 0) >
            (best?.diffAdditions ?? 0) + (best?.diffDeletions ?? 0)
              ? f
              : best,
          treeFiles[0],
        );
        art = {
          kind: 'workspace',
          name: meta.workspaceId,
          id: meta.workspaceId,
          reviewUrl: entry?.reviewUrl,
          openCount: tree.totalOpen,
          threadCount: 0,
          lastActivity: 0,
          files,
        };
        workspaceArtifacts.set(meta.workspaceId, art);
        artifacts.push(art);
      }
      // A diff member marks the whole workspace as a diff review (members can
      // also include plain 'code' context docs — any diff doc wins).
      if (meta.type === 'diff') art.kind = 'diff';
      art.threadCount += threads.length;
      if (lastActivity > art.lastActivity) art.lastActivity = lastActivity;
      continue;
    }

    const decorated = decorate(meta);
    artifacts.push({
      kind: (meta.type as ArtifactKind) ?? 'markdown',
      name: meta.sourceUrl ? basenameOf(meta.sourceUrl) : meta.title || meta.docId,
      id: meta.docId,
      reviewUrl: decorated.reviewUrl,
      openCount,
      threadCount: threads.length,
      lastActivity,
    });
  }

  artifacts.sort((a, b) => {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
    return a.name.localeCompare(b.name);
  });
  return artifacts;
}

function basenameOf(p: string): string {
  let s = p;
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {}
  const m = s.match(/[^/\\]+$/);
  return m ? m[0] : s;
}

/** Display label for a project owner (cwd) — its basename, or the raw key. */
function projectLabel(owner: string): string {
  if (owner === 'ungrouped') return 'Ungrouped';
  return basenameOf(owner) || owner;
}

function renderLandingFile(f: LandingFile): string {
  const link = f.reviewUrl
    ? `<a href="${escape(f.reviewUrl)}">${escape(f.name)}</a>`
    : escape(f.name);
  const badge = f.openCount > 0 ? `<span class="badge badge-open">${f.openCount} open</span>` : '';
  return `<li class="ws-file"><span class="ws-file-name">${link}</span>${badge}</li>`;
}

function renderLandingArtifact(a: LandingArtifact): string {
  const kind = ARTIFACT_KIND[a.kind];
  const openBadge =
    a.openCount > 0
      ? `<span class="badge badge-open">${a.openCount} open</span>`
      : a.threadCount > 0
        ? `<span class="badge badge-resolved">all resolved</span>`
        : '';
  const kindBadge = `<span class="badge badge-kind">${kind.glyph} ${escape(kind.label)}</span>`;
  const activityLine =
    a.lastActivity > 0
      ? `<div class="meta">last activity ${escape(formatRelative(a.lastActivity))}</div>`
      : '';

  if (a.files) {
    const fileCount = a.files.length;
    const files = a.files.map(renderLandingFile).join('');
    const nameLink = a.reviewUrl
      ? `<a href="${escape(a.reviewUrl)}">${escape(a.name)}</a>`
      : escape(a.name);
    // Clicking the NAME opens the review's entry file; the caret + file
    // count is the (separate) expansion affordance for the nested list.
    return `<li class="artifact ${a.openCount > 0 ? 'has-open' : ''}">
      <div class="row">
        <span class="art-glyph">${kind.glyph}</span>
        <span class="art-name">${nameLink}</span>
        <span class="badges">${openBadge}<span class="badge badge-kind">${escape(kind.label)}</span></span>
      </div>
      <details class="ws-details">
        <summary><span class="art-sub">${fileCount} file${fileCount === 1 ? '' : 's'}</span></summary>
        <ul class="ws-files">${files || '<li class="ws-file empty">(no files)</li>'}</ul>
      </details>
      ${activityLine}
    </li>`;
  }

  const link = a.reviewUrl
    ? `<a href="${escape(a.reviewUrl)}">${escape(a.name)}</a>`
    : escape(a.name);
  return `<li class="artifact ${a.openCount > 0 ? 'has-open' : ''}">
    <div class="row">
      <span class="art-glyph">${kind.glyph}</span>
      <span class="art-name">${link}</span>
      <span class="badges">${openBadge}${kindBadge}</span>
    </div>
    ${activityLine}
  </li>`;
}

/**
 * Shared chrome for the two server-rendered pages (`/` and `/projects/<owner>`).
 *
 * Mobile is load-bearing here — this is the page Bryan lands on from his
 * phone. Every rule is authored for a 430px viewport first: single column, no
 * fixed widths, and `min-width: 0` on every flex child that holds prose, which
 * is the flex twin of the `minmax(0, 1fr)` grid footgun in
 * docs/product/design-mobile.md. Nothing here reaches into styles.css: the
 * landing page is server-rendered and owns its own styles, so the client
 * bundle's cascade cannot move it.
 */
const LANDING_CSS = `
*{box-sizing:border-box}
body{font:15px/1.55 system-ui,-apple-system,sans-serif;margin:0 auto;max-width:760px;padding:20px 14px 40px;color:#1b1f23;overflow-wrap:anywhere}
h1{font-size:20px;margin:0 0 2px}
h2{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#57606a;margin:26px 0 8px;display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}
.count{font-size:11px;font-weight:500;letter-spacing:0;text-transform:none;color:#8b95a1}
.summary{color:#6e7781;font-size:12px;margin:0 0 4px}
ul{padding:0;list-style:none;margin:0}
a{color:#2e7dd7;text-decoration:none}
a:hover{text-decoration:underline}
.grp{border-bottom:1px solid #f0f2f4}
.grp-link{display:block;padding:10px 4px;color:inherit;min-height:44px}
.grp-link:hover{text-decoration:none;background:#f8f9fb}
.grp-row{display:flex;align-items:baseline;gap:8px}
.grp-name{flex:1;min-width:0;font-weight:600;font-size:15px;color:#2e7dd7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grp-meta{color:#8b95a1;font-size:12px;margin-top:2px}
.grp-flex{display:flex;align-items:center;gap:8px}
.grp-flex .grp-link{flex:1;min-width:0}
.needs{flex-shrink:0;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:#bf5b16;background:#fff1e6;border-radius:99px;padding:6px 12px;min-height:32px}
.needs:hover{text-decoration:none;background:#ffe7d1}
.needs .n{background:#e36f1e;color:#fff;border-radius:99px;font-size:11px;min-width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0 5px}
.allbar{display:flex;align-items:center;gap:10px;background:#fff8f2;border:1px solid #f5d9c2;border-radius:10px;padding:10px 14px;margin:10px 0 14px}
.allsum{flex:1;min-width:0;font-size:13px;font-weight:600;color:#8a4a12}
.allgo{flex-shrink:0;font-size:13px;font-weight:600;padding:7px 4px}
.badge{font-size:10.5px;padding:1.5px 7px;border-radius:99px;background:#f6f8fa;color:#6e7781;font-weight:500;flex-shrink:0}
.badge-open{background:#fff1e6;color:#bf5b16}
.badge-resolved{background:#e8f5ed;color:#2da44e}
.badge-kind{background:#f6f8fa;color:#8b95a1}
.badges{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
li.artifact{padding:9px 0;border-bottom:1px solid #f3f4f6}
li.artifact.has-open{border-left:3px solid #e36f1e;padding-left:10px;margin-left:-13px}
.row{display:flex;align-items:baseline;gap:8px}
.art-glyph{flex-shrink:0;font-size:13px;width:1.4em;text-align:center}
.art-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 36px minimum tap target (design-mobile.md). An inline link is ~23px tall,
   so every link a thumb aims at gets vertical padding rather than a bigger
   font — this page is read on a phone. */
.art-name a{font-weight:600;display:inline-block;padding:7px 0}
.art-sub{color:#8b95a1;font-size:11px;flex-shrink:0}
.meta{color:#8b95a1;font-size:11px;margin-top:3px;padding-left:1.4em}
details > summary{display:flex;align-items:baseline;gap:8px;cursor:pointer;list-style:none;min-height:36px;align-items:center}
details > summary::-webkit-details-marker{display:none}
details > summary::before{content:'\\25B8';color:#8b95a1;font-size:11px;flex-shrink:0}
details[open] > summary::before{content:'\\25BE'}
/* The landing page's folded sections (inactive workspaces, review docs).
   Styled like the h2s so a fold reads as a section heading you can open —
   quiet on purpose: the page is the active list, the folds are the archive. */
.fold{margin-top:26px}
.fold > summary{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#57606a}
.ws-files{margin:6px 0 0 1.8em;border-left:1px solid #eef0f2;padding-left:10px}
.ws-file{display:flex;align-items:baseline;gap:8px;padding:3px 0}
.ws-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.ws-file-name a{display:inline-block;padding:9px 0}
.ws-file.empty{color:#8b95a1;font-style:italic}
.empty{color:#6e7781;padding:18px 0;font-style:italic;font-size:13px}
.back{font-size:13px;display:inline-block;padding:8px 0;margin-bottom:4px}
footer{margin-top:28px;color:#8b95a1;font-size:11px}
`;

function landingShell(title: string, body: string): string {
  // The manifest belongs here most of all: `/` is the manifest's own
  // `start_url`, so this is the page a Home Screen install lands on and the
  // most likely page somebody installs FROM.
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#2e7dd7">
<style>${LANDING_CSS}</style>
${body}
<footer>POST /api/docs · /widget.iife.js · /demos/mockup</footer>`;
}

function renderLandingWorkspaceRow(w: LandingWorkspaceRow): string {
  // Thread/task activity, never `meta.lastActivityAt` — the collector's
  // header says why. The whole row is the tap target, not the name inside
  // it: an inline text link is ~21px tall, under the 36px floor in
  // docs/product/design-mobile.md, and this is the page Bryan opens on a
  // phone.
  const activity =
    w.lastActivity > 0 ? `active ${formatRelative(w.lastActivity)}` : 'no activity yet';
  // The chip is a SIBLING anchor, not a child — a nested <a> is invalid HTML
  // and browsers split it unpredictably. The row opens Home; the chip opens
  // the same Home with the walkthrough already running (?walk=1), so
  // answering never needs a second tap to find the queue.
  const chip =
    (w.waiting ?? 0) > 0
      ? `<a class="needs" href="${escape(`${w.href}?walk=1`)}"><span class="n">${w.waiting}</span> for you</a>`
      : '';
  return `<li class="grp grp-flex"><a class="grp-link" href="${escape(w.href)}">
    <div class="grp-row"><span class="grp-name">${escape(w.name)}</span></div>
    <div class="grp-meta">${escape(activity)}</div>
  </a>${chip}</li>`;
}

function renderLandingProjectLink(p: LandingProjectLink): string {
  return `<li class="grp"><a class="grp-link" href="${escape(p.href)}">
    <div class="grp-row"><span class="grp-name">${escape(p.label)}</span></div>
  </a></li>`;
}

function renderLanding(model: LandingModel): string {
  const days = Math.round(model.windowMs / 86_400_000);
  // Retired boards are NOT in this denominator. "Nothing active, 3 inactive
  // below" has to mean three rows a reader can go and look at; counting
  // deliberately stood-down boards in it would make the empty state overstate
  // what is still live.
  const total = model.active.length + model.inactive.length;
  // A cut list states what it cut: the empty state names the denominator,
  // and the inactive fold carries its count — "An empty list is a clearance
  // only if you also render the denominator" (docs/process/learnings.md).
  const active =
    model.active.length === 0
      ? total === 0
        ? '<div class="empty">No workspaces yet.</div>'
        : `<div class="empty">Nothing active in the last ${days} days (${total} inactive below).</div>`
      : `<ul>${model.active.map(renderLandingWorkspaceRow).join('')}</ul>`;
  const inactive =
    model.inactive.length === 0
      ? ''
      : `<details class="fold"><summary>Inactive workspaces <span class="count">${model.inactive.length}</span></summary>
<ul>${model.inactive.map(renderLandingWorkspaceRow).join('')}</ul></details>`;
  // Folded, not hidden — a retired board is still readable, which is the
  // whole difference between retiring one and deleting it. The count is the
  // denominator the empty state above deliberately leaves out.
  const retired =
    model.retired.length === 0
      ? ''
      : `<details class="fold"><summary>Retired workspaces <span class="count">${model.retired.length}</span></summary>
<ul>${model.retired.map(renderLandingWorkspaceRow).join('')}</ul></details>`;
  // The review-doc index stays reachable — one fold of per-project links,
  // not a browser. The "hundreds of bound review items" live behind
  // /projects/<owner>, fetched only when somebody opens one.
  const projects =
    model.projects.length === 0
      ? ''
      : `<details class="fold"><summary>Review docs by project <span class="count">${model.projects.length}</span></summary>
<ul>${model.projects.map(renderLandingProjectLink).join('')}</ul></details>`;
  // Every row with a waiting count, page order (active first, then the
  // quiet fold — an item on a quiet board still waits). The bar totals them
  // and "Review all" starts the walkthrough in the most recently active one,
  // handing the rest over via ?then= so the client chains the queues
  // without coming back here between boards. Retired boards are OUT — the
  // collector never computes a waiting count for one, so they can carry no
  // chip, no share of the total, and no place in the chain; this filter is
  // the belt to that suspender.
  const waitingRows = [...model.active, ...model.inactive].filter((w) => (w.waiting ?? 0) > 0);
  const waitingTotal = waitingRows.reduce((sum, w) => sum + (w.waiting ?? 0), 0);
  const firstWaiting = waitingRows[0];
  const allHref = firstWaiting
    ? `${firstWaiting.href}?walk=1${
        waitingRows.length > 1
          ? `&then=${waitingRows
              .slice(1)
              .map((w) => encodeURIComponent(w.id))
              .join(',')}`
          : ''
      }`
    : '';
  const allbar = firstWaiting
    ? `<div class="allbar"><span class="allsum">${waitingTotal} waiting on you${
        waitingRows.length > 1 ? ` across ${waitingRows.length} workspaces` : ''
      }</span><a class="allgo" href="${escape(allHref)}">Review all ›</a></div>`
    : '';
  return landingShell(
    'Workspaces',
    `<h1>Workspaces</h1>
<div class="summary">Active in the last ${days} days, most recent first</div>
${allbar}
${active}
${inactive}
${retired}
${projects}`,
  );
}

/** The "artifacts on demand" half: one project's contents, fetched only when
 *  somebody asks for that project. Keeping this off `/` is what took the
 *  landing response from ~910 KB to a few KB — the nested per-file lists were
 *  most of the bytes and none of the reason anyone opened the page. */
function renderProjectPage(owner: string, artifacts: LandingArtifact[]): string {
  const body =
    artifacts.length === 0
      ? '<div class="empty">No artifacts in this project.</div>'
      : `<ul>${artifacts.map(renderLandingArtifact).join('')}</ul>`;
  const open = artifacts.reduce((sum, a) => sum + a.openCount, 0);
  return landingShell(
    `${projectLabel(owner)} · Workspaces`,
    `<a class="back" href="/">← all workspaces</a>
<h1>${escape(projectLabel(owner))}</h1>
<div class="summary">${escape(owner)}</div>
<div class="summary">${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} · ${open} open thread${open === 1 ? '' : 's'}</div>
${body}`,
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Viewport presets for ?mobile=<preset>. CSS px sizes (logical).
const DEVICE_PRESETS: Record<string, { w: number; h: number; label: string }> = {
  iphone16pm: { w: 440, h: 956, label: 'iPhone 16 Pro Max' },
  iphone16: { w: 393, h: 852, label: 'iPhone 16' },
  iphone15: { w: 393, h: 852, label: 'iPhone 15' },
  iphonese: { w: 375, h: 667, label: 'iPhone SE' },
  pixel8: { w: 412, h: 915, label: 'Pixel 8' },
};

function renderDeviceFrame(presetName: string, url: URL): string {
  const preset = DEVICE_PRESETS[presetName] ?? DEVICE_PRESETS.iphone16pm!;
  // Build the inner URL with the mobile param stripped to avoid recursion
  const innerParams = new URLSearchParams(url.searchParams);
  innerParams.delete('mobile');
  const innerQs = innerParams.toString();
  const innerUrl = `${url.pathname}${innerQs ? `?${innerQs}` : ''}`;
  const asParam = url.searchParams.get('as') ?? 'bryan';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escape(preset.label)} · ${escape(url.pathname)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1e2228; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #eee; }
  body { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 8px; box-sizing: border-box; overflow: auto; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #cfd3d9; }
  .bar .label { background: rgba(0,0,0,0.5); padding: 3px 9px; border-radius: 99px; }
  .bar a { color: #8fbfff; text-decoration: none; background: rgba(0,0,0,0.5); padding: 3px 9px; border-radius: 99px; }
  .bar a:hover { background: rgba(0,0,0,0.75); }
  .bar a.current { background: #8fbfff; color: #1e2228; }
  .device {
    width: ${preset.w}px;
    height: ${preset.h}px;
    background: #fff;
    border: 1px solid #3a3e45;
    border-radius: 18px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.45);
    overflow: hidden;
    flex: 0 0 auto;
  }
  .device iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #fff;
  }
</style>
</head><body>
<div class="bar">
  <span class="label">${escape(preset.label)} · ${preset.w}×${preset.h}</span>
  <a href="?as=${escape(asParam)}">← exit</a>
  <a class="${presetName === 'iphone16pm' ? 'current' : ''}" href="?mobile=iphone16pm&as=${escape(asParam)}">16 Pro Max</a>
  <a class="${presetName === 'iphone16' ? 'current' : ''}" href="?mobile=iphone16&as=${escape(asParam)}">16</a>
  <a class="${presetName === 'iphonese' ? 'current' : ''}" href="?mobile=iphonese&as=${escape(asParam)}">SE</a>
  <a class="${presetName === 'pixel8' ? 'current' : ''}" href="?mobile=pixel8&as=${escape(asParam)}">Pixel 8</a>
</div>
<div class="device"><iframe src="${escape(innerUrl)}" allow="clipboard-write"></iframe></div>
</body></html>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c] ?? c;
  });
}
