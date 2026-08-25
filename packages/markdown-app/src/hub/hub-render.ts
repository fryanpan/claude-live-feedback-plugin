/**
 * DOM renderers for the workspace hub (plan §3.9). Each function re-renders
 * one region into its container from the view model — no fetches, no Yjs —
 * so the interaction contracts (the status dropdown, in-place title edits,
 * the two-filter activity view) are testable under happy-dom.
 */
import {
  REVIEW_LIMITS,
  type ReviewPayload,
  reviewAnswered,
  reviewItemBodyMarkdown,
} from '@feedback/core';
import type { ReviewShape } from '@feedback/core';
import {} from '@feedback/core/goal-summary';
import { renderCommentMarkdown, renderCommentMarkdownInline } from '../comment-markdown.ts';
import { MIC_ICON } from '../icons.ts';
import {
  type ComposerSelection,
  attachMarkdownComposer,
  composerSelection,
  composerState,
  focusMarkdownComposer,
  isComposerFocused,
  refreshMarkdownComposer,
} from '../md-composer.ts';
import { SPACE_HOLD_PAGE_ATTR } from '../voice-capture.ts';
import {
  type ActivityEvent,
  type ActivityFilter,
  type BlockerRow,
  type BoardSection,
  GENERIC_ASSIGNEE,
  GOAL_STATUS_ORDER,
  type HomePayload,
  type HubDecisionOption,
  type HubGoal,
  type HubTask,
  type HubTransition,
  type ReviewItem,
  type ReviewKind,
  type ReviewQueue,
  type ReviewThreadItem,
  TASK_STATUS_ORDER,
  type TaskStatus,
  type UnplacedNotice,
  type UptimeReport,
  activityRows,
  appendDictation,
  askedMeta,
  askedMetaLine,
  assigneeLabel,
  blockedNoteLine,
  describeEvent,
  homeSinceLabel,
  isTaskArchived,
  isTaskParked,
  ownerKindSuffix,
  ownerMarkKind,
  quoteAfterCapture,
  quoteAfterEdit,
  quoteForCapture,
  reviewBannerText,
  reviewCardHeadline,
  reviewHeadline,
  reviewItemBadge,
  reviewRowTitle,
  statusLabel,
  statusOptions,
  taskActivity,
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
function wireInPlaceTitle(
  el: HTMLElement,
  current: () => string,
  commit: (v: string) => void,
  keepKey?: string,
): (caret?: number) => void {
  const put = (text: string): Node => document.createTextNode(text);
  const begin = (caret?: number): void => {
    if (el.querySelector('input')) return;
    const original = current();
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
      el.replaceChildren(put(original));
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
): void {
  container.replaceChildren();
  container.classList.toggle('hub-lead-empty', !leadAgentId);
  const label = document.createElement('span');
  label.className = 'hub-lead-label';
  label.textContent = leadAgentId ? 'Lead agent' : 'No lead agent — nobody owns this board’s asks';
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
  /** Clock seam, so "3 hours ago" is assertable. */
  now?: number;
}

/**
 * The goal band's detail panel (decision 4: a coarse-pointer tap on the row
 * "opens the detail panel and never edits the title" — so the panel is not
 * optional chrome; without it a tap on Bryan's iPad does nothing at all).
 *
 * The first slice of the approved mock's panel: the identity line, the
 * renameable title, the status select with the open-children advisory, and
 * the facts the row deliberately does not carry — owner, due date, task
 * counts ("counts live in the detail panel", struck from the row by name).
 * The mock's description doc, refs and comment thread need server surfaces
 * a goal does not have yet (`GoalRow.body` is not projected, and no thread
 * container exists for a goal) and follow with them.
 *
 * Reuses the task panel's chrome classes wholesale — `.hub-detail-panel`,
 * head, fields — so the two panels read as one surface and the mobile
 * full-bleed layout comes free.
 */
export function renderGoalDetail(
  container: HTMLElement,
  section: BoardSection | null,
  handlers: GoalDetailHandlers,
  /** The goal's comments, as fetched. Absent while the app has not asked —
   *  the section is then omitted rather than drawn empty, so "no comments
   *  yet" is never shown about a discussion nobody has looked for. */
  discussion?: TaskDiscussion,
): void {
  // Snapshot any in-flight rename before the repaint destroys the input —
  // the same guarantee the task panel gives, via the same two helpers.
  const kept = keepFields(container);
  // And the live description editor, which is a websocket rather than a
  // field: the slot is the one node a repaint must not rebuild. Read BEFORE
  // `replaceChildren` below, same as the task panel.
  const keptSlot = section ? keptBodySlot(container, section.id) : null;
  // Backlog is a bucket, not a goal: nothing to declare, nothing to rename,
  // so there is deliberately no panel for it — same refusal as its row's.
  if (!section || section.isChores) {
    container.replaceChildren();
    container.classList.add('hidden');
    document.body.classList.remove('hub-detail-open');
    return;
  }
  container.classList.remove('hidden');
  document.body.classList.add('hub-detail-open');

  // REUSED when a live description editor is mounted, exactly as the task
  // panel does it: the slot must never leave the document, and the only way to
  // guarantee that is to keep its parent and patch around it.
  const panel = keptSlot?.parentElement ?? document.createElement('div');
  panel.className = 'hub-detail-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  // Focusable as a container, same as the task panel and for the same
  // reasons: the keyboard follows the dialog, and Escape has somewhere to
  // land without a global listener.
  panel.tabIndex = -1;
  panel.dataset.goalId = section.id;
  if (!keptSlot) {
    panel.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') handlers.onClose();
    });
  }
  // Everything the panel shows, split around the description — `before` goes
  // above the slot and `after` below it, so the slot itself stays put.
  const before: Node[] = [];
  const after: Node[] = [];

  const head = document.createElement('div');
  head.className = 'hub-detail-head';
  const identity = document.createElement('div');
  const kindTag = document.createElement('span');
  kindTag.className = 'hub-detail-kind';
  kindTag.textContent = 'Goal';
  const idTag = document.createElement('span');
  idTag.className = 'hub-detail-id';
  idTag.textContent = section.id;
  const idLine = document.createElement('div');
  idLine.className = 'hub-detail-kind-line';
  idLine.append(kindTag, idTag);
  const title = document.createElement('h2');
  title.className = 'hub-detail-title';
  title.textContent = section.title;
  title.tabIndex = 0;
  title.title = 'Click or press Enter to rename';
  wireInPlaceTitle(
    title,
    () => section.title,
    (v) => handlers.onTitleCommit(section.id, v),
    `goal-title:${section.id}`,
  );
  identity.append(idLine, title);
  const actions = document.createElement('div');
  actions.className = 'hub-detail-head-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'hub-btn hub-icon-btn hub-detail-close';
  close.textContent = '✕';
  close.title = 'Close goal detail';
  close.setAttribute('aria-label', 'Close goal detail');
  close.addEventListener('click', () => handlers.onClose());
  actions.append(close);
  head.append(identity, actions);

  const dl = document.createElement('dl');
  dl.className = 'hub-detail-fields';
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

  const statusCtl = document.createElement('span');
  statusCtl.className = 'hub-detail-statusctl';
  const status = document.createElement('select');
  status.className = 'hub-detail-select hub-detail-status hub-goal-detail-status';
  // GOAL_STATUS_ORDER, not TASK_STATUS_ORDER: a goal is never filed unvetted,
  // so triage is not one of the states this control may declare.
  for (const s of statusOptions(section.status ?? 'todo', GOAL_STATUS_ORDER)) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = statusLabel(s);
    // An undecorated section (an older server's projection) claims nothing;
    // the select then shows "To do" — the value a fresh row starts on.
    opt.selected = s === (section.status ?? 'todo');
    status.append(opt);
  }
  status.setAttribute('aria-label', 'Goal status — pick to declare a new one');
  status.addEventListener('change', () => {
    handlers.onStatusSet(section.id, status.value as TaskStatus);
  });
  statusCtl.append(status);
  cell('Status', statusCtl);
  // The vacancy is stated rather than hidden — an unowned goal is a fact a
  // reader acts on. No picker yet: no verb sets a goal's owner.
  cell('Owner', section.assignee ?? 'Nobody yet');
  if (section.dueAt !== undefined) {
    cell(
      'Due',
      `due ${new Date(section.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    );
  }
  // No `Tasks` breakdown. *"How many tasks are in triage/todo/in-progress/done
  // is just not useful information"* (Bryan, 2026-08-24, reviewing the live
  // panel). The board's band header still carries the count, where it answers
  // "how big is this band" while you are scanning; repeated inside the goal you
  // already opened it answered nothing and cost a row of a panel whose scarce
  // axis is height. A goal's detail now carries the same fields a task's does.
  const body = document.createElement('div');
  body.className = 'hub-detail-body';
  body.append(dl);

  if (section.status === 'done') {
    // The attribution the row can only whisper (its tooltip), said plainly
    // where there is room: a done goal is somebody's claim, and the claim
    // names its author.
    const note = document.createElement('p');
    note.className = 'hub-goal-done-note';
    const when =
      section.doneAt !== undefined
        ? `, ${new Date(section.doneAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
        : '';
    note.textContent = section.doneBy
      ? `Declared by ${section.doneBy.name}${when}`
      : 'Declared done';
    body.append(note);
  }
  // No open-children advisory either (Bryan, same review). It was never a
  // gate — the server has always accepted a done declaration over open
  // children (`enforce:false`) — so it spent two lines restating a rule
  // nothing enforced, on the one panel that has no room to spare.

  // ── Description ──────────────────────────────────────────────────────────
  //
  // The prose the whole ticket is about: *"the most important object on the
  // board is the only one you cannot explain"*. Same slot the task panel uses,
  // because the goal's body lives in the same kind of room — `task:<goalId>`
  // — and hub-app mounts the same live editor over it. Until that editor
  // paints, the slot holds the projection's text.
  //
  // Drawn unconditionally, including for a goal nobody has described: the
  // empty state is an invitation ("No description yet.") and, more to the
  // point, the slot has to EXIST for the editor to mount on.
  const bodyHead = document.createElement('h3');
  bodyHead.className = 'hub-detail-subhead hub-detail-body-head';
  bodyHead.textContent = 'Description';
  before.push(head, body, bodyHead);
  const slot = keptSlot ?? bodySlot(section);

  // A secondary way in, not the way to edit — the same room in the full
  // review surface, where anchored comments and the wider page live. Only
  // once the projection has told us the address; a link built from a guessed
  // docId would 404 on exactly the older servers that omit it.
  if (section.bodyDocId) {
    const link = document.createElement('p');
    link.className = 'hub-detail-body-link';
    const a = document.createElement('a');
    a.href = `/review/${encodeURIComponent(section.bodyDocId)}`;
    a.textContent = 'Open in the full editor';
    link.append(a);
    after.push(link);
  }

  // ── Discussion ───────────────────────────────────────────────────────────
  //
  // *"A single comment thread with review item support — so a decision about
  // a goal has somewhere to live."* Today that argument has to become a task
  // in a decisions band, which is why this board has decisions about goals
  // filed as peers of the work they govern.
  //
  // No tab row, unlike the task panel. A goal has no transitions worth a
  // second tab and no `quote` — its History is the band's, which the counts
  // above already say — so the conversation sits directly under the
  // description where a reader on a short screen reaches it by scrolling
  // rather than by finding a control.
  const onComment = handlers.onComment;
  if (discussion && onComment) {
    const commentsHead = document.createElement('h3');
    commentsHead.className = 'hub-detail-subhead';
    commentsHead.textContent = 'Comments';
    after.push(
      commentsHead,
      renderDiscussion(
        section.id,
        discussion,
        (text, threadId) => onComment(section.id, text, threadId),
        handlers.focusThreadId,
        handlers.now ?? Date.now(),
      ),
    );
  }

  if (keptSlot) {
    // Repaint AROUND the slot, never through it — the task panel's own
    // two-line patch, and the reason both panels keep the description as a
    // direct child of the dialog rather than nesting it in a section: only a
    // direct child can be left alone while everything beside it is rebuilt.
    for (const child of [...panel.childNodes]) if (child !== keptSlot) child.remove();
    for (const n of before) panel.insertBefore(n, keptSlot);
    panel.append(...after);
  } else {
    panel.append(...before, slot, ...after);
    container.addEventListener('click', (ev) => {
      if (ev.target === container) handlers.onClose();
    });
    container.replaceChildren(panel);
  }
  // A rename in flight when the repaint hit: reopen the editor, then let
  // `restoreFields` put the draft and the caret back — the task panel's own
  // two-step, for the same reason.
  if (kept.has(`goal-title:${section.id}`)) title.click();
  restoreFields(container, kept);
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
): void {
  container.replaceChildren();
  const head = document.createElement('div');
  head.className = 'hub-archived-head';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'hub-linklike hub-archived-back';
  back.textContent = '← Back to the board';
  back.addEventListener('click', () => handlers.onBack());
  const h = document.createElement('h3');
  h.className = 'hub-section-title';
  h.textContent = tasks.length === 1 ? '1 archived task' : `${tasks.length} archived tasks`;
  head.append(back, h);
  container.append(head);
  if (tasks.length === 0) {
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

export interface UnplacedStripHandlers {
  /** Take the reader to the longest-waiting unplaced task. */
  onOpenOldest: (taskId: string) => void;
}

/**
 * "3 tasks have no goal yet · oldest waiting 6d", directly above the board.
 *
 * Above it on purpose. The tasks this counts rest at the BOTTOM of Backlog,
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
  mic.innerHTML = MIC_ICON;
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

// ── Review banner (the board's one line about the queue) ──────────────────
//
// The full "For Your Review" pane is a Preact island now — see
// home-review-island.tsx. What stays here is the board's banner and the
// walkthrough card below.

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

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
   *  item came from, wherever that thread lives. `optionId` rides along when
   *  the reply came from tapping one of a declared item's candidates — the same
   *  shape `onAnswer` uses, because a tap and typed words must reach the thread
   *  by one path or the two will drift. */
  onReply: (item: ReviewItem, text: string, optionId?: string) => Promise<boolean>;
  /** Go to the exact place instead of answering here — the task's discussion at
   *  that thread, the doc anchored on that comment. */
  onOpenItem: (item: ReviewItem) => void;
  /** Move to another position in the queue (skip forward, step back). */
  onStep: (index: number) => void;
  onClose: () => void;
  /** What body of work this one belongs to — the mockup's project chip. Home
   *  is per-workspace, so the honest within-workspace answer is the goal;
   *  null renders no chip rather than a placeholder. */
  contextLabel?: (item: ReviewItem) => string | null;
}

/** The task's own description, or an honest line saying there isn't one. */
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
  // The mockup's Send is `.btn.primary`, which is INK-dark there rather than
  // accent-blue — the two blue buttons stacked under a decision card are what
  // got the old layout called weird. Secondary prompts pass a plain button.
  submitClass = 'hub-btn hub-btn-ink',
  // Key for `keepFields` — scoped to the item the box belongs to, so a draft
  // survives the repaint that rebuilt it but never follows the reader onto a
  // different card.
  keepKey?: string,
): HTMLFormElement {
  const form = document.createElement('form');
  form.className = className;
  const ta = document.createElement('textarea');
  ta.placeholder = placeholder;
  ta.rows = 3;
  if (keepKey) ta.dataset.keep = keepKey;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = submitClass;
  submit.textContent = submitLabel;
  form.append(ta, submit);
  // Every composer is a markdown editor (design point 4); the returned
  // refresh covers the programmatic clears below, which the editor cannot see.
  const refreshComposer = attachMarkdownComposer(ta);
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
    // Cleared HERE rather than on the acknowledgement, same as `commentForm`:
    // a repaint inside this await snapshots the box through `keepFields`, and
    // a restored copy of in-flight text is an enabled duplicate-submit path
    // whose eventual success would clear only the detached old box. Put back
    // verbatim if the write is refused.
    ta.value = '';
    refreshComposer();
    // Anything short of an acknowledged write puts the words back. A
    // mid-flight repaint replaces this form, so the words go to the LIVE box
    // carrying the same keep key — but never over something typed there
    // since; the detached original is the fallback, which keeps a
    // never-repainted form behaving exactly as before. In the corner where
    // all three collide — repaint, a new draft already begun, and a failed
    // write — the new draft wins and the failed one is dropped, deliberately:
    // rewriting a box while somebody is typing in it is the bug this whole
    // mechanism exists to remove, and a failed send is the one case of the
    // three the reader was just told about.
    const putBack = () => {
      const live = keepKey
        ? ta.ownerDocument.querySelector<HTMLTextAreaElement>(`textarea[data-keep="${keepKey}"]`)
        : null;
      const target = live && live !== ta && live.value.trim() === '' ? live : ta;
      target.value = text;
      if (target === ta) refreshComposer();
      else refreshMarkdownComposer(target);
    };
    void Promise.resolve(onSubmit(text))
      .then((ok) => {
        if (ok !== true) putBack();
      })
      .catch(() => {
        putBack();
      })
      .finally(() => {
        busy = false;
        ta.disabled = false;
        submit.disabled = false;
      });
  });
  return form;
}

