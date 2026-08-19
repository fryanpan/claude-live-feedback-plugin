import type { ConnectionStatus } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConnectionView,
  RECONNECT_GRACE_MS,
  renderConnectionBanner,
  renderLiveStaleNotice,
  saveStateView,
  settlePending,
  watchConnection,
  watchLiveSync,
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

/**
 * The Home queue went stale and stayed stale until a manual reload. Reported
 * 2026-08-19: *"Why didn't the home queue item appear immediately? I had to
 * refresh the page."*
 *
 * Measured, not guessed. Against a staging build: posting a declared review
 * item with the page open and the stream healthy DID paint it within ~2.5s
 * (the positive control — the live path works). What has no recovery path at
 * all is the window where the stream is DOWN: the server's SSE has no
 * `Last-Event-ID` replay anywhere in the repo, so an event fired during a
 * disconnect is gone for good, and the board's only calls to `loadReviewItems`
 * after boot are the SSE listeners themselves. `EventSource` reconnects
 * silently, so the page comes back looking perfectly healthy and is missing
 * every item created while it was away — which is a server restart (every
 * deploy), a slept laptop, or a backgrounded phone.
 */
describe('watchLiveSync', () => {
  const fakeStream = () => {
    const cbs: ((s: 'open' | 'closed') => void)[] = [];
    return {
      onStatus: (cb: (s: 'open' | 'closed') => void) => cbs.push(cb),
      set: (s: 'open' | 'closed') => {
        for (const cb of cbs) cb(s);
      },
    };
  };
  const fakeVisible = () => {
    const cbs: (() => void)[] = [];
    return {
      onVisible: (cb: () => void) => cbs.push(cb),
      show: () => {
        for (const cb of cbs) cb();
      },
    };
  };
  /** A clock the dedupe window can be driven against without real waiting. */
  const clock = (start = 0) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it('does not refetch on the first open — boot already loaded the queue', () => {
    const stream = fakeStream();
    const vis = fakeVisible();
    const resync = vi.fn();
    watchLiveSync({
      onStatus: stream.onStatus,
      onVisible: vis.onVisible,
      resync,
      now: clock().now,
    });

    stream.set('open');

    // A resync here would double every page load's REST traffic for nothing.
    expect(resync).not.toHaveBeenCalled();
  });

  it('refetches when the stream comes BACK — the missed-events window', () => {
    // The regression itself. Events that fired while the stream was down are
    // unrecoverable (no replay), so reopening the stream is the only moment
    // the client can learn it missed anything.
    const stream = fakeStream();
    const vis = fakeVisible();
    const resync = vi.fn();
    const c = clock();
    watchLiveSync({ onStatus: stream.onStatus, onVisible: vis.onVisible, resync, now: c.now });

    stream.set('open');
    stream.set('closed');
    c.advance(30_000);
    stream.set('open');

    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('refetches when the reader comes back to the tab', () => {
    // Bryan's actual usage: a phone returning from sleep. The stream may have
    // been torn down and rebuilt without the page ever noticing.
    const stream = fakeStream();
    const vis = fakeVisible();
    const resync = vi.fn();
    const c = clock();
    watchLiveSync({ onStatus: stream.onStatus, onVisible: vis.onVisible, resync, now: c.now });

    stream.set('open');
    c.advance(30_000);
    vis.show();

    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of triggers into one refetch', () => {
    // A restart fires "visible" and "stream reopened" within a few hundred ms
    // of each other. Two refetches of the same three endpoints is waste, and
    // on a phone it is waste at the worst moment.
    const stream = fakeStream();
    const vis = fakeVisible();
    const resync = vi.fn();
    const c = clock();
    watchLiveSync({ onStatus: stream.onStatus, onVisible: vis.onVisible, resync, now: c.now });

    stream.set('open');
    stream.set('closed');
    c.advance(30_000);
    stream.set('open');
    c.advance(100);
    vis.show();

    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('refetches again once the window has passed — dedupe is not a latch', () => {
    // POSITIVE CONTROL for the test above: proves the dedupe suppresses a
    // burst rather than permanently disabling the second trigger, which is
    // how this fix would silently become the bug it replaces.
    const stream = fakeStream();
    const vis = fakeVisible();
    const resync = vi.fn();
    const c = clock();
    watchLiveSync({
      onStatus: stream.onStatus,
      onVisible: vis.onVisible,
      resync,
      now: c.now,
      minIntervalMs: 2_000,
    });

    stream.set('open');
    stream.set('closed');
    c.advance(30_000);
    stream.set('open');
    c.advance(5_000);
    vis.show();

    expect(resync).toHaveBeenCalledTimes(2);
  });

  it('ignores a repeated open with no drop in between', () => {
    const stream = fakeStream();
    const vis = fakeVisible();
    const resync = vi.fn();
    const c = clock();
    watchLiveSync({ onStatus: stream.onStatus, onVisible: vis.onVisible, resync, now: c.now });

    stream.set('open');
    c.advance(30_000);
    stream.set('open');

    expect(resync).not.toHaveBeenCalled();
  });
});

describe('renderLiveStaleNotice', () => {
  it('says the queue may be out of date while live updates are down', () => {
    const el = document.createElement('div');
    el.className = 'hidden';
    renderLiveStaleNotice(el, 'reconnecting');
    expect(el.classList.contains('hidden')).toBe(false);
    // Names what is unreliable — the list — rather than a transport the
    // reader has no model of. "Silence that looks like calm" is the bug
    // underneath the bug.
    expect(el.textContent).toMatch(/out of date|not updating|paused/i);
  });

  it('clears itself when live updates resume', () => {
    const el = document.createElement('div');
    renderLiveStaleNotice(el, 'reconnecting');
    renderLiveStaleNotice(el, 'online');
    expect(el.classList.contains('hidden')).toBe(true);
    expect(el.textContent).toBe('');
  });

  it('tolerates a missing element', () => {
    expect(() => renderLiveStaleNotice(null, 'reconnecting')).not.toThrow();
  });
});
