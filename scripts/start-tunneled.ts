#!/usr/bin/env bun
/**
 * Boots the feedback server on a free port, opens a Cloudflare quick tunnel
 * (bypassing any personal ~/.cloudflared/config.yml) and prints the tunneled
 * URLs. Use this when multiple agents are on the same machine — each picks
 * its own port and its own throwaway trycloudflare.com URL.
 *
 * Usage:
 *   bun run scripts/start-tunneled.ts [--port 8787] [--no-tunnel]
 *
 * Stops cleanly on Ctrl+C (terminates the server + cloudflared child).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';

const args = process.argv.slice(2);
const requestedPort = Number(getArg('port') ?? process.env.PORT ?? '0');
const noTunnel = args.includes('--no-tunnel');

function getArg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  return undefined;
}

async function pickFreePort(start: number): Promise<number> {
  if (start === 0) {
    return new Promise((resolve, reject) => {
      const s = netServer();
      s.once('error', reject);
      s.listen(0, () => {
        const addr = s.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        s.close(() => resolve(port));
      });
    });
  }
  for (let p = start; p < start + 20; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = netServer();
      s.once('error', () => resolve(false));
      s.listen(p, () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error(`No free port near ${start}`);
}

const port = await pickFreePort(requestedPort);
console.log(`[tunneled] picked port ${port}`);

// 1. spawn the feedback server
const repoRoot = join(import.meta.dir, '..');
const dataDir = join(repoRoot, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const server = spawn(
  'bun',
  ['run', join(repoRoot, 'packages', 'server', 'src', 'bin.ts'), '--port', String(port)],
  { stdio: 'inherit' },
);
server.on('exit', (code) => {
  console.log(`[tunneled] server exited ${code}`);
  cleanup();
});

// 2. optionally spawn cloudflared with an empty config (bypasses personal routes)
let tunnel: ReturnType<typeof spawn> | null = null;
let tunnelLog = '';
const emptyConfigPath = join(dataDir, `empty-cloudflared-${port}.yml`);
if (!noTunnel) {
  writeFileSync(emptyConfigPath, '\n');
  tunnel = spawn(
    'cloudflared',
    ['tunnel', '--config', emptyConfigPath, '--url', `http://127.0.0.1:${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const onData = (buf: Buffer) => {
    const text = buf.toString();
    tunnelLog += text;
    // watch for URL
    const m = text.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/);
    if (m && !tunnelUrlPrinted) {
      tunnelUrlPrinted = true;
      const url = m[0];
      console.log('');
      console.log('=============================================================');
      console.log(` Feedback server tunneled to: ${url}`);
      console.log(` Markdown review:   ${url}/review/<docId>?as=bryan`);
      console.log(` Demo mockup:       ${url}/demos/mockup`);
      console.log(` Widget bundle:     ${url}/widget.iife.js`);
      console.log(` Local origin:      http://127.0.0.1:${port}`);
      console.log('=============================================================');
      console.log('');
    }
  };
  let tunnelUrlPrinted = false;
  tunnel.stdout?.on('data', onData);
  tunnel.stderr?.on('data', onData);
  tunnel.on('exit', (code) => {
    console.log(`[tunneled] cloudflared exited ${code}`);
  });
}

// 3. cleanup on signals
let cleaningUp = false;
function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  try { tunnel?.kill('SIGTERM'); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  try { unlinkSync(emptyConfigPath); } catch {}
  setTimeout(() => process.exit(0), 400);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, cleanup);
}
