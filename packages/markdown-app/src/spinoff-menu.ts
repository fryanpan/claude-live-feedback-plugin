/**
 * Spinning work off a line of a huddle doc.
 *
 * A discussion produces lines that are not discussion: a thing to do, a thing
 * to look up. Today the only gesture over a selection is "comment", so both
 * of those arrive as prose somebody has to re-read later and act on by hand.
 * This is what the pointer pill (`pointer-pill.ts`) puts behind that same
 * selection: two ways for a line to leave the doc as work, anchored on the
 * line itself so nothing has to be re-described.
 *
 * ONLY on huddle docs. An ordinary review doc's pill stays exactly what it
 * was — a comment affordance — because a doc under review is not a place work
 * is generated from, and a work menu over a proofreading selection is the
 * wrong answer twice.
 *
 * Everything here rides verbs that already exist: a task create with a `doc`
 * origin (the same one the meeting assistant files its captured tasks
 * through), an anchored thread, and the comment composer. Nothing new on the
 * server, no new webhook, no plugin version.
 *
 * The created task is linked back INTO the prose at the selection, which is
 * the whole point of anchoring on the line: `task-link-chips.ts` sees a
 * same-origin `/workspaces/<ws>?task=<id>` link and decorates it with the
 * row's live status, so the doc shows what became of the line without this
 * module knowing anything about status.
 *
 * Where the two buttons sit is `pointer-pill.ts`'s problem; this module is
 * the verbs behind them.
 */

import type { User } from '@feedback/core';

/** A text-range anchor as it goes over the wire — `anchorBody`'s output. */
export interface SpinoffAnchor {
  kind: 'text-range';
  startRel: number[];
  endRel: number[];
  snippet: { text: string };
  deletedSnippet?: string;
}

/** The two that put a ROW on the board — which is now all of them. The
 *  alias survives because the caller that writes the link back into the
 *  prose is typed against it, and the name says what the id is FOR. */
export type SpinoffTaskId = 'task' | 'research';
export type SpinoffId = SpinoffTaskId;

export interface SpinoffAction {
  id: SpinoffId;
  label: string;
}

/**
 * The two, as the pill shows them: "Research" first, because the mock put
 * the agent's errand in the primary slot, and "Create Task" beside it.
 *
 * There were five, then four. "Start now" did what "Create a task" did plus
 * `order: 0`, which nobody could tell apart in the running product, so Bryan
 * collapsed them (2026-09-01): where a row lands is decided from what the
 * row SAYS, not from which of two identical buttons was pressed. Then
 * "Answer a question" and "Leave a comment" went the same day, with the
 * menu they lived in: both only opened the composer, and a selection on a
 * huddle doc is now answered by a two-button pill at the pointer rather than
 * a four-row menu behind a button. Labels are text, no icons — the pill is
 * read, not decoded.
 */
export const SPINOFF_ACTIONS: readonly SpinoffAction[] = [
  { id: 'research', label: 'Research' },
  { id: 'task', label: 'Create Task' },
] as const;

/** A task title is a line of a title, not a paragraph of one. */
const TITLE_MAX = 80;

/**
 * Shorten to `limit` characters WITHOUT cutting a word in half.
 *
 * The twin of the server's `clipToWordBoundary` (task-title.ts), deliberately
 * re-spelled rather than shared: that module lives in the server package, and
 * the only place in `@feedback/core` both front-ends could reach is
 * `ui-shared.ts`, which the injectable widget bundles and whose size is a
 * hard constraint. Ten lines of pure string work is the cheaper duplicate.
 */
