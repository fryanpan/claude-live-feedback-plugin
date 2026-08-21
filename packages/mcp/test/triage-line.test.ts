import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_REVIEW_SKILL, triageRequestLine } from '../src/triage-line.ts';

const RETRIAGE = {
  kind: 'goal-retriage',
  taskIds: ['t-a', 't-b', 't-c'],
  batchId: 'b-1',
  oldGoal: 'Old goal: ship the widget by Friday.',
  newGoal: 'New goal: ship the board.',
};

describe('triageRequestLine', () => {
  it('asks the lead agent to act, in the imperative', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-lead');
    expect(line).toContain('re-triage 3 open task(s) with set_task_goal');
    expect(line).toContain('batchId "b-1"');
    expect(line).not.toContain('Act only if');
  });

  it('tells a NON-lead who the request is addressed to instead of ordering them to act', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-bystander');
    expect(line).toContain('agent-lead');
    expect(line).toContain('Act only if that is you');
  });

  // Positive control for the test above: the SAME payload renders the plain
  // imperative when the reader is the addressee, so the assertion there is
  // about the addressing and not about something inert in the payload.
  it('renders the imperative for that same payload when the reader IS the lead', () => {
    const line = triageRequestLine(
      { ...RETRIAGE, leadAgentId: 'agent-bystander' },
      'agent-bystander',
    );
    expect(line).toContain('re-triage 3 open task(s) with set_task_goal');
    expect(line).not.toContain('Act only if');
  });

  // One-directional by design: an unknown addressee may over-ask, never
  // under-ask. Silence is the failure mode with no recovery.
  it('keeps the imperative when the payload names no lead at all', () => {
    const line = triageRequestLine(RETRIAGE, 'agent-whoever');
    expect(line).toContain('re-triage 3 open task(s) with set_task_goal');
    expect(line).not.toContain('Act only if');
  });

  it('keeps the batchId in the FYI, so a wrongly-detected non-lead can still act', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-bystander');
    expect(line).toContain('batchId "b-1"');
  });

  it('leaves single-task placement alone — it is addressed to whoever is attached', () => {
    const line = triageRequestLine(
      { kind: 'task', taskId: 't-z', leadAgentId: 'agent-lead' },
      'agent-bystander',
    );
    // Still the imperative, never the addressed FYI a goal-retriage produces.
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
    // Decide how many tasks it is — including none.
    expect(line).toContain('zero / one / several');
    expect(line).toContain('instruction about neighbouring text is zero');
    // Rewrite, then place. Both verbs named, in that order.
    expect(line.indexOf('rewrite_task')).toBeGreaterThan(-1);
    expect(line.indexOf('set_task_goal')).toBeGreaterThan(line.indexOf('rewrite_task'));
  });

  it('says "?" rather than a wrong count when taskIds is missing', () => {
    const line = triageRequestLine({ kind: 'goal-retriage', batchId: 'b-2' }, 'agent-whoever');
    expect(line).toContain('re-triage ? open task(s)');
  });

  // The line used to end by pointing at a `handling-a-goal-change` skill. The
  // skill is gone — the operations do the task movement themselves — so the
  // line has to be self-sufficient, and that is what this pins: the verb to
  // call, the ids to call it on, and the text they were last judged against.
  it('carries the verb, the ids and the old goal, with no skill to go read', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-lead');
    expect(line).toContain('set_task_goal');
    expect(line).toContain('t-a');
    expect(line).toContain('previous goal');
    expect(line).not.toContain('claude-workspaces:');
  });

  // Same reason the batchId rides along: a lead whose id moved reads the FYI,
  // and if they conclude it IS theirs they need everything the imperative had.
  it('leaves the FYI equally self-sufficient', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-bystander');
    expect(line).toContain('t-a');
    expect(line).toContain('previous goal');
    expect(line).not.toContain('claude-workspaces:');
  });
});

/**
 * The LIVE path must not carry LESS than the replayed one.
 *
 * The server broadcasts the whole `TriageRequest` — `oldGoal`, `newGoal`, the
 * full `taskIds`, `batchId`, `leadAgentId` — on `triage.requested`. This
 * renderer used to reduce all of that to a COUNT and a batchId, so the lead
 * who was AT THEIR DESK got strictly less than the lead who was away and
 * picked the same edit up as `pendingRetriage` on attach. The shipped skill
 * papered over it by rebuilding the set with `list_tasks` and by telling the
 * reader that `oldGoal` was gone on this path — neither of which was ever
 * true of the wire, only of what this function chose to render.
 */
