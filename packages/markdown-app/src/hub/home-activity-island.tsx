/**
 * The Home "Recent activity" pane, as a Preact island beside the review
 * queue — what is happening to the work, grouped BY TASK, never by agent
 * (Bryan, 2026-08-29: "I don't care who's doing the work, I care about the
 * work"). Sits under "For Your Review" and above "What's New?".
 *
 * Same bridge the review island rides: the vanilla loader owns the fetch and
 * writes the projected tasks it already holds into `homeActivityData`; the
 * island derives the groups (`homeActivity`, the pure model) and renders
 * them. No fetches, no subscriptions of its own; a background event's signal
 * write still waits for the reader's finger through the repaint-guard.
 *
 * One action only: commenting on a phrase of a note line or of the title,
 * doc-style. The lines are plain text — not buttons — so a selection can
 * land on them (and a tap on a word selects it); the walkthrough card's
 * comment pill appears beside the words; tapping it opens the REAL thread
 * card (threads.ts `renderThread`) beside the group, or under it on a narrow
 * viewport, quoting the phrase. The header row is the only other tap, and
 * it opens the task. No hover hints, no comment box, no counters.
 *
 * Groups are keyed on the task id, so a signal write that changes one task's
 * lines leaves every other group's DOM node IDENTICAL.
 */
