/**
 * The task detail panel's renderers (plan §3.9): who has the task, the fields
 * a ticket shows, its effort numbers and how they were computed, its related
 * and source document links, its body slot, and the audit rows its history
 * prints. Data in, elements out — no fetches, no Yjs — so every contract here
 * is testable under happy-dom.
 *
 * The bottom of the hub's render layer: `hub-discussion-render.ts` and
 * `hub-review-render.ts` import the shapes declared here (`TaskThread`,
 * `PanelReviewItem`), and this file imports neither of them.
 */
import { type ReviewPayload } from '@feedback/core';
import type { ReviewShape, Thread, User } from '@feedback/core';
import {
  EFFORT_MIN_SAMPLES_FOR_CALIBRATION,
  type EffortCalibration,
  type EffortRatio,
  applyEffortRatio,
  effortActualHandsOnSeconds,
  effortActualWallClockSeconds,
  effortEstimateState,
  estimateNumbers,
  formatEffortSeconds,
  ratioForGoal,
} from '@feedback/core/goal-effort';
import { blockableStatus } from '@feedback/core/task-blocked';
import { renderCommentMarkdown } from '../comment-markdown.ts';
import { cachedLinkTitle, fetchLinkInfos } from '../link-titles.ts';
import {
  GENERIC_ASSIGNEE,
  type HubDecisionOption,
  type HubGoal,
  type HubReviewItem,
  type HubTask,
  type HubTransition,
  TASK_STATUS_ORDER,
  type TaskStatus,
  ownerKindSuffix,
  ownerMarkKind,
  statusLabel,
  statusOptions,
} from './hub-board-model.ts';
import { type ActivityEvent, assigneeLabel, describeEvent } from './hub-presence-model.ts';
import { type BlockerRow, type ReviewThreadItem } from './hub-review-model.ts';
import type { TaskAskKind, TaskAskState } from './task-asks.ts';
/**
 * Who has this task, as a picker over everyone it could go to.
 *
 * This was a two-word toggle: one tap flipped the owner between 'human' and
 * the bare word 'agent'. With more than one agent in a workspace that word
 * cannot say who is doing the work — `next_tasks?assignee=<me>` matches
 * nothing, and the board answers "who has this" with a category — so the
 * toggle's only two destinations were a person and nobody.
 *
 * The options are the workspace's live attachments plus 'human', plus the
 * current owner whoever they are: attachments describe who is here NOW, and
 * dropping a detached owner from the list would silently rename their work on
 * the next render. A native <select> buys the mobile picker and keyboard
 * support for free — the same reasoning as the status chip.
 */
function assigneePicker(
  className: string,
  task: HubTask,
  knownAgentIds: string[] | undefined,
  onPick: (assignee: string) => void,
): HTMLSelectElement {
  const owner = task.assignee.trim().toLowerCase() === GENERIC_ASSIGNEE ? '' : task.assignee.trim();
  const kind = ownerMarkKind(task, owner);
  const sel = document.createElement('select');
  sel.className = `${className} hub-owner-${kind}`;
  if (owner === '') {
    // Only ever offered while nobody owns it: an unowned task needs a landing
    // place in the list, but "hand this back to nobody" is not a move.
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Unassigned';
    sel.append(none);
  }
  const agents = [
    ...new Set([...(knownAgentIds ?? []), ...(owner && owner !== 'human' ? [owner] : [])]),
  ]
    .filter((id) => id.trim().toLowerCase() !== GENERIC_ASSIGNEE)
    .sort((a, b) => a.localeCompare(b));
  for (const id of ['human', ...agents]) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = assigneeLabel(id);
    sel.append(opt);
  }
  // After the options are in the tree — a detached option's selected flag
  // does not survive being appended.
  sel.value = owner;
  const reads = owner === '' ? 'nobody' : `${assigneeLabel(owner)}${ownerKindSuffix(kind)}`;
  sel.title = `Assignee: ${reads} — pick who takes this`;
  sel.setAttribute('aria-label', `Assignee: ${reads} — pick who takes this`);
  sel.addEventListener('click', (ev) => ev.stopPropagation());
  sel.addEventListener('change', (ev) => {
    ev.stopPropagation();
    const to = sel.value;
    if (to && to !== owner) onPick(to);
  });
  return sel;
}

/** The shared class every title-hydrated doc anchor carries — the Activity
 *  tab's doc-kind chips and the Related Links section both hydrate through
 *  the one re-query in `hydrateDocTitles`, so either can kick off the fetch
 *  and both catch the answer regardless of which is mounted when it lands. */
const DOC_TITLE_LINK_CLASS = 'hub-doc-title-link';

/** The canonical href for a doc: workspace-scoped when a workspaceId is
 *  known (what every fresh link should be), the legacy `/review/<id>` shape
 *  otherwise — the same fallback the old Source-doc field used. */
function docLinkHref(docId: string, workspaceId?: string): string {
  return workspaceId !== undefined
    ? `/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}`
    : `/review/${encodeURIComponent(docId)}`;
}

/** The canonical href for a task: the board's own deep link. Without a
 *  workspace id there is no address to build — the board is workspace-scoped
 *  — so the anchor points at the query alone, which the board reads on the
 *  page it is already on. */
function taskLinkHref(taskId: string, workspaceId?: string): string {
  const q = `?task=${encodeURIComponent(taskId)}`;
  return workspaceId !== undefined ? `/workspaces/${encodeURIComponent(workspaceId)}${q}` : q;
}

/** Applies the shared link-title cache to one title-hydrated anchor.
 *  `null` (not `undefined`) means the server WAS asked and came back with
 *  nothing — a genuinely untitled doc, not a lookup still in flight — so it
 *  renders "Untitled doc". `undefined` (not yet asked) leaves the "Loading…"
 *  placeholder alone so a later hydration pass can still land. The raw doc
 *  id is never a value this settles on: the AC is title-only links, a
 *  reviewer should never see one in this slot. */
function applyDocTitle(a: HTMLAnchorElement): void {
  const title = cachedLinkTitle(a.getAttribute('href') ?? '');
  if (typeof title === 'string' && title !== '') a.textContent = title;
  else if (title === null) a.textContent = 'Untitled doc';
}

/** Kicks off one title fetch for whichever `DOC_TITLE_LINK_CLASS` anchors
 *  are still on the "Loading…" placeholder, and reapplies titles to
 *  whatever is CURRENTLY mounted when it resolves. Never gated on any one
 *  render's own DOM surviving: `useFill`'s no-deps effect can rebuild
 *  either section on every parent re-render, tearing down the anchor that
 *  issued the fetch well before it settles — re-querying the live document
 *  is what closes that race. */
function hydrateDocTitles(anchors: readonly HTMLAnchorElement[]): void {
  const unresolved = anchors.filter((a) => a.textContent === 'Loading…');
  if (unresolved.length === 0) return;
  void fetchLinkInfos(unresolved.map((a) => a.getAttribute('href') ?? ''))
    .then(() => {
      for (const a of document.querySelectorAll<HTMLAnchorElement>(`.${DOC_TITLE_LINK_CLASS}`))
        applyDocTitle(a);
    })
    .catch(() => {
      // The ids stay — true, just less familiar.
    });
}

