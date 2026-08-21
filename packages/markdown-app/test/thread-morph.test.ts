import type { Thread } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEAVING_FRACTION,
  MORPH_LAG_MS,
  MORPH_MS,
  MORPH_SPAN_MS,
  installSlotRemeasure,
  isFoldingTap,
  morphCard,
  morphThread,
  morphTiming,
  sizeThreadSlots,
} from '../src/thread-morph.ts';
import { ThreadPanel } from '../src/threads.ts';

/* ========================================================================
   Why this file simulates instead of observing

   happy-dom has no layout engine: every `offsetHeight` is 0 and nothing is
   ever animated. A morph test written naively therefore compares zero to
   zero and passes on an engine that never fired — the exact trap that bit
   the mockup twice (once because `fill: 'backwards'` pins the height at its
   START value, once because a hidden browser tab suspends animations and
   every sample read zero).

   So: give the faces real, DIFFERENT heights; make each slot report the
   height the engine actually wrote (as a browser would); record every
   `animate()` call; and then reconstruct the frames from the RECORDED
   keyframes. Every "nothing moved" assertion below is preceded by a
   positive control proving the fixture can see movement at all.
   ======================================================================== */

interface RecordedAnimation {
  el: HTMLElement;
  keyframes: Keyframe[];
  opts: KeyframeAnimationOptions;
  /** Set by the fake's `cancel()`, so a test can assert the interrupted
   *  journey was actually torn down and not merely stacked under a new one. */
  cancelled?: boolean;
}

/** Install a recording `animate()` on one element subtree. */
function recordAnimations(root: HTMLElement): RecordedAnimation[] {
  const log: RecordedAnimation[] = [];
  const install = (el: HTMLElement) => {
    (el as unknown as { animate: unknown }).animate = (
      keyframes: Keyframe[],
      opts: KeyframeAnimationOptions,
    ) => {
      const rec: RecordedAnimation = { el, keyframes, opts, cancelled: false };
      log.push(rec);
      return {
        cancel() {
          rec.cancelled = true;
        },
        finish() {},
      };
    };
  };
  install(root);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) install(el);
  return log;
}

/**
 * Fake the layout happy-dom doesn't have.
 *
 * Faces get fixed heights that DIFFER between the two faces of a slot (or
 * the morph would have nothing to travel). Slots report whatever height the
 * engine wrote into `style.height`, exactly as a real browser does for an
 * element whose height is set inline.
 */
function fakeLayout(card: HTMLElement, faceHeights: Record<string, number>): void {
  for (const [selector, h] of Object.entries(faceHeights)) {
    const el = card.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`fixture is missing ${selector}`);
    Object.defineProperty(el, 'offsetHeight', { get: () => h, configurable: true });
  }
  for (const slot of Array.from(card.querySelectorAll<HTMLElement>('.thread-slot'))) {
    Object.defineProperty(slot, 'offsetHeight', {
      get(this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 0;
      },
      configurable: true,
    });
  }
}

const HEIGHTS = {
  '.slot-a > .face-summary': 22,
  '.slot-a > .face-detail': 45,
  '.slot-b > .face-summary': 35,
  '.slot-b > .face-detail': 222,
};

function thread(overrides: Partial<Thread> = {}): Thread {
  const alice = { id: 'u1', name: 'Alice', kind: 'known' as const, color: '#2e7dd7' };
  const bob = { id: 'u2', name: 'Bob', kind: 'known' as const, color: '#d72e7d' };
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'text-range', snippet: { text: 'the anchored phrase' } } as Thread['anchor'],
    createdBy: alice,
    commentCount: 2,
    lastActivity: 1_700_000_000_000,
    comments: [
      { id: 'c1', author: alice, text: 'The opening message.', ts: 1_699_999_000_000 },
      { id: 'c2', author: bob, text: 'A reply.', ts: 1_700_000_000_000 },
    ],
    ...overrides,
  } as Thread;
}

/** A real card from the real builder — never a hand-rolled fixture, or the
 *  test proves nothing about what ships. */
