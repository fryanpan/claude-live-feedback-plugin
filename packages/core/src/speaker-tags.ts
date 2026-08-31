/**
 * Per-mention speaker attribution inside composed meeting notes.
 *
 * THE PROBLEM THIS FIXES. Until now the notes carried who-said-what only as
 * PROSE: the composer wrote the words "Speaker B" and a rename found them by
 * searching for that string. Two consequences, both in the architecture
 * summary as known limits — a rename could not tell two voices apart when
 * they had been given the same name ("Alex" in the notes does not say
 * which), and nothing else in the system could ever ask a note who said it,
 * because the answer existed only as English.
 *
 * THE TAG IS A MARKDOWN LINK, and that is the whole trick:
 *
 *     - [@Devi](speaker:B) wants the deploy gate moved before merge.
 *
 * The visible half is the name; the durable half is the LABEL, in the href.
 * Everything follows from that split:
 *
 * - **It survives the round trip.** A meeting doc is a live Yjs doc that
 *   serializes to a .md file on disk. A link is ordinary markdown and an
 *   ordinary Yjs `link` mark, so the attribution goes to disk, comes back
 *   from disk, and is carried through an edit the same way bold is. A mark
 *   invented for this would have been lost on the first flush.
 * - **A rename touches the NAME, never the identity.** Naming "B" as Devi
 *   rewrites the link text at every site whose href is `speaker:B` — no
 *   string search, so two voices called Alex are still two voices and each
 *   renames alone. The ambiguity that used to refuse the retroactive rewrite
 *   cannot arise for a tagged mention.
 * - **Reassignment is one attribute.** Moving a turn diarization gave to the
 *   wrong voice is a change of href, in place, and the words never move.
 *
 * THE HREF ALSO SAYS WHERE THE WORDS CAME FROM — `speaker:B?t=10,12`. A
 * rename is a fact about a VOICE and the label answers it; the engine's own
 * late correction is a fact about a TURN ("turn 12 was not B after all"), and
 * a bare label cannot say which of B's sentences a mention was written from.
 * So the tick stamps each mention it composes with that voice's turns in it,
 * and `reattributeSpeakerTags` moves exactly the mentions whose every turn
 * moved the same way — marking the ones it cannot place rather than guessing.
 * A mention a PERSON reassigned carries no provenance, which is what keeps a
 * later engine pass off an answer a human already gave.
 *
 * A TAG IS NOT EVIDENCE, IT IS A CLAIM THE MODEL MAKES. The composer is an
 * LLM, so `normalizeSpeakerTags` is the deterministic gate every composed
 * section passes through before it reaches a doc: a tag naming a voice the
 * meeting never carried is unwrapped to plain words, and a tag naming a real
 * one is re-rendered from the name map rather than trusted to spell it. Same
 * law the task capture's `requester` is held to — a model-claimed
 * attribution must name something the tick's own transcript contained.
 *
 * Pure string work, in core, because three processes need to agree about it:
 * the server composes and renames, the editor renders the chip, and the
 * markdown on disk is what a person reads when neither is running.
 */

import { speakerDisplayName } from './meeting.ts';

/** The href scheme that makes a link a speaker tag rather than a link. */
export const SPEAKER_TAG_SCHEME = 'speaker:';

/**
 * The href parameter carrying the TURNS a mention was composed from —
 * `speaker:B?t=10,12`.
 *
 * WHY A MENTION NEEDS MORE THAN A LABEL. The engine changes its mind about
 * who spoke: a `SpeakerRevision` arrives at the end of a session naming turns
 * the whole-session pass relabelled. A rename ("B is Devi") is a fact about a
 * VOICE and the label alone answers it, which is why the label was enough
 * until now. A revision is a fact about a TURN — "turn 12 was not B after
 * all" — and a mention tagged `speaker:B` cannot say whether it came from
 * turn 12 or from the other thing B said in the same breath. So the tick
 * stamps every mention it composes with the turns of that voice that were in
 * it, and the correction becomes provable instead of guessed.
 *
 * Stamped by the SERVER, never by the composer. Same law as the name itself:
 * the model's job is to say which voice, and the deterministic pass supplies
 * everything a later correction has to trust.
 */
export const SPEAKER_TAG_TURNS_PARAM = 't';

