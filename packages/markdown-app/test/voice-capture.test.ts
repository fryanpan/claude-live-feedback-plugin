/**
 * Hold-to-talk capture (§2.4 / §3.8): hold Space anywhere (or hold the mic
 * button), dictation streams while held, the full transcript sends on
 * release with the per-surface context — and a hold ends on `pointercancel`,
 * not just on release (the wedged-flag lesson from the comment pill).
 *
 * Recognition is injected — happy-dom has no SpeechRecognition — so these
 * tests drive the state machine through the same seams the browser does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type RecognitionLike,
  type RecognitionResultEvent,
  type VoiceAck,
  type VoiceContext,
  createVoiceCapture,
  topmostVisibleHeading,
} from '../src/voice-capture.ts';

class FakeRecognition implements RecognitionLike {
  started = 0;
  stopped = 0;
  onresult: ((ev: RecognitionResultEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
    // Browsers deliver onend asynchronously after stop; sync is fine for the
    // state machine, which only requires "after".
    this.onend?.();
  }
  emit(segments: Array<{ text: string; final: boolean }>): void {
    this.onresult?.({
      resultIndex: 0,
      results: segments.map((s) => ({ 0: { transcript: s.text }, isFinal: s.final })),
    });
  }
}

function keydown(target: EventTarget, code = 'Space', repeat = false): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { code, repeat, bubbles: true, cancelable: true }),
  );
}
function keyup(target: EventTarget, code = 'Space'): void {
  target.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createVoiceCapture', () => {
  let button: HTMLButtonElement;
  let indicator: HTMLDivElement;
  let rec: FakeRecognition;
  let sent: Array<{ transcript: string; context: VoiceContext }>;
  let ackToReturn: VoiceAck | null;
  let navigated: string[];

  const mount = (opts?: { createRecognition?: () => RecognitionLike | null }) =>
    createVoiceCapture({
      button,
      indicator,
      getContext: () => ({ surface: 'hub' }),
      send: (transcript, context) => {
        sent.push({ transcript, context });
        return Promise.resolve(ackToReturn);
      },
      onNavigate: (url) => {
        navigated.push(url);
      },
      createRecognition: opts?.createRecognition ?? (() => rec),
    });

  beforeEach(() => {
    document.body.innerHTML = '';
    button = document.createElement('button');
    indicator = document.createElement('div');
    indicator.className = 'hidden';
    document.body.append(button, indicator);
    rec = new FakeRecognition();
    sent = [];
    navigated = [];
    ackToReturn = { route: 'agent', ack: 'Heard: "x". Sent to the workspace agent.' };
  });

  it('hold Space starts listening and streams interim text into the indicator', () => {
    const cap = mount();
    keydown(document.body);
    expect(rec.started).toBe(1);
    expect(indicator.classList.contains('hidden')).toBe(false);
    rec.emit([{ text: 'rework these', final: false }]);
    expect(indicator.textContent).toContain('rework these');
    cap.destroy();
  });

  it('a repeated keydown (auto-repeat) does not restart recognition', () => {
    const cap = mount();
    keydown(document.body);
    keydown(document.body, 'Space', true);
    keydown(document.body, 'Space', true);
    expect(rec.started).toBe(1);
    cap.destroy();
  });

  it('Space while typing in an input / textarea / contenteditable never triggers the mic', () => {
    const cap = mount();
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(input, textarea, editable);
    for (const el of [input, textarea, editable]) keydown(el);
    expect(rec.started).toBe(0);
    cap.destroy();
  });

  it('release sends the full transcript with the surface context and shows the ack', async () => {
    const cap = mount();
    keydown(document.body);
    rec.emit([{ text: 'rework these into different groupings', final: true }]);
    keyup(document.body);
    await flush();
    expect(rec.stopped).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.transcript).toBe('rework these into different groupings');
    expect(sent[0]?.context).toEqual({ surface: 'hub' });
    expect(indicator.textContent).toContain('Sent to the workspace agent');
    cap.destroy();
  });

  it('a fast-path ack with a navigation target invokes onNavigate', async () => {
    ackToReturn = {
      route: 'fast-path',
      ack: 'Heard: "open the plan". Lookup — opening plan.',
      navigate: '/review/plan',
    };
    const cap = mount();
    keydown(document.body);
    rec.emit([{ text: 'open the plan', final: true }]);
    keyup(document.body);
    await flush();
    expect(navigated).toEqual(['/review/plan']);
    cap.destroy();
  });

  it('pointercancel ends the hold exactly like release — no wedged mic', async () => {
    const cap = mount();
    button.dispatchEvent(new Event('pointerdown'));
    expect(rec.started).toBe(1);
    rec.emit([{ text: 'add a task', final: true }]);
    button.dispatchEvent(new Event('pointercancel'));
    await flush();
    expect(sent.map((s) => s.transcript)).toEqual(['add a task']);
    // The hold fully settled: a fresh hold starts a fresh recognition.
    button.dispatchEvent(new Event('pointerdown'));
    expect(rec.started).toBe(2);
    cap.destroy();
  });

  it('an empty hold answers locally and never sends', async () => {
    const cap = mount();
    keydown(document.body);
    keyup(document.body);
    await flush();
    expect(sent).toHaveLength(0);
    expect(indicator.textContent?.toLowerCase()).toContain('didn');
    cap.destroy();
  });

  it('a browser with no speech recognition says so instead of dying silently', () => {
    const cap = mount({ createRecognition: () => null });
    keydown(document.body);
    expect(indicator.textContent?.toLowerCase()).toContain('not supported');
    keyup(document.body);
    expect(sent).toHaveLength(0);
    cap.destroy();
  });

  it('a failed send still answers', async () => {
    ackToReturn = null;
    const cap = mount();
    keydown(document.body);
    rec.emit([{ text: 'do the thing', final: true }]);
    keyup(document.body);
    await flush();
    expect(indicator.textContent?.toLowerCase()).toContain('failed');
    cap.destroy();
  });

  it('destroy() detaches every listener', () => {
    const cap = mount();
    cap.destroy();
    keydown(document.body);
    expect(rec.started).toBe(0);
  });
});

describe('topmostVisibleHeading', () => {
  it('picks the last heading at or above the viewport threshold', () => {
    const headings = [
      { text: 'Intro', top: -400 },
      { text: 'Rollout risks', top: 40 },
      { text: 'Budget', top: 600 },
    ];
    expect(topmostVisibleHeading(headings)).toBe('Rollout risks');
  });

  it('is undefined above the first heading, and tolerates no headings', () => {
    expect(topmostVisibleHeading([{ text: 'Later', top: 900 }])).toBeUndefined();
    expect(topmostVisibleHeading([])).toBeUndefined();
  });
});
