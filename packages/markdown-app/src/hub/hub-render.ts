/**
 * DOM renderers for the workspace hub (plan §3.9). Each function re-renders
 * one region into its container from the view model — no fetches, no Yjs —
 * so the interaction contracts (the status dropdown, in-place title edits,
 * the two-filter activity view) are testable under happy-dom.
 */
import { escapeHtml, evidenceSuperseded, transitionUnproven } from '@feedback/core';
import {
  GOAL_SUMMARY_MAX_WORDS,
  type StoredGoalSummary,
  clipGoal,
  goalDisplay,
} from '@feedback/core/goal-summary';
import { renderCommentMarkdown } from '../comment-markdown.ts';
import {
  type ActivityEvent,
  type ActivityFilter,
  type BoardSection,
  type DecisionRow,
  type DriftNotice,
  type HubEvidence,
  type HubTask,
  type HubTransition,
  type PendingRetriageView,
  type PresenceChip,
  type ReorderTarget,
  type ReviewItem,
  type ReviewKind,
  type ReviewQueue,
  TASK_STATUS_ORDER,
  type TaskStatus,
  type UnplacedNotice,
  type UptimeReport,
  activityRows,
  appendDictation,
  describeEvent,
  dropIndexFor,
  dropTarget,
  ownerKind,
  quoteAfterCapture,
  quoteAfterEdit,
  quoteForCapture,
  reviewRow,
  shortCommit,
  stepTarget,
  timeAgo,
  uptimeSummary,
} from './hub-model.ts';

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done',
};

/**
 * Swap a title element for an input; Enter commits, Escape or blur cancels
 * (§3.9: tap the title text to edit, Enter commits). Cancel restores the
 * original text — the caller re-renders on commit anyway.
 *
 * Enter/F2 on the element itself starts the edit, so renaming is not a
 * pointer-only gesture. That handler stops propagation for the same reason
 * the click one does: on a task row, an un-stopped Enter would open the task
 * behind the editor it just opened.
 */
function wireInPlaceTitle(
  el: HTMLElement,
  current: () => string,
  commit: (v: string) => void,
): void {
  el.addEventListener('keydown', (ev) => {
    if (el.querySelector('input')) return; // the input owns its own keys
    if (ev.key !== 'Enter' && ev.key !== 'F2') return;
    ev.preventDefault();
    ev.stopPropagation();
    el.click();
  });
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (el.querySelector('input')) return;
    const original = current();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hub-title-input';
    input.value = original;
    el.replaceChildren(input);
    input.focus();
    input.setSelectionRange(original.length, original.length);
    const restore = () => {
      el.replaceChildren(document.createTextNode(original));
    };
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') {
        ke.preventDefault();
        const v = input.value.trim();
        if (v && v !== original) commit(v);
        else restore();
      } else if (ke.key === 'Escape') {
        restore();
      }
    });
    input.addEventListener('blur', () => {
      // Blur cancels: an accidental tap must never rewrite a title.
      if (el.contains(input)) restore();
    });
    input.addEventListener('click', (ce) => ce.stopPropagation());
  });
}

// ── Goal strip ─────────────────────────────────────────────────────────────

export interface GoalStripHandlers {
  /** `summary` is the ≤20-word display line. Empty string clears it, which
   *  is how a reviewer goes back to the deterministic clip. */
  onGoalCommit: (goal: string, summary: string) => void;
}

/**
 * Read-first, editable in place, markdown (§3.9). Empty goal → the §3.9
 * "start planning" lead-in instead of an empty strip.
 *
 * A goal longer than twenty words collapses to its summary with a "Show full
 * goal" toggle; a short one renders in full, markdown and all, with no toggle
 * — a control that reveals nothing is noise. The toggle is a `<button>` with
 * `aria-expanded`, never a hover reveal: this strip is read on a phone, where
 * there is no hover and the full-length card measured 517px tall.
 */
export function renderGoalStrip(
  container: HTMLElement,
  goal: string,
  handlers: GoalStripHandlers,
  storedSummary?: StoredGoalSummary,
  expanded = false,
): void {
  container.replaceChildren();
  const display = goalDisplay(goal, storedSummary);
  const body = document.createElement('div');
  body.className = 'hub-goal-body';
  if (!goal.trim()) {
    body.innerHTML =
      '<p class="hub-goal-empty">No goal yet — start planning: set the goal this workspace drives toward.</p>';
  } else if (display.truncated && !expanded) {
    // Plain text on purpose: a summary is one line, and markdown source in a
    // clip would put `**` and `](http://…` on the most-viewed line of the
    // board. The expanded view below renders the real markdown.
    const p = document.createElement('p');
    p.className = 'hub-goal-summary';
    p.textContent = display.summary;
    body.append(p);
  } else {
    body.innerHTML = renderCommentMarkdown(goal);
  }
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'hub-goal-edit icon-btn';
  edit.title = 'Edit the workspace goal';
  edit.setAttribute('aria-label', 'Edit the workspace goal');
  edit.textContent = '✏️';
  edit.addEventListener('click', () => {
    const editor = document.createElement('div');
    editor.className = 'hub-goal-editor';
    const ta = document.createElement('textarea');
    ta.value = goal;
    ta.rows = Math.min(10, Math.max(3, goal.split('\n').length + 1));
    // The short line is editable right here, because whoever wrote the goal
    // is the person best placed to say what its twenty words are — and a
    // compression somebody else chose is a rewrite of their statement.
    const summaryLabel = document.createElement('label');
    summaryLabel.className = 'hub-goal-summary-label';
    summaryLabel.textContent = `Short version (${GOAL_SUMMARY_MAX_WORDS} words or fewer, shown on the board)`;
    const summaryInput = document.createElement('input');
    summaryInput.type = 'text';
    summaryInput.className = 'hub-goal-summary-input';
    summaryInput.value = storedSummary?.text ?? '';
    summaryInput.placeholder = clipGoal(goal);
    summaryLabel.append(summaryInput);
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save goal';
    save.className = 'hub-btn hub-btn-primary';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.className = 'hub-btn';
    save.addEventListener('click', () => {
      // The field is PRE-FILLED with the stored line, so an untouched one
      // ships back with the save — and the server, which cannot tell a
      // resubmission from a fresh answer, would hash it against the NEW goal
      // and bless a sentence describing the old one. That is the exact
      // failure the hash exists to prevent, laundered through the UI. So a
      // line left exactly as it was, on a goal that moved, is dropped: the
      // strip falls back to the clip of the new goal, and the cost is a line
      // the reviewer can retype rather than a board asserting an abandoned
      // aim. Retyping it is the reconfirmation.
      const untouched = summaryInput.value.trim() === (storedSummary?.text ?? '').trim();
      const stale = ta.value !== goal && untouched;
      handlers.onGoalCommit(ta.value, stale ? '' : summaryInput.value);
    });
    cancel.addEventListener('click', () =>
      renderGoalStrip(container, goal, handlers, storedSummary, expanded),
    );
    const row = document.createElement('div');
    row.className = 'hub-goal-editor-actions';
    row.append(save, cancel);
    editor.append(ta, summaryLabel, row);
    container.replaceChildren(editor);
    ta.focus();
  });
  container.append(body, edit);
  if (display.truncated) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'hub-goal-more';
    more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    more.textContent = expanded ? 'Show less' : 'Show full goal';
    more.addEventListener('click', () =>
      renderGoalStrip(container, goal, handlers, storedSummary, !expanded),
    );
    container.append(more);
  }
}

// ── Lead-agent strip ───────────────────────────────────────────────────────

export interface LeadStripHandlers {
  onLeadCommit: (leadAgentId: string) => void;
}

/**
 * Who is responsible for this board.
 *
 * A goal change with nobody responsible is a dead letter, so the vacancy is
 * rendered as loudly as the assignment — "no lead agent" is a state to fix,
 * not a blank. The picker lists every agent the board knows about (the
 * current lead plus everyone attached), so reassigning is one tap; with
 * nothing to pick from it degrades to the sentence alone rather than an
 * empty dropdown that looks broken.
 */
export function renderLeadStrip(
  container: HTMLElement,
  leadAgentId: string | undefined,
  knownAgentIds: string[],
  handlers: LeadStripHandlers,
  pendingRetriage?: PendingRetriageView,
): void {
  container.replaceChildren();
  container.classList.toggle('hub-lead-empty', !leadAgentId);
  const label = document.createElement('span');
  label.className = 'hub-lead-label';
  label.textContent = leadAgentId ? 'Lead agent' : 'No lead agent — nobody owns goal changes here';
  container.append(label);
  if (pendingRetriage && pendingRetriage.taskIds.length > 0) {
    // A goal edit that has not been picked up. Counted, not vaguely
    // announced: "3 tasks" is the size of the ask, and it is stated whether
    // or not there is a lead — the case with no lead is exactly the one
    // where this used to disappear.
    const n = pendingRetriage.taskIds.length;
    const waiting = document.createElement('span');
    waiting.className = 'hub-lead-pending';
    waiting.textContent = leadAgentId
      ? `Goal edit waiting for the lead — ${n} task${n === 1 ? '' : 's'} to re-place`
      : `Goal edit waiting — ${n} task${n === 1 ? '' : 's'} to re-place, and nobody to do it`;
    waiting.title = `Edited by ${pendingRetriage.byName}`;
    container.append(waiting);
  }

  const options = [...new Set([...(leadAgentId ? [leadAgentId] : []), ...knownAgentIds])].sort(
    (a, b) => a.localeCompare(b),
  );
  if (options.length === 0) return;

  const select = document.createElement('select');
  select.className = 'hub-select hub-lead-select';
  select.setAttribute('aria-label', 'Lead agent');
  if (!leadAgentId) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Assign a lead…';
    select.append(placeholder);
  }
  for (const id of options) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    select.append(opt);
  }
  select.value = leadAgentId ?? '';
  select.addEventListener('change', () => {
    if (select.value && select.value !== leadAgentId) handlers.onLeadCommit(select.value);
  });
  container.append(select);
}

// ── Board ──────────────────────────────────────────────────────────────────

export interface BoardHandlers {
  /** The row's status dropdown picked `to` — an arbitrary status, not a step
   *  along a cycle. Same shape as the detail panel's, deliberately. */
  onStatusSet: (task: HubTask, to: TaskStatus) => void;
  onGoalTitleCommit: (sectionId: string, title: string) => void;
  onOpenTask: (task: HubTask) => void;
  /** A drag or an arrow-key move resolved to a `set_task_goal` call. */
  onReorder: (task: HubTask, target: ReorderTarget) => void;
  onTitleCommit: (task: HubTask, title: string) => void;
  onAssign: (task: HubTask, assignee: string) => void;
  /** The agents currently attached to this workspace — who a task can be
   *  handed to besides a person. Omitted → the picker offers 'human' and
   *  whoever already owns the task. */
  knownAgentIds?: string[];
  /**
   * Whether the title renames on tap. See `renderTaskRow` for why this is a
   * pointer question rather than a width one. Omitted → asked of the browser.
   */
  inlineTitleEdit?: () => boolean;
}

