#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const dist = join(pkgRoot, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(pkgRoot, 'src', 'app.ts')],
  outdir: dist,
  target: 'browser',
  format: 'esm',
  splitting: false,
  sourcemap: 'external',
  naming: {
    entry: 'app.js',
    chunk: '[name]-[hash].js',
    asset: '[name].[ext]',
  },
  minify: process.env.NODE_ENV !== 'dev',
});

if (!result.success) {
  console.error('build failed:');
  for (const m of result.logs) console.error(m);
  process.exit(1);
}

// copy html + css
cpSync(join(pkgRoot, 'index.html'), join(dist, 'index.html'));
cpSync(join(pkgRoot, 'src', 'styles.css'), join(dist, 'styles.css'));

if (!existsSync(join(dist, 'app.js'))) {
  console.error('app.js missing from dist — build emitted:');
  console.error(result.outputs.map((o) => o.path));
  process.exit(1);
}

writeFileSync(join(dist, 'BUILD_INFO.txt'), `built ${new Date().toISOString()}\n`);

console.log(`[markdown-app] built to ${dist}`);
