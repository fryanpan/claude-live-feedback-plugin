#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { readRenamedEnv } from '@feedback/core/env-names';
import { discoveryCandidates, resolveDiscoveryFile } from '@feedback/core/machine-paths';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type BacklogCommentRow, deliverAttachBacklog } from './attach-backlog.ts';
import { createAttachmentKeepalive } from './attachment-keepalive.ts';
import { resolveAgentAuthor } from './author.ts';
import { createChannelMessages } from './channel-messages.ts';
import { type PresenceRow, claimWarning } from './claim-warning.ts';
import { createDeferredEmitter } from './deferred-emit.ts';
import { createFrameDedup } from './frame-dedup.ts';
import { createFrameHandler } from './frame-handler.ts';
import { type Watcher, createSseLoops } from './sse-loop.ts';
import { TOOL_LIST } from './tool-schemas.ts';
import { type DocsToolContext, handleDocsTool } from './tools/docs.ts';
import { type TaskToolContext, handleTaskTool } from './tools/tasks.ts';
import { type WorkspaceToolContext, handleWorkspaceTool } from './tools/workspace.ts';
import {
  type RestoreState,
  boardsToReattach,
  parseCoverage,
  restoreNoticeContent,
} from './watch-coverage.ts';
import { SHARED_IDENTITY_REASON, createWatchRegistry, isSharedIdentity } from './watch-registry.ts';

/**
 * Thin MCP server that proxies tool calls to a running feedback server
 * over HTTP. Agents launch this binary via stdio; it calls the main
 * server's REST API so state is authoritative there.
 *
 * Base URL resolution (first hit wins):
 *   1. $CW_BASE_URL — explicit override
 *   2. ~/.claude/claude-workspaces/server.json — written by scripts/serve.ts
 *      on startup so the MCP auto-finds whichever port the server landed on.
 *      Deliberately NOT renamed with the plugin: the writer and this reader
 *      ship in different artifacts and restart independently, so moving it
 *      needs a dual-write transition rather than a rename.
 *   3. http://localhost:8787 — last-resort default
 *
 * env:
 *   CW_BASE_URL    — optional override; usually discovery handles it
 *   CW_AGENT_NAME  — this agent's display name, as a person would say it;
 *                          wins over CW_AUTHOR, which the plugin's
 *                          .mcp.json pins to `agent` for every peer
 *   CW_AUTHOR      — fallback author key/name (default: agent)
 */

// Resolved per-request, not frozen at module load. The MCP stdio child runs
// for the life of a Claude Code session — sometimes days. The supervisor may
// not be running yet at child-start, may move ports on restart, or may not
// have written server.json yet. Reading the discovery file on each http()
// call is a single fs read of a tiny JSON blob and lets the child pick up
// port changes without a restart.
//
// No silent default: port 8787 used to be the fallback, but it's squatted by
// notion-channel-mcp on developer machines and silently routed every call to
// the wrong server. If discovery is unavailable, fail loudly with a hint.
function resolveBaseUrl(): string {
  const override = readRenamedEnv(process.env, 'CW_BASE_URL');
  if (override) return override;
  const discovery = resolveDiscoveryFile(homedir(), existsSync);
  if (discovery) {
    try {
      const j = JSON.parse(readFileSync(discovery, 'utf8')) as { port?: number };
      if (j.port) return `http://localhost:${j.port}`;
    } catch {
      // fall through to throw — corrupt discovery file
    }
  }
  throw new Error(
    'claude-workspaces server not found — start it with `bun run dev` (or set CW_BASE_URL). ' +
      `Looked for a discovery file at ${discoveryCandidates(homedir()).join(' and ')}.`,
  );
}
const AUTHOR = resolveAgentAuthor(process.env);
/** What `post_status` accepts — the server's `NOTE_TEXT_MAX`
 *  (packages/server/src/agent-notes.ts), which refuses anything longer.
 *  Spelled here because the bundle imports nothing from the server. */
const STATUS_TEXT_MAX = 4000;

/** The {id,name,color} subset of AUTHOR a `suggest: true` route call needs —
 *  suggestions are attributed per-agent from the same identity every other
 *  MCP call uses, not a shared "agent" identity. */
function suggestionAuthor(): { id: string; name: string; color: string } {
  return { id: AUTHOR.id, name: AUTHOR.name, color: AUTHOR.color };
}

