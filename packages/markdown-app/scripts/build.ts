#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildId } from '../src/build-id.ts';
import { OPEN_PROPS_FILES } from '../src/tokens-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const dist = join(pkgRoot, 'dist');
const isWatch = process.argv.includes('--watch');

/**
 * Assets whose bytes decide the build id — everything a browser loads.
 *
 * `sw.js` is in here because a service-worker-only change is otherwise
 * invisible: the id would not move, and "a new version is available" would
 * stay silent for the one file the browser re-fetches on its own schedule.
 */
const HASHED = ['app.js', 'hub.js', 'signin.js', 'sw.js', 'styles.css', 'tokens.css', 'index.html'];

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
  //
  // Splitting is ON for this entry and this entry only, and it is load-bearing
  // rather than tidy. Without it Bun inlines a dynamic `import()` into the
  // entry, so the board's inline task editor — the whole Tiptap/ProseMirror
  // stack behind one `import()` — lands in the file every workspace page load
  // fetches: measured 174,462 bytes before, 3,878,670 after, a 22× bundle for
  // a panel most loads never open. With splitting the editor is its own
  // chunk, fetched the first time somebody opens a task.
  //
  // Chunks ride to production for free: `client-release.ts` copies the dist
  // directory recursively, and the server serves anything under it at
  // `/app/*`. The build id still moves when a chunk changes, because the
  // chunk's name carries a content hash and the entry imports it BY NAME —
  // so the hashed entry bytes change with it.
  const hubResult = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', 'hub', 'hub-app.ts')],
    outdir: dist,
    target: 'browser',
    format: 'esm',
    splitting: true,
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

  // The sign-in page: its own entry (served at /app/signin.js by the shell
  // the server renders for /signin). Splitting off — the page is a card and
  // three fetches; there is nothing worth a second request.
  const signinResult = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', 'signin', 'signin-app.ts')],
    outdir: dist,
    target: 'browser',
    format: 'esm',
    splitting: false,
    sourcemap: 'external',
    define,
    naming: { entry: 'signin.js', chunk: '[name]-[hash].js', asset: '[name].[ext]' },
    minify: process.env.NODE_ENV !== 'dev' && !isWatch,
  });
  if (!signinResult.success) {
    console.error('signin build failed:');
    for (const m of signinResult.logs) console.error(m);
    if (!isWatch) process.exit(1);
    return false;
  }

  // The service worker: its own entry, and IIFE rather than ESM.
  //
  // `register('/sw.js')` without `{ type: 'module' }` loads a CLASSIC script,
  // and module workers are still the newer path across browsers — an ESM
  // bundle here fails to register on the devices this feature exists for.
  // Splitting stays off for the same reason: a worker that imports a chunk
  // is a worker that can fail to install when the chunk 404s.
  const swResult = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', 'sw.ts')],
    outdir: dist,
    target: 'browser',
    format: 'iife',
    splitting: false,
    sourcemap: 'external',
    define,
    naming: { entry: 'sw.js', chunk: '[name]-[hash].js', asset: '[name].[ext]' },
    minify: process.env.NODE_ENV !== 'dev' && !isWatch,
  });
  if (!swResult.success) {
    console.error('service worker build failed:');
    for (const m of swResult.logs) console.error(m);
    if (!isWatch) process.exit(1);
    return false;
  }

  cpSync(join(pkgRoot, 'index.html'), join(dist, 'index.html'));
  cpSync(join(pkgRoot, 'src', 'styles.css'), join(dist, 'styles.css'));
  // The Open Props trial layer: the vendored subset (self-hosted — a strict
  // CSP and offline tailnet use forbid CDN hosts) concatenated with the
  // mapping in src/tokens.css, served as one file at /app/tokens.css so a
  // mockup can import the app's palette with a single <link>. Resolved from
  // this package's node_modules, same as any bundled dependency.
  const requireFromPkg = createRequire(join(pkgRoot, 'package.json'));
  const tokensCss = [
    ...OPEN_PROPS_FILES.map((f) => readFileSync(requireFromPkg.resolve(`open-props/${f}`), 'utf8')),
    readFileSync(join(pkgRoot, 'src', 'tokens.css'), 'utf8'),
  ].join('\n');
  writeFileSync(join(dist, 'tokens.css'), tokensCss);
  // Icons and the web app manifest. Copied wholesale rather than listed, so
  // adding an icon size later needs no build change — and `client-release.ts`
  // copies dist recursively, so they reach production the same way chunks do.
  cpSync(join(pkgRoot, 'public'), dist, { recursive: true });

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
