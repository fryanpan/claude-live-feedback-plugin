/**
 * The provisional zone: the live transcript rendered at the END of the doc,
 * where the notes it will become are about to land — instead of only in the
 * strip under the top bar, a viewport away from the writing.
 *
 * WHAT IT IS NOT. The transcript never enters the document — that invariant
 * belongs to the meeting pipeline (the notes agent writes the doc, from the
 * durable transcript, at pauses). This zone is chrome APPENDED AFTER the
 * editor's content element: plain DOM, no Yjs, gone without trace when the
 * meeting ends. Nothing here can leak a provisional word into the record.
 *
 * WHAT IT SHOWS (approved mock, provisional-text-mock-1): a dashed block
 * labelled "Live transcript", one line per turn, each led by its own meeting
 * time (04:18) — the moment that turn was first heard. When a tick fires,
 * the settled lines SPLIT OFF into a card above the stream ("Writing this
 * into the notes above…", with a spinner) while the remainder keeps
 * streaming; when the note lands, the card's lines leave the zone — the
 * settle wash on the freshly written note (settle-wash.ts) is what carries
 * the eye upward. No status lights, no blinking dots; the one animated thing
 * in the stream is the caret on the line still being spoken.
 *
 * Speaker pills follow the notes rule, not the strip's: only once a second
 * voice has actually been heard. A solo huddle's own name on every line is
 * noise (owner's call, 2026-08-31).
 */

/** One transcript turn as the zone tracks it. */
export interface LiveZoneTurn {
  turn: number;
  text: string;
  final: boolean;
  /** The engine's label for the voice ("A"); display goes through names. */
  speaker?: string;
}

/** A `notes_progress` frame, already parsed. */
export interface LiveZoneProgress {
  tick: number;
  phase: 'composing' | 'written' | 'failed';
  turns: readonly number[];
}

export interface MeetingLiveZone {
  /** A meeting is live; `startedAtMs` anchors the per-line timestamps. */
  begin(startedAtMs: number): void;
  onTurn(t: LiveZoneTurn): void;
  onProgress(e: LiveZoneProgress): void;
  /** The strip's label→name map, re-sent whenever a voice is (re)named. */
  setNames(names: Readonly<Record<string, string>>): void;
  /**
   * Fallback for meetings without progress frames (a bot's words arrive over
   * the doc stream): notes just landed remotely, so every settled line has
   * been written — drop them, keep the one still being spoken.
   */
  clearSettled(): void;
  /** The meeting ended, however it ended: hide and forget everything. */
  end(): void;
  /** Whether a live meeting currently owns the zone. */
  active(): boolean;
  /**
   * Whether the settle wash should still fire (settle-wash.ts's `isLive`):
   * during the meeting, and for a short grace after it ends — the end tick's
   * note is composed asynchronously and lands seconds after `stopped`.
   */
  washActive(): boolean;
  destroy(): void;
}

/** How long after a meeting ends its last note may still earn the wash. */
export const WASH_GRACE_MS = 30_000;

