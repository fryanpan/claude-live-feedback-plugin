import {
  type AnnouncedBy,
  type CaptureMode,
  MAX_SPEAKER_NAME,
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  RECORDING_ANNOUNCEMENT,
  meetingSocketPath,
  parseMeetingClientMessage,
} from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Announcer, SpeechOutcome } from '../src/meeting-announce.ts';
import type { RoomAudioProcessing } from '../src/meeting-audio.ts';
import { captureConstraints } from '../src/meeting-audio.ts';
import type { MeetingCaptureStart } from '../src/meeting-audio.ts';
import {
  type MeetingSocket,
  type MeetingStripHandle,
  TRANSCRIPT_KEEP,
  clipSpeakerName,
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
  modeSwitch(): HTMLButtonElement;
  /** "I'll say it" — the hybrid's other Start. */
  announceButton(): HTMLButtonElement;
  status(): string;
  elapsed(): string;
  caption(): string;
  note(): string;
  /** The speaker tags on the caption, in turn order. */
  tags(): string[];
}

/** What the strip hands the capture: the frames sink plus the room's facts. */
type CaptureCall = {
  onFrame: (pcm: Int16Array) => void;
  mode: CaptureMode;
  room?: RoomAudioProcessing;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.replaceChildren();
});

function mount(
  capture?: (opts: CaptureCall) => Promise<MeetingCaptureStart>,
  extra: {
    autoStart?: boolean;
    promptName?: (current: string) => string | null;
    mode?: CaptureMode;
    speakers?: number;
    room?: RoomAudioProcessing;
    announcer?: Announcer;
  } = {},
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
    startCapture:
      capture ??
      (() =>
        Promise.resolve({
          ok: true,
          capture: { stop, setEchoCancellation: () => Promise.resolve() },
        })),
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
    modeSwitch: () => root.querySelector('.meeting-mode') as HTMLButtonElement,
    announceButton: () => root.querySelector('.meeting-announce') as HTMLButtonElement,
    status: () => q('.meeting-status'),
    elapsed: () => q('.meeting-elapsed'),
    caption: () => q('.meeting-caption-line'),
    note: () => q('.meeting-note'),
    tags: () => [...root.querySelectorAll('.meeting-speaker')].map((el) => el.textContent ?? ''),
  };
}

/** A live capture, for the tests that only care that one exists. */
const fakeCapture = (stop: () => void = vi.fn()) => ({
  stop,
  setEchoCancellation: () => Promise.resolve(),
});

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

