#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { positiveEnvDuration, readRenamedEnv } from '@feedback/core/env-names';
import { resolvePostmarkCodeSender } from './auth/postmark-code-sender.ts';
import { clientReleaseStatus, resolveClientDists } from './client-release.ts';
import { createDeployer } from './deploy.ts';
import { effortEstimateEnabled, haikuEffortEstimator } from './effort-estimator.ts';
import { installLogSquelch } from './log-squelch.ts';
import { createHaikuNotesComposer } from './meeting-notes-composer.ts';
import { createHaikuTaskCaptureExtractor } from './meeting-task-capture.ts';
import { createPluginRefresher } from './plugin-refresh.ts';
import { acquirePort, classifyBindError, probeLocalPort, shouldWalkPorts } from './port-bind.ts';
import { lanHostnames, normalizePublicBaseUrl, tailscaleHost } from './public-host.ts';
import { haikuReviewJudge, reviewGateEnabled } from './review-judge.ts';
import { captureServerError, flushServerSentry, initServerSentry } from './sentry.ts';
import { createServer } from './server.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { TTL_FORMAT_HINT, parseTtl } from './share/ttl.ts';
import { KEYCHAIN_SERVICE, ThreadSummarizer } from './summarize.ts';
import {
  KEYCHAIN_SERVICE as ASSEMBLYAI_KEYCHAIN_SERVICE,
  createAssemblyAiEngine,
} from './transcribe-assemblyai.ts';
import { haikuVoiceComplete } from './voice.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const args = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) return args[idx + 1] ?? fallback;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  return fallback;
}

const requestedPort = Number(arg('port', process.env.PORT ?? '8787'));
const dataDir = arg('data-dir', join(repoRoot, 'data'));

// Which browser bundles to serve. PROD passes published release directories
// (see client-release.ts) so the served client is NOT read out of a git
// working tree someone may be editing or switching branches in. Unset — `bun
// run dev`, `bun run staging`, a bare bin.ts — falls back to this checkout's
// own dist, which is what those want.
const { widget: widgetDist, markdownApp: markdownAppDist } = resolveClientDists({
  widgetDist: arg('widget-dist') ?? readRenamedEnv(process.env, 'CW_WIDGET_DIST'),
  markdownAppDist: arg('markdown-app-dist') ?? readRenamedEnv(process.env, 'CW_MARKDOWN_APP_DIST'),
  repoRoot,
});
const demosDir = pathOrNull(join(repoRoot, 'demos'));

// The external origin this deployment is reached on, when something in front
// terminates TLS. Validated HERE, at boot, so a typo is a startup failure
// somebody reads rather than a server that runs happily while handing out
// links to an origin nobody meant to publish. Unset is the normal case and
// falls back to `http://<discovered host>:<port>`.
const publicBaseUrlOverride =
  normalizePublicBaseUrl(
    arg('public-base-url') ?? readRenamedEnv(process.env, 'CW_PUBLIC_BASE_URL'),
  ) ?? undefined;

// The release root this deployment PUBLISHES into, which is what lets the
// board say "your browser is running a client from three days ago because the
// build has been failing". PROD passes it (scripts/serve.ts --no-watch);
// nothing else may, because dev and staging serve their own checkout's dist
// while sharing this machine's default release root — they would report prod's
// deploy state as their own. Same seam rule as the plugin refresher.
const clientReleaseRootDir = arg('client-release-root') ?? null;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const sentryDsn = readRenamedEnv(process.env, 'CW_SENTRY_DSN')?.trim();

// Server-side Sentry: traces + error capture for THIS process, independent
// of the `sentryDsn` handed to `createServer` below (that one only ever
// reaches the browser as a meta tag — see sentry.ts for why the two are
// deliberately not the same init path). Same env var, same "no DSN, no SDK,
// no outbound request" contract. The release is the deploy this process is
// running, read the same way the board reads a peer's own version: from the
// published release's provenance file, when this start is one (prod). Dev
// and staging run straight from a checkout with no release directory, so
// `sourceRef` is absent there — Sentry just omits the release tag rather
// than guessing at one.
if (sentryDsn) {
  const releaseSourceRef = clientReleaseRootDir
    ? clientReleaseStatus(clientReleaseRootDir).sourceRef
    : null;
  await initServerSentry({ dsn: sentryDsn, release: releaseSourceRef });
  // A crash Sentry never gets to see is the exact failure mode this exists
  // to fix — so these two catch what a request-scoped span cannot: an error
  // that isn't inside any one request. Capture, THEN preserve Bun's default
  // behavior (log + exit non-zero) rather than silently swallowing it.
  process.on('uncaughtException', (err) => {
    captureServerError(err, { phase: 'uncaughtException' });
    console.error('[feedback] uncaught exception', err);
    void flushServerSentry().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    captureServerError(reason instanceof Error ? reason : new Error(String(reason)), {
      phase: 'unhandledRejection',
    });
    console.error('[feedback] unhandled rejection', reason);
    // Registering ANY listener here overrides Bun's own default handling
    // (log + crash) — without this exit, an unhandled rejection would go
    // from fatal to merely logged the moment Sentry is configured, leaving
    // the process alive in whatever state produced the rejection. Match the
    // uncaughtException handler above so enabling Sentry never changes
    // whether the process survives an otherwise-fatal error, only whether
    // it gets seen before exiting.
    void flushServerSentry().finally(() => process.exit(1));
  });
}

