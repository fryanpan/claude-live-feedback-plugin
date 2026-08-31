/**
 * Correcting a note OUT LOUD: "no, I said Thursday" fixes the note that says
 * Tuesday, instead of the doc growing a second note that disagrees with the
 * first one.
 *
 * WHY THIS IS NOT A COMPOSE. The composer already revises — it is handed the
 * whole notes and returns the whole notes, and it is told to "correct earlier
 * notes the new speech overturns". What it cannot do is be RELIED ON to: the
 * result is a whole section rewritten from a model's reading, so the same ask
 * lands as a fix on one tick and as an extra bullet on the next, and either
 * way the merge has to reconcile a section that changed everywhere. A person
 * saying two words wants two words changed. So a correction is a TARGETED,
 * in-place replacement, exactly as a speaker rename is (`relabelNotesSection`)
 * and for the same reason: a two-word fix must cost no more than two words.
 *
 * WHAT VOUCHES FOR IT. The two halves are vouched by different things, and
 * that asymmetry is the design:
 *
 *  - the CORRECTED words are vouched by the transcript. They were just
 *    spoken, so `correctionSpokenOnTick` can ask the tick's own window.
 *  - the MISTAKEN words are vouched by the NOTES. They usually are in the
 *    transcript too — the note was composed from it, mishearing included —
 *    but by the time the correction is spoken the tick that carried them can
 *    be well outside the overlap window. So the guard is stronger than a
 *    transcript match rather than weaker: the phrase must actually be in a
 *    note, in exactly ONE note, and that resolution is what makes the
 *    correction land on something real. A phrase the model invented matches
 *    nothing and the correction is dropped.
 *
 * AND WHY MORE THAN ONE MATCH IS A DROP. Three notes saying "Tuesday" and a
 * person saying "no, Thursday" is not a correction anybody can execute: fix
 * the newest and two stale ones remain and the choice looks arbitrary; fix
 * all three and the edit is wider than the words asked for. Ambiguity is
 * dropped, the way every other reading in this pipeline drops what it cannot
 * prove — the transcript is still the record, and the next compose still sees
 * the correction in the speech.
 *
 * A PERSON'S NOTE IS NEVER OVERWRITTEN. Ownership is the ledger's
 * (`meeting-notes-merge.ts`): the agent may revise only an item it wrote that
 * still reads as it left it. When the only note carrying the mistaken phrase
 * is one a person wrote — or one the agent wrote and the person has since
 * edited — the correction lands as a REDLINE SUGGESTION on that phrase, the
 * same `suggestOps` mechanism the composer already uses when it wants
 * different words in somebody's line. Accepting it is their move. The two
 * cases are deliberately different verbs, not one verb with a flag: revising
 * your own note is bookkeeping, and proposing a change to somebody else's is
 * a request.
 *
 * A SPEAKER TAG IS OUT OF BOUNDS. A site sitting inside `[@Devi](speaker:B)`
 * is an ATTRIBUTION, and rewriting its text while the href still names voice
 * B would leave the tag claiming that B is called something B is not.
 * Attribution moves by the reassign gesture; it never moves by a spoken
 * correction of the words around it. Same law `attributesToNewVoice` holds
 * the composer to from the other side.
 */

import {
  SPEAKER_TAG_SCHEME,
  SUGGEST_DELETE_MARK,
  SUGGEST_INSERT_MARK,
  prose,
  suggestOps,
} from '@feedback/core';
import * as Y from 'yjs';
import {
  NOTES_SUGGESTION_AUTHOR,
  type NoteItem,
  type NotesOwnership,
  classifyOwnership,
  findNotesSection,
  itemsInSection,
} from './meeting-notes-merge.ts';
import type { SpokenCorrection } from './meeting-notes.ts';

/**
 * The shortest a mistaken phrase may be and still identify a note. A
 * correction is only as good as what it points at, and a one- or two-letter
 * token points at half the section.
 */
const MIN_PHRASE_CHARS = 3;

/** Longer than this is a sentence, not a correction — and a sentence-length
 *  "wrong" is a model paraphrasing a note rather than quoting one, which
 *  matches nothing and would only have been dropped later anyway. */
export const CORRECTION_PHRASE_MAX = 60;

/**
 * Is this phrase specific enough to be corrected, or to be a correction?
 * Length only — what it means is the notes' business, not this module's.
 */
export function correctionPhraseUsable(phrase: string): boolean {
  const t = phrase.trim();
  return t.length >= MIN_PHRASE_CHARS && t.length <= CORRECTION_PHRASE_MAX;
}

