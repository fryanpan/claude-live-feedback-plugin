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
  type OriginFacts,
  type RecognitionLike,
  type RecognitionResultEvent,
  type VoiceAck,
  type VoiceContext,
  createVoiceCapture,
  insecureOriginMessage,
  localhostUrlFor,
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

  /** A secure origin — the state-machine tests are about the hold, not the
   *  origin gate, so they run where the mic is actually allowed. */
  const secureOrigin = (): OriginFacts => ({
    isSecureContext: true,
    protocol: 'https:',
    hostname: 'feedback.example.com',
    port: '',
    pathname: '/workspaces/w-1',
    search: '',
  });

  const mount = (opts?: {
    createRecognition?: () => RecognitionLike | null;
    readOrigin?: () => OriginFacts;
  }) =>
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
      readOrigin: opts?.readOrigin ?? secureOrigin,
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

/**
 * The origin gate (the "voice is just broken" report).
 *
 * The server is reached over plain http at a hostname, which is NOT a secure
 * context: Chrome keeps the `SpeechRecognition` constructor on the page but
 * refuses `start()` with `not-allowed` and never prompts. Verified in Chrome
 * 151 against the real origin — `isSecureContext: false`,
 * `navigator.mediaDevices === undefined`, `start()` → `not-allowed` → `end`.
 *
 * So the message must NOT tell anyone to allow the mic for the site — an
 * insecure origin has no such permission to grant — and must name an origin
 * that actually works.
 */
const insecureHostOrigin: OriginFacts = {
  isSecureContext: false,
  protocol: 'http:',
  hostname: 'host.example.ts.net',
  port: '8787',
  pathname: '/workspaces/w-1',
  search: '',
};

describe('localhostUrlFor', () => {
  it('rewrites an insecure host origin to the same page on loopback', () => {
    expect(localhostUrlFor(insecureHostOrigin)).toBe('http://localhost:8787/workspaces/w-1');
  });

  it('keeps the query string, so the suggested URL opens the same view', () => {
    expect(localhostUrlFor({ ...insecureHostOrigin, search: '?tab=tasks' })).toBe(
      'http://localhost:8787/workspaces/w-1?tab=tasks',
    );
  });

  it('has nothing to suggest when the page is already on loopback', () => {
    expect(localhostUrlFor({ ...insecureHostOrigin, hostname: 'localhost' })).toBeNull();
    expect(localhostUrlFor({ ...insecureHostOrigin, hostname: '127.0.0.1' })).toBeNull();
  });
});

describe('insecureOriginMessage', () => {
  // Positive control: the function CAN return null, so the assertions below
  // that expect a message are not vacuously true.
  it('is null on a secure origin', () => {
    expect(
      insecureOriginMessage({ ...insecureHostOrigin, isSecureContext: true, protocol: 'https:' }),
    ).toBeNull();
  });

  it('is null on plain-http loopback, which IS a secure context', () => {
    expect(
      insecureOriginMessage({
        ...insecureHostOrigin,
        hostname: 'localhost',
        isSecureContext: true,
      }),
    ).toBeNull();
  });

  it('names the loopback URL that actually works', () => {
    expect(insecureOriginMessage(insecureHostOrigin)).toContain(
      'http://localhost:8787/workspaces/w-1',
    );
  });

  it('never advises allowing the mic for the site — there is no such permission here', () => {
    const msg = insecureOriginMessage(insecureHostOrigin);
    // Assert the presence before the absence: an absence checked against a
    // null message would pass for the wrong reason.
    expect(msg).not.toBeNull();
    expect((msg ?? '').toLowerCase()).not.toContain('allow the mic');
  });
});

describe('createVoiceCapture on an insecure origin', () => {
  let button: HTMLButtonElement;
  let indicator: HTMLDivElement;
  let created: number;

  const mountAt = (origin: OriginFacts) =>
    createVoiceCapture({
      button,
      indicator,
      getContext: () => ({ surface: 'hub' }),
      send: () => Promise.resolve(null),
      createRecognition: () => {
        created++;
        return null;
      },
      readOrigin: () => origin,
    });

  beforeEach(() => {
    document.body.innerHTML = '';
    button = document.createElement('button');
    indicator = document.createElement('div');
    indicator.className = 'hidden';
    document.body.append(button, indicator);
    created = 0;
  });

  it('explains on press instead of showing a dead "Listening…"', () => {
    const cap = mountAt(insecureHostOrigin);
    keydown(document.body);
    expect(indicator.classList.contains('hidden')).toBe(false);
    expect(indicator.textContent).toContain('http://localhost:8787/workspaces/w-1');
    expect(indicator.textContent).not.toContain('Listening');
    // Proactive: the engine is never asked, so there is no window in which
    // the UI claims to be recording something it cannot record.
    expect(created).toBe(0);
    cap.destroy();
  });

  it('marks the button unavailable at mount but leaves it pressable, so the reason stays reachable', () => {
    const cap = mountAt(insecureHostOrigin);
    expect(button.classList.contains('voice-unavailable')).toBe(true);
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.title).toContain('localhost');
    cap.destroy();
  });

  it('a blocked press does not wedge the hold flag', () => {
    const cap = mountAt(insecureHostOrigin);
    keydown(document.body);
    expect(cap.holding()).toBe(false);
    keyup(document.body);
    expect(cap.holding()).toBe(false);
    cap.destroy();
  });

  // Positive control for the block: on a secure origin the guard is inert
  // and the engine is reached exactly as before.
  it('does not fire on a secure origin', () => {
    const cap = mountAt({ ...insecureHostOrigin, isSecureContext: true, protocol: 'https:' });
    expect(button.classList.contains('voice-unavailable')).toBe(false);
    keydown(document.body);
    expect(created).toBe(1);
    cap.destroy();
  });
});

describe('createVoiceCapture without the Space hotkey', () => {
  /**
   * The board is about to have TWO mics: the board-wide voice dock, and one
   * on the quick-add box. `document`-level Space is a singleton gesture — two
   * captures listening for it both start recording on one press, and both
   * then finalize their own transcript. Only the dock owns Space; the
   * quick-add mic is a button.
   */
  let button: HTMLButtonElement;
  let indicator: HTMLDivElement;
  let rec: FakeRecognition;

  const secureOrigin = (): OriginFacts => ({
    isSecureContext: true,
    protocol: 'https:',
    hostname: 'feedback.example.com',
    port: '',
    pathname: '/workspaces/w-1',
    search: '',
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    button = document.createElement('button');
    indicator = document.createElement('div');
    document.body.append(button, indicator);
    rec = new FakeRecognition();
  });

  const mount = (spaceHotkey: boolean) =>
    createVoiceCapture({
      button,
      indicator,
      spaceHotkey,
      getContext: () => ({ surface: 'hub' }),
      send: () => Promise.resolve(null),
      createRecognition: () => rec,
      readOrigin: secureOrigin,
    });

  it('ignores Space, and still records from its own button', () => {
    const cap = mount(false);
    keydown(document.body);
    expect(rec.started).toBe(0);
    expect(cap.holding()).toBe(false);

    // Positive control beside the absence: the button still works, so the
    // silence above is about the hotkey and not about a dead capture.
    button.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(rec.started).toBe(1);
    expect(cap.holding()).toBe(true);
    cap.destroy();
  });

  it('the default is unchanged — Space still starts the dock', () => {
    const cap = mount(true);
    keydown(document.body);
    expect(rec.started).toBe(1);
    cap.destroy();
  });
});
