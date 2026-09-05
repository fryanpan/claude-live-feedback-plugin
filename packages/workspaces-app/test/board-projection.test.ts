import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createBoardProjection, initialBoardState } from '../src/board/board-projection.ts';
import { parseBoardLocation } from '../src/board/board-url.ts';
import { boardState, mountShell } from './support/board-region-harness.ts';

/**
 * The board renders FROM the server-owned `tasks` / `workspace` maps, and the
 * header has two writers — the boot REST fetch and every projection read.
 * These drive the read itself: what it copies out of the ydoc, and that the
 * name, the retired badge and the tab title all follow it without a reload.
 */
describe('createBoardProjection', () => {
  let el: (id: string) => HTMLElement;
  beforeEach(() => {
    el = mountShell('harbor-relay', 'w-1');
  });

  function projection(state = boardState()) {
    const doc = new Y.Doc();
    const tasks = doc.getMap('tasks');
    const ws = doc.getMap('workspace');
    const api = createBoardProjection({
      state,
      workspaceId: 'w-1',
      document,
      maps: () => ({ tasks, ws }),
    });
    return { state, tasks, ws, ...api };
  }

  it('copies the ydoc rows into state.tasks', () => {
    const p = projection();
    p.tasks.set('t-1', { id: 't-1', title: 'Ship it' } as never);
    p.readProjection();
    expect([...p.state.tasks.keys()]).toEqual(['t-1']);
    expect(p.state.tasks.get('t-1')?.title).toBe('Ship it');
  });

  it('replaces the row set rather than merging into it, so a deleted task leaves', () => {
    const p = projection();
    p.tasks.set('t-1', { id: 't-1', title: 'Ship it' } as never);
    p.readProjection();
    p.tasks.delete('t-1');
    p.readProjection();
    expect(p.state.tasks.size).toBe(0);
  });

  it('renames the board in the header and the tab without a reload', () => {
    const p = projection();
    p.ws.set('id', 'w-1');
    p.ws.set('name', 'harbor-relay');
    p.readProjection();
    expect(el('board-ws-name-text').textContent).toBe('harbor-relay');
    expect(document.title).toContain('harbor-relay');

    p.ws.set('name', 'harbor-relay-september');
    p.readProjection();
    expect(el('board-ws-name-text').textContent).toBe('harbor-relay-september');
    expect(document.title).toContain('harbor-relay-september');
  });

  it('raises the retired badge when the projection says the board is retired', () => {
    const p = projection();
    p.ws.set('id', 'w-1');
    p.ws.set('name', 'harbor-relay');
    p.ws.set('retiredAt', 1_700_000_000_000);
    p.readProjection();
    expect(p.state.info?.retiredAt).toBe(1_700_000_000_000);
    expect(el('board-retired-badge').classList.contains('hidden')).toBe(false);
  });

  it('leaves state.info alone until the room has synced an id', () => {
    // The boot REST fetch is the other writer. An empty map must not wipe
    // what it already put there — that window is a second wide on a cold
    // connection, and the header would blink back to the raw id.
    const state = boardState({ info: { id: 'w-1', name: 'from-rest', goals: [], createdAt: 1 } });
    const p = projection(state);
    p.readProjection();
    expect(state.info?.name).toBe('from-rest');
  });

  it('names the tab after the pane the reader is on', () => {
    const state = boardState({ nav: 'home' });
    const p = projection(state);
    p.ws.set('id', 'w-1');
    p.ws.set('name', 'harbor-relay');
    p.readProjection();
    expect(document.title).toContain('Home');
  });
});

/**
 * The projection before anything has been read into it. Everything here is
 * either empty or a claim the address made — and the claims are what the
 * deep-link deadline later confirms or drops, so a boot URL that names a task
 * has to arrive in the state as an open panel, not as a pending fetch.
 */
describe('initialBoardState', () => {
  const stateFor = (pathname: string, search = '') =>
    initialBoardState(parseBoardLocation(pathname, search));

  it('opens the board on the pane and tab the address names', () => {
    const mine = stateFor('/workspaces/w-1/mine');
    expect([mine.nav, mine.pane, mine.tab, mine.view]).toEqual(['mine', 'board', 'mine', 'board']);
    const home = stateFor('/workspaces/w-1/home');
    expect([home.nav, home.pane, home.tab]).toEqual(['home', 'home', 'all']);
  });

  it('renders Activity as a view of the board pane', () => {
    const s = stateFor('/workspaces/w-1/activity');
    expect([s.pane, s.view]).toEqual(['board', 'activity']);
  });

  it("carries the URL's panel claims in as an already-open panel", () => {
    const s = stateFor('/workspaces/w-1/board', '?task=t-9&thread=th-2');
    expect([s.detailTaskId, s.detailThreadId, s.detailTab]).toEqual(['t-9', 'th-2', 'comments']);
    expect(stateFor('/workspaces/w-1/board', '?goal=g-3').detailGoalId).toBe('g-3');
  });

  it('starts every server-fed list empty and the walkthrough closed', () => {
    const s = stateFor('/workspaces/w-1/board');
    expect([s.tasks.size, s.events.length, s.agents.length, s.reviewItems.length]).toEqual([
      0, 0, 0, 0,
    ]);
    expect([s.info, s.seat, s.home, s.walkKey, s.followedKey]).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(s.walkIndex).toBe(-1);
  });

  it('hides archived rows unless the address asked for them', () => {
    expect(stateFor('/workspaces/w-1/board').showArchived).toBe(false);
    expect(stateFor('/workspaces/w-1/board', '?view=archived').showArchived).toBe(true);
  });

  it('hands back a fresh projection each call — two boots share no map', () => {
    const a = stateFor('/workspaces/w-1/board');
    const b = stateFor('/workspaces/w-1/board');
    a.tasks.set('t-1', { id: 't-1' } as never);
    expect(b.tasks.size).toBe(0);
    expect(a.homeSettled).not.toBe(b.homeSettled);
  });
});
