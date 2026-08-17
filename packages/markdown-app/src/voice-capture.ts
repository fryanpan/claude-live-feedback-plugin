/**
 * Hold-to-talk voice capture (§2.4 / §3.8), shared by the hub, the doc
 * surface, and the task detail. Hold Space anywhere (never while typing), hold
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
 */

export interface VoiceContext {
  surface: 'hub' | 'doc' | 'task';
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
}

export interface VoiceCapture {
  destroy(): void;
  holding(): boolean;
}

/** How long a terminal indicator message stays up. */
const INDICATOR_LINGER_MS = 6_000;
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

  const show = (text: string, opts2?: { linger?: boolean }): void => {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    indicator.textContent = text;
    indicator.classList.remove('hidden');
    if (opts2?.linger) {
      clearTimer = setTimeout(() => {
        indicator.classList.add('hidden');
      }, INDICATOR_LINGER_MS);
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
    show('Routing…');
    void opts.send(text, context).then((ack) => {
      if (!ack) {
        show('Voice request failed — try again.', { linger: true });
        return;
      }
      show(ack.ack, { linger: true });
      if (ack.navigate) opts.onNavigate?.(ack.navigate);
    });
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.code !== 'Space' || ev.repeat) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (typingInPath(eventPath(ev))) return;
    ev.preventDefault();
    beginHold();
  };
  const onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.code !== 'Space') return;
    endHold();
  };
  const onBlur = (): void => endHold();
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
      if (clearTimer) clearTimeout(clearTimer);
      if (watchdog) clearTimeout(watchdog);
      try {
        rec?.stop();
      } catch {}
      rec = null;
    },
  };
}