function mountCard(t: Thread = thread()): {
  card: HTMLElement;
  container: HTMLElement;
  panel: ThreadPanel;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const panel = new ThreadPanel({
    container,
    currentUser: { id: 'me', name: 'Bryan', kind: 'known', color: '#0a0' },
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });
  const card = panel.renderThread(t);
  container.appendChild(card);
  fakeLayout(card, HEIGHTS);
  sizeThreadSlots(container);
  return { card, container, panel };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** Stub `matchMedia` so the reduced-motion branch is reachable. */
function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

// ---------------------------------------------------------------------------
// Phase timing — pure
// ---------------------------------------------------------------------------

describe('morphTiming', () => {
  it('spans 150ms in two 93ms phases offset by 57ms', () => {
    expect(MORPH_SPAN_MS + MORPH_LAG_MS).toBe(MORPH_MS);
    const open = morphTiming(true, false);
    expect(open.a).toEqual({ duration: MORPH_SPAN_MS, delay: 0 });
    expect(open.b).toEqual({ duration: MORPH_SPAN_MS, delay: MORPH_LAG_MS });
    // Phase 1 runs 0→93, phase 2 runs 57→150.
    expect(open.b.delay + open.b.duration).toBe(MORPH_MS);
  });

  it('collapse reverses the phase order — slot B leads', () => {
    const shut = morphTiming(false, false);
    expect(shut.b.delay).toBe(0);
    expect(shut.a.delay).toBe(MORPH_LAG_MS);
    // Positive control: the two orders really are different.
    expect(shut.a.delay).not.toBe(morphTiming(true, false).a.delay);
  });

  it('reduced motion zeroes duration AND delay, not the layout', () => {
    expect(morphTiming(true, true)).toEqual({
      a: { duration: 0, delay: 0 },
      b: { duration: 0, delay: 0 },
    });
    expect(morphTiming(false, true)).toEqual(morphTiming(true, true));
  });
});

// ---------------------------------------------------------------------------
// What the engine actually asks the browser to do
// ---------------------------------------------------------------------------

describe('morphCard — the animations it schedules', () => {
  it('tweens each slot from its measured old height to its measured new one', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const slotA = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const slotB = card.querySelector<HTMLElement>('.slot-b') as HTMLElement;

    // POSITIVE CONTROL: the resting heights differ, so there is a journey to
    // make. Without this every zero below would pass vacuously.
    const restingA = slotA.style.height;
    const restingB = slotB.style.height;
    expect(restingA).toBe('22px');
    expect(restingB).toBe('35px');

    const log = recordAnimations(card);
    morphCard(card, true);

    expect(slotA.style.height).toBe('45px');
    expect(slotB.style.height).toBe('222px');
    expect(slotA.style.height).not.toBe(restingA);
    expect(slotB.style.height).not.toBe(restingB);

    const heightOf = (el: HTMLElement) =>
      log.find((a) => a.el === el && 'height' in (a.keyframes[0] ?? {}));
    expect(heightOf(slotA)?.keyframes).toEqual([{ height: '22px' }, { height: '45px' }]);
    expect(heightOf(slotB)?.keyframes).toEqual([{ height: '35px' }, { height: '222px' }]);
  });

  it("holds the lagging slot with fill:'backwards' so it travels intact", () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const slotB = card.querySelector<HTMLElement>('.slot-b') as HTMLElement;
    const log = recordAnimations(card);
    morphCard(card, true);

    // Every keyframe set in the morph must fill backwards. Without it the
    // lagging slot jumps to its final height at t=0 instead of riding the
    // leading slot's growth.
    expect(log.length).toBeGreaterThan(0);
    for (const a of log) expect(a.opts.fill).toBe('backwards');
    expect(log.find((a) => a.el === slotB)?.opts.delay).toBe(MORPH_LAG_MS);
  });

  it('cross-fades the two faces, the leaving one faster', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const log = recordAnimations(card);
    morphCard(card, true);

    const detail = card.querySelector<HTMLElement>('.slot-a > .face-detail') as HTMLElement;
    const summary = card.querySelector<HTMLElement>('.slot-a > .face-summary') as HTMLElement;
    const arriving = log.find((a) => a.el === detail);
    const leaving = log.find((a) => a.el === summary);
    expect(arriving?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(leaving?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(leaving?.opts.duration).toBe(MORPH_SPAN_MS * LEAVING_FRACTION);
    expect(leaving?.opts.duration).toBeLessThan(arriving?.opts.duration as number);
    expect(leaving?.opts.delay).toBe(arriving?.opts.delay);
  });

  it('animates ONLY slot heights and face opacity — nothing that could move a slot top', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const log = recordAnimations(card);
    morphCard(card, true);

    // This is what makes invariants 1, 2 and 4 true rather than hopeful: in
    // normal flow, if the only thing that changes is a slot's own height,
    // then the card's top cannot move, slot A's offset cannot move, and slot
    // B's top is BY CONSTRUCTION `slotA.top + slotA.height`.
    expect(log.length).toBe(6); // 2 slots × (height + arriving + leaving)
    for (const a of log) {
      const props = new Set(a.keyframes.flatMap((k) => Object.keys(k)));
      const animatesHeight = props.has('height') && props.size === 1;
      const animatesOpacity = props.has('opacity') && props.size === 1;
      expect(animatesHeight || animatesOpacity).toBe(true);
      if (animatesHeight) expect(a.el.classList.contains('thread-slot')).toBe(true);
      if (animatesOpacity) expect(a.el.classList.contains('thread-face')).toBe(true);
    }
    // Nothing above or beside the slots is touched.
    const head = card.querySelector('.thread-head') as HTMLElement;
    const foot = card.querySelector('.thread-foot') as HTMLElement;
    expect(log.some((a) => a.el === head || a.el === foot || a.el === card)).toBe(false);
    // …and the head and foot really do sit OUTSIDE both slots, which is why
    // the resolve control never moves or rebuilds.
    expect(head.closest('.thread-slot')).toBeNull();
    expect(foot.closest('.thread-slot')).toBeNull();
  });

  it('reduced motion lands the final state with no animation at all', () => {
    stubReducedMotion(true);
    const { card } = mountCard();
    const slotA = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const slotB = card.querySelector<HTMLElement>('.slot-b') as HTMLElement;
    const log = recordAnimations(card);
    morphCard(card, true);

    expect(log).toHaveLength(0);
    // …but the card is fully expanded, not merely un-animated.
    expect(card.classList.contains('expanded')).toBe(true);
    expect(slotA.style.height).toBe('45px');
    expect(slotB.style.height).toBe('222px');
    expect(card.querySelector('.slot-b > .face-detail')?.hasAttribute('aria-hidden')).toBe(false);

    // POSITIVE CONTROL: the same fixture DOES animate without the media
    // query, so "no animations" above is a real result, not a dead recorder.
    stubReducedMotion(false);
    morphCard(card, false);
    expect(log.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The geometric invariants, reconstructed from the recorded keyframes
// ---------------------------------------------------------------------------

/** Evaluate a `cubic-bezier(x1,y1,x2,y2)` easing string at progress `t`. */
function easingAt(easing: string | undefined, t: number): number {
  const m = /cubic-bezier\(([^)]+)\)/.exec(easing ?? '');
  if (!m) return t;
  const [x1, y1, x2, y2] = m[1].split(',').map(Number);
  const bez = (a: number, b: number, u: number) =>
    3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
  // Newton is overkill for a monotone curve at test resolution — bisect.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < t) lo = mid;
    else hi = mid;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

/**
 * The height an element has at time `t`, per the Web Animations semantics
 * this engine relies on: `fill: 'backwards'` holds the FIRST keyframe through
 * the delay, then tweens to the last.
 */
function heightAt(anim: RecordedAnimation, t: number): number {
  const from = Number.parseFloat(String(anim.keyframes[0].height));
  const to = Number.parseFloat(String(anim.keyframes[1].height));
  const delay = anim.opts.delay ?? 0;
  const duration = anim.opts.duration as number;
  if (anim.opts.fill !== 'backwards' && anim.opts.fill !== 'both') {
    // No backwards fill: the element sits at its own (already final) inline
    // height until the animation starts. This branch exists so the test can
    // demonstrate that dropping the fill breaks the invariant.
    if (t < delay) return to;
  } else if (t < delay) {
    return from;
  }
  const p = Math.min(1, (t - delay) / duration);
  return from + (to - from) * easingAt(anim.opts.easing as string, p);
}

function sampleMorph(card: HTMLElement, open: boolean) {
  const slotA = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
  const slotB = card.querySelector<HTMLElement>('.slot-b') as HTMLElement;
  const log = recordAnimations(card);
  morphCard(card, open);
  const animA = log.find((a) => a.el === slotA && 'height' in a.keyframes[0]) as RecordedAnimation;
  const animB = log.find((a) => a.el === slotB && 'height' in a.keyframes[0]) as RecordedAnimation;
  // Head and foot are outside both slots and never animate, so their
  // contribution to the card's height is a constant; any constant will do.
  const CHROME = 40;
  const frames = [];
  for (let t = 0; t <= MORPH_MS; t += 1) {
    const hA = heightAt(animA, t);
    const hB = heightAt(animB, t);
    frames.push({
      t,
      hA,
      hB,
      // Slot A's top is the card top plus the (unanimated) head: constant.
      slotATop: 0,
      // Slot B sits directly under slot A in normal flow.
      slotBTop: hA,
      cardHeight: CHROME + hA + hB,
    });
  }
  return { frames, animA, animB };
}

describe('morph invariants', () => {
  it('slot A holds its top; slot B travels exactly slot A’s growth', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const { frames } = sampleMorph(card, true);

    const first = frames[0];
    const last = frames[frames.length - 1];
    // POSITIVE CONTROL: the slots really do change height across the morph,
    // so the deltas below are not all zero on a morph that never fired.
    expect(last.hA - first.hA).toBeCloseTo(23, 6);
    expect(last.hB - first.hB).toBeCloseTo(187, 6);

    for (const f of frames) {
      expect(f.slotATop).toBe(first.slotATop);
      expect(f.slotBTop - first.slotBTop).toBeCloseTo(f.hA - first.hA, 9);
    }
  });

  it('slot B sits still AT ITS OLD HEIGHT while slot A is still growing', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const slotB = card.querySelector<HTMLElement>('.slot-b') as HTMLElement;
    const restingB = Number.parseFloat(slotB.style.height);
    expect(restingB).toBe(35);
    const { frames } = sampleMorph(card, true);

    const held = frames.filter((f) => f.t < MORPH_LAG_MS);
    // POSITIVE CONTROL: slot A is demonstrably moving during that window.
    expect(held[held.length - 1].hA).toBeGreaterThan(held[0].hA);
    // …and slot B is not: it rides down intact on slot A's growth, still at
    // the height it had before the tap. Asserting mere CONSTANCY here would
    // pass without `fill: 'backwards'` too — the slot would just be pinned at
    // its FINAL height instead, which is the bug.
    for (const f of held) expect(f.hB).toBeCloseTo(restingB, 9);
  });

  it('card height is monotonic, never dips, and lands on the resting sum', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const { frames } = sampleMorph(card, true);

    const collapsed = frames[0].cardHeight;
    let prev = Number.NEGATIVE_INFINITY;
    for (const f of frames) {
      expect(f.cardHeight).toBeGreaterThanOrEqual(collapsed - 1e-9);
      expect(f.cardHeight).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = f.cardHeight;
    }
    // At t = 150ms the card is exactly the sum of the measured resting
    // heights — both phases have landed.
    const slotA = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const slotB = card.querySelector<HTMLElement>('.slot-b') as HTMLElement;
    expect(frames[frames.length - 1].hA).toBeCloseTo(Number.parseFloat(slotA.style.height), 6);
    expect(frames[frames.length - 1].hB).toBeCloseTo(Number.parseFloat(slotB.style.height), 6);
  });

  it('collapse is monotonic downward and reverses the lead', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    morphCard(card, true);
    const { frames, animA, animB } = sampleMorph(card, false);

    expect(animB.opts.delay).toBe(0);
    expect(animA.opts.delay).toBe(MORPH_LAG_MS);
    // POSITIVE CONTROL: it really shrinks.
    expect(frames[frames.length - 1].cardHeight).toBeLessThan(frames[0].cardHeight);
    let prev = Number.POSITIVE_INFINITY;
    for (const f of frames) {
      expect(f.cardHeight).toBeLessThanOrEqual(prev + 1e-9);
      prev = f.cardHeight;
    }
  });

  it("the sampler can SEE a missing fill:'backwards' — it is not a rubber stamp", () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const { animB } = sampleMorph(card, true);
    const broken: RecordedAnimation = { ...animB, opts: { ...animB.opts, fill: 'forwards' } };
    // With no backwards fill the lagging slot is already at its final height
    // at t=0 — the "travels intact" invariant fails, which is exactly what
    // the passing test above is asserting the absence of.
    expect(heightAt(broken, 0)).not.toBeCloseTo(heightAt(animB, 0), 6);
    expect(heightAt(broken, 0)).toBeCloseTo(222, 6);
  });
});

