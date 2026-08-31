/**
 * Correcting who a note says spoke.
 *
 * A speaker tag is a claim, and diarization gets claims wrong: two people
 * with similar voices trade turns and a whole exchange lands on one label.
 * The tag is the place that error is visible, so it is the place it should
 * be fixable — tap the name, pick the right voice, done.
 *
 * ONE MENTION, ALWAYS (owner's call, 2026-08-31: "reassigning should just
 * affect the one item being reassigned"). Not the turn, not the voice's
 * other notes. The larger gestures — "and every other note from this turn",
 * reaching back into the transcript — are deliberately not built: they are
 * each a different promise about scope, and the narrow one is the promise
 * nobody has to think about before tapping.
 *
 * The edit is an ordinary document edit, dispatched through the editor the
 * person is already in, so it rides the same Yjs sync, the same undo, and
 * the same ~1s flush to the .md as typing a word does. Nothing here talks to
 * the server: a correction is not a different kind of writing.
 */

import { type RosterVoice, speakerTagHref, speakerTagLabel, speakerTagText } from '@feedback/core';
import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';

/** A speaker tag as it sits in the document. */
export interface SpeakerTagRange {
  /** Start of the tag's TEXT — the sigil, not the mark boundary. */
  from: number;
  to: number;
  /** The voice the tag currently claims. */
  label: string;
  /** What the tag reads now, sigil included. */
  text: string;
}

/**
 * The speaker tag covering `pos`, or null if there isn't one.
 *
 * Walks OUT from the position to the edges of the link mark rather than
 * trusting the DOM node that was clicked: a tag whose name is partly bolded
 * is several DOM nodes and several text nodes, and half a tag is not a tag.
 */
export function findSpeakerTagAt(state: EditorState, pos: number): SpeakerTagRange | null {
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const linkType = state.schema.marks.link;
  if (!linkType) return null;

  const start = $pos.start();
  const offset = $pos.pos - start;
  let found: { from: number; to: number; label: string } | null = null;
  parent.forEach((child, childOffset) => {
    if (found || !child.isText) return;
    const end = childOffset + child.nodeSize;
    // `<=` on the end so a click landing at the tag's trailing edge still
    // finds it; a caret sitting just after the name is still on the name.
    if (offset < childOffset || offset > end) return;
    const mark = child.marks.find((m) => m.type === linkType);
    const label = mark ? speakerTagLabel(String(mark.attrs.href ?? '')) : null;
    if (label === null) return;
    // Grow across every neighbouring node carrying the SAME href: one tag,
    // however many nodes an inner mark has split it into.
    let from = childOffset;
    let to = end;
    parent.forEach((sibling, siblingOffset) => {
      if (!sibling.isText) return;
      const siblingMark = sibling.marks.find((m) => m.type === linkType);
      if (!siblingMark || speakerTagLabel(String(siblingMark.attrs.href ?? '')) !== label) return;
      const siblingEnd = siblingOffset + sibling.nodeSize;
      // Contiguity matters: the same voice tagged twice in one paragraph is
      // two tags, and only the one under the finger is being changed.
      if (siblingEnd < from || siblingOffset > to) return;
      from = Math.min(from, siblingOffset);
      to = Math.max(to, siblingEnd);
    });
    found = { from: start + from, to: start + to, label };
  });
  if (!found) return null;
  const range = found as { from: number; to: number; label: string };
  return { ...range, text: state.doc.textBetween(range.from, range.to) };
}

/**
 * Point one tag at `voice`, or at nobody.
 *
 * `null` is "this is not a quote": the words stay exactly where they are and
 * only the claim about who said them goes, sigil included. Someone typed
 * that sentence or the composer wrote it as narration — either way it is
 * prose, and prose with an @ in front of it reads like an attribution.
 *
 * Returns false when there was nothing to change, so a caller can tell a
 * no-op from a correction without comparing documents.
 */
export function applyReassign(
  editor: Editor,
  tag: SpeakerTagRange,
  voice: RosterVoice | null,
): boolean {
  const wantText = voice
    ? speakerTagText(voice.label, { [voice.label]: voice.name })
    : stripSigil(tag.text);
  const wantHref = voice ? speakerTagHref(voice.label) : null;
  if (voice && voice.label === tag.label && wantText === tag.text) return false;

  const { state } = editor;
  const linkType = state.schema.marks.link;
  if (!linkType) return false;
  const tr = state.tr;
  // Marks OTHER than the link are kept: bold inside a tag is the person's
  // emphasis, and a correction is not a reason to lose it. The link mark is
  // rebuilt rather than patched, because "nobody" has to remove it entirely.
  const carried = state.doc
    .resolve(tag.from + 1)
    .marks()
    .filter((m) => m.type !== linkType);
  const marks = wantHref ? [...carried, linkType.create({ href: wantHref })] : carried;
  tr.replaceWith(tag.from, tag.to, state.schema.text(wantText, marks));
  editor.view.dispatch(tr);
  return true;
}

/** "@Devi" → "Devi". A tag that has stopped being a tag keeps its words. */
function stripSigil(text: string): string {
  return text.startsWith('@') ? text.slice(1) : text;
}
