/**
 * DOM renderers for the workspace hub (plan §3.9). Each function re-renders
 * one region into its container from the view model — no fetches, no Yjs —
 * so the interaction contracts (the status dropdown, in-place title edits,
 * the two-filter activity view) are testable under happy-dom.
 */
import { type ReviewPayload, reviewAnswered, reviewWithdrawn } from '@feedback/core';
import type { ReviewShape, Thread, User } from '@feedback/core';
import {
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
import {} from '@feedback/core/goal-summary';
import { renderCommentMarkdown } from '../comment-markdown.ts';
import { MIC_ICON, PEOPLE_ICON, PLUS_ICON } from '../icons.ts';
import {
  type ComposerSelection,
  composerSelection,
  composerState,
  focusMarkdownComposer,
  isComposerFocused,
  refreshMarkdownComposer,
} from '../md-composer.ts';
import {
  type ActivityEvent,
  type ActivityFilter,
  type BlockerRow,
  type BoardSection,
  GENERIC_ASSIGNEE,
  type HomePayload,
  type HubDecisionOption,
  type HubGoal,
  type HubReviewItem,
  type HubTask,
  type HubTransition,
  type LeadSeatView,
  type ReviewQueue,
  type ReviewThreadItem,
  TASK_STATUS_ORDER,
  type TaskStatus,
  type UptimeReport,
  activityRows,
  assigneeLabel,
  decisionAskedBy,
  describeEvent,
  homeSinceLabel,
  leadSeatLabel,
  ownerKindSuffix,
  ownerMarkKind,
  reviewBannerText,
  statusLabel,
  statusOptions,
  timeAgo,
  uptimeSummary,
} from './hub-model.ts';
import { caretOffsetIn } from './inline-rename.ts';

/**
 * Swap a title element for an input; Enter commits, Escape or blur cancels
 * (§3.9: tap the title text to edit, Enter commits). Cancel restores the
 * original text — the caller re-renders on commit anyway.
 *
 * Enter/F2 on the element itself starts the edit, so renaming is not a
 * pointer-only gesture. That handler stops propagation for the same reason
 * the click one does: on a task row, an un-stopped Enter would open the task
 * behind the editor it just opened.
 *
 * The starter takes a caret offset: a rename entered by clicking the words
 * opens with the cursor on the character that was clicked, and one entered by
 * a key opens with the cursor at the end.
 *
 * The goal strip and the task detail panel use this. The task ROW does not —
 * see `wireWordsInPlace` for why an input cannot serve it.
 */
export function wireInPlaceTitle(
  el: HTMLElement,
  current: () => string,
  commit: (v: string) => void,
  keepKey?: string,
  opts: {
    /** What the element shows when `current()` is empty and the edit ends
     *  without a name — the panel's "Untitled task" stand-in. Without it an
     *  empty original restores an empty heading. */
    placeholder?: () => string;
  } = {},
): (caret?: number) => void {
  const put = (text: string): Node => document.createTextNode(text);
  const begin = (caret?: number): void => {
    if (el.querySelector('input')) return;
    const original = current();
    const shown = original || opts.placeholder?.() || original;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hub-title-input';
    if (keepKey) input.dataset.keep = keepKey;
    input.value = original;
    el.replaceChildren(input);
    input.focus();
    const at =
      typeof caret === 'number' ? Math.max(0, Math.min(original.length, caret)) : original.length;
    input.setSelectionRange(at, at);
    const restore = () => {
      el.replaceChildren(put(shown));
    };
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter' || ke.key === 'Escape') {
        // The editor consumed this key, so nothing above it should also act on
        // it. Load-bearing now that Enter REMOVES the input: the guard on the
        // element's own handler is "is there an input here", and by the time
        // the bubble reaches it the answer has become no — so the key that
        // ended the edit would immediately start a new one.
        ke.stopPropagation();
      }
      if (ke.key === 'Enter') {
        ke.preventDefault();
        const v = input.value.trim();
        if (v && v !== original) {
          // Leave edit mode HERE, before the commit, rather than waiting for
          // the caller's re-render to do it. Two reasons, and the second is
          // the bug: the panel's repaint reopens the editor for any title
          // draft `keepFields` found, so an input still holding the committed
          // text put the reader straight back into edit mode — Enter saved and
          // never exited, every time. Removing the input also settles its own
          // blur handler, which is guarded on `el.contains(input)`.
          el.replaceChildren(put(v));
          commit(v);
        } else restore();
      } else if (ke.key === 'Escape') {
        restore();
      }
    });
    input.addEventListener('blur', () => {
      // Blur cancels: an accidental tap must never rewrite a title.
      if (el.contains(input)) restore();
    });
    input.addEventListener('click', (ce) => ce.stopPropagation());
  };
  el.addEventListener('keydown', (ev) => {
    // Only a key pressed on the element ITSELF starts an edit. "Is there an
    // input here" was the whole guard, and it is a fact that can change
    // between the key being handled and this handler seeing it bubble.
    if (ev.target !== el) return;
    if (el.querySelector('input')) return; // the input owns its own keys
    if (ev.key !== 'Enter' && ev.key !== 'F2') return;
    ev.preventDefault();
    ev.stopPropagation();
    begin();
  });
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    begin(caretOffsetIn(el, ev.clientX, ev.clientY));
  });
  return begin;
}

// ── Topbar: the board's name, and whether it has been stood down ───────────

/**
 * Repaint the two things in the topbar the board itself can change.
 *
 * Both used to be impossible: the name was set once at creation and nothing
 * could change it, and there was no such thing as a retired board. Now
 * `rename_workspace` and `retire_workspace` exist, and this page never
 * reloads — so a header painted once at boot is simply wrong from the moment
 * either lands.
 *
 * The badge is the answer to the question the incident asked. Two boards
 * carried one name and one lead agent; the only way to tell them apart was to
 * read their goal lists. A word in the header is what makes the stale one
 * look different from the live one at a glance.
 */
