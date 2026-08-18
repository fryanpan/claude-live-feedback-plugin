#!/usr/bin/env bun
/**
 * One-shot installer for the live-feedback plugin on the host machine.
 *
 *   1. `npm link` the MCP binary so Claude Code can launch it from PATH
 *      without the package being on the npm registry.
 *   2. Add this repo as a local Claude Code marketplace.
 *   3. Install the `live-feedback` plugin at user scope.
 *
 * What this does NOT do (requires user judgement):
 *   • edit the user's shell profile to add the --dangerously-load-development-channels
 *     flag — that's shell-profile persistence and Claude Code blocks it.
 *     README tells the user what to paste.
 *
 * Re-runnable. Each step detects whether it's already been done and skips.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const mcpDir = join(repoRoot, 'packages', 'mcp');

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; ok?: (out: string) => boolean } = {},
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd, args, { cwd: opts.cwd ?? repoRoot, encoding: 'utf8' });
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function which(bin: string): string | null {
  const res = spawnSync('which', [bin], { encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

console.log('=== live-feedback bootstrap ===\n');

// Step 1: npm link
console.log('1. Linking @fryanpan/live-feedback-mcp binary to your npm global bin…');
if (which('live-feedback-mcp')) {
  console.log('   ✓ already linked (live-feedback-mcp found on PATH)');
} else {
  if (!existsSync(join(mcpDir, 'dist', 'mcp.js'))) {
    console.log('   building dist/mcp.js first…');
    const build = run('bun', ['run', 'build:mcp']);
    if (build.code !== 0) {
      console.error('   ✗ build failed:', build.stderr);
      process.exit(1);
    }
  }
  const link = run('npm', ['link'], { cwd: mcpDir });
  if (link.code !== 0) {
    console.error('   ✗ npm link failed:', link.stderr);
    process.exit(1);
  }
  if (!which('live-feedback-mcp')) {
    console.error('   ✗ linked but binary not on PATH — check `npm bin -g`');
    process.exit(1);
  }
  console.log('   ✓ linked');
}

// Step 2: add marketplace
console.log('\n2. Registering this repo as a Claude Code marketplace…');
const claude = which('claude');
if (!claude) {
  console.error('   ✗ `claude` not found on PATH. Install Claude Code first.');
  process.exit(1);
}
const marketplaces = run(claude, ['plugin', 'marketplace', 'list']);
if (marketplaces.stdout.includes('claude-live-feedback')) {
  console.log('   ✓ marketplace `claude-live-feedback` already registered');
} else {
  const add = run(claude, ['plugin', 'marketplace', 'add', repoRoot]);
  if (add.code !== 0) {
    console.error('   ✗ marketplace add failed:', add.stderr || add.stdout);
    process.exit(1);
  }
  console.log('   ✓ added');
}

// Step 3: install plugin
console.log('\n3. Installing the `live-feedback` plugin at user scope…');
const plugins = run(claude, ['plugin', 'list']);
if (
  plugins.stdout.includes('claude-workspaces@claude-workspaces') &&
  plugins.stdout.includes('enabled')
) {
  console.log('   ✓ plugin already installed and enabled');
} else {
  const install = run(claude, [
    'plugin',
    'install',
    'claude-workspaces@claude-workspaces',
    '--scope',
    'user',
  ]);
  if (install.code !== 0) {
    console.error('   ✗ install failed:', install.stderr || install.stdout);
    process.exit(1);
  }
  console.log('   ✓ installed');
}

console.log('\n=== next steps ===\n');
console.log('Add this flag to however you launch `claude`, so channel events');
console.log('(thread.created / replied / resolved) reach the agent session:');
console.log('');
console.log(
  '    --dangerously-load-development-channels plugin:claude-workspaces@claude-workspaces',
);
console.log('');
console.log('e.g. in your ~/.zshrc:');
console.log('');
console.log('    claude() {');
console.log('      /path/to/claude \\');
console.log(
  '        --dangerously-load-development-channels plugin:claude-workspaces@claude-workspaces \\',
);
console.log('        "$@"');
console.log('    }');
console.log('');
console.log('Then: `source ~/.zshrc`, restart Claude Code, run `bun run dev` here');
console.log('to start the feedback server.');
