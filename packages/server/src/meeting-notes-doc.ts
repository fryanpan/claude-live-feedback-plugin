/**
 * Where composed meeting notes LAND: a named section inside the meeting's
 * own doc, plus the server-side glue that joins the composer to the doc and
 * the project to the composer.
 *
 * THE WRITE GOES THROUGH THE FRAGMENT, NEVER THE FILESYSTEM. A meeting doc
 * is a live bound doc: a file write would be clobbered by the next flush
 * (see the editing-review-docs contract), while a Yjs transaction is an
 * ordinary agent edit — every open browser sees it within a tick, and the
 * write-back observer flushes it to disk like any other.
 *
 * THE SECTION IS FOUND BY ITS HEADING, EVERY TIME. The composer returns the
 * whole notes, so each update must REPLACE the previous section rather than
 * grow the doc — and an anchor or offset would rot the moment a human edits
 * around it. The heading is re-located per write, so the section survives
 * being moved, and a human's edits INSIDE it last until the next tick
 * rewrites the section (the transcript file is the durable record; the
 * notes are a live view).
 *
 * A RENAME REWRITES THE NOTES ALREADY WRITTEN, and does it as a TARGETED
 * replacement rather than a section rewrite (owner, 2026-08-29: "rewrite
 * them" — he does not want the same person reading as "Speaker B" above a
 * rename and by name below it). `relabelNotesSection` replaces only the
 * exact token the composer put there ("Speaker B"), only inside the notes
 * section, and touches nothing else in the doc.
 *
 * It deliberately does NOT go through `replaceNotesSection`. That path
 * replaces the whole section with a string this module composed, which would
 * discard whatever the human had typed inside it since the last tick — and
 * the notes agent overwriting his writing is already a known injury. A
 * rename is a two-word correction and must cost no more than two words.
 */

import { type DocType, contentKind, prose } from '@feedback/core';
import type * as Y from 'yjs';
import {
  type MeetingNotesDeps,
  type MeetingNotesOptions,
  type NotesProjectContext,
  type NotesRelabel,
  type NotesUpdate,
  extendsWord,
} from './meeting-notes.ts';
import { type TaskCaptureBoard, runTaskCapture } from './meeting-task-capture.ts';

/** The section the notes agent owns, verbatim — finding it again is the
 *  replace contract, so this string changing would orphan every live doc's
 *  section mid-meeting. */
export const MEETING_NOTES_HEADING = 'Meeting notes';

/** Enough names to inform the composer; few enough that a thousand-row board
 *  cannot flood the prompt. */
const MAX_CONTEXT_TASKS = 30;

export interface ReplaceNotesResult {
  ok: boolean;
  error?: 'empty' | 'parse-failed';
  /** `replaced` when the section existed, `appended` on its first write. */
  mode?: 'replaced' | 'appended';
}

