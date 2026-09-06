import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAPSE_MS,
  FADE_MS,
  FOLLOW_SLACK_PX,
  NOTE_LAND_MS,
  WASH_GRACE_MS,
  createMeetingLiveZone,
} from '../src/meeting-live-zone.ts';

/**
 * The provisional zone (meeting-notes UX plan, AC 3/4): the live transcript
 * at the end of the doc as ONE run of text — no per-turn stamps or blocks
 * (owner, 2026-09-01: "engine turns have no meaning or value to the
 * viewer") — speaker pills only once a second voice is heard, the
 * splitting-off card while a tick composes, and words leaving the zone the
 * moment their note is written.
 */

let parent: HTMLElement;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  document.body.innerHTML = '';
  parent = document.createElement('div');
  document.body.append(parent);
  clock = 100_000;
});

const zoneEl = (): HTMLElement => {
  const el = parent.querySelector<HTMLElement>('.live-zone');
  if (!el) throw new Error('no .live-zone rendered');
  return el;
};
const turns = (): string[] =>
  [...zoneEl().querySelectorAll<HTMLElement>('.lz-lines .lz-turn')].map((l) => l.textContent ?? '');
const stream = (): string => zoneEl().querySelector('.lz-lines')?.textContent ?? '';
const chunkEl = (): HTMLElement | null => zoneEl().querySelector<HTMLElement>('.lz-chunk');
const slotEl = (): HTMLElement | null => zoneEl().querySelector<HTMLElement>('.lz-slot');

