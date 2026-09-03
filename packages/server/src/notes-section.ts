/**
 * The shape of a notes section: where it is, and what it is made of.
 *
 * THE UNIT IS AN ITEM, NOT A BLOCK. A markdown bullet list is ONE top-level
 * block, so block granularity would hand the agent's entire list to the
 * human the moment they fixed one bullet — and then re-add the agent's list
 * beside it. So a list decomposes into its items, and everything else is
 * itself one item. Everything here reads that decomposition, in the doc or in
 * a string the composer just returned; nothing here decides who owns an item
 * (`notes-ownership.ts`) or writes one (`meeting-notes-merge.ts`).
 */

import { prose } from '@feedback/core';
import * as Y from 'yjs';

/** One addressable thing in the notes section: a top-level block, or one
 *  item of a top-level list. */
export interface NoteItem {
  /** Markdown identity, in the ACCEPTED state — pending suggestion text is
   *  excluded by the serializer, so a proposal never re-classifies its own
   *  target. */
  md: string;
  kind: 'block' | 'item';
  /** The top-level block, or the `listItem`. */
  el: Y.XmlElement;
  /** The owning list, when `kind` is `item`. */
  list?: Y.XmlElement;
  ordered?: boolean;
}

/** An item of the composer's output — markdown only, nothing in a doc yet. */
export interface IncomingItem {
  md: string;
  kind: 'block' | 'item';
  ordered: boolean;
}

export interface NotesSectionSpan {
  /** Index of the heading in the top-level fragment. */
  start: number;
  /** First index past the section body. */
  endExclusive: number;
  heading: Y.XmlElement;
}

/**
 * The heading this meeting's notes are WRITTEN under. Finding it again is the
 * whole contract, so this string changing would orphan every live doc's
 * section mid-meeting — which is why the finder matches the list below rather
 * than this one constant.
 */
export const MEETING_NOTES_HEADING = 'Meeting notes';

/**
 * Every heading a notes section has been written under, canonical first.
 *
 * A tick FINDS its section under any of these and WRITES a new one under
 * `[0]`. Today the list has one entry, because the heading has never been
 * anything else — but "which heading does the section have" is exactly the
 * question a rename gets wrong, and the failure mode is silent: the finder
 * misses the section a previous release wrote and the tick appends a second
 * one below it. Renaming the section means unshifting the new spelling here,
 * never editing the old one out.
 */
export const MEETING_NOTES_HEADINGS: readonly string[] = [MEETING_NOTES_HEADING];

/**
 * The section holding the meeting's own words, verbatim. It is the doc's TAIL
 * — everything the meeting writes goes above it — so it is named here beside
 * the notes heading rather than in the module that writes it: every writer
 * that appends a section to a meeting doc has to know to stop short of it.
 */
export const TRANSCRIPT_HEADING = 'Raw transcript';

/**
 * Where a new top-level section belongs in a meeting doc: above the raw
 * transcript when the doc has one, at the end when it does not.
 *
 * The transcript is machine text nobody reads top to bottom, so it sits under
 * everything a person might. Every append into a meeting doc goes through
 * here — the notes' first write, the research placeholder — because a section
 * appended past the transcript is both in the wrong place and, until this
 * existed, the thing that pushed the notes section off the doc's tail.
 */
export function sectionInsertIndex(fragment: Y.XmlFragment): number {
  const transcript = findNotesSection(fragment, TRANSCRIPT_HEADING);
  return transcript ? transcript.start : fragment.length;
}

