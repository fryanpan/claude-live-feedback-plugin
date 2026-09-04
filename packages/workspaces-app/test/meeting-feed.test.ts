import { RECORDING_CONSENT_NOTE } from '@feedback/core';
import type { CaptureMode, MeetingBotStatus } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import { type MeetingFeed, createMeetingFeed } from '../src/meeting-feed.ts';
import type { MeetingLiveZone } from '../src/meeting-live-zone.ts';
import type { TranscriptTurn } from '../src/meeting-protocol.ts';
import type { StripState } from '../src/meeting-strip.ts';

/**
 * The transcript feed drives one line, and every state a meeting can be left
 * in has to arrive in it as either words or a sentence. These drive
 * `createMeetingFeed` directly — no socket, no strip — because the module's
 * whole contract is "given this state and these turns, what is on the line".
 */

/** A feed wired to mutable holders, so a test moves the state the way the
 *  strip's `let`s move under a rendered line. */
function makeFeed(over: Partial<Harness> = {}): Harness {
  const line = document.createElement('div');
  const h: Harness = {
    line,
    state: { kind: 'idle' } as StripState,
    turns: [] as TranscriptTurn[],
    mode: 'conversation' as CaptureMode,
    names: {} as Record<string, string>,
    liveBot: null as MeetingBotStatus | null,
    farewell: null as string | null,
    named: [] as string[],
    dismissed: 0,
    liveZone: undefined as MeetingLiveZone | undefined,
    feed: undefined as unknown as MeetingFeed,
    ...over,
  };
  h.feed = createMeetingFeed({
    line: h.line,
    ...(h.liveZone ? { liveZone: h.liveZone } : {}),
    state: () => h.state,
    turns: () => h.turns,
    mode: () => h.mode,
    names: () => h.names,
    liveBot: () => h.liveBot,
    botFarewell: () => h.farewell,
    nameSpeaker: (label) => h.named.push(label),
    dismissBotNote: () => {
      h.dismissed += 1;
    },
  });
  return h;
}

interface Harness {
  line: HTMLElement;
  state: StripState;
  turns: TranscriptTurn[];
  mode: CaptureMode;
  names: Record<string, string>;
  liveBot: MeetingBotStatus | null;
  farewell: string | null;
  named: string[];
  dismissed: number;
  liveZone: MeetingLiveZone | undefined;
  feed: MeetingFeed;
}

const words = (line: HTMLElement) =>
  [...line.querySelectorAll('.w')].map((el) => el.textContent?.trim() ?? '');

const pills = (line: HTMLElement) =>
  [...line.querySelectorAll('.meeting-speaker-pill')].map((el) => el.textContent ?? '');

const botStatus = (over: Partial<MeetingBotStatus> = {}): MeetingBotStatus => ({
  botId: 'bot-1',
  docId: 'doc-1',
  state: 'recording',
  meetingUrl: 'https://meet.example.test/abc',
  platform: null,
  speakers: [],
  updatedAt: 0,
  ...over,
});

