/**
 * The browser half of the latency measurement: the flag that turns it on, the
 * marks only this side can take, and the guarantee that an ordinary page load
 * is untouched by any of it.
 *
 * The paint mark is driven by hand here rather than by a real animation
 * frame. That is the point of injecting it: a test that waited for a real
 * frame would be timing the test runner, and the arithmetic under test is
 * exactly the arithmetic that must not depend on when the frame happened to
 * land.
 */
import {
  DEFAULT_CAPTURE_MODE,
  MEETING_AUDIO_ENCODING,
  type MeetingTimingMark,
} from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MeetingSocket, mountMeetingStrip, parseTimingMark } from '../src/meeting-strip.ts';
import { createTimingSession, wantsLatencyTiming } from '../src/meeting-timing-client.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

describe('the flag', () => {
  it('turns on for ?timing=1 and for nothing else', () => {
    expect(wantsLatencyTiming('?timing=1')).toBe(true);
    expect(wantsLatencyTiming('?thread=t-1&timing=1')).toBe(true);
    expect(wantsLatencyTiming('')).toBe(false);
    expect(wantsLatencyTiming('?timing=0')).toBe(false);
    // Not "any value is truthy": a stray flag should not start measuring.
    expect(wantsLatencyTiming('?timing=yes')).toBe(false);
  });
});

const FULL_MARK: MeetingTimingMark = {
  seq: 5,
  audioEndMs: 570,
  chunkAudioEndMs: 600,
  recvMs: 6_512,
  fwdMs: 6_513,
  engineMs: 6_800,
  sendMs: 6_801,
};

describe('the timing block is all-or-nothing', () => {
  it('accepts a complete block', () => {
    expect(parseTimingMark({ ...FULL_MARK })).toEqual(FULL_MARK);
  });

  it('refuses a block missing any one field', () => {
    // A partial block would produce a leg computed from a missing number and
    // land in the percentiles looking like a measurement.
    for (const key of Object.keys(FULL_MARK)) {
      const partial: Record<string, unknown> = { ...FULL_MARK };
      delete partial[key];
      expect(parseTimingMark(partial), `${key} should be required`).toBeNull();
    }
    expect(parseTimingMark({ ...FULL_MARK, engineMs: 'soon' })).toBeNull();
    expect(parseTimingMark({ ...FULL_MARK, seq: Number.NaN })).toBeNull();
    expect(parseTimingMark(null)).toBeNull();
    expect(parseTimingMark('nope')).toBeNull();
  });
});

/** A session with every clock and callback under the test's control. */
function harness() {
  const clock = { at: 1_000 };
  const sent: string[] = [];
  const paints: Array<() => void> = [];
  const saved: string[] = [];
  const session = createTimingSession({
    now: () => clock.at,
    send: (json) => sent.push(json),
    interval: () => () => {},
    timeout: () => {},
    afterPaint: (fn) => paints.push(fn),
    saveCsv: (csv) => saved.push(csv),
  });
  cleanups.push(() => session.destroy());
  return { clock, sent, paints, saved, session };
}

/** Server clock runs 5s ahead; one exchange establishes it exactly. */
function syncClock(h: ReturnType<typeof harness>): void {
  h.session.onPong({ id: 1, clientMs: 900, serverRecvMs: 5_910, serverSendMs: 5_911 }, 921);
}

