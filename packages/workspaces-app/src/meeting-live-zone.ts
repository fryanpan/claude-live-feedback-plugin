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
 * WHAT IT SHOWS: an unframed block, labelled "Live transcript" in its top
 * right corner, holding ONE flowing run of text. The engine hands words over
 * in turns of a few words every few seconds, and a turn is the engine's
 * unit, not the reader's (owner, 2026-09-01: "engine turns have no meaning
 * or value to the viewer, I expect a stream of text"). So turns are inline
 * spans joined by a space — no per-turn time stamp, no per-turn block — and
 * the only line breaks are the ones the engine itself put in a turn's text.
 * No status lights, no blinking dots; the one animated thing in the stream
 * is the caret on the words still being spoken.
 *
 * THE SETTLE (approved settle mock, round 2). When a tick fires the
 * settled words split off into a block of their own, so their height can be
 * collapsed later. That block carries no box, no label and no type change,
 * so its words land on the very pixels they were already on, and whatever is
 * still being said keeps streaming below it. When the note lands, those
 * words FADE WHERE THEY SIT — opacity alone, so not one word around them
 * moves — and only once they are gone does the slot collapse and ease the
 * stream up into the space. Two beats, never overlapping: the complaint was
 * drift, and every simultaneous movement is a source of it. The settle wash
 * on the freshly written note (settle-wash.ts) carries the eye upward.
 *
 * Nothing is drawn in the chunk's place while it composes — no card, no
 * "Writing this into the notes above…" line, no spinner. Both of those took
 * up space and shifted the words they wrapped (owner, 2026-09-05: "just fade
 * the text chunk out when it's written up into the text").
 *
 * Speaker pills follow the notes rule, not the strip's: only once a second
 * voice has actually been heard, and then only where the voice CHANGES — a
 * pill on every few words of one speaker is the engine's turn boundary
 * showing through again. A solo huddle's own name is noise (owner's call,
 * 2026-08-31).
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
  /** A meeting is live. `startedAtMs` is the meeting clock's anchor; the
   *  zone no longer stamps turns with it, and takes it so a caller that has
   *  it need not change. */
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

/**
 * The settle's two beats. The chunk fades where it sits, and only then does
 * its slot collapse.
 *
 * doc.css owns the same two numbers as `--lz-fade-ms` / `--lz-collapse-ms`,
 * because the transitions are CSS; these are what the JS waits for between
 * beats. live-zone-css.test.ts fails if the pair ever disagrees.
 */
export const FADE_MS = 260;
export const COLLAPSE_MS = 440;

/**
 * How long the settled chunk holds — height pinned, fully visible — after
 * its note is reported written, before the fade starts.
 *
 * The `written` frame and the note's own Yjs update reach the client over
 * two different channels, so the note can land a beat AFTER the frame.
 * Fading on the frame let the arriving note push the fading words down the
 * page: 28 measured pixels of drift in the mock, and the second source of
 * the movement this change exists to remove. The note lands, the page
 * settles, then the fade starts. One motion at a time.
 */
export const NOTE_LAND_MS = 420;