// ---------------------------------------------------------------------------
// Driving every copy, and staying measured
// ---------------------------------------------------------------------------

describe('morphThread', () => {
  it('morphs EVERY copy of a thread from one toggle', () => {
    stubReducedMotion(true);
    const inline = mountCard();
    const sheet = mountCard();
    expect(inline.card.getAttribute('data-thread-id')).toBe(
      sheet.card.getAttribute('data-thread-id'),
    );

    morphThread('t1', true);
    // POSITIVE CONTROL first: both were collapsed a line ago.
    expect(inline.card.classList.contains('expanded')).toBe(true);
    expect(sheet.card.classList.contains('expanded')).toBe(true);
    expect(sheet.card.querySelector('.slot-b')?.getAttribute('style')).toContain('222px');

    morphThread('t1', false);
    expect(inline.card.classList.contains('expanded')).toBe(false);
    expect(sheet.card.classList.contains('expanded')).toBe(false);
  });

  it('does not rebuild the card node', () => {
    stubReducedMotion(true);
    const { card, container } = mountCard();
    morphThread('t1', true);
    expect(container.querySelector('.thread')).toBe(card);
  });
});

describe('isFoldingTap', () => {
  it('lets the card body toggle, and everything you tap FOR something else through', () => {
    const { card } = mountCard();
    // POSITIVE CONTROL: a plain tap on the card's own text does fold it.
    expect(isFoldingTap(card.querySelector('.thread-topic'))).toBe(true);
    expect(isFoldingTap(card.querySelector('.thread-message'))).toBe(true);

    expect(isFoldingTap(card.querySelector('textarea'))).toBe(false);
    expect(isFoldingTap(card.querySelector('.thread-resolve'))).toBe(false);
    expect(isFoldingTap(card.querySelector('.thread-actions button'))).toBe(false);
    // …including a control's inner text node's parent — `closest` walks up.
    const link = document.createElement('a');
    card.querySelector('.thread-message')?.appendChild(link);
    expect(isFoldingTap(link)).toBe(false);
  });

  it('the reply box is a field even though it is a div', () => {
    const { card } = mountCard();
    const surface = card.querySelector('.md-composer-surface');
    // POSITIVE CONTROL: the card really does render a markdown editor, so a
    // passing assertion below is about the tap and not about a missing box.
    expect(surface, 'the reply box mounted no editor').not.toBeNull();

    // The tap lands on the editor, or on the surface's padding around it.
    // Measured before this: the card folded shut under the tap that was
    // reaching for the reply box, because a contenteditable <div> matched none
    // of the tag names the textarea used to.
    expect(isFoldingTap(surface?.querySelector('.ProseMirror') ?? null)).toBe(false);
    expect(isFoldingTap(surface)).toBe(false);
  });

  it('a text selection being dragged out does not fold the card', () => {
    const { card } = mountCard();
    const body = card.querySelector('.thread-message') as HTMLElement;
    expect(isFoldingTap(body)).toBe(true); // positive control, selection collapsed

    vi.stubGlobal('getSelection', () => ({ isCollapsed: false }));
    expect(isFoldingTap(body)).toBe(false);
    vi.stubGlobal('getSelection', () => ({ isCollapsed: true }));
    expect(isFoldingTap(body)).toBe(true);
  });
});

