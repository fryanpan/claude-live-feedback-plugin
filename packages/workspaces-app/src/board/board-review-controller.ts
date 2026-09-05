/**
 * The review queue's controller: how a person opens an item, walks the sitting,
 * and answers or asks back — with the REST writes each of those ends in.
 *
 * These were declarations inside `main()`, where the queue's whole answering
 * story sat interleaved with board writes and render plumbing. Same shape as
 * `board-actions.ts`: `createBoardReviewController` takes what they captured as one
 * named object and hands the verbs back, so every call site reads as it did.
 *
 * The refresh order in here is load-bearing and stays as it was. A queue is
 * re-read BEFORE a walkthrough advance, because a position computed against a
 * list that still holds the answered item lands on the wrong card.
 */
import type { Thread, User } from '@feedback/core';
import { activityCommentRequest } from './activity-model.ts';
import type { BoardState } from './board-actions.ts';
import { send, showToast } from './board-actions.ts';
import type { PanelReviewItem } from './board-detail-render.ts';
import { type BoardReviewItem, type BoardTask } from './board-model.ts';
import {
  type ReviewItem,
  type ReviewQueue,
  reviewItemAskRequest,
  reviewItemOwner,
  reviewItemQuestionRequest,
  reviewReplyRequest,
} from './board-review-model.ts';
import { panelAnswerRequest, panelQuestionRequest } from './board-review-render.ts';

/**
 * What the verbs below reach outside themselves for. Named so a reader can see
 * which of them repaint, which re-read the queue, and which do both.
 */
export interface BoardReviewControllerDeps {
  /** Who the write is attributed to. */
  author: Pick<User, 'id' | 'name' | 'kind' | 'color'>;
  /** The projection the walkthrough's aim and tally live on. */
  state: BoardState;
  /** The queue as it stands right now, re-derived rather than stored. */
  currentQueue: () => ReviewQueue;
  /** Repaint the walkthrough card. */
  renderWalkthrough: () => void;
  /** Re-read the REST-fed review items — what actually drops an answered
   *  item out of every surface that shows the queue. */
  loadReviewItems: () => Promise<void>;
  /** Re-read one task's discussion, quietly when it is already on screen. */
  loadDiscussion: (task: BoardTask, quiet?: boolean) => Promise<void>;
  /** Open a task's panel on one thread — the 409 toast's way out. */
  openTaskThread: (taskId: string, threadId: string) => boolean;
}

