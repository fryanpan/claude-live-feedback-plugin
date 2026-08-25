/**
 * DOM renderers for the workspace hub (plan §3.9). Each function re-renders
 * one region into its container from the view model — no fetches, no Yjs —
 * so the interaction contracts (the status dropdown, in-place title edits,
 * the two-filter activity view) are testable under happy-dom.
 */
import {
  REVIEW_LIMITS,
  type ReviewPayload,
  escapeHtml,
  evidenceSuperseded,
  reviewAnswered,
  reviewItemBodyMarkdown,
  transitionUnproven,
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
  type DriftNotice,
  GOAL_STATUS_ORDER,
  type HomePayload,
  type HubDecisionOption,
  type HubEvidence,
  type HubGoal,
  type HubPane,
  type HubTask,
  type HubTransition,
  type PresenceChip,
  type ReorderTarget,
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
  dropIndexFor,
  dropTarget,
  homeSinceLabel,
  initialsOf,
  isTaskArchived,
  isTaskParked,
  ownerKind,
  presenceHue,
  quoteAfterCapture,
  quoteAfterEdit,
  quoteForCapture,
  reviewBannerText,
  reviewCardHeadline,
  reviewHeadline,
  reviewItemBadge,
  reviewRowTitle,
  shortCommit,
  stepTarget,
  taskActivity,
  timeAgo,
  uptimeSummary,
} from './hub-model.ts';

const STATUS_LABEL: Record<TaskStatus, string> = {
  triage: 'Triage',
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done',
};

/**
 * A status's label, falling back to the raw string.
 *
 * The board and the server are two artifacts that ship separately: a browser
 * tab open across a deploy is running a bundle whose status enum predates the
 * one the server is now sending. Indexing the record directly returned
 * `undefined` for such a value, which reached the reader as the words
 * "Status: undefined" and left the picker showing a blank option. The raw
 * string is not a nice label, but it is TRUE, and it is what tells whoever
 * reports it what their tab is actually holding.
 */
function statusLabel(status: TaskStatus): string {
  return STATUS_LABEL[status] ?? String(status);
}

/**
 * The options a status picker offers: the known list, plus the row's CURRENT
 * status when that is not in it.
 *
 * Without the second half a `<select>` handed an unknown value silently
 * resolves to `''` — so the control shows blank, and the first interaction
 * with it writes some other status the reader never chose. Appending the
 * value keeps the picker honest about what the row holds, and keeps every
 * other option one tap away, which is the whole point of the control.
 */
function statusOptions(current: TaskStatus, known: readonly TaskStatus[]): TaskStatus[] {
  return known.includes(current) ? [...known] : [...known, current];
}

/**
 * Which character of `el`'s text the pointer landed on, or `undefined` when
 * the engine will not say. Asana's rule, and Bryan's: clicking a task's name
 * puts the caret where the click was — not at the end, not over a select-all
 * — so the gesture that starts a rename has to carry a position with it.
 *
 * Two spellings of the same question. `caretPositionFromPoint` is the
 * standard; `caretRangeFromPoint` is WebKit's older one and for years the
 * only one Safari had — and Safari is what an iPad reviews on, so the
 * fallback is load-bearing rather than decoration. A DOM with no layout
 * engine (happy-dom, where the unit suite runs) has neither and returns
 * `undefined`, which every caller reads as "put it at the end".
 */
function caretOffsetIn(el: HTMLElement, x: number, y: number): number | undefined {
  // Both are declared as required members of `Document`, and neither is
  // present everywhere it is declared — Safari shipped only the second for
  // years, and happy-dom has neither. So the guard is a runtime one.
  const doc = el.ownerDocument;
  let node: Node | null = null;
  let offset = 0;
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return undefined;
    node = pos.offsetNode;
    offset = pos.offset;
  } else if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (!range) return undefined;
    node = range.startContainer;
    offset = range.startOffset;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return undefined;
  // The offset a text node reports is its OWN, and the input holds the whole
  // title — so count the text that comes before the node the hit landed in.
  // One text node is the common case here; the walk is what keeps it honest
  // for a title that ever renders as more than one.
  let before = 0;
  const stack: Node[] = [el];
  const seen: Node[] = [];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    const kids = Array.from(n.childNodes);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    if (n !== el && n.nodeType === Node.TEXT_NODE) seen.push(n);
  }
  for (const t of seen) {
    if (t === node) return before + offset;
    before += t.textContent?.length ?? 0;
  }
  return undefined;
}

/**
 * Put a collapsed caret at `offset` inside `el`'s text, or at the end when no
 * offset is given. The editing counterpart of `caretOffsetIn`.
 *
 * Reads the selection off the WINDOW rather than the document, deliberately:
 * several tests stub `document.getSelection` with a bare object to drive the
 * drag-select guard, and a stub that cannot hold a range must not take the
 * caret with it. Every capability is checked before it is used, so a DOM that
 * has no real selection simply leaves the caret wherever focus put it.
 */
