/**
 * Writing into the notes section of a live doc.
 *
 * Everything here edits a Yjs doc a person may be typing in at the same
 * moment, so each verb is written to touch the fewest nodes that do the job:
 * a speaker rename rewrites the tag runs in place rather than re-inserting
 * the lines that carry them, and a from-scratch replace is the one verb that
 * deletes a section — which is why the merge exists and why this one is
 * reached for only when there is nothing to merge with.
 *
 * The ownership ledger decides what an agent write may reach
 * (`notes-ownership.ts`); this file is what a permitted write does.
 */

import {
  type SpeakerTagRef,
  escapeTagText,
  findSpeakerTags,
  parseSpeakerTagHref,
  prose,
  reattributeSpeakerTags,
  speakerTagHref,
  speakerTagText,
} from '@feedback/core';
import * as Y from 'yjs';
import { findNotesSection } from './meeting-notes-merge.ts';
import { type NotesReattribution, extendsWord } from './meeting-notes.ts';
import {
  MEETING_NOTES_HEADING,
  MEETING_NOTES_HEADINGS,
  sectionInsertIndex,
} from './notes-section.ts';

/** The section the notes agent owns, and every spelling it has been written
 *  under. Declared in `notes-section.ts` beside the finder that matches them;
 *  re-exported here because this is where every caller already looks. */
export { MEETING_NOTES_HEADING, MEETING_NOTES_HEADINGS };

export interface ReplaceNotesResult {
  ok: boolean;
  error?: 'empty' | 'parse-failed';
  /** `replaced` when the section existed, `appended` on its first write. */
  mode?: 'replaced' | 'appended';
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
  heading: string | readonly string[] = MEETING_NOTES_HEADINGS,
): ReplaceNotesResult {
  if (!notesMarkdown.trim()) return { ok: false, error: 'empty' };
  const headings = typeof heading === 'string' ? [heading] : heading;
  const canonical = headings[0] ?? MEETING_NOTES_HEADING;
  // The heading is the replace contract: a payload without it would land
  // once and then be unfindable, so the NEXT write would append a second
  // section. Enforced here — the one place every notes write passes through.
  const withHeading = startsWithHeading(notesMarkdown, headings)
    ? notesMarkdown
    : `## ${canonical}\n\n${notesMarkdown}`;
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
    // Above the raw transcript, which owns the doc's tail; at the end when
    // the doc has none.
    ydoc.transact(() => {
      fragment.insert(sectionInsertIndex(fragment), blocks);
    }, 'agent');
    return { ok: true, mode: 'appended' };
  }

  ydoc.transact(() => {
    fragment.delete(span.start, span.endExclusive - span.start);
    fragment.insert(span.start, blocks);
  }, 'agent');
  return { ok: true, mode: 'replaced' };
}

/**
 * The placeholder a spoken "can you research X" leaves in the doc: a section
 * headed with the row's title, holding one line that links the row and says
 * the findings land here. It is the pill's second half made visible — the
 * row is where the errand is tracked, the section is where the person who
 * asked will look for the answer. Idempotent by heading: the same ask heard
 * twice files one row (the capture dedupes) and leaves one section.
 */
export function appendResearchPlaceholder(
  ydoc: Y.Doc,
  title: string,
  url: string,
): { ok: boolean; mode?: 'appended' | 'present'; error?: 'parse-failed' } {
  const fragment = prose.getProseFragment(ydoc);
  if (findNotesSectionSpan(fragment, title)) return { ok: true, mode: 'present' };
  let blocks: Y.XmlElement[];
  try {
    blocks = prose.parseMarkdownBlocks(
      `## ${title}\n\nFiled as [${title}](${url}) — the lead writes what it finds here.`,
    );
  } catch {
    return { ok: false, error: 'parse-failed' };
  }
  // Above the raw transcript for the same reason the notes are: a placeholder
  // appended past it would leave the meeting's own words in the middle of the
  // doc — and appending past the NOTES is what used to split them in two.
  ydoc.transact(() => {
    fragment.insert(sectionInsertIndex(fragment), blocks);
  }, 'agent');
  return { ok: true, mode: 'appended' };
}

/** Where the notes section sits in the top-level fragment — the LAST heading
 *  match, shared with the merge so every notes path targets the same section.
 *  Null when the heading is absent — the "never written yet" state, not a
 *  failure. */
function findNotesSectionSpan(
  fragment: Y.XmlFragment,
  heading: string | readonly string[],
): { start: number; endExclusive: number } | null {
  return findNotesSection(fragment, heading);
}

