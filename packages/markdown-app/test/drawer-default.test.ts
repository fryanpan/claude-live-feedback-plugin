import { describe, expect, it } from 'vitest';
import { initialDrawerOpen } from '../src/review-chrome.ts';

describe('initialDrawerOpen', () => {
  it('never opens on mobile', () => {
    expect(initialDrawerOpen({ isDesktop: false, marginVisible: false, stored: null })).toBe(false);
    expect(initialDrawerOpen({ isDesktop: false, marginVisible: false, stored: 'open' })).toBe(
      false,
    );
  });

  it('opens on desktop when no balloon margin is visible (code surface, 901–1100px)', () => {
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: false, stored: null })).toBe(true);
  });

  it('stays closed on desktop when balloons already show the threads', () => {
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: true, stored: null })).toBe(false);
  });

  it('an explicit user toggle overrides the balloon default in both directions', () => {
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: true, stored: 'open' })).toBe(true);
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: false, stored: 'closed' })).toBe(
      false,
    );
  });

  it('ignores garbage stored values', () => {
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: true, stored: 'weird' })).toBe(
      false,
    );
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: false, stored: 'weird' })).toBe(
      true,
    );
  });
});