export function renderWorkspaceIdentity(
  nameEl: HTMLElement | null,
  badgeEl: HTMLElement | null,
  info: { name?: string; retiredAt?: number; retiredReason?: string } | null,
  fallbackName: string,
): void {
  if (nameEl) nameEl.textContent = info?.name ?? fallbackName;
  if (!badgeEl) return;
  const retiredAt = info?.retiredAt;
  badgeEl.classList.toggle('hidden', retiredAt === undefined);
  // The reason is the actionable half — usually the name of the board that
  // replaced this one — so it rides on the badge rather than being dropped.
  const reason = info?.retiredReason;
  badgeEl.title =
    retiredAt === undefined
      ? ''
      : `Retired ${new Date(retiredAt).toLocaleDateString()}${reason ? ` — ${reason}` : ''}`;
}

// ── Lead-agent strip ───────────────────────────────────────────────────────

export interface LeadStripHandlers {
  onLeadCommit: (leadAgentId: string) => void;
}

/**
 * Who is responsible for this board.
 *
 * An ask with nobody responsible is a dead letter, so the vacancy is
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
  seat?: LeadSeatView,
): void {
  container.replaceChildren();
  container.classList.toggle('hub-lead-empty', !leadAgentId);
  // A held seat whose holder has stopped answering is drawn as loudly as an
  // empty one, because it costs the board the same thing: nothing is reading
  // its asks. Before this it was drawn as a healthy board.
  const unmanned = Boolean(leadAgentId && seat?.leadAgentId === leadAgentId && !seat.live);
  container.classList.toggle('hub-lead-stale', unmanned);
  const label = document.createElement('span');
  label.className = 'hub-lead-label';
  label.textContent = leadSeatLabel(leadAgentId, seat);
  container.append(label);

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

// ── The archived list, and the pickers the detail panel shares with it ────

/** The restore list's own handlers — one verb, and the way back to the board. */
export interface ArchivedViewHandlers {
  onRestore: (task: HubTask) => void;
  onOpenTask: (task: HubTask) => void;
  onBack: () => void;
  /** The same two verbs for an archived BAND. Optional: without them the list
   *  draws tasks alone, which is what it drew before goals could be archived
   *  — a surface that cannot restore a row must not offer to. */
  onRestoreGoal?: (goal: HubGoal) => void;
  onOpenGoal?: (goal: HubGoal) => void;
}

/** "1 archived goal and 3 archived tasks" — and each half is dropped when it
 *  is empty, because "0 archived goals" is a sentence about nothing. */
