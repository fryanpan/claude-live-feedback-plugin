#!/usr/bin/env bun
/**
 * Proves the client build id is reproducible.
 *
 * The stale-client notice compares the id a tab is running against the id the
 * server serves. Prod rebuilds the client on every restart, so if two builds
 * of identical source disagree, every restart tells every open tab that a new
 * version is available — the exact nag the notice was built to avoid. The
 * failure is silent: everything still works, it just cries wolf forever.
 *
 * The id is a hash of the built bytes, so this property depends on Bun's
 * bundler being deterministic. That is not ours to guarantee, and bundler
 * output has moved between releases before (it is why CI pins its Bun
 * version) — so it gets checked rather than assumed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildInfo = join(repoRoot, 'packages/markdown-app/dist/BUILD_INFO.txt');

async function build(): Promise<string> {
  const proc = Bun.spawn(['bun', 'run', 'build:markdown-app'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(await new Response(proc.stderr).text());
    throw new Error(`build:markdown-app exited ${code}`);
  }
  return readFileSync(buildInfo, 'utf8').trim();
}

const first = await build();
const second = await build();

if (first !== second) {
  console.error('✗ client build id is not reproducible across two builds of the same source');
  console.error(`  build 1: ${first}`);
  console.error(`  build 2: ${second}`);
  console.error(
    '  Every prod restart would now show "a newer version is available" in every open tab.',
  );
  process.exit(1);
}

console.log(`✓ client build id reproducible (${first})`);
