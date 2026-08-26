#!/usr/bin/env bun
/**
 * Add (or update) an entry in `<dataDir>/identity-links.json` — the file that
 * tells the activity stream which anonymous browser session ids belong to a
 * known person. See packages/server/src/identity-links.ts.
 *
 *   bun run identity:link <actorId> <identityId> [--note "…"] [--data-dir ./data]
 *   bun run identity:link --list [--data-dir ./data]
 *
 * Idempotent: re-linking the same pair rewrites the same entry. The file is
 * NOT tracked in git — the real one names a person's session ids and this repo
 * is public — so this exists to make the deployment's copy reproducible from a
 * command rather than from somebody's memory of the JSON shape.
 *
 * The server reads the file at construction, so a new link takes effect on the
 * next restart. Rows ALREADY in `activity.jsonl` are unaffected until
 * `bun run activity:repair-owner <dataDir> --write` recomputes them.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface LinkEntry {
  from: string;
  to: string;
  note?: string;
}

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const dataDir = flag('--data-dir') ?? join(process.cwd(), 'data');
const path = join(dataDir, 'identity-links.json');

function readEntries(): LinkEntry[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const links = parsed && typeof parsed === 'object' && 'links' in parsed ? parsed.links : parsed;
  if (Array.isArray(links)) {
    return links.filter(
      (e): e is LinkEntry =>
        !!e && typeof e === 'object' && typeof e.from === 'string' && typeof e.to === 'string',
    );
  }
  if (links && typeof links === 'object') {
    return Object.entries(links)
      .filter((pair): pair is [string, string] => typeof pair[1] === 'string')
      .map(([from, to]) => ({ from, to }));
  }
  return [];
}

if (argv.includes('--list')) {
  console.log(JSON.stringify({ path, links: readEntries() }, null, 2));
  process.exit(0);
}

const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const [from, to] = positional;
if (!from || !to) {
  console.error(
    'usage: bun run identity:link <actorId> <identityId> [--note "…"] [--data-dir ./data]',
  );
  console.error('       bun run identity:link --list [--data-dir ./data]');
  process.exit(2);
}
if (from === to) {
  console.error('refusing a self-link: an id already resolves to itself');
  process.exit(2);
}

const note = flag('--note');
const entries = readEntries().filter((e) => e.from !== from);
entries.push(note ? { from, to, note } : { from, to });
entries.sort((a, b) => a.from.localeCompare(b.from));
writeFileSync(path, `${JSON.stringify({ links: entries }, null, 2)}\n`);
console.log(`linked ${from} -> ${to} in ${path} (${entries.length} link(s) total)`);
console.log('Restart the server to pick it up; run activity:repair-owner to fix existing rows.');