/**
 * The `‹ N of M ›` stepper (mockup: right-aligned in the "Review" head),
 * shared by both card kinds because "go through the list" is the feature and
 * it must not stop working when the next item is a comment. Lives in the page
 * head around the position readout, so stepping does not mean scrolling past
 * a long card to find the buttons.
 */
function walkStepper(
  index: number,
  total: number,
  pos: HTMLElement,
  handlers: WalkthroughHandlers,
): HTMLElement {
  const nav = document.createElement('span');
  nav.className = 'hub-walk-nav';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'hub-btn hub-walk-back';
  back.textContent = '‹';
  back.setAttribute('aria-label', 'Back');
  back.disabled = index === 0;
  back.addEventListener('click', () => handlers.onStep(index - 1));
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'hub-btn hub-walk-skip';
  skip.textContent = '›';
  skip.setAttribute('aria-label', index + 1 === total ? 'Skip — finish' : 'Skip for now');
  skip.addEventListener('click', () => handlers.onStep(index + 1));
  nav.append(back, pos, skip);
  return nav;
}

/**
 * The mockup's card head, in its order: kind badge, the question, the chip
 * saying which body of work it belongs to, and how long it has waited.
 *
 * The badge and the chip carry the same `.k` shape in the mockup and the same
 * one here, so a new kind cannot arrive looking like a different component.
 */
function walkCardHead(item: ReviewItem, handlers: WalkthroughHandlers, now: number): HTMLElement {
  const head = document.createElement('div');
  head.className = 'hub-walk-card-head';

  const badge = reviewItemBadge(item);
  const kind = document.createElement('span');
  kind.className = `hub-walk-k hub-walk-k-${badge.tone}`;
  kind.textContent = badge.label;

  const title = document.createElement('h3');
  title.className = 'hub-walk-title';
  // The QUESTION, not the subject — the same title the queue row shows, so
  // tapping a row and stepping onto it cannot read as two different items.
  // In its heading form: a typed question is often a paragraph, and the whole
  // of it is on the card already, in the quote below. A DECLARED headline is
  // already a heading and goes through untouched — clipping it at the first
  // sentence terminator is what "Ship v2 now. Or wait?" cannot survive.
  title.textContent = reviewCardHeadline(item);
  head.append(kind, title);

  const context = handlers.contextLabel?.(item);
  if (context && context.trim() !== '') {
    const chip = document.createElement('span');
    chip.className = 'hub-walk-k hub-walk-k-count';
    chip.textContent = context;
    head.append(chip);
  }

  const wait = document.createElement('span');
  wait.className = 'hub-walk-wait';
  // The head's top-right meta is the card's ONE provenance line — who asked
  // and how long ago — replacing both the bare wait chip and the old
  // left-bordered context block (approved design, review-flow-mock-v1).
  wait.textContent = askedMeta(item, now);
  head.append(wait);
  return head;
}

/**
 * A declared item's ONE body, read through core and rendered as markdown. The
 * labelled sub-sections this replaces ("What to review for", the separate
 * detail block) are the anatomy the approved design collapsed — every word is
 * still here, in the author's order, unlabelled.
 * `renderCommentMarkdown` escapes first and only re-adds known-safe tags.
 */
function walkReviewBody(
  review: NonNullable<ReviewItem['review']>,
  expanded: boolean,
): DocumentFragment | null {
  const markdown = reviewItemBodyMarkdown(review);
  if (markdown === '') return null;
  const frag = document.createDocumentFragment();
  const body = document.createElement('div');
  body.className = 'hub-walk-body';
  body.innerHTML = renderCommentMarkdown(markdown);
  frag.append(body);
  // Marked whether or not it clamps: the snapshot below asks "was this body
  // one that CAN clamp, and had the reader already opened it" — and an
  // unmarked body is indistinguishable from a short one that never clamped.
  if (expanded) body.dataset.walkExpanded = '1';
  // The API stopped refusing a long detail (the refusal split every real ask
  // into a thread body and a weaker card copy), so the card now has to carry
  // it: the FULL words are always in the DOM — card and thread say the same
  // thing — and past the review target the body clamps ON THE PHONE TIER
  // ONLY (the CSS scopes it; wider screens render everything, since 430px is
  // where an unbounded body buries the options and the composer). The button
  // is the explicit expand affordance; expanding is one-way, like reading.
  if (markdown.split(/\s+/).length > REVIEW_LIMITS.detailTargetWords.review && !expanded) {
    body.classList.add('hub-walk-body-clamp');
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'hub-walk-body-expand';
    expand.textContent = 'Show the whole ask';
    expand.addEventListener('click', () => {
      body.classList.remove('hub-walk-body-clamp');
      body.dataset.walkExpanded = '1';
      expand.remove();
    });
    frag.append(expand);
  }
  return frag;
}

