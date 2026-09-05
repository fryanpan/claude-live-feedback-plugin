/**
 * Merging composed meeting notes into a section a HUMAN is also writing in.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID is `replaceNotesSection`: it deletes
 * the whole notes section and re-inserts a string the server composed, so
 * every pause tick discards whatever the person typed into the section since
 * the last one. That is the injury the owner reported in as many words —
 * "destroyed my notes" — and a note-taker that eats what you write is worse
 * than no note-taker, because you stop trusting it.
 *
 * THE INVARIANT: an agent write may delete or replace only what the AGENT
 * wrote. Anything else in the section is a person's writing, and it is kept
 * where it is, as the same Yjs elements — not re-created from markdown, so
 * its marks, its comment anchors, and a collaborator's cursor inside it all
 * survive. The guard is structural, not a prompt: no wording the composer
 * returns can reach a human's item.
 *
 * WHAT "THE AGENT WROTE" MEANS. There is no per-character provenance in the
 * doc, so ownership is a LEDGER keyed by the Yjs ELEMENT, holding the
 * markdown this module left in it. An item is the agent's only if it is an
 * element the agent wrote AND it still reads exactly as the agent left it;
 * an item that reads differently — edited — is a person's, and stays a
 * person's from then on, as does any element the agent never wrote. Both
 * halves are load-bearing: text alone would hand a person's element to the
 * agent the moment they typed a line that matched one of its own, and
 * element alone would keep calling a line the agent's after they rewrote it.
 *
 * THE UNIT IS AN ITEM, NOT A BLOCK. A markdown bullet list is ONE top-level
 * block, so block granularity would hand the agent's entire list to the
 * human the moment they fixed one bullet — and then re-add the agent's list
 * beside it. So a list decomposes into its items, and everything else is
 * itself one item.
 *
 * WHERE THE AGENT WANTS TO CHANGE A PERSON'S WORDS, IT SUGGESTS. The
 * composer is told to reproduce human items verbatim; when it returns
 * something close-but-different in a human item's place, that is a proposed
 * improvement, and it lands as a redline suggestion (the repo's existing
 * `suggestOps` marks) on that item. Accepting it is the person's move.
 *
 * THE STALE-COMPOSE RACE. A compose that started before the person's edit
 * answers from the older text, so its "improvement" of an item they have
 * since changed is not an improvement at all — it is the old words coming
 * back. `basedOn` is the item list as the compose saw it, and it catches the
 * race from both sides: an item NOT in it arrived during the compose, so a
 * collision with one of those is dropped rather than suggested; an item that
 * IS in it and is no longer in the doc is one the person edited or removed
 * during the compose, so anything the compose says that reads like it is
 * dropped rather than inserted. Nothing is lost: the composer returns the
 * whole notes every tick, and the next tick reads the person's text.
 */

import {
  SUGGEST_DELETE_MARK,
  SUGGEST_INSERT_MARK,
  prose,
  speakerLabelsIn,
  suggestOps,
} from '@feedback/core';
import * as Y from 'yjs';
import { type NotesOwnership, classifyOwnership, itemKey, mdOfKey } from './notes-ownership.ts';
import {
  type IncomingItem,
  MEETING_NOTES_HEADING,
  type NoteItem,
  type NotesSectionSpan,
  findNotesSection,
  headingText,
  isList,
  itemsInSection,
  itemsOfMarkdown,
  marker,
  sectionInsertIndex,
  stripSectionHeading,
} from './notes-section.ts';

/** Who a proposed change to a person's note is attributed to. */
export const NOTES_SUGGESTION_AUTHOR: suggestOps.SuggestionAuthor = {
  id: 'meeting-notes',
  name: 'Meeting Assistant',
  color: '#7c5cff',
};

/**
 * How alike an incoming item and a human item must read before the incoming
 * one counts as a REWRITE of it rather than a new note of its own. Word-bag
 * Dice: 0.6 keeps "we should ship on Friday" against "Ship on Friday"
 * together and keeps two unrelated bullets apart.
 */
export const NOTES_REWRITE_SIMILARITY = 0.6;

/**
 * Reading a section apart into its items moved to `notes-section.ts`. The
 * names stay on this module's surface, so no caller and no test moved with
 * them.
 */
export {
  type IncomingItem,
  type NoteItem,
  type NotesSectionSpan,
  LEGACY_TRANSCRIPT_HEADING,
  MEETING_NOTES_HEADING,
  MEETING_NOTES_HEADINGS,
  findNotesSection,
  itemsInSection,
  itemsOfMarkdown,
  listItemMarkdown,
  sectionInsertIndex,
  stripSectionHeading,
} from './notes-section.ts';