import type { Thread, User } from '@feedback/core';
import { signal } from '@preact/signals';
import { render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { sizeThreadSlots } from '../thread-morph.ts';
import { ThreadPanel } from '../threads.ts';
import {
  type ActivityGroup,
  type ActivityInput,
  type ActivityNote,
  DENIAL_PREFIX,
  homeActivity,
} from './activity-model.ts';
import { selectWordAtPoint, useSelectionPill } from './selection-pill.ts';

export interface ActivityHandlers {
  /** The header row's one tap: open this task, the way a queue row does. */
  onOpenTask: (taskId: string) => void;
  /** A comment on `phrase` of this task's note or title: opens a thread on
   *  the task's doc. Resolves to the thread the server made, or null when
   *  the write was refused — the words then stay in the box. */
  onComment: (taskId: string, phrase: { text: string }, text: string) => Promise<Thread | null>;
  /** A further reply on the thread the card is showing. Resolves to the
   *  thread as the server now has it, or null when refused. */
  onReply: (taskId: string, threadId: string, text: string) => Promise<Thread | null>;
}

/** The one write target the vanilla side has: the projection as it stands.
 *  The island does the grouping, so the loader never learns the pane's
 *  rules and a rule change never touches hub-app. */
export const homeActivityData = signal<ActivityInput>({ tasks: [], goals: [], now: 0 });

/** The one line the pane shows when nothing has moved in a day. Names the
 *  plugin version whose hooks post the notes, because until an agent restarts
 *  on it the pane is empty for a reason the reader can act on. */
export const ACTIVITY_EMPTY =
  'Nothing yet — agents post a line per turn once they restart on 0.1.124.';

/** Who the card's reply box is addressed to when no user was handed over —
 *  a surface mounted before identity resolves. Never posted with. */
const NOBODY: User = { id: '', name: 'you', kind: 'anon', color: '#888888' };

/** The comment being written or shown on one group. `thread` is null while
 *  the words are still a draft — nothing has been posted yet — and `draft`
 *  is the thread-shaped stand-in the card shows meanwhile. Built ONCE, when
 *  the pill is tapped, and held here rather than rebuilt per paint: the card
 *  keys its DOM on the thread object, and a fresh object on every signal
 *  write (each board event carries a new `now`) would rebuild the card under
 *  the reader's typing. */
interface OpenComment {
  taskId: string;
  phrase: string;
  thread: Thread | null;
  draft: Thread;
}

/**
 * `text` with `mark` wrapped the way a doc marks a thread's range — built
 * declaratively, so Preact owns every node and a repaint never fights a
 * mark it did not draw. Only the first occurrence; a phrase that is not in
 * this text renders it unmarked rather than marking the wrong words.
 */
function Marked(props: { text: string; mark?: string }) {
  const { text, mark } = props;
  const at = mark ? text.indexOf(mark) : -1;
  if (!mark || at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark class="thread-range active">{mark}</mark>
      {text.slice(at + mark.length)}
    </>
  );
}

/**
 * A denial's text, the way the approved mock draws it: the word as prose,
 * the refused SHAPE tinted. Each half is marked on its own, so a phrase
 * that straddles the boundary renders unmarked rather than half-marked.
 */
function DenialText(props: { text: string; mark?: string }) {
  const { text, mark } = props;
  if (!text.startsWith(DENIAL_PREFIX)) return <Marked text={text} mark={mark} />;
  return (
    <>
      <Marked text={DENIAL_PREFIX} mark={mark} />
      <code class="acti-shape">
        <Marked text={text.slice(DENIAL_PREFIX.length)} mark={mark} />
      </code>
    </>
  );
}

function NoteLine(props: { note: ActivityNote; mark?: string }) {
  const { note, mark } = props;
  return (
    <div class={`hub-activity-note hub-activity-note-${note.kind}`}>
      <span class="acti-text">
        {note.kind === 'denial' ? (
          <DenialText text={note.text} mark={mark} />
        ) : (
          <Marked text={note.text} mark={mark} />
        )}
      </span>
      {' · '}
      <span class="acti-age">{note.age}</span>
      {note.agent !== undefined && note.agent !== '' && (
        <span>
          {' · '}
          <span class="acti-agent">{note.agent}</span>
        </span>
      )}
    </div>
  );
}

/**
 * The real thread card, on the pane. `ThreadPanel.renderThread` is the one
 * card renderer every surface uses (the drawer, the redline margin, the
 * modal), and it is imperative DOM — so, like the walkthrough's PromptForm,
 * Preact owns the box and the card is built into it in a layout effect.
 *
 * Before the first post the card renders a DRAFT thread: the reader's own
 * name in the head, the phrase as the topic, no replies, the reply box. Its
 * Reply is what creates the thread; after that the card shows the thread
 * the server returned, and Reply posts to it.
 */
function ThreadCard(props: {
  thread: Thread;
  user: User;
  onReply: (text: string) => Promise<boolean>;
  onFold: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  // Read at submit/fold time, never captured: the handlers close over the
  // draft/thread this paint drew, and the box outlives the paint.
  const latest = useRef(props);
  latest.current = props;
  // What the reply box held when the card was last torn down, handed to the
  // rebuilt card the way `ThreadPanel.render` keeps `pendingReplies` — a
  // rebuild (the reader's identity resolving, a draft becoming the posted
  // thread) must never eat words being typed. A successful post empties the
  // box before the thread changes, so nothing stale is ever restored.
  const pending = useRef('');
  const { thread, user } = props;
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const panel = new ThreadPanel({
      // The panel's own list is never shown — the card is lifted out of it.
      container: document.createElement('div'),
      currentUser: user,
      onThreadClick: (id) => panel.setActive(id),
      onReply: (_id, text) => latest.current.onReply(text),
      // One action only on this pane: the card's Resolve foot is hidden by
      // CSS, and an open thread never offers Re-anchor.
      onResolve: () => {},
      onReopen: () => {},
      onReanchor: () => {},
      // The card folding shut (a tap on it, or its caret) is the one way a
      // draft is put away besides Escape.
      onActiveChange: (id) => {
        if (id === null) latest.current.onFold();
      },
    });
    panel.markSynced();
    panel.setThreads([thread]);
    panel.setActive(thread.id);
    const card = panel.renderThread(thread);
    const ta = card.querySelector<HTMLTextAreaElement>('textarea');
    if (ta && pending.current !== '' && ta.value === '') ta.value = pending.current;
    pending.current = '';
    el.replaceChildren(card);
    // The card's two slots take their height from the face they show; the
    // margin and the drawer measure after insertion and on resize, so does
    // this.
    sizeThreadSlots(el);
    const onResize = (): void => sizeThreadSlots(el);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      pending.current = el.querySelector<HTMLTextAreaElement>('textarea')?.value ?? '';
      el.replaceChildren();
    };
  }, [thread, user]);
  return <div class="acti-thread" ref={host} />;
}

