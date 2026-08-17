#!/usr/bin/env bun
/**
 * Starts the feedback server on a free port and prints URLs for every
 * network surface the user might want:
 *
 *   http://localhost:<port>             — this machine only
 *   http://<tailscale-host>:<port>      — any device on the tailnet
 *   http://<lan-host-or-ip>:<port>      — any device on the same wifi
 *
 * No tunnels, no DNS, no cloudflared. The project assumes the devices
 * doing the reviewing (Bryan's phone, a teammate's laptop) are on the
 * same Tailscale network or local network as the host machine.
 *
 * Usage:
 *   bun run scripts/serve.ts [--port <n>] [--no-watch]
 *
 * Modes:
 *   default     — DEV: server runs under `bun --watch` (hot-reload on any
 *                 imported change) + a markdown-app bundler in --watch mode.
 *   --no-watch  — PROD: rebuilds the browser bundles once, publishes them as
 *                 an immutable client release outside this checkout, and runs
 *                 the server as a plain long-lived process against it. No
 *                 bundler, no hot-reload: deploys are deliberate (git pull +
 *                 restart), and a --watch reload once left the server
 *                 alive-but-unbound and took the fleet-shared review server
 *                 down. This mode is what the launchd service runs.
 *
 * Stops cleanly on Ctrl+C.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect as netConnect, createServer as netServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type PreparedClient,
  clientReleaseRoot,
  prepareClientRelease,
} from '../packages/server/src/client-release.ts';

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}
const noWatch = args.includes('--no-watch');

const requestedPort = Number(arg('port') ?? process.env.PORT ?? '8787');
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

async function pickFreePort(start: number): Promise<number> {
  async function canBind(p: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
      const s = netServer();
      s.once('error', () => resolve(false));
      s.listen(p, host, () => s.close(() => resolve(true)));
    });
  }
  for (let p = start; p < start + 50; p++) {
    if ((await canBind(p, '127.0.0.1')) && (await canBind(p, '::1'))) return p;
  }
  throw new Error(`no free port near ${start}`);
}

/** Can we open a TCP connection to the port? This answers "is the server
 *  actually LISTENING", which is different from "is the process alive" —
 *  the exact gap that let an unbound-but-alive server escape launchd's
 *  KeepAlive. Resolves false on refusal/timeout. */
function isPortListening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * What this deploy source is parked on, stamped into the release so the served
 * client can say what it was built from. `--dirty` matters: prod's checkout is
 * also where people build, and "current timestamp, uncommitted tree" is a
 * different claim from "current timestamp, this commit".
 *
 * Best-effort — no git, no repo, a slow filesystem, and the publish carries on
 * with a timestamp alone rather than failing a deploy over a label.
 */
