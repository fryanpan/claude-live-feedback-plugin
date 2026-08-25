/**
 * The Home pane's pure model half: pane routing, the coverage sentence, the
 * board banner line, and the generating-poll rule. All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  HOME_POLL_CAP_MS,
  homeSinceLabel,
  navFromPath,
  navPath,
  paneForNav,
  paneFromPath,
  panePath,
  reviewBannerText,
  reviewQueue,
  reviewRowTitle,
  shouldPollHome,
  tabForNav,
  waitingLabel,
} from '../src/hub/hub-model.ts';
import type { HubNav, HubTask, ReviewItem, ReviewThreadItem } from '../src/hub/hub-model.ts';

const NOW = 1_700_000_000_000;

describe('paneFromPath / panePath', () => {
  it('the bare workspace path stays the board — every link in the field points there', () => {
    expect(paneFromPath('/workspaces/w-abc')).toBe('board');
    expect(paneFromPath('/workspaces/w-abc/')).toBe('board');
  });

  it('/home is the Home pane, deep-linkable, trailing slash tolerated', () => {
    expect(paneFromPath('/workspaces/w-abc/home')).toBe('home');
    expect(paneFromPath('/workspaces/w-abc/home/')).toBe('home');
  });

  it('anything else is the board, not a crash', () => {
    expect(paneFromPath('/review/doc-1')).toBe('board');
    expect(paneFromPath('/workspaces/w-abc/homely')).toBe('board');
  });

  it('panePath round-trips through paneFromPath, id encoded', () => {
    expect(paneFromPath(panePath('w-abc', 'home'))).toBe('home');
    expect(paneFromPath(panePath('w-abc', 'board'))).toBe('board');
    expect(panePath('w a', 'home')).toBe('/workspaces/w%20a/home');
  });
});

describe('navFromPath / navPath', () => {
  it('the bare workspace path is Tasks, for the reason the board always was', () => {
    expect(navFromPath('/workspaces/w-abc')).toBe('tasks');
    expect(navFromPath('/workspaces/w-abc/')).toBe('tasks');
  });

  it('every destination has a URL, which is the point of promoting them', () => {
    expect(navFromPath('/workspaces/w-abc/home')).toBe('home');
    expect(navFromPath('/workspaces/w-abc/mine')).toBe('mine');
    expect(navFromPath('/workspaces/w-abc/activity')).toBe('activity');
    expect(navFromPath('/workspaces/w-abc/mine/')).toBe('mine');
  });

  it('an unknown suffix is Tasks, not a crash', () => {
    expect(navFromPath('/workspaces/w-abc/minecraft')).toBe('tasks');
    expect(navFromPath('/review/doc-1')).toBe('tasks');
  });

  it('navPath round-trips all four, id encoded', () => {
    for (const nav of ['home', 'tasks', 'mine', 'activity'] as const) {
      expect(navFromPath(navPath('w-abc', nav))).toBe(nav);
    }
    expect(navPath('w a', 'mine')).toBe('/workspaces/w%20a/mine');
    expect(navPath('w-abc', 'tasks')).toBe('/workspaces/w-abc');
  });

  it('pane and tab derive from nav, and neither Home nor Activity resets the filter', () => {
    expect(paneForNav('home')).toBe('home');
    expect(['tasks', 'mine', 'activity'].map((n) => paneForNav(n as HubNav))).toEqual([
      'board',
      'board',
      'board',
    ]);
    expect(tabForNav('tasks')).toBe('all');
    expect(tabForNav('mine')).toBe('mine');
    // Undefined means "leave the reader's filter alone" — neither of these
    // renders task rows, so answering 'all' would silently undo their choice
    // on the way back.
    expect(tabForNav('home')).toBeUndefined();
    expect(tabForNav('activity')).toBeUndefined();
  });

  it('the old pane paths still resolve, so links already in the field survive', () => {
    expect(paneForNav(navFromPath(panePath('w-abc', 'home')))).toBe('home');
    expect(paneForNav(navFromPath(panePath('w-abc', 'board')))).toBe('board');
  });
});

describe('homeSinceLabel', () => {
  // Local-time fixtures, so the calendar-day comparisons hold in any TZ.
  const now = new Date(2026, 7, 17, 20, 0).getTime(); // Monday 8:00 pm
  // A payload whose brief states no coverage of its own — the pre-field
  // shape, and the shape the deterministic brief has when coverage equals
  // the window. Every case below fixes the window and varies nothing else.
  const at = (since: number, coversFrom?: number) => ({
    since,
    brief: {
      markdown: 'x',
      generatedAt: since,
      source: 'deterministic' as const,
      ...(coversFrom === undefined ? {} : { coversFrom }),
    },
  });

  it("reads as the mockup's window: From <point> until now", () => {
    const friday = new Date(2026, 7, 14, 18, 12).getTime();
    expect(homeSinceLabel(at(friday), now)).toBe('From Friday, 6:12 pm until now');
  });

  it('a window opening today says today, not a weekday', () => {
    const morning = new Date(2026, 7, 17, 6, 5).getTime();
    expect(homeSinceLabel(at(morning), now)).toBe('From today, 6:05 am until now');
  });

  it('yesterday is yesterday — a weekday name a day old is ambiguous next week', () => {
    const y = new Date(2026, 7, 16, 12, 0).getTime();
    expect(homeSinceLabel(at(y), now)).toBe('From yesterday, 12:00 pm until now');
  });

  it('older than a week gets the date, because a bare weekday would lie', () => {
    const old = new Date(2026, 7, 4, 9, 30).getTime();
    expect(homeSinceLabel(at(old), now)).toBe('From Aug 4, 9:30 am until now');
  });

  it('midnight and noon render as 12, not 0', () => {
    const midnight = new Date(2026, 7, 17, 0, 15).getTime();
    expect(homeSinceLabel(at(midnight), now)).toBe('From today, 12:15 am until now');
  });

  it("names the BRIEF's coverage start, not the window's, when the two differ", () => {
    // The reported defect: a 7-day window, a brief written from the newest
    // slice of it, and a card claiming the week. Both are asserted over the
    // same window so the difference can only come from `coversFrom`.
    const weekAgo = new Date(2026, 7, 10, 9, 0).getTime();
    const thisMorning = new Date(2026, 7, 17, 8, 50).getTime();
    expect(homeSinceLabel(at(weekAgo), now)).toBe('From Aug 10, 9:00 am until now');
    expect(homeSinceLabel(at(weekAgo, thisMorning), now)).toBe('From today, 8:50 am until now');
  });
});

describe('waitingLabel', () => {
  it('days, singular and plural', () => {
    expect(waitingLabel(NOW - 2 * 86_400_000, NOW)).toBe('waiting 2 days');
    expect(waitingLabel(NOW - 1 * 86_400_000, NOW)).toBe('waiting 1 day');
  });

  it('hours and minutes below a day', () => {
    expect(waitingLabel(NOW - 4 * 3_600_000, NOW)).toBe('waiting 4 hours');
    expect(waitingLabel(NOW - 12 * 60_000, NOW)).toBe('waiting 12 minutes');
  });

  it('under a minute says moments, not 0 minutes', () => {
    expect(waitingLabel(NOW - 20_000, NOW)).toBe('waiting moments');
  });
});

describe('reviewRowTitle', () => {
  const item = (over: Partial<ReviewItem>): ReviewItem => ({
    key: 'k',
    kind: 'task-thread',
    title: 'Ship the widget',
    ask: '',
    why: 'Reviewer asked you 2m ago · on this task',
    since: NOW,
    ...over,
  });

  it('the question itself is the row title when there is one', () => {
    expect(reviewRowTitle(item({ ask: 'Which repo does this land in?' }))).toBe(
      'Which repo does this land in?',
    );
  });

  it('falls back to the subject when the ask is empty (a decision title IS the question)', () => {
    expect(reviewRowTitle(item({}))).toBe('Ship the widget');
  });
});

describe('reviewBannerText', () => {
  const decision = (id: string): HubTask => ({
    id,
    title: `Decide ${id}`,
    status: 'todo',
    assignee: 'human',
    needs: 'decision',
    goal: 'chores',
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const thread: ReviewThreadItem = {
    kind: 'doc-thread',
    docId: 'doc-1',
    threadId: 'th-1',
    title: 'Plan',
    ask: 'Keep the appendix?',
    askedBy: 'Helper',
    since: NOW - 1000,
  };

  it('null when nothing is waiting — the banner only exists while items are open', () => {
    expect(reviewBannerText(reviewQueue([], [], NOW))).toBeNull();
  });

  it('states presence without a count, whatever the size (Bryan: "Remove the count")', () => {
    expect(reviewBannerText(reviewQueue([decision('t-1')], [], NOW))).toBe(
      'Something is waiting for your review',
    );
    expect(reviewBannerText(reviewQueue([decision('t-1')], [thread], NOW))).toBe(
      'Something is waiting for your review',
    );
    // The regression this pins: no digit may leak back into the line.
    expect(reviewBannerText(reviewQueue([decision('t-1')], [thread], NOW))).not.toMatch(/\d/);
  });
});

describe('shouldPollHome', () => {
  it('polls only on a grounded generating flag, and gives up at the cap', () => {
    const started = NOW;
    expect(shouldPollHome({ generating: true }, started, NOW + 1000)).toBe(true);
    expect(shouldPollHome({ generating: false }, started, NOW + 1000)).toBe(false);
    expect(shouldPollHome(null, started, NOW + 1000)).toBe(false);
    expect(shouldPollHome({ generating: true }, started, NOW + HOME_POLL_CAP_MS)).toBe(false);
  });
});
