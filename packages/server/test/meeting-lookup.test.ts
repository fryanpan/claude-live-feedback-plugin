/**
 * Resolving what a meeting asked to have pulled in: the recency vocabulary,
 * the title path, and — the part that matters most — everything that comes
 * out as no link at all.
 *
 * The negative cases outnumber the positive ones on purpose. A link in the
 * notes puts the board's authority behind a connection nobody made, so an
 * ambiguous title, an empty window, and a doc nobody has ever met over must
 * each resolve to nothing rather than to the nearest thing.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import {
  type LookupDoc,
  MAX_LOOKUP_DOCS,
  boardLookupDocs,
  docLookupUrl,
  lookupWhen,
  parseRecency,
  resolveLookup,
} from '../src/meeting-lookup.ts';

/** Wednesday 2026-08-26, 15:00 local — mid-week, so "last week" and the
 *  weekday names have unambiguous answers on either side of it. */
const NOW = new Date(2026, 7, 26, 15, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 10): number =>
  new Date(y, m - 1, d, h, 0, 0).getTime();

const docs: LookupDoc[] = [
  { docId: 'd-rollout', title: 'Rollout plan for the offline queue', meetingAt: at(2026, 8, 19) },
  { docId: 'd-huddle-tue', title: 'Huddle 2026-08-25 09:30', meetingAt: at(2026, 8, 25, 9) },
  { docId: 'd-huddle-mon', title: 'Huddle 2026-08-24 14:05', meetingAt: at(2026, 8, 24, 14) },
  { docId: 'd-charter', title: 'Team charter' },
];
const tasks = [
  { id: 't-1', title: 'Badge counts invitations nobody accepted' },
  { id: 't-2', title: 'Export dialog forgets the chosen range' },
];
const pool = { docs, tasks };

describe('parseRecency', () => {
  it('reads last week as the previous calendar week', () => {
    const w = parseRecency("pull in last week's notes", NOW);
    expect(w?.label).toBe('last week');
    // Monday 2026-08-17 00:00 through Monday 2026-08-24 00:00.
    expect(w?.from).toBe(at(2026, 8, 17, 0));
    expect(w?.to).toBe(at(2026, 8, 24, 0));
  });

  it('reads this week as the running week so far', () => {
    const w = parseRecency('what did we say this week', NOW);
    expect(w?.from).toBe(at(2026, 8, 24, 0));
    expect(w?.to).toBe(NOW);
  });

  it('reads yesterday as the whole previous day', () => {
    const w = parseRecency("bring up yesterday's decisions", NOW);
    expect(w?.from).toBe(at(2026, 8, 25, 0));
    expect(w?.to).toBe(at(2026, 8, 26, 0));
  });

  it('reads this morning as today so far', () => {
    expect(parseRecency('the notes from this morning', NOW)?.from).toBe(at(2026, 8, 26, 0));
  });

  it('reads last month as the previous calendar month', () => {
    const w = parseRecency('the plan we wrote last month', NOW);
    expect(w?.from).toBe(at(2026, 7, 1, 0));
    expect(w?.to).toBe(at(2026, 8, 1, 0));
  });

  it('reads a weekday as its most recent occurrence', () => {
    // Spoken on Wednesday, "Monday" is two days back, not nine.
    expect(parseRecency('what we agreed on Monday', NOW)?.from).toBe(at(2026, 8, 24, 0));
  });

  it('reads today as today when the weekday spoken is today', () => {
    expect(parseRecency('the Wednesday session', NOW)?.from).toBe(at(2026, 8, 26, 0));
  });

  it('never reaches into the future for a weekday still to come', () => {
    // Friday, spoken on Wednesday, is LAST Friday.
    expect(parseRecency('what we said Friday', NOW)?.from).toBe(at(2026, 8, 21, 0));
  });

  it('reads "the last meeting" as an open window', () => {
    const w = parseRecency('can you pull up the last meeting', NOW);
    expect(w?.from).toBe(0);
    expect(w?.label).toBe('the last meeting');
  });

  it('prefers the longer phrase over a fragment of itself', () => {
    // "last week" must not be read as "the last meeting" via "last".
    expect(parseRecency('last week', NOW)?.label).toBe('last week');
  });

  it('finds no window in speech that names no time', () => {
    expect(parseRecency('pull in the rollout plan', NOW)).toBeNull();
  });
});

