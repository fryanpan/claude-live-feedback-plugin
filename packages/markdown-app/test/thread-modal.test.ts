import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MountScope } from '../src/mount-scope.ts';
import { type ThreadModalHandle, mountThreadModal } from '../src/thread-modal.ts';
import { ThreadPanel } from '../src/threads.ts';

/**
 * The wide modal a long or decision-bearing thread opens in.
 *
 * What it owes: it shows the SAME card the column shows (never a second
 * rendering to keep honest), it closes on every route a dialog is expected to
 * close on, and a tap inside it does not fold the card out from under the
 * reader — which is what would happen if the card's own tap contract were left
 * to bubble, because the whole card is its own tap target.
 *
 * Layout is what no DOM test here can see (happy-dom resolves none); the
 * width/height rules are asserted against the stylesheet in
 * `thread-modal-css.test.ts`.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

let ts = 1_700_000_000_000;
function comment(text: string, review?: ReviewPayload): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: alice, text, ts, ...(review ? { review } : {}) };
}

function thread(id: string, comments: Comment[], over: Partial<Thread> = {}): Thread {
  return {
    id,
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'anchor' } },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: alice,
    comments,
    ...over,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

interface Harness {
  modal: ThreadModalHandle;
  panel: ThreadPanel;
  closed: number;
  root: () => HTMLElement;
  scrim: () => HTMLElement;
  card: () => HTMLElement | null;
}

function mount(): Harness {
  const scope = new MountScope();
  cleanups.push(() => scope.dispose());
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const panel = new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });
  const h: Harness = {
    panel,
    closed: 0,
    modal: mountThreadModal({
      scope,
      renderCard: (t, pendingReply) => panel.renderThread(t, pendingReply),
      onClose: () => {
        h.closed += 1;
      },
    }),
    root: () => document.querySelector('.thread-modal') as HTMLElement,
    scrim: () => document.querySelector('.thread-modal-scrim') as HTMLElement,
    card: () => document.querySelector('.thread-modal-body .thread'),
  };
  return h;
}

const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};
const isShown = (el: HTMLElement): boolean => !el.classList.contains('hidden');

const decisionPayload: ReviewPayload = {
  shape: 'decision',
  headline: 'Pick a cache strategy',
  why: 'The rollout is blocked on it',
  options: [
    { id: 'a', label: 'Write through' },
    { id: 'b', label: 'Write behind' },
  ],
};

describe('the modal opens and closes', () => {
  it('mounts hidden, with nothing in it', () => {
    const h = mount();
    expect(isShown(h.root())).toBe(false);
    expect(isShown(h.scrim())).toBe(false);
    expect(h.modal.openThreadId()).toBe(null);
  });

  it('shows the thread’s own card, built by the panel', () => {
    const h = mount();
    const t = thread('t1', [comment('The long one')]);
    h.panel.setActive('t1');
    h.modal.open(t);
    expect(isShown(h.root())).toBe(true);
    expect(h.card()?.getAttribute('data-thread-id')).toBe('t1');
    expect(h.modal.openThreadId()).toBe('t1');
  });

  it('renders the card already open, not folded', () => {
    const h = mount();
    h.panel.setActive('t1');
    h.modal.open(thread('t1', [comment('The long one')]));
    expect(h.card()?.classList.contains('expanded')).toBe(true);
  });

  it('closes on the close button and tells the caller once', () => {
    const h = mount();
    h.modal.open(thread('t1', [comment('x')]));
    click(h.root().querySelector('.thread-modal-close') as HTMLElement);
    expect(isShown(h.root())).toBe(false);
    expect(h.modal.openThreadId()).toBe(null);
    expect(h.closed).toBe(1);
  });

  it('closes on the scrim', () => {
    const h = mount();
    h.modal.open(thread('t1', [comment('x')]));
    click(h.scrim());
    expect(h.modal.openThreadId()).toBe(null);
    expect(h.closed).toBe(1);
  });

  it('closes on Escape', () => {
    const h = mount();
    h.modal.open(thread('t1', [comment('x')]));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.modal.openThreadId()).toBe(null);
    expect(h.closed).toBe(1);
  });

  it('ignores Escape when it is not open — the surface below owns that key', () => {
    const h = mount();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.closed).toBe(0);
  });

  it('does not re-announce a close it has already made', () => {
    const h = mount();
    h.modal.open(thread('t1', [comment('x')]));
    h.modal.close();
    h.modal.close();
    expect(h.closed).toBe(1);
  });

  it('swaps threads without leaving the first one’s card behind', () => {
    const h = mount();
    h.modal.open(thread('t1', [comment('first')]));
    h.modal.open(thread('t2', [comment('second')]));
    expect(document.querySelectorAll('.thread-modal-body .thread').length).toBe(1);
    expect(h.card()?.getAttribute('data-thread-id')).toBe('t2');
  });

  it('takes its DOM with it when the mount is torn down', () => {
    const scope = new MountScope();
    const panel = new ThreadPanel({
      container: document.createElement('div'),
      currentUser: alice,
      onThreadClick: () => {},
      onReply: () => {},
      onResolve: () => {},
      onReopen: () => {},
      onReanchor: () => {},
    });
    mountThreadModal({ scope, renderCard: (t) => panel.renderThread(t), onClose: () => {} });
    expect(document.querySelector('.thread-modal')).not.toBe(null);
    scope.dispose();
    expect(document.querySelector('.thread-modal')).toBe(null);
    expect(document.querySelector('.thread-modal-scrim')).toBe(null);
  });
});

describe('a tap inside the modal does not fold the card away', () => {
  it('swallows the card’s own fold tap', () => {
    const h = mount();
    h.panel.setActive('t1');
    h.modal.open(thread('t1', [comment('The long one')]));
    const body = h.card()?.querySelector('.thread-message') as HTMLElement;
    click(body);
    expect(h.panel.getActive()).toBe('t1');
    expect(h.card()?.classList.contains('expanded')).toBe(true);
    expect(h.closed).toBe(0);
  });

  it('lets the caret close the modal instead — it is the collapse control', () => {
    const h = mount();
    h.panel.setActive('t1');
    h.modal.open(thread('t1', [comment('The long one')]));
    click(h.card()?.querySelector('.thread-caret') as HTMLElement);
    expect(h.modal.openThreadId()).toBe(null);
    expect(h.closed).toBe(1);
  });

  it('leaves the card’s real controls alone', () => {
    const h = mount();
    h.panel.setActive('t1');
    h.modal.open(thread('t1', [comment('The long one')]));
    const resolve = h.card()?.querySelector('.thread-resolve') as HTMLElement;
    click(resolve);
    expect(h.modal.openThreadId()).toBe('t1');
  });
});

describe('the modal keeps up with the doc', () => {
  it('rebuilds when the thread gains a reply', () => {
    const h = mount();
    const first = thread('t1', [comment('opening')]);
    h.modal.open(first);
    h.modal.refresh(thread('t1', [...first.comments, comment('a reply')]));
    expect(h.card()?.querySelectorAll('.comments .comment').length).toBe(1);
  });

  it('leaves the card alone when nothing display-relevant moved', () => {
    const h = mount();
    const t = thread('t1', [comment('opening')]);
    h.modal.open(t);
    const before = h.card();
    h.modal.refresh(thread('t1', t.comments));
    expect(h.card()).toBe(before);
  });

  it('keeps a half-typed reply across a rebuild', () => {
    const h = mount();
    const t = thread('t1', [comment('opening')]);
    h.modal.open(t);
    const ta = h.card()?.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'half a thought';
    h.modal.refresh(thread('t1', [...t.comments, comment('someone else spoke')]));
    expect((h.card()?.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'half a thought',
    );
  });

  it('closes when the thread it was showing is gone', () => {
    const h = mount();
    h.modal.open(thread('t1', [comment('opening')]));
    h.modal.refresh(null);
    expect(h.modal.openThreadId()).toBe(null);
    expect(h.closed).toBe(1);
  });

  it('refreshing while closed does nothing at all', () => {
    const h = mount();
    h.modal.refresh(null);
    expect(h.closed).toBe(0);
    expect(isShown(h.root())).toBe(false);
  });

  const title = (h: Harness): string =>
    h.root().querySelector('.thread-modal-title')?.textContent ?? '';

  // The dialog covers the document, so the one thing a reader cannot do while
  // it is open is look at the text the thread hangs on. "Comment" told them
  // nothing they had not just clicked.
  it('says which text the thread hangs on, since the dialog covers it', () => {
    const h = mount();
    h.modal.open(
      thread('t1', [comment('plain')], {
        anchor: {
          kind: 'element',
          fingerprint: undefined as never,
          snippet: { text: 'the cache warms on boot' },
        },
      }),
    );
    expect(title(h)).toBe('the cache warms on boot');
  });

  it('keeps "Decision" for a decision, where the kind outranks the anchor', () => {
    const h = mount();
    h.modal.open(thread('t2', [comment('which one?', decisionPayload)]));
    expect(title(h)).toBe('Decision');
  });

  it('falls back to "Comment" when the anchor has no text to quote', () => {
    const h = mount();
    h.modal.open(
      thread('t3', [comment('')], {
        anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: '' } },
      }),
    );
    expect(title(h)).toBe('Comment');
  });

  // Untrusted on the way in — a snippet is document text, and the title is a
  // heading rather than a sanitizer.
  it('puts the snippet in as text, never as markup', () => {
    const h = mount();
    h.modal.open(
      thread('t4', [comment('plain')], {
        anchor: {
          kind: 'element',
          fingerprint: undefined as never,
          snippet: { text: '<img src=x onerror=1>' },
        },
      }),
    );
    expect(h.root().querySelector('.thread-modal-title')?.querySelector('img')).toBe(null);
    expect(title(h)).toBe('<img src=x onerror=1>');
  });
});

/**
 * Tab must not walk out of a dialog that claims `aria-modal="true"`.
 *
 * Measured on the staging build before this trap existed: four stops inside
 * the card and then straight out into the page behind it — the thread view's
 * close button, the back link, the doc switcher — all of it under a scrim the
 * keyboard cannot see and cannot dismiss.
 */
