#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const dist = join(pkgRoot, 'dist');
const isWatch = process.argv.includes('--watch');

async function buildOnce(): Promise<void> {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  // One id per build, stamped into BOTH the bundles and BUILD_INFO.txt. An
  // open tab compares the id it is running against the id the server serves
  // (see src/stale-client.ts), so the two must be written from one value —
  // computing them separately would make every build look stale to itself.
  const buildId = new Date().toISOString();
  const define = { __LF_BUILD_ID__: JSON.stringify(buildId) };

  const result = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', 'app.ts')],
    outdir: dist,
    target: 'browser',
    format: 'esm',
    splitting: false,
    sourcemap: 'external',
    define,
    naming: {
      entry: 'app.js',
      chunk: '[name]-[hash].js',
      asset: '[name].[ext]',
    },
    minify: process.env.NODE_ENV !== 'dev' && !isWatch,
  });

  if (!result.success) {
    console.error('build failed:');
    for (const m of result.logs) console.error(m);
    if (!isWatch) process.exit(1);
    return;
  }

  // The workspace hub is its own entry (served at /app/hub.js by the shell
  // the server renders for /workspaces/:id) — a separate build call because
  // each entry wants a fixed output name.
  const hubResult = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', 'hub', 'hub-app.ts')],
    outdir: dist,
    target: 'browser',
    format: 'esm',
    splitting: false,
    sourcemap: 'external',
    define,
    naming: {
      entry: 'hub.js',
      chunk: '[name]-[hash].js',
      asset: '[name].[ext]',
    },
    minify: process.env.NODE_ENV !== 'dev' && !isWatch,
  });
  if (!hubResult.success) {
    console.error('hub build failed:');
    for (const m of hubResult.logs) console.error(m);
    if (!isWatch) process.exit(1);
    return;
  }

  cpSync(join(pkgRoot, 'index.html'), join(dist, 'index.html'));
  cpSync(join(pkgRoot, 'src', 'styles.css'), join(dist, 'styles.css'));

  if (!existsSync(join(dist, 'app.js'))) {
    console.error('app.js missing from dist — build emitted:');
    console.error(result.outputs.map((o) => o.path));
    if (!isWatch) process.exit(1);
    return;
  }

  writeFileSync(join(dist, 'BUILD_INFO.txt'), `built ${buildId}\n`);
  console.log(`[markdown-app] built to ${dist}`);
}

await buildOnce();

if (isWatch) {
  // Rebuild on any change under src/ or the html shell. Debounce
  // because editors often emit several events per save.
  const srcDir = join(pkgRoot, 'src');
  let timer: Timer | null = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void buildOnce().catch((err) => console.error('[markdown-app] rebuild failed:', err));
    }, 80);
  };
  watch(srcDir, { recursive: true }, schedule);
  watch(join(pkgRoot, 'index.html'), schedule);
  console.log('[markdown-app] watching for changes…');
}