function archivedHeading(goals: number, tasks: number): string {
  const parts: string[] = [];
  if (goals > 0) parts.push(goals === 1 ? '1 archived goal' : `${goals} archived goals`);
  if (tasks > 0 || goals === 0)
    parts.push(tasks === 1 ? '1 archived task' : `${tasks} archived tasks`);
  return parts.join(' and ');
}

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
export function renderTaskLinks(task: HubTask): HTMLElement | null {
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

// ── The goal DETAIL panel: what a goal row's tap opens ─────────────────────

export interface GoalDetailHandlers {
  onClose: () => void;
  /** Rename from the panel — unconditional, like the task panel's title:
   *  this is where renaming lives on the devices whose ROWS never edit. */
  onTitleCommit: (goalId: string, title: string) => void;
  /** A status pick — the same one-gate transition every task goes through
   *  (the server's transition route accepts a goal row's id), which is how
   *  "somebody declares the goal done" happens from the board. */
  onStatusSet: (goalId: string, to: TaskStatus) => void;
  /**
   * Post to the goal's discussion. Resolves to whether it LANDED — the
   * composer keeps the text until it hears yes, so a failed post is
   * retryable, exactly as on a task.
   *
   * Absent means the app has not wired one, and the section is then not drawn
   * at all rather than drawn dead. The same is true of `discussion` below:
   * the panel never renders a composer it cannot deliver from.
   */
  onComment?: (goalId: string, text: string, threadId?: string) => Promise<boolean>;
  /** Which comment the review queue sent the reader here to read. */
  focusThreadId?: string;
  /**
   * The description slot this paint decided on — a rebuilt element when the
   * panel opened on another goal, the SAME element when a repaint kept a live
   * editor in place, and `null` when the panel closed.
   *
   * The app used to read this off the DOM immediately after calling the
   * renderer, which worked only because the renderer painted synchronously.
   * The island writes a signal instead, so nothing outside it can know when the
   * slot exists; the panel therefore reports its own. Same contract as the task
   * panel's, and for the same reason.
   */
  onBodySlot?: (section: BoardSection | null, slot: HTMLElement | null) => void;
  /**
   * Put a link to this goal on the clipboard — the task panel's 🔗, one row
   * type over, and for the same reason: a band is a thing people forward.
   *
   * The renderer does not build the URL, because only the app knows which
   * workspace this board is. No handler, no button.
   */
  onCopyLink?: (section: BoardSection) => void;
  /**
   * What archiving this band would take with it, asked BEFORE the write.
   *
   * The panel will not commit an archive without an answer here, and that is
   * the point of the handler existing at all: the blast radius is the part a
   * reader cannot see from a band header (Bryan, 2026-08-30 — "say what is
   * about to happen, with the count"), and a count the panel invented would
   * be a second implementation of the server's walk, free to be wrong in the
   * direction that matters.
   *
   * Resolves to null when the question could not be asked — the panel then
   * says so and offers no Archive, rather than offering one whose
   * consequences it cannot state.
   */
  onCascadeCount?: (goalId: string) => Promise<{ tasks: number } | null>;
  /** Commit the archive, cascade and all. Only ever reached through the
   *  confirmation above. */
  onArchive?: (section: BoardSection) => void;
  /** Put an archived band back, with the rows its archive took — the panel's
   *  other face, drawn in place of Archive when the open band is archived. */
  onRestore?: (section: BoardSection) => void;
  /** Clock seam, so "3 hours ago" is assertable. */
  now?: number;
}

/**
 * The restore list — every archived row, newest removal first, each with the
 * one control that matters.
 *
 * Deliberately NOT the board's own row renderer. A board row is a working
 * surface: drag handle, status dropdown, owner picker, reorder keys. None of
 * that applies to a row that is off the board, and offering it would invite
 * edits whose only effect is to change what comes back. So an archived row is
 * a title, who removed it and why, and Restore.
 *
 * The title still opens the task, because the discussion on an archived row
 * is often the reason somebody is here.
 */
export function renderArchivedList(
  container: HTMLElement,
  tasks: HubTask[],
  handlers: ArchivedViewHandlers,
  goals: HubGoal[] = [],
): void {
  container.replaceChildren();
  const head = document.createElement('div');
  head.className = 'hub-archived-head';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'hub-linklike hub-archived-back';
  back.textContent = '← Back to the board';
  back.addEventListener('click', () => handlers.onBack());
  const rows = handlers.onRestoreGoal ? goals : [];
  const total = handlers.onRestoreGoal ? rows.length : 0;
  const h = document.createElement('h3');
  h.className = 'hub-section-title';
  h.textContent = archivedHeading(total, tasks.length);
  head.append(back, h);
  container.append(head);
  if (tasks.length === 0 && rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hub-section-empty';
    // Reached by editing the URL, or by restoring the last one from here —
    // in which case this line is the confirmation that it worked.
    empty.textContent = 'Nothing archived. Anything you archive can be restored from here.';
    container.append(empty);
    return;
  }
  const list = document.createElement('ul');
  list.className = 'hub-archived-list';
  // Bands first, and marked as bands: restoring one brings its tasks with it,
  // so a reader scanning for a ticket they lost should meet the goal that took
  // it before they meet the ticket itself.
  for (const goal of rows) {
    const li = document.createElement('li');
    li.className = 'hub-archived-row hub-archived-row--goal';
    li.dataset.goalId = goal.id;
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'hub-linklike hub-archived-title';
    title.textContent = goal.title;
    title.addEventListener('click', () => handlers.onOpenGoal?.(goal));
    const kind = document.createElement('span');
    kind.className = 'hub-archived-kind';
    kind.textContent = 'Goal';
    const why = document.createElement('span');
    why.className = 'hub-archived-why';
    const who = goal.archivedBy ? ` by ${goal.archivedBy}` : '';
    const when = goal.archivedAt ? new Date(goal.archivedAt).toLocaleDateString() : '';
    why.textContent = goal.archiveReason
      ? `${when}${who} — ${goal.archiveReason}`
      : `${when}${who}`;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'hub-btn hub-archived-restore';
    restore.textContent = 'Restore';
    // The label says what the button does that the word "Restore" cannot: the
    // tasks come back too, which is the half a reader has to know BEFORE they
    // press it rather than after.
    restore.setAttribute('aria-label', `Restore “${goal.title}” and its tasks to the board`);
    restore.addEventListener('click', () => handlers.onRestoreGoal?.(goal));
    li.append(kind, title, why, restore);
    list.append(li);
  }
  for (const task of tasks) {
    const li = document.createElement('li');
    li.className = 'hub-archived-row';
    li.dataset.taskId = task.id;
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'hub-linklike hub-archived-title';
    title.textContent = task.title;
    title.addEventListener('click', () => handlers.onOpenTask(task));
    const why = document.createElement('span');
    why.className = 'hub-archived-why';
    const who = task.archivedBy ? ` by ${task.archivedBy}` : '';
    const when = task.archivedAt ? new Date(task.archivedAt).toLocaleDateString() : '';
    why.textContent = task.archiveReason
      ? `${when}${who} — ${task.archiveReason}`
      : `${when}${who}`;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'hub-btn hub-archived-restore';
    restore.textContent = 'Restore';
    restore.setAttribute('aria-label', `Restore “${task.title}” to the board`);
    restore.addEventListener('click', () => handlers.onRestore(task));
    li.append(title, why, restore);
    list.append(li);
  }
  container.append(list);
}

// ── Quick actions: the two ways work starts ───────────────────────────────

/**
 * "New task", "Start a planning huddle" and "Record a conversation", in the
 * slot the quick-add box had.
 *
 * Bryan, 2026-08-29: *"From board, have a quick flow to create a new task
 * (replace current text box) that creates an empty item in the usual task
 * detail view. And have another button to start a planning huddle."* Neither
 * asks anything first: the task is an empty row the panel opens on with the
 * title ready to type, and the huddle is a doc the editor opens with the mic
 * already asked for.
 *
 * The third is the same huddle for a room rather than for one person, and it
 * is what an in-person conversation has instead of a platform to join: the
 * press IS the announcement, and it is the only thing that turns on the
 * diarization a solo session does not pay for.
 *
 * A mount, not a render, like the box it replaced: the board repaints on
 * every ydoc change, and a button rebuilt while its request is out would come
 * back enabled and take a second press.
 */
export interface QuickActionHandlers {
  /** Resolves when the row exists (or the attempt failed) — the button is
   *  held until then, because the reflex second tap would file two empty
   *  rows. */
  onNewTask: () => Promise<boolean>;
  /** Resolves when the huddle doc exists and the page is leaving, or when the
   *  start was refused — which gives the button back as the retry. */
  onStartHuddle: () => Promise<boolean>;
  /**
   * The same huddle, listening for a room instead of for one person.
   *
   * It is a SECOND BUTTON rather than a setting on the first because
   * nothing announces an in-person conversation — there is no meeting
   * platform to notice, no invite, no join — so the press has to be the
   * thing that says it. One action, from the Board, with the mic already
   * asked for and diarization already on.
   */
  onStartConversation: () => Promise<boolean>;
  /** Whether the server will accept writes from this browser. Absent means
   *  yes, so every caller that predates the sign-in gate is unchanged. */
  canWrite?: boolean;
}

export function renderQuickActions(container: HTMLElement, handlers: QuickActionHandlers): void {
  if (container.dataset.mounted === '1') return;
  container.dataset.mounted = '1';
  const row = document.createElement('div');
  row.className = 'hub-quick-actions';
  // One request in flight per button. Held rather than debounced: a disabled
  // button also LOOKS taken, which is the receipt for the press.
  const hold = (button: HTMLButtonElement, run: () => Promise<boolean>): void => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      void run().finally(() => {
        button.disabled = false;
      });
    });
  };
  const newTask = document.createElement('button');
  newTask.type = 'button';
  newTask.className = 'hub-btn hub-btn-primary hub-quick-new';
  newTask.innerHTML = `${PLUS_ICON}<span>New task</span>`;
  hold(newTask, handlers.onNewTask);
  const huddle = document.createElement('button');
  huddle.type = 'button';
  huddle.className = 'hub-btn hub-huddle-start';
  huddle.innerHTML = `${MIC_ICON}<span>Start a planning huddle</span>`;
  hold(huddle, handlers.onStartHuddle);
  const conversation = document.createElement('button');
  conversation.type = 'button';
  conversation.className = 'hub-btn hub-conversation-start';
  conversation.innerHTML = `${PEOPLE_ICON}<span>Record a conversation</span>`;
  hold(conversation, handlers.onStartConversation);
  row.append(newTask, huddle, conversation);
  // Error prevention rather than error recovery, matching the doc surface's
  // edit toggle: a signed-out reader is told these are unavailable instead of
  // pressing one and receiving a refusal. Disabled, not hidden — a control
  // that vanishes teaches nothing about why. The conversation button creates
  // a doc exactly as the huddle does, so it is gated with them.
  if (handlers.canWrite === false) {
    for (const button of [newTask, huddle, conversation]) {
      button.disabled = true;
      button.title = 'Sign in to add to this board';
      button.setAttribute('aria-label', 'Sign in to add to this board');
    }
  }
  container.append(row);
}

