/**
 * The live-meeting transcript strip: a bar along the bottom of the editor pane
 * that owns the doc's audio socket and renders what is being heard.
 *
 * IT IS THE ONLY SURFACE A MEETING HAS. The transcript is never written into
 * the document — the notes agent does that later, from the durable transcript
 * the server keeps — so every state a meeting can be left in has to arrive as
 * words here: a mic that was refused, an origin the browser will not give a
 * mic on at all, a server with no transcription key. A strip that renders
 * nothing in those cases is a Start button that does nothing when pressed,
 * which is the failure this file exists to avoid.
 *
 * IT RESERVES HEIGHT. The strip is the editor pane's third grid row, so the
 * scrolling document is shorter by exactly its height rather than running
 * underneath it. Layout rules live in styles.css under MEETING TRANSCRIPT
 * STRIP and are asserted in `meeting-strip-css.test.ts`, because no DOM test
 * resolves layout.
 *
 * CORRECTIONS LAND ON THE WORD ALREADY ON SCREEN. A `transcript` frame carries
 * the WHOLE turn as currently understood, so a later frame for the same turn
 * is the engine revising itself. `diffTurnWords` finds which words actually
 * moved and only those are rewritten and flashed — redrawing the line instead
 * would make every partial look like a correction.
 */

import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  type MeetingServerMessage,
  type MeetingUnavailableReason,
  meetingSocketPath,
  speakerDisplayName,
} from '@feedback/core';
import {
  type MeetingCapture,
  type MeetingCaptureStart,
  startMeetingCapture,
} from './meeting-audio.ts';

/**
 * How many turns stay on the strip. Three is what fits the phone's two wrapped
 * lines; the bar shows the tail of the same three.
 */
export const TRANSCRIPT_KEEP = 3;

/** How often the elapsed clock is redrawn. Twice a second: a second-resolution
 *  readout that ticks once a second visibly stalls whenever the two clocks
 *  drift out of phase. */
const CLOCK_MS = 500;

export interface TranscriptTurn {
  turn: number;
  text: string;
  final: boolean;
  /** The engine's label for the voice; the tag shows the name given to it. */
  speaker?: string;
}

/**
 * Fold one transcript frame into the rolling window.
 *
 * A turn already on the strip is replaced WHERE IT IS — that is the whole
 * correction mechanism. A turn that has already rolled off is dropped rather
 * than re-added, because appending it would put an old line at the live end of
 * the strip, which reads as the speaker repeating themselves.
 */
export function rollTranscript(
  turns: readonly TranscriptTurn[],
  next: TranscriptTurn,
  keep = TRANSCRIPT_KEEP,
): TranscriptTurn[] {
  const at = turns.findIndex((t) => t.turn === next.turn);
  if (at >= 0) {
    const out = turns.slice();
    out[at] = next;
    return out;
  }
  const newest =
    turns.length > 0 ? Math.max(...turns.map((t) => t.turn)) : Number.NEGATIVE_INFINITY;
  if (next.turn < newest) return turns.slice();
  return [...turns, next].slice(-keep);
}

/**
 * Which words of a turn the engine actually changed.
 *
 * Compared by position, which is what makes "check list" → "checklist" read
 * correctly: the word count moved, so everything from the change onward is
 * genuinely different text in a different place. A word past the end of the
 * previous text is NEW, not corrected — flashing it would mean flashing every
 * word as it is spoken.
 */
export function diffTurnWords(
  before: string,
  after: string,
): Array<{ text: string; changed: boolean }> {
  const old = before.split(/\s+/).filter((w) => w.length > 0);
  return after
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((text, i) => ({ text, changed: i < old.length && old[i] !== text }));
}

/** mm:ss, zero-padded, counting past an hour rather than wrapping. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** Parse a server frame, returning null for anything malformed. */
export function parseMeetingServerMessage(raw: unknown): MeetingServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (m.type) {
    case 'ready':
      return {
        type: 'ready',
        meetingId: str(m.meetingId),
        startedAt: typeof m.startedAt === 'number' ? m.startedAt : 0,
        engine: str(m.engine),
      };
    case 'unavailable': {
      const reason = m.reason;
      if (
        reason !== 'not_configured' &&
        reason !== 'engine_unavailable' &&
        reason !== 'already_recording'
      ) {
        return null;
      }
      return { type: 'unavailable', reason, message: str(m.message) };
    }
    case 'transcript':
      if (typeof m.turn !== 'number' || typeof m.text !== 'string') return null;
      return {
        type: 'transcript',
        turn: m.turn,
        text: m.text,
        final: m.final === true,
        ...(typeof m.speaker === 'string' && m.speaker ? { speaker: m.speaker } : {}),
      };
    case 'stopped':
      return {
        type: 'stopped',
        meetingId: str(m.meetingId),
        endedAt: typeof m.endedAt === 'number' ? m.endedAt : 0,
      };
    case 'error':
      return { type: 'error', message: str(m.message) };
    default:
      return null;
  }
}

