/**
 * DOM renderers for the workspace hub (plan §3.9). Each function re-renders
 * one region into its container from the view model — no fetches, no Yjs —
 * so the interaction contracts (the status dropdown, in-place title edits,
 * the two-filter activity view) are testable under happy-dom.
 */
import { reviewAnswered } from '@feedback/core';
import { renderCommentMarkdown } from '../comment-markdown.ts';
import { PENCIL_ICON, PLUS_ICON, SPEECH_ICON } from '../icons.ts';
import { focusMarkdownComposer } from '../md-composer.ts';
import {
  type BoardSection,
  type HubGoal,
  type HubReviewItem,
  type HubTask,
  type TaskStatus,
} from './hub-board-model.ts';
import { type PanelReviewItem, type TaskDiscussion } from './hub-detail-render.ts';
import { answeredRecord, optionLabel, reviewBadge } from './hub-discussion-render.ts';
import {
  type ActivityEvent,
  type ActivityFilter,
  type HomePayload,
  type LeadSeatView,
  type UptimeReport,
  activityRows,
  describeEvent,
  homeSinceLabel,
  leadSeatLabel,
  timeAgo,
  uptimeSummary,
} from './hub-presence-model.ts';
import {
  LEGACY_REVIEW_ITEM_ID,
  type ReviewQueue,
  type ReviewThreadItem,
  decisionAskedBy,
  reviewBannerText,
  reviewItemThreadRequest,
} from './hub-review-model.ts';
import { caretOffsetIn } from './inline-rename.ts';
/**
 * Swap a title element for an input; Enter or blur commits a changed title,
 * Escape cancels (§3.9: tap the title text to edit, Enter commits). Cancel
 * restores the original text — the caller re-renders on commit anyway.
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
      // Blur SAVES a changed title (Bryan, 2026-09-01: "click outside while
      // editing — expect that the title saves, but it reverts instead").
      // It used to cancel, to protect against an accidental tap; the tap
      // that opens the editor never changes the text, so an unchanged or
      // emptied value still restores, and Escape is the deliberate cancel.
      if (!el.contains(input)) return;
      const v = input.value.trim();
      if (v && v !== original) {
        el.replaceChildren(put(v));
        commit(v);
      } else restore();
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
  /** Set the due date, or clear it with `null` — the same field the task
   *  panel carries, and the same "all fields must be human editable" rule
   *  (Bryan, 2026-08-18). Absent means the app has not wired one, and the
   *  field renders read-only text rather than a control nothing answers. */
  onDueSet?: (goalId: string, dueAt: number | null) => void;
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
  /** The board's own workspace id, so the Related Links section can link
   *  each doc at its canonical workspace address — same field, same reason,
   *  as the task panel's. Without it the section still renders, linking the
   *  legacy `/review/` shape instead. */
  workspaceId?: string;
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
 * "New task", "Make a plan" and "Have a discussion", in the slot the
 * quick-add box had.
 *
 * Bryan, 2026-08-29: *"From board, have a quick flow to create a new task
 * (replace current text box) that creates an empty item in the usual task
 * detail view. And have another button to start a planning huddle."* Neither
 * asks anything first: the task is an empty row the panel opens on with the
 * title ready to type, and the huddle is a doc the editor opens with the mic
 * already asked for.
 *
 * Renamed from "Start a planning huddle" / "Record a conversation" with the
 * round-4 entry mock (Bryan, 2026-09-01): the old labels named the mechanism;
 * these name what you leave with — a plan doc, or discussion notes. The
 * rename touches these buttons only; routes, params, classes and doc titles
 * keep the huddle name.
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
  huddle.innerHTML = `${PENCIL_ICON}<span>Make a plan</span>`;
  hold(huddle, handlers.onStartHuddle);
  const conversation = document.createElement('button');
  conversation.type = 'button';
  conversation.className = 'hub-btn hub-conversation-start';
  conversation.innerHTML = `${SPEECH_ICON}<span>Have a discussion</span>`;
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

