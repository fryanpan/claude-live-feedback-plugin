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

import type { StoredSummary, Thread, User } from './types.ts';

/** Discussion line for a thread nobody has replied to. Rendered muted italic. */
export const NO_REPLIES_TEXT = 'No replies yet';

/** Discussion line while a regenerated summary is in flight. */
export const SUMMARY_PENDING_TEXT = 'Generating summary…';

/**
 * How long after a thread's last activity a missing/stale summary still reads
 * as "in flight". Generation normally lands in ~4–6s (3s debounce + one Haiku
 * call); the window is deliberately generous because its expiry is the ONLY
 * thing that turns a failed generation back into the fallback lines instead of
 * a spinner that never resolves.
 */
export const SUMMARY_PENDING_WINDOW_MS = 30_000;

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

/**
 * Where the discussion line came from. `none` is the no-replies state;
 * `pending` is the generation-in-flight state.
 */
export type DiscussionKind = 'replies' | 'none' | 'pending';

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
 * Both lines are derived deterministically from data the thread already
 * carries — topic from the anchor snippet, discussion from the latest
 * comment's opening words — UNLESS a generated summary is stored on the thread
 * and still matches what it was generated from. Generation was added here and
 * nowhere else: no caller, no card builder and no CSS changed, and every
 * surface plus `summaryKey` inherits it for free.
 *
 * A stored summary whose hash no longer matches is IGNORED rather than
 * deleted. The thread has moved on since it was written, the regenerated one
 * will arrive in a few seconds, and a stale sentence about a superseded state
 * is worse than the raw comment it replaced.
 *
 * The no-replies branch is deliberately outside all of that: a thread with no
 * replies has no discussion to summarize, generated or otherwise, so the model
 * is never allowed to invent a conversation that has not happened.
 */
export function threadLines(t: Thread): ThreadLines {
  const base = { topic: deriveTopic(t), ...deriveDiscussion(t) };
  const stored = t.summary;
  if (stored && stored.hash === summaryHash(t)) {
    // A current stored summary wins even over a pending stamp — if the
    // regenerated summary has already synced, "generating" would be a lie.
    return {
      topic: stored.topic || base.topic,
      discussion:
        base.discussionKind === 'none' ? base.discussion : stored.discussion || base.discussion,
      discussionKind: base.discussionKind,
    };
  }
  if (t.summaryPending) {
    // Topic stays deterministic (the anchor snippet is already right); only
    // the discussion line announces the in-flight generation.
    return { topic: base.topic, discussion: SUMMARY_PENDING_TEXT, discussionKind: 'pending' };
  }
  return base;
}

/**
 * Should a collector stamp `summaryPending` on this thread?
 *
 * The client cannot see the server's Haiku call, so "in flight" is inferred:
 * generation is enabled on this doc, the stored summary is absent or stale,
 * and the thread changed recently enough that the regeneration debounce +
 * call should still be running. Time-bounding on `lastActivity` is what lets
 * a failed call degrade to the deterministic lines instead of spinning.
 */
export function summaryPending(t: Thread, opts: { enabled: boolean; now: number }): boolean {
  if (!opts.enabled) return false;
  if (t.summary && t.summary.hash === summaryHash(t)) return false;
  return opts.now - t.lastActivity < SUMMARY_PENDING_WINDOW_MS;
}

/**
 * Lift a `summary` value out of untrusted storage.
 *
 * THE ONLY WAY a summary should enter a `Thread`. Every field is checked,
 * because the value arrives as opaque JSON out of a Yjs map — and Yjs sync is
 * a full state exchange with no server-side write authority, so any synced
 * peer (a share visitor included) can put an arbitrary shape there. Checking
 * `topic` and `hash` but not `discussion` was not enough: a non-string
 * `discussion` is truthy, wins the `stored.discussion || base.discussion`
 * choice in `threadLines`, and reaches a card row declared `string` — which
 * renders as `[object Object]`.
 *
 * Returns a fresh, three-field object so nothing else riding on the stored
 * value travels with it.
 */
export function readStoredSummary(value: unknown): StoredSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const s = value as Record<string, unknown>;
  if (typeof s.topic !== 'string') return undefined;
  if (typeof s.discussion !== 'string') return undefined;
  if (typeof s.hash !== 'string') return undefined;
  return { topic: s.topic, discussion: s.discussion, hash: s.hash };
}

/**
 * The anchor's own text, whatever kind of anchor it is. Shared by the topic
 * line, the hash, and the prompt so all three agree on what "the anchored
 * text" means.
 */
export function anchorText(t: Thread): string {
  const a = t.anchor;
  const raw = a.kind === 'orphan' ? a.original?.snippet?.text : a.snippet?.text;
  return oneLine(raw ?? '');
}

/**
 * Fingerprint of everything a summary is derived from.
 *
 * Covers the comment texts AND the anchor snippet. Hashing the comments alone
 * would strand an edited anchor with a topic line describing text that is no
 * longer there — the snippet moves independently of the comments, which is the
 * same reason `summaryKey` exists on the render side.
 *
 * FNV-1a: a change-detector, not a security primitive. It has to run
 * identically in the server, the browser and a test without pulling in a
 * crypto import.
 */
export function summaryHash(t: Thread): string {
  const input = [anchorText(t), ...t.comments.map((c) => `${c.author?.name ?? ''} ${c.text}`)]
    .join('\u0000')
    .normalize('NFC');
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
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
  // Anchors arrive as opaque JSON out of the ydoc and are never validated on
  // the way in. Every constructor we own writes a snippet, so this is belt
  // and braces — but the blast radius changed when this function joined the
  // render key: one malformed anchor used to break its own card, and would
  // now throw inside the key and take down the whole panel render.
  const snippet = anchorText(t);
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
