#!/usr/bin/env bun
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePostmarkCodeSender } from './auth/postmark-code-sender.ts';
import { confirmDeployBoot, deployLogPath } from './deploy.ts';
import { createDeployer } from './deploy.ts';
import { effortEstimateEnabled, haikuEffortEstimator } from './effort-estimator.ts';
import { installLogSquelch } from './log-squelch.ts';
import { stamped } from './log-stamp.ts';
import { createHaikuNotesComposer } from './meeting-notes-composer.ts';
import { createHaikuTaskCaptureExtractor } from './meeting-task-capture.ts';
import { createPluginRefresher } from './plugin-refresh.ts';
import { acquirePort, classifyBindError, probeLocalPort, shouldWalkPorts } from './port-bind.ts';
import { lanHostnames, tailscaleHost } from './public-host.ts';
import {
  GOOGLE_OAUTH_KEYCHAIN_SERVICE,
  createGoogleOauthApp,
  createKeychainRefreshTokenVault,
  createRecallCalendarClient,
  resolveGoogleOauthCreds,
} from './recall-calendar.ts';
import { createRecallClient, recallStatusWebhookUrl } from './recall.ts';
import { haikuReviewJudge, reviewGateEnabled } from './review-judge.ts';
import { captureServerError, flushServerSentry, initServerSentry } from './sentry.ts';
import { resolveServerConfig } from './server-config.ts';
import { createServer } from './server.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { KEYCHAIN_SERVICE, ThreadSummarizer } from './summarize.ts';
import {
  KEYCHAIN_SERVICE as ASSEMBLYAI_KEYCHAIN_SERVICE,
  createAssemblyAiEngine,
  createAssemblyAiProEngine,
} from './transcribe-assemblyai.ts';
import { SONIOX_KEYCHAIN_SERVICE, createSonioxEngine } from './transcribe-soniox.ts';
import { orderedEngines } from './transcribe.ts';
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

const cfg = resolveServerConfig({ env: process.env, repoRoot, arg });
const {
  requestedPort,
  dataDir,
  widgetDist,
  markdownAppDist,
  demosDir,
  publicBaseUrlOverride,
  clientReleaseRootDir,
  sentryDsn,
  releaseSourceRef,
  allowedOrigins,
  sharingEnvLocked,
  requireEmailAuth,
  requireSignInToWrite,
  ownerEmail,
  trustedHosts,
  cfAccess,
  accessTunnelHosts,
  accessTunnelReady,
  proxiedTrustedHosts,
  proxiedTrustedEmails,
  proxiedTrustedReady,
  recallCallbackHost,
  meetingBotWebhookSecret,
  pluginRefreshIntervalMs,
  shareConfig,
  accessShareConfigured,
  authGlobalStartsPerHour,
  authPeerStartsPerHour,
  readyNudgeIdleMs,
  stallNudgeQuietMs,
  stallBuilderSilentMultiplier,
  stallNudgeRepeatMs,
  heldReviewItemMs,
} = cfg;

