/**
 * Hold-to-talk voice capture (§2.4 / §3.8), shared by the hub, the doc
 * surface, and the task detail. Hold Space over the page itself (a real hold,
 * never a tap, never while typing or while any control has focus), hold
 * the mic button, or hold Space/Enter while the mic button has focus — the
 * last being the only route for someone who never uses a pointer, since a
 * mount that opts out of the document hotkey would otherwise have no keyboard
 * path at all. Dictation streams live into the indicator while held;
 * the full transcript sends on release with the per-surface context —
 * `{surface, docId?, taskId?, visibleHeading?}` — and the server's ack (which
 * ALWAYS names what was heard and which route handles it) replaces it.
 *
 * Gesture rules carried from the comment-pill incident (learnings.md): a
 * hold has TWO endings — `pointercancel` fires instead of `pointerup`
 * whenever the system takes the touch over — and both settle the hold the
 * same way. A `blur` (tab switch mid-hold) settles it too, so the mic can
 * never wedge open.
 *
 * A Space this capture has a claim to never scrolls the page: the default is
 * held back at keydown (the only moment that can keep the page still) and a
 * press that turns out to be a tap is paid its page-down back on release. See
 * `onKeyDown` for why the two halves cannot be collapsed into one.
 */

export interface VoiceContext {
  surface: 'hub' | 'doc' | 'task';
  /** The thread the speaker has open — the review item they are "in", so a
   *  spoken answer lands on it rather than on whichever item is first. */
  threadId?: string;
  docId?: string;
  taskId?: string;
  visibleHeading?: string;
}

/** What the /voice route answers with. */
export interface VoiceAck {
  route: string;
  ack: string;
  navigate?: string;
}

export interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>;
}