/**
 * The one pointer up and out of the card: the task or doc this came from.
 *
 * ALWAYS rendered, on every kind. It used to be dropped for an item whose
 * question IS its subject, on the grounds that naming the subject would print
 * the same words twice — true of the words, and it left those cards with no
 * exit at all. That was survivable only while the queue row itself navigated;
 * now that a row opens the card, this link is the reader's ONLY way to the
 * resource, so a card without it is a dead end. Where the title would repeat
 * the headline, the link says what it does instead of what it points at.
 */
function walkWhere(item: ReviewItem, handlers: WalkthroughHandlers): HTMLElement {
  const doc = item.kind === 'doc-thread';
  const where = document.createElement('p');
  where.className = 'hub-walk-where';
  const label = document.createElement('b');
  label.textContent = doc ? 'Doc:' : 'Task:';
  const open = document.createElement('button');
  open.type = 'button';
  // Its own class, kept distinct from every button class the cards use:
  // sharing a selector with a primary button once turned this link into bare
  // blue text — measured on staging at 430px.
  open.className = 'hub-walk-where-link';
  const title = item.title.trim();
  // Compared against the ROW title rather than the rendered headline: the
  // headline clips, so a long subject would differ from itself and read as
  // new information the card has already shown.
  const names = title !== '' && title !== reviewRowTitle(item).trim();
  open.textContent = names ? `${title} ↗` : `${doc ? 'Open the doc' : 'Open the task'} ↗`;
  open.addEventListener('click', () => handlers.onOpenItem(item));
  where.append(label, document.createTextNode(' '), open);
  return where;
}

/** The mockup's `Skip for now` row. The `›` stepper does the same move; both
 *  exist because the stepper is where you look to navigate and this is where
 *  you look when you have decided not to answer. */
function walkActions(index: number, handlers: WalkthroughHandlers): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'hub-walk-actions';
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'hub-btn hub-btn-ghost hub-walk-skip-link';
  skip.textContent = 'Skip for now';
  skip.addEventListener('click', () => handlers.onStep(index + 1));
  actions.append(skip);
  return actions;
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

/** How the thing you just finished reads in the banner. A ticket-borne
 *  review item is ANSWERED like a decision — nothing was replied on. */
function clearedVerb(kind: ReviewKind): string {
  return kind === 'decision' || kind === 'task-review' ? 'Answered' : 'Replied on';
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
 * A PAGE, not a modal (approved mockup home-pane-mockup-v1). It replaces the
 * Home pane's content behind a `‹ Back to Home` link and keeps the workspace
 * shell — rail, topbar — where it was. The previous cut floated a dialog over
 * the board with its own dimmed backdrop and a ✕, which is what got the
 * layout called weird: a queue you work for several minutes is somewhere you
 * go, not something that interrupts you.
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
  now: number = Date.now(),
): void {
  // The board repaints this surface on every SSE event — a task moving, a
  // presence change — and a repaint rebuilds the card the reader may be
  // typing an answer into. Same guarantee the detail panel gives: read the
  // drafts out before the swap, put them back after.
  const kept = keepFields(container);
  // …and the same guarantee for what the reader OPENED. Both expansions on
  // this card used to live only in the DOM the swap throws away, so a
  // background event a second later closed them with nothing the reader did:
  // Bryan, 2026-08-24 — "when I expand a task, it collapses a second later".
  // Keyed on the item, so it is this card's expansion and not the next one's.
  const wasOn = container.dataset.walkItem ?? '';
  const openBefore = {
    body: container.querySelector('.hub-walk-body[data-walk-expanded]') !== null,
    info: (() => {
      const info = container.querySelector('.hub-walk-info');
      return info !== null && !info.classList.contains('hidden');
    })(),
  };
  container.replaceChildren();
  if (index < 0) {
    container.classList.add('hidden');
    delete container.dataset.walkItem;
    return;
  }
  container.classList.remove('hidden');

  const panel = document.createElement('div');
  panel.className = 'hub-walk-panel';

  // The way back out, above everything (mockup: its own row over the head).
  const topline = document.createElement('div');
  topline.className = 'hub-walk-topline';
  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'hub-btn hub-btn-ghost hub-walk-home';
  home.textContent = '‹ Back to Home';
  home.addEventListener('click', () => handlers.onClose());
  topline.append(home);
  panel.append(topline);

  const item = queue.items[index];
  // Only what the reader opened ON THIS ITEM comes back. Moving on — or
  // having the item answered out from under them — draws the next card the
  // way it was authored, rather than unfolding a body nobody asked to see.
  const open = item && wasOn === item.key ? openBefore : { body: false, info: false };
  if (item) container.dataset.walkItem = item.key;
  else delete container.dataset.walkItem;
  // Only a decision gets the answer furniture — the thread kinds below get a
  // reply path instead. (A blocker never reaches this queue at all: it is
  // task state, surfaced as the detail panel's blocked note.)
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
    close.textContent = 'Back to Home';
    close.addEventListener('click', () => handlers.onClose());
    done.append(close);
    panel.append(done);
    container.append(panel);
    return;
  }

  const head = document.createElement('div');
  head.className = 'hub-walk-head';
  const heading = document.createElement('h2');
  heading.className = 'hub-walk-heading';
  heading.textContent = 'Review';
  const pos = document.createElement('span');
  pos.className = 'hub-walk-pos';
  // Two readings, because the queue shrinks as it is worked and neither number
  // alone says you moved: where you are in what REMAINS, and what this sitting
  // has taken off the list. The ‹ › stepper wraps the readout.
  pos.textContent = `${index + 1} of ${queue.items.length}`;
  if (progress.cleared > 0) {
    const cleared = document.createElement('span');
    cleared.className = 'hub-walk-cleared';
    cleared.textContent = `${progress.cleared} cleared`;
    pos.append(cleared);
  }
  head.append(heading, walkStepper(index, queue.items.length, pos, handlers));
  panel.append(head);

  const card = document.createElement('div');
  card.className = `hub-walk-card hub-walk-${item.kind}`;

  // First thing on the card, above the new item: what you just finished. It
  // belongs here rather than in a toast because this is read on a phone, where
  // a toast is gone before the thumb has come back down.
  const banner = advancedBanner(progress, handlers);
  if (banner) card.append(banner);

  // ONE anatomy (approved design): head row — kind badge, headline, goal
  // chip, asked-by meta — then one markdown body. The separate why line and
  // the left-bordered provenance block are gone; the why leads the body, and
  // the who/when lives in the head's meta.
  card.append(walkCardHead(item, handlers, now));

  // ── A thread: the question, a reply box, and the way out to the surface it
  // lives on. Answering here is the point — going through the queue must not
  // mean leaving the queue on every item — but a comment sometimes only makes
  // sense in place, so "open where this lives" is always offered.
  if (!row) {
    card.append(walkWhere(item, handlers));
    const review = item.review;
    if (review) {
      // A DECLARED review item. Everything below was written by the agent for
      // this card, so none of it is derived, clipped or guessed at — which is
      // the whole reason declaring exists.
      const body = walkReviewBody(review, open.body);
      if (body) card.append(body);
      if (review.options && review.options.length > 0) {
        const opts = document.createElement('div');
        opts.className = 'hub-walk-options';
        for (const o of review.options) {
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
          // The same contract a decision task's options have: the LABEL is the
          // verbatim reply, the id says which candidate it was. One reply path,
          // so a tap and a typed answer land in the thread identically.
          b.addEventListener('click', () => handlers.onReply(item, o.label, o.id));
          opts.append(b);
        }
        card.append(opts);
      }
    } else if (reviewHeadline(item.ask) !== item.ask.trim().replace(/\s+/g, ' ')) {
      // The mockup's "What I need from you" block — rendered only when it says
      // more than the heading already did. A one-line question fits in the
      // heading, and quoting it again underneath is the card repeating itself.
      const box = document.createElement('div');
      box.className = 'hub-walk-askbox';
      const askHead = document.createElement('h4');
      askHead.className = 'hub-walk-ask-head';
      askHead.textContent = 'What I need from you';
      const ask = document.createElement('blockquote');
      ask.className = 'hub-walk-ask';
      ask.textContent = item.ask;
      box.append(askHead, ask);
      card.append(box);
    }
    // Always present, options or not — the candidates are a shortcut, never a
    // closed set, and a review item with no options only has this.
    card.append(
      promptForm(
        'hub-walk-answer',
        review?.options?.length ? '…or answer in your own words' : 'Reply…',
        'Send',
        (text) => handlers.onReply(item, text),
        undefined,
        `walk-answer:${item.key}`,
      ),
    );
    card.append(walkActions(index, handlers));
    panel.append(card);
    container.append(panel);
    restoreFields(container, kept);
    return;
  }

  const task = row.task;

  // The same pointer out the thread kinds carry. A decision card had none —
  // the only route from the queue to its task was the Home row, and the row
  // now opens this card instead.
  card.append(walkWhere(item, handlers));

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
      '…or answer in your own words — the agent gets your text verbatim',
      'Send',
      (text) => handlers.onAnswer(task, text),
      undefined,
      `walk-answer:${task.id}`,
    ),
  );

  // "I can't answer this yet" has no card in the mockup, because the mockup
  // has no such concept — and this is the only surface that offers it, so
  // dropping it to match would delete the capability rather than restyle it.
  // Collapsed behind a ghost control in the actions row: the card reads as
  // the mockup does until a stuck reviewer goes looking.
  const actions = walkActions(index, handlers);
  const info = promptForm(
    'hub-walk-info hidden',
    "Not enough to decide? Ask for what's missing…",
    'Send question',
    (text) => handlers.onMoreInfo(task, text),
    'hub-btn',
    `walk-info:${task.id}`,
  );
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'hub-btn hub-btn-ghost hub-walk-more';
  more.textContent = 'Tell me more';
  more.setAttribute('aria-expanded', 'false');
  more.addEventListener('click', () => {
    const open = info.classList.toggle('hidden');
    more.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (!open) info.querySelector('textarea')?.focus();
  });
  actions.append(more);
  card.append(actions, info);

  panel.append(card);

  container.append(panel);
  restoreFields(container, kept);
  // A restored draft inside a re-hidden panel is still a lost draft: the
  // open/closed state lives in the DOM the repaint just threw away, so reopen
  // the ask box when the reader was mid-question.
  const infoSnap = kept.get(`walk-info:${task.id}`);
  if (open.info || (infoSnap && (infoSnap.value.trim() !== '' || infoSnap.focused))) {
    info.classList.remove('hidden');
    more.setAttribute('aria-expanded', 'true');
  }
}

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
   *  `hub-model`'s `goalLabel`, which resolves subgoals and Backlog. The panel
   *  is where a reader goes to find out what a task is FOR, so an id is a
   *  fact about the store rather than an answer. Optional, and without it the
   *  row falls back to the id — a missing lookup must not blank it. */
  goalLabel?: (goalId: string) => string;
  /** The board's own goal sections, so the Goal field can offer them. Without
   *  it the field still renders — showing this task's goal and nothing else —
   *  rather than disappearing, because a field that vanishes when a lookup is
   *  missing reads as a bug in the task. */
  goals?: HubGoal[];
  /** Move the task to another goal or subgoal. */
  onGoalSet?: (task: HubTask, goalId: string) => void;
  /** Set the due date, or clear it with `null`. */
  onDueSet?: (task: HubTask, dueAt: number | null) => void;
  /** Defer the task to a date, or un-park it with `null`. Never moves the
   *  row — parking is not a status. */
  onParkSet?: (task: HubTask, parkedUntil: number | null) => void;
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
  /** The one thread the reader was sent here to answer, when they arrived
   *  from the review queue. Marked and scrolled to — "open the task" is not
   *  the promise the strip makes on a task with six discussions. */
  focusThreadId?: string;
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