describe('resolveLookup', () => {
  it('resolves a doc by title', () => {
    const hit = resolveLookup('the rollout plan for the offline queue', pool, NOW);
    expect(hit).toEqual({
      kind: 'doc',
      docId: 'd-rollout',
      title: 'Rollout plan for the offline queue',
      via: 'title',
      meetingAt: at(2026, 8, 19),
    });
  });

  it('falls back to a board row when the material is a row', () => {
    const hit = resolveLookup('the export dialog range ticket', pool, NOW);
    expect(hit).toEqual({
      kind: 'task',
      taskId: 't-2',
      title: 'Export dialog forgets the chosen range',
      via: 'title',
    });
  });

  it('reaches a past meeting by when, with no title to match on', () => {
    // "notes" matches every doc and "week" is a stopword — time is the only
    // thing in this ask that identifies anything.
    const hit = resolveLookup("pull in last week's notes", pool, NOW);
    expect(hit).toEqual({
      kind: 'doc',
      docId: 'd-rollout',
      title: 'Rollout plan for the offline queue',
      via: 'recency',
      meetingAt: at(2026, 8, 19),
    });
  });

  it('takes the newest meeting inside the window', () => {
    const hit = resolveLookup('what did we decide this week', pool, NOW);
    expect(hit?.kind === 'doc' && hit.docId).toBe('d-huddle-tue');
  });

  it('reaches huddles, which are docs like any other', () => {
    const hit = resolveLookup('the huddle from Monday', pool, NOW);
    expect(hit?.kind === 'doc' && hit.docId).toBe('d-huddle-mon');
  });

  it('resolves nothing when the window holds no meeting', () => {
    expect(resolveLookup("yesterday's notes", { docs: [docs[0] as LookupDoc], tasks }, NOW)).toBe(
      null,
    );
  });

  it('never reaches a doc nobody has met over by recency alone', () => {
    const onlyCharter = { docs: [docs[3] as LookupDoc], tasks: [] };
    expect(resolveLookup('the last meeting', onlyCharter, NOW)).toBeNull();
  });

  it('resolves nothing rather than the better of two alike titles', () => {
    const twins = {
      docs: [
        { docId: 'd-a', title: 'Offline queue design' },
        { docId: 'd-b', title: 'Offline queue rollout' },
      ],
      tasks: [],
    };
    expect(resolveLookup('the offline queue one', twins, NOW)).toBeNull();
  });

  it('lets a spoken when separate two alike titles', () => {
    const twins = {
      docs: [
        { docId: 'd-a', title: 'Offline queue notes', meetingAt: at(2026, 8, 19) },
        { docId: 'd-b', title: 'Offline queue notes', meetingAt: at(2026, 8, 25, 9) },
      ],
      tasks: [],
    };
    const hit = resolveLookup('the offline queue notes from yesterday', twins, NOW);
    expect(hit?.kind === 'doc' && hit.docId).toBe('d-b');
  });

  it('resolves nothing for an empty query or an empty board', () => {
    expect(resolveLookup('   ', pool, NOW)).toBeNull();
    expect(resolveLookup('the rollout plan', { docs: [], tasks: [] }, NOW)).toBeNull();
  });
});

describe('link shape', () => {
  it('builds a root-relative canonical doc URL', () => {
    expect(docLookupUrl('w-1', 'd-rollout')).toBe('/workspaces/w-1/docs/d-rollout');
  });

  it('escapes ids rather than pasting them into a path', () => {
    expect(docLookupUrl('w /1', 'd?x')).toBe('/workspaces/w%20%2F1/docs/d%3Fx');
  });

  it("says when in the speaker's own frame when they gave one", () => {
    const hit = resolveLookup("last week's notes", pool, NOW);
    const when = parseRecency("last week's notes", NOW);
    expect(hit && lookupWhen(hit, when)).toBe('last week');
  });

  it('dates a meeting found by name instead', () => {
    const hit = resolveLookup('the rollout plan for the offline queue', pool, NOW);
    expect(hit && lookupWhen(hit, null)).toBe('2026-08-19');
  });

  it('says nothing about a doc that never carried a meeting', () => {
    const hit = resolveLookup('the team charter', pool, NOW);
    expect(hit?.kind === 'doc' && hit.docId).toBe('d-charter');
    expect(hit && lookupWhen(hit, null)).toBeUndefined();
  });

  it('dates no board row', () => {
    const hit = resolveLookup('the export dialog range ticket', pool, NOW);
    expect(hit && lookupWhen(hit, null)).toBeUndefined();
  });
});

describe('boardLookupDocs', () => {
  const sources = {
    docIds: (ws: string) =>
      ws === 'w-1' ? ['d-self', 'd-untitled', 'd-charter', 'd-broken', 'd-huddle'] : undefined,
    docTitle: (id: string) =>
      ({
        'd-self': 'The meeting in progress',
        'd-charter': 'Team charter',
        'd-broken': 'Doc with an unreadable index',
        'd-huddle': 'Huddle 2026-08-24 14:05',
      })[id],
    lastMeetingAt: (id: string) => {
      if (id === 'd-broken') throw new Error('meeting index unreadable');
      return id === 'd-huddle' ? at(2026, 8, 24, 14) : undefined;
    },
  };

  it('offers the board its docs, with when each last carried a meeting', () => {
    expect(boardLookupDocs(sources, 'w-1', 'd-self')).toEqual([
      { docId: 'd-charter', title: 'Team charter' },
      { docId: 'd-broken', title: 'Doc with an unreadable index' },
      { docId: 'd-huddle', title: 'Huddle 2026-08-24 14:05', meetingAt: at(2026, 8, 24, 14) },
    ]);
  });

  it('never offers the doc the meeting is in', () => {
    // "Pull up the last meeting" means the one before this one, and the notes
    // being written are already here.
    const ids = boardLookupDocs(sources, 'w-1', 'd-self').map((d) => d.docId);
    expect(ids).not.toContain('d-self');
  });

  it('skips a doc with no title — nothing to match on, nothing to show', () => {
    expect(boardLookupDocs(sources, 'w-1', 'd-self').map((d) => d.docId)).not.toContain(
      'd-untitled',
    );
  });

  it('an unreadable meeting index costs that doc its when, not the lookup', () => {
    const broken = boardLookupDocs(sources, 'w-1', 'd-self').find((d) => d.docId === 'd-broken');
    expect(broken).toEqual({ docId: 'd-broken', title: 'Doc with an unreadable index' });
  });

  it('offers nothing for a board that does not exist', () => {
    expect(boardLookupDocs(sources, 'w-gone', 'd-self')).toEqual([]);
  });

  it('caps how many docs one spoken sentence can stat', () => {
    const many = Array.from({ length: MAX_LOOKUP_DOCS + 25 }, (_, i) => `d-${i}`);
    const wide = {
      docIds: () => many,
      docTitle: (id: string) => `Doc ${id}`,
      lastMeetingAt: () => undefined,
    };
    expect(boardLookupDocs(wide, 'w-1', 'none')).toHaveLength(MAX_LOOKUP_DOCS);
  });
});