/**
 * The task's `links`, as chips. Until this existed, a ref was stored, keyed
 * and backlinked and then never drawn — the store had it and no surface
 * could show it, which is the failure mode this codebase has already been
 * bitten by once with resolved threads.
 *
 * `url` refs become external anchors, and `doc` refs become title-hydrated
 * internal anchors — the same title-only treatment Related Links gets, so a
 * reviewer never sees a raw doc id here either. The remaining internal kinds
 * (thread / task / diff) are ids with no titled destination this panel can
 * resolve, so they stay labelled chips; a ref of an unknown kind is skipped
 * rather than thrown on — an older client must survive a newer server
 * adding a kind, and a task that fails to open is worse than a missing chip.
 */
export function renderTaskLinks(task: HubTask, workspaceId?: string): HTMLElement | null {
  const refs = Array.isArray(task.links) ? task.links : [];
  if (refs.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.className = 'hub-detail-links';
  const docAnchors: HTMLAnchorElement[] = [];
  for (const raw of refs) {
    if (typeof raw !== 'object' || raw === null) continue;
    const ref = raw as Record<string, unknown>;
    if (ref.kind === 'url' && typeof ref.url === 'string') {
      // The server refuses any scheme but http(s) on the way in. Re-checking
      // here anyway: this element is built from whatever the doc currently
      // holds, and a ref persisted before that check existed would otherwise
      // become a live `javascript:` href on click.
      let safe = false;
      try {
        const u = new URL(ref.url);
        safe = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        safe = false;
      }
      if (!safe) continue;
      const a = document.createElement('a');
      a.className = 'hub-link-chip';
      a.href = ref.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // The host is what identifies a link at a glance; the full URL is the
      // tooltip so a chip never grows to the width of a query string.
      a.textContent = new URL(ref.url).host;
      a.title = ref.url;
      a.addEventListener('click', (ev) => ev.stopPropagation());
      wrap.append(a);
      continue;
    }
    const kind = typeof ref.kind === 'string' ? ref.kind : null;
    if (kind === null) continue;
    if (kind === 'doc' && typeof ref.docId === 'string' && ref.docId !== '') {
      const a = document.createElement('a');
      a.className = `hub-link-chip ${DOC_TITLE_LINK_CLASS}`;
      a.href = docLinkHref(ref.docId, workspaceId);
      a.textContent = 'Loading…';
      a.addEventListener('click', (ev) => ev.stopPropagation());
      applyDocTitle(a);
      wrap.append(a);
      docAnchors.push(a);
      continue;
    }
    const id = ref.docId ?? ref.taskId ?? ref.workspaceId;
    const chip = document.createElement('span');
    chip.className = 'hub-link-chip hub-link-internal';
    chip.textContent = typeof id === 'string' ? `${kind}: ${id}` : kind;
    wrap.append(chip);
  }
  hydrateDocTitles(docAnchors);
  return wrap.childElementCount > 0 ? wrap : null;
}

// ── Task detail (opens instantly, no transition — §3.9) ────────────────────

export interface DetailHandlers {
  onClose: () => void;
  onStatusSet: (task: HubTask, to: TaskStatus) => void;
  onTitleCommit: (task: HubTask, title: string) => void;
  /**
   * `optionId` is set only when the answer came from tapping a candidate;
   * `text` is the verbatim answer either way.
   *
   * Resolving to `false` means the write was REFUSED, and the card puts the
   * reader's words back in the box. Anything else — including a handler that
   * returns nothing — is taken as landed, so a caller that does not report
   * does not thereby claim a failure.
   */
  onAnswer: (task: HubTask, text: string, optionId?: string) => Promise<boolean> | undefined;
  /**
   * Answer an item that came from a THREAD rather than from the task's own
   * decision: a reply on that thread, so the agent watching it hears the
   * answer, and — on a declared item — recorded against the declaring comment
   * so the queue drops it.
   *
   * Separate from `onComment` deliberately. Routing this through the plain
   * comment handler is what the panel did before, and it lost the picked
   * option (the comment route has nowhere to put one) and left the queue
   * showing an item that had just been answered.
   */
  onAnswerThread?: (
    task: HubTask,
    item: PanelReviewItem,
    text: string,
    optionId?: string,
  ) => Promise<boolean>;
  /**
   * "I have a question" on a ticket-borne card: the question goes to the
   * item's owner as a thread on this task's doc (`panelQuestionRequest`),
   * and the item leaves the reader's queue until the owner revises it.
   * Resolves to whether the question LANDED — anything else keeps the words
   * in the box. Absent on a surface that cannot ask (the link is not drawn).
   */
  onAskOnPanelItem?: (task: HubTask, item: PanelReviewItem, question: string) => Promise<boolean>;
  /** Take back this task's recorded answer. Without it the answered banner
   *  renders with no way out, which is the state this handler exists to end. */
  onUndoAnswer?: (task: HubTask) => Promise<boolean> | undefined;
  /**
   * Overrule the quality gate on one HELD review item, putting it on the
   * reader's queue without waiting for its filer to reword it.
   *
   * The gate is a judge, and a judge can be wrong about one item. Without
   * this the held note had no interactive element at all: a reader looking at
   * a question they could have answered in ten seconds could do nothing but
   * wait for an agent (UX review, 2026-08-29).
   */
  onReleaseHeld?: (task: HubTask, item: HubReviewItem) => Promise<boolean> | undefined;
  /**
   * Take back an answer recorded on a THREAD-borne item — the persistent Undo
   * on the in-place answered record. Goes through
   * `POST /api/docs/:docId/threads/:threadId/answer/undo` with the declaring
   * comment's id, which moves the stamps into `answerHistory` and re-offers
   * the item on every queue's next read.
   */
  onUndoThreadAnswer?: (task: HubTask, item: PanelReviewItem) => Promise<boolean> | undefined;
  /**
   * The reader's own display name, so the record can say "Answered by you"
   * for their answer and the name for anyone else's. Optional — without it
   * every record names the answerer, which is true, just less familiar.
   */
  selfName?: string;
  /** The board's own workspace id, so the Source-doc field can link the
   *  origin doc at its canonical workspace address. Without it the field
   *  still renders, linking the legacy `/review/` shape instead. */
  workspaceId?: string;
  onAssign: (task: HubTask, assignee: string) => void;
  /** The agents currently attached to this workspace — see `BoardHandlers`. */
  knownAgentIds?: string[];
  /** Names the goal the way the board's own section header does — pass
   *  `hub-board-model`'s `goalLabel`, which resolves Backlog too. The panel
   *  is where a reader goes to find out what a task is FOR, so an id is a
   *  fact about the store rather than an answer. Optional, and without it the
   *  row falls back to the id — a missing lookup must not blank it. */
  goalLabel?: (goalId: string) => string;
  /** The board's own goal sections, so the Goal field can offer them. Without
   *  it the field still renders — showing this task's goal and nothing else —
   *  rather than disappearing, because a field that vanishes when a lookup is
   *  missing reads as a bug in the task. */
  goals?: HubGoal[];
  /** Move the task to another goal. */
  onGoalSet?: (task: HubTask, goalId: string) => void;
  /** Set the due date, or clear it with `null`. */
  onDueSet?: (task: HubTask, dueAt: number | null) => void;
  /**
   * Take the task off the board, reversibly. THE PANEL IS THE ONLY PLACE THIS
   * LIVES (Bryan, on the design thread: *"Detail panel only… It's a secondary
   * action. Should not take up space from primary flows."*) — an earlier mock
   * put a `⋯` menu and a swipe on the row itself and he rejected both, so the
   * board row is deliberately untouched by this feature.
   *
   * Also `e` from the keyboard, which is the same act reached without opening
   * anything; see `hub-shortcuts`.
   */
  onArchive?: (task: HubTask) => void;
  /** Put an archived task back — the panel's other face, drawn in place of
   *  Archive when the open task is already archived. */
  onRestore?: (task: HubTask) => void;
  /** A comment on the task. With `threadId` it is a reply; without one it
   *  opens a new thread about the task itself. */
  onComment?: (task: HubTask, text: string, threadId?: string) => Promise<boolean>;
  /**
   * A comment on a PHRASE of the Activity feed — a note's words, or a move's
   * or audit row's — the way the Home pane takes one: a subject thread on
   * the task's doc whose first comment quotes the phrase
   * (`activityCommentRequest`). Resolves to the thread the server made, or
   * null when refused — the words then stay in the box. Without it the feed
   * still renders and the pill never appears.
   */
  onActivityComment?: (
    task: HubTask,
    phrase: { text: string },
    text: string,
  ) => Promise<Thread | null>;
  /** A further reply on the thread the feed's card is showing. Resolves to
   *  the thread as the server now has it, or null when refused. */
  onActivityReply?: (task: HubTask, threadId: string, text: string) => Promise<Thread | null>;
  /** Who the feed's thread card speaks as. Without it the card addresses
   *  "you" — a surface mounted before identity resolves — and posts nothing
   *  under a name; the handlers above carry the author. */
  user?: User;
  /** The one thread the reader was sent here to answer, when they arrived
   *  from the review queue. Marked and scrolled to — "open the task" is not
   *  the promise the strip makes on a task with six discussions. */
  focusThreadId?: string;
  /** Open with the title already in rename — an EMPTY input, focused — so the
   *  first thing typed is the name. The Board's "New task" sets this for the
   *  row it just filed and for nothing else; it is an open-time act, and a
   *  repaint of the same task does not repeat it. */
  focusTitle?: boolean;
  /**
   * This task's rows from the SERVER's review queue
   * (`GET /api/workspaces/:id/review-items`) — the same computation the strip
   * reads, handed down rather than re-derived.
   *
   * Re-deriving "is this run waiting on a person" in the browser would be a
   * second copy of a matcher that already exists, and this repo has paid once
   * for two copies of that one heuristic drifting apart (the extractor lost
   * the newline branch and clipped away the very question the feature was
   * built to surface). One source, two readers.
   */
  asks?: ReviewThreadItem[];
  /**
   * Put a link to this task on the clipboard — a URL that names the workspace
   * the task lives in, which is what makes it forwardable ("a way to share a
   * link to the task with a URL that clearly indicates it's in this
   * workspace", Bryan 2026-08-18).
   *
   * The renderer does not build the URL, because only the app knows which
   * workspace this board is. No handler, no button: an affordance that copies
   * nothing is worse than its absence.
   */
  onCopyLink?: (task: HubTask) => void;
  /**
   * Set when the open task is a human-owned open task other work waits on —
   * the row `humanBlockerRows` derives for it, handed down by the app. The
   * panel renders it as the amber blocked note under the key fields: a
   * blocker is task STATE (design point 5), so this is the one surface that
   * says it, and the board row and the Home queue deliberately do not.
   */
  blocked?: BlockerRow;
  /**
   * The tickets this task is WAITING on — its open `after` edges, resolved to
   * titles by the app, which is the only layer that holds the board's rows.
   * They render as Related Links entries wearing the barred ring, because a
   * blocker is a link to another ticket and giving it a section of its own
   * would say the same thing twice.
   *
   * The opposite direction of `blocked`, which names work waiting on THIS
   * task.
   */
  blockers?: readonly RelatedBlocker[];
  /**
   * Add whatever this URL names to Related Links. A ticket on this workspace
   * becomes an `after` edge — that is how a blocker is set, since Blocked is
   * derived from those edges and no status control offers it — a doc becomes
   * a doc link, and anything else is kept as the plain address it is.
   *
   * The app decides which of those writes it is: the panel knows only that a
   * reader typed a URL. Absent → no add control is drawn.
   */
  onRelatedAdd?: (task: HubTask, url: string) => void;
  /** Take one entry back off: the `after` edge for a blocker, the ref for a
   *  doc or a plain URL. Absent → no x is drawn. */
  onRelatedRemove?: (task: HubTask, entry: RelatedEntry) => void;
  /**
   * Ask the board's agent to plan this ticket, or to review it — the two
   * one-tap asks a huddle doc carries as floats. Resolves to whether the ask
   * LANDED, so a refused press puts the control back rather than leaving a
   * receipt for an ask nobody received.
   *
   * Absent → neither ask is OFFERED, which is the honest state for a reader
   * who cannot write and for a board served by a server that predates the
   * ask routes. A receipt below still renders: whether somebody has asked is
   * ticket state, and hiding it would show a reader an untouched ticket.
   */
  onAsk?: (task: HubTask, kind: TaskAskKind) => Promise<boolean>;
  /**
   * What the ticket's own doc says about the two asks — who asked and when,
   * per kind. Undefined until the app has read the doc, which the controls
   * deliberately render as "not yet asked": see `TaskAskState`.
   */
  taskAsks?: TaskAskState;
  /** Clock for the "asked 3h ago" lines. Injected so a test can pin it. */
  now?: number;
  /**
   * The workspace's audit rows, unfiltered — the panel takes this task's out
   * of them (`taskActivity`) and renders them in the Activity tab beside the
   * stored transitions.
   *
   * Handed down rather than fetched per task: they are the same rows the
   * workspace Activity view reads, and a per-task endpoint would be a second
   * projection of one log.
   */
  activity?: ActivityEvent[];
  /**
   * Where the live description editor should be mounted, handed over the
   * moment the panel has decided on it — a rebuilt element when the panel
   * opened on another task, the SAME element when a repaint kept a live editor
   * in place, and `null` when the panel closed.
   *
   * The app used to read this off the DOM immediately after calling the
   * renderer, which worked only because the renderer painted synchronously.
   * The island writes a signal instead, so nothing outside it can know when
   * the slot exists; the panel therefore reports its own.
   */
  onBodySlot?: (task: HubTask | null, slot: HTMLElement | null) => void;
}

export interface TaskComment {
  /**
   * The comment's own id, as the thread API names it. Optional because a
   * payload from a server older than the field still renders — but without it
   * an answered declaration has nothing for `/answer/undo` to name, so the
   * record renders with no Undo rather than one that 400s.
   */
  id?: string;
  author: string;
  text: string;
  ts: number;
  /**
   * The Review Item this comment declared, when it declared one.
   *
   * Carried at COMMENT grain because that is where it is written — a thread
   * that starts as a status note becomes a review item at the comment that
   * declares, and the `Needs your reply` badge above is at thread grain
   * precisely because the server publishes nothing finer for the inferred
   * band. This one is finer because it is authored, not inferred.
   */
  review?: ReviewPayload;
}

/**
 * A thread as the DISCUSSION model carries it: its identity and its words,
 * nothing else. Status and anchor text live in storage exactly as
 * `create_thread` wrote them (34 of 37 on the live board carry a text anchor,
 * and `resolve_thread` still means "this point is handled") — but the panel
 * renders every comment as a peer of every other, so carrying open/resolved
 * or the anchored passage here was presentation residue feeding no render.
 * The id is load-bearing: it is how a reply reaches the agent watching that
 * conversation.
 */
export interface TaskThread {
  id: string;
  comments: TaskComment[];
}

/**
 * The task's discussion, as fetched. `loading` is the FETCH's own state, not
 * an inference from empty threads — an empty task and a task whose threads
 * have not arrived look identical otherwise, and guessing between them means
 * promising a comment that never appears.
 */
export interface TaskDiscussion {
  loading: boolean;
  threads: TaskThread[];
}

/** One audit row in a ticket's history, in the same sentence the workspace
 *  Activity view would read it in — one `describeEvent`, two surfaces. */
export function activityRow(ev: ActivityEvent, title: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'hub-detail-activity-row';
  li.title = new Date(ev.ts).toLocaleString();
  const what = document.createElement('span');
  what.textContent = describeEvent(ev, () => title);
  li.append(what);
  return li;
}

export function renderTransitionRow(t: HubTransition): HTMLLIElement {
  const li = document.createElement('li');
  li.title = new Date(t.ts).toLocaleString();
  const head = document.createElement('span');
  const bits = [`${t.by.name} · ${t.from} → ${t.to}`];
  if (t.note) bits.push(t.note);
  head.textContent = bits.join(' — ');
  li.append(head);
  return li;
}

/**
 * The description's place in the panel, and what it holds before (or without)
 * the live editor.
 *
 * `hub-app.ts` mounts the real Tiptap editor over the task's body room INTO
 * this element, so what the reader types merges with what an agent writes
 * through `set_doc_content` / `find_and_replace` on the same room. Until that
 * mount lands — and if it never does — the slot shows the projection's text,
 * which is the whole description for anything under the projection cap and an
 * honest note when it is not.
 */
/**
 * The row a description belongs to, whatever kind of row that is.
 *
 * A task and a goal reach this with the same three fields and the same body
 * room (`task:<id>` for both — the approved design's naming decision), so the
 * slot is built once rather than twice. `dataset.taskId` keeps its name on
 * both: it is the key `TaskBodyEditorHost.sync` matches on, and renaming it to
 * something kind-neutral would be a rename across two files to say nothing
 * new.
 */
export interface BodyRow {
  id: string;
  body?: string;
  bodyTruncated?: boolean;
}

export function bodySlot(row: BodyRow): HTMLElement {
  const slot = document.createElement('div');
  slot.className = 'hub-detail-body-slot';
  slot.dataset.taskId = row.id;
  // `renderCommentMarkdown` escapes first and only adds known-safe tags, so a
  // body written by anyone with write access is inert markup either way.
  const desc = document.createElement('div');
  if (row.body?.trim()) {
    desc.className = 'hub-detail-body';
    desc.innerHTML = renderCommentMarkdown(row.body);
  } else {
    desc.className = 'hub-detail-body-empty';
    desc.textContent = 'No description yet.';
  }
  slot.append(desc);
  if (row.bodyTruncated) {
    // Only the pre-mount fallback can be short: the projection caps a body,
    // the room does not, and the editor reads the room.
    const more = document.createElement('p');
    more.className = 'hub-detail-body-more';
    more.textContent = 'Shortened here — the full description is in the task doc.';
    slot.append(more);
  }
  return slot;
}

/**
 * The slot already on screen for THIS task, if the panel is being repainted
 * rather than opened.
 *
 * The board repaints the panel on every ydoc change — a peer's status flip, a
 * comment landing, and the reader's OWN typing (the body snapshot lands in the
 * projection ~300ms after a pause). A repaint that rebuilt the description
 * would tear down the editor under the reader's hands: even moving the node
 * (`replaceChildren` with the same element) removes it from the document
 * first, which blurs it and drops the caret. So the slot is the one node the
 * repaint never touches — everything around it is rebuilt and patched in
 * place, before and after.
 *
 * Only a LIVE slot is kept (`BODY_LIVE_CLASS`, set by the mount). Until the
 * editor is up the slot holds the projection's text, and that must follow the
 * projection like everything else in the panel — an un-mounted slot that was
 * kept would show a description the store no longer has.
 */
export const BODY_LIVE_CLASS = 'hub-detail-body-live';
/**
 * The four facts a reader checks before doing anything else, in one row under
 * the title: status, who has it, when it is due, what it serves.
 *
 * Asana and Linear both put these immediately under the title and everything
 * else below the description, and the reason is the complaint this answers:
 * *"information is disorganized and doesn't let me take the most important
 * actions"*. The old panel had them scattered through a nine-row definition
 * list BELOW the description, mixed in with `After` and the verbatim goal text
 * this task was triaged against — reference material that is identical across
 * most of the board.
 *
 * ALL FOUR are controls. Bryan, 2026-08-18: *"All fields must be human
 * editable. But I expect they'll be mostly set by agents going forward. Trust
 * but verify… sometimes having me edit a thing is the fastest way to fix."*
 * Due and Goal were plain text until that — Due because `dueAt` had no route
 * after creation (this branch adds `POST /api/tasks/:id/due`), Goal because
 * nothing had asked for it. A row where two cells are editable and two are
 * prose also reads as broken rather than as read-only, which is the shape the
 * complaint above describes.
 *
 * Every one of them is a native `<select>` or `<input>`, for the reason the
 * assignee picker already gives: the phone's own picker, keyboard support and
 * the focus ring come free, and four controls that look and behave alike are
 * what makes the row scan as one row.
 *
 * Status is a single value with a dropdown to change it, NOT a row of chips.
 * Bryan, 2026-08-18: *"Status should only show current status with a dropdown
 * to change the status."* The chips also had a defect that made the point —
 * the current one rendered as a disabled, unbordered word while its siblings
 * were pills, so the state you were IN read as a stray label rather than as
 * the selected one.
 */
/** One doc a row's Related Links section names. `held` marks the ORIGIN doc
 *  of a plan-held draft — the one row this note can ever attach to. */
export interface RelatedDocLink {
  docId: string;
  held?: boolean;
  /** This entry is the row's ORIGIN — the doc or thread the task was promoted
   *  out of — rather than a tie in `links`. It carries no x: origin is where
   *  the row came from, a fact about its history, and `DELETE /links` has
   *  nothing to take off (it answers 200 changed:false and the entry stays,
   *  which is the silent no-op this flag exists to prevent). */
  origin?: boolean;
}

/** One ticket this row is waiting on: an open `after` edge, resolved against
 *  the board so the entry can read as a title rather than an id. */
export interface RelatedBlocker {
  taskId: string;
  title: string;
}

/** What an x was pressed on. The caller decides what removing it means — an
 *  `after` edge for a blocker, a ref for the other two — because only the app
 *  knows which write that is. */
export type RelatedEntry =
  | { kind: 'blocker'; taskId: string }
  | { kind: 'doc'; docId: string }
  | { kind: 'url'; url: string };

export interface RelatedLinksOptions {
  /** The tickets this row waits on, listed FIRST and each wearing the barred
   *  ring the board draws on the blocked row. Nothing is written to say they
   *  are blockers: the ring is what says it, in the same place it says it on
   *  the board (owner's rule — affordances, not captions). */
  blockers?: readonly RelatedBlocker[];
  /** Plain `url` refs, shown as the link itself. A pasted address that is not
   *  a doc or a ticket on this workspace has no title to resolve to, and
   *  inventing one would be a lie about what the reader will land on. */
  urls?: readonly string[];
  /** Remove one entry. Absent → no x is drawn at all, which is the goal
   *  panel's case and every read-only surface's. */
  onRemove?: (entry: RelatedEntry) => void;
  /** Render the section even when it holds nothing, so an add control below
   *  it has a heading to sit under. */
  keepEmpty?: boolean;
}

/** The plain-URL refs a row carries, in stored order. Deduped by URL: the
 *  same address linked twice is one entry, and the x would otherwise remove
 *  both at once while only one row disappeared. */
export function relatedUrlLinks(row: { links?: unknown[] }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of row.links ?? []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const ref = raw as Record<string, unknown>;
    if (ref.kind !== 'url') continue;
    if (typeof ref.url !== 'string' || ref.url === '' || seen.has(ref.url)) continue;
    seen.add(ref.url);
    out.push(ref.url);
  }
  return out;
}

