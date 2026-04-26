#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const dist = join(pkgRoot, 'dist');

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