/** The slice of SpeechRecognition the capture uses — injectable in tests. */
export interface RecognitionLike {
  start(): void;
  stop(): void;
  onresult: ((ev: RecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** The browser's real recognition, or null where none exists (Firefox). */
export function defaultRecognitionFactory(): RecognitionLike | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => RecognitionLike & {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
    };
    webkitSpeechRecognition?: new () => RecognitionLike & {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
    };
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  return rec;
}

/**
 * The topmost heading currently on screen — rough scroll awareness with no
 * pixel tracking (§3.8). Pure: the DOM adapter below feeds it positions.
 * "Current section" = the last heading at or above the threshold line near
 * the viewport top; above the first heading there is no section yet.
 */
export function topmostVisibleHeading(
  headings: Array<{ text: string; top: number }>,
  threshold = 100,
): string | undefined {
  let current: string | undefined;
  for (const h of headings) {
    if (h.top <= threshold) current = h.text;
  }
  return current;
}

/** DOM adapter for `topmostVisibleHeading`. */
export function visibleHeadingIn(root: ParentNode): string | undefined {
  const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).map(
    (el) => ({ text: el.textContent?.trim() ?? '', top: el.getBoundingClientRect().top }),
  );
  return topmostVisibleHeading(headings.filter((h) => h.text.length > 0));
}

export interface VoiceCaptureOpts {
  /** The mic button (hold to talk). */
  button: HTMLElement;
  /** Where streaming dictation and acks render. Toggles `.hidden`. */
  indicator: HTMLElement;
  /** The per-utterance anchor: wherever the speaker is NOW (§3.8 — the
   *  conversation's anchor shifts as it proceeds). Read at release time. */
  getContext: () => VoiceContext;
  /** POST the transcript; resolve the server's ack, or null on failure. */
  send: (transcript: string, context: VoiceContext) => Promise<VoiceAck | null>;
  onNavigate?: (url: string) => void;
  createRecognition?: () => RecognitionLike | null;
  /** The page's origin facts — injectable so the gate is testable. */
  readOrigin?: () => OriginFacts;
  /**
   * Bind hold-Space on `document`. Default true.
   *
   * Space is a SINGLETON gesture: two captures listening for it both start on
   * one press and both finalize their own transcript, so exactly one capture
   * per page may own it. The board-wide voice dock does; the mic on the
   * quick-add box is a button and opts out.
   */
  spaceHotkey?: boolean;
  /**
   * Perform the scroll a native Space would have done, for a press that turned
   * out to be a tap. Injectable because no test environment resolves layout.
   */
  scrollPage?: (target: EventTarget | null, direction: 1 | -1) => void;
}

export interface VoiceCapture {
  destroy(): void;
  holding(): boolean;
}

/** How long a terminal indicator message stays up. */
/** How long a one-line ack stays up. The floor of `lingerFor`. */
export const INDICATOR_LINGER_MS = 6_000;
/** From this many words an ack is prose — a status brief — and the readout
 *  takes its long form (`.voice-indicator--long`) so the stylesheet can cap
 *  and scroll it. */
export const LONG_ACK_WORDS = 30;
/** Reading pace the linger is sized to, per word. ~250 wpm is brisk; a
 *  hundred-word brief gets ~30s, which is what it takes to read it twice. */
const LINGER_PER_WORD_MS = 300;
const LINGER_MAX_MS = 45_000;

/**
 * How long an ack stays up: the fixed linger for a sentence, longer for a
 * paragraph. Bryan, 2026-08-29: *"If I ask for a brief status update, that
 * should be able to show me a 100 word message"* — and a hundred words that
 * clear themselves after six seconds were not shown, they were flashed.
 */
export function lingerFor(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.min(LINGER_MAX_MS, Math.max(INDICATOR_LINGER_MS, words * LINGER_PER_WORD_MS));
}
/**
 * How long Space must be HELD before the document-level hotkey starts
 * recording. Push-to-talk is a hold; a typed space is a tap (keydown→keyup in
 * well under 150ms), and before this threshold existed a tap RECORDED — every
 * space that landed outside a text field started the engine and left a 6s
 * "Didn't catch anything." toast (t-Mym15-yQ3QxJ). The mic button keeps
 * starting instantly: pressing a mic is already unambiguous.
 */
export const SPACE_HOLD_ARM_MS = 250;
/** If the recognition's `onend` never arrives after stop(), finalize anyway —
 *  a dead engine must not eat the utterance. */
const FINALIZE_WATCHDOG_MS = 1_500;

import { eventPath, typingInPath } from './keyboard-target.ts';

/**
 * The facts about the current origin that decide whether voice can run at
 * all. Injectable so the decision is testable without a browser.
 */
export interface OriginFacts {
  /** `window.isSecureContext` — the single thing the mic is gated on. */
  isSecureContext: boolean;
  protocol: string;
  hostname: string;
  /** `location.port` — '' when the scheme's default port is in use. */
  port: string;
  pathname: string;
  search: string;
}

/** The real page's origin. */
export function defaultOriginFacts(): OriginFacts {
  return {
    isSecureContext: window.isSecureContext,
    protocol: location.protocol,
    hostname: location.hostname,
    port: location.port,
    pathname: location.pathname,
    search: location.search,
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The same page on loopback — which IS a secure context however it is served,
 * so it is the one origin that needs no TLS to make the mic work. Null when
 * the page is already there (nothing left to suggest).
 */
export function localhostUrlFor(loc: OriginFacts): string | null {
  if (LOOPBACK_HOSTS.has(loc.hostname)) return null;
  const port = loc.port === '' ? '' : `:${loc.port}`;
  return `http://localhost${port}${loc.pathname}${loc.search}`;
}

/**
 * Why voice cannot run on this origin, in one line someone can act on — or
 * null when the origin is fine.
 *
 * The microphone is gated on a SECURE CONTEXT. The server is normally reached
 * over plain http at a hostname (`http://<host>:8787/...`), which is not one;
 * loopback is exempt whatever its scheme. Verified in Chrome 151 against that
 * origin: the `SpeechRecognition` constructor is still THERE (so "unsupported
 * browser" is the wrong thing to say), `navigator.mediaDevices` is undefined,
 * and `start()` answers `not-allowed` immediately with no prompt.
 *
 * That last part is why this message must not suggest allowing the mic for
 * the site: on an insecure origin Chrome offers no such permission, so the
 * advice sends someone into site settings to look for a control that is not
 * there. Naming loopback is the one instruction that works today with no
 * certificate, no tunnel, and no configuration.
 */
export function insecureOriginMessage(loc: OriginFacts): string | null {
  if (loc.isSecureContext) return null;
  const url = localhostUrlFor(loc);
  const why = 'Voice needs https or localhost — on plain http the browser blocks the mic outright.';
  return url ? `${why} From the host machine, open ${url}` : why;
}

/** The `error` code off a SpeechRecognition error event, if it carries one. */
export function errorCodeOf(ev: unknown): string | null {
  const code = (ev as { error?: unknown } | null)?.error;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/**
 * What to tell the person, per recognition error code.
 *
 * The insecure-origin case no longer reaches here — `insecureOriginMessage`
 * catches it before the engine is started — so a `not-allowed` that gets this
 * far came from a SECURE origin, where it means the permission was genuinely
 * refused: denied for the site, or denied to the browser by the OS. Those are
 * the two places worth naming, and both are real controls that exist.
 */
export function recognitionErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone permission refused — allow the mic for this site, and check the browser has mic access in the OS privacy settings.';
    case 'audio-capture':
      return 'No microphone found.';
    case 'network':
      return 'Speech service unreachable — check the network.';
    case 'no-speech':
      return "Didn't catch anything.";
    case 'aborted':
      return 'Recording stopped.';
    default:
      return `Voice input failed (${code}).`;
  }
}

/** Held Space starts a recording, so "am I typing?" has to be right through a
 *  shadow boundary too — otherwise a space typed into the feedback widget's
 *  comment box starts recording instead of typing a space. Same retargeting
 *  bug as the board's hotkeys; same shared guard. */

/**
 * The attribute a surface stamps on a container to say "a Space held here is
 * the page's, not mine" — see `spaceHoldTargetsPage`. One spelling, shared by
 * the predicate and by whoever marks the region.
 */
export const SPACE_HOLD_PAGE_ATTR = 'data-space-hold';

/**
 * Where a document-level Space hold may begin: on the page itself, and
 * nowhere else. A keydown's target is whatever has focus, and Space MEANS
 * something on almost any focused element — it activates a button, toggles a
 * checkbox, opens a select, "selects" a task row. `typingInPath` only knows
 * about text entry, so every one of those cases used to start a recording
 * (t-Mym15-yQ3QxJ). The honest positive predicate is narrow: the press is the
 * page's own only when it lands on body / the root / the document — which is
 * exactly the state of a reader who is not interacting with anything.
 *
 * Deliberately one-directional: everything this suppresses still has the mic
 * button, so a false "not the page" costs a click; the old false "not typing"
 * cost a corrupted sentence and a surprise recording.
 *
 * **The one widening**, and the reason it is safe: a surface that takes focus
 * onto a non-interactive CONTAINER — a dialog that must be readable and
 * dismissable from the keyboard — leaves the reader in exactly the state body
 * describes, with focus somewhere the browser assigns no meaning to Space.
 * The task detail panel is that case, and until it was covered, opening a task
 * from the board killed hold-to-talk outright: the click left focus on the
 * task row, so every press answered "not the page" and the mic never armed.
 * The marker is read off the FOCUSED element only, never an ancestor, so a
 * button or a select inside such a container keeps Space for itself.
 */
export function spaceHoldTargetsPage(path: readonly (EventTarget | undefined)[]): boolean {
  const inner = path[0];
  if (!inner) return false;
  if (inner instanceof Document) return true;
  if (!(inner instanceof Element)) return false;
  const doc = inner.ownerDocument;
  if (inner === doc.body || inner === doc.documentElement) return true;
  return inner.getAttribute(SPACE_HOLD_PAGE_ATTR) === 'page';
}

/**
 * How much of the screen a native Space page-down leaves behind. Browsers
 * scroll a viewport height less a couple of lines, so the reader keeps their
 * place across the jump; this is that overlap.
 */
const SPACE_SCROLL_OVERLAP_PX = 40;

/**
 * The box a native Space would have scrolled, or null for the viewport.
 *
 * `null` is the answer for the page itself, and it is not a fallback: a hub
 * page sets `overflow: auto` on <body>, which PROPAGATES to the viewport — so
 * the body element is not the scroller and `body.scrollBy()` moves nothing at
 * all. Only the marked page-like containers need the walk, and one of them
 * (the task detail panel) really is its own scrollport.
 */
export function spaceScrollTarget(from: EventTarget | null | undefined): Element | null {
  if (!(from instanceof Element)) return null;
  const doc = from.ownerDocument;
  const view = doc.defaultView;
  let el: Element | null = from;
  while (el && el !== doc.body && el !== doc.documentElement) {
    const overflowY = view?.getComputedStyle(el).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/** The deferred half of the Space guard: the page-down the browser was not
 *  allowed to do, once the release has said the press was a tap. */
export function defaultSpaceScroll(target: EventTarget | null, direction: 1 | -1): void {
  const box = spaceScrollTarget(target);
  const height = box ? box.clientHeight : window.innerHeight;
  const dy = direction * Math.max(0, height - SPACE_SCROLL_OVERLAP_PX);
  if (box) box.scrollBy(0, dy);
  else if (typeof window.scrollBy === 'function') window.scrollBy(0, dy);
}

export function createVoiceCapture(opts: VoiceCaptureOpts): VoiceCapture {
  const { button, indicator } = opts;
  const createRecognition = opts.createRecognition ?? defaultRecognitionFactory;
  const readOrigin = opts.readOrigin ?? defaultOriginFacts;

  let holding = false;
  let rec: RecognitionLike | null = null;
  let transcript = '';
  let finalized = true;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let lastError: string | null = null;

  /**
   * `busy` is the "we are working on it" state, and it is grounded in the
   * work rather than inferred: it is set at the one point a request is
   * IN FLIGHT and cleared by whatever replaces it — the ack, or the failure.
   * Without it the gap between releasing the key and the ack landing was a
   * static line of text with nothing moving in it, which reads as a dead mic
   * on the surface whose whole promise is that every utterance gets an answer.
   */
  const show = (text: string, opts2?: { linger?: boolean; busy?: boolean }): void => {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    const busy = opts2?.busy === true;
    indicator.replaceChildren();
    if (busy) {
      const spinner = document.createElement('span');
      spinner.className = 'voice-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      indicator.append(spinner);
    }
    const label = document.createElement('span');
    label.className = 'voice-indicator-text';
    label.textContent = text;
    indicator.append(label);
    indicator.classList.toggle('voice-indicator--busy', busy);
    // Prose, not a line: the long form wraps, caps its height and scrolls.
    indicator.classList.toggle(
      'voice-indicator--long',
      text.split(/\s+/).filter((w) => w.length > 0).length >= LONG_ACK_WORDS,
    );
    indicator.setAttribute('aria-busy', busy ? 'true' : 'false');
    indicator.classList.remove('hidden');
    if (opts2?.linger) {
      clearTimer = setTimeout(() => {
        indicator.classList.add('hidden');
      }, lingerFor(text));
    }
  };

  const readResults = (ev: RecognitionResultEvent): void => {
    let text = '';
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r) text += r[0].transcript;
    }
    transcript = text.trim();
    if (holding) show(transcript.length > 0 ? transcript : 'Listening…');
  };

  const beginHold = (): void => {
    if (holding) return;
    // The origin gate comes FIRST. On an insecure origin the engine answers
    // `not-allowed` a beat after start(), so reacting to that error means
    // showing "Listening…" first — the UI claims to be recording when it
    // provably cannot. Checked here rather than at mount alone because
    // nothing else in the app owns the moment the person actually asks.
    const blocked = insecureOriginMessage(readOrigin());
    if (blocked) {
      show(blocked, { linger: true });
      return;
    }
    holding = true;
    transcript = '';
    finalized = false;
    button.classList.add('voice-active');
    rec = createRecognition();
    if (!rec) {
      show('Voice input is not supported in this browser.', { linger: true });
      return;
    }
    rec.onresult = readResults;
    rec.onend = () => finalize();
    rec.onerror = (ev: unknown) => {
      // An aborted engine still has whatever transcript it managed, so the
      // error does not stop the finalize path — but it must be NAMED. The
      // old handler swallowed the reason entirely, which is why "voice is
      // just broken" was the whole bug report available: holding the mic
      // showed "Listening…", the engine refused, and the only visible
      // outcome was an empty transcript indistinguishable from silence.
      // `not-allowed` on a page served over plain http is the common one —
      // Chrome gates the microphone on a secure context, so every hub
      // reached by hostname (rather than localhost) fails exactly here.
      lastError = errorCodeOf(ev);
    };
    show('Listening…');
    try {
      rec.start();
    } catch {
      rec = null;
      show('Voice input failed to start.', { linger: true });
    }
  };

  const endHold = (): void => {
    if (!holding) return;
    holding = false;
    // However the hold ends — release, blur, destroy — the next Space keyup is
    // not this one's, so the claim is dropped with the hold.
    spaceStartedHold = false;
    button.classList.remove('voice-active');
    if (!rec) {
      finalized = true;
      return;
    }
    // stop() → onend → finalize; the watchdog covers an engine whose onend
    // never fires, so the utterance is never silently eaten.
    watchdog = setTimeout(() => finalize(), FINALIZE_WATCHDOG_MS);
    try {
      rec.stop();
    } catch {
      finalize();
    }
  };

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    rec = null;
    const text = transcript.trim();
    if (text.length === 0) {
      // An empty transcript with a recorded error is a refusal, not silence,
      // and saying so is the difference between "voice is just broken" and a
      // report someone can act on.
      show(lastError ? recognitionErrorMessage(lastError) : "Didn't catch anything.", {
        linger: true,
      });
      lastError = null;
      return;
    }
    lastError = null;
    const context = opts.getContext();
    show('Routing…', { busy: true });
    void opts.send(text, context).then((ack) => {
      if (!ack) {
        show('Voice request failed — try again.', { linger: true });
        return;
      }
      show(ack.ack, { linger: true });
      if (ack.navigate) opts.onNavigate?.(ack.navigate);
    });
  };

  /**
   * The document-level hotkey. Three rules beyond the typing guard. The first
   * two are from the accidental-trigger report (t-Mym15-yQ3QxJ — "voice
   * triggers while I'm typing, basically everywhere"):
   *
   * 1. The press must land on the PAGE (`spaceHoldTargetsPage`), not on some
   *    focused control. This is what catches the report's worst case: a board
   *    re-render that rebuilds the DOM under someone's hands drops focus to
   *    <body>, and their next typed space arrived here looking exactly like a
   *    deliberate hotkey.
   * 2. The press must be a HOLD. keydown only ARMS a timer; the engine starts
   *    SPACE_HOLD_ARM_MS later, and a keyup before that disarms — so a tap
   *    does nothing at all.
   * 3. **A press the page owns does not scroll the page.** Every dictation
   *    used to open with the board jumping a screen, because the native
   *    page-down fires at KEYDOWN and the hold only arms 250ms later — by
   *    which time the scroll has already happened and no amount of
   *    preventDefault afterwards can take it back. So the default is
   *    suppressed at keydown, on the one press this capture has a claim to,
   *    and the ending says what the press was: a hold records, and a tap gets
   *    its page-down replayed on release. Nothing is taken away — rule 1 keeps
   *    this off every press that belongs to a field or a control, which still
   *    reach the browser untouched.
   */
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  /** Where a still-arming press landed, and which way it would scroll — read
   *  by the release, when a tap has to be paid back its page-down. */
  let armedTap: { target: EventTarget | null; direction: 1 | -1 } | null = null;
  /**
   * Whether the LIVE hold was started by this hotkey. A hold started from the
   * mic button belongs to the button's own release: a stray Space keyup used
   * to end it, cutting the utterance off mid-sentence on a tablet, where the
   * button is how dictation starts.
   */
  let spaceStartedHold = false;
  const scrollPage = opts.scrollPage ?? defaultSpaceScroll;
  const disarm = (): void => {
    armedTap = null;
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.code !== 'Space') return;
    if (ev.repeat) {
      // Once the hold is arming or live, its auto-repeats are the hold's —
      // keep them from scrolling the page under a recording.
      if (holding || armTimer) ev.preventDefault();
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const path = eventPath(ev);
    if (typingInPath(path)) return;
    if (!spaceHoldTargetsPage(path)) return;
    if (armTimer) return;
    if (holding) {
      // Dictation is already running — from the mic button, or from a first
      // key still down. The page must not move under a recording.
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
    armedTap = { target: path[0] ?? null, direction: ev.shiftKey ? -1 : 1 };
    armTimer = setTimeout(() => {
      armTimer = null;
      armedTap = null;
      beginHold();
      // False when the origin gate refused: nothing is holding, so no later
      // keyup should try to settle anything.
      spaceStartedHold = holding;
    }, SPACE_HOLD_ARM_MS);
  };
  const onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.code !== 'Space') return;
    if (armTimer) {
      // A tap: nothing started, so there is nothing to settle or report — but
      // the scroll held back at keydown is owed, and this is where it is paid.
      const tap = armedTap;
      disarm();
      if (tap) scrollPage(tap.target, tap.direction);
      return;
    }
    if (!spaceStartedHold) return;
    endHold();
  };
  const onBlur = (): void => {
    disarm();
    endHold();
  };
  const onPointerDown = (ev: Event): void => {
    ev.preventDefault();
    beginHold();
  };
  const onPointerEnd = (): void => endHold();

