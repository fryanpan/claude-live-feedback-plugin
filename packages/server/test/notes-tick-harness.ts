/**
 * A meeting, scripted: utterances in, the doc after every tick out.
 *
 * The notes pipeline is a pause ticker, a promise chain, an LLM seam, an
 * ownership ledger and a Yjs merge, and a test that wants to ask "what does
 * the doc look like after the third tick" had to assemble all five. So they
 * are assembled once here. A test says what was said and what the model
 * answers, and reads the doc back after each tick.
 *
 * WHY IT MATTERS MORE THAN THE USUAL HELPER. Almost everything worth knowing
 * about a note-taker is a statement about a SEQUENCE — the heading does not
 * move between ticks, a second section never appears, a point already made
 * does not get a new heading of its own. None of those can be seen in one
 * write, and all of them are cheap to see here.
 *
 * Every clock is the manual scheduler: no test waits out real quiet, for the
 * same reason the mock engine advances per chunk (testing-standards.md, 2).
 *
 * All fixtures are synthetic. The repo is public.
 */

import { type DocType, prose } from '@feedback/core';
import * as Y from 'yjs';
import { type NotesLedger, withServerNotesSinks } from '../src/meeting-notes-doc.ts';
import {
  type NotesComposeInput,
  type TickScheduler,
  beginNotesSession,
} from '../src/meeting-notes.ts';
import { MEETING_NOTES_HEADINGS, findNotesSection, itemsInSection } from '../src/notes-section.ts';
import { waitFor } from './wait-for.ts';

/**
 * A scheduler the test advances by hand. `fire()` runs whatever is armed,
 * shortest delay first — a real clock reaches the quiet threshold before the
 * cadence ceiling, and firing in the order timers happened to be set would let
 * the ceiling win a race it never wins in a meeting.
 */
