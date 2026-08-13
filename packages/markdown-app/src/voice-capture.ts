/**
 * Hold-to-talk voice capture (§2.4 / §3.8), shared by the hub, the doc
 * surface, and the task detail. Hold Space anywhere (never while typing) or
 * hold the mic button; dictation streams live into the indicator while held;
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

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable || target.closest('[contenteditable="true"]') !== null;
}

export function createVoiceCapture(opts: VoiceCaptureOpts): VoiceCapture {
  const { button, indicator } = opts;
  const createRecognition = opts.createRecognition ?? defaultRecognitionFactory;

  let holding = false;
  let rec: RecognitionLike | null = null;
  let transcript = '';
  let finalized = true;
  let clearTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

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
    rec.onerror = () => {
      // Errors surface at finalize time: an aborted engine still has
      // whatever transcript it managed, and an empty one answers honestly.
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
      show("Didn't catch anything.", { linger: true });
      return;
    }
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
    if (isTypingTarget(ev.target)) return;
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

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  button.addEventListener('pointerdown', onPointerDown);
  button.addEventListener('pointerup', onPointerEnd);
  // The common ending on mobile: the system took the touch (scroll,
  // long-press menu). Settle exactly like a release.
  button.addEventListener('pointercancel', onPointerEnd);

  return {
    holding: () => holding,
    destroy: () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      button.removeEventListener('pointerdown', onPointerDown);
      button.removeEventListener('pointerup', onPointerEnd);
      button.removeEventListener('pointercancel', onPointerEnd);
      if (clearTimer) clearTimeout(clearTimer);
      if (watchdog) clearTimeout(watchdog);
      try {
        rec?.stop();
      } catch {}
      rec = null;
    },
  };
}
