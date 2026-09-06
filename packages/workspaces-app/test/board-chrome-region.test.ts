import type { FeedbackClient } from '@feedback/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBoardChromeRegion } from '../src/board/board-chrome-region.ts';
import { presenceData } from '../src/board/presence-island.tsx';
import { fakeLocation } from './boot-harness.ts';
import { boardState, mountShell } from './support/board-region-harness.ts';

/**
 * The top-right cluster and the panel behind its button. The rule that makes
 * these one region is the alarm: a drift notice in a CLOSED panel is an alarm
 * nobody sees, so the write that produces the notices is the write that
 * decides whether the settings button wears its dot.
 */
function fakeAwareness(
  states: Array<[number, unknown]>,
  clientID = 1,
): FeedbackClient['awareness'] {
  return {
    clientID,
    getStates: () => new Map(states),
  } as unknown as FeedbackClient['awareness'];
}

describe('createBoardChromeRegion', () => {
  let el: (id: string) => HTMLElement;
  beforeEach(() => {
    el = mountShell();
  });

  it('draws you as your own initials, and says whose chip it is', () => {
    const chrome = createBoardChromeRegion({
      state: boardState(),
      user: { name: 'Bryan Chan', color: '#123456' },
      el,
      location: fakeLocation('https://board.test/workspaces/w-1/tasks'),
      awareness: fakeAwareness([]),
    });
    chrome.renderMe();
    expect(el('board-me').textContent).toBe('BC');
    expect(el('board-me').getAttribute('aria-label')).toBe('You: Bryan Chan');
  });

  it('drops a nameless awareness entry rather than drawing a blank chip', () => {
    const chrome = createBoardChromeRegion({
      state: boardState(),
      user: { name: 'Bryan', color: '' },
      el,
      location: fakeLocation('https://board.test/workspaces/w-1/tasks'),
      awareness: fakeAwareness([
        [1, { user: { id: 'u-1', name: 'Bryan' }, surface: 'board' }],
        [2, { surface: 'board' }],
      ]),
    });
    expect(chrome.peopleFromAwareness().map((p) => p.name)).toEqual(['Bryan']);
  });

  it('marks the reader’s own connection as self, so the strip can fold it', () => {
    const chrome = createBoardChromeRegion({
      state: boardState(),
      user: { name: 'Bryan', color: '' },
      el,
      location: fakeLocation('https://board.test/workspaces/w-1/tasks'),
      awareness: fakeAwareness(
        [
          [7, { user: { id: 'u-1', name: 'Bryan' } }],
          [8, { user: { id: 'u-2', name: 'Ada' } }],
        ],
        7,
      ),
    });
    const me = chrome.peopleFromAwareness().find((p) => p.self);
    expect(me?.name).toBe('Bryan');
  });

  it('writes the strip through the signal and leaves the followed chip alone', () => {
    const chrome = createBoardChromeRegion({
      state: boardState({ followedKey: 'u-2' }),
      user: { name: 'Bryan', color: '' },
      el,
      location: fakeLocation('https://board.test/workspaces/w-1/tasks'),
      awareness: fakeAwareness([[1, { user: { id: 'u-1', name: 'Bryan' } }]]),
    });
    chrome.renderPresenceRegion();
    expect(presenceData.value.followedKey).toBe('u-2');
    expect(presenceData.value.chips.length).toBeGreaterThan(0);
  });

  it('leaves the settings dot dark when nothing in the panel is asking', () => {
    const chrome = createBoardChromeRegion({
      state: boardState(),
      user: { name: 'Bryan', color: '' },
      el,
      location: fakeLocation('https://board.test/workspaces/w-1/tasks'),
      awareness: fakeAwareness([]),
    });
    chrome.renderPresenceRegion();
    expect(el('board-settings-alarm').classList.contains('hidden')).toBe(true);
    expect(el('board-settings').getAttribute('aria-label')).toBe('Workspace settings');
  });

  it('arms the dot — and the button’s label — when a session is behind', () => {
    // Both attributes, because the dot is aria-hidden: a reader who never
    // sees it would otherwise be told nothing is asking.
    const chrome = createBoardChromeRegion({
      state: boardState({
        pluginRelease: {
          version: '0.1.9',
          behind: [{ agentId: 'a-1', version: '0.1.1' }],
        } as never,
      }),
      user: { name: 'Bryan', color: '' },
      el,
      location: fakeLocation('https://board.test/workspaces/w-1/tasks'),
      awareness: fakeAwareness([]),
    });
    chrome.renderPresenceRegion();
    expect(el('board-settings-alarm').classList.contains('hidden')).toBe(false);
    expect(el('board-settings').getAttribute('aria-label')).toContain('needs a look');
  });

  it('shows and hides the panel from state, and tells a reader which it is', () => {
    const state = boardState();
    const chrome = createBoardChromeRegion({
      state,
      user: { name: 'Bryan', color: '' },
      el,
      location: fakeLocation('https://board.test/workspaces/w-1/tasks'),
      awareness: fakeAwareness([]),
    });
    chrome.renderSettingsPanel();
    expect(el('board-settings-panel').classList.contains('hidden')).toBe(true);
    expect(el('board-settings').getAttribute('aria-expanded')).toBe('false');
    state.settingsOpen = true;
    chrome.renderSettingsPanel();
    expect(el('board-settings-panel').classList.contains('hidden')).toBe(false);
    expect(el('board-settings').getAttribute('aria-expanded')).toBe('true');
  });
});