/** The heading's text, read the same way the serializer would render it. */
function headingText(el: Y.XmlElement): string {
  const line = prose.serializeBlockToMarkdown(el).split('\n', 1)[0] ?? '';
  return line.replace(/^#{1,6}\s+/, '').trim();
}

/**
 * Replace the notes section with `notesMarkdown`, or append it at the end of
 * the doc on the first write. The span replaced is heading-to-heading — from
 * the notes heading up to the next heading at the same or a higher level —
 * exactly the span `deleteSection` would take. One transaction, so no
 * browser ever renders the gap between the delete and the insert.
 */
export function replaceNotesSection(
  ydoc: Y.Doc,
  notesMarkdown: string,
  heading: string = MEETING_NOTES_HEADING,
): ReplaceNotesResult {
  if (!notesMarkdown.trim()) return { ok: false, error: 'empty' };
  // The heading is the replace contract: a payload without it would land
  // once and then be unfindable, so the NEXT write would append a second
  // section. Enforced here — the one place every notes write passes through.
  const withHeading = startsWithHeading(notesMarkdown, heading)
    ? notesMarkdown
    : `## ${heading}\n\n${notesMarkdown}`;
  let blocks: Y.XmlElement[];
  try {
    blocks = prose.parseMarkdownBlocks(demoteBodyHeadings(withHeading));
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  if (blocks.length === 0) return { ok: false, error: 'empty' };

  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSectionSpan(fragment, heading);

  if (!span) {
    ydoc.transact(() => {
      fragment.insert(fragment.length, blocks);
    }, 'agent');
    return { ok: true, mode: 'appended' };
  }

  ydoc.transact(() => {
    fragment.delete(span.start, span.endExclusive - span.start);
    fragment.insert(span.start, blocks);
  }, 'agent');
  return { ok: true, mode: 'replaced' };
}

/** Where the notes section sits in the top-level fragment: the heading's own
 *  index, and the first index past its body (the next heading at the same or
 *  a higher level, or the end of the doc). Null when the heading is absent —
 *  which is the "never written yet" state, not a failure. */
function findNotesSectionSpan(
  fragment: Y.XmlFragment,
  heading: string,
): { start: number; endExclusive: number } | null {
  const top = fragment.toArray() as Y.XmlElement[];
  let start = -1;
  let level = 0;
  for (let i = 0; i < top.length; i++) {
    const el = top[i]!;
    if (el.nodeName !== 'heading') continue;
    if (headingText(el) !== heading) continue;
    start = i;
    level = prose.headingLevelOf(el);
    break;
  }
  if (start < 0) return null;

  let endExclusive = top.length;
  for (let i = start + 1; i < top.length; i++) {
    const el = top[i]!;
    if (el.nodeName !== 'heading') continue;
    if (prose.headingLevelOf(el) <= level) {
      endExclusive = i;
      break;
    }
  }
  return { start, endExclusive };
}

export interface RelabelNotesResult {
  /** How many occurrences were rewritten. Zero is an ordinary answer: the
   *  notes may not mention that voice, or may not exist yet. */
  replaced: number;
  /** Matches that straddled two Y.XmlText nodes and were left alone. A
   *  count the caller cannot see is a stale label nobody knows about. */
  skippedCrossNode?: number;
}

/**
 * Rewrite `from` to `to` inside the notes section only — the rename made
 * retroactive across notes already composed.
 *
 * SCOPED THREE WAYS, because this runs on a doc a human is writing in:
 *  1. Only inside the notes section, and never its heading. Prose the human
 *     wrote elsewhere in the doc cannot be reached from here, whatever it
 *     says.
 *  2. Only the exact token, on word boundaries — the string this module's
 *     own composer put there ("Speaker B"), not a substring of one.
 *  3. In place, character-for-character, carrying each site's marks. The
 *     surrounding sentence is not re-composed, re-parsed, or replaced, so a
 *     sentence the human edited into the section keeps every other word.
 */
export function relabelNotesSection(
  ydoc: Y.Doc,
  from: string,
  to: string,
  heading: string = MEETING_NOTES_HEADING,
): RelabelNotesResult {
  if (!from || !to || from === to) return { replaced: 0 };
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSectionSpan(fragment, heading);
  if (!span) return { replaced: 0 };

  const top = fragment.toArray() as Y.XmlElement[];
  // From start + 1: the heading is the replace contract's own anchor and
  // holds no speaker, so it is never eligible.
  const inSection = new Set<unknown>(top.slice(span.start + 1, span.endExclusive));
  if (inSection.size === 0) return { replaced: 0 };

  const { matches, crossNode, plainText } = prose.locateMatches(fragment, { find: from });
  const kept = matches.filter((m) => {
    if (!inSection.has(m.segment.topBlock)) return false;
    if (extendsWord(plainText[m.docOffset - 1])) return false;
    if (extendsWord(plainText[m.docOffset + m.length])) return false;
    return true;
  });
  if (kept.length === 0) {
    return { replaced: 0, ...(crossNode > 0 ? { skippedCrossNode: crossNode } : {}) };
  }

  ydoc.transact(() => {
    // Descending, for the reason findAndReplace's sweep is: every offset not
    // yet used stays valid because edits only land at or above the next site.
    for (let i = kept.length - 1; i >= 0; i--) {
      const m = kept[i]!;
      const siteMarks = prose.coveringInlineMarks([
        { node: m.segment.node, offset: m.offsetInNode, length: m.length },
      ]);
      m.segment.node.delete(m.offsetInNode, m.length);
      prose.insertTextWithMarks(m.segment.node, m.offsetInNode, to, {
        attributes: siteMarks.attributes,
      });
    }
  }, 'agent');

  return { replaced: kept.length, ...(crossNode > 0 ? { skippedCrossNode: crossNode } : {}) };
}

/**
 * Demote every heading AFTER the first line to at least level 3, so nothing
 * inside the section sits at the section heading's own level. The replace
 * span above runs heading-to-next-heading at the same or a higher level; a
 * body heading at level 2 — the stub's `## Notes`, a model ignoring the
 * "### subheadings" instruction — would end that span early, and every later
 * write would leave the previous body behind, duplicating the notes once per
 * pause for the length of the meeting.
 */
function demoteBodyHeadings(markdown: string): string {
  let fenced = false;
  let seenSectionHeading = false;
  return markdown
    .split('\n')
    .map((line) => {
      // A fence marker flips the state; heading-looking lines inside a code
      // block are code, not structure.
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const m = line.match(/^#{1,2}\s+(.*)$/);
      if (!m) return line;
      // The first heading IS the section heading — the one the replace
      // contract finds again. Everything after it is body.
      if (!seenSectionHeading) {
        seenSectionHeading = true;
        return line;
      }
      return `### ${m[1]}`;
    })
    .join('\n');
}

function startsWithHeading(markdown: string, heading: string): boolean {
  const first = markdown.trimStart().split('\n', 1)[0] ?? '';
  const m = first.match(/^#{1,6}\s+(.*)$/);
  return m?.[1]?.trim() === heading;
}

/** The slice of `Rooms` the notes sink needs — narrow so the tests hand in a
 *  map instead of a server. */
export interface NotesDocRooms {
  get(
    docId: string,
  ): { ydoc: Y.Doc; meta: { type: DocType; title?: string; setId?: string } } | undefined;
}

/** The slice of `TaskStore` the context gatherer needs. */
export interface NotesContextTasks {
  listTasks(workspaceId: string): Array<{ title: string; status: string; kind?: 'task' | 'goal' }>;
}

/**
 * Write one composed update into its meeting doc. False — never a throw —
 * when the doc is gone or is not prose: a meeting on a vanished doc still
 * has its transcript file, and a flat doc is not a notepad.
 */
export function applyNotesUpdate(rooms: NotesDocRooms, update: NotesUpdate): boolean {
  const room = rooms.get(update.docId);
  if (!room) return false;
  if (contentKind(room.meta.type) !== 'prose') return false;
  return replaceNotesSection(room.ydoc, update.notes).ok;
}

/**
 * Carry a rename into the notes already written in the meeting's doc.
 * Same tolerances as `applyNotesUpdate`: a doc that has gone away or was
 * never prose is not an error, it is a meeting whose notes are elsewhere.
 * Returns how many mentions moved — zero when the voice was never written
 * about, which is ordinary.
 */
export function applyNotesRelabel(rooms: NotesDocRooms, relabel: NotesRelabel): number {
  const room = rooms.get(relabel.docId);
  if (!room) return 0;
  if (contentKind(room.meta.type) !== 'prose') return 0;
  return relabelNotesSection(room.ydoc, relabel.from, relabel.to).replaced;
}

/**
 * Wire caller options into the deps a meeting session runs on: the doc write
 * becomes the sink (a caller `onNotes` observes after it), and the context
 * resolver reads the doc's title and its board's open task titles at meeting
 * start — the "informed, not generic" half of the notes agent.
 *
 * `rooms` / `tasks` are thunks because `createServer` builds the relay before
 * either exists; a meeting can only start once both do.
 */
export function withServerNotesSinks(
  options: MeetingNotesOptions,
  deps: {
    rooms: () => NotesDocRooms;
    tasks: () => NotesContextTasks;
    /** The store the capture pipeline writes through. A thunk like `tasks`,
     *  and only read when `taskExtractor` is present. */
    captureBoard?: () => TaskCaptureBoard;
    /** The lead wake for a captured task judged clear enough to start —
     *  wired to the ready-nudge channel by the server. */
    onTaskReady?: (wake: { workspaceId: string; taskId: string; title: string }) => void;
  },
): MeetingNotesDeps {
  const extractor = options.taskExtractor;
  const captureBoard = deps.captureBoard;
  const captureTasks: MeetingNotesDeps['captureTasks'] =
    options.captureTasks ??
    (extractor && captureBoard
      ? async ({ docId, turns }) => {
          // The doc's board is the capture's scope: a meeting on a doc no
          // workspace owns has no board to find or create on.
          const room = deps.rooms().get(docId);
          const workspaceId = room?.meta.setId;
          if (!workspaceId) return [];
          return runTaskCapture(
            {
              board: captureBoard(),
              extractor,
              ...(deps.onTaskReady ? { onTaskReady: deps.onTaskReady } : {}),
              onError: (message) => console.error(`[meeting-tasks] ${message}`),
            },
            {
              workspaceId,
              docId,
              ...(room.meta.title !== undefined ? { docTitle: room.meta.title } : {}),
              turns,
            },
          );
        }
      : undefined);
  return {
    ...options,
    ...(captureTasks ? { captureTasks } : {}),
    resolveContext: (docId: string): NotesProjectContext | undefined => {
      const gathered: NotesProjectContext = {};
      try {
        const room = deps.rooms().get(docId);
        if (room?.meta.title) gathered.docTitle = room.meta.title;
        const workspaceId = room?.meta.setId;
        if (workspaceId) {
          gathered.workspaceId = workspaceId;
          const titles = deps
            .tasks()
            .listTasks(workspaceId)
            .filter((t) => t.kind !== 'goal' && t.status !== 'done')
            .slice(0, MAX_CONTEXT_TASKS)
            .map((t) => t.title);
          if (titles.length > 0) gathered.taskTitles = titles;
        }
      } catch (err) {
        // Context is an enhancement to the notes, never a dependency: a
        // store that cannot answer must not cost the meeting its notes.
        console.error('[meeting-notes] context gather failed:', err);
      }
      // Caller-supplied context wins field-by-field: whoever wired the
      // server said something more specific than what we can gather.
      const supplied = options.resolveContext?.(docId) ?? options.context;
      const merged = { ...gathered, ...supplied };
      return Object.keys(merged).length > 0 ? merged : undefined;
    },
    onNotes: (update: NotesUpdate): void => {
      try {
        if (!applyNotesUpdate(deps.rooms(), update)) {
          console.error(`[meeting-notes] doc write skipped for ${update.docId}`);
        }
      } catch (err) {
        // The session chain treats an onNotes throw as a failed compose and
        // carries the words — wrong for notes that DID compose. Contain it.
        console.error('[meeting-notes] doc write failed:', err);
      }
      options.onNotes?.(update);
    },
    onRelabel: (relabel: NotesRelabel): void => {
      try {
        applyNotesRelabel(deps.rooms(), relabel);
      } catch (err) {
        // A rename that cannot reach the doc leaves a stale label, which is
        // a blemish; letting it reach the compose chain as a rejection would
        // cost the meeting its next notes, which is not.
        console.error('[meeting-notes] relabel failed:', err);
      }
      options.onRelabel?.(relabel);
    },
  };
}