describe('parity with the replayed payload', () => {
  it('lists every task id, so the lead does not have to rebuild the set', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-lead');
    for (const id of RETRIAGE.taskIds) expect(line).toContain(id);
  });

  // Not a clip. The skill's own step 4 says re-triaging against the first 120
  // characters of a goal is how the second half of an edit gets ignored, and
  // the baseline is the input to "does this task still belong where it is".
  it('carries oldGoal verbatim — it is recoverable from nowhere else', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-lead');
    expect(line).toContain(RETRIAGE.oldGoal);
  });

  // Same reason the batchId already rides along: a lead whose id moved reads
  // the FYI, and if they conclude the sweep IS theirs they need the whole
  // payload, not a count.
  it('carries both in the FYI as well', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-bystander');
    for (const id of RETRIAGE.taskIds) expect(line).toContain(id);
    expect(line).toContain(RETRIAGE.oldGoal);
  });

  // The count and the list are two renderings of one array; if they can
  // disagree, one of them is lying and the reader cannot tell which.
  it('the count matches the number of ids it lists', () => {
    const line = triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-lead');
    expect(line).toContain('re-triage 3 open task(s)');
    expect(line.match(/t-[abc]/g)).toHaveLength(3);
  });

  // No cap, deliberately: a cap is exactly "the present lead gets less", in a
  // smaller form. The replayed payload has no cap either.
  it('does not truncate a long list', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t-${i}`);
    const line = triageRequestLine(
      { ...RETRIAGE, taskIds: many, leadAgentId: 'agent-lead' },
      'agent-lead',
    );
    for (const id of many) expect(line).toContain(id);
  });

  // Degradation, both directions — a missing field must vanish, never render
  // as the word "undefined" next to an instruction to act on it.
  it('omits the task list rather than printing an empty one', () => {
    const line = triageRequestLine(
      { kind: 'goal-retriage', batchId: 'b-2', oldGoal: 'Old.' },
      'agent-whoever',
    );
    expect(line).toContain('re-triage ? open task(s)');
    expect(line).not.toContain('undefined');
    expect(line).not.toMatch(/tasks:\s*$/m);
  });

  it('omits the baseline line when there was no previous goal', () => {
    const line = triageRequestLine(
      { kind: 'goal-retriage', batchId: 'b-3', taskIds: ['t-a'], oldGoal: '' },
      'agent-whoever',
    );
    expect(line).toContain('t-a');
    expect(line).not.toContain('undefined');
    expect(line.toLowerCase()).not.toContain('previous goal');
  });

  // The smaller ask never had a goal change behind it, so neither addition
  // may leak onto it.
  it('adds neither to a single-task placement', () => {
    const line = triageRequestLine(
      { kind: 'task', taskId: 't-z', taskIds: ['t-a'], oldGoal: 'Old.' },
      'agent-whoever',
    );
    expect(line).toContain('shape and place task t-z');
    expect(line).not.toContain('t-a');
    expect(line).not.toContain('Old.');
  });
});

/**
 * A band appeared in the goal list, so the unknown-goal bucket is worth
 * re-looking at. A THIRD kind, not a `goal-retriage`: the north-star text did
 * not move, so rendering it through that branch would tell the lead their
 * placements were judged against a goal that never changed.
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

  // It is not a north-star change, so the goal-change wording must not be
  // borrowed — that ask is a re-triage of every OPEN task against a new north
  // star, which is much larger and different.
  it('does not borrow the goal-change wording', () => {
    const line = triageRequestLine({ ...REVIEW, leadAgentId: 'agent-lead' }, 'agent-lead');
    expect(line).not.toContain('goal changed');
    expect(line).not.toContain('previous goal');
  });

  it('never renders "undefined" when the payload is thin', () => {
    const line = triageRequestLine({ kind: 'bucket-review', batchId: 'gc-2' }, 'agent-whoever');
    expect(line).not.toContain('undefined');
  });
});

describe('every skill a triage line names actually ships', () => {
  // A line naming a skill is a promise that a skill by that name SHIPS. A
  // deletion that leaves a name behind produces a message telling an agent to
  // go read something that does not exist — which reads as a broken install
  // rather than as a skill that was retired on purpose.
  const NAMED = [TASK_REVIEW_SKILL];

  for (const ref of NAMED) {
    it(`${ref} resolves to a skill directory in the plugin`, () => {
      const dir = ref.split(':')[1] as string;
      const path = join(import.meta.dirname, '..', '..', 'plugin', 'skills', dir, 'SKILL.md');
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain(`name: ${dir}`);
    });
  }

  // POSITIVE CONTROL: the loop above is vacuous if NAMED is empty, and the
  // retired skills are exactly what would empty it. Prove it ran.
  it('checks at least one name', () => {
    expect(NAMED.length).toBeGreaterThan(0);
  });

  // The retired ones must not come back as a dangling reference.
  it('names no retired skill anywhere in a rendered line', () => {
    const lines = [
      triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-lead'),
      triageRequestLine({ ...RETRIAGE, leadAgentId: 'agent-lead' }, 'agent-other'),
      triageRequestLine({ kind: 'task', taskId: 't-z' }, 'agent-whoever'),
      triageRequestLine({ kind: 'bucket-review', taskIds: ['t-1'] }, 'agent-whoever'),
    ];
    for (const line of lines) {
      for (const gone of ['handling-a-goal-change', 'running-a-workspace-hub', 'reviewing-task-shape']) {
        expect(line).not.toContain(gone);
      }
    }
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
