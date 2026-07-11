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
 *   --no-watch  — PROD: server runs as a plain long-lived process and the
 *                 bundler is NOT started. Deploys are deliberate (git pull +
 *                 rebuild dist + restart), so prod must NOT hot-reload — a
 *                 --watch reload once left the server alive-but-unbound and
 *                 took the fleet-shared review server down. This mode is what
 *                 the launchd service runs.
 *
 * Stops cleanly on Ctrl+C.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect as netConnect, createServer as netServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const port = await pickFreePort(requestedPort);

// DEV supervises two processes so code is never stale:
//   1. The HTTP/WS server via `bun --watch` — restarts on any imported
//      TypeScript change under packages/**.
//   2. The markdown-app bundler in --watch mode — rebuilds dist on any
//      src/**/*.{ts,css} or index.html change.
// PROD (--no-watch) runs neither watcher: the server is a plain long-lived
// process and dist is built once at deploy time.
const serverArgs = [
  'run',
  join(repoRoot, 'packages', 'server', 'src', 'bin.ts'),
  '--port',
  String(port),
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
