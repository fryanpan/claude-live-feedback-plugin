import {
  type CaptureMode,
  MAX_SPEAKER_NAME,
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  type MeetingBotState,
  type MeetingBotStatus,
  RECORDING_CONSENT_NOTE,
  isTerminalBotState,
  meetingSocketPath,
  parseMeetingClientMessage,
} from '@feedback/core';
import type { MeetingTranscriptEvent } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomAudioProcessing } from '../src/meeting-audio.ts';
import type { MeetingCaptureStart } from '../src/meeting-audio.ts';
import type { MeetingBotClient } from '../src/meeting-bot-client.ts';
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
import type { DocSpeakers } from '../src/speaker-voices.ts';

/**
 * The meeting chrome is the only surface a meeting has, so every way a meeting
 * can fail has to arrive as words in it. These cover the rolling transcript
 * (where a correction has to land on the word already on screen), the clock,
 * each state the strip can be left sitting in, and the two popovers behind the
 * Record button — the start chooser where every choice is made, and the
 * speaker menu that holds the one verb a running meeting has.
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

  it('accepts a notes_progress frame, and drops non-numeric turn ids', () => {
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'notes_progress', tick: 1, phase: 'composing', turns: [0, 1] }),
      ),
    ).toEqual({ type: 'notes_progress', tick: 1, phase: 'composing', turns: [0, 1] });
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'notes_progress', tick: 2, phase: 'written', turns: [3, 'x'] }),
      ),
    ).toEqual({ type: 'notes_progress', tick: 2, phase: 'written', turns: [3] });
    expect(
      parseMeetingServerMessage(
        JSON.stringify({ type: 'notes_progress', tick: 1, phase: 'later', turns: [] }),
      ),
    ).toBeNull();
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

/** A minimal status the strip can render. */
const botStatus = (state: MeetingBotState, speakers: string[] = []): MeetingBotStatus => ({
  botId: 'b-1',
  docId: 'doc-1',
  state,
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  platform: 'google_meet',
  speakers,
  updatedAt: 1_000,
});

