/**
 * The stored view preferences, driven directly.
 *
 * The drawer's default is the one that has to survive a hostile storage
 * accessor: every read and write here is wrapped because private mode,
 * cleared site data and the thumbnail renderer all THROW on the accessor
 * itself, and a review page that cannot render without `sessionStorage` is a
 * review page that renders blank for the reader who most needs it. The
 * default-choosing rules are covered by drawer-default / set-pane; what is
 * asserted here is the round trip they sit on and its behaviour when storage
 * refuses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  initialDrawerOpen,
  initialSetPaneOpen,
  readDrawerPref,
  writeDrawerPref,
} from '../src/doc/view-prefs.ts';

const KEY = 'lf:drawer';
const realStorage = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

/** Replace `sessionStorage` with one that throws on every access — the shape
 *  private mode and a blocked-cookies browser actually present. */
function breakStorage(): void {
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: storage is disabled');
    },
  });
}

describe('the drawer preference this session stores', () => {
  afterEach(() => {
    if (realStorage) Object.defineProperty(window, 'sessionStorage', realStorage);
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      // nothing to clean up
    }
  });

  it('reads back nothing until a choice has been made', () => {
    expect(readDrawerPref()).toBeNull();
  });

  it('round-trips a stated choice in both directions', () => {
    writeDrawerPref(true);
    expect(readDrawerPref()).toBe('open');

    writeDrawerPref(false);
    expect(readDrawerPref()).toBe('closed');
  });

  it('lets a stated choice beat the surface default it was overriding', () => {
    // A balloon margin is showing, so the default is closed — the drawer
    // would be a second copy of the same comments.
    const surfaces = { isDesktop: true, marginVisible: true, inlineVisible: false };
    expect(initialDrawerOpen({ ...surfaces, stored: readDrawerPref() })).toBe(false);

    writeDrawerPref(true);

    expect(initialDrawerOpen({ ...surfaces, stored: readDrawerPref() })).toBe(true);
  });

  it('degrades to the tier default when storage throws instead of crashing', () => {
    breakStorage();

    expect(() => writeDrawerPref(true)).not.toThrow();
    expect(readDrawerPref()).toBeNull();
    // Null is "nothing stored", so the width tiers still decide — a phone
    // never opens the drawer, a code doc above 1100px does.
    expect(
      initialDrawerOpen({
        isDesktop: true,
        marginVisible: false,
        inlineVisible: false,
        stored: readDrawerPref(),
      }),
    ).toBe(true);
    expect(initialSetPaneOpen(null, true)).toBe(true);
  });
});