describe('the strip decides who it is listening for before the mic opens', () => {
  const startFrame = (h: Harness) => JSON.parse(String(h.sockets[0]?.sent[0]));

  it('starts solo, and says so without saying it is off', () => {
    const h = mount();
    // The label is the same in both states — `aria-pressed` is what moves.
    // A button whose words flip between the state and the action cannot be
    // read either way.
    expect(h.modeSwitch().textContent).toBe('Multiple speakers');
    expect(h.modeSwitch().getAttribute('aria-label')).toBe('Detect multiple speakers');
    expect(h.modeSwitch().getAttribute('aria-pressed')).toBe('false');
    expect(h.strip.mode()).toBe('solo');
  });

  it('a press turns it on, and the next capture is opened as a conversation', async () => {
    const h = mount();
    h.modeSwitch().click();
    expect(h.modeSwitch().getAttribute('aria-pressed')).toBe('true');
    expect(h.strip.mode()).toBe('conversation');
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    expect(startFrame(h).mode).toBe('conversation');
  });

  it('the Board button arrives with it already on — that press was the choice', async () => {
    // "Record a conversation" is the only thing that says anyone else is in
    // the room, and it happens on a page that is gone by the time this
    // mounts.
    const h = mount(undefined, { mode: 'conversation' });
    expect(h.modeSwitch().getAttribute('aria-pressed')).toBe('true');
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    expect(startFrame(h).mode).toBe('conversation');
  });

  it('cannot be moved while the mic is open, because the session cannot be', async () => {
    const h = mount();
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'solo',
    });
    expect(h.root.dataset.state).toBe('recording');
    // A streaming session's configuration IS its connect URL, so a switch
    // mid-meeting would mean a second session and a second bill.
    expect(h.modeSwitch().disabled).toBe(true);
    h.modeSwitch().click();
    expect(h.strip.mode()).toBe('solo');
    expect(h.modeSwitch().title).toMatch(/stop and start/i);
  });

  it('adopts what the SERVER says it opened, not what was asked for', async () => {
    const h = mount(undefined, { mode: 'conversation' });
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    // A server that opened a solo session — an older build, or one that
    // refused the surcharge — is the one being billed, and the strip must
    // report the meeting that exists.
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'solo',
    });
    expect(h.strip.mode()).toBe('solo');
    expect(h.modeSwitch().getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the choice across a stop and start — the room did not change', async () => {
    const h = mount();
    h.modeSwitch().click();
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.toggle().click();
    expect(h.root.dataset.state).toBe('idle');
    expect(h.modeSwitch().disabled).toBe(false);
    h.toggle().click();
    await settle();
    h.sockets[1]?.onopen?.();
    expect(JSON.parse(String(h.sockets[1]?.sent[0])).mode).toBe('conversation');
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
      // Solo unless somebody said otherwise — the mode that pays for no
      // speaker labels.
      mode: 'solo',
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
    const h = mount(() => Promise.resolve({ ok: true, capture: fakeCapture(stop) }));
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
    const h = mount(() => Promise.resolve({ ok: true, capture: fakeCapture(stop) }));
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
    const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
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
    const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
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
        : Promise.resolve({ ok: true as const, capture: fakeCapture() }),
    );
    const h = mount(capture, { autoStart: true });
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    expect(h.toggle().textContent).toBe('Tap to start the mic');
    expect(h.toggle().disabled).toBe(false);
    expect(h.note()).toMatch(/tap/i);
    expect(h.note()).not.toMatch(/refused/i);
    // No sheet and no second way to start: the strip's own button is the
    // target. The mode switch beside it is not one — it starts nothing.
    expect(h.root.querySelectorAll('.meeting-toggle')).toHaveLength(1);
    // Visible buttons only: this capture is solo, so "I'll say it" is in the
    // DOM but hidden — there is nobody in the room to announce anything to,
    // and a hidden button is not a second way to start.
    expect(
      [...h.root.querySelectorAll('button')]
        .filter((b) => !(b as HTMLButtonElement).hidden)
        .map((b) => b.className),
    ).toEqual(['meeting-mode', 'meeting-toggle']);
    h.modeSwitch().click();
    expect(capture).toHaveBeenCalledTimes(1);

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

  it('clips a name to the limit the server enforces, so the two never diverge', async () => {
    const long = 'Jordan'.repeat(30);
    const h = await live(() => long);
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    (h.root.querySelector('.meeting-speaker') as HTMLButtonElement).click();
    const clipped = clipSpeakerName(long);
    // Past the limit the server drops the frame without answering, so an
    // unclipped name would sit on screen while the record and the notes
    // never heard it.
    expect(h.tags()).toEqual([clipped]);
    const named = (h.sockets[0]?.sent ?? [])
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { type: string; name?: string })
      .filter((m) => m.type === 'name_speaker');
    expect(named).toEqual([{ type: 'name_speaker', speaker: 'A', name: clipped }]);
    // The positive control on the clip: what it produces is what the server
    // accepts. A clip that still overshot would be no clip at all.
    expect(parseMeetingClientMessage(JSON.stringify(named[0]))).not.toBeNull();
  });

  it('a clipped name SAYS it was clipped, and breaks at a word', () => {
    const title = 'Jordan Ashworth, VP of Platform Engineering, EMEA and APAC regions';
    const clipped = clipSpeakerName(title);
    expect(clipped.length).toBeLessThanOrEqual(MAX_SPEAKER_NAME);
    // Cut mid-word and silent, this read as a typo rather than a truncation.
    expect(clipped.endsWith('\u2026')).toBe(true);
    expect(clipped).not.toMatch(/Engi\u2026$/);
    expect(title.startsWith(clipped.slice(0, -1))).toBe(true);
    // A name that fits is returned untouched — no stray ellipsis on "Jordan".
    expect(clipSpeakerName('Jordan')).toBe('Jordan');
    expect(clipSpeakerName('x'.repeat(MAX_SPEAKER_NAME))).toBe('x'.repeat(MAX_SPEAKER_NAME));
    // One long word cannot break at a boundary, and must not clip to nothing.
    const oneWord = clipSpeakerName('x'.repeat(MAX_SPEAKER_NAME + 20));
    expect(oneWord.length).toBe(MAX_SPEAKER_NAME);
    expect(oneWord.endsWith('\u2026')).toBe(true);
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
    const h = mount(() => Promise.resolve({ ok: true, capture: fakeCapture(stop) }));
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
    prompt.answer?.({ ok: true, capture: fakeCapture(stop) });
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

describe('what the strip tells the microphone and the server about the room', () => {
  /** Mount, press Start, and hand back what the capture and the socket saw. */
  async function press(extra: Parameters<typeof mount>[1]): Promise<{
    call: CaptureCall | undefined;
    start: Record<string, unknown> | undefined;
  }> {
    const calls: CaptureCall[] = [];
    const h = mount((opts) => {
      calls.push(opts);
      return Promise.resolve({
        ok: true,
        capture: { stop: vi.fn(), setEchoCancellation: () => Promise.resolve() },
      });
    }, extra);
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    const sent = h.sockets[0]?.sent
      .filter((raw): raw is string => typeof raw === 'string')
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);
    return { call: calls[0], start: sent?.find((m) => m.type === 'start') };
  }

  it('hands the capture the mode it is about to record in', async () => {
    expect((await press({ mode: 'conversation' })).call?.mode).toBe('conversation');
    expect((await press({})).call?.mode).toBe('solo');
  });

  it('passes the room processing through, and passes nothing when nobody set it', async () => {
    const room = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
    expect((await press({ mode: 'conversation', room })).call?.room).toEqual(room);
    // Absent rather than a copy of the default: the default belongs to
    // `captureConstraints`, and two places holding it is two places to change.
    expect((await press({ mode: 'conversation' })).call).not.toHaveProperty('room');
  });

  it('tells the server how many people are in the room, when it was told', async () => {
    expect((await press({ mode: 'conversation', speakers: 3 })).start?.speakers).toBe(3);
    expect((await press({ mode: 'conversation' })).start).not.toHaveProperty('speakers');
  });

  it('records under the mode the switch is showing, not the one it was mounted with', async () => {
    // The switch can be flipped between meetings; the constraints belong to
    // the press, not to the mount.
    const calls: CaptureCall[] = [];
    const h = mount((opts) => {
      calls.push(opts);
      return Promise.resolve({
        ok: true,
        capture: { stop: vi.fn(), setEchoCancellation: () => Promise.resolve() },
      });
    });
    h.modeSwitch().click();
    h.toggle().click();
    await settle();
    expect(calls[0]?.mode).toBe('conversation');
  });
});

// ---------------------------------------------------------------------------

/**
 * The recording announcement.
 *
 * The claim worth testing is an ORDERING one, and it is the opposite of the
 * intuitive order: the microphone opens first and the sentence is spoken into
 * it, so the announcement is part of the captured audio rather than a moment
 * before the recording that nothing can show afterwards. What no test here
 * can show is that a real room hears it, or that a real engine transcribes a
 * device speaking through its own microphone — see the note in
 * docs/architecture/meeting-assistant.md.
 */

/** An announcer whose speech ends only when the test says it does. */
class FakeAnnouncer implements Announcer {
  primes = 0;
  cancels = 0;
  said: string[] = [];
  /** Resolvers for each pending `speak`, in call order. */
  private pending: Array<(outcome: SpeechOutcome) => void> = [];
  constructor(
    private readonly can = true,
    private readonly log: string[] = [],
  ) {}
  supported(): boolean {
    return this.can;
  }
  /** As the real one: a gesture has been spent iff `prime()` was reached. */
  primed(): boolean {
    return this.primes > 0;
  }
  prime(): void {
    this.primes += 1;
    this.log.push('prime');
  }
  speak(text: string): Promise<SpeechOutcome> {
    this.said.push(text);
    this.log.push('speak');
    if (!this.can) return Promise.resolve('failed');
    return new Promise<SpeechOutcome>((resolve) => this.pending.push(resolve));
  }
  cancel(): void {
    this.cancels += 1;
  }
  /** The engine finishing (or failing) the sentence. */
  settle(outcome: SpeechOutcome): void {
    for (const resolve of this.pending.splice(0)) resolve(outcome);
  }
  /**
   * Only the OLDEST pending utterance answers. A cancelled sentence can stay
   * unsettled for its whole timeout while a second meeting starts and speaks,
   * and the tests that care about that need the two to land separately.
   */
  settleOldest(outcome: SpeechOutcome): void {
    this.pending.shift()?.(outcome);
  }
  get speaking(): boolean {
    return this.pending.length > 0;
  }
}

/** A capture that hands the test its own microphone. */
function pumpCapture(log: string[] = []) {
  let emit: ((pcm: Int16Array) => void) | null = null;
  const stop = vi.fn();
  /** Every echo-cancellation flip, in order — the announcement's hedge. */
  const aec: boolean[] = [];
  const setEchoCancellation = vi.fn((on: boolean) => {
    aec.push(on);
    log.push(`aec:${on ? 'on' : 'off'}`);
    return Promise.resolve();
  });
  const start = vi.fn((opts: { onFrame: (pcm: Int16Array) => void }) => {
    emit = opts.onFrame;
    log.push('mic-open');
    return Promise.resolve({ ok: true as const, capture: { stop, setEchoCancellation } });
  });
  return { start, stop, aec, setEchoCancellation, speakInto: (n = 1) => emit?.(new Int16Array(n)) };
}

/** Bring a conversation capture all the way to `recording`. */
async function recordingConversation(announcer: FakeAnnouncer, log: string[] = []) {
  const mic = pumpCapture(log);
  const h = mount(mic.start, { mode: 'conversation', announcer });
  h.toggle().click();
  await settle();
  const sock = h.sockets[0];
  sock?.onopen?.();
  log.push('start-frame');
  sock?.serve({
    type: 'ready',
    meetingId: 'm1',
    startedAt: 1_000,
    engine: 'test',
    mode: 'conversation',
  });
  // The announcement suspends echo cancellation before it speaks, which is a
  // promise; let that settle so callers see the sentence underway.
  await settle();
  return { h, mic, sock };
}

const startFrame = (sock: { sent: Array<string | ArrayBufferView> } | undefined) =>
  parseMeetingClientMessage(sock?.sent.find((x) => typeof x === 'string') ?? '');

/** Every JSON frame the strip put on the socket, in order. */
const textFrames = (sock: { sent: Array<string | ArrayBufferView> } | undefined) =>
  (sock?.sent ?? [])
    .filter((x): x is string => typeof x === 'string')
    .map((x) => JSON.parse(x) as { type: string; by?: AnnouncedBy });

describe('announcing a room capture', () => {
  it('speaks only AFTER the mic is open and the audio path is live', async () => {
    const log: string[] = [];
    const announcer = new FakeAnnouncer(true, log);
    await recordingConversation(announcer, log);
    // The whole point: the sentence is spoken into an already-open
    // microphone. Reverse these two and the announcement stops being part of
    // the recording, which is the only thing that makes it evidence.
    expect(log).toEqual(['prime', 'mic-open', 'start-frame', 'aec:off', 'speak']);
    expect(announcer.said).toEqual([RECORDING_ANNOUNCEMENT]);
  });

  it('carries audio to the socket THROUGHOUT the announcement', async () => {
    const announcer = new FakeAnnouncer();
    const { mic, sock } = await recordingConversation(announcer);
    // Mid-sentence — the device is still talking.
    expect(announcer.speaking).toBe(true);
    mic.speakInto(160);
    expect(sock?.sent.filter((x) => typeof x !== 'string')).toHaveLength(1);
    announcer.settle('spoke');
    await settle();
    // …and after it, with nothing torn down in between.
    mic.speakInto(160);
    expect(sock?.sent.filter((x) => typeof x !== 'string')).toHaveLength(2);
  });

  it('primes speech inside the click, before anything is awaited', async () => {
    // iOS Safari unlocks synthesis only from the gesture's own task, and the
    // announcement itself cannot be spoken there — it has to wait for the
    // mic. The tap is spent on the unlock instead.
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const h = mount(mic.start, { mode: 'conversation', announcer });
    h.toggle().click();
    expect(announcer.primes).toBe(1);
    expect(announcer.said).toEqual([]);
    await settle();
  });

  it('claims NOTHING while the device is still mid-sentence', async () => {
    // The claim is not on the start frame and is not made early: a meeting
    // stopped here leaves a record that says the room was never told, which
    // is exactly what happened.
    const announcer = new FakeAnnouncer();
    const { sock, h } = await recordingConversation(announcer);
    expect(startFrame(sock)).toMatchObject({ mode: 'conversation' });
    expect(startFrame(sock) && 'announced' in (startFrame(sock) as object)).toBe(false);
    expect(textFrames(sock).some((f) => f.type === 'announced')).toBe(false);
    expect(h.strip.announced()).toBeUndefined();
  });

  it('tells the server the room was told once the sentence FINISHED', async () => {
    const announcer = new FakeAnnouncer();
    const { sock, h } = await recordingConversation(announcer);
    announcer.settle('spoke');
    await settle();
    expect(textFrames(sock).at(-1)).toEqual({ type: 'announced', by: 'device' });
    expect(h.strip.announced()).toBe('device');
  });

  it('claims nothing when the meeting is stopped mid-sentence', async () => {
    const announcer = new FakeAnnouncer();
    const { sock, h } = await recordingConversation(announcer);
    h.toggle().click();
    announcer.settle('spoke');
    await settle();
    // Not even a late `device`: the room heard half a sentence at most.
    expect(textFrames(sock).some((f) => f.type === 'announced')).toBe(false);
    expect(h.strip.announced()).toBeUndefined();
  });

  it('shows the sentence on the strip while the device says it', async () => {
    const announcer = new FakeAnnouncer();
    const { h } = await recordingConversation(announcer);
    expect(h.note()).toContain(RECORDING_ANNOUNCEMENT);
  });

  it('gives the announcement back to the transcript once words arrive', async () => {
    const announcer = new FakeAnnouncer();
    const { h, sock } = await recordingConversation(announcer);
    sock?.serve({ type: 'transcript', turn: 0, text: 'so the sync is', final: false });
    expect(h.note()).toBe('');
    expect(h.caption()).toContain('so the sync is');
  });
});

describe('a solo capture announces nothing', () => {
  it('says no words and claims nothing on the wire', async () => {
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const h = mount(mic.start, { announcer });
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(announcer.said).toEqual([]);
    expect(announcer.primes).toBe(0);
    const frame = startFrame(h.sockets[0]);
    expect(frame).toMatchObject({ mode: 'solo' });
    expect(frame && 'announced' in frame).toBe(false);
    expect(h.strip.announced()).toBeUndefined();
  });

  it('hides "I\'ll say it" until there is a room to say it to', () => {
    const h = mount();
    expect(h.announceButton().hidden).toBe(true);
    h.modeSwitch().click();
    expect(h.announceButton().hidden).toBe(false);
  });

  it('hides it again once the meeting is running — the announcement has happened', async () => {
    const announcer = new FakeAnnouncer();
    const { h } = await recordingConversation(announcer);
    expect(h.announceButton().hidden).toBe(true);
  });
});

describe('"I\'ll say it" — the person takes the sentence', () => {
  it('starts the capture itself and keeps the device quiet', async () => {
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const h = mount(mic.start, { mode: 'conversation', announcer });
    h.announceButton().click();
    await settle();
    // It IS a Start: a person saying it needs the mic open exactly as much
    // as the device does, or their words are not in the recording either.
    expect(mic.start).toHaveBeenCalledTimes(1);
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    expect(h.root.dataset.state).toBe('recording');
    expect(announcer.said).toEqual([]);
    expect(announcer.primes).toBe(0);
  });

  it('puts the sentence on screen to read, and records that path', async () => {
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const h = mount(mic.start, { mode: 'conversation', announcer });
    h.announceButton().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    expect(h.note()).toContain(RECORDING_ANNOUNCEMENT);
    expect(h.note()).toMatch(/say this out loud/i);
    // `spoken` is claimed at once, because putting the sentence on screen is
    // the whole of what `spoken` claims — the strip cannot know whether
    // anybody read it aloud, and it never pretends to.
    expect(textFrames(h.sockets[0]).at(-1)).toEqual({ type: 'announced', by: 'spoken' });
    expect(h.strip.announced()).toBe('spoken');
  });
});

describe('a device that turns out not to be able to speak', () => {
  const failing = async (announcer: FakeAnnouncer, outcome: SpeechOutcome = 'failed') => {
    const got = await recordingConversation(announcer);
    announcer.settle(outcome);
    await settle();
    return got;
  };

  it('falls back to the person and CORRECTS the record', async () => {
    const announcer = new FakeAnnouncer();
    const { h, sock } = await failing(announcer);
    expect(h.note()).toMatch(/say this out loud/i);
    expect(h.note()).toContain(RECORDING_ANNOUNCEMENT);
    // The fallback is the point. A record saying the device announced it
    // when the device said nothing is worse than one that claims less.
    expect(textFrames(sock).at(-1)).toEqual({ type: 'announced', by: 'spoken' });
    expect(textFrames(sock).filter((f) => f.type === 'announced')).toHaveLength(1);
    expect(h.strip.announced()).toBe('spoken');
  });

  it('keeps recording — a mute announcement is not a failed meeting', async () => {
    const announcer = new FakeAnnouncer();
    const { h, mic, sock } = await failing(announcer);
    expect(h.root.dataset.state).toBe('recording');
    mic.speakInto(160);
    expect(sock?.sent.filter((x) => typeof x !== 'string')).toHaveLength(1);
  });

  it('a browser with no synthesis at all takes the same path', async () => {
    const announcer = new FakeAnnouncer(false);
    const { h } = await recordingConversation(announcer);
    await settle();
    expect(h.note()).toMatch(/say this out loud/i);
    expect(h.strip.announced()).toBe('spoken');
  });
});

// ---------------------------------------------------------------------------

/**
 * The Board's "Record a conversation", on an iPad.
 *
 * Reported by Bryan on a real iPad, 2026-08-30: the room heard nothing. The
 * button is on the BOARD and it navigates (`location.assign`), so the gesture
 * it carries dies with that page and the strip mounts on the doc with nothing
 * having touched it. iOS Safari does not refuse the sentence there — it
 * accepts the utterance into a queue no gesture has unlocked and never begins
 * it, so the old code waited out a twelve-second timeout and then put a line
 * on a strip nobody was looking at, and a room that was told nothing had a
 * record saying a person had been asked to speak.
 *
 * A navigation cannot carry a gesture, so none of this can be fixed on the
 * board's side. The fix is to ASK for the one tap, on the doc, where the
 * announcement is owed — and to ask within seconds rather than after twelve.
 */

/** The board's button, as the doc sees it: a mount that starts itself. */
async function autoStartedConversation(announcer: FakeAnnouncer, log: string[] = []) {
  const mic = pumpCapture(log);
  const h = mount(mic.start, { mode: 'conversation', announcer, autoStart: true });
  await settle();
  const sock = h.sockets[0];
  sock?.onopen?.();
  sock?.serve({
    type: 'ready',
    meetingId: 'm1',
    startedAt: 1_000,
    engine: 'test',
    mode: 'conversation',
  });
  await settle();
  return { h, mic, sock };
}

/** The announcement line, which is always a control. */
const noteButton = (h: Harness) => h.root.querySelector('.meeting-note') as HTMLButtonElement;

describe('an auto-started meeting whose device never begins the sentence', () => {
  /** Auto-start, and the queue turns out to be the locked one. */
  async function muted(log: string[] = []) {
    const announcer = new FakeAnnouncer(true, log);
    const got = await autoStartedConversation(announcer, log);
    announcer.settle('mute');
    await settle();
    return { ...got, announcer };
  }

  it('primed nothing on the way in — a navigation carries no gesture', async () => {
    const { announcer } = await muted();
    expect(announcer.primes).toBe(0);
    expect(announcer.said).toEqual([RECORDING_ANNOUNCEMENT]);
  });

  it('asks for one tap instead of silently downgrading to a line to read', async () => {
    const { h } = await muted();
    expect(h.note()).toMatch(/tap to announce/i);
    expect(h.note()).toContain(RECORDING_ANNOUNCEMENT);
    expect(noteButton(h).tagName).toBe('BUTTON');
  });

  it('spends that tap on the unlock and then says it, in that order', async () => {
    const log: string[] = [];
    const { h, announcer } = await muted(log);
    noteButton(h).click();
    await settle();
    expect(announcer.primes).toBe(1);
    expect(announcer.said).toEqual([RECORDING_ANNOUNCEMENT, RECORDING_ANNOUNCEMENT]);
    // The unlock is synchronous inside the click — that is the whole of what
    // iOS is waiting for — and the sentence follows the microphone's echo
    // cancellation exactly as the first attempt did.
    expect(log.slice(log.indexOf('prime'))).toEqual(['prime', 'aec:off', 'speak']);
  });

  it('claims `spoken` while the offer stands, and upgrades once it is heard', async () => {
    const { h, sock, announcer } = await muted();
    // The sentence IS on screen for a person, which is the whole of what
    // `spoken` claims — the same claim the old fallback made, so a room that
    // nobody taps for is recorded no worse than before.
    expect(h.strip.announced()).toBe('spoken');
    noteButton(h).click();
    await settle();
    announcer.settle('spoke');
    await settle();
    expect(h.strip.announced()).toBe('device');
    expect(textFrames(sock).at(-1)).toEqual({ type: 'announced', by: 'device' });
  });

  it('gives the line back to the transcript once the room has actually heard it', async () => {
    const { h, announcer } = await muted();
    noteButton(h).click();
    await settle();
    announcer.settle('spoke');
    await settle();
    expect(h.note()).toBe('');
  });

  it('falls back to the person when the tap does not get speech either', async () => {
    const { h, sock, announcer } = await muted();
    noteButton(h).click();
    await settle();
    announcer.settle('failed');
    await settle();
    expect(h.note()).toMatch(/say this out loud/i);
    expect(h.note()).toContain(RECORDING_ANNOUNCEMENT);
    expect(h.strip.announced()).toBe('spoken');
    // And says so once: the record already said `spoken`, and repeating a
    // claim on the wire is not a second announcement.
    expect(textFrames(sock).filter((f) => f.type === 'announced')).toHaveLength(1);
  });

  it('keeps recording throughout — a mute announcement is not a failed meeting', async () => {
    const { h, mic, sock } = await muted();
    expect(h.root.dataset.state).toBe('recording');
    mic.speakInto(160);
    expect(sock?.sent.filter((x) => typeof x !== 'string')).toHaveLength(1);
  });

  it('does NOT offer a tap when a gesture was already spent on the unlock', async () => {
    // Pressing Start primes inside the click. If the queue stayed silent
    // after that, a tap is not what is missing — and a button that cannot
    // work is worse than the line it replaces.
    const announcer = new FakeAnnouncer();
    const { h } = await recordingConversation(announcer);
    announcer.settle('mute');
    await settle();
    expect(h.note()).toMatch(/say this out loud/i);
    expect(h.note()).not.toMatch(/tap to announce/i);
  });

  it('a meeting stopped before the tap says nothing into the room it left', async () => {
    const { h, announcer } = await muted();
    const offer = noteButton(h);
    h.toggle().click();
    expect(h.root.dataset.state).toBe('idle');
    offer.click();
    await settle();
    // Not even the unlock: there is no meeting for it to be spent on.
    expect(announcer.primes).toBe(0);
    expect(announcer.said).toHaveLength(1);
  });
});

describe('a meeting stopped mid-announcement', () => {
  it('silences the device and does not rewrite the strip afterwards', async () => {
    const announcer = new FakeAnnouncer();
    const { h } = await recordingConversation(announcer);
    h.toggle().click();
    expect(announcer.cancels).toBeGreaterThanOrEqual(1);
    expect(h.root.dataset.state).toBe('idle');
    // The sentence resolving late belongs to a meeting that is over; it must
    // not put a "say this out loud" prompt on an idle strip.
    announcer.settle('failed');
    await settle();
    expect(h.root.dataset.state).toBe('idle');
    expect(h.note()).not.toMatch(/say this out loud/i);
  });
});

describe('the sentence a person has to READ stays on screen', () => {
  /** Bring up the "I'll say it" prompt on a live capture. */
  async function prompting() {
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const h = mount(mic.start, { mode: 'conversation', announcer });
    h.announceButton().click();
    await settle();
    const sock = h.sockets[0];
    sock?.onopen?.();
    sock?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    return { h, sock, announcer };
  }

  it('survives partials — an air conditioner must not wipe it mid-read', async () => {
    const { h, sock } = await prompting();
    expect(h.note()).toContain(RECORDING_ANNOUNCEMENT);
    sock?.serve({ type: 'transcript', turn: 0, text: 'mmm', final: false });
    sock?.serve({ type: 'transcript', turn: 0, text: 'mmm hh', final: false });
    expect(h.note()).toContain(RECORDING_ANNOUNCEMENT);
    expect(h.caption()).not.toContain('mmm hh');
  });

  it('gives the line back once a whole utterance has SETTLED', async () => {
    const { h, sock } = await prompting();
    sock?.serve({ type: 'transcript', turn: 0, text: 'partial', final: false });
    sock?.serve({
      type: 'transcript',
      turn: 0,
      text: 'Just so everyone knows, this conversation is being recorded.',
      final: true,
    });
    expect(h.note()).toBe('');
    // Nothing said while it held was lost — it draws as soon as the line
    // comes back.
    expect(h.caption()).toContain('this conversation is being recorded');
  });

  it('can be tapped away by someone who has already said it', async () => {
    const { h, sock } = await prompting();
    const note = h.root.querySelector('.meeting-note') as HTMLButtonElement;
    expect(note.tagName).toBe('BUTTON');
    note.click();
    expect(h.note()).toBe('');
    sock?.serve({ type: 'transcript', turn: 1, text: 'right, so', final: false });
    expect(h.caption()).toContain('right, so');
  });

  it('does NOT hold the line when the device is the one talking', async () => {
    // That caption is a courtesy for something the room is already hearing.
    const announcer = new FakeAnnouncer();
    const { h, sock } = await recordingConversation(announcer);
    expect(h.note()).toContain(RECORDING_ANNOUNCEMENT);
    sock?.serve({ type: 'transcript', turn: 0, text: 'so the sync', final: false });
    expect(h.note()).toBe('');
    expect(h.caption()).toContain('so the sync');
  });

  it('lets go when the meeting ends, whatever it was holding', async () => {
    const { h, sock } = await prompting();
    sock?.serve({ type: 'stopped', meetingId: 'm1', endedAt: 2_000 });
    expect(h.root.dataset.state).toBe('idle');
    expect(h.note()).toBe('');
  });
});

describe('the SERVER decides whether there is a room to announce to', () => {
  /** Start a capture in `asked`, and have the server answer `opened`. */
  async function negotiated(asked: CaptureMode, opened: CaptureMode) {
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const h = mount(mic.start, { mode: asked, announcer });
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: opened,
    });
    return { h, announcer };
  }

  it('says nothing when the server opened a SOLO session we asked to be a room', async () => {
    // An old server answering `solo`: the strip has just relabelled this
    // capture solo, and a solo capture announces nothing.
    const { h, announcer } = await negotiated('conversation', 'solo');
    expect(h.strip.mode()).toBe('solo');
    expect(announcer.said).toEqual([]);
    expect(h.note()).not.toContain(RECORDING_ANNOUNCEMENT);
    expect(h.strip.announced()).toBeUndefined();
  });

  it('announces when the server opened a ROOM we asked to be solo', async () => {
    // The inverse mismatch, and the one that matters: a room is owed an
    // announcement whatever the client asked for.
    const { h, announcer } = await negotiated('solo', 'conversation');
    await settle();
    expect(h.strip.mode()).toBe('conversation');
    expect(announcer.said).toEqual([RECORDING_ANNOUNCEMENT]);
    expect(h.note()).toContain(RECORDING_ANNOUNCEMENT);
  });
});