/**
 * The ownership ledger moved to `notes-ownership.ts`, and the two reads that
 * go through it with it. Every name stays on this module's surface.
 */
export {
  type NotesOwnership,
  type NotesSectionRead,
  agentOwnedElements,
  classifyOwnership,
  createNotesOwnership,
  itemKey,
  readNotesSection,
  reclaimAfterInPlaceEdit,
} from './notes-ownership.ts';

/** Word-bag Dice coefficient — punctuation and case ignored. */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const bag = new Map<string, number>();
  for (const t of ta) bag.set(t, (bag.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of tb) {
    const n = bag.get(t) ?? 0;
    if (n > 0) {
      shared++;
      bag.set(t, n - 1);
    }
  }
  return (2 * shared) / (ta.length + tb.length);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((t) => t.length > 0);
}

/** Longest common subsequence, as index pairs. Both sides are a handful of
 *  bullets, so the quadratic table is free. */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/** A run of new agent items to insert after `after` (null = section start). */
export interface InsertRun {
  after: NoteItem | null;
  entries: IncomingItem[];
}

export interface SuggestionPlan {
  target: NoteItem;
  replacement: string;
}

export interface MergePlan {
  deletes: NoteItem[];
  inserts: InsertRun[];
  suggestions: SuggestionPlan[];
  /** Incoming items withheld because the person's item they collide with is
   *  newer than the compose that produced them. */
  dropped: string[];
  /** Agent items this plan leaves exactly as they are — still the agent's
   *  after the write, so still in the ledger. */
  keptAgent: NoteItem[];
}

/**
 * Decide what to change, without touching the doc. Pure, so the invariant —
 * no human item is ever deleted — is a property of a value a test can read.
 */
export function planNotesMerge(
  current: readonly NoteItem[],
  incoming: readonly IncomingItem[],
  opts: { ownership: NotesOwnership; basedOn?: readonly string[] },
): MergePlan {
  const isAgent = classifyOwnership(current, opts.ownership);
  const seenBefore = opts.basedOn ? consumable(opts.basedOn) : null;
  // An item the compose never saw is FRESH: it arrived while the compose was
  // in flight, so nothing the compose says about it can be an improvement on
  // it. Consumed in reading order, for the same multiset reason ownership is.
  const fresh = current.map((item) => (seenBefore ? !seenBefore(itemKey(item)) : false));
  // What the compose READ that is no longer in the doc: an item a person
  // edited away, deleted, or restructured while it was thinking. Everything
  // these notes say about one of those was written from words already gone.
  const vanished = missingFrom(opts.basedOn ?? [], current);

  const pairs = lcsPairs(current.map(itemKey), incoming.map(itemKey));
  // The lines that are still in the doc after this write: everything the
  // output lines up with (anchored — whoever wrote it, it stays), and the
  // person's lines it does not. An incoming entry matching one of these
  // exactly is the composer echoing a line back somewhere else — a second
  // tick re-listing an earlier point, say — and the line is already in the
  // doc, so re-inserting it would leave two of it.
  const anchored = new Set(pairs.map(([pi]) => pi));
  const echoOf = consumable(current.filter((_, i) => anchored.has(i) || !isAgent[i]).map(itemKey));

  const plan: MergePlan = {
    deletes: [],
    inserts: [],
    suggestions: [],
    dropped: [],
    keptAgent: [],
  };
  let ci = 0;
  let ii = 0;
  let anchor: NoteItem | null = null;

  const resolveGap = (
    gapCur: NoteItem[],
    gapAgent: boolean[],
    gapFresh: boolean[],
    gapInc: IncomingItem[],
  ): void => {
    // An entry that IS one of the person's lines, verbatim, is settled
    // before anything else looks at it: it is neither a proposal nor a new
    // note, it is their line, and it is already where they put it.
    const claimed = new Set<number>();
    for (let k = 0; k < gapInc.length; k++) {
      if (echoOf(itemKey(gapInc[k]!))) claimed.add(k);
    }
    // Pair each of the person's items with the incoming item that reads most
    // like it: that pairing is the composer proposing a rewrite of it.
    const pairedWith = new Map<number, number>();
    for (let h = 0; h < gapCur.length; h++) {
      if (gapAgent[h]) continue;
      let best = -1;
      // Starts below every real score, and the threshold is checked
      // separately — a line scoring EXACTLY the cutoff is a rewrite, which
      // is what the constant's own comment says. Ties go to the first, so
      // the composer's order breaks them.
      let bestScore = -1;
      for (let k = 0; k < gapInc.length; k++) {
        if (claimed.has(k)) continue;
        const s = similarity(gapCur[h]!.md, gapInc[k]!.md);
        if (s >= NOTES_REWRITE_SIMILARITY && s > bestScore) {
          bestScore = s;
          best = k;
        }
      }
      if (best >= 0) {
        claimed.add(best);
        pairedWith.set(h, best);
      }
    }
    for (let h = 0; h < gapCur.length; h++) {
      const item = gapCur[h]!;
      if (gapAgent[h]) {
        plan.deletes.push(item);
        continue;
      }
      const k = pairedWith.get(h);
      if (k !== undefined) {
        const replacement = gapInc[k]!.md;
        if (gapFresh[h] || !canSuggestOn(item, gapInc[k]!)) plan.dropped.push(replacement);
        else plan.suggestions.push({ target: item, replacement });
      }
      anchor = item;
    }
    const entries: IncomingItem[] = [];
    for (let k = 0; k < gapInc.length; k++) {
      if (claimed.has(k)) continue;
      // An entry that reads like something the compose saw and the person
      // has since changed is that older wording coming back. Withhold it —
      // the next tick composes from what they wrote.
      const stale = takeSimilar(vanished, gapInc[k]!.md);
      if (stale) {
        plan.dropped.push(gapInc[k]!.md);
        continue;
      }
      entries.push(gapInc[k]!);
    }
    if (entries.length > 0) plan.inserts.push({ after: anchor, entries });
  };

  const walk: Array<[number, number]> = [...pairs, [current.length, incoming.length]];
  for (const [pi, pj] of walk) {
    resolveGap(
      current.slice(ci, pi),
      isAgent.slice(ci, pi),
      fresh.slice(ci, pi),
      incoming.slice(ii, pj),
    );
    if (pi < current.length) {
      const kept = current[pi]!;
      if (isAgent[pi]) plan.keptAgent.push(kept);
      anchor = kept;
    }
    ci = pi + 1;
    ii = pj + 1;
  }
  return plan;
}

