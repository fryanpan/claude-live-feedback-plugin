/**
 * The CallTool dispatcher: what every `tools/call` request runs through
 * before, and after, the domain handler that answers it.
 *
 * Four things happen around the answer and each is load-bearing. The deferred
 * emitter is opened first and released in a `finally`, so a throwing handler
 * still lets the held channel frames out. The watch restore runs before
 * anything else, because a respawned child's first tool call is the moment
 * its set has to be back. The heartbeat is fire-and-forget, because liveness
 * is not worth failing a call over. And the auto-watch fires before the
 * handler, so a doc named in a call is subscribed even if the caller forgot.
 *
 * Lifted out of `mcp.ts` unchanged. The three domain families arrive as a
 * list rather than three named imports: the chain is the shape here, and the
 * last link — the answer for a name nobody claims — is what the switch's
 * `default` became.
 */
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DocsToolContext } from './tools/docs.ts';
import type { TaskToolContext } from './tools/tasks.ts';
import type { WorkspaceToolContext } from './tools/workspace.ts';

/** The slice of the process the domain handlers in `tools/` read. */
export type ToolContext = DocsToolContext & TaskToolContext & WorkspaceToolContext;

/** One domain family. `undefined` means "not one of mine". */
export type DomainHandler = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<CallToolResult | undefined>;

export type CallToolHandler = (req: CallToolRequest) => Promise<CallToolResult>;

export interface CallToolDeps {
  /** Holds channel frames produced inside a call until it has answered. */
  deferredEmits: { beginToolCall(): () => void };
  ensureWatchesRestored: () => Promise<void>;
  sendDueHeartbeats: () => Promise<void>;
  watchDoc: (docId: string) => Promise<unknown>;
  /** Built per call — see the note on `toolContext` in mcp.ts. */
  toolContext: () => ToolContext;
  /** The domain families, in the order a name is offered to them. */
  handlers: DomainHandler[];
  err: (message: string) => CallToolResult;
}

/**
 * Tools that take a `docId` but should NOT trigger implicit auto-watch.
 *
 * - `unwatch_doc`: by definition the user is opting OUT of events; don't
 *   reverse that intent.
 * - `watch_doc`: already wires the watcher itself; redundant.
 * - `observe_url`: returns the SSE URL but doesn't imply the caller is
 *   actually consuming the stream from this MCP session.
 */
export const NO_AUTO_WATCH_TOOLS = new Set([
  'unwatch_doc',
  'watch_doc',
  'observe_url',
  // attach_doc's docId may be a diff-review/folder workspaceId, which has no
  // per-doc SSE channel — the hub watch is the WORKSPACE channel, wired by
  // create_workspace / attach_agent instead.
  'attach_doc',
]);

/**
 * Implicit auto-watch (path B). Any MCP tool call that names a docId is a
 * strong "I'm working on this doc" signal — almost always the caller
 * wants to be told when threads land on it. Today an agent has to
 * remember a separate `watch_doc(docId)` call after binding, and the
 * failure is silent (no events flow, doc looks fine). The wrapper closes
 * that gap by subscribing on the first docId touch.
 *
 * Idempotent (`watchDoc` returns immediately if the docId is already
 * watched). Callers can opt out per-call with `subscribe: false` in the
 * tool args. Explicit `watch_doc` / `unwatch_doc` semantics are
 * unaffected.
 */
export async function maybeAutoWatch(
  watchDoc: (docId: string) => Promise<unknown>,
  name: string,
  args: unknown,
): Promise<void> {
  if (NO_AUTO_WATCH_TOOLS.has(name)) return;
  if (!args || typeof args !== 'object') return;
  const a = args as { docId?: unknown; subscribe?: unknown };
  if (a.subscribe === false) return;
  if (typeof a.docId !== 'string' || a.docId.length === 0) return;
  await watchDoc(a.docId);
}

export function createCallToolHandler(deps: CallToolDeps): CallToolHandler {
  return async (req) => {
    const { name, arguments: a = {} } = req.params;
    // Released in the `finally` below, so a throwing handler still lets the
    // held frames out.
    const endToolCall = deps.deferredEmits.beginToolCall();
    try {
      // Restore before anything else: a respawned child's first tool call is
      // the moment its watch set has to be back, and if the server was down at
      // initialize this is the retry. Never throws.
      await deps.ensureWatchesRestored();
      // A tool call is this session proving it is alive AND working, which is
      // exactly what an attachment's heartbeat asserts. Without this, an agent
      // that followed "declare yourself lead and you are done" drifts out of
      // the observed window on every board it is not actively touching, at
      // which point Bryan's next goal edit queues with no channel emit and the
      // session hears the silence this whole ticket is about. Fire-and-forget:
      // liveness is not worth failing a tool call over. See
      // attachment-keepalive.ts for why this rides real calls rather than a
      // timer.
      void deps.sendDueHeartbeats();
      await maybeAutoWatch(deps.watchDoc, name, a);
      // Documents answer from tools/docs.ts, board rows from tools/tasks.ts,
      // and boards, agents and the operator verbs from tools/workspace.ts. A
      // domain handler returns `undefined` for a name that is not its own, so
      // the three families chain the way the server's route files do — and the
      // last link is the answer for a name none of them claims, which is where
      // the switch's `default` went.
      const ctx = deps.toolContext();
      for (const handle of deps.handlers) {
        const answer = await handle(name, a, ctx);
        if (answer !== undefined) return answer;
      }
      return deps.err(`unknown tool: ${name}`);
    } catch (e) {
      return deps.err(e instanceof Error ? e.message : String(e));
    } finally {
      endToolCall();
    }
  };
}