function placeCaretIn(el: HTMLElement, offset?: number): void {
  const doc = el.ownerDocument;
  const sel = doc.defaultView?.getSelection?.();
  if (!sel || typeof sel.removeAllRanges !== 'function' || typeof sel.addRange !== 'function') {
    return;
  }
  if (typeof doc.createRange !== 'function') return;
  const node = el.firstChild;
  const range = doc.createRange();
  if (node && node.nodeType === Node.TEXT_NODE) {
    const len = node.textContent?.length ?? 0;
    range.setStart(node, typeof offset === 'number' ? Math.max(0, Math.min(len, offset)) : len);
    range.collapse(true);
  } else {
    // No text node to aim at — an empty title. Put the caret inside the
    // element so the first keystroke lands there rather than nowhere.
    range.selectNodeContents(el);
    range.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Whether this engine understands `contenteditable="plaintext-only"`. */
let plaintextOnly: boolean | undefined;
function editableMode(): 'plaintext-only' | 'true' {
  if (plaintextOnly === undefined) {
    plaintextOnly = false;
    try {
      const probe = document.createElement('div');
      probe.contentEditable = 'plaintext-only';
      plaintextOnly = probe.contentEditable === 'plaintext-only';
    } catch {
      // Firefox before 136 THROWS on the unsupported value rather than
      // ignoring it — and the attribute form is worse there than the throw,
      // because an unrecognised keyword makes the element inherit instead of
      // becoming editable at all. So the probe decides, once.
      plaintextOnly = false;
    }
  }
  return plaintextOnly ? 'plaintext-only' : 'true';
}

/**
 * Rename the words WHERE THEY ARE, by making the element that already holds
 * them editable. Enter commits, Escape or blur cancels.
 *
 * This exists rather than reusing `wireInPlaceTitle` because of one
 * requirement that an `<input>` cannot satisfy structurally (Bryan,
 * 2026-08-21): *"Entering edit mode must NOT shift the text — zero layout
 * jump."* Swapping a span for an input means matching font, weight,
 * line-height, padding, border and baseline between two different box types,
 * and getting it right today says nothing about the next font change —
 * `.hub-title-input` currently adds 4px of padding and a 1px border, which is
 * exactly the 5px sideways jump this replaces. Here the element, its text node
 * and its box are never replaced at all: one attribute changes. Zero shift is
 * then a property of the DOM rather than a number two rules have to agree on.
 *
 * The second thing it buys is Asana's transition — the hover rectangle is on
 * this same element, so it can simply turn off while editing and leave the
 * reader with nothing but a caret in the text they clicked.
 */
function wireWordsInPlace(
  el: HTMLElement,
  current: () => string,
  commit: (v: string) => void,
  onEdit?: (editing: boolean) => void,
): (caret?: number) => void {
  let original = '';
  let editing = false;

  // Listeners are attached ONCE and gated on `editing`, rather than added per
  // edit and removed on exit: a rename that ends by committing also ends by
  // blurring, and handlers registered per-edit accumulate a set at a time.
  const end = (text: string, save: boolean): void => {
    if (!editing) return;
    editing = false;
    el.removeAttribute('contenteditable');
    el.textContent = text;
    onEdit?.(false);
    if (save) commit(text);
  };

  el.addEventListener('keydown', (ev) => {
    if (!editing) return;
    if (ev.key !== 'Enter' && ev.key !== 'Escape') {
      // Every other key belongs to the edit. The row above listens for `r`
      // and F2, and this element is a SPAN — the "am I inside a text field"
      // guards that watch for input/textarea do not cover it.
      ev.stopPropagation();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      end(original, false);
      return;
    }
    const v = (el.textContent ?? '').trim();
    if (v && v !== original) end(v, true);
    else end(original, false);
  });

  // Blur cancels: an accidental click away must never rewrite a title.
  el.addEventListener('blur', () => end(original, false));

  // There is deliberately no paste handler. `plaintext-only` flattens the
  // clipboard where it applies, and where it does not, both endings read
  // `el.textContent` — so pasted markup can look wrong for the length of the
  // edit but can never reach the task. A handler would buy the cosmetic half
  // at the cost of the native undo stack.
  return (caret?: number): void => {
    if (editing) return;
    original = current();
    editing = true;
    el.setAttribute('contenteditable', editableMode());
    onEdit?.(true);
    el.focus();
    placeCaretIn(el, caret);
  };
}

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

// ── Board ──────────────────────────────────────────────────────────────────

export interface BoardHandlers {
  /** The row's status dropdown picked `to` — an arbitrary status, not a step
   *  along a cycle. Same shape as the detail panel's, deliberately. */
  onStatusSet: (task: HubTask, to: TaskStatus) => void;
  onGoalTitleCommit: (sectionId: string, title: string) => void;
  /** A new band, typed into the row at the foot of the list. `after` is the
   *  band it should follow, omitted to append. Absent → no add affordance,
   *  which is what every existing caller (and every test) gets. */
  onGoalAdd?: (title: string, after?: string) => void;
  /** The goal row was opened: the only gesture the row has on a coarse
   *  pointer, and the desktop click anywhere off the title's words — the same
   *  interaction model as a task row (Bryan's mockup review, 2026-08-23).
   *  Absent → the tap does nothing yet; the goal detail panel it should open
   *  is the caller's surface, not this renderer's. */
  onOpenGoal?: (section: BoardSection) => void;
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
  /**
   * How many rows this board has archived, and the way to go look at them.
   *
   * A single line above the first goal, and deliberately NOT a fifth nav
   * item: the phone rail has exactly four seats, and "what did I put down"
   * is not a place people go, it is a thing they check after archiving the
   * wrong row. Absent, or a zero, draws nothing at all — a board that has
   * never archived anything should not carry a control saying so.
   */
  archivedCount?: number;
  onShowArchived?: () => void;
}

/** The restore list's own handlers — one verb, and the way back to the board. */
export interface ArchivedViewHandlers {
  onRestore: (task: HubTask) => void;
  onOpenTask: (task: HubTask) => void;
  onBack: () => void;
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
 * it implies a visible hover state (so the drag handle and the open caret are
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
  // REMOVED 2026-08-18, same request and same reasoning as the comment count
  // below ("not useful and a waste of space"). `decision` / `action` badges
  // used to sit here, one per row, on a list whose job is to answer what to
  // work on next — and `needs` is a classification of the WHOLE board's
  // shape, so on a well-triaged board it is nearly constant and says nothing
  // about any particular row.
  //
  // The field is not gone and neither is the surface that uses it: `needs`
  // still drives the review queue on Home and the review strip's ranking,
  // which is where "this one wants a decision from you" belongs — a place
  // that lists only the rows it applies to, instead of labelling all of them.
  // If the board ever needs to distinguish a decision row again, that is a
  // filter or an ordering, not a badge on every line.

  // The assignee is its own cell at the end of the row now (§ row anatomy).
  // As a badge it appeared only when it wasn't the default 'agent', so most
  // rows showed no owner at all.

  // REMOVED 2026-08-18, at Bryan's explicit request ("comment counts on the
  // top level task list — taking up space for no reason"). A `💬 N` badge used
  // to sit here. Recorded rather than deleted silently, because the comment it
  // replaces argued the badge was load-bearing and it was citing a real
  // incident: see "The store has it is not the surface can show it" in
  // docs/process/learnings.md, where a reviewer's reply to a resolved thread
  // was invisible on the board and got reported as "comments seem to be going
  // missing".
  //
  // So state the cost plainly rather than let it be rediscovered: **the board
  // no longer signals that a discussion exists on a row.** Finding one means
  // opening the task, where the detail panel still lists every comment.
  // Deliberately NOT replaced with a quieter affordance (a dot, a hover, a
  // smaller glyph) — a substitute is the over-engineering being objected to.
  // If "comments are going missing" is reported again, this is the trade that
  // produced it, and a row-level tell is the fix.
  // REMOVED 2026-08-19, at Bryan's request on seeing it: *"That's not helpful.
  // Just don't show it any more. We can figure out how or if this data is
  // useful or not as we go along."* An `after N` badge sat here, counting the
  // task's dependencies.
  //
  // Recorded rather than deleted silently, and the specific reason it was not
  // helpful is worth keeping: the number counted ALL of `after`, while only
  // the `afterEnforce` subset actually hard-blocks a transition. So `after 2`
  // could mean two hard blocks, two soft ones, or a mix, and the row could not
  // say which — it read as "blocked" on rows that were not. What it was
  // blocked ON lived only in the hover title, which a touch screen cannot
  // reach at all.
  //
  // The dependencies themselves are untouched: `after` / `afterEnforce` still
  // gate transitions, still drive the detail panel's blocked note, and still
  // show in the panel. This removes a row-level TELL, not a feature. If the
  // board needs one again, it should distinguish enforced from soft and name
  // what is blocking without a hover.
  if (task.dueAt !== undefined) {
    const due = new Date(task.dueAt);
    const overdue = task.dueAt < Date.now() && task.status !== 'done';
    add(
      overdue ? 'hub-badge-due hub-badge-overdue' : 'hub-badge-due',
      `due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
    );
  }
  // Deferred to a date. This one earns its place on the row where `needs` and
  // the dependency count did not, and the difference is that it is TRUE OF
  // ALMOST NO ROWS: it marks the handful somebody deliberately put off, on a
  // list whose job is to answer what to work on next. Without it a parked row
  // is indistinguishable from work nobody has gotten to — which is precisely
  // the confusion the field was added to end, so a park the board did not
  // draw would be the store-has-it/surface-can't-show-it failure again.
  //
  // The reason rides `title` rather than the chip text. It is free prose of
  // any length and the row is one line; the panel below shows it in full.
  if (isTaskParked(task)) {
    const until = new Date(task.parkedUntil as number);
    add(
      'hub-badge-parked',
      `parked · ${until.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
      task.parkedReason,
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

/** Where a live, non-empty selection sits inside `el` — or null for none. */
type SelectionMark = {
  anchor: Node | null;
  focus: Node | null;
  anchorOffset: number;
  focusOffset: number;
};

function selectionInside(el: HTMLElement): SelectionMark | null {
  const sel = typeof document.getSelection === 'function' ? document.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode)) return null;
  return {
    anchor: sel.anchorNode,
    focus: sel.focusNode,
    anchorOffset: sel.anchorOffset,
    focusOffset: sel.focusOffset,
  };
}

function sameSelection(a: SelectionMark | null, b: SelectionMark | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.anchor === b.anchor &&
    a.focus === b.focus &&
    a.anchorOffset === b.anchorOffset &&
    a.focusOffset === b.focusOffset
  );
}

export function renderTaskRow(task: HubTask, handlers: BoardHandlers): HTMLElement {
  const row = document.createElement('div');
  row.className = `hub-task-row hub-status-${task.status}${task.status === 'done' ? ' hub-done' : ''}`;
  row.dataset.taskId = task.id;
  row.tabIndex = 0;

  // A click that ends a drag-select fires like any other, and neither of this
  // row's two gestures may act on it: opening the panel would destroy the
  // selection the reader just made to copy a title, and swapping the words for
  // an input would too. But the question is whether THIS gesture made the
  // selection, not whether one exists: a finished selection stands until the
  // next mousedown, so a single read at click time also swallows the click
  // AFTER the drag, and the row reads as dead. Compare the two ends of the
  // gesture instead — changed during it means this click selected something,
  // unchanged means it is somebody else's selection and the row acts.
  let selAtDown = selectionInside(row);
  const selectedByThisClick = (): boolean => {
    const now = selectionInside(row);
    return now !== null && !sameSelection(now, selAtDown);
  };
  row.addEventListener('mousedown', () => {
    selAtDown = selectionInside(row);
  });

  // A dropdown over every status, not a tap-to-cycle mark. The cycle assumed
  // the workflow was linear (todo → in-progress → done → todo), so sending a
  // finished task back to todo cost two transitions and wrote two audit events
  // for a move that happened once. A native <select> also gets the mobile
  // picker and keyboard support for free, which a custom popup would owe.
  const chip = document.createElement('select');
  chip.className = `hub-status-select hub-chip-${task.status}`;
  for (const s of statusOptions(task.status, TASK_STATUS_ORDER)) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = statusLabel(s);
    chip.append(opt);
  }
  // After the options are in the tree, not via `option.selected` before it —
  // a detached option's selected flag doesn't survive being appended.
  chip.value = task.status;
  chip.setAttribute('aria-label', `Status: ${statusLabel(task.status)}`);
  chip.title = `Status: ${statusLabel(task.status)}`;
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

  // ── The open caret. Asana's desktop affordance, asked for by name: a caret
  // that appears on hover and always opens the task. It needs no click handler
  // — the row's own opens, and this click bubbles into it — so it is a
  // <button> for the cursor and the hit area rather than for a behaviour of
  // its own.
  //
  // It sits at the RIGHT end, immediately before the assignee bubble (Bryan,
  // 2026-08-21, twice: not in the gap on the left, and *"right BEFORE the
  // profile bubble"*). It is appended in that position below, so the reading
  // order is title · whitespace · caret · bubble.
  //
  // Deliberately NOT a tab stop: Enter on the focused row already opens the
  // task, so a focusable twin would be a stop that says nothing new. That is
  // the one thing lost with the pencil, which was the keyboard's only path to
  // a rename — `r` (or F2) on the focused row is that path now, below.
  const openCaret = document.createElement('button');
  openCaret.type = 'button';
  openCaret.className = 'hub-task-open';
  openCaret.textContent = '›';
  openCaret.tabIndex = -1;
  openCaret.setAttribute('aria-hidden', 'true');
  openCaret.title = 'Open this task';
  // `tabIndex = -1` keeps it off the tab ring but leaves it CLICK-focusable,
  // and a button that takes focus on click keeps it after the panel it opened
  // is closed — measured at 430px: a blue focus ring standing on an
  // `aria-hidden` glyph, with nothing to do with the row the reader is now on.
  // Cancelling the mousedown default is the standard way to say "clickable,
  // never focusable"; the click still fires and still bubbles to the row.
  openCaret.addEventListener('mousedown', (ev) => ev.preventDefault());

  const title = document.createElement('span');
  title.className = 'hub-task-title';
  // Inline editing stays fine-pointer-only. On a phone the title tap has
  // always meant "open" ("I can't open a task to see what's inside" is the
  // bug that removed tap-to-rename an hour before it first shipped), and
  // renaming lives in the detail panel one tap away, where the title is a
  // full-width target. `finePointer()` is NOT a width breakpoint — see it.
  const editable = (handlers.inlineTitleEdit ?? finePointer)();

  // The words live in an INLINE child rather than loose in the title cell,
  // and that is what makes Bryan's rule expressible: everything on the row
  // except the actual text opens the task, *including the whitespace to the
  // right of the text*. The cell is the grid's `minmax(0, 1fr)` track, so it
  // spans every pixel between the status mark and the badges — on a 1282px
  // row a six-word title leaves most of that cell empty, and a handler on the
  // cell could not tell the empty half from the words. The browser's own
  // hit-testing tells them apart for free: a click on the empty part has the
  // CELL as its target, never reaches this child, and bubbles on to the row's
  // open handler.
  let beginRename: ((caret?: number) => void) | null = null;
  const words = document.createElement('span');
  words.className = 'hub-task-title-text';
  words.textContent = task.title;
  title.append(words);

  if (editable) {
    title.title = 'Click the words to rename · anywhere else opens the task';
    // The words are edited in place — this element becomes editable and is
    // never swapped for an input, which is what makes entering edit mode cost
    // zero layout shift. See `wireWordsInPlace`.
    beginRename = wireWordsInPlace(
      words,
      () => task.title,
      (v) => handlers.onTitleCommit(task, v),
      (on) => title.classList.toggle('hub-title-editing', on),
    );
    words.addEventListener('click', (ev) => {
      // The one click on this row that does not open the task.
      ev.stopPropagation();
      if (selectedByThisClick()) return;
      // Already editing: this click is the reader moving their own caret, and
      // `beginRename` no-ops on it. Stopping the bubble above is the whole job.
      beginRename?.(caretOffsetIn(words, ev.clientX, ev.clientY));
    });
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

  row.append(handle, statusCtl, title, taskBadges(task), openCaret, ownerCtl);

  row.addEventListener('click', () => {
    if (selectedByThisClick()) return;
    handlers.onOpenTask(task);
  });
  if (editable) {
    row.addEventListener('keydown', (ev) => {
      // The pencil was the keyboard's rename and it is gone, so these two
      // spellings are. `r` is the one that matters: it joins the row's
      // existing single-letter set (j/k move, o opens, s status, a assignee)
      // and it is reachable on the Magic Keyboard Bryan reviews from, which
      // has no function row at all. F2 rides along because it is what a file
      // manager and a spreadsheet rename with, and it costs one clause.
      // Enter stays "open", so nothing races for the same press.
      if (ev.key !== 'F2' && ev.key !== 'r') return;
      // A letter key belongs to whatever is being typed into, not to the row
      // it happens to sit inside. `[contenteditable]` is in the list because
      // the title being renamed IS one — an editable span, which none of the
      // usual "is this a text field" selectors match.
      if ((ev.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      ev.preventDefault();
      ev.stopPropagation();
      beginRename?.();
    });
  }
  row.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    // Every control in the row is its own tab stop, and Enter on a focused
    // control fires a keydown that bubbles through here BEFORE the browser
    // synthesizes the control's activation — so a row that takes every Enter
    // beats each of them to it, and their `stopPropagation` on click arrives
    // far too late to matter. Space never showed this: a button activates on
    // keyUP, so the click it dispatches is the whole of the gesture. The row
    // takes Enter only when the focus is on the row itself.
    if ((ev.target as HTMLElement).closest('input, button, select, textarea')) return;
    handlers.onOpenTask(task);
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

/**
 * The board, mounted only on the pane that shows it.
 *
 * Home hides the whole column (`.hub-main--home .hub-board-col { display: none }`)
 * and the render path used to run there regardless, so arriving at Home built
 * a `.hub-task-row` per task — 70 on the real board — with their selects and
 * their drag and keyboard listeners, and collapsed all of it to zero height.
 * The comment on that CSS said the board was being hidden rather than
 * unmounted so it could "keep its realtime projection warm", but the
 * projection is the task map the ydoc feeds; the rows are derived output, and
 * re-entering the board rebuilds them from it in one pass. Nothing was being
 * kept warm that a render does not recreate.
 *
 * Zero-height rows also answer selectors, which makes them worse than waste:
 * anything reading the board by query gets a full row set on a page showing
 * none of it.
 */
export function renderBoardForPane(
  container: HTMLElement,
  pane: HubPane,
  sections: BoardSection[],
  handlers: BoardHandlers,
): void {
  if (pane !== 'board') {
    container.replaceChildren();
    return;
  }
  renderBoard(container, sections, handlers);
}

// ── The goal band: the goal IS a row, and the row carries its tasks ────────

/**
 * Which bands this viewer has folded — localStorage, never the shared ydoc,
 * because a fold is a reading preference: collapsing a band you have finished
 * scanning must not collapse it for everyone else on the board.
 *
 * Guarded reads/writes: private mode throws on both, and a board that cannot
 * remember a fold is still a board (the class toggle keeps working for the
 * life of the render).
 */
const COLLAPSED_BANDS_KEY = 'hub:collapsed-bands';
function collapsedBands(): Record<string, 1> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_BANDS_KEY) ?? '{}');
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, 1>) : {};
  } catch {
    return {};
  }
}
function setBandCollapsed(goalId: string, folded: boolean): void {
  try {
    const map = collapsedBands();
    if (folded) map[goalId] = 1;
    else delete map[goalId];
    localStorage.setItem(COLLAPSED_BANDS_KEY, JSON.stringify(map));
  } catch {
    /* private mode — the fold still applies until the next render */
  }
}

/**
 * One board band: the goal's own ROW on top, its tasks on a rail below it
 * (Bryan's approved mock, 2026-08-23). The row deliberately carries NONE of a
 * task row's working chrome — his review struck, by name: open/doing/done
 * counts, the drag handle, the status circle, decision chips, and any 'legacy
 * band' marker. Reordering, status and counts live in the goal's detail
 * panel. What the row keeps is what identifies the band at a glance: the
 * title, the due date as plain muted text (overdue = red), and the owner
 * avatar in the same column as the task rows' — that alignment is the CSS's
 * half of the contract (see `goal-band-css.test.ts`).
 *
 * Interaction model is the TASK row's, by decision: on a fine pointer the
 * words rename in place (`wireWordsInPlace`, zero layout shift) and anywhere
 * else opens the goal; on a coarse pointer any tap opens and never edits —
 * renaming lives in the detail panel there. The one control a goal row has
 * that a task row does not is the fold, so the twisty is ALWAYS visible: a
 * hover-only affordance is no affordance on the iPad this board is read from.
 *
 * A done band is a muted title, the plain word `done` in the due date's slot,
 * and the attribution riding the row's tooltip. The word is there because the
 * other two are hover-only tells on a touch device — but it stays plain text
 * in an existing slot, since the mock draws no chrome of its own for a done
 * goal and the status select lives in the panel.
 */
function renderGoalBand(section: BoardSection, handlers: BoardHandlers): HTMLElement {
  const folded = collapsedBands()[section.id] === 1;
  const band = document.createElement('div');
  band.className = [
    'hub-band',
    section.isChores ? 'hub-band-reserved' : '',
    section.status === 'done' ? 'hub-band-done' : '',
    folded ? 'is-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const row = document.createElement('div');
  row.className = 'hub-goal-row';

  // The fold. Toggles classes in place rather than re-rendering: the live
  // board repaints often enough on its own, and the persisted map is what a
  // repaint reads.
  const twisty = document.createElement('button');
  twisty.type = 'button';
  twisty.className = 'hub-twisty';
  const glyph = document.createElement('span');
  glyph.textContent = '▾';
  twisty.append(glyph);
  // Everything the twisty says names the gesture the NEXT click will do, so
  // all three live here together. The tooltip used to be set once outside
  // this function and never followed the fold, which left a collapsed band
  // offering to collapse itself while its aria-label said the opposite.
  const sayFold = (isFolded: boolean): void => {
    twisty.setAttribute('aria-expanded', isFolded ? 'false' : 'true');
    twisty.setAttribute('aria-label', `${isFolded ? 'Expand' : 'Collapse'} “${section.title}”`);
    twisty.title = `${isFolded ? 'Expand' : 'Collapse'} this goal — just for you`;
  };
  sayFold(folded);
  twisty.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const now = !band.classList.contains('is-collapsed');
    band.classList.toggle('is-collapsed', now);
    sayFold(now);
    setBandCollapsed(section.id, now);
  });

  // The title cell. Same structural split as the task row: the WORDS live in
  // an inline child, so the browser's own hit-testing separates "rename the
  // words" from "open the goal" — a click on the cell's empty width never
  // reaches the child and bubbles to the row's open handler.
  const title = document.createElement('span');
  title.className = 'hub-goal-title';
  const words = document.createElement('span');
  words.className = 'hub-goal-title-text';
  words.textContent = section.title;
  title.append(words);

  const editable = !section.isChores && (handlers.inlineTitleEdit ?? finePointer)();

  // The drag-select guard, same as the task row's: a click that just made a
  // selection is somebody copying a title, and neither gesture may act on it.
  let selAtDown = selectionInside(row);
  const selectedByThisClick = (): boolean => {
    const now = selectionInside(row);
    return now !== null && !sameSelection(now, selAtDown);
  };
  row.addEventListener('mousedown', () => {
    selAtDown = selectionInside(row);
  });

  let beginRename: ((caret?: number) => void) | null = null;
  if (editable) {
    title.title = 'Click the words to rename · anywhere else opens the goal';
    beginRename = wireWordsInPlace(
      words,
      () => section.title,
      (v) => handlers.onGoalTitleCommit(section.id, v),
      (on) => title.classList.toggle('hub-title-editing', on),
    );
    words.addEventListener('click', (ev) => {
      // The one click on this row that does not open the goal.
      ev.stopPropagation();
      if (selectedByThisClick()) return;
      beginRename?.(caretOffsetIn(words, ev.clientX, ev.clientY));
    });
  } else if (!section.isChores) {
    title.title = 'Tap to open';
  }

  // What sits right of the title, as plain muted text (decision 6 —
  // explicitly not a chip, and no chip may return beside it):
  //
  //   done band → the word `done`. The muted title alone is a difference
  //     nobody can name, and the attribution tooltip that carries the rest
  //     never appears on the iPad this board is read from. It takes the due
  //     date's slot rather than sitting beside it, because a date a finished
  //     goal ran past is noise (and its red is already suppressed).
  //   open band → the due date, red once it is past.
  const meta = document.createElement('span');
  meta.className = 'hub-goal-meta';
  if (!section.isChores && section.status === 'done') {
    const note = document.createElement('span');
    note.className = 'hub-done-note';
    note.textContent = 'done';
    meta.append(note);
  } else if (!section.isChores && section.dueAt !== undefined) {
    const due = document.createElement('span');
    // A done band never reaches here, so being past the date is all overdue
    // can mean by this point.
    due.className = section.dueAt < Date.now() ? 'hub-due hub-due-overdue' : 'hub-due';
    due.textContent = `due ${new Date(section.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    meta.append(due);
  }

  // The open caret — the task row's, one size up the tree. Same contract:
  // no behaviour of its own (the row's click opens, this one bubbles), not a
  // tab stop, never keeps focus from a click.
  const openCaret = document.createElement('button');
  openCaret.type = 'button';
  openCaret.className = 'hub-goal-open';
  openCaret.textContent = '›';
  openCaret.tabIndex = -1;
  openCaret.setAttribute('aria-hidden', 'true');
  openCaret.title = 'Open this goal';
  openCaret.addEventListener('mousedown', (ev) => ev.preventDefault());

  // The owner slot is ALWAYS emitted — it is the grid track that keeps the
  // avatar column aligned with the task rows' (decision 8) — but Backlog gets
  // no avatar in it: a bucket cannot be owned, and drawing a vacancy would
  // invite filling it. A goal without a projected owner IS a vacancy, drawn
  // as one, exactly like an unowned task.
  const ownerCtl = document.createElement('span');
  ownerCtl.className = 'hub-owner-ctl';
  if (!section.isChores) {
    const avatar = document.createElement('span');
    if (section.assignee !== undefined) {
      const kindClass =
        section.ownerKind === 'person'
          ? 'hub-owner-human'
          : section.ownerKind === 'agent'
            ? 'hub-owner-agent'
            : 'hub-owner-unknown';
      avatar.className = `hub-owner-avatar ${kindClass}`;
      avatar.textContent = ownerInitials(section.assignee);
      avatar.title = `Owner: ${assigneeLabel(section.assignee)}`;
    } else {
      avatar.className = 'hub-owner-avatar hub-owner-none';
      avatar.textContent = '—';
      avatar.title = 'Nobody owns this goal yet';
    }
    ownerCtl.append(avatar);
  }

  row.append(twisty, title, meta, openCaret, ownerCtl);

  // Done attribution, where a one-line row can carry it: the tooltip. The
  // band's visible treatment is the muted title class alone — the mock shows
  // no further chrome for a done goal, and none is invented here.
  if (section.status === 'done') {
    const when =
      section.doneAt !== undefined
        ? `, ${new Date(section.doneAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
        : '';
    row.title = section.doneBy ? `Done — declared by ${section.doneBy.name}${when}` : 'Done';
  }

  if (!section.isChores) {
    row.addEventListener('click', () => {
      if (selectedByThisClick()) return;
      handlers.onOpenGoal?.(section);
    });
    // The keyboard's copy of the same two gestures, mirroring the task row:
    // Enter on the focused row opens, `r`/F2 renames where renaming exists.
    row.tabIndex = 0;
    row.addEventListener('keydown', (ev) => {
      if ((ev.target as HTMLElement).closest('input, button, select, textarea, [contenteditable]'))
        return;
      if (ev.key === 'Enter') {
        handlers.onOpenGoal?.(section);
      } else if (editable && (ev.key === 'r' || ev.key === 'F2')) {
        ev.preventDefault();
        ev.stopPropagation();
        beginRename?.();
      }
    });
  }

  band.append(row);

  // The band's tasks, on the rail that says "these belong to the row above".
  // A folded band hides this container in CSS and renders NOTHING in its
  // place — a collapsed band shows nothing extra, by decision.
  const tasksWrap = document.createElement('div');
  tasksWrap.className = 'hub-band-tasks';
  if (section.tasks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hub-section-empty';
    empty.textContent = section.isChores ? 'Nothing in the backlog.' : 'No tasks yet.';
    tasksWrap.append(empty);
  } else {
    for (const task of section.tasks) tasksWrap.append(renderTaskRow(task, handlers));
  }
  band.append(tasksWrap);
  return band;
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
): void {
  // Snapshot any in-flight rename before the repaint destroys the input —
  // the same guarantee the task panel gives, via the same two helpers.
  const kept = keepFields(container);
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

  const panel = document.createElement('div');
  panel.className = 'hub-detail-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  // Focusable as a container, same as the task panel and for the same
  // reasons: the keyboard follows the dialog, and Escape has somewhere to
  // land without a global listener.
  panel.tabIndex = -1;
  panel.dataset.goalId = section.id;
  panel.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') handlers.onClose();
  });

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

  const counts = { triage: 0, todo: 0, 'in-progress': 0, done: 0 } as Record<TaskStatus, number>;
  // `?? 0` because a status this bundle predates is a real key here, and
  // `undefined + 1` would render the band's whole task line as NaN.
  for (const t of section.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  // What is left to do in this band. Triage counts as open — the work exists,
  // it just has not been agreed to yet, and calling it closed is the reading
  // that lets a band look finished while nobody has looked at half of it.
  const open = counts.triage + counts.todo + counts['in-progress'];

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
  cell(
    'Tasks',
    TASK_STATUS_ORDER.map((s) => `${counts[s]} ${statusLabel(s).toLowerCase()}`).join(' · '),
  );

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
  } else if (open > 0) {
    // The advisory from the mock, verbatim in spirit: the server reports open
    // children on a done declaration and never enforces them, so the panel
    // says up front what a declaration would leave open.
    const advisory = document.createElement('p');
    advisory.className = 'hub-goal-advisory';
    advisory.textContent =
      `Marking this goal done leaves ${open} open task${open === 1 ? '' : 's'} in it. ` +
      'A goal is done because you say so — its tasks are reported, never enforced.';
    body.append(advisory);
  }

  panel.append(head, body);
  container.addEventListener('click', (ev) => {
    if (ev.target === container) handlers.onClose();
  });
  container.replaceChildren(panel);
  // A rename in flight when the repaint hit: reopen the editor, then let
  // `restoreFields` put the draft and the caret back — the task panel's own
  // two-step, for the same reason.
  if (kept.has(`goal-title:${section.id}`)) title.click();
  restoreFields(container, kept);
}

/** Goals-as-sections, Backlog last (already ordered by the model); done rows
 *  stay in place, drawn done — finishing a task doesn't move it (§3.9). */
export function renderBoard(
  container: HTMLElement,
  sections: BoardSection[],
  handlers: BoardHandlers,
): void {
  container.replaceChildren();
  // The board's meta line: what is true of the LIST rather than of any row in
  // it. One entry so far, and it earns its line only when there is something
  // to point at — see `archivedCount`.
  if (handlers.onShowArchived && (handlers.archivedCount ?? 0) > 0) {
    const meta = document.createElement('p');
    meta.className = 'hub-board-meta';
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'hub-linklike hub-board-meta-archived';
    const n = handlers.archivedCount ?? 0;
    link.textContent = `${n} archived`;
    link.title = 'Show archived tasks — each one can be restored';
    link.addEventListener('click', () => handlers.onShowArchived?.());
    meta.append(link);
    container.append(meta);
  }
  for (const section of sections) {
    const sec = document.createElement('section');
    // FLAT. `section.depth` is still an honest fact about the goal list —
    // `boardSections`, `goalRank` and `goalLabel` all agree on it, and the
    // stored shape is untouched — but the list renders one level, because a
    // subgoal indented under a parent reads as a smaller thing rather than as
    // work with the same claim on the day. Nothing here destroys nesting: a
    // board that already has subgoals shows them as top-level sections in
    // board order, and the data migration is a separate, deliberate step.
    sec.className = `hub-section${section.isChores ? ' hub-chores' : ''}`;
    sec.dataset.goalId = section.id;
    sec.append(renderGoalBand(section, handlers));
    container.append(sec);
  }
  if (handlers.onGoalAdd) container.append(goalAddRow(sections, handlers.onGoalAdd));
  // After the rows exist: the drag/keyboard wiring needs the whole board (a
  // drop can cross into another goal's section), so it can't live on the row.
  wireBoardReorder(container, sections, handlers);
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

/**
 * "New goal" at the foot of the list — the other half of inline goal editing,
 * beside the tap-to-rename the section titles already have.
 *
 * It appends after the last REAL band rather than at the very end, because
 * Backlog is a fixed catch-all that always renders last: a band added after it
 * would be the only thing below the bucket for work that has no band.
 *
 * Enter files it, Escape abandons it, and blurring an empty box closes it —
 * the same three endings `wireInPlaceTitle` gives a rename, so the two
 * gestures on this list behave the same way.
 */
function goalAddRow(
  sections: BoardSection[],
  onGoalAdd: (title: string, after?: string) => void,
): HTMLElement {
  const last = [...sections].reverse().find((s) => !s.isChores);
  const wrap = document.createElement('div');
  wrap.className = 'hub-goal-add';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hub-goal-add-btn';
  btn.textContent = '+ New goal';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'hub-goal-add-input hidden';
  input.placeholder = 'Goal title';
  input.setAttribute('aria-label', 'New goal title');

  const close = (): void => {
    input.value = '';
    input.classList.add('hidden');
    btn.classList.remove('hidden');
  };
  btn.addEventListener('click', () => {
    btn.classList.add('hidden');
    input.classList.remove('hidden');
    input.focus();
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const title = input.value.trim();
      ev.preventDefault();
      if (title.length === 0) {
        close();
        return;
      }
      onGoalAdd(title, last?.id);
      close();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  });
  // Only an EMPTY box closes on blur. Closing over typed-but-uncommitted text
  // is how a half-written title disappears when a repaint moves focus.
  input.addEventListener('blur', () => {
    if (input.value.trim().length === 0) close();
  });
  wrap.append(btn, input);
  return wrap;
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

// ── Decisions strip ────────────────────────────────────────────────────────

export interface ReviewStripHandlers {
  /** Open this one in the queue itself — the card that carries the ask and the
   *  box to answer it, aimed at this row. What a LIVE row does when tapped.
   *
   *  Tapping used to call `onOpen` and leave Home for the underlying task or
   *  doc, which is the opposite of what the row is for: the reader came to the
   *  queue to work the queue, and every tap ejected them from it. Going to the
   *  resource is still offered — from inside the opened card, as a second,
   *  deliberate tap. */
  onReview: (item: ReviewItem, index: number) => void;
  /** Jump straight to where this one gets answered — the decision's panel,
   *  the task's discussion at that thread, the doc anchored on that comment.
   *  "Exactly the place", not the containing surface.
   *
   *  Now reached from the card's own pointer out, and from a SETTLED row —
   *  which has left the queue, so there is no card left to open it in. */
  onOpen: (item: ReviewItem) => void;
  /** Go through all of them, one at a time. */
  onWalkthrough: () => void;
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What each kind is, for the row's hover title. The card's own badge comes
 *  from `reviewBadge`, which is the mockup's two-tone vocabulary; this is the
 *  longer wording a tooltip can afford. */
const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  decision: 'Decision',
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
 *
 * This now lives on the HOME pane as "For Your Review" (the board keeps only
 * a one-line banner — `renderReviewBanner`). Same queue, same rows, same
 * walkthrough entry; what moved is which page carries it.
 */
export function renderHomeReview(
  container: HTMLElement,
  queue: ReviewQueue,
  handlers: ReviewStripHandlers,
  settled: ReviewItem[] = [],
  now: number = Date.now(),
): void {
  container.replaceChildren();
  container.classList.remove('hidden');
  container.classList.add('hub-home-review-card');

  const titleRow = document.createElement('div');
  titleRow.className = 'hub-home-review-head';
  const heading = document.createElement('h2');
  heading.className = 'hub-home-heading';
  heading.textContent = 'For Your Review';
  titleRow.append(heading);
  // The walkthrough entry: the mockup's dark "Review All", top-right of the
  // section head. Only offered when there is something to walk through.
  if (queue.total > 0) {
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'hub-btn hub-btn-ink hub-review-go';
    go.textContent = 'Review All';
    go.setAttribute('aria-label', 'Go through these one at a time');
    go.addEventListener('click', () => handlers.onWalkthrough());
    titleRow.append(go);
  }
  container.append(titleRow);

  // Settled rows stay in the stack marked done (approved design): an answered
  // item vanishing outright reads as the page losing things. Only rows that
  // have actually LEFT the queue render here — an item still present (a
  // replied thread the next refresh hasn't dropped yet) stays a live row.
  const live = new Set(queue.items.map((i) => i.key));
  const done = settled.filter((s) => !live.has(s.key));

  if (queue.total === 0) {
    const quiet = document.createElement('p');
    quiet.className = 'hub-home-quiet';
    quiet.textContent = 'Nothing is waiting for your review right now.';
    container.append(quiet);
    appendSettledRows(container, done, handlers, now);
    return;
  }

  /**
   * The mockup's row anatomy, exactly: a ranked vertical list, hairlines
   * between rows, the QUESTION as the row title (`reviewRowTitle` — the ask
   * when the item carries one, the subject when the subject is the question),
   * "waiting N days" as the subline, and the top row highlighted because it
   * is the one Review All opens on. The old title-chip strip was the board
   * component moved over, which is what got this page rejected.
   */
  queue.items.forEach((item, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `hub-review-row hub-review-${item.kind}${i === 0 ? ' hub-review-row-current' : ''}`;
    const title = document.createElement('span');
    title.className = 'hub-review-row-title';
    title.textContent = reviewRowTitle(item);
    const sub = document.createElement('span');
    sub.className = 'hub-review-row-sub';
    // The asked-by meta, in the same spelling the card head uses — one clock,
    // one sentence, so the row and the card it opens can never disagree. The
    // declared why moved into the card's one markdown body (approved design);
    // the row is title + meta and nothing else.
    sub.textContent = askedMeta(item, now);
    row.append(title, sub);
    row.title = `${REVIEW_KIND_LABEL[item.kind]}: ${item.title}${item.ask ? ` — ${item.ask}` : ''} · ${item.why}`;
    // Into the queue's own card at this row, not out to the task or the doc.
    // The index rides along so the card opens where the reader was pointing;
    // the card re-resolves it by key on every repaint from there.
    row.addEventListener('click', () => handlers.onReview(item, i));
    container.append(row);
  });

  appendSettledRows(container, done, handlers, now);
}

/** What this sitting already cleared: kept in the stack as struck-through
 *  rows, same anatomy as the live ones (mockup: answered items stay put). */
function appendSettledRows(
  container: HTMLElement,
  done: ReviewItem[],
  handlers: ReviewStripHandlers,
  now: number,
): void {
  for (const item of done) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'hub-review-row hub-review-row-done';
    const title = document.createElement('span');
    title.className = 'hub-review-row-title';
    title.textContent = reviewRowTitle(item);
    const sub = document.createElement('span');
    sub.className = 'hub-review-row-sub';
    sub.textContent = `${askedMeta(item, now)} · answered this sitting`;
    row.append(title, sub);
    row.title = `Done this sitting: ${item.title}`;
    // Still a way back to the thing that was just answered — the row is the
    // only pointer left once the queue dropped it.
    row.addEventListener('click', () => handlers.onOpen(item));
    container.append(row);
  }
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
 * A declared item's ONE body: why + lookFor + detail, composed in core and
 * rendered as markdown. The labelled sub-sections this replaces ("What to
 * review for", the separate detail block) are the anatomy the approved design
 * collapsed — every part is still here, in the author's order, unlabelled.
 * `renderCommentMarkdown` escapes first and only re-adds known-safe tags.
 */
function walkReviewBody(review: NonNullable<ReviewItem['review']>): DocumentFragment | null {
  const markdown = reviewItemBodyMarkdown(review);
  if (markdown === '') return null;
  const frag = document.createDocumentFragment();
  const body = document.createElement('div');
  body.className = 'hub-walk-body';
  body.innerHTML = renderCommentMarkdown(markdown);
  frag.append(body);
  // The API stopped refusing a long detail (the refusal split every real ask
  // into a thread body and a weaker card copy), so the card now has to carry
  // it: the FULL words are always in the DOM — card and thread say the same
  // thing — and past the review target the body clamps ON THE PHONE TIER
  // ONLY (the CSS scopes it; wider screens render everything, since 430px is
  // where an unbounded body buries the options and the composer). The button
  // is the explicit expand affordance; expanding is one-way, like reading.
  if (markdown.split(/\s+/).length > REVIEW_LIMITS.detailTargetWords.review) {
    body.classList.add('hub-walk-body-clamp');
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'hub-walk-body-expand';
    expand.textContent = 'Show the whole ask';
    expand.addEventListener('click', () => {
      body.classList.remove('hub-walk-body-clamp');
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
  container.replaceChildren();
  if (index < 0) {
    container.classList.add('hidden');
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
      const body = walkReviewBody(review);
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
  if (infoSnap && (infoSnap.value.trim() !== '' || infoSnap.focused)) {
    info.classList.remove('hidden');
    more.setAttribute('aria-expanded', 'true');
  }
}

// ── Presence strip (§2.7) ──────────────────────────────────────────────────

export interface PresenceHandlers {
  /** Tap a chip to jump to where they are. */
  onTap: (chip: PresenceChip) => void;
  /** Long-press to follow — your view navigates when theirs does. */
  onLongPress: (chip: PresenceChip) => void;
  /** Tap the "+N" overflow circle — hand back the people it stands for, so
   *  the caller can name them (a title attribute alone is unreachable from a
   *  touch screen). */
  onOverflow?: (hidden: PresenceChip[]) => void;
}

const LONG_PRESS_MS = 550;

/** Compact mode caps the strip at this many circles; past it the last slot
 *  becomes a "+N" that names the rest. Chosen so the cluster's worst case
 *  (4 × 28px + gaps ≈ 124px) still leaves the workspace name room at 430px. */
const MAX_CIRCLES = 4;

export function renderPresence(
  container: HTMLElement,
  chips: PresenceChip[],
  followedKey: string | null,
  handlers: PresenceHandlers,
  // A LIST, because "what is running where" has two independent answers: the
  // agents' plugin bundles and the browser's own client. They fail separately
  // and are fixed separately, so neither may hide the other.
  drift?: ReadonlyArray<DriftNotice | null | undefined> | null,
  // Compact: small circular profile buttons (initials, full name in the
  // title) instead of the long-form chips — the top-right cluster's fit
  // (Bryan, 2026-08-18: "show smaller circle profile buttons for each active
  // user instead of the long form"). Tap and long-press behave exactly as the
  // chips did; only the rendering changes.
  compact = false,
): void {
  container.replaceChildren();
  const notices = (drift ?? []).filter((d): d is DriftNotice => Boolean(d));
  if (chips.length === 0 && notices.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  // Clamp BEFORE the loop, so the overflow circle replaces the fourth chip
  // rather than following it — the cap is a footprint, not a count.
  let visible = chips;
  let hidden: PresenceChip[] = [];
  if (compact && chips.length > MAX_CIRCLES) {
    visible = chips.slice(0, MAX_CIRCLES - 1);
    hidden = chips.slice(MAX_CIRCLES - 1);
  }
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
  for (const chip of visible) {
    const el = document.createElement('button');
    el.type = 'button';
    const base = compact ? 'hub-presence-circle' : 'hub-presence-chip';
    el.className = `${base} hub-presence-${chip.kind}${chip.state ? ` hub-presence-${chip.state}` : ''}${followedKey === chip.key ? ' hub-following' : ''}`;
    el.title =
      followedKey === chip.key ? `${chip.title} · following — long-press to stop` : chip.title;
    if (compact) {
      el.innerHTML = `<span class="hub-presence-initials">${escapeHtml(initialsOf(chip.label))}</span>`;
      el.style.background = `hsl(${presenceHue(chip.label)}, 45%, 45%)`;
      // The circle drops the visible name, so it must be announced — the
      // title alone is read weakly or not at all depending on the reader.
      el.setAttribute('aria-label', chip.title);
    } else {
      el.innerHTML = `<span class="hub-presence-name">${escapeHtml(chip.label)}</span><span class="hub-presence-where">${escapeHtml(chip.where)}</span>`;
    }
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
  if (hidden.length > 0) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'hub-presence-circle hub-presence-more';
    more.textContent = `+${hidden.length}`;
    const names = hidden.map((c) => c.label).join(', ');
    more.title = names;
    more.setAttribute('aria-label', `${hidden.length} more: ${names}`);
    more.addEventListener('click', () => handlers.onOverflow?.(hidden));
    container.append(more);
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
function renderDiscussion(
  task: HubTask,
  discussion: TaskDiscussion,
  onComment: (task: HubTask, text: string, threadId?: string) => Promise<boolean>,
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
    (text) => onComment(task, text, target?.id),
    // Keyed by task: a draft survives every repaint of this panel and never
    // follows the reader onto a different task.
    `discussion:${task.id}`,
  );
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
function bodySlot(task: HubTask): HTMLElement {
  const slot = document.createElement('div');
  slot.className = 'hub-detail-body-slot';
  slot.dataset.taskId = task.id;
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
  slot.append(desc);
  if (task.bodyTruncated) {
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
function keptBodySlot(container: HTMLElement, task: HubTask): HTMLElement | null {
  const prior = container.querySelector<HTMLElement>('.hub-detail-panel');
  if (!prior || prior.dataset.taskId !== task.id) return null;
  const slot = prior.querySelector<HTMLElement>('.hub-detail-body-slot');
  return slot &&
    slot.parentElement === prior &&
    slot.dataset.taskId === task.id &&
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
 * Deliberately the `ReviewPayload` shape (headline / why / detail / options),
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
  why: string;
  detail?: string;
  lookFor?: string;
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
  /** The item DECLARED what it wants (a `review` payload), which is what
   *  makes the answer route legal for it. An inferred item answers by
   *  replying and nothing else. */
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
 * One-directional, like the gate: a body it cannot read yields an empty
 * headline, and the caller falls back rather than inventing a question.
 */
export function decisionBlurb(body: string | undefined): { headline: string; why: string } {
  const text = (body ?? '').trim();
  if (!text) return { headline: '', why: '' };
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
  const why = rows
    .filter((l, i) => i !== questionAt && !isListItem(l) && plain(l) !== '' && !introducesList(i))
    .map(plain)
    .join(' ')
    .trim();
  return { headline, why };
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
      why: blurb.why,
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
      why: r?.why ?? '',
      ...(r?.detail !== undefined ? { detail: r.detail } : {}),
      ...(r?.lookFor !== undefined ? { lookFor: r.lookFor } : {}),
      ...(r?.options ? { options: r.options } : {}),
      askedBy: a.askedBy,
      since: a.askedAt ?? a.since,
      ...(a.direct !== undefined ? { direct: a.direct } : {}),
      threadId: a.threadId,
      docId: a.docId,
      ...(a.commentId !== undefined ? { commentId: a.commentId } : {}),
      // `declared` is the pair the answer route needs, not the payload alone:
      // it records the answer against a COMMENT, so a declaration with no
      // comment id has nothing to write on and answers by replying instead.
      declared: r !== undefined && a.commentId !== undefined,
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
        why: r.why,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        ...(r.lookFor !== undefined ? { lookFor: r.lookFor } : {}),
        askedBy: c.author,
        since: c.ts,
        threadId: t.id,
        docId: task.bodyDocId,
        ...(c.id !== undefined ? { commentId: c.id } : {}),
        declared: c.id !== undefined,
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
  const rank = (i: PanelReviewItem): number =>
    i.answered ? 3 : i.source === 'task' ? 0 : i.shape === 'decision' || i.why !== '' ? 1 : 2;
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
  // body composed of why + lookFor + detail. The separate why/detail/lookFor
  // paragraphs and the trailing meta line this replaces were four blocks
  // saying what the mock says in two.
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
  const keptSlot = keptBodySlot(container, task);
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
    comments.append(
      renderDiscussion(
        task,
        discussion,
        handlers.onComment,
        handlers.focusThreadId,
        handlers.now ?? Date.now(),
      ),
    );
  }

  const activity = document.createElement('div');
  activity.className = 'hub-detail-tabpanel hub-detail-tabpanel-activity';
  activity.setAttribute('role', 'tabpanel');
  // ONE history, newest first: the stored transitions (which carry evidence
  // and the unproven mark) merged with the task's own rows from the workspace
  // audit log. The tab used to render transitions and nothing else, so a
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
