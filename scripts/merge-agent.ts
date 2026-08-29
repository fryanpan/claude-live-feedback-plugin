#!/usr/bin/env bun
/**
 * Fold one agent id into another on a RUNNING server — the rename verb.
 *
 *   bun run agents:merge <fromId> <intoId> [--write] [--base http://127.0.0.1:8787]
 *
 * Without `--write` this is a DRY RUN: the server reports which boards would
 * hand over their lead seat, which attachment records would re-key, and
 * which durable watches would move, and touches nothing. Run that first,
 * read it, then run again with `--write`. Same convention as
 * `activity:repair-owner`, for the same reason: the target is prod's data.
 *
 * Nothing is rewritten in activity.jsonl or any ydoc — the roster records
 * the merge and every reader resolves the old id through it at read time.
 * Reversible by merging back. See identities.ts `mergeAgent`.
 */
const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--base');
const [from, into] = positional;
if (!from || !into) {
  console.error(
    'usage: bun run agents:merge <fromId> <intoId> [--write] [--base http://127.0.0.1:8787]',
  );
  process.exit(2);
}
const base = (flag('--base') ?? process.env.FEEDBACK_BASE_URL ?? 'http://127.0.0.1:8787').replace(
  /\/$/,
  '',
);
const write = argv.includes('--write');

const res = await fetch(`${base}/api/agents/${encodeURIComponent(from)}/merge`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ into, dryRun: !write }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`merge refused: HTTP ${res.status} ${text}`);
  process.exit(1);
}
console.log(text);
if (!write) console.log('\nDry run — nothing changed. Re-run with --write to apply.');
export {};