/** The bot lifecycle as the chrome sees it, driven entirely by the test. */
class FakeBot implements MeetingBotClient {
  ready = Promise.resolve();
  isConfigured = true;
  current: MeetingBotStatus | null = null;
  invites: Array<{ url: string; name?: string }> = [];
  leaves = 0;
  /** When set, the next invite rejects with this message. */
  refuse: string | null = null;
  private listeners = new Set<() => void>();
  private wordListeners = new Set<(frame: MeetingTranscriptEvent) => void>();
  destroy(): void {}
  configured(): boolean {
    return this.isConfigured;
  }
  onTranscript(cb: (frame: MeetingTranscriptEvent) => void): () => void {
    this.wordListeners.add(cb);
    return () => this.wordListeners.delete(cb);
  }
  /** One live turn arriving on the doc's stream, as the server sends it. */
  speak(frame: Omit<MeetingTranscriptEvent, 'event' | 'docId' | 'meetingId'>): void {
    const full: MeetingTranscriptEvent = {
      event: 'meeting.transcript',
      docId: 'doc-1',
      meetingId: 'bot-meeting-1',
      ...frame,
    };
    for (const cb of [...this.wordListeners]) cb(full);
  }
  status(): MeetingBotStatus | null {
    return this.current;
  }
  live(): MeetingBotStatus | null {
    return this.current && !isTerminalBotState(this.current.state) ? this.current : null;
  }
  invite(url: string, name?: string): Promise<void> {
    if (this.refuse) return Promise.reject(new Error(this.refuse));
    this.invites.push({ url, ...(name !== undefined ? { name } : {}) });
    return Promise.resolve();
  }
  leave(): Promise<void> {
    this.leaves += 1;
    return Promise.resolve();
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  set(state: MeetingBotState, speakers: string[] = []): void {
    this.current = botStatus(state, speakers);
    for (const cb of [...this.listeners]) cb();
  }
}

interface Harness {
  root: HTMLElement;
  strip: MeetingStripHandle;
  sockets: FakeSocket[];
  tick(): void;
  clock: { at: number };
  /** The Record Audio button in the top bar (root, in these mounts). */
  record(): HTMLButtonElement;
  /** The one popover panel — the chooser or the menu, whichever is built. */
  pop(): HTMLElement;
  scrim(): HTMLElement;
  startCta(): HTMLButtonElement;
  stopCta(): HTMLButtonElement;
  /** Pick a chooser radio card by its title ("Just me", "Soniox", …). */
  pick(title: string): void;
  /** The whole start gesture: open the chooser, adjust it, press Start. */
  pressStart(o?: { pick?: string }): void;
  /** The whole stop gesture: open the menu, press Stop Recording. */
  pressStop(): void;
  elapsed(): string;
  caption(): string;
  note(): string;
  /** The speaker tags on the caption, in turn order. */
  tags(): string[];
  /** The rename rows in whichever popover is open. */
  popNames(): string[];
  renameButtons(): HTMLButtonElement[];
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
    autoChoose?: boolean;
    promptName?: (current: string) => string | null;
    mode?: CaptureMode;
    speakers?: number;
    room?: RoomAudioProcessing;
    engine?: 'assemblyai' | 'soniox';
    listEngines?: () => Promise<{ engines: string[]; default: string | null } | null>;
    loadSpeakers?: () => Promise<DocSpeakers | null>;
    postName?: (meetingId: string, speaker: string, name: string) => Promise<boolean>;
    bot?: MeetingBotClient;
    botNamePrefill?: string;
    toolbar?: HTMLElement | null;
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
  const record = () => root.querySelector('.meeting-record') as HTMLButtonElement;
  const pop = () => root.querySelector('.meeting-pop') as HTMLElement;
  const pick = (title: string): void => {
    const card = [...pop().querySelectorAll('.meeting-choice')].find(
      (el) => el.querySelector('.meeting-choice-title')?.textContent === title,
    );
    const input = card?.querySelector('input');
    if (!input) throw new Error(`no chooser card titled "${title}"`);
    input.checked = true;
    input.dispatchEvent(new Event('change'));
  };
  const startCta = () => root.querySelector('.meeting-start-cta') as HTMLButtonElement;
  const stopCta = () => root.querySelector('.meeting-stop-cta') as HTMLButtonElement;
  return {
    root,
    strip,
    sockets,
    clock,
    tick: () => ticker?.(),
    record,
    pop,
    scrim: () => root.querySelector('.meeting-scrim') as HTMLElement,
    startCta,
    stopCta,
    pick,
    pressStart: (o = {}) => {
      record().click();
      if (o.pick) pick(o.pick);
      startCta().click();
    },
    pressStop: () => {
      record().click();
      stopCta().click();
    },
    elapsed: () => q('.meeting-elapsed'),
    caption: () => q('.meeting-caption-line'),
    note: () => q('.meeting-note'),
    tags: () => [...root.querySelectorAll('.meeting-speaker')].map((el) => el.textContent ?? ''),
    popNames: () =>
      [...pop().querySelectorAll('.meeting-pop-speaker-name')].map((el) => el.textContent ?? ''),
    renameButtons: () => [...pop().querySelectorAll<HTMLButtonElement>('.meeting-pop-rename')],
  };
}

/** A live capture, for the tests that only care that one exists. */
const fakeCapture = (stop: () => void = vi.fn()) => ({
  stop,
  setEchoCancellation: () => Promise.resolve(),
});

/** Let the click's promise chain settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('the chrome at rest', () => {
  it('is a Record Audio button and no strip — the row is only paid for live', () => {
    const h = mount();
    expect(h.root.dataset.state).toBe('idle');
    // The strip's grid track is `auto`, so hidden means the editor gets the
    // row back; an idle meeting surface has nothing to say.
    expect(h.root.hidden).toBe(true);
    expect(h.record().textContent).toContain('Record Audio');
    expect(h.record().getAttribute('aria-label')).toBe('Record audio');
    expect(h.record().getAttribute('aria-haspopup')).toBe('menu');
    expect(h.record().classList.contains('is-live')).toBe(false);
    // The glyph shows at rest; the solid red dot is the recording face.
    expect(h.record().querySelector<HTMLElement>('.meeting-record-glyph')?.hidden).toBe(false);
    expect(h.record().querySelector<HTMLElement>('.meeting-record-dot')?.hidden).toBe(true);
  });

  it('docks the button in the toolbar it was given, and takes it along on destroy', () => {
    const toolbar = document.createElement('div');
    document.body.append(toolbar);
    const h = mount(undefined, { toolbar });
    const btn = toolbar.querySelector('.meeting-record');
    expect(btn).not.toBeNull();
    expect(h.root.querySelector('.meeting-record')).toBeNull();
    h.strip.destroy();
    expect(toolbar.querySelector('.meeting-record')).toBeNull();
  });

  it('destroy takes the scrim and popover with it, not just the button', () => {
    // The scrim and both popovers dock beside the button in the TOOLBAR, not
    // in `root` (root is `hidden` while idle — see the chooser-was-
    // unreachable-while-idle fix). A destroy that only removed the button
    // left them behind: a SPA navigation to the next doc re-mounts a fresh
    // strip, but the ORPHANED scrim from the last one still sits over the
    // new Record button, and the orphaned popover's own Escape listener is
    // gone (it was removed from `document`, not from the element), so nothing
    // closes it.
    const toolbar = document.createElement('div');
    document.body.append(toolbar);
    const h = mount(undefined, { toolbar });
    toolbar.querySelector<HTMLButtonElement>('.meeting-record')?.click();
    expect(toolbar.querySelector<HTMLElement>('.meeting-pop')?.hidden).toBe(false);
    h.strip.destroy();
    expect(toolbar.querySelector('.meeting-record')).toBeNull();
    expect(toolbar.querySelector('.meeting-scrim')).toBeNull();
    expect(toolbar.querySelector('.meeting-pop')).toBeNull();
  });

  it('a press opens the start chooser; the scrim and Escape both close it', () => {
    const h = mount();
    expect(h.pop().hidden).toBe(true);
    h.record().click();
    expect(h.pop().hidden).toBe(false);
    expect(h.scrim().hidden).toBe(false);
    expect(h.record().classList.contains('is-open')).toBe(true);
    expect(h.record().getAttribute('aria-expanded')).toBe('true');
    expect(h.pop().querySelector('.meeting-sheet-title')?.textContent).toBe('Start recording');
    h.scrim().click();
    expect(h.pop().hidden).toBe(true);
    expect(h.record().getAttribute('aria-expanded')).toBe('false');
    h.record().click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.pop().hidden).toBe(true);
  });
});

describe('the start chooser decides who it is listening for', () => {
  const startFrame = (h: Harness) => JSON.parse(String(h.sockets[0]?.sent[0]));

  it('preselects Multiple Speakers — this product’s ordinary meeting has a room', async () => {
    const h = mount();
    h.record().click();
    const selected = h.pop().querySelector('.meeting-choice.is-selected .meeting-choice-title');
    expect(selected?.textContent).toBe('Use microphone');
    const speakerCards = [...h.pop().querySelectorAll('input[name="meeting-speakers"]')];
    expect(speakerCards.map((el) => (el as HTMLInputElement).checked)).toEqual([false, true]);
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    expect(startFrame(h).mode).toBe('conversation');
    expect(h.strip.mode()).toBe('conversation');
  });

  it('Just me is the deliberate cheaper pick, and the frame says so', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    expect(startFrame(h)).toEqual({
      type: 'start',
      sampleRate: MEETING_SAMPLE_RATE,
      encoding: MEETING_AUDIO_ENCODING,
      mode: 'solo',
    });
    expect(h.strip.mode()).toBe('solo');
  });

  it('an address that says solo presets the chooser the other way', async () => {
    // The Board's solo huddle carries its mode in on the address; the chooser
    // opens agreeing with it rather than arguing.
    const h = mount(undefined, { mode: 'solo' });
    h.record().click();
    const soloInput = [...h.pop().querySelectorAll('input[name="meeting-speakers"]')][0];
    expect((soloInput as HTMLInputElement).checked).toBe(true);
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    expect(startFrame(h).mode).toBe('solo');
  });

  it('adopts what the SERVER says it opened, not what was asked for', async () => {
    const h = mount();
    h.pressStart();
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
  });

  it('keeps the choice across a stop and start — the room did not change', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'solo',
    });
    h.pressStop();
    expect(h.root.dataset.state).toBe('idle');
    h.pressStart();
    await settle();
    h.sockets[1]?.onopen?.();
    expect(JSON.parse(String(h.sockets[1]?.sent[0])).mode).toBe('solo');
  });

  it('offers no knob mid-meeting, because the session cannot be moved', async () => {
    // A streaming session's configuration IS its connect URL, so a switch
    // mid-meeting would mean a second session and a second bill. The menu
    // holds the facts and Stop — no choice cards at all.
    const h = mount();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.record().click();
    expect(h.pop().querySelectorAll('.meeting-choice')).toHaveLength(0);
    expect(h.pop().querySelector('.meeting-start-cta')).toBeNull();
    expect(h.stopCta().textContent).toBe('■ Stop Recording');
  });
});

describe('the strip while a meeting runs', () => {
  it('asks for the mic, opens the doc socket, and announces the format it will send', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    expect(h.root.dataset.state).toBe('requesting');
    expect(h.root.hidden).toBe(false);
    expect(h.note()).toMatch(/asking for the microphone/i);
    await settle();
    const sock = h.sockets[0];
    expect(sock).toBeDefined();
    sock?.onopen?.();
    expect(JSON.parse(String(sock?.sent[0]))).toEqual({
      type: 'start',
      sampleRate: MEETING_SAMPLE_RATE,
      encoding: MEETING_AUDIO_ENCODING,
      mode: 'solo',
    });
  });

  it('goes live on ready: red dot and Recording on the button, a clock off the injected time', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(h.root.dataset.state).toBe('recording');
    expect(h.root.classList.contains('is-live')).toBe(true);
    expect(h.record().classList.contains('is-live')).toBe(true);
    expect(h.record().textContent).toContain('Recording');
    expect(h.record().querySelector<HTMLElement>('.meeting-record-dot')?.hidden).toBe(false);
    expect(h.record().querySelector<HTMLElement>('.meeting-record-glyph')?.hidden).toBe(true);
    h.clock.at = 1_000 + 65_000;
    h.tick();
    expect(h.elapsed()).toBe('01:05');
  });

  it('renders words as they arrive and rewrites a corrected word in place', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
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
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'into the strip only', final: true });
    expect(editor.textContent).toBe('');
  });

  it('Stop Recording in the menu tells the server, releases the mic, closes the socket', async () => {
    const stop = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true, capture: fakeCapture(stop) }));
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.pressStop();
    expect(JSON.parse(String(h.sockets[0]?.sent[1]))).toEqual({ type: 'stop' });
    expect(stop).toHaveBeenCalled();
    expect(h.sockets[0]?.closed).toBe(1);
    expect(h.root.dataset.state).toBe('idle');
    // Stop closed the menu too; nothing hangs over an idle surface.
    expect(h.pop().hidden).toBe(true);
  });
});

describe('the speaker menu states the facts settled at start', () => {
  it('headline: Recording · microphone · N speakers · clock, kept in step', async () => {
    const h = mount();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Hey.', final: true, speaker: 'B' });
    h.clock.at = 1_000 + 65_000;
    h.record().click();
    const headline = () => h.pop().querySelector('.meeting-pop-headline')?.textContent;
    expect(headline()).toBe('Recording · microphone · 2 speakers · 01:05');
    // A menu left open keeps pace with the clock it quotes.
    h.clock.at += 5_000;
    h.tick();
    expect(headline()).toBe('Recording · microphone · 2 speakers · 01:10');
  });

  it('a voice arriving while the menu is open lands as a row at once', async () => {
    const h = mount();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.record().click();
    expect(h.popNames()).toEqual([]);
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    expect(h.popNames()).toEqual(['Speaker A']);
  });

  it('a menu row renames the voice, everywhere, over the live socket', async () => {
    const h = mount(undefined, { promptName: () => 'Jordan' });
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    h.record().click();
    h.renameButtons()[0]?.click();
    // The row shows only the name once given — never "Speaker A (Jordan)".
    expect(h.popNames()).toEqual(['Jordan']);
    expect(h.tags()).toEqual(['Jordan']);
    const named = (h.sockets[0]?.sent ?? [])
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as { type: string })
      .filter((m) => m.type === 'name_speaker');
    expect(named).toEqual([{ type: 'name_speaker', speaker: 'A', name: 'Jordan' }]);
  });
});

describe('the strip when no words are coming', () => {
  it('says so when transcription is not configured, and the mic goes back', async () => {
    const stop = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true, capture: fakeCapture(stop) }));
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'unavailable',
      reason: 'not_configured',
      message: 'Transcription is not configured on this server.',
    });
    expect(h.root.dataset.state).toBe('unavailable');
    expect(h.root.hidden).toBe(false);
    expect(h.note()).toBe('Transcription is not configured on this server.');
    // …and the mic does not stay open behind a settled state.
    expect(stop).toHaveBeenCalled();
  });

  it('explains an insecure origin rather than failing silently', async () => {
    const h = mount(() =>
      Promise.resolve({
        ok: false,
        kind: 'insecure',
        message: 'Voice needs https or localhost — open http://localhost:8787/review/d1',
      }),
    );
    h.pressStart({ pick: 'Just me' });
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    expect(h.note()).toContain('http://localhost:8787/review/d1');
    // No socket is opened: there is no meeting to start.
    expect(h.sockets.length).toBe(0);
  });

  it('explains a refused microphone', async () => {
    const h = mount(() =>
      Promise.resolve({
        ok: false,
        kind: 'denied',
        message: 'Microphone permission refused — allow the mic.',
      }),
    );
    h.pressStart({ pick: 'Just me' });
    await settle();
    expect(h.root.dataset.state).toBe('blocked');
    expect(h.note()).toContain('Microphone permission refused');
  });

  it('names a mid-meeting error and a socket that drops', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({ type: 'error', message: 'the engine hung up' });
    expect(h.root.dataset.state).toBe('error');
    expect(h.note()).toBe('the engine hung up');

    const h2 = mount();
    h2.pressStart({ pick: 'Just me' });
    await settle();
    h2.sockets[0]?.onopen?.();
    h2.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h2.sockets[0]?.onclose?.();
    expect(h2.root.dataset.state).toBe('error');
    expect(h2.note()).toMatch(/connection/i);
  });

  it('settles to idle when the server reports the meeting stopped', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
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
    expect(h.record().textContent).toContain('Recording');
  });

  /**
   * The Board has two entry buttons and they are not the same gesture.
   * "Make a plan" is one person thinking out loud, so it opens the mic on
   * arrival — the press already happened, on a page that is gone. "Have a
   * discussion" has other people in it, and the sentence that tells them
   * they are being recorded is now a button somebody has to press, so it
   * arrives at the CHOICE instead.
   */
  describe('a discussion arrives at the chooser, not at the microphone', () => {
    it('opens the chooser and touches no microphone', () => {
      const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
      const h = mount(capture, { autoChoose: true, mode: 'conversation' });
      expect(capture).not.toHaveBeenCalled();
      expect(h.root.dataset.state).toBe('idle');
      expect(h.pop().hidden).toBe(false);
      expect(h.pop().getAttribute('aria-label')).toBe('Start recording');
      // One verb, and the same one whichever mode is selected: the room's
      // announcement and its decline button are gone.
      expect(h.startCta().textContent).toBe('● Start Recording');
      expect(h.pop().querySelectorAll('button')).toHaveLength(1);
    });

    it('preselects Multiple Speakers, so the choice made on the Board carries', () => {
      const h = mount(undefined, { autoChoose: true, mode: 'conversation' });
      const selected = [...h.pop().querySelectorAll('.meeting-choice')]
        .filter((el) => el.querySelector('input')?.checked === true)
        .map((el) => el.querySelector('.meeting-choice-title')?.textContent);
      expect(selected).toContain('Multiple Speakers');
    });

    it('an open microphone outranks it — a chooser over a live capture decides nothing', async () => {
      const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
      const h = mount(capture, { autoStart: true, autoChoose: true, mode: 'conversation' });
      expect(capture).toHaveBeenCalledTimes(1);
      await settle();
      expect(h.pop().hidden).toBe(true);
    });

    it('is not the plan entry — that one still opens the mic', () => {
      // Positive control for the assertion above it: the same mount with the
      // other flag really does reach the microphone, so "not called" is a
      // fact about the flag rather than about the fixture.
      const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
      mount(capture, { autoStart: true, mode: 'solo' });
      expect(capture).toHaveBeenCalledTimes(1);
    });
  });

