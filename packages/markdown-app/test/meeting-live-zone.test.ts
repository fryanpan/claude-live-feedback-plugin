import { beforeEach, describe, expect, it } from 'vitest';
import { WASH_GRACE_MS, createMeetingLiveZone } from '../src/meeting-live-zone.ts';

/**
 * The provisional zone (meeting-notes UX plan, AC 3/4): the live transcript
 * at the end of the doc, per-line meeting timestamps, speaker pills only
 * once a second voice is heard, the splitting-off card while a tick
 * composes, and lines leaving the zone the moment their note is written.
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
const lines = (): string[] =>
  [...zoneEl().querySelectorAll<HTMLElement>('.lz-lines .lz-line')].map((l) => l.textContent ?? '');

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

  it('each line leads with its own meeting time, kept across revisions', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    clock += 258_000; // 04:18 into the meeting
    zone.onTurn({ turn: 0, text: 'the first ver', final: false });
    clock += 12_000;
    zone.onTurn({ turn: 0, text: 'the first version, corrected.', final: true });
    const ts = zoneEl().querySelector('.lz-ts')?.textContent;
    // The moment the turn was FIRST heard — not when it settled.
    expect(ts).toBe('04:18');
    expect(lines()).toEqual(['04:18the first version, corrected.']);
  });

  it('only the line still being spoken carries the caret', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'done.', final: true });
    zone.onTurn({ turn: 1, text: 'still going', final: false });
    const rendered = [...zoneEl().querySelectorAll<HTMLElement>('.lz-line')];
    expect(rendered.map((l) => l.classList.contains('lz-partial'))).toEqual([false, true]);
  });

  it('speaker pills appear only once a second voice has been heard', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'just me so far.', final: true, speaker: 'A' });
    expect(zoneEl().querySelector('.lz-speaker')).toBeNull();
    zone.onTurn({ turn: 1, text: 'a second voice.', final: false, speaker: 'B' });
    const pills = [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')];
    expect(pills.map((p) => p.textContent)).toEqual(['Speaker A', 'Speaker B']);
    zone.setNames({ A: 'Dana' });
    expect(
      [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')].map((p) => p.textContent),
    ).toEqual(['Dana', 'Speaker B']);
  });

  it('composing splits the tick’s lines into the card; written removes them; the rest streams on', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the settled thought.', final: true });
    zone.onTurn({ turn: 1, text: 'the next one, mid-air', final: false });
    const chunk = zoneEl().querySelector<HTMLElement>('.lz-chunk');
    if (!chunk) throw new Error('no chunk card');
    expect(chunk.hidden).toBe(true);

    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    expect(chunk.hidden).toBe(false);
    expect(chunk.querySelector('.lz-chunk-lines')?.textContent).toContain('the settled thought.');
    expect(chunk.querySelector('.lz-chunk-note')?.textContent).toContain(
      'Writing this into the notes above…',
    );
    // The remainder keeps streaming below the card.
    expect(lines()).toEqual(['00:00the next one, mid-air']);

    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });
    expect(chunk.hidden).toBe(true);
    expect(lines()).toEqual(['00:00the next one, mid-air']);
  });

  it('a failed tick returns its lines to the stream — they are still provisional', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'carried words.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.onProgress({ tick: 1, phase: 'failed', turns: [0] });
    expect(zoneEl().querySelector<HTMLElement>('.lz-chunk')?.hidden).toBe(true);
    expect(lines()).toEqual(['00:00carried words.']);
  });

  it('clearSettled drops final lines and keeps the one being spoken (bot fallback)', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'written by the bot path.', final: true });
    zone.onTurn({ turn: 1, text: 'still talking', final: false });
    zone.clearSettled();
    expect(lines()).toEqual(['00:00still talking']);
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