/** The bare word the store used to default to. It names a category rather
 *  than somebody, so a task still carrying it is UNOWNED, not assigned —
 *  and the API refuses to hand a task to it. */
const GENERIC_ASSIGNEE = 'agent';

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
    opt.textContent = id;
    sel.append(opt);
  }
  // After the options are in the tree — a detached option's selected flag
  // does not survive being appended.
  sel.value = owner;
  const reads = owner === '' ? 'nobody' : `${owner}${ownerKindSuffix(kind)}`;
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

/** The four states the owner mark can be in. `human` keeps its name because
 *  it is the class the person styling has always carried; it now covers every
 *  person, not only the reserved literal. */
type OwnerMarkKind = 'none' | 'human' | 'agent' | 'unknown';

/**
 * Which mark to draw for this owner.
 *
 * `none` is "nobody has this" and is answered from the assignee alone — a
 * hole in the board, and a different question from person-or-agent. For
 * everyone else the answer is the server's `ownerKind`, never the name: a
 * rule that pattern-matched names would be wrong for somebody, silently, and
 * the board would keep drawing a plausible mark over it. An owner nobody has
 * declared gets its own mark rather than being folded into `agent`, which is
 * what the board did before and is why a person named Bryan was drawn
 * identically to an agent.
 */
function ownerMarkKind(task: HubTask, owner: string): OwnerMarkKind {
  if (owner === '') return 'none';
  switch (ownerKind(task)) {
    case 'person':
      return 'human';
    case 'agent':
      return 'agent';
    default:
      return 'unknown';
  }
}

/**
 * The words that carry the distinction for anyone not reading the colour.
 *
 * The mark is a coloured circle of initials, and colour alone is not a
 * distinction — it is invisible to a screen reader and unreliable for a
 * colour-blind reader. So the kind rides the picker's accessible name and
 * its tooltip, which is where the owner's full name already lives.
 */
function ownerKindSuffix(kind: OwnerMarkKind): string {
  switch (kind) {
    case 'human':
      return ' (person)';
    case 'agent':
      return ' (agent)';
    case 'unknown':
      return ' (person or agent not recorded)';
    default:
      return '';
  }
}

/**
 * One or two letters for the circle that stands in for an owner.
 *
 * A board row is read for its TITLE, and the two controls flanking it were
 * spending ~200px on the words "In progress" and a full agent id — on the
 * surface whose entire job is letting someone scan what the work is. The name
 * does not disappear: it stays on the picker's `title`/`aria-label` and in the
 * detail panel, where there is room for it.
 *
 * `agent-` / `agent_` leads are dropped before the initials are taken, because
 * every agent id starts with it and a column of "A"s distinguishes nobody.
 * A single word yields ONE letter rather than its first two — "HU" for `human`
 * reads as a name fragment, "H" reads as a mark.
 */
export function ownerInitials(owner: string): string {
  const trimmed = owner.trim();
  if (trimmed === '' || trimmed.toLowerCase() === GENERIC_ASSIGNEE) return '?';
  const words = trimmed
    .replace(/^agent[-_\s]+/i, '')
    .split(/[-_\s.]+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0][0] ?? '?').toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/**
 * A hovering, precise pointer is what makes tap-to-rename on the title safe:
 * it implies a visible hover state (so the drag handle and the open zone are
 * discoverable) and a click that lands where it was aimed. Asking the pointer
 * rather than the viewport width is the honest form of the question — an
 * iPad with a trackpad gets the desktop gesture, a touchscreen laptop's mouse
 * does too, and a 430px phone never does.
 */
let pointerQuery: { matches: boolean } | null | undefined;
function finePointer(): boolean {
  if (pointerQuery === undefined) {
    // Resolved once and kept: the MediaQueryList stays LIVE (its `matches`
    // tracks the real pointer), and asking for a new one per row would build
    // a hundred objects on every board render.
    const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
    try {
      pointerQuery =
        typeof mm === 'function' ? mm.call(globalThis, '(hover: hover) and (pointer: fine)') : null;
    } catch {
      pointerQuery = null;
    }
  }
  return pointerQuery === null ? true : pointerQuery.matches;
}

/* Always emits a slot, even with no tier to show. Grid auto-placement fills
   CONSECUTIVE tracks — it does not leave a hole where a child is missing — so
   a row that skipped the dot put its title in the dot's track and its badges
   in the title's. With the title track at `minmax(0, 1fr)` and the dot track
   collapsed, that rendered every title at zero width. Keeping the child count
   fixed is also what makes titles line up across rows, which is the whole
   point of the grid. */
function riskDot(task: HubTask): HTMLElement {
  const dot = document.createElement('span');
  if (!task.riskTier) {
    dot.className = 'hub-risk-slot';
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }
  dot.className = `hub-risk-slot hub-risk hub-risk-${task.riskTier}`;
  dot.title = `risk: ${task.riskTier}`;
  return dot;
}

function taskBadges(task: HubTask): HTMLElement {
  const badges = document.createElement('span');
  badges.className = 'hub-task-badges';
  const add = (cls: string, text: string, title?: string) => {
    const b = document.createElement('span');
    b.className = `hub-badge ${cls}`;
    b.textContent = text;
    if (title) b.title = title;
    badges.append(b);
  };
  if (task.needs === 'decision') add('hub-badge-decision', 'decision');
  else if (task.needs === 'action') add('hub-badge-action', 'action');
  // The assignee is its own cell at the end of the row now (§ row anatomy).
  // As a badge it appeared only when it wasn't the default 'agent', so most
  // rows showed no owner at all.

  // The row's only tell that a discussion exists. Without it the comments are
  // in the store and unreachable from the board — the failure mode this
  // codebase has already been bitten by with resolved threads. It goes before
  // the derived badges because the badge strip clips on a narrow row, and the
  // one badge that means “someone is talking to you” must not be the one lost.
  if (task.commentCount) {
    add(
      'hub-badge-comments',
      `💬 ${task.commentCount}`,
      `${task.commentCount} comment${task.commentCount === 1 ? '' : 's'} — open the task to read them`,
    );
  }
  if (task.after.length > 0)
    add('hub-badge-after', `after ${task.after.length}`, `blocked on: ${task.after.join(', ')}`);
  if (task.dueAt !== undefined) {
    const due = new Date(task.dueAt);
    const overdue = task.dueAt < Date.now() && task.status !== 'done';
    add(
      overdue ? 'hub-badge-due hub-badge-overdue' : 'hub-badge-due',
      `due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    );
  }
  if (task.triagePendingTs !== undefined) add('hub-badge-triage', 'triaging…');
  // The title standard's only surface on the board. A gap computed on the
  // server and rendered nowhere is not a check — it is a field, and this
  // codebase has shipped that mistake before (`unproven`, which reached an
  // event and a toast and never a row).
  //
  // Deliberately quiet: one badge whatever the gap count, and the specifics
  // in the tooltip rather than in the strip. A row that needs renaming is a
  // nudge for whoever next touches it, not an alarm — and a loud marker on
  // what will initially be most of the board is a marker everyone learns to
  // skim past.
  if (task.titleGaps && task.titleGaps.length > 0) {
    add(
      'hub-badge-title-gap',
      'name?',
      `This title doesn't meet the standard (${task.titleGaps.join(', ')}). Aim for "<Person> can <achieve goal X> by <describe action>", under 70 characters.`,
    );
  }
  // The description's own badge, separate from the title's because they are
  // separate fixes: a row can be perfectly named and still not say who the
  // work is for. Same quiet styling and the same one-badge-whatever-the-count
  // rule, for the same reason.
  if (task.bodyGaps && task.bodyGaps.length > 0) {
    const empty = task.bodyGaps.includes('empty');
    add(
      'hub-badge-body-gap',
      empty ? 'no description' : 'why?',
      empty
        ? 'This task has no description at all.'
        : 'The description does not open with a user story. Aim for "<Person> can <achieve goal X> so that <goal Y>" — or state the question outright if this is a decision.',
    );
  }
  return badges;
}

/**
 * The task's `links`, as chips. Until this existed, a ref was stored, keyed
 * and backlinked and then never drawn — the store had it and no surface
 * could show it, which is the failure mode this codebase has already been
 * bitten by once with resolved threads.
 *
 * Only `url` refs become anchors. The internal kinds (doc / thread / task /
 * diff) are ids, and inventing hrefs for them here would be guessing at
 * route shapes that live on the server; they render as labelled chips so
 * their presence is at least visible. A ref of an unknown kind is skipped
 * rather than thrown on — an older client must survive a newer server
 * adding a kind, and a task that fails to open is worse than a missing chip.
 */
function renderTaskLinks(task: HubTask): HTMLElement | null {
  const refs = Array.isArray(task.links) ? task.links : [];
  if (refs.length === 0) return null;
  const wrap = document.createElement('div');
  wrap.className = 'hub-detail-links';
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
    const id = ref.docId ?? ref.taskId ?? ref.workspaceId;
    const chip = document.createElement('span');
    chip.className = 'hub-link-chip hub-link-internal';
    chip.textContent = typeof id === 'string' ? `${kind}: ${id}` : kind;
    wrap.append(chip);
  }
  return wrap.childElementCount > 0 ? wrap : null;
}

