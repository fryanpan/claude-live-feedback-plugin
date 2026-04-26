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
 *   bun run scripts/serve.ts [--port <n>]
 *
 * Stops cleanly on Ctrl+C.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

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

const port = await pickFreePort(requestedPort);
// `bun run dev` supervises two processes so code is never stale:
//   1. The HTTP/WS server via `bun --watch` — restarts on any imported
//      TypeScript change under packages/**.
//   2. The markdown-app bundler in --watch mode — rebuilds dist on any
//      src/**/*.{ts,css} or index.html change. The server serves
//      packages/markdown-app/dist straight from disk, so a rebuild is
//      visible after a browser reload.
const server = spawn(
  'bun',
  ['--watch', 'run', join(repoRoot, 'packages', 'server', 'src', 'bin.ts'), '--port', String(port)],
  { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'dev' } },
);
const mdApp = spawn(
  'bun',
  ['run', join(repoRoot, 'packages', 'markdown-app', 'scripts', 'build.ts'), '--watch'],
  { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'dev' } },
);

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
console.log('');

let cleaningUp = false;
function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const p of [server, mdApp]) {
    try {
      p.kill('SIGTERM');
    } catch {}
  }
  try {
    unlinkSync(discoveryFile);
  } catch {}
  setTimeout(() => process.exit(0), 300);
}
server.on('exit', cleanup);
mdApp.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, cleanup);
