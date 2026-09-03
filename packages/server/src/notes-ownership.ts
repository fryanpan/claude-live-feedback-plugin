/**
 * Who wrote which line, and what an agent write is allowed to touch.
 *
 * THE INVARIANT the whole meeting note-taker rests on: an agent write may
 * delete or replace only what the AGENT wrote. There is no per-character
 * provenance in a Yjs doc, so ownership is a LEDGER keyed by the ELEMENT,
 * holding the markdown this module left in it. An item is the agent's only if
 * it is an element the agent wrote AND it still reads exactly as the agent
 * left it. Both halves are load-bearing: text alone would hand a person's
 * element to the agent the moment they typed a line matching one of its own,
 * and element alone would keep calling a line the agent's after they rewrote
 * it.
 *
 * The ledger is the guard, and it is structural rather than a prompt — no
 * wording the composer returns can reach a human's item. What a write DOES
 * with the answer is `meeting-notes-merge.ts`.
 */

import { prose } from '@feedback/core';
import type * as Y from 'yjs';
import { type NoteItem, findNotesSection, itemsInSection, sectionItems } from './notes-section.ts';

/**
 * The ledger: which Yjs elements the agent wrote, and the markdown it left
 * in each. Element-keyed and weak, so an item a person deletes takes its
 * entry with it and nothing here outlives the doc.
 */
export interface NotesOwnership {
  /** Did the agent write this element, and does it still read as it left it? */
  claims(el: Y.XmlElement, md: string): boolean;
  /** Record what the agent owns after a write. */
  record(items: ReadonlyArray<{ el: Y.XmlElement; md: string }>): void;
  /**
   * Drop every claim. Called when a NEW meeting starts on the doc: the notes
   * a previous recording wrote are finished writing — a fresh session that
   * still claimed them would delete them on its first from-scratch compose,
   * which is the stop-and-restart data loss the owner reported ("recording
   * replaces all existing notes"). Released, they read as somebody else's:
   * kept where they are, revisable only by suggestion.
   */
  release(): void;
}

export function createNotesOwnership(): NotesOwnership {
  let byElement = new WeakMap<Y.XmlElement, string>();
  return {
    claims: (el, md) => byElement.get(el) === md,
    record(items) {
      for (const item of items) byElement.set(item.el, item.md);
    },
    release() {
      byElement = new WeakMap();
    },
  };
}

/**
 * The identity a merge compares on: an item's KIND and its markdown. Two
 * items that read the same in different structures are not the same item —
 * a paragraph a person turned into a bullet is an edit, and comparing text
 * alone would call it unchanged.
 */
export function itemKey(item: { kind: string; md: string }): string {
  return `${item.kind} ${item.md}`;
}

/** The inverse: the markdown half of a key. `basedOn` is carried as keys, and
 *  the stale-compose check compares what it holds against item text. */
export function mdOfKey(key: string): string {
  return key.slice(key.indexOf(' ') + 1);
}

/** Which of these items the agent may revise. */
export function classifyOwnership(
  items: readonly NoteItem[],
  ownership: NotesOwnership,
): boolean[] {
  return items.map((item) => ownership.claims(item.el, item.md));
}

/** The section as it currently reads, for the composer's `previous`. */
export interface NotesSectionRead {
  /** Heading line plus body, the accepted state. */
  markdown: string;
  /** Every item's KEY, in reading order — the compose's `basedOn`. Keys
   *  rather than plain markdown so that a paragraph a person turns into a
   *  bullet mid-compose reads as the edit it is. Opaque to callers. */
  items: string[];
  /** The subset the agent did not write. */
  human: string[];
}

export function readNotesSection(
  ydoc: Y.Doc,
  heading: string,
  ownership: NotesOwnership,
): NotesSectionRead | null {
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSection(fragment, heading);
  if (!span) return null;
  const top = fragment.toArray() as Y.XmlElement[];
  const parts: string[] = [];
  for (let i = span.start; i < span.endExclusive; i++) {
    const md = prose.serializeBlockToMarkdown(top[i]!);
    if (md.length > 0) parts.push(md);
  }
  const items = itemsInSection(fragment, span);
  const isAgent = classifyOwnership(items, ownership);
  return {
    markdown: parts.join('\n\n'),
    items: items.map(itemKey),
    human: items.filter((_, i) => !isAgent[i]).map((i) => i.md),
  };
}

/**
 * Run an agent edit that rewrites text IN PLACE inside the notes section,
 * and keep the ledger's idea of its own lines in step with it.
 *
 * The speaker rename (`relabelNotesSection`) is one: it does not replace
 * items, it edits the characters inside them, so an item the ledger knows as
 * "Speaker B said yes" now reads "Dana said yes" while the ledger still
 * holds the old string. Ownership is element AND text — deliberately, so a
 * person retyping a line takes it back — which means without this the rename
 * would hand every line it touched to the person, and the note-taker could
 * never revise its own notes about that speaker again.
 *
 * Only the lines the ledger ALREADY claimed, snapshotted before the edit,
 * are re-recorded. A line the person had made theirs stays theirs: it is not
 * in the snapshot, so nothing here can claim it back.
 */
export function reclaimAfterInPlaceEdit<T>(
  ydoc: Y.Doc,
  heading: string,
  ownership: NotesOwnership,
  edit: () => T,
): T {
  const owned = new Set<Y.XmlElement>();
  const before = sectionItems(ydoc, heading);
  const claimed = classifyOwnership(before, ownership);
  for (let i = 0; i < before.length; i++) if (claimed[i]) owned.add(before[i]!.el);

  const result = edit();

  if (owned.size > 0) {
    const after = sectionItems(ydoc, heading);
    ownership.record(
      after.filter((item) => owned.has(item.el)).map((item) => ({ el: item.el, md: item.md })),
    );
  }
  return result;
}

/**
 * The elements in the notes section the ledger says the AGENT wrote — the
 * scope of an edit that may not reach a person's own writing.
 *
 * A block for a paragraph, the `listItem` for one bullet, exactly as
 * ownership is tracked: an item is the agent's only if the agent wrote that
 * element AND it still reads as the agent left it.
 */
export function agentOwnedElements(
  ydoc: Y.Doc,
  heading: string,
  ownership: NotesOwnership,
): Set<Y.XmlElement> {
  const items = sectionItems(ydoc, heading);
  const claimed = classifyOwnership(items, ownership);
  const owned = new Set<Y.XmlElement>();
  for (let i = 0; i < items.length; i++) if (claimed[i]) owned.add(items[i]!.el);
  return owned;
}