/**
 * Must match packages/plugin/.claude-plugin/plugin.json — this is the version
 * a client sees in the initialize handshake, and it had drifted three minor
 * releases behind. Asserted against the manifest, through the real bundle, in
 * packages/mcp/test/launcher.test.ts.
 *
 * One constant rather than a literal per use: the same value is reported to
 * the hub on attach, so the board can say which sessions are running an older
 * bundle than the deploy source would install. A second literal would be a
 * fourth version site, and this file's history is that version sites drift.
 */
const PLUGIN_VERSION = '0.1.152';

/**
 * One nonce per PROCESS, minted at module load and sent on every attach.
 * The server compares it against the attachment's recorded nonce to answer
 * the question the ack grace window turns on: is this attach a fresh process
 * (bypass the grace — whatever was in flight went to a process that is gone)
 * or the same live one re-attaching (respect it — a frame already on the
 * wire to THIS process must not be handed over a second time through the
 * attach response). See AgentAttachment.processId on the server side.
 */
const PROCESS_ID = randomUUID();

const server = new Server(
  {
    name: 'claude-workspaces',
    version: PLUGIN_VERSION,
  },
  {
    capabilities: {
      tools: {},
      // Declares this server as a Claude Code channel — incoming feedback
      // events get pushed to the session as <channel source="claude-workspaces" …>
      // via `notifications/claude/channel`.
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      'Every markdown review doc is backed by a .md file on disk. The file is the',
      'source of truth at rest; the live editor is the source of truth at runtime;',
      'the plugin keeps them in sync bidirectionally (~1s debounced).',
      '',
      'CREATE: call create_review_doc(docId, path) to bring a .md under review.',
      'The server reads the file, parses it into the live editor, sets up the',
      'fs.watch + write-back, and returns a reviewUrl you can hand to a human.',
      '',
      'EDIT: never use Write/Edit/str_replace on the .md while it is under review',
      '— direct filesystem edits race against the live doc’s own ~1s flush, and if',
      'LF has any pending state your edit can be silently overwritten by the next',
      'write-back. Route edits through the MCP tools below: find_and_replace for',
      'prose changes, rewrite_thread_region / insert_after_thread / insert_blocks_after_thread',
      'for comment-anchored edits, and set_doc_content(docId, markdown) for a',
      'COMPREHENSIVE REWRITE of the whole doc (do NOT Write the file + reparse,',
      'and do NOT delete_doc + Write + re-create — both race the flush and both',
      'have destroyed content in the field). NEVER use set_doc_content on a doc a',
      'human is reviewing or editing: a scoped request (a comment, one section)',
      'gets a scoped edit — find_and_replace (table rows match in pipe syntax),',
      'rewrite_thread_region, edit_at_anchor — and a whole-doc rewrite built from',
      'an earlier read destroys their concurrent edits. The server refuses such a',
      'write with 409 stale-write naming the human-edit time; re-read with',
      'get_doc, re-apply your change onto the CURRENT content, and only retry',
      'with confirmOverwriteHumanEdits: true if a full rewrite is truly needed.',
      'External edits (VS Code, git pull)',
      'flow back into the live doc via the file poll when LF is idle; if you wrote',
      'to a bound file externally and need to be sure it landed, call',
      'reparse_from_disk(docId) to force-pull from disk. If an edit response or',
      'get_doc carries a `syncError`, read it — it names the conflict and where',
      'the overwritten version was backed up.',
      '',
      'DIFF REVIEW / FOLDER BROWSE: when the human wants to review your code',
      'changes ("review this diff", a branch, work in progress), call',
      'create_diff_review(repo, base) — one review doc per changed file,',
      'PR-style unified diff with line comments. Omit base to BROWSE a folder',
      'instead (no diff): everything is navigable from the all-files sidebar,',
      'files open lazily, markdown editable — works on plain folders and',
      'fresh repos too (bind_folder is an alias for this). Default mode diffs',
      'base against the LIVE working tree: keep editing the code and the reviewer',
      'sees your changes re-render within ~1s, with their comments riding along',
      '(threads orphan into the outdated-comments flow if their line disappears).',
      'ALWAYS pass groups: [{title, paths[]}] — organize the changed files by',
      'INTENT (the way you would split a branch into reviewable commits); you',
      'know the semantics of your change far better than the heuristic fallback.',
      'First group = read first; a directory path claims every file under it;',
      'unlisted files land in "Other". Pass target only to pin a review to a',
      'finished range. Re-run the tool after touching files that were not in',
      'the diff before (idempotent; refreshes the file list; keeps your groups',
      'unless you pass new ones). Share the returned entryUrl with the human',
      '(bare URL on its own line); the file tree navigates the rest. Thread',
      'events arrive per file via the auto-watch; resolve threads as you address',
      'them; refresh_review(setId) to re-sync membership and reviews as files move (threads survive); delete_review(setId) when the review is done.',
      '',
      'SUGGEST: pass suggest: true on find_and_replace or rewrite_thread_region to',
      'PROPOSE a change instead of applying it — the match is marked pending and',
      'attributed to this agent; disk and every other reader stay on the accepted',
      'state until a human (or accept_suggestion) accepts it. Returns { suggestionId }.',
      'Use for judgment calls a reviewer should approve; use the plain edit for',
      'mechanical fixes. list_suggestions(docId) / accept_suggestion(docId, sid) /',
      'reject_suggestion(docId, sid) / resolve_all_suggestions(docId, action, authorId?)',
      'manage proposals from any author. suggestion.created/accepted/rejected events',
      'arrive on the same watch_doc channel as thread events.',
      '',
      'OBSERVE: call watch_doc(docId) once per doc to receive thread events as',
      '<channel source="claude-workspaces" doc_id="..." thread_id="..." event="..." author="..." sent_at="...">body</channel>',
      'messages. Treat each as an explicit ask from the reviewer; read, decide if it',
      "is in your domain, act via an edit tool. unwatch_doc when you're done.",
      'Watches are remembered on the server under this agent name (CW_AGENT_NAME)',
      'and re-wired when the session respawns; list_watched_docs says whether the',
      'current set was restored from the server or is session-only.',
      '',
      'CLEANUP: review docs are usually short-lived — bound for a ~30-minute',
      'feedback pass, then obsolete. When you no longer need one, call',
      'delete_doc(docId) to remove it (the bound source .md is left on disk; only',
      'the review session goes away). It refuses if the doc still has open threads',
      "(someone's waiting on that feedback) — resolve them first or pass force:true.",
      "Don't leave stale docs piling up in list_docs.",
      '',
      'BEFORE YOU EDIT A .md FILE: call list_docs first. If a doc has sourceUrl',
      'matching the path, route through the MCP. If not, normal file edits are fine.',
      '',
      'WORKSPACE HUB: a hub workspace is a goal + a task board + linked docs.',
      'create_workspace mints one; attach_doc links existing docs/reviews to it;',
      'create_tasks (ALWAYS a list — one idea is a one-row list) and',
      'promote_to_task add work (omit `goal` and the task lands UNPLACED in',
      'Backlog awaiting triage — the create says so and hands you the goal',
      'bands, and placing it with set_task_goal IS the triage:',
      'pick the goal AND the exact position). task_transition is the',
      'single gate for status changes — blockers come back in the result.',
      'attach_agent registers you as the workspace agent (heartbeat every few',
      'minutes to stay live; lead-addressed deliveries only reach live agents).',
      'Workspace events (task.*, decision.answered, workspace.goals_changed)',
      'arrive on the same channel as thread events once you create/attach.',
      'import_tasks_markdown moves an existing hand-maintained markdown tracker',
      'onto the board (dry-run first — review the mapping before apply:true).',
    ].join(' '),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => TOOL_LIST);

/**
 * Tools that take a `docId` but should NOT trigger implicit auto-watch.
 *
 * - `unwatch_doc`: by definition the user is opting OUT of events; don't
 *   reverse that intent.
 * - `watch_doc`: already wires the watcher itself; redundant.
 * - `observe_url`: returns the SSE URL but doesn't imply the caller is
 *   actually consuming the stream from this MCP session.
 */
const NO_AUTO_WATCH_TOOLS = new Set([
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
async function maybeAutoWatch(name: string, args: unknown): Promise<void> {
  if (NO_AUTO_WATCH_TOOLS.has(name)) return;
  if (!args || typeof args !== 'object') return;
  const a = args as { docId?: unknown; subscribe?: unknown };
  if (a.subscribe === false) return;
  if (typeof a.docId !== 'string' || a.docId.length === 0) return;
  await watchDoc(a.docId);
}

/**
 * Channel frames produced from inside a tool call, held until it has answered.
 *
 * The restore path is the one producer of those: `ensureWatchesRestored` is
 * kicked off at `oninitialized`, and the first tool call awaits the same
 * in-flight promise, so anything it emitted was written between a `tools/call`
 * request and its response — the one window a session does not read. See
 * deferred-emit.ts for the 2026-08-20 measurement.
 */
const deferredEmits = createDeferredEmitter();

/**
 * The slice of this module the domain handlers in `tools/` read.
 *
 * Built per tool call rather than once at module load, because half of what
 * it names — the watch registry and the functions over it — is declared
 * BELOW the handler, and a `const` read from a module-level object literal
 * up here would hit its temporal dead zone. A tool call is a network round
 * trip; one object literal is not the cost worth avoiding.
 *
 * Passing the slice explicitly, rather than letting `tools/` import it back,
 * is what keeps the dependency one-way: this file connects a stdio transport
 * at the bottom, so anything that imports it runs that.
 */
function toolContext(): DocsToolContext & TaskToolContext & WorkspaceToolContext {
  return {
    http,
    ok,
    err,
    AUTHOR,
    PLUGIN_VERSION,
    PROCESS_ID,
    markAttached,
    STATUS_TEXT_MAX,
    suggestionAuthor,
    resolveBaseUrl,
    watchers,
    watchDoc,
    watchWorkspace,
    unwatchDoc,
    refreshCoverage,
    watchPersistenceMode,
    claimNoticeFor,
    restoreState,
    lastPersistError: registry.lastPersistError(),
    IDENTITY_IS_SHARED,
    SHARED_IDENTITY_REASON,
  };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  // Released in the `finally` below, so a throwing handler still lets the
  // held frames out.
  const endToolCall = deferredEmits.beginToolCall();
  try {
    // Restore before anything else: a respawned child's first tool call is
    // the moment its watch set has to be back, and if the server was down at
    // initialize this is the retry. Never throws.
    await ensureWatchesRestored();
    // A tool call is this session proving it is alive AND working, which is
    // exactly what an attachment's heartbeat asserts. Without this, an agent
    // that followed "declare yourself lead and you are done" drifts out of
    // the observed window on every board it is not actively touching, at
    // which point Bryan's next goal edit queues with no channel emit and the
    // session hears the silence this whole ticket is about. Fire-and-forget:
    // liveness is not worth failing a tool call over. See
    // attachment-keepalive.ts for why this rides real calls rather than a
    // timer.
    void sendDueHeartbeats();
    await maybeAutoWatch(name, a);
    // Documents answer from tools/docs.ts, board rows from tools/tasks.ts,
    // and boards, agents and the operator verbs from tools/workspace.ts. A
    // domain handler returns `undefined` for a name that is not its own, so
    // the three families chain the way the server's route files do — and the
    // last link is the answer for a name none of them claims, which is where
    // the switch's `default` went.
    const ctx = toolContext();
    return (
      (await handleDocsTool(name, a, ctx)) ??
      (await handleTaskTool(name, a, ctx)) ??
      (await handleWorkspaceTool(name, a, ctx)) ??
      err(`unknown tool: ${name}`)
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  } finally {
    endToolCall();
  }
});

// ===========================================================================
// CHANNEL — bridge the feedback server's SSE stream into Claude Code via
// `notifications/claude/channel`. Each active watcher owns one fetch
// connection to /events/<docId>; events are forwarded as channel messages.
// ===========================================================================

const watchers = new Map<string, Watcher>();

const IDENTITY_IS_SHARED = isSharedIdentity(AUTHOR.id);

let restoreState: RestoreState = IDENTITY_IS_SHARED
  ? { status: 'session-only', from: 'session', restored: [], pruned: [], attempts: 0 }
  : { status: 'pending', from: 'session', restored: [], pruned: [], attempts: 0 };
let restoreInFlight: Promise<void> | null = null;
/** After a failed restore, don't hammer a down server from every tool call —
 *  back off (capped at 30s), then try again on the next call after that. */
let restoreRetryAt = 0;

/**
 * Which boards this session is attached to, and when it last proved it.
 *
 * An attachment is a claim that expires unless the server keeps observing
 * this session, not a state — see attachment-keepalive.ts. Marked wherever
 * this process attaches
 * (`attach_agent`, declaring itself lead, the re-attach on restore) and
 * refreshed off real tool calls.
 */
const keepalive = createAttachmentKeepalive();

/** Record an attachment this session just made. */
function markAttached(workspaceId: string): void {
  keepalive.mark(workspaceId);
}

/** Prove liveness on any board whose heartbeat is due. Never throws: a
 *  keepalive that could fail a tool call would be worse than the staleness it
 *  prevents. */
async function sendDueHeartbeats(): Promise<void> {
  for (const workspaceId of keepalive.due()) {
    try {
      await http(
        'POST',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(AUTHOR.id)}/heartbeat`,
        { toolCallAt: Date.now() },
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
async function claimNoticeFor(taskId: string): Promise<string | undefined> {
  for (const workspaceId of keepalive.boards()) {
    try {
      const res = (await http(
        'GET',
        // includeBlocked so a row held by a dependency is still findable —
        // its being blocked says nothing about whether somebody is on it.
        `/api/workspaces/${encodeURIComponent(workspaceId)}/next?includeBlocked=true`,
      )) as { tasks?: PresenceRow[] };
      const row = res.tasks?.find((t) => t?.id === taskId);
      if (row) return claimWarning(row, AUTHOR.id, Date.now());
    } catch {
      // Next board, then silence. See the contract above.
    }
  }
  return undefined;
}

/**
 * Ask the server what this identity was watching and re-wire it. Single
 * flight; a failure leaves `restoreState.status = 'failed'` and the next call
 * tries again. Once `restored`, further calls are no-ops — the server set
 * only changes through this process's own watch/unwatch from then on (or
 * through a sibling session with the same name, whose additions reach this
 * process at ITS next respawn, not live).
 */
async function ensureWatchesRestored(): Promise<void> {
  if (restoreState.status === 'restored' || restoreState.status === 'session-only') return;
  if (restoreInFlight) return restoreInFlight;
  if (restoreState.status === 'failed' && Date.now() < restoreRetryAt) return;
  restoreInFlight = (async () => {
    const attempts = restoreState.attempts + 1;
    try {
      const res = (await http('GET', registry.watchesPath())) as {
        watches?: Array<{ key: string }>;
        pruned?: string[];
      };
      registry.setCoverage(parseCoverage(res));
      const keys = (res.watches ?? []).map((w) => w.key);
      const restored: string[] = [];
      for (const key of keys) {
        if (watchers.has(key)) continue;
        if (key.startsWith('ws:')) await watchWorkspace(key.slice('ws:'.length), false);
        else await watchDoc(key, false);
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
      for (const workspaceId of boardsToReattach(registry.coverage())) {
        try {
          const attachRes = (await http(
            'POST',
            `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`,
            {
              agentId: AUTHOR.id,
              agentName: AUTHOR.name,
              runtime: 'claude-code-local',
              pluginVersion: PLUGIN_VERSION,
              processId: PROCESS_ID,
            },
          )) as {
            queuedComments?: BacklogCommentRow[];
            queuedVoice?: Array<{ transcript?: unknown }>;
          };
          markAttached(workspaceId);
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
          deferredEmits.emitOutsideToolCall(() =>
            deliverAttachBacklog(workspaceId, attachRes, {
              emit: async (ev, payload) => {
                if (shouldForwardFrame.shouldForward(ev, payload)) {
                  await emitChannelMessage(ev, payload);
                }
              },
              ackComment: async (rowId) => {
                await http(
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
      if (reattached.length > 0) await refreshCoverage();
      const state: RestoreState = {
        status: 'restored',
        from: 'server',
        restored,
        reattached,
        pruned: res.pruned ?? [],
        at: new Date().toISOString(),
        attempts,
      };
      restoreState = state;
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
      deferredEmits.emitOutsideToolCall(() => emitRestoreNotice(state));
    } catch (err) {
      restoreState = {
        ...restoreState,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        attempts,
      };
      restoreRetryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** attempts);
    } finally {
      restoreInFlight = null;
    }
  })();
  return restoreInFlight;
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
async function emitRestoreNotice(state: RestoreState): Promise<void> {
  const content = restoreNoticeContent({
    restored: state.restored,
    reattached: state.reattached ?? [],
    pruned: state.pruned,
    agentName: AUTHOR.name,
    coverage: registry.coverage(),
  });
  if (content === null) return;
  await server.notification({
    method: 'notifications/claude/channel',
    params: {
      source: 'claude-workspaces',
      sent_at: state.at ?? new Date().toISOString(),
      content,
      meta: {
        event: 'watches.restored',
        restored: state.restored,
        pruned: state.pruned,
        ...(registry.coverage() ? { unattachedBoards: registry.coverage()?.unattachedBoards } : {}),
      },
    },
  });
}

/** Shared across every SSE loop in this process — the whole point is to catch
 *  a frame arriving on the board stream that the review stream already
 *  delivered, so a per-loop instance would see nothing. See frame-dedup.ts
 *  for what identifies an event (the server's `eid` first, `event#docId#seq`
 *  for an older one), why the fallback needs a window, and why anything it
 *  cannot identify is forwarded rather than dropped. */
const shouldForwardFrame = createFrameDedup();

/**
 * The channel renderers, bound to this process: the notification sink the SDK
 * gives us, the HTTP client above, and this session's identity. See
 * channel-messages.ts — it holds every line an agent reads.
 */
const channel = createChannelMessages({
  notify: (n) => server.notification(n),
  http: (method, path, body) => http(method, path, body),
  authorId: AUTHOR.id,
});
const emitChannelMessage = channel.emitChannelMessage;

/**
 * The SSE frame handler, bound to this process. See frame-handler.ts for the
 * ordering it keeps between the kind gate, the dedup and the comment receipt.
 */
const handleFrame = createFrameHandler({
  notify: (n) => server.notification(n),
  emitChannelMessage: (event, payload) => channel.emitChannelMessage(event, payload),
  http: (method, path, body) => http(method, path, body),
  shouldForward: (event, payload) => shouldForwardFrame.shouldForward(event, payload),
});

/**
 * The SSE loops, bound to this process. See sse-loop.ts — it owns the
 * reconnect, the `open` flag on each watcher record, and the cursor's
 * deliver-then-commit order.
 */
const { startSseLoop } = createSseLoops({
  watchers,
  resolveBaseUrl,
  fetch: (url, init) => fetch(url, init),
  handleFrame: (raw) => handleFrame(raw),
  resetDedup: () => shouldForwardFrame.reset(),
  log: (...args) => console.error(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  timers: {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
});

/**
 * The watch registry, bound to this process. See watch-registry.ts — it owns
 * the local subscriptions, the mirror of that set on the server, and the two
 * failures (stream not open, watch not persisted) that must stay apart.
 */
const registry = createWatchRegistry({
  watchers,
  http: (method, path, body) => http(method, path, body),
  author: AUTHOR,
  startSseLoop,
  identityIsShared: IDENTITY_IS_SHARED,
  log: (...args) => console.error(...args),
});
const { watchDoc, watchWorkspace, unwatchDoc, refreshCoverage, watchPersistenceMode } = registry;

async function http(method: string, path: string, body?: unknown): Promise<unknown> {
  const baseUrl = resolveBaseUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  // Check status before parsing — the server's catch-all returns the bare
  // string "not found" for unmatched routes, which would explode JSON.parse
  // and bury the actual HTTP error.
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

const transport = new StdioServerTransport();
// Once the client has finished initializing (not merely connected — the MCP
// spec has the server hold notifications until then), ask the server for
// this identity's watch set and re-wire it, so the respawn keeps its feedback
// loop without waiting for a tool call. A tool call arriving meanwhile awaits
// the same in-flight restore.
server.oninitialized = () => {
  void ensureWatchesRestored();
};
await server.connect(transport);
// Best-effort startup banner. Fall back gracefully if discovery isn't ready
// at child-start — http() will resolve fresh per request anyway.
let bannerBase: string;
try {
  bannerBase = resolveBaseUrl();
} catch {
  bannerBase = '<discovery pending — server not yet running>';
}
console.error(`[mcp] connected — base ${bannerBase}, author ${AUTHOR.name}`);
