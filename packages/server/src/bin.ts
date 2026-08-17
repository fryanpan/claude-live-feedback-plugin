#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClientDists } from './client-release.ts';
import { createPluginRefresher } from './plugin-refresh.ts';
import { lanHostnames, tailscaleHost } from './public-host.ts';
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
  widgetDist: arg('widget-dist') ?? process.env.LF_WIDGET_DIST,
  markdownAppDist: arg('markdown-app-dist') ?? process.env.LF_MARKDOWN_APP_DIST,
  repoRoot,
});
const demosDir = pathOrNull(join(repoRoot, 'demos'));

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
 * LF_SHARING_DISABLED=1 — external sharing starts OFF and the runtime toggle
 * (`POST /api/share/enabled`, the `set_sharing_enabled` MCP tool) refuses to
 * reopen it. Use this while a security review is in flight: it is the one
 * setting nothing the server exposes can undo, so a compromised or
 * misbehaving caller cannot reopen the door.
 *
 * For an ordinary on/off, leave this unset and use the runtime toggle — that
 * state persists in <dataDir>/sharing.json across restarts.
 */
const sharingEnvLocked = ['1', 'true', 'yes'].includes(
  (process.env.LF_SHARING_DISABLED ?? '').trim().toLowerCase(),
);

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
// key. An absent key or LF_SUMMARIES=0 makes every call on it a no-op.
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

// Try the requested port first; if it's taken (e.g. another agent owns it),
// walk up to the next 20 ports. This keeps `bun run dev` working without
// conflicts when multiple agents are on the same machine.
let port = requestedPort;
let handle: ReturnType<typeof createServer> | null = null;
let lastErr: unknown = null;
for (let i = 0; i < 20 && !handle; i++) {
  try {
    handle = createServer({
      port,
      dataDir,
      widgetDistDir: widgetDist,
      markdownAppDistDir: markdownAppDist,
      demosDir,
      trustedHosts,
      allowedOrigins,
      sharingEnvLocked,
      cfAccess,
      share,
      summarizer,
      ...(voiceComplete ? { voiceComplete } : {}),
      ...(pluginRefresher ? { pluginRefresher } : {}),
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
for (const h of lan) console.log(`[feedback]   lan:        http://${h}:${port}`);
if (trustedHosts.length) console.log(`[feedback]   trusted:    ${trustedHosts.join(', ')}`);
if (allowedOrigins.length) console.log(`[feedback]   origins:    ${allowedOrigins.join(', ')}`);
console.log('[feedback]   routes:     /  /review/<docId>  /widget.iife.js  /demos/mockup');
if (cfAccess) {
  const audDisplay =
    typeof cfAccess.audience === 'string' ? cfAccess.audience.slice(0, 8) : 'auto-from-shares';
  console.log(`[feedback]   cf-access:  team=${cfAccess.teamDomain} aud=${audDisplay}…`);
}
if (share) {
  const st = handle.sharingGate.status();
  console.log(
    `[feedback]   sharing:    ${st.enabled ? 'ON — external share hosts are served' : 'OFF — every external host gets 403'}` +
      `${st.locked ? ' (LOCKED by LF_SHARING_DISABLED)' : ''}` +
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
//   LF_SUMMARY_BACKFILL=1 bun run dev
//
// Set the window in minutes with LF_SUMMARY_BACKFILL_MINUTES (default 15).
// It is paced, skips anything already summarized, and stops on shutdown.
if (['1', 'true', 'yes'].includes((process.env.LF_SUMMARY_BACKFILL ?? '').trim().toLowerCase())) {
  const minutes = Number(process.env.LF_SUMMARY_BACKFILL_MINUTES ?? '15');
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