/**
 * Does this plan want a topic heading INSIDE a run of bullets?
 *
 * The item-level merge inserts a top-level block by putting it after the
 * whole list its cursor sits in — Yjs cannot re-parent an existing element,
 * so there is no way to split a list around a new heading without
 * re-creating the items below it. Left alone, a tick that first groups the
 * meeting into topics therefore lands every heading below every bullet: the
 * notes come out as a run of bullets followed by a stack of empty headings,
 * which is worse than the flat list it was trying to organise.
 *
 * So the case is DETECTED rather than approximated, and the caller rebuilds
 * the section body instead — allowed only when every item in it is the
 * agent's own, which is the same invariant as everywhere else here.
 *
 * It is deliberately narrow. A heading the notes already carry is matched by
 * the diff and never appears in an insert run at all, so an ordinary tick —
 * bullets added under headings that already exist — never takes this path,
 * and the items in the section keep their elements, their marks and their
 * comment anchors. Only the tick that MOVES the furniture pays for it.
 */
export function planNeedsRelayout(current: readonly NoteItem[], plan: MergePlan): boolean {
  const lastOfList = (item: NoteItem): boolean => {
    if (item.kind !== 'item' || !item.list) return true;
    const children = item.list.toArray();
    return children.indexOf(item.el) === children.length - 1;
  };
  for (const run of plan.inserts) {
    if (!run.entries.some((e) => e.kind === 'block')) continue;
    // The top of the body: a block landing here is pushed below a list that
    // already opens it.
    if (!run.after) {
      if (current[0]?.kind === 'item') return true;
      continue;
    }
    if (!lastOfList(run.after)) return true;
  }
  return false;
}

/** The markdown of the `basedOn` entries no longer present among `current`,
 *  matched by item key so a restructured item counts as gone. */
function missingFrom(basedOn: readonly string[], current: readonly NoteItem[]): string[] {
  const still = consumable(current.map(itemKey));
  const gone: string[] = [];
  for (const key of basedOn) if (!still(key)) gone.push(mdOfKey(key));
  return gone;
}

/** Take the entry of `pool` that reads most like `md`, if any is close
 *  enough. Mutates `pool` — one vanished line explains one incoming line. */
