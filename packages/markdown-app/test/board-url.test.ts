import { describe, expect, it } from 'vitest';
import {
  type BoardLocation,
  buildBoardUrl,
  goalShareUrl,
  historyStep,
  parseBoardLocation,
  resourceOf,
  taskShareUrl,
} from '../src/hub/board-url.ts';

const at = (over: Partial<BoardLocation>): BoardLocation => ({
  nav: 'tasks',
  task: null,
  goal: null,
  thread: null,
  item: null,
  archived: false,
  ...over,
});

describe('parseBoardLocation', () => {
  it('reads the bare workspace path as the board with nothing open', () => {
    expect(parseBoardLocation('/workspaces/w1', '')).toEqual(at({}));
  });

  it('reads the nav suffix', () => {
    expect(parseBoardLocation('/workspaces/w1/home', '').nav).toBe('home');
    expect(parseBoardLocation('/workspaces/w1/mine', '').nav).toBe('mine');
    expect(parseBoardLocation('/workspaces/w1/activity', '').nav).toBe('activity');
  });

  it('reads an open task, with the thread it is aimed at', () => {
    expect(parseBoardLocation('/workspaces/w1', '?task=t1&thread=th1')).toEqual(
      at({ task: 't1', thread: 'th1' }),
    );
  });

  it('reads an open goal', () => {
    expect(parseBoardLocation('/workspaces/w1', '?goal=g1')).toEqual(at({ goal: 'g1' }));
  });

  it('task wins when both task and goal are present', () => {
    const loc = parseBoardLocation('/workspaces/w1', '?task=t1&goal=g1');
    expect(loc.task).toBe('t1');
    expect(loc.goal).toBeNull();
  });

  it('ignores a thread with no panel to aim inside', () => {
    expect(parseBoardLocation('/workspaces/w1', '?thread=th1').thread).toBeNull();
  });

  it('reads the walkthrough item on Home, and only on Home', () => {
    expect(parseBoardLocation('/workspaces/w1/home', '?item=doc-thread%3Ad1%3At9').item).toBe(
      'doc-thread:d1:t9',
    );
    expect(parseBoardLocation('/workspaces/w1', '?item=doc-thread%3Ad1%3At9').item).toBeNull();
  });

  it('reads the archived filter', () => {
    expect(parseBoardLocation('/workspaces/w1', '?view=archived').archived).toBe(true);
  });
});

describe('buildBoardUrl', () => {
  it('round-trips every field', () => {
    const cases: BoardLocation[] = [
      at({}),
      at({ nav: 'home' }),
      at({ task: 't1' }),
      at({ task: 't1', thread: 'th1' }),
      at({ goal: 'g1', thread: 'th2' }),
      at({ nav: 'home', item: 'task-thread:task:t1:th' }),
      at({ archived: true }),
    ];
    for (const loc of cases) {
      const url = buildBoardUrl('w1', loc);
      const [pathname, search = ''] = url.split('?');
      expect(parseBoardLocation(pathname as string, search ? `?${search}` : '')).toEqual(loc);
    }
  });

  it('builds the bare board path with no dangling separators', () => {
    expect(buildBoardUrl('w1', at({}))).toBe('/workspaces/w1');
    expect(buildBoardUrl('w1', at({ nav: 'home' }))).toBe('/workspaces/w1/home');
  });

  it('encodes ids', () => {
    expect(buildBoardUrl('w 1', at({ task: 't/1' }))).toBe('/workspaces/w%201?task=t%2F1');
  });

  it('carries the identity override through, and nothing else', () => {
    const url = buildBoardUrl('w1', at({ task: 't1' }), '?as=bryan&walk=1&then=w2&stray=x');
    expect(url).toContain('as=bryan');
    expect(url).toContain('task=t1');
    expect(url).not.toContain('walk=');
    expect(url).not.toContain('then=');
    expect(url).not.toContain('stray=');
  });
});

describe('resourceOf', () => {
  it('names the open panel, task first', () => {
    expect(resourceOf(at({}))).toBeNull();
    expect(resourceOf(at({ task: 't1' }))).toBe('task:t1');
    expect(resourceOf(at({ goal: 'g1' }))).toBe('goal:g1');
    expect(resourceOf(at({ task: 't1', goal: 'g1' }))).toBe('task:t1');
  });

  it('names the walkthrough as one resource whatever item it is on', () => {
    expect(resourceOf(at({ nav: 'home', item: 'a' }))).toBe('walk');
    expect(resourceOf(at({ nav: 'home', item: 'b' }))).toBe('walk');
  });

  it('a panel opened over the walkthrough is the resource', () => {
    expect(resourceOf(at({ nav: 'home', item: 'a', task: 't1' }))).toBe('task:t1');
  });
});

describe('historyStep', () => {
  it('opening a resource is a navigation', () => {
    expect(historyStep(at({}), at({ task: 't1' }))).toBe('push');
    expect(historyStep(at({}), at({ goal: 'g1' }))).toBe('push');
    expect(historyStep(at({ nav: 'home' }), at({ nav: 'home', item: 'k' }))).toBe('push');
  });

  it('moving between resources is a navigation', () => {
    expect(historyStep(at({ task: 't1' }), at({ task: 't2' }))).toBe('push');
    expect(historyStep(at({ task: 't1' }), at({ goal: 'g1' }))).toBe('push');
  });

  it('changing nav destination is a navigation', () => {
    expect(historyStep(at({}), at({ nav: 'home' }))).toBe('push');
    expect(historyStep(at({ task: 't1' }), at({ nav: 'mine', task: 't1' }))).toBe('push');
  });

  it('refining the open resource rewrites the entry instead of adding one', () => {
    expect(historyStep(at({ task: 't1' }), at({ task: 't1', thread: 'th' }))).toBe('replace');
    expect(historyStep(at({ nav: 'home', item: 'a' }), at({ nav: 'home', item: 'b' }))).toBe(
      'replace',
    );
    expect(historyStep(at({}), at({ archived: true }))).toBe('replace');
    expect(historyStep(at({}), at({}))).toBe('replace');
  });

  it('closing the open resource unwinds', () => {
    expect(historyStep(at({ task: 't1' }), at({}))).toBe('close');
    expect(historyStep(at({ nav: 'home', item: 'a' }), at({ nav: 'home' }))).toBe('close');
  });

  it('closing while changing nav is a navigation, not an unwind', () => {
    // Tapping Home while the walkthrough is up on the board side has no such
    // path today, but a nav change always makes a new place — Back should
    // return to the old nav with its resource still open.
    expect(historyStep(at({ task: 't1' }), at({ nav: 'home' }))).toBe('push');
  });
});

describe('share URLs', () => {
  it('a task link is the bare board path plus ?task=, whatever page it is copied from', () => {
    expect(taskShareUrl('http://mac.local:8787', 'w1', 't1')).toBe(
      'http://mac.local:8787/workspaces/w1?task=t1',
    );
  });

  it('a goal link is the bare board path plus ?goal=', () => {
    expect(goalShareUrl('http://mac.local:8787', 'w1', 'g1')).toBe(
      'http://mac.local:8787/workspaces/w1?goal=g1',
    );
  });
});