  it('stays at rest when not asked — a plain doc never opens a mic on its own', () => {
    const capture = vi.fn(() => Promise.resolve({ ok: true as const, capture: fakeCapture() }));
    const h = mount(capture);
    expect(capture).not.toHaveBeenCalled();
    expect(h.root.dataset.state).toBe('idle');
  });

  it('offers ONE tap in the strip when the browser wants a gesture, and that tap starts it', async () => {
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
    const tap = h.root.querySelector('.meeting-note-start') as HTMLButtonElement;
    expect(tap?.tagName).toBe('BUTTON');
    expect(h.note()).toMatch(/tap/i);
    expect(h.note()).not.toMatch(/refused/i);

    refuse = false;
    tap.click();
    expect(capture).toHaveBeenCalledTimes(2);
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    expect(h.root.dataset.state).toBe('recording');
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
    const tap = h.root.querySelector('.meeting-note-start') as HTMLButtonElement;
    expect(tap).not.toBeNull(); // presence
    tap.click();
    await settle();
    // A press IS a gesture, so a refusal now is a real one.
    expect(h.note()).toContain('Microphone permission refused');
    expect(h.root.querySelector('.meeting-note-start')).toBeNull();
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
    expect(h.root.querySelector('.meeting-note-start')).toBeNull();
    expect(h.note()).toContain('http://localhost:8787/review/d1');
  });
});

