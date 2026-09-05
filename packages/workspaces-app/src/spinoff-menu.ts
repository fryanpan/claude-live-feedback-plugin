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
 * ONLY on huddle docs. An ordinary attachment's pill stays exactly what it
 * was — a comment affordance — because a doc under review is not a place work
 * is generated from, and a work menu over a proofreading selection is the
 * wrong answer twice.
 *
 * Two verbs, two shapes. Create Task is a task create with a `doc` origin
 * (the same one the meeting assistant files its captured tasks through);
 * the created row is linked back INTO the prose at the selection, which is
 * the whole point of anchoring on the line: `task-link-chips.ts` sees a
 * same-origin `/workspaces/<ws>?task=<id>` link and decorates it with the
 * row's live status, so the doc shows what became of the line without this
 * module knowing anything about status.
 *
 * Research is NOT a task any more. It was, and Bryan pressed it on prod and
 * found a board row where the approved mock had a section in the notes
 * ("it just creates a task — does not follow the flow in the mockups",
 * 2026-09-01). Now it is `POST /research-request`: the server files an
 * anchored ask thread on the selected line, from the presser, and inserts
 * a "Research: <topic>" placeholder section right after that line for the
 * lead to fill — the mock's flow, and the same comment channel Make Plan
 * and Review ride.
 *
 * Where the two buttons sit is `pointer-pill.ts`'s problem; this module is
 * the verbs behind them.
 *
 * THE BUTTONS ARE GONE (2026-09-04, Bryan's call: "Change Research / Comment
 * / Add Task to just comment"). The pill offers one action now, and the
 * composer it opens is how a person asks for research, an edit or a task —
 * in the words they were already going to type, which the lead reads and
 * acts on. Three named buttons made the reader pick a verb before they had
 * said anything, and two of the three were an agent's errand dressed as a
 * menu item; the sentence they type says which errand it is, and says the
 * rest of it too. This is the same rule that took the kind chips off a
 * review item: an affordance the reader can act on beats a label that
 * explains one.
 *
 * The verbs below STAY, and so do their server routes — nothing about the
 * capability was withdrawn, only the buttons in front of it.
 * `SPINOFF_ACTIONS` and `runSpinoff` have no caller in the UI as of that
 * date; a later ticket decides whether they come back behind something else
 * or go. `spinoff-menu.test.ts` and `doc-spinoff.test.ts` still drive them.
 */

import { type User, readyToWork, spinoffBody, spinoffDocHref } from '@feedback/core';

/** Re-exported: the readiness rule now lives in core, shared with the meeting
 *  assistant's capture pass, which files a spoken ask by the same rule. */
export { readyToWork };

/** A text-range anchor as it goes over the wire — `anchorBody`'s output. */
export interface SpinoffAnchor {
  kind: 'text-range';
  startRel: number[];
  endRel: number[];
  snippet: { text: string };
  deletedSnippet?: string;
}

/** The two verbs. `task` puts a row on the board, `research` puts a section
 *  in the doc. `SpinoffTaskId` is what `runSpinoff` and `doc-spinoff.ts` are
 *  typed against; the pill no longer names either of them. */
export type SpinoffTaskId = 'task' | 'research';
export type SpinoffId = SpinoffTaskId;

export interface SpinoffAction {
  id: SpinoffId;
  label: string;
}

/**
 * The two verbs, still named here, no longer offered anywhere.
 *
 * There were five, then four, then two, then none. "Start now" did what
 * "Create a task" did plus `order: 0`, which nobody could tell apart in the
 * running product, so Bryan collapsed them (2026-09-01): where a row lands is
 * decided from what the row SAYS, not from which of two identical buttons was
 * pressed. Then "Answer a question" and "Leave a comment" went the same day,
 * with the menu they lived in. Then the last two went as buttons on
 * 2026-09-04 — see the header. The list survives because the verbs behind it
 * do; it is not what the pill reads its actions from any more.
 */
export const SPINOFF_ACTIONS: readonly SpinoffAction[] = [
  { id: 'research', label: 'Research' },
  { id: 'task', label: 'Create Task' },
] as const;

/**
 * What the pointer pill offers: Comment, and nothing else.
 *
 * The comment was nearly lost once already — dropping "Leave a comment" from
 * the old menu took the comment itself away with it, and a huddle doc's
 * selection became the one place a comment could not be left (owner,
 * 2026-09-01: "keep a comment option available"). It is now the whole pill.
 * It is not a spin-off: nothing is filed until the person sends it.
 *
 * Still a LIST of one rather than a bare button, because the pill is a
 * toolbar and the shape is what a second action would be added back to.
 */
export type PointerPillActionId = 'comment';
export const POINTER_PILL_ACTIONS: readonly {
  id: PointerPillActionId;
  label: string;
  primary?: boolean;
}[] = [{ id: 'comment', label: 'Comment' }];

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
   * (`doc/anchor-body.ts`'s `anchorBody`), not core's `Anchor`. The two differ
   * on purpose: core stores relative positions as `Uint8Array`, and what
   * crosses the network is the JSON array form. Nothing here posts it today;
   * it rides along so a caller can pin what was spun off from where.
   */
  anchor: SpinoffAnchor;
  /** The doc's own title, so the created row can say where it came from. */
  docTitle?: string;
  fetchJson: (url: string, init?: RequestInit) => Promise<unknown>;
}

/** What a Research press made: the ask thread, and the section it opened
 *  in the doc for the answer. No row, no link — the doc IS the receipt. */
export interface ResearchSpinoffResult {
  action: 'research';
  threadId: string;
  /** The section heading the placeholder went in under — "Research: …". */
  section: string;
  /** Whether the placeholder section actually landed; the thread files
   *  either way, so a false here is a doc to look at, not a lost ask. */
  placeholder: boolean;
}

export interface TaskSpinoffResult {
  action: 'task';
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

export type SpinoffResult = TaskSpinoffResult | ResearchSpinoffResult;

function post(deps: SpinoffDeps, url: string, body: unknown): Promise<unknown> {
  return deps.fetchJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Run one spin-off. Returns what it made, so the caller can write the link
 * over the selection (a task) or say where to look (research); `null` when
 * the server answered without an id, which the caller reports rather than
 * inventing one.
 */
export async function runSpinoff(
  action: SpinoffId,
  deps: SpinoffDeps,
): Promise<SpinoffResult | null> {
  if (action === 'research') return runResearch(deps);
  const title = deriveTaskTitle(deps.quote, TITLE_MAX);
  const res = (await post(deps, `/api/workspaces/${encodeURIComponent(deps.workspaceId)}/tasks`, {
    title,
    // The whole selection and the way back to the doc; the title above is
    // only a trimmed reading of the same words.
    body: spinoffBody(deps.quote, deps.docTitle, {
      docHref: spinoffDocHref(deps.workspaceId, deps.docId),
    }),
    author: deps.user,
    // Where it came from, the way the meeting assistant's captured tasks
    // say it — one origin kind for "a doc line became this".
    origin: { kind: 'doc', docId: deps.docId },
    // PLACE it: the board's top active goal, the lead as owner, `todo`.
    // Without this the row landed in chores owned by the tapper, and the
    // lead's dispatch never saw it (Bryan, 2026-09-01: "created in Backlog
    // and not automatically started"). The rule is the server's
    // (`TaskStore.placeSpinoff`); this only asks for it.
    spinoff: true,
    // Where the row lands, decided from what the row SAYS. A thin selection
    // makes a row nobody can pick up, and triage is where a row goes to be
    // given enough to act on — see `readyToWork`.
    ...(!readyToWork(title) ? { triage: true } : {}),
  })) as { task?: { id?: string; status?: string } };
  const taskId = res?.task?.id;
  if (taskId === undefined) return null;
  const status = typeof res.task?.status === 'string' ? res.task.status : undefined;
  return {
    action: 'task',
    taskId,
    title,
    ...(status !== undefined ? { status } : {}),
    href: taskLinkHref(deps.workspaceId, taskId),
  };
}

/**
 * Research: the ask goes to the DOC, not the board. The topic is the
 * selection read as a title (the same derivation a task gets, a little
 * shorter so "Research: " fits on a heading line); the anchor is the
 * selection itself, so the thread sits on the line that asked and the
 * placeholder section follows that line.
 */
async function runResearch(deps: SpinoffDeps): Promise<ResearchSpinoffResult | null> {
  const topic = deriveTaskTitle(deps.quote, TITLE_MAX - 10);
  const res = (await post(deps, `/api/docs/${encodeURIComponent(deps.docId)}/research-request`, {
    author: deps.user,
    topic,
    anchor: deps.anchor,
  })) as { threadId?: string; section?: string; placeholder?: boolean };
  if (typeof res?.threadId !== 'string') return null;
  return {
    action: 'research',
    threadId: res.threadId,
    section: typeof res.section === 'string' ? res.section : `Research: ${topic}`,
    placeholder: res.placeholder === true,
  };
}
