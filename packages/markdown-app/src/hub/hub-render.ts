/**
 * DOM renderers for the workspace hub (plan §3.9). Each function re-renders
 * one region into its container from the view model — no fetches, no Yjs —
 * so the interaction contracts (the status dropdown, in-place title edits,
 * the two-filter activity view) are testable under happy-dom.
 */
import { escapeHtml } from '@feedback/core';
import { renderCommentMarkdown } from '../comment-markdown.ts';
import {
  type ActivityEvent,
  type ActivityFilter,
  type BoardSection,
  type HubTask,
  type PresenceChip,
  TASK_STATUS_ORDER,
  type TaskStatus,
  type UptimeReport,
  activityRows,
  describeEvent,
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
 */
function wireInPlaceTitle(
  el: HTMLElement,
  current: () => string,
  commit: (v: string) => void,
): void {
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
  onGoalCommit: (goal: string) => void;
}

/** Read-first, editable in place, markdown (§3.9). Empty goal → the §3.9
 *  "start planning" lead-in instead of an empty strip. */
export function renderGoalStrip(
  container: HTMLElement,
  goal: string,
  handlers: GoalStripHandlers,
): void {
  container.replaceChildren();
  const body = document.createElement('div');
  body.className = 'hub-goal-body';
  if (goal.trim()) {
    body.innerHTML = renderCommentMarkdown(goal);
  } else {
    body.innerHTML =
      '<p class="hub-goal-empty">No goal yet — start planning: set the goal this workspace drives toward.</p>';
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
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save goal';
    save.className = 'hub-btn hub-btn-primary';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.className = 'hub-btn';
    save.addEventListener('click', () => handlers.onGoalCommit(ta.value));
    cancel.addEventListener('click', () => renderGoalStrip(container, goal, handlers));
    const row = document.createElement('div');
    row.className = 'hub-goal-editor-actions';
    row.append(save, cancel);
    editor.append(ta, row);
    container.replaceChildren(editor);
    ta.focus();
  });
  container.append(body, edit);
}

// ── Board ──────────────────────────────────────────────────────────────────

export interface BoardHandlers {
  /** The row's status dropdown picked `to` — an arbitrary status, not a step
   *  along a cycle. Same shape as the detail panel's, deliberately. */
  onStatusSet: (task: HubTask, to: TaskStatus) => void;
  onGoalTitleCommit: (sectionId: string, title: string) => void;
  onOpenTask: (task: HubTask) => void;
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
  if (task.assignee && task.assignee !== 'agent') add('hub-badge-assignee', task.assignee);
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

  const dot = riskDot(task);
  const title = document.createElement('span');
  title.className = 'hub-task-title';
  title.textContent = task.title;
  // NOT editable in place. The title spans most of the row, and its click
  // handler stopped propagation to enter edit mode — so on a phone, where the
  // title is nearly the whole row, tapping a task could only ever rename it.
  // "I can't open a task to see what's inside" was the report. Renaming lives
  // in the detail panel, which is now one tap away from anywhere on the row.
  title.title = 'Tap to open';

  row.append(chip, dot, title, taskBadges(task));
  row.addEventListener('click', () => handlers.onOpenTask(task));
  row.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !(ev.target as HTMLElement).closest('input')) {
      handlers.onOpenTask(task);
    }
  });
  return row;
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
}

// ── Decisions strip ────────────────────────────────────────────────────────

export function renderDecisions(
  container: HTMLElement,
  rows: HubTask[],
  onOpen: (task: HubTask) => void,
): void {
  container.replaceChildren();
  if (rows.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  const label = document.createElement('span');
  label.className = 'hub-decisions-label';
  label.textContent = rows.length === 1 ? '1 open decision' : `${rows.length} open decisions`;
  container.append(label);
  for (const task of rows) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'hub-decision-chip';
    chip.textContent = task.title.length > 60 ? `${task.title.slice(0, 59)}…` : task.title;
    chip.title = task.title;
    chip.addEventListener('click', () => onOpen(task));
    container.append(chip);
  }
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
): void {
  container.replaceChildren();
  if (chips.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
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

export interface DetailHandlers {
  onClose: () => void;
  onStatusSet: (task: HubTask, to: TaskStatus) => void;
  onTitleCommit: (task: HubTask, title: string) => void;
  onAnswer: (task: HubTask, text: string) => void;
  onAssign: (task: HubTask, assignee: string) => void;
}

/** The hand-off toggle's other end. Named assignees (a specific agent) are
 *  set from the tools; the board's one-tap gesture is the human/agent flip,
 *  which is the hand-off that actually happens minute to minute. */
export function otherAssignee(assignee: string): string {
  return assignee === 'human' ? 'agent' : 'human';
}

export function renderTaskDetail(
  container: HTMLElement,
  task: HubTask | null,
  handlers: DetailHandlers,
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
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hub-assignee-btn';
    btn.textContent = task.assignee;
    const to = otherAssignee(task.assignee);
    btn.title = `Assign to ${to}`;
    btn.setAttribute('aria-label', `Assignee ${task.assignee} — assign to ${to}`);
    btn.addEventListener('click', () => handlers.onAssign(task, to));
    dd.append(btn);
    meta.append(dt, dd);
  }
  addMeta('Goal', task.goal);
  if (task.riskTier) addMeta('Risk', task.riskTier);
  if (task.dueAt !== undefined) addMeta('Due', new Date(task.dueAt).toLocaleDateString());
  if (task.after.length > 0) addMeta('After', task.after.join(', '));
  if (task.triagedAgainst) {
    addMeta('Triaged against', task.triagedAgainst.goal);
  }
  panel.append(meta);

  const linkChips = renderTaskLinks(task);
  if (linkChips) panel.append(linkChips);

  if (task.quote) {
    const q = document.createElement('blockquote');
    q.className = 'hub-detail-quote';
    q.textContent = task.quote;
    panel.append(q);
  }

  if (task.answer) {
    const ans = document.createElement('p');
    ans.className = 'hub-detail-answer';
    ans.textContent = `Answered by ${task.answer.by}: “${task.answer.text}”`;
    panel.append(ans);
  } else if (task.needs === 'decision') {
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

  const body = document.createElement('p');
  body.className = 'hub-detail-body-link';
  const bodyLink = document.createElement('a');
  bodyLink.href = `/review/${encodeURIComponent(task.bodyDocId)}`;
  bodyLink.textContent = 'Open the task doc (live, commentable)';
  body.append(bodyLink);
  panel.append(body);

  if (task.transitions.length > 0) {
    const h = document.createElement('h3');
    h.className = 'hub-detail-subhead';
    h.textContent = 'History';
    panel.append(h);
    const list = document.createElement('ul');
    list.className = 'hub-detail-transitions';
    for (const t of [...task.transitions].reverse()) {
      const li = document.createElement('li');
      const bits = [`${t.by.name} · ${t.from} → ${t.to}`];
      if (t.note) bits.push(t.note);
      if (t.evidence?.commit) bits.push(`commit ${t.evidence.commit.slice(0, 10)}`);
      li.textContent = bits.join(' — ');
      li.title = new Date(t.ts).toLocaleString();
      list.append(li);
    }
    panel.append(list);
  }

  container.addEventListener('click', (ev) => {
    if (ev.target === container) handlers.onClose();
  });
  container.append(panel);
}
