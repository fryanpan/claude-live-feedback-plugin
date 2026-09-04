import type { FeedbackClient } from '@feedback/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHubChromeRegion } from '../src/hub/hub-chrome-region.ts';
import { presenceData } from '../src/hub/presence-island.tsx';
import { hubState, mountShell } from './support/hub-region-harness.ts';

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

describe('createHubChromeRegion', () => {
  let el: (id: string) => HTMLElement;
  beforeEach(() => {
    el = mountShell();
  });

  it('draws you as your own initials, and says whose chip it is', () => {
    const chrome = createHubChromeRegion({
      state: hubState(),
      user: { name: 'Bryan Chan', color: '#123456' },
      el,
      awareness: fakeAwareness([]),
    });
    chrome.renderMe();
    expect(el('hub-me').textContent).toBe('BC');
    expect(el('hub-me').getAttribute('aria-label')).toBe('You: Bryan Chan');
  });

  it('drops a nameless awareness entry rather than drawing a blank chip', () => {
    const chrome = createHubChromeRegion({
      state: hubState(),
      user: { name: 'Bryan', color: '' },
      el,
      awareness: fakeAwareness([
        [1, { user: { id: 'u-1', name: 'Bryan' }, surface: 'hub' }],
        [2, { surface: 'hub' }],
      ]),
    });
    expect(chrome.peopleFromAwareness().map((p) => p.name)).toEqual(['Bryan']);
  });

  it('marks the reader’s own connection as self, so the strip can fold it', () => {
    const chrome = createHubChromeRegion({
      state: hubState(),
      user: { name: 'Bryan', color: '' },
      el,
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
    const chrome = createHubChromeRegion({
      state: hubState({ followedKey: 'u-2' }),
      user: { name: 'Bryan', color: '' },
      el,
      awareness: fakeAwareness([[1, { user: { id: 'u-1', name: 'Bryan' } }]]),
    });
    chrome.renderPresenceRegion();
    expect(presenceData.value.followedKey).toBe('u-2');
    expect(presenceData.value.chips.length).toBeGreaterThan(0);
  });

  it('leaves the settings dot dark when nothing in the panel is asking', () => {
    const chrome = createHubChromeRegion({
      state: hubState(),
      user: { name: 'Bryan', color: '' },
      el,
      awareness: fakeAwareness([]),
    });
    chrome.renderPresenceRegion();
    expect(el('hub-settings-alarm').classList.contains('hidden')).toBe(true);
    expect(el('hub-settings').getAttribute('aria-label')).toBe('Workspace settings');
  });

  it('arms the dot — and the button’s label — when a session is behind', () => {
    // Both attributes, because the dot is aria-hidden: a reader who never
    // sees it would otherwise be told nothing is asking.
    const chrome = createHubChromeRegion({
      state: hubState({
        pluginRelease: {
          version: '0.1.9',
          behind: [{ agentId: 'a-1', version: '0.1.1' }],
        } as never,
      }),
      user: { name: 'Bryan', color: '' },
      el,
      awareness: fakeAwareness([]),
    });
    chrome.renderPresenceRegion();
    expect(el('hub-settings-alarm').classList.contains('hidden')).toBe(false);
    expect(el('hub-settings').getAttribute('aria-label')).toContain('needs a look');
  });

  it('shows and hides the panel from state, and tells a reader which it is', () => {
    const state = hubState();
    const chrome = createHubChromeRegion({
      state,
      user: { name: 'Bryan', color: '' },
      el,
      awareness: fakeAwareness([]),
    });
    chrome.renderSettingsPanel();
    expect(el('hub-settings-panel').classList.contains('hidden')).toBe(true);
    expect(el('hub-settings').getAttribute('aria-expanded')).toBe('false');
    state.settingsOpen = true;
    chrome.renderSettingsPanel();
    expect(el('hub-settings-panel').classList.contains('hidden')).toBe(false);
    expect(el('hub-settings').getAttribute('aria-expanded')).toBe('true');
  });
});