/**
 * Every whole-token occurrence of `phrase` in `text`, as start offsets, case
 * insensitively.
 *
 * A plain scan, not a RegExp: the phrase is arbitrary words a person spoke,
 * and escaping them for a pattern is a bug waiting for the first correction
 * with a dot or a bracket in it. Case-insensitive because the model quotes
 * the phrase from speech while the notes carry it as the composer capitalised
 * it — "thursday" and "Thursday" are the same correction, and refusing the
 * pair would drop the ordinary case.
 *
 * WHOLE TOKEN, or correcting "ten" would reach inside "attention".
 *
 * The boundary is UNICODE-AWARE, and deliberately not the rename's
 * `extendsWord`. That one asks `[A-Za-z0-9]`, which is right where it lives:
 * an engine label is a single ASCII letter, so "Speaker A" only ever needs to
 * be told apart from "Speaker AB". A correction is arbitrary words somebody
 * SPOKE, in whatever language the room speaks, and an ASCII rule reads every
 * accented letter as a word boundary — correcting "ana" would rewrite the
 * tail of "mañana", because the "ñ" before it does not look like a letter.
 * Combining marks count too, so a decomposed "ñ" (n + U+0303) is not a
 * boundary either. Found by `codex review`.
 *
 * And the folding is LENGTH-PRESERVING, because an offset found in a folded
 * copy is used to edit the ORIGINAL. `String.prototype.toLowerCase` is not a
 * per-character map: "İ" (U+0130) lowercases to TWO code units, so one such
 * letter earlier in a note shifts every offset after it by one, and the
 * correction lands a character to the right of the word it meant. The
 * whole-token guard turns most of that drift into a silent miss rather than a
 * misplaced edit, which is the better failure and still the wrong one — a
 * person's correction disappearing with no note of why. Folding one character
 * at a time and keeping the original wherever its lowercase is not exactly one
 * unit costs those few letters their case-insensitivity and keeps every offset
 * true. Also found by `codex review`.
 */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** True when `ch` would make text adjacent to a match part of a longer word,
 *  in any script. */
function extendsWordUnicode(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/** Lowercase, one code unit at a time, keeping any character whose lowercase
 *  is not the same length — so the result indexes exactly like its input. */
function foldPreservingLength(s: string): string {
  let out = '';
  for (const ch of s) {
    const lowered = ch.toLowerCase();
    out += lowered.length === ch.length ? lowered : ch;
  }
  return out;
}

export function phraseSites(text: string, phrase: string): number[] {
  if (phrase.length === 0) return [];
  const haystack = foldPreservingLength(text);
  const needle = foldPreservingLength(phrase);
  const out: number[] = [];
  let i = 0;
  while (true) {
    const at = haystack.indexOf(needle, i);
    if (at < 0) break;
    if (!extendsWordUnicode(text[at - 1]) && !extendsWordUnicode(text[at + phrase.length])) {
      out.push(at);
    }
    i = at + 1;
  }
  return out;
}

/** Was this phrase actually said on the tick's window? The corrected half's
 *  guard, and the only half the transcript can vouch for — see the module
 *  note. Boundary-checked so "sixty" is not found inside "sixty-six"'s
 *  neighbour word, and case-insensitive for the reason `phraseSites` is. */
export function correctionSpokenOnTick(
  turns: ReadonlyArray<{ text: string }>,
  phrase: string,
): boolean {
  const spoken = turns.map((t) => t.text).join(' ');
  return phraseSites(spoken, phrase.trim()).length > 0;
}

/** What a correction did, or why it did nothing. Every outcome is ordinary:
 *  most speech carries no correction, and most corrections that reach here
 *  resolve to one note. */
export type CorrectionOutcome =
  /** An agent note was rewritten in place. */
  | { applied: 'revised'; sites: number }
  /** A person's note carries the phrase; the change is proposed on it. */
  | { applied: 'suggested' }
  | {
      applied: 'none';
      reason: /** The doc holds no notes section — nothing has been written yet. */
        | 'no-section'
        /** The phrase is in no note. The commonest answer, and the safe one:
         *  a model that guessed at the wrong words points at nothing. */
        | 'no-match'
        /** More than one note carries it, so which one is a guess. */
        | 'ambiguous'
        /** The only sites sit inside a speaker tag, which is an attribution
         *  and does not move this way. */
        | 'attribution'
        /** A person's note, but the proposal could not be anchored — a
         *  suggestion is already pending on it, or the range would not
         *  resolve. */
        | 'unsuggestable';
    };

/** One place the phrase sits: the text node holding it and where in it. */
interface Site {
  node: Y.XmlText;
  offset: number;
}

/** Every `Y.XmlText` under `el`, itself included, in reading order. */
function collectTextNodes(el: Y.XmlElement, into: Y.XmlText[]): void {
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) into.push(child);
    else if (child instanceof Y.XmlElement) collectTextNodes(child, into);
  }
}

