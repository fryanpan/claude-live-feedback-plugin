#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const port = Number(arg('port', process.env.PORT ?? '8787'));
const dataDir = arg('data-dir', join(repoRoot, 'data'));
const widgetDist = pathOrNull(join(repoRoot, 'packages', 'widget', 'dist'));
const markdownAppDist = pathOrNull(join(repoRoot, 'packages', 'markdown-app', 'dist'));
const demosDir = pathOrNull(join(repoRoot, 'demos'));

const handle = createServer({
  port,
  dataDir,
  widgetDistDir: widgetDist,
  markdownAppDistDir: markdownAppDist,
  demosDir,
});

console.log(`[feedback] listening on http://localhost:${port}`);
console.log(`[feedback]   - landing:     http://localhost:${port}/`);
console.log('[feedback]   - markdown app /review/<docId>');
console.log('[feedback]   - widget       /widget.iife.js');
console.log('[feedback]   - demos        /demos/mockup');
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