export function renderTaskRow(task: HubTask, handlers: BoardHandlers): HTMLElement {
  const row = document.createElement('div');
  row.className = `hub-task-row hub-status-${task.status}${task.status === 'done' ? ' hub-done' : ''}`;
  row.dataset.taskId = task.id;
  row.tabIndex = 0;

  // A dropdown over every status, not a tap-to-cycle mark. The cycle assumed
  // the workflow was linear (todo → in-progress → done → todo), so sending a
  // finished task back to todo cost two transitions and wrote two audit events
  // for a move that happened once. A native <select> also gets the mobile
  // picker and keyboard support for free, which a custom popup would owe.
  const chip = document.createElement('select');
  chip.className = `hub-status-select hub-chip-${task.status}`;
  for (const s of TASK_STATUS_ORDER) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = STATUS_LABEL[s];
    chip.append(opt);
  }
  // After the options are in the tree, not via `option.selected` before it —
  // a detached option's selected flag doesn't survive being appended.
  chip.value = task.status;
  chip.setAttribute('aria-label', `Status: ${STATUS_LABEL[task.status]}`);
  chip.title = `Status: ${STATUS_LABEL[task.status]}`;
  // A select swallows its own clicks in a real browser, but the row's open
  // handler must not fire from the picker either way.
  chip.addEventListener('click', (ev) => ev.stopPropagation());
  chip.addEventListener('change', (ev) => {
    ev.stopPropagation();
    const to = chip.value as TaskStatus;
    if (to !== task.status) handlers.onStatusSet(task, to);
  });

  // …drawn as a small round mark rather than as the word. The select is still
  // the control — it is laid over the mark at full size and made transparent,
  // which is the only way to keep the phone's native picker and the keyboard
  // behaviour while spending 22px instead of 96px of the row. Nothing about
  // the picker changes: same class, same options, same aria-label.
  const statusCtl = document.createElement('span');
  statusCtl.className = 'hub-status-ctl';
  const statusMark = document.createElement('span');
  statusMark.className = `hub-status-mark hub-status-mark-${task.status}`;
  statusMark.setAttribute('aria-hidden', 'true');
  statusCtl.append(statusMark, chip);

  // ── Far left: the drag handle. Hidden until the row is hovered or the
  // handle itself is focused (CSS) — a permanent column of ⠿ is noise on a
  // list you read by skimming. A done row keeps the ELEMENT and loses the
  // control: finishing a task doesn't move it (mockup v2), and dropping the
  // child instead would slide every later cell one grid track left, which is
  // the bug the risk-dot slot already exists to prevent.
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'hub-drag-handle';
  handle.textContent = '⠿';
  handle.tabIndex = -1;
  if (task.status === 'done') {
    handle.disabled = true;
    handle.setAttribute('aria-hidden', 'true');
  } else {
    handle.tabIndex = 0;
    handle.setAttribute('aria-label', `Reorder “${task.title}” — drag, or arrow keys to move`);
    handle.title = 'Drag to reorder — or focus and use the arrow keys';
  }
  handle.addEventListener('click', (ev) => ev.stopPropagation());

  // ── Then the open zone: space whose only job is opening the task. It is
  // what makes restoring inline title editing safe — with the title claiming
  // taps for a rename, the row needs a target that can only ever mean "open".
  const openZone = document.createElement('button');
  openZone.type = 'button';
  openZone.className = 'hub-open-zone';
  openZone.textContent = '›';
  openZone.setAttribute('aria-label', `Open ${task.title}`);
  openZone.title = 'Open this task';
  openZone.addEventListener('click', (ev) => {
    ev.stopPropagation();
    handlers.onOpenTask(task);
  });

  const dot = riskDot(task);
  const title = document.createElement('span');
  title.className = 'hub-task-title';
  title.textContent = task.title;
  // Inline editing, restored — but only for a pointer that can hover and aim.
  //
  // It was removed an hour before this shipped because the title spans most
  // of the row and its click handler stopped propagation to enter edit mode,
  // so on a phone tapping a task could only ever rename it ("I can't open a
  // task to see what's inside"). The open zone is the structural half of the
  // fix; `finePointer()` is the other half, and it is deliberately NOT a
  // width breakpoint: a narrow gap is not a real tap target at 430px, so
  // rather than dedicate ~44px of a 430px row to whitespace, the phone keeps
  // the gesture it already had — the whole row, title included, opens the
  // task, and renaming happens in the detail panel one tap away, where the
  // title is a full-width target.
  const editable = (handlers.inlineTitleEdit ?? finePointer)();
  if (editable) {
    title.tabIndex = 0;
    title.title = 'Click or press Enter to rename';
    wireInPlaceTitle(
      title,
      () => task.title,
      (v) => handlers.onTitleCommit(task, v),
    );
  } else {
    title.title = 'Tap to open';
  }

  // ── Far right: who has it, and the gesture that hands it over — the same
  // picker the detail panel offers.
  // Same construction as the status control, same reason: a circle of initials
  // where a truncated id used to be, with the real picker transparent on top
  // of it so the gesture, the keyboard path and the accessible name all stay.
  const assignee = assigneePicker('hub-row-assignee', task, handlers.knownAgentIds, (to) =>
    handlers.onAssign(task, to),
  );
  const ownerCtl = document.createElement('span');
  ownerCtl.className = 'hub-owner-ctl';
  const avatar = document.createElement('span');
  const ownerKind = assignee.className.split(' ').find((c) => c.startsWith('hub-owner-')) ?? '';
  avatar.className = `hub-owner-avatar ${ownerKind}`;
  avatar.textContent = ownerInitials(task.assignee);
  avatar.setAttribute('aria-hidden', 'true');
  ownerCtl.append(avatar, assignee);

  row.append(handle, openZone, statusCtl, dot, title, taskBadges(task), ownerCtl);
  row.addEventListener('click', () => handlers.onOpenTask(task));
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !(ev.target as HTMLElement).closest('input')) {
      handlers.onOpenTask(task);
    }
  });
  return row;
}

// ── Reordering: drag from the handle, or move with the keyboard ────────────

function clearDropMarks(container: HTMLElement): void {
  for (const el of container.querySelectorAll('.hub-drop-into')) {
    el.classList.remove('hub-drop-into');
  }
  for (const el of container.querySelectorAll('.hub-drop-before, .hub-drop-after')) {
    el.classList.remove('hub-drop-before', 'hub-drop-after');
  }
}

/**
 * Which section and slot the pointer is currently over, painted as it goes.
 * This is the only browser-shaped part of reordering — `elementFromPoint` and
 * layout rectangles have no meaning without a real engine — so it does no
 * arithmetic of its own: the index comes from `dropIndexFor` and the call it
 * turns into comes from `dropTarget`, both pure and both unit-tested.
 */
function previewDrop(
  container: HTMLElement,
  dragged: HTMLElement,
  x: number,
  y: number,
): { sectionId: string; index: number } | null {
  const at =
    typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
  const section = at?.closest?.('.hub-section') as HTMLElement | null;
  if (!section) return null;
  const rows = [...section.querySelectorAll<HTMLElement>('.hub-task-row')].filter(
    (r) => r !== dragged,
  );
  const index = dropIndexFor(
    rows.map((r) => {
      const box = r.getBoundingClientRect();
      return { top: box.top, height: box.height };
    }),
    y,
  );
  clearDropMarks(container);
  section.classList.add('hub-drop-into');
  const before = rows[index];
  if (before) before.classList.add('hub-drop-before');
  else rows[rows.length - 1]?.classList.add('hub-drop-after');
  return { sectionId: section.dataset.goalId ?? '', index };
}

/**
 * Pointer Events rather than HTML5 drag-and-drop. Mockup v2 used `draggable`,
 * which is the right sketch and the wrong mechanism here: `dragstart` never
 * fires for a finger, so a `draggable` handle is dead on the surface where
 * this board is actually reviewed. One pointer path covers mouse, trackpad
 * and touch; the interaction it draws — handle at the far left, grab cursor,
 * the row at .45 opacity, the target section outlined — is the mockup's.
 *
 * A drag has two endings and `pointercancel` is the common one on a phone, so
 * both are wired; on cancel the move is abandoned rather than committed. A
 * board re-render mid-drag (the ydoc is live) replaces these rows outright,
 * which drops the gesture — the listeners go with the detached element, so
 * nothing is left armed.
 */
function wireBoardReorder(
  container: HTMLElement,
  sections: BoardSection[],
  handlers: BoardHandlers,
): void {
  const byId = new Map<string, HubTask>();
  for (const section of sections) for (const t of section.tasks) byId.set(t.id, t);

  const step = (task: HubTask, dir: -1 | 1) => {
    const target = stepTarget(sections, task.id, dir);
    if (target) handlers.onReorder(task, target);
  };

  for (const row of container.querySelectorAll<HTMLElement>('.hub-task-row')) {
    const task = byId.get(row.dataset.taskId ?? '');
    if (!task || task.status === 'done') continue;

    // Alt+Arrow from the ROW: j/k leaves the focus on the row, so a reorder
    // reachable only from the handle would mean tabbing out of the navigation
    // you are already in. Bare arrows stay the browser's.
    row.addEventListener('keydown', (ev) => {
      if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
      ev.preventDefault();
      step(task, ev.key === 'ArrowUp' ? -1 : 1);
    });

    const handle = row.querySelector<HTMLElement>('.hub-drag-handle');
    if (!handle) continue;
    handle.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
      ev.preventDefault();
      ev.stopPropagation();
      step(task, ev.key === 'ArrowUp' ? -1 : 1);
    });
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button > 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      let drop: { sectionId: string; index: number } | null = null;
      row.classList.add('hub-dragging');
      try {
        handle.setPointerCapture?.(ev.pointerId);
      } catch {
        /* capture is an optimisation; the listeners below work without it */
      }
      const onMove = (m: PointerEvent) => {
        const next = previewDrop(container, row, m.clientX, m.clientY);
        if (next) drop = next;
      };
      const finish = (commit: boolean) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onCancel);
        try {
          handle.releasePointerCapture?.(ev.pointerId);
        } catch {
          /* nothing captured */
        }
        row.classList.remove('hub-dragging');
        clearDropMarks(container);
        if (!commit || !drop) return;
        const target = dropTarget(sections, task.id, drop.sectionId, drop.index);
        if (target) handlers.onReorder(task, target);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onCancel);
    });
  }
}

/** Goals-as-sections, Chores last (already ordered by the model); done rows
 *  stay in place, drawn done — finishing a task doesn't move it (§3.9). */