describe('the provisional live zone', () => {
  it('is hidden until a live meeting has words, and renders after the editor content', () => {
    const zone = createMeetingLiveZone({ parent, now });
    expect(zoneEl().hidden).toBe(true);
    zone.begin(now());
    expect(zoneEl().hidden).toBe(true);
    zone.onTurn({ turn: 0, text: 'hello', final: false });
    expect(zoneEl().hidden).toBe(false);
    expect(zoneEl().querySelector('.lz-label')?.textContent).toBe('Live transcript');
    // Appended last: at the end of the doc, under whatever the parent holds.
    expect(parent.lastElementChild).toBe(zoneEl());
  });

  it('a turn arriving before begin() is dropped — nothing owns the zone yet', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.onTurn({ turn: 0, text: 'stray', final: true });
    expect(zoneEl().hidden).toBe(true);
  });

  it('renders N finals as one run of text: no stamps, no blocks, a space between turns', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    clock += 258_000;
    zone.onTurn({ turn: 0, text: 'the first ver', final: false });
    clock += 12_000;
    zone.onTurn({ turn: 0, text: 'The first version, corrected.', final: true });
    zone.onTurn({ turn: 1, text: 'Then a few more words', final: true });
    zone.onTurn({ turn: 2, text: 'and the rest of the sentence.', final: true });
    const lines = zoneEl().querySelector<HTMLElement>('.lz-lines');
    if (!lines) throw new Error('no .lz-lines');
    // No mm:ss anywhere in the stream — a turn's arrival time is the
    // engine's business, not the reader's.
    expect(lines.textContent).not.toMatch(/\b\d\d:\d\d\b/);
    expect(lines.querySelector('.lz-ts')).toBeNull();
    // Every child is inline: a span per turn, a text node between, nothing
    // block-level, so the words wrap as one paragraph.
    for (const child of [...lines.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        expect(child.textContent).toBe(' ');
        continue;
      }
      expect((child as Element).tagName).toBe('SPAN');
      expect((child as Element).classList.contains('lz-turn')).toBe(true);
    }
    expect(lines.querySelector('div, p, li')).toBeNull();
    expect(stream()).toBe(
      'The first version, corrected. Then a few more words and the rest of the sentence.',
    );
  });

  it('keeps a line break the engine put in a turn, and adds none of its own', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'First paragraph.\nSecond paragraph.', final: true });
    zone.onTurn({ turn: 1, text: 'No break before this.', final: true });
    const lines = zoneEl().querySelector<HTMLElement>('.lz-lines');
    if (!lines) throw new Error('no .lz-lines');
    expect(lines.querySelectorAll('br')).toHaveLength(1);
    const first = lines.querySelector('.lz-turn');
    expect(first?.querySelector('br')).not.toBeNull();
    expect(turns()).toEqual(['First paragraph.Second paragraph.', 'No break before this.']);
  });

  it('only the line still being spoken carries the caret', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'done.', final: true });
    zone.onTurn({ turn: 1, text: 'still going', final: false });
    const rendered = [...zoneEl().querySelectorAll<HTMLElement>('.lz-turn')];
    expect(rendered.map((l) => l.classList.contains('lz-partial'))).toEqual([false, true]);
  });

  it('speaker pills appear only once a second voice has been heard, and only where the voice changes', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'just me so far.', final: true, speaker: 'A' });
    zone.onTurn({ turn: 1, text: 'still me.', final: true, speaker: 'A' });
    expect(zoneEl().querySelector('.lz-speaker')).toBeNull();
    zone.onTurn({ turn: 2, text: 'a second voice.', final: true, speaker: 'B' });
    zone.onTurn({ turn: 3, text: 'the same voice, going on', final: false, speaker: 'B' });
    // One pill per run of a voice — the engine's turn boundaries inside a
    // run are not the reader's.
    const pills = [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')];
    expect(pills.map((p) => p.textContent)).toEqual(['Speaker A', 'Speaker B']);
    zone.setNames({ A: 'Dana' });
    expect(
      [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')].map((p) => p.textContent),
    ).toEqual(['Dana', 'Speaker B']);
  });

  it('composing splits the tick’s lines off with nothing drawn around them, and the rest streams on', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the settled thought.', final: true });
    zone.onTurn({ turn: 1, text: 'the next one, mid-air', final: false });
    expect(chunkEl()).toBeNull(); // no block until a tick actually splits one

    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    const chunk = chunkEl();
    if (!chunk) throw new Error('no chunk');
    expect(chunk.textContent).toContain('the settled thought.');
    // The chunk IS the stream's type, and nothing is drawn in its place: the
    // "Writing this into the notes above…" line and its spinner are gone
    // (owner, 2026-09-05 — both took up space and shifted the words).
    expect(chunk.classList.contains('lz-chunk-lines')).toBe(true);
    expect(zoneEl().querySelector('.lz-chunk-note')).toBeNull();
    expect(zoneEl().querySelector('.lz-spinner')).toBeNull();
    expect(zoneEl().textContent).not.toContain('Writing this into the notes');
    // The remainder keeps streaming below.
    expect(turns()).toEqual(['the next one, mid-air']);
  });

  it('a failed tick returns its lines to the stream — they are still provisional', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'carried words.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    expect(chunkEl()).not.toBeNull(); // control: it really was split off
    zone.onProgress({ tick: 1, phase: 'failed', turns: [0] });
    // Nothing settled, so the block goes at once — no fade, no collapse.
    expect(chunkEl()).toBeNull();
    expect(turns()).toEqual(['carried words.']);
  });

  it('clearSettled drops final lines and keeps the one being spoken (bot fallback)', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'written by the bot path.', final: true });
    zone.onTurn({ turn: 1, text: 'still talking', final: false });
    zone.clearSettled();
    expect(turns()).toEqual(['still talking']);
  });

  it('end() hides and forgets; the wash stays armed for the grace window only', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'words.', final: true });
    expect(zone.active()).toBe(true);
    zone.end();
    expect(zone.active()).toBe(false);
    expect(zoneEl().hidden).toBe(true);
    // The end tick's note lands seconds after `stopped` — it still washes…
    expect(zone.washActive()).toBe(true);
    // …but a remote edit long after the meeting does not.
    clock += WASH_GRACE_MS + 1;
    expect(zone.washActive()).toBe(false);
  });

  it('destroy removes the zone element', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.destroy();
    expect(parent.querySelector('.live-zone')).toBeNull();
  });
});

