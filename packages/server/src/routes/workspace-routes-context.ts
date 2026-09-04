import type { DocType, User } from '@feedback/core';
import type { AgentWatches } from '../agent-watches.ts';
import type { HomeBriefStore } from '../home-brief.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import type { ReviewItemRow } from '../review-queue.ts';
import type { Rooms } from '../rooms.ts';
import type { SseHub } from '../sse.ts';
import type { TaskProjection } from '../task-projection.ts';
import type { HubWorkspace, TaskStore } from '../tasks.ts';
import type { VoiceRouter } from '../voice.ts';
import type { ParallelismCapView } from './task-routes-context.ts';

/**
 * What the workspace routes read instead of `createServer`'s closure.
 *
 * The split follows the one the task routes already use: everything here is
 * built once per server, and what only a request knows travels beside it in
 * `WorkspaceRouteRequest`. The difference from `TaskRoutesContext` is that a
 * board is where docs, agents and the client release meet, so this side
 * carries the doc rooms and the release directory the task side never needed.
 */
export interface WorkspaceRoutesContext {
  /** The hub store — boards, their goals, their tasks and their agents. */
  taskStore: TaskStore;
  /** The ydoc projection of the store, refreshed by hand after the writes
   *  that emit no store event (attach, unfile, archive-in-place). */
  taskProjection: TaskProjection;
  /** Doc rooms — a board's attached docs, its huddles and its diff reviews. */
  rooms: Rooms;
  /** The server-sent-event hub a voice frame is pushed down. */
  sse: SseHub;
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
  homePayload: (workspace: HubWorkspace, person: string, now: number) => unknown;
  /** The review items on a board, in the order Home shows them. */
  reviewItemsFor: (workspace: HubWorkspace) => ReviewItemRow[];
  /** How many builders the board may run, and who is holding the slots. */
  parallelismCapView: (
    workspaceId: string,
    excludeTaskId?: string,
  ) => ParallelismCapView | undefined;
  /** The board a doc belongs to, or null when none holds it. */
  resolveWorkspaceForDoc: (docId: string) => string | null;
  /** File a doc under a board — the requested one, else the default — and
   *  answer which board it landed on. */
  fileUnderHubWorkspace: (attachmentId: string, requested?: string) => string;
  /** Take a doc back off the default holding board once a real one has it. */
  unfileFromDefault: (attachmentId: string, keptHubWorkspaceId: string) => void;
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
 * The delete route's extra collaborator.
 *
 * `deleteReview` is built inside the request closure, further down the chain
 * than the context above is assembled, and `DELETE /api/reviews/:id` — which
 * is not a workspace route — still calls it there. So it travels with the
 * request rather than being hoisted or copied.
 */
export interface WorkspaceDeleteRequest extends WorkspaceRouteRequest {
  deleteReview: (setId: string, force: boolean, purge: boolean) => Response;
}