function takeSimilar(pool: string[], md: string): string | null {
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < pool.length; i++) {
    const s = similarity(pool[i]!, md);
    if (s >= NOTES_REWRITE_SIMILARITY && s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  if (best < 0) return null;
  return pool.splice(best, 1)[0] ?? null;
}

/**
 * Every notes section that is NOT the one being written into — a previous
 * meeting's, or this meeting's own earlier section once a person's heading
 * pushed it off the end of the doc. Their lines are written; they are not
 * re-added.
 */
function dropEchoesOfEarlierSections(
  incoming: readonly IncomingItem[],
  fragment: Y.XmlFragment,
  headings: readonly string[],
  target: NotesSectionSpan | null,
): IncomingItem[] {
  const top = fragment.toArray() as Y.XmlElement[];
  const keys: string[] = [];
  for (let i = 0; i < top.length; i++) {
    const el = top[i]!;
    if (el.nodeName !== 'heading' || !headings.includes(headingText(el))) continue;
    if (target && i === target.start) continue;
    const level = prose.headingLevelOf(el);
    let endExclusive = top.length;
    for (let j = i + 1; j < top.length; j++) {
      const h = top[j]!;
      if (h.nodeName === 'heading' && prose.headingLevelOf(h) <= level) {
        endExclusive = j;
        break;
      }
    }
    for (const item of itemsInSection(fragment, { start: i, endExclusive, heading: el })) {
      keys.push(itemKey(item));
    }
  }
  if (keys.length === 0) return [...incoming];
  const written = consumable(keys);
  return incoming.filter((item) => !written(itemKey(item)));
}

/** Entries back to markdown: items keep their markers and run as one tight
 *  list where they are consecutive; blocks stand apart. */
function markdownOfItems(items: readonly IncomingItem[]): string {
  const out: string[] = [];
  let prev: IncomingItem | null = null;
  for (const item of items) {
    const md = item.kind === 'item' ? marker(item.ordered) + item.md : item.md;
    const tight = prev?.kind === 'item' && item.kind === 'item' && prev.ordered === item.ordered;
    out.push((tight ? '\n' : out.length ? '\n\n' : '') + md);
    prev = item;
  }
  return out.join('');
}

function consumable(mds: readonly string[]): (md: string) => boolean {
  const left = new Map<string, number>();
  for (const md of mds) left.set(md, (left.get(md) ?? 0) + 1);
  return (md: string): boolean => {
    const n = left.get(md) ?? 0;
    if (n === 0) return false;
    left.set(md, n - 1);
    return true;
  };
}

/** A proposal can only be expressed as a redline on text that is one line of
 *  prose. A heading, a table, a multi-line item: left alone rather than
 *  half-rewritten. */
function canSuggestOn(target: NoteItem, incoming: IncomingItem): boolean {
  if (target.kind !== incoming.kind) return false;
  if (target.md.includes('\n') || incoming.md.includes('\n')) return false;
  if (target.kind === 'block' && target.el.nodeName !== 'paragraph') return false;
  if (attributesToNewVoice(target.md, incoming.md)) return false;
  return textNodesOf(target) !== null;
}

/**
 * Would taking `incoming` in place of `before` say a VOICE said something
 * `before` did not credit to anyone?
 *
 * This is the guard on a person's own note. A line somebody typed into the
 * notes is their idea, and the composer — seeing it beside a transcript —
 * will sometimes return it with a speaker tag on the front, which reads as
 * that voice having said it. That is not a wording proposal, it is a change
 * of authorship, and it is not the composer's to make: attribution moves by
 * the reassign gesture, never by a suggestion nobody read as one.
 *
 * Only NEW labels count. Re-emitting a tag the line already carries is the
 * composer preserving an attribution, which is exactly what it is asked to
 * do when it revises the words around one.
 */
function attributesToNewVoice(before: string, incoming: string): boolean {
  const had = new Set(speakerLabelsIn(before));
  return speakerLabelsIn(incoming).some((label) => !had.has(label));
}

/** The Y.XmlText run carrying an item's own words. Null when the shape is
 *  not one this module knows how to redline. */
function textNodesOf(item: NoteItem): Y.XmlText[] | null {
  const holder =
    item.kind === 'item'
      ? (item.el.toArray().find((c) => c instanceof Y.XmlElement && c.nodeName === 'paragraph') as
          | Y.XmlElement
          | undefined)
      : item.el;
  if (!holder) return null;
  const texts = holder.toArray().filter((c) => c instanceof Y.XmlText) as Y.XmlText[];
  return texts.length > 0 ? texts : null;
}

export interface MergeNotesResult {
  ok: boolean;
  error?: 'empty' | 'parse-failed';
  /** `appended` on a section's first write, `merged` after that. */
  mode?: 'appended' | 'merged';
  deleted: number;
  inserted: number;
  suggested: number;
  dropped: number;
}

/** One item the agent now owns: the element it wrote, and the markdown it
 *  left in it. */
export interface OwnedItem {
  el: Y.XmlElement;
  md: string;
}

/**
 * Apply a plan to the doc. One transaction for the structural half, so no
 * browser renders a half-merged section; suggestions are created after it
 * because `suggestRewriteRange` transacts for itself.
 */
function applyPlan(
  ydoc: Y.Doc,
  plan: MergePlan,
  heading: Y.XmlElement,
  author: suggestOps.SuggestionAuthor,
): { deleted: number; inserted: number; suggested: number; owned: OwnedItem[] } {
  const fragment = prose.getProseFragment(ydoc);
  let deleted = 0;
  const owned: OwnedItem[] = [];
  const touchedLists = new Set<Y.XmlElement>();

  ydoc.transact(() => {
    for (const item of plan.deletes) {
      if (item.kind === 'item' && item.list) {
        const idx = item.list.toArray().indexOf(item.el);
        if (idx < 0) continue;
        item.list.delete(idx, 1);
        touchedLists.add(item.list);
        deleted++;
        continue;
      }
      const idx = fragment.toArray().indexOf(item.el);
      if (idx < 0) continue;
      fragment.delete(idx, 1);
      deleted++;
    }
    // A list emptied by those deletes is not a list any more, and leaving it
    // would put a stray empty block between the person's notes.
    for (const list of touchedLists) {
      const hasItem = list
        .toArray()
        .some((c) => c instanceof Y.XmlElement && c.nodeName === 'listItem');
      if (hasItem) continue;
      const idx = fragment.toArray().indexOf(list);
      if (idx >= 0) fragment.delete(idx, 1);
    }
    for (const run of plan.inserts) owned.push(...applyRun(fragment, run, heading));
  }, 'agent');

  let suggested = 0;
  for (const s of plan.suggestions) if (createSuggestion(ydoc, s, author)) suggested++;
  return { deleted, inserted: owned.length, suggested, owned };
}

/** Where the next inserted item goes: a slot in the top-level fragment, or a
 *  slot inside one list. */
type Cursor =
  | { at: 'top'; index: number }
  | { at: 'list'; list: Y.XmlElement; index: number; ordered: boolean };

/** Insert a run, returning each new item paired with the element that now
 *  holds it — the ledger's half of the write. */
function applyRun(fragment: Y.XmlFragment, run: InsertRun, heading: Y.XmlElement): OwnedItem[] {
  let cursor = startCursor(fragment, run.after, heading);
  const owned: OwnedItem[] = [];
  for (const entry of run.entries) {
    // A single-line bullet joins the list the cursor is already in: that is
    // the ONLY path that does not re-create a block, which is why it is the
    // preferred one — every other item becomes its own top-level block.
    if (
      entry.kind === 'item' &&
      cursor.at === 'list' &&
      cursor.ordered === entry.ordered &&
      !entry.md.includes('\n')
    ) {
      const li = buildListItem();
      cursor.list.insert(cursor.index, [li]);
      const holder = li.toArray()[0] as Y.XmlElement;
      const text = holder.toArray()[0] as Y.XmlText;
      prose.insertTextWithMarks(text, 0, entry.md, { parseInlineMarks: true });
      cursor = { ...cursor, index: cursor.index + 1 };
      owned.push({ el: li, md: entry.md });
      continue;
    }
    const markdown = entry.kind === 'item' ? marker(entry.ordered) + entry.md : entry.md;
    let blocks: Y.XmlElement[];
    try {
      blocks = prose.parseMarkdownBlocks(markdown);
    } catch {
      continue;
    }
    if (blocks.length === 0) continue;
    const topIndex =
      cursor.at === 'top' ? cursor.index : fragment.toArray().indexOf(cursor.list) + 1;
    fragment.insert(topIndex, blocks);
    const first = blocks[0]!;
    // The element the ledger must key on is the one `itemsInSection` will
    // hand back next time: a list contributes its listItem, not itself.
    const holder = isList(first)
      ? ((first.toArray().find((c) => c instanceof Y.XmlElement && c.nodeName === 'listItem') ??
          first) as Y.XmlElement)
      : first;
    owned.push({ el: holder, md: entry.md });
    const last = blocks[blocks.length - 1]!;
    cursor = isList(last)
      ? { at: 'list', list: last, index: last.length, ordered: last.nodeName === 'orderedList' }
      : { at: 'top', index: topIndex + blocks.length };
  }
  return owned;
}

function startCursor(
  fragment: Y.XmlFragment,
  after: NoteItem | null,
  heading: Y.XmlElement,
): Cursor {
  if (!after) {
    // No anchor: the top of the section body, right under its heading. Its
    // index is read live — nothing this module deletes is a heading, but
    // deletes above it have already moved it.
    const top = fragment.toArray() as Y.XmlElement[];
    const at = top.indexOf(heading);
    if (at < 0) return { at: 'top', index: fragment.length };
    // The body already opens with a list: join it rather than laying a
    // second list against it. Two adjacent lists read as one gap-separated
    // list in the editor and are one list again after a disk round trip —
    // a difference the person sees and nobody asked for.
    const first = top[at + 1];
    if (first && isList(first)) {
      return { at: 'list', list: first, index: 0, ordered: first.nodeName === 'orderedList' };
    }
    return { at: 'top', index: at + 1 };
  }
  if (after.kind === 'item' && after.list) {
    const idx = after.list.toArray().indexOf(after.el);
    if (idx >= 0) {
      return { at: 'list', list: after.list, index: idx + 1, ordered: after.ordered === true };
    }
  }
  const holder = after.kind === 'item' && after.list ? after.list : after.el;
  const idx = fragment.toArray().indexOf(holder);
  return { at: 'top', index: idx >= 0 ? idx + 1 : fragment.length };
}

/** An empty `listItem > paragraph > text`, ready for the item's words. A
 *  parsed one cannot be used: Yjs will not re-parent a node that already has
 *  one, and the parsed list IS its parent. */
function buildListItem(): Y.XmlElement {
  const li = new Y.XmlElement('listItem');
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  li.insert(0, [p]);
  p.insert(0, [t]);
  return li;
}

/**
 * Propose the composer's wording over a person's, as a redline on the item
 * itself. Skipped when the same proposal is already pending: a person who
 * has not answered one yet must not collect a new copy every pause.
 */
function createSuggestion(
  ydoc: Y.Doc,
  plan: SuggestionPlan,
  author: suggestOps.SuggestionAuthor,
): boolean {
  const texts = textNodesOf(plan.target);
  if (!texts) return false;
  const first = texts[0]!;
  const last = texts[texts.length - 1]!;
  // One pending proposal per item at a time. A person who has not answered
  // the last one must not collect a fresh copy every pause — and the marks
  // ARE the registry, so the doc is the only place to ask.
  const holder = first.parent;
  const pending = suggestOps.scanSuggestions(prose.getProseFragment(ydoc));
  for (const entry of pending.values()) {
    for (const range of entry.ranges) {
      if (range.block === holder || range.block === plan.target.el) return false;
    }
  }
  const res = suggestOps.suggestRewriteRange(ydoc, {
    startRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(first, 0)),
    endRel: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(last, last.length)),
    replacement: plan.replacement,
    parseInlineMarks: true,
    author,
  });
  return res.ok;
}

