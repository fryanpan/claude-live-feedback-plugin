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
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRenamedEnv } from '../packages/core/src/env-names.ts';
import { DISCOVERY_FILE, discoveryDir } from '../packages/core/src/machine-paths.ts';
import {
  type PreparedClient,
  clientReleaseRoot,
  prepareClientRelease,
} from '../packages/server/src/client-release.ts';
import { readDeploySource } from '../packages/server/src/deploy-source.ts';
import {
  type BindErrorKind,
  acquirePort,
  probeLocalPort,
  shouldWalkPorts,
} from '../packages/server/src/port-bind.ts';

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

/**
 * DEV only. Walk to the next port when this one is occupied, so two agents on
 * one machine do not fight over 8787. Only `in-use` justifies a step: a host
 * that cannot open a socket at all will answer identically for all 50 ports,
 * and walking converts one host-level failure into a bogus "no free port".
 */
async function pickFreePort(start: number): Promise<number> {
  let last: BindErrorKind | null = null;
  for (let p = start; p < start + 50; p++) {
    const kind = await probeLocalPort(p);
    if (kind === null) return p;
    last = kind;
    if (kind !== 'in-use') break;
  }
  throw new Error(
    last === 'in-use'
      ? `no free port near ${start}`
      : `cannot open a socket on :${start} — this host is out of network resources, not out of ports`,
  );
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

// What this deploy source is parked on, stamped into the release so the served
// client can say what it was built from. `-dirty` is NOT `git describe
// --dirty`: this checkout also hosts bound review documents, so a modified
// tracked file under `docs/` is an ordinary editing session rather than an
// uncommitted build. See `packages/server/src/deploy-source.ts` for the rule,
// which is an ignore list closed by default — anything this deploy builds or
// serves still earns the suffix.
//
// Best-effort: no git, no repo, a slow filesystem, and the publish carries on
// with a timestamp alone rather than failing a deploy over a label.
const deploySource = noWatch ? readDeploySource(repoRoot) : null;

// DEV negotiates a port; PROD is GIVEN one. Under launchd the port is part
// of the contract — the discovery file, peers' CW_BASE_URL, the Cloudflare
// tunnel and this supervisor's own bind-health watchdog all name it — so a
// prod server that quietly moved to 8788 is invisible to every one of them.
// On 2026-08-29 that invisibility is precisely what let the watchdog kill and
// relaunch nine healthy servers in a row while their predecessors stayed up.
//
// So prod WAITS for its port, in this process, with backoff. The wait happens
// here, BEFORE the client builds and before the child hydrates 5,622
// documents, so a busy port costs a log line rather than a full relaunch.
const walkPorts = shouldWalkPorts(args);
async function resolvePort(): Promise<number> {
  if (walkPorts) return pickFreePort(requestedPort);
  await acquirePort({
    port: requestedPort,
    probe: probeLocalPort,
    sleep: (ms) =>
      new Promise((r) => {
        setTimeout(r, ms);
      }),
    log: (m) => console.error(m),
  });
  return requestedPort;
}
const port = await resolvePort();

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
    // has to carry the commit as well as the clock — and the modified paths,
    // so a reader can judge the `-dirty` decision instead of trusting it.
    ...(deploySource ?? {}),
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
    console.log(
      `[supervisor] client release: ${prepared.releaseDir}` +
        (deploySource ? ` (source ${deploySource.sourceRef})` : '') +
        // Named rather than counted: "3 modified files" makes a reader go
        // looking, which is the cost this is meant to remove.
        (deploySource?.dirtyPaths ? ` modified: ${deploySource.dirtyPaths.join(', ')}` : ''),
    );
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
  const raw = Number(readRenamedEnv(process.env, 'CW_PLUGIN_REFRESH_MINUTES') ?? '30');
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
  // PROD only: the port is the contract, so the child may not walk off it
  // either. Without this the supervisor waits politely for 8787, hands the
  // child 8787, and the child binds 8788 the moment anything else is holding
  // it — which is invisible to the bind-health watchdog below (it polls the
  // port it ASKED for) and was the engine of the 2026-08-29 restart storm.
  ...(noWatch ? ['--no-port-walk'] : []),
  // PROD only: the published release to serve. Empty in dev, where the
  // bundler watches this checkout's dist and the server should follow it.
  ...clientArgs,
  // PROD only: keep this machine's plugin cache current on a timer, so a
  // merge reaches peers without anyone remembering to run the update. Dev and
  // staging must NOT do this — they are copies of the deploy source, and a
  // `bun run staging` that quietly updated the fleet's plugin would be the
  // same class of accident as building bundles in the primary checkout.
  // Override the cadence with CW_PLUGIN_REFRESH_MINUTES; 0 turns it off.
  ...pluginRefreshArgs,
  // PROD only: let this server pull its own deploy source and restart
  // itself, so shipping stops needing a person with a shell in the primary
  // checkout. Dev and staging must NOT — they are copies of that checkout,
  // and a `bun run staging` that fast-forwarded it and bounced the launchd
  // service would be the same class of accident as building bundles there.
  //
  // Note what enabling this presumes and what it does not: the restart is a
  // `launchctl kickstart` of the supervised job, which re-reads the plist
  // launchd already has. It does not reinstall the plist, so the environment
  // baked in at install time (CW_PUBLIC_BASE_URL) is carried across a deploy
  // untouched. Changing that is still `scripts/launchd/install.sh`.
  ...(noWatch ? ['--deploy'] : []),
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

// Publish the live port so the claude-workspaces MCP (and any other local
// agent tooling) can discover whichever port `scripts/serve.ts` ended
// up on. The MCP reads this file if $CW_BASE_URL isn't set.
//
// Only ever the CURRENT name. Readers still fall back to the old directory
// (see `resolveDiscoveryFile`) because the flag day does not order the server
// restart against each session's respawn — but writing both would leave a
// stale port behind for whichever reader checked the old one first.
const discoveryFile = join(discoveryDir(homedir()), DISCOVERY_FILE);
mkdirSync(discoveryDir(homedir()), { recursive: true });
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

/** How long a child gets to honour SIGTERM before we stop being polite. */
const SHUTDOWN_GRACE_MS = 5_000;
const SIGKILL_GRACE_MS = 2_000;

const stillRunning = (): ChildProcess[] =>
  children().filter((p) => p.exitCode === null && p.signalCode === null);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * SIGTERM every child, then WAIT for them to actually die, then SIGKILL
 * whatever is left.
 *
 * The predecessor of this function fired SIGTERM and called `process.exit`
 * 300ms later without ever looking at whether anything died. A server child
 * midway through hydrating 5,622 documents does not exit in 300ms, so it was
 * reparented to launchd and kept running — holding its port, its 2,553 file
 * watchers and its memory — while launchd started a replacement. On
 * 2026-08-29 that leak ran nine times; the last survivor reached 2.77 GB and
 * was the process jetsam killed when the machine ran out of memory and, with
 * it, network buffers. `activity-writer.lock is held by pid 88883` appears in
 * the log across seven consecutive restarts: one orphan, outliving them all.
 */
async function reapChildren(): Promise<void> {
  for (const p of stillRunning()) {
    try {
      p.kill('SIGTERM');
    } catch {}
  }
  const softDeadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < softDeadline && stillRunning().length > 0) await wait(100);

  const stubborn = stillRunning();
  if (stubborn.length === 0) return;
  console.error(
    `[supervisor] ${stubborn.length} child(ren) ignored SIGTERM after ` +
      `${SHUTDOWN_GRACE_MS / 1000}s — SIGKILL (pids ${stubborn.map((p) => p.pid).join(', ')})`,
  );
  for (const p of stubborn) {
    try {
      p.kill('SIGKILL');
    } catch {}
  }
  const hardDeadline = Date.now() + SIGKILL_GRACE_MS;
  while (Date.now() < hardDeadline && stillRunning().length > 0) await wait(50);
}