describe('one measured word, end to end', () => {
  it('splits the journey into legs that add up to what the person waited', () => {
    const h = harness();
    h.session.begin();
    syncClock(h);
    // Six frames, 100ms apart: frame 5 goes out at t=1500.
    for (let i = 0; i < 6; i++) {
      h.clock.at = 1_000 + i * 100;
      h.session.frameSent();
    }
    h.clock.at = 1_809;
    h.session.frameReceived({ turn: 2, final: false, timing: FULL_MARK }, 1_809);
    h.clock.at = 1_812;
    h.session.domUpdated();
    expect(h.session.samples()).toHaveLength(0);
    h.clock.at = 1_818;
    for (const paint of h.paints.splice(0)) paint();

    const [s] = h.session.samples();
    expect(s).toBeDefined();
    expect(s?.capture).toBe(30);
    expect(s?.spokenMs).toBe(1_470);
    expect(s?.uplink).toBe(12);
    expect(s?.queue).toBe(1);
    expect(s?.vendor).toBe(287);
    expect(s?.serverOut).toBe(1);
    expect(s?.downlink).toBe(8);
    expect(s?.render).toBe(3);
    expect(s?.paint).toBe(6);
    expect(s?.total).toBe(348);
    expect(s?.offsetMs).toBe(5_000);
  });

  it('shows the running p50/p95 in the readout', () => {
    const h = harness();
    h.session.begin();
    syncClock(h);
    for (let i = 0; i < 6; i++) {
      h.clock.at = 1_000 + i * 100;
      h.session.frameSent();
    }
    h.clock.at = 1_809;
    h.session.frameReceived({ turn: 2, final: false, timing: FULL_MARK }, 1_809);
    h.clock.at = 1_812;
    h.session.domUpdated();
    h.clock.at = 1_818;
    for (const paint of h.paints.splice(0)) paint();
    const values = [...h.session.element.querySelectorAll('.meeting-timing-value')].map(
      (el) => el.textContent ?? '',
    );
    expect(values[0]).toBe('348/348 ms');
    // The vendor is the biggest leg in this budget; the readout says so
    // beside what everything we own costs together.
    expect(values[1]).toBe('287 / 61 ms');
    expect(values[2]).toBe('1');
  });

  it('drops a word whose audio frame it no longer remembers, rather than guessing one', () => {
    const h = harness();
    h.session.begin();
    syncClock(h);
    // Only two frames were ever sent; the mark names frame 5.
    h.session.frameSent();
    h.session.frameSent();
    h.session.frameReceived({ turn: 2, final: false, timing: FULL_MARK }, 1_809);
    h.session.domUpdated();
    for (const paint of h.paints.splice(0)) paint();
    expect(h.session.samples()).toHaveLength(0);
  });

  it('ignores a transcript frame with no block at all', () => {
    const h = harness();
    h.session.begin();
    h.session.frameSent();
    h.session.frameReceived({ turn: 0, final: true }, 1_100);
    h.session.domUpdated();
    expect(h.paints).toHaveLength(0);
    expect(h.session.samples()).toHaveLength(0);
  });

  it('keeps the headline on partials, and counts the finals separately', () => {
    const h = harness();
    h.session.begin();
    syncClock(h);
    for (let i = 0; i < 6; i++) h.session.frameSent();
    // A final arrives after the engine has re-punctuated the turn, so it is
    // slower by construction; averaging it in would report a pipeline nobody
    // is watching.
    h.clock.at = 1_809;
    h.session.frameReceived({ turn: 2, final: true, timing: FULL_MARK }, 1_809);
    h.clock.at = 1_812;
    h.session.domUpdated();
    h.clock.at = 1_818;
    for (const paint of h.paints.splice(0)) paint();
    expect(h.session.samples()).toHaveLength(1);
    expect(h.session.summary().total.n).toBe(0);
    const values = [...h.session.element.querySelectorAll('.meeting-timing-value')].map(
      (el) => el.textContent ?? '',
    );
    expect(values[2]).toBe('0+1f');
  });

  it('hands over a CSV of what it has', () => {
    const h = harness();
    h.session.begin();
    syncClock(h);
    for (let i = 0; i < 6; i++) h.session.frameSent();
    h.session.frameReceived({ turn: 2, final: false, timing: FULL_MARK }, 1_809);
    h.session.domUpdated();
    for (const paint of h.paints.splice(0)) paint();
    (h.session.element.querySelector('.meeting-timing-save') as HTMLButtonElement).click();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.split('\n')[0]).toContain('total');
    expect(h.saved[0]?.split('\n')).toHaveLength(2);
  });

  it('starts a second meeting from nothing', () => {
    const h = harness();
    h.session.begin();
    syncClock(h);
    for (let i = 0; i < 6; i++) h.session.frameSent();
    h.session.frameReceived({ turn: 2, final: false, timing: FULL_MARK }, 1_809);
    h.session.domUpdated();
    for (const paint of h.paints.splice(0)) paint();
    expect(h.session.samples()).toHaveLength(1);
    // The next meeting is a new audio stream: the old frame ordinals mean
    // nothing to the new server-side ledger, so carrying them would price a
    // word against somebody else's frame.
    h.session.begin();
    expect(h.session.samples()).toHaveLength(0);
  });
});

class FakeSocket implements MeetingSocket {
  readonly sent: Array<string | ArrayBufferView> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {}
}

/** Let the start()'s promise chain settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

async function mountStrip(timing: boolean): Promise<{ root: HTMLElement; socket: FakeSocket }> {
  const root = document.createElement('div');
  document.body.append(root);
  let socket: FakeSocket | null = null;
  const strip = mountMeetingStrip({
    docId: 'doc-1',
    root,
    now: () => 1_000,
    interval: () => () => {},
    openSocket: () => {
      socket = new FakeSocket();
      return socket;
    },
    startCapture: () => Promise.resolve({ ok: true, capture: { stop: vi.fn() } }),
    timing,
  });
  cleanups.push(() => strip.destroy());
  (root.querySelector('.meeting-toggle') as HTMLButtonElement).click();
  await settle();
  const sock = socket as FakeSocket | null;
  if (!sock) throw new Error('the strip opened no socket');
  sock.onopen?.();
  return { root, socket: sock };
}

describe('the strip only measures when it is asked — and the control that proves it can', () => {
  it('draws no readout and asks for no timing on an ordinary load', async () => {
    const { root, socket } = await mountStrip(false);
    expect(root.querySelector('.meeting-timing-row')).toBeNull();
    expect(root.classList.contains('has-timing')).toBe(false);
    const start = JSON.parse(socket.sent[0] as string) as Record<string, unknown>;
    // Whole-shape, so `timing` being absent is asserted rather than assumed.
    expect(start).toEqual({
      type: 'start',
      sampleRate: 16_000,
      encoding: MEETING_AUDIO_ENCODING,
      mode: DEFAULT_CAPTURE_MODE,
    });
  });

  it('draws the readout and asks, under the flag', async () => {
    const { root, socket } = await mountStrip(true);
    expect(root.querySelector('.meeting-timing-row')).not.toBeNull();
    expect(root.classList.contains('has-timing')).toBe(true);
    const start = JSON.parse(socket.sent[0] as string) as Record<string, unknown>;
    expect(start.timing).toBe(true);
    // The readout is a row of its own, after the caption — never a fourth
    // item competing with the transcript for the bar's one line.
    expect(root.lastElementChild?.className).toBe('meeting-timing-row');
  });
});