export function clipTitle(text: string, limit = TITLE_MAX): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.slice(0, Math.max(1, limit - 1));
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${kept.replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/**
 * A row's title, from the words somebody selected.
 *
 * The selection is a line of talk, and a line of talk is not a title. What
 * shipped first was `clipTitle(quote)` — the raw selection, verbatim — which
 * put rows on the board called "## Cloudflare" and "- so we should check
 * whether Access covers the mockup route,". Three things are wrong there and
 * each is fixed below:
 *
 * - **The markdown marker is structure, not words.** A heading's `##` and a
 *   bullet's `-` describe where the line sits in the doc; neither is part of
 *   what the line says, and neither belongs in a title on a board that has no
 *   headings.
 * - **A paragraph is not a title.** When the selection runs to several
 *   sentences the first one is the subject and the rest is elaboration, which
 *   belongs in the body (`spinoffBody` already quotes the whole thing). The
 *   `{12,}` floor keeps an abbreviation's full stop — "Mr. Smith", "e.g." —
 *   from being read as the end of the sentence and leaving a two-word title.
 * - **Trailing punctuation is a seam, not a word.** A line clipped mid-clause
 *   ends on a comma; a title never should. `?` and `!` are the exception and
 *   stay: they are the last word of the sentence rather than a join between
 *   two, and "Research: Does Access cover the mockup route" asks nothing.
 */
export function deriveTaskTitle(quote: string, limit = TITLE_MAX): string {
  const flat = quote.trim().replace(/\s+/g, ' ');
  const bare = flat.replace(/^(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)+/, '');
  const firstSentence = bare.match(/^(.{12,}?[.!?])(?:\s|$)/)?.[1] ?? bare;
  const tidy = firstSentence.replace(/[\s,;:.…\-–—]+$/, '');
  return clipTitle(tidy, limit) || clipTitle(flat, limit);
}

/**
 * Whether a row's own words are enough to pick it up — To do if so, Triage
 * if not.
 *
 * A person's create normally lands in To do, and that is right when the
 * person WROTE the row. A spin-off is not written, it is selected: the words
 * are a fragment of somebody's sentence, and a reviewer's pass filed rows
 * called "Cloudflare" and "Access" this way. Nobody can act on those, and a
 * row nobody can act on sitting in To do is worse than the same row in
 * Triage, because To do is the list people work from.
 *
 * Three words is the line, and it is deliberately crude: it separates a
 * noun somebody happened to double-click from a phrase with something to do
 * in it, which is the whole distinction being drawn. The cost of getting it
 * wrong is one drag between two columns, in either direction.
 */
export function readyToWork(title: string): boolean {
  return title.trim().split(/\s+/).filter(Boolean).length >= 3;
}

/**
 * The link a spun-off task is written back into the prose as.
 *
 * Root-relative on purpose, and byte-identical to the server's
 * `taskCaptureUrl`: `task-link-chips.ts` only decorates a SAME-ORIGIN href,
 * and an absolute one baked at localhost is a dead link the moment the doc is
 * read over the tailnet.
 */
export function taskLinkHref(workspaceId: string, taskId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(taskId)}`;
}

/**
 * Which board a spun-off row is filed on.
 *
 * Two ids, and they are not the same thing. `backTo` is the BOARD a doc was
 * reached from — for a huddle, the board that started it. `workspaceId` is the
 * GROUPING id of a diff review or a folder browse, and a huddle doc has none
 * at all.
 *
 * It is a function, and tested, because reading the wrong one of the two
 * failed silently in exactly the way an id mix-up does: `DocMeta` defaults
 * both to the empty string, so an `=== undefined` guard let `''` through and
 * the create went to `/api/workspaces//tasks`. The person got a toast that
 * said "404".
 */
export function boardIdFor(meta: {
  backTo?: { workspaceId?: string };
  workspaceId?: string;
}): string {
  return meta.backTo?.workspaceId?.trim() || meta.workspaceId?.trim() || '';
}

export interface SpinoffDeps {
  docId: string;
  workspaceId: string;
  /** The person spinning off. A person-authored create lands at `todo`; an
   *  agent's would land at `triage`, which is not what a tap means. */
  user: User;
  /** The selected words — the line the menu was opened on. */
  quote: string;
  /**
   * That same selection as a thread anchor — the WIRE shape
   * (`review-chrome.ts`'s `anchorBody`), not core's `Anchor`. The two differ
   * on purpose: core stores relative positions as `Uint8Array`, and what
   * crosses the network is the JSON array form. Nothing here posts it today;
   * it rides along so a caller can pin what was spun off from where.
   */
  anchor: SpinoffAnchor;
  /** The doc's own title, so the created row can say where it came from. */
  docTitle?: string;
  fetchJson: (url: string, init?: RequestInit) => Promise<unknown>;
}

export interface SpinoffResult {
  action: SpinoffId;
  /** The created row's id. */
  taskId: string;
  /** Where the board actually put it — `todo` or `triage`. Read back from
   *  the create rather than predicted, so the toast cannot tell somebody
   *  their row is in a column it is not in. */
  status?: string;
  /** The row's title as the board now holds it — so the toast can name what
   *  was made rather than saying "Task created" about nothing in particular,
   *  and so the person can tell whether the title came out sane. */
  title?: string;
  /** The href to write over the selection. */
  href: string;
}

/** The body every spun-off row carries: where it came from, in words, since
 *  the `origin` ref is machine-readable and a person reading the ticket a
 *  week later is not. */
function spinoffBody(quote: string, docTitle: string | undefined): string {
  const where = docTitle ? ` "${docTitle}"` : '';
  return `Spun off from a line of the discussion${where}.\n\n> ${quote.trim().replace(/\s+/g, ' ')}`;
}

function post(deps: SpinoffDeps, url: string, body: unknown): Promise<unknown> {
  return deps.fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Run one spin-off. Returns what it made, so the caller can write the link
 * over the selection and say so; `null` when the server answered without a
 * row id, which the caller reports rather than inventing one.
 */
export async function runSpinoff(
  action: SpinoffId,
  deps: SpinoffDeps,
): Promise<SpinoffResult | null> {
  const said = deriveTaskTitle(deps.quote, action === 'research' ? TITLE_MAX - 10 : TITLE_MAX);
  const title = action === 'research' ? `Research: ${said}` : said;
  const res = (await post(deps, `/api/workspaces/${encodeURIComponent(deps.workspaceId)}/tasks`, {
    title,
    body: spinoffBody(deps.quote, deps.docTitle),
    author: deps.user,
    // Where it came from, the way the meeting assistant's captured tasks
    // say it — one origin kind for "a doc line became this".
    origin: { kind: 'doc', docId: deps.docId },
    // Research is the agent's errand, not the tapper's. Left unsaid, the
    // create route falls the assignee back to the author, which put "go and
    // find out about this" on the plate of the person who asked the question
    // — and a client-side lead lookup that came back empty left that
    // fallback in place. So the row is ADDRESSED to the board: the server
    // hands it to the lead, or files it at triage owned by nobody when
    // there is no lead, and never to whoever tapped.
    ...(action === 'research' ? { assignToLead: true } : {}),
    // Where the row lands, decided from what the row SAYS. A thin selection
    // makes a row nobody can pick up, and triage is where a row goes to be
    // given enough to act on — see `readyToWork`.
    ...(!readyToWork(said) ? { triage: true } : {}),
  })) as { task?: { id?: string; status?: string } };
  const taskId = res?.task?.id;
  if (taskId === undefined) return null;
  const status = typeof res.task?.status === 'string' ? res.task.status : undefined;
  return {
    action,
    taskId,
    title,
    ...(status !== undefined ? { status } : {}),
    href: taskLinkHref(deps.workspaceId, taskId),
  };
}
