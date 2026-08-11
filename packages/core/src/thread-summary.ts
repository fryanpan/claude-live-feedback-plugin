/**
 * The summary block a thread card renders when it is collapsed: a topic line,
 * a discussion line, and who has spoken.
 *
 * ONE implementation for every surface — the drawer card, the margin balloon,
 * the mobile inline card and the sheet all call `threadSummary`. Forking it
 * per surface is how the two lines start disagreeing about what a thread is
 * about.
 *
 * Pure and DOM-free (same constraint as `ui-shared.ts` — the widget's bundle
 * size rides on this file staying dependency-free). It returns DATA, never
 * markup: author names and comment text are agent-supplied and untrusted, and
 * this module makes no assumption that anything escaped them upstream. Every
 * string here must reach the DOM through `textContent` (or through
 * `renderCommentMarkdown`, which escapes first).
 */

import type { Thread, User } from './types.ts';

/** Discussion line for a thread nobody has replied to. Rendered muted italic. */
export const NO_REPLIES_TEXT = 'No replies yet';

/**
 * Hard cap on the topic line, matching `SNIPPET_MAX` in `anchor/text-range.ts`
 * — text-range snippets already arrive within it; element anchors and the
 * opening-message fallback do not, so the cap is applied here too.
 */
export const TOPIC_MAX = 80;

/**
 * Hard cap on the discussion line. CSS ellipsizes at the real width (which is
 * far narrower); this only stops a 5,000-character comment from being poured
 * into the DOM for a one-line slot.
 */
export const DISCUSSION_MAX = 120;

/** Who to render on the participants row. */
export type ParticipantsLabel =
  | { kind: 'named'; name: string; text: string }
  | { kind: 'count'; count: number; text: string };

export interface Participants {
  /** Distinct repliers, first-appearance order, thread author excluded. */
  repliers: User[];
  /**
   * `text` is the whole row label for surfaces rendering a single text node;
   * `name` / `count` are there for surfaces that style the name separately.
   */
  label: ParticipantsLabel;
}

/** Where the discussion line came from. `none` is the no-replies state. */
export type DiscussionKind = 'replies' | 'none';

export interface ThreadLines {
  topic: string;
  discussion: string;
  discussionKind: DiscussionKind;
}

export interface ThreadSummaryBlock extends ThreadLines {
  /**
   * `null` when nobody but the author has spoken. This is the ONLY part of
   * the card that comes and goes — the two lines are always rendered.
   */
  participants: Participants | null;
}

/**
 * THE SEAM. The single place that decides what the two lines say.
 *
 * Today both lines are derived deterministically from data the thread already
 * carries: topic from the anchor snippet, discussion from the latest comment's
 * opening words. If generated summaries are ever approved, they change only
 * this function — prefer the stored generated text when present, fall back to
 * the deterministic result otherwise. No caller, no card builder and no CSS
 * changes.
 *
 * The no-replies branch is deliberately outside that: a thread with no replies
 * has no discussion to summarize, generated or otherwise.
 */
export function threadLines(t: Thread): ThreadLines {
  return { topic: deriveTopic(t), ...deriveDiscussion(t) };
}

/** The full collapsed-card block: both lines plus the participants descriptor. */
export function threadSummary(t: Thread): ThreadSummaryBlock {
  return { ...threadLines(t), participants: deriveParticipants(t) };
}

/**
 * Everything this module makes a card display, flattened for a render key.
 *
 * Every surface that caches a rendered card keys on THIS and not on a field
 * it picked out itself — three of them did, and all three picked `topic`.
 * That was correct only by accident: the values they left out happen to move
 * with `commentCount`/`lastActivity` today. Generation breaks the accident. A
 * summary arriving from the seam above changes no term any surface compares,
 * so the card never repaints and the new text is never seen.
 *
 * Add a field to the block and add it here, in the same edit.
 */
export function summaryKey(t: Thread): string {
  const s = threadSummary(t);
  const who = s.participants?.repliers.map((r) => r.id).join(',') ?? '';
  return [s.topic, s.discussion, s.discussionKind, who].join('\u0001');
}

function deriveTopic(t: Thread): string {
  const a = t.anchor;
  // Anchors arrive as opaque JSON out of the ydoc and are never validated on
  // the way in. Every constructor we own writes a snippet, so this is belt
  // and braces — but the blast radius changed when this function joined the
  // render key: one malformed anchor used to break its own card, and would
  // now throw inside the key and take down the whole panel render.
  const raw = a.kind === 'orphan' ? a.original?.snippet?.text : a.snippet?.text;
  const snippet = oneLine(raw ?? '');
  // An anchor can legitimately carry an empty snippet (a collapsed range, an
  // element with no text). A blank topic line would leave slot A with nothing
  // to morph out of, so fall back to what the thread opened with.
  const text = snippet || oneLine(t.comments[0]?.text ?? '');
  return clip(text, TOPIC_MAX);
}

function deriveDiscussion(t: Thread): { discussion: string; discussionKind: DiscussionKind } {
  // Walk back from the latest reply: a trailing blank comment is not where the
  // discussion "got to", and an empty discussion line is worse than saying
  // there is nothing there.
  for (let i = t.comments.length - 1; i >= 1; i--) {
    const text = oneLine(t.comments[i]?.text ?? '');
    if (text) return { discussion: clip(text, DISCUSSION_MAX), discussionKind: 'replies' };
  }
  return { discussion: NO_REPLIES_TEXT, discussionKind: 'none' };
}

function deriveParticipants(t: Thread): Participants | null {
  // The header row is the opening message's attribution, so its author is
  // already named there. Exclude both the recorded thread author and the
  // opening comment's author — the same person in practice, but a card must
  // not name someone twice if the two ever disagree.
  const excluded = new Set([userKey(t.createdBy), userKey(t.comments[0]?.author)]);
  const seen = new Set<string>();
  const repliers: User[] = [];
  for (const c of t.comments.slice(1)) {
    if (!c?.author) continue;
    const key = userKey(c.author);
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    repliers.push(c.author);
  }

  if (repliers.length === 0) return null;
  if (repliers.length === 1) {
    // Counting to one is worse than saying who.
    const name = repliers[0]?.name ?? '';
    return { repliers, label: { kind: 'named', name, text: `${name} replied` } };
  }
  const count = repliers.length;
  return { repliers, label: { kind: 'count', count, text: `+${count} others` } };
}

/** Identity for dedup/exclusion: id when there is one, display name otherwise. */
function userKey(u: User | undefined): string {
  return u?.id ? `id:${u.id}` : `name:${u?.name ?? ''}`;
}

/** Collapse all whitespace so a multi-line comment still fits one card row. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Clip to `max` INCLUDING the ellipsis, backing off to a word boundary. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour the word boundary if it doesn't throw away most of the line.
  const head = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s,.;:!?-]+$/, '')}…`;
}