// ── Review banner (the board's one line about the queue) ──────────────────
//
// The full "For Your Review" pane is a Preact island now — see
// home-review-island.tsx, and the walkthrough card it opens is another —
// walkthrough-island.tsx. What stays here is the board's one-line banner.

/**
 * The board's whole read of the review queue: one line and a way to Home.
 * The full list lives on the Home pane now — repeating it here would be two
 * surfaces claiming to be the queue, drifting the first time only one of
 * them learns something. Renders nothing at all when nothing is waiting
 * (approved design: the banner exists only while items are open).
 */
export interface ReviewBannerHandlers {
  onGoHome: () => void;
}

export function renderReviewBanner(
  container: HTMLElement,
  queue: ReviewQueue,
  handlers: ReviewBannerHandlers,
): void {
  container.replaceChildren();
  const text = reviewBannerText(queue);
  if (!text) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  const line = document.createElement('span');
  line.className = 'hub-review-banner-text';
  line.textContent = text;
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'hub-btn hub-btn-ink hub-review-banner-go';
  go.textContent = 'Go to Home';
  go.addEventListener('click', () => handlers.onGoHome());
  container.append(line, go);
}

// ── The Home brief ("What's New?") ─────────────────────────────────────────

export interface HomeBriefHandlers {
  onMarkCaughtUp: () => void;
  /** Save & Update Summary — the server drops every cached brief and
   *  regenerates under the new instructions. */
  onSaveInstructions: (text: string) => void;
  /** Open or close the recipe editor. State lives with the app, not the DOM,
   *  so a repaint mid-edit cannot silently close the panel. */
  onEditRecipe: (open: boolean) => void;
}

export function renderHomeBrief(
  container: HTMLElement,
  payload: HomePayload | null,
  now: number,
  editingRecipe: boolean,
  handlers: HomeBriefHandlers,
): void {
  container.replaceChildren();
  const card = document.createElement('section');
  card.className = 'hub-home-brief-card';

  const head = document.createElement('div');
  head.className = 'hub-home-review-head';
  const h = document.createElement('h2');
  h.className = 'hub-home-heading';
  h.textContent = "What's New?";
  head.append(h);
  card.append(head);

  if (!payload) {
    const quiet = document.createElement('p');
    quiet.className = 'hub-home-quiet';
    quiet.textContent = 'Loading…';
    card.append(quiet);
    container.append(card);
    return;
  }

  // The window, beside the heading (mockup: "What's New?  From Friday,
  // 6:12 pm until now"). "Updating…" is grounded in the server's own
  // generating flag — the flag is written at the point the call is queued,
  // never inferred here.
  const since = document.createElement('span');
  since.className = 'hub-home-since';
  since.textContent = homeSinceLabel(payload, now) + (payload.generating ? ' · Updating…' : '');
  head.append(since);

  const body = document.createElement('div');
  body.className = 'hub-home-brief-body';
  // Escape-first markdown subset; anything a writer put in the board is inert
  // markup by the time it lands here.
  body.innerHTML = renderCommentMarkdown(payload.brief.markdown);
  card.append(body);

  // The mockup's footer, verbatim: "Edit how this gets generated" as a plain
  // link bottom-left, "Mark read" as the dark button bottom-right.
  const actions = document.createElement('div');
  actions.className = 'hub-home-brief-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'hub-linklike hub-home-edit-recipe';
  edit.textContent = 'Edit how this gets generated';
  edit.addEventListener('click', () => handlers.onEditRecipe(!editingRecipe));
  const mark = document.createElement('button');
  mark.type = 'button';
  mark.className = 'hub-btn hub-btn-ink hub-home-mark-read';
  mark.textContent = 'Mark read';
  mark.addEventListener('click', () => handlers.onMarkCaughtUp());
  actions.append(edit, mark);
  card.append(actions);

  if (editingRecipe) {
    const panel = document.createElement('div');
    panel.className = 'hub-home-recipe';
    const hint = document.createElement('p');
    hint.className = 'hub-home-recipe-hint';
    hint.textContent =
      'Edit these instructions and they will be used on this summary and future summaries.';
    const ta = document.createElement('textarea');
    ta.className = 'hub-home-recipe-text';
    ta.value = payload.instructions;
    ta.rows = 6;
    const buttons = document.createElement('div');
    buttons.className = 'hub-home-recipe-buttons';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'hub-btn hub-btn-ink hub-home-recipe-save';
    save.textContent = 'Save & Update Summary';
    save.addEventListener('click', () => {
      const text = ta.value.trim();
      if (text) handlers.onSaveInstructions(text);
    });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'hub-btn hub-home-recipe-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => handlers.onEditRecipe(false));
    buttons.append(save, cancel);
    panel.append(hint, ta, buttons);
    card.append(panel);
  }

  container.append(card);
}

// The decision walkthrough (§ six answers in one sitting) moved to
// `walkthrough-island.tsx` — a Preact island, because the card is rebuilt by
// every board event and everything it was holding died with it: the drafts,
// and the two expansions the reader had opened. `WalkthroughHandlers` and
// `WalkProgress` live there now.