/**
 * Every doc a task or goal ties to, in Related-Links order: the origin doc
 * first (a thread origin counts — the thread lives on a doc, and that doc is
 * where the reader should land), then every doc-kind ref in `links`. Deduped
 * by doc id — the backfill already avoids double-tying the same doc via
 * origin AND links, but an older row or a hand-written link can still repeat
 * one, and this is the one place that reads both arrays at once.
 *
 * Only doc-kind refs: after the 2026-08-31 linkage rework `links` holds
 * doc ties exclusively (`refs-backfill.ts`), and a `url`/`diff` ref is
 * rendered elsewhere as a chip rather than here as a title.
 */
export function relatedDocLinks(row: {
  links?: unknown[];
  origin?: unknown;
  planHold?: { docId: string };
}): RelatedDocLink[] {
  const out: RelatedDocLink[] = [];
  const seen = new Set<string>();
  const origin = row.origin;
  if (typeof origin === 'object' && origin !== null) {
    const ref = origin as Record<string, unknown>;
    if (
      (ref.kind === 'doc' || ref.kind === 'thread') &&
      typeof ref.docId === 'string' &&
      ref.docId !== ''
    ) {
      seen.add(ref.docId);
      out.push({ docId: ref.docId, held: row.planHold?.docId === ref.docId, origin: true });
    }
  }
  for (const raw of row.links ?? []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const ref = raw as Record<string, unknown>;
    if (ref.kind !== 'doc') continue;
    if (typeof ref.docId !== 'string' || ref.docId === '' || seen.has(ref.docId)) continue;
    seen.add(ref.docId);
    out.push({ docId: ref.docId });
  }
  return out;
}

