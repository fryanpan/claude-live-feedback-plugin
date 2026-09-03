/**
 * The storage a page's entry point hands its boot.
 *
 * `window.localStorage` is a getter that THROWS where storage is blocked, so
 * WHEN it is read decides what a blocked browser gets: read while the entry
 * module builds its environment and the page dies before the write gate, the
 * keyboard inset and the doc switcher are wired; read at the call site, where
 * every caller inside a boot already guards, and the page comes up and simply
 * forgets its preferences. `browserStorage` is what keeps the read at the
 * call, and both entry points pass it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { browserStorage } from '../src/boot-env.ts';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
});

/** A browser that refuses storage: the getter itself throws. */
function blockStorage(): { reads: () => number } {
  let reads = 0;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get(): Storage {
      reads++;
      throw new Error('The operation is insecure.');
    },
  });
  return { reads: () => reads };
}

describe('browserStorage reads the global at the call, not when it is built', () => {
  it('builds an environment on a browser that refuses storage', () => {
    const blocked = blockStorage();
    // The control, and the hazard in one line: naming the global directly —
    // which is how both entry points read before this — throws while the
    // object is being built, and takes the page down with it.
    expect(() => ({ localStorage })).toThrow();
    expect(blocked.reads()).toBe(1);
    // What an entry point does instead: pass the accessor.
    const env = { localStorage: browserStorage };
    expect(env.localStorage).toBe(browserStorage);
    expect(blocked.reads()).toBe(1);
  });

  it('throws only when a key is actually asked for', () => {
    const blocked = blockStorage();
    expect(() => browserStorage.getItem('feedback-user-name')).toThrow();
    expect(() => browserStorage.setItem('feedback-user-name', 'Ada')).toThrow();
    expect(blocked.reads()).toBe(2);
  });

  it('reads and writes the real storage when there is one', () => {
    browserStorage.setItem('boot-env-probe', 'kept');
    expect(browserStorage.getItem('boot-env-probe')).toBe('kept');
    expect(browserStorage.getItem('boot-env-absent')).toBeNull();
  });
});