describe('nothing keeps announcing a meeting that ended', () => {
  /** Every way a meeting can end that is not the Stop button. */
  const endings: Array<[string, (sock: FakeSocket) => void]> = [
    ['the relay reports an error', (s) => s.serve({ type: 'error', message: 'engine died' })],
    ['the server stops it', (s) => s.serve({ type: 'stopped', meetingId: 'm1', endedAt: 2_000 })],
    [
      'the engine turns out to be unavailable',
      (s) => s.serve({ type: 'unavailable', reason: 'engine_unavailable', message: 'no' }),
    ],
    ['the socket drops', (s) => s.onclose?.()],
  ];

  for (const [name, end] of endings) {
    it(`silences the device when ${name}`, async () => {
      const announcer = new FakeAnnouncer();
      const { h, sock } = await recordingConversation(announcer);
      expect(announcer.speaking).toBe(true);
      if (sock) end(sock);
      // The device must not carry on telling a room it is being recorded
      // into a room where it is not.
      expect(announcer.cancels).toBeGreaterThanOrEqual(1);
      // And the sentence resolving afterwards writes nothing: no claim on a
      // meeting that failed, and no prompt on a strip that has moved on.
      const before = h.root.dataset.state;
      announcer.settle('spoke');
      await settle();
      expect(h.root.dataset.state).toBe(before);
      expect(h.strip.announced()).toBeUndefined();
      expect(h.note()).not.toMatch(/say this out loud/i);
    });
  }
});

