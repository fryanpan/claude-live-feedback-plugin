import type { DocType, User } from '@feedback/core';
import type { AgentWatches } from '../agent-watches.ts';
import type { DocStore } from '../doc-store.ts';
import type { HomeBriefStore } from '../home-brief.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import type { WorkspaceScope } from '../middleware/workspace-scope.ts';
import type { ReviewItemRow } from '../review-queue.ts';
import type { SseBus } from '../sse.ts';
import type { TaskProjection } from '../task-projection.ts';
import type { BoardWorkspace, TaskStore } from '../tasks.ts';
import type { VoiceRouter } from '../voice.ts';
import type { ParallelismCapView } from './task-routes-context.ts';

/**
 * What the workspace routes read instead of `createServer`'s closure.
 *
 * The split follows the one the task routes already use: everything here is
 * built once per server, and what only a request knows travels beside it in
 * `WorkspaceRouteRequest`. The difference from `TaskRoutesContext` is that a
 * board is where docs, agents and the client release meet, so this side
 * carries the doc store and the release directory the task side never needed.
 */
export interface WorkspaceRoutesContext {
  /** The board store — boards, their goals, their tasks and their agents. */
  taskStore: TaskStore;
  /** The ydoc projection of the store, refreshed by hand after the writes
   *  that emit no store event (attach, unfile, archive-in-place). */
  taskProjection: TaskProjection;
  /** Doc store — a board's attached docs, its huddles and its diff reviews. */
  docStore: DocStore;
  /** The server-sent-event bus a voice frame is pushed down. */
  sse: SseBus;
  /** Per-person Home briefs and the read markers under them. */
  homeBriefs: HomeBriefStore;
  /** What each agent has asked to be told about. */
  agentWatches: AgentWatches;
  /** Where a spoken request is routed and how its answer comes back. */
  voiceRouter: VoiceRouter;

  /** The data dir — load reports, the event log and huddle files hang off it. */
  dataDir: string;
  /** The published client's root, or null when this server publishes none.
   *  Only the attachments read touches it, to say which release is live. */
  clientReleaseRootDir: string | null;

  /**
   * The two `ServerOptions` fields the routes below read, and no more.
   *
   * Structural on purpose: naming `ServerOptions` here would make routes/
   * import a type out of server.ts, which imports routes/ back. The fields
   * are copied rather than the object narrowed, so adding one is a decision
   * someone makes here.
   */
  opts: { premiseStaleAfterMs?: number; uptimeTickMs?: number };

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** Whether a string is shaped like a doc id at all. */
  isValidDocId: (s: string) => boolean;

  /** This server's externally reachable origin, as links are minted from. */
  externalBaseUrl: () => string;
  /** Decorate a doc's meta with the URL a person opens it at. */
  withReviewUrl: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
    precomputedHome?: string | null,
  ) => T & { reviewUrl?: string };
  /** One person's Home read: their brief, their queue and its coverage.
   *  Typed loosely because the routes only ever hand it straight to `j`. */
  homePayload: (workspace: BoardWorkspace, person: string, now: number) => unknown;
  /** The review items on a board, in the order Home shows them. */
  reviewItemsFor: (workspace: BoardWorkspace) => ReviewItemRow[];
  /** How many builders the board may run, and who is holding the slots. */
  parallelismCapView: (
    workspaceId: string,
    excludeTaskId?: string,
  ) => ParallelismCapView | undefined;
  /** The board a doc belongs to, or null when none holds it. */
  resolveWorkspaceForDoc: (docId: string) => string | null;
  /** File a doc under a board — the requested one, else the default — and
   *  answer which board it landed on. */
  fileUnderBoardWorkspace: (attachmentId: string, requested?: string) => string;
  /** Take a doc back off the default holding board once a real one has it. */
  unfileFromDefault: (attachmentId: string, keptBoardWorkspaceId: string) => void;
  /**
   * EVERY workspace an id belongs to, most specific first — the same resolver
   * the host guard's share scoping reads (`shareWorkspacesOf`).
   *
   * It is here so a route asking "may this member reach this doc?" asks the
   * question the GUARD would ask, rather than a second rule of its own. Two
   * rules that agree today drift apart later, and the one that drifts open is
   * a breach.
   */
  workspacesOfDoc: (docId: string) => string[];
  /** Whether a watch key still names something on this server. */
  watchKeyExists: (key: string) => boolean;
}

/** What only this request knows. */
export interface WorkspaceRouteRequest {
  /**
   * The board this canonical path named, and the remainder under it —
   * resolved once by `middleware/workspace-scope.ts`, which has already
   * refused an unknown board and a member filed on a different one.
   *
   * `undefined` when the path is not under `/workspaces/<id>/…` at all, and
   * that is what makes the resolution structural rather than remembered: a
   * resource route matches through `matchRest`, so with no scope it has no
   * remainder to match and cannot answer. Read `scope.workspaceId` for the
   * board rather than a body field — the path is the argument now.
   */
  scope?: WorkspaceScope<BoardWorkspace>;

  req: Request;
  pathname: string;
  url: URL;
  /** The share target this request resolved to, or null for a member. Every
   *  route that refuses share visitors reads this and nothing else. */
  visitor: ShareTarget | null;
  /** The author this request is allowed to claim, from its body's `author`
   *  plus whatever the session, widget token or roster proves. */
  authorFor: (claimed: unknown) => User | undefined;
}

/**
 * The board delete's request. Nothing extra any more.
 *
 * It used to carry `deleteReview`, because the one DELETE fronted two stores
 * and needed the review destroy to fall through to. The canonical shape
 * addresses a review under the board that holds it, so that fall-through is
 * gone and so is the field — the alias stays as the name the chain calls.
 */
export type WorkspaceDeleteRequest = WorkspaceRouteRequest;
