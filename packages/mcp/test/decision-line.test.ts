/**
 * The propagation clause on `decision.answered`, and the wiring that carries
 * it to an agent.
 *
 * The behaviour is proven against REAL emitted rows in
 * `packages/server/test/decision-answered-line.test.ts` — that is the test
 * that can tell `links` from a key nobody sends. What this file adds is the
 * two seams that suite cannot see: the switch in mcp.ts must actually call
 * this renderer rather than rebuild the sentence inline (which is how the
 * unconditional clause survived in the first place), and the BUNDLE must carry
 * the guard, because peers load `packages/plugin/mcp/index.js` and never the
 * source.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decisionAnsweredLine } from '../src/decision-line.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

const CLAUSE = 'walk its links as the propagation checklist';
const ANSWERED = {
  taskId: 't-synthetic',
  answer: 'Rebuild after the freeze.',
  actor: { name: 'Alex' },
};

describe('decisionAnsweredLine', () => {
  it('always says which task was answered, and in whose words', () => {
    const line = decisionAnsweredLine({ ...ANSWERED, links: [] });
    expect(line).toContain('[decision.answered]');
    expect(line).toContain('t-synthetic');
    expect(line).toContain('by Alex');
    expect(line).toContain('Rebuild after the freeze.');
  });

  it('offers the checklist when there are links to walk', () => {
    expect(decisionAnsweredLine({ ...ANSWERED, links: [{ kind: 'doc', docId: 'd1' }] })).toContain(
      CLAUSE,
    );
  });

  it('says nothing about links when the task has none', () => {
    expect(decisionAnsweredLine({ ...ANSWERED, links: [] })).not.toContain(CLAUSE);
  });

  it('says nothing about links when the frame carries no links key at all', () => {
    // A server older than the field, or a replayed row. Absent is not "walk
    // an empty list" and it is not "walk an unknown list" either — there is
    // nothing to hand the reader.
    expect(decisionAnsweredLine(ANSWERED)).not.toContain(CLAUSE);
  });

  it('truncates a long answer rather than relaying the whole essay', () => {
    const line = decisionAnsweredLine({ ...ANSWERED, answer: 'x'.repeat(200), links: [] });
    expect(line).toContain('…');
    expect(line).not.toContain('x'.repeat(200));
  });
});

describe('the channel switch and the shipped bundle both use it', () => {
  /** The `case 'decision.answered':` arm, up to the next case. */
  const arm = (): string => {
    const start = SRC.indexOf("case 'decision.answered':");
    expect(start, 'no decision.answered case in mcp.ts').toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    return rest.slice(0, rest.indexOf('case '));
  };

  it('delegates to the renderer instead of rebuilding the sentence inline', () => {
    expect(arm()).toContain('decisionAnsweredLine(p)');
    expect(arm()).not.toContain(CLAUSE);
  });

  it('ships the guard in the artifact peers actually load', () => {
    // Positive control first: the bundle is a real build that contains the
    // clause at all, so "no unconditional clause" cannot be "wrong file".
    expect(BUNDLE).toContain(CLAUSE);
    expect(BUNDLE).toContain('Array.isArray(p.links) && p.links.length > 0');
  });
});