function commentForm(
  className: string,
  placeholder: string,
  submitLabel: string,
  onSubmit: (text: string) => Promise<boolean>,
  keepKey: string,
): HTMLFormElement {
  const form = document.createElement('form');
  form.className = className;
  const ta = document.createElement('textarea');
  ta.placeholder = placeholder;
  ta.rows = 2;
  ta.dataset.keep = keepKey;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'hub-btn';
  submit.textContent = submitLabel;
  form.append(ta, submit);
  // Every composer is a markdown editor (design point 4); refresh covers the
  // programmatic clear and restore below, which the editor cannot see.
  const refreshComposer = attachMarkdownComposer(ta);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = ta.value.trim();
    if (!text) {
      // An empty submit was a silent no-op: the button was enabled, the click
      // registered, and nothing at all happened or was said.
      requireText(ta, submit, 'Write something first');
      return;
    }
    ta.disabled = true;
    submit.disabled = true;
    // Cleared HERE rather than in the `then`. Posting a comment reloads the
    // discussion, which repaints the panel from inside this await — and
    // `keepFields` snapshots this box on the way through. So the old clear ran
    // on a detached textarea while the rebuilt one came back holding the
    // comment that had just been posted, and the obvious second click posted
    // it twice. Put back verbatim if the post is refused.
    ta.value = '';
    refreshComposer();
    // `Promise.resolve` rather than `await onSubmit(...)` so a handler that
    // returns nothing at all still settles here instead of throwing.
    void Promise.resolve(onSubmit(text))
      .then((ok) => {
        if (!ok) {
          ta.value = text;
          refreshComposer();
        }
      })
      .catch(() => {
        ta.value = text;
        refreshComposer();
      })
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
 * The task's Discussion: ONE chronological sequence of comments, and ONE
 * composer at the bottom.
 *
 * Three rounds of the same complaint got it here, each removing a layer of
 * threading from the SURFACE. First there were N + 1 composers — a reply box
 * inside every thread plus a new-thread box under them all. Then one composer,
 * with each thread still drawn as its own bordered box. Then one stream of
 * rows, but with a Reply button per conversation, a "Replying below" state and
 * a "New thread" button. Bryan, 2026-08-18, on that last one: *"Mocks still
 * show threaded comments design. I explicitly asked for that to be removed."*
 *
 * So there is now no threading affordance at all: no reply target to choose,
 * nothing naming a thread, no way to start one by hand. What a reader sees is
 * what they were promised — *"a single sequence of comments with clearer
 * separation, authorship and timing"* — and the composer's destination is
 * DERIVED (`composerTarget`) rather than picked.
 *
 * Storage did not move, and deliberately: threads remain exactly as
 * `create_thread` writes them (34 of 37 on the live board carry a text anchor
 * into the description) and `resolve_thread` still means "this point is
 * handled". Flattening the render is reversible; flattening the store would
 * destroy the anchors and redefine an MCP verb that has callers. Nothing in
 * this render reads a thread's identity except `data-thread-id`, which is data
 * rather than presentation — it is how a reply reaches the agent watching that
 * conversation.
 */
/**
 * Takes a bare `rowId` and a bound `post`, rather than a `HubTask` and a
 * handler that re-derives the row: a GOAL's discussion is the same surface
 * over the same thread API pointed at the same kind of body room, and the only
 * thing this function ever wanted from the task was an id to key the draft on.
 * The callers hold the row and close over it.
 */
function renderDiscussion(
  rowId: string,
  discussion: TaskDiscussion,
  post: (text: string, threadId?: string) => Promise<boolean>,
  focusThreadId?: string,
  now: number = Date.now(),
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'hub-discussion';
  // Threads waiting on a person are NOT badged here any more, and this
  // function no longer takes `asks` at all. That signal renders in the review
  // queue at the top of the panel, above the fold, which is where the reader
  // was told to look — a second copy on the comment row is the same
  // duplication the description/decision-card overlap already cost us.

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

  const target = composerTarget(discussion.threads, focusThreadId);

  const stream = document.createElement('ol');
  stream.className = 'hub-comment-stream';
  for (const row of flattenComments(discussion.threads)) {
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
      const badge = document.createElement('span');
      badge.className = 'hub-comment-review-k';
      badge.textContent = c.review.shape === 'decision' ? 'Decision' : 'Question';
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
      headline.className = 'hub-comment-review-headline';
      headline.textContent = c.review.headline;
      li.append(headline);
    }

    const body = document.createElement('div');
    body.className = 'hub-comment-body';
    // Same escape-then-allow-known-tags path the description uses, so a
    // comment written by anyone with write access is inert markup.
    body.innerHTML = renderCommentMarkdown(c.text);
    li.append(body);

    stream.append(li);
  }
  if (stream.childElementCount > 0) section.append(stream);

  // One box, one verb, no target row above it. The destination is derived and
  // the reader is not told about it, because being told about it is the
  // threading UI they asked to have removed — and there is nothing they could
  // do with the information anyway.
  const form = commentForm(
    'hub-comment-form',
    'Add a comment…',
    'Comment',
    (text) => post(text, target?.id),
    // Keyed by row: a draft survives every repaint of this panel and never
    // follows the reader onto a different task or goal.
    `discussion:${rowId}`,
  );
  section.append(form);
  return section;
}

/** One audit row in a ticket's history, in the same sentence the workspace
 *  Activity view would read it in — one `describeEvent`, two surfaces. */
function activityRow(ev: ActivityEvent, title: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'hub-detail-activity-row';
  li.title = new Date(ev.ts).toLocaleString();
  const what = document.createElement('span');
  what.textContent = describeEvent(ev, () => title);
  li.append(what);
  return li;
}

