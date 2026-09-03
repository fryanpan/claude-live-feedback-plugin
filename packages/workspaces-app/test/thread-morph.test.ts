import type { Thread } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEAVING_FRACTION,
  MORPH_MS,
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

/* The card has ONE slot since the collapsed redesign: its head — glyph,
   topic, who, chevron — stays put across the fold instead of cross-fading
   into anything, so there is one disclosure to animate. */
const HEIGHTS = {
  '.slot-a > .face-summary': 22,
  '.slot-a > .face-detail': 222,
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
  it('is one phase spanning the whole gesture', () => {
    expect(morphTiming(false)).toEqual({ duration: MORPH_MS, delay: 0 });
  });

  it('reduced motion zeroes the duration, not the layout', () => {
    expect(morphTiming(true)).toEqual({ duration: 0, delay: 0 });
    // Positive control: the two answers really are different, so the zero
    // above is a result and not the only thing this function can say.
    expect(morphTiming(true)).not.toEqual(morphTiming(false));
  });
});

// ---------------------------------------------------------------------------
// What the engine actually asks the browser to do
// ---------------------------------------------------------------------------

describe('morphCard — the animations it schedules', () => {
  it('tweens the slot from its measured old height to its measured new one', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const slot = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;

    // POSITIVE CONTROL: the resting heights differ, so there is a journey to
    // make. Without this every zero below would pass vacuously.
    const resting = slot.style.height;
    expect(resting).toBe('22px');

    const log = recordAnimations(card);
    morphCard(card, true);

    expect(slot.style.height).toBe('222px');
    expect(slot.style.height).not.toBe(resting);

    const heightOf = (el: HTMLElement) =>
      log.find((a) => a.el === el && 'height' in (a.keyframes[0] ?? {}));
    expect(heightOf(slot)?.keyframes).toEqual([{ height: '22px' }, { height: '222px' }]);
  });

  it('fills backwards, so the tween replays the journey the class flip already landed', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const slot = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const log = recordAnimations(card);
    morphCard(card, true);

    // The resting state lands immediately and the keyframes only replay it.
    // Without a backwards fill the slot would sit at its FINAL height for
    // the whole delay instead of starting where it was.
    expect(log.length).toBeGreaterThan(0);
    for (const a of log) expect(a.opts.fill).toBe('backwards');
    // One phase: nothing waits for anything else.
    expect(log.find((a) => a.el === slot)?.opts.delay).toBe(0);
    expect(log.find((a) => a.el === slot)?.opts.duration).toBe(MORPH_MS);
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
    expect(leaving?.opts.duration).toBe(MORPH_MS * LEAVING_FRACTION);
    expect(leaving?.opts.duration).toBeLessThan(arriving?.opts.duration as number);
    expect(leaving?.opts.delay).toBe(arriving?.opts.delay);
  });

  it('animates ONLY the slot height and face opacity — nothing that could move the head', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const log = recordAnimations(card);
    morphCard(card, true);

    // This is what makes the invariants below true rather than hopeful: if
    // the only thing that changes is the slot's own height, then neither the
    // card's top nor the head's can move.
    expect(log.length).toBe(3); // 1 slot × (height + arriving + leaving)
    for (const a of log) {
      const props = new Set(a.keyframes.flatMap((k) => Object.keys(k)));
      const animatesHeight = props.has('height') && props.size === 1;
      const animatesOpacity = props.has('opacity') && props.size === 1;
      expect(animatesHeight || animatesOpacity).toBe(true);
      if (animatesHeight) expect(a.el.classList.contains('thread-slot')).toBe(true);
      if (animatesOpacity) expect(a.el.classList.contains('thread-face')).toBe(true);
    }
    // Nothing above or beside the slot is touched.
    const head = card.querySelector('.thread-head') as HTMLElement;
    expect(log.some((a) => a.el === head || a.el === card)).toBe(false);
    // …and the head really does sit OUTSIDE the slot, which is why the topic,
    // the glyph and the chevron never move or rebuild when the card opens.
    expect(head.closest('.thread-slot')).toBeNull();
    // The resolve control, by contrast, is now INSIDE the fold: a folded card
    // does not carry it at all.
    const foot = card.querySelector('.thread-foot') as HTMLElement;
    expect(foot.closest('.thread-face.face-detail')).not.toBeNull();
  });

  it('reduced motion lands the final state with no animation at all', () => {
    stubReducedMotion(true);
    const { card } = mountCard();
    const slot = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const log = recordAnimations(card);
    morphCard(card, true);

    expect(log).toHaveLength(0);
    // …but the card is fully expanded, not merely un-animated.
    expect(card.classList.contains('expanded')).toBe(true);
    expect(slot.style.height).toBe('222px');
    expect(card.querySelector('.slot-a > .face-detail')?.hasAttribute('aria-hidden')).toBe(false);

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
  const slot = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
  const log = recordAnimations(card);
  morphCard(card, open);
  const anim = log.find((a) => a.el === slot && 'height' in a.keyframes[0]) as RecordedAnimation;
  // The head is outside the slot and never animates, so its contribution to
  // the card's height is a constant; any constant will do.
  const CHROME = 40;
  const frames = [];
  for (let t = 0; t <= MORPH_MS; t += 1) {
    const h = heightAt(anim, t);
    frames.push({
      t,
      h,
      // The head's top is the card's top: constant, because nothing animates
      // above the slot.
      headTop: 0,
      // The slot sits directly under the head in normal flow.
      slotTop: 0,
      cardHeight: CHROME + h,
    });
  }
  return { frames, anim };
}

describe('morph invariants', () => {
  it('the head holds its top for the whole journey', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    const { frames } = sampleMorph(card, true);

    const first = frames[0];
    const last = frames[frames.length - 1];
    // POSITIVE CONTROL: the slot really does change height across the morph,
    // so the constancy below is not measured on a morph that never fired.
    expect(last.h - first.h).toBeCloseTo(200, 6);

    for (const f of frames) {
      expect(f.headTop).toBe(first.headTop);
      expect(f.slotTop).toBe(first.slotTop);
    }
  });

  it('card height is monotonic, never dips, and lands on the resting height', () => {
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
    // At t = 150ms the card is exactly the measured resting height.
    const slot = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    expect(frames[frames.length - 1].h).toBeCloseTo(Number.parseFloat(slot.style.height), 6);
  });

  it('collapse is monotonic downward and starts immediately', () => {
    stubReducedMotion(false);
    const { card } = mountCard();
    morphCard(card, true);
    const { frames, anim } = sampleMorph(card, false);

    // One slot has nothing to lag behind, so it leads in both directions.
    expect(anim.opts.delay).toBe(0);
    // POSITIVE CONTROL: it really shrinks.
    expect(frames[frames.length - 1].cardHeight).toBeLessThan(frames[0].cardHeight);
    let prev = Number.POSITIVE_INFINITY;
    for (const f of frames) {
      expect(f.cardHeight).toBeLessThanOrEqual(prev + 1e-9);
      prev = f.cardHeight;
    }
  });

  /* The two assertions that used to sit here — that the lagging slot holds
     its OLD height through the delay, and that the sampler can see a missing
     `fill: 'backwards'` — went with the second slot. One phase has no delay,
     so a backwards fill has nothing to hold across and neither assertion
     could fail any more. What they were really protecting is now covered
     above by the recorded keyframes, which start at the height measured
     BEFORE the class flip: that is what lets an interrupted fold replay from
     wherever it had got to rather than from its resting state. */
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
    expect(sheet.card.querySelector('.slot-a')?.getAttribute('style')).toContain('222px');

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

  /* A reply composer's editor chunk mounts in a microtask — AFTER the card
     holding it was measured, so the detail face grows under a slot height
     written against the bare textarea and `overflow: hidden` eats the reply
     box — the clipped-reply defect, as reported in the field. The mount
     announces itself with a bubbling event; the remeasure listens for it. */
  it('re-measures when a composer editor mounts inside a card', () => {
    const { card } = mountCard();
    const slotA = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    installSlotRemeasure(scopeSpy());

    const face = card.querySelector<HTMLElement>('.slot-a > .face-summary') as HTMLElement;
    Object.defineProperty(face, 'offsetHeight', { get: () => 55, configurable: true });
    // POSITIVE CONTROL: nothing has re-measured yet, so the height is stale.
    expect(slotA.style.height).toBe('22px');

    card.dispatchEvent(new CustomEvent('lf-composer-mounted', { bubbles: true }));
    expect(slotA.style.height).toBe('55px');
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

describe('sizeThreadSlots converges when its own writes change layout', () => {
  /* Writing slot heights can itself reflow the cards it just measured: on a
     scroller whose content crosses its height only once the slots are tall,
     the scrollbar appears, every face narrows, and the longest text rewraps
     TALLER — after the pass that measured it. Measured live in the thread
     modal: face 1691px at measure, 1740px one microtask later, and the 49px
     clipped by the stale height was exactly the Reply row. So a pass must
     re-read after writing and keep going until the numbers stop moving. */
  it('re-measures after writing, so a rewrap caused by the write still lands', () => {
    const { card, container } = mountCard();
    const slotB = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const face = card.querySelector<HTMLElement>('.slot-a > .face-summary') as HTMLElement;
    // Emulate the scrollbar feedback: while the slot is unset the scroller
    // does not overflow and the face measures 35; the moment a height ≥35 is
    // written the scroller overflows, the face narrows, and it rewraps to 84.
    slotB.style.height = '';
    Object.defineProperty(face, 'offsetHeight', {
      get: () => (Number.parseFloat(slotB.style.height) >= 35 ? 84 : 35),
      configurable: true,
    });
    sizeThreadSlots(container);
    expect(slotB.style.height).toBe('84px');
  });

  it('gives up on an oscillating layout instead of looping forever', () => {
    const { card, container } = mountCard();
    const slotB = card.querySelector<HTMLElement>('.slot-a') as HTMLElement;
    const face = card.querySelector<HTMLElement>('.slot-a > .face-summary') as HTMLElement;
    slotB.style.height = '';
    // Pathological: every re-read disagrees with the last write.
    let reads = 0;
    Object.defineProperty(face, 'offsetHeight', {
      get: () => {
        reads += 1;
        return 30 + reads;
      },
      configurable: true,
    });
    sizeThreadSlots(container);
    // Bounded: a handful of reads, not an unbounded loop. The exact count is
    // the pass cap's business; what matters is that it stopped.
    expect(reads).toBeLessThanOrEqual(8);
    expect(slotB.style.height).not.toBe('');
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
