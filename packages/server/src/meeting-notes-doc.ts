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
 * whole notes, so each update must revise the previous section rather than
 * grow the doc — and an anchor or offset would rot the moment a human edits
 * around it. The heading is re-located per write, so the section survives
 * being moved.
 *
 * WHAT REACHES THE DOC IS A MERGE, NOT A REPLACE. `replaceNotesSection`
 * below deletes the section and re-inserts the composed string; run every
 * pause tick, that is the note-taker destroying what the person typed while
 * it was composing, which is exactly what the owner reported. The live sink
 * goes through `mergeNotesSection` instead: it changes only the items the
 * agent itself last wrote, and where the composer wants different words in a
 * person's line it proposes them as a suggestion. `replaceNotesSection` is
 * kept for the first write of a section and for callers that own the whole
 * span; see `meeting-notes-merge.ts` for the invariant and its reasoning.
 *
 * A RENAME REWRITES THE NOTES ALREADY WRITTEN, and does it as a TARGETED
 * replacement rather than a section rewrite (owner, 2026-08-29: "rewrite
 * them" — he does not want the same person reading as "Speaker B" above a
 * rename and by name below it). `relabelNotesSection` replaces only the
 * exact token the composer put there ("Speaker B"), only inside the notes
 * section, and touches nothing else in the doc.
 *
 * It deliberately does NOT go through `replaceNotesSection`, for the same
 * reason the notes sink no longer does: that path replaces the whole section
 * with a string this module composed, discarding whatever the human had
 * typed into it. A rename is a two-word correction and must cost no more
 * than two words. It edits IN PLACE, under the agent's hand, so the sink
 * hands it `reclaimAfterInPlaceEdit` — the ledger has to learn the new
 * wording of its own lines, or the rename would hand every line it touched
 * to the person and the notes would freeze there.
 *
 * AND THE ENGINE'S OWN LATE CORRECTION IS A THIRD KIND OF EDIT.
 * `reattributeNotesSection` does not change a name; it moves a MENTION from
 * one voice to another, because AssemblyAI's end-of-session pass decided a
 * turn belonged to somebody else. Which mentions move is read off each tag's
 * own provenance rather than off the voice, and — unlike a rename — the walk
 * is scoped to the items the LEDGER still claims. What a voice is called is
 * true wherever it is written; a second thought about who spoke does not get
 * to edit a sentence a person has taken over.
 */

