#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BunPlugin } from 'bun';
import { assertShimCovers } from './shim-guard.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const dist = join(pkgRoot, 'dist');
const shims = join(here, 'shims');

/**
 * The widget ships under a hard gzipped budget (`bun run check:widget-size`),
 * and yjs plus lib0 account for about two thirds of it. The plugins below are
 * the shrinks that do NOT change how a host page loads the widget: they swap
 * two lib0 modules for stand-ins covering the API the bundle actually reads.
 * Each one is documented where it lives; see the shims for what they drop.
 */

/**
 * `lib0/logging` drags `lib0/dom` -> `lib0/schema` (~6.8 KB) in to colourise
 * five yjs console diagnostics, and `lib0/environment` carries env-var and CLI
 * parsing for a single dev-mode check. Neither has anything to do on a host
 * page, so both resolve to a local stand-in.
 */
// Fail the build rather than ship a shim that is short an export; see
// shim-guard.ts for why a missing one is worse than a build error.
assertShimCovers('lib0/logging', join(shims, 'lib0-logging.js'), pkgRoot);
assertShimCovers('lib0/environment', join(shims, 'lib0-environment.js'), pkgRoot);

const lib0Shims: BunPlugin = {
  name: 'lib0-shims',
  setup(build) {
    const replacements: Array<[RegExp, string]> = [
      [/^lib0\/logging$/, join(shims, 'lib0-logging.js')],
      [/^lib0\/environment$/, join(shims, 'lib0-environment.js')],
    ];
    for (const [filter, path] of replacements) {
      build.onResolve({ filter }, () => ({ path }));
    }
    // lib0's own modules reach for these by relative path.
    build.onResolve({ filter: /(^|\/)logging\.js$/ }, (args) =>
      args.importer.includes('/lib0/') ? { path: join(shims, 'lib0-logging.js') } : undefined,
    );
    build.onResolve({ filter: /(^|\/)environment\.js$/ }, (args) =>
      args.importer.includes('/lib0/') ? { path: join(shims, 'lib0-environment.js') } : undefined,
    );
  },
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

async function build(format: 'esm' | 'iife', name: string) {
  const result = await Bun.build({
    entrypoints: [join(pkgRoot, 'src', 'widget.ts')],
    outdir: dist,
    target: 'browser',
    format: format === 'iife' ? 'iife' : 'esm',
    minify: true,
    sourcemap: 'external',
    plugins: [lib0Shims],
    naming: {
      entry: name,
    },
  });
  if (!result.success) {
    console.error(`build failed (${format}):`);
    for (const m of result.logs) console.error(m);
    process.exit(1);
  }
  return result;
}

await build('esm', 'widget.esm.js');
await build('iife', 'widget.iife.js');

writeFileSync(join(dist, 'BUILD_INFO.txt'), `built ${new Date().toISOString()}\n`);

console.log(`[widget] built to ${dist}`);
