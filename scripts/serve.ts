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
import { existsSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
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

function tailscaleHost(): string | null {
  // Try the CLI in both common install paths
  const candidates = [
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    try {
      const out = Bun.spawnSync({ cmd: [bin, 'status', '--json'], stdout: 'pipe' });
      const j = JSON.parse(out.stdout.toString('utf8')) as {
        Self?: { DNSName?: string };
      };
      const dns = j.Self?.DNSName?.replace(/\.$/, '');
      if (dns) return dns;
    } catch {
      // ignore
    }
  }
  return null;
}

function lanHostnames(): string[] {
  const out: string[] = [];
  // OS hostname often resolves via mDNS as "<hostname>.local" on the LAN
  const h = hostname().replace(/\.local$/, '');
  if (h) out.push(`${h}.local`);
  // IPv4 addresses on non-internal interfaces
  const nets = networkInterfaces();
  for (const infos of Object.values(nets)) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

const port = await pickFreePort(requestedPort);
const server = spawn(
  'bun',
  ['run', join(repoRoot, 'packages', 'server', 'src', 'bin.ts'), '--port', String(port)],
  { stdio: 'inherit' },
);

const ts = tailscaleHost();
const lan = lanHostnames();

console.log('');
console.log('=============================================================');
console.log(` Feedback server listening on :${port}`);
console.log('');
console.log(`   local:      http://localhost:${port}`);
if (ts) console.log(`   tailscale:  http://${ts}:${port}`);
for (const h of lan) console.log(`   lan:        http://${h}:${port}`);
console.log('');
console.log(' Markdown review:   .../review/<docId>?as=bryan');
console.log(' Demo mockup:       .../demos/mockup');
console.log(' Mobile preview:    append  &mobile=iphone16pm  to a review URL');
console.log('=============================================================');
console.log('');

let cleaningUp = false;
function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    server.kill('SIGTERM');
  } catch {}
  setTimeout(() => process.exit(0), 300);
}
server.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, cleanup);