/**
 * The "Related Links" section: title-only links to every doc a row ties to,
 * below the fields row on both the task and the goal panel. No source chips,
 * no staleness mark — Bryan rejected both on the revised mock ("omit
 * needless details"). `null` when the row names no doc, so the section is
 * absent entirely rather than an empty heading.
 *
 * Each link's visible text starts as the doc id and swaps to its title when
 * the shared link-title cache answers — the same display-only hydration
 * every pasted workspace link gets, batched into one lookup rather than one
 * per link.
 */
export function renderRelatedLinks(
  links: readonly RelatedDocLink[],
  workspaceId?: string,
  opts: RelatedLinksOptions = {},
): HTMLElement | null {
  const blockers = opts.blockers ?? [];
  const urls = opts.urls ?? [];
  if (links.length + blockers.length + urls.length === 0 && opts.keepEmpty !== true) return null;
  const wrap = document.createElement('div');
  wrap.className = 'hub-related-links';
  const heading = document.createElement('p');
  heading.className = 'hub-related-links-k';
  heading.textContent = 'Related Links';
  const list = document.createElement('ul');
  list.className = 'hub-related-links-list';
  const anchors: HTMLAnchorElement[] = [];

  /** The x. One per entry, and only when the caller can act on it. */
  const remove = (li: HTMLElement, entry: RelatedEntry, reads: string): void => {
    if (!opts.onRemove) return;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'hub-related-link-x';
    x.setAttribute('aria-label', reads);
    x.title = reads;
    x.textContent = '×';
    x.addEventListener('click', (ev) => {
      ev.stopPropagation();
      opts.onRemove?.(entry);
    });
    li.append(x);
  };

  // Blockers first: what this ticket is WAITING for outranks what it merely
  // refers to, and a reader scanning the section wants the held-open ring in
  // one run rather than scattered through the doc links.
  for (const blocker of blockers) {
    const li = document.createElement('li');
    li.className = 'hub-related-blocker';
    const mark = document.createElement('span');
    mark.className = 'hub-status-mark hub-status-mark-blocked hub-related-mark';
    mark.setAttribute('aria-hidden', 'true');
    const a = document.createElement('a');
    a.className = 'hub-related-link';
    a.href = taskLinkHref(blocker.taskId, workspaceId);
    a.textContent = blocker.title;
    a.addEventListener('click', (ev) => ev.stopPropagation());
    li.append(mark, a);
    remove(li, { kind: 'blocker', taskId: blocker.taskId }, `Stop waiting on “${blocker.title}”`);
    list.append(li);
  }

  for (const link of links) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = `hub-related-link ${DOC_TITLE_LINK_CLASS}`;
    a.href = docLinkHref(link.docId, workspaceId);
    a.textContent = 'Loading…';
    a.addEventListener('click', (ev) => ev.stopPropagation());
    applyDocTitle(a);
    li.append(a);
    if (link.held) {
      const held = document.createElement('span');
      held.className = 'hub-related-link-held';
      held.textContent = 'Draft — held until the plan is approved';
      li.append(held);
    }
    // No x on the origin — see `RelatedDocLink.origin`.
    if (!link.origin) remove(li, { kind: 'doc', docId: link.docId }, 'Remove this link');
    list.append(li);
    anchors.push(a);
  }

  // A pasted address that is not ours: the link itself, exactly as it was
  // typed. There is no title to hydrate to and no ring to draw.
  for (const url of urls) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'hub-related-link hub-related-link-plain';
    a.href = url;
    a.rel = 'noreferrer';
    a.target = '_blank';
    a.textContent = url;
    a.addEventListener('click', (ev) => ev.stopPropagation());
    li.append(a);
    remove(li, { kind: 'url', url }, 'Remove this link');
    list.append(li);
  }

  wrap.append(heading, list);
  hydrateDocTitles(anchors);
  return wrap;
}