export class ManualScheduler implements TickScheduler {
  private fns = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  set(fn: () => void, ms: number): unknown {
    this.n++;
    this.fns.set(this.n, { fn, ms });
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  get armed(): number {
    return this.fns.size;
  }
  fire(): void {
    const pending = [...this.fns.values()].sort((a, b) => a.ms - b.ms);
    this.fns.clear();
    for (const t of pending) t.fn();
  }
}

/** One utterance in a script: bare words, or words with a voice behind them. */
export type Utterance = string | { speaker: string; text: string };

/** The doc, and the tick's own inputs, immediately after that tick's write. */
export interface TickSnapshot {
  /** 1-based, per meeting. */
  tick: number;
  /** The whole doc as markdown. */
  markdown: string;
  /** Just the notes section's body, markdown. */
  notes: string;
  /** Every top-level heading, in order — the cheapest way to assert that a
   *  section did not move, get a twin, or gain a sibling. */
  headings: string[];
  /**
   * What the model was handed for this tick — UNDEFINED when no compose ran
   * for it.
   *
   * Optional because it really is optional: a tick whose compose was skipped
   * or coalesced settles with a doc and no input, and this field used to be
   * cast to non-null, which typechecked and then crashed a whole eval run
   * twelve minutes in. A caller reading it must handle the absence.
   */
  input?: NotesComposeInput;
  /** What it answered. */
  composed: string;
}

export interface NotesTickHarnessOptions {
  /** The doc before the meeting starts. Default: an empty doc. */
  doc?: string;
  /**
   * The fake model. Returns the WHOLE notes, the way the real composer does;
   * throw to script a failed compose. The tick number is 1-based.
   */
  compose: (input: NotesComposeInput, tick: number) => string | Promise<string>;
  /** Default `markdown`; pass a flat type to test the refusal path. */
  docType?: DocType;
  /** Share a ledger across two harnesses to model a second meeting on one doc. */
  ledger?: NotesLedger;
  docId?: string;
  meetingId?: string;
  docTitle?: string;
  /** The file the doc is bound to, if any — what decides whether the old
   *  note-taker could have written a transcript section here. Pair with
   *  `dataDir`. */
  boundPath?: string;
  /** The server's data dir, as that placement rule reads it. */
  dataDir?: string;
  /**
   * The board this meeting's doc belongs to. Wiring it is what turns on the
   * two stages that need a board: the task titles in the composer's context,
   * and the per-tick reference search. Absent, both are empty, which is the
   * huddle-with-no-board case every other script here runs in.
   */
  workspaceId?: string;
  /** The board's rows, as the task store would list them. */
  tasks?: Array<{ id?: string; title: string; status: string; kind?: 'task' | 'goal' }>;
  /** The board's other docs, as the lookup would list them. */
  boardDocs?: Array<{ docId: string; title: string; meetingAt?: number }>;
  /**
   * How long `tick()` waits for the write. The default suits a scripted
   * composer, which answers in microseconds; `notes-eval.ts` drives a REAL
   * model whose reply grows with the notes, and five seconds is not enough
   * by the twentieth tick of a meeting.
   */
  tickTimeoutMs?: number;
}

export interface NotesTickHarness {
  /** Settle these utterances as turns. Nothing is written until `tick()`. */
  say(...utterances: Utterance[]): void;
  /** Let the room fall quiet: fire the pause tick and wait for its write. */
  tick(): Promise<TickSnapshot>;
  /** `say` then `tick` — the ordinary unit of a script. */
  speak(...utterances: Utterance[]): Promise<TickSnapshot>;
  /** Stop the meeting and wait for the final compose. */
  end(): Promise<void>;
  /** Every snapshot so far, in order. */
  readonly snapshots: readonly TickSnapshot[];
  /** Errors the session reported — an empty list is part of most assertions. */
  readonly errors: readonly string[];
  readonly ydoc: Y.Doc;
  markdown(): string;
  notes(): string;
  headings(): string[];
  /** How many top-level headings read exactly `text`. The duplicate-section
   *  assertion, spelled once. */
  countHeadings(text: string): number;
}

export function createNotesTickHarness(opts: NotesTickHarnessOptions): NotesTickHarness {
  const docId = opts.docId ?? 'd-meeting';
  const meetingId = opts.meetingId ?? 'm1';
  const ydoc = new Y.Doc();
  if (opts.doc) prose.applyMarkdownToFragment(prose.getProseFragment(ydoc), opts.doc);
  const meta = {
    type: opts.docType ?? ('markdown' as DocType),
    ...(opts.docTitle ? { title: opts.docTitle } : {}),
  };
  const rooms = {
    get: (id: string) => (id === docId ? { ydoc, meta } : undefined),
    boundPathOf: (id: string) => (id === docId ? opts.boundPath : undefined),
  };

  const schedule = new ManualScheduler();
  const snapshots: TickSnapshot[] = [];
  const errors: string[] = [];
  const settled = new Map<number, { input: NotesComposeInput; composed: string }>();
  const done = new Set<number>();
  let turnNo = 0;
  let tickNo = 0;

  const deps = withServerNotesSinks(
    {
      composer: {
        name: 'scripted',
        async compose(input: NotesComposeInput): Promise<string> {
          const n = input.tick.tick;
          const composed = await opts.compose(input, n);
          settled.set(n, { input, composed });
          return composed;
        },
      },
      // Pause ticks only. A ceiling would fire on its own inside `fire()` and
      // turn a script's third tick into somebody else's second.
      cadenceMs: Number.POSITIVE_INFINITY,
      schedule,
      onError: (message) => errors.push(message),
      onTickLifecycle: (event) => {
        if (event.phase === 'written' || event.phase === 'failed') done.add(event.tick);
      },
    },
    {
      rooms: () => rooms,
      tasks: () => ({ listTasks: () => opts.tasks ?? [] }),
      ...(opts.workspaceId ? { boardOf: () => opts.workspaceId } : {}),
      ...(opts.boardDocs ? { lookup: { docs: () => opts.boardDocs ?? [] } } : {}),
      ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
      ...(opts.ledger ? { ledger: opts.ledger } : {}),
    },
  );
  const session = beginNotesSession(deps, { docId, meetingId });

  const markdown = (): string => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));

  const sectionBody = (heading: string | readonly string[]): string => {
    const fragment = prose.getProseFragment(ydoc);
    const span = findNotesSection(fragment, heading);
    if (!span) return '';
    const top = fragment.toArray() as Y.XmlElement[];
    const out: string[] = [];
    for (let i = span.start + 1; i < span.endExclusive; i++) {
      const md = prose.serializeBlockToMarkdown(top[i]!);
      if (md.length > 0) out.push(md);
    }
    return out.join('\n\n');
  };

  const headings = (): string[] => {
    const top = prose.getProseFragment(ydoc).toArray() as Y.XmlElement[];
    return top
      .filter((el) => el.nodeName === 'heading')
      .map((el) =>
        (prose.serializeBlockToMarkdown(el).split('\n', 1)[0] ?? '').replace(/^#+\s+/, ''),
      );
  };

  const snapshot = (tick: number): TickSnapshot => {
    const seen = settled.get(tick);
    return {
      tick,
      markdown: markdown(),
      notes: sectionBody(MEETING_NOTES_HEADINGS),
      headings: headings(),
      ...(seen?.input ? { input: seen.input } : {}),
      composed: seen?.composed ?? '',
    };
  };

  const harness: NotesTickHarness = {
    snapshots,
    errors,
    ydoc,
    markdown,
    notes: () => sectionBody(MEETING_NOTES_HEADINGS),
    headings,
    countHeadings: (text) => headings().filter((h) => h === text).length,
    say(...utterances) {
      for (const u of utterances) {
        const turn = turnNo++;
        const text = typeof u === 'string' ? u : u.text;
        const speaker = typeof u === 'string' ? undefined : u.speaker;
        // A partial first, then the settled turn: the ticker treats any frame
        // as speech in progress, which is how a real turn arrives.
        session.onTurn({ turn, text: text.slice(0, Math.max(1, text.length - 1)), final: false });
        session.onTurn({
          turn,
          text,
          final: true,
          ...(speaker !== undefined ? { speaker } : {}),
        });
      }
    },
    async tick() {
      const n = ++tickNo;
      schedule.fire();
      await waitFor(() => done.has(n), {
        describe: `notes tick ${n} to be written`,
        ...(opts.tickTimeoutMs !== undefined ? { timeout: opts.tickTimeoutMs } : {}),
      });
      const shot = snapshot(n);
      snapshots.push(shot);
      return shot;
    },
    async speak(...utterances) {
      harness.say(...utterances);
      return harness.tick();
    },
    async end() {
      await session.end();
    },
  };
  return harness;
}

/** The items the notes section currently holds, as markdown — the unit the
 *  merge works in, for a test that wants to count notes rather than lines. */
export function notesItems(ydoc: Y.Doc): string[] {
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSection(fragment, MEETING_NOTES_HEADINGS);
  return span ? itemsInSection(fragment, span).map((i) => i.md) : [];
}