/** A thread that does not exist yet, shaped for the real card: the reader as
 *  its author, the phrase as its topic, nothing said. */
function draftThread(taskId: string, phrase: string, user: User, now: number): Thread {
  return {
    id: `draft:${taskId}`,
    status: 'open',
    // Local only — never posted (`activityCommentRequest` sends a subject
    // anchor and quotes the phrase). The card's topic line reads whichever
    // anchor's snippet it is handed, and this is the one kind with a
    // snippet and nothing else to satisfy.
    anchor: { kind: 'review-item', reviewItemId: 'draft', snippet: { text: phrase } },
    commentCount: 0,
    lastActivity: now,
    createdBy: user,
    comments: [],
  };
}

function Group(props: {
  group: ActivityGroup;
  handlers: ActivityHandlers;
  open: OpenComment | null;
  user: User;
  onPosted: (thread: Thread) => void;
  onClose: () => void;
}) {
  const { group, handlers, open, user } = props;
  const isOpen = open !== null && open.taskId === group.taskId;
  const mark = isOpen ? open.phrase : undefined;
  const openTask = (): void => {
    // A tap that ends a drag across the title is the end of a SELECTION,
    // not a request to leave Home — the pill is about to appear for it.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    handlers.onOpenTask(group.taskId);
  };
  // "Tap a word to select it" on the note lines — a pointer gesture only
  // (a keyboard selects with shift+arrows and needs nothing here), so it is
  // a listener on the node rather than a click handler in the markup.
  const notesRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    const tapWord = (ev: MouseEvent): void => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      selectWordAtPoint(ev.clientX, ev.clientY, el);
    };
    el.addEventListener('click', tapWord);
    return () => el.removeEventListener('click', tapWord);
  }, []);
  const reply = async (text: string): Promise<boolean> => {
    if (!open) return false;
    const t = open.thread
      ? await handlers.onReply(group.taskId, open.thread.id, text)
      : await handlers.onComment(group.taskId, { text: open.phrase }, text);
    if (!t) return false;
    props.onPosted(t);
    return true;
  };
  return (
    // The wrap is always there, so opening a card beside a group never
    // re-parents the group's node. Open, it is a two-column grid at the
    // tablet tier and a stack below 1100px.
    <div class={`acti-group-wrap${isOpen ? ' acti-group-wrap-open' : ''}`}>
      <div class="acti-group" data-task-id={group.taskId}>
        {/* The queue's row anatomy — hairline, 44px floor, hover — as the group
            header. A div acting as a button rather than a <button>, because a
            button's text cannot be selected, and selecting a phrase of the
            title is how it gets commented on. */}
        {/* biome-ignore lint/a11y/useSemanticElements: the title must stay selectable text, which a <button> forbids; the div carries the role, the tab stop and the keys a button has. */}
        <div
          role="button"
          tabIndex={0}
          class={`hub-review-row acti-head${isOpen ? ' acti-group-open' : ''}`}
          title={`Open task: ${group.title}`}
          onClick={openTask}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              handlers.onOpenTask(group.taskId);
            }
          }}
        >
          <span class={`acti-mark acti-mark-${group.status}`} aria-hidden="true" />
          <span class="hub-review-row-title acti-title-text">
            <Marked text={group.title} mark={mark} />
          </span>
          {group.flag && (
            <span class={`hub-badge hub-badge-${group.flag.replace('-', '')}`}>{group.flag}</span>
          )}
        </div>
        <div class="acti-notes" ref={notesRef}>
          {group.notes.map((n) => (
            <NoteLine key={`${n.at}:${n.kind}:${n.text}`} note={n} mark={mark} />
          ))}
          {group.more > 0 && <div class="acti-more">{`+${group.more} more`}</div>}
        </div>
      </div>
      {isOpen && (
        <ThreadCard
          thread={open.thread ?? open.draft}
          user={user}
          onReply={reply}
          onFold={() => {
            // Folding a POSTED thread's card is the card's own fold; only a
            // draft has nothing to keep.
            if (open.thread === null) props.onClose();
          }}
        />
      )}
    </div>
  );
}

