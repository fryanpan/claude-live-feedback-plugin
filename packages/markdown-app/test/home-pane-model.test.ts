/**
 * The Home pane's pure model half: pane routing, the coverage sentence, the
 * board banner line, and the generating-poll rule. All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  HOME_POLL_CAP_MS,
  homeSinceLabel,
  paneFromPath,
  panePath,
  reviewBannerText,
  reviewQueue,
  shouldPollHome,
} from '../src/hub/hub-model.ts';
import type { HubTask, ReviewThreadItem } from '../src/hub/hub-model.ts';

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

describe('homeSinceLabel', () => {
  it('a never-marked reader gets the bounded window stated as a bound', () => {
    expect(homeSinceLabel({ lastReadAt: 0 }, NOW)).toBe('Covering the last 7 days');
  });

  it('a marked reader gets their own marker, phrased personally', () => {
    expect(homeSinceLabel({ lastReadAt: NOW - 2 * 3_600_000 }, NOW)).toBe(
      'Since you caught up 2h ago',
    );
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

  it('singular and plural, counting every kind', () => {
    expect(reviewBannerText(reviewQueue([decision('t-1')], [], NOW))).toBe(
      '1 item is waiting for your review',
    );
    expect(reviewBannerText(reviewQueue([decision('t-1')], [thread], NOW))).toBe(
      '2 items are waiting for your review',
    );
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
