/**
 * Taking the raw transcript back out of a notes doc.
 *
 * For one release the note-taker appended every tick's settled words to the
 * doc under a `## Raw transcript` heading. The owner's call on 2026-09-03 is
 * that they do not belong there: the notes are the short, reviewed record a
 * person or an agent actually reads, and a verbatim transcript is unreviewed
 * raw material — useful for checking exactly who said what, and for improving
 * transcription — so it lives in the `-raw-transcript.md` sister file beside
 * the meeting's data dir and nowhere else.
 *
 * NOTHING IS LOST WHEN THIS DELETES. Every line the old writer put in the doc
 * came from the same folded transcript `meeting-raw.ts` composes the sister
 * file from, so the words survive the removal in the file that was always
 * their home. That is what makes this safe to do without asking.
 *
 * ONLY THE SHAPE THE OLD WRITER MADE. The heading, one fenced block under it,
 * and nothing else until the next heading. Anything more means a person has
 * written in that section — pasted a quote, answered a line, kept a heading
 * of their own — and then it is their section and not ours to remove.
 */

import { prose } from '@feedback/core';
import * as Y from 'yjs';
import {
  LEGACY_TRANSCRIPT_HEADING,
  type NotesSectionSpan,
  findNotesSection,
} from './notes-section.ts';

/** What one pass over a doc did. `kept` is the one worth a log line: the
 *  section is there and somebody has been writing in it. */
export type LegacyTranscriptOutcome = 'removed' | 'kept' | 'absent';

/**
 * The span a removal may delete, or null.
 *
 * Pure: it reads the doc's top-level block list and decides, and the caller
 * below is the only thing that writes. Null covers both "no such section" and
 * "a section that is no longer just a transcript" — a caller that needs to
 * tell those apart asks `findNotesSection` itself, which is what
 * `dropLegacyTranscriptSection` does to log only the second one.
 */
export function legacyTranscriptSpan(fragment: Y.XmlFragment): NotesSectionSpan | null {
  const span = findNotesSection(fragment, LEGACY_TRANSCRIPT_HEADING);
  if (!span) return null;
  const top = fragment.toArray() as Y.XmlElement[];
  const body = top.slice(span.start + 1, span.endExclusive);
  if (body.length !== 1) return null;
  return body[0]?.nodeName === 'codeBlock' ? span : null;
}

/**
 * Take the old writer's transcript section out of a doc, when it is still
 * exactly what that writer left. Runs on the notes tick, so a doc that
 * received one before this shipped is cleaned up the next time its meeting
 * writes — no migration pass, no touching docs that are not in a meeting.
 */
export function dropLegacyTranscriptSection(ydoc: Y.Doc): LegacyTranscriptOutcome {
  const fragment = prose.getProseFragment(ydoc);
  const span = legacyTranscriptSpan(fragment);
  if (!span) {
    return findNotesSection(fragment, LEGACY_TRANSCRIPT_HEADING) ? 'kept' : 'absent';
  }
  ydoc.transact(() => {
    fragment.delete(span.start, span.endExclusive - span.start);
  }, 'agent');
  return 'removed';
}
