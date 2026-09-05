/**
 * "Link that to the existing task" — heard, and answered from a loose
 * description.
 *
 * WHY THIS EXISTS BESIDE `notes-references.ts`. That module links the row
 * somebody NAMED, and it is deliberately strict about it: a citation nobody
 * asked for is a claim about what the discussion was about, so it demands a
 * contiguous run of the title's own words. That strictness is right for an
 * unprompted citation and wrong for an instruction. When a person says "link
 * that to the existing task" they have already decided the link should exist;
 * what they have not done is quote the title. They said "the volume rocker
 * being too stiff" and the row reads "Volume buttons". A matcher that needs
 * the words back gives them nothing, and the owner's verdict on the first
 * version was exactly that: finding existing tasks did not work well.
 *
 * So an ASK is scored differently from a MENTION, by the board's own
 * related-work index (`@feedback/core/related-work`) rather than by title
 * runs. That scorer already answers "is somebody already working on this?"
 * from a sentence, which is the same question in a different room, and
 * reusing it means the notes and the planning flow agree about what "related"
 * means. The scorer is imported, never the MCP verb: this runs inside a tick,
 * and a tick may not make a network call.
 *
 * THREE OUTCOMES, AND THE THIRD IS THE POINT.
 *
 *   • Asked, and one row is clearly ahead → LINK it. The person asked.
 *   • Asked, and two rows are neck and neck → SUGGEST both. A coin flip
 *     between two plausible rows is how a wrong link gets written, and a
 *     wrong link is worse than a question: nobody rereading the notes can
 *     tell it was a guess.
 *   • Not asked, but a row scores well above the mention threshold →
 *     SUGGEST it. This is the owner's second half — "suggest tickets to add
 *     if it's not sure but probably has some related tickets" — and it is
 *     why the unasked path may not simply stay silent.
 *
 * A SUGGESTION IS A LINK THE READER TAPS, not a caption saying a link might
 * belong. It is written into the note as ordinary markdown whose href carries
 * `suggest=1`; the client turns a tap on it into the real link and rewrites
 * the text (`notes-link-affordance.ts`). Written that way it degrades to
 * something useful with no JavaScript at all — a reader who opens the bound
 * `.md` sees a question with the row behind it — and it costs the doc no node
 * type, no chip and no explanatory sentence.
 */

import { type RelatedWorkCandidate, scoreRelatedWork } from '@feedback/core';
import type { NoteReference } from './notes-references.ts';

/**
 * Enough score to LINK a row when somebody asked for one, deliberately below
 * the scorer's own default.
 *
 * The default (0.25) answers "should I interrupt a person about this?", where
 * a false positive costs somebody's attention. Here the person has already
 * asked, so the cost of the two errors has flipped: refusing a row that
 * shares one real word of the request leaves the ask visibly unanswered,
 * which is the failure being fixed. One shared word of a short title scores
 * about 0.16 through the scorer's title floor, so this sits just under that.
 */
export const ASK_LINK_MIN_SCORE = 0.15;

/**
 * Enough score to SUGGEST a row nobody asked about.
 *
 * Above the scorer's default rather than below it, because this is the
 * unprompted direction: roughly two of a title's own words have to turn up in
 * the speech. A suggestion on every bullet is noise a reader learns to skip,
 * and a suggestion nobody reads is the same as no suggestion.
 */
export const SUGGEST_MIN_SCORE = 0.3;

/**
 * How far ahead the best row must be before an ASK is answered with a link
 * rather than with the shortlist.
 *
 * Two rows within this of each other are, as far as the words go, the same
 * answer — "the volume and channel buttons" names both — and picking one is
 * guessing. The margin is what turns that case into a question instead of
 * into a wrong citation, which is the whole of "none link wrong".
 */
export const ASK_AMBIGUITY_MARGIN = 0.08;

/**
 * How many suggestions one tick's note may carry.
 *
 * Two. A bullet trailing four questions is a bullet nobody finishes reading,
 * and the shortlist a near-tie produces is a choice between the top two by
 * construction.
 */
export const MAX_SUGGESTIONS = 2;

