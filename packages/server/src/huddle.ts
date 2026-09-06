/**
 * A huddle's identity on the server: what it is called, where its file
 * lives, and what its first bytes are.
 *
 * A huddle is a live conversation over a doc, started from the Board before
 * there is a task. Everything about it that is a DOC — the doc, the file
 * binding, the board filing, the listing — is the ordinary doc machinery;
 * this module is only the handful of pure decisions the huddle route makes
 * before handing over to it, kept out of `server.ts` so they can be read and
 * tested without a server.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { type HuddleKind, docKindLabel } from '@feedback/core';

export type { HuddleKind };

/** Longer than this and it is a paragraph, not a topic. */
export const HUDDLE_TOPIC_MAX = 200;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * "Plan 2026-08-29 14:05" / "Meeting notes 2026-08-29 14:05" — the doc's kind
 * in the product's words, then the clock, to the minute, in the SERVER's
 * local time. The server is the box on Bryan's desk, so its clock is the
 * room's clock; a browser-supplied zone would be one more thing to get
 * wrong for a title that only has to read naturally to the people in it.
 *
 * The word is the KIND, not the mechanism: Bryan retired "Huddle" from the
 * UI on 2026-09-02 ("We can have plans and meeting notes"). An absent kind is
 * a caller from before the split and reads as meeting notes, which is what
 * an untyped live doc has always been.
 */
export function huddleTitle(at: number, kind?: HuddleKind): string {
  const d = new Date(at);
  const clock = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${docKindLabel(kind)} ${clock}`;
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
 * — the doc opens goal-shaped; `'discussion'` is "Have a meeting" — live
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
  'Please make a plan from this goal. Append it to this doc as a "Plan" section, and file the first tickets from it. ' +
  'Ask each question you have as its own thread on the sentence it is about (create_thread with `find` and a `review` payload) — never a list of questions in one comment.';

/**
 * What the Review press says — the meeting's second float, beside Make Plan.
 * Same channel: a subject thread from the presser. The agent reads the notes
 * AND the transcript, and answers on the lines it has questions about, as
 * review or decision items where an answer is a choice rather than prose.
 */
export const REVIEW_REQUEST_COMMENT =
  'Please review these notes against the transcript so far. Where a point is thin, ambiguous, or missing a decision, ask a clarifying question as a comment on that line — as a review or decision item where one would help.';

/**
 * The same two asks, pressed on a TICKET rather than on a huddle doc.
 *
 * A task's comments live in its body doc (`task:<id>`), so the board's
 * controls file through the very routes the floats use and the seated lead
 * hears them on the subscription it already holds. What cannot travel from
 * the doc is the WORDS: `PLAN_REQUEST_COMMENT` tells the agent to append a
 * Plan section to "this doc" and file the first tickets from it, which on a
 * ticket names the ticket's own description and asks for tickets from a
 * ticket. So the text is the ticket's, and only the text — the shape, the
 * channel and the stamp are shared.
 */
export const TASK_PLAN_REQUEST_COMMENT =
  'Please make a plan for this ticket. Write it into the ticket description as a "Plan" section, covering the approach and the steps, and file any follow-up tickets it needs. ' +
  'Ask each question you have as its own thread on this ticket (create_thread with a `review` payload) — never a list of questions in one comment.';

export const TASK_REVIEW_REQUEST_COMMENT =
  'Please review this ticket before it is worked. Where the goal, the acceptance criteria or the approach is thin, ambiguous, or missing a decision, ask a clarifying question as a comment on this ticket — as a review or decision item where an answer is a choice rather than prose.';

/**
 * Which words an ask carries: a ticket's, or a huddle doc's.
 *
 * `onTask` rather than a doc id, because whether a doc id names a ticket's
 * body is `taskIdOfBodyDoc`'s question (`task-row.ts`) and there must not be
 * a second answer to it — spelling the `task:` prefix here would be exactly
 * that, one rename away from silently sending huddle words to a ticket.
 */
export function askCommentFor(onTask: boolean, kind: 'plan' | 'review'): string {
  if (kind === 'plan') return onTask ? TASK_PLAN_REQUEST_COMMENT : PLAN_REQUEST_COMMENT;
  return onTask ? TASK_REVIEW_REQUEST_COMMENT : REVIEW_REQUEST_COMMENT;
}

/**
 * What a review ask heard in the transcript says — the Review float's press
 * with the person's own question attached, so the agent answers what was
 * asked rather than reviewing everything. Same channel, same shape: a
 * subject thread on the doc, stamped so the float shows the ask is open.
 */
export function spokenReviewComment(question: string, requester?: string): string {
  const who = requester ? `${requester} asked` : 'Someone asked';
  const q = question.trim().replace(/\s+/g, ' ');
  return `${who} in the meeting: "${q}"\n\nPlease answer against the notes and the transcript so far, as a comment on the line it concerns — as a review or decision item where a choice is needed.`;
}

/** The pill's Research topic, as a heading: a line, not a paragraph. */
export const RESEARCH_TOPIC_MAX = 120;

/** The section heading a Research press writes — the same words the ask
 *  thread names, so the agent can find where to write. */
export function researchSectionTitle(topic: string): string {
  return `Research: ${topic.trim().replace(/\s+/g, ' ')}`;
}

/**
 * What the pointer pill's Research press leaves IN THE NOTES, right after
 * the line it was pressed on — the approved mock's flow (pointer-actions
 * mock, 2026-09-01): a section headed with the topic and a one-line
 * placeholder the agent replaces with what it finds. Not a task: Bryan
 * pressed Research on prod, got a board row and nothing in the doc, and
 * said so ("does not follow the flow in the mockups"). The row was the
 * errand's bookkeeping; the section is the errand's answer, where the
 * person who asked will look for it.
 */
export function researchPlaceholderMarkdown(topic: string): string {
  return `## ${researchSectionTitle(topic)}\n\nResearching — in progress.`;
}

/**
 * What the Research press SAYS — an anchored thread on the selected line,
 * from the presser. Same channel as Make Plan and Review: an ordinary
 * comment, which every watching agent already hears. It names the section
 * the placeholder opened, so the agent writes there rather than replying
 * in prose the person would have to move.
 */
export function researchAskComment(topic: string): string {
  const title = researchSectionTitle(topic);
  return `Research: ${topic.trim().replace(/\s+/g, ' ')}\n\nPlease look into this and write what you find under the "${title}" section just below this line, replacing its placeholder. Resolve this thread when the section is filled.`;
}

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