// How long ready, agent-owned work may sit untouched before the board wakes
// its lead (ready-nudge.ts). Minutes rather than ms because it is a number an
// operator types.
const readyNudgeIdleMs = positiveEnvDuration(process.env, 'CW_READY_NUDGE_MINUTES', MINUTE_MS);

// How long a row may go untouched before the board tells its lead it has
// STALLED (stall-nudge.ts) — a different question from the one above, which
// asks whether ready work has been picked up.
const stallNudgeQuietMs = positiveEnvDuration(process.env, 'CW_STALL_NUDGE_MINUTES', MINUTE_MS);

// How many quiet windows a row with a WATCHING builder dispatch gets before
// the board calls its builder silent (stall-gate.ts). A bare multiplier —
// unit 1 — rather than its own duration, so it scales whatever the quiet
// window above is set to.
const stallBuilderSilentMultiplier = positiveEnvDuration(
  process.env,
  'CW_BUILDER_SILENT_MULTIPLIER',
  1,
);

// How long the board waits before saying the SAME unchanged stall again
// (stall-nudge.ts). Hours, not minutes, because this one is priced in a
// woken lead's whole turn rather than in a tick: a wake costs the lead
// session real tokens whether or not anything changed, so the repeat window
// is the knob that sets the standing floor on that cost. Tunable without a
// release for exactly that reason.
const stallNudgeRepeatMs = positiveEnvDuration(process.env, 'CW_STALL_REPEAT_HOURS', HOUR_MS);

// How long a review item the quality gate HELD may stand before the stall
// loop complains to its filer and then to the lead (stall-gate.ts). Minutes,
// like the stall window, and much shorter than it: a held item's filer was
// told in the same tool result, and revising is one call.
const heldReviewItemMs = positiveEnvDuration(process.env, 'CW_HELD_ITEM_MINUTES', MINUTE_MS);

// Extra hostnames to treat as LOCAL. Loopback, the tailnet name, this
// machine's LAN names, and private IPv4 ranges are detected automatically;
// this covers anything we can't detect (a reverse proxy in front, a custom
// /etc/hosts alias). Everything else is denied — see middleware/host-guard.ts.
/**
 * Browser origins allowed to call the API cross-origin, beyond this machine's
 * own names — which are allowed automatically, so the widget on a local dev
 * server needs no configuration. Set this only for a dev server on a DIFFERENT
 * machine. Without it the option would be unreachable from the shipped binary,
 * and a config knob nobody can turn is the same bug as not having one.
 *
 * UNDERSTAND WHAT THIS GRANTS: an origin listed here can read ANY FILE this
 * process can read. A page on an allowed origin may open
 * `/y/<id>?type=mockup&sourceUrl=/abs/path`, which auto-creates the doc, then
 * fetch `/mockup/<id>`. That is inherent to the local trust model — loopback
 * already has it — but this knob hands the same primitive to another machine,
 * and those origins are also the only ones granted
 * Access-Control-Allow-Private-Network. List an origin only if you would
 * equally trust it with your home directory.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * CW_SHARING_DISABLED=1 — external sharing starts OFF and the runtime toggle
 * (`POST /api/share/enabled`, the `set_sharing_enabled` MCP tool) refuses to
 * reopen it. Use this while a security review is in flight: it is the one
 * setting nothing the server exposes can undo, so a compromised or
 * misbehaving caller cannot reopen the door.
 *
 * For an ordinary on/off, leave this unset and use the runtime toggle — that
 * state persists in <dataDir>/sharing.json across restarts.
 */
const sharingEnvLocked = ['1', 'true', 'yes'].includes(
  (readRenamedEnv(process.env, 'CW_SHARING_DISABLED') ?? '').trim().toLowerCase(),
);

