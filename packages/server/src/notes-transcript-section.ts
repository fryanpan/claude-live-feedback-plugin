/**
 * The meeting's own words, in the doc, under everything else.
 *
 * The notes are a VIEW of a meeting and the transcript is its RECORD, and the
 * two want opposite things from a page: the notes want to be read, the record
 * wants to be there when a note comes out wrong. So the record goes last, in
 * one section, and nothing the meeting writes ever lands below it
 * (`sectionInsertIndex` in `notes-section.ts` is how every other writer
 * agrees).
 *
 * ONE BLOCK, NOT MANY LINES. The whole segment is a single `codeBlock`, for
 * three reasons that all point the same way. A tick appends to its `Y.XmlText`
 * rather than inserting blocks, so a two-hour meeting costs the doc one node
 * instead of a thousand. The notes merge decomposes lists and paragraphs into
 * items it may delete or propose on, and a code block is neither — the record
 * cannot be edited by the note-taker even by accident. And a reader scrolling
 * past meets one quiet grey box instead of an hour of speech dressed as prose.
 *
 * WHAT IT IS NOT is collapsed. The prose vocabulary this project shares with
 * the editor (`packages/core/src/prose-markdown.ts`) has headings, lists,
 * quotes, code, rules, tables and images — and no fold. A `<details>` block
 * would round-trip through the `.md` as literal text in the editor, so the
 * fold has to be a real node in the schema plus a Tiptap extension plus a
 * design pass, which is a feature and not this plumbing. The heading is a
 * constant so that fold, when it lands, has one thing to key on.
 *
 * WHERE THE WORDS END UP. A huddle or meeting doc's `.md` lives under the
 * server data dir, beside the `*-raw-transcript.md` that already holds these
 * words. A doc BOUND TO A REPO FILE is different: this puts spoken words into
 * a working tree, which is the one thing `meeting-raw.ts` is careful never to
 * do. The notes already carry quotes and attributions, so this is more of the
 * same content rather than a new kind of it — but it is more of it, and that
 * is a call for the owner rather than a detail of the plumbing.
 */

import { prose } from '@feedback/core';
import * as Y from 'yjs';
import { extendsWord, replaceWholeToken } from './meeting-notes.ts';
import { TRANSCRIPT_HEADING, findNotesSection } from './notes-section.ts';

export { TRANSCRIPT_HEADING };

/** The fence's language. `text` and not the empty string: an unlabelled fence
 *  invites a highlighter to guess, and speech is not a language. */
export const TRANSCRIPT_LANGUAGE = 'text';

/** One settled turn as the record holds it. The speaker is optional because a
 *  solo meeting has nobody to distinguish and a bare name on every line is
 *  noise (the same gate the composer's tags sit behind). */
export interface TranscriptLine {
  speaker?: string;
  text: string;
}

export interface TranscriptWriteResult {
  ok: boolean;
  /** `created` on the first write of the section, `extended` after. */
  mode?: 'created' | 'extended';
  /** How many lines were added. Zero is ordinary: a tick of silence. */
  appended: number;
  /** True when the section had to be lifted back to the end of the doc. */
  moved: boolean;
  error?: 'not-prose' | 'parse-failed';
}

/**
 * `Devi: we should measure first.` — the whole grammar of a line here.
 *
 * Newlines are folded to spaces because a turn is one utterance however the
 * engine punctuated it, and a line that wrapped would read as two speakers.
 * Backticks are thinned so a run of three cannot close the fence the block is
 * written inside — a transcript that ends its own code block would spill the
 * rest of the meeting into the doc as prose.
 */