export function detailFields(
  task: HubTask,
  handlers: DetailHandlers,
  /** The board's learned correction, so the panel can show what the raw
   *  estimate becomes and what it was scaled by. Absent on a panel opened
   *  without a board behind it, and the effort cell then shows the raw
   *  numbers alone rather than inventing a factor of 1. */
  calibration?: EffortCalibration,
  /** The band the ticket renders under — see `effortCellText`. */
  calibrationGoal?: string,
): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = 'hub-detail-fields';
  // Each field is a `<div>` WRAPPING its `dt` + `dd`, which HTML has allowed
  // inside a `<dl>` since 5.2 and which the grid needs: bare `dt`/`dd` children
  // are two independent grid items, so `auto-fit` puts the label in one column
  // and its value in the NEXT one. Measured in a browser at 1512px before the
  // wrapper existed — "STATUS" sat in column one with the chips in column two
  // and "ASSIGNEE" in column three, which is exactly the jumble this row is
  // meant to end.
  const cell = (key: string, value: Node | string, opts?: { full?: boolean }): void => {
    const wrap = document.createElement('div');
    wrap.className = opts?.full ? 'hub-detail-field hub-detail-field--full' : 'hub-detail-field';
    const dt = document.createElement('dt');
    dt.className = 'hub-detail-field-k';
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.className = 'hub-detail-field-v';
    if (typeof value === 'string') dd.textContent = value;
    else dd.append(value);
    wrap.append(dt, dd);
    dl.append(wrap);
  };

  // The same round mark the board rows use, beside the same dropdown they
  // use. Asked for by name — *"show ONLY the current status, with the status
  // icon used in the summary view, and a dropdown to change it"* — and the
  // shared class is the point: a second glyph vocabulary would mean the board
  // and the panel could disagree about what "in progress" looks like.
  const statusCtl = document.createElement('span');
  statusCtl.className = 'hub-detail-statusctl';
  const mark = document.createElement('span');
  // Blocked wears the board's barred ring here too, and for the same reason
  // the shared class exists: the panel and the row must not disagree about
  // what a state looks like. It is drawn from the SAME derivation the ring on
  // the row comes from — an open `after` edge — and the picker beside it still
  // reads "To do", because blocked is not a status and the way out of it is
  // closing the ticket this one waits on.
  const blocked = blockableStatus(task.status) && (handlers.blockers?.length ?? 0) > 0;
  mark.className = `hub-status-mark hub-status-mark-${blocked ? 'blocked' : task.status}`;
  mark.setAttribute('aria-hidden', 'true');
  const status = document.createElement('select');
  // Deliberately NOT `hub-status-select` / `hub-chip-<status>`. Those two are
  // the BOARD row's vocabulary — the first strips the native caret because the
  // select there is a transparent hit area over the mark, the second tints the
  // text and the border. Here the mark next door already carries the colour,
  // and the panel's four fields are meant to look like four ordinary controls,
  // so borrowing them would fight `.hub-detail-select` for every property and
  // leave a dropdown with no caret.
  status.className = 'hub-detail-select hub-detail-status';
  for (const s of statusOptions(task.status, TASK_STATUS_ORDER)) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = statusLabel(s);
    status.append(opt);
  }
  status.value = task.status;
  status.setAttribute('aria-label', `Status: ${statusLabel(task.status)} — pick a new status`);
  status.addEventListener('change', () => {
    const to = status.value as TaskStatus;
    if (to !== task.status) handlers.onStatusSet(task, to);
  });
  statusCtl.append(mark, status);
  cell('Status', statusCtl);

  cell(
    'Assignee',
    assigneePicker('hub-detail-select hub-assignee-btn', task, handlers.knownAgentIds, (to) =>
      handlers.onAssign(task, to),
    ),
  );

  // A native date input, whose value is a LOCAL calendar day. Both conversions
  // go through the local timezone deliberately: `toISOString` here would show
  // yesterday's date to anyone west of UTC for an evening deadline, and
  // `new Date('2026-08-18')` on the way back parses as UTC midnight, which is
  // the previous day in the same places. Cleared input → `null`, which the
  // route reads as "clear this" rather than as a bad value.
  const due = document.createElement('input');
  due.type = 'date';
  due.className = 'hub-detail-input hub-detail-due';
  due.value = task.dueAt === undefined ? '' : localDateInputValue(task.dueAt);
  due.setAttribute('aria-label', 'Due date');
  due.addEventListener('change', () => {
    const v = due.value;
    if (!v) {
      handlers.onDueSet?.(task, null);
      return;
    }
    const [y, m, d] = v.split('-').map(Number);
    if (!y || !m || !d) return;
    handlers.onDueSet?.(task, new Date(y, m - 1, d, 12, 0, 0, 0).getTime());
  });
  cell('Due', due);

  // The goal list comes from the board rather than being re-derived, so the
  // options here are the sections a reader can already see. The task's own
  // goal is always present even when the list does not have it: a stale or
  // deleted band must not silently re-place the task on the next change event.
  const goal = document.createElement('select');
  goal.className = 'hub-detail-select hub-detail-goal';
  const seen = new Set<string>();
  const addGoalOption = (id: string, label: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = label;
    goal.append(opt);
  };
  for (const g of handlers.goals ?? []) addGoalOption(g.id, g.title);
  addGoalOption(task.goal, handlers.goalLabel?.(task.goal) ?? task.goal);
  goal.value = task.goal;
  goal.setAttribute('aria-label', 'Goal');
  goal.addEventListener('change', () => {
    if (goal.value && goal.value !== task.goal) handlers.onGoalSet?.(task, goal.value);
  });
  // Explicitly full-width, not "whichever field lands last": when effort
  // fields are scored, the hidden effort-detail drawer is what's actually
  // appended last, and DOM order is never a fact this panel wants to depend
  // on for a completely different reason (the goal panel's own last field,
  // Due, must never inherit this by coincidence of position).
  cell('Goal', goal, { full: true });

  // Effort, last, and only when there is something to say.
  //
  // This is where the numbers live. Bryan struck them from the board rows —
  // "No need to show hands on or wall clock hours in the board" — on the
  // understanding that the ticket still carries them, so this cell is the
  // other half of that trade. It is also the one non-hover surface that
  // states the calibration factor, which matters because the goal header
  // says it in a `title` and an iPad has no hover.
  //
  // Three states, three sentences, and an unscored ticket gets NO cell at
  // all rather than a zero — the same line `Task.effortEstimate` draws in
  // its own type doc.
  // Two ordinary top-level fields, and the computation only when it is asked
  // for. *"On task details, the estimate is a secondary function. Don't use
  // so much space for it. Just show the hands on and wall clock estimates
  // with other top level fields. And if I click on one show the detailed
  // estimation computation."* (Bryan, 2026-08-30.) It replaced one prose
  // field that spent a whole row on the calibration sentence.
  const effort = effortFields(task, calibration, calibrationGoal);
  if (effort) {
    cell('Hands-on', effort.handsOn);
    cell('Wall clock', effort.wallClock);
    dl.append(effort.detail);
  }
  return dl;
}

