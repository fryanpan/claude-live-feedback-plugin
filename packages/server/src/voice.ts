/**
 * Voice routing (§2.4 / §3.8): every utterance is classified — does this
 * change something, or just look something up? — and answered.
 *
 *  - Lookups take the Haiku FAST PATH, on the server: the classification call
 *    carries a compact workspace index (tasks, docs, goals) and the model
 *    names the target; the server validates the id and answers with a
 *    navigation. No full-agent round trip; works with no agent attached.
 *    A lookup the server cannot resolve is NOT answered here: it falls to
 *    the LEAD agent like a change (below), because "nothing matched" was a
 *    dead end nobody heard. Only an empty lead seat may fail it, and then
 *    the ack says how to fill the seat.
 *  - A small ACTION set applied to the RESOURCE IN VIEW runs here too, on the
 *    speaker's own authority: status, assignee, a comment, an answer to the
 *    one open review item, and opening a linked doc. Every one of them goes
 *    through the same store choke point the REST routes use — `transition`,
 *    `setAssignee`, `postComment`, `answerReviewItem` — so a spoken act is
 *    attributed, audited and broadcast exactly like a tapped one, and this
 *    file adds no write path and no audit surface of its own.
 *    `resolveVoiceAction` is the guardrail and it refuses far more than it
 *    allows.
 *  - Everything else — every other change, and any action the guardrail or
 *    the store declined — belongs to the ATTACHED WORKSPACE AGENT, carrying
 *    the transcript VERBATIM: the `voice.request` event rides the workspace
 *    channel the MCP watch already formats. With no live attachment the
 *    request is queued on disk and delivered in the next attach result.
 *
 * **Voice always answers.** Every path out of `handle()` produces an ack that
 * names what was heard and which route handles it — including "agent away —
 * queued" — and every utterance emits `voice.request` (§3.6), so the promise
 * has a checkable artifact.
 *
 * The network half follows the summarizer's rules exactly (summarize.ts):
 * the fast path is opt-in at the seam — `createServer` builds NO default
 * completer, so nothing that merely spins a server up can reach the network;
 * only bin.ts constructs the real one, and only the DEDICATED keychain entry
 * counts as consent for LF→Anthropic traffic.
 */
import { isReviewItemOpen } from '@feedback/core';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';
import { resolveAssignee } from './task-owner.ts';
import { taskBodyDocId, taskIdOfBodyDoc } from './task-projection.ts';
import type { Task, TaskStore, VoiceRoute } from './tasks.ts';
import {
  type VoiceActionPlan,
  type VoiceActor,
  pickReviewItem,
  resolveVoiceAction,
} from './voice-action.ts';
import {
  type VoiceClassification,
  type VoiceContext,
  type VoicePick,
  type VoiceResource,
  type VoiceReviewItem,
  type VoiceReviewOption,
  buildVoicePrompt,
  parseVoiceReply,
  refNavigation,
  reviewItemKey,
  sameOriginPath,
} from './voice-prompt.ts';
import {
  type HubDestination,
  type ScoredCandidate,
  type TitleCandidate,
  answerBody,
  goalOrdinalAsk,
  hubDestinationAsk,
  navigationAsk,
  parseOrdinal,
  pickByLabel,
  resolveByTitle,
  statusAsk,
} from './voice-resolve.ts';
import { type StatusQueueRow, type StatusTask, composeStatus } from './voice-status.ts';

// The deterministic pieces live in voice-resolve.ts; re-exported so callers
// and tests keep one import for "voice". The spoken brief has its own file
// (voice-status.ts) and its own importers.
export {
  answerBody,
  goalOrdinalAsk,
  hubDestinationAsk,
  navigationAsk,
  parseOrdinal,
  pickByLabel,
  resolveByTitle,
  spokenKind,
  statusAsk,
  wordsMatch,
} from './voice-resolve.ts';

/**
 * How long a "which one?" stays answerable. Thirty seconds is a person
 * hearing the question and saying "the second one"; anything longer and the
 * next utterance is about something else — it was 90s, and a question asked
 * on the board could still catch a pick made inside a doc a minute later.
 */
export const CHOICE_WINDOW_MS = 30_000;