function renderTransitionRow(t: HubTransition): HTMLLIElement {
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
 * both: it is the key `keptBodySlot` and `TaskBodyEditorHost.sync` match on,
 * and renaming it to something kind-neutral would be a rename across two
 * files to say nothing new.
 */
interface BodyRow {
  id: string;
  body?: string;
  bodyTruncated?: boolean;
}

function bodySlot(row: BodyRow): HTMLElement {
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
 * `rowId` rather than a task, because a GOAL's description is a live editor
 * over a websocket too and needs the same repaint guarantee. The panel on
 * screen is identified by whichever id it carries — `dataset.taskId` on the
 * task panel, `dataset.goalId` on the goal one — and the two id spaces do not
 * overlap (`t-…` against `g-…`), so asking both cannot match the wrong panel.
 */
function keptBodySlot(container: HTMLElement, rowId: string): HTMLElement | null {
  const prior = container.querySelector<HTMLElement>('.hub-detail-panel');
  if (!prior) return null;
  if (prior.dataset.taskId !== rowId && prior.dataset.goalId !== rowId) return null;
  const slot = prior.querySelector<HTMLElement>('.hub-detail-body-slot');
  return slot &&
    slot.parentElement === prior &&
    slot.dataset.taskId === rowId &&
    slot.classList.contains(BODY_LIVE_CLASS)
    ? slot
    : null;
}

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
function detailFields(task: HubTask, handlers: DetailHandlers): HTMLElement {
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
  // options here are the sections a reader can already see — including
  // subgoals, which is the grain a task is actually placed at. The task's own
  // goal is always present even when the list does not have it: a stale or
  // deleted band must not silently re-place the task on the next change event.
  const goal = document.createElement('select');
  goal.className = 'hub-detail-select hub-detail-goal';
  const seen = new Set<string>();
  const addGoalOption = (id: string, label: string, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = depth > 0 ? `— ${label}` : label;
    goal.append(opt);
  };
  for (const g of handlers.goals ?? []) {
    addGoalOption(g.id, g.title, 0);
    for (const sub of g.subgoals ?? []) addGoalOption(sub.id, sub.title, 1);
  }
  addGoalOption(task.goal, handlers.goalLabel?.(task.goal) ?? task.goal, 0);
  goal.value = task.goal;
  goal.setAttribute('aria-label', 'Goal');
  goal.addEventListener('change', () => {
    if (goal.value && goal.value !== task.goal) handlers.onGoalSet?.(task, goal.value);
  });
  cell('Goal', goal);
  return dl;
}

/** An epoch-ms instant as the `YYYY-MM-DD` a `<input type="date">` wants, in
 *  the reader's own timezone. `toISOString().slice(0,10)` is the tempting
 *  one-liner and it is wrong west of UTC for anything set in the evening. */
function localDateInputValue(ts: number): string {
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
  source: 'task' | 'thread';
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
      since: task.createdAt,
      asked: true,
    });
  }
  for (const a of asks ?? []) {
    const r = a.review;
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

/** The verbatim words a tapped option recorded, when the payload still holds
 *  the candidate list. Undefined otherwise — the record never invents words. */
function optionLabel(r: ReviewPayload, optionId: string | undefined): string | undefined {
  if (optionId === undefined) return undefined;
  return r.options?.find((o) => o.id === optionId)?.label;
}

/**
 * The review queue INSIDE a ticket: what is waiting on the reader, one item
 * expanded, with a walkthrough when there is more than one.
 *
 * Two complaints shaped this. The layout one, reported against the same card
 * on the Home queue (2026-08-18): *"options crammed against their details, no
 * spacing between the answer buttons, no spacing between buttons and comment
 * text, nothing aligned."* The task-detail copy had NO stylesheet rules at all
 * — every class it emitted was unstyled, so the browser's defaults stacked the
 * options edge to edge. And the content one, the same day: the card jumped
 * from "WAITING ON YOUR DECISION" straight to the buttons, leaning on the
 * ticket title to say what was being decided.
 *
 * The `hub-decide-*` classes are deliberately NOT panel-specific: one layout
 * for "here is a question and here are the ways to answer it", defined once,
 * for the Home card to adopt when that ticket comes off hold rather than
 * growing a second layout that drifts from this one.
 *
 * The walkthrough chrome appears only from two items up. With one — the common
 * case — this renders exactly the single card it always did, because a "1 of 1"
 * counter and two dead arrows are furniture that says nothing.
 */
function reviewQueueRegion(
  task: HubTask,
  handlers: DetailHandlers,
  now: number,
  prior: { index: number; itemId: string | null },
  discussion?: TaskDiscussion,
): HTMLElement | null {
  // What was decided, and the way back out of it.
  //
  // This used to RETURN here, which retired the whole region the moment the
  // task's own decision was answered — including thread items that were still
  // open server-side. Measured in the browser 2026-08-18: answering the
  // decision on a task with two open thread items left the reader with no
  // queue at all and nothing saying two questions were still waiting. The
  // answered line is now one part of the region, and the queue below it
  // carries whatever is still open.
  const answered = task.answer ? answeredNote(task, handlers) : null;
  const queue = panelReviewQueue(task, handlers.asks, discussion);
  if (queue.length === 0) {
    if (!answered) return null;
    const only = document.createElement('section');
    only.className = 'hub-decide hub-decide--answered';
    only.append(answered);
    return only;
  }
  // `prior.index < 0` means "this is a fresh open, there is no position to
  // keep" — so a deep link into a thread opens the queue AT that thread's
  // item rather than at whatever happened to be first.
  const linked =
    prior.index < 0 && handlers.focusThreadId
      ? queue.findIndex((i) => i.threadId === handlers.focusThreadId)
      : -1;
  // Position is the ITEM, not its number — this is what `PanelReviewItem.id`
  // exists for. A repaint that inserts an item ahead (a peer's undo puts the
  // task's own decision back at rank 0) must not swap which question is
  // shown under the reader mid-thought; the numeric index is only the
  // fallback for when the kept item itself left the queue.
  const kept = prior.itemId !== null ? queue.findIndex((i) => i.id === prior.itemId) : -1;
  const wanted = linked >= 0 ? linked : kept >= 0 ? kept : prior.index;
  let at = Math.min(Math.max(Number.isInteger(wanted) ? wanted : 0, 0), queue.length - 1);

  const region = document.createElement('section');
  region.className = 'hub-decide';
  region.dataset.reviewIndex = String(at);
  if (answered) region.append(answered);

  const head = document.createElement('div');
  head.className = 'hub-decide-head';
  const kicker = document.createElement('p');
  kicker.className = 'hub-decide-kicker';
  head.append(kicker);
  const count = document.createElement('span');
  count.className = 'hub-decide-count';
  const prev = document.createElement('button');
  const next = document.createElement('button');
  if (queue.length > 1) {
    const walk = document.createElement('div');
    walk.className = 'hub-decide-walk';
    for (const [b, label, glyph] of [
      [prev, 'Previous item', '‹'],
      [next, 'Next item', '›'],
    ] as const) {
      b.type = 'button';
      b.className = 'hub-btn hub-decide-step';
      b.textContent = glyph;
      b.setAttribute('aria-label', label);
    }
    walk.append(prev, count, next);
    head.append(walk);
  }
  region.append(head);

  // Every item is BUILT, and the walkthrough only changes which one is shown.
  // Same reasoning as the tabs: repainting to step the queue would tear down
  // the answer box the reader may be typing in, and the panel already repaints
  // on every board change without anybody asking it to.
  const cards = queue.map((item) => reviewItemCard(task, item, handlers, now));
  region.append(...cards);

  const show = (i: number): void => {
    at = Math.min(Math.max(i, 0), queue.length - 1);
    region.dataset.reviewIndex = String(at);
    // The shown item's identity, for the next repaint to restore by — the
    // index alone names a different item the moment the queue moves.
    region.dataset.reviewItemId = queue[at]?.id ?? '';
    cards.forEach((c, ci) => c.classList.toggle('hidden', ci !== at));
    const item = queue[at];
    // Two headings. There was a third — "Flagged for you — not addressed to
    // you by name" over an item whose `direct` flag came back false — and it
    // is gone per the mock direction. It was written when an undeclared status
    // note could reach this queue (measured 2026-08-17: 23 items, ZERO of them
    // `direct`), and it hedged the heading because the row underneath might
    // not be a question at all. Membership is decided server-side now — a row
    // here is a declared item or a surviving direct ask — so the hedge
    // apologises for a row that no longer arrives, in the reader's most
    // prominent line.
    kicker.textContent =
      item?.shape === 'decision' ? 'Waiting on your decision' : 'Waiting on your review';
    // A settled item is none of the above: the card below it is the RECORD,
    // and the kicker says so. An override rather than a fourth ternary arm so
    // the three waiting headings above stay exactly as written.
    if (item?.answered !== undefined) kicker.textContent = 'Answered';
    count.textContent = `${at + 1} of ${queue.length}`;
    prev.disabled = at === 0;
    next.disabled = at === queue.length - 1;
  };
  prev.addEventListener('click', () => show(at - 1));
  next.addEventListener('click', () => show(at + 1));
  show(at);
  return region;
}

/**
 * What was decided — and the way back out of it.
 *
 * Answering is a single click with no confirmation step, which is the right
 * cost for the common case and unrecoverable for the stray one. The recovery
 * chosen here is a persistent UNDO rather than a confirm dialog or a
 * five-second toast, for three reasons: it does not tax the 99% of taps that
 * are deliberate, it is still there when the reader notices the mistake a
 * minute later, and it survives a reload because it is rendered from the
 * stored answer rather than from a timer nobody can see. The write behind it
 * is reversible too — the server moves the answer to `answerHistory` rather
 * than dropping it.
 */
function answeredNote(task: HubTask, handlers: DetailHandlers): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'hub-detail-answered';
  const ans = document.createElement('p');
  ans.className = 'hub-detail-answer';
  const answer = task.answer;
  ans.textContent = answer ? `Answered by ${answer.by}: “${answer.text}”` : '';
  wrap.append(ans);
  if (!handlers.onUndoAnswer) return wrap;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'hub-btn hub-detail-undo-answer';
  undo.textContent = 'Undo';
  undo.title = 'Take this answer back — it reopens the decision and keeps a record';
  undo.setAttribute('aria-label', 'Undo this answer and reopen the decision');
  undo.addEventListener('click', () => {
    // Disabled for the round trip. On success the panel repaints without this
    // note, so nothing here needs to happen. On FAILURE the handler resolves
    // `false` — the app's `send()` never rejects, it reports fetch errors as
    // `{ok: false}` — and the app returns before its `loadReviewItems()`, so
    // no repaint rebuilds this button either. Re-enabling on that resolved
    // `false` (same contract as `reviewItemCard`'s answer path) is the only
    // thing that gives the reader a retry on a quiet board; the `.catch` alone
    // could never fire.
    undo.disabled = true;
    void Promise.resolve(handlers.onUndoAnswer?.(task))
      .then((ok) => {
        if (ok === false) undo.disabled = false;
      })
      .catch(() => {
        undo.disabled = false;
      });
  });
  wrap.append(undo);
  return wrap;
}

/**
 * The answered RECORD for a thread-borne item, in place: the same anatomy as
 * the task decision's `answeredNote` — "Answered by …" and a persistent Undo
 * — because a typed answer and a tapped option produce the identical record
 * (approved design). "you" when the reader is the one who answered; the
 * answer's words render markdown-inline, since they are a comment's words.
 * The Undo goes through the thread-answer undo route, which moves the stamps
 * into `answerHistory` rather than dropping them.
 */
function threadAnsweredNote(
  task: HubTask,
  item: PanelReviewItem,
  answered: NonNullable<PanelReviewItem['answered']>,
  handlers: DetailHandlers,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'hub-detail-answered';
  const ans = document.createElement('p');
  ans.className = 'hub-detail-answer';
  const label =
    answered.by !== undefined &&
    handlers.selfName !== undefined &&
    answered.by === handlers.selfName
      ? 'you'
      : answered.by;
  ans.append(document.createTextNode(label ? `Answered by ${label}: “` : 'Answered: “'));
  const words = document.createElement('span');
  words.className = 'hub-answer-words';
  words.innerHTML = renderCommentMarkdownInline(answered.text ?? '');
  ans.append(words, document.createTextNode('”'));
  wrap.append(ans);
  // No comment id means the undo route has nothing to name — the record still
  // renders, without a button that could only 400.
  if (!handlers.onUndoThreadAnswer || item.commentId === undefined) return wrap;
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'hub-btn hub-detail-undo-answer';
  undo.textContent = 'Undo';
  undo.title = 'Take this answer back — it reopens the item and keeps a record';
  undo.setAttribute('aria-label', 'Undo this answer and reopen the review item');
  undo.addEventListener('click', () => {
    // Same contract as `answeredNote`'s Undo: disabled for the round trip,
    // re-enabled only on a resolved `false` so a quiet board still offers a
    // retry (the app's `send()` never rejects).
    undo.disabled = true;
    void Promise.resolve(handlers.onUndoThreadAnswer?.(task, item))
      .then((ok) => {
        if (ok === false) undo.disabled = false;
      })
      .catch(() => {
        undo.disabled = false;
      });
  });
  wrap.append(undo);
  return wrap;
}

/** One item's card: the head row and body, then the ways to answer it — or
 *  the answered record, once somebody has. */
