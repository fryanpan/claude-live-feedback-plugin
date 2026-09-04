import type { CaptureMode, MeetingBotStatus } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import type { MeetingBotClient } from '../src/meeting-bot-client.ts';
import { type MeetingMenu, createMeetingMenu } from '../src/meeting-menu.ts';
import type { StripState } from '../src/meeting-strip.ts';

/**
 * The speaker menu is a report on a meeting already configured, with Stop as
 * its one verb. These drive `createMeetingMenu` directly: the headline it
 * composes, the cast it lists, and what its single button does — none of
 * which needs a socket, a microphone or a mounted strip.
 */

interface Harness {
  pop: HTMLElement;
  state: StripState;
  mode: CaptureMode;
  names: Record<string, string>;
  cast: string[];
  liveBot: MeetingBotStatus | null;
  named: string[];
  now: number;
  recordingEngine: string | null;
  advancedFor: string[];
  stopped: number;
  closed: number;
  disposed: boolean;
  bot: MeetingBotClient | undefined;
  menu: MeetingMenu;
}

function makeMenu(over: Partial<Harness> = {}): Harness {
  const h: Harness = {
    pop: document.createElement('div'),
    state: { kind: 'recording', startedAt: 0 } as StripState,
    mode: 'conversation' as CaptureMode,
    names: {} as Record<string, string>,
    cast: [] as string[],
    liveBot: null as MeetingBotStatus | null,
    named: [] as string[],
    now: 0,
    recordingEngine: null as string | null,
    advancedFor: [] as string[],
    stopped: 0,
    closed: 0,
    disposed: false,
    bot: undefined as MeetingBotClient | undefined,
    menu: undefined as unknown as MeetingMenu,
    ...over,
  };
  h.menu = createMeetingMenu({
    pop: h.pop,
    bot: h.bot,
    state: () => h.state,
    mode: () => h.mode,
    names: () => h.names,
    cast: () => h.cast,
    liveBot: () => h.liveBot,
    nameSpeaker: (label) => h.named.push(label),
    now: () => h.now,
    recordingEngine: () => h.recordingEngine,
    buildAdvancedPanel: (engineId, recording) => {
      h.advancedFor.push(`${engineId}:${recording}`);
      const el = document.createElement('div');
      el.className = 'meeting-adv';
      return el;
    },
    stop: () => {
      h.stopped += 1;
    },
    closePop: () => {
      h.closed += 1;
    },
    isDisposed: () => h.disposed,
  });
  return h;
}

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

const rows = (pop: HTMLElement) =>
  [...pop.querySelectorAll('.meeting-pop-speaker-name')].map((el) => el.textContent ?? '');

describe('createMeetingMenu — the headline', () => {
  it('names the source, the room size and the clock while recording', () => {
    const h = makeMenu({ cast: ['A', 'B'], now: 125_000 });
    expect(h.menu.headline()).toBe('Recording · microphone · 2 speakers · 02:05');
  });

  it('says multiple speakers before any voice has been heard', () => {
    const h = makeMenu();
    expect(h.menu.headline()).toBe('Recording · microphone · multiple speakers · 00:00');
    h.state = { kind: 'requesting' };
    expect(h.menu.headline()).toBe('Starting… · microphone · multiple speakers');
  });

  it('leaves the room size out of a solo capture', () => {
    const h = makeMenu({ mode: 'solo', cast: ['A'], now: 5_000 });
    expect(h.menu.headline()).toBe('Recording · microphone · 00:05');
  });

  it('describes the bot instead when one is live', () => {
    const h = makeMenu({ liveBot: botStatus({ state: 'joining', speakers: ['Dana'] }) });
    expect(h.menu.headline()).toBe('Joining the call · meeting bot · 1 speaker');
  });

  it('counts past an hour rather than wrapping', () => {
    const h = makeMenu({ mode: 'solo', now: 3_723_000 });
    expect(h.menu.headline()).toBe('Recording · microphone · 62:03');
  });
});