/**
 * The query parameter that marks a written link as a QUESTION rather than a
 * citation.
 *
 * A parameter on the row's own URL, not a separate link shape, so everything
 * that already understands a workspace link still understands this one: the
 * href resolves to the task whether or not anything strips the marker, and a
 * reader with no client-side script gets a working link to the row being
 * asked about.
 */
export const SUGGEST_PARAM = 'suggest';

/** Verbs that ask for a link. Every inflection spelled out: speech conjugates
 *  and a stemmer here would have to be shared with nothing else. */
const LINK_VERB =
  /\b(link|links|linked|linking|connect|connects|connected|connecting|attach|attaches|attached|attaching|associate|associates|associated|associating|tie|ties|tied|hook|hooks|hooked)\b/i;

/** What a person calls a board row out loud. */
const ROW_NOUN =
  /\b(task|tasks|ticket|tickets|issue|issues|card|cards|story|stories|row|rows|item|items|bug|bugs)\b/gi;

/**
 * A row noun the speech marked as NOT YET EXISTING.
 *
 * "Link this to a new ticket" is a create, and the extractor's `request`
 * intent owns it; answering it with an existing row would attach the
 * discussion to the wrong work AND swallow the row somebody asked for. Only
 * the words immediately before the noun count, so "a new take on the volume
 * ticket" is still an existing ticket.
 */
const NEW_BEFORE_NOUN = /\b(new|another|separate|fresh)\s+$/i;

/**
 * Words the ASK ITSELF contributes, which must not be scored.
 *
 * "Link that to the existing task" would otherwise hand the scorer `link`,
 * `existing` and `task` — and a board row called "Task capture" or "Linking
 * docs" would then match every ask ever made, ahead of the row the sentence
 * was actually about. Dropped from the query only; the catalogue keeps its
 * own words.
 */
const ASK_WORDS = new Set([
  'link',
  'links',
  'linked',
  'linking',
  'connect',
  'connects',
  'connected',
  'connecting',
  'attach',
  'attaches',
  'attached',
  'attaching',
  'associate',
  'associates',
  'associated',
  'associating',
  'tie',
  'ties',
  'tied',
  'hook',
  'hooks',
  'hooked',
  'existing',
  'exist',
  'already',
  'task',
  'tasks',
  'ticket',
  'tickets',
  'issue',
  'issues',
  'card',
  'cards',
  'story',
  'stories',
  'row',
  'rows',
  'item',
  'items',
  'bug',
  'bugs',
  'board',
  'please',
  'can',
  'could',
  'would',
]);

/** Speech split into sentences, so a verb in one and a noun in the next are
 *  not read as one instruction. */
