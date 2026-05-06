#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanHostnames, tailscaleHost } from './public-host.ts';
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

const requestedPort = Number(arg('port', process.env.PORT ?? '8787'));
const dataDir = arg('data-dir', join(repoRoot, 'data'));
const widgetDist = pathOrNull(join(repoRoot, 'packages', 'widget', 'dist'));
const markdownAppDist = pathOrNull(join(repoRoot, 'packages', 'markdown-app', 'dist'));
const demosDir = pathOrNull(join(repoRoot, 'demos'));

// Cloudflare Access gate (only active when both env vars are set — the
// share machinery sets these when it brings up a tunnel for external review).
const cfAccessTeam = process.env.CF_ACCESS_TEAM_DOMAIN;
const cfAccessAud = process.env.CF_ACCESS_AUD;
const cfAccess =
  cfAccessTeam && cfAccessAud ? { teamDomain: cfAccessTeam, audience: cfAccessAud } : undefined;

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
      cfAccess,
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
console.log('[feedback]   routes:     /  /review/<docId>  /widget.iife.js  /demos/mockup');
if (cfAccess) {
  console.log(
    `[feedback]   cf-access:  team=${cfAccess.teamDomain} aud=${cfAccess.audience.slice(0, 8)}…`,
  );
}
if (!widgetDist)
  console.log('[feedback] (widget bundle not built yet — run: bun run build:widget)');
if (!markdownAppDist)
  console.log('[feedback] (markdown app not built yet — run: bun run build:markdown-app)');

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[feedback] shutting down (${sig})`);
    await handle.stop();
    process.exit(0);
  });
}

function pathOrNull(p: string): string | null {
  return existsSync(p) ? p : null;
}
