import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readyIdleLine, reviewAnsweredLine } from '../src/nudge-line.ts';

/**
 * The two wake events exist to make the board the scheduler instead of the
 * human. That only works if the wake SAYS something: rendered through the
 * hub renderer's `default:` case, both arrived as `[workspace.ready_idle]
 * task t-abc123` — a slug the lead has to go look up before it can know
 * whether the interruption was worth the turn. A wake that costs a turn and
 * carries no subject is the training signal the nudger's arming rules were
 * written to avoid, undone at the last hop.
 */

const IDLE = {
  taskId: 't-a1',
  title: 'Ship the search revamp',
  readyCount: 3,
  idleMs: 22 * 60_000,
};

describe('readyIdleLine', () => {
  it('names the task the lead should start with, by title and id', () => {
    const line = readyIdleLine(IDLE);
    expect(line).toContain('Ship the search revamp');
    expect(line).toContain('t-a1');
  });

  it('says how many rows are ready and how long they sat', () => {
    const line = readyIdleLine(IDLE);
    expect(line).toContain('3 tasks');
    expect(line).toContain('22m');
  });

  it('keeps the event slug so the channel stays greppable', () => {
    expect(readyIdleLine(IDLE)).toContain('[workspace.ready_idle]');
  });

  // The whole point of the frame: work is waiting on nobody but the reader.
  it('tells the lead to pick the work up', () => {
    expect(readyIdleLine(IDLE).toLowerCase()).toContain('next_tasks');
  });

  it('reads as one task when only one is ready', () => {
    const line = readyIdleLine({ ...IDLE, readyCount: 1 });
    expect(line).toContain('1 task has been ready');
    expect(line).toContain('nobody on it');
    expect(line).not.toContain('1 tasks');
  });

  it('reads as several tasks when several are ready', () => {
    const line = readyIdleLine(IDLE);
    expect(line).toContain('3 tasks have been ready');
    expect(line).toContain('nobody on them');
  });

  it('renders hours past the hour mark rather than a three-digit minute count', () => {
    expect(readyIdleLine({ ...IDLE, idleMs: 95 * 60_000 })).toContain('1h 35m');
  });

  // A frame from a server that sends less than this one does must still read
  // as a sentence — the fallback it would otherwise land in is what this
  // whole module replaces.
  it('still says something when the frame carries no task', () => {
    const line = readyIdleLine({ readyCount: 2, idleMs: 16 * 60_000 });
    expect(line).toContain('[workspace.ready_idle]');
    expect(line).toContain('2 tasks');
    expect(line).not.toContain('undefined');
  });

  it('omits the idle duration rather than inventing one', () => {
    const line = readyIdleLine({ taskId: 't-a1', title: 'Ship the search revamp' });
    expect(line).toContain('Ship the search revamp');
    expect(line).not.toContain('undefined');
    expect(line).not.toContain('NaN');
  });

  it('truncates a very long title instead of flooding the channel', () => {
    const line = readyIdleLine({ ...IDLE, title: 'x'.repeat(200) });
    expect(line).not.toContain('x'.repeat(200));
    expect(line).toContain('…');
    // The instruction is the half a reader acts on, so truncation must never
    // eat it — the cap belongs to the title alone.
    expect(line).toContain('next_tasks');
  });
});

describe('reviewAnsweredLine', () => {
  it('names the answered task and tells the lead to act on the answer', () => {
    const line = reviewAnsweredLine({ taskId: 't-a1', title: 'Ship the search revamp' });
    expect(line).toContain('[workspace.review_answered]');
    expect(line).toContain('Ship the search revamp');
    expect(line).toContain('t-a1');
    expect(line.toLowerCase()).toContain('answer');
  });

  // The comment-review route records an answer that moves no task row, so it
  // has no id to carry. It is still the event the lead most needs.
  it('reads as a sentence when the answer belongs to no task row', () => {
    const line = reviewAnsweredLine({});
    expect(line).toContain('[workspace.review_answered]');
    expect(line).not.toContain('undefined');
    expect(line.toLowerCase()).toContain('answer');
  });

  it('falls back to the id when the server sent no title', () => {
    expect(reviewAnsweredLine({ taskId: 't-a1' })).toContain('t-a1');
  });
});

/**
 * The propagation clause, and the wiring that carries it to an agent.
 *
 * The behaviour is proven against REAL emitted frames in
 * `packages/server/test/review-answered-nudge-links.test.ts` — that is the
 * test that can tell `links` from a key nobody sends. What this block adds is
 * the two seams that suite cannot see: the switch in mcp.ts must call this
 * renderer rather than rebuild the sentence inline, and the BUNDLE must carry
 * the guard, because peers load `packages/plugin/mcp/index.js` and never the
 * source.
 */
describe('the propagation clause on reviewAnsweredLine', () => {
  const CLAUSE = 'walk its links as the propagation checklist';
  const ANSWERED = { taskId: 't-a1', title: 'Ship the search revamp' };

  it('offers the checklist when there are links to walk', () => {
    expect(reviewAnsweredLine({ ...ANSWERED, links: [{ kind: 'doc', docId: 'd1' }] })).toContain(
      CLAUSE,
    );
  });

  it('says nothing about links when the row has none', () => {
    const line = reviewAnsweredLine({ ...ANSWERED, links: [] });
    expect(line).not.toContain(CLAUSE);
    // Positive control, so "no clause" cannot be "no line".
    expect(line).toContain('[workspace.review_answered]');
    expect(line).toContain('read it and act on it now');
  });

  it('says nothing about links when the frame carries no links key at all', () => {
    // A server older than the field, or the comment-review route, which
    // records an answer against no row. Absent is not "walk an empty list"
    // and it is not "walk an unknown list" either — there is nothing to hand
    // the reader.
    expect(reviewAnsweredLine(ANSWERED)).not.toContain(CLAUSE);
    expect(reviewAnsweredLine({})).not.toContain(CLAUSE);
  });

  it('leaves nothing dangling where the clause used to sit', () => {
    const line = reviewAnsweredLine({ ...ANSWERED, links: [] });
    expect(line.trimEnd()).toBe(line);
    expect(line).not.toMatch(/[;—]\s*\.?$/);
    expect(line.endsWith('now.')).toBe(true);
  });
});

describe('the channel switch and the shipped bundle both use it', () => {
  const CLAUSE = 'walk its links as the propagation checklist';
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
  const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

  /** The `case 'workspace.review_answered':` arm, up to the next case. */
  const arm = (): string => {
    const start = SRC.indexOf("case 'workspace.review_answered':");
    expect(start, 'no workspace.review_answered case in mcp.ts').toBeGreaterThan(-1);
    const rest = SRC.slice(start + 1);
    return rest.slice(0, rest.indexOf('case '));
  };

  it('delegates to the renderer instead of rebuilding the sentence inline', () => {
    expect(arm()).toContain('reviewAnsweredLine(p)');
    expect(arm()).not.toContain(CLAUSE);
  });

  it('ships the guard in the artifact peers actually load', () => {
    // Positive control first: the bundle is a real build that contains the
    // clause at all, so "no unconditional clause" cannot be "wrong file".
    expect(BUNDLE).toContain(CLAUSE);
    // Both renderers guard the same way, so this literal must appear at least
    // twice — decision-line.ts's copy and this one.
    expect(BUNDLE.split('Array.isArray(p.links) && p.links.length > 0').length - 1).toBeGreaterThan(
      1,
    );
  });
});