/** What the strip is showing. */
export type StripState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'unavailable'; reason: MeetingUnavailableReason; message: string }
  /** The browser will not hand over a mic: an insecure origin, or a refusal. */
  | { kind: 'blocked'; message: string }
  | { kind: 'error'; message: string };

/** The slice of a WebSocket the strip uses — injectable so every state above
 *  can be driven in a test without a server. */
export interface MeetingSocket {
  send(data: string | ArrayBufferView): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** The doc's audio socket on this host. Same scheme rule as the Yjs socket. */
export function meetingSocketUrl(docId: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${meetingSocketPath(docId)}`;
}

export interface MeetingStripOpts {
  docId: string;
  /** The shell element the strip renders into — `#meeting-strip`. */
  root: HTMLElement;
  now?: () => number;
  /** Run `fn` every `ms`; returns a canceller. Injectable so the clock is
   *  deterministic in tests. */
  interval?: (fn: () => void, ms: number) => () => void;
  openSocket?: (url: string) => MeetingSocket;
  startCapture?: (opts: { onFrame: (pcm: Int16Array) => void }) => Promise<MeetingCaptureStart>;
  /**
   * Ask for the mic on mount, without a press — the Board's "Start a planning
   * huddle" button was the press, on a page that is gone by the time this
   * mounts. A browser that wants the gesture INSIDE this page refuses the
   * mic exactly the way it refuses a real denial; the strip cannot tell them
   * apart, so it offers its one button as "Tap to start the mic" rather than
   * reporting a refusal nobody made. A tap is a gesture, so a refusal after
   * that is reported as what it is.
   */
  autoStart?: boolean;
  /**
   * Ask the person what to call a speaker; `current` is what the tag says
   * now. Null or blank means leave it. Defaults to `window.prompt` — the
   * strip is a 40px bar with no room for an inline field, and a name is
   * typed once per voice per meeting.
   */
  promptName?: (current: string) => string | null;
}

export interface MeetingStripHandle {
  destroy(): void;
  state(): StripState;
}

/** What to say when the server sends an `unavailable` with no message. */
function unavailableFallback(reason: MeetingUnavailableReason): string {
  switch (reason) {
    case 'not_configured':
      return 'Transcription is not configured on this server, so no words will appear.';
    case 'engine_unavailable':
      return 'The transcription engine is not answering right now.';
    case 'already_recording':
      return 'Another session is already recording this doc.';
  }
}

function defaultOpenSocket(url: string): MeetingSocket {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return ws as unknown as MeetingSocket;
}

function defaultInterval(fn: () => void, ms: number): () => void {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

function defaultPromptName(current: string): string | null {
  return window.prompt('Who is this?', current);
}

export function mountMeetingStrip(opts: MeetingStripOpts): MeetingStripHandle {
  const { docId, root } = opts;
  const now = opts.now ?? Date.now;
  const interval = opts.interval ?? defaultInterval;
  const openSocket = opts.openSocket ?? defaultOpenSocket;
  const startCapture = opts.startCapture ?? startMeetingCapture;
  const promptName = opts.promptName ?? defaultPromptName;

  const strip = document.createElement('div');
  strip.className = 'meeting-strip-row';
  const meta = document.createElement('span');
  meta.className = 'meeting-meta';
  const dot = document.createElement('span');
  dot.className = 'meeting-dot';
  dot.setAttribute('aria-hidden', 'true');
  const status = document.createElement('span');
  status.className = 'meeting-status';
  const elapsed = document.createElement('span');
  elapsed.className = 'meeting-elapsed';
  meta.append(dot, status, elapsed);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'meeting-toggle';
  strip.append(meta, toggle);

  const caption = document.createElement('div');
  caption.className = 'meeting-caption';
  caption.setAttribute('aria-live', 'polite');
  const line = document.createElement('p');
  line.className = 'meeting-caption-line';
  caption.append(line);

  root.classList.add('meeting-strip');
  root.replaceChildren(strip, caption);
  root.hidden = false;

  let state: StripState = { kind: 'idle' };
  let turns: TranscriptTurn[] = [];
  let capture: MeetingCapture | null = null;
  let socket: MeetingSocket | null = null;
  let socketOpen = false;
  let stopClock: (() => void) | null = null;
  let disposed = false;
  /**
   * Which attempt to start is the live one. A permission prompt can stay up
   * for as long as the person looks at it, and Stop (or a navigation, or a
   * second Start) during that window has to leave the mic that eventually
   * arrives with nowhere to go — otherwise it opens behind a strip that says
   * Paused.
   */
  let generation = 0;
  /** The auto-start was refused in the way a missing gesture is: the button
   *  is the tap that supplies one, and says so. Cleared by any press. */
  let tapToStart = false;

  /** Live word spans per turn, so a correction rewrites the span that is
   *  already on screen instead of redrawing the line under the reader. */
  const rendered = new Map<
    number,
    { span: HTMLElement; tag: HTMLButtonElement | null; words: HTMLElement[]; text: string }
  >();
  /**
   * Engine label → what the person calls that voice. Belongs to ONE meeting:
   * the engine hands out "A" afresh each session, so the map is emptied when
   * a meeting starts, never carried into the next.
   */
  let names: Record<string, string> = {};

  /** The tag every turn with this label wears, as it should read now. */
  function renderTag(entry: { tag: HTMLButtonElement | null }, label: string): void {
    const tag = entry.tag;
    if (!tag) return;
    const shown = speakerDisplayName(label, names);
    tag.dataset.speaker = label;
    tag.textContent = shown;
    tag.setAttribute('aria-label', `Name ${shown}`);
  }

  function nameSpeaker(label: string): void {
    const current = speakerDisplayName(label, names);
    const answer = promptName(current)?.trim() ?? '';
    if (!answer || answer === current) return;
    names[label] = answer;
    for (const entry of rendered.values()) {
      if (entry.tag?.dataset.speaker === label) renderTag(entry, label);
    }
    if (socketOpen) {
      socket?.send(JSON.stringify({ type: 'name_speaker', speaker: label, name: answer }));
    }
  }

  function renderCaption(): void {
    if (state.kind !== 'idle' && state.kind !== 'recording') return;
    // A note and a transcript share the line, so the reason the last attempt
    // gave has to go when words start arriving.
    line.querySelector('.meeting-note')?.remove();
    for (const [turn, entry] of rendered) {
      if (!turns.some((t) => t.turn === turn)) {
        entry.span.remove();
        rendered.delete(turn);
      }
    }
    for (const turn of turns) {
      let entry = rendered.get(turn.turn);
      if (!entry) {
        const span = document.createElement('span');
        span.className = 'meeting-turn';
        line.append(span);
        entry = { span, tag: null, words: [], text: '' };
        rendered.set(turn.turn, entry);
      }
      // The tag comes and goes with the label — the engine attributes a turn
      // once it has heard enough of it, and may reattribute it at the end.
      const label = turn.speaker;
      if (label === undefined) {
        entry.tag?.remove();
        entry.tag = null;
      } else {
        if (!entry.tag) {
          const tag = document.createElement('button');
          tag.type = 'button';
          tag.className = 'meeting-speaker';
          tag.title = 'Tap to name this speaker';
          tag.addEventListener('click', () => nameSpeaker(tag.dataset.speaker ?? ''));
          entry.span.prepend(tag);
          entry.tag = tag;
        }
        renderTag(entry, label);
      }
      if (entry.text === turn.text) continue;
      const words = diffTurnWords(entry.text, turn.text);
      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (!word) continue;
        let el = entry.words[i];
        if (!el) {
          el = document.createElement('span');
          el.className = 'w';
          entry.span.append(el);
          entry.words[i] = el;
        }
        // A leading space on every word, never a generated one: a ::before
        // cannot line-break, which on the phone's wrapped lines would pin a
        // word boundary mid-line. At the start of a line it collapses away.
        el.textContent = ` ${word.text}`;
        el.classList.remove('is-fixed');
        if (word.changed) {
          // Reading the box restarts the animation for a word corrected twice.
          void el.offsetWidth;
          el.classList.add('is-fixed');
        }
      }
      for (const extra of entry.words.splice(words.length)) extra.remove();
      entry.text = turn.text;
    }
  }

  function clearCaption(): void {
    rendered.clear();
    line.replaceChildren();
  }

  function showNote(text: string): void {
    clearCaption();
    const note = document.createElement('span');
    note.className = 'meeting-note';
    note.textContent = text;
    line.append(note);
  }

  function tickClock(): void {
    elapsed.textContent =
      state.kind === 'recording' ? formatElapsed(now() - state.startedAt) : formatElapsed(0);
  }

  function render(): void {
    root.dataset.state = state.kind;
    root.classList.toggle('is-live', state.kind === 'recording');
    // The visible label is one bare word in a strip that never says what it
    // is — the accessible name carries the feature's name instead.
    toggle.setAttribute(
      'aria-label',
      `${state.kind === 'recording' ? 'Stop' : 'Start'} meeting transcription`,
    );
    switch (state.kind) {
      case 'idle':
        status.textContent = 'Paused';
        toggle.textContent = 'Start';
        toggle.disabled = false;
        break;
      case 'requesting':
        status.textContent = 'Starting…';
        toggle.textContent = 'Start';
        toggle.disabled = true;
        showNote('Asking for the microphone…');
        break;
      case 'recording':
        status.textContent = 'REC';
        toggle.textContent = 'Stop';
        toggle.disabled = false;
        break;
      case 'unavailable':
        status.textContent = 'Off';
        toggle.textContent = 'Start';
        // Nothing is retrying and no key is going to appear on its own; the
        // other two reasons can clear without anyone editing a config.
        toggle.disabled = state.reason === 'not_configured';
        showNote(state.message || unavailableFallback(state.reason));
        break;
      case 'blocked':
      case 'error':
        status.textContent = 'Off';
        toggle.textContent = tapToStart ? 'Tap to start the mic' : 'Start';
        // Deliberately pressable: the press is how someone sees the reason
        // again after granting the permission the message named.
        toggle.disabled = false;
        showNote(tapToStart ? 'The huddle is on — the mic needs one tap to start.' : state.message);
        break;
    }
    tickClock();
    renderCaption();
  }

  function setState(next: StripState): void {
    state = next;
    if (next.kind === 'recording') {
      stopClock ??= interval(tickClock, CLOCK_MS);
    } else {
      stopClock?.();
      stopClock = null;
    }
    render();
  }

  function releaseAudio(): void {
    capture?.stop();
    capture = null;
  }

  function closeSocket(): void {
    const sock = socket;
    socket = null;
    socketOpen = false;
    if (!sock) return;
    // Handlers first: closing is a deliberate end, and an onclose that still
    // fired would report it as a dropped connection.
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
    sock.close();
  }

  function handle(msg: MeetingServerMessage | null): void {
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        setState({ kind: 'recording', startedAt: now() });
        break;
      case 'transcript':
        turns = rollTranscript(turns, {
          turn: msg.turn,
          text: msg.text,
          final: msg.final,
          ...(msg.speaker !== undefined ? { speaker: msg.speaker } : {}),
        });
        renderCaption();
        break;
      case 'unavailable':
        // The words are never coming, so the mic goes back rather than sitting
        // open behind a settled state.
        releaseAudio();
        closeSocket();
        setState({ kind: 'unavailable', reason: msg.reason, message: msg.message });
        break;
      case 'stopped':
        releaseAudio();
        closeSocket();
        setState({ kind: 'idle' });
        break;
      case 'error':
        releaseAudio();
        closeSocket();
        setState({ kind: 'error', message: msg.message || 'The meeting ended unexpectedly.' });
        break;
    }
  }

