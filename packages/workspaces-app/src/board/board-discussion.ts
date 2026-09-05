/**
 * A row's comments: where they live, how they are read, and how one is posted.
 *
 * One responsibility, and the reason it is one is the sentence the inline
 * version buried: a row's comments live in its BODY doc — `task:<id>` for a
 * task and for a goal alike — so this is the ordinary thread API pointed at
 * that room. There is no second store, an agent's `create_thread` writes the
 * same threads, and a GOAL reaches both its discussion and its description
 * editor through the same two functions. Scattered through `bootBoard` that was
 * invisible: `loadDiscussion` sat beside `renderDetail` and read like part of
 * the panel.
 *
 * The keying is the invariant worth reading twice. `state.discussionTaskId` is
 * claimed BEFORE the fetch and re-checked after it, so a load that lands once
 * the reader has moved to another row paints nothing — and claiming it first is
 * also what stops `renderDetail`'s own "fetch if the id differs" from
 * recursing.
 *
 * `BoardDiscussionDeps` is the whole list of what these verbs may reach.
 * `send`, `fetchJson` and `showToast` are not on it: they are the module-level
 * primitives every board write ends in, imported the way `board-actions.ts`
 * exports them.
 */
import type { ReviewPayload, User } from '@feedback/core';
import { type BoardState, fetchJson, send, showToast } from './board-actions.ts';
import type { TaskThread } from './board-detail-render.ts';

/**
 * A row and its live body room — the only two things the discussion and the
 * description editor ever needed from a task, which is why a GOAL reaches
 * both through the same functions.
 */
export interface DiscussionRow {
  id: string;
  bodyDocId: string;
}

/** Everything the discussion needs from `bootBoard`, and nothing else. */
export interface BoardDiscussionDeps {
  /** The board's one projection: the load claims `discussionTaskId` on it and
   *  writes `discussion` back. LIVE, the same contract `wireBoardLive` uses. */
  state: BoardState;
  /** Who is posting. */
  author: Pick<User, 'id' | 'name' | 'kind' | 'color'>;
  /** Repaint the panel the threads are showing in. */
  renderDetail(): void;
}

/** What `bootBoard` keeps: the two verbs, plus the goal's room derivation. */
export interface BoardDiscussion {
  /** Where a goal's description and comments live. */
  goalBodyDocId(section: { id: string; bodyDocId?: string }): string;
  loadDiscussion(task: DiscussionRow, quiet?: boolean): Promise<void>;
  postRowComment(task: DiscussionRow, text: string, threadId?: string): Promise<boolean>;
}

/**
 * Where a goal's description and comments live.
 *
 * Prefers what the projection sent, and falls back to deriving it. The
 * fallback is not defensive padding: a board served by a server that predates
 * the goal-body projection carries no `bodyDocId`, and without it the panel
 * would fetch `/api/docs//threads` and mount an editor on nothing. Deriving is
 * safe because the shape is a DECISION rather than a lookup — `task:<goalId>`,
 * settled in the goals-as-a-task-type design.
 */
export const goalBodyDocId = (section: { id: string; bodyDocId?: string }): string =>
  section.bodyDocId ?? `task:${section.id}`;

export function createBoardDiscussion(deps: BoardDiscussionDeps): BoardDiscussion {
  const { state, author, renderDetail } = deps;

  /**
   * A row's comments live in its body doc (`task:<rowId>` for a task and for a
   * goal alike), so this is the ordinary thread API pointed at that room — no
   * second store, and the same threads an agent sees through `create_thread`.
   */
  async function loadDiscussion(task: DiscussionRow, quiet = false): Promise<void> {
    state.discussionTaskId = task.id;
    if (!quiet) {
      // A quiet reload is a refresh of something already on screen; flipping
      // it to "Loading…" would blank a discussion the reader is reading.
      state.discussion = { loading: true, threads: [] };
      renderDetail();
    }
    const payload = await fetchJson<{
      threads?: Array<{
        id: string;
        comments?: Array<{
          id?: string;
          author?: { name?: string };
          text?: string;
          ts?: number;
          review?: ReviewPayload;
        }>;
      }>;
    }>(`/api/docs/${encodeURIComponent(task.bodyDocId)}/threads`);
    // The reader may have moved on while this was in flight.
    if (state.discussionTaskId !== task.id) return;
    // Only the id and the words. The payload also carries each thread's
    // status and anchor, and the discussion model deliberately does not:
    // the panel renders every comment as a peer of every other, so the
    // fields fed nothing — see `TaskThread` in board-render.
    const threads: TaskThread[] = (payload?.threads ?? []).map((t) => ({
      id: t.id,
      comments: (t.comments ?? []).map((c) => ({
        // The id is what the answered record's Undo names on the undo route;
        // absent from an older server's payload, and the record then renders
        // without the button rather than with one that could only fail.
        ...(c.id !== undefined ? { id: c.id } : {}),
        author: c.author?.name ?? 'Someone',
        text: c.text ?? '',
        ts: c.ts ?? Date.now(),
        // Forwarded, not re-validated: the server refuses a malformed
        // declaration at the write, and re-deciding here would be a second
        // copy of one rule free to drift from the first.
        ...(c.review ? { review: c.review } : {}),
      })),
    }));
    state.discussion = { loading: false, threads };
    renderDetail();
  }

  /** Resolves to whether the comment actually landed — the composer keeps the
   *  text until it hears yes, so a failed post is retryable. Takes a row
   *  rather than a task: a goal's discussion posts through the same route. */
  async function postRowComment(
    task: DiscussionRow,
    text: string,
    threadId?: string,
  ): Promise<boolean> {
    const doc = encodeURIComponent(task.bodyDocId);
    const res = threadId
      ? await send(`/api/docs/${doc}/threads/${encodeURIComponent(threadId)}/comments`, 'POST', {
          author,
          text,
        })
      : // No anchor to point at — the comment is about the task itself, which
        // is what a subject anchor means. A task's description is often empty,
        // so there is frequently nothing in it to point at at all.
        await send(`/api/docs/${doc}/threads`, 'POST', {
          author,
          text,
          anchor: { kind: 'subject' },
        });
    if (!res.ok) {
      showToast('Posting the comment failed — your text is still in the box');
      return false;
    }
    await loadDiscussion(task);
    return true;
  }

  return { goalBodyDocId, loadDiscussion, postRowComment };
}