/**
 * A review item raised on the TICKET, drawn as a row of the comment history.
 *
 * Same anatomy as a declaring comment's row (`commentRow`): who raised it and
 * when, the kind chip, the headline, the detail as the body — and, once
 * answered, the answered record. There is no comment text because there was
 * no comment: the item is the whole of what the agent said.
 */
export function reviewItemRow(item: HubReviewItem, now: number, selfName?: string): HTMLLIElement {
  const r = item.review;
  const withdrawn = r.withdrawnAt !== undefined;
  const li = document.createElement('li');
  li.className = 'hub-comment hub-comment-review hub-comment-ticket-item';
  li.dataset.reviewItemId = item.id;

  const head = document.createElement('div');
  head.className = 'hub-comment-head';
  const who = document.createElement('span');
  who.className = 'hub-comment-author';
  who.textContent = item.createdBy ?? 'Someone';
  head.append(who);
  if (item.createdAt !== undefined) {
    const when = document.createElement('span');
    when.className = 'hub-comment-when';
    when.textContent = timeAgo(item.createdAt, now);
    when.title = new Date(item.createdAt).toLocaleString();
    head.append(when);
  }
  head.append(reviewBadge(r.shape, withdrawn, item.answer !== undefined));
  li.append(head);

  const headline = document.createElement('p');
  headline.className = withdrawn
    ? 'hub-comment-review-headline is-withdrawn'
    : 'hub-comment-review-headline';
  headline.textContent = r.headline;
  li.append(headline);

  if (r.detail !== undefined && r.detail.trim() !== '') {
    const body = document.createElement('div');
    body.className = 'hub-comment-body';
    body.innerHTML = renderCommentMarkdown(r.detail);
    li.append(body);
  }

  if (item.answer !== undefined) {
    li.classList.add('hub-comment-answered-item');
    const a = item.answer;
    li.append(
      answeredRecord(
        {
          ...(a.by !== undefined ? { by: a.by } : {}),
          text: a.text,
          ...(a.ts !== undefined ? { at: a.ts } : {}),
        },
        now,
        selfName,
      ),
    );
  }
  return li;
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
  // The ticket's own decision — unless it is WAITING on its owner: the
  // reader asked on it, and it comes back marked Revised when the owner
  // revises (the same rule that keeps a waiting ticket item off the
  // review-items route, read off the projection here).
  if (!task.answer && task.needs === 'decision' && task.decisionState !== 'waiting') {
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
      // Came back revised after the reader asked: say so, quote the question,
      // and aim the focus-scroll at the thread — as a ticket item does.
      ...(task.decisionRevision
        ? {
            revision: {
              at: task.decisionRevision.at,
              ...(task.decisionRevision.question !== undefined
                ? { question: task.decisionRevision.question }
                : {}),
            },
            ...(task.decisionRevision.threadId ? { threadId: task.decisionRevision.threadId } : {}),
          }
        : {}),
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

/**
 * Where a panel card's QUESTION gets written — "I have a question", the
 * card's way of asking back without selecting a phrase. The same thread the
 * Home walkthrough's card makes (`reviewItemThreadRequest`, quoting the
 * headline as the phrase), so the item is derived `waiting` by the same rule
 * and leaves both queues on the same re-read. A ticket-borne card anchors
 * to its item; the ticket's OWN decision anchors to the derived `r-legacy`
 * row, quoting the title (its headline, server-side). A thread-borne card
 * has no item — its thread is where a question goes — so null, and the
 * card says so instead of drawing the link.
 */
export function panelQuestionRequest(
  task: Pick<HubTask, 'id' | 'title'>,
  item: PanelReviewItem,
  question: string,
): { path: string; body: Record<string, unknown> } | null {
  if (item.source === 'task') {
    return reviewItemThreadRequest(
      { taskId: task.id, reviewItemId: LEGACY_REVIEW_ITEM_ID },
      task.title,
      question,
    );
  }
  if (item.source !== 'task-review' || !item.reviewItemId) return null;
  return reviewItemThreadRequest(
    { taskId: task.id, reviewItemId: item.reviewItemId },
    item.headline,
    question,
  );
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