/**
 * The href parameter marking a mention the engine's revision TOUCHED and
 * could not place — `speaker:B?t=10,12&unsure=1`.
 *
 * It is set when the turns behind a mention stopped agreeing: turn 10 is
 * still B and turn 12 is now C, so the mention is one of them and nothing in
 * the notes says which. Rewriting it would be a coin flip and leaving it
 * silent would be a claim the meeting can no longer make, so the claim stays
 * and is marked — the reader is told the attribution is in doubt, and the
 * transcript still says exactly who said what.
 *
 * A person reassigning the mention writes a bare `speaker:<label>`, which
 * clears both parameters: their answer is not a guess and no later revision
 * gets to revisit it.
 */
export const SPEAKER_TAG_UNSURE_PARAM = 'unsure';

/**
 * The most turns a single mention is stamped with.
 *
 * A tick's turns for one voice are a handful; the cap exists for the tick
 * that carries a long `carry` after failed composes. Past it the mention is
 * stamped with NOTHING, which reads as "no handle" and leaves it untouched
 * by any later revision — the safe direction, and honest: a mention that
 * could have come from thirty turns is not one a revision can place.
 */
export const MAX_SPEAKER_TAG_TURNS = 12;

/** What a speaker tag's href says: which voice, and which turns behind it. */
export interface SpeakerTagRef {
  /** The engine label — the voice's identity, and the only required half. */
  label: string;
  /** Turn ids this mention could have been composed from, ascending. Empty
   *  when nothing stamped one, which is a mention no revision can place. */
  turns: readonly number[];
  /**
   * The href carried a `t` parameter at all — true even when it was
   * unreadable and `turns` came back empty.
   *
   * The two empties are not the same thing and only this tells them apart.
   * A tag with NO parameter is one the composer has just written, and this
   * tick's turns are the truthful thing to stamp on it. A tag whose
   * parameter would not parse is an OLD mention whose handle was corrupted;
   * stamping it with turns from a tick it has nothing to do with would hand
   * a later revision the wrong mention to move. It keeps its empty list and
   * stays out of every correction.
   */
  claimsTurns: boolean;
  /** A revision moved some of `turns` and not others, so which voice this
   *  mention belongs to is no longer known. */
  unsure: boolean;
}

/** Turn ids as the href carries them: ascending, deduped, whole and
 *  non-negative. A list with anything else in it is not trusted at all —
 *  a mention with unreadable provenance is one with none. */
function parseTurnList(raw: string): number[] {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) return [];
    out.add(Number(trimmed));
  }
  return [...out].sort((a, b) => a - b);
}

function normalizeTurns(turns: readonly number[] | undefined): number[] {
  if (!turns || turns.length === 0) return [];
  const out = new Set<number>();
  for (const turn of turns) {
    if (!Number.isInteger(turn) || turn < 0) return [];
    out.add(turn);
  }
  if (out.size > MAX_SPEAKER_TAG_TURNS) return [];
  return [...out].sort((a, b) => a - b);
}

/**
 * The character that opens a tag's visible text. Not decoration: it is what
 * tells a reader of the raw markdown — and a reader of the flushed .md file,
 * where nothing renders a chip — that "Devi" here is an attribution and not
 * the first word of the sentence.
 */
export const SPEAKER_TAG_SIGIL = '@';

/** What to stamp beside the label. Omitted entirely by every path where a
 *  PERSON decides the attribution — see {@link SPEAKER_TAG_UNSURE_PARAM}. */
export interface SpeakerTagRefInit {
  turns?: readonly number[];
  unsure?: boolean;
  /**
   * Write the handle as EMPTY rather than absent: `speaker:B?t=`.
   *
   * The one state the two spellings have to keep apart. A tag with no `t`
   * at all is one the composer has just written, and the next tick stamps
   * it. A tag whose `t` says nothing is one whose provenance was lost — and
   * it has to keep saying so, or the next tick stamps IT too, with turns it
   * was never composed from. Set when re-rendering a tag that claimed
   * provenance and had none readable; nothing else needs it.
   */
  claimsTurns?: boolean;
}