/** The heading's text, read the same way the serializer would render it. */
export function headingText(el: Y.XmlElement): string {
  const line = prose.serializeBlockToMarkdown(el).split('\n', 1)[0] ?? '';
  return line.replace(/^#{1,6}\s+/, '').trim();
}

/**
 * Where the notes section sits: its heading's index and the first index past
 * its body (the next heading at the same or a higher level, or the end).
 * Null when the heading is absent — the "never written yet" state, not a
 * failure.
 *
 * `heading` may be one string or a list of them, in which case any of them
 * identifies the section — that is how a section written under an older
 * spelling is still the section this meeting extends rather than a second one
 * it appends below.
 *
 * The LAST matching heading, not the first. A doc that already carries two
 * (every doc a research placeholder split before this was fixed) gets its
 * NEWEST section extended, which is the one the reader is watching; the older
 * one keeps its lines and is never written into again.
 */
export function findNotesSection(
  fragment: Y.XmlFragment,
  heading: string | readonly string[],
): NotesSectionSpan | null {
  const wanted = typeof heading === 'string' ? [heading] : heading;
  const top = fragment.toArray() as Y.XmlElement[];
  let start = -1;
  let level = 0;
  for (let i = 0; i < top.length; i++) {
    const el = top[i]!;
    if (el.nodeName !== 'heading') continue;
    if (!wanted.includes(headingText(el))) continue;
    start = i;
    level = prose.headingLevelOf(el);
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
  return { start, endExclusive, heading: top[start]! };
}

export function isList(el: Y.XmlElement): boolean {
  return el.nodeName === 'bulletList' || el.nodeName === 'orderedList';
}

function contIndent(ordered: boolean): string {
  return ordered ? '   ' : '  ';
}

export function marker(ordered: boolean): string {
  return ordered ? '1. ' : '- ';
}

/**
 * One list item as markdown, WITHOUT its marker: the first child block on
 * line one, every later child indented under it. `serializeBlockToMarkdown`
 * on a `listItem` runs its children together with no separator, which is
 * fine as a rendering and useless as an identity.
 */
export function listItemMarkdown(item: Y.XmlElement, ordered: boolean): string {
  const parts: string[] = [];
  for (const child of item.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    const md = prose.serializeBlockToMarkdown(child);
    if (md.length > 0) parts.push(md);
  }
  if (parts.length === 0) return '';
  const [head, ...rest] = parts;
  const ind = contIndent(ordered);
  return [
    head,
    ...rest.map((p) =>
      p
        .split('\n')
        .map((l) => ind + l)
        .join('\n'),
    ),
  ].join('\n');
}

/** Flatten one top-level block into the items it contributes. */
function itemsOfBlock(el: Y.XmlElement): NoteItem[] {
  if (!isList(el)) {
    const md = prose.serializeBlockToMarkdown(el);
    return md.length > 0 ? [{ md, kind: 'block', el }] : [];
  }
  const ordered = el.nodeName === 'orderedList';
  const out: NoteItem[] = [];
  for (const child of el.toArray()) {
    if (!(child instanceof Y.XmlElement) || child.nodeName !== 'listItem') continue;
    const md = listItemMarkdown(child, ordered);
    if (md.length > 0) out.push({ md, kind: 'item', el: child, list: el, ordered });
  }
  return out;
}

/** The section body as a flat item list, in reading order. */
export function itemsInSection(fragment: Y.XmlFragment, span: NotesSectionSpan): NoteItem[] {
  const top = fragment.toArray() as Y.XmlElement[];
  const out: NoteItem[] = [];
  for (let i = span.start + 1; i < span.endExclusive; i++) out.push(...itemsOfBlock(top[i]!));
  return out;
}

/**
 * The same flattening for markdown that is not in a doc yet. Parsed into a
 * SCRATCH doc rather than read off `parseMarkdownBlocks` directly: Yjs
 * refuses to read a type that has never been attached to a document, so the
 * blocks it hands back serialize to nothing until something owns them.
 */
export function itemsOfMarkdown(markdown: string): IncomingItem[] | null {
  const scratch = new Y.Doc();
  const fragment = prose.getProseFragment(scratch);
  try {
    prose.applyMarkdownToFragment(fragment, markdown);
  } catch {
    return null;
  }
  const blocks = fragment.toArray() as Y.XmlElement[];
  const out: IncomingItem[] = [];
  for (const block of blocks) {
    if (isList(block)) {
      const ordered = block.nodeName === 'orderedList';
      for (const child of block.toArray()) {
        if (!(child instanceof Y.XmlElement) || child.nodeName !== 'listItem') continue;
        const md = listItemMarkdown(child, ordered);
        if (md.length > 0) out.push({ md, kind: 'item', ordered });
      }
      continue;
    }
    const md = prose.serializeBlockToMarkdown(block);
    if (md.length > 0) out.push({ md, kind: 'block', ordered: false });
  }
  return out;
}

/**
 * Drop the composer's own copies of the section heading, and demote any level
 * 1-2 heading left in the body — a body heading at the section's own level
 * would end the section span and orphan everything under it.
 *
 * EVERY copy, not just the leading one. A model asked to "start with the
 * exact heading" sometimes says it twice, and the demotion below turned the
 * second one into `### Meeting notes` — a heading the finder reads as the
 * section, at a level that ends nothing, so the doc came out with two
 * headings reading "Meeting notes" and the tick wrote into the lower one. A
 * repeated section heading carries no information the first one did not, so
 * the line goes and whatever it introduced stays where it was.
 */
export function stripSectionHeading(markdown: string, heading: string | readonly string[]): string {
  const wanted = typeof heading === 'string' ? [heading] : heading;
  const lines = markdown.split('\n');
  let fenced = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    const h = fenced ? null : line.match(/^(#{1,6})\s+(.*)$/);
    if (!h) {
      out.push(line);
      continue;
    }
    if (wanted.includes(h[2]!.trim())) continue;
    out.push(h[1]!.length <= 2 ? `### ${h[2]}` : line);
  }
  return out.join('\n').trim();
}

/** The section's items, or none when the section is not there. */
export function sectionItems(ydoc: Y.Doc, heading: string | readonly string[]): NoteItem[] {
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSection(fragment, heading);
  return span ? itemsInSection(fragment, span) : [];
}