  /**
   * The same hold, from a keyboard, while the BUTTON has focus.
   *
   * `onPointerDown` calls `preventDefault()`, so a tap never focuses the mic —
   * and without this the button was reachable by Tab and did nothing at all,
   * while its label promised "hold to dictate". The board-wide Space hotkey is
   * not the answer: it routes the utterance to the agent, not into the box the
   * mic sits in, and the quick-add mount opts out of it entirely.
   *
   * Why this cannot resurrect the singleton-gesture bug `spaceHotkey` exists
   * to prevent: that bug is TWO captures starting on ONE press, because
   * `document` hears every press regardless of where focus is. These handlers
   * are bound to a BUTTON, which belongs to exactly one capture — so a press
   * can only ever reach its own instance, at most twice (at the target, then
   * bubbling to that instance's own document listener). `beginHold` returns
   * early while already holding and `endHold` while not, so the second pass is
   * a no-op rather than a second recognizer. Asserted in voice-capture.test.ts
   * by counting `start()` calls for one press with both bound.
   */
  const HOLD_KEYS: ReadonlySet<string> = new Set(['Space', 'Enter', 'NumpadEnter']);
  const onButtonKeyDown = (ev: KeyboardEvent): void => {
    if (!HOLD_KEYS.has(ev.code) || ev.repeat) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // Space scrolls the page; Enter fires the button's click. Neither is what
    // holding the mic means.
    ev.preventDefault();
    beginHold();
  };
  const onButtonKeyUp = (ev: KeyboardEvent): void => {
    if (!HOLD_KEYS.has(ev.code)) return;
    endHold();
  };
  // A key hold has the same two endings as a touch: the release, or focus
  // moving away mid-press — after which the keyup lands somewhere else and the
  // mic would stay open for the rest of the page load.
  const onButtonBlur = (): void => endHold();

