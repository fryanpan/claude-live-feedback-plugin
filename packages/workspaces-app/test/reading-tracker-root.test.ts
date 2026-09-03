import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_WINDOW_MS, startReadingTracker } from '../src/reading-tracker.ts';

/**
 * The `root` option — what makes the tracker mountable on the hub's ticket
 * panel rather than only on a surface where the page IS the document.
 *
 * The hub is the reason it exists: a ticket opens as a panel over a board
 * that is still on screen, so a tracker listening on `window` would accrue
 * every scroll of the rows behind it as time spent reading the ticket.
 */

interface Posted {
  type: string;
  payload: Record<string, unknown>;
  author: { id: string; name: string };
}

const USER = { id: 'u-1', name: 'Reader', kind: 'known' as const, color: '#abcdef' };

let posted: Posted[] = [];

beforeEach(() => {
  posted = [];
  // sendBeacon is the read_session path when present; drop it so both event
  // types land on the fetch stub and the assertions read one list.
  (navigator as unknown as { sendBeacon?: unknown }).sendBeacon = undefined;
  vi.stubGlobal('fetch', (_url: string, init?: { body?: string }) => {
    if (init?.body) posted.push(JSON.parse(init.body) as Posted);
    return Promise.resolve({ ok: true });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const sessions = (): Posted[] => posted.filter((p) => p.type === 'read_session');

function panel(): HTMLElement {
  const host = document.createElement('div');
  host.id = 'hub-detail';
  const inner = document.createElement('div');
  inner.className = 'hub-detail-panel';
  host.appendChild(inner);
  document.body.appendChild(host);
  return host;
}

describe('reading tracker scoped to a root element', () => {
  it('emits doc_open on start, for the doc it was given', () => {
    const stop = startReadingTracker({ docId: 'task:t-1', user: USER, root: panel() });
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('doc_open');
    stop();
  });

  it('an interaction INSIDE the root opens a session', () => {
    const host = panel();
    const stop = startReadingTracker({ docId: 'task:t-1', user: USER, root: host });
    host
      .querySelector('.hub-detail-panel')
      ?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    stop(); // the hub's close path — flushes what is in flight
    expect(sessions()).toHaveLength(1);
    expect(sessions()[0].payload.durationMs).toBe(ACTIVE_WINDOW_MS);
  });

  it('an interaction OUTSIDE the root records nothing — the board behind the panel', () => {
    const host = panel();
    const board = document.createElement('div');
    document.body.appendChild(board);
    const stop = startReadingTracker({ docId: 'task:t-1', user: USER, root: host });
    // Scrolling and clicking the board while a ticket is open.
    board.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    board.dispatchEvent(new Event('scroll', { bubbles: true }));
    window.dispatchEvent(new Event('keydown'));
    stop();
    expect(sessions()).toHaveLength(0);
  });

  it('catches scroll on a descendant, which does not bubble but does capture', () => {
    const host = panel();
    const stop = startReadingTracker({ docId: 'task:t-1', user: USER, root: host });
    // `bubbles: false` is what a real scroll event is. Capture is the only
    // reason an ancestor hears it — if the listener were bubble-phase this
    // would record nothing.
    host.querySelector('.hub-detail-panel')?.dispatchEvent(new Event('scroll', { bubbles: false }));
    stop();
    expect(sessions()).toHaveLength(1);
  });

  it('defaults to window when no root is given, as the doc surfaces rely on', () => {
    const stop = startReadingTracker({ docId: 'd-1', user: USER });
    window.dispatchEvent(new Event('keydown'));
    stop();
    expect(sessions()).toHaveLength(1);
  });

  it('teardown removes the root listeners — a closed ticket stops accruing', () => {
    const host = panel();
    const stop = startReadingTracker({ docId: 'task:t-1', user: USER, root: host });
    stop();
    const before = posted.length;
    host.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(posted).toHaveLength(before);
  });

  it('a ticket opened and never touched records NO read session', () => {
    // The overnight-tab guarantee, at the panel level: a session only ever
    // opens on an interaction, so a panel left open banks nothing.
    const stop = startReadingTracker({ docId: 'task:t-1', user: USER, root: panel() });
    stop();
    expect(sessions()).toHaveLength(0);
    expect(posted.map((p) => p.type)).toEqual(['doc_open']);
  });

  it('attributes the session to the reader it was given', () => {
    const host = panel();
    const stop = startReadingTracker({ docId: 'task:t-1', user: USER, root: host });
    host.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    stop();
    expect(sessions()[0].author.name).toBe('Reader');
    expect(sessions()[0].author.id).toBe('u-1');
  });

  it('resolves a scrollEl getter lazily, after the panel is painted', () => {
    const host = panel();
    // The hub opens a ticket by writing a signal; the panel it scrolls does
    // not exist yet at this point. Start with the element absent.
    host.innerHTML = '';
    let asked = 0;
    const stop = startReadingTracker({
      docId: 'task:t-1',
      user: USER,
      root: host,
      scrollEl: () => {
        asked++;
        return host.querySelector<HTMLElement>('.hub-detail-panel');
      },
    });
    // Painted a microtask later.
    const inner = document.createElement('div');
    inner.className = 'hub-detail-panel';
    host.appendChild(inner);
    host.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    stop();
    expect(asked).toBeGreaterThan(0);
    expect(sessions()).toHaveLength(1);
  });
});
