import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireBoardVoice } from '../src/board/board-voice.ts';
import type { RecognitionLike, RecognitionResultEvent } from '../src/voice-capture.ts';
import { boardState, mountShell, task } from './support/board-region-harness.ts';

/**
 * The board's half of the mic: what an utterance is ABOUT, and where an ack
 * sends the reader.
 *
 * `voice-capture.ts` owns the hold-to-talk mechanics for every surface, and
 * its own suite drives those. What is only true here is the anchoring — the
 * context has to be re-derived at the moment of the press, because the whole
 * promise is that "this ticket" means whatever the speaker is looking at NOW
 * — and the one navigation that must NOT be a page load.
 */
class FakeRecognition implements RecognitionLike {
  onresult: ((ev: RecognitionResultEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  start(): void {}
  stop(): void {
    this.onend?.();
  }
  say(text: string): void {
    this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: true }] });
  }
}

function voice(over: Partial<Parameters<typeof wireBoardVoice>[0]> = {}) {
  const el = mountShell();
  const state = boardState({ tasks: new Map([['t-1', task('t-1')]]) });
  const rec = new FakeRecognition();
  const assigned: string[] = [];
  const renderDetail = vi.fn();
  const posted: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return Promise.resolve(
      new Response(JSON.stringify(ack), { headers: { 'content-type': 'application/json' } }),
    );
  });
  let ack: unknown = { ack: 'ok' };
  wireBoardVoice({
    state,
    author: { id: 'u-1', name: 'Bryan', kind: 'known', color: '#000' },
    workspaceId: 'w-1',
    document,
    location: {
      origin: 'https://board.example.com',
      pathname: '/workspaces/w-1',
      assign: (u: string) => assigned.push(u),
    },
    el,
    renderDetail,
    createRecognition: () => rec,
    ...over,
  });
  return {
    el,
    state,
    rec,
    assigned,
    renderDetail,
    posted,
    setAck: (a: unknown) => {
      ack = a;
    },
  };
}

/** Hold the mic, say a sentence, let go. */
async function utter(v: ReturnType<typeof voice>, text: string): Promise<void> {
  v.el('board-mic').dispatchEvent(new Event('pointerdown'));
  v.rec.say(text);
  v.el('board-mic').dispatchEvent(new Event('pointerup'));
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  // The mic is gated on a secure context, which no test environment is. The
  // gate has its own suite; here it must simply be open.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('wireBoardVoice', () => {
  it('sends the utterance to the board it is addressed to', async () => {
    const v = voice();
    await utter(v, 'mark it done');
    expect(v.posted[0]?.transcript).toBe('mark it done');
    expect(v.posted[0]?.author).toMatchObject({ name: 'Bryan' });
  });

  it('anchors on the panel that is open at the moment of the press', async () => {
    // Not at mount: the reader opens a ticket long after boot, and "this
    // ticket" has to mean the one they are looking at.
    const v = voice();
    v.state.detailTaskId = 't-1';
    await utter(v, 'park it');
    expect((v.posted[0]?.context as { taskId?: string })?.taskId).toBe('t-1');
  });

  it('falls back to the row the keyboard is on', async () => {
    const v = voice();
    const row = document.createElement('div');
    row.className = 'board-task-row';
    row.dataset.taskId = 't-1';
    row.tabIndex = 0;
    document.body.append(row);
    row.focus();
    await utter(v, 'assign it to me');
    expect((v.posted[0]?.context as { taskId?: string })?.taskId).toBe('t-1');
  });

  it('opens a task the ack names IN PLACE — the session survives navigation', async () => {
    const v = voice();
    v.setAck({ ack: 'here it is', navigate: '/workspaces/w-1?task=t-1' });
    await utter(v, 'show me that ticket');
    expect(v.state.detailTaskId).toBe('t-1');
    expect(v.renderDetail).toHaveBeenCalled();
    expect(v.assigned).toEqual([]);
  });

  it('leaves the page for anything that is not a task on this board', async () => {
    const v = voice();
    v.setAck({ ack: 'over here', navigate: '/review/plan-a' });
    await utter(v, 'open the plan');
    expect(v.assigned).toEqual(['/review/plan-a']);
    expect(v.state.detailTaskId).toBeNull();
  });
});