/** What the two estimate fields and their shared drawer hold, or `null` for a
 *  ticket nobody has scored — which gets no fields at all rather than fields
 *  reading "0m". */
export interface EffortFields {
  handsOn: HTMLElement;
  wallClock: HTMLElement;
  detail: HTMLElement;
}

/**
 * The panel's two estimate fields plus the drawer behind them.
 *
 * Each value is a button rather than text: tapping either opens the same
 * drawer, which is where the arithmetic lives — what was estimated, what the
 * board scaled it by and on what evidence, and what the ticket actually took
 * once it closed. A button because the reveal has to work by TAP; a `title`
 * would have put the whole explanation behind a hover the primary device
 * does not have.
 *
 * The three estimate states stay three: never scored returns `null` and draws
 * nothing, a failed run draws both fields reading "not estimated" with the
 * drawer saying the scorer ran, and a real estimate draws numbers.
 */
export function effortFields(
  task: HubTask,
  calibration?: EffortCalibration,
  calibrationGoal?: string,
): EffortFields | null {
  const state = effortEstimateState(task);
  if (state === 'none') return null;
  const est = state === 'ok' ? estimateNumbers(task) : null;
  const band = calibrationGoal ?? task.goal;
  const wallRatio = calibration ? ratioForGoal(calibration.wallClock, band) : undefined;
  const handsRatio = calibration ? ratioForGoal(calibration.handsOn, band) : undefined;
  const hands =
    est && handsRatio
      ? applyEffortRatio(est.handsOnSeconds, handsRatio.ratio)
      : est?.handsOnSeconds;
  const wall =
    est && wallRatio
      ? applyEffortRatio(est.wallClockSeconds, wallRatio.ratio)
      : est?.wallClockSeconds;

  const detail = document.createElement('div');
  detail.className = 'hub-detail-field hub-detail-effort-detail';
  detail.hidden = true;
  const detailBody = document.createElement('dd');
  detailBody.className = 'hub-detail-field-v hub-detail-effort-why';
  detail.append(detailBody);
  for (const line of effortComputationLines(task, est, wallRatio, handsRatio)) {
    const p = document.createElement('p');
    p.textContent = line;
    detailBody.append(p);
  }

  const value = (text: string): HTMLElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hub-detail-effort-value';
    btn.textContent = text;
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'How this estimate was worked out';
    btn.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      for (const other of [
        ...(btn.closest('dl')?.querySelectorAll('.hub-detail-effort-value') ?? []),
      ]) {
        other.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
    });
    return btn;
  };
  const notEstimated = 'not estimated';
  return {
    handsOn: value(hands === undefined ? notEstimated : formatEffortSeconds(hands)),
    wallClock: value(wall === undefined ? notEstimated : formatEffortSeconds(wall)),
    detail,
  };
}

