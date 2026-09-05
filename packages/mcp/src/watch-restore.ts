/**
 * Ask the server what this identity was watching, re-wire it, and re-ATTACH.
 *
 * WHY IT EXISTS. `watchers` is a Map in this process, and this process is the
 * MCP child Claude Code spawns per session — it dies with the session, so a
 * respawn came back with an empty set and `list_watched_docs` answering `[]`,
 * which is exactly what a session that never subscribed answers. Measured
 * 2026-08-18 by two peers: 62 and 6 subscriptions, silently gone.
 *
 * Re-subscribing alone is not enough. The attachment record hydrates with the
 * heartbeat from before the restart and reads `away` the moment the session
 * comes back, and every lead-addressed delivery asks for a LIVE attachment —
 * so a respawned lead was subscribed and still invisible. The re-attach here
 * is what closes that, and the backlog the server drains into the attach
 * response is forwarded rather than swallowed by its own arrival.
 *
 * Lifted out of `mcp.ts` unchanged. Everything is an argument: the HTTP
 * client, the registry, the deferred emitter, the notification sink and the
 * clock — so the whole restore, including its backoff, is drivable.
 */
import { type BacklogCommentRow, deliverAttachBacklog } from './attach-backlog.ts';
import { reconnectDelayMs } from './backoff.ts';
import type { ChannelNotification } from './channel-messages.ts';
import type { DeferredEmitter } from './deferred-emit.ts';
import type { Watcher } from './sse-loop.ts';
import {
  type RestoreState,
  boardsToReattach,
  parseCoverage,
  restoreNoticeContent,
} from './watch-coverage.ts';
import type { WatchRegistry } from './watch-registry.ts';

export interface WatchRestoreDeps {
  /** The REST call to the feedback server; throws on a non-2xx. */
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** The registry this restore re-wires; it owns the local subscriptions and
   *  the coverage read. */
  registry: WatchRegistry;
  /** The live watcher map, read to skip keys already wired this run. */
  watchers: ReadonlyMap<string, Watcher>;
  author: { id: string; name: string };
  /** Reported on every attach so the board can say which sessions are behind. */
  pluginVersion: string;
  /** One nonce per process, so the server can tell a fresh attach from a
   *  re-attach by the same live child. */
  processId: string;
  /** Record that this session's attachment on a board is fresh. */
  markAttached: (workspaceId: string) => void;
  /** Where a channel line goes — `server.notification` in the real process. */
  notify: (n: ChannelNotification) => Promise<void>;
  /** The doc/board renderer, for the backlog the attach response drains. */
  emitChannelMessage: (event: string, payload: unknown) => Promise<void>;
  /** The process-wide dedup; a backlog row may also be arriving on a stream. */
  shouldForward: (event: string, payload: unknown) => boolean;
  /** Holds these emits until no tool call is in flight — the restore runs
   *  inside the first call's await, which is the one window a session does
   *  not read. See deferred-emit.ts. */
  deferredEmits: DeferredEmitter;
  /** Whether every peer collapsed into one shared identity, in which case
   *  there is no set to restore. */
  identityIsShared: boolean;
  /** Injectable so the backoff and the notice timestamp are assertable. */
  now?: () => number;
  /** Injectable so the retry backoff's jitter draw is assertable. */
  random?: () => number;
}

/** Everything one restore run carries between calls. */
interface RestoreRuntime {
  state: RestoreState;
  inFlight: Promise<void> | null;
  /** After a failed restore, don't hammer a down server from every tool call
   *  — back off (capped at 30s), then try again on the next call after that. */
  retryAt: number;
}

export interface WatchRestore {
  /** Single flight. Never throws: a failure leaves the state `failed` and the
   *  next call retries once the backoff has lapsed. */
  ensureWatchesRestored(): Promise<void>;
  /** The state as of now — what `list_watched_docs` reports. */
  state(): RestoreState;
}