describe('createMeetingFeed — words on the line', () => {
  it('renders one word span per word, with the speaker tag ahead of them', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'meet on Thursday', final: false, speaker: 'A' }];
    h.feed.renderFeed();
    expect(words(h.line)).toEqual(['meet', 'on', 'Thursday']);
    expect(pills(h.line)).toEqual(['Speaker A']);
  });

  it('rewrites only the corrected word, and flashes that one', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'meet on thirsty', final: false }];
    h.feed.renderFeed();
    const before = [...h.line.querySelectorAll('.w')];
    h.turns = [{ turn: 1, text: 'meet on Thursday', final: true }];
    h.feed.renderFeed();
    const after = [...h.line.querySelectorAll('.w')];
    // The same elements: a correction lands on the words already on screen.
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(words(h.line)).toEqual(['meet', 'on', 'Thursday']);
    expect(after.map((el) => el.classList.contains('is-fixed'))).toEqual([false, false, true]);
  });

  it('drops the span of a turn that has rolled out of the window', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [
      { turn: 1, text: 'one', final: true },
      { turn: 2, text: 'two', final: false },
    ];
    h.feed.renderFeed();
    expect(h.line.querySelectorAll('.meeting-turn').length).toBe(2);
    h.turns = [{ turn: 2, text: 'two', final: false }];
    h.feed.renderFeed();
    expect(words(h.line)).toEqual(['two']);
  });

  it('hands a tap on a speaker tag straight back to the strip', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'hello', final: false, speaker: 'B' }];
    h.feed.renderFeed();
    const tag = h.line.querySelector<HTMLButtonElement>('button.meeting-speaker');
    tag?.click();
    expect(h.named).toEqual(['B']);
  });

  it('gives a bot turn a tag with no tap in it', () => {
    const h = makeFeed();
    h.state = { kind: 'idle' };
    h.liveBot = botStatus({ speakers: ['Dana'] });
    h.turns = [{ turn: 1, text: 'hello', final: false, speaker: 'Dana' }];
    h.feed.renderFeed();
    expect(h.line.querySelector('button.meeting-speaker')).toBeNull();
    expect(h.line.querySelector('.meeting-speaker.is-fixed')).not.toBeNull();
  });

  it('retags every turn wearing a label once that voice has a name', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [
      { turn: 1, text: 'hi', final: true, speaker: 'A' },
      { turn: 2, text: 'there', final: false, speaker: 'A' },
    ];
    h.feed.renderFeed();
    expect(pills(h.line)).toEqual(['Speaker A', 'Speaker A']);
    h.names = { A: 'Bryan' };
    h.feed.retagSpeaker('A');
    expect(pills(h.line)).toEqual(['Bryan', 'Bryan']);
  });

  it('renders no turns at all when the doc has a live zone', () => {
    const zone = { active: () => true } as unknown as MeetingLiveZone;
    const h = makeFeed({ liveZone: zone });
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'said in two places', final: false }];
    h.feed.renderFeed();
    expect(words(h.line)).toEqual([]);
  });
});

describe('createMeetingFeed — the notes that stand in for words', () => {
  it('opens a conversation recording with the consent note', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')?.textContent).toBe(RECORDING_CONSENT_NOTE);
  });

  it('gives a solo recording no consent note — nobody was there to ask', () => {
    const h = makeFeed();
    h.mode = 'solo';
    h.state = { kind: 'recording', startedAt: 0 };
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')).toBeNull();
  });

  it('clears the note the moment there are words to show instead', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')).not.toBeNull();
    h.turns = [{ turn: 1, text: 'first words', final: false }];
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')).toBeNull();
    expect(words(h.line)).toEqual(['first', 'words']);
  });

  it('narrates a live bot that has not said anything yet, naming its speakers', () => {
    const h = makeFeed();
    h.liveBot = botStatus({ state: 'joining', speakers: ['Dana', 'Sam'] });
    h.feed.renderFeed();
    const note = h.line.querySelector('.meeting-bot-note');
    expect(note?.textContent).toContain('Dana, Sam');
  });

  it('offers a terminal bot state as one line the person can tap away', () => {
    const h = makeFeed();
    h.farewell = 'The bot left the call';
    h.feed.renderFeed();
    const note = h.line.querySelector<HTMLButtonElement>('button.meeting-note-dismiss');
    expect(note?.textContent).toBe('The bot left the call');
    note?.click();
    expect(h.dismissed).toBe(1);
  });

  it('leaves an idle line with nothing to say empty', () => {
    const h = makeFeed();
    h.line.append(document.createElement('span'));
    h.feed.renderFeed();
    expect(h.line.childNodes.length).toBe(0);
  });

  it('replaces the line with one sentence for showNote', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'words', final: false }];
    h.feed.renderFeed();
    h.feed.showNote('The microphone was refused.', 'meeting-consent-note');
    expect(words(h.line)).toEqual([]);
    const note = h.line.querySelector('.meeting-note');
    expect(note?.textContent).toBe('The microphone was refused.');
    expect(note?.classList.contains('meeting-consent-note')).toBe(true);
  });

  it('leaves the line untouched while a start is still being requested', () => {
    const h = makeFeed();
    h.feed.showNote('Asking for the microphone…');
    h.state = { kind: 'requesting' };
    h.turns = [{ turn: 1, text: 'ignored', final: false }];
    h.feed.renderFeed();
    expect(h.line.querySelector('.meeting-note')?.textContent).toBe('Asking for the microphone…');
  });

  it('forgets its spans on clearTurnSpans, so the next turn starts clean', () => {
    const h = makeFeed();
    h.state = { kind: 'recording', startedAt: 0 };
    h.turns = [{ turn: 1, text: 'one two', final: false }];
    h.feed.renderFeed();
    h.feed.clearTurnSpans();
    expect(h.line.childNodes.length).toBe(0);
    h.feed.renderFeed();
    expect(words(h.line)).toEqual(['one', 'two']);
  });
});
