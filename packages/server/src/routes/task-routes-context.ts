import type { DocMeta, TaskReviewItem, User } from '@feedback/core';
import type { AgentNoteRing } from '../agent-notes.ts';
import type { DispatchRegistry } from '../dispatch-registry.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import type { ReadyWorkNudger } from '../ready-nudge.ts';
import type { Rooms } from '../rooms.ts';
import type { TaskProjection } from '../task-projection.ts';
import type { ParallelismCapChange, Task, TaskStore } from '../tasks.ts';

/**
 * The review-item quality gate's verdict on one item — held, or through.
 *
 * It lives here rather than in the server closure because both sides of the
 * split need it: `createServer` runs the judge and the routes report what it
 * said. The comment-borne variant (`ThreadReviewGate`) stays in server.ts,
 * and `heldFields` below is deliberately typed to the narrower of the two so
 * a route cannot come to depend on the wider one.
 */
export type ReviewGate =
  | { held: false; item: TaskReviewItem }
  | { held: true; item: TaskReviewItem; reason: string; message: string };

/** The parallelism cap as a route reads it — the number, who is holding it,
 *  and who last moved it. `undefined` for a workspace that has none. */
export interface ParallelismCapView {
  cap: number;
  isDefault: boolean;
  default: number;
  inUse: number;
  free: number;
  holders: Array<{ taskId: string; title?: string; agentName?: string }>;
  lastChange?: ParallelismCapChange;
}

/** The long-lived collaborators, built once per server. */
export interface TaskRoutesContext {
  /** The hub task store — workspaces, tasks, review items, the gate. */
  taskStore: TaskStore;
  /** The ydoc projection of the store; refreshed by hand after the writes
   *  that emit no store event (links, goal placement, archive-in-place). */
  taskProjection: TaskProjection;
  /** Doc rooms — read for a batch's source doc and written when an ask-back
   *  turns a question into a thread. */
  rooms: Rooms;
  /** Open builder dispatches and their worktree watchers. */
  dispatches: DispatchRegistry;
  /** The per-agent ring of turn / denial / status notes. */
  agentNotes: AgentNoteRing;
  /** Wakes the lead when a row it owns becomes ready. */
  readyNudger: ReadyWorkNudger;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** Attribution for a write that arrived with no author at all. */
  ANONYMOUS_ACTOR: User;

  /** Parse a revise route's optional `revisedRange`. */
  parseRevisedRange: (
    raw: unknown,
  ) => { ok: true; range?: { start: number; end: number } } | { ok: false; error: string };
  /** Tell the addressee a review item is waiting on them. */
  announceTaskReview: (task: Task, item: TaskReviewItem, author: User) => void;
  /** Turn a question typed where an answer goes into a thread on the item. */
  askBackOnItem: (
    task: Task,
    item: TaskReviewItem,
    text: string,
    author: User,
    visitor: boolean,
  ) => Promise<Response>;
  /** doc id → the hub boards holding it, built once per request that needs it. */
  boardIndexForListing: () => Map<string, string[]>;
  /**
   * Every workspace an id belongs to — `shareWorkspacesOf`, the same resolver
   * the host guard scopes paths with.
   *
   * Here it answers the question the guard cannot: a cross-reference names
   * its target in the BODY, so no path check ever saw it. See
   * `share/ref-scope.ts`.
   */
  workspacesOfDoc: (id: string) => string[];
  /** The response fields a filing route adds when the gate held the item. */
  heldFields: (gate: ReviewGate | undefined) => Record<string, unknown>;
  /** "alice on \"Ship the thing\", bob on t-2" — the cap refusal's sentence. */
  holdersClause: (
    holders: ReadonlyArray<{ taskId: string; title?: string; agentName?: string }>,
  ) => string;
  /** Which hub boards hold a doc, answered off a prebuilt index. */
  hubBoardsForDocIndexed: (index: Map<string, string[]>, meta: DocMeta) => Set<string>;
  /** Put a filed or revised review item through the quality gate. */
  judgeReviewItem: (
    task: Task,
    item: TaskReviewItem,
    author: { id: string; name: string; kind?: string },
  ) => Promise<ReviewGate>;
  /** The same gate for a ticket that IS a decision; `undefined` when the
   *  ticket is not one, so a caller cannot report a judgement never made. */
  judgeTaskDecision: (
    task: Task,
    author: { id: string; name: string; kind?: string },
  ) => Promise<ReviewGate | undefined>;
  /** One hold out of a filed item's and the ticket decision's. */
  mergedHold: (
    filed: ReviewGate | undefined,
    decision: ReviewGate | undefined,
  ) => ReviewGate | undefined;
  /** How many builders the board may run, and who is holding the slots. */
  parallelismCapView: (
    workspaceId: string,
    excludeTaskId?: string,
  ) => ParallelismCapView | undefined;
  /** File an allow-rule proposal off a denial note. */
  proposeAllowRule: (
    task: Task,
    note: { kind: string; text: string; agent: string; at: number },
  ) => void;
  /** Re-judge a ticket's own decision after its words moved. */
  regateDecisionWords: (taskId: string, author: User) => Promise<void>;
  /** Replace a task's body markdown through the body doc. */
  rewriteTaskBody: (
    task: Task,
    markdown: string,
    opts: {
      actor?: { id: string; name: string; kind?: string };
      title?: string;
      reason?: string;
    },
  ) => { ok: true } | { ok: false; error: string };
}

/** What only this request knows. */
export interface TaskRouteRequest {
  req: Request;
  pathname: string;
  url: URL;
  /** The share target this request resolved to, or null for a member. Every
   *  route that refuses share visitors reads this and nothing else. */
  visitor: ShareTarget | null;
  /** The author this request is allowed to claim, from its body's `author`
   *  plus whatever the session, widget token or roster proves. */
  authorFor: (claimed: unknown) => User | undefined;
  /** The 400 for an author that names a category rather than a person. */
  refuseCategoryAuthor: () => Response;
}
