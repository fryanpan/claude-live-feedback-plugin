/**
 * Hold-to-talk capture (§2.4 / §3.8): hold Space anywhere (or hold the mic
 * button), dictation streams while held, the full transcript sends on
 * release with the per-surface context — and a hold ends on `pointercancel`,
 * not just on release (the wedged-flag lesson from the comment pill).
 *
 * Recognition is injected — happy-dom has no SpeechRecognition — so these
 * tests drive the state machine through the same seams the browser does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INDICATOR_LINGER_MS,
  LONG_ACK_WORDS,
  type OriginFacts,
  type RecognitionLike,
  type RecognitionResultEvent,
  SPACE_HOLD_ARM_MS,
  type VoiceAck,
  type VoiceContext,
  createVoiceCapture,
  insecureOriginMessage,
  lingerFor,
  localhostUrlFor,
  spaceScrollTarget,
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

/**
 * The document-level hotkey is a HOLD, not a tap (the accidental-trigger ticket): keydown
 * arms a timer and the recording only starts SPACE_HOLD_ARM_MS later, so a
 * typed space — which is a quick tap wherever it lands — never records.
 * These helpers run under fake timers.
 */
function holdSpace(target: EventTarget = document.body): void {
  keydown(target);
  vi.advanceTimersByTime(SPACE_HOLD_ARM_MS);
}
/** `flush` for fake-timer tests: runs due 0ms timers and the microtasks between. */
const flushTimers = () => vi.advanceTimersByTimeAsync(0);