/**
 * The drawer's sentences: the guess, the correction, and what happened.
 *
 * Split out from the fields so the wording is testable without a DOM — which
 * of the three states says what is the thing worth an assertion, not that a
 * `<p>` got appended.
 */
export function effortComputationLines(
  task: HubTask,
  est: { handsOnSeconds: number; wallClockSeconds: number } | null,
  wallRatio?: EffortRatio,
  handsRatio?: EffortRatio,
): string[] {
  if (!est) {
    // Said out loud, because the alternative is a ticket that reads exactly
    // like one nobody has scored. This is the visible half of the positive
    // control: a scorer that produces nothing must be legible as producing
    // nothing.
    return ['The scorer ran on this ticket and could not produce an estimate.'];
  }
  const lines = [
    `Scored at ${formatEffortSeconds(est.handsOnSeconds)} hands-on over ${formatEffortSeconds(est.wallClockSeconds)} of calendar time.`,
  ];
  const said = (r: EffortRatio): string =>
    `\u00d7${r.ratio.toFixed(2)} from ${r.samples} closed ticket${r.samples === 1 ? '' : 's'}`;
  // A factor with NO closed tickets behind it is the board's prior — the
  // starting assumption that the scorer still sizes a ticket for a person
  // (`EFFORT_PRIOR_*` in core). It has to be said, and it has to be said
  // DIFFERENTLY: every number on this panel is traceable back to where it
  // came from, and until priors existed a factor of 1 needed no sentence
  // because it changed nothing. A silent \u00d70.07 would leave a reader
  // looking at a figure fifteen times smaller than the scorer's own with
  // nothing on the panel accounting for it.
  //
  // "Nothing has closed" is only true when nothing has. A goal below the
  // calibration floor (`EFFORT_MIN_SAMPLES_FOR_CALIBRATION`) has closed one
  // or two tickets and is still on the assumption \u2014 saying nothing closed
  // would be false about rows the reader can see on the same board, so the
  // count it HAS is what the sentence names.
  const notYet = (r: EffortRatio): string =>
    r.observedSamples > 0
      ? `${r.observedSamples} closed ticket${r.observedSamples === 1 ? '' : 's'} so far, below the ${EFFORT_MIN_SAMPLES_FOR_CALIBRATION} needed to correct it`
      : 'nothing has closed under this goal to measure yet';
  const assumed = (r: EffortRatio): string =>
    `\u00d7${r.ratio.toFixed(2)} from the board's starting assumption that agents do the work \u2014 ${notYet(r)}`;
  // Agreeing on the FACTOR is what makes it one correction to a reader; the
  // sample counts behind it can differ and the sentence is still about one
  // number. Keying "is this one correction?" on the counts as well printed
  // the same figure twice in a hundred characters.
  const same =
    handsRatio !== undefined &&
    wallRatio !== undefined &&
    handsRatio.samples > 0 &&
    wallRatio.samples > 0 &&
    handsRatio.ratio.toFixed(2) === wallRatio.ratio.toFixed(2);
  if (same && handsRatio !== undefined && wallRatio !== undefined) {
    const lo = Math.min(handsRatio.samples, wallRatio.samples);
    const hi = Math.max(handsRatio.samples, wallRatio.samples);
    lines.push(
      `Scaled \u00d7${wallRatio.ratio.toFixed(2)} from ${lo === hi ? hi : `${lo}\u2013${hi}`} closed ticket${hi === 1 ? '' : 's'} on this goal.`,
    );
  } else {
    if (handsRatio && handsRatio.samples > 0) lines.push(`Hands-on scaled ${said(handsRatio)}.`);
    if (wallRatio && wallRatio.samples > 0) lines.push(`Calendar time scaled ${said(wallRatio)}.`);
  }
  // A factor learned somewhere ELSE on the board. `samples: 0` with
  // `calibrated` true is a goal that has closed too little (or nothing) to
  // teach a correction and is using the board's, and until this branch
  // existed the panel said nothing at all about it: the two `said` lines
  // need samples of their own and the two `assumed` lines are about a prior.
  // A figure fifteen times smaller than the scorer's own with no sentence
  // accounting for it is exactly the hole the priors' own wording was added
  // to close.
  const boardLearned = (r: EffortRatio | undefined): boolean =>
    r?.calibrated === true && r.samples === 0;
  const fromBoard = (r: EffortRatio): string =>
    `\u00d7${r.ratio.toFixed(2)} from closed tickets elsewhere on the board \u2014 ${
      r.observedSamples > 0
        ? `${r.observedSamples} closed ticket${r.observedSamples === 1 ? '' : 's'} under this goal so far, below the ${EFFORT_MIN_SAMPLES_FOR_CALIBRATION} it needs for a factor of its own`
        : 'nothing has closed under this goal yet'
    }`;
  if (boardLearned(handsRatio) && handsRatio)
    lines.push(`Hands-on scaled ${fromBoard(handsRatio)}.`);
  if (boardLearned(wallRatio) && wallRatio)
    lines.push(`Calendar time scaled ${fromBoard(wallRatio)}.`);
  // Said once for both quantities when neither has evidence, which is the
  // shape a board wears right after a prompt bump — two sentences saying
  // "nothing has closed yet" is the same sentence twice.
  //
  // Keyed on `calibrated`, not on `samples === 0`. Since the calibration
  // floor landed, a goal that has closed nothing of its own but sits on a
  // board that HAS learned also reports `samples: 0` \u2014 and its factor is a
  // measured board-wide correction, not an assumption. Calling that "the
  // board's starting assumption" would be false about the one number the
  // panel exists to explain.
  const priorOnly = (r: EffortRatio | undefined): boolean =>
    r !== undefined && !r.calibrated && r.ratio.toFixed(2) !== '1.00';
  // The combined sentence needs ONE count to name, so it fires only when
  // both axes have seen the same number of closes. Different counts get a
  // sentence each rather than one sentence that is right about half the
  // panel.
  if (
    priorOnly(handsRatio) &&
    priorOnly(wallRatio) &&
    handsRatio &&
    wallRatio &&
    handsRatio.observedSamples === wallRatio.observedSamples
  ) {
    lines.push(
      `Hands-on scaled \u00d7${handsRatio.ratio.toFixed(2)} and calendar time \u00d7${wallRatio.ratio.toFixed(2)}, from the board's starting assumption that agents do the work \u2014 ${notYet(wallRatio)}.`,
    );
  } else {
    if (priorOnly(handsRatio) && handsRatio) lines.push(`Hands-on scaled ${assumed(handsRatio)}.`);
    if (priorOnly(wallRatio) && wallRatio)
      lines.push(`Calendar time scaled ${assumed(wallRatio)}.`);
  }
  // What it actually took, once it is closed. Measured numbers are never
  // multiplied — these are reported exactly as they happened, beside the
  // corrected guess rather than folded into it.
  // Only for a ticket that is closed RIGHT NOW. A reopened one still carries
  // the `done` transition from its first life, so both helpers keep answering
  // — and the drawer would report how long the ticket took as a finished fact
  // about a ticket somebody is working on again.
  const closedNow = task.status === 'done';
  const actualWall = closedNow ? effortActualWallClockSeconds(task) : null;
  const actualHands = closedNow ? effortActualHandsOnSeconds(task) : null;
  if (actualWall !== null || actualHands !== null) {
    const took: string[] = [];
    if (actualHands !== null) took.push(`${formatEffortSeconds(actualHands)} of reading`);
    if (actualWall !== null) took.push(`${formatEffortSeconds(actualWall)} of calendar time`);
    lines.push(`Actually took ${took.join(' over ')}.`);
  }
  return lines;
}