function deploySourceRef(): string | undefined {
  try {
    const r = spawnSync('git', ['describe', '--always', '--dirty'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5000,
    });
    const out = r.status === 0 ? r.stdout.trim() : '';
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
const sourceRef = noWatch ? deploySourceRef() : undefined;

const port = await pickFreePort(requestedPort);

// PROD deploy step. Two problems, one sequence:
//
//   1. The served bundles used to be whatever the last deploy left in dist/,
//      and nothing enforced that a deploy rebuilt them. 2026-08-11: generated
//      thread summaries merged, the server restarted, and every browser kept
//      loading a pre-feature app.js. So: rebuild both bundles here, once,
//      before the server starts — restart == deploy.
//
//   2. The server then served `packages/markdown-app/dist` FROM THIS CHECKOUT,
//      per request. That made building anywhere in this checkout a deploy to
//      the whole fleet, and made the served client track whichever commit the
//      working tree happened to be parked on. So: copy the built bundles into
//      an immutable release directory outside any working tree and serve that
//      (client-release.ts). The switch is a rename, never a copy over live
//      files, so there is no instant where a half-populated directory is
//      being served.
//
// A failed build keeps the previous release live (stale beats down), loudly.
const clientArgs: string[] = [];
if (noWatch) {
  const failures: string[] = [];
  for (const pkg of ['widget', 'markdown-app']) {
    const r = spawnSync('bun', ['run', join(repoRoot, 'packages', pkg, 'scripts', 'build.ts')], {
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      failures.push(pkg);
      console.error(`[supervisor] ${pkg} build FAILED`);
    }
  }

  const root = clientReleaseRoot();
  // A failed build must not be published even if dist LOOKS complete — the
  // markdown-app build writes app.js before its second entrypoint, so a late
  // failure leaves a dist that passes a file-existence check and is wrong.
  // `buildError` is how prepareClientRelease is told that, so BOTH kinds of
  // failure land in the same ledger and the board sees either one.
  const prepared: PreparedClient = prepareClientRelease({
    root,
    sources: {
      widget: join(repoRoot, 'packages', 'widget', 'dist'),
      markdownApp: join(repoRoot, 'packages', 'markdown-app', 'dist'),
    },
    // What the served client was built FROM. Freshness of the artifact is not
    // freshness of the source: a checkout parked on an old commit builds
    // successfully and stamps a current timestamp on old code, so the release
    // has to carry the commit as well as the clock.
    ...(sourceRef ? { sourceRef } : {}),
    ...(failures.length > 0 ? { buildError: `${failures.join(' + ')} build failed` } : {}),
  });

  if (prepared.stale) {
    console.error(
      `[supervisor] client NOT republished (${prepared.error ?? 'unknown'}; ` +
        `${prepared.consecutiveFailures} in a row) — ` +
        (prepared.releaseDir
          ? `serving the last good release ${prepared.releaseDir}`
          : 'and there is no previous release, so no client will be served'),
    );
  } else {
    console.log(`[supervisor] client release: ${prepared.releaseDir}`);
  }

  if (prepared.widget) clientArgs.push('--widget-dist', prepared.widget);
  if (prepared.markdownApp) clientArgs.push('--markdown-app-dist', prepared.markdownApp);
  // Only the process that publishes may report on the published client. Dev
  // and staging share this machine's default release root while serving their
  // own dist, so arming them would put PROD's deploy state on a board that is
  // not serving prod's client.
  clientArgs.push('--client-release-root', root);
}

// DEV supervises two processes so code is never stale:
//   1. The HTTP/WS server via `bun --watch` — restarts on any imported
//      TypeScript change under packages/**.
//   2. The markdown-app bundler in --watch mode — rebuilds dist on any
//      src/**/*.{ts,css} or index.html change.
// PROD (--no-watch) runs neither watcher: the server is a plain long-lived
// process serving a client release published above, which nothing can change
// while it runs.
const pluginRefreshMinutes = (() => {
  const raw = Number(process.env.LF_PLUGIN_REFRESH_MINUTES ?? '30');
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
})();
const pluginRefreshArgs =
  noWatch && pluginRefreshMinutes > 0
    ? ['--plugin-refresh-interval-ms', String(Math.round(pluginRefreshMinutes * 60_000))]
    : [];

const serverArgs = [
  'run',
  join(repoRoot, 'packages', 'server', 'src', 'bin.ts'),
  '--port',
  String(port),
  // PROD only: the published release to serve. Empty in dev, where the
  // bundler watches this checkout's dist and the server should follow it.
  ...clientArgs,
  // PROD only: keep this machine's plugin cache current on a timer, so a
  // merge reaches peers without anyone remembering to run the update. Dev and
  // staging must NOT do this — they are copies of the deploy source, and a
  // `bun run staging` that quietly updated the fleet's plugin would be the
  // same class of accident as building bundles in the primary checkout.
  // Override the cadence with LF_PLUGIN_REFRESH_MINUTES; 0 turns it off.
  ...pluginRefreshArgs,
];
if (!noWatch) serverArgs.unshift('--watch');
const server = spawn('bun', serverArgs, {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: noWatch ? 'production' : 'dev' },
});
const mdApp: ChildProcess | null = noWatch
  ? null
  : spawn(
      'bun',
      ['run', join(repoRoot, 'packages', 'markdown-app', 'scripts', 'build.ts'), '--watch'],
      { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'dev' } },
    );
const children = (): ChildProcess[] => (mdApp ? [server, mdApp] : [server]);

// Publish the live port so the live-feedback MCP (and any other local
// agent tooling) can discover whichever port `scripts/serve.ts` ended
// up on. The MCP reads this file if $FEEDBACK_BASE_URL isn't set.
const discoveryDir = join(homedir(), '.claude', 'live-feedback');
const discoveryFile = join(discoveryDir, 'server.json');
mkdirSync(discoveryDir, { recursive: true });
writeFileSync(
  discoveryFile,
  `${JSON.stringify({ port, pid: server.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
);

// bin.ts prints its own URL banner (tailscale + lan + localhost), so we
// stay quiet here — just leave a hint after about the review URL shape.
console.log('');
console.log('[supervisor] markdown review: .../review/<docId>?as=bryan');
console.log('[supervisor] demo mockup:    .../demos/mockup');
console.log('[supervisor] mobile preview: append  &mobile=iphone16pm  to a review URL');
if (noWatch) console.log('[supervisor] mode: prod (no hot-reload; bind-health watchdog on)');
console.log('');

let cleaningUp = false;
/** Tear down children + discovery file and exit. `code` decides whether
 *  launchd (KeepAlive: SuccessfulExit=false) respawns us: exit 0 on an
 *  intentional stop (SIGINT/SIGTERM) so we stay down, exit 1 when a child
 *  died or the server went unbound so a fresh, bound server comes up. */
function cleanup(code: number): void {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const p of children()) {
    try {
      p.kill('SIGTERM');
    } catch {}
  }
  try {
    unlinkSync(discoveryFile);
  } catch {}
  setTimeout(() => process.exit(code), 300);
}
// A child exiting unexpectedly is a failure — exit non-zero so launchd
// respawns a healthy supervisor (the old code exited 0 here, which meant a
// crashed server was NOT respawned).
server.on('exit', () => cleanup(1));
mdApp?.on('exit', () => cleanup(1));
// Intentional stop → exit 0, no respawn.
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => cleanup(0));

// Bind-health watchdog (prod only). The failure that took prod down was the
// server process staying ALIVE but no longer LISTENING (a --watch reload
// wedge). launchd's KeepAlive can't see that — the process is up. So poll the
// port; if it's unreachable across MAX_FAILS consecutive checks while we
// haven't been asked to stop, exit non-zero so launchd respawns a bound
// server. Dropping --watch removes the known trigger; this catches the class.
if (noWatch) {
  const GRACE_MS = 15_000; // let the server bind before the first check
  const CHECK_MS = 30_000;
  const MAX_FAILS = 2; // ~60s unbound before we act (avoids blips)
  let fails = 0;
  setTimeout(() => {
    const timer = setInterval(async () => {
      if (cleaningUp) return;
      if (await isPortListening(port)) {
        fails = 0;
        return;
      }
      fails += 1;
      console.error(`[supervisor] health: :${port} not listening (${fails}/${MAX_FAILS})`);
      if (fails >= MAX_FAILS) {
        clearInterval(timer);
        console.error('[supervisor] server alive-but-unbound — restarting via launchd');
        cleanup(1);
      }
    }, CHECK_MS);
    timer.unref?.();
  }, GRACE_MS);
}
