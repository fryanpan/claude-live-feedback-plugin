/**
 * Spinning work off a line of a huddle doc.
 *
 * A discussion produces lines that are not discussion: a thing to do, a thing
 * to look up, a thing only the agent knows. Today the only gesture over a
 * selection is "comment", so all four of those arrive as prose somebody has
 * to re-read later and act on by hand. This is the menu the approved mock
 * puts behind that same selection: five ways for a line to leave the doc as
 * work, anchored on the line itself so nothing has to be re-described.
 *
 * ONLY on huddle docs. An ordinary review doc's pill stays exactly what it
 * was — a comment affordance — because a doc under review is not a place work
 * is generated from, and a five-item menu over a proofreading selection is
 * four wrong answers and the one you wanted.
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
 * It is a POPOVER on a pointer and a BOTTOM SHEET at 560px — the stylesheet
 * decides, exactly as it does for the speaker menu this is modelled on. A
 * menu anchored to a word lands under a thumb and half off-screen on a phone.
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

/** Which of the five. `comment` is the old behaviour, kept as a row. */
export type SpinoffId = SpinoffTaskId | 'question' | 'comment';

/** The three that put a ROW on the board. Its own type because the caller
 *  that writes the link back into the prose only ever handles these, and
 *  saying so in the signature is cheaper than a guard it can forget. */
export type SpinoffTaskId = 'task' | 'start' | 'research';

export interface SpinoffAction {
  id: SpinoffId;
  label: string;
  /** Inline SVG path data, drawn in the nav's stroked-glyph vocabulary. */
  icon: string;
}

/**
 * The five, in the mock's order — which is also frequency order for the
 * gesture: capturing a to-do is what a discussion mostly produces, and
 * "Leave a comment" is last because it is the only one that does not make
 * something happen.
 */
