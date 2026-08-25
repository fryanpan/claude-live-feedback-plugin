#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRenamedEnv } from '@feedback/core/env-names';
import { resolveClientDists } from './client-release.ts';
import { createDeployer } from './deploy.ts';
import { createPluginRefresher } from './plugin-refresh.ts';
import { lanHostnames, normalizePublicBaseUrl, tailscaleHost } from './public-host.ts';
import { createServer } from './server.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { ThreadSummarizer } from './summarize.ts';
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

// How long ready, agent-owned work may sit untouched before the board wakes
// its lead (ready-nudge.ts). Minutes rather than ms because it is a number an
// operator types; a non-numeric or non-positive value falls back to the
// default rather than disabling the wake by accident — an idle window of 0
// would nudge on every tick, which is the one behaviour the feature exists to
// avoid.
const readyNudgeMinutes = Number(readRenamedEnv(process.env, 'CW_READY_NUDGE_MINUTES') ?? '');
const readyNudgeIdleMs =
  Number.isFinite(readyNudgeMinutes) && readyNudgeMinutes > 0
    ? readyNudgeMinutes * 60_000
    : undefined;

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
const cfAccess = cfAccessTeam
  ? { teamDomain: cfAccessTeam, audience: cfAccessAud ?? 'placeholder-overridden-by-shares' }
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
const shareConfig =
  accessShareConfigured || publicHostname
    ? {
        ...(process.env.CF_ACCOUNT_ID ? { cfAccountId: process.env.CF_ACCOUNT_ID } : {}),
        ...(cfAccessTeam ? { cfTeamDomain: cfAccessTeam } : {}),
        ...(process.env.CF_SHARE_BASE_HOSTNAME
          ? { baseHostname: process.env.CF_SHARE_BASE_HOSTNAME }
          : {}),
        ...(publicHostname ? { publicHostname } : {}),
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

// The ONLY place the real voice fast-path completer is constructed — the
// same seam rule (and the same dedicated-key consent) as the summarizer.
// Absent key → null → the fast path is off and voice routes to the agent.
const voiceComplete = haikuVoiceComplete();

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

// Try the requested port first; if it's taken (e.g. another agent owns it),
// walk up to the next 20 ports. This keeps `bun run dev` working without
// conflicts when multiple agents are on the same machine.
let port = requestedPort;
let lastErr: unknown = null;
for (let i = 0; i < 20 && !handle; i++) {
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
      allowedOrigins,
      publicBaseUrl: publicBaseUrlOverride,
      sharingEnvLocked,
      requireEmailAuth,
      ...(ownerEmail ? { ownerEmail } : {}),
      cfAccess,
      share,
      summarizer,
      ...(readyNudgeIdleMs !== undefined ? { readyNudgeIdleMs } : {}),
      ...(voiceComplete ? { voiceComplete } : {}),
      ...(pluginRefresher ? { pluginRefresher } : {}),
      ...(deployer ? { deployer } : {}),
    });
  } catch (err) {
    lastErr = err;
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'EADDRINUSE') throw err;
    console.warn(`[feedback] port ${port} busy, trying ${port + 1}`);
    port++;
  }
}
if (!handle) throw lastErr ?? new Error('could not start server');
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
if (allowedOrigins.length) console.log(`[feedback]   origins:    ${allowedOrigins.join(', ')}`);
console.log(
  '[feedback]   routes:     /  /workspaces/<id>/docs/<docId>  /widget.iife.js  /demos/mockup',
);
if (cfAccess) {
  const audDisplay =
    typeof cfAccess.audience === 'string' ? cfAccess.audience.slice(0, 8) : 'auto-from-shares';
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
  console.log(`[feedback]   share-link: https://${share.config.publicHostname}/s/<slug>`);
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

// One-shot backfill of every thread that has no current summary, open or
// resolved, spread over a window.
//
// Deliberately OPT-IN per start. Threads written before generation shipped
// have no summary, and nothing in the live path ever revisits them — but the
// backlog is hundreds of billed calls, so a restart (a crash loop, a launchd
// respawn, a `bun run dev` while iterating) must never spend it by accident.
// Run it once, on purpose:
//
//   CW_SUMMARY_BACKFILL=1 bun run dev
//
// Set the window in minutes with CW_SUMMARY_BACKFILL_MINUTES (default 15).
// It is paced, skips anything already summarized, and stops on shutdown.
if (
  ['1', 'true', 'yes'].includes(
    (readRenamedEnv(process.env, 'CW_SUMMARY_BACKFILL') ?? '').trim().toLowerCase(),
  )
) {
  const minutes = Number(readRenamedEnv(process.env, 'CW_SUMMARY_BACKFILL_MINUTES') ?? '15');
  const windowMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60_000;
  const { queued, open, resolved } = handle.rooms.backfillSummaries({ windowMs });
  console.log(
    queued > 0
      ? `[feedback]   backfill:   ${queued} threads (${open} open, ${resolved} resolved) ` +
          `over ~${Math.round(windowMs / 60_000)} min`
      : '[feedback]   backfill:   nothing to do (no unsummarized threads, or summaries are off)',
  );
}

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
    // Cancels an in-flight backfill; without it a paced drain keeps spending
    // on a process that is on its way out.
    summarizer.dispose();
    if (pluginRefreshTimer) clearInterval(pluginRefreshTimer);
    await handle.stop();
    process.exit(0);
  });
}

function pathOrNull(p: string): string | null {
  return existsSync(p) ? p : null;
}
