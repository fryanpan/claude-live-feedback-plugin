/**
 * The half of the notes ownership ledger that has to survive the process.
 *
 * WHAT IS PERSISTED, AND WHAT DELIBERATELY IS NOT. The ledger answers two
 * different questions with one structure (`notes-ownership.ts`):
 *
 *   1. MAY I REPLACE THIS ITEM? — element AND text, so a line a person has
 *      rewritten stops being the agent's. Keyed by Yjs element, which is a
 *      runtime object: it cannot be written down, and it must not be. A
 *      restarted server that claimed items it has never seen would delete a
 *      person's writing on its first from-scratch compose, which is the
 *      reported data loss the release exists to prevent.
 *   2. IS THIS SECTION THE NOTE-TAKER'S? — the question that decides whether
 *      a tick EXTENDS the "Meeting notes" it finds or opens a second one.
 *      That one is answered by text alone, and it is the one written here.
 *
 * So this file persists the markdown of the items the note-taker wrote, and
 * nothing else. After a restart the merge can recognise its own section
 * wherever it now sits, while still holding no right to replace a single line
 * in it. Adding and suggesting, never replacing, is the safe direction.
 *
 * WHY PER DOC AND NOT PER MEETING. A restart mid-meeting does not resume the
 * meeting: the browser reports the connection lost, the person presses record
 * again, and `MeetingStore.start` mints a new meeting id from the new clock.
 * A claim keyed strictly to the meeting id would therefore be unreadable by
 * the only process that needs it. The record NAMES its meeting and is adopted
 * only while it is fresh (`NOTES_LEDGER_CONTINUATION_MS`), which is what keeps
 * the owner's 2026-09-01 rule intact: a genuinely new meeting, days later on a
 * doc whose old notes sit mid-document, still starts its own section at the
 * end rather than growing the old one above everything written since.
 *
 * Beside the doc's meetings, under the same `<dataDir>/meetings/<docId>/`
 * folder as the transcripts and the index, because it is per-doc meeting state
 * and belongs where the rest of it is. A whole-file rewrite rather than an
 * append, unlike its neighbours: this is a snapshot of what the notes
 * currently say, not a record of what happened, and only the latest reading is
 * ever wanted.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { meetingDirPath } from './meetings.ts';

/** The file, inside the doc's own meetings folder. */
export const NOTES_LEDGER_FILENAME = 'notes-ledger.json';

/**
 * How long a written claim keeps identifying the section.
 *
 * It is a bound on ONE sitting, not a guess at when a meeting ends. A deploy
 * takes seconds and the person presses record again as soon as they notice;
 * half an hour is generous for that and still short enough that next week's
 * meeting on the same doc reads as the new meeting it is. Erring long costs
 * one section instead of two — the outcome this whole file is for; erring
 * short costs the twinning back.
 */
export const NOTES_LEDGER_CONTINUATION_MS = 30 * 60_000;

/**
 * How many item texts a record keeps, newest kept.
 *
 * The claim needs ONE line to match, so the cap is only there to stop an hour
 * of ticks — each recording every wording it has ever written — turning a
 * snapshot into a transcript. Far above any real meeting's notes.
 */
export const NOTES_LEDGER_MAX_ITEMS = 500;

/** What one doc's notes ledger looks like on disk. */
export interface NotesLedgerRecord {
  /** The recording that last wrote these lines. Read by a person debugging a
   *  doc; the adoption decision keys on `writtenAt`, since the id a restarted
   *  meeting carries is a new one. */
  meetingId: string;
  /** When the last write landed. */
  writtenAt: number;
  /** The markdown of every item the note-taker has written into this doc's
   *  notes section, oldest first. */
  items: string[];
}

/** Where a record is read and written. Injected, so the ledger can be driven
 *  in a test without a filesystem. */
export interface NotesLedgerStore {
  read(docId: string): NotesLedgerRecord | null;
  write(docId: string, record: NotesLedgerRecord): void;
}

/** The file a doc's notes ledger lives in. Exported so tests assert the real
 *  path rather than a copy of it. */
export function notesLedgerPath(dataDir: string, docId: string): string {
  return join(meetingDirPath(dataDir, docId), NOTES_LEDGER_FILENAME);
}

/**
 * Is this record still the sitting that is going on?
 *
 * `Math.abs`, not a one-sided window: a record written under a clock that has
 * since been corrected backwards would otherwise be adopted forever, and a
 * stamp from the future is as suspect as one from last week.
 */
export function continuesSitting(record: NotesLedgerRecord | null, now: number): boolean {
  if (!record) return false;
  return Math.abs(now - record.writtenAt) <= NOTES_LEDGER_CONTINUATION_MS;
}

/** Keep the newest `NOTES_LEDGER_MAX_ITEMS` of a claim. */
export function cappedItems(items: readonly string[]): string[] {
  return items.length <= NOTES_LEDGER_MAX_ITEMS
    ? [...items]
    : items.slice(items.length - NOTES_LEDGER_MAX_ITEMS);
}

function parseRecord(text: string): NotesLedgerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.meetingId !== 'string') return null;
  if (typeof row.writtenAt !== 'number' || !Number.isFinite(row.writtenAt)) return null;
  if (!Array.isArray(row.items)) return null;
  const items = row.items.filter((item): item is string => typeof item === 'string');
  return { meetingId: row.meetingId, writtenAt: row.writtenAt, items };
}

/**
 * The real store, rooted at the server's data dir.
 *
 * NOTHING HERE THROWS. A ledger that cannot be read or written costs the
 * meeting one section, and a meeting must never lose its notes to the file
 * that was only meant to keep them together. A missing file, a torn one, a
 * folder that cannot be created: all of them read as "no claim", which is the
 * behaviour this file replaces and therefore always safe.
 */
export function createNotesLedgerStore(dataDir: string): NotesLedgerStore {
  return {
    read(docId) {
      const path = notesLedgerPath(dataDir, docId);
      try {
        if (!existsSync(path)) return null;
        return parseRecord(readFileSync(path, 'utf8'));
      } catch (err) {
        console.error(`[meeting-notes] notes ledger for ${docId} not read:`, err);
        return null;
      }
    },
    write(docId, record) {
      const path = notesLedgerPath(dataDir, docId);
      try {
        mkdirSync(meetingDirPath(dataDir, docId), { recursive: true });
        // Written beside and renamed over: a tick can land while a restarting
        // server is reading, and a half-written file would read as no claim
        // at exactly the moment the claim is needed.
        const tmp = `${path}.tmp`;
        writeFileSync(
          tmp,
          `${JSON.stringify({ ...record, items: cappedItems(record.items) }, null, 2)}\n`,
        );
        renameSync(tmp, path);
      } catch (err) {
        console.error(`[meeting-notes] notes ledger for ${docId} not written:`, err);
      }
    },
  };
}