function sentences(text: string): string[] {
  return text
    .split(/[.?!\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Did this speech ask, in so many words, for a link to work the board
 * already has?
 *
 * The test is a link verb and, AFTER it in the same sentence, a word for a
 * board row that the speech did not mark as new. Order matters: "the new task
 * should link to the design doc" has both words and asks for nothing, and
 * requiring the noun to follow the verb is what separates the instruction
 * from the description.
 */
export function detectLinkAsk(text: string): boolean {
  for (const sentence of sentences(text)) {
    const verb = LINK_VERB.exec(sentence);
    if (!verb) continue;
    const after = verb.index + verb[0].length;
    ROW_NOUN.lastIndex = 0;
    for (let m = ROW_NOUN.exec(sentence); m !== null; m = ROW_NOUN.exec(sentence)) {
      if (m.index < after) continue;
      if (NEW_BEFORE_NOUN.test(sentence.slice(Math.max(0, m.index - 24), m.index))) continue;
      return true;
    }
  }
  return false;
}

/**
 * The speech as the scorer should read it: the ask's own vocabulary removed,
 * everything a person said about the SUBJECT kept.
 *
 * Words are blanked rather than the sentence rewritten, because what is left
 * is fed to a bag-of-words scorer and nothing downstream reads it as prose.
 */
export function linkAskQuery(text: string): string {
  return text
    .split(/([^a-zA-Z0-9]+)/)
    .map((part) => (ASK_WORDS.has(part.toLowerCase()) ? ' ' : part))
    .join('');
}

/** What one tick's speech should do about the board. Both lists empty is the
 *  ordinary answer, and most ticks give it. */
export interface NoteLinkOutcome {
  /**
   * Rows to LINK, because somebody asked for a link and these are the answer.
   *
   * Includes rows the STRICT matcher had already found, whenever the speech
   * carried an ask. Those rows are cited either way; what the ask adds is the
   * ref on the row itself, and leaving them out was a real hole — a person
   * who said the title out loud and then said "link that to the existing
   * ticket" got the citation and no backlink, which is the half that makes
   * the work findable from the board.
   */
  linked: NoteReference[];
  /** Rows to ASK ABOUT: a near-tie under an explicit ask, or a probable
   *  match nobody raised. */
  suggested: NoteReference[];
}

export interface ResolveNoteLinksInput {
  /** Everything said this tick, joined. */
  spokenText: string;
  /** The meeting's board, as `resolveReferences` assembled it. */
  catalogue: readonly NoteReference[];
  /**
   * What the strict title matcher already found for this tick. Those rows are
   * being cited anyway, so re-offering one as a question would ask the reader
   * to confirm a link already in the note.
   */
  named?: readonly NoteReference[];
}

/** The catalogue in the shape the board's related-work index scores. */
function asCandidates(catalogue: readonly NoteReference[]): RelatedWorkCandidate[] {
  return catalogue.map((ref, at) => ({
    kind: ref.kind,
    // The scorer needs a stable identity for its tie-break and its answer;
    // a catalogue entry's id is optional, so its POSITION stands in. Never
    // shown to anybody — the answer is mapped straight back to the entry.
    id: ref.id ?? `at-${at}`,
    title: ref.title,
    ...(ref.body !== undefined ? { body: ref.body } : {}),
  }));
}

/**
 * What this tick's speech asks the notes to link, and what it should ask the
 * reader about.
 *
 * Pure, and deliberately: the decision to cite a person's work in the record
 * of their meeting is one a test must be able to pin exactly, and the version
 * of this feature that put the decision in the extractor's prompt is the one
 * the owner said did not work.
 */
export function resolveNoteLinks(input: ResolveNoteLinksInput): NoteLinkOutcome {
  const none: NoteLinkOutcome = { linked: [], suggested: [] };
  const spoken = input.spokenText.trim();
  if (spoken.length === 0 || input.catalogue.length === 0) return none;

  const named = input.named ?? [];
  const alreadyNamed = new Set(named.map((r) => r.url));
  const open = input.catalogue.filter((r) => !alreadyNamed.has(r.url));
  const asked = detectLinkAsk(spoken);
  if (open.length === 0) return asked ? { linked: [...named], suggested: [] } : none;

  const candidates = asCandidates(open);
  const byId = new Map(candidates.map((c, at) => [c.id, open[at]!]));
  // The floor is the LOWER of the two thresholds either outcome could use, so
  // one scoring pass answers both questions; the outcome rules below are what
  // actually decide.
  const ranked = scoreRelatedWork(linkAskQuery(spoken), candidates, {
    threshold: Math.min(ASK_LINK_MIN_SCORE, SUGGEST_MIN_SCORE),
    limit: MAX_SUGGESTIONS + 1,
  });
  const refOf = (id: string): NoteReference | undefined => byId.get(id);
  const top = ranked[0];
  if (!top) return asked && named.length > 0 ? { linked: [...named], suggested: [] } : none;

  if (asked) {
    const runnerUp = ranked[1];
    const clear =
      top.score >= ASK_LINK_MIN_SCORE &&
      (runnerUp === undefined || top.score - runnerUp.score >= ASK_AMBIGUITY_MARGIN);
    const chosen = clear ? refOf(top.id) : undefined;
    const linked = [...named, ...(chosen ? [chosen] : [])];
    // An ask that landed on something is answered. Adding the shortlist on
    // top would ask the reader to confirm alternatives to a link the note now
    // carries, which is a question with nothing behind it.
    if (linked.length > 0) return { linked, suggested: [] };
    // Asked, and the words did not settle it. The shortlist is the honest
    // answer: it is what the person would have been shown had they searched.
    return {
      linked: [],
      suggested: ranked
        .slice(0, MAX_SUGGESTIONS)
        .map((m) => refOf(m.id))
        .filter((r): r is NoteReference => r !== undefined),
    };
  }

  return {
    linked: [],
    suggested: ranked
      .filter((m) => m.score >= SUGGEST_MIN_SCORE)
      .slice(0, MAX_SUGGESTIONS)
      .map((m) => refOf(m.id))
      .filter((r): r is NoteReference => r !== undefined),
  };
}

/**
 * The ref a spoken link writes onto the row.
 *
 * Exported, and named, because the SAME ref has to be produced in three
 * places or unlinking silently removes nothing: the meeting writes it, the
 * note's own unlink affordance deletes it, and the test that proves the round
 * trip has to name it too. It is the ordinary doc ref `link_refs` writes — a
 * spoken link is not a new kind of link, and giving it one would keep it out
 * of every backlink surface the board already draws.
 */
export function spokenLinkRef(docId: string): { kind: 'doc'; docId: string } {
  return { kind: 'doc', docId };
}

/** The row's own URL, marked as a question rather than a citation. */
export function suggestionHref(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${SUGGEST_PARAM}=1`;
}

/**
 * The words a suggestion is written as.
 *
 * A question, because it is one, and short because it rides the end of a
 * note somebody is reading for the note's own sake. No prefix naming the
 * assistant and no sentence explaining what a tap will do: the link is the
 * affordance, and a caption beside it would only say what tapping it says.
 */
export function suggestionLabel(title: string): string {
  return `related: ${title}?`;
}

/** One suggestion, written. */
export function suggestionMarkdown(ref: NoteReference): string {
  return `[${suggestionLabel(ref.title)}](${suggestionHref(ref.url)})`;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+\S/;

export interface AppendSuggestionsOptions {
  /**
   * Lines a PERSON wrote. Never appended to: a suggestion added to somebody's
   * own sentence reaches the doc as a proposed rewrite of it, which is the
   * merge asking them to approve a change they did not make.
   */
  protect?: readonly string[];
}

/**
 * Write this tick's suggestions into the composed notes.
 *
 * Deterministic, and downstream of the model on purpose. The composer is
 * asked to weave in links it is GIVEN; asking it to also decide whether to
 * ask a question, and to spell the marker that makes the question tappable,
 * is how a feature ends up working four ticks in five. So the model writes
 * the note and this writes the question.
 *
 * WHERE IT LANDS: the end of the last agent-written note in the section. The
 * suggestion is about what was just said, and the last note is where what was
 * just said ended up. When the section holds no note of ours to hang it on,
 * the suggestion becomes a note of its own rather than being dropped — a
 * silent skip is the failure this whole path exists to remove.
 *
 * A row already cited in these notes is skipped: the reader has the link.
 */
export function appendSuggestions(
  notesMarkdown: string,
  suggestions: readonly NoteReference[],
  opts: AppendSuggestionsOptions = {},
): string {
  if (suggestions.length === 0) return notesMarkdown;
  const protectedLines = new Set((opts.protect ?? []).map((l) => l.trim()));
  const lines = notesMarkdown.split('\n');
  const fresh = suggestions.filter((ref) => !notesMarkdown.includes(ref.url));
  if (fresh.length === 0) return notesMarkdown;

  let target = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!LIST_ITEM.test(line)) continue;
    if (protectedLines.has(line.trim())) continue;
    target = i;
    break;
  }
  const written = fresh.map((ref) => suggestionMarkdown(ref));
  if (target === -1) {
    const tail = lines[lines.length - 1] ?? '';
    const spacer = tail.trim().length === 0 ? [] : [''];
    return [...lines, ...spacer, ...written.map((w) => `- ${w}`)].join('\n');
  }
  lines[target] = `${(lines[target] ?? '').replace(/\s+$/, '')} ${written.join(' ')}`;
  return lines.join('\n');
}
