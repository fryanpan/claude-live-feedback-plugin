/**
 * The `commit` field says what a GOOD commit is, at the only layer that can.
 *
 * The server cannot validate a sha — it has no checkout, and no way to know
 * which of a machine's repos a board's shas belong to. So the tool description
 * is the whole guard, and it has to reach the caller BEFORE the bad value
 * exists.
 *
 * What made this worth a release, measured on this project's own board
 * 2026-08-17: of 67 `evidence.commit` values on closed rows, four do not point
 * at anything a reader can follow — `PR #131`, `PR #132`, one sha that resolves
 * nowhere, and one still-live branch commit on an unmerged branch. That last
 * one is the tell that this is not historical carelessness: it is the SAME
 * defect in flight, counted as proof today and dead the moment its branch
 * squash-merges. None of the four are flagged `unproven`, because `hasEvidence`
 * only asks whether a non-empty string arrived.
 *
 * Two things are guarded here, and the second is the one this repo keeps
 * relearning:
 *
 *  - The guidance is attached to the FIELD, in both tools that accept a
 *    commit — not merely mentioned in prose somewhere in the file.
 *  - It is in the committed BUNDLE. `.mcp.json` loads
 *    `packages/plugin/mcp/index.js`, not the source, so a description edited
 *    in `mcp.ts` and never rebuilt reaches nobody (PR #69). A tool description
 *    IS the deliverable here — there is no behaviour to notice, so nothing
 *    else would report the miss.
 *
 * Source-reading, like tool-wiring.test.ts and create-tasks-tool.test.ts:
 * mcp.ts is a bundle entry point and exports nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

/** The declaration block for one tool, up to the next tool entry. */
function declarationFor(tool: string): string {
  const start = SRC.indexOf(`name: '${tool}',\n      description:`);
  expect(start, `no declaration for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  return rest.slice(0, rest.indexOf('},\n    {'));
}

/** Every tool whose schema accepts a commit as proof. If a third one is ever
 *  added, it belongs in this list — which is the point of naming them here
 *  rather than asserting "somewhere in the file". */
const TOOLS_TAKING_A_COMMIT = ['task_transition', 'amend_evidence'];

describe('the commit field carries its own guidance', () => {
  it.each(TOOLS_TAKING_A_COMMIT)('%s attaches a description to `commit`', (tool) => {
    const decl = declarationFor(tool);
    // Positive control: the field is really in this declaration, so a helper
    // that returned the wrong slice fails here rather than passing the real
    // assertion vacuously.
    expect(decl).toMatch(/commit: \{ type: 'string'/);
    // A bare `commit: { type: 'string' }` is the state this fixes.
    expect(decl).toMatch(/commit: \{ type: 'string', description: COMMIT_EVIDENCE_DESCRIPTION \}/);
  });

  it('says it once, so the two tools cannot drift apart', () => {
    // Two hand-written copies is how one of them ends up stale. The constant
    // is the single spelling; assert there is exactly one literal.
    const literals = SRC.match(/A commit sha that will still resolve/g) ?? [];
    expect(literals).toHaveLength(1);
  });

  it('names the mechanism, not just the rule', () => {
    // "Use a good sha" would have prevented none of the four bad values. What
    // an agent needs is WHY the obvious action is wrong: the sha it would
    // naturally record is the one the squash-merge throws away.
    const guidance = SRC.slice(SRC.indexOf('A commit sha that will still resolve'));
    expect(guidance.slice(0, 1200)).toMatch(/squash-merge/);
    expect(guidance.slice(0, 1200)).toMatch(/not the branch commit/);
    // Where a PR number goes — two of the four bad values were PR numbers.
    expect(guidance.slice(0, 1200)).toMatch(/PR number is not a commit/);
    // And the path for work that has not merged yet, which is the case that
    // produced the live-branch-sha value.
    expect(guidance.slice(0, 1200)).toMatch(/amend_evidence/);
  });

  it('steers from task_transition prose too, where the agent is already reading', () => {
    // The field description is only read by a caller that opens the schema.
    // The prose is what every agent sees at the moment it closes a task.
    const decl = declarationFor('task_transition');
    expect(decl).toMatch(/still resolves after a squash-merge/);
  });
});

describe('the committed bundle peers load carries it', () => {
  it('ships the guidance on both commit fields', () => {
    // Positive control first: a string that has shipped for months. If the
    // bundle read returned something useless, this fails rather than letting
    // the assertions below pass vacuously.
    expect(BUNDLE).toContain('list_attachments');
    expect(BUNDLE).toContain('The single gate for status changes');

    // The guidance itself reached the artifact.
    expect(BUNDLE).toContain('A commit sha that will still resolve');
    expect(BUNDLE).toContain('squash-merge');

    // And it is attached to the FIELD in both tools, not merely present in
    // the file — the bundler keeps the shared identifier, so both schemas
    // resolve to the one definition.
    const refs = BUNDLE.match(
      /commit: \{ type: "string", description: COMMIT_EVIDENCE_DESCRIPTION \}/g,
    );
    expect(refs).toHaveLength(TOOLS_TAKING_A_COMMIT.length);
  });
});