describe('the device speaking is not cancelled out of its own recording', () => {
  it('suspends echo cancellation across the sentence and restores it after', async () => {
    // Echo cancellation is asked for on every capture and its whole job is
    // to remove what this device plays from what its microphone hears —
    // which is the one moment that has to work the other way round.
    const log: string[] = [];
    const announcer = new FakeAnnouncer(true, log);
    const mic = pumpCapture(log);
    const h = mount(mic.start, { mode: 'conversation', announcer });
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    await settle();
    expect(mic.aec).toEqual([false]);
    announcer.settle('spoke');
    await settle();
    // Restored: a whole meeting captured without echo cancellation would
    // transcribe its own speaker output for the rest of the hour.
    expect(mic.aec).toEqual([false, true]);
    expect(log.indexOf('aec:off')).toBeLessThan(log.indexOf('speak'));
    expect(log.indexOf('speak')).toBeLessThan(log.indexOf('aec:on'));
  });

  it('leaves it alone when a person is the one talking', async () => {
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const h = mount(mic.start, { mode: 'conversation', announcer });
    h.announceButton().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    await settle();
    // Their voice reaches the mic the way every other voice in the room
    // does; the canceller was never in the way of it.
    expect(mic.aec).toEqual([]);
  });

  it("a cancelled sentence never un-suspends the NEXT meeting's microphone", async () => {
    // The hazard: cancelling speech does not settle its promise, so the
    // restore half of a dead announcement can run minutes later — by which
    // time the strip holds a different microphone, mid-announcement. Undoing
    // the suspension there is precisely the bug the suspension exists to
    // prevent, and it would be silent.
    const announcer = new FakeAnnouncer();
    const mics: Array<{ aec: boolean[] }> = [];
    const startCapture = () => {
      const aec: boolean[] = [];
      mics.push({ aec });
      return Promise.resolve({
        ok: true as const,
        capture: {
          stop: vi.fn(),
          setEchoCancellation: (on: boolean) => {
            aec.push(on);
            return Promise.resolve();
          },
        },
      });
    };
    const h = mount(startCapture, { mode: 'conversation', announcer });
    const ready = async (i: number) => {
      h.sockets[i]?.onopen?.();
      h.sockets[i]?.serve({
        type: 'ready',
        meetingId: `m${i}`,
        startedAt: 1_000,
        engine: 'test',
        mode: 'conversation',
      });
      await settle();
    };

    h.toggle().click();
    await settle();
    await ready(0);
    // Stopped mid-sentence: the utterance is abandoned, not answered.
    h.toggle().click();
    await settle();
    h.toggle().click();
    await settle();
    await ready(1);
    expect(mics).toHaveLength(2);
    expect(mics[1]?.aec).toEqual([false]);

    // Now the abandoned utterance finally comes back.
    announcer.settleOldest('spoke');
    await settle();
    expect(mics[0]?.aec).toEqual([false, true]);
    // The live meeting is still speaking, so its canceller is still down.
    // Bound to the closure instead of the instance, this reads [false, true].
    expect(mics[1]?.aec).toEqual([false]);
  });

  it('restores echo cancellation to what the ROOM asked for, not to on', async () => {
    // `?mic=ec0-…` turns echo cancellation off for a room, and the
    // announcement is made on exactly the mode that knob applies to. Restoring
    // a hardcoded `true` afterwards would switch it back on mid-meeting, for
    // the rest of the meeting, with nothing saying so — and the knob is what
    // the microphone measurement varies.
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const h = mount(mic.start, {
      mode: 'conversation',
      announcer,
      room: { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    });
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    await settle();
    announcer.settleOldest('spoke');
    await settle();
    // Down for the sentence, and back to OFF — where the room put it.
    expect(mic.aec).toEqual([false, false]);
  });

  it('ignores a room config that the mode it is recording in would not apply', async () => {
    // A stale `?mic=ec0-…` on the address while the switch is on solo. The
    // capture opens with the SOLO processing, so the restore must too — the
    // announcement is unreachable in solo today, and this pins the rule to
    // the constraints the microphone was opened with rather than to that.
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const room = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const h = mount(mic.start, { mode: 'conversation', announcer, room });
    h.toggle().click();
    await settle();
    // Flip to solo and back is not available mid-meeting; instead assert the
    // room path, then that `captureConstraints` is what decides it.
    expect((captureConstraints('solo', room).audio as MediaTrackConstraints).echoCancellation).toBe(
      true,
    );
    expect(
      (captureConstraints('conversation', room).audio as MediaTrackConstraints).echoCancellation,
    ).toBe(false);
  });

  it('restores it to ON for a room that never asked for anything else', async () => {
    // The positive control: the fix must not simply stop restoring. The
    // default room wants cancellation, and gets it back.
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    const h = mount(mic.start, { mode: 'conversation', announcer });
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    await settle();
    announcer.settleOldest('spoke');
    await settle();
    expect(mic.aec).toEqual([false, true]);
  });

  it('a meeting that ends while the constraint is in flight is never announced', async () => {
    // `cancel()` reaches an utterance that has started. It cannot reach one
    // that has not — and suspending the canceller is a promise, so there is a
    // window where a stop lands before `speak()` is even called. Speaking
    // there tells a room it is being recorded when it is not.
    const announcer = new FakeAnnouncer();
    const held: Array<() => void> = [];
    const mic = pumpCapture();
    mic.setEchoCancellation.mockImplementation(() => new Promise<void>((r) => void held.push(r)));
    const h = mount(mic.start, { mode: 'conversation', announcer });
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    await settle();
    // Suspension still pending, so nothing has been spoken yet.
    expect(announcer.said).toEqual([]);
    h.toggle().click();
    await settle();
    for (const r of held.splice(0)) r();
    await settle();
    // The room is not told about a meeting that is over.
    expect(announcer.said).toEqual([]);
    expect(h.strip.announced()).toBeUndefined();
  });

  it('announces anyway when the browser REFUSES the constraint', async () => {
    // The hedge is best-effort, and its failure must not take the sentence
    // down with it — the one thing that must never happen here is silence.
    const announcer = new FakeAnnouncer();
    const mic = pumpCapture();
    mic.setEchoCancellation.mockImplementation(() => Promise.reject(new Error('nope')));
    const h = mount(mic.start, { mode: 'conversation', announcer });
    h.toggle().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    await settle();
    expect(mic.setEchoCancellation).toHaveBeenCalled();
    expect(announcer.said).toEqual([RECORDING_ANNOUNCEMENT]);
    // …and the record still follows the sentence, not the hedge.
    announcer.settle('spoke');
    await settle();
    expect(h.strip.announced()).toBe('device');
  });
});