function reviewItemCard(
  task: HubTask,
  item: PanelReviewItem,
  handlers: DetailHandlers,
  now: number,
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'hub-decide-card';
  card.dataset.reviewItemId = item.id;
  // Routing data, and the thing the focus-scroll guard below reads to tell
  // whether the thread a deep link named is already hoisted to the top.
  if (item.threadId) card.dataset.reviewThreadId = item.threadId;

  // ONE anatomy (approved design, review-flow-mock-v1): a head row — kind
  // badge, the headline, the asked-by meta top-right — then one markdown
  // body. The separate why/detail/lookFor paragraphs and the trailing meta
  // line this replaces were four blocks saying what the mock says in two.
  const head = document.createElement('div');
  head.className = 'hub-decide-card-head';
  const badge = document.createElement('span');
  // New UI text says Question; the class token stays `review` (stored
  // vocabulary and tone classes are unchanged by the rename in flight).
  badge.className = `hub-decide-k hub-decide-k-${item.shape === 'decision' ? 'decision' : 'review'}`;
  badge.textContent = item.shape === 'decision' ? 'Decision' : 'Question';
  head.append(badge);
  // The one body, markdown-rendered — the links to the thing under review are
  // the whole reason a declaration carries a detail, and appended as text
  // they rendered as bracket soup (reported with a screenshot 2026-08-19).
  // `renderCommentMarkdown` escapes first and only re-adds known-safe tags.
  const bodyMarkdown = reviewItemBodyMarkdown(item);
  // The headline is free-flowing prose rather than a clipped line: a decision
  // blurb *"may run a few lines"*, so nothing here truncates it. Without it
  // the card leans on the ticket title, and "the ticket title is not the
  // decision".
  //
  // Which is why it is DROPPED when it came out as the ticket title anyway:
  // `panelReviewQueue` falls back to `task.title` for a decision whose body
  // yields no blurb, and this card renders directly under the panel's own
  // `.hub-detail-title`, so the reader gets the same words twice in a row.
  // Only when the body below still says something, though — the fallback
  // exists so an unreadable body yields the title rather than a card that
  // says nothing at all, and that remains the better of the two.
  const echoesTitle = item.headline.trim() === task.title.trim();
  if (!(echoesTitle && bodyMarkdown !== '')) {
    const headline = document.createElement('p');
    headline.className = 'hub-decide-headline';
    headline.textContent = item.headline;
    head.append(headline);
  }
  const meta = document.createElement('p');
  meta.className = 'hub-decide-meta';
  meta.textContent = askedMetaLine(item.askedBy, item.asked ?? true, item.since, now);
  head.append(meta);
  card.append(head);
  if (bodyMarkdown !== '') {
    const body = document.createElement('div');
    body.className = 'hub-decide-body';
    body.innerHTML = renderCommentMarkdown(bodyMarkdown);
    card.append(body);
  }

  // A settled item renders the RECORD in place of the ways to answer: the
  // same "Answered by …" + persistent Undo the task's own decision gets, so a
  // typed answer and a tapped option read identically wherever they landed.
  if (item.answered) {
    card.append(threadAnsweredNote(task, item, item.answered, handlers));
    return card;
  }

  // Answering a thread-borne item is a REPLY on its thread, so the agent
  // watching it hears the answer; answering the task's own decision goes
  // through `answer_decision`. Same card, two destinations — which is the
  // whole reason the item carries `threadId`.
  //
  // Every control on the card is disabled for the round trip. Without it the
  // card sat unchanged while the write was in flight — measured 2026-08-18:
  // a free-text answer on a thread item persisted server-side and repainted
  // nothing for 2.5 seconds, so the natural retry posted the answer twice.
  const controls: Array<HTMLButtonElement | HTMLTextAreaElement> = [];
  const busy = (on: boolean): void => {
    card.classList.toggle('is-busy', on);
    for (const c of controls) c.disabled = on;
  };
  const answer = (text: string, optionId?: string, onFail?: () => void): void => {
    busy(true);
    const sent = item.threadId
      ? handlers.onAnswerThread?.(task, item, text, optionId)
      : handlers.onAnswer(task, text, optionId);
    // Only an explicit `false` is a refusal. A handler that returns nothing
    // has said nothing about success, and reading that as failure would put a
    // "your words are still in the box" story over a write that landed.
    void Promise.resolve(sent)
      .then((ok) => {
        if (ok === false) onFail?.();
      })
      .catch(() => onFail?.())
      .finally(() => busy(false));
  };

  if (item.options && item.options.length > 0) {
    const opts = document.createElement('div');
    opts.className = 'hub-decide-options';
    for (const o of item.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hub-decide-option';
      const label = document.createElement('span');
      label.className = 'hub-decide-option-label';
      label.textContent = o.label;
      b.append(label);
      if (o.detail) {
        const detail = document.createElement('span');
        detail.className = 'hub-decide-option-detail';
        detail.textContent = o.detail;
        b.append(detail);
      }
      b.addEventListener('click', () => answer(o.label, o.id));
      controls.push(b);
      opts.append(b);
    }
    card.append(opts);
  }

  const form = document.createElement('form');
  form.className = 'hub-answer-form hub-decide-form';
  const hint = document.createElement('p');
  hint.className = 'hub-decide-form-hint';
  // Says which of the two this box is. With options above it and no line
  // between, the box read as a required second step rather than an alternative.
  hint.textContent =
    item.options && item.options.length > 0
      ? 'Or answer in your own words'
      : 'Answer in your own words';
  const ta = document.createElement('textarea');
  ta.placeholder = 'Record your answer, verbatim…';
  ta.rows = 3;
  // Keyed by ITEM, so walking to the next question and back does not hand the
  // reader the answer they were drafting for a different one.
  ta.dataset.keep = `answer:${task.id}:${item.id}`;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'hub-btn hub-btn-primary';
  submit.textContent = 'Record answer';
  form.append(hint, ta, submit);
  controls.push(ta, submit);
  // Every composer is a markdown editor (design point 4); refresh covers the
  // programmatic clear and restore below, which the editor cannot see.
  const refreshComposer = attachMarkdownComposer(ta);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = ta.value.trim();
    if (!text) {
      // Not a silent no-op. An empty submit used to do literally nothing —
      // enabled button, no message — which reads as a broken control rather
      // than as a refusal.
      requireText(ta, submit, 'Write an answer first');
      return;
    }
    // Cleared BEFORE the round trip, not after it. Answering repaints the
    // panel from inside the await, and `keepFields` snapshots this box on the
    // way through — so a clear that runs after the write lands writes into a
    // detached node while the rebuilt one is refilled with the words that
    // were just sent. Restored verbatim if the write is refused.
    ta.value = '';
    refreshComposer();
    answer(text, undefined, () => {
      ta.value = text;
      refreshComposer();
    });
  });
  card.append(form);
  return card;
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
function requireText(field: HTMLTextAreaElement, near: HTMLElement, message: string): void {
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

/**
 * The head-height observer for each open panel, so a repaint can retire the
 * previous one. A WeakMap rather than a field on the element: the entry goes
 * with the panel when the panel goes, and nothing has to remember to clean up
 * after a close.
 */
const headObservers = new WeakMap<HTMLElement, ResizeObserver>();

/** The two tabs at the bottom of the panel, and which one is showing. */
type DetailTab = 'comments' | 'activity';
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'comments', label: 'Comments' },
  { id: 'activity', label: 'Activity' },
];