// The presence strip (§2.7) moved to `presence-island.tsx` — a Preact island,
// because a circle carries a long-press and a rebuilt node dropped the press
// that was running on it. `PresenceHandlers` lives there now.

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
  onAssign: (task: HubTask, assignee: string) => void;
  /** The agents currently attached to this workspace — see `BoardHandlers`. */
  knownAgentIds?: string[];
  /** Names the goal the way the board's own section header does — pass
   *  `hub-model`'s `goalLabel`, which resolves Backlog too. The panel
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
// ── What a repaint owes the person typing ──────────────────────────────────

type TextControl = HTMLTextAreaElement | HTMLInputElement;

/** What one text control held the instant before a repaint threw it away. */
export interface KeptField {
  value: string;
  focused: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: 'forward' | 'backward' | 'none';
  /** Where the caret was when the control is a live markdown composer. A
   *  ProseMirror position is not a string offset, so it needs its own slot —
   *  and it maps back exactly, because the restore puts the same markdown
   *  back before placing it. */
  composer: ComposerSelection | null;
}

/**
 * Snapshot every text control under `root` that carries a `data-keep` key.
 *
 * The detail panel is repainted by `replaceChildren` on every board change —
 * a task transition arriving over SSE, a reply landing, a picker list moving —
 * and a repaint rebuilds the composer, so whatever was typed and wherever the
 * caret was went with the old DOM. `discussionIsBusy` holds back one of those
 * doors (a discussion reload) and cannot see the others, so the guarantee
 * belongs here, at the one point every repaint passes through: read the
 * fields out before the swap, put them back after.
 *
 * The key is stamped by whoever builds the control and includes the task id,
 * so a draft belongs to the task it was typed on — the panel is one shared
 * container, and a half-typed comment must never follow the reader onto a
 * different task.
 */
export function keepFields(root: ParentNode): Map<string, KeptField> {
  const kept = new Map<string, KeptField>();
  for (const el of root.querySelectorAll<TextControl>('textarea[data-keep], input[data-keep]')) {
    const key = el.dataset.keep;
    if (!key) continue;
    // A composer's textarea is hidden behind its editor, so neither focus nor
    // the caret is on the element any more — both have to be asked of the
    // surface the reader is actually typing in. `composerSelection` answers
    // null for a plain control, which is what selects the other branch.
    const live = el instanceof HTMLTextAreaElement && composerState(el) === 'live';
    kept.set(key, {
      value: el.value,
      focused: live
        ? isComposerFocused(el as HTMLTextAreaElement)
        : el === el.ownerDocument.activeElement,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
      selectionDirection: el.selectionDirection ?? 'none',
      composer: live ? composerSelection(el as HTMLTextAreaElement) : null,
    });
  }
  return kept;
}

/**
 * Put a `keepFields` snapshot back into the freshly built controls under
 * `root`. Value always; focus and caret only for the field that HAD focus —
 * a draft the reader tapped away from is restored where it was, without
 * pulling focus back from wherever they went.
 */
export function restoreFields(root: ParentNode, kept: Map<string, KeptField>): void {
  for (const el of root.querySelectorAll<TextControl>('textarea[data-keep], input[data-keep]')) {
    const snap = el.dataset.keep ? kept.get(el.dataset.keep) : undefined;
    if (!snap) continue;
    el.value = snap.value;
    // The value is the composer's source of truth but not its content — put
    // the words back into the editor too. No-op on a plain control, and safe
    // before the editor's chunk has landed: it seeds from the value on mount.
    if (el instanceof HTMLTextAreaElement) refreshMarkdownComposer(el);
    if (!snap.focused) continue;
    // A box whose editor has not mounted yet still restores through here: the
    // focus is remembered and applied the moment it does.
    if (el instanceof HTMLTextAreaElement && composerState(el) !== 'none') {
      focusMarkdownComposer(el, snap.composer);
      continue;
    }
    el.focus();
    if (snap.selectionStart !== null && snap.selectionEnd !== null) {
      el.setSelectionRange(snap.selectionStart, snap.selectionEnd, snap.selectionDirection);
    }
  }
}

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

/** One comment, in the single chronological sequence the panel shows. The
 *  `threadId` is the one thread fact a row still carries, as DATA rather than
 *  presentation: it is how a reply lands in the conversation the agent is
 *  watching. (opensThread/closesThread/status/anchorText are gone — they fed
 *  the Reply button, badge and anchor quote this surface no longer has.) */
export interface StreamComment {
  threadId: string;
  comment: TaskComment;
}

/**
 * Every comment on the task, oldest first, in ONE sequence.
 *
 * Bryan, 2026-08-18: *"multi-threaded comments are too complicated — just a
 * single sequence of comments with clearer separation, authorship and
 * timing."* So this is a change to the RENDERING and to nothing else. Threads
 * remain exactly as stored (34 of 37 on the live board carry a text anchor
 * into the description, and `resolve_thread` still means "this point is
 * handled") — the stream simply reads them in the order they were said, and
 * each row keeps its `threadId` so a reply still lands in the right
 * conversation.
 *
 * The tie-break is declaration order rather than nothing: two comments written
 * in the same millisecond are a fixture, not a race, and an unstable sort
 * would make the panel repaint into a different order for no reason.
 */
export function flattenComments(threads: TaskThread[]): StreamComment[] {
  const rows = threads.flatMap((t, ti) =>
    t.comments.map((c, ci) => ({
      order: ti * 1000 + ci,
      row: { threadId: t.id, comment: c } satisfies StreamComment,
    })),
  );
  rows.sort((a, b) =>
    a.row.comment.ts !== b.row.comment.ts ? a.row.comment.ts - b.row.comment.ts : a.order - b.order,
  );
  return rows.map((r) => r.row);
}

/**
 * Where the one composer's next comment lands.
 *
 * The reader is never asked and is never shown a choice: Bryan, 2026-08-18,
 * on seeing the version that offered one — *"Mocks still show threaded
 * comments design. I explicitly asked for that to be removed."* So this is
 * derivation, not selection. It goes to the thread the review queue sent the
 * reader here to answer, else the thread the NEWEST comment belongs to —
 * which is the conversation the composer sits directly under in the stream —
 * and on a task with no threads at all it returns null and the caller opens
 * one.
 *
 * Reading the newest off `flattenComments` rather than off `threads` matters:
 * the panel orders comments by TIME, so the last thread in the array and the
 * last thread on the screen are not the same thread once two conversations
 * interleave, and replying into the one that is no longer on screen would put
 * the answer somewhere the person cannot see it.
 */