/**
 * Email-keyed identity is IN EFFECT. Default off, and off means a request
 * with a session cookie is attributed exactly as it is attributed today.
 * The `/api/auth/*` routes are mounted either way — see ServerOptions.
 */
const requireEmailAuth = ['1', 'true', 'yes'].includes(
  (process.env.CW_REQUIRE_EMAIL_AUTH ?? '').trim().toLowerCase(),
);

/**
 * The address whose email identity is the fleet owner. Without it,
 * `isOwnerActor` keeps matching only the two pre-email spellings, and the
 * day the owner signs in by email the owner-activity view quietly reads
 * empty — see activity.ts.
 */
const ownerEmail = (process.env.CW_OWNER_EMAIL ?? '').trim();

const trustedHosts = (process.env.TRUSTED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h !== '');

// Cloudflare Access gate. When `share` is also configured, this gate
// is wired to the shares registry so each share-<slug> hostname uses
// its own AUD; the env-var AUD is then a static fallback for legacy
// single-share use.
const cfAccessTeam = process.env.CF_ACCESS_TEAM_DOMAIN;
const cfAccessAud = process.env.CF_ACCESS_AUD;
// No AUD → no `audience` at all, not a placeholder string. The server asks
// "is a static audience configured?" by the TYPE of this field, and a string
// placeholder answered yes — leaving every fail-closed host rule depending on
// this file remembering to empty the lists. Absent, the verifier refuses every
// token on its own, and the shares registry still overrides it per hostname.
const cfAccess = cfAccessTeam
  ? { teamDomain: cfAccessTeam, ...(cfAccessAud ? { audience: cfAccessAud } : {}) }
  : undefined;

/**
 * Hostnames the Cloudflare tunnel serves that should reach the COLLABORATION
 * surface from outside the tailnet — the share surface, gated by an Access
 * application over that hostname.
 *
 * Deliberately NOT `TRUSTED_HOSTS`. That variable means "another name for this
 * machine on a network I control" and its entries classify `local`, which is
 * the whole product with no authentication at all; quietly widening it would
 * grant tunnel access to every name added for a LAN reason. The `cf-ray` veto
 * in host-guard stays exactly as it was — an entry here classifies `collab`,
 * never `local`.
 *
 * Honoured ONLY with `CF_ACCESS_TEAM_DOMAIN` *and* `CF_ACCESS_AUD` set: the
 * hostname has its own Access application, so it has its own AUD tag, and
 * without one there is nothing to verify a token against. The server refuses
 * the list on its own (see `collabAccessVerifier`); this is the loud half, so
 * a misconfiguration reads as a misconfiguration instead of as a hostname
 * that mysteriously 403s.
 */
const accessTunnelHosts = (process.env.CF_ACCESS_TUNNEL_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h !== '');
const accessTunnelReady = Boolean(cfAccessTeam && cfAccessAud);
if (accessTunnelHosts.length && !accessTunnelReady) {
  console.error(
    `[feedback] IGNORING CF_ACCESS_TUNNEL_HOSTS (${accessTunnelHosts.join(', ')}): ` +
      'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must BOTH be set, or there is no ' +
      'Access application in front of those hostnames and they would expose the ' +
      'server to anyone who can reach the tunnel. They will answer 403 unknown_host.',
  );
}

/**
 * Hostnames the Cloudflare tunnel serves that are the OPERATOR'S OWN address —
 * the whole product from outside the tailnet, behind a Cloudflare Access
 * application over that hostname.
 *
 * The third list. `TRUSTED_HOSTS` is a LAN name (local, no token, refused
 * through the proxy); `CF_ACCESS_TUNNEL_HOSTS` is for collaborators (token,
 * then the share surface); this one is for the operator (token, then
 * everything loopback gets). Kept apart from both because it grants the most,
 * and a host listed here AND as a collaboration host stays collab — the
 * server resolves the contradiction toward the narrower grant, and the boot
 * log says so rather than leaving it to be discovered as a 403.
 *
 * Honoured ONLY with `CF_ACCESS_TEAM_DOMAIN` *and* `CF_ACCESS_AUD` set, for the
 * same reason as the collaboration list and with more at stake: without an
 * Access application to verify against, honouring the list would be the full
 * API — every doc, share administration, the deploy verb — to anyone who can
 * reach the tunnel and type the hostname. The server refuses on its own (see
 * `proxiedTrustedVerifier`); this is the loud half.
 */
