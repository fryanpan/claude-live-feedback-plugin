/**
 * The watch registry: which keys this session is subscribed to, and mirroring
 * that set onto the server so a respawn can ask for it back.
 *
 * Lifted out of `mcp.ts` unchanged. Everything it touches is an argument —
 * the HTTP client, this session's identity, the SSE loop starter, the shared
 * watcher map — so a test can watch a doc, unwatch it, and read the requests
 * that went out without a socket or a server.
 *
 * Two failures are reported APART here and that is deliberate: a stream that
 * did not open loses events now, a watch that did not persist loses them at
 * the next respawn. Collapsing them into one boolean is how a caller ends up
 * reassured about the half that worked.
 */
import type { Watcher } from './sse-loop.ts';
import { type WatchCoverage, parseCoverage } from './watch-coverage.ts';

export interface WatchRegistryDeps {
  /** The live watcher registry, shared with the SSE loops. */
  watchers: Map<string, Watcher>;
  /** The REST call to the feedback server; throws on a non-2xx. */
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** This session's identity — the key the server files the watch set under. */
  author: { id: string; name: string };
  /** Opens one stream and answers whether it is actually connected. */
  startSseLoop: (label: string, path: string, controller: AbortController) => Promise<boolean>;
  /** Whether every peer collapsed into one shared identity, in which case
   *  nothing is persisted at all. */
  identityIsShared: boolean;
  log: (...args: unknown[]) => void;
}

/** Everything the registry remembers between calls. */
interface RegistryState {
  /** The server's last answer to "what am I MISSING?", or undefined for
   *  "not known". */
  coverage: WatchCoverage | undefined;
  lastPersistError: string | undefined;
}

export interface WatchRegistry {
  watchDoc(docId: string, persist?: boolean): Promise<boolean>;
  watchWorkspace(
    workspaceId: string,
    persist?: boolean,
  ): Promise<{ open: boolean; persisted: boolean }>;
  unwatchDoc(docId: string): Promise<boolean>;
  refreshCoverage(): Promise<WatchCoverage | undefined>;
  /** The last coverage read, without asking the server again. */
  coverage(): WatchCoverage | undefined;
  /** Record a coverage read made elsewhere — the restore path reads it out of
   *  the same response it gets the watch set from. */
  setCoverage(next: WatchCoverage | undefined): void;
  watchPersistenceMode(): 'server' | 'session-only';
  lastPersistError(): string | undefined;
  /** The route the set lives at, shared with the restore path. */
  watchesPath(): string;
}

/** The route this identity's watch set lives at. */
function watchesPath(deps: WatchRegistryDeps): string {
  return `/api/agents/${encodeURIComponent(deps.author.id)}/watches`;
}

/** Bind the registry to one process's dependencies. */
export function createWatchRegistry(deps: WatchRegistryDeps): WatchRegistry {
  const state: RegistryState = { coverage: undefined, lastPersistError: undefined };
  return {
    watchDoc: (docId, persist) => watchDoc(deps, state, docId, persist),
    watchWorkspace: (workspaceId, persist) => watchWorkspace(deps, state, workspaceId, persist),
    unwatchDoc: (docId) => unwatchDoc(deps, state, docId),
    refreshCoverage: () => refreshCoverage(deps, state),
    coverage: () => state.coverage,
    setCoverage: (next) => {
      state.coverage = next;
    },
    watchPersistenceMode: () => watchPersistenceMode(deps),
    lastPersistError: () => state.lastPersistError,
    watchesPath: () => watchesPath(deps),
  };
}

// ---------------------------------------------------------------------------
// Durable watches. Everything above this line is SESSION-SCOPED: `watchers`
// is a Map in this process, and this process is the MCP child Claude Code
// spawns per session — it dies with the session, so a respawn (a token
// switch, a /clear, a crash) came back with `watchers` empty and
// `list_watched_docs` answering `[]`, which is exactly what a session that
// never subscribed answers. Measured 2026-08-18 by two peers: 62 and 6
// subscriptions, silently gone.
//
// The server keeps the SET under this agent's identity (AUTHOR.id — the same
// id every other call carries; `/api/agents/<id>/watches`). This process
// mirrors every watch/unwatch there and, once the client has initialized,
// asks for the set back and re-wires it. Persistence is best-effort and never
// fails a tool call: the local watch is what delivers events right now, and a
// persist that could not land is reported (`persisted: false`,
// `lastPersistError`) rather than thrown. Restore is single-flight, retried on
// the next tool call if the server was down, and reported in full by
// `list_watched_docs` so `[]` can no longer mean two things.
//
// The shared identity (`CW_AGENT_NAME` unset → `known-agent`) is not
// persisted at all — every anonymous session resolves to it, so a set keyed
// on it would restore everybody's watches into each of them. The server
// refuses it too; this check just spares the round trip and says why.
// ---------------------------------------------------------------------------

export function isSharedIdentity(authorId: string): boolean {
  return authorId === 'known-agent';
}

export const SHARED_IDENTITY_REASON =
  'CW_AGENT_NAME is not set, so this session has no identity to key its watches on; ' +
  'they will not survive a restart. Set it in the launch environment and restart the session.';

/**
 * The server's last answer to "what am I MISSING?", or undefined for "not
 * known" — an older server, the shared-identity refusal, an unreachable box.
 * Deliberately not defaulted to an empty block: unknown rendered as empty
 * reads as "nothing is missing", which is exactly the confident wrong answer
 * this whole readout exists to replace.
 */

