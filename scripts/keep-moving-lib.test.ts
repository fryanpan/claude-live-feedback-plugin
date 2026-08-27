import { describe, expect, it } from 'vitest';
import { agentActivityByHour, classifyOpenTasks, collectActivityTicks } from './keep-moving-lib.ts';

const H = 3_600_000;
const now = 100 * H;
const bands = { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) };
const task = (over: Record<string, unknown>) => ({
  id: 'x',
  title: 't',
  status: 'todo',
  goal: 'g1',
  createdAt: now - 10 * H,
  ...over,
});

describe('keep-moving classification', () => {
  it('a filed ask outranks everything: blocked-on-owner, never stalled', () => {
    const rows = classifyOpenTasks([task({ id: 'a' })], [], [{ taskId: 'a' }], now, 4 * H, bands);
    expect(rows[0]?.bucket).toBe('blocked-on-owner');
    expect(rows[0]?.stalled).toBe(false);
  });

  it('an unmet dependency blocks; a done one does not', () => {
    const rows = classifyOpenTasks(
      [
        task({ id: 'a', after: ['dep'] }),
        task({ id: 'b', after: ['gone'] }),
        task({ id: 'dep', status: 'in-progress' }),
        task({ id: 'gone', status: 'done' }),
      ],
      [],
      [],
      now,
      4 * H,
      bands,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.a?.bucket).toBe('blocked-on-dependency');
    expect(byId.a?.blockers).toEqual(['dep']);
    // b's dependency is done — b is ready, and 10h quiet makes it stalled.
    expect(byId.b?.bucket).toBe('ready-unpicked');
    expect(byId.b?.stalled).toBe(true);
  });

  it('a band the goal list does not name is backlog by rule, not a failure', () => {
    const rows = classifyOpenTasks([task({ goal: 'chores' })], [], [], now, 4 * H, bands);
    expect(rows[0]?.bucket).toBe('backlog-unranked');
    expect(rows[0]?.stalled).toBe(false);
  });

  it('a recent board event resets the stall clock', () => {
    const rows = classifyOpenTasks(
      [task({ id: 'a', status: 'in-progress', transitions: [{ ts: now - 20 * H }] })],
      [{ taskId: 'a', ts: now - H }],
      [],
      now,
      4 * H,
      bands,
    );
    expect(rows[0]?.stalled).toBe(false);
  });

  it('activity buckets count only agent actors, newest hour first', () => {
    const events = [
      { ts: now - 30 * 60_000, actor: { kind: 'agent' } },
      { ts: now - 90 * 60_000, actor: { kind: 'person' } },
      { ts: now - 90 * 60_000, actor: { kind: 'agent' } },
    ];
    expect(agentActivityByHour(events, now, 3)).toEqual([1, 1, 0]);
  });
});