  // Say up front that this origin can't record, so the mic doesn't read as a
  // working control. Deliberately NOT `disabled`: a disabled button swallows
  // the press, and the press is how someone gets the explanation. It stays
  // pressable and answers with the reason.
  const blockedAtMount = insecureOriginMessage(readOrigin());
  if (blockedAtMount) {
    button.classList.add('voice-unavailable');
    button.title = blockedAtMount;
    button.setAttribute('aria-label', blockedAtMount);
  }

  const spaceHotkey = opts.spaceHotkey ?? true;
  if (spaceHotkey) {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
  }
  window.addEventListener('blur', onBlur);
  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('pointerup', onPointerEnd);
  // The common ending on mobile: the system took the touch (scroll,
  // long-press menu). Settle exactly like a release.
  button.addEventListener('pointercancel', onPointerEnd);
  button.addEventListener('keydown', onButtonKeyDown);
  button.addEventListener('keyup', onButtonKeyUp);
  button.addEventListener('blur', onButtonBlur);

  return {
    holding: () => holding,
    destroy: () => {
      if (spaceHotkey) {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
      }
      window.removeEventListener('blur', onBlur);
      button.removeEventListener('pointerdown', onPointerDown);
      button.removeEventListener('pointerup', onPointerEnd);
      button.removeEventListener('pointercancel', onPointerEnd);
      button.removeEventListener('keydown', onButtonKeyDown);
      button.removeEventListener('keyup', onButtonKeyUp);
      button.removeEventListener('blur', onButtonBlur);
      disarm();
      if (clearTimer) clearTimeout(clearTimer);
      if (watchdog) clearTimeout(watchdog);
      try {
        rec?.stop();
      } catch {}
      rec = null;
    },
  };
}