/** Ask the server for a fresh coverage read. Never throws and never
 *  fabricates: an unreachable server leaves the previous answer alone rather
 *  than manufacturing an all-clear out of a failed request. */
async function refreshCoverage(
  deps: WatchRegistryDeps,
  state: RegistryState,
): Promise<WatchCoverage | undefined> {
  if (deps.identityIsShared) return undefined;
  try {
    state.coverage = parseCoverage(await deps.http('GET', watchesPath(deps))) ?? state.coverage;
  } catch {
    // Leave the previous coverage as it was; `list_watched_docs` omits the field
    // entirely when it is undefined.
  }
  return state.coverage;
}

function watchPersistenceMode(deps: WatchRegistryDeps): 'server' | 'session-only' {
  return deps.identityIsShared ? 'session-only' : 'server';
}

/** Mirror a local watch/unwatch to the server. Never throws. */
async function persistWatchChange(
  deps: WatchRegistryDeps,
  state: RegistryState,
  change: { add?: string[]; remove?: string[] },
): Promise<boolean> {
  if (deps.identityIsShared) return false;
  try {
    await deps.http('POST', watchesPath(deps), { ...change, name: deps.author.name });
    state.lastPersistError = undefined;
    return true;
  } catch (err) {
    state.lastPersistError = err instanceof Error ? err.message : String(err);
    deps.log('[claude-workspaces-mcp] could not persist watch change:', state.lastPersistError);
    return false;
  }
}

/** Returns whether the watch was persisted on the server (false when this
 *  identity is shared, the server refused, or it was unreachable). */
async function watchDoc(
  deps: WatchRegistryDeps,
  state: RegistryState,
  docId: string,
  persist = true,
): Promise<boolean> {
  if (!deps.watchers.has(docId)) {
    const controller = new AbortController();
    deps.watchers.set(docId, { controller, docId, open: false });
    await deps.startSseLoop(docId, `/events/${encodeURIComponent(docId)}`, controller);
  }
  // Persist even when already locally watched: an earlier persist may have
  // failed (server down at the time), and the POST is idempotent.
  return persist ? persistWatchChange(deps, state, { add: [docId] }) : false;
}

/**
 * Watch a whole workspace on ONE stream. Two things wear that word, and this
 * key covers both — but it did not always, and the comment here used to say
 * "every thread event on any member doc arrives" without saying which sense
 * it meant.
 *
 *  - A GROUPING (a diff review / folder bind): its member docs carry the
 *    review tag and `rooms.ts` has always double-broadcast on it. True from
 *    the start.
 *  - A hub BOARD: it holds docs through `workspace.docIds`, which is NOT that
 *    tag. Until the board fan-out landed in server.ts's `onDocRoomEvent`, a
 *    doc filed on a board reached this stream never — and nothing said so,
 *    which is the whole failure class here. Now it does, resolved at
 *    broadcast time, so docs created LATER are covered with no second call.
 *
 * What this key still does NOT do is attach you. Watching is listening;
 * attaching is being addressable. Every delivery gate asks the second
 * question, so a session with this key and no attachment hears comments while
 * voice notes queue for a lead it is not. `coverage`
 * on `list_watched_docs` is what reports that gap.
 */
async function watchWorkspace(
  deps: WatchRegistryDeps,
  state: RegistryState,
  workspaceId: string,
  persist = true,
): Promise<{ open: boolean; persisted: boolean }> {
  const key = `ws:${workspaceId}`;
  let open = deps.watchers.get(key)?.open === true;
  if (!deps.watchers.has(key)) {
    const controller = new AbortController();
    deps.watchers.set(key, { controller, docId: key, open: false });
    // Name ourselves on the stream. This socket is held for the life of the
    // session, so it is the most reliable evidence the server can have that a
    // delivery to this agent will land — but only if the server can tell WHICH
    // agent is on it. Without the id it is one more anonymous subscriber,
    // indistinguishable from a browser tab, and the server falls back to
    // asking how recently the model happened to call a tool. That clock
    // expires under an agent doing local work: measured 2026-08-19 at a
    // 19.1-minute grep-and-read gap against a 15-minute window, with this
    // stream open throughout and a voice note queued instead of delivered.
    open = await deps.startSseLoop(
      key,
      `/events/workspace/${encodeURIComponent(workspaceId)}?agentId=${encodeURIComponent(deps.author.id)}`,
      controller,
    );
  }
  // Two failures, reported apart. A stream that did not open loses events NOW;
  // a watch that did not persist loses them at the next respawn. Collapsing
  // them into one boolean is how a caller ends up reassured about the half
  // that worked.
  const persisted = persist ? await persistWatchChange(deps, state, { add: [key] }) : false;
  return { open, persisted };
}

async function unwatchDoc(
  deps: WatchRegistryDeps,
  state: RegistryState,
  docId: string,
): Promise<boolean> {
  const w = deps.watchers.get(docId);
  if (w) {
    w.controller.abort();
    deps.watchers.delete(docId);
  }
  // Forget it on the server even if it was not locally wired — a sibling
  // session may have recorded it, and an explicit unwatch means "stop".
  return persistWatchChange(deps, state, { remove: [docId] });
}