/**
 * Is anything in this span still waiting for somebody to accept or reject it?
 *
 * ASKING THE PLAN IS NOT ENOUGH, and the first version of the relayout gate
 * asked only the plan: `plan.suggestions.length === 0` counts what THIS tick
 * proposes and knows nothing about a proposal already sitting in the doc.
 * Worse, a pending proposal can be invisible to every other check here — a
 * block or list item whose every character is a pending insert serializes to
 * the empty string, so it never becomes a `NoteItem`, never reaches
 * `classifyOwnership`, and leaves `allAgent` true. Relayout would then delete
 * the span it lives in and the proposal with it, reporting `suggested: 0` and
 * leaving no trace in the Yjs tree.
 *
 * So this reads the DOC, walking the span for either suggestion mark. It is
 * deliberately coarse: any pending mark anywhere in the section refuses the
 * relayout, and the ordinary merge runs instead — which puts the heading
 * below the list rather than inside it. Worse looking, and it cannot eat
 * somebody's proposal.
 */
export function spanHasPendingSuggestion(fragment: Y.XmlFragment, span: NotesSectionSpan): boolean {
  const marked = (text: Y.XmlText): boolean =>
    text
      .toDelta()
      .some(
        (op: { attributes?: Record<string, unknown> }) =>
          op.attributes?.[SUGGEST_INSERT_MARK] != null ||
          op.attributes?.[SUGGEST_DELETE_MARK] != null,
      );
  const walk = (node: Y.XmlElement | Y.XmlText): boolean => {
    if (node instanceof Y.XmlText) return marked(node);
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText || child instanceof Y.XmlElement) {
        if (walk(child)) return true;
      }
    }
    return false;
  };
  const top = fragment.toArray();
  for (let i = span.start; i < span.endExclusive && i < top.length; i++) {
    const node = top[i];
    if (node instanceof Y.XmlText || node instanceof Y.XmlElement) {
      if (walk(node)) return true;
    }
  }
  return false;
}

