/**
 * This session's attachments: proving them live, and reading who else is on a
 * row before it claims one.
 *
 * WHY IT EXISTS. Attaching is not a state, it is a claim that lapses unless
 * the server keeps SEEING this session, and every lead-addressed delivery is
 * gated on that. An agent editing files, thinking, or working a different
 * board is invisible here however busy it is — so the heartbeat rides real
 * tool calls, which is the honest signal that this agent is alive AND
 * working. The decision half (which boards are due) is
 * `attachment-keepalive.ts`; this is the sending half, which is what could
 * not be driven while it lived in `mcp.ts`.
 *
 * Neither call here ever throws. A keepalive that could fail a tool call
 * would be worse than the staleness it prevents, and a claim warning that
 * could fail a claim would be worse than the collision it prevents.
 */
import type { AttachmentKeepalive } from './attachment-keepalive.ts';
import { type PresenceRow, claimWarning } from './claim-warning.ts';

export interface AttachmentDeps {
  /** The REST call to the feedback server; throws on a non-2xx. */
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** This session's identity, as the attachment records it. */
  author: { id: string };
  /** Which boards are attached, and which are due a heartbeat. */
  keepalive: AttachmentKeepalive;
  /** Injectable so the stamps a test reads are its own. */
  now?: () => number;
}

export interface Attachments {
  markAttached(workspaceId: string): void;
  sendDueHeartbeats(): Promise<void>;
  claimNoticeFor(taskId: string): Promise<string | undefined>;
}

function now(deps: AttachmentDeps): number {
  return (deps.now ?? Date.now)();
}

/** Bind the attachment calls to one process's dependencies. */
export function createAttachments(deps: AttachmentDeps): Attachments {
  return {
    markAttached: (workspaceId) => markAttached(deps, workspaceId),
    sendDueHeartbeats: () => sendDueHeartbeats(deps),
    claimNoticeFor: (taskId) => claimNoticeFor(deps, taskId),
  };
}

/**
 * Which boards this session is attached to, and when it last proved it.
 *
 * An attachment is a claim that expires unless the server keeps observing
 * this session, not a state — see attachment-keepalive.ts. Marked wherever
 * this process attaches
 * (`attach_agent`, declaring itself lead, the re-attach on restore) and
 * refreshed off real tool calls.
 */

/** Record an attachment this session just made. */
function markAttached(deps: AttachmentDeps, workspaceId: string): void {
  deps.keepalive.mark(workspaceId);
}

/** Prove liveness on any board whose heartbeat is due. Never throws: a
 *  keepalive that could fail a tool call would be worse than the staleness it
 *  prevents. */
async function sendDueHeartbeats(deps: AttachmentDeps): Promise<void> {
  for (const workspaceId of deps.keepalive.due()) {
    try {
      await deps.http(
        'POST',
        `/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(deps.author.id)}/heartbeat`,
        { toolCallAt: now(deps) },
      );
    } catch {
      // The board will read this session as away, and `coverage` reports
      // exactly that — which is the honest outcome of a server we cannot
      // reach, and better than pretending here.
    }
  }
}
/**
 * The presence line a pickup carries, or undefined when the row is free.
 *
 * READ FROM THE QUEUE, because the queue route is the only one that carries
 * both halves — `ownerSession` (the session behind the OWNER) and `claimedBy`
 * (the session that last moved the row into in-progress, which is the only
 * one that exists on a row nobody assigned). `/api/tasks/:id` does not exist
 * and this deliberately does not add it: the read already ships on a route
 * every attached session can already call.
 *
 * The workspace comes from the boards this session holds an attachment on —
 * `task_transition` takes a task id and nothing else, and requiring a
 * workspace argument would change the tool's shape for every caller to serve
 * an advisory. Usually one board, and the loop stops at the first row that
 * matches.
 *
 * NEVER THROWS. Every failure here — unreachable server, an older server that
 * returns rows without presence, a board this session never attached to —
 * produces silence, which is the same answer as "nobody is on it". That is a
 * miss, not a lie, and a warning that could fail a claim would be worse than
 * the collision it prevents.
 */
async function claimNoticeFor(deps: AttachmentDeps, taskId: string): Promise<string | undefined> {
  for (const workspaceId of deps.keepalive.boards()) {
    try {
      const res = (await deps.http(
        'GET',
        // includeBlocked so a row held by a dependency is still findable —
        // its being blocked says nothing about whether somebody is on it.
        `/api/workspaces/${encodeURIComponent(workspaceId)}/next?includeBlocked=true`,
      )) as { tasks?: PresenceRow[] };
      const row = res.tasks?.find((t) => t?.id === taskId);
      if (row) return claimWarning(row, deps.author.id, now(deps));
    } catch {
      // Next board, then silence. See the contract above.
    }
  }
  return undefined;
}
