import { describe, expect, it } from 'vitest';
import { agentActivityByHour, classifyOpenTasks } from './keep-moving-lib.ts';

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