export function createBoardReviewController(deps: BoardReviewControllerDeps) {
  const {
    author,
    state,
    currentQueue,
    renderWalkthrough,
    loadReviewItems,
    loadDiscussion,
    openTaskThread,
  } = deps;

  function startWalkthrough(): void {
    // A sitting starts empty: the tally counts what THIS pass cleared, so
    // carrying the last one's over would open on "4 cleared" before the
    // reader has answered anything.
    state.walkProgress = { cleared: 0, last: null };
    state.walkIndex = 0;
    state.walkKey = currentQueue().items[0]?.key ?? null;
    renderWalkthrough();
  }

  /**
   * Tapping a row on Home: open the queue's card ON that row, in place.
   *
   * The same surface `Review All` opens, aimed at the item the reader pointed
   * at rather than at the top — one card anatomy, one answer path, and the
   * reader stays on Home. `walkKey` is what actually holds the aim; the index
   * is the fallback for the repaint after the item leaves the queue.
   */
  function openInQueue(item: ReviewItem, index: number): void {
    // A new sitting, exactly as `Review All` starts one: the tally counts what
    // this pass cleared, and a leftover count would open on "4 cleared".
    state.walkProgress = { cleared: 0, last: null };
    state.walkIndex = index;
    state.walkKey = item.key;
    renderWalkthrough();
  }
  /** Resolves to whether the answer LANDED — the walkthrough advances on that
   *  and on nothing else, and the composer keeps the text until it hears yes. */
  async function answerDecision(
    task: BoardTask,
    text: string,
    optionId?: string,
  ): Promise<'answered' | 'asked' | false> {
    // Posted with the PERSON's own identity: answer.by shows who decided.
    // `text` is always the verbatim answer — tapping an option sends the
    // option's label as the answer and its id alongside, so nothing about the
    // recorded answer depends on the option list still existing later.
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/answer`, 'POST', {
      text,
      ...(optionId ? { optionId } : {}),
      author,
    });
    if (!res.ok) {
      showToast('Recording the answer failed — your words are still in the box');
      return false;
    }
    // The server read the words as a QUESTION and recorded them as a request
    // for more context — the decision stays open, and nothing was answered,
    // so the caller must not settle or undo-toast it.
    if (res.data?.asked === true) {
      showToast('Sent as a question — the decision stays open until it is answered');
      return 'asked';
    }
    return 'answered';
  }

  /**
   * The task panel's three answering doors, all of which owe the reader the
   * same thing: the write, then a REPAINT of the panel they are looking at.
   *
   * The walkthrough got that for free — it re-derives its queue on every
   * render — and the panel did not, because its queue is handed down from
   * `state.reviewItems` and nothing re-rendered the panel when that list
   * moved. Measured 2026-08-18: a free-text answer on a thread item persisted
   * server-side and the card sat unchanged 2.5 seconds later, so the natural
   * retry posted it twice.
   */
  async function answerTaskDecision(
    task: BoardTask,
    text: string,
    optionId?: string,
  ): Promise<boolean> {
    const wrote = await answerDecision(task, text, optionId);
    if (wrote === false) return false;
    // A question already toasted for itself, and there is no answer to undo.
    if (wrote === 'answered') showToast('Answer recorded — Undo is on the ticket');
    // The row itself arrives over the ydoc; this is what moves the panel's
    // own queue on, since the review items are a REST-fed projection.
    await loadReviewItems();
    return true;
  }

  /**
   * Take back an answer recorded on a THREAD-borne item — the in-place
   * record's persistent Undo. The server moves the stamps into
   * `answerHistory` (soft, like every delete here) and the reply stays in the
   * thread; every queue re-offers the item on its next read, so the repaint
   * below is the whole client-side story. A 400 usually means somebody else
   * undid it first — the refresh shows the reopened item either way.
   */
  async function undoThreadAnswer(task: BoardTask, item: PanelReviewItem): Promise<boolean> {
    if (!item.threadId || item.commentId === undefined) return false;
    const doc = encodeURIComponent(item.docId ?? task.bodyDocId);
    const thread = encodeURIComponent(item.threadId);
    const res = await send(`/api/docs/${doc}/threads/${thread}/answer/undo`, 'POST', {
      author,
      commentId: item.commentId,
    });
    if (!res.ok) {
      showToast('Taking the answer back failed');
      // Repaint anyway: the likeliest refusal is that a peer already undid
      // it, and a fresh read shows the reopened item rather than a stale
      // record with a dead button.
      await loadDiscussion(task, true);
      await loadReviewItems();
      return false;
    }
    showToast('Answer taken back — the item is open again');
    // Both, and in this order: the discussion so the record leaves the card,
    // the review items so the reopened item comes back to every queue.
    await loadDiscussion(task, true);
    await loadReviewItems();
    return true;
  }

  async function undoTaskAnswer(task: BoardTask): Promise<boolean> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/answer/undo`, 'POST', {
      author,
    });
    if (!res.ok) {
      showToast('Taking the answer back failed');
      return false;
    }
    showToast('Answer taken back — the decision is open again');
    await loadReviewItems();
    return true;
  }

  /**
   * Overrule the quality gate on one held item — "Ask me anyway".
   *
   * The item goes on the queue on the reader's authority, and the queue is
   * re-read so it appears in the same repaint the note leaves in. No confirm:
   * the act is undone by the filer revising, and a dialog in front of a
   * one-tap override is what makes readers leave the hold alone.
   */
  async function releaseHeldReviewItem(task: BoardTask, item: BoardReviewItem): Promise<boolean> {
    const res = await send(
      `/api/tasks/${encodeURIComponent(task.id)}/review-items/${encodeURIComponent(item.id)}/release`,
      'POST',
      { author },
    );
    if (!res.ok) {
      showToast('Could not put that item on your queue');
      return false;
    }
    showToast('On your queue — the gate was overruled');
    await loadReviewItems();
    return true;
  }

  /**
   * Answer an item the panel's queue got from a THREAD or from the TICKET.
   *
   * Same routes the walkthrough uses, for the same reason: a declared thread
   * item records the answer against its declaring comment, an inferred one is
   * answered by replying, and in both cases the REPLY is what takes the item
   * out of the queue; a ticket-borne item is stamped at the task review-item
   * route, which drops it from every queue's next read. The panel used to
   * send this through the plain comment handler, which has nowhere to put the
   * picked option and left the queue showing an item that had just been
   * answered. ONE spelling of the destination — `panelAnswerRequest` — so a
   * card with no thread cannot post at `/threads/undefined/…`.
   */
  async function answerPanelThreadItem(
    task: BoardTask,
    item: PanelReviewItem,
    text: string,
    optionId?: string,
  ): Promise<boolean> {
    const reqSpec = panelAnswerRequest(task, item, text, optionId);
    if (!reqSpec) return false;
    const res = await send(reqSpec.path, 'POST', { ...reqSpec.body, author });
    if (!res.ok) {
      showToast('Posting the answer failed — your text is still in the box');
      return false;
    }
    // A question converted server-side answered nothing — say what actually
    // happened. The refreshes below repaint the row as waiting either way.
    showToast(
      res.data?.asked === true ? 'Sent as a question — the item stays open' : 'Answer posted',
    );
    // Both, and in this order: the discussion so a reply appears in the
    // stream below (a ticket-borne answer writes no comment, but the reload
    // is cheap and keeps one path), the review items so the card it answered
    // leaves the queue.
    await loadDiscussion(task, true);
    await loadReviewItems();
    return true;
  }

  /**
   * Ask on a ticket-borne review item — a thread on the task's doc anchored
   * to a PHRASE of the item (the selection pill, `reviewItemAskRequest`) or
   * to the item as a whole (the card's "I have a question" link,
   * `reviewItemQuestionRequest`; `phrase` is null). Same route either way:
   * the server records the question on the item WITH the thread it made,
   * which is what takes the item off the queue while it waits on its owner,
   * and the owner hears about it the way it hears every task-doc thread.
   *
   * The card LEAVES in the same interaction. It used to be held in place with
   * a "Waiting on <owner>" note until the reader stepped off it — the reason
   * given was that the next card replacing the one just typed into "reads as
   * the page losing the thing they were doing". Measured the other way round
   * (Bryan, 2026-08-31: *"I hit submit and then nothing happens"*): a card
   * that stays put after Send reads as the send not having happened. The
   * toast says the question went and where it is now; the next card is the
   * proof the queue moved.
   *
   * The old `POST /api/tasks/:id/more-info` box that stood here is gone from
   * the board (Bryan, 2026-08-29); the route stays for its other callers.
   */
  async function askOnReviewItem(
    item: ReviewItem,
    phrase: { text: string } | null,
    question: string,
  ): Promise<boolean> {
    const reqSpec = phrase
      ? reviewItemAskRequest(item, phrase.text, question)
      : reviewItemQuestionRequest(item, question);
    if (!reqSpec) return false;
    // A ticket's own decision carries its task on `decision`, not `thread`.
    const taskId = item.thread?.taskId ?? item.decision?.task.id;
    return sendReviewItemQuestion(reqSpec, taskId, reviewItemOwner(item));
  }

  /**
   * The POST behind both asking surfaces (the walkthrough card above, the
   * task panel's card in `askOnPanelItem`), with the one refusal they share
   * spelled once. Resolves to whether the question LANDED; the caller's box
   * keeps its words on anything else.
   */
  async function sendReviewItemQuestion(
    reqSpec: { path: string; body: Record<string, unknown> },
    taskId: string | undefined,
    askedBy: string | undefined,
  ): Promise<boolean> {
    const res = await send(reqSpec.path, 'POST', { ...reqSpec.body, author });
    if (!res.ok) {
      // A stale card: the pill hides itself once THIS session learns the item
      // is waiting, but another session's question can put it there first.
      // The server refuses with the open thread's id rather than filing a
      // second question nobody would read — surface that thread instead of
      // the generic failure, and refresh so the pill goes away here too.
      if (res.status === 409 && res.data?.error === 'waiting') {
        const message =
          typeof res.data.message === 'string'
            ? res.data.message
            : 'Already waiting on the owner — add to the open thread instead';
        const openThreadId = typeof res.data.threadId === 'string' ? res.data.threadId : undefined;
        showToast(
          message,
          openThreadId && taskId
            ? { label: 'Open thread', run: () => openTaskThread(taskId, openThreadId) }
            : undefined,
        );
        await loadReviewItems();
        return false;
      }
      showToast('Sending the question failed — your words are still in the box');
      return false;
    }
    showToast(askedToast('Asked', askedBy));
    // The item is the owner's turn now: the queue drops it on this re-read
    // and every surface that shows the queue — Home, the walkthrough, the
    // task panel's card — repaints without it.
    await loadReviewItems();
    return true;
  }

  /** "Asked — waiting on Helper. It comes back to your queue when they
   *  revise it." One sentence for what happened, one for what happens next:
   *  the card is gone, so the toast is the only thing that says where it
   *  went. */
  function askedToast(lead: string, askedBy: string | undefined): string {
    const owner = askedBy?.trim() || 'the owner';
    return `${lead} — waiting on ${owner}. It comes back to your queue when they revise it.`;
  }

  /**
   * "I have a question" on the task panel's card — the same thread the
   * walkthrough card makes (`reviewItemThreadRequest`, quoting the item's
   * headline), so the item's state is derived the same way and it leaves the
   * panel's queue on the same re-read. Only a ticket-borne item has the
   * anchor; `panelQuestionRequest` answers null for the rest.
   */
  async function askOnPanelItem(
    task: BoardTask,
    item: PanelReviewItem,
    question: string,
  ): Promise<boolean> {
    const reqSpec = panelQuestionRequest(task, item, question);
    if (!reqSpec) return false;
    const ok = await sendReviewItemQuestion(reqSpec, task.id, item.askedBy);
    // The thread it made is in this task's discussion; show it there too.
    if (ok) await loadDiscussion(task, true);
    return ok;
  }

  /**
   * Comment on a phrase of a task's note (or its title) from the activity
   * pane — a thread on the task's doc whose first comment quotes the phrase
   * (`activityCommentRequest` says why the anchor is the task itself). The
   * owner hears about it the way it hears every task-doc thread. Resolves to
   * the thread the server made, which the pane's card then shows.
   */
  async function commentOnActivity(
    taskId: string,
    phrase: { text: string },
    text: string,
  ): Promise<Thread | null> {
    const reqSpec = activityCommentRequest(taskId, phrase.text, text);
    const res = await send(reqSpec.path, 'POST', { ...reqSpec.body, author });
    const thread = res.ok ? (res.data?.thread as Thread | undefined) : undefined;
    if (!thread) {
      showToast('Posting the comment failed — your text is still in the box');
      return null;
    }
    return thread;
  }

  /** A further reply on the thread the activity pane's card is showing —
   *  the same POST the task panel's composer makes. Resolves to the thread
   *  as the server now has it. */
  async function replyOnActivity(
    taskId: string,
    threadId: string,
    text: string,
  ): Promise<Thread | null> {
    const doc = encodeURIComponent(`task:${taskId}`);
    const res = await send(
      `/api/docs/${doc}/threads/${encodeURIComponent(threadId)}/comments`,
      'POST',
      {
        author,
        text,
      },
    );
    const thread = res.ok ? (res.data?.thread as Thread | undefined) : undefined;
    if (!thread) {
      showToast('Posting the reply failed — your text is still in the box');
      return null;
    }
    return thread;
  }

  /**
   * Answer a queued comment from the queue itself. The reply is an ordinary
   * thread comment — the same POST the doc and the task panel use — which is
   * what takes the item OUT of the queue: the server ships a thread row only
   * while a declared item or a direct ask is still waiting on a person, and a
   * person's reply ends the unanswered run (`unansweredRun` in the server's
   * review-queue.ts), so there is no separate dismissed flag to write and
   * none to keep in sync. A declared item is retired the same way through
   * `/answer`, which records the choice on the declaring comment.
   */
  async function replyToReviewItem(
    item: ReviewItem,
    text: string,
    optionId?: string,
  ): Promise<'answered' | 'asked' | false> {
    // ONE spelling of "where does this answer go" (`reviewReplyRequest`): a
    // declared thread item goes through the thread `/answer` route, which
    // posts the SAME reply and additionally records which candidate it came
    // from; an undeclared one is a plain comment; and a TICKET-borne item
    // (`task-review`) posts to the task review-item answer route — it has no
    // thread, and before the routing was shared this handler would have
    // posted its answer at `/api/docs/undefined/…`.
    const reqSpec = reviewReplyRequest(item, text, optionId);
    if (!reqSpec) return false;
    const res = await send(reqSpec.path, 'POST', { ...reqSpec.body, author });
    if (!res.ok) {
      showToast('Posting the reply failed — your text is still in the box');
      return false;
    }
    // The server read the words as a QUESTION asked back at the item —
    // nothing was answered. A ticket-borne item is now waiting on its owner
    // and leaves the queue on the re-read, exactly as `askOnReviewItem`'s
    // does; a thread item stays where the conversation is either way.
    if (res.data?.asked === true) {
      const owner = item.thread?.askedBy?.trim() || 'the owner';
      showToast(
        item.thread?.kind === 'task-review'
          ? askedToast('Sent as a question', owner)
          : `Sent as a question — waiting on ${owner}`,
      );
      await loadReviewItems();
      return 'asked';
    }
    // Refresh BEFORE the advance: the queue has to have dropped the answered
    // item before the new position is computed against it, or the aim lands on
    // a list that still holds the thing just replied to.
    await loadReviewItems();
    return 'answered';
  }

  return {
    startWalkthrough,
    openInQueue,
    answerDecision,
    answerTaskDecision,
    undoThreadAnswer,
    undoTaskAnswer,
    releaseHeldReviewItem,
    answerPanelThreadItem,
    askOnReviewItem,
    askOnPanelItem,
    commentOnActivity,
    replyOnActivity,
    replyToReviewItem,
  };
}

/**
 * Every verb `createBoardReviewController` hands back, as one type.
 *
 * Derived from the factory for the same reason `BoardActions` is: the regions
 * that answer, ask back and undo take the controller whole, so a verb added
 * here reaches them without a second declaration to keep in step.
 */
export type BoardReviewController = ReturnType<typeof createBoardReviewController>;