describe('createMeetingMenu — the panel', () => {
  it('lists one rename row per voice, and hands a press back to the strip', () => {
    const h = makeMenu({ cast: ['A', 'B'], names: { B: 'Bryan' } });
    h.menu.buildMenu();
    expect(rows(h.pop)).toEqual(['Speaker A', 'Bryan']);
    const rename = h.pop.querySelectorAll<HTMLButtonElement>('.meeting-pop-rename');
    expect(rename.length).toBe(2);
    rename[1]?.click();
    expect(h.named).toEqual(['B']);
  });

  it('redraws from scratch, so a second open shows the names given since', () => {
    const h = makeMenu({ cast: ['A'] });
    h.menu.buildMenu();
    expect(rows(h.pop)).toEqual(['Speaker A']);
    h.names = { A: 'Bryan' };
    h.menu.buildMenu();
    expect(rows(h.pop)).toEqual(['Bryan']);
  });

  it('gives a bot meeting speakers with nothing to rename', () => {
    const h = makeMenu({ liveBot: botStatus({ speakers: ['Dana', 'Sam'] }) });
    h.menu.buildMenu();
    expect(rows(h.pop)).toEqual(['Dana', 'Sam']);
    expect(h.pop.querySelector('.meeting-pop-rename')).toBeNull();
  });

  it('offers the recording engine its Advanced panel, marked live', () => {
    const h = makeMenu({ recordingEngine: 'soniox' });
    h.menu.buildMenu();
    expect(h.advancedFor).toEqual(['soniox:true']);
    expect(h.pop.querySelector('.meeting-adv')).not.toBeNull();
  });

  it('offers no Advanced panel for an engine with no controls', () => {
    const h = makeMenu({ recordingEngine: 'no-such-engine' });
    h.menu.buildMenu();
    expect(h.advancedFor).toEqual([]);
  });

  it('offers no Advanced panel to a bot meeting — there is no mic engine to tune', () => {
    const h = makeMenu({ recordingEngine: 'soniox', liveBot: botStatus() });
    h.menu.buildMenu();
    expect(h.advancedFor).toEqual([]);
  });
});

describe('createMeetingMenu — the one verb', () => {
  it('stops the capture and closes the popover', () => {
    const h = makeMenu();
    h.menu.buildMenu();
    const cta = h.pop.querySelector<HTMLButtonElement>('.meeting-stop-cta');
    expect(cta?.textContent).toBe('■ Stop Recording');
    cta?.click();
    expect(h.stopped).toBe(1);
    expect(h.closed).toBe(1);
  });

  it('sends a live bot home instead, and closes once the leave settles', async () => {
    let resolveLeave: (() => void) | undefined;
    const leave = new Promise<void>((r) => {
      resolveLeave = r;
    });
    const bot = { leave: () => leave } as unknown as MeetingBotClient;
    const h = makeMenu({ bot, liveBot: botStatus() });
    h.menu.buildMenu();
    const cta = h.pop.querySelector<HTMLButtonElement>('.meeting-stop-cta');
    expect(cta?.textContent).toBe('■ Send the bot home');
    cta?.click();
    // Disabled at once: the press is in flight, and a second one would send a
    // second leave for the same bot.
    expect(cta?.disabled).toBe(true);
    expect(h.stopped).toBe(0);
    resolveLeave?.();
    await leave;
    await Promise.resolve();
    expect(h.closed).toBe(1);
  });

  it('leaves a torn-down mount alone when the leave finally answers', async () => {
    const leave = Promise.reject(new Error('gone'));
    const bot = { leave: () => leave } as unknown as MeetingBotClient;
    const h = makeMenu({ bot, liveBot: botStatus() });
    h.menu.buildMenu();
    h.pop.querySelector<HTMLButtonElement>('.meeting-stop-cta')?.click();
    h.disposed = true;
    await leave.catch(() => undefined);
    await Promise.resolve();
    expect(h.closed).toBe(0);
  });
});