export function composerTarget(threads: TaskThread[], focusThreadId?: string): TaskThread | null {
  const stream = flattenComments(threads);
  const newest = stream[stream.length - 1]?.threadId ?? threads[threads.length - 1]?.id ?? null;
  const wanted = focusThreadId ?? newest;
  if (wanted === null) return null;
  return threads.find((t) => t.id === wanted) ?? threads[threads.length - 1] ?? null;
}

/**
 * One comment, as the stream draws it — the row anatomy the task panel and
 * the goal panel share.
 *
 * Exported because the task detail island owns the `<ol>` these rows land in
 * but not the rows themselves: a comment row holds nothing a reader can be
 * part-way through, so rebuilding it on every paint costs nothing — while a
 * second copy of this markup in JSX would be a second thing to keep in step.
 */
export function commentRow(
  row: StreamComment,
  focusThreadId: string | undefined,
  now: number,
): HTMLLIElement {
  const c = row.comment;
  const li = document.createElement('li');
  // Every comment is a peer of every other one. No resolved styling, no
  // "opens a thread" styling, no quoted anchor above the first of a run —
  // those were the last places the thread structure showed through, and
  // Bryan's instruction was to remove it from the UX, not only to remove the
  // buttons. `focus` survives because it is not about threads: it marks the
  // comment the review queue sent the reader here to read.
  li.className = [
    'hub-comment',
    c.review ? 'hub-comment-review' : '',
    row.threadId === focusThreadId ? 'hub-comment-focus' : '',
  ]
    .filter(Boolean)
    .join(' ');
  // Kept as DATA and rendered nowhere: it is how a reply reaches the agent
  // watching that conversation, and dropping it would make every answer a
  // new thread nobody is subscribed to.
  li.dataset.threadId = row.threadId;

  // Author AND time, both as text. The time used to live only in a `title`
  // attribute — which is a hover tooltip, and the reader this surface is
  // for is on a phone, where nothing hovers. "Who said this and when" was
  // therefore unanswerable on the device it mattered on.
  const head = document.createElement('div');
  head.className = 'hub-comment-head';
  const who = document.createElement('span');
  who.className = 'hub-comment-author';
  who.textContent = c.author;
  const when = document.createElement('span');
  when.className = 'hub-comment-when';
  when.textContent = timeAgo(c.ts, now);
  when.title = new Date(c.ts).toLocaleString();
  head.append(who, when);
  if (c.review) {
    // A WITHDRAWN item still belongs in the stream — it is history, and the
    // reader may already have acted on it — but badging it 'Question' is the
    // whole bug the verb exists to prevent, one surface over. The doc pane's
    // `reviewHeader` marks it the same way; both read the one predicate.
    const retracted = reviewWithdrawn(c.review);
    const badge = document.createElement('span');
    badge.className = retracted ? 'hub-comment-review-k is-withdrawn' : 'hub-comment-review-k';
    badge.textContent = retracted
      ? 'Withdrawn'
      : c.review.shape === 'decision'
        ? 'Decision'
        : 'Question';
    head.append(badge);
  }
  // "Needs your reply" was a THREAD badge — it named a thread, because the
  // server's queue names threads — so it went with the rest of the thread
  // presentation. The signal did not go with it: everything waiting on the
  // reader now renders in the review queue at the TOP of the panel, which is
  // where they were told to look and is above the fold. A badge two hundred
  // pixels down a comment stream was the weaker of the two anyway.
  li.append(head);

  if (c.review) {
    // The declared headline, in the author's words. It goes ABOVE the
    // comment text rather than replacing it: the text is what the agent
    // said, the declaration is what it is asking for, and the two are not
    // the same sentence. The why paragraph is gone from here — it leads the
    // item card's markdown body at the top of the panel, and a second copy
    // in the stream was the duplication the one-card anatomy removes.
    const headline = document.createElement('p');
    headline.className = reviewWithdrawn(c.review)
      ? 'hub-comment-review-headline is-withdrawn'
      : 'hub-comment-review-headline';
    headline.textContent = c.review.headline;
    li.append(headline);
  }

  const body = document.createElement('div');
  body.className = 'hub-comment-body';
  // Same escape-then-allow-known-tags path the description uses, so a
  // comment written by anyone with write access is inert markup.
  body.innerHTML = renderCommentMarkdown(c.text);
  li.append(body);
  return li;
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
  const cell = (key: string, value: Node | string): void => {
    const wrap = document.createElement('div');
    wrap.className = 'hub-detail-field';
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
  mark.className = `hub-status-mark hub-status-mark-${task.status}`;
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
  cell('Goal', goal);

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
  const assumed = (r: EffortRatio): string =>
    `\u00d7${r.ratio.toFixed(2)} from the board's starting assumption that agents do the work \u2014 nothing has closed under this goal to measure yet`;
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
  // Said once for both quantities when neither has evidence, which is the
  // shape a board wears right after a prompt bump — two sentences saying
  // "nothing has closed yet" is the same sentence twice.
  const priorOnly = (r: EffortRatio | undefined): boolean =>
    r !== undefined && r.samples === 0 && r.ratio.toFixed(2) !== '1.00';
  if (priorOnly(handsRatio) && priorOnly(wallRatio) && handsRatio && wallRatio) {
    lines.push(
      `Hands-on scaled \u00d7${handsRatio.ratio.toFixed(2)} and calendar time \u00d7${wallRatio.ratio.toFixed(2)}, from the board's starting assumption that agents do the work \u2014 nothing has closed under this goal to measure yet.`,
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

/**
 * The question a decision task is asking, lifted out of its body.
 *
 * Bryan, 2026-08-18: *"For decisions, the ticket title is not the decision. A
 * decision is a part of a ticket, and there should be a decision blurb above
 * the options."* A task-borne decision has no headline FIELD — the question
 * and the stakes live in the body markdown, which is exactly what the server's
 * create gate reads (`checkDecisionShape` refuses a body that never asks
 * anything). So the blurb is derived the same way the gate judges: the first
 * line that asks something is the question, and the prose that is not the
 * question and not the options list is what is at stake.
 *
 * This is also why the description below can be de-emphasised — on a decision
 * task it repeats what the card now shows.
 *
 * The second half was called `why` while the payload had a field of that name
 * and this fed it. It never was one: it is everything in the body that is not
 * the question and not the options — a BODY — so it is spelled as one now and
 * lands in `detail`, which is where the card reads a body from.
 *
 * One-directional, like the gate: a body it cannot read yields an empty
 * headline, and the caller falls back rather than inventing a question.
 */
export function decisionBlurb(body: string | undefined): { headline: string; body: string } {
  const text = (body ?? '').trim();
  if (!text) return { headline: '', body: '' };
  const rows = text.split('\n');
  // A markdown list item — the options, which the card renders as buttons and
  // must not repeat as prose.
  const isListItem = (l: string) => /^\s{0,3}([-*+]|\d+[.)])\s+\S/.test(l);
  // Heading hashes, bold wrappers and a leading list marker are markup, not
  // words; the card is not a markdown renderer and a stray `##` in a headline
  // reads as a typo.
  const plain = (l: string) =>
    l
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/, '')
      .replace(/\*\*/g, '')
      .trim();
  // A line that introduces the list we are about to drop — `Options:` — is
  // dropped with it. Measured in the browser 2026-08-18: keeping it welded the
  // orphaned label onto the sentence after the list ("…not shipping it.
  // Options: Blocked until answered: …"), which reads as a typo rather than as
  // prose. The test is deliberately narrow — a trailing colon AND a list item
  // as the next non-blank line — so a sentence that merely ends in a colon and
  // introduces nothing keeps its place.
  const introducesList = (i: number) => {
    if (isListItem(rows[i] ?? '') || !plain(rows[i] ?? '').endsWith(':')) return false;
    for (let j = i + 1; j < rows.length; j += 1) {
      if (plain(rows[j] ?? '') === '') continue;
      return isListItem(rows[j] ?? '');
    }
    return false;
  };
  const questionAt = rows.findIndex((l) => l.includes('?'));
  const headline = questionAt >= 0 ? plain(rows[questionAt] ?? '') : '';
  const rest = rows
    .filter((l, i) => i !== questionAt && !isListItem(l) && plain(l) !== '' && !introducesList(i))
    .map(plain)
    .join(' ')
    .trim();
  return { headline, body: rest };
}

/**
 * Everything on this task that is waiting on the reader, ranked.
 *
 * Bryan, 2026-08-18: *"over time, there may be more than one decision
 * associated with a ticket. In fact, at any point in time there might be
 * multiple open decisions for a ticket. Please accommodate and have a similar
 * review queue within a ticket details interface."* So the panel's review
 * region is a QUEUE rather than a card — the same two sources the strip reads,
 * merged: the task's own `needs: 'decision'`, and every declared or unanswered
 * item the server computed for this task's threads.
 *
 * Nothing about storage changes and nothing is re-derived here: the thread
 * items arrive from `GET /api/workspaces/:id/review-items`, which is where
 * "is this run waiting on a person" is decided, and this only merges and
 * orders. Ranking is the strip's own rule so the two cannot disagree —
 * declared before inferred, a named person before nobody, oldest first inside
 * each group — with the task's decision ahead of all of it, because it is the
 * one item that is structurally blocking rather than inferred from who spoke
 * last.
 */
export function panelReviewQueue(
  task: HubTask,
  asks: ReviewThreadItem[] | undefined,
  discussion?: TaskDiscussion,
): PanelReviewItem[] {
  const items: PanelReviewItem[] = [];
  if (!task.answer && task.needs === 'decision') {
    const blurb = decisionBlurb(task.body);
    items.push({
      id: `task:${task.id}`,
      source: 'task',
      shape: 'decision',
      // The title is the fallback and not the default: it names the ticket,
      // and the ticket is not the decision. An unreadable body yields the
      // title rather than a blank card, which would say nothing at all.
      headline: blurb.headline || task.title,
      ...(blurb.body !== '' ? { detail: blurb.body } : {}),
      ...(task.options ? { options: task.options } : {}),
      // The ticket's filer, read the one way the Home card reads it, so the
      // same decision does not say "Asked by UX Bot" there and "Asked" here.
      ...(decisionAskedBy(task) !== undefined ? { askedBy: decisionAskedBy(task) } : {}),
      since: task.createdAt,
      asked: true,
    });
  }
  for (const a of asks ?? []) {
    const r = a.review;
    if (a.kind === 'task-review') {
      // A TICKET-borne item: the same card a declared thread item gets, keyed
      // by the ids its answer posts to and carrying no `threadId` — there is
      // no thread, and inventing one would aim the focus-scroll and the deep
      // link at nothing. `panelAsks` has already refused a row without the
      // payload or the ids; the guard here is what makes THIS function total.
      if (!a.taskId || !a.reviewItemId || r === undefined) continue;
      items.push({
        id: `task-review:${a.taskId}:${a.reviewItemId}`,
        source: 'task-review',
        shape: r.shape,
        headline: r.headline,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        ...(r.options ? { options: r.options } : {}),
        askedBy: a.askedBy,
        since: a.askedAt ?? a.since,
        ...(a.direct !== undefined ? { direct: a.direct } : {}),
        reviewItemId: a.reviewItemId,
        declared: true,
        asked: true,
        // A REVISED item keeps what the server said about the revision, and
        // the thread that asked — so the card can say "this came back
        // changed" and the focus-scroll can aim at it. A fresh item carries
        // no thread: there is none, and inventing one would aim the deep link
        // at nothing.
        ...(a.state === 'revised'
          ? {
              revision: {
                at: a.revisedAt ?? a.since,
                ...(a.question !== undefined ? { question: a.question } : {}),
              },
              ...(a.threadId ? { threadId: a.threadId } : {}),
            }
          : {}),
      });
      continue;
    }
    items.push({
      id: `thread:${a.threadId}`,
      source: 'thread',
      shape: r?.shape ?? 'review',
      // A declared item says what it wants in its own words. An inferred one
      // has no declaration, so its headline is the comment itself — which is
      // what the strip shows, and it is honest about being an excerpt.
      headline: r?.headline ?? a.ask,
      ...(r?.detail !== undefined ? { detail: r.detail } : {}),
      ...(r?.options ? { options: r.options } : {}),
      askedBy: a.askedBy,
      since: a.askedAt ?? a.since,
      ...(a.direct !== undefined ? { direct: a.direct } : {}),
      threadId: a.threadId,
      docId: a.docId,
      ...(a.commentId !== undefined ? { commentId: a.commentId } : {}),
      declared: r !== undefined,
      // A declaration is an ask; an inferred item only measured one.
      asked: r !== undefined || a.direct === true,
    });
  }
  // ANSWERED declared items stay in the panel as the record (approved
  // design): the "Answered by …" line with its persistent Undo renders where
  // the item card stood, not on some other surface. They come from the
  // DISCUSSION rather than from `asks`, because the review-items route only
  // ships what is still waiting — the stamps on the declaring comment are the
  // record that survives a reload. An unanswered declaration is skipped here:
  // its row already arrived through `asks`, and admitting it twice would put
  // a dead copy of the card above the live one.
  for (const t of discussion?.threads ?? []) {
    for (const c of t.comments) {
      const r = c.review;
      if (!r || !reviewAnswered(r)) continue;
      items.push({
        id: `answered:${t.id}:${c.id ?? c.ts}`,
        source: 'thread',
        shape: r.shape,
        headline: r.headline,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        askedBy: c.author,
        since: c.ts,
        threadId: t.id,
        docId: task.bodyDocId,
        ...(c.id !== undefined ? { commentId: c.id } : {}),
        declared: true,
        asked: true,
        answered: {
          ...(r.answeredBy !== undefined ? { by: r.answeredBy } : {}),
          // A legacy tap stamped `answeredWith` alone; the option's label is
          // the verbatim words that tap recorded.
          ...((r.answerText ?? optionLabel(r, r.answeredWith)) !== undefined
            ? { text: r.answerText ?? optionLabel(r, r.answeredWith) }
            : {}),
          at: r.answeredAt ?? 0,
        },
      });
    }
  }
  // Declared before inferred. This asked `why !== ''` while the payload had a
  // required `why` and an inferred item had none — a proxy for exactly this,
  // which the row now states outright. Same ordering, no longer inferred from
  // a field's emptiness.
  const rank = (i: PanelReviewItem): number =>
    i.answered
      ? 3
      : i.source === 'task'
        ? 0
        : i.shape === 'decision' || i.declared === true
          ? 1
          : 2;
  return items.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const d = Number(b.direct ?? false) - Number(a.direct ?? false);
    return d !== 0 ? d : a.since - b.since;
  });
}