/**
 * Rewrite the section body to the shape the composer returned, and hand the
 * ledger the elements it now holds.
 *
 * Every item written here is the agent's — the caller has already checked
 * that every item REPLACED was too — so this is the invariant's own move
 * rather than an exception to it. What it costs is element identity: a
 * comment anchored to one of the agent's bullets is anchored to an element
 * that no longer exists, and lands in the outdated-comment flow. That price
 * is why the caller pays it only on the tick that reorganises, and never on
 * a tick that merely adds a bullet.
 *
 * Null when the composer's markdown will not parse, which leaves the caller
 * on the ordinary path rather than on an empty section.
 */
function relayoutSection(
  ydoc: Y.Doc,
  fragment: Y.XmlFragment,
  span: NotesSectionSpan,
  incoming: readonly IncomingItem[],
  canonical: string,
  headings: readonly string[],
  ownership: NotesOwnership,
  dropped: readonly string[],
): { deleted: number; inserted: number; dropped: number } | null {
  // THE PLAN'S DROP LIST APPLIES HERE TOO. `incoming` is what the composer
  // returned, and the plan has already decided some of it must not be
  // written — an item whose person's line is newer than the compose that
  // produced it, or a bullet somebody deleted while the compose was in
  // flight. Writing `incoming` wholesale put those back, silently undoing a
  // deletion and reporting `dropped: 0` while the ordinary path reported 1.
  const withheld = new Map<string, number>();
  for (const md of dropped) withheld.set(md, (withheld.get(md) ?? 0) + 1);
  const keep: IncomingItem[] = [];
  for (const item of incoming) {
    const left = withheld.get(item.md);
    if (left) withheld.set(item.md, left - 1);
    else keep.push(item);
  }
  const dropCount = incoming.length - keep.length;
  let blocks: Y.XmlElement[];
  try {
    blocks = prose.parseMarkdownBlocks(`## ${canonical}\n\n${markdownOfItems(keep)}`);
  } catch {
    return null;
  }
  if (blocks.length === 0) return null;
  const deleted = itemsInSection(fragment, span).length;
  ydoc.transact(() => {
    fragment.delete(span.start, span.endExclusive - span.start);
    fragment.insert(span.start, blocks);
  }, 'agent');
  // Read the items back off the doc rather than trusting the blocks handed
  // to `insert`: the ledger has to key on what `itemsInSection` will return
  // next tick, which is a list's listItems and not the list.
  const written = findNotesSection(fragment, headings);
  const items = written ? itemsInSection(fragment, written) : [];
  ownership.record(items.map((i) => ({ el: i.el, md: i.md })));
  return { deleted, inserted: items.length, dropped: dropCount };
}