const proxiedTrustedHosts = (readRenamedEnv(process.env, 'CW_PROXIED_TRUSTED_HOSTS') ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter((h) => h !== '');
if (proxiedTrustedHosts.length && !accessTunnelReady) {
  console.error(
    `[feedback] IGNORING CW_PROXIED_TRUSTED_HOSTS (${proxiedTrustedHosts.join(', ')}): ` +
      'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must BOTH be set, or there is no ' +
      'Access application in front of those hostnames and they would expose the ' +
      'WHOLE product to anyone who can reach the tunnel. They will answer 403 unknown_host.',
  );
}
/**
 * WHO the operator is, by verified Access email — the check that makes the
 * list above the operator's door rather than a door for everyone the Access
 * application admits.
 *
 * A valid token proves admission by a policy this server cannot read. One
 * application may cover the collaboration hostnames too, and then every
 * collaborator's token is just as valid here. So after the token, the
 * verified email must be on this list, or the request is refused. Defaults to
 * CW_OWNER_EMAIL; with NEITHER set the host list is ignored, because a door
 * that cannot tell the operator from a collaborator must not open.
 */
const proxiedTrustedEmails = (process.env.CW_PROXIED_TRUSTED_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim())
  .filter((e) => e !== '');
if (proxiedTrustedEmails.length === 0 && ownerEmail) proxiedTrustedEmails.push(ownerEmail);
const proxiedTrustedReady = accessTunnelReady && proxiedTrustedEmails.length > 0;
if (proxiedTrustedHosts.length && accessTunnelReady && proxiedTrustedEmails.length === 0) {
  console.error(
    `[feedback] IGNORING CW_PROXIED_TRUSTED_HOSTS (${proxiedTrustedHosts.join(', ')}): ` +
      'no operator allowlist. Set CW_PROXIED_TRUSTED_EMAILS (or CW_OWNER_EMAIL), or an ' +
      'Access token from ANYONE the application admits — every collaborator on the same ' +
      'app — would reach the whole product. They will answer 403 unknown_host.',
  );
}
const alsoCollab = proxiedTrustedHosts.filter((h) =>
  accessTunnelHosts.some((c) => c.toLowerCase() === h.toLowerCase()),
);
if (alsoCollab.length) {
  console.error(
    `[feedback] CW_PROXIED_TRUSTED_HOSTS overlaps CF_ACCESS_TUNNEL_HOSTS (${alsoCollab.join(', ')}): ` +
      'a hostname on both lists is served as a COLLABORATION host — Access token, ' +
      'share surface, operator verbs refused. Remove it from one list to say which you meant.',
  );
}

// Sharing.
//
// LINK mode needs only CF_SHARE_PUBLIC_HOSTNAME — the single hostname the
// tunnel serves. No Cloudflare account, no Zero Trust team, no API token.
//
// ACCESS mode (per-share hostnames behind Cloudflare Access) additionally
// needs CF_SHARE_BASE_HOSTNAME + CF_ACCOUNT_ID + CF_ACCESS_TEAM_DOMAIN; the
// API token comes from the macOS Keychain via the share module's reader.
const accessShareConfigured = Boolean(
  process.env.CF_SHARE_BASE_HOSTNAME && process.env.CF_ACCOUNT_ID && cfAccessTeam,
);
const publicHostname = process.env.CF_SHARE_PUBLIC_HOSTNAME;
// Optional ceiling on every share's TTL, in the same grammar `share_link`
// takes (`30d`, `72h`). A mint or extension asking for more is clamped and
// told so. Unset = no ceiling; a value the grammar cannot read is a startup
// error rather than a silently absent ceiling.
const maxTtlRaw = process.env.CF_SHARE_MAX_TTL;
const maxTtlSeconds = maxTtlRaw ? parseTtl(maxTtlRaw) : null;
if (maxTtlRaw && (maxTtlSeconds === null || maxTtlSeconds <= 0)) {
  console.error(
    `CF_SHARE_MAX_TTL=${JSON.stringify(maxTtlRaw)} is not a positive duration — ${TTL_FORMAT_HINT}`,
  );
  process.exit(1);
}
const shareConfig =
  accessShareConfigured || publicHostname
    ? {
        ...(process.env.CF_ACCOUNT_ID ? { cfAccountId: process.env.CF_ACCOUNT_ID } : {}),
        ...(cfAccessTeam ? { cfTeamDomain: cfAccessTeam } : {}),
        ...(process.env.CF_SHARE_BASE_HOSTNAME
          ? { baseHostname: process.env.CF_SHARE_BASE_HOSTNAME }
          : {}),
        ...(publicHostname ? { publicHostname } : {}),
        ...(maxTtlSeconds ? { maxTtlSeconds } : {}),
      }
    : null;
const share = shareConfig
  ? {
      config: shareConfig,
      // Only read the Keychain when Access mode is actually configured —
      // the reader throws when the entry is missing, and a link-only
      // deployment has no reason to hold a Cloudflare token at all.
      ...(accessShareConfigured
        ? { cfApiToken: readKeychainPassword('cloudflare-api-token') }
        : {}),
    }
  : undefined;

// The ONLY place a real summarizer is constructed. `createServer` has no
// default, so nothing that merely spins a server up — every test in
// packages/server/test, every embedded use — can reach the network or the
// key. An absent key or CW_SUMMARIES=0 makes every call on it a no-op.
const summarizer = new ThreadSummarizer();

// The ONLY place a real email sender is constructed, for the same reason the
// summarizer is: `createServer` defaults to the log sender, so nothing that
// merely spins a server up — every test, every embedded use — can reach the
// network or the Keychain. Resolving never throws; a partial setup keeps the
// log sender and says which piece is missing, because during setup that is
// the normal state rather than an error.
const codeSenderChoice = resolvePostmarkCodeSender(process.env, readKeychainPassword);
if (codeSenderChoice.reason) console.log(`[auth] ${codeSenderChoice.reason}`);
else console.log('[auth] login codes send via Postmark');

// Hourly abuse ceilings on the login-code mailer. Unset or not a positive
// number → the defaults in auth/email-code.ts; there is deliberately no
// value that turns a ceiling OFF.
const positiveIntEnv = (name: string): number | undefined => {
  const n = Number((process.env[name] ?? '').trim() || Number.NaN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};
const authGlobalStartsPerHour = positiveIntEnv('CW_AUTH_GLOBAL_STARTS_PER_HOUR');
const authPeerStartsPerHour = positiveIntEnv('CW_AUTH_PEER_STARTS_PER_HOUR');

// The ONLY place the real voice fast-path completer is constructed — the
// same seam rule (and the same dedicated-key consent) as the summarizer.
// Absent key → null → the fast path is off and voice routes to the agent.
const voiceComplete = haikuVoiceComplete();

// The ONLY place the real review-item judge is constructed — same seam rule
// and the SAME dedicated-key consent as the summarizer, because what leaves
// the machine is the item's own text. Absent key or CW_REVIEW_GATE=0 → null
// → every item passes unjudged, which is the documented "gate off" state.
const reviewJudge = haikuReviewJudge();
if (!reviewJudge) {
  console.log(
    reviewGateEnabled()
      ? '[review-gate] no summary API key; review items pass unjudged. ' +
          `Add one with: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`
      : '[review-gate] off (CW_REVIEW_GATE=0); review items pass unjudged.',
  );
}

// The ONLY place the real effort-estimate scorer is constructed — same seam
// rule and the same dedicated-key consent as the summarizer and the review
// judge: a ticket's title and description leave the machine for this call.
// Absent key or CW_EFFORT_ESTIMATE=0 → null → every ticket stays unscored,
// which reads on the row exactly like a workspace that never wired this in.
const effortEstimator = haikuEffortEstimator();
if (!effortEstimator) {
  console.log(
    effortEstimateEnabled()
      ? '[effort-estimate] no summary API key; tickets stay unscored. ' +
          `Add one with: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`
      : '[effort-estimate] off (CW_EFFORT_ESTIMATE=0); tickets stay unscored.',
  );
}

// The ONLY place a real transcription engine is constructed — same seam rule,
// and here it is also the difference between a test suite that is free and one
// that opens a metered streaming session per server it spins up. No key → null
// → the meeting socket answers `not_configured` and the strip says so.
const transcription = createAssemblyAiEngine();
if (!transcription) {
  console.log(
    '[meetings] no transcription key; live meetings answer "not configured". ' +
      `Add one with: security add-generic-password -a "$USER" -s ${ASSEMBLYAI_KEYCHAIN_SERVICE} -w`,
  );
}

// The ONLY place the real notes composer is constructed — same seam and the
// SAME dedicated-key consent as the summarizer, because what it sends off-
// machine is the meeting transcript itself. Absent key → null → meetings
// still record transcripts; the notes section simply never appears.
const notesComposer = createHaikuNotesComposer();
if (transcription && !notesComposer) {
  console.log(
    '[meeting-notes] no summary API key; meetings record transcripts, notes stay off. ' +
      `Add one with: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
  );
}

// The ONLY place the real task-capture extractor is constructed — the same
// dedicated-key consent as the notes composer, because the same transcript
// text leaves the machine. Absent key or CW_MEETING_TASKS=0 → null → the
// notes still compose, they just never link or file board tasks.
const taskExtractor = createHaikuTaskCaptureExtractor();
if (notesComposer && !taskExtractor) {
  console.log(
    '[meeting-tasks] task capture off (CW_MEETING_TASKS=0); meetings compose notes ' +
      'without finding or filing board tasks.',
  );
}

// The ONLY place a real plugin refresher is constructed — same seam rule as
// the summarizer above, and here it also means no test run and no `bun run
// staging` can mutate this machine's plugin cache. A deploy has to be asked
// for by the process that IS the deploy.
//
// PROD passes --plugin-refresh-interval-ms (see scripts/serve.ts). Absent, no
// refresher exists and /api/plugin/refresh answers 501, which is what dev and
// staging want: they are copies, not the machine everyone installs from.
const pluginRefreshIntervalMs = Number(arg('plugin-refresh-interval-ms', '0'));
const pluginRefresher =
  Number.isFinite(pluginRefreshIntervalMs) && pluginRefreshIntervalMs > 0
    ? createPluginRefresher()
    : null;

// Declared before the deployer because the deployer needs to ask this
// server's Rooms which bound documents are mid-edit, and the server is
// constructed below.
let handle: ReturnType<typeof createServer> | null = null;

// The ONLY place a real deployer is constructed — same seam rule as the
// plugin refresher above, and it matters more here: this one runs `git merge
// --ff-only` in the deploy source and then restarts the launchd service. No
// test run, no embedded server and no `bun run staging` may do either.
//
// PROD passes --deploy (see scripts/serve.ts). Absent, no deployer exists and
// /api/deploy answers 501 — which is what dev and staging want, because they
// are copies of the deploy source rather than the machine everyone reads.
//
// There is deliberately no "--restart" companion. A restart re-runs
// scripts/serve.ts out of the deploy source's WorkingDirectory, so over an
// unpulled checkout it rebuilds the same bundles and republishes the same
// client while printing a successful deploy line. Pull and restart are one
// verb in deploy.ts precisely so that cannot be expressed here.
const deployer = args.includes('--deploy')
  ? createDeployer({
      repoRoot,
      dataDir: dataDir ?? join(repoRoot, 'data'),
      // Only documents bound INSIDE the deploy source can be clobbered by
      // its pull; one bound from another checkout is not this deploy's
      // business.
      busyDocs: () => handle?.rooms.pendingFileWrites(repoRoot) ?? [],
      // What the browser is actually running, which is what a deploy
      // delivers. Without it "up-to-date" only means the CHECKOUT is
      // current, and a hand-pulled source with an unrestarted server reports
      // nothing to do while the fleet loads the older bundle.
      clientReleaseRoot: clientReleaseRootDir,
    })
  : null;

// A ceiling on what a hot error loop can cost this process's log.
//
// launchd owns ~/Library/Logs/…err.log and /etc/newsyslog.d is not ours to
// edit, so the bound has to be in-process. Installed HERE rather than in
// createServer: patching a global console is the prerogative of the program
// that owns the log, and every test that imports the server would otherwise
// inherit it. Installed BEFORE createServer because hydrate — the loop that
// put 357 MB in the file on 2026-08-29 — runs inside it.
//
// It also goes before the bind wait below, so that a server waiting hours for
// an occupied port cannot spend the log on its own backoff lines either.
const logSquelch = installLogSquelch();

// DEV: try the requested port, and if it's taken (another agent owns it),
// walk up to the next 20. That convenience is what keeps `bun run dev`
// working with several agents on one machine.
//
// PROD (`--no-port-walk`, passed by scripts/serve.ts under launchd): the port
// is the contract. Peers' CW_BASE_URL, the discovery file, the Cloudflare
// tunnel and the supervisor's bind-health watchdog all name it, and a server
// that silently moved to 8788 is invisible to every one of them — the
// watchdog then reads "8787 not listening", kills a healthy server and
// relaunches, forever. So prod waits for its port in place, with backoff,
// rather than moving or throwing.
//
// Either way, only EADDRINUSE is a statement about the PORT. A host that has
// run out of network buffers (ENOBUFS) or lost its interface (EADDRNOTAVAIL)
// answers the same for every port, so walking cannot help and must not run —
// see packages/server/src/port-bind.ts for the whole story.
const walkPorts = shouldWalkPorts(args);
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

// PROD: wait for the port with a CHEAP socket probe, before `createServer` is
// ever called. This ordering is the requirement, not an optimisation:
// `createServer` hydrates every persisted document and re-arms every markdown
// file watcher before it attempts its bind, so retrying `createServer`
// against a busy port costs a full 5,622-document hydration (and leaks the
// activity-writer lock) per attempt. Retrying the probe costs two syscalls.
if (!walkPorts) {
  await acquirePort({
    port: requestedPort,
    probe: probeLocalPort,
    sleep,
    log: (m) => console.warn(m.replace('[supervisor]', '[feedback]')),
  });
}

let port = requestedPort;
while (!handle) {
  try {
    handle = createServer({
      port,
      dataDir,
      widgetDistDir: widgetDist,
      markdownAppDistDir: markdownAppDist,
      clientReleaseRootDir,
      demosDir,
      trustedHosts,
      accessTunnelHosts: accessTunnelReady ? accessTunnelHosts : [],
      proxiedTrustedHosts: proxiedTrustedReady ? proxiedTrustedHosts : [],
      proxiedTrustedEmails,
      allowedOrigins,
      publicBaseUrl: publicBaseUrlOverride,
      sharingEnvLocked,
      requireEmailAuth,
      ...(ownerEmail ? { ownerEmail } : {}),
      // Browser Sentry DSN — box config, never the repo (see ServerOptions).
      ...(sentryDsn ? { sentryDsn } : {}),
      cfAccess,
      share,
      summarizer,
      ...(codeSenderChoice.sender ? { codeSender: codeSenderChoice.sender } : {}),
      authCeilings: {
        ...(authGlobalStartsPerHour ? { globalStartsPerHour: authGlobalStartsPerHour } : {}),
        ...(authPeerStartsPerHour ? { peerStartsPerHour: authPeerStartsPerHour } : {}),
      },
      ...(readyNudgeIdleMs !== undefined ? { readyNudgeIdleMs } : {}),
      ...(stallNudgeQuietMs !== undefined ? { stallNudgeQuietMs } : {}),
      ...(stallBuilderSilentMultiplier !== undefined ? { stallBuilderSilentMultiplier } : {}),
      ...(stallNudgeRepeatMs !== undefined ? { stallNudgeRepeatMs } : {}),
      ...(heldReviewItemMs !== undefined ? { heldReviewItemMs } : {}),
      ...(reviewJudge ? { reviewJudge } : {}),
      ...(effortEstimator ? { effortEstimator } : {}),
      ...(voiceComplete ? { voiceComplete } : {}),
      ...(transcription ? { transcription } : {}),
      ...(notesComposer ? { meetingNotes: { composer: notesComposer, taskExtractor } } : {}),
      ...(pluginRefresher ? { pluginRefresher } : {}),
      ...(deployer ? { deployer } : {}),
    });
  } catch (err) {
    const kind = classifyBindError(err);
    if (kind === 'fatal') throw err;
    if (walkPorts) {
      // Dev only, and only for a genuinely occupied port.
      if (kind !== 'in-use' || port >= requestedPort + 20) throw err;
      console.warn(`[feedback] port ${port} busy, trying ${port + 1}`);
      port++;
      continue;
    }
    // We probed and the port was free, so reaching here means we lost a race
    // for it in the moments since. Rare, and the answer is the same: wait for
    // the port, never move off it. Going back through the probe keeps the
    // waiting cheap even though this retry does re-run the hydration.
    console.warn(
      kind === 'in-use'
        ? `[feedback] lost the race for :${port} — waiting for it, not walking`
        : `[feedback] cannot open a socket on :${port} (host resources, not the port) — waiting`,
    );
    await acquirePort({
      port,
      probe: probeLocalPort,
      sleep,
      log: (m) => console.warn(m.replace('[supervisor]', '[feedback]')),
    });
  }
}
port = handle.port;

const ts = tailscaleHost();
const lan = lanHostnames();
console.log(`[feedback] listening on :${port}`);
console.log(`[feedback]   local:      http://localhost:${port}`);
if (ts) console.log(`[feedback]   tailscale:  http://${ts}:${port}`);
// Which base every reviewUrl / entryUrl the server hands out is built on.
// Printed only when it is NOT the obvious one, because that is the case
// where a reader would otherwise assume wrong — and because a TLS frontend
// is invisible from in here, this line is the only place the process says
// which origin its links point at.
if (publicBaseUrlOverride) console.log(`[feedback]   links use:  ${publicBaseUrlOverride}`);
for (const h of lan) console.log(`[feedback]   lan:        http://${h}:${port}`);
if (trustedHosts.length) console.log(`[feedback]   trusted:    ${trustedHosts.join(', ')}`);
// Named at boot because the alternative is a security-relevant setting nobody
// can see. "collab" is the whole claim: Access-gated, share-scoped, and not
// the privileged surface the tailnet names get.
if (accessTunnelHosts.length && accessTunnelReady) {
  console.log(`[feedback]   collab:     ${accessTunnelHosts.join(', ')} (via Cloudflare Access)`);
}
// "operator" is the whole claim: Access-gated, and then the privileged
// surface — the one line that says the product is reachable from outside.
if (proxiedTrustedHosts.length && proxiedTrustedReady) {
  console.log(
    `[feedback]   operator:   ${proxiedTrustedHosts.join(', ')} (via Cloudflare Access, full product, ` +
      `${proxiedTrustedEmails.length} allowed ${proxiedTrustedEmails.length === 1 ? 'email' : 'emails'})`,
  );
}
if (allowedOrigins.length) console.log(`[feedback]   origins:    ${allowedOrigins.join(', ')}`);
console.log(
  '[feedback]   routes:     /  /workspaces/<id>/docs/<docId>  /widget.iife.js  /demos/mockup',
);
if (cfAccess) {
  const audDisplay =
    typeof cfAccess.audience === 'string'
      ? cfAccess.audience.slice(0, 8)
      : share
        ? 'auto-from-shares'
        : 'NONE (every token refused)';
  console.log(`[feedback]   cf-access:  team=${cfAccess.teamDomain} aud=${audDisplay}…`);
}
if (share) {
  const st = handle.sharingGate.status();
  console.log(
    `[feedback]   sharing:    ${st.enabled ? 'ON — external share hosts are served' : 'OFF — every external host gets 403'}` +
      `${st.locked ? ' (LOCKED by CW_SHARING_DISABLED)' : ''}` +
      `${st.loadError ? ` (failed closed: ${st.loadError})` : ''}`,
  );
}
if (share?.config.publicHostname) {
  console.log(
    `[feedback]   share-link: https://${share.config.publicHostname}/share/<id>?exp=…&sig=…`,
  );
}
if (share?.config.baseHostname && share.config.cfAccountId) {
  console.log(
    `[feedback]   share-cf:   base=${share.config.baseHostname} account=${share.config.cfAccountId.slice(0, 8)}…`,
  );
}
if (!widgetDist)
  console.log('[feedback] (widget bundle not built yet — run: bun run build:widget)');
if (!markdownAppDist)
  console.log('[feedback] (markdown app not built yet — run: bun run build:markdown-app)');

// The summary backfill is NOT here any more.
//
// It was gated on CW_SUMMARY_BACKFILL=1 at startup, which meant the only way
// to ask for a piece of catch-up work was to bounce the process. It is now
// POST /api/summaries/backfill — same sweep, same pacing, no restart. Still
// deliberate: nothing schedules it, because the backlog is billed calls.

// The update runs off the merge, not off somebody remembering.
//
// Eleven releases once sat undelivered because delivery had exactly one
// trigger: a person deciding to run one command. Nothing was broken and
// nothing said so. `claude plugin update` fetches from the marketplace, so
// polling it on a timer means a merge reaches this machine's cache on its own
// — and the only step left is the peer's own restart.
//
// This cannot interrupt anyone: it rewrites a version-keyed cache directory,
// and every running session keeps loading the path it resolved at launch. It
// is also the reason this is safe to arm without asking.
//
// Once at startup, because a prod restart is already the deploy for the
// browser client and there is no reason for the plugin to be the one artifact
// that waits.
let pluginRefreshTimer: ReturnType<typeof setInterval> | null = null;
if (pluginRefresher) {
  const say = (why: string) => {
    void pluginRefresher.refresh().then((r) => {
      // Only speak up when something changed or broke. A quiet no-op every
      // half hour in a log people read is how they stop reading it.
      if (r.changed || !r.ok) console.log(`[feedback]   plugin(${why}): ${r.message}`);
    });
  };
  say('boot');
  pluginRefreshTimer = setInterval(() => say('poll'), pluginRefreshIntervalMs);
  // Never hold the process open for a cache update.
  pluginRefreshTimer.unref();
  console.log(
    `[feedback]   plugin:     auto-refresh every ${Math.round(pluginRefreshIntervalMs / 60_000)} min ` +
      '(cache only — peers pick it up on their next restart)',
  );
}

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[feedback] shutting down (${sig})`);
    // Report whatever the current squelch window was still counting; nothing
    // else will ask for it once the process is gone.
    logSquelch.flush();
    // Cancels an in-flight backfill; without it a paced drain keeps spending
    // on a process that is on its way out.
    summarizer.dispose();
    if (pluginRefreshTimer) clearInterval(pluginRefreshTimer);
    await handle.stop();
    await flushServerSentry();
    process.exit(0);
  });
}

function pathOrNull(p: string): string | null {
  return existsSync(p) ? p : null;
}
