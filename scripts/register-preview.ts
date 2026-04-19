#!/usr/bin/env bun
/**
 * Register a local feedback-server as a preview under the user's stable
 * tunnel domain (e.g. `*.tunnel.fryanpan.com`).
 *
 * 1. Picks a free port
 * 2. Starts the feedback server on that port (inherits stdio)
 * 3. Writes/updates `~/.live-feedback/registry.json` with
 *    `<slug>: { port, pid, ts }` so the router forwards the right traffic
 * 4. Prints the stable URL `https://<slug>.<baseDomain>`
 * 5. On SIGINT/SIGTERM, removes its registry entry and terminates the server
 *
 * Requires the user's stable tunnel to be running. Run once (on the
 * machine that will host previews): `scripts/setup-named-tunnel.sh`.
 *
 * Usage:
 *   bun run scripts/register-preview.ts [--slug mystuff]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

const LIVE_DIR = join(homedir(), '.live-feedback');
const REGISTRY = join(LIVE_DIR, 'registry.json');
const CONFIG = join(LIVE_DIR, 'config.json');

if (!existsSync(LIVE_DIR)) mkdirSync(LIVE_DIR, { recursive: true });

interface UserConfig {
  baseDomain: string;
}
function readUserConfig(): UserConfig {
  if (!existsSync(CONFIG)) {
    console.error(
      `[register-preview] no config at ${CONFIG}. Run scripts/setup-named-tunnel.sh first.`,
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG, 'utf8')) as UserConfig;
}

function readRegistry(): Record<string, { port: number; pid?: number; ts?: number }> {
  if (!existsSync(REGISTRY)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY, 'utf8'));
  } catch {
    return {};
  }
}
function writeRegistry(reg: Record<string, unknown>): void {
  writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
}

async function pickFreePort(start = 8787): Promise<number> {
  for (let p = start; p < start + 50; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = netServer();
      s.once('error', () => resolve(false));
      s.listen(p, () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error('no free port near ' + start);
}

function randomSlug(): string {
  // 6 alnum chars
  return Math.random().toString(36).slice(2, 8);
}

const cfg = readUserConfig();
const slug = arg('slug') ?? randomSlug();
const port = await pickFreePort();

// Start the feedback server
const here = dirname(new URL(import.meta.url).pathname);
const repoRoot = join(here, '..');
const server = spawn(
  'bun',
  ['run', join(repoRoot, 'packages', 'server', 'src', 'bin.ts'), '--port', String(port)],
  { stdio: 'inherit' },
);

// Write registry entry
const registry = readRegistry();
registry[slug] = { port, pid: server.pid ?? 0, ts: Date.now() };
writeRegistry(registry);

const url = `https://${slug}.${cfg.baseDomain}`;
console.log('');
console.log('=============================================================');
console.log(` Preview registered: ${url}`);
console.log(` Markdown review:   ${url}/review/<docId>?as=bryan`);
console.log(` Demo mockup:       ${url}/demos/mockup`);
console.log(` Widget bundle:     ${url}/widget.iife.js`);
console.log(` Local origin:      http://127.0.0.1:${port}  (slug: ${slug})`);
console.log('=============================================================');
console.log('');

function cleanup() {
  try {
    const reg = readRegistry();
    delete reg[slug];
    writeRegistry(reg);
  } catch {}
  try {
    server.kill('SIGTERM');
  } catch {}
  setTimeout(() => process.exit(0), 300);
}

server.on('exit', () => {
  cleanup();
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, cleanup);

// Extra safety: remove stale registry entries for dead PIDs on startup
for (const [s, e] of Object.entries(registry)) {
  if (s === slug) continue;
  if (!e.pid) continue;
  try {
    process.kill(e.pid, 0);
  } catch {
    delete registry[s];
  }
}
writeRegistry(registry);