  async function start(auto = false): Promise<void> {
    if (state.kind === 'requesting' || state.kind === 'recording') return;
    const attempt = ++generation;
    turns = [];
    names = {};
    tapToStart = false;
    setState({ kind: 'requesting' });
    const started = await startCapture({
      onFrame: (pcm) => {
        if (socketOpen) socket?.send(pcm);
      },
    });
    if (disposed || attempt !== generation) {
      if (started.ok) started.capture.stop();
      return;
    }
    if (!started.ok) {
      // Only a DENIAL can be a missing gesture; an insecure origin gives no
      // mic to any press, and says so.
      tapToStart = auto && started.kind === 'denied';
      setState({ kind: 'blocked', message: started.message });
      return;
    }
    capture = started.capture;
    const sock = openSocket(meetingSocketUrl(docId));
    socket = sock;
    sock.onopen = () => {
      socketOpen = true;
      // Opening the socket IS starting the meeting; this frame only tells the
      // server what shape the audio behind it will be.
      sock.send(
        JSON.stringify({
          type: 'start',
          sampleRate: MEETING_SAMPLE_RATE,
          encoding: MEETING_AUDIO_ENCODING,
        }),
      );
    };
    sock.onmessage = (ev) => handle(parseMeetingServerMessage(ev.data));
    sock.onclose = () => {
      socketOpen = false;
      releaseAudio();
      setState({ kind: 'error', message: 'The connection to the meeting was lost.' });
    };
    // `error` is always followed by `close`; reporting both would overwrite the
    // message with itself.
    sock.onerror = null;
  }

  function stop(): void {
    generation += 1;
    if (socketOpen) socket?.send(JSON.stringify({ type: 'stop' }));
    releaseAudio();
    closeSocket();
    setState({ kind: 'idle' });
  }

  const onToggle = (): void => {
    if (state.kind === 'recording' || state.kind === 'requesting') stop();
    else void start();
  };
  toggle.addEventListener('click', onToggle);

  render();
  if (opts.autoStart) void start(true);

  return {
    state: () => state,
    destroy: () => {
      disposed = true;
      generation += 1;
      toggle.removeEventListener('click', onToggle);
      releaseAudio();
      closeSocket();
      stopClock?.();
      stopClock = null;
      clearCaption();
      root.classList.remove('is-live');
      root.hidden = true;
      root.removeAttribute('data-state');
      root.replaceChildren();
    },
  };
}