/**
 * Merge `notesMarkdown` into the doc's notes section, keeping every item the
 * agent did not write, and updating `ownership` to what it owns afterwards.
 *
 * `basedOn` is the item list the compose that produced these notes was
 * reading. An ownership record that claims nothing — a server that restarted
 * — means everything already in the section reads as a person's. That is the
 * safe direction: a doc whose notes section holds an agenda somebody typed
 * before pressing record keeps it, at the price of the note-taker adding
 * beneath rather than revising.
 */
export function mergeNotesSection(
  ydoc: Y.Doc,
  notesMarkdown: string,
  heading: string | readonly string[],
  opts: {
    ownership: NotesOwnership;
    basedOn?: readonly string[];
    author?: suggestOps.SuggestionAuthor;
  },
): MergeNotesResult {
  // One heading is written, any of them is found: a section written under an
  // older spelling is still this meeting's section, not a doc to append below.
  const headings = typeof heading === 'string' ? [heading] : heading;
  const canonical = headings[0] ?? MEETING_NOTES_HEADING;
  const empty = (error: 'empty' | 'parse-failed'): MergeNotesResult => ({
    ok: false,
    error,
    deleted: 0,
    inserted: 0,
    suggested: 0,
    dropped: 0,
  });
  if (!notesMarkdown.trim()) return empty('empty');
  const body = stripSectionHeading(notesMarkdown, headings);
  const parsed = itemsOfMarkdown(body);
  if (parsed === null) return empty('parse-failed');
  if (parsed.length === 0) return empty('empty');

  const fragment = prose.getProseFragment(ydoc);
  const found = findNotesSection(fragment, headings);
  // A SECTION THIS MEETING HAS WRITTEN INTO IS ITS SECTION, WHEREVER IT NOW
  // SITS. The position test used to be the only test, and it split the notes
  // in two every time the product appended anything to the doc: press Research
  // on a note, or say "can you research that", and `## Research: …` lands
  // below the notes, the notes stop being last, and the next tick appends a
  // SECOND "Meeting notes". Two presses left three sections with the meeting's
  // points scattered across them.
  //
  // The ledger separates the two cases the position test was conflating. An
  // item this session wrote is proof the section is this meeting's, so it is
  // extended and never twinned — which is the whole of the fix.
  //
  // TWO READINGS OF "THIS SESSION WROTE IT", because a restart destroys one of
  // them. `claims` is element AND text, and a doc reloaded from disk comes
  // back as new Yjs objects holding the same words, so after a deploy
  // mid-meeting it claimed nothing and the position test below took over —
  // putting the twinning back for as long as the process was young. So a
  // line the note-taker WROTE, matched on text alone, identifies the section
  // too; the ledger reads that half back from disk (`notes-ledger-store.ts`).
  // It says only WHERE the notes go. What may be replaced inside them is
  // still `claims` alone, so a restarted server adds and suggests here and
  // rewrites nothing.
  const inSection = found !== null ? itemsInSection(fragment, found) : [];
  const mine =
    found !== null &&
    (inSection.some((item) => opts.ownership.claims(item.el, item.md)) ||
      opts.ownership.wroteAnyOf(inSection.map((item) => item.md)));
  // A section it has written NOTHING into belongs to a previous recording, or
  // to a server that restarted. Then the position test still holds, and still
  // for the owner's reason (2026-09-01, "notes got inserted in the top in the
  // original Meeting notes section, not at the end of the doc"): a new meeting
  // does not grow an old meeting's notes above everything a person has written
  // since. It starts its own, at the end.
  //
  // "At the end" now means above the raw transcript rather than at the last
  // index, because the transcript owns the tail (`sectionInsertIndex`). Read
  // any other way, a second meeting would refuse to join the section sitting
  // immediately above the record it had just written.
  const span =
    found && (mine || found.endExclusive === sectionInsertIndex(fragment)) ? found : null;
  // Whatever an earlier section already holds is written. The composer's
  // `previous` is only the LAST section, so once a fresh one starts it
  // re-lists the points it no longer sees; appending those would say them
  // twice, so an entry that reads the same as a line of an earlier section
  // is dropped here.
  const incoming = dropEchoesOfEarlierSections(parsed, fragment, headings, span);
  if (incoming.length === 0) {
    return {
      ok: true,
      mode: span ? 'merged' : 'appended',
      deleted: 0,
      inserted: 0,
      suggested: 0,
      dropped: parsed.length,
    };
  }
  if (!span) {
    // First write of this meeting's section: nothing of anybody's to
    // protect in it. Append it whole, below everything a person has written
    // and above the raw transcript when the doc already has one.
    // The composer's own markdown when every entry is new — its shape is
    // the shape wanted — and the entries re-listed otherwise.
    const fresh = incoming.length === parsed.length ? body : markdownOfItems(incoming);
    let blocks: Y.XmlElement[];
    try {
      blocks = prose.parseMarkdownBlocks(`## ${canonical}\n\n${fresh}`);
    } catch {
      return empty('parse-failed');
    }
    if (blocks.length === 0) return empty('empty');
    ydoc.transact(() => {
      fragment.insert(sectionInsertIndex(fragment), blocks);
    }, 'agent');
    // Everything in a section that did not exist a moment ago is the
    // agent's — read it back so the ledger keys on the elements the doc
    // actually holds, not on the ones handed to `insert`.
    const written = findNotesSection(fragment, headings);
    const items = written ? itemsInSection(fragment, written) : [];
    opts.ownership.record(items.map((i) => ({ el: i.el, md: i.md })));
    return {
      ok: true,
      mode: 'appended',
      deleted: 0,
      inserted: items.length,
      suggested: 0,
      dropped: 0,
    };
  }

  const current = itemsInSection(fragment, span);
  const plan = planNotesMerge(current, incoming, opts);

  // THE ONE CASE THE ITEM-LEVEL MERGE CANNOT EXPRESS: the notes are being
  // grouped under topic headings for the first time, so a heading has to land
  // between two bullets of a list that already exists. Re-laying the body is
  // the only way to say that in a Yjs fragment, and it is permitted here for
  // exactly the reason every other write is — everything in this section is
  // the agent's own writing, so there is nothing of anybody else's to lose.
  // One person's item anywhere in the section (or one pending proposal on
  // one) turns this off and the ordinary merge runs, which places the heading
  // below the list rather than inside it: worse looking, and safe.
  const allAgent = current.length > 0 && classifyOwnership(current, opts.ownership).every(Boolean);
  if (
    allAgent &&
    plan.suggestions.length === 0 &&
    !spanHasPendingSuggestion(fragment, span) &&
    planNeedsRelayout(current, plan)
  ) {
    const relaid = relayoutSection(
      ydoc,
      fragment,
      span,
      incoming,
      canonical,
      headings,
      opts.ownership,
      plan.dropped,
    );
    if (relaid) return { ok: true, mode: 'merged', ...relaid, suggested: 0 };
  }

  const applied = applyPlan(ydoc, plan, span.heading, opts.author ?? NOTES_SUGGESTION_AUTHOR);
  opts.ownership.record([...plan.keptAgent.map((i) => ({ el: i.el, md: i.md })), ...applied.owned]);
  return {
    ok: true,
    mode: 'merged',
    deleted: applied.deleted,
    inserted: applied.inserted,
    suggested: applied.suggested,
    dropped: plan.dropped.length,
  };
}