describe('installSlotRemeasure', () => {
  function scopeSpy() {
    const handlers: Array<[string, EventListener]> = [];
    return {
      handlers,
      listen: (target: EventTarget, type: string, handler: EventListenerOrEventListenerObject) => {
        handlers.push([type, handler as EventListener]);
        target.addEventListener(type, handler);
      },
    };
  }

  it('re-measures every slot when a reflow changes the text metrics', () => {
    const { card } = mountCard();
    const slotA = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    expect(slotA.style.height).toBe('22px');

    installSlotRemeasure(scopeSpy());

    // A webfont lands / the window narrows: the topic line now wraps to two.
    const face = card.querySelector<HTMLElement>('.slot-a > .face-summary') as HTMLElement;
    Object.defineProperty(face, 'offsetHeight', { get: () => 44, configurable: true });
    // POSITIVE CONTROL: nothing has re-measured yet, so the height is stale.
    expect(slotA.style.height).toBe('22px');

    window.dispatchEvent(new Event('resize'));
    expect(slotA.style.height).toBe('44px');
  });

  it('re-measures after document.fonts.ready', async () => {
    const { card } = mountCard();
    const slotA = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const face = card.querySelector<HTMLElement>('.slot-a > .face-summary') as HTMLElement;

    let release: () => void = () => {};
    const ready = new Promise<void>((r) => {
      release = r;
    });
    Object.defineProperty(document, 'fonts', {
      value: { ready },
      configurable: true,
    });

    installSlotRemeasure(scopeSpy());
    Object.defineProperty(face, 'offsetHeight', { get: () => 66, configurable: true });
    expect(slotA.style.height).toBe('22px'); // still stale — the font hasn't landed

    release();
    await ready;
    await Promise.resolve();
    expect(slotA.style.height).toBe('66px');
  });

  /* The comments panel is resized by dragging its handle, which rewrites a
     CSS variable — no `resize` fires on the window, and the cards inside it
     reflow anyway. Without a width watcher an expanded card keeps the height
     it was measured at when it was wider, and `overflow: hidden` silently
     eats the bottom of the message. */
  it('re-measures when a container changes WIDTH without a window resize', () => {
    const { card, container } = mountCard();
    const slotA = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const face = card.querySelector<HTMLElement>('.slot-a > .face-summary') as HTMLElement;

    type RoEntry = { target: Element; contentRect: { width: number } };
    const observed: Element[] = [];
    const callbacks: Array<(entries: RoEntry[]) => void> = [];
    class FakeResizeObserver {
      constructor(cb: (entries: RoEntry[]) => void) {
        callbacks.push(cb);
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    installSlotRemeasure(scopeSpy(), [container]);
    expect(observed).toContain(container);
    const fire = (entries: RoEntry[]) => {
      for (const cb of callbacks) cb(entries);
    };

    Object.defineProperty(face, 'offsetHeight', { get: () => 48, configurable: true });
    // POSITIVE CONTROL: nothing has re-measured yet.
    expect(slotA.style.height).toBe('22px');

    fire([{ target: container, contentRect: { width: 280 } }]);
    expect(slotA.style.height).toBe('48px');

    // A HEIGHT-only report is ignored: growing a slot changes the panel's own
    // content height, and reacting to that would loop.
    Object.defineProperty(face, 'offsetHeight', { get: () => 99, configurable: true });
    fire([{ target: container, contentRect: { width: 280 } }]);
    expect(slotA.style.height).toBe('48px');
  });
});

describe('sizeThreadSlots refuses a zero measurement', () => {
  /* A slot's height is a number we WRITE, and both faces are absolutely
     positioned, so a zero written into it is a card clipped to nothing. The
     drawer renders its cards while `#threads-pane` is `display: none` on
     desktop — every face measures 0 there, and that must not be believed. */
  it('leaves the last good height alone when the card is not being laid out', () => {
    const { card, container } = mountCard();
    const slotA = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const face = card.querySelector<HTMLElement>('.slot-a > .face-summary') as HTMLElement;
    expect(slotA.style.height).toBe('22px');

    // The pane is display:none: every offsetHeight in the subtree reads 0.
    Object.defineProperty(face, 'offsetHeight', { get: () => 0, configurable: true });
    sizeThreadSlots(container);
    expect(slotA.style.height).toBe('22px');

    // POSITIVE CONTROL: a real measurement still lands, so the assertion
    // above is about the zero and not about a function that stopped working.
    Object.defineProperty(face, 'offsetHeight', { get: () => 31, configurable: true });
    sizeThreadSlots(container);
    expect(slotA.style.height).toBe('31px');
  });
});

describe('an interrupted morph', () => {
  /*
   * The animations use `fill: 'backwards'` and no forwards fill, so each one
   * stops contributing the moment its active phase ends. Stack a short close
   * on top of a long open and the close finishes FIRST — at which point the
   * open animation, still inside its own active phase, becomes the top of the
   * effect stack again and replays the rest of a journey the user cancelled.
   * On screen: double-tap a card and the replies flash back in and vanish.
   */
  it('tears down the journey it interrupted, on every element it animated', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const log = recordAnimations(card);

    morphCard(card, true);
    const opening = log.length;
    // POSITIVE CONTROL: opening really did animate something, so the
    // assertion below is about cancellation and not about an empty log.
    expect(opening).toBeGreaterThan(0);
    expect(log.some((a) => a.cancelled)).toBe(false);

    morphCard(card, false);

    // Everything the open scheduled is cancelled...
    for (const a of log.slice(0, opening)) expect(a.cancelled).toBe(true);
    // ...and nothing the close scheduled is.
    expect(log.slice(opening).length).toBeGreaterThan(0);
    for (const a of log.slice(opening)) expect(a.cancelled).toBe(false);
  });
});