/**
 * Rename a voice at every INLINE SPEAKER TAG in the notes section — the
 * precise half of a rename, and the half that cannot be wrong.
 *
 * A tag is a markdown link whose href carries the engine label
 * (`[@Speaker B](speaker:B)`), so this asks the doc a structural question —
 * "which runs are marked as voice B?" — where `relabelNotesSection` below
 * can only ask a textual one — "which runs say the words 'Speaker B'?". The
 * difference is the whole reason tags exist: two voices a person has given
 * the same name are still two labels, so each renames alone, and a person
 * who writes "Speaker B" in a sentence of their own is writing words, not an
 * attribution, and is left alone.
 *
 * Written IN PLACE, run by run, carrying each site's own marks — the link
 * mark included, which is what keeps the tag a tag. Nothing is re-parsed and
 * no item is replaced, so a sentence a person edited around the tag keeps
 * every other word of theirs.
 */
export function retagSpeakerInNotes(
  ydoc: Y.Doc,
  label: string,
  displayName: string,
  heading: string | readonly string[] = MEETING_NOTES_HEADINGS,
): { replaced: number } {
  const want = speakerTagText(label, { [label]: displayName });
  return rewriteSpeakerTagRuns(ydoc, heading, (tag) =>
    // Keyed on the label alone: a rename says what this voice is CALLED, and
    // where the mention came from is none of its business — so the href
    // rides through untouched, provenance and all.
    tag.ref.label === label && tag.text !== want ? { text: want, href: tag.href } : null,
  );
}

/**
 * One speaker tag as the DOC holds it: a contiguous run of delta ops sharing
 * one link href, plus what the href parses to.
 */
interface SpeakerTagRun {
  href: string;
  ref: SpeakerTagRef;
  /** The run's text, sigil included. */
  text: string;
}

/** What a caller wants a tag to become. `href: null` takes the link mark off
 *  entirely, which is how a claim is withdrawn while the words stay. */
interface SpeakerTagRewrite {
  text: string;
  href: string | null;
}

/**
 * Walk every speaker tag in the notes section and rewrite the ones `decide`
 * answers for — in place, run by run, carrying each site's own marks.
 *
 * THE UNIT IS A RUN, NOT AN OP. A tag is not always one delta op: bold half
 * a tag's name and Yjs carries it as two ops sharing the link href, and a
 * loop treating each op as a whole tag writes the new name once per op. So
 * contiguous ops with the SAME href accumulate into one run and the run is
 * what gets replaced. (Two tags for one voice written back to back with
 * nothing between them merge into one — markdown that says the same name
 * twice in a row with no words between it.)
 *
 * `within` scopes the walk to a set of elements. Absent, the whole section
 * is in scope, which is what a rename wants: what a voice is called is true
 * wherever it is written. A correction of WHO SPOKE passes the agent's own
 * items, because rewriting the attribution inside a sentence a person has
 * taken over is a claim about their writing, not about the transcript.
 */
function rewriteSpeakerTagRuns(
  ydoc: Y.Doc,
  heading: string | readonly string[],
  decide: (tag: SpeakerTagRun) => SpeakerTagRewrite | null,
  within?: ReadonlySet<Y.XmlElement>,
): { replaced: number } {
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSectionSpan(fragment, heading);
  if (!span) return { replaced: 0 };
  const top = fragment.toArray() as Y.XmlElement[];
  const nodes: Y.XmlText[] = [];
  // From start + 1: the heading is the section's own anchor, never a tag.
  for (let i = span.start + 1; i < span.endExclusive; i++) {
    collectTextNodesWithin(top[i]!, within, nodes);
  }

  let replaced = 0;
  ydoc.transact(() => {
    for (const node of nodes) {
      const edits: Array<{
        offset: number;
        length: number;
        attributes: Record<string, unknown>;
        rewrite: SpeakerTagRewrite;
      }> = [];
      let run: {
        offset: number;
        length: number;
        attributes: Record<string, unknown>;
        text: string;
        href: string;
      } | null = null;
      const flush = () => {
        if (run) {
          const ref = parseSpeakerTagHref(run.href);
          if (ref) {
            const rewrite = decide({ href: run.href, ref, text: run.text });
            if (rewrite) {
              edits.push({
                offset: run.offset,
                length: run.length,
                attributes: run.attributes,
                rewrite,
              });
            }
          }
        }
        run = null;
      };
      let offset = 0;
      for (const op of node.toDelta() as YTextOp[]) {
        // A non-string insert is an embed: one position wide, and never a
        // speaker tag. Counted so later offsets stay true.
        if (typeof op.insert !== 'string') {
          flush();
          offset += 1;
          continue;
        }
        const length = op.insert.length;
        const attributes = op.attributes;
        const href = (attributes?.link as { href?: unknown } | undefined)?.href;
        if (typeof href === 'string' && run?.href === href) {
          run.length += length;
          run.text += op.insert;
        } else {
          flush();
          if (typeof href === 'string') {
            // The FIRST op's marks carry the whole replacement: the text is
            // being written anew, so emphasis that covered part of the old
            // spelling has nothing left to cover. The link mark, which is
            // the one that matters, is on every op of the run by definition.
            run = { offset, length, attributes: attributes ?? {}, text: op.insert, href };
          }
        }
        offset += length;
      }
      flush();
      // Descending, so every offset not yet used is still valid: an edit
      // only ever changes text at or after the site it lands on.
      for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i]!;
        node.delete(edit.offset, edit.length);
        const text = edit.rewrite.text;
        if (text.length > 0) {
          prose.insertTextWithMarks(node, edit.offset, text, {
            attributes: attributesFor(edit.attributes, edit.rewrite.href),
          });
        }
        replaced++;
      }
    }
  }, 'agent');
  return { replaced };
}

