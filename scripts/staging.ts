/**
 * Run an unmerged branch as a second live-feedback instance, so peers and
 * people can review a build BEFORE it lands on main.
 *
 *   bun run staging [--port 8788] [--data-dir <path>]
 *
 * Prod keeps running on 8787 with its own data the whole time. Nothing about
 * this touches it — which takes two specific guardrails, both of which are the
 * whole reason this script exists rather than a line in a doc:
 *
 * 1. **It refuses to run from the primary checkout.** Prod serves
 *    `packages/markdown-app/dist` per-request from that directory, so building
 *    bundles there is a deploy to the fleet, not a test build. A linked
 *    worktree has its own `dist`, so building there is inert for prod. We
 *    detect the primary checkout by comparing `--git-dir` with
 *    `--git-common-dir`: they're equal only in the main checkout.
 *
 * 2. **It starts the server via `bin.ts`, never `scripts/serve.ts`.**
 *    `serve.ts` publishes the live port to the file the live-feedback MCP uses
 *    for discovery — running it here would silently repoint every agent in the
 *    fleet at the staging build. `bin.ts` takes `--port` and `--data-dir` and
 *    publishes nothing.
 *
 * Peers whose AGENT side needs staging relaunch with
 * `FEEDBACK_BASE_URL=http://<host>:<port>`; the MCP checks that override first.
 * It's read once at session launch, so it needs a restart with the env set.
 *
 * Throw the staging data dir away when you're done — nothing in it migrates to
 * prod, by design. Evaluate on staging pre-merge; do the real work once, after.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(...a: string[]): string {
  return spawnSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim() ?? '';
}

const gitDir = resolve(repoRoot, git('rev-parse', '--git-dir'));
const commonDir = resolve(repoRoot, git('rev-parse', '--git-common-dir'));
const isPrimaryCheckout = gitDir === commonDir;

if (isPrimaryCheckout && !args.includes('--force')) {
  console.error(
    [
      '[staging] Refusing to run from the primary checkout.',
      '',
      `  ${repoRoot}`,
      '',
      '  Prod serves packages/markdown-app/dist from this directory on every',
      '  request, so building bundles here deploys to the whole fleet — the',
      '  "test build" would BE the deploy, which is the trap this exists to',
      '  prevent.',
      '',
      '  Run it from a linked worktree instead, which has its own dist:',
      '',
      '    git worktree add .claude/worktrees/<branch> <branch>',
      '    cd .claude/worktrees/<branch> && bun run staging',
      '',
      '  --force overrides, and you almost certainly do not want it.',
    ].join('\n'),
  );
  process.exit(2);
}

const port = Number(arg('port') ?? '8788');
const dataDir = resolve(arg('data-dir') ?? join(repoRoot, 'data-staging'));

if (port === 8787) {
  console.error('[staging] 8787 is prod. Pick another port.');
  process.exit(2);
}

mkdirSync(dataDir, { recursive: true });

// Build in THIS worktree. Both bundles, because a stale dist is exactly how a
// merged feature ends up invisible in the browser.
for (const script of ['build:widget', 'build:markdown-app']) {
  console.log(`[staging] ${script}…`);
  const built = spawnSync('bun', ['run', script], { cwd: repoRoot, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error(`[staging] ${script} failed — not starting a server on a stale bundle.`);
    process.exit(1);
  }
}

const bin = join(repoRoot, 'packages/server/src/bin.ts');
if (!existsSync(bin)) {
  console.error(`[staging] no server entrypoint at ${bin}`);
  process.exit(1);
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD') || '(detached)';
console.log(
  [
    '',
    `[staging] branch:   ${branch}`,
    `[staging] port:     ${port}   (prod stays on 8787)`,
    `[staging] data dir: ${dataDir}   (throwaway — nothing here migrates)`,
    '[staging] the MCP port file is untouched, so agents still point at prod.',
    `[staging] for an agent on staging: FEEDBACK_BASE_URL=http://<host>:${port} (needs a session restart)`,
    '',
  ].join('\n'),
);

const server = spawn('bun', ['run', bin, '--port', String(port), '--data-dir', dataDir], {
  cwd: repoRoot,
  stdio: 'inherit',
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.kill(sig));
}