if (sentryDsn) {
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

// Declared before the deps because the deployer needs to ask this server's
// Rooms which bound documents are mid-edit, and the server is constructed
// below.
let handle: ReturnType<typeof createServer> | null = null;

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
// Stamped, like the code-delivery lines themselves: this line says which
// sender the codes that follow went through, so reading a burst means
// pairing it with the notice that was in force at the time.
if (codeSenderChoice.reason) console.log(stamped(`[auth] ${codeSenderChoice.reason}`));
else console.log(stamped('[auth] login codes send via Postmark'));

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
const assemblyAi = createAssemblyAiEngine();
// The same key opens the pro model, so the two appear and disappear together.
const assemblyAiPro = createAssemblyAiProEngine();
const soniox = createSonioxEngine();
// Default first — Soniox (Bryan, 2026-09-01). The ordering itself lives in
// `orderedEngines`, where a test holds it still.
const engines = orderedEngines({ soniox, assemblyAi, assemblyAiPro });
const transcription = engines.length > 0 ? engines : null;
if (!transcription) {
  console.log(
    '[meetings] no transcription key; live meetings answer "not configured". ' +
      `Add one with: security add-generic-password -a "$USER" -s ${ASSEMBLYAI_KEYCHAIN_SERVICE} -w`,
  );
} else if (!soniox) {
  // Not a failure — the option simply does not appear in any chooser. Named
  // so the person wondering where the Soniox option went finds the answer in
  // the log rather than in the code. It matters more than it used to:
  // Soniox is the DEFAULT engine, so its absence also moves the default
  // back to AssemblyAI.
  console.log(
    '[meetings] no Soniox key; the soniox engine option stays hidden and ' +
      'AssemblyAI becomes the default. ' +
      `Add one with: security add-generic-password -a "$USER" -s ${SONIOX_KEYCHAIN_SERVICE} -w`,
  );
}

// The ONLY place the real notes composer is constructed — same seam and the
// SAME dedicated-key consent as the summarizer, because what it sends off-
// machine is the meeting transcript itself. Absent key → null → meetings
// still record transcripts; the notes section simply never appears.
// The ONLY place a real Recall client is constructed — the same seam again,
// and the most expensive one to get wrong: a bot bills the vendor per
// meeting-hour AND opens an AssemblyAI session behind it, so a client built
// by anything that merely spins a server up would be a meter attached to a
// test suite. No key → null → the invite route answers `not_configured` and
// the doc says meeting bots are not set up.
const meetingBot = createRecallClient({ publicBaseUrl: publicBaseUrlOverride });
if (meetingBot && !meetingBot.config.publicWsBase) {
  // Worth saying out loud rather than discovering at invite time: the server
  // binds to localhost and Recall dials in from the public internet, so it
  // has to be told the origin something in front of it answers on. Named
  // rather than guessed, and named ONCE — the same value every human-facing
  // link is built from.
  console.log(
    publicBaseUrlOverride
      ? '[meetings] Recall key found but CW_PUBLIC_BASE_URL is not https; ' +
          'bots stay disabled rather than stream a meeting in plaintext.'
      : '[meetings] Recall key found but CW_PUBLIC_BASE_URL is unset; ' +
          'bots stay disabled until it names the https origin this server is reached on.',
  );
}
if (meetingBot) {
  // Say which region the key is being sent to and whether it answers there.
  // A key from another region fails every invite with a 502 and nothing
  // else in the boot log hints at it; this line is the hint.
  const regionSource = process.env.RECALL_REGION?.trim()
    ? `RECALL_REGION=${meetingBot.config.region}`
    : `RECALL_REGION unset, defaulting to ${meetingBot.config.region}`;
  void meetingBot.checkKeyRegion().then((check) => {
    if (check.ok) {
      console.log(`[meetings] Recall key accepted by ${check.region} (${regionSource}).`);
    } else if (check.status === 401) {
      console.error(
        `[meetings] Recall key REJECTED by ${check.region} (401; ${regionSource}). ` +
          'The key belongs to another region, so every bot invite will answer 502. ' +
          'Set RECALL_REGION in the launchd plist EnvironmentVariables to the region ' +
          'the key was issued in and re-bootstrap the service.',
      );
    } else {
      console.error(
        `[meetings] Recall key check against ${check.region} failed (status ${check.status}; ${regionSource}); bots may not work.`,
      );
    }
  });
}

if (meetingBot?.config.publicWsBase && !meetingBotWebhookSecret) {
  // Says CLOSED, not "accepted unsigned". It said the latter until the
  // pass-2 review, which was the pre-fix behaviour and the opposite of the
  // meetings summary block twelve lines down. An operator reading it
  // concluded either that an unauthenticated injection path was open or that
  // events were arriving, when in fact every delivery 404s — and the symptom
  // they will actually see, a bot whose status never updates, has no other
  // line to point at.
  console.log(
    '[meetings] RECALL_WEBHOOK_SECRET is unset; the bot status webhook is ' +
      'CLOSED — every delivery answers 404 and bot status will not update. ' +
      'Set it to the signing secret from the Recall dashboard.',
  );
}
// Calendar auto-join — the ONLY place real calendar-side pieces are
// constructed, same seam rule as the bot client above: a scheduled bot joins
// a real call and spends. The Recall key gates the whole feature; the Google
// OAuth app (Keychain service `claude-workspaces-google-oauth`, accounts
// `client-id` / `client-secret`) gates only the CONNECT flow, so a calendar
// connected earlier keeps syncing even if those entries go missing.
const calendarClient = createRecallCalendarClient({});
const googleOauthCreds = calendarClient ? resolveGoogleOauthCreds(process.env) : null;
// The redirect URI is registered at Google verbatim, so it is stated rather
// than guessed: the env override wins, else it derives from the same public
// base URL every human-facing link uses.
const googleRedirectUri =
  process.env.CW_GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
  (publicBaseUrlOverride
    ? `${publicBaseUrlOverride.replace(/\/+$/, '')}/api/calendar/google/callback`
    : null);
const calendarBot = calendarClient
  ? {
      client: calendarClient,
      google:
        googleOauthCreds && googleRedirectUri
          ? createGoogleOauthApp({ creds: googleOauthCreds, redirectUri: googleRedirectUri })
          : null,
      vault: createKeychainRefreshTokenVault(),
    }
  : null;
if (calendarBot) {
  if (calendarBot.google) {
    console.log(
      `[calendar] Google connect armed; redirect URI ${googleRedirectUri} ` +
        '(must match the OAuth app registration at Google).',
    );
  } else {
    console.log(
      '[calendar] connect is off: ' +
        (googleOauthCreds
          ? 'CW_PUBLIC_BASE_URL (or CW_GOOGLE_OAUTH_REDIRECT_URI) is unset.'
          : `no Google OAuth app in Keychain service ${GOOGLE_OAUTH_KEYCHAIN_SERVICE} ` +
            '(accounts client-id and client-secret). A calendar connected earlier keeps syncing.'),
    );
  }
}

// Where Recall dials in, and whether each of the two routes there is actually
// armed. Printed whenever a callback hostname is configured, because "did this
// take effect?" is otherwise only answerable by making a bot join a real call
// — and the status webhook URL in particular is a value a human must paste
// into the Recall dashboard, which nothing else in this process ever says.
//
// NOT gated on the operator hostname any more: the callback host stands on its
// own now, and a deployment can have one without publishing the product at all.
if (recallCallbackHost) {
  console.log(
    `[meetings] bot callback host: ${recallCallbackHost} (no Cloudflare Access; ` +
      'each route carries its own credential)',
  );
  console.log(
    '[meetings]   websocket  wss://' +
      `${recallCallbackHost}/recall/<per-bot-token>  ` +
      (meetingBot?.config.publicWsBase ? 'ARMED' : 'closed (no Recall key)'),
  );
  console.log(
    `[meetings]   webhook    ${recallStatusWebhookUrl({ callbackHost: recallCallbackHost })}  ` +
      (meetingBotWebhookSecret ? 'ARMED' : 'closed (set RECALL_WEBHOOK_SECRET)') +
      ' — paste this into the Recall dashboard',
  );
  console.log('[meetings]   every other path on that hostname answers 404.');
}
// No `else` warning here on purpose. Whether the CW_PUBLIC_BASE_URL fallback
// is actually dialable depends on the effective host lists, which live in
// createServer — so the honest line ("bots are OFF: Recall would dial …") is
// printed there, by the same check that disarms the invite. A warning here
// would either duplicate it or cry wolf at every deployment whose public
// hostname is not Access-gated at all.

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
const pluginRefresher =
  Number.isFinite(pluginRefreshIntervalMs) && pluginRefreshIntervalMs > 0
    ? createPluginRefresher()
    : null;

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
      dataDir,
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
      ...(recallCallbackHost ? { recallCallbackHost } : {}),
      ...(calendarBot ? { calendarBot } : {}),
      proxiedTrustedEmails,
      allowedOrigins,
      publicBaseUrl: publicBaseUrlOverride,
      sharingEnvLocked,
      requireEmailAuth,
      requireSignInToWrite,
      ...(ownerEmail ? { ownerEmail } : {}),
      // Browser Sentry DSN — box config, never the repo (see ServerOptions).
      ...(sentryDsn ? { sentryDsn } : {}),
      // …and the deploy it should call itself, when this start is a published
      // release. Same string `initServerSentry` got above.
      ...(sentryDsn && releaseSourceRef ? { sentryRelease: releaseSourceRef } : {}),
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
      ...(meetingBot ? { meetingBot } : {}),
      ...(meetingBotWebhookSecret ? { meetingBotWebhookSecret } : {}),
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

// The other half of the deploy's boot verification. A deploy records its
// restart as `pending` and then dies; the only process that can honestly say
// the restart WORKED is this one, standing here — port bound, documents
// hydrated, about to serve. A boot that never reaches this line leaves the
// record pending, and the detached watchdog the deploy spawned expires it
// into `boot-failed` (deploy.ts, "Dependencies are part of the delivery").
if (deployer) {
  const confirmed = confirmDeployBoot(deployLogPath(dataDir));
  if (confirmed) {
    console.log(`[deploy] boot confirmed healthy for the deploy recorded at ${confirmed.ranAt}`);
  }
}

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
// The bot callback hostname is security-relevant in the opposite direction to
// the lines below it — it is the one name here that is NOT Access-gated — so
// it says what it serves rather than only that it exists.
if (recallCallbackHost) {
  console.log(`[feedback]   recall:     ${recallCallbackHost} (bot callbacks only, 404 otherwise)`);
}
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