describe('the strip across stop and start', () => {
  it('a second meeting starts clean: fresh clock, fresh socket, no words from the last one', async () => {
    const h = mount();
    h.pressStart({ pick: 'Just me' });
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

    // Stop: the chrome settles to rest — hidden strip, idle button, zeroed
    // clock — and the socket is closed, not abandoned.
    h.pressStop();
    expect(h.root.dataset.state).toBe('idle');
    expect(h.root.hidden).toBe(true);
    expect(h.record().textContent).toContain('Record Audio');
    expect(h.elapsed()).toBe('00:00');
    expect(h.root.classList.contains('is-live')).toBe(false);
    expect(first?.closed).toBe(1);

    // A long idle gap must not leak into the next meeting's clock.
    h.clock.at += 120_000;
    h.pressStart();
    await settle();
    const second = h.sockets[1];
    expect(second).toBeDefined();
    second?.onopen?.();
    second?.serve({ type: 'ready', meetingId: 'm-2', startedAt: 0, engine: 'mock' });
    expect(h.root.dataset.state).toBe('recording');
    // The clock counts THIS meeting only — not the first one, not the gap.
    expect(h.elapsed()).toBe('00:00');
    h.clock.at += 5_000;
    h.tick();
    expect(h.elapsed()).toBe('00:05');
    // And the first meeting's words are gone from the caption.
    expect(h.caption()).not.toContain('old words');
    second?.serve({ type: 'transcript', turn: 0, text: 'new words', final: false });
    expect(h.caption()).toContain('new words');
    // Nothing was sent on the dead socket; the new meeting opened its own.
    expect(JSON.parse(String(second?.sent[0]))).toMatchObject({ type: 'start' });
  });
});

describe('who is speaking', () => {
  const live = async (promptName?: (current: string) => string | null) => {
    const h = mount(undefined, promptName ? { promptName } : {});
    h.pressStart({ pick: 'Just me' });
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
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toMatch(/Engi…$/);
    expect(title.startsWith(clipped.slice(0, -1))).toBe(true);
    // A name that fits is returned untouched — no stray ellipsis on "Jordan".
    expect(clipSpeakerName('Jordan')).toBe('Jordan');
    expect(clipSpeakerName('x'.repeat(MAX_SPEAKER_NAME))).toBe('x'.repeat(MAX_SPEAKER_NAME));
    // One long word cannot break at a boundary, and must not clip to nothing.
    const oneWord = clipSpeakerName('x'.repeat(MAX_SPEAKER_NAME + 20));
    expect(oneWord.length).toBe(MAX_SPEAKER_NAME);
    expect(oneWord.endsWith('…')).toBe(true);
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
    h.pressStop();
    h.pressStart();
    await settle();
    h.sockets[1]?.onopen?.();
    h.sockets[1]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 1_000, engine: 'test' });
    h.sockets[1]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    expect(h.tags()).toEqual(['Speaker A']);
  });
});