/** An epoch-ms instant as the `YYYY-MM-DD` a `<input type="date">` wants, in
 *  the reader's own timezone. `toISOString().slice(0,10)` is the tempting
 *  one-liner and it is wrong west of UTC for anything set in the evening. */
export function localDateInputValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * One thing on this task that is waiting on the reader, in the shape the card
 * renders — whether it came from the task's own decision or from a declaration
 * on one of its comment threads.
 *
 * Deliberately the `ReviewPayload` shape (headline / detail / options),
 * because that entity is where task decisions are heading: a separate ticket
 * unifies them onto it, and a panel rendering a bespoke task-options layout
 * would need rewriting the day it lands. Two sources, one shape, one renderer.
 */
export interface PanelReviewItem {
  /** Stable within one task, so the walkthrough can hold a position across a
   *  repaint without the queue having identity of its own. */
  id: string;
  /** Where the card came from: the task's own decision, a declaration on one
   *  of its threads, or a review item filed ON the ticket (`add_review_item`,
   *  a `review` payload on `create_tasks`). The last has no thread — its
   *  answer goes to the task review-item route, keyed by `reviewItemId`. */
  source: 'task' | 'thread' | 'task-review';
  shape: ReviewShape;
  headline: string;
  /** The ONE body. A task-borne decision has no `detail` field to read, so
   *  this is `decisionBlurb`'s derived prose; a declaration carries its own. */
  detail?: string;
  options?: HubDecisionOption[];
  askedBy?: string;
  /** Ranking key: when this started waiting. */
  since: number;
  /** Names a person. Ranks above a run that merely ended with an agent
   *  speaking — the strip's own rule, not a second opinion. */
  direct?: boolean;
  /** Thread-borne items answer by replying THERE, so the reply reaches the
   *  agent watching that thread. Absent on the task's own decision, which is
   *  answered through `answer_decision`. */
  threadId?: string;
  /** Which doc the thread lives in — a task's threads live in its body room,
   *  but the item is carried verbatim rather than re-derived. */
  docId?: string;
  /** The comment carrying the declaration, so the answer is written against
   *  the right one on a thread that declared twice. */
  commentId?: string;
  /** Which row on the ticket, on a `task-review` card — the answer is
   *  stamped back at this id. */
  reviewItemId?: string;
  /**
   * On a `task-review` card the owner REVISED after the reader asked on a
   * phrase of it: when, and the question that prompted it (the anchored
   * thread's first comment). `threadId` above then names that thread — it
   * lives on this task's doc, so the discussion below the card holds it.
   * Carried from the server's row, never derived here; absent on a fresh
   * item. The Home walkthrough renders the same note (`ReviewRevisionNote`).
   */
  revision?: { at: number; question?: string };
  /** An agent DECLARED this — it carries a `review` payload — rather than the
   *  queue inferring it from who spoke last. It ranks above an inferred item,
   *  and it is half of what makes the answer route legal; the other half is a
   *  `commentId` to write the stamp on, which the caller checks for itself
   *  (`hub-app`), because a declaration with nowhere to record an answer is
   *  still a declaration and still ranks as one. */
  declared?: boolean;
  /**
   * Whether the head meta may say "Asked by". True for the task's own
   * decision and for every declaration — a declaration IS an ask — and for an
   * inferred item only when `direct` measured a named question. Same rule as
   * `askedMeta`, carried as data because this row shape has no `ReviewItem`
   * to derive it from at render time.
   */
  asked?: boolean;
  /**
   * A declared item somebody already ANSWERED — the record the card renders
   * in place ("Answered by you: …" with a persistent Undo) instead of the
   * composer. Read off the declaring comment's own stamps, which is the only
   * place the record survives a reload; `text` falls back to the tapped
   * option's label on a legacy answer that stamped `answeredWith` alone.
   */
  answered?: { by?: string; text?: string; at: number };
}
