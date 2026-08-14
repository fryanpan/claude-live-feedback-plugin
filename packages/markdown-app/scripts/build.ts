#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildId } from '../src/build-id.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const dist = join(pkgRoot, 'dist');
const isWatch = process.argv.includes('--watch');

/** Assets whose bytes decide the build id — everything a browser loads. */
const HASHED = ['app.js', 'hub.js', 'styles.css', 'index.html'];

/**
 * Builds both entries plus the copied assets. Runs TWICE per build: once with
 * a placeholder id to get bytes to hash, then again with the real id baked in.
 *
 * The id has to be derived from the output rather than the clock, because
 * prod rebuilds the client on every restart — a timestamp id would change
 * when nothing changed and turn every restart into "a new version is
 * available" for every open tab. Two passes is the price of an id that is
 * stable across a no-op rebuild; it costs about a second.
 */
async function emit(buildId: string): Promise<boolean> {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
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
    return false;
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
    return false;
  }

  cpSync(join(pkgRoot, 'index.html'), join(dist, 'index.html'));
  cpSync(join(pkgRoot, 'src', 'styles.css'), join(dist, 'styles.css'));

  if (!existsSync(join(dist, 'app.js'))) {
    console.error('app.js missing from dist — build emitted:');
    console.error(result.outputs.map((o) => o.path));
    if (!isWatch) process.exit(1);
    return false;
  }
  return true;
}

async function buildOnce(): Promise<void> {
  // Pass 1: a fixed placeholder, so the only thing varying between two builds
  // of the same source is the source.
  if (!(await emit('0'))) return;
  const buildId = computeBuildId(
    HASHED.filter((n) => existsSync(join(dist, n))).map((name) => ({
      name,
      bytes: readFileSync(join(dist, name)),
    })),
  );
  // Pass 2: the real id, baked into the bundles and written where the server
  // serves it. Both come from this one value — computing them separately
  // would make every build look stale to itself.
  if (!(await emit(buildId))) return;

  writeFileSync(join(dist, 'BUILD_INFO.txt'), `built ${buildId}\n`);
  console.log(`[markdown-app] built to ${dist} (${buildId})`);
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
