import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import {
  type DocMeta,
  type DocType,
  type Thread,
  type User,
  type WebhookPayload,
  agentIdForName,
  contentKind,
  isEmailLike,
  normalizeEmail,
  reviewIdOf,
  reviewItemState,
} from '@feedback/core';
import type { Server as BunServer } from 'bun';
import { createAccessDeps } from './access-deps.ts';
import { releaseActivityLock } from './activity-lock.ts';
import { AgentNoteRing } from './agent-notes.ts';
import {
  AgentWatches,
  SHARED_AGENT_IDS,
  SHARED_IDENTITY_ERROR,
  SHARED_IDENTITY_MESSAGE,
  isValidAgentId,
} from './agent-watches.ts';
import { AllowRuleProposals } from './allow-rules.ts';
import { ARTIFACT_CHECK_ACTOR, ArtifactChecker } from './artifact-check.ts';
import type { CodeSender } from './auth/code-sender.ts';
import { type BrowserSentryConfig, type PageType, injectSentryHead } from './browser-sentry.ts';
import { ChatAudit, isSharedAgentName, localDay } from './chat-audit.ts';
import { maybeCompress, maybeNotModified } from './compress.ts';
import type { Deployer } from './deploy.ts';
import { DispatchRegistry, type WatchFactory } from './dispatch-registry.ts';
import { type EffortEstimator } from './effort-estimator.ts';
import { createEffortScoring } from './effort-scoring.ts';
import { type GoogleOauthApp, type RefreshTokenVault } from './google-oauth.ts';
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
import { spokenReviewComment } from './huddle.ts';
import { Identities, type IdentityRecord, userForIdentity } from './identities.ts';
import { createIdentitySetup } from './identity-setup.ts';
import { buildLandingModel } from './landing.ts';
import { type LookupDoc, boardLookupDocs } from './meeting-lookup.ts';
import { withServerNotesSinks } from './meeting-notes-doc.ts';
import type { MeetingNotesOptions } from './meeting-notes.ts';
import { MeetingRelay } from './meeting-protocol.ts';
import { MEETING_CAPTURE_ACTOR } from './meeting-task-capture.ts';
import { MeetingStore } from './meetings.ts';
import {
  LOOPBACK_HOSTS,
  corsHeadersFor,
  isAllowedBrowserOrigin,
} from './middleware/browser-origin.ts';
import type { CfAccessOptions } from './middleware/cf-access.ts';
import {
  type ShareTarget,
  classifyHost,
  collabScope,
  isLoopbackAddress,
  isProxiedTrustedHost,
  isTrustedLocalHost,
  shareScopeAllows,
} from './middleware/host-guard.ts';
import { RECALL_STATUS_PATH, recallCallbackAllows } from './middleware/recall-callback-gate.ts';
import { isBrowserRequest, isGatedWrite, signInRequiredBody } from './middleware/write-gate.ts';
import {
  captureMockup,
  isHtmlMockupSource,
  readMockupCapture,
  readMockupHtml,
} from './mockup-capture.ts';
import { injectWidget } from './mockup-widget.ts';
import { parseMuxCursor } from './mux-cursor.ts';
import {
  PARK_MIGRATION_ACTOR,
  type ParkMigrationResult,
  migrateParkedRows,
} from './park-migration.ts';
import { parkNoteText } from './park-note.ts';
import type { PluginRefresher } from './plugin-refresh.ts';
import { localHostnames, publicBaseUrl } from './public-host.ts';
import { createPushAnnounce } from './push-announce.ts';
import type { PushFetch } from './push-notify.ts';
import type { NudgeTally } from './ready-nudge.ts';
import {
  CalendarConnectionStore,
  CalendarSyncConsumer,
  type RecallCalendarClient,
  parseCalendarSyncWebhook,
} from './recall-calendar.ts';
import { RecallMeetingRelay } from './recall-meeting.ts';
import { parseBotStatusWebhook } from './recall-status.ts';
import { svixHeadersFrom, verifySvixSignature } from './recall-webhook-auth.ts';
import { type RecallClient, unreachableCallbackReason } from './recall.ts';
import { scanSettledDocRefs } from './refs-backfill.ts';
import { listArchivedReviews, readDocArchiveManifest } from './review-archive.ts';
import { backfillReviewFiling } from './review-backfill.ts';
import { createReviewGate } from './review-gate.ts';
import { type ReviewJudge } from './review-judge.ts';
import { type ReviewItemRow, type ReviewThreadItem, reviewItemRows } from './review-queue.ts';
import { type FeedbackWs, Rooms } from './rooms.ts';
import {
  type AgentIdentityRoutesContext,
  handleAgentIdentityRoutes,
} from './routes/agent-identity.ts';
import { type ArchiveRoutesContext, createArchiveRoutes } from './routes/archive.ts';
import { type AuthShareRoutesContext, handleAuthShareRoutes } from './routes/auth-share.ts';
import {
  type DocRoutesContext,
  handleDocCreateListRoutes,
  handleDocPromoteRoute,
  handleDocResourceRoutes,
} from './routes/docs.ts';
import {
  type MeetingCalendarRoutesContext,
  handleMeetingCalendarRoutes,
} from './routes/meetings-calendar.ts';
import { type OpsRoutesContext, handleOpsMetricsRoute, handleOpsRoutes } from './routes/ops.ts';
import {
  type TaskRoutesContext,
  handleDispatchAndNoteRoutes,
  handleTaskRoutes,
} from './routes/tasks.ts';
import {
  type WorkspaceRoutesContext,
  handleWorkspaceAttachmentRoutes,
  handleWorkspaceDeleteRoute,
  handleWorkspaceGoalRoutes,
  handleWorkspaceRoutes,
} from './routes/workspaces.ts';
import { captureServerError, routePatternForSpan, withRouteSpan } from './sentry.ts';
import { CfApi } from './share/cf-api.ts';
import { redactHubEventForVisitor } from './share/redact-hub-events.ts';
import {
  redactMetaForVisitor,
  redactWorkspaceFilesForVisitor,
  redactWorkspaceGroupedForVisitor,
  redactWorkspaceTreeForVisitor,
  relativeReviewUrl,
} from './share/redact-meta.ts';
import { renderShareLinkUnavailable } from './share/share-link-page.ts';
import { shareMemberKey } from './share/share-links.ts';
import { Shares, audienceEntryAdmits } from './share/shares.ts';
import { SharingGate } from './share/sharing-gate.ts';
import type { ShareConfig } from './share/types.ts';
import { sanitizeVisitorAuthor } from './share/visitor-identity.ts';
import { claimReplayMarks, saveReplayMarks } from './sse-marks.ts';
import { channelForWatchKey, openAgentMuxStream } from './sse-mux.ts';
import { HTTP_IDLE_TIMEOUT_SEC, SseHub, openSseStream } from './sse.ts';
import { createStallWiring } from './stall-wiring.ts';
import { ThreadSummarizer } from './summarize.ts';
import { AUTHOR_REQUIRED_ERROR, AUTHOR_REQUIRED_MESSAGE } from './task-owner.ts';
import { TaskProjection, taskBodyDocId } from './task-projection.ts';
import {
  DEFAULT_PARALLELISM_CAP,
  type HubWorkspace,
  LEGACY_REVIEW_ITEM_ID,
  type ParallelismCapChange,
  type Task,
  TaskStore,
  legacyDecisionItem,
  taskChip,
} from './tasks.ts';
import { ThreadRequestDedup } from './thread-request-dedup.ts';
import type { TranscriptionEngine } from './transcribe.ts';
import { UptimeMonitor } from './uptime.ts';
import { type VoiceComplete, VoiceRouter } from './voice.ts';
import { type WebhookLogEntry, createWebhookDispatcher } from './webhooks.ts';
import { onClose, onMessage, onOpen } from './yjs-protocol.ts';

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

import { HUB_FEEDBACK_DOC_ID } from './doc-ids.ts';
import {
  HTML_SHELL_HEADERS,
  appCacheControl,
  buildProjectArtifacts,
  collectLandingProjects,
  collectLandingWorkspaces,
  readAppAssetManifest,
  renderDeviceFrame,
  renderHubNotFound,
  renderHubShell,
  renderLanding,
  renderMockupNotFound,
  renderProjectPage,
  renderReviewNotFound,
  renderSigninShell,
  serveStatic,
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
  HUB_FEEDBACK_DOC_ID,
  appCacheControl,
  readAppAssetManifest,
  renderHubShell,
  renderSigninShell,
  serveStaticUnder,
};

