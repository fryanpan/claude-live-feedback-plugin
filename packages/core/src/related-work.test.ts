/**
 * The matching step, on fixtures shaped like the incident it exists for.
 *
 * The board in these fixtures is the one from 2026-09-02: a live goal about
 * the meeting-notes UX, an unrelated goal about the widget bundle, the plan
 * doc that already covers the first goal, and the huddle notes the request
 * came out of. What the suite has to pin down is not "does overlap work" but
 * the three answers the caller branches on — a real match ranked first, a
 * near miss dropped rather than ranked last, and a link carrying a candidate
 * that shares no words.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLD,
  type RelatedWorkCandidate,
  readsAsPlan,
  relatedWorkTerms,
  scoreRelatedWork,
} from './related-work.ts';

const MEETING_GOAL: RelatedWorkCandidate = {
  kind: 'goal',
  id: 'g-meeting',
  title: 'Bryan can read meeting notes that are worth keeping',
  body: 'The notes a live huddle produces should stand on their own the next morning. Capture, correction and the notes doc are all in scope.',
  url: '/workspaces/w-fixture?goal=g-meeting',
};

const WIDGET_GOAL: RelatedWorkCandidate = {
  kind: 'goal',
  id: 'g-widget',
  title: 'A host site can embed the widget without a bundle regression',
  body: 'Keep the injectable widget under its size budget on every release.',
  url: '/workspaces/w-fixture?goal=g-widget',
};

const NOTES_PLAN_DOC: RelatedWorkCandidate = {
  kind: 'doc',
  id: 'd-notes-plan',
  title: 'Meeting notes UX plan',
  path: 'docs/product/plans/meeting-notes-ux-plan.md',
  body: 'How the notes strip behaves during a huddle, and what the agent writes when the room falls quiet.',
  url: '/review/d-notes-plan',
};

const HUDDLE_NOTES: RelatedWorkCandidate = {
  kind: 'doc',
  id: 'd-huddle-0902',
  title: 'Huddle notes',
  path: 'data/huddles/2026-09-02.md',
  body: 'Bryan asked why planning ignored the board.',
  url: '/review/d-huddle-0902',
};

const BOARD = [MEETING_GOAL, WIDGET_GOAL, NOTES_PLAN_DOC, HUDDLE_NOTES];

describe('relatedWorkTerms', () => {
  it('drops stopwords and short words, and folds a plural onto its singular', () => {
    const terms = relatedWorkTerms('The meeting notes are for a huddle');
    expect([...terms].sort()).toEqual(['huddle', 'meeting', 'note']);
  });

  it('reads an empty set out of nothing rather than throwing', () => {
    expect(relatedWorkTerms(undefined).size).toBe(0);
    expect(relatedWorkTerms('a of an  ').size).toBe(0);
  });
});

describe('readsAsPlan', () => {
  it('accepts a plan named in the title or in a path segment', () => {
    expect(readsAsPlan({ title: 'Meeting notes UX plan' })).toBe(true);
    expect(readsAsPlan({ title: 'Notes', path: 'docs/product/plans/notes.md' })).toBe(true);
    expect(readsAsPlan({ title: 'Streamlined review design' })).toBe(true);
  });

  it('rejects notes and a word that merely contains a plan word', () => {
    expect(readsAsPlan({ title: 'Huddle notes', path: 'data/huddles/2026-09-02.md' })).toBe(false);
    // "explanation" contains "plan" — a substring match would fire here.
    expect(readsAsPlan({ title: 'An explanation of the queue' })).toBe(false);
  });
});

describe('scoreRelatedWork', () => {
  it('ranks the goal and the plan doc that line up above everything else', () => {
    const matches = scoreRelatedWork('Plan the meeting notes UX so notes are worth keeping', BOARD);
    expect(matches.map((m) => m.id)).toEqual(['g-meeting', 'd-notes-plan']);
    // The goal is where the plan would land, so it leads.
    expect(matches[0]?.kind).toBe('goal');
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 1);
  });

  it('names the evidence in the reason, not the score', () => {
    const [top] = scoreRelatedWork('Plan the meeting notes UX', BOARD);
    expect(top?.reason).toContain('title shares');
    expect(top?.matchedTerms).toContain('meeting');
    expect(top?.matchedTerms).toContain('note');
    expect(top?.reason).not.toContain(String(top?.score));
  });

  it('answers an empty list when nothing on the board lines up', () => {
    // A real request, about work this board has never held.
    expect(scoreRelatedWork('Rotate the Postmark sending credentials', BOARD)).toEqual([]);
  });

  it('drops a near miss instead of ranking it last', () => {
    const query = 'meeting notes capture';
    const matches = scoreRelatedWork(query, BOARD);
    expect(matches.map((m) => m.id)).toEqual(['g-meeting', 'd-notes-plan']);
    for (const m of matches) expect(m.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);

    // The dropped rows are dropped BY THE THRESHOLD, which is the claim this
    // test exists to make. Scored with the threshold off, the huddle notes do
    // share a word and the widget goal shares none — so the run above proves
    // a scoring boundary rather than an empty candidate set.
    const unfiltered = scoreRelatedWork(query, BOARD, { threshold: 0 });
    const scoreOf = (id: string) => unfiltered.find((m) => m.id === id)?.score ?? -1;
    expect(scoreOf('d-huddle-0902')).toBeGreaterThan(0);
    expect(scoreOf('d-huddle-0902')).toBeLessThan(DEFAULT_THRESHOLD);
    expect(scoreOf('g-widget')).toBe(0);
  });

  it('returns a candidate whose only relation is a link, with the link as its reason', () => {
    const linkOnly: RelatedWorkCandidate = {
      kind: 'goal',
      id: 'g-share',
      title: 'A collaborator can join a board from a share link',
      linked: true,
      linkNote: 'links the huddle notes this request came from',
    };
    const matches = scoreRelatedWork('Rotate the Postmark sending credentials', [
      ...BOARD,
      linkOnly,
    ]);
    expect(matches.map((m) => m.id)).toEqual(['g-share']);
    expect(matches[0]?.linked).toBe(true);
    expect(matches[0]?.reason).toContain('links the huddle notes');
    expect(matches[0]?.matchedTerms).toEqual([]);
  });

  it('lets a link lift a weak text match above a stronger unlinked one', () => {
    const linked = { ...WIDGET_GOAL, linked: true, linkNote: 'linked from the request' };
    const matches = scoreRelatedWork('widget bundle', [MEETING_GOAL, linked]);
    expect(matches[0]?.id).toBe('g-widget');
  });

  it('honours a caller-supplied limit and threshold', () => {
    const wide = scoreRelatedWork('meeting notes huddle plan widget', BOARD, { threshold: 0 });
    expect(wide.length).toBe(4);
    const one = scoreRelatedWork('meeting notes huddle plan widget', BOARD, {
      threshold: 0,
      limit: 1,
    });
    expect(one.length).toBe(1);
    expect(one[0]?.id).toBe(wide[0]?.id);
  });

  it('scores a candidate with no body on its title alone rather than penalizing it', () => {
    const bodiless: RelatedWorkCandidate = {
      kind: 'goal',
      id: 'g-bare',
      title: 'Meeting notes',
    };
    const [top] = scoreRelatedWork('meeting notes', [bodiless]);
    expect(top?.id).toBe('g-bare');
    expect(top?.score).toBeGreaterThan(DEFAULT_THRESHOLD);
  });

  it('keeps a total order, so two candidates scoring the same never swap', () => {
    const twinA: RelatedWorkCandidate = { kind: 'doc', id: 'd-b', title: 'meeting notes' };
    const twinB: RelatedWorkCandidate = { kind: 'doc', id: 'd-a', title: 'meeting notes' };
    const once = scoreRelatedWork('meeting notes', [twinA, twinB]).map((m) => m.id);
    const again = scoreRelatedWork('meeting notes', [twinB, twinA]).map((m) => m.id);
    expect(once).toEqual(['d-a', 'd-b']);
    expect(again).toEqual(once);
  });
});