import {
  type DocType,
  type SpeakerTagRef,
  contentKind,
  escapeTagText,
  findSpeakerTags,
  parseSpeakerTagHref,
  prose,
  reattributeSpeakerTags,
  speakerTagHref,
  speakerTagText,
} from '@feedback/core';
import * as Y from 'yjs';
import {
  type NotesOwnership,
  agentOwnedElements,
  createNotesOwnership,
  mergeNotesSection,
  readNotesSection,
  reclaimAfterInPlaceEdit,
} from './meeting-notes-merge.ts';
import {
  type MeetingNotesDeps,
  type MeetingNotesOptions,
  type NotesProjectContext,
  type NotesReattribution,
  type NotesRelabel,
  type NotesSectionState,
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
  heading: string = MEETING_NOTES_HEADING,
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
  heading: string,
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
  heading: string = MEETING_NOTES_HEADING,
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
 * One ownership record per meeting doc — what the agent wrote into that
 * doc's notes section, and the ONLY thing separating the agent's own bullets
 * from a person's writing.
 *
 * Per DOC, not per meeting, and it outlives a meeting deliberately: a second
 * meeting on the same doc still recognises the first one's notes as its own
 * and revises them, the way it always has. Nothing a person touched is in
 * there, so the longer life costs them nothing.
 *
 * In memory only, so a restarted server claims nothing — which the merge
 * reads as "everything in this section is somebody else's". That is the safe
 * direction: after a restart the note-taker adds and stops replacing, rather
 * than guessing that prose it has never seen is its own.
 */
export interface NotesLedger {
  forDoc(docId: string): NotesOwnership;
}

export function createNotesLedger(): NotesLedger {
  const byDoc = new Map<string, NotesOwnership>();
  return {
    forDoc(docId) {
      const existing = byDoc.get(docId);
      if (existing) return existing;
      const created = createNotesOwnership();
      byDoc.set(docId, created);
      return created;
    },
  };
}

/**
 * Write one composed update into its meeting doc, keeping every item the
 * agent did not write. False — never a throw — when the doc is gone or is
 * not prose: a meeting on a vanished doc still has its transcript file, and
 * a flat doc is not a notepad.
 */
export function applyNotesUpdate(
  rooms: NotesDocRooms,
  update: NotesUpdate,
  ledger: NotesLedger,
): boolean {
  const room = rooms.get(update.docId);
  if (!room) return false;
  if (contentKind(room.meta.type) !== 'prose') return false;
  return mergeNotesSection(room.ydoc, update.notes, MEETING_NOTES_HEADING, {
    ownership: ledger.forDoc(update.docId),
    ...(update.basedOn ? { basedOn: update.basedOn } : {}),
  }).ok;
}

/** The notes section as it currently reads, for the composer's `previous`. */
export function readNotesState(
  rooms: NotesDocRooms,
  ids: { docId: string; meetingId: string },
  ledger: NotesLedger,
): NotesSectionState | null {
  const room = rooms.get(ids.docId);
  if (!room) return null;
  if (contentKind(room.meta.type) !== 'prose') return null;
  return readNotesSection(room.ydoc, MEETING_NOTES_HEADING, ledger.forDoc(ids.docId));
}

/**
 * Carry a rename into the notes already written in the meeting's doc.
 * Same tolerances as `applyNotesUpdate`: a doc that has gone away or was
 * never prose is not an error, it is a meeting whose notes are elsewhere.
 * Returns how many mentions moved — zero when the voice was never written
 * about, which is ordinary.
 *
 * TWO PASSES, AND THE ORDER IS NOT ARBITRARY. The tags go first and always:
 * they name the voice by label, so they are right whatever anybody is
 * called. The plain-text sweep runs second and only when the relabel says it
 * may — it is what reaches notes composed before tags existed, and it is
 * also the pass that cannot tell two voices with one name apart. Running it
 * second means a mention that was already retagged is no longer spelled the
 * old way, so the sweep has nothing left to find there and cannot touch it
 * twice.
 */
export function applyNotesRelabel(
  rooms: NotesDocRooms,
  relabel: NotesRelabel,
  ledger: NotesLedger,
): number {
  const room = rooms.get(relabel.docId);
  if (!room) return 0;
  if (contentKind(room.meta.type) !== 'prose') return 0;
  // Through the reclaim wrapper, not straight at the doc: the rename edits
  // the agent's own lines in place, and the ledger has to come out the other
  // side still recognising them. See `reclaimAfterInPlaceEdit`.
  return reclaimAfterInPlaceEdit(
    room.ydoc,
    MEETING_NOTES_HEADING,
    ledger.forDoc(relabel.docId),
    () => {
      // The untagged sweep runs FIRST, and the order is load-bearing. It
      // looks for the old display name on word boundaries, and an extension
      // rename leaves that name inside the new one — retag first and the
      // sweep finds "Devi" inside the "@Devi Raman" it has just written, and
      // makes it "@Devi Raman Raman". Sweeping first, the sweep sees only the
      // old spelling everywhere it appears, and the retag that follows
      // canonicalises every tag for this voice — including any the sweep had
      // no way to reach, and including the ones it has just corrected, where
      // it finds the right text already there and does nothing.
      const swept = relabel.rewriteUntagged
        ? relabelNotesSection(room.ydoc, relabel.from, relabel.to).replaced
        : 0;
      return swept + retagSpeakerInNotes(room.ydoc, relabel.label, relabel.to).replaced;
    },
  );
}

/**
 * Carry the engine's late correction of who spoke into the meeting's doc.
 * Same tolerances as `applyNotesRelabel`, and the same reclaim wrapper: this
 * edits the agent's own lines in place, so the ledger has to come out the
 * other side still recognising them.
 */
export function applyNotesReattribution(
  rooms: NotesDocRooms,
  reattribution: NotesReattribution,
  ledger: NotesLedger,
): number {
  const room = rooms.get(reattribution.docId);
  if (!room) return 0;
  if (contentKind(room.meta.type) !== 'prose') return 0;
  const ownership = ledger.forDoc(reattribution.docId);
  // Read BEFORE the edit, for the same reason `reclaimAfterInPlaceEdit`
  // snapshots there: ownership is element AND text, and the edit changes the
  // text. Afterwards the ledger would no longer claim the very lines this is
  // allowed to touch.
  const owned = agentOwnedElements(room.ydoc, MEETING_NOTES_HEADING, ownership);
  if (owned.size === 0) return 0;
  return reclaimAfterInPlaceEdit(
    room.ydoc,
    MEETING_NOTES_HEADING,
    ownership,
    () => reattributeNotesSection(room.ydoc, reattribution, owned).replaced,
  );
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
    /** Tests: an ownership ledger they can seed or read back. */
    ledger?: NotesLedger;
  },
): MeetingNotesDeps {
  const extractor = options.taskExtractor;
  const captureBoard = deps.captureBoard;
  // One ledger per wiring, i.e. per server: it is keyed by doc and meeting,
  // and a meeting is the life of one notes section.
  const ledger = deps.ledger ?? createNotesLedger();
  const captureTasks: MeetingNotesDeps['captureTasks'] =
    options.captureTasks ??
    (extractor && captureBoard
      ? async ({ docId, turns, priorTurns }) => {
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
              priorTurns,
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
    readSection: (ids: { docId: string; meetingId: string }): NotesSectionState | null => {
      try {
        return readNotesState(deps.rooms(), ids, ledger);
      } catch (err) {
        // A section we cannot read costs the compose its awareness of the
        // person's writing, never its notes.
        console.error('[meeting-notes] section read failed:', err);
        return null;
      }
    },
    onNotes: (update: NotesUpdate): void => {
      try {
        if (!applyNotesUpdate(deps.rooms(), update, ledger)) {
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
        applyNotesRelabel(deps.rooms(), relabel, ledger);
      } catch (err) {
        // A rename that cannot reach the doc leaves a stale label, which is
        // a blemish; letting it reach the compose chain as a rejection would
        // cost the meeting its next notes, which is not.
        console.error('[meeting-notes] relabel failed:', err);
      }
      options.onRelabel?.(relabel);
    },
    onReattribute: (reattribution: NotesReattribution): void => {
      try {
        applyNotesReattribution(deps.rooms(), reattribution, ledger);
      } catch (err) {
        // Same containment as the relabel above: an attribution left stale
        // is a blemish, and a rejection reaching the compose chain would
        // cost the meeting its next notes.
        console.error('[meeting-notes] reattribution failed:', err);
      }
      options.onReattribute?.(reattribution);
    },
  };
}