export interface ServerOptions {
  /**
   * CW_SHARING_DISABLED was set: external sharing starts OFF and the runtime
   * toggle refuses to reopen it. The switch to reach for while a security
   * review is in flight — nothing this process exposes can undo it.
   */
  sharingEnvLocked?: boolean;
  port?: number;
  /**
   * The bind address, passed straight to `Bun.serve`. Unset — every caller
   * except `scripts/staging.ts` — keeps Bun's own default (the wildcard,
   * every interface), which is what prod needs to be reachable over
   * Tailscale and the LAN. Only `scripts/staging.ts` passes a value, and it
   * defaults that value to loopback: see `reserved-ports.ts` for the outage
   * a wildcard-bound dev/staging server caused.
   */
  hostname?: string;
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
   * A browser must be SIGNED IN to write (`CW_REQUIRE_SIGNIN_TO_WRITE`).
   * Default off, and off means byte-for-byte today's behaviour.
   *
   * Deliberately a second switch rather than a widening of
   * `requireEmailAuth`. That one governs what a session MEANS and has never
   * governed whether you need one — with it on and this one off, a browser
   * that signs in is believed over its own claimed body, and a browser that
   * does not sign in still writes as whatever it typed. This flag is the
   * other half: with it on, an ordinary write from a browser that has proven
   * nothing is refused, and the person is told to sign in.
   *
   * Two flags because the two answers are independently useful. Trustworthy
   * attribution for whoever does sign in costs nobody anything and can go on
   * first; requiring it of everyone makes a first-time reviewer sign in
   * before their first comment, which is a decision about audience, not
   * about identity plumbing.
   *
   * What it does NOT gate: reads (never — everyone who can reach this server
   * can read it), the `/api/auth/*` flow (gating it would be a deadlock),
   * and anything that is not a browser. See middleware/write-gate.ts for why
   * agents are outside the gate and what that boundary is worth.
   */
  requireSignInToWrite?: boolean;
  /**
   * ACCESS-ONLY browser hosts. Defaults to TRUE — every hostname that is not
   * loopback is browser-facing and must carry a verified Cloudflare Access
   * identity, so the tailnet name, this machine's LAN names and
   * `trustedHosts` stop being an unauthenticated door (Bryan, 2026-09-02:
   * *"No internal hole."*). See rule 3 in middleware/host-guard.ts for what
   * the rule is and what it closes.
   *
   * `false` restores the pre-2026-09-02 classification. The tests that
   * exercise the LAN-alias grant pass it explicitly, the same way the tests
   * of other gates pass `requireSignInToWrite: false`; the deployment switch
   * is `CW_ACCESS_ONLY_BROWSER_HOSTS`.
   */
  accessOnlyBrowserHosts?: boolean;
  /**
   * Whether this server offers its OWN emailed-code sign-in: the `/signin`
   * page and the `/api/auth/start` + `/api/auth/verify` routes.
   *
   * Defaults to the inverse of `accessOnlyBrowserHosts`. Under access-only
   * every browser has already proven an address at Cloudflare Access, so a
   * second sign-in is a second authentication for the same person and a
   * "you are not signed in" dead end on a surface where nobody can be
   * un-signed-in. Nothing else changes: sessions minted before it was turned
   * off are still honoured, and `/api/auth/session`, `/api/auth/profile` and
   * `/api/auth/logout` all stay open.
   */
  emailCodeSignIn?: boolean;
  /**
   * Sentry DSN for the BROWSER apps (`CW_SENTRY_DSN`). Server config on the
   * box, never the public repo: a DSN is a public client key, but committing
   * it invites drive-by event spam and couples the repo to one org. Reaches
   * the browser as a meta tag in the served shells; absent means the client
   * never loads the Sentry SDK at all.
   */
  sentryDsn?: string;
  /**
   * What the BROWSER should call this deploy in Sentry (`release`). The same
   * provenance string the server stamps on its own events — `git describe`
   * of the deploy source, from the published release's `release.json` — so a
   * regression can be attributed to the deploy it arrived with, and the
   * browser trace and the server span it continues agree on the release.
   * Only prod resolves one; dev and staging leave it unset and Sentry simply
   * omits the release, exactly as the server does. See browser-sentry.ts.
   */
  sentryRelease?: string;
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
   * Hourly abuse ceilings on the login-code mailer
   * (`CW_AUTH_GLOBAL_STARTS_PER_HOUR`, `CW_AUTH_PEER_STARTS_PER_HOUR`).
   * Bounds how much mail `/api/auth/start` can be made to send in total and
   * per peer, above the sliding 15-minute limits. Defaults in
   * auth/email-code.ts; a tripped ceiling answers like a success and logs.
   */
  authCeilings?: { globalStartsPerHour?: number; peerStartsPerHour?: number };
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
   * How many quiet windows a row with a WATCHING builder dispatch gets
   * before the wake calls its builder silent (default
   * `BUILDER_SILENT_MULTIPLIER_DEFAULT`, two; `CW_BUILDER_SILENT_MULTIPLIER`
   * sets it on the box). A test seam for the same reason `stallNudgeQuietMs`
   * is one; the reasoning behind the number is on the constant in
   * stall-gate.ts.
   */
  stallBuilderSilentMultiplier?: number;
  /**
   * The review-item quality gate. **No default**, the summarizer's seam
   * rule: omitting it means every item passes unjudged and nothing that
   * spins a server up can reach the network. `bin.ts` constructs the real
   * one (`haikuReviewJudge`); tests pass a stub.
   */
  reviewJudge?: ReviewJudge;
  /**
   * The ticket-effort scorer (chunk 2 of the effort model). **No default**,
   * the same seam rule as the review judge and the summarizer: omitting it
   * leaves every ticket unscored — `Task.effortEstimate` stays absent
   * rather than a failed run being recorded — and nothing that merely spins
   * a server up can reach the network. `bin.ts` constructs the real one
   * (`haikuEffortEstimator`); tests pass a stub.
   */
  effortEstimator?: EffortEstimator;
  /**
   * How long a held review item may stand before the stall loop complains
   * (default `HELD_ITEM_DEFAULT_MS`, five minutes; `CW_HELD_ITEM_MINUTES`
   * sets it on the box). A test seam for the same reason `stallNudgeQuietMs`
   * is one.
   */
  heldReviewItemMs?: number;
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
  /**
   * How the dispatch registry watches builder worktrees (default: recursive
   * fs.watch). A test seam for the same reason `stallNudgeQuietMs` is one —
   * the feature is OS filesystem events a test on CI's Bun-on-Linux cannot
   * rely on receiving (see dispatch-registry.ts).
   */
  dispatchWatchFactory?: WatchFactory;
  /** Absolute path to the built widget dist dir, or null to skip. */
  widgetDistDir?: string | null;
  /** Absolute path to the built workspaces-app dist dir. */
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
   * Hostnames served through the Cloudflare tunnel that are the OPERATOR'S
   * OWN address — the whole product, from outside the tailnet, once
   * Cloudflare Access has authenticated the visitor as someone the operator
   * admitted.
   *
   * A third list, separate from both above, because it grants the most: an
   * entry classifies `proxied-local` — an Access token is required, and then
   * the request is served exactly as loopback is (doc list, workspace
   * creation, share administration, deploy). `trustedHosts` entries are
   * still refused through the proxy; `accessTunnelHosts` entries still get
   * only the share surface; a host on both opt-in lists stays collab.
   *
   * IGNORED unless `cfAccess` is configured with a static audience — the same
   * rule as `accessTunnelHosts`, enforced by `proxiedTrustedVerifier` below.
   * Honoured without Access in front, this list would be the full API
   * exposed to anyone who can reach the tunnel, so it fails closed.
   *
   * The sharing master switch does NOT cover it: this is the operator's own
   * door, keyed to their own identity, and it is how they turn sharing back
   * on from outside.
   */
  proxiedTrustedHosts?: string[];
  /**
   * WHO may come through `proxiedTrustedHosts`, by the email Cloudflare
   * Access verified — folded the way the roster folds addresses.
   *
   * A valid token proves the Access policy admitted someone, never who. One
   * application (one AUD) may cover the collaboration hostnames too, and
   * then a collaborator's token is exactly as valid at the operator's door.
   * So after the token, the verified email must be on this list or the
   * request is refused with a bare 403 that echoes nothing. Independent of
   * `requireEmailAuth`, which governs sessions, not this gate.
   *
   * EMPTY means `proxiedTrustedHosts` is ignored entirely — a door that
   * cannot tell the operator from a collaborator must not open. bin.ts
   * defaults it to `CW_OWNER_EMAIL`.
   */
  proxiedTrustedEmails?: string[];
  /**
   * The SHARE hostname(s) — `share.<domain>` — where a share link is opened.
   *
   * The fifth list, and the one whose Access application admits ANY email:
   * its policy is "everyone, one-time PIN", so passing Cloudflare there
   * proves an address and grants nothing. Reach is decided afterwards by this
   * server's own membership record — the emails that redeemed a live link for
   * the workspace the path names (`shareLinks.isMember`). Root and every path
   * that names no workspace answer nothing but the app shell.
   *
   * The FIRST entry is what share URLs are built from; the rest are honoured
   * so a hostname rename does not break links already sent.
   *
   * IGNORED unless `shareLinkAudience` is also set, and the verifier built
   * from it is the share application's OWN audience — never `cfAccess`'s.
   * That separation is the audience cross-check: an owner-host token must not
   * verify here, and an any-email share-host token must not verify there.
   */
  shareLinkHosts?: string[];
  /**
   * The AUD tag of the ONE Cloudflare Access application in front of
   * `shareLinkHosts` (`CF_ACCESS_SHARE_AUD`).
   *
   * Its own option rather than a reuse of `cfAccess.audience` for the reason
   * above: the two applications have different policies, and one audience
   * covering both would mean a token anyone can mint by typing an email into
   * the share sign-in also opens the operator's hostname.
   */
  shareLinkAudience?: string;
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
   * constructs real ones (`createAssemblyAiEngine`, `createSonioxEngine`).
   *
   * An array is several engines the client may choose between by name on its
   * `start` frame, FIRST one the default; a bare engine is that one engine,
   * exactly as before.
   */
  transcription?: TranscriptionEngine | readonly TranscriptionEngine[];
  /**
   * The Recall.ai client that puts a BOT in a Zoom / Meet call. **No
   * default**, the same seam rule as `transcription` directly above and for
   * the same reason doubled: creating a bot bills the vendor per meeting-hour
   * AND opens an AssemblyAI streaming session behind it. Omitting it makes
   * the invite route answer `not_configured`, which the doc's strip renders
   * as a settled state. Only `bin.ts` constructs a real one
   * (`createRecallClient`).
   */
  meetingBot?: RecallClient;
  /**
   * Shared secret for verifying Recall's status webhooks (Svix format).
   *
   * **The webhook route is armed only while this is set.** Unset, `POST
   * /recall/status` answers 404 on every host — the signature is the route's
   * only credential, so without one there is no door to knock on. There is
   * no unsigned fallback: this comment used to describe one ("falls back to
   * the bot id being unguessable"), and that path was removed because an
   * unauthenticated caller on the LAN or the tailnet could inject bot-status
   * and calendar-sync events outside the replay guard.
   *
   * So leaving it unset does not degrade the webhook, it turns it off, and
   * the symptom is a bot whose status never updates. The operator sets
   * `RECALL_WEBHOOK_SECRET` to the signing secret from the Recall dashboard.
   */
  meetingBotWebhookSecret?: string;
  /**
   * Calendar meeting-join: Recall.ai Calendar V2 plus the Google OAuth app
   * the connect flow speaks for. No bot joins anything by default — the
   * connection tracks upcoming meetings, and taking a per-event join sends
   * the bot in through `meetingBot`'s invite path (so joins also need THAT
   * configured) and opens the discussion doc the transcript lands in.
   * **No default**, the same seam rule as `meetingBot` directly above and
   * with the same bill attached — an invited bot joins a real call and
   * spends. Omitting it makes every `/api/calendar/*` route answer
   * `not_configured` and the status webhook ignore `calendar.sync_events`.
   * Only `bin.ts` constructs real ones (`createRecallCalendarClient`,
   * `createGoogleOauthApp`, `createKeychainRefreshTokenVault`).
   */
  calendarBot?: {
    client: RecallCalendarClient;
    /** Null when the Google OAuth app is not configured: sync + join still
     *  work for a calendar connected earlier, but connect answers 503. */
    google: GoogleOauthApp | null;
    /** Where the refresh token rests so disconnect can revoke it at Google. */
    vault?: RefreshTokenVault;
  };
  /**
   * The dedicated hostname Recall.ai's backend dials this deployment on —
   * `CW_RECALL_CALLBACK_HOST`, e.g. `recall.<domain>`, pointed at the same
   * tunnel as the operator hostname and with NO Cloudflare Access
   * application in front of it.
   *
   * A hostname of its own rather than a hole in the operator's (Bryan,
   * 2026-08-31). It classifies its own host kind and serves exactly two
   * routes — the per-bot websocket upgrade and the status webhook — each
   * armed only while the credential it carries is configured; everything
   * else on it is 404. Unset is the ordinary state, and then the hostname is
   * unknown like any other and denied.
   */
  recallCallbackHost?: string;
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
  /**
   * Requests whose response takes at least this many milliseconds to BUILD
   * leave a `[timing]` line in the log (method, path, ms, status, bytes).
   * Default 500. The body's transfer is not in the number — Bun streams it
   * after the handler returns — which is why the byte count rides along:
   * a 0 ms route with a megabyte body and a 3 s route with a 4 KB one are
   * different bugs, and the line has to tell them apart. Tests set 0.
   */
  slowRequestMs?: number;
}