describe('focus stays inside the dialog', () => {
  function openWith(): { h: Harness; items: HTMLElement[] } {
    const h = mount();
    h.panel.setActive('t1');
    h.modal.open(thread('t1', [comment('The long one')]));
    const items = Array.from(
      h.root().querySelectorAll<HTMLElement>('button, textarea, [contenteditable]'),
    );
    return { h, items };
  }

  const tab = (shift = false): boolean => {
    // `cancelable: true` is not decoration — without it `preventDefault()` is
    // a no-op and `defaultPrevented` stays false however well the trap works.
    const ev = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  it('has something to trap — the control that proves the rest is not vacuous', () => {
    const { items } = openWith();
    expect(items.length).toBeGreaterThan(2);
  });

  it('wraps forward from the last control to the first', () => {
    const { h, items } = openWith();
    const first = items[0];
    items[items.length - 1].focus();
    expect(tab()).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(h.root().contains(document.activeElement)).toBe(true);
  });

  it('wraps backward from the first control to the last', () => {
    const { items } = openWith();
    items[0].focus();
    expect(tab(true)).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('leaves a Tab in the middle of the dialog to the browser', () => {
    const { items } = openWith();
    items[0].focus();
    expect(tab()).toBe(false);
  });

  it('pulls focus back when it is already outside', () => {
    const { h, items } = openWith();
    const stray = document.createElement('button');
    document.body.appendChild(stray);
    cleanups.push(() => stray.remove());
    stray.focus();
    expect(tab()).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    expect(h.root().contains(document.activeElement)).toBe(true);
  });

  it('does not touch Tab while the dialog is down', () => {
    mount();
    const stray = document.createElement('button');
    document.body.appendChild(stray);
    cleanups.push(() => stray.remove());
    stray.focus();
    expect(tab()).toBe(false);
    expect(document.activeElement).toBe(stray);
  });
});

describe('the dialog keeps its slots sized to their faces', () => {
  /*
   * A slot's height is a number WE write against a measured face, and
   * `overflow: hidden` clips whatever a stale number cuts off — which, in
   * this dialog, was the Reply button: the foot sits outside the slots, so
   * the card looked whole while its one send control was unreachable
   * (measured live 2026-08-24: face 1691px at measure, 1740px after the body
   * gained its scrollbar and the text rewrapped; the missing 49px was the
   * actions row, and no scroll can reach inside an overflow clip).
   *
   * happy-dom lays nothing out, so faces get offsetHeight getters that model
   * the browser: 0 while unrendered (`display: none`), a real number once the
   * dialog is up, and a bigger number when the fixture grows the face.
   */

  /** A harness whose card faces measure `h()` while the dialog is visible. */
  function mountMeasured(
    h: () => number,
  ): Harness & { faces: () => HTMLElement[]; scope: MountScope } {
    const scope = new MountScope();
    cleanups.push(() => scope.dispose());
    const container = document.createElement('div');
    document.body.appendChild(container);
    cleanups.push(() => container.remove());
    const panel = new ThreadPanel({
      container,
      currentUser: alice,
      onThreadClick: () => {},
      onReply: () => {},
      onResolve: () => {},
      onReopen: () => {},
      onReanchor: () => {},
    });
    const harness: Harness & { faces: () => HTMLElement[]; scope: MountScope } = {
      panel,
      scope,
      closed: 0,
      modal: mountThreadModal({
        scope,
        renderCard: (t, pendingReply) => {
          const card = panel.renderThread(t, pendingReply);
          for (const face of Array.from(card.querySelectorAll<HTMLElement>('.thread-face'))) {
            Object.defineProperty(face, 'offsetHeight', {
              get: () => {
                const root = document.querySelector('.thread-modal');
                // display:none reads 0, exactly as a browser would report it.
                return root && !root.classList.contains('hidden') ? h() : 0;
              },
              configurable: true,
            });
          }
          return card;
        },
        onClose: () => {
          harness.closed += 1;
        },
      }),
      root: () => document.querySelector('.thread-modal') as HTMLElement,
      scrim: () => document.querySelector('.thread-modal-scrim') as HTMLElement,
      card: () => document.querySelector('.thread-modal-body .thread'),
      faces: () =>
        Array.from(document.querySelectorAll<HTMLElement>('.thread-modal-body .thread-face')),
    };
    return harness;
  }

  const slotOf = (h: Harness): HTMLElement => h.root().querySelector('.thread-slot') as HTMLElement;

  it('open() sizes the slots itself — no composer mount required to rescue it', () => {
    // A card whose thread is resolved, or whose composer chunk never lands,
    // announces nothing after paint — the open must not depend on that
    // announcement having a reason to fire.
    const h = mountMeasured(() => 40);
    h.modal.open(thread('t1', [comment('hello')]));
    expect(slotOf(h).style.height).toBe('40px');
  });

  it('a face that grows while the dialog is up gets its slot re-sized', () => {
    // The growth path with no event anywhere: typing a reply that wraps onto
    // more lines, an image landing in a comment body — the face is taller,
    // nothing announces it, and the stale slot clips the reply controls.
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      observed: Element[] = [];
      constructor(public cb: () => void) {
        FakeResizeObserver.instances.push(this);
      }
      observe(el: Element): void {
        this.observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {
        this.observed = [];
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    cleanups.push(() => vi.unstubAllGlobals());

    let faceH = 40;
    const h = mountMeasured(() => faceH);
    h.modal.open(thread('t1', [comment('hello')]));
    expect(slotOf(h).style.height).toBe('40px');

    const watching = FakeResizeObserver.instances.filter((o) =>
      o.observed.some((el) => el.classList.contains('thread-face')),
    );
    expect(watching.length).toBeGreaterThan(0);

    faceH = 90;
    for (const o of watching) o.cb();
    expect(slotOf(h).style.height).toBe('90px');
  });

  it('disposing the mount scope while the dialog is open releases the face watch', () => {
    // Navigating away never calls close() — the scope's own teardown is the
    // only thing that runs, and an observer it misses retains the whole card.
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = [];
      observed: Element[] = [];
      constructor(public cb: () => void) {
        FakeResizeObserver.instances.push(this);
      }
      observe(el: Element): void {
        this.observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {
        this.observed = [];
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    cleanups.push(() => vi.unstubAllGlobals());

    const h = mountMeasured(() => 40);
    h.modal.open(thread('t1', [comment('hello')]));
    const watching = FakeResizeObserver.instances.filter((o) =>
      o.observed.some((el) => el.classList.contains('thread-face')),
    );
    expect(watching.length).toBeGreaterThan(0);

    h.scope.dispose();
    for (const o of watching) {
      expect(o.observed).toHaveLength(0);
    }
  });
});
