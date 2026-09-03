/**
 * Taking the raw transcript back out of a notes doc — and only ever the
 * transcript.
 *
 * For one release the note-taker appended every tick's settled words to the
 * doc under a `## Raw transcript` heading. The owner's call on 2026-09-03 is
 * that they do not belong there: the notes are the short, reviewed record a
 * person or an agent actually reads, and a verbatim transcript is unreviewed
 * raw material — useful for checking exactly who said what, and for improving
 * transcription — so it lives in the `-raw-transcript.md` sister file beside
 * the meeting's data dir and nowhere else.
 *
 * NOTHING IS LOST ONLY BECAUSE THE FINGERPRINT IS EXACT. The words this
 * deletes are in the sister file `meeting-raw.ts` composes from the same
 * folded transcript — but that is true of the old WRITER'S output and of
 * nothing else, so this removes only what that writer could have produced,
 * and every condition below is required:
 *
 * - the doc is unbound, or bound under the server data dir. The writer was
 *   gated on exactly that (`allowedIn` below is its rule, kept verbatim), so
 *   a heading in a repo-bound doc was written by a person.
 * - the heading is level TWO and reads exactly `Raw transcript`. A `###` one
 *   is somebody's subsection; the writer only ever wrote `##`.
 * - the section is the doc's TAIL. The writer put the record last and lifted
 *   it back when anything landed below it, so a `Raw transcript` section with
 *   a doc after it was not left there by the writer.
 * - exactly one block sits under it, a code block whose language is `text`.
 *   The writer's fence was always ```` ```text ````; a `json` fence, a bare
 *   fence, a paragraph, or a second block means a person has been here.
 *
 * A doc outside that fingerprint keeps its section, and the caller logs one
 * line. A reviewer found the earlier version of this deleting a transcript
 * somebody had pasted in by hand, which is the failure every clause above is
 * paying for.
 */

import { resolve, sep } from 'node:path';
import { prose } from '@feedback/core';
import * as Y from 'yjs';
import { LEGACY_TRANSCRIPT_HEADING, headingText } from './notes-section.ts';

/** The level the old writer's heading was written at, and the only one this
 *  will remove. */
const LEGACY_TRANSCRIPT_LEVEL = 2;

/** The fence language the old writer always set. `text` and not the empty
 *  string: it labelled the fence so no highlighter would guess at speech. */
const LEGACY_TRANSCRIPT_LANGUAGE = 'text';

/** Where the old writer's section sits, when the doc has one to remove. */
export interface LegacyTranscriptSpan {
  /** Index of the heading in the top-level fragment. */
  start: number;
  /** First index past the section — the end of the doc, by definition. */
  endExclusive: number;
}

/** What one pass over a doc did. `kept` is the one worth a log line: the
 *  section is there and it is not the old writer's. */
export type LegacyTranscriptOutcome = 'removed' | 'kept' | 'absent';

/** Where the doc lives, as the placement rule below reads it. */
export interface LegacyTranscriptPlacement {
  /** The file the doc is bound to, if any. Absent reads as unbound. */
  boundPath?: string | undefined;
  /** The server's data dir. Absent means unknown, which reads as no. */
  dataDir?: string | undefined;
}

/**
 * Could the old writer have written in this doc at all?
 *
 * The gate it was held to, kept whole: a huddle or meeting doc is unbound, or
 * bound under the server data dir beside the `*-raw-transcript.md` that holds
 * the same words. A doc bound to a repo file never got a section, so a
 * heading in one is somebody's own and this must not touch it.
 *
 * Unknown means no, for the same reason it did then: a bound doc whose data
 * dir this cannot see could be anywhere, and deleting is the irreversible
 * direction.
 */
export function allowedIn(placement: LegacyTranscriptPlacement): boolean {
  if (!placement.boundPath) return true;
  if (!placement.dataDir) return false;
  const file = resolve(placement.boundPath);
  const root = resolve(placement.dataDir);
  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The span a removal may delete, or null — the fingerprint, as a pure read of
 * the doc's top-level block list.
 *
 * Expressed as the doc's LAST TWO blocks rather than as a section lookup, so
 * "it is the tail" and "nothing else is under it" are one structural fact
 * instead of two checks that could disagree. The heading's level is asked
 * here rather than left to a finder that matches text at any level.
 */
export function legacyTranscriptSpan(fragment: Y.XmlFragment): LegacyTranscriptSpan | null {
  const top = fragment.toArray() as Y.XmlElement[];
  if (top.length < 2) return null;
  const heading = top[top.length - 2];
  const fence = top[top.length - 1];
  if (!(heading instanceof Y.XmlElement) || heading.nodeName !== 'heading') return null;
  if (prose.headingLevelOf(heading) !== LEGACY_TRANSCRIPT_LEVEL) return null;
  if (headingText(heading) !== LEGACY_TRANSCRIPT_HEADING) return null;
  if (!(fence instanceof Y.XmlElement) || fence.nodeName !== 'codeBlock') return null;
  if (fence.getAttribute('language') !== LEGACY_TRANSCRIPT_LANGUAGE) return null;
  return { start: top.length - 2, endExclusive: top.length };
}

/** Does the doc carry a heading reading `Raw transcript` at all, at any level?
 *  The difference between "nothing to do" and "something is there that this
 *  is declining to touch". */
function hasTranscriptHeading(fragment: Y.XmlFragment): boolean {
  return (fragment.toArray() as Y.XmlElement[]).some(
    (el) => el.nodeName === 'heading' && headingText(el) === LEGACY_TRANSCRIPT_HEADING,
  );
}

/**
 * Take the old writer's transcript section out of a doc, when the doc is one
 * that writer could have written in and the section is still exactly what it
 * left. Runs on the notes tick, so a doc that received one before this
 * shipped is cleaned up the next time its meeting writes — no migration pass,
 * and no touching docs that are not in a meeting.
 */
export function dropLegacyTranscriptSection(
  ydoc: Y.Doc,
  placement: LegacyTranscriptPlacement = {},
): LegacyTranscriptOutcome {
  const fragment = prose.getProseFragment(ydoc);
  if (!allowedIn(placement)) return hasTranscriptHeading(fragment) ? 'kept' : 'absent';
  const span = legacyTranscriptSpan(fragment);
  if (!span) return hasTranscriptHeading(fragment) ? 'kept' : 'absent';
  ydoc.transact(() => {
    fragment.delete(span.start, span.endExclusive - span.start);
  }, 'agent');
  return 'removed';
}