// The four measured false-FAIL gaps (board task t-heInRFyyCfNs, 2026-08-27).
// Each failed against the pre-fix logic — the red run is in the PR body.
describe('keep-moving false-FAIL gaps', () => {
  it('gap 1: a person-owned row is blocked-on-owner, never a dark in-progress row', () => {
    // Measured: t-Q6DTQn05IMPo (assignee "human", server ownerKind "person")
    // reported as a dark in-progress row.
    const rows = classifyOpenTasks(
      [task({ id: 'a', status: 'in-progress', ownerKind: 'person', assignee: 'human' })],
      [],
      [],
      now,
      4 * H,
      bands,
    );
    expect(rows[0]?.bucket).toBe('blocked-on-owner');
    expect(rows[0]?.stalled).toBe(false);
  });

  it('gap 2: a fresh comment on the task thread resets the quiet clock', () => {
    // Measured: t-9Ujf8EcjSpbR flagged 12.4h quiet on a day the whole decision
    // conversation was live on its task:<id> thread.
    const rows = classifyOpenTasks(
      [task({ id: 'a', status: 'in-progress', transitions: [{ ts: now - 20 * H }] })],
      [],
      [],
      now,
      4 * H,
      bands,
      new Map([['a', now - H]]),
    );
    expect(rows[0]?.stalled).toBe(false);
    expect(rows[0]?.sinceActivityMs).toBe(H);
  });

  it('gap 3: row edits and review filings count as activity the events feed missed', () => {
    // Measured: Team Lead board read "0/12 hours" across a window with a row
    // update at 07:19Z that never appeared in /events.
    const ticks = collectActivityTicks(
      [task({ id: 'a', updatedAt: now - 30 * 60_000 })],
      [{ taskId: 'a', askedAt: now - 90 * 60_000 }],
    );
    expect(agentActivityByHour([], now, 3, ticks)).toEqual([1, 1, 0]);
  });

  it('gap 3: identical row timestamps dedupe to one tick', () => {
    const ticks = collectActivityTicks(
      [task({ id: 'a', updatedAt: now - H, bodyWrittenAt: now - H, titleWrittenAt: now - 2 * H })],
      [],
    );
    expect(ticks.sort((x, y) => y - x)).toEqual([now - H, now - 2 * H]);
  });

  it('gap 4: a row parked into the future is parked, never stalled', () => {
    // Measured 07:59Z: t-FbXgQ6m9e-et parked to 2026-08-28 (parkedUntil epoch
    // ms) yet reported "ready-unpicked stalled".
    const rows = classifyOpenTasks(
      [task({ id: 'a', parkedUntil: now + 24 * H })],
      [],
      [],
      now,
      4 * H,
      bands,
    );
    expect(rows[0]?.bucket).toBe('parked');
    expect(rows[0]?.stalled).toBe(false);
  });

  it('gap 4: an expired park does not shield the row', () => {
    const rows = classifyOpenTasks(
      [task({ id: 'a', parkedUntil: now - H })],
      [],
      [],
      now,
      4 * H,
      bands,
    );
    expect(rows[0]?.bucket).toBe('ready-unpicked');
    expect(rows[0]?.stalled).toBe(true);
  });
});

// Codex adversarial review of PR #394 — two P2 findings, tests written red-first.
describe('codex P2 findings', () => {
  it('P2-1: a filed ask outranks a park — blocked-on-owner, not parked', () => {
    // A parked row with an active ask on Bryan (filed review item, person
    // owner, or owner-band goal) must surface as blocked-on-owner; bucketing
    // it parked hides the ask. Same invariant the first test in this file
    // states: a filed ask outranks everything.
    const rows = classifyOpenTasks(
      [
        task({ id: 'asked', parkedUntil: now + 24 * H }),
        task({ id: 'human', parkedUntil: now + 24 * H, ownerKind: 'person' }),
      ],
      [],
      [{ taskId: 'asked' }],
      now,
      4 * H,
      bands,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.asked?.bucket).toBe('blocked-on-owner');
    expect(byId.human?.bucket).toBe('blocked-on-owner');
    expect(byId.asked?.stalled).toBe(false);
    expect(byId.human?.stalled).toBe(false);
  });

  it('P2-2: a row edit already reported by /events is not double-counted', () => {
    // updatedAt advances on a normal transition AND the same action appears
    // in /events — an unconditional tick counts one action twice, inflating
    // the histogram exactly when the events feed works.
    const eventTs = now - 30 * 60_000;
    const events = [{ taskId: 'a', ts: eventTs, actor: { kind: 'agent' } }];
    const ticks = collectActivityTicks([task({ id: 'a', updatedAt: eventTs + 1_000 })], [], events);
    expect(ticks).toEqual([]);
    expect(agentActivityByHour(events, now, 3, ticks)).toEqual([1, 0, 0]);
  });

  it('P2-2: an edit no event covers still counts (the gap-3 fix survives)', () => {
    const events = [{ taskId: 'a', ts: now - 30 * 60_000, actor: { kind: 'agent' } }];
    const ticks = collectActivityTicks(
      [task({ id: 'a', updatedAt: now - 90 * 60_000 })], // far from any event
      [],
      events,
    );
    expect(agentActivityByHour(events, now, 3, ticks)).toEqual([1, 1, 0]);
  });
});
