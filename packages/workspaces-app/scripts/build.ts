#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSET_MANIFEST_FILE,
  type AssetManifest,
  SHELL_ASSETS,
  hashedAssetName,
  rewriteAssetRefs,
} from '@feedback/core/asset-manifest';
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
const HASHED = [
  'app.js',
  'hub.js',
  'signin.js',
  'landing.js',
  'sentry.js',
  'sw.js',
  'styles.css',
  'hub.css',
  'signin.css',
  'tokens.css',
  'index.html',
];

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

  // The landing page: its own entry (served at /app/landing.js by the shell
  // renderLanding emits). It defines <meeting-banner> and nothing else —
  // splitting off because the page is a list and one self-styling element.
  const landingResult = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', 'landing-app.ts')],
    outdir: dist,
    target: 'browser',
    format: 'esm',
    splitting: false,
    sourcemap: 'external',
    define,
    naming: { entry: 'landing.js', chunk: '[name]-[hash].js', asset: '[name].[ext]' },
    minify: process.env.NODE_ENV !== 'dev' && !isWatch,
  });
  if (!landingResult.success) {
    console.error('landing build failed:');
    for (const m of landingResult.logs) console.error(m);
    if (!isWatch) process.exit(1);
    return false;
  }

  // Sentry: its own entry, loaded by a <script type="module"> that a shell
  // emits only when the box has a DSN configured — see
  // packages/server/src/browser-sentry.ts for why it is not an import inside
  // the page bundles. Splitting off: it is one module and the SDK, and a
  // chunk that 404s would take the whole init with it.
  const sentryResult = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', 'sentry-boot.ts')],
    outdir: dist,
    target: 'browser',
    format: 'esm',
    splitting: false,
    sourcemap: 'external',
    define,
    naming: { entry: 'sentry.js', chunk: '[name]-[hash].js', asset: '[name].[ext]' },
    minify: process.env.NODE_ENV !== 'dev' && !isWatch,
  });
  if (!sentryResult.success) {
    console.error('sentry build failed:');
    for (const m of sentryResult.logs) console.error(m);
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

  cpSync(join(pkgRoot, 'src', 'styles.css'), join(dist, 'styles.css'));
  // The board's own rules, loaded by the hub shell on top of styles.css.
  // Copied rather than bundled for the same reason styles.css is: a
  // stylesheet the shells name by URL has to exist under that name.
  cpSync(join(pkgRoot, 'src', 'hub.css'), join(dist, 'hub.css'));
  cpSync(join(pkgRoot, 'src', 'signin.css'), join(dist, 'signin.css'));
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

  // ── Content-addressed copies of everything a shell names ────────────────
  //
  // The shells (this index.html, and the hub/sign-in shells the server
  // renders) used to point at permanent URLs, so whether a reloaded tab got
  // the new bundle was the browser's call and nothing the server sent could
  // overrule it. Emitting `app-<hash>.js` beside `app.js` makes new bytes a
  // new URL, which no cache can already hold.
  //
  // The plain names stay on disk on purpose, and this is the transition
  // rather than tidiness: a shell that a browser cached BEFORE this change
  // still asks for `/app/app.js`, and that request has to keep answering — a
  // 404 there is a blank page, which is worse than the banner this fixes.
  // They cost disk, never bandwidth: nothing emitted from here references
  // them any more.
  const assets: AssetManifest = {};
  for (const name of SHELL_ASSETS) {
    const from = join(dist, name);
    if (!existsSync(from)) continue;
    const bytes = readFileSync(from);
    const emitted = hashedAssetName(name, bytes);
    writeFileSync(join(dist, emitted), bytes);
    assets[name] = emitted;
  }
  writeFileSync(join(dist, ASSET_MANIFEST_FILE), `${JSON.stringify(assets, null, 2)}\n`);

  // index.html is copied LAST, after the hashes exist, and rewritten on the
  // way so it references them. The server rewrites its own shells at serve
  // time from the same manifest.
  writeFileSync(
    join(dist, 'index.html'),
    rewriteAssetRefs(readFileSync(join(pkgRoot, 'index.html'), 'utf8'), assets),
  );

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
  console.log(`[workspaces-app] built to ${dist} (${buildId})`);
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
      void buildOnce().catch((err) => console.error('[workspaces-app] rebuild failed:', err));
    }, 80);
  };
  watch(srcDir, { recursive: true }, schedule);
  watch(join(pkgRoot, 'index.html'), schedule);
  console.log('[workspaces-app] watching for changes…');
}