/**
 * The settle (approved settle mock, round 2). The words do not
 * disappear with their turns: the block holding them stays where it is,
 * holds while the note lands, fades in place, and only then collapses the
 * space it held.
 *
 * happy-dom lays nothing out, so the "nothing below it moves" claim is a
 * BROWSER measurement (recorded in the PR). What is guarded here is the
 * mechanism that produces it: the slot's height is pinned before the fade
 * starts and is not touched again until the collapse begins.
 */
describe('a settled chunk fades where it sits, then collapses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settling = (): { zone: ReturnType<typeof createMeetingLiveZone>; slot: HTMLElement } => {
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => false });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the settled thought.', final: true });
    zone.onTurn({ turn: 1, text: 'still talking', final: false });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });
    const slot = slotEl();
    if (!slot) throw new Error('the chunk left the zone the moment its turns did');
    return { zone, slot };
  };

  it('holds the words on screen after `written`, at a pinned height', () => {
    const { slot } = settling();
    // The turns are gone from the model…
    expect(turns()).toEqual(['still talking']);
    // …but their words are still on the page, not yet fading.
    expect(slot.textContent).toContain('the settled thought.');
    expect(chunkEl()?.classList.contains('is-fading')).toBe(false);
    // Pinned before anything animates, so the fade cannot change the height.
    expect(slot.style.height).toBe('0px'); // happy-dom measures every box at 0
  });

  it('fades only after the note has had time to land, and collapses only after the fade', () => {
    const { slot } = settling();
    const pinned = slot.style.height;

    vi.advanceTimersByTime(NOTE_LAND_MS - 1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(true);

    // Through the whole fade the slot keeps the height it was pinned at and
    // the collapse has not started — this is the interval the browser
    // measurement checks nothing below it moves in.
    vi.advanceTimersByTime(FADE_MS - 1);
    expect(slot.classList.contains('is-collapsing')).toBe(false);
    expect(slot.style.height).toBe(pinned);

    vi.advanceTimersByTime(1);
    expect(slot.classList.contains('is-collapsing')).toBe(true);
    expect(slot.style.height).toBe('0px');

    // Gone once the collapse has run, and the zone with it — nothing left.
    vi.advanceTimersByTime(COLLAPSE_MS);
    expect(slotEl()).toBeNull();
  });

  it('reduced motion keeps the cross-fade and drops only the travel', () => {
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => true });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the settled thought.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });

    // Not a cut: the words are still there, and they still fade — the owner
    // tried the instant swap and called it too sudden (2026-09-05).
    vi.advanceTimersByTime(NOTE_LAND_MS - 1);
    expect(chunkEl()?.textContent).toContain('the settled thought.');
    expect(chunkEl()?.classList.contains('is-fading')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(true);

    // The fade runs its full length…
    vi.advanceTimersByTime(FADE_MS - 1);
    expect(slotEl()?.classList.contains('is-collapsing')).toBe(false);
    // …and it is the COLLAPSE that loses its travel, not the fade.
    vi.advanceTimersByTime(1);
    const slot = slotEl();
    expect(slot?.classList.contains('is-collapsing')).toBe(true);
    expect(slot?.style.getPropertyValue('--lz-collapse-ms')).toBe('0ms');
    // No travel to wait out: the slot goes on the very next tick, where the
    // full-motion path is still COLLAPSE_MS from being done.
    vi.advanceTimersByTime(1);
    expect(slotEl()).toBeNull();
  });

  it('a second tick settles behind the first without disturbing it', () => {
    const { zone, slot } = settling();
    zone.onTurn({ turn: 1, text: 'still talking, finished now.', final: true });
    zone.onProgress({ tick: 2, phase: 'composing', turns: [1] });
    const slots = zoneEl().querySelectorAll('.lz-slot');
    expect(slots).toHaveLength(2);
    // Order on the page is the order they settled: the older one stays above.
    expect(slots[0]).toBe(slot);
    expect(slots[1]?.textContent).toContain('still talking, finished now.');
  });

  it('the meeting ending drops a chunk mid-settle rather than leaving it behind', () => {
    const { zone } = settling();
    vi.advanceTimersByTime(NOTE_LAND_MS);
    zone.end();
    expect(slotEl()).toBeNull();
    expect(zoneEl().hidden).toBe(true);
    // And no timer left to resurrect it.
    vi.advanceTimersByTime(FADE_MS + COLLAPSE_MS);
    expect(slotEl()).toBeNull();
  });
});