function now(deps: WatchRestoreDeps): number {
  return (deps.now ?? Date.now)();
}

/** Bind the restore to one process's dependencies. */
export function createWatchRestore(deps: WatchRestoreDeps): WatchRestore {
  const rt: RestoreRuntime = {
    state: deps.identityIsShared
      ? { status: 'session-only', from: 'session', restored: [], pruned: [], attempts: 0 }
      : { status: 'pending', from: 'session', restored: [], pruned: [], attempts: 0 },
    inFlight: null,
    retryAt: 0,
  };
  return {
    ensureWatchesRestored: () => ensureWatchesRestored(deps, rt),
    state: () => rt.state,
  };
}

/**
 * Ask the server what this identity was watching and re-wire it. Single
 * flight; a failure leaves `rt.state.status = 'failed'` and the next call
 * tries again. Once `restored`, further calls are no-ops — the server set
 * only changes through this process's own watch/unwatch from then on (or
 * through a sibling session with the same name, whose additions reach this
 * process at ITS next respawn, not live).
 */
async function ensureWatchesRestored(deps: WatchRestoreDeps, rt: RestoreRuntime): Promise<void> {
  if (rt.state.status === 'restored' || rt.state.status === 'session-only') return;
  if (rt.inFlight) return rt.inFlight;
  if (rt.state.status === 'failed' && now(deps) < rt.retryAt) return;
  rt.inFlight = (async () => {
    const attempts = rt.state.attempts + 1;
    try {
      const res = (await deps.http('GET', deps.registry.watchesPath())) as {
        watches?: Array<{ key: string }>;
        pruned?: string[];
      };
      deps.registry.setCoverage(parseCoverage(res));
      const keys = (res.watches ?? []).map((w) => w.key);
      const restored: string[] = [];
      for (const key of keys) {
        if (deps.watchers.has(key)) continue;
        if (key.startsWith('ws:'))
          await deps.registry.watchWorkspace(key.slice('ws:'.length), false);
        else await deps.registry.watchDoc(key, false);
        restored.push(key);
      }
      // Re-ATTACH, not just re-subscribe. Restoring the keys puts the events
      // back on the wire; it does nothing about the attachment record, which
      // hydrates with the heartbeat from before the restart and is therefore
      // `away` the moment the session comes back. Every lead-addressed
      // delivery — voice notes above all — asks for a LIVE attachment, so
      // without this a respawned lead is
      // subscribed and still invisible, which is the original incident with
      // extra steps. Only boards it already led or was already attached to;
      // see boardsToReattach.
      const reattached: string[] = [];
      for (const workspaceId of boardsToReattach(deps.registry.coverage())) {
        try {
          const attachRes = (await deps.http(
            'POST',
            `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`,
            {
              agentId: deps.author.id,
              agentName: deps.author.name,
              runtime: 'claude-code-local',
              pluginVersion: deps.pluginVersion,
              processId: deps.processId,
            },
          )) as {
            queuedComments?: BacklogCommentRow[];
            queuedVoice?: Array<{ transcript?: unknown }>;
          };
          deps.markAttached(workspaceId);
          reattached.push(workspaceId);
          // This POST is the fourth attach site, and the only one whose
          // response body no tool call reads — yet the server just drained
          // the backlog into it (voice destructively; comment rows marked
          // emitted). Dropping it here is the ticket's own failure mode one
          // layer down: the respawned session the queue waited for arrives,
          // and the arrival itself eats the delivery. So forward each row as
          // the channel notification its SSE frame would have been, acking a
          // comment row only after its emit succeeded — same order, same
          // reason as handleFrame.
          //
          // Deferred as ONE unit rather than emit-by-emit: the restore runs
          // inside the first tool call's await (see deferredEmits), and these
          // frames go unread there exactly like the notice below did. Keeping
          // the whole delivery together preserves emit-then-ack — a receipt
          // must still follow the frame it acknowledges, not precede it.
          deps.deferredEmits.emitOutsideToolCall(() =>
            deliverAttachBacklog(workspaceId, attachRes, {
              emit: async (ev, payload) => {
                if (deps.shouldForward(ev, payload)) {
                  await deps.emitChannelMessage(ev, payload);
                }
              },
              ackComment: async (rowId) => {
                await deps.http(
                  'POST',
                  `/api/workspaces/${encodeURIComponent(workspaceId)}/comment-queue/${encodeURIComponent(rowId)}/ack`,
                  {},
                );
              },
            }),
          );
        } catch {
          // Best effort, exactly like the watch restore: the notice below
          // reads the coverage AFTER this, so a failure shows up as a board
          // still waiting rather than as a silent claim of success.
        }
      }
      // Re-read, so the notice describes the state the session is actually
      // in rather than the one it woke up in — otherwise a successful
      // re-attach still prints an alarm about itself.
      if (reattached.length > 0) await deps.registry.refreshCoverage();
      const state: RestoreState = {
        status: 'restored',
        from: 'server',
        restored,
        reattached,
        pruned: res.pruned ?? [],
        at: new Date(now(deps)).toISOString(),
        attempts,
      };
      rt.state = state;
      // Unconditional now — `emitRestoreNotice` decides whether there is
      // anything to say. It speaks on an EMPTY restore when a board is
      // waiting on this session, which is the incident's own shape: the
      // watches were wired by hand this run, so there was nothing to restore
      // and nothing was said, while four items sat queued for a seat nobody
      // held.
      //
      // Deferred, not awaited. This promise is what the first tool call awaits
      // at the top of the CallTool handler, so emitting here wrote the notice
      // into the window between that request and its response — measured
      // 2026-08-20 as a respawn that read `restored` in a tool RESULT and
      // never saw the frame. See deferred-emit.ts.
      deps.deferredEmits.emitOutsideToolCall(() => emitRestoreNotice(deps, state));
    } catch (err) {
      rt.state = {
        ...rt.state,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        attempts,
      };
      // Jittered, not just capped. Restore-on-attach is the one call every
      // session makes at the same moment after a server restart, so an
      // unjittered retry schedule reconverges the whole fleet on one instant
      // — the herd that turned a single restart into twenty. See backoff.ts.
      // `attempts + 1` keeps the ceiling this line has always had — the old
      // schedule was `1_000 * 2 ** attempts`, and `reconnectWindowMs` counts
      // from the base at attempt 1. Only the draw inside the window is new.
      rt.retryAt = now(deps) + reconnectDelayMs(attempts + 1, deps.random, 1_000, 30_000);
    } finally {
      rt.inFlight = null;
    }
  })();
  return rt.inFlight;
}

/**
 * One line into the session saying the feedback loop came back intact — and
 * naming any board that is waiting on this session but has no attachment from
 * it. Silent when there is nothing of either kind to report.
 *
 * The second half is the one that matters: an agent that does not know the
 * gap exists never runs the probe that would show it, so the report has to
 * arrive unprompted or it may as well not exist.
 */
async function emitRestoreNotice(deps: WatchRestoreDeps, state: RestoreState): Promise<void> {
  const content = restoreNoticeContent({
    restored: state.restored,
    reattached: state.reattached ?? [],
    pruned: state.pruned,
    agentName: deps.author.name,
    coverage: deps.registry.coverage(),
  });
  if (content === null) return;
  await deps.notify({
    method: 'notifications/claude/channel',
    params: {
      source: 'claude-workspaces',
      sent_at: state.at ?? new Date(now(deps)).toISOString(),
      content,
      meta: {
        event: 'watches.restored',
        restored: state.restored,
        pruned: state.pruned,
        ...(deps.registry.coverage()
          ? { unattachedBoards: deps.registry.coverage()?.unattachedBoards }
          : {}),
      },
    },
  });
}