export function transcriptLine(line: TranscriptLine): string {
  const text = line.text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/`{3,}/g, '``')
    .trim();
  const speaker = line.speaker?.trim();
  return speaker ? `${speaker}: ${text}` : text;
}

/**
 * Append settled turns to the doc's raw-transcript section, creating it at the
 * end of the doc when it is not there and lifting it back to the end when
 * something has been written below it.
 *
 * Idempotent on the SECTION, never on the lines: a caller that hands the same
 * turn twice gets it twice, because this cannot tell a repeat from two people
 * saying the same thing. The tick's delta is deduped upstream by the pause
 * ticker's `seen` set, which is the one place that knows a turn number.
 */
export function appendTranscriptTurns(
  ydoc: Y.Doc,
  lines: readonly TranscriptLine[],
): TranscriptWriteResult {
  const rendered = lines.map(transcriptLine).filter((l) => l.length > 0);
  if (rendered.length === 0) return { ok: true, appended: 0, moved: false, mode: 'extended' };

  const fragment = prose.getProseFragment(ydoc);
  let moved = false;
  let mode: 'created' | 'extended' = 'extended';

  ydoc.transact(() => {
    const found = findNotesSection(fragment, TRANSCRIPT_HEADING);
    if (!found) {
      mode = 'created';
      insertSection(fragment, '');
    } else if (found.endExclusive !== fragment.length) {
      // Something landed below the record — a person's own heading, or a
      // writer that has not learned about `sectionInsertIndex`. The record is
      // the tail by definition, so it goes back there. Re-created rather than
      // moved: Yjs will not re-parent a live node, and there is nothing in a
      // code block of machine text for a mark or an anchor to be attached to.
      const carried = codeTextIn(fragment, found)?.toString() ?? '';
      fragment.delete(found.start, found.endExclusive - found.start);
      insertSection(fragment, carried);
      moved = true;
    }
    const span = findNotesSection(fragment, TRANSCRIPT_HEADING);
    if (!span) return;
    const text = codeTextIn(fragment, span);
    if (!text) return;
    text.insert(text.length, (text.length > 0 ? '\n' : '') + rendered.join('\n'));
  }, 'agent');

  const written = findNotesSection(fragment, TRANSCRIPT_HEADING);
  if (!written) return { ok: false, error: 'parse-failed', appended: 0, moved };
  return { ok: true, mode, appended: rendered.length, moved };
}

/**
 * Carry a rename of a voice into the record already written.
 *
 * The same law the notes are held to (owner, 2026-08-29: "rewrite them" — a
 * meeting must not read as "Speaker B" above a rename and by name below it),
 * and the record is where it bites hardest: every line carries the name, and
 * the file written at stop (`meeting-raw.ts`) composes from the folded
 * transcript and so gets the final names throughout. A doc whose record froze
 * the placeholder at the moment each line landed would disagree with its own
 * sidecar.
 *
 * A whole-token replacement over the block's text, and it needs no ownership
 * question first: a code block of machine speech is the agent's alone, and
 * there is nothing of anybody's in it to protect.
 */
export function relabelTranscriptSection(
  ydoc: Y.Doc,
  from: string,
  to: string,
): { replaced: number } {
  if (!from || from === to) return { replaced: 0 };
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSection(fragment, TRANSCRIPT_HEADING);
  if (!span) return { replaced: 0 };
  let replaced = 0;
  ydoc.transact(() => {
    for (let i = span.start + 1; i < span.endExclusive; i++) {
      const el = (fragment.toArray() as Y.XmlElement[])[i];
      if (!(el instanceof Y.XmlElement) || el.nodeName !== 'codeBlock') continue;
      const text = el.toArray()[0];
      if (!(text instanceof Y.XmlText)) continue;
      const before = text.toString();
      const after = replaceWholeToken(before, from, to);
      if (after === before) continue;
      // The whole block at once: a code block holds no marks, so there is
      // nothing a per-run rewrite would preserve that a replace would lose.
      text.delete(0, text.length);
      text.insert(0, after);
      replaced += countOccurrences(before, from);
    }
  }, 'agent');
  return { replaced };
}

/** How many whole-token hits a replacement made, for the caller's tally. */
function countOccurrences(text: string, token: string): number {
  let n = 0;
  let at = text.indexOf(token);
  while (at >= 0) {
    if (!extendsWord(text[at - 1]) && !extendsWord(text[at + token.length])) n++;
    at = text.indexOf(token, at + token.length);
  }
  return n;
}

/** Heading plus one code block, at the very end of the doc. Built through the
 *  markdown parser rather than by hand, so the heading level, the fence's
 *  language attribute and every future schema detail come from the one place
 *  that already knows them. */
function insertSection(fragment: Y.XmlFragment, body: string): void {
  const fence = ['```' + TRANSCRIPT_LANGUAGE, body, '```'].join('\n');
  fragment.insert(
    fragment.length,
    prose.parseMarkdownBlocks(`## ${TRANSCRIPT_HEADING}\n\n${fence}`),
  );
}

/**
 * The `Y.XmlText` the section's words live in — the first code block under the
 * heading, or a fresh one when a person has deleted it and left the heading.
 * Never the heading's own text, and never a paragraph somebody typed in there.
 */
function codeTextIn(
  fragment: Y.XmlFragment,
  span: { start: number; endExclusive: number },
): Y.XmlText | null {
  const top = fragment.toArray() as Y.XmlElement[];
  for (let i = span.start + 1; i < span.endExclusive; i++) {
    const el = top[i];
    if (!(el instanceof Y.XmlElement) || el.nodeName !== 'codeBlock') continue;
    const first = el.toArray()[0];
    if (first instanceof Y.XmlText) return first;
    const text = new Y.XmlText();
    el.insert(0, [text]);
    return text;
  }
  const block = new Y.XmlElement('codeBlock');
  block.setAttribute('language', TRANSCRIPT_LANGUAGE);
  const text = new Y.XmlText();
  block.insert(0, [text]);
  fragment.insert(span.start + 1, [block]);
  return text;
}
