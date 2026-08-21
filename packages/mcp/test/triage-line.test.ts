import { describe, expect, it } from 'vitest';
import { triageRequestLine } from '../src/triage-line.ts';

describe('a single-task placement (kind: task)', () => {
  it('is addressed to whoever is attached, never turned into an FYI', () => {
    const line = triageRequestLine(
      { kind: 'task', taskId: 't-z', leadAgentId: 'agent-lead' },
      'agent-bystander',
    );
    // Still the imperative, never the addressed FYI the lead-addressed kinds
    // produce.
    expect(line).toContain('shape and place task t-z');
    expect(line).not.toContain('FYI');
    expect(line).not.toContain('agent-lead');
  });

  // The line is the whole contract for a single-task triage: there is no
  // skill name on this path and no second delivery. It used to say only
  // "place task X against the goal", and the board did exactly that — a
  // captured paragraph got a goal and kept its clipped fragment of a title
  // forever, with every component reporting success. The three verbs have to
  // be IN the request, because it is the only thing the recipient reads.
  it('asks for shaping, not only placement', () => {
    const line = triageRequestLine({ kind: 'task', taskId: 't-z' }, 'agent-whoever');
    // Read the words.
    expect(line).toContain('its own words');
    // Decide how many tasks it is, zero included.
    expect(line).toContain('zero / one / several');
    expect(line).toContain('instruction about neighbouring text is zero');
    // Rewrite, then place. Both verbs named, in that order.
    expect(line.indexOf('rewrite_task')).toBeGreaterThan(-1);
    expect(line.indexOf('set_task_goal')).toBeGreaterThan(line.indexOf('rewrite_task'));
  });

  // Degradation: a missing field must vanish, never render as the word
  // "undefined" next to an instruction to act on it.
  it('never renders "undefined" when the payload is thin', () => {
    const line = triageRequestLine({ kind: 'task', taskId: 't-z' }, 'agent-whoever');
    expect(line).not.toContain('undefined');
  });
});

/**
 * A band appeared in the goal list, so the unknown-goal bucket is worth
 * re-looking at.
 *
 * The ask is to LOOK. The server never places anything in answer to it, and
 * the line must not read as though it did — "leave it unplaced" is a valid
 * answer, and the bucket exists precisely because nobody has made that call.
 */
describe('a bucket re-look (kind: bucket-review)', () => {
  const REVIEW = {
    kind: 'bucket-review',
    taskIds: ['t-a', 't-b'],
    batchId: 'gc-1',
    newBands: [{ id: 'g2', title: 'Reviewer trust' }],
  };

  it('names the band that appeared and every task in the bucket', () => {
    const line = triageRequestLine({ ...REVIEW, leadAgentId: 'agent-lead' }, 'agent-lead');
    expect(line).toContain('Reviewer trust');
    expect(line).toContain('g2');
    for (const id of REVIEW.taskIds) expect(line).toContain(id);
    expect(line).toContain('set_task_goal');
  });

  // The count and the list are two renderings of one array.
  it('the count matches the number of ids it lists', () => {
    const line = triageRequestLine({ ...REVIEW, leadAgentId: 'agent-lead' }, 'agent-lead');
    expect(line).toContain('2 unplaced task(s)');
    expect(line.match(/t-[ab]/g)).toHaveLength(2);
  });

  // Placing is the lead's judgment, so the line has to say that leaving one
  // where it is remains an answer. Without it the reader treats the request
  // as "empty this bucket", which is the auto-assign Bryan ruled out, made of
  // words instead of code.
  it('says that leaving a task unplaced is a valid answer', () => {
    const line = triageRequestLine({ ...REVIEW, leadAgentId: 'agent-lead' }, 'agent-lead');
    expect(line.toLowerCase()).toContain('unplaced is fine');
  });

  it('addresses a non-lead as an FYI, carrying the whole payload', () => {
    const line = triageRequestLine({ ...REVIEW, leadAgentId: 'agent-lead' }, 'agent-bystander');
    expect(line).toContain('Act only if that is you');
    expect(line).toContain('agent-lead');
    for (const id of REVIEW.taskIds) expect(line).toContain(id);
    expect(line).toContain('Reviewer trust');
  });

  // Positive control for the assertion above: the same payload renders the
  // imperative when the reader IS the addressee.
  it('renders the imperative for that same payload when the reader is the lead', () => {
    const line = triageRequestLine(
      { ...REVIEW, leadAgentId: 'agent-bystander' },
      'agent-bystander',
    );
    expect(line).not.toContain('Act only if');
  });

  it('never renders "undefined" when the payload is thin', () => {
    const line = triageRequestLine({ kind: 'bucket-review', batchId: 'gc-2' }, 'agent-whoever');
    expect(line).not.toContain('undefined');
  });
});

describe('a task shape review (kind: task-review)', () => {
  const payload = {
    kind: 'task-review',
    taskId: 't-r1',
    title: 'fix the thing with the search',
    trigger: 'renamed',
    leadAgentId: 'agent-lead',
    actor: { id: 'known-jordan', name: 'Jordan' },
  };

  it('renders the imperative for the lead, naming the row, the trigger, and the writer', () => {
    const line = triageRequestLine(payload, 'agent-lead');
    expect(line).toContain('t-r1');
    expect(line).toContain('fix the thing with the search');
    expect(line).toContain('renamed');
    expect(line).toContain('Jordan');
    expect(line).not.toContain('FYI');
  });

  it('names the contract skill and the rewrite verb — the line is the whole briefing', () => {
    const line = triageRequestLine(payload, 'agent-lead');
    expect(line).toContain('claude-workspaces:leading-a-workspace');
    expect(line).toContain('rewrite_task');
    // Judging a row fine must be a stated outcome, or every review "finds"
    // something — the corrective-retry lesson, one loop earlier.
    expect(line).toContain('fine as-is');
    // The other honest outcome: ask the person who filed it, on the task.
    expect(line).toContain('ask the filer');
  });

  it('addresses a non-lead as an FYI rather than ordering a second reviewer in', () => {
    const line = triageRequestLine(payload, 'agent-bystander');
    expect(line).toContain('FYI');
    expect(line).toContain('agent-lead');
    expect(line).toContain('Act only if that is you');
  });

  it('keeps the imperative when the payload names no lead at all', () => {
    const { leadAgentId: _lead, ...unaddressed } = payload;
    const line = triageRequestLine(unaddressed, 'agent-whoever');
    expect(line).not.toContain('FYI');
    expect(line).toContain('rewrite_task');
  });

  it('never renders "undefined" when the payload is thin', () => {
    const line = triageRequestLine({ kind: 'task-review', taskId: 't-r2' }, 'agent-whoever');
    expect(line).not.toContain('undefined');
    expect(line).toContain('t-r2');
  });
});