/** `"B"` → `"speaker:B"`, and `"B"` plus turns → `"speaker:B?t=10,12"`. */
export function speakerTagHref(label: string, ref?: SpeakerTagRefInit): string {
  const turns = normalizeTurns(ref?.turns);
  const params: string[] = [];
  if (turns.length > 0) params.push(`${SPEAKER_TAG_TURNS_PARAM}=${turns.join(',')}`);
  else if (ref?.claimsTurns === true) params.push(`${SPEAKER_TAG_TURNS_PARAM}=`);
  // Only meaningful beside a turn list — it says those turns disagree — so a
  // flag with nothing to be unsure ABOUT is dropped rather than written.
  if (ref?.unsure === true && turns.length > 0) params.push(`${SPEAKER_TAG_UNSURE_PARAM}=1`);
  const base = `${SPEAKER_TAG_SCHEME}${label}`;
  return params.length > 0 ? `${base}?${params.join('&')}` : base;
}

/**
 * `"speaker:B?t=10,12"` → the voice and what is known about where the
 * mention came from; null for every href that is not a speaker tag.
 *
 * Null rather than a throw: most links in a meeting doc are ordinary links,
 * and asking is the common case. An unreadable parameter costs the mention
 * its provenance and never its voice — the label is the identity, and a tag
 * an older build wrote with no parameters at all parses exactly as it did.
 */
export function parseSpeakerTagHref(href: string): SpeakerTagRef | null {
  if (!href.startsWith(SPEAKER_TAG_SCHEME)) return null;
  const rest = href.slice(SPEAKER_TAG_SCHEME.length).trim();
  const q = rest.indexOf('?');
  const label = (q < 0 ? rest : rest.slice(0, q)).trim();
  if (label.length === 0) return null;
  let turns: readonly number[] = [];
  let claimsTurns = false;
  let unsure = false;
  if (q >= 0) {
    for (const part of rest.slice(q + 1).split('&')) {
      const eq = part.indexOf('=');
      const key = eq < 0 ? part : part.slice(0, eq);
      const value = eq < 0 ? '' : part.slice(eq + 1);
      if (key === SPEAKER_TAG_TURNS_PARAM) {
        claimsTurns = true;
        turns = parseTurnList(value);
      } else if (key === SPEAKER_TAG_UNSURE_PARAM) unsure = value === '1';
    }
  }
  return { label, turns, claimsTurns, unsure: unsure && turns.length > 0 };
}

/**
 * `"speaker:B"` → `"B"`, and null for every other href — the question most
 * callers have, asked without the provenance they do not care about.
 */
export function speakerTagLabel(href: string): string | null {
  return parseSpeakerTagHref(href)?.label ?? null;
}

/**
 * The visible text of a tag for a voice: `"@Devi"`, or `"@Speaker B"`.
 *
 * BRACKETS ARE REMOVED, because a name is free text somebody typed and a tag
 * is a markdown link. "Sam [PM]" written into one produces
 * `[@Sam [PM]](speaker:C)`, which is not a tag any more: the finder cannot
 * see it, normalization skips it, and every later rename silently updates
 * nothing — the attribution stuck on that spelling for good.
 *
 * Removed rather than backslash-escaped, and that is the deliberate half.
 * Escaping only works if every path that writes a tag escapes, and one of
 * them is the document serializer, which writes `[` + text + `](href)` for
 * EVERY link and escapes none of them (a pre-existing bug this module is not
 * the place to fix). A name that cannot break the syntax is safe whichever
 * path writes it — the server composing markdown, or a person reassigning a
 * mention in the editor. The strip still shows the name as typed; it is only
 * inside a tag that the brackets go.
 */
export function speakerTagText(label: string, names: Readonly<Record<string, string>>): string {
  return `${SPEAKER_TAG_SIGIL}${tagSafeName(speakerDisplayName(label, names))}`;
}

/** A display name with the two characters that would end a link's text
 *  taken out, and the hole they leave tidied up. */
