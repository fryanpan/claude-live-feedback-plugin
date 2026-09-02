/**
 * A huddle's identity on the server: what it is called, where its file
 * lives, and what its first bytes are.
 *
 * A huddle is a live conversation over a doc, started from the Board before
 * there is a task. Everything about it that is a DOC — the room, the file
 * binding, the board filing, the listing — is the ordinary doc machinery;
 * this module is only the handful of pure decisions the huddle route makes
 * before handing over to it, kept out of `server.ts` so they can be read and
 * tested without a server.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { HuddleKind } from '@feedback/core';

export type { HuddleKind };

/** Longer than this and it is a paragraph, not a topic. */
export const HUDDLE_TOPIC_MAX = 200;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * "Huddle 2026-08-29 14:05" — the clock, to the minute, in the SERVER's
 * local time. The server is the box on Bryan's desk, so its clock is the
 * room's clock; a browser-supplied zone would be one more thing to get
 * wrong for a title that only has to read naturally to the people in it.
 */
export function huddleTitle(at: number): string {
  const d = new Date(at);
  return `Huddle ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The readable name the doc is created under — `huddle-20260829-1405-x7q2`.
 * The doc's ADDRESS is the id `createForCaller` mints; this is the alias
 * that name resolves through, and it needs a random tail because two
 * huddles in one minute are two docs.
 */
export function huddleAlias(at: number): string {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `huddle-${stamp}-${randomBytes(3)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'x')}`;
}

/**
 * The topic, if the caller sent one that can be a heading. `undefined` is
 * the bare button press and is fine; a non-string or an over-long one is the
 * caller's mistake and is refused rather than truncated — a title cut mid-word
 * is a worse first line than a 400.
 */
export function parseHuddleTopic(raw: unknown): { ok: true; topic?: string } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'string') return { ok: false };
  const topic = raw.trim().replace(/\s+/g, ' ');
  if (topic.length === 0) return { ok: true };
  if (topic.length > HUDDLE_TOPIC_MAX) return { ok: false };
  return { ok: true, topic };
}

/**
 * Which of the Board's two entry flows is asking. `'plan'` is "Make a plan"
 * — the doc opens goal-shaped; `'discussion'` is "Have a discussion" — live
 * notes over an empty doc. Absent is the old payload (a caller from before
 * the split) and keeps the old behavior exactly.
 */
export function parseHuddleKind(raw: unknown): { ok: true; kind?: HuddleKind } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (raw === 'plan' || raw === 'discussion') return { ok: true, kind: raw };
  return { ok: false };
}

/**
 * What the Make Plan press says. The ask travels as an ordinary comment
 * thread from the presser — comments are the product's ask channel, so it
 * rides the existing thread.created webhook and board channel to whichever
 * agent watches this doc, with no new event type. Fixed text: the button is
 * one tap, and the goal it points at is the doc itself.
 */
export const PLAN_REQUEST_COMMENT =
  'Please make a plan from this goal. Append it to this doc as a "Plan" section, and file the first tickets from it.';

/**
 * What the Review press says — the meeting's second float, beside Make Plan.
 * Same channel: a subject thread from the presser. The agent reads the notes
 * AND the transcript, and answers on the lines it has questions about, as
 * review or decision items where an answer is a choice rather than prose.
 */
export const REVIEW_REQUEST_COMMENT =
  'Please review these notes against the transcript so far. Where a point is thin, ambiguous, or missing a decision, ask a clarifying question as a comment on that line — as a review or decision item where one would help.';

/**
 * The file's first bytes. A plan doc always opens under a `# Goal` heading —
 * that heading is what the placeholder copy and the Make Plan float hang off
 * — with a topic, when one was given, filed under it as the first line of
 * the goal statement rather than replacing the heading. Everything else:
 * the topic as the first heading, else nothing.
 */
export function huddleSeedMarkdown(topic?: string, kind?: HuddleKind): string {
  if (kind === 'plan') return topic ? `# Goal\n\n${topic}\n` : '# Goal\n';
  return topic ? `# ${topic}\n` : '';
}

/**
 * Where the huddle's markdown lives. Under the data dir rather than in any
 * repo: a huddle has no project file to be bound to, and the doc IS the
 * record — the file is the write-back's target so the record survives the
 * `.ydoc`, same as every other bound doc. The id is server-minted
 * (`d-…`), so it is filename-safe by construction.
 */
export function huddleFilePath(dataDir: string, docId: string): string {
  return join(dataDir, 'huddles', `${docId}.md`);
}

// ---------------------------------------------------------------------------
// A calendar meeting's discussion doc — the same shape of decisions, made for
// the doc the "join this meeting" click creates. A meeting doc is a huddle
// whose conversation happens in a video call the bot is listening to.
// ---------------------------------------------------------------------------

/**
 * The event's own title when the calendar has one; the clock, huddle-style,
 * when it does not — an untitled event is still a real meeting, and "Meeting"
 * plus when it happened is how a person will look for it later.
 */
export function meetingDocTitle(eventTitle: string | null, at: number): string {
  if (eventTitle) return eventTitle;
  const d = new Date(at);
  return `Meeting ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `meeting-20260901-1405-x7q2` — same construction as `huddleAlias`. */
export function meetingDocAlias(at: number): string {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `meeting-${stamp}-${randomBytes(3)
    .toString('base64url')
    .replace(/[^A-Za-z0-9]/g, 'x')}`;
}

/** Beside the huddles, for the same reason huddles live under the data dir. */
export function meetingDocFilePath(dataDir: string, docId: string): string {
  return join(dataDir, 'meetings', `${docId}.md`);
}