interface ZoneTurn {
  turn: number;
  text: string;
  final: boolean;
  speaker?: string;
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
  /**
   * Whether the viewer asked for reduced motion. Reads the media query by
   * default; injected by tests, which have no media engine to read.
   */
  reducedMotion?: () => boolean;
}): MeetingLiveZone {
  const now = opts.now ?? (() => Date.now());
  const scroller = opts.scroller ?? opts.parent;
  const reducedMotion =
    opts.reducedMotion ??
    (() =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);

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

  // Holds the settled chunks: the one a tick is composing, plus any still
  // fading out behind it. A container, not a surface — the sheet gives it
  // nothing, so it adds no box and no space of its own.
  const chunkHost = document.createElement('div');
  chunkHost.className = 'lz-chunks';

  const lines = document.createElement('div');
  lines.className = 'lz-lines';

  root.append(head, chunkHost, lines);
  opts.parent.append(root);

  let live = false;
  let endedAt = 0;
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

  /**
   * One turn as an inline span. The text's own newlines — the only breaks
   * the engine ever emits — become <br>s; nothing else in a turn is a line.
   */
  function spanFor(t: ZoneTurn, prev: ZoneTurn | null): HTMLElement {
    const span = document.createElement('span');
    span.className = t.final ? 'lz-turn' : 'lz-turn lz-partial';
    if (t.speaker !== undefined && voices.size >= 2 && t.speaker !== prev?.speaker) {
      const pill = document.createElement('span');
      pill.className = 'lz-speaker';
      pill.textContent = names[t.speaker] ?? `Speaker ${t.speaker}`;
      span.append(pill);
    }
    const parts = t.text.split('\n');
    for (const [i, part] of parts.entries()) {
      if (i > 0) span.append(document.createElement('br'));
      if (part) span.append(part);
    }
    return span;
  }

  /** The turns as one run: spans with a single space between them. */
  function runOf(ts: readonly ZoneTurn[]): Node[] {
    const out: Node[] = [];
    ts.forEach((t, i) => {
      if (i > 0) out.push(document.createTextNode(' '));
      out.push(spanFor(t, ts[i - 1] ?? null));
    });
    return out;
  }

  /** A split-off chunk: the block its words were lifted into, and the timer
   *  carrying it through the settle. */
  interface Chunk {
    slot: HTMLElement;
    body: HTMLElement;
    timer: ReturnType<typeof setTimeout> | null;
  }
  /** The chunk a tick is composing, if one is. */
  let openChunk: Chunk | null = null;
  /** Chunks whose note has landed and that are fading / collapsing out. */
  const settling = new Set<Chunk>();

  function mountChunk(): Chunk {
    const slot = document.createElement('div');
    slot.className = 'lz-slot';
    const body = document.createElement('div');
    // The chunk and the stream are typographically the SAME text: `lz-chunk`
    // adds the fade and nothing else — no size, no colour, no box — or
    // splitting one off would move the words it holds.
    body.className = 'lz-chunk lz-chunk-lines';
    slot.append(body);
    chunkHost.append(slot);
    return { slot, body, timer: null };
  }

  function step(c: Chunk, ms: number, fn: () => void): void {
    c.timer = setTimeout(() => {
      c.timer = null;
      fn();
    }, ms);
  }

  function discard(c: Chunk): void {
    if (c.timer !== null) clearTimeout(c.timer);
    c.timer = null;
    settling.delete(c);
    c.slot.remove();
  }

  /** Fade the chunk out where it stands, then collapse the space it held. */
  function settle(c: Chunk): void {
    settling.add(c);
    // Pin the height BEFORE anything animates: from here nothing this chunk
    // does can move a word below it, for the whole of the fade.
    c.slot.style.height = `${c.slot.getBoundingClientRect().height}px`;
    const reduced = reducedMotion();
    step(c, NOTE_LAND_MS, () => {
      c.body.classList.add('is-fading');
      step(c, FADE_MS, () => {
        // Reduced motion keeps the cross-fade and loses only the travel
        // (owner, 2026-09-05: the instant swap "was too sudden"). Less
        // movement, not none.
        if (reduced) c.slot.style.setProperty('--lz-collapse-ms', '0ms');
        c.slot.classList.add('is-collapsing');
        void c.slot.offsetHeight; // flush, so the height below transitions
        c.slot.style.height = '0px';
        step(c, reduced ? 0 : COLLAPSE_MS, () => {
          discard(c);
          render();
        });
      });
    });
  }

  /** Drop every chunk on the floor, mid-settle or not: the meeting is over,
   *  restarting, or the zone is going away. */
  function clearChunks(): void {
    for (const c of [...settling]) discard(c);
    if (openChunk) {
      openChunk.slot.remove();
      openChunk = null;
    }
  }

  function render(): void {
    if (!live) {
      root.hidden = true;
      return;
    }
    const all = ordered();
    const splitting = all.filter((t) => t.composing);
    const streaming = all.filter((t) => !t.composing);
    // A chunk mid-settle still has words on screen after its turns are gone.
    root.hidden = all.length === 0 && settling.size === 0;
    if (splitting.length > 0) {
      openChunk ??= mountChunk();
      openChunk.body.replaceChildren(...runOf(splitting));
    } else if (openChunk) {
      // A failed tick returns its words to the stream, so the block they
      // were lifted into goes with no animation — nothing settled.
      openChunk.slot.remove();
      openChunk = null;
    }
    lines.replaceChildren(...runOf(streaming));
    matchProseWidth();
    keepInView();
  }

  return {
    begin() {
      live = true;
      follow = true;
      clearChunks();
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
        // The note is in the doc; the settle wash up there takes over. The
        // words do NOT leave with their turns — the block holding them is
        // handed to the settle, which fades them where they sit and only
        // then collapses the space.
        for (const id of e.turns) turns.delete(id);
        const done = openChunk;
        openChunk = null;
        if (done) settling.add(done); // before render, or the zone hides
        render();
        if (done) settle(done);
        return;
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
      clearChunks();
      turns.clear();
      voices.clear();
      render();
    },
    active: () => live,
    washActive: () => live || (endedAt > 0 && now() - endedAt < WASH_GRACE_MS),
    destroy() {
      live = false;
      clearChunks();
      resize?.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      root.remove();
    },
  };
}