/** mm:ss into the meeting; the anchor is `begin`'s startedAt. */
function stamp(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

interface ZoneTurn {
  turn: number;
  text: string;
  final: boolean;
  speaker?: string;
  /** Meeting time this turn was FIRST heard — revisions keep the moment. */
  atMs: number;
  /** Set while a tick that carries this turn is composing. */
  composing: boolean;
}

/** How far below the pane's visible edge the zone's bottom may sit and
 *  still count as "in view" — a scroll that leaves it within this is not a
 *  scroll away from it. */
export const FOLLOW_SLACK_PX = 48;
/** Breathing room kept under the zone when it is scrolled into view. */
const FOLLOW_PAD_PX = 12;

export function createMeetingLiveZone(opts: {
  /** Rendered as `parent`'s last child — after the editor's content. */
  parent: HTMLElement;
  /**
   * The editor's content element. The zone copies its width exactly: in the
   * balloon-margin grid the prose shrink-wraps to its widest line (auto
   * margins in a grid cell), a width no stylesheet rule can coincide with.
   */
  prose?: HTMLElement;
  /** The scroll pane the zone is kept in view within. Defaults to `parent`. */
  scroller?: HTMLElement;
  now?: () => number;
}): MeetingLiveZone {
  const now = opts.now ?? (() => Date.now());
  const scroller = opts.scroller ?? opts.parent;

  const root = document.createElement('div');
  root.className = 'live-zone';
  root.hidden = true;
  root.setAttribute('aria-live', 'off');

  const head = document.createElement('div');
  head.className = 'lz-head';
  const label = document.createElement('span');
  label.className = 'lz-label';
  label.textContent = 'Live transcript';
  head.append(label);

  const chunk = document.createElement('div');
  chunk.className = 'lz-chunk';
  chunk.hidden = true;
  const chunkLines = document.createElement('div');
  chunkLines.className = 'lz-chunk-lines';
  const chunkNote = document.createElement('div');
  chunkNote.className = 'lz-chunk-note';
  const spinner = document.createElement('span');
  spinner.className = 'lz-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  chunkNote.append(spinner, 'Writing this into the notes above…');
  chunk.append(chunkLines, chunkNote);

  const lines = document.createElement('div');
  lines.className = 'lz-lines';

  root.append(head, chunk, lines);
  opts.parent.append(root);

  let live = false;
  let endedAt = 0;
  let startedAt = 0;
  let names: Readonly<Record<string, string>> = {};
  const turns = new Map<number, ZoneTurn>();
  /** Voices actually heard — two of them is what turns the pills on. */
  const voices = new Set<string>();

  const ordered = (): ZoneTurn[] => [...turns.values()].sort((a, b) => a.turn - b.turn);

  /**
   * Follow mode: the zone is kept in view as it grows — the transcript is
   * what the person is watching. Off the moment they scroll it out of view
   * (a deliberate scroll up to read or edit is never fought), on again once
   * they scroll back to it. Decided from where the zone IS after each
   * scroll, so the zone's own scrolling always lands in "following".
   */
  let follow = true;

  /** Pixels the zone's bottom (plus padding) sits below the pane's visible
   *  edge; ≤ 0 means in view. Null while the zone is hidden. */
  function overflowBelow(): number | null {
    if (root.hidden) return null;
    const visibleBottom = scroller.getBoundingClientRect().top + scroller.clientHeight;
    return root.getBoundingClientRect().bottom + FOLLOW_PAD_PX - visibleBottom;
  }
  const onScroll = (): void => {
    const over = overflowBelow();
    if (over !== null) follow = over <= FOLLOW_SLACK_PX;
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  function keepInView(): void {
    if (!follow) return;
    const over = overflowBelow();
    if (over !== null && over > 0) scroller.scrollTop += over;
  }

  function matchProseWidth(): void {
    if (!opts.prose || root.hidden) return;
    const width = opts.prose.getBoundingClientRect().width;
    root.style.width = width > 0 ? `${width}px` : '';
  }
  // The prose changes size as notes land (taller, and wider when a new line
  // is the longest): re-match the width, and follow the zone down.
  const resize =
    typeof ResizeObserver === 'undefined' || !opts.prose
      ? null
      : new ResizeObserver(() => {
          matchProseWidth();
          keepInView();
        });
  if (opts.prose) resize?.observe(opts.prose);

  function lineFor(t: ZoneTurn): HTMLElement {
    const line = document.createElement('div');
    line.className = t.final ? 'lz-line' : 'lz-line lz-partial';
    const ts = document.createElement('span');
    ts.className = 'lz-ts';
    ts.textContent = stamp(t.atMs);
    line.append(ts);
    if (t.speaker !== undefined && voices.size >= 2) {
      const pill = document.createElement('span');
      pill.className = 'lz-speaker';
      pill.textContent = names[t.speaker] ?? `Speaker ${t.speaker}`;
      line.append(pill);
    }
    const text = document.createElement('span');
    text.className = 'lz-text';
    text.textContent = t.text;
    line.append(text);
    return line;
  }

  function render(): void {
    if (!live) {
      root.hidden = true;
      return;
    }
    const all = ordered();
    const splitting = all.filter((t) => t.composing);
    const streaming = all.filter((t) => !t.composing);
    root.hidden = all.length === 0;
    chunk.hidden = splitting.length === 0;
    chunkLines.replaceChildren(...splitting.map(lineFor));
    lines.replaceChildren(...streaming.map(lineFor));
    matchProseWidth();
    keepInView();
  }

  return {
    begin(startedAtMs) {
      live = true;
      follow = true;
      startedAt = startedAtMs;
      turns.clear();
      voices.clear();
      render();
    },
    onTurn(t) {
      if (!live) return;
      if (t.speaker !== undefined) voices.add(t.speaker);
      const known = turns.get(t.turn);
      turns.set(t.turn, {
        turn: t.turn,
        text: t.text,
        final: t.final,
        ...(t.speaker !== undefined ? { speaker: t.speaker } : {}),
        atMs: known ? known.atMs : now() - startedAt,
        composing: known?.composing ?? false,
      });
      render();
    },
    onProgress(e) {
      if (!live) return;
      if (e.phase === 'composing') {
        for (const id of e.turns) {
          const t = turns.get(id);
          if (t) t.composing = true;
        }
      } else if (e.phase === 'written') {
        // The note is in the doc; the settle wash up there takes over.
        for (const id of e.turns) turns.delete(id);
      } else {
        // Failed: the tick's words are carried into the next tick — they are
        // still provisional, so they return to the stream.
        for (const id of e.turns) {
          const t = turns.get(id);
          if (t) t.composing = false;
        }
      }
      render();
    },
    setNames(next) {
      names = next;
      render();
    },
    clearSettled() {
      if (!live) return;
      for (const [id, t] of turns) {
        if (t.final) turns.delete(id);
      }
      render();
    },
    end() {
      if (live) endedAt = now();
      live = false;
      turns.clear();
      voices.clear();
      render();
    },
    active: () => live,
    washActive: () => live || (endedAt > 0 && now() - endedAt < WASH_GRACE_MS),
    destroy() {
      live = false;
      resize?.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      root.remove();
    },
  };
}