function tagSafeName(name: string): string {
  return name
    .replace(/[[\]\\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A whole tag as markdown: `[@Devi](speaker:B)`, or with the turns it was
 *  composed from, `[@Devi](speaker:B?t=10,12)`. */
export function renderSpeakerTag(
  label: string,
  names: Readonly<Record<string, string>>,
  ref?: SpeakerTagRefInit,
): string {
  return `[${speakerTagText(label, names)}](${speakerTagHref(label, ref)})`;
}

/** Undo a backslash escape, for a tag an older build wrote that way. */
function unescapeTagText(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

/**
 * The inverse: visible text made safe to sit inside a link's brackets.
 *
 * For callers holding text they did not compose — the document rewriter
 * rebuilds a one-tag markdown string out of what is actually in the doc,
 * and a person can type a bracket into a chip's words. Unescaped, that text
 * closes the link early, {@link findSpeakerTags} sees no tag at all, and the
 * mention silently sits out the correction. Escaped, it round-trips: the
 * finder unescapes it back on the way out.
 *
 * Not what {@link speakerTagText} does to a NAME — a name is stripped,
 * because names travel through the document serializer, which escapes
 * nothing. This is for text going straight into the finder and back.
 */
export function escapeTagText(text: string): string {
  return text.replace(/[[\]\\]/g, '\\$&');
}

/** One tag found in a markdown string. */
export interface SpeakerTagMatch {
  /** Index of the opening `[`. */
  start: number;
  /** Index one past the closing `)`. */
  end: number;
  /** The engine label the href carries. */
  label: string;
  /** The turns this mention was composed from, or empty when the href
   *  stamped none. See {@link SPEAKER_TAG_TURNS_PARAM}. */
  turns: readonly number[];
  /** The href claimed provenance, readable or not. See
   *  {@link SpeakerTagRef.claimsTurns} for why the distinction matters. */
  claimsTurns: boolean;
  /** A revision moved some of `turns` and not others. */
  unsure: boolean;
  /** The tag's visible text, sigil included and UNESCAPED — what a reader
   *  sees, and what a caller compares against a display name. */
  text: string;
  /** The tag exactly as it appears in the source, escapes and all. Compared
   *  against a freshly rendered tag to tell "already right" from "changed". */
  raw: string;
}

/**
 * Every speaker tag in a markdown string, in reading order.
 *
 * A scan rather than a full markdown parse: this runs on the composer's
 * reply and on item markdown, both of which are fragments rather than
 * documents, and the shape being looked for is exact. Link text may not
 * contain a bracket, which keeps a nested `[...]` from being read as a tag.
 */
export function findSpeakerTags(markdown: string): SpeakerTagMatch[] {
  const out: SpeakerTagMatch[] = [];
  // Link text is anything but an unescaped bracket; `\\.` lets an escaped
  // one through, which is how a name containing brackets stays findable.
  const re = /\[((?:\\.|[^\][\\])*)\]\(([^\s)]+)\)/g;
  for (const m of markdown.matchAll(re)) {
    const ref = parseSpeakerTagHref(m[2] ?? '');
    if (ref === null) continue;
    const start = m.index;
    out.push({
      start,
      end: start + m[0].length,
      label: ref.label,
      turns: ref.turns,
      claimsTurns: ref.claimsTurns,
      unsure: ref.unsure,
      text: unescapeTagText(m[1] ?? ''),
      raw: m[0],
    });
  }
  return out;
}

/** Every distinct voice a piece of markdown attributes anything to. */
export function speakerLabelsIn(markdown: string): string[] {
  const seen = new Set<string>();
  for (const tag of findSpeakerTags(markdown)) seen.add(tag.label);
  return [...seen];
}

/** Rebuild `markdown` with each tag replaced by what `replace` returns for
 *  it — null keeps the tag exactly as it was written. */
function rewriteTags(
  markdown: string,
  replace: (tag: SpeakerTagMatch) => string | null,
): { markdown: string; changed: number } {
  const tags = findSpeakerTags(markdown);
  if (tags.length === 0) return { markdown, changed: 0 };
  let out = '';
  let at = 0;
  let changed = 0;
  for (const tag of tags) {
    const next = replace(tag);
    if (next === null) continue;
    out += markdown.slice(at, tag.start) + next;
    at = tag.end;
    changed++;
  }
  return { markdown: out + markdown.slice(at), changed };
}

export interface NormalizeSpeakerTagsOptions {
  /** Label → the name a person has given that voice. */
  names: Readonly<Record<string, string>>;
  /**
   * The labels this meeting has actually carried. A tag naming anything else
   * is the model inventing a voice, and is unwrapped rather than shown.
   */
  known: ReadonlySet<string>;
  /**
   * Lines a PERSON wrote, which this pass must leave byte-for-byte alone.
   * The composer is asked to reproduce them verbatim and the merge
   * recognises them by exact text; normalizing one would turn the person's
   * own line into a second copy of itself in the doc.
   */
  protect?: readonly string[];
  /**
   * The turns THIS tick carried, per voice — the provenance stamped onto
   * every mention of that voice the tick composed.
   *
   * Only a tag that arrives WITHOUT provenance is stamped. One that has some
   * already came out of an earlier tick and is being re-emitted by a
   * composer that returns the whole notes every time; restamping it with
   * this tick's turns would move its provenance forward to words it was
   * never written from, and the first revision would then correct the wrong
   * mention. Omitted entirely by callers with no tick to speak for.
   */
  turnsByLabel?: Readonly<Record<string, readonly number[]>>;
}

export interface NormalizeSpeakerTagsResult {
  markdown: string;
  /** Tags whose visible name was rewritten from the name map. */
  renamed: number;
  /** Tags that gained this tick's provenance, their visible name unchanged. */
  stamped: number;
  /** Labels that were unwrapped because the meeting never carried them. */
  unknown: string[];
}

/**
 * Bring every tag in a composed section into the canonical form, and strip
 * the ones that name nobody.
 *
 * Two rules, both deterministic:
 *  1. A tag whose label the meeting carried is RE-RENDERED from the name map
 *     — the model's job is to say which voice, never to spell the name.
 *  2. A tag whose label it did not carry is UNWRAPPED to its own text, so
 *     the sentence still reads and no reader is told a voice said something
 *     that never spoke. The label is reported, never silently dropped.
 */
export function normalizeSpeakerTags(
  markdown: string,
  opts: NormalizeSpeakerTagsOptions,
): NormalizeSpeakerTagsResult {
  const protectedLines = protectedLineSet(opts.protect);
  const unknown: string[] = [];
  let renamed = 0;
  let stamped = 0;
  const lines = markdown.split('\n').map((line) => {
    if (isProtected(line, protectedLines)) return line;
    return rewriteTags(line, (tag) => {
      if (!opts.known.has(tag.label)) {
        unknown.push(tag.label);
        // The words stay; only the claim about who said them goes. A tag
        // whose text is bare sigil leaves nothing worth keeping.
        return unwrappedText(tag);
      }
      // Provenance the tag already carries is its own and is kept; a tag the
      // composer has just written carries none, and gets this tick's. Asked
      // of `claimsTurns` and not of the list, so a mention whose parameter
      // was corrupted keeps its empty handle instead of being handed one
      // from a tick it never came from.
      const turns = tag.claimsTurns ? tag.turns : (opts.turnsByLabel?.[tag.label] ?? []);
      const want = renderSpeakerTag(tag.label, opts.names, {
        turns,
        // Canonicalizing a corrupted handle drops the unreadable value, so
        // the empty claim is written back explicitly — otherwise this pass
        // turns the mention into a bare tag and the NEXT one stamps it.
        claimsTurns: tag.claimsTurns,
        unsure: tag.unsure,
      });
      if (want === tag.raw) return null;
      // Three reasons a tag gets rewritten, and only two of them are worth
      // a number. The third is canonicalizing a handle that would not parse
      // into the empty one — nothing was renamed and no provenance was
      // gained, so counting it as either would overstate what happened.
      if (speakerTagText(tag.label, opts.names) !== tag.text) renamed++;
      else if (!tag.claimsTurns && turns.length > 0) stamped++;
      return want;
    }).markdown;
  });
  return { markdown: lines.join('\n'), renamed, stamped, unknown };
}

/** A tag reduced to its own words, the claim about who said them gone. */
function unwrappedText(tag: SpeakerTagMatch): string {
  const text = tag.text.startsWith(SPEAKER_TAG_SIGIL) ? tag.text.slice(1) : tag.text;
  return text.trim().length > 0 ? text : '';
}

/**
 * The retroactive half of naming a voice, on a markdown string: every tag
 * for `label` now reads as `names[label]` says it should.
 *
 * Keyed by the LABEL, so it cannot touch another voice's mentions however
 * they are spelled — which is exactly what the display-text rewrite could
 * not promise when two voices shared a name.
 */
export function renameSpeakerTags(
  markdown: string,
  label: string,
  names: Readonly<Record<string, string>>,
): { markdown: string; replaced: number } {
  const { markdown: next, changed } = rewriteTags(markdown, (tag) => {
    if (tag.label !== label) return null;
    // A rename changes what a voice is CALLED, so the mention's own
    // provenance rides through untouched — including an `unsure` flag, which
    // says something about where the words came from rather than about the
    // name and is not answered by giving the voice a new one.
    const want = renderSpeakerTag(label, names, { turns: tag.turns, unsure: tag.unsure });
    return tag.raw === want ? null : want;
  });
  return { markdown: next, replaced: changed };
}

/**
 * Turn id → the voice the engine now says spoke it, `null` for "nobody".
 * Only turns whose label CHANGED are in it.
 */
export type SpeakerRevisions = ReadonlyMap<number, string | null>;

export interface ReattributeSpeakerTagsResult {
  markdown: string;
  /** Mentions moved to the voice the revision named. */
  moved: number;
  /** Mentions whose claim came off, because every turn behind them is now
   *  attributed to nobody. */
  unwrapped: number;
  /** Mentions the revision reached but could not place, now marked unsure. */
  unsure: number;
}

/**
 * The late half of who-said-what: the engine changed its mind AFTER these
 * words were written, and the notes catch up.
 *
 * A `SpeakerRevision` names TURNS, and a mention names a VOICE, so the join
 * is the provenance stamped in the href. For each tagged mention, every turn
 * behind it is asked what it is attributed to now — a revised turn answers
 * with its new label, an untouched one answers with the label it already
 * had, which is the mention's own:
 *
 *  - **They all agree on a different voice** → the mention moves. Every turn
 *    that could have produced these words belongs to that voice now, so the
 *    attribution is not a guess.
 *  - **They all agree on nobody** → the claim comes off and the words stay,
 *    the same remedy `normalizeSpeakerTags` gives a voice the meeting never
 *    carried. Saying "Speaker B" of speech the engine has withdrawn from B
 *    is the one outcome worse than saying nothing.
 *  - **They disagree** → the mention is marked unsure. Half its turns moved
 *    and half did not, so it belongs to one of two voices and the notes do
 *    not record which. A coin flip would put a name against words somebody
 *    else said; silence would hide that the meeting no longer stands behind
 *    the name already there.
 *  - **No provenance, or no turn behind it was revised** → untouched. That
 *    covers every tag written before this parameter existed and, on purpose,
 *    every mention a PERSON has reassigned: their answer is written bare, so
 *    no later engine pass revisits it.
 */
export function reattributeSpeakerTags(
  markdown: string,
  opts: { revisions: SpeakerRevisions; names: Readonly<Record<string, string>> },
): ReattributeSpeakerTagsResult {
  let moved = 0;
  let unwrapped = 0;
  let unsure = 0;
  const { markdown: next } = rewriteTags(markdown, (tag) => {
    if (tag.turns.length === 0) return null;
    let touched = false;
    const now = new Set<string | null>();
    for (const turn of tag.turns) {
      if (opts.revisions.has(turn)) {
        touched = true;
        now.add(opts.revisions.get(turn) ?? null);
      } else {
        // Not in the revision: this turn is still attributed the way the
        // mention already says it is.
        now.add(tag.label);
      }
    }
    if (!touched) return null;
    if (now.size === 1) {
      const [only] = now;
      // A revision that lands back on the label already written changes
      // nothing a reader can see.
      if (only === tag.label) return null;
      if (only === null) {
        unwrapped++;
        return unwrappedText(tag);
      }
      moved++;
      return renderSpeakerTag(only, opts.names, { turns: tag.turns });
    }
    // Already flagged by an earlier revision: nothing further to say.
    if (tag.unsure) return null;
    unsure++;
    return renderSpeakerTag(tag.label, opts.names, { turns: tag.turns, unsure: true });
  });
  return { markdown: next, moved, unwrapped, unsure };
}

/**
 * Is this line one a person wrote?
 *
 * Compared with the LIST MARKER STRIPPED as well as whole, because the two
 * sides spell an item differently: a person's item reaches us as the merge
 * records it — its own words, no marker, because a bullet's marker belongs
 * to the list rather than to the item — while the composer's reply is a
 * markdown document in which the same words are a `- ` line.
 */
function isProtected(line: string, protectedLines: ReadonlySet<string>): boolean {
  const trimmed = line.trim();
  if (protectedLines.has(trimmed)) return true;
  const unmarked = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
  return unmarked !== trimmed && protectedLines.has(unmarked);
}

function protectedLineSet(protect: readonly string[] | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  for (const item of protect ?? []) {
    for (const line of item.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) set.add(trimmed);
    }
  }
  return set;
}