/**
 * Layout stand-ins: happy-dom lays nothing out, so the pane and the zone
 * report the geometry the test declares. `zoneBottom` is the zone's bottom
 * in the pane's content coordinates; the pane is `viewport` tall.
 */
function fakeLayout(opts: { viewport: number; zoneBottom: () => number; proseWidth?: number }) {
  let scrollTop = 0;
  Object.defineProperty(parent, 'clientHeight', { value: opts.viewport, configurable: true });
  Object.defineProperty(parent, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
  parent.getBoundingClientRect = () => ({ top: 0, bottom: opts.viewport }) as DOMRect;
  zoneEl().getBoundingClientRect = () =>
    ({ top: opts.zoneBottom() - 40 - scrollTop, bottom: opts.zoneBottom() - scrollTop }) as DOMRect;
  const prose = document.createElement('div');
  prose.getBoundingClientRect = () => ({ width: opts.proseWidth ?? 0 }) as DOMRect;
  return {
    prose,
    scroll: (to: number) => {
      scrollTop = to;
      parent.dispatchEvent(new Event('scroll'));
    },
    top: () => scrollTop,
  };
}

describe('the live zone stays in view', () => {
  it('scrolls the pane so a zone that grew past the bottom edge is visible again', () => {
    const zone = createMeetingLiveZone({ parent, now });
    let bottom = 300;
    const lay = fakeLayout({ viewport: 500, zoneBottom: () => bottom });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'fits', final: false });
    expect(lay.top()).toBe(0); // in view: nothing to do
    bottom = 900;
    zone.onTurn({ turn: 0, text: 'fits and then some more words', final: false });
    // Bottom edge plus the 12px breathing room lands at the pane's edge.
    expect(lay.top()).toBe(900 + 12 - 500);
  });

  it('does not fight a deliberate scroll up, and follows again once scrolled back', () => {
    const zone = createMeetingLiveZone({ parent, now });
    let bottom = 900;
    const lay = fakeLayout({ viewport: 500, zoneBottom: () => bottom });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'a line', final: false });
    expect(lay.top()).toBe(412);
    // The person scrolls to the top to read the agenda.
    lay.scroll(0);
    bottom = 960;
    zone.onTurn({ turn: 0, text: 'a line, longer now', final: false });
    expect(lay.top()).toBe(0);
    // They scroll back until the zone's bottom is within the slack…
    lay.scroll(960 + 12 - 500 - FOLLOW_SLACK_PX);
    bottom = 1020;
    zone.onTurn({ turn: 0, text: 'a line, longer still', final: false });
    // …and the zone is followed again.
    expect(lay.top()).toBe(1020 + 12 - 500);
  });

  it("copies the prose column's width so the two coincide exactly", () => {
    const zone = createMeetingLiveZone({ parent, now, prose: document.createElement('div') });
    const lay = fakeLayout({ viewport: 500, zoneBottom: () => 100, proseWidth: 678 });
    // The prose handed in at creation reports no layout in happy-dom; swap
    // in the measured one through the same option shape.
    zone.destroy();
    const zone2 = createMeetingLiveZone({ parent, now, prose: lay.prose });
    fakeLayout({ viewport: 500, zoneBottom: () => 100, proseWidth: 678 });
    zone2.begin(now());
    zone2.onTurn({ turn: 0, text: 'hello', final: false });
    expect(zoneEl().style.width).toBe('678px');
  });
});
