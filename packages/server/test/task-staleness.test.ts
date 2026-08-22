/**
 * A task body is a measurement taken on the day it was filed and rendered
 * forever as a present-tense description. Five times in one week an agent
 * picked up a row, reproduced its premise as it had been told to, and found
 * the premise had been overtaken — twice by work that had shipped hours
 * after the row was written.
 *
 * The measured shape of those five, on the real board (reproduced before any
 * of this was designed):
 *
 *   - four of the five bodies were BYTE-IDENTICAL to what was filed, three
 *     days and dozens of merges later. Board-wide, 74 of 81 bodies had never
 *     been corrected. Descriptions essentially never get revised.
 *   - all five had a comment saying the premise had moved. None of those
 *     comments reached the next reader: the pickup path returns `body` and
 *     drops the discussion.
 *   - the gap between "description written" and "newest note" was over 60h
 *     on every one of the five, and under 14h on every non-instance. The
 *     distribution is bimodal, which is why the threshold below is not
 *     load-bearing.
 *
 * So the arming rule reads a gap that is already recorded, and the payload is
 * the correction somebody already wrote. The tests below encode each of the
 * five as a synthetic fixture plus every silence, each with a positive
 * control so an assertion of absence can never be vacuous.
 *
 * Fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PREMISE_STALE_AFTER_MS,
  type PremiseNote,
  bodyWrittenAtOf,
  decidePremiseDrift,
} from '../src/task-staleness';
import { TaskStore } from '../src/tasks.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

function note(atMs: number, text = 'The premise moved; the read already exists.'): PremiseNote {
  return { ts: T0 + atMs, by: 'Reviewer', text };
}

describe('decidePremiseDrift — arming', () => {
  it('fires when the description has stood still for days while the task was discussed', () => {
    const drift = decidePremiseDrift({
      status: 'todo',
      bodyWrittenAt: T0,
      notes: [note(3 * DAY)],
    });
    expect(drift).not.toBeNull();
    expect(drift!.agedMs).toBe(3 * DAY);
    expect(drift!.headline).toContain('3 days');
  });

  it('carries every note that postdates the description, oldest first and uncapped', () => {
    // Clipping the correction to a preview is the failure being fixed, in a
    // smaller form: the reader is handed less than the record holds and has
    // to go and look anyway.
    const drift = decidePremiseDrift({
      status: 'todo',
      bodyWrittenAt: T0,
      notes: [note(3 * DAY, 'third'), note(2 * DAY, 'second'), note(-1 * HOUR, 'before the body')],
    });
    expect(drift!.notes.map((n) => n.text)).toEqual(['second', 'third']);
    // The note written BEFORE the description is not a correction of it.
    expect(drift!.notes.some((n) => n.text === 'before the body')).toBe(false);
  });

  it('says nothing about whether the task is done, in the copy itself', () => {
    // Four of the five instances still had real work in them after the
    // premise was corrected. The one thing this notice must never be read as
    // is a completion.
    const drift = decidePremiseDrift({
      status: 'in-progress',
      bodyWrittenAt: T0,
      notes: [note(3 * DAY)],
    });
    expect(drift!.headline).toContain('description');
    expect(drift!.advice).toContain('says nothing about whether the task is done');
  });
});

describe('decidePremiseDrift — the four silences', () => {
  it('is silent on a done task, so the reading can never be mistaken for one', () => {
    const notes = [note(3 * DAY)];
    // Positive control first: the same row, open, does fire.
    expect(decidePremiseDrift({ status: 'todo', bodyWrittenAt: T0, notes })).not.toBeNull();
    expect(decidePremiseDrift({ status: 'done', bodyWrittenAt: T0, notes })).toBeNull();
  });

  it('is silent once the description is rewritten — a correction clears it with no ack step', () => {
    const notes = [note(3 * DAY)];
    expect(decidePremiseDrift({ status: 'todo', bodyWrittenAt: T0, notes })).not.toBeNull();
    // The body is rewritten an hour after the newest note: the author has
    // now accounted for it.
    expect(
      decidePremiseDrift({ status: 'todo', bodyWrittenAt: T0 + 3 * DAY + HOUR, notes }),
    ).toBeNull();
  });

  it('is silent on a task nobody has said anything about — age alone is not contradiction', () => {
    // Without this, every untouched row in the backlog lights up and the
    // signal trains people to ignore it.
    expect(decidePremiseDrift({ status: 'todo', bodyWrittenAt: T0, notes: [] })).toBeNull();
    // Positive control: one note, and the same ancient body fires.
    expect(
      decidePremiseDrift({ status: 'todo', bodyWrittenAt: T0, notes: [note(9 * DAY)] }),
    ).not.toBeNull();
  });

  it('is silent on a conversation inside the window — filed this morning, discussed this afternoon', () => {
    expect(
      decidePremiseDrift({ status: 'todo', bodyWrittenAt: T0, notes: [note(6 * HOUR)] }),
    ).toBeNull();
    // Both sides of the boundary, so the threshold is actually asserted.
    expect(
      decidePremiseDrift({
        status: 'todo',
        bodyWrittenAt: T0,
        notes: [note(PREMISE_STALE_AFTER_MS - 1)],
      }),
    ).toBeNull();
    expect(
      decidePremiseDrift({
        status: 'todo',
        bodyWrittenAt: T0,
        notes: [note(PREMISE_STALE_AFTER_MS)],
      }),
    ).not.toBeNull();
  });
});

describe('decidePremiseDrift — the five instances that produced this', () => {
  /**
   * Each row is the real gap between the description and the newest note on
   * that task, measured off the live board. Titles and note text are
   * synthetic; only the timings are real.
   */
  const instances: { label: string; gapHours: number; status: 'todo' | 'in-progress' | 'done' }[] =
    [
      {
        label: 'read claimed missing; it shipped 32 minutes after filing',
        gapHours: 78.2,
        status: 'todo',
      },
      {
        label: 'measurement table overtaken by its own earlier PR',
        gapHours: 70.3,
        status: 'todo',
      },
      { label: 'route claimed absent; it answered correctly', gapHours: 80.1, status: 'todo' },
      {
        label: 'queue-and-replay claimed missing; already shipped',
        gapHours: 80.4,
        status: 'todo',
      },
      {
        label: 'intra-batch refs claimed to be the new work; then built',
        gapHours: 65.0,
        status: 'todo',
      },
    ];

  for (const inst of instances) {
    it(`flags: ${inst.label}`, () => {
      const drift = decidePremiseDrift({
        status: inst.status,
        bodyWrittenAt: T0,
        notes: [note(Math.round(inst.gapHours * HOUR), 'Reproduced first: the premise has moved.')],
      });
      expect(drift).not.toBeNull();
      expect(drift!.notes).toHaveLength(1);
    });
  }

  it('leaves the quiet rows alone — every non-instance gap on the same board was under 14h', () => {
    // The board's gap distribution is bimodal: 14h vs 60h+. This is the
    // negative half of the fixture set, and it is what keeps the flag rate
    // at 3 of 17 open rows rather than all of them.
    for (const gapHours of [8.2, 9.0, 9.6, 12.3, 12.4, 13.8]) {
      expect(
        decidePremiseDrift({
          status: 'todo',
          bodyWrittenAt: T0,
          notes: [note(Math.round(gapHours * HOUR))],
        }),
      ).toBeNull();
    }
  });
});