export const SPINOFF_ACTIONS: readonly SpinoffAction[] = [
  { id: 'task', label: 'Create a task', icon: 'M12 5v14M5 12h14' },
  { id: 'start', label: 'Start now', icon: 'M5 3l14 9-14 9z' },
  {
    id: 'research',
    label: 'Research and come back',
    icon: 'M21 21l-4.3-4.3M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z',
  },
  {
    id: 'question',
    label: 'Answer a question',
    icon: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  },
  {
    id: 'comment',
    label: 'Leave a comment',
    icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  },
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

/** The composer's starting words when somebody taps "Answer a question" — a
 *  PREFILL the person edits or clears, never a posted sentence. The line
 *  itself rides along as the thread's anchor, so only the ask needs typing. */
export const SPINOFF_QUESTION_PREFILL = 'Can you answer this? ';

export interface SpinoffDeps {
  docId: string;
  workspaceId: string;
  /** The person spinning off. A person-authored create lands at `todo`; an
   *  agent's would land at `triage`, which is not what a tap means. */
  user: User;
  /** The selected words — the line the menu was opened on. */
  quote: string;
  /**
   * That same selection as a thread anchor, for the question path — the WIRE
   * shape (`review-chrome.ts`'s `anchorBody`), not core's `Anchor`. The two
   * differ on purpose: core stores relative positions as `Uint8Array`, and
   * what crosses the network is the JSON array form.
   */
  anchor: SpinoffAnchor;
  /** The doc's own title, so the created row can say where it came from. */
  docTitle?: string;
  fetchJson: (url: string, init?: RequestInit) => Promise<unknown>;
}

export interface SpinoffResult {
  action: SpinoffId;
  /** Present when the action created a task. */
  taskId?: string;
  /** The row's title as the board now holds it — so the toast can name what
   *  was made rather than saying "Task created" about nothing in particular,
   *  and so the person can tell whether the title came out sane. */
  title?: string;
  /** The href to write over the selection, when there is one. */
  href?: string;
  /** Present when the action opened a thread. */
  threadId?: string;
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
 * over the selection and say so.
 *
 * `comment` does nothing here on purpose — the composer is the caller's, and
 * routing it through a fetch seam would be a fiction.
 */
export async function runSpinoff(
  action: SpinoffId,
  deps: SpinoffDeps,
): Promise<SpinoffResult | null> {
  // Both open the caller's composer rather than posting anything. `question`
  // used to POST a fixed sentence — "Can you answer this? …" — the moment the
  // row was tapped, so a thread appeared under someone's name containing
  // words they had never written. One tap is not consent to be quoted. The
  // question still reaches the agent watching the doc the same way it always
  // did, over the `thread.created` a posted comment fires; the difference is
  // that a person writes it.
  if (action === 'comment' || action === 'question') return { action };

  const title =
    action === 'research'
      ? `Research: ${deriveTaskTitle(deps.quote, TITLE_MAX - 10)}`
      : deriveTaskTitle(deps.quote);
  const res = (await post(deps, `/api/workspaces/${encodeURIComponent(deps.workspaceId)}/tasks`, {
    title,
    body: spinoffBody(deps.quote, deps.docTitle),
    author: deps.user,
    // Where it came from, the way the meeting assistant's captured tasks
    // say it — one origin kind for "a doc line became this".
    origin: { kind: 'doc', docId: deps.docId },
    // "Start now" is a placement, not a status. Nothing is actually in
    // progress the instant somebody taps a line, so claiming `in-progress`
    // would put a lie on the board; what the tap means is "work this
    // next", and the top of the band is where that is said.
    ...(action === 'start' ? { order: 0 } : {}),
  })) as { task?: { id?: string } };
  const taskId = res?.task?.id;
  if (taskId === undefined) return null;
  return { action, taskId, title, href: taskLinkHref(deps.workspaceId, taskId) };
}

export interface SpinoffMenuOpts {
  /** The element the popover hangs under — the selection pill. */
  anchorEl: HTMLElement;
  onPick: (action: SpinoffId) => void;
  /** Called when the menu closes without a pick, so the caller can put focus
   *  back where the reader left it. */
  onDismiss?: () => void;
  /** Defaults to the document body, so no `overflow: hidden` in the editor's
   *  own layout can clip it. */
  root?: HTMLElement;
}

export interface SpinoffMenuHandle {
  destroy(): void;
}

/**
 * Open the menu. One at a time — the caller destroys the previous handle.
 */
export function mountSpinoffMenu(opts: SpinoffMenuOpts): SpinoffMenuHandle {
  const root = opts.root ?? document.body;
  let live = true;

  const scrim = document.createElement('div');
  scrim.className = 'spinoff-menu-scrim';
  const menu = document.createElement('div');
  menu.className = 'spinoff-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Spin this line off');

  function destroy(): void {
    if (!live) return;
    live = false;
    opts.anchorEl.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeyDown);
    menu.remove();
    scrim.remove();
  }
  function dismiss(): void {
    if (!live) return;
    destroy();
    opts.onDismiss?.();
  }
  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') dismiss();
  }

  scrim.addEventListener('click', () => dismiss());
  for (const action of SPINOFF_ACTIONS) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'spinoff-menu-item';
    row.setAttribute('role', 'menuitem');
    row.dataset.action = action.id;
    // Built rather than interpolated: the icon data is ours, but a row's
    // label reaches innerHTML nowhere in this file, and keeping the whole
    // row builder markup-free is what guarantees that stays true.
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glyph.setAttribute('viewBox', '0 0 24 24');
    glyph.setAttribute('width', '15');
    glyph.setAttribute('height', '15');
    glyph.setAttribute('fill', 'none');
    glyph.setAttribute('stroke', 'currentColor');
    glyph.setAttribute('stroke-width', '2');
    glyph.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', action.icon);
    glyph.append(path);
    const label = document.createElement('span');
    label.className = 'spinoff-menu-label';
    label.textContent = action.label;
    row.append(glyph, label);
    // `mousedown` is prevented for the same reason the pill prevents it: on
    // desktop the press blurs the editor before the click lands, and the
    // selection this whole menu is about goes with it.
    row.addEventListener('mousedown', (ev) => ev.preventDefault());
    row.addEventListener('click', () => {
      destroy();
      opts.onPick(action.id);
    });
    menu.append(row);
  }

  root.append(scrim, menu);
  opts.anchorEl.setAttribute('aria-expanded', 'true');
  place(menu, opts.anchorEl);
  document.addEventListener('keydown', onKeyDown);
  // Focus the first row so the keyboard can walk the menu it just opened.
  menu.querySelector<HTMLButtonElement>('.spinoff-menu-item')?.focus();

  return { destroy };
}

/** Under the pill, nudged left if it would run off the right edge. The bottom
 *  sheet ignores all of it — at 560px the stylesheet pins the menu to the
 *  bottom of the screen, where the thumb is. */
function place(menu: HTMLElement, anchorEl: HTMLElement): void {
  const box = anchorEl.getBoundingClientRect();
  const width = menu.offsetWidth || 240;
  const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
  menu.style.top = `${box.bottom + window.scrollY + 6}px`;
  menu.style.left = `${left + window.scrollX}px`;
}
