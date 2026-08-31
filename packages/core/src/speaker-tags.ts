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
 * The character that opens a tag's visible text. Not decoration: it is what
 * tells a reader of the raw markdown — and a reader of the flushed .md file,
 * where nothing renders a chip — that "Devi" here is an attribution and not
 * the first word of the sentence.
 */
export const SPEAKER_TAG_SIGIL = '@';

/** `"B"` → `"speaker:B"`. */
export function speakerTagHref(label: string): string {
  return `${SPEAKER_TAG_SCHEME}${label}`;
}

/**
 * `"speaker:B"` → `"B"`, and null for every other href. Null rather than a
 * throw: most links in a meeting doc are ordinary links, and asking is the
 * common case.
 */
export function speakerTagLabel(href: string): string | null {
  if (!href.startsWith(SPEAKER_TAG_SCHEME)) return null;
  const label = href.slice(SPEAKER_TAG_SCHEME.length).trim();
  return label.length > 0 ? label : null;
}

/** The visible text of a tag for a voice: `"@Devi"`, or `"@Speaker B"`. */
export function speakerTagText(label: string, names: Readonly<Record<string, string>>): string {
  return `${SPEAKER_TAG_SIGIL}${speakerDisplayName(label, names)}`;
}

/** A whole tag as markdown: `[@Devi](speaker:B)`. */
export function renderSpeakerTag(label: string, names: Readonly<Record<string, string>>): string {
  return `[${speakerTagText(label, names)}](${speakerTagHref(label)})`;
}

/** One tag found in a markdown string. */
export interface SpeakerTagMatch {
  /** Index of the opening `[`. */
  start: number;
  /** Index one past the closing `)`. */
  end: number;
  /** The engine label the href carries. */
  label: string;
  /** The tag's visible text, sigil included. */
  text: string;
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
  const re = /\[([^\][]*)\]\(([^\s)]+)\)/g;
  for (const m of markdown.matchAll(re)) {
    const label = speakerTagLabel(m[2] ?? '');
    if (label === null) continue;
    const start = m.index;
    out.push({ start, end: start + m[0].length, label, text: m[1] ?? '' });
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
}

export interface NormalizeSpeakerTagsResult {
  markdown: string;
  /** Tags whose visible name was rewritten from the name map. */
  renamed: number;
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
  const lines = markdown.split('\n').map((line) => {
    if (isProtected(line, protectedLines)) return line;
    return rewriteTags(line, (tag) => {
      if (!opts.known.has(tag.label)) {
        unknown.push(tag.label);
        // The words stay; only the claim about who said them goes. A tag
        // whose text is bare sigil leaves nothing worth keeping.
        const text = tag.text.startsWith(SPEAKER_TAG_SIGIL) ? tag.text.slice(1) : tag.text;
        return text.trim().length > 0 ? text : '';
      }
      const want = renderSpeakerTag(tag.label, opts.names);
      const already = `[${tag.text}](${speakerTagHref(tag.label)})`;
      if (want === already) return null;
      renamed++;
      return want;
    }).markdown;
  });
  return { markdown: lines.join('\n'), renamed, unknown };
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
  const want = renderSpeakerTag(label, names);
  const { markdown: next, changed } = rewriteTags(markdown, (tag) => {
    if (tag.label !== label) return null;
    const already = `[${tag.text}](${speakerTagHref(tag.label)})`;
    return already === want ? null : want;
  });
  return { markdown: next, replaced: changed };
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
