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
 */

import { type DocType, contentKind, prose } from '@feedback/core';
import type * as Y from 'yjs';
import type {
  MeetingNotesDeps,
  MeetingNotesOptions,
  NotesProjectContext,
  NotesUpdate,
} from './meeting-notes.ts';

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
    blocks = prose.parseMarkdownBlocks(withHeading);
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  if (blocks.length === 0) return { ok: false, error: 'empty' };

  const fragment = prose.getProseFragment(ydoc);
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

  if (start < 0) {
    ydoc.transact(() => {
      fragment.insert(fragment.length, blocks);
    }, 'agent');
    return { ok: true, mode: 'appended' };
  }

  let endExclusive = top.length;
  for (let i = start + 1; i < top.length; i++) {
    const el = top[i]!;
    if (el.nodeName !== 'heading') continue;
    if (prose.headingLevelOf(el) <= level) {
      endExclusive = i;
      break;
    }
  }
  ydoc.transact(() => {
    fragment.delete(start, endExclusive - start);
    fragment.insert(start, blocks);
  }, 'agent');
  return { ok: true, mode: 'replaced' };
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
  deps: { rooms: () => NotesDocRooms; tasks: () => NotesContextTasks },
): MeetingNotesDeps {
  return {
    ...options,
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
  };
}