/** Tear down children + discovery file and exit. `code` decides whether
 *  launchd (KeepAlive: SuccessfulExit=false) respawns us: exit 0 on an
 *  intentional stop (SIGINT/SIGTERM) so we stay down, exit 1 when a child
 *  died or the server went unbound so a fresh, bound server comes up. */
function cleanup(code: number): void {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    unlinkSync(discoveryFile);
  } catch {}
  void reapChildren().then(() => process.exit(code));
}

// Last-resort orphan guard. `cleanup` covers the paths we know about; this
// covers the ones we do not — an uncaught throw, an explicit process.exit
// elsewhere, a code path added later. It must be synchronous, so SIGKILL is
// the only option available here.
process.on('exit', () => {
  for (const p of stillRunning()) {
    try {
      p.kill('SIGKILL');
    } catch {}
  }
});
// A child exiting unexpectedly is a failure — exit non-zero so launchd
// respawns a healthy supervisor (the old code exited 0 here, which meant a
// crashed server was NOT respawned).
//
// But a child that dies IMMEDIATELY, every time, is the outage's cost
// structure with a different trigger: launchd's ThrottleInterval is 10s, and
// each relaunch re-runs two client builds and re-hydrates every persisted
// document before it can fail again. So when the server dies young, hold
// before exiting. This is a damper, not exponential backoff — the supervisor
// keeps no state across launchd relaunches, so it cannot know it is the
// fourth attempt — but it turns a 10s hot loop into a ~30s one and costs
// nothing when the server was healthy and something else killed it.
const FAST_CRASH_MS = 30_000;
const FAST_CRASH_HOLD_MS = 20_000;
const spawnedAt = Date.now();
server.on('exit', () => {
  const uptimeMs = Date.now() - spawnedAt;
  if (cleaningUp || uptimeMs >= FAST_CRASH_MS) {
    cleanup(1);
    return;
  }
  console.error(
    `[supervisor] server died ${Math.round(uptimeMs / 1000)}s after starting — ` +
      `holding ${FAST_CRASH_HOLD_MS / 1000}s before exiting, so relaunching does not ` +
      'become a hot loop of client builds and document hydration',
  );
  setTimeout(() => cleanup(1), FAST_CRASH_HOLD_MS);
});
mdApp?.on('exit', () => cleanup(1));
// Intentional stop → exit 0, no respawn.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => cleanup(0));

// Bind-health watchdog (prod only). The failure that took prod down was the
// server process staying ALIVE but no longer LISTENING (a --watch reload
// wedge). launchd's KeepAlive can't see that — the process is up. So poll the
// port; if it's unreachable across MAX_FAILS consecutive checks while we
// haven't been asked to stop, exit non-zero so launchd respawns a bound
// server. Dropping --watch removes the known trigger; this catches the class.
//
// This polls the port we ASKED for, which is only the same as the port the
// child BOUND because prod forbids walking on both sides (`shouldWalkPorts`
// above, `--no-port-walk` in serverArgs). When that invariant did not hold,
// this watchdog was the outage: the child bound 8788, the watchdog polled
// 8787, declared a healthy server unbound, and restarted it — nine times,
// leaking a fully-hydrated server on each pass. Do not re-enable walking in
// prod without giving the child a way to report the port it actually got.
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
