/**
 * What a page's boot sequence is allowed to reach for.
 *
 * Both entry points — the document editor (`app.ts`) and the board
 * (`board/board-app.ts`) — used to run their whole boot on import, against the
 * ambient `document` / `location` / `history` / `localStorage` and a real
 * WebSocket. That is why neither could be loaded in a test at all: importing
 * the module WAS running the app, so their sequences were pinned by reading
 * their own source text instead of by driving them.
 *
 * These are structural subsets, not the DOM interfaces: a boot function takes
 * the four or five things it actually touches, so a test can hand it a
 * throwaway document, a synthetic address and a fake socket and then assert on
 * what the boot did. The real globals satisfy every one of them, which is what
 * the one call at the bottom of each entry point passes.
 */

/** The address bar, as much of it as a boot reads or writes. */
export interface BootLocation {
  readonly pathname: string;
  readonly search: string;
  readonly origin: string;
  readonly protocol: string;
  readonly host: string;
  /** Read for "copy this page's link", and ASSIGNED to hop a walk chain. */
  href: string;
  assign(url: string): void;
}

/** The session history, as much of it as the board's one URL writer uses. */
export interface BootHistory {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url: string): void;
  replaceState(data: unknown, unused: string, url: string): void;
  back(): void;
}

/** Key/value storage. `localStorage` satisfies it; so does a plain Map wrapper. */
export interface BootStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The real browser's storage, read LAZILY.
 *
 * `window.localStorage` is a getter that THROWS where storage is blocked
 * (Safari's private mode is the reported one), so naming it in the entry
 * module's env object would run that getter at module evaluation — before the
 * write gate, the keyboard inset and the doc switcher are wired, and the whole
 * page would die on a browser that used to boot and simply forget its
 * preferences. Every call site inside a boot already guards its own read; this
 * keeps the read AT those call sites, which is where it was.
 */
export const browserStorage: BootStorage = {
  getItem(key: string): string | null {
    return localStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    localStorage.setItem(key, value);
  },
};

/**
 * The global event target a boot subscribes to — popstate on the board, scroll
 * on the document editor — and hands on to the repaint guard, which watches it
 * for the touch releases a press-parked repaint waits on.
 *
 * `EventTarget` rather than a narrower shape because that is what the guard
 * asks for, and because `new EventTarget()` is a complete stand-in: a test can
 * dispatch a real `popstate` at it and get the real listener semantics.
 */
export type BootWindow = EventTarget;