/** Sanitize a client-supplied context object; anything malformed → none. */
export function parseVoiceContext(raw: unknown): VoiceContext | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.surface !== 'hub' && r.surface !== 'doc' && r.surface !== 'task') return undefined;
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
  const docId = str(r.docId, 300);
  const taskId = str(r.taskId, 300);
  const visibleHeading = str(r.visibleHeading, 200);
  const threadId = str(r.threadId, 300);
  const reviewItemId = str(r.reviewItemId, 300);
  return {
    surface: r.surface,
    ...(docId !== undefined ? { docId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(visibleHeading !== undefined ? { visibleHeading } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(reviewItemId !== undefined ? { reviewItemId } : {}),
  };
}

/** How the router learns what a doc holds. Injected, because the answer needs
 *  the room store and the review-item builder — neither of which voice owns,
 *  and neither of which it should grow a second copy of. */
export type VoiceDocResourceReader = (
  workspaceId: string,
  docId: string,
) => { title?: string; reviewItems: VoiceReviewItem[] } | undefined;

/**
 * The two room-side writes voice performs, and nothing else.
 *
 * Declared as a narrow structural interface rather than by importing the room
 * store's type, for the same reason `VoiceReviewItem` is a projection: the
 * review-item entity is being reshaped on another branch, and voice must meet
 * it at a stable seam. `DocRooms` satisfies this as-is — these ARE its methods,
 * called with the arguments they already take, not reimplemented and not
 * restructured.
 */
export interface VoiceRooms {
  postComment(
    docId: string,
    threadId: string | null,
    author: VoiceActor,
    text: string,
    anchor?: { kind: 'subject' },
    opts?: { generate?: boolean },
  ): Promise<{ id: string } | null>;
  answerReviewItem(
    docId: string,
    threadId: string,
    commentId: string,
    author: VoiceActor,
    text: string,
    optionId?: string,
    opts?: { generate?: boolean },
  ): Promise<{ ok: boolean }>;
}

/**
 * A task's discussion room, CREATED if this process has not served it yet.
 *
 * Injected rather than derived from the task id, because `task:<id>` is only
 * half the answer: body rooms are made lazily, so on a freshly restarted
 * server the room for a task nobody has opened does not exist and a comment
 * aimed straight at that docId is silently dropped. The one function that
 * both ensures and names it lives in the projection, so voice asks for it.
 */
export type VoiceTaskCommentDoc = (taskId: string) => string | undefined;

/** One classification round trip: prompt in, raw reply text out. Injected in
 *  tests; the real one is `haikuVoiceComplete` below. */
export type VoiceComplete = (args: { system: string; user: string }) => Promise<string>;

export interface VoiceResult {
  route: VoiceRoute;
  /** The explicit reply: what was heard, and which route handles it. */
  ack: string;
  /** Where the client should take the speaker (fast-path lookup hits only). */
  navigate?: string;
}

export type VoiceHandleResult =
  | ({ ok: true } & VoiceResult)
  | { ok: false; error: 'workspace-not-found' };

const MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
/**
 * 120 was sized for a 30-byte classification, and an action reply is longer.
 * Raised deliberately rather than left to fit "most" of them: a truncated
 * reply parses to null, which is SAFE — it takes the agent route — but it is
 * safe in the way a permanently disabled feature is safe, and nothing would
 * have reported it. Still far under a runaway.
 */
const MAX_TOKENS = 200;
const TIMEOUT_MS = 10_000;
/** Keep acks readable when a hold rambles. */
const ACK_TRANSCRIPT_MAX = 90;
/** How long a repeat of the same spoken text counts as a RETRY rather than a
 *  second thing to say. Generous enough to cover a lost response plus the
 *  speaker realising and repeating themselves; far short of a session. */
const RETRY_WINDOW_MS = 90_000;

/**
 * A voice write never spends the summary API key.
 *
 * The comment routes pass `generate: !visitor` because a share visitor must
 * not be able to run up a bill on a public tunnel URL. Voice states the same
 * rule as a STANDING refusal instead of a live gate, because the router has no
 * visitor flag to read and could only get one by threading request identity
 * down here. Today it would always be `true` — `/api/workspaces/<id>/voice` is
 * not on the share allowlist, so only a local speaker reaches it — and that is
 * exactly the argument that would make this line safe to omit right up until
 * the allowlist widened. The cost is the whole cost: a spoken comment gets no
 * generated thread summary. One line of speech is not what a summary is for.
 */
const NO_GENERATE = { generate: false } as const;

function heard(transcript: string): string {
  const t =
    transcript.length > ACK_TRANSCRIPT_MAX
      ? `${transcript.slice(0, ACK_TRANSCRIPT_MAX - 1)}…`
      : transcript;
  return `Heard: "${t}".`;
}

/** Where a "which one?" was asked from — surface, doc, task — so an answer
 *  said from somewhere else is not taken as one. */
function choiceAnchor(context: VoiceContext | undefined): string {
  return context ? `${context.surface}\0${context.docId ?? ''}\0${context.taskId ?? ''}` : '';
}

/**
 * What running a plan produced.
 *
 * `defer` is the important half: an executor that cannot finish the job hands
 * the utterance back to the agent route UNCHANGED, and may attach one clause
 * saying why. It is not an error path — the speaker still gets an answer, and
 * the work still gets done, just by somebody with more room to think.
 */
type ActionOutcome = { kind: 'answered'; result: VoiceResult } | { kind: 'defer'; note?: string };

export class VoiceRouter {
  private tasks: TaskStore;
  private complete: VoiceComplete | undefined;
  private docResource: VoiceDocResourceReader | undefined;
  private rooms: VoiceRooms | undefined;
  private taskCommentDoc: VoiceTaskCommentDoc | undefined;
  private docTitle: ((workspaceId: string, docId: string) => string | undefined) | undefined;
  private queue: ((workspaceId: string) => StatusQueueRow[]) | undefined;
  /** Recent text writes, keyed by workspace + verb + target + exact words —
   *  see `once`. Pruned on every write, so it cannot grow without bound. */
  private recentWrites = new Map<string, number>();
  /**
   * "Did you mean A or B?" — the two the router offered, per speaker, so the
   * NEXT utterance ("the second one", "the billing one") can answer. Consumed
   * by whatever is said next, expired after `CHOICE_WINDOW_MS`, and DROPPED
   * when the speaker's context changes: a question asked on the board is not
   * what "pick the second one" means once they have tapped into a decision
   * doc — there it is an answer to the decision, and it used to navigate.
   */
  private pendingChoices = new Map<
    string,
    { candidates: ScoredCandidate[]; at: number; anchor: string }
  >();
  private now: () => number;

  constructor(opts: {
    tasks: TaskStore;
    complete?: VoiceComplete;
    docResource?: VoiceDocResourceReader;
    /** Absent on a server built without a room store — the two text verbs then
     *  defer, exactly as they did before their executors existed. */
    rooms?: VoiceRooms;
    taskCommentDoc?: VoiceTaskCommentDoc;
    /** A doc's label, for title matching and the prompt's index. Absent, a
     *  doc can only be reached by its id — which is what "never worked". */
    docTitle?: (workspaceId: string, docId: string) => string | undefined;
    /** What is waiting on a person board-wide — the Home queue, as the
     *  review-items route ships it. Feeds "brief status" only. */
    queue?: (workspaceId: string) => StatusQueueRow[];
    /** The clock, for the "which one?" window. Tests move it. */
    now?: () => number;
  }) {
    this.now = opts.now ?? Date.now;
    this.tasks = opts.tasks;
    this.complete = opts.complete;
    this.docResource = opts.docResource;
    this.rooms = opts.rooms;
    this.taskCommentDoc = opts.taskCommentDoc;
    this.docTitle = opts.docTitle;
    this.queue = opts.queue;
  }

  /**
   * THE membership predicate for a task id — one rule, used by the context
   * check and by the lookup validation below.
   *
   * They agree today, which is exactly when two copies are cheapest to write
   * and most expensive later: one gets a fix and the other keeps the hole.
   * `getTask` is a GLOBAL index, so without this an id from any board on this
   * server resolves.
   */
  private taskInWorkspace(workspaceId: string, taskId: string): Task | undefined {
    const task = this.tasks.getTask(taskId);
    return task && task.workspaceId === workspaceId ? task : undefined;
  }

  /**
   * The same rule for a doc: attached to THIS workspace, or not present.
   *
   * A task's BODY room (`task:<taskId>`) is the second half, and it was
   * missing. `/review/task:<id>` is a real surface the hub links to, and
   * `workspaceOfDoc` deliberately resolves those rooms to the task's
   * workspace — but `attachDoc` is the only writer of `docIds` and it never
   * holds one, so speaking on that page had its docId silently dropped from
   * the prompt, from the channel line and from the queue. The agent that
   * later attached got a deictic "assign this to me" with no referent.
   */
  private docInWorkspace(workspaceId: string, docId: string): boolean {
    if (this.tasks.getWorkspace(workspaceId)?.docIds.includes(docId)) return true;
    const taskId = taskIdOfBodyDoc(docId);
    return taskId !== null && this.taskInWorkspace(workspaceId, taskId) !== undefined;
  }

  /**
   * The client's context, with any id that is not a member of this workspace
   * DROPPED — never trusted, never quietly passed along.
   *
   * `parseVoiceContext` only clamps lengths, so up to here a `taskId` is an
   * arbitrary client string. Dropping happens before the context is used for
   * ANYTHING — prompt, queue, audit record — rather than only at the point of
   * a write: a foreign id in the queue is a foreign id the next reader has to
   * re-check, and one of them eventually won't.
   */
  private validateContext(workspaceId: string, context?: VoiceContext): VoiceContext | undefined {
    if (!context) return undefined;
    const taskId =
      context.taskId !== undefined && this.taskInWorkspace(workspaceId, context.taskId)
        ? context.taskId
        : undefined;
    const docId =
      context.docId !== undefined && this.docInWorkspace(workspaceId, context.docId)
        ? context.docId
        : undefined;
    return {
      surface: context.surface,
      ...(docId !== undefined ? { docId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(context.visibleHeading !== undefined ? { visibleHeading: context.visibleHeading } : {}),
      // Carried, not validated: neither is ever acted on by itself. They only
      // SELECT among review items the router has already read off a resource
      // that passed the membership checks above (`pickReviewItem`).
      ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
      ...(context.reviewItemId !== undefined ? { reviewItemId: context.reviewItemId } : {}),
    };
  }

  /**
   * The resource the speaker is looking at, for the prompt. Takes an ALREADY
   * VALIDATED context — the ids here are members by construction.
   *
   * A task wins over a doc when both are set: the task is the narrower thing
   * in view (a task opened over a doc surface), and "this" means the narrower
   * one to whoever said it.
   */
  private resourceInView(workspaceId: string, context?: VoiceContext): VoiceResource | undefined {
    if (!context) return undefined;
    if (context.taskId !== undefined) {
      const task = this.taskInWorkspace(workspaceId, context.taskId);
      if (task) {
        // Both places a ticket's review items live: rows on the ticket
        // itself, and declared threads on its discussion. Read through the
        // same two readers everything else uses, so what the panel shows and
        // what voice can answer cannot disagree.
        const ticketItems: VoiceReviewItem[] = this.tasks
          .listReviewItems(task.id)
          .filter(isReviewItemOpen)
          .map((r) => ({
            reviewItemId: r.id,
            ask: r.review.headline,
            askedBy: r.createdBy,
            ...(r.review.options?.length
              ? { options: r.review.options.map((o) => ({ id: o.id, label: o.label })) }
              : {}),
          }));
        const threadItems =
          this.docResource?.(workspaceId, taskBodyDocId(task.id))?.reviewItems ?? [];
        return {
          kind: 'task',
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: task.assignee,
          ...(task.needs !== undefined ? { needs: task.needs } : {}),
          links: task.links,
          reviewItems: [...ticketItems, ...threadItems],
        };
      }
    }
    if (context.docId !== undefined) {
      const doc = this.docResource?.(workspaceId, context.docId);
      return {
        kind: 'doc',
        id: context.docId,
        ...(doc?.title ? { title: doc.title } : {}),
        reviewItems: doc?.reviewItems ?? [],
      };
    }
    return undefined;
  }

  /**
   * Run a resolved plan against the store — or decline it.
   *
   * Both writers go through the SAME choke points the REST routes use
   * (`transition` / `setAssignee`), which is what makes this commit add no
   * new write path and no new audit surface: `by: {…, kind: classifyActor}`
   * lands on the transition row, and `task.transitioned` / `task.assigned`
   * reach events.jsonl at the store's emit choke point before any listener
   * fires. A voice move and a tapped move are the same bytes in the log.
   *
   * The two text verbs go through `rooms.postComment` — the ONE choke point
   * every reply path in this server already funnels through — and through
   * `rooms.answerReviewItem` called exactly as it stands. Neither is
   * reimplemented here: a spoken comment and a typed one are the same write,
   * fire the same events, and reach a watching agent identically.
   *
   * A verb added to `VOICE_ACTIONS` without a case here defers, which is the
   * safe direction.
   */
  private async executeAction(
    workspaceId: string,
    transcript: string,
    plan: VoiceActionPlan,
  ): Promise<ActionOutcome> {
    switch (plan.action) {
      case 'set-status': {
        // Read the status BEFORE the write: the ack has to name both ends of
        // the move, and after `transition` the task carries only the new one.
        const from = this.tasks.getTask(plan.taskId)?.status;
        const res = this.tasks.transition(plan.taskId, plan.status, { actor: plan.actor });
        if (res.ok) {
          return {
            kind: 'answered',
            result: {
              route: 'fast-path-action',
              ack: `${heard(transcript)} Moved "${res.task.title}" from ${from} to ${plan.status}.`,
            },
          };
        }
        // ALREADY THERE IS SUCCESS. A voice retry after a dropped response is
        // the likeliest retry there is — the speaker heard nothing and said
        // it again — and answering "that failed" about a board which already
        // says exactly what they asked for is the worst available answer: it
        // invites a third attempt and teaches them the feature is unreliable.
        if (res.error === 'same-status') {
          const task = this.tasks.getTask(plan.taskId);
          return {
            kind: 'answered',
            result: {
              route: 'fast-path-action',
              ack: `${heard(transcript)} "${task?.title ?? plan.taskId}" is already ${plan.status}.`,
            },
          };
        }
        // Blocked is a JUDGEMENT, not a failure: an open dependency refused
        // the move, and deciding what to do about that is the agent's work.
        // Name the blockers anyway — "sent to the agent" with no reason reads
        // as the fast path having simply not fired.
        if (res.error === 'blocked') {
          const names = (res.blockers ?? [])
            .filter((b) => b.enforce)
            .map((b) => `"${b.title}"`)
            .join(', ');
          return names.length > 0
            ? { kind: 'defer', note: `Blocked by ${names}.` }
            : { kind: 'defer' };
        }
        return { kind: 'defer' };
      }
      case 'set-assignee': {
        // The same gate the hand-over route applies, via the same function:
        // a board must not be walked back to the generic owner one utterance
        // at a time, and "agent" is a category rather than somebody. No
        // author fallback here either — `resolveVoiceAction` has already
        // turned "me" into the speaker's name, which is a deliberate
        // resolution and not a guess about who a blank assignee meant.
        const assignee = resolveAssignee(plan.assignee, undefined);
        if (!assignee) return { kind: 'defer' };
        const res = this.tasks.setAssignee(plan.taskId, assignee, { actor: plan.actor });
        if (!res.ok) return { kind: 'defer' };
        // `changed: false` is acked as success for the same reason
        // same-status is: the board already says what was asked for.
        return {
          kind: 'answered',
          result: {
            route: 'fast-path-action',
            ack: `${heard(transcript)} Assigned "${res.task.title}" to ${assignee}.`,
          },
        };
      }
      case 'comment': {
        if (!this.verbatim(transcript, plan.text) || !this.rooms) return { kind: 'defer' };
        const rooms = this.rooms;
        // A task discussion lives in the task's own body room, which may not
        // exist yet; a doc's comments live on the doc itself.
        const docId =
          plan.target.kind === 'task'
            ? this.taskCommentDoc?.(plan.target.taskId)
            : plan.target.docId;
        if (!docId) return { kind: 'defer' };
        const label =
          plan.target.kind === 'task'
            ? (this.tasks.getTask(plan.target.taskId)?.title ?? plan.target.taskId)
            : plan.target.docId;
        return this.once(
          workspaceId,
          `comment|${docId}|${plan.actor.id}|${plan.text}`,
          `${heard(transcript)} Commented on "${label}".`,
          async () => {
            // A NEW thread, anchored to the subject: a spoken comment points
            // at the thing as a whole, and `VoiceContext` carries no text
            // range for it to point into. A subject anchor also cannot break,
            // so this comment can never orphan.
            const thread = await rooms.postComment(
              docId,
              null,
              plan.actor,
              plan.text,
              { kind: 'subject' },
              NO_GENERATE,
            );
            return thread !== null;
          },
        );
      }
      case 'answer-review': {
        // The words posted are the speaker's (the transcript, or the transcript
        // minus its spoken "answer:" prefix) or the STORE's (an option label).
        // Never the model's.
        if (!this.verbatim(transcript, plan.text, plan.optionId !== undefined)) {
          return { kind: 'defer' };
        }
        const { target } = plan;
        // The ack says what was RECORDED — the option or the words, and on
        // which item — because the person holding the mic is the only
        // verifier this design has (Bryan: "Answered 'Keep placeholders' on
        // <headline>"). One shape for an option and for free words: what
        // landed, then where. Only the verb changes for a plain reply.
        const headline = `"${plan.headline}"`;
        const verb = target.kind === 'thread' && target.mode === 'reply' ? 'Replied' : 'Answered';
        const ack = `${heard(transcript)} ${verb} "${plan.text}" on ${headline}.`;
        if (target.kind === 'ticket') {
          return this.once(
            workspaceId,
            `answer-review|${target.taskId}|${target.reviewItemId}|${plan.actor.id}|${plan.optionId ?? ''}|${plan.text}`,
            ack,
            // The same store write the ticket's answer route makes, with the
            // same provenance stamp for a picked option.
            async () =>
              this.tasks.answerTaskReview(target.taskId, target.reviewItemId, plan.text, {
                actor: plan.actor,
                ...(plan.optionId !== undefined ? { answeredWith: plan.optionId } : {}),
              }).ok,
          );
        }
        if (!this.rooms) return { kind: 'defer' };
        const rooms = this.rooms;
        return this.once(
          workspaceId,
          `answer-review|${target.docId}|${target.threadId}|${plan.actor.id}|${plan.optionId ?? ''}|${plan.text}`,
          ack,
          async () => {
            if (target.mode === 'answer') {
              // Called as it stands. A free-text answer leaves the `optionId`
              // slot empty, exactly as a typed answer does; a pick fills it
              // with the store's own id, exactly as a tap does. Everything
              // that makes an answer an answer — the reply, the reopen, the
              // events a watching agent receives — is that function's, not
              // this one's.
              const res = await rooms.answerReviewItem(
                target.docId,
                target.threadId,
                target.commentId,
                plan.actor,
                plan.text,
                plan.optionId,
                NO_GENERATE,
              );
              return res.ok;
            }
            // No declaration to stamp — so the honest write is the one every
            // typed reply already makes: `postComment` onto that thread.
            // Not a fallback keyed off an error string: `answerable` is read
            // from the projection, so the branch is chosen from a fact rather
            // than from a message another branch may rename.
            const replied = await rooms.postComment(
              target.docId,
              target.threadId,
              plan.actor,
              plan.text,
              undefined,
              NO_GENERATE,
            );
            return replied !== null;
          },
        );
      }
      case 'open-link': {
        const navigate = refNavigation(plan.ref);
        if (!navigate) return { kind: 'defer' };
        return {
          kind: 'answered',
          result: {
            // 'fast-path', NOT 'fast-path-action'. The board did not move, so
            // there is nothing for the attached agent to be told about; this
            // is precisely "a lookup the server already answered", which is
            // the route the MCP suppresses. Sending it as an action would
            // hand the agent an instruction to open a link already open.
            route: 'fast-path',
            ack: `${heard(transcript)} Opening the linked doc.`,
            navigate,
          },
        };
      }
      default:
        return { kind: 'defer' };
    }
  }

  /**
   * The posted body IS the transcript, asserted at the write rather than
   * trusted from the plan.
   *
   * `resolveVoiceAction` sets `text` from the transcript and nothing else
   * writes a plan — so this can only fire on a future edit, which is the
   * point. The failure it forecloses is specific and silent: `MAX_TOKENS`
   * truncates a reply mid-sentence, and a design that ever let the model
   * supply the words would post half a sentence to a thread under the
   * speaker's name, indistinguishable from something they said.
   */
  private verbatim(transcript: string, text: string, isOptionLabel = false): boolean {
    if (text === transcript) return true;
    // "answer: yes but only for the auth task" posts the words after the
    // prefix — a deterministic strip of the speaker's own sentence.
    if (answerBody(transcript) === text) return true;
    // An option label comes from the store, and the plan only carries one
    // the guardrail found on the item itself.
    if (isOptionLabel) return true;
    console.error('[voice] refusing to post text that is not the transcript');
    return false;
  }

  /**
   * Run a TEXT write once per window, and answer the repeat identically.
   *
   * `set-status` already treats "already there" as success, and the reason
   * given there is the whole reason for this: a voice retry after a dropped
   * response is the likeliest retry there is — the speaker heard nothing and
   * said it again. The two text verbs had no equivalent, so the same sentence
   * twice made two threads under the speaker's name, and this project
   * soft-deletes, so nothing removes the second one cleanly.
   *
   * In-memory and per-process on purpose: it defends the retry that follows a
   * lost response by seconds, which is the measured failure. It is NOT
   * durable across a restart, and it does not see an agent re-applying the
   * same words through the MCP tools — neither is claimed.
   */
  private async once(
    workspaceId: string,
    key: string,
    ack: string,
    write: () => Promise<boolean>,
  ): Promise<ActionOutcome> {
    const full = `${workspaceId}\0${key}`;
    const now = Date.now();
    for (const [k, at] of this.recentWrites)
      if (now - at > RETRY_WINDOW_MS) this.recentWrites.delete(k);
    const seen = this.recentWrites.get(full);
    if (seen !== undefined && now - seen <= RETRY_WINDOW_MS) {
      // The board already says it. Answer exactly as the first call did — a
      // different answer to the same sentence is what invites a third try.
      return { kind: 'answered', result: { route: 'fast-path-action', ack } };
    }
    // Reserved BEFORE the await, released if the write fails. Two requests in
    // flight at once — a double-tap on the mic, or a client retry that races
    // the first response rather than following it — both miss a ledger
    // written afterwards, which is the case a naive "record it when it lands"
    // ledger cannot see.
    this.recentWrites.set(full, now);
    if (!(await write())) {
      this.recentWrites.delete(full);
      return { kind: 'defer' };
    }
    return { kind: 'answered', result: { route: 'fast-path-action', ack } };
  }

  /**
   * Route one utterance. Never throws for a live workspace: every failure
   * mode degrades to the agent route with an honest ack, because the one
   * unacceptable outcome is an utterance that gets no answer (§2.4).
   */
  async handle(
    workspaceId: string,
    req: {
      transcript: string;
      context?: VoiceContext;
      actor: VoiceActor;
    },
  ): Promise<VoiceHandleResult> {
    const workspace = this.tasks.getWorkspace(workspaceId);
    if (!workspace) return { ok: false, error: 'workspace-not-found' };
    const { transcript, actor } = req;
    // Everything below reads `context`, and nothing below re-checks it.
    const context = this.validateContext(workspaceId, req.context);

    let classification: VoiceClassification | null = null;
    let fastPathDown = false;
    // Hoisted: an action is resolved against the SAME projection the model
    // was shown, so the guardrail cannot be arguing about a different read of
    // the store than the one that produced the classification.
    let resource: VoiceResource | undefined;
    try {
      // In a try, not bare. `resourceInView` walks the review items of every
      // doc on the board through injected readers, and every one of those is
      // I/O this function does not own. An exception here used to escape
      // `handle()` entirely — no `voice.request` row, no queue, a 500 to the
      // client — which is the one outcome §2.4 rules out. Degrading to a
      // prompt with no resource block is a worse classification and an
      // honest one.
      resource = this.resourceInView(workspaceId, context);
    } catch (err) {
      console.error('[voice] resource read failed:', err instanceof Error ? err.message : err);
    }

    /**
     * A READ the server answered itself, with no model: a status brief, a
     * navigation resolved by title, the "which one?" question when two titles
     * are too close to call, or the answer to that question. Read-only, so
     * nothing is queued for an agent and the route is `fast-path`.
     */
    let direct: VoiceResult | undefined;
    /** Title matches below the confidence floor: the model is shown THESE
     *  rather than the whole board, and validated exactly as before. */
    let narrowTo: ScoredCandidate[] | undefined;
    try {
      direct = this.answerPendingChoice(workspaceId, transcript, actor, context);
      if (!direct && statusAsk(transcript)) {
        direct = this.statusResult(workspaceId, workspace.name, resource);
      }
      // The hub's own places and a goal by its rank come BEFORE the title
      // index: "the homepage" and "my top goal" are not titles, and both
      // used to fall through to a model that had nothing to match them to
      // and a lead agent that cannot drive a browser (Bryan, 2026-08-29).
      if (!direct) {
        const nav = hubDestinationAsk(transcript, [workspace.name]);
        if (nav !== null) direct = this.openHubDestination(workspaceId, transcript, nav);
      }
      if (!direct) {
        const at = goalOrdinalAsk(transcript, workspace.goals.length, [workspace.name]);
        const goal = at === null ? undefined : workspace.goals[at];
        if (goal) {
          direct = this.openCandidate(workspaceId, transcript, {
            id: goal.id,
            kind: 'goal',
            title: goal.title,
          });
        }
      }
      if (!direct) {
        const name = navigationAsk(transcript, [workspace.name]);
        if (name !== null) {
          const r = resolveByTitle(name, this.titleIndex(workspaceId));
          if (r.kind === 'hit') direct = this.openCandidate(workspaceId, transcript, r.match);
          else if (r.kind === 'ambiguous')
            direct = this.askWhich(workspaceId, transcript, actor, context, r.matches);
          else narrowTo = r.top;
        }
      }
      // A spoken pick or answer on the review item in view needs no model
      // either: the words are the speaker's, the option is the store's. A
      // pick with no item to land on is answered with a question, not a
      // guess — and not a model call either, which could only guess too.
      if (!direct) {
        const picked = this.directPick(transcript, context, resource);
        if (picked && 'direct' in picked) direct = picked.direct;
        else if (picked) classification = picked.classification;
      }
    } catch (err) {
      console.error('[voice] direct read failed:', err instanceof Error ? err.message : err);
    }

    if (direct || classification) {
      // Answered, or resolved to an action, without the model.
    } else if (this.complete) {
      const keep = narrowTo?.length
        ? new Set(narrowTo.map((c) => c.id).concat(resource ? [resource.id] : []))
        : undefined;
      const docTitles: Record<string, string> = {};
      for (const d of workspace.docIds) {
        const title = this.docTitle?.(workspaceId, d);
        if (title) docTitles[d] = title;
      }
      const index = {
        goals: workspace.goals.map((g) => ({ id: g.id, title: g.title })),
        tasks: this.tasks
          .listTasks(workspaceId)
          .filter((t) => !keep || keep.has(t.id))
          .map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            ...(t.needs !== undefined ? { needs: t.needs } : {}),
          })),
        docIds: workspace.docIds.filter((d) => !keep || keep.has(d)),
        docTitles,
      };
      try {
        const reply = await this.complete(buildVoicePrompt(index, transcript, context, resource));
        classification = parseVoiceReply(reply);
        if (!classification) fastPathDown = true;
      } catch (err) {
        console.error('[voice] fast path failed:', err instanceof Error ? err.message : err);
        fastPathDown = true;
      }
    } else {
      fastPathDown = true;
    }

    // An action the router ran itself, if the guardrail let it and the store
    // agreed. Anything short of that is `undefined` and falls to the agent
    // route below — deliberately the SAME branch a change takes, so a
    // declined action is indistinguishable from an utterance voice never
    // claimed to handle.
    let answered: VoiceResult | undefined;
    /** One clause explaining why an action went to the agent after all. */
    let deferNote = '';
    if (classification?.kind === 'action') {
      const plan = resolveVoiceAction({
        classification,
        actor,
        transcript,
        ...(context !== undefined ? { context } : {}),
        ...(resource !== undefined ? { resource } : {}),
      });
      if (plan) {
        // Same reason as the resource read above: `executeAction` creates a
        // body room, parses a task body and awaits two room writes. A
        // rejection there is a reason to hand the utterance to the agent, not
        // to lose it.
        let outcome: ActionOutcome = { kind: 'defer' };
        try {
          outcome = await this.executeAction(workspaceId, transcript, plan);
        } catch (err) {
          console.error('[voice] action failed:', err instanceof Error ? err.message : err);
        }
        if (outcome.kind === 'answered') answered = outcome.result;
        else if (outcome.note) deferNote = ` ${outcome.note}`;
      }
    }

    let result: VoiceResult;
    /** The queue entry this utterance was written to, so the emit can name it
     *  and the receiving agent can acknowledge exactly one row. */
    let queueId: string | false = false;
    if (answered) {
      result = answered;
      // The utterance can carry MORE than the verb ("mark this done and then
      // draft the migration notes"), and the only durable channel to an away
      // agent is this queue — `attachAgent` drains it and nothing replays
      // events.jsonl. Before this, an action answered on a board with nobody
      // live dropped the remainder on the floor while the ack read as full
      // success. `applied` is what stops the draining agent redoing the part
      // that already happened.
      if (!this.tasks.hasLiveAttachment(workspaceId)) {
        this.tasks.queueVoiceRequest(workspaceId, {
          transcript,
          ...(context !== undefined ? { context } : {}),
          actor,
          applied: result.ack,
        });
      }
    } else if (direct) {
      // A read the server answered itself — nothing moved, nothing to hand
      // over. Same standing as a resolved lookup.
      result = direct;
    } else if (
      classification?.kind === 'lookup' &&
      (answered = this.lookupResult(workspaceId, transcript, classification))
    ) {
      // A lookup the server could vouch for: navigate, and hand nothing over.
      result = answered;
    } else if (classification?.kind === 'lookup' && workspace.leadAgentId === undefined) {
      // A lookup that resolved nothing, on a board with an EMPTY seat. This is
      // the one place voice may fail, and the message is the next step, never
      // the bare "nothing matched" it used to be. Nothing is queued: a row on
      // a board with no lead is a promise to nobody.
      result = {
        route: 'fast-path',
        ack: `${heard(transcript)} Nothing here matched, and no lead agent is registered for this workspace — attach an agent to take the seat, then say it again.`,
      };
    } else {
      // A change — or an unclassifiable utterance, an action the guardrail or
      // the store declined, or a lookup that matched nothing. All of them need
      // judgment this call does not have, which is what the agent is for.
      //
      // The lookup miss used to stop here with "nothing in this workspace
      // matched": route `fast-path`, no queue row, an emit the MCP drops. A
      // spoken request that the fast path merely could not RESOLVE was the
      // one utterance nobody ever heard (Bryan, 2026-08-29: "voice requests
      // should always fall back to the lead agent, never say lookup
      // failed"). It now takes exactly this branch, addressed to the lead:
      // the seat is proved occupied above, and liveness is the LEAD's, not
      // any bystander's, because the ack names the lead and the queue drains
      // only for it.
      const lookupMiss = classification?.kind === 'lookup';
      const note = fastPathDown ? ' (Fast path unavailable.)' : '';
      // Written down FIRST, and whether or not anyone is listening. The queue
      // is the record; the emit below is an optimisation on top of it. It used
      // to be the other way round — the live branch kept nothing — which made
      // being live strictly worse for a message's odds than being away.
      queueId = this.tasks.queueVoiceRequest(workspaceId, {
        transcript,
        ...(context !== undefined ? { context } : {}),
        actor,
      });
      const live = lookupMiss
        ? this.tasks.hasLiveLeadAttachment(workspaceId)
        : this.tasks.hasLiveAttachment(workspaceId);
      if (lookupMiss) {
        result = live
          ? {
              route: 'agent',
              ack: `${heard(transcript)} Nothing here matched — sent to the lead agent.`,
            }
          : {
              route: 'agent-queued',
              ack: `${heard(transcript)} Nothing here matched — lead agent away, queued for its next attach.`,
            };
      } else if (live) {
        result = {
          route: 'agent',
          ack: `${heard(transcript)} Sent to the workspace agent.${deferNote}${note}`,
        };
      } else {
        result = {
          route: 'agent-queued',
          ack: `${heard(transcript)} Agent away — queued for its next attach.${deferNote}${note}`,
        };
      }
    }

    // Every utterance is audited, whatever happened to it (§3.6). For the
    // 'agent' route the emit is the fast path to a listening agent — it rides
    // the workspace channel the attached agent's MCP watch formats — but it is
    // no longer the only record, so losing it costs latency rather than the
    // request. `queueId` travels with it: that is what the receiver
    // acknowledges, and an unacknowledged entry comes back.
    this.tasks.recordVoiceRequest(workspaceId, {
      transcript,
      route: result.route,
      ack: result.ack,
      ...(context !== undefined ? { context } : {}),
      ...(queueId !== false ? { queueId } : {}),
      actor,
    });
    if (queueId !== false && result.route === 'agent') {
      this.tasks.markVoiceEmitted(workspaceId, queueId);
    }
    return { ok: true, ...result };
  }

  /** Every task, doc and goal on the board with the words a person would
   *  say. */
  private titleIndex(workspaceId: string): TitleCandidate[] {
    const workspace = this.tasks.getWorkspace(workspaceId);
    const goals: TitleCandidate[] = (workspace?.goals ?? []).map((g) => ({
      id: g.id,
      kind: 'goal',
      title: g.title,
    }));
    const tasks: TitleCandidate[] = this.tasks
      .listTasks(workspaceId)
      .map((t) => ({ id: t.id, kind: 'task', title: t.title }));
    const docs: TitleCandidate[] = (workspace?.docIds ?? []).map((id) => ({
      id,
      kind: 'doc',
      title: this.docTitle?.(workspaceId, id) ?? id,
    }));
    return [...goals, ...tasks, ...docs];
  }

  /** Where a resolved candidate opens — the two paths `lookupResult` emits
   *  plus the goal panel (`?goal=`, the shape `goalShareUrl` builds in the
   *  client), all through the same same-origin assertion. */
  private navigationFor(workspaceId: string, c: TitleCandidate): string | undefined {
    const board = `/workspaces/${encodeURIComponent(workspaceId)}`;
    if (c.kind === 'task') return sameOriginPath(`${board}?task=${encodeURIComponent(c.id)}`);
    if (c.kind === 'goal') return sameOriginPath(`${board}?goal=${encodeURIComponent(c.id)}`);
    return sameOriginPath(`/review/${encodeURIComponent(c.id)}`);
  }

  /**
   * One of the hub's own places. The paths are `navPath` in the client
   * (`hub-presence-model.ts`) spelled out: Tasks is the bare board, the other three
   * are suffixes. The ack names the place the way the nav labels it.
   */
  private openHubDestination(
    workspaceId: string,
    transcript: string,
    nav: HubDestination,
  ): VoiceResult | undefined {
    const board = `/workspaces/${encodeURIComponent(workspaceId)}`;
    const navigate = sameOriginPath(nav === 'tasks' ? board : `${board}/${nav}`);
    if (!navigate) return undefined;
    const label = { home: 'Home', tasks: 'the board', mine: 'My tasks', activity: 'Activity' }[nav];
    return { route: 'fast-path', ack: `${heard(transcript)} Opening ${label}.`, navigate };
  }

  private openCandidate(
    workspaceId: string,
    transcript: string,
    c: TitleCandidate,
  ): VoiceResult | undefined {
    const navigate = this.navigationFor(workspaceId, c);
    if (!navigate) return undefined;
    const what = c.kind === 'goal' ? `goal "${c.title}"` : `"${c.title}"`;
    return { route: 'fast-path', ack: `${heard(transcript)} Opening ${what}.`, navigate };
  }

  /**
   * Two titles too close to call: ASK, and remember the pair for the next
   * thing this speaker says. Wrong-but-confident navigation is worse than a
   * question — the speaker lands somewhere, reads for a while, and only then
   * learns it was the wrong doc.
   */
  private askWhich(
    workspaceId: string,
    transcript: string,
    actor: VoiceActor,
    context: VoiceContext | undefined,
    matches: [ScoredCandidate, ScoredCandidate],
  ): VoiceResult {
    this.pendingChoices.set(`${workspaceId}\0${actor.id}`, {
      candidates: matches,
      at: this.now(),
      anchor: choiceAnchor(context),
    });
    return {
      route: 'fast-path',
      ack: `${heard(transcript)} Did you mean "${matches[0].title}" or "${matches[1].title}"? Say first or second, or part of the name.`,
    };
  }

  /**
   * The answer to a standing "which one?", if the utterance is one — by
   * ordinal ("the second one") or by name ("the billing one"). Any utterance
   * consumes the pending pair, so a stale question cannot catch a later,
   * unrelated "the first one"; a pair asked from a different surface, doc or
   * task than the speaker is on now is dropped unread, because "the second
   * one" said INSIDE a decision doc is that decision's second option.
   */
  private answerPendingChoice(
    workspaceId: string,
    transcript: string,
    actor: VoiceActor,
    context: VoiceContext | undefined,
  ): VoiceResult | undefined {
    const key = `${workspaceId}\0${actor.id}`;
    const pending = this.pendingChoices.get(key);
    if (!pending) return undefined;
    this.pendingChoices.delete(key);
    if (this.now() - pending.at > CHOICE_WINDOW_MS) return undefined;
    if (pending.anchor !== choiceAnchor(context)) return undefined;
    const ordinal = parseOrdinal(transcript, pending.candidates.length);
    const chosen =
      ordinal !== null
        ? pending.candidates[ordinal]
        : (() => {
            const byName = pickByLabel(
              transcript,
              pending.candidates.map((c) => ({ id: c.id, label: c.title })),
            );
            return byName ? pending.candidates.find((c) => c.id === byName.id) : undefined;
          })();
    return chosen ? this.openCandidate(workspaceId, transcript, chosen) : undefined;
  }

  /**
   * "brief status": ≤ `VOICE_STATUS_MAX_WORDS` words about the thing in view,
   * or the board when nothing is. Composed from the store; no model phrases
   * it, so the numbers in it are the board's numbers.
   */
  private statusResult(
    workspaceId: string,
    workspaceName: string,
    resource: VoiceResource | undefined,
  ): VoiceResult {
    const now = Date.now();
    const toStatus = (t: Task): StatusTask => {
      const last = t.transitions[t.transitions.length - 1];
      const done = [...t.transitions].reverse().find((tr) => tr.to === 'done');
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        assignee: t.assignee,
        ...(t.needs !== undefined ? { needs: t.needs } : {}),
        ...(done ? { doneAt: done.ts } : {}),
        ...(last
          ? { lastMove: { from: last.from, to: last.to, by: last.by.name, ts: last.ts } }
          : {}),
        links: t.links.length,
      };
    };
    const tasks = this.tasks.listTasks(workspaceId).map(toStatus);
    const queue = this.queue?.(workspaceId) ?? [];
    const task = resource?.kind === 'task' ? tasks.find((t) => t.id === resource.id) : undefined;
    const doc =
      resource?.kind === 'doc'
        ? {
            title: resource.title ?? resource.id,
            asks: resource.reviewItems.map((i) => ({
              title: resource.title ?? resource.id,
              ask: i.ask,
              askedBy: i.askedBy,
            })),
          }
        : undefined;
    return {
      route: 'fast-path',
      ack: composeStatus({
        workspaceName,
        tasks,
        queue,
        now,
        ...(task ? { task } : {}),
        ...(doc ? { doc } : {}),
      }),
    };
  }

  /**
   * A spoken pick or answer on the review item in view, resolved from the
   * speaker's words alone — no model. Returns the same classification shape
   * the model would, carrying a `pick`, so it passes through the SAME
   * guardrail (`resolveVoiceAction`) and the same executor — or, when the
   * words are plainly a pick but no item can take it, a direct ASK.
   *
   *  - "pick the second one" → the item's second option, by ordinal;
   *  - "choose keep placeholders" → the option whose label those words
   *    resolve to, across every item in view when the label is unique;
   *  - "answer: the second one" / "answer: keep placeholders" → the same,
   *    read from the words after the prefix: a pick said with the prefix is
   *    still a pick, not those four words posted verbatim;
   *  - "answer: yes but only for the auth task" → the words after the prefix.
   *
   * Which item: the one the speaker has open (context), else — on the doc
   * surface only — the only one. An ordinal or an answer with several items
   * and nothing open, or on a ticket that is highlighted rather than open,
   * is NOT guessed: the ack asks them to open the item.
   */
  private directPick(
    transcript: string,
    context: VoiceContext | undefined,
    resource: VoiceResource | undefined,
  ): { classification: VoiceClassification } | { direct: VoiceResult } | null {
    if (!resource || !context) return null;
    const items = resource.kind === 'doc' ? resource.reviewItems : (resource.reviewItems ?? []);
    if (items.length === 0) return null;
    const pinned = pickReviewItem(items, context);
    const action = (pick: VoicePick): { classification: VoiceClassification } => ({
      classification: { kind: 'action', action: 'answer-review', id: resource.id, pick },
    });
    const ask = (): { direct: VoiceResult } => ({
      direct: {
        route: 'fast-path',
        ack: `${heard(transcript)} Which review item? Open the one you mean and say that again.`,
      },
    });
    const optionOf = (item: VoiceReviewItem, words: string): VoiceReviewOption | undefined => {
      if (!item.options?.length) return undefined;
      const ordinal = parseOrdinal(words, item.options.length);
      return ordinal !== null
        ? item.options[ordinal]
        : (pickByLabel(words, item.options) ?? undefined);
    };
    const chosen = (item: VoiceReviewItem, option: VoiceReviewOption) =>
      action({ itemKey: reviewItemKey(item), optionId: option.id, optionLabel: option.label });

    const text = answerBody(transcript);
    if (text !== null) {
      if (!pinned) return ask();
      const option = optionOf(pinned, text);
      return option ? chosen(pinned, option) : action({ itemKey: reviewItemKey(pinned), text });
    }
    if (pinned) {
      const option = optionOf(pinned, transcript);
      if (option) return chosen(pinned, option);
    }
    // By label — across every item in view, and only when exactly one item
    // offers the label those words resolve to.
    const hits = items.flatMap((item) => {
      const option = item.options?.length ? pickByLabel(transcript, item.options) : null;
      return option ? [{ item, option }] : [];
    });
    const [hit, ...rest] = hits;
    if (hit && rest.length === 0 && (!pinned || pinned === hit.item))
      return chosen(hit.item, hit.option);
    // Plainly a pick — an ordinal some item could take, or a label several
    // offer — with nowhere to land. Ask; never guess.
    const ordinalSomewhere = items.some(
      (item) => !!item.options?.length && parseOrdinal(transcript, item.options.length) !== null,
    );
    if (!pinned && (ordinalSomewhere || hits.length > 1)) return ask();
    return null;
  }

  /**
   * Validate the model's named target against the store — never navigate on
   * an id the model may have invented. `undefined` is a miss: no target named,
   * or one the store does not hold on this board. The caller hands a miss to
   * the lead agent; this function no longer composes a "nothing matched" ack,
   * because that ack was the dead end.
   */
  private lookupResult(
    workspaceId: string,
    transcript: string,
    c: { target?: 'task' | 'doc'; id?: string },
  ): VoiceResult | undefined {
    if (c.target === 'task' && c.id) {
      const task = this.taskInWorkspace(workspaceId, c.id);
      // Every navigation leaves through `sameOriginPath`, this one included:
      // one assertion covering all three, rather than one that covers only
      // the path added last.
      const navigate = task
        ? sameOriginPath(
            `/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(task.id)}`,
          )
        : undefined;
      if (task && navigate) {
        return {
          route: 'fast-path',
          ack: `${heard(transcript)} Lookup — opening task "${task.title}".`,
          navigate,
        };
      }
    }
    if (c.target === 'doc' && c.id) {
      const navigate = this.docInWorkspace(workspaceId, c.id)
        ? sameOriginPath(`/review/${encodeURIComponent(c.id)}`)
        : undefined;
      if (navigate) {
        return {
          route: 'fast-path',
          ack: `${heard(transcript)} Lookup — opening ${c.id}.`,
          navigate,
        };
      }
    }
    return undefined;
  }
}

/**
 * The real Haiku completer, or null when the operator hasn't opted in.
 *
 * Consent is the SAME dedicated keychain entry the summarizer uses
 * (`claude-workspaces-summary-api-key` / CW_SUMMARY_API_KEY): adding
 * it is the act of consenting to LF→api.anthropic.com traffic, and voice
 * transcripts are the speaker's own words sent by their own explicit action.
 * A generic ANTHROPIC_API_KEY in the environment is deliberately not
 * honoured (see summarize.ts for the incident that rule comes from).
 */
export function haikuVoiceComplete(opts?: {
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  readKey?: (service: string) => string | null;
}): VoiceComplete | null {
  // Same two-name resolution as the summarizer: a machine set up before the
  // rename holds only the legacy entry, and reading just the new name left
  // the fast path silently off while summaries kept working.
  const key = resolveKeyFrom(opts?.apiKey, opts?.readKey ?? readKeychainPassword);
  if (!key) return null;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const resolvedKey = key;
  return async ({ system, user }) => {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': resolvedKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      return body.content?.map((b) => b.text ?? '').join('') ?? '';
    } finally {
      clearTimeout(timeout);
    }
  };
}
