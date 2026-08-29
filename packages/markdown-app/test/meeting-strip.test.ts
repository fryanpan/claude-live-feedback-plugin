import { MEETING_AUDIO_ENCODING, MEETING_SAMPLE_RATE, meetingSocketPath } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MeetingCaptureStart } from '../src/meeting-audio.ts';
import {
  type MeetingSocket,
  type MeetingStripHandle,
  TRANSCRIPT_KEEP,
  diffTurnWords,
  formatElapsed,
  mountMeetingStrip,
  parseMeetingServerMessage,
  rollTranscript,
} from '../src/meeting-strip.ts';

/**
 * The strip is the only surface a meeting has, so every way a meeting can fail
 * has to arrive as words in it. These cover the rolling transcript (where a
 * correction has to land on the word already on screen), the clock, and each
 * state the strip can be left sitting in.
 */

describe('rollTranscript', () => {
  const t = (turn: number, text: string, final = false) => ({ turn, text, final });

  it('appends new turns and keeps only the last few', () => {
    let turns = rollTranscript([], t(1, 'one'), 2);
    turns = rollTranscript(turns, t(2, 'two'), 2);
    turns = rollTranscript(turns, t(3, 'three'), 2);
    expect(turns.map((x) => x.text)).toEqual(['two', 'three']);
  });

  it('REPLACES a turn already on screen in place — that is how a correction lands', () => {
    let turns = rollTranscript([], t(1, 'meet on thirsty'), 3);
    turns = rollTranscript(turns, t(2, 'sounds good'), 3);
    turns = rollTranscript(turns, t(1, 'meet on Thursday', true), 3);
    expect(turns.map((x) => x.text)).toEqual(['meet on Thursday', 'sounds good']);
    expect(turns[0]?.final).toBe(true);
  });

  it('drops a correction for a turn that has already rolled off', () => {
    let turns = rollTranscript([], t(1, 'one'), 2);
    turns = rollTranscript(turns, t(2, 'two'), 2);
    turns = rollTranscript(turns, t(3, 'three'), 2);
    // Turn 1 is gone; re-adding it would put an old line at the live end.
    turns = rollTranscript(turns, t(1, 'ONE'), 2);
    expect(turns.map((x) => x.text)).toEqual(['two', 'three']);
  });

  it('keeps three turns by default', () => {
    expect(TRANSCRIPT_KEEP).toBe(3);
  });
});

describe('diffTurnWords', () => {
  it('marks only the word the model changed, not the whole line', () => {
    const words = diffTurnWords('meet on thirsty', 'meet on Thursday');
    expect(words.map((w) => w.text)).toEqual(['meet', 'on', 'Thursday']);
    expect(words.map((w) => w.changed)).toEqual([false, false, true]);
  });

  it('does not flash words that are merely new', () => {
    const words = diffTurnWords('meet on', 'meet on Thursday');
    expect(words.map((w) => w.changed)).toEqual([false, false, false]);
  });

  it('handles a correction that changes the word count', () => {
    const words = diffTurnWords('the check list', 'the checklist');
    expect(words.map((w) => w.text)).toEqual(['the', 'checklist']);
    expect(words.map((w) => w.changed)).toEqual([false, true]);
  });

  it('treats a first partial as all-new', () => {
    expect(diffTurnWords('', 'hello').map((w) => w.changed)).toEqual([false]);
  });
});

describe('formatElapsed', () => {
  it('is mm:ss, zero-padded', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(9_000)).toBe('00:09');
    expect(formatElapsed(65_000)).toBe('01:05');
    expect(formatElapsed(492_000)).toBe('08:12');
  });

  it('keeps counting past an hour rather than wrapping', () => {
    expect(formatElapsed(3_725_000)).toBe('62:05');
  });

  it('never shows a negative clock', () => {
    expect(formatElapsed(-5_000)).toBe('00:00');
  });
});