describe('createVoiceCapture', () => {
  let button: HTMLButtonElement;
  let indicator: HTMLDivElement;
  let rec: FakeRecognition;
  let sent: Array<{ transcript: string; context: VoiceContext }>;
  let ackToReturn: VoiceAck | null;
  let navigated: string[];
  /** Every scroll the capture replayed on behalf of a Space that turned out
   *  to be a tap. Injected, because no test environment resolves layout. */
  let scrolled: Array<{ target: EventTarget | null; direction: 1 | -1 }>;

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
      scrollPage: (target, direction) => {
        scrolled.push({ target, direction });
      },
    });

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    button = document.createElement('button');
    indicator = document.createElement('div');
    indicator.className = 'hidden';
    document.body.append(button, indicator);
    rec = new FakeRecognition();
    sent = [];
    navigated = [];
    scrolled = [];
    ackToReturn = { route: 'agent', ack: 'Heard: "x". Sent to the workspace agent.' };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hold Space starts listening and streams interim text into the indicator', () => {
    const cap = mount();
    holdSpace();
    expect(rec.started).toBe(1);
    expect(indicator.classList.contains('hidden')).toBe(false);
    rec.emit([{ text: 'rework these', final: false }]);
    expect(indicator.textContent).toContain('rework these');
    cap.destroy();
  });

  it('a Space TAP records nothing, and gets the scroll it was asking for', () => {
    // The accidental-trigger report (the accidental-trigger ticket): a typed space is a tap,
    // and before this a tap RECORDED — plus a 6s "Didn't catch anything."
    // toast — whenever the guard could not see typing (focus stolen by a
    // re-render, a focused row, plain body). A tap still never reaches the
    // engine.
    //
    // What it no longer does is scroll NATIVELY. A press that might become a
    // hold has its default suppressed at keydown, because that is the only
    // moment the page can be kept still — and by the time the hold arms, a
    // native space has already jumped the page a screen. The scroll is not
    // lost, it is deferred: the release says the press was a tap, and the tap
    // gets its page-down then.
    const cap = mount();
    const ev = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(SPACE_HOLD_ARM_MS - 100);
    keyup(document.body);
    vi.advanceTimersByTime(10_000);
    expect(rec.started).toBe(0);
    expect(sent).toHaveLength(0);
    expect(indicator.classList.contains('hidden')).toBe(true);
    expect(scrolled).toEqual([{ target: document.body, direction: 1 }]);
    cap.destroy();
  });

  it('a Shift+Space tap scrolls back UP, the way Shift+Space always has', () => {
    const cap = mount();
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'Space',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    vi.advanceTimersByTime(SPACE_HOLD_ARM_MS - 100);
    keyup(document.body);
    expect(scrolled.map((s) => s.direction)).toEqual([-1]);
    cap.destroy();
  });

  it('the press that becomes a hold scrolls nothing — not on the way in, not on release', () => {
    // The reported bug: every dictation began with the page jumping a screen,
    // because the press that starts the hold was left to its native default.
    const cap = mount();
    const ev = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    vi.advanceTimersByTime(SPACE_HOLD_ARM_MS);
    expect(rec.started).toBe(1);
    expect(ev.defaultPrevented).toBe(true);
    keyup(document.body);
    // The release ended a recording; it was never a page-down.
    expect(scrolled).toEqual([]);
    cap.destroy();
  });

  it('a Space pressed while dictation is already live neither scrolls nor cuts the recording', () => {
    // Dictation started from the MIC BUTTON, which is how it starts on a
    // tablet. A stray Space then arrived at the document handler with nothing
    // to arm, fell through un-prevented, and scrolled the page out from under
    // the person talking — and its keyup ended the utterance early.
    const cap = mount();
    button.dispatchEvent(new Event('pointerdown'));
    expect(rec.started).toBe(1);

    const ev = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    keyup(document.body);
    expect(scrolled).toEqual([]);
    expect(rec.stopped).toBe(0);
    expect(cap.holding()).toBe(true);

    // …and the button's own release still ends it.
    button.dispatchEvent(new Event('pointerup'));
    expect(rec.stopped).toBe(1);
    cap.destroy();
  });

  it('leaves Space alone where it belongs to something else', () => {
    // The guard is one-directional on purpose: it may only ever suppress a
    // press the page itself owns. A space typed into a field must type, and a
    // space on a focused button must press it — so neither is prevented, and
    // neither is replayed as a scroll either.
    const cap = mount();
    const input = document.createElement('input');
    const control = document.createElement('button');
    document.body.append(input, control);
    for (const el of [input, control]) {
      const ev = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      vi.advanceTimersByTime(SPACE_HOLD_ARM_MS);
      keyup(el);
      expect(ev.defaultPrevented, `Space on <${el.tagName.toLowerCase()}> was eaten`).toBe(false);
    }
    expect(scrolled).toEqual([]);
    expect(rec.started).toBe(0);
    // Positive control: the same probe DOES see the page's own press.
    const onPage = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    document.body.dispatchEvent(onPage);
    expect(onPage.defaultPrevented).toBe(true);
    cap.destroy();
  });

  it('Space over a focused control never arms the mic, however long it is held', () => {
    // A keydown's target is whatever has focus: a task row (a tabindex div),
    // a button, a select. Space MEANS something on all of those, and none of
    // them are "the page". The hotkey only arms when the press lands on the
    // page itself.
    const cap = mount();
    const row = document.createElement('div');
    row.tabIndex = 0;
    row.className = 'hub-task-row';
    const pageButton = document.createElement('button');
    document.body.append(row, pageButton);
    for (const el of [row, pageButton]) {
      keydown(el);
      vi.advanceTimersByTime(10_000);
      keyup(el);
    }
    expect(rec.started).toBe(0);
    // Positive control in the same pass: the same hold on the page starts.
    holdSpace();
    expect(rec.started).toBe(1);
    cap.destroy();
  });

  /**
   * The reported break: "the voice is broken in task detail view right now —
   * holding space does nothing." The panel is opened by CLICKING a task row,
   * which leaves focus on that row, and a row is not the page — so every
   * press answered "not the page" for as long as the task was open. The panel
   * takes focus and declares itself page-like; this is that pair, end to end.
   */
  it('a held Space inside a region marked page-like starts the mic', () => {
    const cap = mount();
    const panel = document.createElement('div');
    panel.tabIndex = -1;
    panel.setAttribute('data-space-hold', 'page');
    const plain = document.createElement('div');
    plain.tabIndex = -1;
    document.body.append(panel, plain);

    // Negative half first, so the positive one below is not a renderer that
    // starts on everything: an unmarked focusable container still does not.
    keydown(plain);
    vi.advanceTimersByTime(10_000);
    keyup(plain);
    expect(rec.started).toBe(0);

    keydown(panel);
    vi.advanceTimersByTime(SPACE_HOLD_ARM_MS);
    expect(rec.started).toBe(1);
    keyup(panel);
    cap.destroy();
  });

  /** The marker is read off the FOCUSED element, never an ancestor — a button
   *  inside the panel keeps Space for itself, which is what Space means on a
   *  button. */
  it('does not start on a control inside a page-like region', () => {
    const cap = mount();
    const panel = document.createElement('div');
    panel.tabIndex = -1;
    panel.setAttribute('data-space-hold', 'page');
    const inner = document.createElement('button');
    panel.append(inner);
    document.body.append(panel);

    keydown(inner);
    vi.advanceTimersByTime(10_000);
    keyup(inner);
    expect(rec.started).toBe(0);
    // Positive control in the same pass: the container itself does start.
    keydown(panel);
    vi.advanceTimersByTime(SPACE_HOLD_ARM_MS);
    expect(rec.started).toBe(1);
    cap.destroy();
  });

  /** "After I make a voice request it should show a spinner/indicator that
   *  it's working." The gap between release and the ack had nothing moving in
   *  it, which is indistinguishable from a dead mic. */
  it('marks the indicator busy while the request is in flight, and clears it on the ack', async () => {
    let settle: ((ack: VoiceAck | null) => void) | undefined;
    const cap = createVoiceCapture({
      button,
      indicator,
      getContext: () => ({ surface: 'hub' }),
      send: () =>
        new Promise<VoiceAck | null>((resolve) => {
          settle = resolve;
        }),
      createRecognition: () => rec,
      readOrigin: secureOrigin,
    });
    holdSpace();
    rec.emit([{ text: 'file a task about the mic', final: true }]);
    keyup(document.body);
    await flushTimers();
    expect(indicator.textContent).toContain('Routing…');
    expect(indicator.querySelector('.voice-spinner')).toBeTruthy();
    expect(indicator.getAttribute('aria-busy')).toBe('true');

    settle?.({ route: 'agent', ack: 'Heard: "file a task about the mic".' });
    await flushTimers();
    // The busy state is cleared by whatever REPLACES it, so a spinner can
    // never outlive the request it was reporting on.
    expect(indicator.querySelector('.voice-spinner')).toBeNull();
    expect(indicator.getAttribute('aria-busy')).toBe('false');
    expect(indicator.textContent).toContain('Heard:');
    cap.destroy();
  });

  it('auto-repeats while the hold is live are prevented, so the page does not scroll under a recording', () => {
    const cap = mount();
    holdSpace();
    const repeat = new KeyboardEvent('keydown', {
      code: 'Space',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    cap.destroy();
  });

  it('a window blur while the hold is still arming cancels it', () => {
    const cap = mount();
    keydown(document.body);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(10_000);
    expect(rec.started).toBe(0);
    cap.destroy();
  });

  it('a repeated keydown (auto-repeat) does not restart recognition', () => {
    const cap = mount();
    holdSpace();
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
    for (const el of [input, textarea, editable]) {
      keydown(el);
      vi.advanceTimersByTime(10_000);
    }
    expect(rec.started).toBe(0);
    // Non-vacuity: the same held Space on the page does start.
    holdSpace();
    expect(rec.started).toBe(1);
    cap.destroy();
  });

  it('release sends the full transcript with the surface context and shows the ack', async () => {
    const cap = mount();
    holdSpace();
    rec.emit([{ text: 'rework these into different groupings', final: true }]);
    keyup(document.body);
    await flushTimers();
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
    holdSpace();
    rec.emit([{ text: 'open the plan', final: true }]);
    keyup(document.body);
    await flushTimers();
    expect(navigated).toEqual(['/review/plan']);
    cap.destroy();
  });

  it('pointercancel ends the hold exactly like release — no wedged mic', async () => {
    const cap = mount();
    button.dispatchEvent(new Event('pointerdown'));
    expect(rec.started).toBe(1);
    rec.emit([{ text: 'add a task', final: true }]);
    button.dispatchEvent(new Event('pointercancel'));
    await flushTimers();
    expect(sent.map((s) => s.transcript)).toEqual(['add a task']);
    // The hold fully settled: a fresh hold starts a fresh recognition.
    button.dispatchEvent(new Event('pointerdown'));
    expect(rec.started).toBe(2);
    cap.destroy();
  });

  it('an empty hold answers locally and never sends', async () => {
    const cap = mount();
    holdSpace();
    keyup(document.body);
    await flushTimers();
    expect(sent).toHaveLength(0);
    expect(indicator.textContent?.toLowerCase()).toContain('didn');
    cap.destroy();
  });

  it('a browser with no speech recognition says so instead of dying silently', () => {
    const cap = mount({ createRecognition: () => null });
    holdSpace();
    expect(indicator.textContent?.toLowerCase()).toContain('not supported');
    keyup(document.body);
    expect(sent).toHaveLength(0);
    cap.destroy();
  });

  it('a failed send still answers', async () => {
    ackToReturn = null;
    const cap = mount();
    holdSpace();
    rec.emit([{ text: 'do the thing', final: true }]);
    keyup(document.body);
    await flushTimers();
    expect(indicator.textContent?.toLowerCase()).toContain('failed');
    cap.destroy();
  });

  it('destroy() detaches every listener', () => {
    const cap = mount();
    cap.destroy();
    holdSpace();
    expect(rec.started).toBe(0);
  });

  it('destroy() cancels a hold that is still arming', () => {
    const cap = mount();
    keydown(document.body);
    cap.destroy();
    vi.advanceTimersByTime(10_000);
    expect(rec.started).toBe(0);
  });
});