/** Files the workspaces-app build emits that must ALSO answer at the root
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
  rooms: Rooms;
  /** The hub task store — workspaces, tasks, the transition gate. */
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
  const meetingStore = new MeetingStore(dataDir, {
    // The raw companion's tie back to the doc: bound path and title as they
    // are at meeting start and stop. A thunk over `rooms`, which is
    // constructed below; a meeting can only start long after it exists.
    docInfo: (docId) => {
      const path = rooms.boundPathOf(docId);
      const title = rooms.peekMeta(docId)?.title;
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
    // references: rooms and the task store are constructed below, and both
    // exist long before any meeting can start.
    notes: opts.meetingNotes
      ? withServerNotesSinks(opts.meetingNotes, {
          rooms: () => rooms,
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
          // A huddle doc is HELD by a hub workspace rather than owned by one
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
    // Lifecycle only. The words never touch this hub — see meeting-protocol.
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
    // The bot's words DO touch this hub — unlike the microphone's — because a
    // bot has no socket to any browser. Transient: live fan-out, no buffer,
    // no id, so the replay window stays the doc's (see SseHub).
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
  // Server-side half of the double-submit fix: the doc composer's in-flight
  // guard stops ONE call site from ever sending the repeat, this catches
  // whatever gets through anyway (a request that landed but read as a
  // client-side failure, a future caller that reintroduces the race).
  const threadRequestDedup = new ThreadRequestDedup<Thread | null>();
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

  /**
   * A watch key is live when the thing it names still exists: a doc room, or
   * for `ws:<id>` a hub workspace / review. Anything else is a subscription
   * the child would open against a 404 forever.
   *
   * Closure-level rather than route-local because two routes need the same
   * answer — the watches list, and the attach response that reports how many
   * watches this session actually has. Two copies would be two definitions of
   * "live" free to drift, on a pair of readings that only mean anything when
   * they agree.
   */
  const watchKeyExists = (key: string): boolean => {
    if (rooms.docExists(key)) return true;
    if (!key.startsWith('ws:')) return false;
    const wsId = key.slice('ws:'.length);
    return (
      taskStore.getWorkspace(wsId) !== undefined || rooms.list().some((m) => m.workspaceId === wsId)
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
        docTitle: (docId) => rooms.peekMeta(docId)?.title,
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
  // for finished work (hub, 2026-08-31: `inUse 12 / free 0`, all twelve
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
  const taskProjection = new TaskProjection({ rooms, tasks: taskStore });
  taskProjection.init();

  // Provenance stamping at the store's one choke point: every create whose
  // origin names a doc records the doc's settled content revision, whichever
  // route (or the meeting capture) filed it.
  taskStore.setDocRevisionReader((docId) => rooms.settledContentRevision(docId));
  // …and the return half: a settled edit burst on a doc flags the open rows
  // derived from an earlier revision of it. Flagging emits no store event
  // (§3.6's table is exhaustive), so the projection refresh happens here,
  // the same pattern as the links route.
  rooms.onContentRevision = (docIds, revision) => {
    const touched = new Set(taskStore.flagStaleFromDocEdit(docIds, revision));
    // The settled doc's prose is the linkage record: any task/goal link the
    // edit wrote (or that was never mined) becomes a structured ref now, so
    // the Docs field on the row side stays true without a second call. Ids
    // arrive as canonical + alias; scanning the first that resolves scans
    // the one doc they both name.
    const scanned = new Set<string>();
    for (const docId of docIds) {
      const canonical = rooms.resolveDocId(docId);
      if (scanned.has(canonical)) continue;
      scanned.add(canonical);
      for (const wsId of scanSettledDocRefs(rooms, taskStore, canonical)) touched.add(wsId);
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

  // The stall / ready-work wiring — both per-board snapshots, the two
  // nudgers, the lead-presence monitor, the ready clock's store subscription
  // and the comment-queue bridge. One documented subsystem
  // (docs/architecture/stall-detection.md), so it is one module:
  // `stall-wiring.ts`. `createServer` composes it and arms the nudgers below;
  // it does not derive any of it.
  //
  // Three members of the context are FUNCTIONS rather than values —
  // `hubBoardsForDoc`, `backTargetFor` and `reviseCallFor` — because all
  // three are built further down this file than this line, and every one of
  // them is only ever reached from a request or an event. Passing them
  // deferred is what let this move without reordering the blocks below:
  // the review gate is built where it is because it needs
  // `resolveWorkspaceForDoc` and the task projection, and hoisting it to
  // satisfy a declaration order would trade one ordering constraint for a
  // worse one.
  const stallWiring = createStallWiring({
    taskStore,
    taskProjection,
    rooms,
    sse,
    dispatches,
    agentWatches,
    dataDir,
    parallelismCapView,
    capSummary,
    hubBoardsForDoc: (docId) => hubBoardsForDoc(docId),
    backTargetFor: (docId, reviewId) => backTargetFor(docId, reviewId),
    reviseCallFor: (address) => reviseCallFor(address),
    ...(opts.readyNudgeIdleMs !== undefined ? { readyNudgeIdleMs: opts.readyNudgeIdleMs } : {}),
    ...(opts.stallNudgeQuietMs !== undefined ? { stallNudgeQuietMs: opts.stallNudgeQuietMs } : {}),
    ...(opts.stallBuilderSilentMultiplier !== undefined
      ? { stallBuilderSilentMultiplier: opts.stallBuilderSilentMultiplier }
      : {}),
    ...(opts.stallNudgeRepeatMs !== undefined
      ? { stallNudgeRepeatMs: opts.stallNudgeRepeatMs }
      : {}),
    ...(opts.heldReviewItemMs !== undefined ? { heldReviewItemMs: opts.heldReviewItemMs } : {}),
  });
  const { leadPresence, readyNudger, stallNudger } = stallWiring;
  // The late binding `Rooms` was constructed with: the bridge needs the task
  // store and the projection, which are built after `Rooms` is.
  onDocRoomEvent = stallWiring.onDocRoomEvent;

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
        const meta = rooms.peekMeta(docId);
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
   * now (`reviewQueue` in hub-review-model.ts), which closed the measured gap where
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
    // A decision the reader has asked on is the OWNER's turn and off the
    // browser's queue (`decisionRows` reads `decisionState`), so it is not
    // counted here either — the same derivation, on the same row.
    const decisions = open.filter((t) => {
      if (t.needs !== 'decision' || t.answer) return false;
      const item = legacyDecisionItem(t);
      return item === undefined || reviewItemState(item) !== 'waiting';
    });
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
      const meta = rooms.peekMeta(docId);
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
      const meta = rooms.peekMeta(docId);
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
    const id = rooms.resolveDocId(rawId);
    const out = new Set<string>();
    const reviewId = reviewIdOf(rooms.peekMeta(id) ?? {});
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
   * Is this Access-verified email a MEMBER of this workspace — the question
   * the collaboration hostname asks after Cloudflare Access has answered
   * "is this someone Bryan admitted to the hostname at all?".
   *
   * The two are not the same question, and treating them as one was the
   * weakness this closes: every email the Access application admitted could
   * open every workspace on the server by id, because the only thing checked
   * after the token was whether the PATH was in scope for the workspace it
   * named. A share hostname never had that problem — it is minted for one
   * workspace with one allow list — so the fix is to give the collaboration
   * hostname the same record rather than a new one.
   *
   * THE MEMBERSHIP SET, exactly: the allow lists of the workspace's LIVE
   * shares, plus the owner allowlist. A share is the only place an email is
   * ever written down against a workspace, so a workspace with no live share
   * admits nobody here — which is the correct answer, not a gap: nobody has
   * been given it.
   *
   * Three details, each of which would otherwise be a hole:
   *
   *   - The candidate set is the workspace itself PLUS every workspace that
   *     covers it (`shareWorkspacesOf`). A doc's path resolves to its REVIEW,
   *     while the share that admits people is minted on the BOARD the review
   *     is filed on, so checking the path's workspace alone would refuse
   *     every legitimately shared diff review and folder bind. This is the
   *     same set `shareScopeAllows` reaches through, so it grants exactly
   *     what a share on one of those boards already grants — no wider.
   *   - `boardShareTarget` is applied to each share, so a record whose
   *     workspace is no longer a board is as dead here as it is on its own
   *     hostname. One rule for what a share is worth.
   *   - A token with NO email claim is nobody, and nobody is a member. It
   *     reaches the app shell and nothing else.
   */
  const collabMemberOf = (workspaceId: string, email: string | null): boolean => {
    const who = email ? normalizeEmail(email) : '';
    if (who === '' || !workspaceId) return false;
    // The owner half. Same list the operator hostname checks and the same
    // list a `share_link` with no audience falls back to, so "who is this
    // deployment's own people" has one answer.
    if (proxiedTrustedEmails.has(who)) return true;
    if (!shares) return false;
    const candidates = new Set<string>([workspaceId, ...shareWorkspacesOf(workspaceId)]);
    for (const wsId of candidates) {
      for (const share of shares.liveForWorkspace(wsId)) {
        if (!boardShareTarget(share)) continue;
        if ((share.allowDomains ?? []).some((entry) => audienceEntryAdmits(entry, who))) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * Is this Access-verified email a member of this workspace, on the SHARE
   * hostname — the question asked after Cloudflare has confirmed an address
   * that its "everyone" policy admitted without knowing anything about them.
   *
   * Deliberately NOT `collabMemberOf`, and the separation is the whole
   * security property of the share hostname. That function's membership set
   * is the allow lists of a workspace's live shares plus the owner allowlist
   * — records that say "the operator named this person". The share hostname's
   * application names nobody, so reusing it would answer the question with a
   * record that was written about a different door: every address the
   * operator ever allow-listed anywhere would reach the share host, and every
   * redeemed reviewer would reach the collaboration host. Two doors, two
   * records, and a redemption grants exactly one of them.
   *
   * The candidate set is the workspace itself PLUS every workspace that
   * covers it, for the reason `collabMemberOf` gives at the same line: a
   * doc's path resolves to its REVIEW, while the link that admitted people
   * was minted on the BOARD the review is filed on. Same set
   * `shareScopeAllows` reaches through, so it grants exactly what the board's
   * own link already grants — no wider.
   *
   * `boardShareTarget`'s rule applies here too, spelled as the lookup it is:
   * a workspace that is no longer a board grants nothing, so a link minted
   * before a board was retired stops admitting people the moment it stops
   * being a board.
   *
   * A token with NO email claim is nobody, and nobody is a member.
   */
  const shareLinkMemberOf = (workspaceId: string, email: string | null): boolean => {
    if (!email || !workspaceId) return false;
    const candidates = new Set<string>([workspaceId, ...shareWorkspacesOf(workspaceId)]);
    for (const wsId of candidates) {
      if (!taskStore.getWorkspace(wsId)) continue;
      if (shareLinks.isMember(wsId, email)) return true;
    }
    return false;
  };

  /** A path segment, decoded, answering itself rather than throwing on `%`. */
  const safeDecodeSegment = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  /**
   * `GET /s/<id>` on the share hostname: turn a verified email into a member.
   *
   * The ONLY write a non-member can make here, and its whole content is the
   * caller's own Access-verified address against the workspace the link
   * already names. Nothing in the request body or the path can change WHICH
   * workspace — that came from the record.
   *
   * Everything that is not a live link on a live board renders the one
   * unavailable page and records nothing: revoked, expired, unknown,
   * malformed, and a workspace that is no longer a board. Four answers would
   * let anyone with the route learn which ids exist by the difference between
   * them, so there is one.
   *
   * The board check runs BEFORE the redeem, so a link whose board was retired
   * writes no membership row on its way to being refused.
   *
   * Success is a redirect to the board on this same hostname, which is where
   * a returning member's next visit goes directly.
   */
  const redeemShareLink = (linkId: string, email: string | null): Response => {
    const unavailable = () =>
      new Response(renderShareLinkUnavailable(), {
        status: 404,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Keeps the link id out of any downstream Referer, the same reason
          // the retired link routes set it.
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
        },
      });
    const link = shareLinks.get(linkId);
    if (!link || !taskStore.getWorkspace(link.workspaceId)) return unavailable();
    const outcome = shareLinks.redeem(linkId, email ?? '');
    if (!outcome.ok) return unavailable();
    return new Response(null, {
      status: 302,
      headers: {
        location: `/workspaces/${encodeURIComponent(outcome.workspaceId)}`,
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      },
    });
  };

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
    const reviewId = reviewIdOf(rooms.peekMeta(docId) ?? {});
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
    const thread = await rooms.postComment(
      docId,
      null,
      author,
      text,
      { kind: 'subject' },
      { generate: false },
    );
    if (!thread) return null;
    const stamped = rooms.setReviewRequested(docId, author.name, thread.id);
    return { threadId: thread.id, ...(stamped.ok ? { requestedAt: stamped.requestedAt } : {}) };
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
    backTargetFor(docId, reviewIdOf(rooms.peekMeta(docId) ?? {}))?.id ?? null;

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
    rooms,
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
    // The doc editor's shell is a BUILT file, identical on every box, so the
    // Sentry tags cannot be templated into it at build time — they are box
    // config. Rewritten here on the way out instead, the same way a mockup's
    // own HTML gets the widget. Unconfigured, `injectSentryHead` is skipped
    // and the built bytes go out as they are. The bundle URLs inside are
    // already content-addressed — the BUILD wrote them that way.
    return serveShellHtml(join(markdownAppDist, 'index.html'), 'doc');
  };

  /**
   * A built HTML shell, with the browser Sentry tags added for `pageType`.
   *
   * Read rather than delegated to `serveStatic` because the body can be
   * rewritten on the way out and the response has to describe what was
   * actually SENT. That used to mean re-hashing for an etag; it now means
   * `no-store` and no etag at all, which is the same principle taken one step
   * further — see `HTML_SHELL_HEADERS`.
   */
  const serveShellHtml = (path: string, pageType: PageType): Response | null => {
    if (!existsSync(path)) return null;
    // `no-store`, and no etag to go with it. This shell names the bundle URLs
    // the page will load; a browser holding an old copy of it loads the
    // bundles IT names, and there is no later request in which to notice.
    // Since those URLs are content-addressed, the shell is the only thing
    // that has to stay fresh — and it is about a kilobyte gzipped.
    const raw = readFileSync(path, 'utf8');
    const html = browserSentry
      ? injectSentryHead(raw, browserSentry, pageType, readAppAssetManifest(markdownAppDist))
      : raw;
    return new Response(html, { headers: HTML_SHELL_HEADERS });
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
  const isMockupDoc = (docId: string): boolean => rooms.peekMeta(docId)?.type === 'mockup';

  /**
   * A mockup's own HTML, streamed from the file the room is bound to — with
   * the comment widget added on the way out.
   *
   * The embed is attached HERE rather than written into the file, so a page
   * that a build step generates, or that git tracks, never has to carry review
   * scaffolding to be reviewable. See mockup-widget.ts for the incident that
   * moved it. A page that embeds the widget itself is served untouched.
   *
   * The live file wins whenever it is readable, and serving refreshes the
   * capture from it — so a mock that is still being edited behaves exactly as
   * it always did, and the fallback holds the last thing anyone was shown
   * rather than whatever round one looked like. Only when the file is gone
   * does the capture answer, which is the case that used to be a 404 in front
   * of the reviewer. See mockup-capture.ts.
   */
  const serveMockup = (docId: string): Response => {
    const notFound = () =>
      new Response(renderMockupNotFound(docId), {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    const room = rooms.get(docId);
    if (!room || room.meta.type !== 'mockup' || !room.meta.sourceUrl) return notFound();
    const source = room.meta.sourceUrl;
    // A mockup bound to something that isn't HTML is served as-is, as before:
    // nothing is injected into it and nothing is captured from it.
    if (!isHtmlMockupSource(source)) return serveStatic(source) ?? notFound();
    const live = readMockupHtml(source);
    if (live !== null) captureMockup(dataDir, room.docId, live);
    const html = live ?? readMockupCapture(dataDir, room.docId);
    if (html === null) return notFound();
    // Sentry tags ride out with the widget embed, for the same reason and by
    // the same route: a mockup is somebody's own file, and neither the review
    // scaffolding nor the box's monitoring config belongs in it on disk.
    const withWidget = injectWidget(html, room.meta.docId);
    const body = injectSentryHead(
      withWidget,
      browserSentry,
      'mockup',
      readAppAssetManifest(markdownAppDist),
    );
    return new Response(body, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        // Content-derived like serveStatic's, and for the same reason: a
        // reload of an unchanged mock should cost a 304, and a deploy that
        // changed nothing should not throw the cache away. Hashed from the
        // BODY WE SEND rather than the file we read — the widget embed and
        // the Sentry head are part of what the browser is holding, so a
        // source-derived tag would revalidate a page whose injected half had
        // changed underneath it. (`serveShellHtml` no longer carries a tag at
        // all — it is `no-store`, so there is nothing stored to validate.)
        etag: `"${Bun.hash(body).toString(16)}"`,
        // Which copy answered. A page served from the capture is still the
        // page — but "the source file is gone" is a fact somebody may want to
        // act on, and it must not be inferred from the absence of an error.
        'x-mockup-source': live !== null ? 'live' : 'captured',
      },
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
    const viaProxy = req.headers.has('cf-ray');
    const isLocalSurface = isTrustedLocalHost(host, {
      lanHosts: ourNames,
      extraHosts: opts.trustedHosts ?? [],
      viaProxy,
    });
    // The operator's own proxied hostname serves the same product, but it is
    // NOT the local surface for origin purposes. Through the tunnel the
    // browser's `localhost` is the VISITOR'S machine, and a LAN name resolves
    // on the visitor's network, so every allowance that makes sense for a
    // TRUSTED_HOSTS name — loopback, LAN names, any port on our own names —
    // would here trust a page the operator merely has open. Same-origin plus
    // the origins the operator configured by name, nothing else. (The
    // configured ones are the one deliberate cross-origin grant, and they
    // are the operator's own call.)
    const isProxiedLocal = isProxiedTrustedHost(host, {
      viaProxy,
      proxiedTrustedHosts,
      accessFronted: proxiedTrustedVerifier !== null,
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
      allowedOrigins: isLocalSurface || isProxiedLocal ? (opts.allowedOrigins ?? []) : [],
    };
  };

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
  /**
   * What the operator routes read instead of this closure's scope. Built
   * once — every collaborator in it is long-lived.
   */
  const opsRoutesCtx: OpsRoutesContext = {
    rooms,
    pluginRefresher,
    deployer,
    pushStore,
    pushNotifier,
    j,
    safeJson,
    requestAddress: (req) => server.requestIP(req)?.address,
  };

  /** The archive family — the four archive/unarchive routes and the
   *  review-only delete the board delete two positions below still calls. */
  const archiveRoutesCtx: ArchiveRoutesContext = {
    rooms,
    taskStore,
    taskProjection,
    dataDir,
    j,
    safeJson,
    unlinkFromEveryHubWorkspace,
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
  };

  /**
   * What the meeting, transcript and calendar routes read instead of this
   * closure's scope. Built once — every collaborator in it is long-lived.
   */
  const meetingCalendarRoutesCtx: MeetingCalendarRoutesContext = {
    rooms,
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
    fileUnderHubWorkspace,
  };

  /**
   * What the doc, thread and bind routes read instead of this closure's
   * scope. Built once — every collaborator in it is long-lived.
   */
  const docRoutesCtx: DocRoutesContext = {
    rooms,
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
    hubBoardsForDocIndexed,
    homeForDocIndexed,
    fileUnderHubWorkspace,
    unlinkFromEveryHubWorkspace,
    threadUrl,
    fileReviewRequest,
    judgeThreadReview,
    announceThreadReview,
    recordedThreadHold,
    gateThreadDeclaration,
    heldFields,
    rewriteTaskBody,
    parseRevisedRange,
  };

  /**
   * What the sign-in, session and share routes read instead of this closure's
   * scope. Built once — every collaborator in it is long-lived.
   */
  const authShareRoutesCtx: AuthShareRoutesContext = {
    rooms,
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
    defaultHubWorkspaceName: DEFAULT_HUB_WORKSPACE_NAME,
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
    rooms,
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
    hubBoardsForDocIndexed,
    judgeReviewItem,
    judgeTaskDecision,
    mergedHold,
    parallelismCapView,
    proposeAllowRule,
    regateDecisionWords,
    rewriteTaskBody,
  };
  /**
   * The same split for the workspace routes — see ./routes/workspaces.ts.
   * Built once, for the same reason: every collaborator in it is long-lived,
   * and the per-request half travels with each call.
   */
  const workspaceRoutesCtx: WorkspaceRoutesContext = {
    taskStore,
    taskProjection,
    rooms,
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
    fileUnderHubWorkspace,
    unfileFromDefault,
    workspacesOfDoc: shareWorkspacesOf,
    watchKeyExists,
  };

  /**
   * What an upgrade attaches to a socket, for every socket this server opens.
   *
   * `kind` is what the ONE websocket handler below branches on: Bun routes
   * every upgraded path into the same `open`/`message`/`close`, so the audio
   * socket and the editing socket are told apart by what the upgrade
   * attached. Absent means the editing socket, which is every upgrade that
   * predates meetings.
   *
   * `shareId` and `readOnly` are named here rather than passed as excess
   * properties, so the two upgrades that set them are type-checked against
   * the fields the handlers read (`WsCtx` in rooms.ts, `MeetingClient` in
   * meeting-protocol.ts).
   */
  type UpgradeData = {
    docId: string;
    kind?: 'yjs' | 'audio' | 'recall';
    token?: string;
    shareId?: string;
    shareMember?: string;
    readOnly?: boolean;
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
    async fetch(req, server) {
      const startedAt = performance.now();
      const pathname = new URL(req.url).pathname;
      // Server-side Sentry (a no-op passthrough when unconfigured — see
      // sentry.ts): one span per request, named by route PATTERN never raw
      // path, continuing the browser's trace when it sent one so a page load
      // reads end to end. A throw inside `route()` is reported with the same
      // route-pattern context, then rethrown unchanged — this wrapper only
      // observes, it does not change what a request returns.
      let routed: Response | undefined;
      try {
        routed = await withRouteSpan(req, pathname, () => route(req, server));
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
      async function route(
        req: Request,
        server: BunServer<UpgradeData>,
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
         *  1. A proven identity. It outranks the body precisely because the
         *     body is the thing it exists to stop being authoritative — and
         *     it does so whether or not `CW_REQUIRE_EMAIL_AUTH` is on: the
         *     flag governs whether a session is REQUIRED, never whether a
         *     verified one is believed (Bryan, 2026-08-29 — a verified name
         *     is never worse than a typed one).
         *  2. A share visitor with nothing proven stays a `guest-` — that
         *     path is the template this work copies, not a thing it replaces.
         *     Since every share host sits behind Cloudflare Access, a visitor
         *     reaching this rung is a deployment with no verifier wired, not a
         *     normal anonymous reviewer.
         *  3. Otherwise the claimed body, exactly as today. This is the rung
         *     every agent, every MCP call and every un-authenticated browser
         *     lands on, so a request with no session behaves identically
         *     whichever way the flag is set.
         *
         * With no session presented, this function is byte-for-byte what it
         * was whichever way the flag is set.
         */
        const authorFor = (claimed: unknown): User | undefined => {
          // Rung 0: a verified widget popup-token. NOT behind the flag,
          // unlike the cookie rung — no request carries this header by
          // accident, so presenting the token is itself the opt-in, and the
          // whole point of the handshake is attribution on a surface the
          // cookie can never reach. An invalid token never lands here: the
          // gate below 401s it before any route runs.
          if (widgetIdentity) return userForIdentity(widgetIdentity);
          const proven = provenIdentityFor();
          if (proven) return userForIdentity(proven);
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
          return stampRosterAgent(claimed as User | undefined);
        };

        /**
         * A write signed by a roster AGENT is stamped with the roster's
         * name and canonical id — the board's record of who holds the seat
         * names the lead, not the launch env of whichever process happened
         * to sign. Mirrors `userForIdentity` for people. An author the
         * roster does not know (a person's typed name, an old bundle's id
         * nothing attached under) passes through exactly as claimed.
         */
        /** The 400 every comment route answers the shared category with.
         *  One message, the same fix named, so a peer launched without a
         *  name learns it from the first refusal rather than from silence. */
        const refuseCategoryAuthor = (): Response =>
          j(400, { error: AUTHOR_REQUIRED_ERROR, message: AUTHOR_REQUIRED_MESSAGE });

        const stampRosterAgent = (claimed: User | undefined): User | undefined => {
          if (!claimed || typeof claimed !== 'object' || typeof claimed.id !== 'string') {
            return claimed;
          }
          const rec = identities.get(claimed.id);
          if (!rec || rec.kind !== 'agent') return claimed;
          // A row written by an older bundle's attach carries no name — its
          // display name is its id. The claim on THIS write is the launch
          // env's name, which is exactly the source the roster wants, so
          // learn it here rather than overwrite a real name with an id.
          const claimedName = typeof claimed.name === 'string' ? claimed.name.trim() : '';
          if (rec.displayName === rec.id && claimedName && claimedName !== rec.id) {
            const learned = identities.upsertAgent(rec.id, claimedName);
            return { ...claimed, id: rec.id, name: learned?.displayName ?? claimedName };
          }
          return { ...claimed, id: rec.id, name: rec.displayName };
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

        /**
         * The identity a widget popup-token proved, resolved once below the
         * host gate and read by `authorFor` (rung 0). Stays null when no
         * token was presented; a presented-but-invalid token never gets this
         * far — the gate answers 401 for the whole request.
         */
        let widgetIdentity: IdentityRecord | null = null;
        // Set when this request comes from a SHARE visitor (either mode).
        // Everything below treats a non-null value as "untrusted outsider":
        // their claimed identity is rewritten and doc metadata is redacted.
        let visitor: ShareTarget | null = null;
        /** The share that authorized this request, stamped onto any websocket
         *  it upgrades so revocation can find and close it later. */
        let visitorShareId: string | null = null;
        /** The MEMBERSHIP that authorized this request, when it came in on the
         *  share hostname. The same job as `visitorShareId` for the door that
         *  has no Cloudflare share behind it: without it, ejecting a member or
         *  shutting external access off left their open socket and stream
         *  running, because both are authorized once and never re-checked. */
        let visitorMemberKey: string | null = null;
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
            // The operator's own proxied address — listed, and honoured only
            // with the same static-audience verifier behind it.
            proxiedTrustedHosts,
            accessFronted: staticAccessVerifier !== null,
            // The share hostname, and the fact that its OWN Access
            // application is configured. `shareLinkAccessFronted` is a
            // separate flag from `accessFronted` because the two hostnames
            // sit behind two applications with two audiences — see the field.
            shareLinkHosts,
            shareLinkAccessFronted: shareLinkVerifier !== null,
            // Recall's own hostname. Neither `viaProxy` nor `accessFronted`
            // applies to it — see the field on TrustedHostOpts for why both
            // absences are deliberate.
            recallCallbackHost,
            // Access on every browser-facing hostname (rule 3 in host-guard).
            // `loopbackPeer` is the half the Host header cannot fake: both of
            // this deployment's proxies dial us over loopback, so it does not
            // separate a tunnel visitor from the box on its own — the Host
            // and the `cf-ray` veto do that — but it does stop a LAN or
            // tailnet client typing `Host: localhost` and being served the
            // product with no identity at all.
            accessOnly: accessOnlyBrowserHosts,
            loopbackPeer: isLoopbackAddress(server.requestIP(req)?.address),
            lookupShare: (h) => {
              // LIVE, not merely known: an expired share's hostname must stop
              // being a share hostname, or expiry never takes effect for
              // Access mode (see Shares.findLiveByHostname).
              return boardShareTarget(shares?.findLiveByHostname(h));
            },
          });
          if (decision.kind === 'deny') {
            return j(403, { error: 'unknown_host' });
          }
          // --- External-access master switch ---
          // AHEAD of both auth paths on purpose: while sharing is off, a live
          // Access JWT, an unexpired session cookie and no credential at all
          // must be indistinguishable. Gating after auth would leak which
          // share links are real to anyone still holding one.
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
          //
          // `proxied-local` is in here too, and it is the WIDEST of the four:
          // the operator's own public hostname through the tunnel, with the
          // whole product behind it. It arrives from outside the machine by
          // exactly the definition the other three do, and leaving it out
          // meant an operator who flipped this switch during a security
          // review — believing the one sentence that describes it — had not
          // closed the widest external door. Being the operator's own door is
          // not an argument for exempting it; it is the argument for the
          // Access token and the email allowlist below, which stay.
          //
          // Nothing local is affected, so the way back is the way in: flip it
          // from the box or the tailnet (`POST /api/share/enabled`, or the
          // `set_sharing_enabled` MCP tool). `CW_SHARING_DISABLED=1` is off
          // AND LOCKED, and it now locks remote operator access with it —
          // which is what "the outside door is shut" was always supposed to
          // mean.
          if (
            (decision.kind === 'share' ||
              decision.kind === 'share-link' ||
              decision.kind === 'collab' ||
              decision.kind === 'proxied-local') &&
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
          } else if (decision.kind === 'share-link') {
            // THE SHARE HOSTNAME. One Cloudflare Access application covers
            // the whole host with an "everyone" policy and a one-time PIN
            // login, so what arrives here is a verified email address and
            // nothing else — Cloudflare has said WHO, and said nothing about
            // what they may open. Everything below is this server answering
            // the second question.
            //
            // Non-null by construction (the host could not have classified
            // share-link without it), re-checked because "I could not verify"
            // must never mean "serve it".
            if (!shareLinkVerifier) {
              return j(503, { error: 'access_not_configured' });
            }
            const result = await shareLinkVerifier(req);
            if (!result.ok) return j(result.status, { error: result.error });
            accessEmail = result.email ?? null;

            // The redeem route, ABOVE the scope check on purpose: `/s/<id>`
            // names no workspace, so `collabScope` would refuse it as an
            // out-of-scope path and nobody could ever become a member. It is
            // the one path on this hostname a non-member may reach, and all
            // it can do is write the caller's own verified address down
            // against the workspace the link already names.
            const redeemMatch = pathname.match(/^\/s\/([^/]+)$/);
            if (redeemMatch && req.method === 'GET') {
              return redeemShareLink(safeDecodeSegment(redeemMatch[1] ?? ''), accessEmail);
            }

            // Every other request on this hostname is judged on MEMBERSHIP,
            // not on the link. `collabScope` is `shareScopeAllows` with the
            // path's own workspace as the target, so every operator verb a
            // share visitor is refused — the doc list, share administration,
            // folder binds, diff creation, DELETE, wholesale rewrite — is
            // refused here by the same lines, and a route added to one is
            // added to both.
            //
            // A path that names no workspace (root, `/api/docs`, anything
            // this deployment serves that is not a board's content) reaches
            // only the static app shell, which is what makes "root answers
            // nothing useful" true rather than asserted.
            //
            // The refusal is spelled exactly like the collaboration
            // hostname's, on purpose: two different bodies would tell a
            // signed-in stranger which guessed workspace ids are real.
            const scope = collabScope(pathname, req.method, {
              workspacesOf: shareWorkspacesOf,
              isMember: (wsId) => shareLinkMemberOf(wsId, accessEmail),
            });
            if (!scope.allowed) return j(403, { error: 'out_of_share_scope' });
            // An outsider like any other: identity rewritten to a guest, doc
            // metadata redacted, `visitor`-gated routes closed. No
            // `visitorShareId` — there is no Cloudflare share behind this.
            visitor = scope.target;
            // What there IS instead: the membership. Stamped on whatever this
            // request upgrades so that removing the member, or throwing the
            // master switch, can hang it up.
            visitorMemberKey =
              accessEmail && scope.target?.workspaceId
                ? shareMemberKey(scope.target.workspaceId, accessEmail)
                : null;
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
            // …and Access proves the visitor was admitted to the HOSTNAME,
            // not to a board behind it. `isMember` is the second condition:
            // the workspace the path names must list this email, through a
            // live share's allow list or the owner allowlist.
            //
            // The refusal is spelled exactly like the out-of-scope one, on
            // purpose. Two different bodies would tell an admitted
            // collaborator which guessed workspace ids are real, which is an
            // enumeration oracle over precisely the ids this check exists to
            // stop them opening.
            const scope = collabScope(pathname, req.method, {
              workspacesOf: shareWorkspacesOf,
              isMember: (wsId) => collabMemberOf(wsId, accessEmail),
            });
            if (!scope.allowed) return j(403, { error: 'out_of_share_scope' });
            // An outsider like any other: identity rewritten to a guest, doc
            // metadata redacted, `visitor`-gated routes closed. What it does
            // NOT get is a `visitorShareId` — there is no share behind it.
            visitor = scope.target;
          } else if (decision.kind === 'recall-callback') {
            // Recall's dedicated hostname. No Access token is demanded and
            // none could be presented: this caller is a vendor's backend.
            // What stands in for it is that the hostname serves TWO routes
            // and each one carries its own credential — a 128-bit per-bot
            // token in the websocket path, a Svix signature over the webhook
            // body — verified by the routes themselves one layer in. So the
            // gate's whole job here is to refuse everything else, and it is
            // an allowlist rather than a denylist: a route added to this
            // server tomorrow is closed on this hostname by default.
            //
            // 404 rather than 403, and rather than the 401 the operator
            // hostname answers: this name is not an address the product is
            // served on, so "there is nothing here" is both true and the
            // least it can say about what this deployment runs.
            //
            // Deliberately NOT under the external-access master switch above.
            // That switch answers "is anything reachable from outside right
            // now?" about workspace CONTENT reached by people; these two
            // routes read no doc and are reachable only by whoever holds a
            // token this server minted for one bot. Turning sharing off in
            // the middle of a meeting must not silently strand its bot.
            if (
              !recallCallbackAllows(pathname, req.method, {
                relayConfigured: recallRelay.configured(),
                webhookSecretSet: Boolean(opts.meetingBotWebhookSecret),
              })
            ) {
              return j(404, { error: 'not_found' });
            }
            // Nothing else: no `visitor`, no scope, no accessEmail. The two
            // routes below authenticate themselves.
          } else if (decision.kind === 'proxied-local') {
            // The operator's own hostname through the tunnel: an Access
            // application in front of it, and the WHOLE product behind it.
            // The token is the only thing between the tunnel and loopback
            // privileges, so it is demanded here REGARDLESS of whether shares
            // are wired — the legacy whole-server branch below stops running
            // the moment link sharing is configured, and prod has it.
            //
            // Non-null by construction (the host could not have classified
            // proxied-local otherwise), re-checked because "I could not
            // verify" must never mean "serve it".
            //
            // NOTHING SKIPS THE TOKEN HERE. Two requests used to — Recall's
            // bot callbacks, because the operator hostname was the only
            // public address this deployment had. They now arrive on a
            // hostname of their own (`recallCallbackHost`, handled above),
            // which is a strictly better trade: what a vendor's backend can
            // reach and what a person can reach are two names, and this one
            // is back to having no holes in it at all.
            if (!proxiedTrustedVerifier) {
              return j(503, { error: 'access_not_configured' });
            }
            const result = await proxiedTrustedVerifier(req);
            if (!result.ok) return j(result.status, { error: result.error });
            // A token is admission, not identity. The Access policy this
            // server cannot read may admit collaborators through the same
            // application, and their tokens verify exactly as the operator's
            // does. The verified email is the only thing that says WHO, so it
            // must be on the allowlist — folded the way the roster folds — or
            // the door stays shut. The body names nothing: not the email, not
            // that an allowlist exists.
            const who = result.email ? normalizeEmail(result.email) : '';
            if (who === '' || !proxiedTrustedEmails.has(who)) {
              return j(403, { error: 'forbidden' });
            }
            accessEmail = result.email ?? null;
            // Nothing else: no `visitor`, no scope. From here on the request
            // is what a loopback request is.
          } else if (cfAccessVerifier && !shares && !shareLinkVerifier) {
            // Legacy whole-server mode: cfAccess configured WITHOUT any
            // sharing surface means the entire deployment sits behind Access,
            // so even a local-looking Host must present a token. (With
            // sharing wired, local traffic is the agent's own MCP calls over
            // loopback and stays unauthenticated.)
            //
            // A share-link hostname counts as a sharing surface, and it has
            // to. The per-share mode it replaces is retired: an operator who
            // finishes draining those records and removes the old settings
            // would otherwise fall into this branch by deletion, and every
            // agent on the box would start being asked for an Access token it
            // has no way to hold.
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
        // a share visitor is already proven by Cloudflare Access, and this is
        // not a second way to claim an identity on a share host.
        // --- Widget popup-token gate ---
        // Resolve a presented token ONCE for the whole request, and fail
        // loudly: an invalid token 401s rather than silently downgrading the
        // write to anonymous — the widget hears "signed out" on the request
        // that proved it, not never. Runs below the host gate so a share
        // visitor's request is already scoped; runs above every route so no
        // write path can forget the check.
        {
          const rawWidgetToken = widgetBearerOf(req);
          if (rawWidgetToken !== null) {
            widgetIdentity = widgetTokenIdentityFor(rawWidgetToken, req.headers.get('origin'));
            if (widgetIdentity === null) return j(401, { error: 'widget_token_invalid' });
          }
        }

        /**
         * `true` when this request comes from a browser that has proven
         * nobody. The three proofs, in the order `authorFor` ranks them: a
         * widget popup-token, a Cloudflare Access claim, a session cookie —
         * the last two both resolved by `provenIdentityFor`.
         *
         * Shared by the write gate below and by the `/y/` upgrade, which is
         * the one write surface that is not an HTTP write: a markdown doc's
         * prose is edited over the websocket, so a gate that only looked at
         * methods would refuse the comment and wave the edit through.
         */
        const browserProvedNobody = (): boolean =>
          isBrowserRequest(req.headers) && widgetIdentity === null && provenIdentityFor() === null;

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

        // --- Recall's bot status-change webhook ---
        //
        // Workspace-level at the vendor, so it carries no token of ours and
        // arrives for every bot this account creates; the relay ignores bot
        // ids it does not know. Answered 200 even for an event we do not
        // model — a non-2xx makes the vendor retry, and retrying will not
        // make an unmodelled code become one.
        //
        // It lives under `/recall/` with the websocket upgrade below, and
        // IMMEDIATELY above it, both on purpose. One prefix is the whole bot
        // surface, which is what the dedicated callback hostname admits and
        // what a tunnel rule can be written against; and the upgrade's own
        // test is `startsWith('/recall/')`, so a status POST reaching it
        // first would be answered `404 unknown endpoint` by the token
        // lookup. Order is load-bearing — keep these two adjacent.
        if (pathname === RECALL_STATUS_PATH && req.method === 'POST') {
          const secret = opts.meetingBotWebhookSecret;
          // ARMED ONLY WHILE ITS CREDENTIAL IS CONFIGURED — on every host,
          // not just the dedicated callback one.
          //
          // `recallCallbackAllows` already closes this path on the callback
          // hostname when `RECALL_WEBHOOK_SECRET` is unset, precisely because
          // an unset secret used to mean "accept unsigned bodies". But the
          // route is reachable on every other admitting host class too, and
          // there the whole signature-and-replay block sat inside `if
          // (secret)`: an unauthenticated non-browser caller on the LAN or the
          // tailnet could inject arbitrary bot-status and calendar-sync
          // events, unsigned and unbounded by the replay guard. Unset is the
          // DEFAULT (`bin.ts` warns rather than refuses), so that was the
          // shipped state.
          //
          // 404 rather than 401: without a secret there is no credential this
          // route could check, so it is not a door that can be knocked on.
          if (!secret) return j(404, { error: 'not_found' });
          const raw = await req.text();
          {
            const svix = svixHeadersFrom(req.headers);
            const signed = await verifySvixSignature({ secret, body: raw, headers: svix });
            if (!signed) return j(401, { error: 'bad signature' });
            // Signed, so the id is the vendor's — and a repeat of it inside
            // the window is a captured request played back, not a delivery.
            // 409 rather than a quiet 200: the ticket asks that a replay be
            // REJECTED, and a rejection is what an operator reading the log
            // can act on. The cost is that a genuine at-least-once duplicate
            // from the vendor is retried against this 409 for a while; that
            // is noise, and it is the rarer of the two cases by far.
            // (Urgent-fixes ticket, 2026-09-02.)
            if (!webhookReplayGuard.admit(svix.id ?? '')) {
              return j(409, { error: 'replayed webhook', id: svix.id });
            }
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return j(400, { error: 'bad json' });
          }
          const event = parseBotStatusWebhook(parsed);
          if (event) recallRelay.onStatus(event);
          // The same Svix-signed endpoint carries the CALENDAR webhooks —
          // webhooks are workspace-level at the vendor — so a body that is
          // not a bot status may be a `calendar.sync_events`. Consumed after
          // the 200 is decided: the vendor's contract is "you got it", and a
          // list-and-reconcile that takes seconds must not make it retry.
          if (!event && calendarSync) {
            const sync = parseCalendarSyncWebhook(parsed);
            if (sync) {
              calendarSync.onSync(sync).catch((err: unknown) => {
                console.error('[calendar] sync_events consume failed:', err);
              });
            }
          }
          return j(200, { ok: true });
        }

        // --- WebSocket upgrade: Recall dialling US with a bot's words ---
        //
        // NO Origin check, unlike `/audio/` and `/y/` below. That guard exists
        // because a browser will open a socket from any page the user visits
        // and hand it the data regardless of CORS. This caller is a vendor's
        // backend: there is no origin, and requiring one would refuse every
        // real connection. The unguessable per-bot token in the path is the
        // authentication — 128 CSPRNG bits, one bot, forgotten when that
        // bot's meeting ends (see RecallMeetingRelay's mintToken).
        if (pathname.startsWith('/recall/')) {
          const token = decodeURIComponent(pathname.slice('/recall/'.length));
          // Shape-checked before it is looked up so a lookup is never the
          // thing that distinguishes a malformed token from an unknown one.
          if (!/^[0-9a-f]{32}$/.test(token) || !recallRelay.acceptsToken(token)) {
            return j(404, { error: 'unknown endpoint' });
          }
          const upgraded = server.upgrade(req, {
            data: { docId: '', token, kind: 'recall' as const },
          });
          if (!upgraded) return new Response('upgrade required', { status: 426 });
          return undefined;
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
          // The SAME sign-in decision `/y/` makes two branches down, for a
          // surface that is write-only: a meeting opens a billed engine
          // session and writes transcript and notes into the doc, and the
          // method-keyed write gate cannot see it because a websocket
          // upgrade is a GET. Carried rather than refused at the handshake
          // so the strip can render the reason (meeting-protocol.ts refuses
          // the `start` frame); an upgrade refused here reaches the page as
          // a bare error event with no body to show.
          const audioReadOnly = requireSignInToWrite && browserProvedNobody();
          const upgraded = server.upgrade(req, {
            data: {
              docId,
              kind: 'audio' as const,
              // WHAT AUTHORIZED THIS SOCKET, carried for its life, exactly as
              // `/y/` carries it below. A websocket is authorized once at its
              // upgrade, so revoking a share, removing a member and throwing
              // the sharing master switch all have to be able to find the
              // connections that grant opened. Without these two the sweeps
              // closed the editor and left an open microphone running a
              // billed transcription session against a doc the person may no
              // longer read. `Rooms.trackShareSocket` is the other half: this
              // socket is in no room's `conns` for a sweep to walk.
              ...(visitorShareId ? { shareId: visitorShareId } : {}),
              ...(visitorMemberKey ? { shareMember: visitorMemberKey } : {}),
              ...(audioReadOnly ? { readOnly: true } : {}),
            },
          });
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
          // Decided BEFORE the creation below, not after it. Creating a room
          // and filing a workspace row is a write like any other, and it used
          // to run above this line: a browser that had proven nobody could
          // open `/y/<any-new-id>?type=mockup` and make the server create a
          // doc and file it under the hub workspace, with the read-only carry
          // only stopping the ydoc edits that came afterwards.
          const readOnly = requireSignInToWrite && browserProvedNobody();
          if (!rooms.get(docId)) {
            if (type === 'mockup') {
              // Nothing to read yet, so refusing here gates no read: the doc
              // this socket would have created does not exist for anybody.
              if (readOnly) return j(401, signInRequiredBody());
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
          // READ-ONLY, not refused. The editing socket is also the READING
          // socket — a markdown doc's text arrives over it and nowhere else
          // — so refusing the upgrade would gate reading, which this gate
          // must never do. The socket opens, sync step 1 hands over the
          // whole doc, and `onMessage` drops anything that would change it
          // (see yjs-protocol.ts). Decided once here, at the handshake, and
          // then carried for the life of the connection: the same shape the
          // share authorization uses two lines up.
          const upgraded = server.upgrade(req, {
            data: {
              docId,
              ...(visitorShareId ? { shareId: visitorShareId } : {}),
              ...(visitorMemberKey ? { shareMember: visitorMemberKey } : {}),
              ...(readOnly ? { readOnly: true } : {}),
            },
          });
          if (!upgraded) return new Response('upgrade required', { status: 426 });
          return undefined;
        }

        // --- SSE (agent-level): every key ONE agent watches, on ONE socket. ---
        //
        // The route that ends the socket-per-watch storm. An MCP child used to
        // open a TCP connection per watched key, so a lead holding 214 watches
        // held 214 sockets; on 2026-09-04 the fleet exhausted this machine's
        // kernel socket memory and the supervisor read the resulting connect
        // failures as an unbound server, restarting it twenty times. The
        // per-key routes below are untouched — a session on the previous
        // bundle keeps using them through the rollout.
        //
        // The channel set is the agent's DURABLE watch set, so this route
        // needs no key list from the caller: the same set a respawn restores
        // from is the one the stream fans out, and `watch_doc` reaches an open
        // stream through the store's change hook rather than a reconnect.
        const agentEventsMatch = pathname.match(/^\/events\/agent\/([^/]+)$/);
        if (agentEventsMatch) {
          // A share visitor never opens one. The same posture the watches REST
          // route takes, and for a stronger reason: this stream carries every
          // channel one agent watches, which is a superset of any one board.
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const streamAgentId = decodeURIComponent(agentEventsMatch[1] ?? '');
          if (!isValidAgentId(streamAgentId)) return j(400, { error: 'bad agentId' });
          if (SHARED_AGENT_IDS.has(streamAgentId)) {
            // Same refusal the watch store makes: a set keyed on the shared
            // identity is every anonymous session's watches at once, so a
            // stream over it would deliver everybody's events into each of
            // them. Those sessions keep the per-key routes.
            return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
          }
          return openAgentMuxStream({
            hub: sse,
            agentId: streamAgentId,
            keys: () => agentWatches.list(streamAgentId, watchKeyExists).watches.map((w) => w.key),
            channelFor: (key) => channelForWatchKey(key, canonicalDocId),
            cursors: parseMuxCursor(sseLastEventId(req, url)),
            onWatchSetChanged: (cb) => agentWatches.onChange(streamAgentId, cb),
          });
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
            visitorMemberKey ?? undefined,
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
            visitorMemberKey ?? undefined,
          );
        }

        // --- REST: what this process currently costs ---
        //
        // The 2026-08-29 jetsam kill left nothing to read: the server was at
        // 2.6 GB and the only evidence of how it got there was the absence of
        // the process. `Rooms.stats()` is also written to the log every five
        // minutes; this route is the same numbers on demand, so the NEXT
        // incident can be sampled over time instead of reconstructed.
        //
        // Counts only — no doc ids, no paths, no titles. That is what makes
        // it safe to leave un-gated for anyone already past the front door,
        // and it still refuses a share visitor: an external reviewer invited
        // to one document has no business reading how many others exist.
        /**
         * Run the one-shot summary backfill NOW, on request.
         *
         * It used to be reachable only by restarting the server with
         * CW_SUMMARY_BACKFILL=1, which made a piece of catch-up work into a
         * reason to bounce the process — the opposite of what a cheap boot
         * is for. It is the same sweep with the same pacing and the same
         * skip-if-summarized rule; what changed is that asking for it no
         * longer costs a restart.
         *
         * Still deliberate rather than automatic: the backlog is hundreds of
         * billed calls, so nothing schedules this. Somebody asks.
         */
        if (pathname === '/api/summaries/backfill' && req.method === 'POST') {
          if (visitor) return j(403, { error: 'not available to share visitors' });
          const body = await safeJson(req);
          const minutes = Number(body?.windowMinutes ?? 15);
          const windowMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
          const { queued, open, resolved } = rooms.backfillSummaries({ windowMs });
          return j(200, { ok: true, queued, open, resolved, windowMs });
        }

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
          // Every file node carries the same absolute `reviewUrl` /tree and
          // /files build, and this route is on the same visitor allowlist
          // line — see redactWorkspaceGroupedForVisitor.
          return j(
            200,
            visitor ? redactWorkspaceGroupedForVisitor(grouped, visitor.workspaceId) : grouped,
          );
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
          // `not-listed` is a 404 on purpose: the tree does not show the
          // file, and whether it exists is exactly what must not be told.
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
        // the client's routing (`navFromPath` in hub-presence-model), so all four are
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
              // The board is the whole of what a visitor was given, so the
              // shell leaves out the "all workspaces" arrow rather than
              // painting a link to a 403.
              visitor: Boolean(visitor),
              sentry: browserSentry,
              assets: readAppAssetManifest(markdownAppDist),
            }),
            { headers: HTML_SHELL_HEADERS },
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
          const rel = pathname.slice('/app/'.length);
          const p = join(markdownAppDist, rel);
          const resp = serveStaticUnder(markdownAppDist, p, appCacheControl(basename(rel)));
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

        // --- Sign-in page ---
        // Server-rendered shell like the hub's, so the route works — and the
        // page's behavior all lives in /app/signin.js. Identity, not access:
        // the tailnet reaches everything signed out; this page only lets a
        // person claim who they are (`/api/auth/*` above).
        if (pathname === '/signin' && req.method === 'GET') {
          // Turned off under access-only: the page's whole job is to prove an
          // address, and Access proved one before the request arrived. 404
          // rather than a redirect, so nothing links here and nothing lands
          // here — a dead end is exactly what this removes.
          if (!emailCodeSignIn) return j(404, { error: 'not_found' });
          return new Response(
            renderSigninShell(browserSentry, readAppAssetManifest(markdownAppDist)),
            { headers: HTML_SHELL_HEADERS },
          );
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
          // The landing banner's join files its doc under the default board
          // (the join POST carries no workspaceId from `/`), so the offer
          // names that destination on its face.
          // `no-store` like every other shell, and this one has a second
          // reason of its own: the page IS the model — workspace rows,
          // waiting counts, "active in the last N days". Served with no cache
          // directives at all, as it was, a browser picks its own freshness
          // lifetime and can show a queue that has since been worked.
          return new Response(
            renderLanding(
              model,
              browserSentry,
              DEFAULT_HUB_WORKSPACE_NAME,
              readAppAssetManifest(markdownAppDist),
            ),
            { headers: HTML_SHELL_HEADERS },
          );
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
          return new Response(
            renderProjectPage(
              owner,
              artifacts,
              browserSentry,
              readAppAssetManifest(markdownAppDist),
            ),
            { status: artifacts.length === 0 ? 404 : 200, headers: HTML_SHELL_HEADERS },
          );
        }

        return new Response('not found', { status: 404 });
      }
    },
    websocket: {
      // Yjs sync step 2 hands a fresh tab the WHOLE room state in one binary
      // frame. Measured over the live hub board's persisted state on
      // 2026-08-29: 1,264,566 bytes, deflating to 431,733 — 2.9×, or 813 KB
      // this server stops sending on every board open, every tab, every
      // reconnect. Every browser offers the extension already; the server
      // only had to accept it and ask for compression per send.
      //
      // How much WALL TIME that buys is a property of the reader's link, and
      // this repo has no trustworthy measurement of Bryan's — so the claim
      // here is the byte count, which is measured, and not a number of
      // seconds, which would not be. Audio frames are opaque and already
      // codec-compressed; they do not shrink, and the cost is one deflate
      // context per socket.
      perMessageDeflate: true,
      open(ws) {
        if (ws.data.kind === 'recall') return;
        if (ws.data.kind === 'audio') {
          // Before the relay, because the relay's own bookkeeping is a
          // WeakMap nothing can enumerate: this is what makes the socket
          // reachable by the share sweeps in `rooms.ts`. A socket carrying
          // neither stamp — the owner's — is not tracked at all.
          rooms.trackShareSocket(ws);
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
        if (ws.data.kind === 'recall') {
          // Text only. Recall's realtime transcript events are JSON frames;
          // this endpoint subscribes no binary media, so a binary frame here
          // is not ours to interpret.
          if (typeof message === 'string' && ws.data.token) {
            recallRelay.onSocketText(ws.data.token, message);
          }
          return;
        }
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
        if (ws.data.kind === 'recall') {
          // NOT the end of the meeting — see RecallMeetingRelay.onSocketClose.
          if (ws.data.token) recallRelay.onSocketClose(ws.data.token);
          return;
        }
        if (ws.data.kind === 'audio') {
          rooms.untrackShareSocket(ws);
          meetingRelay.onClose(ws);
          return;
        }
        onClose(ws as unknown as FeedbackWs);
      },
    },
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
    const meta = rooms.peekMeta(docId);
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
      // below are still live — after `rooms.flush()` that write would have
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
      rooms.stop();
      rooms.flush();
      // Hand the next process each channel's final event id. Without it every
      // subscriber's cursor is unrecognisable after the restart and every
      // stream opens with a `replay.gap` that has nothing behind it.
      saveReplayMarks(dataDir, sse.marks());
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