describe('parseMeetingServerMessage', () => {
  it('accepts the frames the contract defines', () => {
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'unavailable', reason: 'not_configured', message: 'no key' }),
      ),
    ).toEqual({ type: 'unavailable', reason: 'not_configured', message: 'no key' });
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'transcript', turn: 2, text: 'hi', final: false }),
      ),
    ).toEqual({ type: 'transcript', turn: 2, text: 'hi', final: false });
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'transcript', turn: 2, text: 'hi', final: false, speaker: 'A' }),
      ),
    ).toEqual({ type: 'transcript', turn: 2, text: 'hi', final: false, speaker: 'A' });
  });

  it('returns null for anything malformed rather than throwing', () => {
    expect(parseMeetingServerMessage('not json')).toBeNull();
    expect(parseMeetingServerMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseMeetingServerMessage(new ArrayBuffer(4))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

class FakeSocket implements MeetingSocket {
  sent: Array<string | ArrayBufferView> = [];
  closed = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed += 1;
  }
  serve(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

interface Harness {
  root: HTMLElement;
  strip: MeetingStripHandle;
  sockets: FakeSocket[];
  tick(): void;
  clock: { at: number };
  toggle(): HTMLButtonElement;
  status(): string;
  elapsed(): string;
  caption(): string;
  note(): string;
  /** The speaker tags on the caption, in turn order. */
  tags(): string[];
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

function mount(
  capture?: () => Promise<MeetingCaptureStart>,
  extra: { autoStart?: boolean; promptName?: (current: string) => string | null } = {},
): Harness {
  const root = document.createElement('div');
  document.body.append(root);
  const sockets: FakeSocket[] = [];
  const clock = { at: 1_000 };
  let ticker: (() => void) | null = null;
  const stop = vi.fn();
  const strip = mountMeetingStrip({
    docId: 'doc-1',
    root,
    now: () => clock.at,
    interval: (fn) => {
      ticker = fn;
      return () => {
        ticker = null;
      };
    },
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture: capture ?? (() => Promise.resolve({ ok: true, capture: { stop } })),
    ...extra,
  });
  cleanups.push(() => strip.destroy());
  const q = (sel: string) => root.querySelector(sel)?.textContent ?? '';
  return {
    root,
    strip,
    sockets,
    clock,
    tick: () => ticker?.(),
    toggle: () => root.querySelector('.meeting-toggle') as HTMLButtonElement,
    status: () => q('.meeting-status'),
    elapsed: () => q('.meeting-elapsed'),
    caption: () => q('.meeting-caption-line'),
    note: () => q('.meeting-note'),
    tags: () => [...root.querySelectorAll('.meeting-speaker')].map((el) => el.textContent ?? ''),
  };
}

/** Let the click's promise chain settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('the strip at rest', () => {
  it('shows a stopped meeting with a Start button and no transcript', () => {
    const h = mount();
    expect(h.root.dataset.state).toBe('idle');
    expect(h.root.hidden).toBe(false);
    expect(h.toggle().textContent).toBe('Start');
    expect(h.toggle().disabled).toBe(false);
    expect(h.status()).toBe('Paused');
    expect(h.elapsed()).toBe('00:00');
    expect(h.root.classList.contains('is-live')).toBe(false);
  });

  it("names the feature on its only control, since the visible label is just 'Start'", async () => {
    // The idle strip is a dot, a clock, and a bare word — nothing on screen
    // says "meeting" or "transcription". The accessible name has to.
    const h = mount();
    expect(h.toggle().getAttribute('aria-label')).toBe('Start meeting transcription');
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(h.toggle().getAttribute('aria-label')).toBe('Stop meeting transcription');
  });
});

describe('the strip while a meeting runs', () => {
  it('asks for the mic, opens the doc socket, and announces the format it will send', async () => {
    const h = mount();
    h.toggle().click();
    expect(h.root.dataset.state).toBe('requesting');
    expect(h.toggle().disabled).toBe(true);
    await settle();
    const sock = h.sockets[0];
    expect(sock).toBeDefined();
    sock?.onopen?.();
    expect(JSON.parse(String(sock?.sent[0]))).toEqual({
      type: 'start',
      sampleRate: MEETING_SAMPLE_RATE,
      encoding: MEETING_AUDIO_ENCODING,
    });
  });

  it('goes live on ready, pulses, and runs a clock off the injected time', async () => {
    const h = mount();
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(h.root.dataset.state).toBe('recording');
    expect(h.root.classList.contains('is-live')).toBe(true);
    expect(h.toggle().textContent).toBe('Stop');
    expect(h.status()).toBe('REC');
    h.clock.at = 1_000 + 65_000;
    h.tick();
    expect(h.elapsed()).toBe('01:05');
  });

  it('renders words as they arrive and rewrites a corrected word in place', async () => {
    const h = mount();
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 1,
      text: 'come back by thirsty',
      final: false,
    });
    expect(h.caption().trim()).toBe('come back by thirsty');
    const before = h.root.querySelectorAll('.meeting-caption-line .w');
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 1,
      text: 'come back by Thursday',
      final: true,
    });
    const after = h.root.querySelectorAll('.meeting-caption-line .w');
    expect(h.caption().trim()).toBe('come back by Thursday');
    // The same span is rewritten, so the correction animates on the word that
    // was already on screen rather than redrawing the line.
    expect(after[3]).toBe(before[3]);
    expect(after[3]?.classList.contains('is-fixed')).toBe(true);
    expect(after[0]?.classList.contains('is-fixed')).toBe(false);
  });

  it('never writes the transcript into the document body', async () => {
    const editor = document.createElement('div');
    editor.id = 'editor';
    document.body.append(editor);
    const h = mount();
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'into the strip only', final: true });
    expect(editor.textContent).toBe('');
  });

  it('stops on the second press: tells the server, releases the mic, closes the socket', async () => {
    const stop = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true, capture: { stop } }));
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.toggle().click();
    expect(JSON.parse(String(h.sockets[0]?.sent[1]))).toEqual({ type: 'stop' });
    expect(stop).toHaveBeenCalled();
    expect(h.sockets[0]?.closed).toBe(1);
    expect(h.root.dataset.state).toBe('idle');
  });
});

describe('the strip when no words are coming', () => {
  it('says so, and stops offering a button, when transcription is not configured', async () => {
    const stop = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true, capture: { stop } }));
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'unavailable',
      reason: 'not_configured',
      message: 'Transcription is not configured on this server.',
    });
    expect(h.root.dataset.state).toBe('unavailable');
    expect(h.note()).toBe('Transcription is not configured on this server.');
    // Nothing is retrying and no key is going to appear, so the control says so.
    expect(h.toggle().disabled).toBe(true);
    // …and the mic does not stay open behind a settled state.
    expect(stop).toHaveBeenCalled();
  });

  it('keeps the button live for a reason that could clear on its own', async () => {
    const h = mount();
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'unavailable',
      reason: 'already_recording',
      message: 'Another session is recording this doc.',
    });
    expect(h.toggle().disabled).toBe(false);
  });

  it('explains an insecure origin rather than leaving a dead button', async () => {
    const h = mount(() =>
      Promise.resolve({
        ok: false,
        kind: 'insecure',
        message: 'Voice needs https or localhost — open http://localhost:8787/review/d1',
      }),
    );
    h.toggle().click();
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    expect(h.note()).toContain('http://localhost:8787/review/d1');
    // No socket is opened: there is no meeting to start.
    expect(h.sockets.length).toBe(0);
    // Pressable, because the press is how someone gets the explanation again.
    expect(h.toggle().disabled).toBe(false);
  });

  it('explains a refused microphone', async () => {
    const h = mount(() =>
      Promise.resolve({
        ok: false,
        kind: 'denied',
        message: 'Microphone permission refused — allow the mic.',
      }),
    );
    h.toggle().click();
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    expect(h.note()).toContain('Microphone permission refused');
  });

  it('names a mid-meeting error and a socket that drops', async () => {
    const h = mount();
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'error', message: 'the engine hung up' });
    expect(h.root.dataset.state).toBe('error');
    expect(h.note()).toBe('the engine hung up');

    const h2 = mount();
    h2.toggle().click();
    await settle();
    h2.sockets[0]?.onopen?.();
    h2.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h2.sockets[0]?.onclose?.();
    expect(h2.root.dataset.state).toBe('error');
    expect(h2.note()).toMatch(/connection/i);
  });

  it('settles to idle when the server reports the meeting stopped', async () => {
    const h = mount();
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'stopped', meetingId: 'm1', endedAt: 2_000 });
    expect(h.root.dataset.state).toBe('idle');
    expect(h.root.classList.contains('is-live')).toBe(false);
  });
});

describe('the strip opened by the Board’s huddle button', () => {
  // The button's click is the person's gesture, and a full navigation does not
  // carry it into the editor — so the editor is TOLD, and starts at once.
  it('starts the meeting on mount without a press when asked to', async () => {
    const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: { stop: vi.fn() } }));
    const h = mount(capture, { autoStart: true });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(h.root.dataset.state).toBe('requesting');
    await settle();
    expect(h.sockets).toHaveLength(1);
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(h.root.dataset.state).toBe('recording');
    expect(h.toggle().textContent).toBe('Stop');
  });

  it('stays at rest when not asked — a plain doc never opens a mic on its own', () => {
    const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: { stop: vi.fn() } }));
    const h = mount(capture);
    expect(capture).not.toHaveBeenCalled();
    expect(h.root.dataset.state).toBe('idle');
  });

  it('offers ONE tap target when the browser wants a gesture, and that tap starts it', async () => {
    // Safari refuses getUserMedia with no user activation and names it the
    // same way it names a real denial. The strip cannot tell them apart, so
    // it asks for the tap rather than reporting a refusal nobody made.
    let refuse = true;
    const capture = vi.fn(() =>
      refuse
        ? Promise.resolve({
            ok: false as const,
            kind: 'denied' as const,
            message: 'Microphone permission refused — allow the mic.',
          })
        : Promise.resolve({ ok: true as const, capture: { stop: vi.fn() } }),
    );
    const h = mount(capture, { autoStart: true });
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    expect(h.toggle().textContent).toBe('Tap to start the mic');
    expect(h.toggle().disabled).toBe(false);
    expect(h.note()).toMatch(/tap/i);
    expect(h.note()).not.toMatch(/refused/i);
    // No sheet, no second control: the strip's own button is the target.
    expect(h.root.querySelectorAll('button')).toHaveLength(1);

    refuse = false;
    h.toggle().click();
    expect(capture).toHaveBeenCalledTimes(2);
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(h.root.dataset.state).toBe('recording');
    expect(h.toggle().textContent).toBe('Stop');
  });

  it('reports a refusal honestly once the tap itself is refused', async () => {
    const capture = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        kind: 'denied' as const,
        message: 'Microphone permission refused — allow the mic.',
      }),
    );
    const h = mount(capture, { autoStart: true });
    await settle();
    expect(h.toggle().textContent).toBe('Tap to start the mic'); // presence
    h.toggle().click();
    await settle();
    // A press IS a gesture, so a refusal now is a real one.
    expect(h.note()).toContain('Microphone permission refused');
    expect(h.toggle().textContent).toBe('Start');
  });

  it('does not offer a tap for an origin that gives no mic at all', async () => {
    const h = mount(
      () =>
        Promise.resolve({
          ok: false,
          kind: 'insecure',
          message: 'Voice needs https or localhost — open http://localhost:8787/review/d1',
        }),
      { autoStart: true },
    );
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    // A tap would not help; the explanation is the whole answer.
    expect(h.toggle().textContent).toBe('Start');
    expect(h.note()).toContain('http://localhost:8787/review/d1');
  });
});

describe('the strip across stop and start', () => {
  it('a second meeting starts clean: fresh clock, fresh socket, no words from the last one', async () => {
    const h = mount();
    h.toggle().click();
    await settle();
    const first = h.sockets[0];
    expect(first).toBeDefined();
    first?.onopen?.();
    first?.serve({ type: 'ready', meetingId: 'm-1', startedAt: 0, engine: 'mock' });
    first?.serve({ type: 'transcript', turn: 0, text: 'old words', final: true });
    h.clock.at += 65_000;
    h.tick();
    expect(h.elapsed()).toBe('01:05');
    expect(h.caption()).toContain('old words');

    // Stop: the strip settles to rest immediately — Paused, zeroed clock,
    // no pulse — and the socket is closed, not abandoned.
    h.toggle().click();
    expect(h.root.dataset.state).toBe('idle');
    expect(h.status()).toBe('Paused');
    expect(h.toggle().textContent).toBe('Start');
    expect(h.elapsed()).toBe('00:00');
    expect(h.root.classList.contains('is-live')).toBe(false);
    expect(first?.closed).toBe(1);

    // A long idle gap must not leak into the next meeting's clock.
    h.clock.at += 120_000;
    h.toggle().click();
    await settle();
    const second = h.sockets[1];
    expect(second).toBeDefined();
    second?.onopen?.();
    second?.serve({ type: 'ready', meetingId: 'm-2', startedAt: 0, engine: 'mock' });
    expect(h.root.dataset.state).toBe('recording');
    expect(h.status()).toBe('REC');
    // The clock counts THIS meeting only — not the first one, not the gap.
    expect(h.elapsed()).toBe('00:00');
    h.clock.at += 5_000;
    h.tick();
    expect(h.elapsed()).toBe('00:05');
    // And the first meeting's words are gone from the caption.
    expect(h.caption()).not.toContain('old words');
    second?.serve({ type: 'transcript', turn: 0, text: 'new words', final: false });
    expect(h.caption()).toContain('new words');
    // Nothing was sent on the dead socket; the new meeting announced itself
    // on its own.
    expect(JSON.parse(String(second?.sent[0]))).toMatchObject({ type: 'start' });
  });
});

describe('who is speaking', () => {
  const live = async (promptName?: (current: string) => string | null) => {
    const h = mount(undefined, promptName ? { promptName } : {});
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    return h;
  };

  it('tags each turn with its speaker, from the first word, and follows a relabel', async () => {
    const h = await live();
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 0,
      text: 'can you',
      final: false,
      speaker: 'A',
    });
    expect(h.tags()).toEqual(['Speaker A']);
    // The tag sits before the words, inside the turn, so it wraps with them.
    const turn = h.root.querySelector('.meeting-turn');
    expect(turn?.firstElementChild?.classList.contains('meeting-speaker')).toBe(true);
    expect(h.caption().replace(/\s+/g, ' ').trim()).toBe('Speaker A can you');
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'sure', final: false });
    // A turn the engine has not attributed yet has no tag — not "Speaker ?".
    expect(h.tags()).toEqual(['Speaker A']);
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    expect(h.tags()).toEqual(['Speaker A', 'Speaker B']);
    // The engine changed its mind about turn 1: the tag follows, in place.
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Sure.', final: true, speaker: 'A' });
    expect(h.tags()).toEqual(['Speaker A', 'Speaker A']);
  });

  it('a tap on a tag names that speaker everywhere, once, and tells the server', async () => {
    const asked: string[] = [];
    const h = await live((current) => {
      asked.push(current);
      return '  Jordan ';
    });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 0,
      text: 'Take it?',
      final: true,
      speaker: 'A',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 2,
      text: 'Thanks.',
      final: true,
      speaker: 'A',
    });
    const tag = h.root.querySelector('.meeting-speaker') as HTMLButtonElement;
    expect(tag.getAttribute('aria-label')).toBe('Name Speaker A');
    tag.click();
    expect(asked).toEqual(['Speaker A']);
    expect(h.tags()).toEqual(['Jordan', 'Speaker B', 'Jordan']);
    // A turn that arrives later with the same label reads as Jordan too —
    // and turn 0 has rolled off the three-turn window by then.
    h.sockets[0]?.serve({ type: 'transcript', turn: 3, text: 'Go.', final: false, speaker: 'A' });
    expect(h.tags()).toEqual(['Speaker B', 'Jordan', 'Jordan']);
    expect(h.tags().length).toBe(TRANSCRIPT_KEEP);
    const named = (h.sockets[0]?.sent ?? [])
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { type: string })
      .filter((m) => m.type === 'name_speaker');
    expect(named).toEqual([{ type: 'name_speaker', speaker: 'A', name: 'Jordan' }]);
    // The prompt offers the current name next time, so a rename starts from it.
    tag.click();
    expect(asked[1]).toBe('Jordan');
  });

  it('a cancelled or blank prompt changes nothing and sends nothing', async () => {
    let answer: string | null = null;
    const h = await live(() => answer);
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    const tag = h.root.querySelector('.meeting-speaker') as HTMLButtonElement;
    tag.click();
    answer = '   ';
    tag.click();
    expect(h.tags()).toEqual(['Speaker A']);
    const sent = (h.sockets[0]?.sent ?? []).filter((d) => typeof d === 'string');
    expect(sent.some((d) => String(d).includes('name_speaker'))).toBe(false);
  });

  it('names belong to one meeting: the next one starts with the labels bare', async () => {
    const h = await live(() => 'Jordan');
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    (h.root.querySelector('.meeting-speaker') as HTMLButtonElement).click();
    expect(h.tags()).toEqual(['Jordan']);
    h.toggle().click();
    h.toggle().click();
    await settle();
    h.sockets[1]?.onopen?.();
    h.sockets[1]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 1_000, engine: 'test' });
    h.sockets[1]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    expect(h.tags()).toEqual(['Speaker A']);
  });
});

describe('teardown', () => {
  it('releases the mic and the socket when the doc is navigated away from', async () => {
    const stop = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true, capture: { stop } }));
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.strip.destroy();
    expect(stop).toHaveBeenCalled();
    expect(h.sockets[0]?.closed).toBe(1);
    // The shell element is reusable by the next mount, and hidden until then.
    expect(h.root.hidden).toBe(true);
    expect(h.root.childElementCount).toBe(0);
  });

  it('does not leave a mic running when the mount is torn down mid-request', async () => {
    const stop = vi.fn();
    const prompt: { answer?: (v: MeetingCaptureStart) => void } = {};
    const h = mount(
      () =>
        new Promise<MeetingCaptureStart>((r) => {
          prompt.answer = r;
        }),
    );
    h.toggle().click();
    h.strip.destroy();
    prompt.answer?.({ ok: true, capture: { stop } });
    await settle();
    expect(stop).toHaveBeenCalled();
    expect(h.sockets.length).toBe(0);
  });
});

describe('the socket address', () => {
  it('is the doc audio path on this host', () => {
    expect(meetingSocketPath('doc-1')).toBe('/audio/doc-1');
  });
});