/**
 * Is this run one a correction may not write into?
 *
 * Two marks say no. A SPEAKER TAG is an attribution — see the module note. A
 * run carrying either SUGGESTION mark is text nobody has accepted yet, or
 * text somebody has proposed removing: rewriting inside a pending proposal
 * would anchor this correction onto an answer that has not been given, and
 * rejecting the first would take the second's words with it. Same rule
 * `locateMatches`' `excludePendingSuggestions` exists for.
 */
function runBlock(attributes: Record<string, unknown> | undefined): 'tag' | 'pending' | null {
  const link = attributes?.link as { href?: unknown } | undefined;
  if (typeof link?.href === 'string' && link.href.startsWith(SPEAKER_TAG_SCHEME)) return 'tag';
  if (attributes?.[SUGGEST_INSERT_MARK] != null) return 'pending';
  if (attributes?.[SUGGEST_DELETE_MARK] != null) return 'pending';
  return null;
}

/**
 * Where `phrase` sits inside one note, and which of its occurrences had to be
 * passed over.
 *
 * Scanned PER TEXT NODE and per MARK RUN, which is what makes `blocked`
 * meaningful: a phrase half of which is bold lives in two runs, and rewriting
 * across a mark boundary would silently pick one of the two sets of marks for
 * the whole replacement. Blocked sites are reported, not fixed — but they
 * still count as the note CARRYING the phrase, so a note this module cannot
 * cleanly rewrite is never mistaken for one that does not mention the words
 * at all, and a correction aimed at it never slides onto the note next door.
 */
function sitesInItem(
  item: NoteItem,
  phrase: string,
): { sites: Site[]; blocked: number; blockedByTag: number } {
  const nodes: Y.XmlText[] = [];
  collectTextNodes(item.el, nodes);
  const sites: Site[] = [];
  let blocked = 0;
  let blockedByTag = 0;
  for (const node of nodes) {
    // Read the node as its delta so each site can be asked what marks cover
    // it before anything is written.
    let offset = 0;
    const runs: Array<{ start: number; end: number; block: 'tag' | 'pending' | null }> = [];
    let text = '';
    for (const op of node.toDelta() as Array<{
      insert: unknown;
      attributes?: Record<string, unknown>;
    }>) {
      if (typeof op.insert !== 'string') {
        // An embed is one position wide and never words. Counted so later
        // offsets stay true, and rendered as a character no phrase contains.
        runs.push({ start: offset, end: offset + 1, block: null });
        text += ' ';
        offset += 1;
        continue;
      }
      runs.push({ start: offset, end: offset + op.insert.length, block: runBlock(op.attributes) });
      text += op.insert;
      offset += op.insert.length;
    }
    for (const at of phraseSites(text, phrase)) {
      const end = at + phrase.length;
      const covering = runs.filter((r) => at < r.end && r.start < end);
      const tagged = covering.some((r) => r.block === 'tag');
      // Inside a speaker tag, inside a pending proposal, or straddling two
      // runs with different marks: every one of them a site this module
      // declines to write into, and every one of them still the phrase
      // being here.
      if (tagged || covering.some((r) => r.block !== null) || covering.length > 1) {
        blocked++;
        if (tagged) blockedByTag++;
        continue;
      }
      sites.push({ node, offset: at });
    }
  }
  return { sites, blocked, blockedByTag };
}

/**
 * Apply one spoken correction to a doc's notes section.
 *
 * Resolution, in order, and every step of it is a refusal to guess:
 *  1. the phrase must be usable at all, and must not already read correctly;
 *  2. it must sit in exactly one note the AGENT still owns → rewrite it;
 *  3. failing that, in exactly one note a PERSON owns → propose it;
 *  4. anything else → nothing happens, with the reason said out loud.
 *
 * The agent's own notes win over a person's when both carry the phrase, and
 * that is not a tiebreak so much as the definition: the note this correction
 * is about is the note the assistant wrote from the mishearing. A person's
 * line that happens to say "Tuesday" as well is their line, and untouched.
 *
 * The caller owes this the ledger's reclaim wrapper — the rewrite edits the
 * agent's own text in place, so the ledger must learn its lines' new wording
 * or the note-taker hands them to the person and freezes. See
 * `applyNotesCorrection`.
 */