export function renderBoard(
  container: HTMLElement,
  sections: BoardSection[],
  handlers: BoardHandlers,
): void {
  container.replaceChildren();
  for (const section of sections) {
    const sec = document.createElement('section');
    sec.className = `hub-section${section.depth === 1 ? ' hub-subgoal' : ''}${section.isChores ? ' hub-chores' : ''}`;
    sec.dataset.goalId = section.id;
    const head = document.createElement('h3');
    head.className = 'hub-section-title';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'hub-section-title-text';
    titleSpan.textContent = section.title;
    if (!section.isChores) {
      titleSpan.title = 'Tap to edit the goal title';
      wireInPlaceTitle(
        titleSpan,
        () => section.title,
        (v) => handlers.onGoalTitleCommit(section.id, v),
      );
    }
    head.append(titleSpan);
    if (section.dueAt !== undefined) {
      const due = document.createElement('span');
      due.className = 'hub-badge hub-badge-due';
      due.textContent = `due ${new Date(section.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      head.append(due);
    }
    sec.append(head);
    if (section.tasks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hub-section-empty';
      empty.textContent = section.isChores ? 'No chores.' : 'No tasks yet.';
      sec.append(empty);
    } else {
      for (const task of section.tasks) sec.append(renderTaskRow(task, handlers));
    }
    container.append(sec);
  }
  // After the rows exist: the drag/keyboard wiring needs the whole board (a
  // drop can cross into another goal's section), so it can't live on the row.
  wireBoardReorder(container, sections, handlers);
}

export interface UnplacedStripHandlers {
  /** Take the reader to the longest-waiting unplaced task. */
  onOpenOldest: (taskId: string) => void;
}

/**
 * "3 tasks have no goal yet · oldest waiting 6d", directly above the board.
 *
 * Above it on purpose. The tasks this counts rest at the BOTTOM of Chores,
 * which is the last thing on the page and the reason the bucket goes unread —
 * a notice rendered down there would inherit exactly the invisibility it
 * exists to fix.
 *
 * `null` empties the container and hides it. Rendering "0 tasks have no goal"
 * would be a line that is present on every board forever, and a line that is
 * always there is a line nobody reads.
 */
export function renderUnplacedStrip(
  container: HTMLElement,
  notice: UnplacedNotice | null,
  handlers: UnplacedStripHandlers,
): void {
  container.replaceChildren();
  if (!notice) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'hub-unplaced-open';
  open.textContent = notice.label;
  open.setAttribute(
    'aria-label',
    `${notice.label}, ${notice.detail} — open the one that has waited longest`,
  );
  open.addEventListener('click', () => handlers.onOpenOldest(notice.oldestTaskId));

  const age = document.createElement('span');
  age.className = 'hub-unplaced-age';
  age.textContent = notice.detail;

  container.append(open, age);
}

// ── Quick capture ──────────────────────────────────────────────────────────

/**
 * One box, always in the same place, that turns a sentence into a task.
 *
 * Built once and never re-rendered — unlike every other region here. That is
 * the whole point: the board repaints on every ydoc change, and a composer
 * that is replaced mid-sentence loses what you were typing and the caret with
 * it. So `renderQuickAdd` is a MOUNT, guarded against a second call on the
 * same container.
 */
export interface QuickAddHandlers {
  /** The raw text, exactly as typed. Splitting it into title and body is the
   *  model's job, not the DOM's.
   *
   *  Resolves true when the task actually exists. The box clears on THAT, not
   *  on dispatch: a phone in a lift would otherwise eat the idea and hand back
   *  a toast, which is the one failure this box exists to prevent, at the
   *  moment it costs most.
   *
   *  `quote` is the speaker's own words when any of the text was dictated —
   *  kept verbatim even after the text is edited, so a misheard word can be
   *  fixed without losing what was actually said. */
  onCapture: (text: string, quote?: string) => Promise<boolean>;
  /** Wire speech to the box. Called once at mount with the parts to drive;
   *  omitted entirely where speech is unavailable, and the typed path is then
   *  exactly what it was.
   *
   *  The split is deliberate: this module owns the DOM, and the caller owns
   *  the policy (which recognizer, what it costs, when it may listen). */
  mountVoice?: (parts: {
    button: HTMLButtonElement;
    indicator: HTMLElement;
    /** A finished utterance. Appends to the box; never files anything —
     *  dictation mishears, and a wrong task filed silently is worse than one
     *  more tap on Add. */
    deliver: (transcript: string) => void;
  }) => void;
}

export function renderQuickAdd(container: HTMLElement, handlers: QuickAddHandlers): void {
  if (container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';
  const form = document.createElement('form');
  form.className = 'hub-quick-form';
  const input = document.createElement('textarea');
  input.className = 'hub-quick-input';
  input.rows = 1;
  input.placeholder = 'Capture a task — say it however you like';
  input.setAttribute('aria-label', 'Capture a task');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'hub-btn hub-quick-submit';
  submit.textContent = 'Add';

  // Grow with the text: an idea that runs to three lines shouldn't be typed
  // through a one-line slot.
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  // One in flight at a time. Without this the second Enter — the reflex when
  // the first appears to do nothing — files the idea twice, because the text
  // now stays in the box until the task lands.
  let inFlight = false;
  // What was SAID, accumulated across utterances, for as long as the box still
  // holds the idea it belongs to.
  let spoken = '';
  const capture = () => {
    const text = input.value.trim();
    if (!text || inFlight) return;
    inFlight = true;
    submit.disabled = true;
    const quote = quoteForCapture(spoken);
    void handlers.onCapture(text, quote).then((ok) => {
      inFlight = false;
      submit.disabled = false;
      if (!ok) return;
      // The utterance belonged to the task that just landed. Carrying it into
      // the next one would file words about work nobody spoke about — but the
      // box stayed live while the POST was out, so anything dictated SINCE
      // belongs to the idea still sitting there. Same rule as the text below:
      // remove what was sent, keep the rest.
      spoken = quoteAfterCapture(spoken, quote);
      // Only what was sent. Anything typed while it was in flight is a second
      // idea, and clearing the whole box would take it with the first.
      input.value = input.value.trim() === text ? '' : input.value;
      autosize();
    });
  };
  input.addEventListener('input', () => {
    autosize();
    // Edited away: the idea the utterance belonged to is gone, so the
    // utterance goes with it — whether the box was cleared or retyped over
    // (a select-all retype is one input event with a NON-empty value, which
    // is how the previous "empty means forget" test let a retyped task file
    // the last idea's words). Correcting a misheard word keeps it; the rule
    // itself lives in the model.
    spoken = quoteAfterEdit(input.value, spoken);
  });
  // Enter submits, Shift+Enter is a newline — the convention every chat box
  // has, because this is the box people reach for instead of chat.
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      capture();
    } else if (ev.key === 'Escape') {
      input.blur();
    }
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    capture();
  });
  form.append(input, submit);
  container.append(form);

  if (!handlers.mountVoice) return;
  const mic = document.createElement('button');
  // Not a submit: a press-and-hold on a button inside a form files the box on
  // release in some browsers, which would send a half-dictated idea.
  mic.type = 'button';
  mic.className = 'hub-btn hub-quick-mic';
  // Names the key, because the hold is genuinely available from the keyboard
  // (the capture binds Space/Enter on this button) and nothing else on the
  // page would tell someone who never taps that it is.
  mic.setAttribute('aria-label', 'Hold to dictate a task — hold Space or Enter');
  mic.textContent = '🎤';
  const indicator = document.createElement('span');
  // Hidden until there is something to say — it takes a flex line of its own
  // (`flex-basis: 100%`), so mounting it visible puts a row-gap under the form
  // that vanishes for good the first time anything is dictated. The capture
  // un-hides it; this is the same start the board-wide dock's indicator has.
  indicator.className = 'hub-quick-mic-state hidden';
  indicator.setAttribute('aria-live', 'polite');
  // Before Add, not after: the two thumb targets on a phone are the box and
  // the mic, and Add is the one that ends the interaction.
  form.insertBefore(mic, submit);
  form.append(indicator);
  handlers.mountVoice({
    button: mic,
    indicator,
    deliver: (transcript) => {
      const next = appendDictation(input.value, transcript, spoken);
      input.value = next.text;
      spoken = next.quote;
      autosize();
      // So the next words land after these, and Enter files without a hunt
      // for the box.
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
  });
}

// ── Decisions strip ────────────────────────────────────────────────────────

export interface ReviewStripHandlers {
  /** Jump straight to where this one gets answered — the decision's panel,
   *  the task's discussion at that thread, the doc anchored on that comment.
   *  "Exactly the place", not the containing surface. */
  onOpen: (item: ReviewItem) => void;
  /** Go through all of them, one at a time. */
  onWalkthrough: () => void;
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What each kind is, in one glyph. The queue mixes three surfaces and the
 *  reader has to know which one a row will take them to before they tap it. */
const REVIEW_MARK: Record<ReviewKind, string> = {
  decision: '◆',
  blocker: '⛔',
  'task-thread': '💬',
  'doc-thread': '📄',
};
const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  decision: 'Decision',
  blocker: 'Your task, blocking',
  'task-thread': 'Task comment',
  'doc-thread': 'Doc comment',
};

/**
 * The read at the top of the board: what is waiting on you, in priority order,
 * across every surface this workspace has.
 *
 * This replaced a decisions-only strip. The reason is the whole feature: when
 * Bryan comes back to the board his question is "what do I look at next", and
 * a strip that only knew about decision tasks answered a narrower one — an
 * agent's question on a task and an unanswered doc comment were in the store
 * and unreachable from the board, which is the failure mode this codebase has
 * already been bitten by and which presents as the worst possible bug because
 * nothing is actually lost.
 *
 * Urgency is still DERIVED, never declared: "blocking work now" is the same
 * fact as "something depends on it", which `after` / `afterEnforce` already
 * record. There is no urgency field to set and none to keep up to date.
 */
export function renderReviewStrip(
  container: HTMLElement,
  queue: ReviewQueue,
  handlers: ReviewStripHandlers,
): void {
  container.replaceChildren();
  if (queue.total === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const head = document.createElement('div');
  head.className = 'hub-decisions-head';

  const count = document.createElement('button');
  count.type = 'button';
  count.className = 'hub-decisions-count';
  count.textContent = queue.total === 1 ? '1 thing needs you' : `${queue.total} things need you`;
  count.setAttribute('aria-label', `${count.textContent} — go through them one at a time`);
  count.addEventListener('click', () => handlers.onWalkthrough());

  const urgency = document.createElement('span');
  urgency.className = 'hub-decisions-urgency';
  // "0 blocking" reads like a metric nobody asked for; say the fact instead.
  const rest = queue.total - queue.blocking;
  urgency.textContent =
    queue.blocking === 0
      ? 'Nothing is blocked on them yet'
      : rest === 0
        ? `${queue.blocking} blocking work now`
        : `${queue.blocking} blocking work now · ${rest} can wait`;

  head.append(count, urgency);
  container.append(head);

  const chips = document.createElement('div');
  chips.className = 'hub-decision-chips';
  for (const item of queue.items) {
    const chip = document.createElement('button');
    chip.type = 'button';
    // Both banded kinds carry a row; read it through the one helper so a new
    // band cannot be styled as blocking on one line and not on the next.
    const row = reviewRow(item);
    const blocking = (row?.blocks.length ?? 0) > 0;
    chip.className = `hub-decision-chip hub-review-${item.kind}${blocking ? ' hub-decision-blocking' : ''}`;
    const mark = document.createElement('span');
    mark.className = 'hub-review-mark';
    mark.textContent = REVIEW_MARK[item.kind];
    mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'hub-decision-chip-title';
    label.textContent = clip(item.title);
    chip.append(mark, label);
    // The ask on a thread is the thing that tells you whether to open it —
    // "Ship the widget" alone is the container, not the question.
    if (item.ask) {
      const ask = document.createElement('span');
      // A question addressed to the reader is the one row on this strip they
      // can act on without opening anything, so it is marked as such rather
      // than left to read like the status notes it sits among.
      ask.className = item.thread?.direct
        ? 'hub-review-ask hub-review-ask--direct'
        : 'hub-review-ask';
      ask.textContent = clip(item.ask, 48);
      chip.append(ask);
    } else if (blocking) {
      const blocks = document.createElement('span');
      blocks.className = 'hub-decision-chip-blocks';
      blocks.textContent = `blocks ${row?.blocks.length}`;
      chip.append(blocks);
    }
    chip.title = `${REVIEW_KIND_LABEL[item.kind]}: ${item.title}${item.ask ? ` — ${item.ask}` : ''} · ${item.why}`;
    chip.addEventListener('click', () => handlers.onOpen(item));
    chips.append(chip);
  }
  container.append(chips);
}

// ── Decision walkthrough (six answers in one sitting) ──────────────────────

export interface WalkthroughHandlers {
  /** Record a verbatim answer. `optionId` rides along when the answer came
   *  from tapping one of the asker's candidates.
   *
   *  Resolves to whether the write LANDED. The advance is the confirmation
   *  that it did, so it has to follow the write rather than race it — and a
   *  refused write must leave the reader on the card with their words still in
   *  the box, which is the one direction that cannot lose anything. */
  onAnswer: (task: HubTask, text: string, optionId?: string) => Promise<boolean>;
  /** "I can't answer this yet" — a question back to the asker, not an answer.
   *  Deliberately does NOT advance: the decision stays open and this card is
   *  still the one that needs you. */
  onMoreInfo: (task: HubTask, question: string) => Promise<boolean>;
  /** Answer a thread without leaving the queue. Posts a reply on the thread the
   *  item came from, wherever that thread lives. */
  onReply: (item: ReviewItem, text: string) => Promise<boolean>;
  /** Go to the exact place instead of answering here — the task's discussion at
   *  that thread, the doc anchored on that comment. */
  onOpenItem: (item: ReviewItem) => void;
  /** Move to another position in the queue (skip forward, step back). */
  onStep: (index: number) => void;
  onClose: () => void;
}

/** The task's own description, or an honest line saying there isn't one.
 *  Shared by the decision and blocker cards — both are a task. */
function walkBody(task: HubTask): HTMLElement {
  const body = document.createElement('div');
  // `renderCommentMarkdown` escapes first and only adds known-safe tags, so a
  // body written by anyone with write access is inert markup either way.
  if (task.body?.trim()) {
    body.className = 'hub-walk-body';
    body.innerHTML = renderCommentMarkdown(task.body);
  } else {
    body.className = 'hub-walk-body hub-walk-body-empty';
    body.textContent = 'No context was written for this one.';
  }
  return body;
}

function blocksLine(row: DecisionRow): string {
  if (row.blocks.length === 0) return 'Nothing is waiting on this one.';
  const titles = row.blocks.map((t) => t.title);
  const shown = titles.slice(0, 3).join(', ');
  const rest = titles.length > 3 ? ` and ${titles.length - 3} more` : '';
  return `${row.hard ? 'Hard-blocking' : 'Blocking'} ${titles.length === 1 ? '1 task' : `${titles.length} tasks`}: ${shown}${rest}`;
}

/**
 * A textarea + submit pair; the submit is ignored when the field is blank.
 *
 * Locked while the write is in flight, for the same reason the discussion's
 * composer is: the walkthrough's answer does not come back through the POST —
 * a decision's answer arrives later over the ydoc — so between the tap and the
 * card swapping there is a window in which nothing on screen has changed and
 * the button still works. Every extra tap in that window is another recorded
 * answer.
 */
function promptForm(
  className: string,
  placeholder: string,
  submitLabel: string,
  onSubmit: (text: string) => Promise<boolean>,
): HTMLFormElement {
  const form = document.createElement('form');
  form.className = className;
  const ta = document.createElement('textarea');
  ta.placeholder = placeholder;
  ta.rows = 3;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'hub-btn hub-btn-primary';
  submit.textContent = submitLabel;
  form.append(ta, submit);
  // A flag, not just the disabled attributes: disabling the CONTROLS stops a
  // second tap, and a form can still be submitted around them (Enter in the
  // field, a programmatic submit). The guard has to be on the handler.
  let busy = false;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = ta.value.trim();
    if (!text || busy) return;
    busy = true;
    ta.disabled = true;
    submit.disabled = true;
    void Promise.resolve(onSubmit(text))
      .then((ok) => {
        // Cleared only on an acknowledged write. A handler that answers
        // nothing at all keeps the text, which is the safe direction: the
        // usual outcome there is that the card is replaced anyway.
        if (ok === true) ta.value = '';
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
        ta.disabled = false;
        submit.disabled = false;
      });
  });
  return form;
}

/** Back / skip. Shared by both card kinds, because "go through the list" is
 *  the feature and it must not stop working when the next item is a comment. */
function walkNav(index: number, total: number, handlers: WalkthroughHandlers): HTMLElement {
  const nav = document.createElement('div');
  nav.className = 'hub-walk-nav';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'hub-btn hub-walk-back';
  back.textContent = 'Back';
  back.disabled = index === 0;
  back.addEventListener('click', () => handlers.onStep(index - 1));
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'hub-btn hub-walk-skip';
  skip.textContent = index + 1 === total ? 'Skip — finish' : 'Skip for now';
  skip.addEventListener('click', () => handlers.onStep(index + 1));
  nav.append(back, skip);
  return nav;
}

/**
 * What this sitting has cleared so far.
 *
 * Without it the advance is invisible. The queue shrinks as it is worked, so
 * answering item 3 of 7 leaves you at "3 of 6" — the number that says WHERE
 * YOU ARE does not move, and the only thing that changed is a total that got
 * smaller. To a reader that is indistinguishable from "my answer did nothing"
 * or "the page reset", which is worse than not advancing at all, because they
 * cannot tell whether the answer landed.
 */
export interface WalkProgress {
  /** How many items this sitting has finished. */
  cleared: number;
  /** The one just finished. It is no longer in the queue, so Back cannot
   *  reach it — the banner is the only way back to something you answered by
   *  mistake, which is why it holds the whole item rather than a title. */
  last: ReviewItem | null;
}

/** How the thing you just finished reads in the banner. */
function clearedVerb(kind: ReviewKind): string {
  return kind === 'decision' ? 'Answered' : 'Replied on';
}

/**
 * "You just did that, here is the next one" — the half of the advance that
 * turns a jump-cut into a queue.
 */
function advancedBanner(progress: WalkProgress, handlers: WalkthroughHandlers): HTMLElement | null {
  const last = progress.last;
  if (!last) return null;
  const bar = document.createElement('div');
  bar.className = 'hub-walk-advanced';
  const said = document.createElement('span');
  said.className = 'hub-walk-advanced-said';
  said.textContent = `✓ ${clearedVerb(last.kind)} “${clip(last.title, 60)}”`;
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'hub-btn hub-walk-advanced-back';
  back.textContent = 'Back to it';
  // Not `onStep(index - 1)`: the answered item LEFT the queue, so stepping
  // back lands on whatever preceded it. Opening it where it lives is the only
  // route to the thing that was actually just answered.
  back.addEventListener('click', () => handlers.onOpenItem(last));
  bar.append(said, back);
  return bar;
}

/**
 * One item at a time, in the derived order, with the way out at every
 * step: tap one of the asker's options, write your own answer, ask for more
 * information, or skip. Six answers should be one sitting, not six
 * navigations — so the position and the queue live here rather than in six
 * separate detail-panel visits.
 *
 * `index` is the position in `queue.items`; past the end (or over an empty
 * queue) is the done state, and a negative index means closed.
 */
export function renderReviewWalkthrough(
  container: HTMLElement,
  queue: ReviewQueue,
  index: number,
  handlers: WalkthroughHandlers,
  progress: WalkProgress = { cleared: 0, last: null },
): void {
  container.replaceChildren();
  if (index < 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const panel = document.createElement('div');
  panel.className = 'hub-walk-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const item = queue.items[index];
  // Only a decision gets the answer furniture. A blocker carries the same row
  // shape but was never a question, so writing an `answer` onto it would be a
  // lie about what happened.
  const row = item?.decision;
  if (!item) {
    const done = document.createElement('div');
    done.className = 'hub-walk-done';
    // Answering the LAST one lands here, which makes this the likeliest moment
    // to want the item back — so the banner belongs on the finished screen too,
    // not only on the card that replaces something.
    const lastBanner = advancedBanner(progress, handlers);
    if (lastBanner) done.append(lastBanner);
    const h = document.createElement('h2');
    h.textContent = 'All caught up';
    const p = document.createElement('p');
    p.textContent = 'Nothing else is waiting on you right now.';
    done.append(h, p);
    // The count is what makes this an ENDING rather than an empty surface: a
    // sitting that cleared four things and one that found nothing waiting read
    // identically otherwise, and the first is the one worth finishing.
    if (progress.cleared > 0) {
      const tally = document.createElement('p');
      tally.className = 'hub-walk-done-tally';
      tally.textContent =
        progress.cleared === 1
          ? 'You cleared 1 in this sitting.'
          : `You cleared ${progress.cleared} in this sitting.`;
      done.append(tally);
    }
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'hub-btn hub-btn-primary';
    close.textContent = 'Back to the board';
    close.addEventListener('click', () => handlers.onClose());
    done.append(close);
    panel.append(done);
    container.append(panel);
    return;
  }

  const head = document.createElement('div');
  head.className = 'hub-walk-head';
  const pos = document.createElement('span');
  pos.className = 'hub-walk-pos';
  // Two readings, because the queue shrinks as it is worked and neither number
  // alone says you moved: where you are in what REMAINS, and what this sitting
  // has taken off the list.
  pos.textContent = `${index + 1} of ${queue.items.length}`;
  if (progress.cleared > 0) {
    const cleared = document.createElement('span');
    cleared.className = 'hub-walk-cleared';
    cleared.textContent = `${progress.cleared} cleared`;
    pos.append(cleared);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'hub-btn hub-walk-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close the walkthrough');
  close.addEventListener('click', () => handlers.onClose());
  head.append(pos, close);
  panel.append(head);

  const card = document.createElement('div');
  card.className = `hub-walk-card hub-walk-${item.kind}`;

  // First thing on the card, above the new item: what you just finished. It
  // belongs here rather than in a toast because this is read on a phone, where
  // a toast is gone before the thumb has come back down.
  const banner = advancedBanner(progress, handlers);
  if (banner) card.append(banner);

  const kind = document.createElement('p');
  kind.className = 'hub-walk-kind';
  kind.textContent = `${REVIEW_MARK[item.kind]} ${REVIEW_KIND_LABEL[item.kind]}`;
  card.append(kind);

  const title = document.createElement('h2');
  title.className = 'hub-walk-title';
  title.textContent = item.title;
  card.append(title);

  // ── A blocker: your own task, and the work standing behind it. There is
  // nothing to answer and nothing to reply to — the only move is to go and do
  // it — so the card says what is waiting and hands you the task.
  const blocker = item.blocker;
  if (blocker) {
    const blocks = document.createElement('p');
    blocks.className = 'hub-walk-blocks hub-walk-blocking';
    blocks.textContent = blocksLine(blocker);
    card.append(blocks, walkBody(blocker.task));
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'hub-btn hub-btn-primary hub-walk-open';
    open.textContent = 'Open the task';
    open.addEventListener('click', () => handlers.onOpenItem(item));
    card.append(open);
    panel.append(card);
    panel.append(walkNav(index, queue.items.length, handlers));
    container.append(panel);
    return;
  }

  // ── A thread: the question, a reply box, and the way out to the surface it
  // lives on. Answering here is the point — going through the queue must not
  // mean leaving the queue on every item — but a comment sometimes only makes
  // sense in place, so "open where this lives" is always offered.
  if (!row) {
    const ask = document.createElement('blockquote');
    ask.className = 'hub-walk-ask';
    ask.textContent = item.ask;
    const who = document.createElement('p');
    who.className = 'hub-walk-blocks';
    who.textContent = item.why;
    card.append(who, ask);
    card.append(
      promptForm('hub-walk-answer', 'Reply…', 'Reply', (text) => handlers.onReply(item, text)),
    );
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'hub-btn hub-walk-open';
    open.textContent =
      item.kind === 'task-thread' ? 'Open the task discussion' : 'Open the doc at this comment';
    open.addEventListener('click', () => handlers.onOpenItem(item));
    card.append(open);
    panel.append(card);
    panel.append(walkNav(index, queue.items.length, handlers));
    container.append(panel);
    return;
  }

  const task = row.task;

  const blocks = document.createElement('p');
  blocks.className = `hub-walk-blocks${row.blocks.length > 0 ? ' hub-walk-blocking' : ''}`;
  blocks.textContent = blocksLine(row);
  card.append(blocks);

  card.append(walkBody(task));

  if (task.infoRequests && task.infoRequests.length > 0) {
    const asked = document.createElement('p');
    asked.className = 'hub-walk-asked';
    const last = task.infoRequests[task.infoRequests.length - 1];
    asked.textContent = `You already asked: “${last?.text ?? ''}”`;
    card.append(asked);
  }

  if (task.options && task.options.length > 0) {
    const opts = document.createElement('div');
    opts.className = 'hub-walk-options';
    for (const o of task.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hub-walk-option';
      const label = document.createElement('span');
      label.className = 'hub-walk-option-label';
      label.textContent = o.label;
      b.append(label);
      if (o.detail) {
        const detail = document.createElement('span');
        detail.className = 'hub-walk-option-detail';
        detail.textContent = o.detail;
        b.append(detail);
      }
      // The option's label IS the verbatim answer; the id says which candidate
      // it was, so a shortcut and a typed answer land in the same field.
      b.addEventListener('click', () => handlers.onAnswer(task, o.label, o.id));
      opts.append(b);
    }
    card.append(opts);
  }

  // Always present, options or not: the candidates are a shortcut, never a
  // closed set.
  card.append(
    promptForm(
      'hub-walk-answer',
      task.options && task.options.length > 0
        ? 'Or answer in your own words…'
        : 'Record your answer, verbatim…',
      'Record answer',
      (text) => handlers.onAnswer(task, text),
    ),
  );
  card.append(
    promptForm(
      'hub-walk-info',
      "Not enough to decide? Ask for what's missing…",
      'Tell me more',
      (text) => handlers.onMoreInfo(task, text),
    ),
  );

  panel.append(card);
  panel.append(walkNav(index, queue.items.length, handlers));

  container.append(panel);
}

// ── Presence strip (§2.7) ──────────────────────────────────────────────────

export interface PresenceHandlers {
  /** Tap a chip to jump to where they are. */
  onTap: (chip: PresenceChip) => void;
  /** Long-press to follow — your view navigates when theirs does. */
  onLongPress: (chip: PresenceChip) => void;
}

const LONG_PRESS_MS = 550;

export function renderPresence(
  container: HTMLElement,
  chips: PresenceChip[],
  followedKey: string | null,
  handlers: PresenceHandlers,
  // A LIST, because "what is running where" has two independent answers: the
  // agents' plugin bundles and the browser's own client. They fail separately
  // and are fixed separately, so neither may hide the other.
  drift?: ReadonlyArray<DriftNotice | null | undefined> | null,
): void {
  container.replaceChildren();
  const notices = (drift ?? []).filter((d): d is DriftNotice => Boolean(d));
  if (chips.length === 0 && notices.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  for (const notice of notices) {
    // Beside the agents, because that is what it is about — and BEFORE the
    // early return that a chipless strip used to take: an away session draws
    // no chip, and an away session is the one most likely to be stranded on
    // a bundle that predates whatever was just merged.
    const note = document.createElement('div');
    // A coverage line is always on the board, so it gets the quiet treatment.
    // Styling it like the alarm would train people to skim past the alarm.
    note.className = notice.kind === 'coverage' ? 'hub-drift hub-drift-quiet' : 'hub-drift';
    note.innerHTML = `<span class="hub-drift-head">${escapeHtml(notice.headline)}</span><span class="hub-drift-who">${escapeHtml(notice.detail)}</span><span class="hub-drift-fix">${escapeHtml(notice.fix)}</span>`;
    container.append(note);
  }
  for (const chip of chips) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `hub-presence-chip hub-presence-${chip.kind}${chip.state ? ` hub-presence-${chip.state}` : ''}${followedKey === chip.key ? ' hub-following' : ''}`;
    el.title =
      followedKey === chip.key ? `${chip.title} · following — long-press to stop` : chip.title;
    el.innerHTML = `<span class="hub-presence-name">${escapeHtml(chip.label)}</span><span class="hub-presence-where">${escapeHtml(chip.where)}</span>`;
    // A long-press follows; a tap jumps. The press has TWO endings —
    // pointercancel is the common one on mobile — and both must disarm the
    // timer or one scroll wedges the strip.
    let timer: ReturnType<typeof setTimeout> | null = null;
    let longFired = false;
    const disarm = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    el.addEventListener('pointerdown', () => {
      longFired = false;
      disarm();
      timer = setTimeout(() => {
        longFired = true;
        handlers.onLongPress(chip);
      }, LONG_PRESS_MS);
    });
    el.addEventListener('pointerup', disarm);
    el.addEventListener('pointercancel', disarm);
    el.addEventListener('pointerleave', disarm);
    el.addEventListener('click', () => {
      if (!longFired) handlers.onTap(chip);
    });
    container.append(el);
  }
}

// ── Activity view (exactly two filters — §3.9) ─────────────────────────────

export function renderActivity(
  container: HTMLElement,
  events: ActivityEvent[],
  filter: ActivityFilter,
  titleOf: (taskId: string) => string,
  onFilter: (f: ActivityFilter) => void,
  uptime: UptimeReport | null = null,
): void {
  container.replaceChildren();
  // Deploy readiness (§3.12 commit 11): the 99% availability target (goal
  // 4.4) rendered where the after-the-fact review already happens. No report
  // yet (young log) → no banner, not a fake 100%.
  const summary = uptimeSummary(uptime);
  if (summary) {
    const banner = document.createElement('div');
    banner.className = `hub-uptime ${summary.ok ? 'hub-uptime-ok' : 'hub-uptime-miss'}`;
    const label = document.createElement('strong');
    label.className = 'hub-uptime-label';
    label.textContent = summary.label;
    const detail = document.createElement('span');
    detail.className = 'hub-uptime-detail';
    detail.textContent = summary.detail;
    banner.append(label, detail);
    container.append(banner);
  }
  const bar = document.createElement('div');
  bar.className = 'hub-activity-filters';
  for (const f of ['all', 'decisions'] as const) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `hub-tab${filter === f ? ' hub-tab-active' : ''}`;
    btn.textContent = f === 'all' ? 'All' : 'Decisions';
    btn.setAttribute('aria-pressed', String(filter === f));
    btn.addEventListener('click', () => onFilter(f));
    bar.append(btn);
  }
  container.append(bar);

  const rows = activityRows(events, filter);
  const list = document.createElement('div');
  list.className = 'hub-activity-list';
  if (rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hub-section-empty';
    empty.textContent =
      filter === 'decisions' ? 'No agent decisions recorded yet.' : 'No activity yet.';
    list.append(empty);
  }
  const now = Date.now();
  for (const ev of rows) {
    const row = document.createElement('div');
    row.className = 'hub-activity-row';
    const when = document.createElement('span');
    when.className = 'hub-activity-when';
    when.textContent = timeAgo(ev.ts, now);
    when.title = new Date(ev.ts).toLocaleString();
    const what = document.createElement('span');
    what.className = 'hub-activity-what';
    what.textContent = describeEvent(ev, titleOf);
    row.append(when, what);
    list.append(row);
  }
  container.append(list);
}

// ── Sidebars ───────────────────────────────────────────────────────────────

export interface SidebarDoc {
  docId: string;
  label: string;
  url: string;
}

export function renderDocsSidebar(container: HTMLElement, docs: SidebarDoc[]): void {
  container.replaceChildren();
  const head = document.createElement('h2');
  head.className = 'hub-side-title';
  head.textContent = 'Docs';
  container.append(head);
  if (docs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hub-section-empty';
    empty.textContent = 'No docs attached.';
    container.append(empty);
    return;
  }
  const list = document.createElement('ul');
  list.className = 'hub-side-list';
  for (const doc of docs) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = doc.url;
    a.textContent = doc.label;
    a.title = doc.docId;
    li.append(a);
    list.append(li);
  }
  container.append(list);
}

export interface SidebarThread {
  docId: string;
  threadId: string;
  label: string;
  url: string;
  commentCount: number;
}

export function renderThreadsSidebar(container: HTMLElement, threads: SidebarThread[]): void {
  container.replaceChildren();
  const head = document.createElement('h2');
  head.className = 'hub-side-title';
  head.textContent = threads.length > 0 ? `Open threads (${threads.length})` : 'Open threads';
  container.append(head);
  if (threads.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hub-section-empty';
    empty.textContent = 'No open threads.';
    container.append(empty);
    return;
  }
  const list = document.createElement('ul');
  list.className = 'hub-side-list';
  for (const t of threads) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = t.url;
    a.textContent = t.label;
    a.title = `${t.docId} · ${t.commentCount} comment${t.commentCount === 1 ? '' : 's'}`;
    li.append(a);
    list.append(li);
  }
  container.append(list);
}

// ── Task detail (opens instantly, no transition — §3.9) ────────────────────

/**
 * A meta row whose value is long prose: the clip inline, the whole thing
 * behind a tap. Nothing is dropped — `full` is in the DOM the moment the
 * reader asks for it, and the toggle is a `<button>` so a thumb can reach it.
 *
 * Re-renders in place rather than toggling a CSS class, so the collapsed row
 * is short in the DOM as well as on screen — a hidden 180-word paragraph is
 * still 180 words for anything reading the panel out loud.
 */
function addCollapsibleMeta(meta: HTMLElement, key: string, full: string): void {
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.className = 'hub-meta-collapsible';
  const short = clipGoal(full);
  const paint = (expanded: boolean): void => {
    dd.replaceChildren();
    const text = document.createElement('span');
    text.textContent = expanded ? full : short;
    dd.append(text);
    if (short === full) return;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'hub-meta-more';
    more.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    more.textContent = expanded ? 'Less' : 'More';
    more.addEventListener('click', () => paint(!expanded));
    dd.append(more);
  };
  paint(false);
  meta.append(dt, dd);
}

export interface DetailHandlers {
  onClose: () => void;
  onStatusSet: (task: HubTask, to: TaskStatus) => void;
  onTitleCommit: (task: HubTask, title: string) => void;
  /** `optionId` is set only when the answer came from tapping a candidate;
   *  `text` is the verbatim answer either way. */
  onAnswer: (task: HubTask, text: string, optionId?: string) => void;
  onAssign: (task: HubTask, assignee: string) => void;
  /** The agents currently attached to this workspace — see `BoardHandlers`. */
  knownAgentIds?: string[];
  /** Names the goal the way the board's own section header does — pass
   *  `hub-model`'s `goalLabel`, which resolves subgoals and Chores. The panel
   *  is where a reader goes to find out what a task is FOR, so an id is a
   *  fact about the store rather than an answer. Optional, and without it the
   *  row falls back to the id — a missing lookup must not blank it. */
  goalLabel?: (goalId: string) => string;
  /** A comment on the task. With `threadId` it is a reply; without one it
   *  opens a new thread about the task itself. */
  onComment?: (task: HubTask, text: string, threadId?: string) => Promise<boolean>;
  /** The one thread the reader was sent here to answer, when they arrived
   *  from the review queue. Marked and scrolled to — "open the task" is not
   *  the promise the strip makes on a task with six discussions. */
  focusThreadId?: string;
  /**
   * Which conversation the single composer is pointed at: a thread id, `null`
   * for a new thread, `undefined` for "nobody has chosen" (take the default).
   *
   * Three states rather than two, because the default has to be re-derivable
   * on every repaint AND an explicit choice has to survive one. A repaint that
   * re-applied the default would silently move a reader who had just tapped
   * "New thread" back onto a reply.
   */
  replyThreadId?: string | null;
  /** Point the composer somewhere else. `null` means a new thread. */
  onReplyTarget?: (threadId: string | null) => void;
}

export interface TaskComment {
  author: string;
  text: string;
  ts: number;
}

export interface TaskThread {
  id: string;
  status: 'open' | 'resolved';
  comments: TaskComment[];
  /**
   * The passage of the task's description this thread hangs off, when it has
   * one. Absent for a subject-anchored thread, which is about the task as a
   * whole.
   *
   * This is what makes a task's threads distinguishable, and the surface used
   * to throw it away: on the live board 34 of 37 task threads carry one (they
   * are agents' `create_thread(docId: 'task:…', find: …)` calls) and only 3 do
   * not. Rendering author-and-text alone turned every one of them into an
   * indistinguishable pile, which is the reason a reply needed a box of its
   * own to be routable at all.
   */
  anchorText?: string;
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

/**
 * A comment box that submits its trimmed text and clears itself. Shared by
 * the new-thread composer and every reply, so "empty posts nothing" is one
 * rule rather than one per box.
 *
 * The box empties only once the post is ACKNOWLEDGED. A handler that returns
 * a promise resolving `false` (or that rejects) leaves the text where it is:
 * a comment lost to a dropped connection is worse than one that never sent,
 * because the box is empty, the toast is gone in seconds, and the person
 * believes they said it. A handler that never resolves true
 * therefore keeps its text — the safe direction.
 */
function commentForm(
  className: string,
  placeholder: string,
  submitLabel: string,
  onSubmit: (text: string) => Promise<boolean>,
): HTMLFormElement {
  const form = document.createElement('form');
  form.className = className;
  const ta = document.createElement('textarea');
  ta.placeholder = placeholder;
  ta.rows = 2;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'hub-btn';
  submit.textContent = submitLabel;
  form.append(ta, submit);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    ta.disabled = true;
    submit.disabled = true;
    // `Promise.resolve` rather than `await onSubmit(...)` so a handler that
    // returns nothing at all still settles here instead of throwing.
    void Promise.resolve(onSubmit(text))
      .then((ok) => {
        if (ok) ta.value = '';
      })
      .catch(() => {})
      .finally(() => {
        ta.disabled = false;
        submit.disabled = false;
      });
  });
  return form;
}

/**
 * The task's Discussion.
 *
 * This is the whole point of the panel for a reviewer: the board used to
 * offer a LINK to the task doc and nothing else, so disagreeing with a task
 * cost a navigation — which in practice meant saying it in chat instead,
 * where it reaches nobody the task reaches.
 */
/**
 * Whether someone is mid-sentence in the discussion's composer.
 *
 * A live refresh repaints the panel, and a repaint rebuilds the composer —
 * so refreshing under someone's hands deletes what they were typing. This
 * is deliberately one-directional: the worst it can do is make a reply
 * appear when the reader stops typing rather than the instant it lands.
 */
export function discussionIsBusy(root: ParentNode): boolean {
  const composers = [...root.querySelectorAll<HTMLTextAreaElement>('.hub-discussion textarea')];
  return composers.some((ta) => ta.value.trim() !== '' || ta === ta.ownerDocument.activeElement);
}

/**
 * Which conversation the composer is pointed at, and whether that thread is
 * still there to be pointed at.
 *
 * `undefined` from the caller means nobody has chosen, so take the default:
 * the thread the review queue aimed at, else the last one on screen — which is
 * the thread the composer sits directly under, and on the common single-thread
 * task is the only reply anyone means. `null` is an explicit "new thread" and
 * survives repaints. A chosen id that no longer resolves falls back to a new
 * thread rather than to a box that posts nowhere.
 */
export function composerTarget(
  threads: TaskThread[],
  chosen: string | null | undefined,
  focusThreadId?: string,
): TaskThread | null {
  const wanted =
    chosen === undefined ? (focusThreadId ?? threads[threads.length - 1]?.id ?? null) : chosen;
  if (wanted === null) return null;
  return threads.find((t) => t.id === wanted) ?? null;
}

/** How a thread reads when it has to be named in one line: the passage of the
 *  description it hangs off, else who opened it. */
function threadLabel(t: TaskThread): string {
  const anchor = t.anchorText?.trim();
  if (anchor) return `“${clip(anchor.replace(/\s+/g, ' '), 44)}”`;
  const who = t.comments[0]?.author;
  return who ? `${who}’s thread` : 'this thread';
}

/**
 * The task's Discussion.
 *
 * ONE composer, always at the bottom, whose target is named above it.
 *
 * It used to be N + 1 — a reply box inside every thread plus a new-thread box
 * under them all — so the ordinary single-thread task ended in two stacked
 * boxes whose only difference was placeholder text. Bryan read that as "why do
 * I have two reply boxes… are we supporting threaded replies unnecessarily?",
 * and the honest answer is that threading is doing real work here (see
 * `TaskThread.anchorText`) but the surface was hiding the evidence of it and
 * then asking the reader to disambiguate anyway.
 *
 * So the fix is not fewer threads, it is: show what each thread is ABOUT, and
 * charge one decision instead of two. Anything proposing a second always-present
 * composer is proposing that state again — see docs/product/decisions.md.
 */
function renderDiscussion(
  task: HubTask,
  discussion: TaskDiscussion,
  onComment: (task: HubTask, text: string, threadId?: string) => Promise<boolean>,
  focusThreadId?: string,
  replyThreadId?: string | null,
  onReplyTarget?: (threadId: string | null) => void,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'hub-discussion';

  const h = document.createElement('h3');
  h.className = 'hub-detail-subhead';
  h.textContent = 'Discussion';
  section.append(h);

  if (discussion.loading) {
    const p = document.createElement('p');
    p.className = 'hub-discussion-loading';
    p.textContent = 'Loading the discussion…';
    section.append(p);
  } else if (discussion.threads.length === 0) {
    const p = document.createElement('p');
    p.className = 'hub-discussion-empty';
    p.textContent = 'No comments yet.';
    section.append(p);
  }

  const target = composerTarget(discussion.threads, replyThreadId, focusThreadId);

  for (const t of discussion.threads) {
    const el = document.createElement('div');
    // Resolved threads stay VISIBLE. A resolved thread is still part of the
    // argument, and hiding one here would repeat the drawer bug where a reply
    // existed in the store with no surface that could reach it.
    el.className = `hub-thread${t.status === 'resolved' ? ' resolved' : ''}${
      t.id === focusThreadId ? ' hub-thread-focus' : ''
    }${t.id === target?.id ? ' hub-thread-target' : ''}`;
    el.dataset.threadId = t.id;
    if (t.status === 'resolved') {
      const badge = document.createElement('span');
      badge.className = 'hub-thread-status';
      badge.textContent = 'Resolved';
      el.append(badge);
    }
    // What this conversation is about. Without it two threads on one task are
    // two piles of comments, and picking between them is guesswork.
    const anchor = t.anchorText?.trim();
    if (anchor) {
      const quote = document.createElement('blockquote');
      quote.className = 'hub-thread-anchor';
      quote.textContent = clip(anchor.replace(/\s+/g, ' '), 140);
      el.append(quote);
    }
    for (const c of t.comments) {
      const row = document.createElement('div');
      row.className = 'hub-comment';
      const who = document.createElement('span');
      who.className = 'hub-comment-author';
      who.textContent = c.author;
      who.title = new Date(c.ts).toLocaleString();
      const body = document.createElement('div');
      body.className = 'hub-comment-body';
      // Same escape-then-allow-known-tags path the description uses, so a
      // comment written by anyone with write access is inert markup.
      body.innerHTML = renderCommentMarkdown(c.text);
      row.append(who, body);
      el.append(row);
    }
    // A button rather than a box. Pointing the one composer at this thread is
    // the whole job, and it is also the only way back to a thread once the
    // composer has been switched to a new one — including a RESOLVED thread,
    // which stays replyable exactly as it was.
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'hub-btn hub-thread-reply';
    reply.textContent = t.id === target?.id ? 'Replying below' : 'Reply';
    reply.setAttribute('aria-pressed', t.id === target?.id ? 'true' : 'false');
    reply.addEventListener('click', () => onReplyTarget?.(t.id));
    el.append(reply);
    section.append(el);
  }

  const form = commentForm(
    'hub-comment-form',
    target ? `Reply to ${threadLabel(target)}…` : 'Say something about this task…',
    target ? 'Reply' : 'Comment',
    (text) => onComment(task, text, target?.id),
  );
  // The target row rides INSIDE the form, above the box, so what the button
  // will do is readable without moving your eyes off it. Omitted when there is
  // nothing to disambiguate — a task with no threads has one possible action.
  if (discussion.threads.length > 0) {
    const bar = document.createElement('div');
    bar.className = 'hub-composer-target';
    const label = document.createElement('span');
    label.className = 'hub-composer-target-label';
    label.textContent = target ? `Replying to ${threadLabel(target)}` : 'Starting a new thread';
    bar.append(label);
    // One-directional: this switches AWAY from a thread. The way back is the
    // Reply button on the thread itself, which names which one — a generic
    // "reply instead" here could not.
    if (target) {
      const fresh = document.createElement('button');
      fresh.type = 'button';
      fresh.className = 'hub-btn hub-composer-switch';
      fresh.textContent = 'New thread';
      fresh.addEventListener('click', () => onReplyTarget?.(null));
      bar.append(fresh);
    }
    form.prepend(bar);
  }
  section.append(form);
  return section;
}

/** How a piece of evidence reads in the history: the commit if there is one,
 *  else the fact that a thread was cited. */
function evidenceLabel(evidence: HubEvidence | undefined): string {
  const commit = shortCommit(evidence?.commit);
  if (commit) return `commit ${commit}`;
  return evidence?.threadRef !== undefined ? 'thread ref' : '';
}

/**
 * One row of a task's audit trail, and the only surface that tells the whole
 * truth about how well proven a move is.
 *
 * Three states, and the middle one is the reason this exists:
 *
 *  - no proof at all → marked `unproven`, which is the board's shading;
 *  - proof that was later CORRECTED → never unproven, before or after, so
 *    the shading is silent about it. The superseded commit is struck here
 *    instead, because a sha that resolves to nothing reads as evidence and
 *    nothing looks wrong until someone tries to follow it;
 *  - proof attached after the fact → the mark clears (there IS proof now),
 *    and the row keeps the narrower fact that it arrived late.
 */
function renderTransitionRow(t: HubTransition): HTMLLIElement {
  const li = document.createElement('li');
  li.title = new Date(t.ts).toLocaleString();
  const head = document.createElement('span');
  const bits = [`${t.by.name} · ${t.from} → ${t.to}`];
  if (t.note) bits.push(t.note);
  head.textContent = bits.join(' — ');
  li.append(head);

  const original = evidenceLabel(t.evidence);
  if (original) {
    const span = document.createElement('span');
    span.className = evidenceSuperseded(t) ? 'hub-evidence-superseded' : 'hub-evidence';
    span.textContent = ` — ${original}`;
    if (evidenceSuperseded(t)) span.title = 'Superseded by a later correction — do not follow this';
    li.append(span);
  }

  if (transitionUnproven(t)) {
    li.classList.add('unproven');
    const mark = document.createElement('span');
    mark.className = 'hub-unproven-mark';
    mark.textContent = ' — no evidence';
    li.append(mark);
  }

  for (const a of t.amendments ?? []) {
    const line = document.createElement('div');
    line.className = 'hub-evidence-amendment';
    const label = evidenceLabel(a.evidence) || 'evidence';
    const parts = [
      `${label} added by ${a.by.name}${a.supersedes !== undefined ? ', replacing the entry above' : ''}`,
    ];
    if (a.note) parts.push(a.note);
    line.textContent = parts.join(' — ');
    line.title = new Date(a.ts).toLocaleString();
    li.append(line);
  }
  return li;
}

export function renderTaskDetail(
  container: HTMLElement,
  task: HubTask | null,
  handlers: DetailHandlers,
  discussion?: TaskDiscussion,
): void {
  container.replaceChildren();
  if (!task) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  const panel = document.createElement('div');
  panel.className = 'hub-detail-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'hub-detail-head';
  const title = document.createElement('h2');
  title.className = 'hub-detail-title';
  title.textContent = task.title;
  wireInPlaceTitle(
    title,
    () => task.title,
    (v) => handlers.onTitleCommit(task, v),
  );
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'hub-btn hub-detail-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close task detail');
  close.addEventListener('click', () => handlers.onClose());
  head.append(title, close);
  panel.append(head);

  const statuses = document.createElement('div');
  statuses.className = 'hub-detail-statuses';
  for (const s of ['todo', 'in-progress', 'done'] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `hub-status-chip hub-chip-${s}${task.status === s ? ' hub-chip-current' : ''}`;
    b.textContent = STATUS_LABEL[s];
    b.disabled = task.status === s;
    b.addEventListener('click', () => handlers.onStatusSet(task, s));
    statuses.append(b);
  }
  panel.append(statuses);

  const meta = document.createElement('dl');
  meta.className = 'hub-detail-meta';
  const addMeta = (k: string, v: string) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    meta.append(dt, dd);
  };
  // Assignee is the one meta row that is also a control — handing a task over
  // is a gesture, not a fact to read (§3.6 task.assigned).
  {
    const dt = document.createElement('dt');
    dt.textContent = 'Assignee';
    const dd = document.createElement('dd');
    dd.append(
      assigneePicker('hub-assignee-btn', task, handlers.knownAgentIds, (to) =>
        handlers.onAssign(task, to),
      ),
    );
    meta.append(dt, dd);
  }
  addMeta('Goal', handlers.goalLabel?.(task.goal) ?? task.goal);
  if (task.riskTier) addMeta('Risk', task.riskTier);
  if (task.dueAt !== undefined) addMeta('Due', new Date(task.dueAt).toLocaleDateString());
  if (task.after.length > 0) addMeta('After', task.after.join(', '));
  if (task.triagedAgainst) {
    // The goal text this task was judged against, verbatim, on every task —
    // identical across the whole board, so at full length it pushes the one
    // thing that DOES differ (the description) off the screen while telling
    // two tasks apart not at all. No stored summary applies: this is the
    // goal as it stood at triage time, which may no longer be the goal.
    addCollapsibleMeta(meta, 'Triaged against', task.triagedAgainst.goal);
  }
  panel.append(meta);

  const linkChips = renderTaskLinks(task);
  if (linkChips) panel.append(linkChips);

  if (task.quote) {
    // An unlabelled blockquote above a rewritten description is silent about
    // what it is, and the two readings it invites want opposite reactions:
    // "here is what you said, check I understood it" versus "here is a source
    // somebody chose to quote". The label settles it.
    //
    // ONE label serves every quote, because `quote` has exactly one meaning.
    // All four writers fill it with the words the task came from, verbatim: a
    // dictated capture transcript (`quoteForCapture`), the human's words on a
    // chat-born `create_tasks` row, the latest HUMAN comment on a
    // `promote_to_task` (agent replies are excluded there by design), and the
    // row's own pre-rewrite title-and-body preserved by `updateBodySnapshot`.
    // None of them is an author-chosen quotation, so the field needs no way to
    // say which kind it is and the label cannot lie on a kind it doesn't cover.
    //
    // "Original words" rather than anything that names a person: the preserved
    // pre-rewrite body of an agent-created row is not something a human said,
    // so "in their words" / "what Bryan said" would be false on that case — and
    // a label that lies is worse than no label. `figure` + `figcaption` is the
    // markup for a quotation with its own attribution, so the caption is read
    // as belonging to the quote rather than as a heading over the panel.
    const fig = document.createElement('figure');
    fig.className = 'hub-detail-quote-block';
    const cap = document.createElement('figcaption');
    cap.className = 'hub-detail-quote-label';
    cap.textContent = 'Original words';
    cap.title = 'The words this task came from, kept verbatim.';
    const q = document.createElement('blockquote');
    q.className = 'hub-detail-quote';
    q.textContent = task.quote;
    fig.append(cap, q);
    panel.append(fig);
  }

  if (task.answer) {
    const ans = document.createElement('p');
    ans.className = 'hub-detail-answer';
    ans.textContent = `Answered by ${task.answer.by}: “${task.answer.text}”`;
    panel.append(ans);
  } else if (task.needs === 'decision') {
    // The walkthrough is not the only way in — a chip or a board row lands
    // here, and options the asker supplied have to be tappable from both.
    if (task.options && task.options.length > 0) {
      const opts = document.createElement('div');
      opts.className = 'hub-detail-options';
      for (const o of task.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hub-detail-option';
        const label = document.createElement('span');
        label.className = 'hub-detail-option-label';
        label.textContent = o.label;
        b.append(label);
        if (o.detail) {
          const detail = document.createElement('span');
          detail.className = 'hub-detail-option-detail';
          detail.textContent = o.detail;
          b.append(detail);
        }
        b.addEventListener('click', () => handlers.onAnswer(task, o.label, o.id));
        opts.append(b);
      }
      panel.append(opts);
    }
    const form = document.createElement('form');
    form.className = 'hub-answer-form';
    const ta = document.createElement('textarea');
    ta.placeholder = 'Record your answer, verbatim…';
    ta.rows = 3;
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'hub-btn hub-btn-primary';
    submit.textContent = 'Record answer';
    form.append(ta, submit);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = ta.value.trim();
      if (text) handlers.onAnswer(task, text);
    });
    panel.append(form);
  }

  // The description reads HERE. It used to be a link and nothing else, so
  // "what is this task for" cost a navigation and the board read as a list of
  // bare titles — the store had the description and no surface showed it.
  // `renderCommentMarkdown` escapes first and only adds known-safe tags, so a
  // body written by anyone with write access is inert markup either way.
  const desc = document.createElement('div');
  if (task.body?.trim()) {
    desc.className = 'hub-detail-body';
    desc.innerHTML = renderCommentMarkdown(task.body);
  } else {
    desc.className = 'hub-detail-body-empty';
    desc.textContent = 'No description yet.';
  }
  panel.append(desc);

  if (task.bodyTruncated) {
    const more = document.createElement('p');
    more.className = 'hub-detail-body-more';
    more.textContent = 'Shortened here — the full description is in the task doc.';
    panel.append(more);
  }

  const body = document.createElement('p');
  body.className = 'hub-detail-body-link';
  const bodyLink = document.createElement('a');
  bodyLink.href = `/review/${encodeURIComponent(task.bodyDocId)}`;
  // No longer "or comment" — commenting happens right below, and sending
  // someone elsewhere to do it is what this section replaces.
  bodyLink.textContent = task.body?.trim()
    ? 'Edit the task doc'
    : 'Write the description in the task doc';
  body.append(bodyLink);
  panel.append(body);

  if (discussion && handlers.onComment) {
    panel.append(
      renderDiscussion(
        task,
        discussion,
        handlers.onComment,
        handlers.focusThreadId,
        handlers.replyThreadId,
        handlers.onReplyTarget,
      ),
    );
  }

  if (task.transitions.length > 0) {
    const h = document.createElement('h3');
    h.className = 'hub-detail-subhead';
    h.textContent = 'History';
    panel.append(h);
    const list = document.createElement('ul');
    list.className = 'hub-detail-transitions';
    for (const t of [...task.transitions].reverse()) {
      list.append(renderTransitionRow(t));
    }
    panel.append(list);
  }

  container.addEventListener('click', (ev) => {
    if (ev.target === container) handlers.onClose();
  });
  container.append(panel);
  // After it is in the document — scrollIntoView on a detached node does
  // nothing, silently. Guarded because happy-dom has no implementation.
  const focus = handlers.focusThreadId
    ? panel.querySelector<HTMLElement>(
        `.hub-thread[data-thread-id="${CSS.escape(handlers.focusThreadId)}"]`,
      )
    : null;
  if (focus && typeof focus.scrollIntoView === 'function') {
    focus.scrollIntoView({ block: 'center' });
  }
}