/**
 * Where a panel card's answer gets WRITTEN — path and body, minus the author
 * the caller adds. The sibling of `reviewReplyRequest` (Home queue), for the
 * panel's own row shape, and one spelling for the same reason: `hub-app`
 * built the two thread routes inline, which is exactly how a ticket-borne
 * card would have posted its answer at `/api/docs/<task doc>/threads/
 * undefined/…` — a write that lands nowhere while the card says "posted".
 *
 * - a `task-review` card → the task review-item answer route. `answeredWith`
 *   is that entity's spelling of the tapped candidate's id.
 * - a declared thread card with a comment to stamp → the thread `/answer`
 *   route, which posts the same reply AND records the candidate.
 * - any other thread card → a plain thread comment.
 *
 * Null when the card holds no address to write to — the task's own decision
 * included, which answers through `answer_decision` and never comes here.
 */
export function panelAnswerRequest(
  task: Pick<HubTask, 'id' | 'bodyDocId'>,
  item: PanelReviewItem,
  text: string,
  optionId?: string,
): { path: string; body: Record<string, unknown> } | null {
  if (item.source === 'task-review') {
    if (!item.reviewItemId) return null;
    return {
      path: `/api/tasks/${encodeURIComponent(task.id)}/review-items/${encodeURIComponent(item.reviewItemId)}/answer`,
      body: { text, ...(optionId !== undefined ? { answeredWith: optionId } : {}) },
    };
  }
  if (item.source !== 'thread' || !item.threadId) return null;
  const doc = encodeURIComponent(item.docId ?? task.bodyDocId);
  const thread = encodeURIComponent(item.threadId);
  return item.declared && item.commentId !== undefined
    ? {
        path: `/api/docs/${doc}/threads/${thread}/answer`,
        body: {
          text,
          commentId: item.commentId,
          ...(optionId !== undefined ? { optionId } : {}),
        },
      }
    : { path: `/api/docs/${doc}/threads/${thread}/comments`, body: { text } };
}