export function renderTaskDetail(
  container: HTMLElement,
  task: HubTask | null,
  handlers: DetailHandlers,
  discussion?: TaskDiscussion,
): void {
  // Read what the reader has typed BEFORE the swap throws it away — see
  // `keepFields`. Every repaint of this panel comes through here, which is
  // what makes this the one place the guarantee can live.
  //
  // Two things a repaint must not destroy, and they need opposite mechanisms.
  // A text control can be rebuilt and refilled, because its whole state is a
  // string and a caret offset; an editor cannot, because its state is a
  // ProseMirror view bound to a Yjs room. So drafts are SNAPSHOT and restored,
  // and the description slot is KEPT — see `keptBodySlot`.
  const keptDrafts = keepFields(container);
  // Whether this call OPENS the panel on a task, as opposed to repainting the
  // one already there. Read before the swap, because the swap is what makes
  // the two indistinguishable.
  const prior = container.querySelector<HTMLElement>('.hub-detail-panel');
  const priorTaskId = prior?.dataset.taskId ?? null;
  // Which tab was showing, for the same reason and read the same way: the
  // panel repaints on every board change, and a tab choice that reset on the
  // next peer's comment is a tab nobody can use.
  const priorTab = prior?.dataset.tab === 'activity' ? 'activity' : 'comments';
  // And which review item the walkthrough was on, for the same reason: a
  // position that reset on a peer's comment would walk the reader back to the
  // first question while they were answering the third. The item's ID leads
  // and the index is only its fallback — a queue that gained or lost an item
  // ahead of this one renumbers every position, and restoring the number
  // would swap which question is on screen mid-thought.
  const priorDecide = prior?.querySelector<HTMLElement>('.hub-decide');
  const priorReviewIndex = Number(priorDecide?.dataset.reviewIndex ?? '0');
  const priorReviewItemId = priorDecide?.dataset.reviewItemId || null;
  // …and whether the preserved capture was open. Same reason again: `open` on
  // a `<details>` is DOM-only state, and this panel is rebuilt on every board
  // event, so the words the reader had just unfolded folded away under them.
  const priorQuoteOpen =
    prior?.querySelector<HTMLDetailsElement>('.hub-detail-quote-block')?.open ?? false;
  if (!task) {
    container.replaceChildren();
    container.classList.add('hidden');
    // The board gets its width back. Marked on `<body>` rather than inferred
    // with `:has()` because the board and the panel are siblings under
    // different subtrees, and a class is the thing a test can assert on.
    document.body.classList.remove('hub-detail-open');
    return;
  }
  const freshOpen = priorTaskId !== task.id;
  container.classList.remove('hidden');
  // Wide screens reflow the BOARD out from under the panel instead of letting
  // it run beneath the panel's edge — the review banner and the quick-capture
  // row were both being clipped by it.
  document.body.classList.add('hub-detail-open');
  const keptSlot = keptBodySlot(container, task.id);
  const panel = keptSlot?.parentElement ?? document.createElement('div');
  panel.className = 'hub-detail-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  // Focusable as a container, and declared page-like for the Space hold.
  //
  // Both halves are one fix. A dialog that never takes focus leaves the
  // keyboard behind the thing it opened; and because the board opens this
  // panel from a CLICK on a task row, focus stayed on that row — where a held
  // Space is not "the page", so hold-to-talk was dead for the entire time a
  // task was open (reported as "voice does nothing in the task detail"). The
  // panel is a scroll container with no Space behaviour of its own, so taking
  // the focus is what makes the hold legible again. See `spaceHoldTargetsPage`.
  panel.tabIndex = -1;
  panel.setAttribute(SPACE_HOLD_PAGE_ATTR, 'page');
  panel.dataset.taskId = task.id;
  // Everything the panel shows, split around the description: `before` is
  // patched in above the slot and `after` below it, so the slot itself never
  // leaves the document (see `keptBodySlot`).
  const before: Node[] = [];
  const after: Node[] = [];

  const head = document.createElement('div');
  head.className = 'hub-detail-head';
  const title = document.createElement('h2');
  title.className = 'hub-detail-title';
  title.textContent = task.title;
  // The same affordance the board row's title carries, for the same reason:
  // renaming here was pointer-only, so on a keyboard the panel's title could
  // not be reached at all — and with no tooltip nothing said it was editable
  // to anyone. `wireInPlaceTitle` already answers Enter and F2; what was
  // missing was a way to put the focus on it. Deliberately unconditional,
  // where the board makes it depend on a fine pointer: the panel's title is a
  // full-width target with no competing tap gesture over it.
  title.tabIndex = 0;
  title.title = 'Click or press Enter to rename';
  const titleKeepKey = `title:${task.id}`;
  wireInPlaceTitle(
    title,
    () => task.title,
    (v) => handlers.onTitleCommit(task, v),
    titleKeepKey,
  );
  const actions = document.createElement('div');
  actions.className = 'hub-detail-head-actions';
  // Share first, because it is the one action about the task AS A LINK, and
  // the reader who wants it wants it before they have read anything.
  //
  // Icons rather than words, asked for by name ("icons instead of text
  // buttons, Asana-style"). Each one keeps BOTH an `aria-label` and a `title`:
  // the label is what a screen reader says and the title is what a desktop
  // hover says, and an icon-only control with neither is a control nobody can
  // identify. The glyphs are text characters rather than inline SVG so they
  // inherit the button's colour and the reader's font scaling for free.
  if (handlers.onCopyLink) {
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'hub-btn hub-icon-btn hub-detail-share';
    share.textContent = '🔗';
    share.title = 'Copy a link to this task';
    share.setAttribute('aria-label', 'Copy a link to this task');
    share.addEventListener('click', () => handlers.onCopyLink?.(task));
    actions.append(share);
  }
  // Full screen is a preference of the READER, not of the task, so it lives on
  // the container and survives both a repaint and a move to another task. On a
  // phone the panel is already full-bleed and the toggle would promise a
  // change nothing can make, so it is desktop-only — hidden by the same media
  // query that makes the panel a split pane.
  const full = document.createElement('button');
  full.type = 'button';
  const isFull = container.classList.contains('hub-detail--full');
  full.className = 'hub-btn hub-icon-btn hub-detail-expand';
  const fullState = (on: boolean): void => {
    // At full screen the panel covers the board, so the board must stop
    // reserving room for it — otherwise it is squeezed to nothing behind a
    // panel that is already hiding it, and comes back reflowing.
    document.body.classList.toggle('hub-detail-full', on);
    full.textContent = on ? '⤡' : '⤢';
    const label = on ? 'Exit full screen' : 'Full screen';
    full.title = label;
    full.setAttribute('aria-label', label);
    full.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  fullState(isFull);
  full.addEventListener('click', () => fullState(container.classList.toggle('hub-detail--full')));
  actions.append(full);
  // Archive, between the reader's preference and the way out. Last of the
  // three that DO something to the task, and the only one that changes it —
  // so it sits closest to Close, which is where a secondary action belongs on
  // a head whose left-hand end is the title people came to read. The glyph is
  // the tray every mail client uses; the tooltip says "archive" in words,
  // because a box outline on its own has been read as both "download" and
  // "delete" and this action is neither.
  const archived = isTaskArchived(task);
  if (archived ? handlers.onRestore : handlers.onArchive) {
    const arch = document.createElement('button');
    arch.type = 'button';
    arch.className = 'hub-btn hub-icon-btn hub-detail-archive';
    arch.textContent = archived ? '↩︎' : '🗄';
    const label = archived ? 'Restore this task to the board' : 'Archive this task (e)';
    arch.title = label;
    arch.setAttribute('aria-label', label);
    arch.addEventListener('click', () =>
      archived ? handlers.onRestore?.(task) : handlers.onArchive?.(task),
    );
    actions.append(arch);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'hub-btn hub-icon-btn hub-detail-close';
  close.textContent = '✕';
  close.title = 'Close task detail';
  close.setAttribute('aria-label', 'Close task detail');
  close.addEventListener('click', () => handlers.onClose());
  actions.append(close);
  head.append(title, actions);
  before.push(head);

  // Then the four key fields, then whatever is WAITING on the reader, and only
  // then the description.
  //
  // The requirement is that opening a row from the review queue shows what is
  // wanted without scrolling on a 430px phone, and the old order — statuses,
  // then a nine-row metadata list, then the preserved capture, then finally
  // the description — spent the entire first screen on facts that are
  // identical across every task on the board. None of that is what the reader
  // came to answer.
  before.push(detailFields(task, handlers));

  // The blocked note (design point 5): this task is a person's own open work
  // that other tasks wait on, and this panel is the ONE surface that says so
  // — a blocker is task state, never a review item, so it appears in no
  // queue, no walkthrough, and no row badge. The chip keeps the card-head
  // pill shape (`.hub-decide-k`) so "what kind of thing is this" reads in one
  // vocabulary across the panel.
  if (handlers.blocked) {
    const note = document.createElement('div');
    note.className = 'hub-blocked-note';
    const k = document.createElement('span');
    k.className = 'hub-decide-k hub-blocked-k';
    // "Blocking", because this task IS the blocker: `handlers.blocked` is a
    // humanBlockerRow — the reader's own open task other work waits on — and
    // the line beside the chip says so ("Blocking 2 tasks: …"). "Blocked"
    // here asserted the opposite dependency direction, on the same card.
    k.textContent = 'Blocking';
    const line = document.createElement('p');
    line.textContent = blockedNoteLine(handlers.blocked);
    note.append(k, line);
    before.push(note);
  }

  // Deferred on purpose, in the same shape as the blocking note above — and
  // in a block of its OWN rather than as a fifth cell in the fields row.
  // That row is a pinned four: *"the four facts a reader checks before doing
  // anything else"*, on a panel whose scarcest axis is height. A park is also
  // true of almost no rows, so a permanent fifth control would cost every
  // task a cell to say nothing.
  //
  // It carries a control anyway, because a field an agent writes and a person
  // cannot correct reads as broken (Bryan, 2026-08-18: *"All fields must be
  // human editable"*) — and this one more than most, since deferring somebody
  // else's work is exactly the call a reader wants to overturn in one tap.
  // The REASON is read-only here: it is prose that belongs with the
  // discussion, and clearing the date clears it server-side anyway.
  if (isTaskParked(task, handlers.now ?? Date.now())) {
    const note = document.createElement('div');
    note.className = 'hub-parked-note';
    const k = document.createElement('span');
    k.className = 'hub-decide-k hub-parked-k';
    k.textContent = 'Parked';
    const line = document.createElement('p');
    line.textContent = task.parkedReason
      ? `until ${new Date(task.parkedUntil as number).toLocaleDateString()} — ${task.parkedReason}`
      : `until ${new Date(task.parkedUntil as number).toLocaleDateString()}`;
    // Local noon both ways, exactly as the Due control does it: `toISOString`
    // shows yesterday to anyone west of UTC, and `new Date('2026-09-02')`
    // parses back as UTC midnight, which is the previous day in the same
    // places. An emptied input is an explicit un-park, not a bad value.
    const until = document.createElement('input');
    until.type = 'date';
    until.className = 'hub-detail-input hub-parked-until';
    until.value = localDateInputValue(task.parkedUntil as number);
    until.setAttribute('aria-label', 'Parked until — clear the date to un-park');
    until.addEventListener('change', () => {
      const v = until.value;
      if (!v) {
        handlers.onParkSet?.(task, null);
        return;
      }
      const [y, m, d] = v.split('-').map(Number);
      if (!y || !m || !d) return;
      handlers.onParkSet?.(task, new Date(y, m - 1, d, 12, 0, 0, 0).getTime());
    });
    note.append(k, line, until);
    before.push(note);
  }

  // Archived, and the panel has to SAY so. A deep link, a search result or a
  // restore list can all open a task that is no longer on any board, and
  // without this the panel would look exactly like any other task's — a row
  // whose absence from the lanes reads as a rendering bug rather than as
  // something somebody decided. Same shape as the parked note above, and it
  // is a note rather than a fields cell for the same reason: it is true of
  // almost no rows, so a permanent cell would cost every task height to say
  // nothing.
  if (isTaskArchived(task)) {
    const note = document.createElement('div');
    note.className = 'hub-archived-note';
    const k = document.createElement('span');
    k.className = 'hub-decide-k hub-parked-k';
    k.textContent = 'Archived';
    const who = task.archivedBy ? ` by ${task.archivedBy}` : '';
    const when = task.archivedAt ? new Date(task.archivedAt).toLocaleDateString() : '';
    const line = document.createElement('p');
    line.textContent = task.archiveReason
      ? `${when}${who} — ${task.archiveReason}`
      : `${when}${who}`;
    note.append(k, line);
    if (handlers.onRestore) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'hub-btn hub-archived-restore';
      back.textContent = 'Restore to the board';
      back.addEventListener('click', () => handlers.onRestore?.(task));
      note.append(back);
    }
    before.push(note);
  }

  // Everything waiting on the reader, as ONE queue — the task's own decision
  // and every declared or unanswered item on its threads, ranked together.
  // There used to be two regions here, a decision card and an "ask" panel,
  // each rendering one item and each blind to the other; a task with both
  // showed two competing headers, and a task with three thread items showed
  // one and silently dropped the rest.
  const decide = reviewQueueRegion(
    task,
    handlers,
    handlers.now ?? Date.now(),
    freshOpen
      ? { index: -1, itemId: null }
      : { index: priorReviewIndex, itemId: priorReviewItemId },
    // The discussion rides along so ANSWERED declared items keep their card —
    // the in-place record — after the review-items route stops shipping them.
    discussion,
  );
  if (decide) before.push(decide);

  // What is left of the old definition list: reference material, and it moves
  // to the Activity tab with the rest of it. `Goal` and `Due` are not repeated
  // here — they are in the fields row above, where a reader looks for them.
  const meta = document.createElement('dl');
  meta.className = 'hub-detail-meta';
  const addMeta = (k: string, v: string) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    meta.append(dt, dd);
  };
  /* `addMeta('Risk', task.riskTier)` was here. It existed to explain the
     transition gate when it fired; the gate was removed 2026-08-18 and the
     field with it, so a tier in the panel would describe machinery that no
     longer exists. */
  if (task.after.length > 0) addMeta('After', task.after.join(', '));

  const linkChips = renderTaskLinks(task);

  /**
   * The words the task came from, kept verbatim — moved out of the top of the
   * panel and collapsed.
   *
   * The in-place argument for the LABEL still holds and is kept: an unlabelled
   * blockquote invites two readings ("here is what you said, check I
   * understood it" versus "here is a source somebody chose to quote") that
   * want opposite reactions from the reader, so the caption settles it. That
   * argument was always about the label, never about the POSITION — and the
   * position is what was wrong. This block rendered above the description, so
   * a reader maintaining a task saw their own superseded words before the
   * content they maintain, every single time.
   *
   * `<details>` rather than a comment row: the preservation guarantee lives at
   * the storage choke point (`updateBodySnapshot`) and turning it into a real
   * stored comment would mean a write path and a migration for what is a
   * placement complaint. Reachable, labelled, closed by default — which is
   * what was asked for. The guarantee itself is untouched; nothing here
   * decides whether a quote is kept, only where it renders.
   *
   * ONE label serves every quote, because `quote` has exactly one meaning.
   * All four writers fill it with the words the task came from, verbatim: a
   * dictated capture transcript (`quoteForCapture`), the human's words on a
   * chat-born `create_tasks` row, the latest HUMAN comment on a
   * `promote_to_task` (agent replies are excluded there by design), and the
   * row's own pre-rewrite title-and-body preserved by `updateBodySnapshot`.
   * None of them is an author-chosen quotation, so the field needs no way to
   * say which kind it is and the label cannot lie on a kind it doesn't cover.
   *
   * "Original words" rather than anything that names a person: the preserved
   * pre-rewrite body of an agent-created row is not something a human said, so
   * "in their words" / "what Bryan said" would be false on that case — and a
   * label that lies is worse than no label.
   */
  const quoteBlock = (): HTMLElement | null => {
    if (!task.quote) return null;
    const det = document.createElement('details');
    det.className = 'hub-detail-quote-block';
    // Closed by default, and closed again when the panel opens on a DIFFERENT
    // task: the reader chose to read this one's capture, not every task's.
    det.open = !freshOpen && priorQuoteOpen;
    const sum = document.createElement('summary');
    sum.className = 'hub-detail-quote-label';
    sum.textContent = 'Original words';
    sum.title = 'The words this task came from, kept verbatim.';
    const q = document.createElement('blockquote');
    q.className = 'hub-detail-quote';
    q.textContent = task.quote;
    det.append(sum, q);
    return det;
  };

  // The description reads — and is written — HERE. It used to be a link and
  // nothing else, so "what is this task for" cost a navigation and the board
  // read as a list of bare titles; then it was read-only text plus a link to a
  // separate doc for editing, which put the description and the place to
  // change it on two different pages. The slot below is where hub-app.ts
  // mounts the live editor over the task's body room; see `bodySlot` for what
  // it holds until then.
  const slot = keptSlot ?? bodySlot(task);
  // A heading above it, because the description is a SECTION and everything
  // around it now announces itself — the fields row, the review card, the
  // tabs. Without one the body ran straight on from whatever was above it,
  // and on a decision task that meant prose appearing directly under the
  // answer buttons with nothing saying it had changed subject.
  const bodyHead = document.createElement('h3');
  bodyHead.className = 'hub-detail-subhead hub-detail-body-head';
  bodyHead.textContent = 'Description';
  before.push(bodyHead);

  // Everything below the description is one of two things, and they get one
  // tab each: the CONVERSATION, which is what a reviewer came for, and the
  // RECORD — the audit trail, the words the task came from, the leftover
  // fields, the link chips. Asked for by name ("Activity hidden behind a
  // second tab beside Comments"), and the reason is that the record used to
  // sit inline underneath the discussion, so scrolling to the bottom of a
  // conversation meant scrolling through a transition list first.
  const tabs = document.createElement('div');
  tabs.className = 'hub-detail-tabs';
  tabs.setAttribute('role', 'tablist');
  const tab = freshOpen ? 'comments' : priorTab;
  panel.dataset.tab = tab;

  const comments = document.createElement('div');
  comments.className = 'hub-detail-tabpanel hub-detail-tabpanel-comments';
  comments.setAttribute('role', 'tabpanel');
  if (discussion && handlers.onComment) {
    const onComment = handlers.onComment;
    comments.append(
      renderDiscussion(
        task.id,
        discussion,
        (text, threadId) => onComment(task, text, threadId),
        handlers.focusThreadId,
        handlers.now ?? Date.now(),
      ),
    );
  }

  const activity = document.createElement('div');
  activity.className = 'hub-detail-tabpanel hub-detail-tabpanel-activity';
  activity.setAttribute('role', 'tabpanel');
  // ONE history, newest first: the stored transitions merged with the task's
  // own rows from the workspace audit log. The tab used to render transitions and nothing else, so a
  // rename, a description rewrite, a reassignment and a due-date change all
  // left no trace on the ticket they changed — every one of them was in the
  // log the whole time, on a surface nobody opens a ticket to read.
  const history: Array<{ ts: number; node: HTMLLIElement }> = [
    ...task.transitions.map((t) => ({ ts: t.ts, node: renderTransitionRow(t) })),
    ...taskActivity(handlers.activity, task.id).map((e) => ({
      ts: e.ts,
      node: activityRow(e, task.title),
    })),
  ].sort((a, b) => b.ts - a.ts);
  if (history.length > 0) {
    const h = document.createElement('h3');
    h.className = 'hub-detail-subhead';
    h.textContent = 'History';
    activity.append(h);
    const list = document.createElement('ul');
    list.className = 'hub-detail-transitions';
    for (const row of history) list.append(row.node);
    activity.append(list);
  }
  const quote = quoteBlock();
  if (quote) activity.append(quote);
  if (meta.childElementCount > 0) activity.append(meta);
  if (linkChips) activity.append(linkChips);

  const body = document.createElement('p');
  body.className = 'hub-detail-body-link';
  const bodyLink = document.createElement('a');
  bodyLink.href = `/review/${encodeURIComponent(task.bodyDocId)}`;
  // A secondary way in, not the way to edit: the same room in the full review
  // surface, for anchored comments and the wider page.
  bodyLink.textContent = 'Open in the full editor';
  body.append(bodyLink);
  activity.append(body);

  const panels: Record<DetailTab, HTMLElement> = { comments, activity };
  const buttons: Partial<Record<DetailTab, HTMLButtonElement>> = {};
  const show = (want: DetailTab): void => {
    panel.dataset.tab = want;
    for (const t of DETAIL_TABS) {
      panels[t.id].classList.toggle('hidden', t.id !== want);
      buttons[t.id]?.setAttribute('aria-selected', t.id === want ? 'true' : 'false');
    }
  };
  /**
   * Where the reader lands after switching, and it is not "wherever the
   * scrollbar ends up".
   *
   * Hiding the taller panel shortens the content under the scroll position, so
   * the browser clamps it — measured going straight to 0 on a switch to
   * Activity. That drops the reader at the top of the ticket with the tab row
   * a screenful below and the panel they just chose off the bottom of the
   * screen: the click reads as having done nothing at all, which is exactly
   * how it was reported. Parking the tab row under the sticky head instead
   * puts the switch where it happened — the row that changed stays put, and
   * the new panel starts immediately under it.
   *
   * `scroll-margin-top` on the row (styles.css) is what keeps it clear of the
   * head; without it `block: 'start'` aligns to the scrollport's own top,
   * which is the position the head is painted over.
   */
  const land = (): void => {
    if (typeof tabs.scrollIntoView === 'function') tabs.scrollIntoView({ block: 'start' });
  };
  for (const t of DETAIL_TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `hub-detail-tab hub-detail-tab-${t.id}`;
    b.textContent = t.label;
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      show(t.id);
      land();
    });
    buttons[t.id] = b;
    tabs.append(b);
  }
  // Switching a tab does not repaint the panel, so this is the only place the
  // two states are set — including the initial one.
  show(tab);
  after.push(tabs, comments, activity);

  if (keptSlot) {
    // Repaint around the slot, never through it — see `keptBodySlot`.
    for (const child of [...panel.childNodes]) if (child !== keptSlot) child.remove();
    for (const n of before) panel.insertBefore(n, keptSlot);
    panel.append(...after);
  } else {
    panel.append(...before, slot, ...after);
    container.addEventListener('click', (ev) => {
      if (ev.target === container) handlers.onClose();
    });
    container.replaceChildren(panel);
  }
  // How tall the sticky head actually is, published to the stylesheet.
  //
  // The tab row docks under the head rather than sliding beneath it, and the
  // head's height is not a constant a stylesheet can know: it grows by a line
  // whenever the title wraps, which depends on the title and on the panel's
  // width. A hard-coded offset is therefore wrong on exactly the tickets with
  // the longest names. The CSS carries a fallback for the first paint and for
  // environments with no layout at all (happy-dom measures everything as 0,
  // which is why a zero is discarded rather than published).
  const syncHeadHeight = (): void => {
    const h = head.getBoundingClientRect?.().height ?? 0;
    if (h > 0) panel.style.setProperty('--hub-detail-head-h', `${Math.round(h)}px`);
  };
  syncHeadHeight();
  // A window resize re-wraps the title without repainting the panel, so a
  // measurement taken only at render goes stale in the one case that moves it.
  // Keyed by panel and disconnected first: this function runs on every repaint
  // and each one builds a new head, so an observer per render would accumulate
  // one live observer per board event for as long as the ticket is open.
  headObservers.get(panel)?.disconnect();
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(syncHeadHeight);
    ro.observe(head);
    headObservers.set(panel, ro);
  }

  // After it is in the document — scrollIntoView on a detached node does
  // nothing, silently. Guarded because happy-dom has no implementation.
  //
  // NOT when the review queue is already carrying that same thread's item.
  // Measured in a real browser at 430px before this guard existed: opening a
  // review item left the panel at scrollTop 112, with the queue's heading cut
  // off above the fold — the deep-link centred the thread the panel had just
  // hoisted to the top, so the reader landed mid-page on a second copy of what
  // they came for. Centring is still right when the focused thread is NOT in
  // the queue, which is why this is a condition and not a deletion.
  const focusInQueue =
    handlers.focusThreadId !== undefined &&
    panel.querySelector(
      `.hub-decide-card[data-review-thread-id="${CSS.escape(handlers.focusThreadId)}"]`,
    ) !== null;
  const focus =
    handlers.focusThreadId && !focusInQueue
      ? panel.querySelector<HTMLElement>(
          `.hub-comment[data-thread-id="${CSS.escape(handlers.focusThreadId)}"]`,
        )
      : null;
  if (focus && typeof focus.scrollIntoView === 'function') {
    focus.scrollIntoView({ block: 'center' });
  }

  // Take the focus on OPEN only. A repaint that focused the panel would pull
  // the caret out of the composer every time a peer's comment landed, which is
  // the same class of bug `keptBodySlot` exists to prevent one element over.
  if (freshOpen && typeof panel.focus === 'function') panel.focus({ preventScroll: true });

  // Last, after the thread-centring above: restoring focus scrolls the field
  // back into view, so the composer someone is typing in wins over a centred
  // thread rather than losing to it. The title editor is a control that only
  // exists mid-edit, so a repaint does not merely empty it — it closes it;
  // reopen it first so there is a field for the restore to find.
  if (keptDrafts.has(titleKeepKey)) title.click();
  restoreFields(container, keptDrafts);
}