describe('naming a voice after the meeting — the chooser keeps the cast', () => {
  /** A two-voice conversation, recorded and then stopped by the server. */
  const stopped = async (extra: Parameters<typeof mount>[1] = {}) => {
    const h = mount(undefined, extra);
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.sockets[0]?.serve({
      type: 'transcript',
      turn: 0,
      text: 'Take it?',
      final: true,
      speaker: 'A',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    h.sockets[0]?.serve({ type: 'stopped', meetingId: 'm1', endedAt: 2_000 });
    return h;
  };

  it('the chooser lists the last meeting’s voices, each with a Rename', async () => {
    const h = await stopped({ promptName: () => null });
    expect(h.root.dataset.state).toBe('idle');
    // The words are gone with the meeting — and so is the strip's row.
    expect(h.root.hidden).toBe(true);
    h.record().click();
    expect(h.pop().querySelector('.meeting-pop-cast')).not.toBeNull();
    expect(h.popNames()).toEqual(['Speaker A', 'Speaker B']);
    expect(h.renameButtons()).toHaveLength(2);
  });

  it('a rename after stop rides HTTP — the socket is gone', async () => {
    const postName = vi.fn(() => Promise.resolve(true));
    const h = await stopped({ promptName: () => 'Priya', postName });
    h.record().click();
    h.renameButtons()[1]?.click();
    await settle();
    expect(h.popNames()).toEqual(['Speaker A', 'Priya']);
    expect(postName).toHaveBeenCalledWith('m1', 'B', 'Priya');
    // Nothing rode the dead socket.
    const sent = (h.sockets[0]?.sent ?? []).filter((d) => typeof d === 'string');
    expect(sent.some((d) => String(d).includes('name_speaker'))).toBe(false);
  });

  it('a name the server refused does not stay on screen claiming it was saved', async () => {
    const postName = vi.fn(() => Promise.resolve(false));
    const h = await stopped({ promptName: () => 'Priya', postName });
    h.record().click();
    h.renameButtons()[1]?.click();
    await settle();
    expect(h.popNames()).toEqual(['Speaker A', 'Speaker B']);
  });

  it('a reloaded doc offers its last meeting’s cast, and renames it over HTTP', async () => {
    const postName = vi.fn(() => Promise.resolve(true));
    const h = mount(undefined, {
      promptName: () => 'Priya',
      postName,
      loadSpeakers: () =>
        Promise.resolve({
          meetingId: 'm-9',
          voices: [
            { label: 'A', name: 'Devi', lastSaid: 'Move the gate.' },
            { label: 'B', name: 'Speaker B', lastSaid: 'Sure.' },
          ],
        }),
    });
    await settle();
    h.record().click();
    // The names given live come back; the unnamed voice is still a label.
    expect(h.popNames()).toEqual(['Devi', 'Speaker B']);
    h.renameButtons()[1]?.click();
    await settle();
    expect(h.popNames()).toEqual(['Devi', 'Priya']);
    expect(postName).toHaveBeenCalledWith('m-9', 'B', 'Priya');
  });

  it('starting a new capture clears the old cast — labels are per meeting', async () => {
    const h = mount(undefined, {
      loadSpeakers: () =>
        Promise.resolve({
          meetingId: 'm-9',
          voices: [{ label: 'A', name: 'Devi', lastSaid: 'Hi.' }],
        }),
    });
    await settle();
    h.record().click();
    expect(h.popNames()).toEqual(['Devi']);
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm2', startedAt: 1_000, engine: 'test' });
    h.record().click();
    expect(h.popNames()).toEqual([]);
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    // The new meeting's A is a different person; the old name must not stick.
    expect(h.tags()).toEqual(['Speaker A']);
  });

  it('a doc with no meetings shows no cast block at all', async () => {
    const h = mount(undefined, { loadSpeakers: () => Promise.resolve(null) });
    await settle();
    h.record().click();
    expect(h.pop().querySelector('.meeting-pop-cast')).toBeNull();
  });
});

describe('teardown', () => {
  it('releases the mic, the socket and the Record button when the doc is left', async () => {
    const stop = vi.fn();
    const h = mount(() => Promise.resolve({ ok: true, capture: fakeCapture(stop) }));
    h.pressStart({ pick: 'Just me' });
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test' });
    h.strip.destroy();
    expect(stop).toHaveBeenCalled();
    expect(h.sockets[0]?.closed).toBe(1);
    // The shell element is reusable by the next mount, and hidden until then;
    // the button this mount docked goes with it.
    expect(h.root.hidden).toBe(true);
    expect(h.root.childElementCount).toBe(0);
    expect(document.querySelector('.meeting-record')).toBeNull();
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
    h.pressStart({ pick: 'Just me' });
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
  async function press(
    extra: Parameters<typeof mount>[1],
    pick?: string,
  ): Promise<{
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
    h.pressStart(pick ? { pick } : {});
    await settle();
    h.sockets[0]?.onopen?.();
    const sent = h.sockets[0]?.sent
      .filter((raw): raw is string => typeof raw === 'string')
      .map((raw) => JSON.parse(raw) as Record<string, unknown>);
    return { call: calls[0], start: sent?.find((m) => m.type === 'start') };
  }

  it('hands the capture the mode it is about to record in', async () => {
    expect((await press({ mode: 'conversation' })).call?.mode).toBe('conversation');
    expect((await press({}, 'Just me')).call?.mode).toBe('solo');
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

  it('records under the mode the chooser is showing, not the one it was mounted with', async () => {
    // The chooser can change it between meetings; the constraints belong to
    // the press, not to the mount.
    const got = await press({ mode: 'solo' }, 'Multiple Speakers');
    expect(got.call?.mode).toBe('conversation');
  });
});

describe('the engine seam', () => {
  const twoEngines = () =>
    Promise.resolve({ engines: ['assemblyai', 'soniox'], default: 'assemblyai' });

  it('renders an Engine group only when there is a real choice', async () => {
    // A row with a single answer is a fact wearing a control's clothes.
    const one = mount(undefined, {
      listEngines: () => Promise.resolve({ engines: ['assemblyai'], default: 'assemblyai' }),
    });
    await settle();
    one.record().click();
    expect(
      [...one.pop().querySelectorAll('.meeting-choice-group-label')].map((e) => e.textContent),
    ).not.toContain('Choose speech recognition engine:');
    one.strip.destroy();
    // An old server (no route) or a failed fetch answers null — same as one
    // engine, no choice.
    const old = mount(undefined, { listEngines: () => Promise.resolve(null) });
    await settle();
    old.record().click();
    expect(
      [...old.pop().querySelectorAll('.meeting-choice-group-label')].map((e) => e.textContent),
    ).not.toContain('Choose speech recognition engine:');
    old.strip.destroy();
    const h = mount(undefined, {
      listEngines: () =>
        Promise.resolve({
          engines: ['assemblyai', 'assemblyai-pro', 'soniox'],
          default: 'assemblyai',
        }),
    });
    await settle();
    h.record().click();
    const labels = [...h.pop().querySelectorAll('.meeting-choice-group-label')].map(
      (e) => e.textContent,
    );
    expect(labels).toContain('Choose speech recognition engine:');
    const titles = [...h.pop().querySelectorAll('.meeting-choice-title')].map((e) => e.textContent);
    expect(titles).toContain('AssemblyAI');
    expect(titles).toContain('AssemblyAI Pro');
    expect(titles).toContain('Soniox');
  });

  it('redraws an already-open chooser once a slow fetch answers', async () => {
    let resolveList:
      | ((v: { engines: string[]; default: string | null } | null) => void)
      | undefined;
    const h = mount(undefined, {
      listEngines: () =>
        new Promise((r) => {
          resolveList = r;
        }),
    });
    h.record().click();
    expect(
      [...h.pop().querySelectorAll('.meeting-choice-group-label')].map((e) => e.textContent),
    ).not.toContain('Choose speech recognition engine:');
    resolveList?.({ engines: ['assemblyai', 'soniox'], default: 'assemblyai' });
    await settle();
    expect(
      [...h.pop().querySelectorAll('.meeting-choice-group-label')].map((e) => e.textContent),
    ).toContain('Choose speech recognition engine:');
  });

  it('sends the picked engine on the start frame — and only when one was offered', async () => {
    const h = mount(undefined, { listEngines: twoEngines, mode: 'solo' });
    await settle();
    h.pressStart({ pick: 'Soniox' });
    await settle();
    h.sockets[0]?.onopen?.();
    expect(JSON.parse(String(h.sockets[0]?.sent[0])).engine).toBe('soniox');
    h.strip.destroy();
    // A server that has never heard of engines never receives the field.
    const plain = mount(undefined, { listEngines: () => Promise.resolve(null), mode: 'solo' });
    await settle();
    plain.pressStart();
    await settle();
    plain.sockets[0]?.onopen?.();
    expect(JSON.parse(String(plain.sockets[0]?.sent[0]))).not.toHaveProperty('engine');
  });

  it('carries the address’s engine on the start frame even with no chooser to show', async () => {
    // The address's own ask stands even unlisted — the server, not this
    // fetch, is the authority on what it refuses.
    const chosen = mount(undefined, {
      engine: 'soniox',
      listEngines: () => Promise.resolve(null),
      mode: 'solo',
    });
    await settle();
    chosen.pressStart();
    await settle();
    chosen.sockets[0]?.onopen?.();
    expect(JSON.parse(String(chosen.sockets[0]?.sent[0])).engine).toBe('soniox');
  });

  it('preselects the address’s pick once the chooser has a real choice', async () => {
    const h = mount(undefined, { engine: 'soniox', listEngines: twoEngines });
    await settle();
    h.record().click();
    const card = [...h.pop().querySelectorAll('.meeting-choice')].find(
      (el) => el.querySelector('.meeting-choice-title')?.textContent === 'Soniox',
    );
    expect(card?.querySelector('input')?.checked).toBe(true);
  });
});

describe('advanced options in the chrome', () => {
  const threeEngines = () =>
    Promise.resolve({
      engines: ['soniox', 'assemblyai', 'assemblyai-pro'],
      default: 'soniox',
    });

  /** Open the chooser, expand Advanced Options. */
  const openAdvanced = (h: Harness): void => {
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();
  };

  /** Type one term into a chips control and commit it with Enter. */
  const addTerm = (h: Harness, key: string, term: string): void => {
    const input = h
      .pop()
      .querySelector<HTMLInputElement>(
        `.meeting-adv-ctl[data-key="${key}"] .meeting-adv-chips input`,
      );
    if (!input) throw new Error(`no chips control for ${key}`);
    input.value = term;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };

  /** Drag one range control to a value and settle the drag. */
  const drag = (h: Harness, key: string, value: string): void => {
    const input = h
      .pop()
      .querySelector<HTMLInputElement>(`.meeting-adv-ctl[data-key="${key}"] input[type="range"]`);
    if (!input) throw new Error(`no range control for ${key}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  };

  it('tags the engine cards the way the mock reads', async () => {
    const h = mount(undefined, { listEngines: threeEngines });
    await settle();
    h.record().click();
    const card = (title: string) =>
      [...h.pop().querySelectorAll('.meeting-choice')].find(
        (el) => el.querySelector('.meeting-choice-title')?.textContent === title,
      );
    const tags = (title: string) =>
      [...(card(title)?.querySelectorAll('.meeting-engine-tag') ?? [])].map((el) => el.textContent);
    expect(tags('Soniox')).toEqual(['default', 'fastest']);
    expect(tags('AssemblyAI Pro')).toEqual(['highest quality']);
    expect(card('AssemblyAI Pro')?.querySelector('.meeting-engine-meta')?.textContent).toContain(
      '$0.45/hr',
    );
  });

  it('says beside the Soniox speaker toggle that its labels have no cap', async () => {
    const h = mount(undefined, { listEngines: threeEngines });
    await settle();
    h.record().click();
    expect(h.pop().querySelector('.meeting-engine-hint')?.textContent).toBe(
      "Soniox labels speakers but doesn't cap how many.",
    );
    // The hint is Soniox-and-conversation only: the cap it explains the
    // absence of belongs to diarization, which the other engines do cap.
    h.pick('AssemblyAI');
    expect(h.pop().querySelector('.meeting-engine-hint')).toBeNull();
  });

  it('starts with the moved knobs on the frame — and just the field when nothing moved', async () => {
    const h = mount(undefined, { listEngines: threeEngines, mode: 'solo' });
    await settle();
    openAdvanced(h);
    h.pick('AssemblyAI');
    drag(h, 'vad_threshold', '0.8');
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    expect(JSON.parse(String(h.sockets[0]?.sent[0])).tuning).toEqual({ vad_threshold: 0.8 });
    h.strip.destroy();
    // Untouched: the field still travels (it marks the client as owning the
    // speaker cap), but empty.
    const plain = mount(undefined, { listEngines: threeEngines, mode: 'solo' });
    await settle();
    plain.pressStart();
    await settle();
    plain.sockets[0]?.onopen?.();
    expect(JSON.parse(String(plain.sockets[0]?.sent[0])).tuning).toEqual({});
  });

  it('seeds the cap stepper from the address’s ?speakers, per engine panel', async () => {
    const h = mount(undefined, { listEngines: threeEngines, speakers: 3 });
    await settle();
    openAdvanced(h);
    h.pick('AssemblyAI');
    expect(
      h.pop().querySelector('.meeting-adv-ctl[data-key="max_speakers"] .meeting-adv-stepnum')
        ?.textContent,
    ).toBe('3');
  });

  it('keeps each engine’s tuned state across a flip away and back', async () => {
    const h = mount(undefined, { listEngines: threeEngines });
    await settle();
    openAdvanced(h);
    h.pick('AssemblyAI');
    drag(h, 'vad_threshold', '0.8');
    h.pick('Soniox');
    // Soniox's own panel is untouched — no dot borrowed from a sibling.
    expect(h.pop().querySelector('.meeting-adv-moddot')).toBeNull();
    h.pick('AssemblyAI');
    expect(h.pop().querySelector('.meeting-adv-moddot')).not.toBeNull();
  });

  it('tunes the live meeting from the menu and shows the server’s answer', async () => {
    const h = mount(undefined, { listEngines: threeEngines, mode: 'solo' });
    await settle();
    h.record().click();
    h.pick('AssemblyAI');
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'assemblyai' });
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();
    drag(h, 'vad_threshold', '0.8');
    const tune = h.sockets[0]?.sent
      .map((f) => JSON.parse(String(f)) as Record<string, unknown>)
      .find((m) => m.type === 'tune');
    expect(tune?.settings).toEqual({ vad_threshold: 0.8 });
    // The confirmation arrives; the control under the finger now says so.
    h.sockets[0]?.serve({ type: 'tuned', applied: ['vad_threshold'] });
    expect(
      h.pop().querySelector('.meeting-adv-ctl[data-key="vad_threshold"] .meeting-adv-note')
        ?.textContent,
    ).toBe('Applied.');

    // Reset mid-meeting reverts the LIVE session too, not just the panel —
    // a panel claiming defaults over an engine still running the tuned
    // values would be lying. The revert travels as the documented default.
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-reset')?.click();
    const tunes =
      h.sockets[0]?.sent
        .map((f) => JSON.parse(String(f)) as Record<string, unknown>)
        .filter((m) => m.type === 'tune') ?? [];
    expect(tunes.at(-1)?.settings).toEqual({ vad_threshold: 0.4 });
    // And the panel is open with defaults showing, not collapsed over them.
    expect(h.pop().querySelector('.meeting-adv-body')).not.toBeNull();
    expect(h.pop().querySelector('.meeting-adv-moddot')).toBeNull();
  });

  it('admits the one key a mid-meeting reset cannot revert on the live session', async () => {
    // `keyterms_prompt` IS live-tunable, so it earns no "next recording"
    // note — but an EMPTIED list has no wire form (the server reads `[]` as
    // "no change"). Reset therefore leaves the engine running the terms it
    // was given, and the control has to say so instead of showing an empty
    // box over a live list.
    const h = mount(undefined, { listEngines: threeEngines, mode: 'solo' });
    await settle();
    h.record().click();
    h.pick('AssemblyAI');
    h.startCta().click();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'assemblyai' });
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();

    addTerm(h, 'keyterms_prompt', 'Kubernetes');
    const sentTerms = h.sockets[0]?.sent
      .map((f) => JSON.parse(String(f)) as Record<string, unknown>)
      .find((m) => m.type === 'tune');
    expect(sentTerms?.settings).toEqual({ keyterms_prompt: ['Kubernetes'] });
    // The engine confirms it, which is what makes the divergence real.
    h.sockets[0]?.serve({ type: 'tuned', applied: ['keyterms_prompt'] });

    const framesBefore = h.sockets[0]?.sent.length ?? 0;
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-reset')?.click();
    // No frame goes out for the emptied list — one would apply nothing and
    // still earn an "Applied." the session has not earned.
    expect(h.sockets[0]?.sent.length).toBe(framesBefore);
    expect(
      h.pop().querySelector('.meeting-adv-ctl[data-key="keyterms_prompt"] .meeting-adv-note')
        ?.textContent,
    ).toBe('Cleared here — this recording keeps the terms it already has.');

    // Typing a term again settles the disagreement: the frame travels and
    // the admission goes away.
    addTerm(h, 'keyterms_prompt', 'Postgres');
    expect(h.sockets[0]?.sent.length).toBe(framesBefore + 1);
    expect(
      h
        .pop()
        .querySelector('.meeting-adv-ctl[data-key="keyterms_prompt"] .meeting-adv-note.is-stale'),
    ).toBeNull();
  });

  it('sends no tune frame for an engine that cannot take one', async () => {
    const h = mount(undefined, { listEngines: threeEngines, mode: 'solo' });
    await settle();
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'soniox' });
    h.record().click();
    h.pop().querySelector<HTMLButtonElement>('.meeting-adv-head')?.click();
    drag(h, 'endpoint_sensitivity', '0.5');
    const frames = h.sockets[0]?.sent.map((f) => JSON.parse(String(f)) as { type?: string }) ?? [];
    expect(frames.some((m) => m.type === 'tune')).toBe(false);
    // The panel already told the person where the change goes.
    expect(
      h.pop().querySelector('.meeting-adv-ctl[data-key="endpoint_sensitivity"] .meeting-adv-note')
        ?.textContent,
    ).toBe('Applies to the next recording.');
  });
});

describe('the meeting bot in the chrome', () => {
  it('offers the bot source only where the server can field one', () => {
    const off = new FakeBot();
    off.isConfigured = false;
    const h = mount(undefined, { bot: off });
    h.record().click();
    expect(h.pop().querySelector('.meeting-choice-bot')).toBeNull();
    h.strip.destroy();
    const on = mount(undefined, {
      bot: new FakeBot(),
      botNamePrefill: "Bryan's Claude Code Agent",
    });
    on.record().click();
    expect(on.pop().querySelector('.meeting-choice-bot')).not.toBeNull();
    const name = on.pop().querySelector('.meeting-bot-name') as HTMLInputElement;
    // The prefilled name is editable, not a placeholder that vanishes.
    expect(name.value).toBe("Bryan's Claude Code Agent");
  });

  it('Start with a link sends the bot, name and all, and closes the sheet', async () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot, botNamePrefill: "Bryan's Claude Code Agent" });
    h.record().click();
    h.pick('Join Zoom / Google Meet');
    const url = h.pop().querySelector('.meeting-bot-url') as HTMLInputElement;
    url.value = ' https://meet.google.com/abc-defg-hij ';
    url.dispatchEvent(new Event('input'));
    const name = h.pop().querySelector('.meeting-bot-name') as HTMLInputElement;
    name.value = "Priya's Notetaker";
    name.dispatchEvent(new Event('input'));
    h.startCta().click();
    await settle();
    expect(bot.invites).toEqual([
      { url: 'https://meet.google.com/abc-defg-hij', name: "Priya's Notetaker" },
    ]);
    expect(h.pop().hidden).toBe(true);
    // No microphone was opened: the bot is the capture.
    expect(h.sockets).toHaveLength(0);
  });

  it('a refused invite stays in the sheet with the reason', async () => {
    const bot = new FakeBot();
    bot.refuse = 'That is not a Zoom, Google Meet or Teams link.';
    const h = mount(undefined, { bot });
    h.record().click();
    h.pick('Join Zoom / Google Meet');
    h.startCta().click();
    await settle();
    expect(h.pop().hidden).toBe(false);
    expect(h.pop().querySelector('.meeting-pop-error')?.textContent).toBe(
      'That is not a Zoom, Google Meet or Teams link.',
    );
  });

  it('a live bot owns the strip: its state is the line, its progress the light', () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    expect(h.root.hidden).toBe(true);
    bot.set('waiting_room');
    expect(h.root.hidden).toBe(false);
    expect(h.note()).toBe('Waiting to be let in');
    // Not recording yet: the button must not claim it is.
    expect(h.record().textContent).toContain('Record Audio');
    bot.set('recording', ['Ann', 'Ben']);
    expect(h.root.classList.contains('is-live')).toBe(true);
    expect(h.record().textContent).toContain('Recording');
    expect(h.note()).toBe('Recording · Ann, Ben');
  });

  it('the menu behind a live bot lists who it hears, and sends it home', async () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    bot.set('recording', ['Ann', 'Ben']);
    h.record().click();
    expect(h.popNames()).toEqual(['Ann', 'Ben']);
    // A bot's speakers are display names from the call — nothing to rename.
    expect(h.renameButtons()).toHaveLength(0);
    expect(h.stopCta().textContent).toBe('■ Send the bot home');
    h.stopCta().click();
    await settle();
    expect(bot.leaves).toBe(1);
    expect(h.pop().hidden).toBe(true);
  });

  it('a terminal state is news only when the bot was seen alive here', () => {
    // Found already-terminal at load it is history, not news.
    const stale = new FakeBot();
    stale.current = botStatus('left');
    const h = mount(undefined, { bot: stale });
    expect(h.root.hidden).toBe(true);
    h.strip.destroy();

    const bot = new FakeBot();
    const h2 = mount(undefined, { bot });
    bot.set('recording', ['Ann']);
    bot.set('left');
    expect(h2.root.hidden).toBe(false);
    expect(h2.note()).toBe('The bot has left');
    // Dismissible: the farewell is a line, not a permanent fixture.
    (h2.root.querySelector('.meeting-note-dismiss') as HTMLButtonElement).click();
    expect(h2.root.hidden).toBe(true);
  });

  it("a live bot's words roll on the line as the microphone's do, under the platform's names", () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    bot.set('recording', ['Rowan Pike']);
    // Until the first word the line narrates the bot's state…
    expect(h.note()).toBe('Recording · Rowan Pike');
    // …and the first partial replaces that narration with the words.
    bot.speak({ turn: 0, text: 'so the', final: false, speaker: 'p7', speakerName: 'Rowan Pike' });
    expect(h.note()).toBe('');
    expect(h.caption()).toContain('so the');
    expect(h.tags()).toEqual(['Rowan Pike']);
    // A later partial for the SAME turn replaces it in place — the whole
    // correction mechanism, and the thing the microphone strip does.
    bot.speak({
      turn: 0,
      text: 'So the sync is the bottleneck.',
      final: true,
      speaker: 'p7',
      speakerName: 'Rowan Pike',
    });
    expect(h.root.querySelectorAll('.meeting-turn')).toHaveLength(1);
    expect(h.caption()).toContain('So the sync is the bottleneck.');
    expect(h.caption()).not.toContain('so the sync is');
    bot.speak({ turn: 1, text: 'Measure it.', final: true, speaker: 'p8', speakerName: 'Devi' });
    expect(h.tags()).toEqual(['Rowan Pike', 'Devi']);
    expect(h.root.querySelectorAll('.meeting-turn')).toHaveLength(2);
    // The recording face, same as the microphone's.
    expect(h.root.classList.contains('is-live')).toBe(true);
    // The tag is the same pill but not a rename button: a live bot meeting
    // cannot be renamed from the strip, and a tap that could only fail is
    // not offered.
    expect(h.root.querySelectorAll('button.meeting-speaker')).toHaveLength(0);
    expect(h.root.querySelectorAll('.meeting-speaker.is-fixed')).toHaveLength(2);
  });

  it('POSITIVE CONTROL: a microphone frame still renders through the same fold', async () => {
    // Same harness, same accessors — proves `caption()`/`tags()` see a turn
    // the socket path draws, so the bot assertions above are not vacuous.
    const h = mount(undefined, { bot: new FakeBot() });
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'conversation',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Hi.', final: true, speaker: 'A' });
    expect(h.caption()).toContain('Hi.');
    expect(h.tags()).toEqual(['Speaker A']);
    // And the microphone's tag IS the rename button.
    expect(h.root.querySelectorAll('button.meeting-speaker')).toHaveLength(1);
  });

  it("a bot's words are dropped while this strip's own microphone is the capture", async () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    h.pressStart();
    await settle();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.serve({
      type: 'ready',
      meetingId: 'm1',
      startedAt: 1_000,
      engine: 'test',
      mode: 'solo',
    });
    h.sockets[0]?.serve({ type: 'transcript', turn: 0, text: 'Mine.', final: true });
    bot.speak({ turn: 0, text: 'Not mine.', final: true, speaker: 'p7', speakerName: 'Rowan' });
    expect(h.caption()).toContain('Mine.');
    expect(h.caption()).not.toContain('Not mine.');
  });

  it('a bot leaving clears the window, and the next bot meeting starts from turn 0', () => {
    const bot = new FakeBot();
    const h = mount(undefined, { bot });
    bot.set('recording', ['Rowan Pike']);
    bot.speak({ turn: 0, text: 'First.', final: true, speaker: 'p7', speakerName: 'Rowan Pike' });
    bot.speak({ turn: 1, text: 'Second.', final: true, speaker: 'p7', speakerName: 'Rowan Pike' });
    bot.set('left');
    expect(h.note()).toBe('The bot has left');
    expect(h.root.querySelectorAll('.meeting-turn')).toHaveLength(0);
    // A new bot, a new meeting: its turn 0 must not read as "older than the
    // newest" and be dropped by the rolling window.
    bot.set('recording', ['Devi']);
    bot.speak({ turn: 0, text: 'Again.', final: true, speaker: 'p9', speakerName: 'Devi' });
    expect(h.caption()).toContain('Again.');
    expect(h.caption()).not.toContain('Second.');
    expect(h.tags()).toEqual(['Devi']);
  });
});

/**
 * What replaced the consent step.
 *
 * The step that stood here spoke a fixed sentence into the room's own
 * microphone, offered a second button that declined it, and wrote down which
 * path was taken. Bryan removed all of it on 2026-09-01 — "This is too much
 * fiddling. I'll manually handle consent for now." — and what is left is one
 * line at the head of the transcript.
 *
 * These are mostly NEGATIVE tests, so each one carries the positive control
 * that says the strip is still doing its job: a chooser that renders nothing
 * has no skip button either, and a transcript panel that never draws has no
 * announcement in it.
 */
describe('the consent step is gone', () => {
  it('offers ONE start verb, the same one, whichever room the chooser is set to', () => {
    const h = mount(undefined, { mode: 'conversation' });
    h.record().click();
    expect(h.startCta().textContent).toBe('● Start Recording');
    // The skip verb was the decline path. It is the button whose absence is
    // the removal, so it is asserted by class as well as by count.
    expect(h.pop().querySelector('.meeting-skip-cta')).toBeNull();
    expect(h.pop().querySelectorAll('button')).toHaveLength(1);
    // Flipping to the solo room used to change both the verb's words and the
    // button count. Now it changes neither.
    h.pick('Just me');
    expect(h.startCta().textContent).toBe('● Start Recording');
    expect(h.pop().querySelectorAll('button')).toHaveLength(1);
  });

  it('quotes no sentence for the room to hear', () => {
    const h = mount(undefined, { mode: 'conversation' });
    h.record().click();
    expect(h.pop().querySelector('.meeting-announce-quote')).toBeNull();
    expect(h.pop().textContent).not.toMatch(/being recorded and transcribed/i);
    // The positive control: the chooser IS built, so the two assertions above
    // are about missing chrome rather than a missing popover.
    expect(h.pop().textContent).toContain('Multiple Speakers');
  });

  it('says nothing on the wire about how the room was told', async () => {
    const h = mount(undefined, { mode: 'conversation' });
    h.pressStart();
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
    const frames = (sock?.sent ?? [])
      .filter((x): x is string => typeof x === 'string')
      .map((x) => JSON.parse(x) as { type: string });
    expect(frames.map((f) => f.type)).not.toContain('announced');
    // Positive control: the socket carried the frame it is supposed to.
    expect(frames.map((f) => f.type)).toContain('start');
    // And the handle no longer reports a consent path at all.
    expect('announced' in h.strip).toBe(false);
  });

  it('does not report the room as told even for a conversation that runs', async () => {
    // The strip used to hold this on `mode === conversation`, which is the
    // one setting that could resurrect it silently.
    const h = mount(undefined, { mode: 'conversation' });
    h.pressStart();
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
    expect(h.strip.mode()).toBe('conversation');
    expect(h.root.dataset.state).toBe('recording');
  });
});

describe('the transcript panel opens with the consent reminder', () => {
  /** A conversation capture taken all the way to `recording`. */
  const recording = async (mode: CaptureMode = 'conversation') => {
    const h = mount(undefined, { mode });
    h.pressStart();
    await settle();
    const sock = h.sockets[0];
    sock?.onopen?.();
    sock?.serve({ type: 'ready', meetingId: 'm1', startedAt: 1_000, engine: 'test', mode });
    await settle();
    return { h, sock };
  };

  it('shows the single line, and no more than it', async () => {
    const { h } = await recording();
    expect(h.note()).toBe(RECORDING_CONSENT_NOTE);
    expect(h.root.querySelectorAll('.meeting-note')).toHaveLength(1);
    // It is the fixed line, not a sentence composed here: the words are
    // asserted through the export, and their substance in core's own test.
    expect(h.note()).toMatch(/^By recording/);
  });

  it('is chrome, not a turn — it is not a caption anybody said', async () => {
    const { h } = await recording();
    // The class the stylesheet italicises it by. A note that lost it would
    // read as a transcript line, which is the one thing it must not be.
    expect(h.root.querySelector('.meeting-consent-note')).not.toBeNull();
    expect(h.root.querySelectorAll('.meeting-turn')).toHaveLength(0);
  });

  it('gives the line to the words the moment there are any', async () => {
    const { h, sock } = await recording();
    sock?.serve({
      type: 'transcript',
      turn: 0,
      text: 'So the sync is the bottleneck',
      final: false,
    });
    expect(h.caption()).toContain('So the sync is the bottleneck');
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
  });

  it('does not come back over a transcript that has already started', async () => {
    // A settled turn used to be what released the announcement's hold. The
    // reminder has no hold to release, and must not reappear between turns.
    const { h, sock } = await recording();
    sock?.serve({ type: 'transcript', turn: 0, text: 'First.', final: true });
    sock?.serve({ type: 'transcript', turn: 1, text: 'Second.', final: false });
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
    expect(h.caption()).toContain('Second.');
  });

  it('shows it for a solo capture too — the asking is the same person’s either way', async () => {
    const { h } = await recording('solo');
    expect(h.note()).toBe(RECORDING_CONSENT_NOTE);
  });

  it('is not on the strip before a recording starts', async () => {
    // The strip is hidden at rest, so a reminder there would be a line about
    // a recording that is not happening.
    const h = mount(undefined, { mode: 'conversation' });
    expect(h.root.hidden).toBe(true);
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
  });

  it('yields to the reason a meeting could not start', async () => {
    // `unavailable` writes its own note through the same line. The reminder
    // must not sit under a meeting that is not recording anything.
    const h = mount(undefined, { mode: 'conversation' });
    h.pressStart();
    await settle();
    const sock = h.sockets[0];
    sock?.onopen?.();
    sock?.serve({
      type: 'unavailable',
      reason: 'not_configured',
      message: 'Transcription is not configured on this server.',
    });
    expect(h.note()).toBe('Transcription is not configured on this server.');
    expect(h.root.querySelector('.meeting-consent-note')).toBeNull();
  });
});