/** The verbatim words a tapped option recorded, when the payload still holds
 *  the candidate list. Undefined otherwise — the record never invents words. */
function optionLabel(r: ReviewPayload, optionId: string | undefined): string | undefined {
  if (optionId === undefined) return undefined;
  return r.options?.find((o) => o.id === optionId)?.label;
}

/**
 * Say why a submit did nothing, next to the control that did nothing.
 *
 * A disabled button would be the tidier affordance and it is the wrong one
 * here: these boxes are refilled by `restoreFields` after every repaint,
 * which sets `.value` directly and fires no `input` event — so a button whose
 * enabled state is driven by typing would sit disabled over a full box. This
 * says the same thing at the moment it matters and needs no state to be kept
 * in sync.
 */
export function requireText(field: HTMLTextAreaElement, near: HTMLElement, message: string): void {
  const form = near.closest('form');
  const existing = form?.querySelector('.hub-form-error');
  const note = existing instanceof HTMLElement ? existing : document.createElement('p');
  note.className = 'hub-form-error';
  note.textContent = message;
  note.setAttribute('role', 'alert');
  if (!existing) near.insertAdjacentElement('beforebegin', note);
  // Through the composer: the textarea is hidden behind its editor, and
  // focusing a hidden control puts the caret nowhere the reader can see.
  focusMarkdownComposer(field);
  // Clears itself the moment the reason goes away, so it never contradicts
  // what the reader can see in the box.
  field.addEventListener('input', () => note.remove(), { once: true });
}