export function correctNotesSection(
  ydoc: Y.Doc,
  heading: string,
  ownership: NotesOwnership,
  correction: SpokenCorrection,
): CorrectionOutcome {
  const wrong = correction.wrong.trim();
  const right = correction.right.trim();
  if (!correctionPhraseUsable(wrong) || right.length === 0) {
    return { applied: 'none', reason: 'no-match' };
  }
  if (wrong.toLowerCase() === right.toLowerCase()) return { applied: 'none', reason: 'no-match' };

  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSection(fragment, heading);
  if (!span) return { applied: 'none', reason: 'no-section' };
  const items = itemsInSection(fragment, span);
  const isAgent = classifyOwnership(items, ownership);

  type Hit = { item: NoteItem; sites: Site[]; blockedByTag: number };
  const agentHits: Hit[] = [];
  const humanHits: Hit[] = [];
  for (let i = 0; i < items.length; i++) {
    const { sites, blocked, blockedByTag } = sitesInItem(items[i]!, wrong);
    if (sites.length === 0 && blocked === 0) continue;
    (isAgent[i] ? agentHits : humanHits).push({ item: items[i]!, sites, blockedByTag });
  }

  const hits = agentHits.length > 0 ? agentHits : humanHits;
  if (hits.length === 0) return { applied: 'none', reason: 'no-match' };
  // Two notes carrying the same mistaken words cannot both be the one the
  // speaker meant, and picking is a guess. See the module note.
  if (hits.length > 1) return { applied: 'none', reason: 'ambiguous' };
  const hit = hits[0]!;
  if (hit.sites.length === 0) {
    // The note carries the phrase, but only where this module will not write.
    // A speaker tag is its own answer — the correction was aimed at an
    // attribution, which moves by a different gesture entirely. Anything else
    // (a pending proposal, a mark boundary) is a site that could not be
    // anchored.
    return { applied: 'none', reason: hit.blockedByTag > 0 ? 'attribution' : 'unsuggestable' };
  }

  if (agentHits.length > 0) return reviseInPlace(ydoc, hit.sites, wrong.length, right);
  return proposeOnHumanNote(ydoc, hit.item, hit.sites[0]!, wrong.length, right);
}

/**
 * Rewrite the agent's own note, site by site, carrying each site's own marks
 * — the `relabelNotesSection` mechanic. Descending within each node so every
 * offset not yet used stays valid: an edit only ever changes text at or after
 * the site it lands on.
 */
function reviseInPlace(
  ydoc: Y.Doc,
  sites: Site[],
  wrongLength: number,
  right: string,
): CorrectionOutcome {
  const byNode = new Map<Y.XmlText, number[]>();
  for (const site of sites) {
    const offsets = byNode.get(site.node) ?? [];
    offsets.push(site.offset);
    byNode.set(site.node, offsets);
  }
  ydoc.transact(() => {
    for (const [node, offsets] of byNode) {
      offsets.sort((a, b) => b - a);
      for (const offset of offsets) {
        const marks = prose.coveringInlineMarks([{ node, offset, length: wrongLength }]);
        node.delete(offset, wrongLength);
        // Plain text, not markdown: `right` is words somebody said, and
        // parsing it for marks would let an asterisk in a transcript italicise
        // half a note.
        prose.insertTextWithMarks(node, offset, right, { attributes: marks.attributes });
      }
    }
  }, 'agent');
  return { applied: 'revised', sites: sites.length };
}

/**
 * Propose the corrected words on a person's note, as a redline on the phrase
 * itself rather than on the whole line: they wrote the sentence, and the only
 * part under discussion is the two words the room just corrected.
 *
 * Skipped when a proposal is already pending on that block — a person who has
 * not answered one must not collect a fresh copy every tick, and the marks
 * ARE the registry, so the doc is the only place to ask.
 */
function proposeOnHumanNote(
  ydoc: Y.Doc,
  item: NoteItem,
  site: Site,
  wrongLength: number,
  right: string,
): CorrectionOutcome {
  const pending = suggestOps.scanSuggestions(prose.getProseFragment(ydoc));
  const holder = site.node.parent;
  for (const entry of pending.values()) {
    for (const range of entry.ranges) {
      if (range.block === holder || range.block === item.el) {
        return { applied: 'none', reason: 'unsuggestable' };
      }
    }
  }
  const res = suggestOps.suggestRewriteRange(ydoc, {
    startRel: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(site.node, site.offset),
    ),
    endRel: Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(site.node, site.offset + wrongLength),
    ),
    replacement: right,
    author: NOTES_SUGGESTION_AUTHOR,
  });
  return res.ok ? { applied: 'suggested' } : { applied: 'none', reason: 'unsuggestable' };
}