function HomeActivity(props: { handlers: ActivityHandlers; user: User }) {
  const input = homeActivityData.value;
  const groups = homeActivity(input);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pill = useSelectionPill(listRef, true);
  const [open, setOpen] = useState<OpenComment | null>(null);
  // Escape puts a draft away. A posted thread's card stays — it is a real
  // thread now, and the way to it is to fold it like any card.
  useLayoutEffect(() => {
    if (!open || open.thread !== null) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setOpen(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  // The group the selection sits in — and only when the words are the
  // task's own: its title or a note's text. An age, an agent's name, a badge
  // or "+N more" are the pane's chrome, not something to comment on, so a
  // selection whose common ancestor is not inside `.acti-title-text` or
  // `.acti-text` gets no pill. That also covers a drag from one group into
  // the next (its ancestor is the list) and one from a note's text out over
  // its age (its ancestor is the line): the pill stays hidden rather than
  // sitting there as a dead tap.
  const taskId = pill.phrase
    ? pill.at
        ?.closest<HTMLElement>('.acti-title-text, .acti-text')
        ?.closest<HTMLElement>('.acti-group')?.dataset.taskId
    : undefined;
  const openCard = (): void => {
    if (!pill.phrase || !taskId) return;
    setOpen({
      taskId,
      phrase: pill.phrase,
      thread: null,
      draft: draftThread(taskId, pill.phrase, props.user, input.now),
    });
    pill.clear();
    window.getSelection()?.removeAllRanges();
  };
  return (
    <section class="hub-activity-card">
      <div class="hub-home-review-head">
        <h2 class="hub-home-heading">Recent activity</h2>
      </div>
      {groups.length === 0 && <p class="hub-home-quiet">{ACTIVITY_EMPTY}</p>}
      {groups.length > 0 && (
        <div class="acti-list" ref={listRef}>
          {groups.map((g) => (
            <Group
              key={g.taskId}
              group={g}
              handlers={props.handlers}
              open={open}
              user={props.user}
              onPosted={(thread) => setOpen((o) => (o ? { ...o, thread } : o))}
              onClose={() => setOpen(null)}
            />
          ))}
        </div>
      )}
      {/* The walkthrough card's pill, on the pane: fixed-position, placed by
          the hook beside the selection's end. `mousedown` is swallowed so the
          tap does not blur the selection before the click lands (touch is
          left alone, since cancelling it cancels the click on iOS). */}
      <button
        type="button"
        class={`comment-pill acti-pill${taskId ? '' : ' hidden'}`}
        style={{ left: `${pill.place.left}px`, top: `${pill.place.top}px` }}
        aria-label="Comment on this"
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={openCard}
      >
        💬
      </button>
    </section>
  );
}

/**
 * Mounts the pane into a wrapper it appends to `host` (`#hub-home-activity`);
 * returns the disposer. The island contract, as the review pane has it: the
 * wrapper — not the host — is Preact's container, disposal is render(null,
 * el), and no vanilla code may replaceChildren/innerHTML a container holding
 * the live island. Handlers are bound once at mount; `user` is who the
 * card's reply box speaks as.
 */
export function mountHomeActivityIsland(
  host: HTMLElement,
  handlers: ActivityHandlers,
  user: User = NOBODY,
): () => void {
  const el = document.createElement('div');
  el.setAttribute('data-preact-island', 'home-activity');
  host.appendChild(el);
  render(<HomeActivity handlers={handlers} user={user} />, el);
  return () => {
    render(null, el);
    el.remove();
  };
}