describe('spaceScrollTarget', () => {
  it('sends the page itself to the viewport, whatever the body says about overflow', () => {
    // `body { overflow: auto }` PROPAGATES to the viewport — the body element
    // is then not the scroller, so `body.scrollBy()` moves nothing at all. The
    // hub is exactly that layout, and it is the surface where this scroll is
    // the one people use, so "null means the viewport" is load-bearing rather
    // than a fallback.
    document.body.style.overflowY = 'auto';
    expect(spaceScrollTarget(document.body)).toBeNull();
    expect(spaceScrollTarget(document.documentElement)).toBeNull();
    expect(spaceScrollTarget(null)).toBeNull();
    document.body.style.overflowY = '';
  });

  it('picks the scrollable box a page-like container sits in', () => {
    // The task detail panel takes focus and declares itself page-like, and it
    // has its own `overflow: auto`. A space tap there scrolls the PANEL; the
    // viewport behind it would be the wrong thing to move.
    const panel = document.createElement('div');
    panel.style.overflowY = 'auto';
    const inner = document.createElement('div');
    panel.append(inner);
    document.body.append(panel);
    // No test environment resolves layout, so the one fact the walk reads off
    // the box — that it has more content than room — is stated here.
    Object.defineProperty(panel, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(panel, 'clientHeight', { value: 400, configurable: true });

    expect(spaceScrollTarget(inner)).toBe(panel);
    // A box with nothing to scroll is not the answer — the walk continues past
    // it to the viewport.
    Object.defineProperty(panel, 'scrollHeight', { value: 400, configurable: true });
    expect(spaceScrollTarget(inner)).toBeNull();
    panel.remove();
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
    vi.useFakeTimers();
    document.body.innerHTML = '';
    button = document.createElement('button');
    indicator = document.createElement('div');
    indicator.className = 'hidden';
    document.body.append(button, indicator);
    created = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('explains on press instead of showing a dead "Listening…"', () => {
    const cap = mountAt(insecureHostOrigin);
    holdSpace();
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
    holdSpace();
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
    holdSpace();
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
    vi.useFakeTimers();
    document.body.innerHTML = '';
    button = document.createElement('button');
    indicator = document.createElement('div');
    document.body.append(button, indicator);
    rec = new FakeRecognition();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    holdSpace();
    expect(rec.started).toBe(0);
    expect(cap.holding()).toBe(false);

    // Positive control beside the absence: the button still works, so the
    // silence above is about the hotkey and not about a dead capture.
    button.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    expect(rec.started).toBe(1);
    expect(cap.holding()).toBe(true);
    cap.destroy();
  });

  it('the default is unchanged — a held Space still starts the dock', () => {
    const cap = mount(true);
    holdSpace();
    expect(rec.started).toBe(1);
    cap.destroy();
  });
});

describe('createVoiceCapture from the keyboard', () => {
  /**
   * The mic promises "hold to dictate" to everyone, including someone who
   * never touches a pointer. `pointerdown` calls `preventDefault()` so the
   * button never takes focus from a tap — but focused via Tab, holding Space
   * or Enter has to do what holding the button does.
   */
  let button: HTMLButtonElement;
  let indicator: HTMLDivElement;
  let rec: FakeRecognition;
  let sent: string[];

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
    sent = [];
  });

  const mount = (spaceHotkey: boolean) =>
    createVoiceCapture({
      button,
      indicator,
      spaceHotkey,
      getContext: () => ({ surface: 'hub' }),
      send: (transcript) => {
        sent.push(transcript);
        return Promise.resolve(null);
      },
      createRecognition: () => rec,
      readOrigin: secureOrigin,
    });

  it('records a held Space on the button, and sends on release', async () => {
    const cap = mount(false);
    keydown(button);
    expect(rec.started).toBe(1);
    expect(cap.holding()).toBe(true);
    rec.emit([{ text: 'file a bug about the mic', final: true }]);
    keyup(button);
    expect(cap.holding()).toBe(false);
    await flush();
    expect(sent).toEqual(['file a bug about the mic']);
    cap.destroy();
  });

  it('records a held Enter too', () => {
    const cap = mount(false);
    keydown(button, 'Enter');
    expect(rec.started).toBe(1);
    keyup(button, 'Enter');
    expect(rec.stopped).toBe(1);
    cap.destroy();
  });

  it('does not start on a key that is neither Space nor Enter', () => {
    // Negative beside the positives above: Tab moving on, or a typed letter
    // reaching a focused button, must not open the mic.
    const cap = mount(false);
    keydown(button, 'KeyA');
    keydown(button, 'Tab');
    expect(rec.started).toBe(0);
    cap.destroy();
  });

  it('one press records once even when this capture also owns Space', () => {
    // The singleton-gesture bug is TWO captures on one press. It cannot
    // happen here: the button-scoped handler and the document hotkey belong
    // to the SAME capture, and the press reaches its own instance twice —
    // once at the target, once on the way up — where `beginHold`/`endHold`
    // are idempotent. Assert the count, because a second recognizer per
    // press would be silent.
    const cap = mount(true);
    keydown(button);
    expect(rec.started).toBe(1);
    keyup(button);
    expect(rec.stopped).toBe(1);
    expect(cap.holding()).toBe(false);
    cap.destroy();
  });

  it('settles the hold when focus leaves mid-press', () => {
    // The keyup lands wherever focus went, so the button would never hear it
    // and the mic would stay open for the rest of the page load.
    const cap = mount(false);
    keydown(button);
    expect(cap.holding()).toBe(true);
    button.dispatchEvent(new FocusEvent('blur'));
    expect(cap.holding()).toBe(false);
    cap.destroy();
  });

  it('unbinds the button keys on destroy', () => {
    const cap = mount(false);
    cap.destroy();
    keydown(button);
    expect(rec.started).toBe(0);
  });
});

describe('a long ack stays up long enough to be read', () => {
  /**
   * Bryan, 2026-08-29: a "brief status" is a 100-word message. The readout
   * used to clear itself after one fixed linger, sized for a one-line ack; a
   * hundred words vanished mid-read. The linger now scales with the words,
   * and the box takes the long form (`.voice-indicator--long`) so the
   * stylesheet can cap and scroll it.
   */
  it('lingerFor grows with the word count, from the old floor', () => {
    expect(lingerFor('Heard: "x". Sent to the workspace agent.')).toBe(INDICATOR_LINGER_MS);
    const hundred = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
    expect(lingerFor(hundred)).toBeGreaterThan(3 * INDICATOR_LINGER_MS);
    // …and has a ceiling: a runaway ack must not pin the strip open.
    const thousand = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(' ');
    expect(lingerFor(thousand)).toBeLessThanOrEqual(60_000);
  });

  it('a 100-word ack gets the long form and outlives the default linger', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    const button = document.createElement('button');
    const indicator = document.createElement('div');
    indicator.className = 'hidden';
    document.body.append(button, indicator);
    const rec = new FakeRecognition();
    const brief = Array.from({ length: LONG_ACK_WORDS + 70 }, (_, i) => `w${i}`).join(' ');
    const cap = createVoiceCapture({
      button,
      indicator,
      getContext: () => ({ surface: 'hub' }),
      send: () => Promise.resolve({ route: 'fast-path', ack: brief }),
      createRecognition: () => rec,
      readOrigin: () => ({
        isSecureContext: true,
        protocol: 'https:',
        hostname: 'example.test',
        port: '',
        host: 'example.test',
        pathname: '/workspaces/w-1',
        search: '',
      }),
    });
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true }),
    );
    vi.advanceTimersByTime(SPACE_HOLD_ARM_MS + 10);
    rec.emit([{ text: 'brief status', final: true }]);
    document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(indicator.textContent).toContain('w0');
    expect(indicator.classList.contains('voice-indicator--long')).toBe(true);
    // Still up after the old fixed linger…
    vi.advanceTimersByTime(INDICATOR_LINGER_MS + 100);
    expect(indicator.classList.contains('hidden')).toBe(false);
    // …and gone once its own linger runs out.
    vi.advanceTimersByTime(lingerFor(brief));
    expect(indicator.classList.contains('hidden')).toBe(true);
    // A short ack afterwards drops the long form again.
    cap.destroy();
    vi.useRealTimers();
  });
});
