import type { ConnectionStatus } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConnectionView,
  RECONNECT_GRACE_MS,
  renderConnectionBanner,
  saveStateView,
  settlePending,
  watchConnection,
} from '../src/connection-state.ts';

/** Drives the status callback exactly the way ws-client does. */
function fakeStatus(initial: ConnectionStatus = 'open') {
  const cbs: ((s: ConnectionStatus) => void)[] = [];
  let current: ConnectionStatus = initial;
  return {
    // ws-client's contract: fires on every transition AND immediately with
    // the current status at subscribe time.
    onStatus: (cb: (s: ConnectionStatus) => void) => {
      cbs.push(cb);
      cb(current);
    },
    set(s: ConnectionStatus) {
      current = s;
      for (const cb of cbs) cb(s);
    },
  };
}

describe('watchConnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces an outage that outlasts the grace window', () => {
    // POSITIVE CONTROL for every "it stays quiet" assertion below: this
    // proves the watcher can speak at all. Without it, a broken watcher that
    // never calls onView would pass the anti-flicker tests vacuously.
    const status = fakeStatus();
    const views: ConnectionView[] = [];
    watchConnection({ onStatus: status.onStatus, onView: (v) => views.push(v) });

    status.set('closed');
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1);

    expect(views).toEqual(['reconnecting']);
  });

  it('says nothing at all while the socket is simply up', () => {
    const status = fakeStatus('open');
    const views: ConnectionView[] = [];
    watchConnection({ onStatus: status.onStatus, onView: (v) => views.push(v) });

    vi.advanceTimersByTime(60_000);

    expect(views).toEqual([]);
  });

  it('stays silent through a blip the socket repairs inside the grace window', () => {
    // The flicker the task is about: a one-second drop must not paint a
    // banner and immediately unpaint it.
    const status = fakeStatus();
    const views: ConnectionView[] = [];
    watchConnection({ onStatus: status.onStatus, onView: (v) => views.push(v) });

    status.set('closed');
    vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1);
    status.set('open');
    vi.advanceTimersByTime(60_000);

    expect(views).toEqual([]);
  });

  it('announces once, not once per retry, while the backoff loops', () => {
    // ws-client emits connecting → closed → connecting → … on every retry.
    // A deliberate state means ONE transition, however many attempts happen.
    const status = fakeStatus();
    const views: ConnectionView[] = [];
    watchConnection({ onStatus: status.onStatus, onView: (v) => views.push(v) });

    status.set('closed');
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1);
    for (let i = 0; i < 5; i++) {
      status.set('connecting');
      vi.advanceTimersByTime(500);
      status.set('closed');
      vi.advanceTimersByTime(2000);
    }

    expect(views).toEqual(['reconnecting']);
  });

  it('clears itself when the socket comes back — no reload involved', () => {
    const status = fakeStatus();
    const views: ConnectionView[] = [];
    watchConnection({ onStatus: status.onStatus, onView: (v) => views.push(v) });

    status.set('closed');
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1);
    status.set('open');

    expect(views).toEqual(['reconnecting', 'online']);
  });

  it('announces a second outage after a recovery', () => {
    const status = fakeStatus();
    const views: ConnectionView[] = [];
    watchConnection({ onStatus: status.onStatus, onView: (v) => views.push(v) });

    status.set('closed');
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1);
    status.set('open');
    status.set('closed');
    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1);

    expect(views).toEqual(['reconnecting', 'online', 'reconnecting']);
  });

  it('announces when the page loads while the server is already down', () => {
    // The restart case that matters most: the tab was opened (or woken) mid
    // deploy, so the FIRST status ever seen is 'connecting' and 'open' never
    // arrived. Arming only on a transition away from 'open' would sit mute.
    const status = fakeStatus('connecting');
    const views: ConnectionView[] = [];
    watchConnection({ onStatus: status.onStatus, onView: (v) => views.push(v) });

    vi.advanceTimersByTime(RECONNECT_GRACE_MS + 1);

    expect(views).toEqual(['reconnecting']);
  });
});

describe('renderConnectionBanner', () => {
  it('shows readable copy that reads as "coming back", not as "broken"', () => {
    const el = document.createElement('div');
    el.className = 'conn-banner hidden';

    renderConnectionBanner(el, 'reconnecting');

    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.textContent).toMatch(/reconnect/i);
    // "Offline" / "error" / "failed" is the reading the task exists to stop.
    expect(el.textContent).not.toMatch(/error|failed|offline/i);
  });

  it('does not promise durability it cannot deliver', () => {
    // There is no local persistence — unsent updates live only in the
    // in-memory Y.Doc and die with `client.close()` on navigate or reload.
    // A banner saying "your work is safe" is exactly wrong for the one
    // reader who then closes the tab because it told them they could.
    const el = document.createElement('div');
    renderConnectionBanner(el, 'reconnecting');

    expect(el.textContent).not.toMatch(/safe|saved|no data will be lost|don't worry/i);
    // Says the thing that IS true and IS actionable instead.
    expect(el.textContent).toMatch(/keep this tab open/i);
  });

  it('hides itself again on recovery, leaving no leftover text', () => {
    const el = document.createElement('div');
    el.className = 'conn-banner hidden';

    renderConnectionBanner(el, 'reconnecting');
    expect(el.classList.contains('hidden')).toBe(false); // positive control

    renderConnectionBanner(el, 'online');

    expect(el.classList.contains('hidden')).toBe(true);
    expect(el.textContent).toBe('');
  });

  it('does nothing when the element is absent', () => {
    expect(() => renderConnectionBanner(null, 'reconnecting')).not.toThrow();
  });
});

/**
 * The grace window is a rule about what to SHOW, and it must not become a
 * rule about what is TRUE. Codex caught the first cut letting one leak into
 * the other: with the socket already down but the banner not yet due, an edit
 * made in that window hit the 500ms "typing stopped" debounce and was
 * reported as "All changes saved" — a claim about a server that wasn't there.
 * The lie is in the reassuring direction, which is the one that costs work.
 */
describe('settlePending', () => {
  it('lets the debounce settle to saved when there is a server to save to', () => {
    // POSITIVE CONTROL: proves the debounce can still clear at all.
    expect(settlePending(3, true)).toBe(0);
  });

  it('refuses to settle while the socket is down, however long typing stopped', () => {
    expect(settlePending(3, false)).toBe(3);
  });

  it('keys on the live socket, not on whether the banner is showing yet', () => {
    // The whole point: inside the grace window the socket is ALREADY down.
    expect(settlePending(1, false)).toBe(1);
  });
});

describe('saveStateView', () => {
  it('shows the reconnecting state once the drop has earned it', () => {
    expect(saveStateView({ reconnecting: true, pendingEdits: 0 })).toBe('reconnecting');
    // …and it outranks pending edits: the connection is the bigger news.
    expect(saveStateView({ reconnecting: true, pendingEdits: 4 })).toBe('reconnecting');
  });

  it('shows dirty while edits are outstanding', () => {
    expect(saveStateView({ reconnecting: false, pendingEdits: 2 })).toBe('dirty');
  });

  it('shows saved only with nothing outstanding', () => {
    expect(saveStateView({ reconnecting: false, pendingEdits: 0 })).toBe('saved');
  });

  it('never claims saved during a silent outage — the regression', () => {
    // Socket down, banner not yet due, edits made in the window. settlePending
    // has kept them pending, so the view has something to report and does not
    // fall through to "All changes saved".
    const pending = settlePending(1, /* wsOnline */ false);
    expect(saveStateView({ reconnecting: false, pendingEdits: pending })).not.toBe('saved');
  });
});
