import { describe, expect, it } from 'vitest';
import { blockableStatus, blockerLookup, isBlocked, openBlockerIds } from './task-blocked.ts';

interface Row {
  id: string;
  status: string;
  after?: string[];
  archivedAt?: number;
}

const board = (...rows: Row[]) => blockerLookup(rows);

describe('openBlockerIds', () => {
  it('reports the ids of every dependency that is not finished', () => {
    const dep = { id: 't-dep', status: 'todo' };
    const other = { id: 't-other', status: 'in-progress' };
    const row = { id: 't-1', status: 'todo', after: [dep.id, other.id] };
    expect(openBlockerIds(row, board(dep, other, row))).toEqual([dep.id, other.id]);
  });

  it('a finished dependency blocks nothing', () => {
    const dep = { id: 't-dep', status: 'done' };
    const row = { id: 't-1', status: 'todo', after: [dep.id] };
    expect(openBlockerIds(row, board(dep, row))).toEqual([]);
  });

  it('an archived dependency blocks nothing — it is off the board', () => {
    // Positive control: the same open row blocks while it is on the board.
    const live = { id: 't-dep', status: 'todo' };
    const row = { id: 't-1', status: 'todo', after: [live.id] };
    expect(openBlockerIds(row, board(live, row))).toEqual([live.id]);
    const gone = { id: 't-dep', status: 'todo', archivedAt: 1 };
    expect(openBlockerIds(row, board(gone, row))).toEqual([]);
  });

  it('a dangling id cannot block — a deleted ticket must not wedge its dependants', () => {
    const row = { id: 't-1', status: 'todo', after: ['t-deleted'] };
    expect(openBlockerIds(row, board(row))).toEqual([]);
  });

  it('a row with no edges at all reads as unblocked', () => {
    const row = { id: 't-1', status: 'todo' };
    expect(openBlockerIds(row, board(row))).toEqual([]);
  });
});

describe('isBlocked', () => {
  it('a todo row waiting on an open ticket is blocked', () => {
    const dep = { id: 't-dep', status: 'todo' };
    const row = { id: 't-1', status: 'todo', after: [dep.id] };
    expect(isBlocked(row, board(dep, row))).toBe(true);
  });

  it('clears the moment the last blocker closes — nothing has to be written', () => {
    const dep = { id: 't-dep', status: 'todo' };
    const row = { id: 't-1', status: 'todo', after: [dep.id] };
    expect(isBlocked(row, board(dep, row))).toBe(true);
    expect(isBlocked(row, board({ ...dep, status: 'done' }, row))).toBe(false);
  });

  it('an in-progress row draws as blocked too — the queue drops it either way', () => {
    const dep = { id: 't-dep', status: 'todo' };
    const row = { id: 't-1', status: 'in-progress', after: [dep.id] };
    expect(isBlocked(row, board(dep, row))).toBe(true);
  });

  it('done and triage keep their own mark — each is a louder fact than waiting', () => {
    const dep = { id: 't-dep', status: 'todo' };
    for (const status of ['triage', 'done']) {
      const row = { id: 't-1', status, after: [dep.id] };
      expect(isBlocked(row, board(dep, row))).toBe(false);
      // …and the edge is still reported, which is what the queue reads.
      expect(openBlockerIds(row, board(dep, row))).toEqual([dep.id]);
    }
  });

  it('blockableStatus is the whole rule, and says so for every status', () => {
    expect(blockableStatus('todo')).toBe(true);
    expect(blockableStatus('in-progress')).toBe(true);
    expect(blockableStatus('triage')).toBe(false);
    expect(blockableStatus('done')).toBe(false);
    // A status this board has never heard of is not drawn as blocked: the
    // rule names what it covers rather than excluding what it does not.
    expect(blockableStatus('parked')).toBe(false);
  });
});
