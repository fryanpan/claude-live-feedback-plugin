#!/usr/bin/env bun
/**
 * Triage the threads the old inferred review queue left behind.
 *
 *   bun run packages/server/src/migrate-review-queue.ts --workspace <id>
 *   bun run packages/server/src/migrate-review-queue.ts --workspace <id> --apply --author "Name"
 *
 * Dry run is the DEFAULT and prints the full disposition table — every row,
 * including the two classes it will never touch. `--apply` resolves the
 * receipt class and nothing else. What the three classes mean, and why only
 * one of them is a script's to act on, is in `review-migration.ts`; so is
 * everything that talks to the server, because a CLI module runs its own
 * `main` on import and therefore cannot be driven by a test.
 */
import {
  type MigrationPlan,
  fetchQueueRows,
  fetchQueueThreads,
  formatPlan,
  resolvable,
  resolveReceipts,
  triageThreads,
} from './review-migration.ts';

interface Args {
  workspace: string;
  base: string;
  apply: boolean;
  author: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = {
    workspace: '',
    base: process.env.FEEDBACK_BASE_URL ?? 'http://127.0.0.1:8787',
    apply: false,
    author: process.env.FEEDBACK_AGENT_NAME ?? '',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--json') args.json = true;
    else if (a === '--workspace') args.workspace = argv[++i] ?? '';
    else if (a === '--base') args.base = argv[++i] ?? '';
    else if (a === '--author') args.author = argv[++i] ?? '';
    else return `unknown argument: ${a}`;
  }
  if (args.workspace === '') return '--workspace <id> is required';
  // An audit row naming nobody is worse than an honest refusal: the resolve
  // lands in the thread's history as an actor, and "unknown" there is a
  // record nobody can follow up on.
  if (args.apply && args.author.trim() === '') {
    return '--apply needs --author "<name>" (or FEEDBACK_AGENT_NAME) — a resolve is attributed';
  }
  return args;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    console.error(`migrate-review-queue: ${parsed}`);
    return 2;
  }
  const args = parsed;
  const base = args.base.replace(/\/$/, '');

  const rows = await fetchQueueRows(base, args.workspace);
  const plan: MigrationPlan = triageThreads(await fetchQueueThreads(base, rows));
  const targets = resolvable(plan);

  if (args.json) {
    console.log(JSON.stringify({ ...plan, resolvable: targets }, null, 2));
  } else {
    console.log(`workspace ${args.workspace} · ${base} · ${args.apply ? 'APPLY' : 'dry run'}`);
    console.log(formatPlan(plan, Date.now()));
  }

  if (!args.apply) {
    console.log('');
    console.log(
      `Dry run — nothing was changed. Re-run with --apply --author "<name>" to resolve the ${targets.length} receipt row(s).`,
    );
    console.log(
      'The question and skim rows are for a person or an agent to read; this script will never resolve them.',
    );
    return 0;
  }

  const { resolved, failed } = await resolveReceipts(base, args.author.trim(), targets);
  console.log('');
  console.log(
    `Resolved ${resolved.length} of ${targets.length} receipt row(s) as ${args.author.trim()}.`,
  );
  for (const f of failed) console.error(`  FAILED ${f.row.docId} ${f.row.threadId}: ${f.error}`);
  // Said here rather than only in the module header: the person reading this
  // output is the one who would otherwise go looking for an undo.
  console.log('Resolve is soft — every thread is intact and a reply reopens it.');
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`migrate-review-queue: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