/** The site's marks with the link mark pointed somewhere new — or dropped,
 *  which leaves the words carrying every other mark they had. */
function attributesFor(
  attributes: Record<string, unknown>,
  href: string | null,
): Record<string, unknown> {
  const { link, ...rest } = attributes;
  // Rebuilt WITHOUT the key rather than with an undefined one: these
  // attributes go straight into a Yjs insert, and a present-but-undefined
  // mark is not the same thing as an absent one.
  if (href === null) return rest;
  return { ...rest, link: { ...(link as Record<string, unknown> | undefined), href } };
}

/** One op of a `Y.XmlText` delta, as much of it as this module reads. */
interface YTextOp {
  insert: unknown;
  attributes?: Record<string, unknown>;
}

/** Every `Y.XmlText` under `el`, itself included, in reading order. */
function collectTextNodes(el: Y.XmlElement, into: Y.XmlText[]): void {
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) into.push(child);
    else if (child instanceof Y.XmlElement) collectTextNodes(child, into);
  }
}

/**
 * The text nodes under `el` that a scoped edit may touch: all of them when
 * there is no scope, and otherwise only those inside an element the scope
 * names. Descends THROUGH an unnamed element rather than stopping at it — a
 * bullet list is never itself an item, its `listItem` children are.
 */
function collectTextNodesWithin(
  el: Y.XmlElement,
  within: ReadonlySet<Y.XmlElement> | undefined,
  into: Y.XmlText[],
): void {
  if (within === undefined || within.has(el)) {
    collectTextNodes(el, into);
    return;
  }
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlElement) collectTextNodesWithin(child, within, into);
  }
}

/**
 * Carry the engine's late correction of WHO SPOKE into the notes already
 * written — the half a rename could never do.
 *
 * A rename is keyed on a voice and reaches every mention of it. This is
 * keyed on TURNS, so which mentions move is decided per site from the
 * provenance each one carries (`speaker:B?t=10,12`): the ones whose every
 * turn moved the same way take the new voice, the ones whose turns now
 * disagree are marked unsure, and the ones the revision never touched are
 * left exactly alone. `reattributeSpeakerTags` in core is the same decision
 * on a markdown string — one rule, so the session's memory of the notes and
 * the doc itself cannot come out saying different things.
 *
 * SCOPED TO THE AGENT'S OWN ITEMS. Everything else here is scoped to the
 * notes section; this is scoped further, to the lines the ledger still
 * claims. Rewriting the attribution inside a sentence a person has taken
 * over would be the note-taker editing their writing on a machine's second
 * thoughts — and it is the same boundary that keeps this off an EARLIER
 * meeting's leftovers in the same doc, whose turn numbers start again from
 * the beginning and could otherwise collide with this meeting's.
 */
export function reattributeNotesSection(
  ydoc: Y.Doc,
  reattribution: Pick<NotesReattribution, 'revisions' | 'names'>,
  owned: ReadonlySet<Y.XmlElement>,
  heading: string | readonly string[] = MEETING_NOTES_HEADINGS,
): { replaced: number } {
  if (reattribution.revisions.size === 0) return { replaced: 0 };
  return rewriteSpeakerTagRuns(
    ydoc,
    heading,
    (tag) => {
      // Run through core on a one-tag markdown string, so the doc and the
      // session's `previous` are decided by the same code rather than by two
      // implementations of the same rule.
      // Escaped, because this text came out of the DOCUMENT rather than out
      // of a composer: a person can type a bracket into a chip's words, and
      // raw it would close the link early and make the mention invisible to
      // the finder — the correction would skip it in silence.
      const before = `[${escapeTagText(tag.text)}](${tag.href})`;
      const after = reattributeSpeakerTags(before, reattribution).markdown;
      if (after === before) return null;
      const rewritten = findSpeakerTags(after)[0];
      // No tag left in the answer is the withdrawn claim: the words stay and
      // the link mark goes.
      return rewritten
        ? { text: rewritten.text, href: speakerTagHref(rewritten.label, rewritten) }
        : { text: after, href: null };
    },
    owned,
  );
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
  heading: string | readonly string[] = MEETING_NOTES_HEADINGS,
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

function startsWithHeading(markdown: string, headings: readonly string[]): boolean {
  const first = markdown.trimStart().split('\n', 1)[0] ?? '';
  const m = first.match(/^#{1,6}\s+(.*)$/);
  const text = m?.[1]?.trim();
  return text !== undefined && headings.includes(text);
}
