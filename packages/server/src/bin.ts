#!/usr/bin/env bun
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmDeployBoot, deployLogPath } from './deploy-log.ts';
import { installLogSquelch } from './log-squelch.ts';
import { acquirePort, classifyBindError, probeLocalPort, shouldWalkPorts } from './port-bind.ts';
import { lanHostnames, tailscaleHost } from './public-host.ts';
import { captureServerError, flushServerSentry, initServerSentry } from './sentry.ts';
import { resolveServerConfig } from './server-config.ts';
import { createServerDeps } from './server-deps.ts';
import { createServer } from './server.ts';

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
  accessOnlyBrowserHosts,
  emailCodeSignIn,
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

const deps = createServerDeps(cfg, {
  deployEnabled: args.includes('--deploy'),
  busyDocs: () => handle?.rooms.pendingFileWrites(repoRoot) ?? [],
});
const {
  share,
  summarizer,
  codeSenderChoice,
  voiceComplete,
  reviewJudge,
  effortEstimator,
  transcription,
  meetingBot,
  calendarBot,
  notesComposer,
  taskExtractor,
  pluginRefresher,
  deployer,
} = deps;

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
      accessOnlyBrowserHosts,
      emailCodeSignIn,
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
