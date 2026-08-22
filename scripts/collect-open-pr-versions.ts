#!/usr/bin/env bun
/**
 * What plugin version does every OTHER open PR declare right now?
 *
 * The release gate can answer "is my number ahead of what main publishes" from
 * the checkout alone. It cannot answer "has another unmerged branch already
 * taken this number", because an unmerged branch is not in the checkout — and
 * that is the case that actually shipped nothing: two PRs both declaring the
 * same version are each ahead of the tip, so both stay green, and identical
 * strings merge clean because a conflict requires disagreement. The second
 * merge then publishes a version string that has not moved, and
 * `claude plugin update` copies nothing while reporting success. Measured
 * twice: #178/#176 both carried 0.1.43, and three branches pushed 0.1.46 on
 * 2026-08-17 with nothing anywhere going red.
 *
 * This script asks GitHub instead of the checkout, and prints a payload the
 * gate consumes. It is deliberately a separate process from the gate so the
 * gate's collision logic stays pure and testable — everything that needs a
 * network lives here, behind GH_BIN.
 *
 * THE OUTPUT SHAPE IS THE WHOLE POINT. `{"status":"ok","prs":[]}` means "asked,
 * nobody has your number"; `{"status":"unavailable","reason":…}` means "could
 * not ask". Those must never collapse into one value, because an empty list is
 * exactly the answer that lets a collision through. Compare "An empty `behind`
 * list is not a fleet-wide clearance" in CLAUDE.md — same failure, different
 * surface.
 *
 * Exits 0 on every path, including failure. A flaky network must not take an
 * unrelated PR red; it must make the gate SAY the concurrent half did not run.
 *
 * Usage: bun run scripts/collect-open-pr-versions.ts [--exclude <pr-number>]
 *        GH_BIN overrides the `gh` binary (tests point it at a stub).
 */

import { execFileSync } from 'node:child_process';

const GH = process.env.GH_BIN ?? 'gh';
const PLUGIN_MANIFEST = 'packages/plugin/.claude-plugin/plugin.json';
const PR_LIMIT = '200';

const args = process.argv.slice(2);
function argOf(name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const excludeRaw = argOf('--exclude');
const exclude = excludeRaw === undefined ? undefined : Number(excludeRaw);

function gh(...a: string[]): string {
  return execFileSync(GH, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function reasonOf(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string })?.stderr;
  const text = typeof stderr === 'string' ? stderr : (stderr?.toString() ?? '');
  return (text.trim() || (err as Error)?.message || String(err)).split('\n').slice(0, 3).join(' ');
}

function emit(payload: unknown): never {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

type ListedPr = { number: number; headRefName: string; headRefOid: string };

let listed: ListedPr[];
try {
  listed = JSON.parse(
    gh(
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      PR_LIMIT,
      '--json',
      'number,headRefName,headRefOid',
    ),
  );
} catch (err) {
  emit({ status: 'unavailable', reason: `could not list open PRs: ${reasonOf(err)}` });
}

const prs: { number: number; headRefName: string; version: string | null }[] = [];
for (const pr of listed) {
  if (pr.number === exclude) continue;
  let version: string | null = null;
  try {
    // `gh api` substitutes {owner}/{repo} from the current repo (or GH_REPO),
    // so this needs no slug lookup. A SHA ref resolves for fork PRs too,
    // because the base repo holds their commits.
    const raw = gh(
      'api',
      `repos/{owner}/{repo}/contents/${PLUGIN_MANIFEST}?ref=${pr.headRefOid}`,
      '-H',
      'Accept: application/vnd.github.raw',
    );
    const v = JSON.parse(raw).version;
    version = typeof v === 'string' ? v : null;
  } catch {
    // A 404 is ordinary: the branch may predate the manifest, or the fetch may
    // have failed. Either way this ONE PR's number is unknown — which the gate
    // reports as unknown rather than treating as "not a collision".
    version = null;
  }
  prs.push({ number: pr.number, headRefName: pr.headRefName, version });
}

emit({ status: 'ok', prs });