describe('bodyWrittenAtOf', () => {
  it('falls back to creation for a body that has never been rewritten', () => {
    expect(bodyWrittenAtOf({ createdAt: T0 })).toBe(T0);
    expect(bodyWrittenAtOf({ createdAt: T0, bodyWrittenAt: T0 + DAY })).toBe(T0 + DAY);
  });
});

describe('the store stamps a body clock the row clock cannot provide', () => {
  /**
   * `updateBodySnapshot` is the path EVERY real body edit takes: measured on
   * the live board, seven descriptions had been rewritten and `events.jsonl`
   * held zero `task.body_edited` rows, because that event only fires for the
   * wholesale-rewrite route. So if this path does not stamp the clock, the
   * clock is wrong for exactly the edits that happen.
   */
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'body-clock-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const newTask = () => {
    const ws = store.createWorkspace('clock');
    const res = store.createTask(ws.id, {
      title: 'Row',
      body: 'first',
      assignee: 'Reviewer',
      actor: { id: 'known-reviewer', name: 'Reviewer' },
    });
    if (!res.ok) throw new Error('fixture task was not created');
    return res.task;
  };

  it('stamps bodyWrittenAt when the live room flushes a CHANGED body', () => {
    const task = newTask();
    expect(task.bodyWrittenAt).toBeUndefined();
    expect(bodyWrittenAtOf(task)).toBe(task.createdAt);

    store.updateBodySnapshot(task.id, 'rewritten');
    const after = store.getTask(task.id)!;
    expect(after.bodyWrittenAt).toBeGreaterThanOrEqual(after.createdAt);
    expect(bodyWrittenAtOf(after)).toBe(after.bodyWrittenAt!);
  });

  it('does not stamp on a no-op flush — a re-flush must not make a stale body look fresh', () => {
    const task = newTask();
    store.updateBodySnapshot(task.id, 'rewritten');
    const stamped = store.getTask(task.id)!.bodyWrittenAt;
    expect(stamped).toBeDefined();

    // The debounced flush re-sends identical text routinely. If that moved
    // the clock, the drift notice would clear itself on the rows that need
    // it most, with nothing having been corrected.
    store.updateBodySnapshot(task.id, 'rewritten');
    expect(store.getTask(task.id)!.bodyWrittenAt).toBe(stamped);
  });

  it('leaves the body clock alone when only the ROW changes', () => {
    // `updatedAt` is bumped by twelve mutators including linkRef, which is
    // why it cannot stand in for a body clock.
    const task = newTask();
    store.updateBodySnapshot(task.id, 'rewritten');
    const stamped = store.getTask(task.id)!.bodyWrittenAt;

    store.linkRef(task.id, { kind: 'url', url: 'https://example.invalid/x' });
    const after = store.getTask(task.id)!;
    expect(after.bodyWrittenAt).toBe(stamped);
    expect(after.updatedAt).toBeGreaterThanOrEqual(stamped!);
  });
});
