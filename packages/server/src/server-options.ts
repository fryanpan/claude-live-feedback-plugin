/**
 * Everything `createServer` can be handed, and what each option MEANS.
 *
 * Its own module because it is the one type the whole process is configured
 * through, and it used to live in `server.ts` — which imports `routes/`, so
 * anything naming it closed a cycle. Six modules worked around that by
 * hand-copying the two or three fields they read into a structural type, each
 * with a comment explaining the cycle; `routes/meetings-calendar.ts` did not,
 * and imported the type out of `server.ts` instead, which is the import
 * direction the layers forbid.
 *
 * Nothing here is behaviour. It is a declaration plus the reasoning for each
 * default, which is why the file is long and why splitting it by subject
 * would only scatter one type across several files. `server.ts` re-exports it
 * so callers that address it there keep working.
 *
 * The values these options are RESOLVED from live in `server-config.ts`;
 * `bin.ts` reads that config and constructs the object below.
 */
import type { CodeSender } from './auth/code-sender.ts';
import type { Deployer } from './deploy.ts';
import type { WatchFactory } from './dispatch-registry.ts';
import type { EffortEstimator } from './effort-estimator.ts';
import type { GoogleOauthApp, RefreshTokenVault } from './google-oauth.ts';
import type { MeetingNotesOptions } from './meeting-notes.ts';
import type { CfAccessOptions } from './middleware/cf-access.ts';
import type { NoteAskJudge } from './note-ask.ts';
import type { PluginRefresher } from './plugin-refresh.ts';
import type { PushFetch } from './push-notify.ts';
import type { RecallCalendarClient } from './recall-calendar.ts';
import type { RecallClient } from './recall.ts';
import type { ReviewJudge } from './review-judge.ts';
import type { CfApi } from './share/cf-api.ts';
import type { ShareConfig } from './share/types.ts';
import type { ThreadSummarizer } from './summarize.ts';
import type { TranscriptionEngine } from './transcribe.ts';
import type { VoiceComplete } from './voice.ts';

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
   * Whether the two agent-id-keyed routes refuse a caller that presents no
   * `at1` agent token: `GET /api/agents/<id>/watches` and
   * `GET /events/agent/<id>`.
   *
   * Defaults to FALSE — the deprecation window, not an opinion about the
   * gate. Presenting the token needs the MCP child to change, and that ships
   * in a plugin bundle each peer updates on their own schedule; refusing an
   * un-updated child would take its watch restore and its whole event stream
   * away mid-session. The shape gate (loopback, not a browser, not through
   * the edge) is enforced on both routes regardless of this flag. The
   * deployment switch is `CW_REQUIRE_AGENT_TOKEN`; see auth/agent-token.ts.
   */
  requireAgentToken?: boolean;
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
   * Confirms that a task note the deterministic prefilter flagged really does
   * say the agent is waiting on a person, so the stall loop can call the row
   * `blocked-on-owner-unfiled` on the strength of its own prose
   * (`note-ask.ts`). **No default**, the same seam rule as the review judge:
   * omitting it leaves the prefilter deciding alone and nothing that merely
   * spins a server up reaches the network. `bin.ts` constructs the real one
   * (`haikuNoteAskJudge`); tests pass a stub.
   */
  noteAskJudge?: NoteAskJudge;
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
  /**
   * How long a row the lead was already told about may stay a finding before
   * the board files a review item over the lead's head (default
   * `STALL_ESCALATE_DEFAULT_MS`, one hour; `CW_STALL_ESCALATE_MINUTES` sets it
   * on the box).
   *
   * Deployment-tunable for the same reason `stallNudgeRepeatMs` is, one step
   * more expensive: what this number spends is a PERSON's attention, and the
   * right interval is a thing an owner discovers by living with it.
   */
  stallEscalateMs?: number;
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
   * `CW_PUBLIC_BASE_URL` at boot so a typo fails there rather than here.
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
