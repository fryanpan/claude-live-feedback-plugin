#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createAgentTokenStore } from './agent-token.ts';
import { createAttachmentKeepalive } from './attachment-keepalive.ts';
import { createAttachments } from './attachments.ts';
import { resolveAgentAuthor } from './author.ts';
import { type ToolContext, createCallToolHandler } from './call-tool.ts';
import { createChannelMessages } from './channel-messages.ts';
import { createDeferredEmitter } from './deferred-emit.ts';
import { createFrameDedup } from './frame-dedup.ts';
import { createFrameHandler } from './frame-handler.ts';
import { resolveBaseUrl as baseUrlFrom, createHttp, err, ok } from './http-client.ts';
import { createMuxLoop } from './mux-loop.ts';
import { type Watcher, createSseLoops } from './sse-loop.ts';
import { TOOL_LIST } from './tool-schemas.ts';
import { handleDocsTool } from './tools/docs.ts';
import { handleTaskTool } from './tools/tasks.ts';
import { handleWorkspaceTool } from './tools/workspace.ts';

import { SHARED_IDENTITY_REASON, createWatchRegistry, isSharedIdentity } from './watch-registry.ts';
import { createWatchRestore } from './watch-restore.ts';

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

/** Resolved per request, not frozen at module load — see http-client.ts. */
const resolveBaseUrl = () => baseUrlFrom({ env: process.env, homedir, existsSync, readFileSync });

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
const PLUGIN_VERSION = '0.1.166';

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
      'fresh repos too (attach_folder is an alias for this). Default mode diffs',
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
      'spin_off_task add work (omit `goal` and the task lands UNPLACED in',
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
function toolContext(): ToolContext {
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
    streamMode: registry.streamMode,
    claimNoticeFor,
    restoreState: restore.state(),
    lastPersistError: registry.lastPersistError(),
    IDENTITY_IS_SHARED,
    SHARED_IDENTITY_REASON,
  };
}

/**
 * The CallTool dispatcher, bound to this process. See call-tool.ts for what
 * runs around every answer: the deferred emitter, the watch restore, the
 * fire-and-forget heartbeat and the implicit auto-watch.
 */
server.setRequestHandler(
  CallToolRequestSchema,
  createCallToolHandler({
    deferredEmits,
    ensureWatchesRestored: () => ensureWatchesRestored(),
    sendDueHeartbeats: () => sendDueHeartbeats(),
    watchDoc: (docId) => watchDoc(docId),
    toolContext,
    handlers: [handleDocsTool, handleTaskTool, handleWorkspaceTool],
    err,
  }),
);

// ===========================================================================
// CHANNEL — bridge the feedback server's SSE stream into Claude Code via
// `notifications/claude/channel`. Each active watcher owns one fetch
// connection to /events/<docId>; events are forwarded as channel messages.
// ===========================================================================

const watchers = new Map<string, Watcher>();

const IDENTITY_IS_SHARED = isSharedIdentity(AUTHOR.id);

/**
 * This session's proof that it is AUTHOR and not some other agent whose name
 * happens to be readable on the board. See agent-token.ts — fetched once,
 * held for the process, and never fatal: no token means the header is absent,
 * which is what this client sent before the header existed and what the
 * server still accepts through its deprecation window.
 */
const agentTokens = createAgentTokenStore({
  agentId: AUTHOR.id,
  resolveBaseUrl,
  fetch: (url, init) => fetch(url, init),
  log: (...args) => console.error(...args),
  identityIsShared: IDENTITY_IS_SHARED,
});

/**
 * This session's attachments, bound to this process. See attachments.ts — the
 * heartbeat rides real tool calls because that is the only honest evidence
 * this agent is alive AND working.
 */
const { markAttached, sendDueHeartbeats, claimNoticeFor } = createAttachments({
  http: (method, path, body) => http(method, path, body),
  author: AUTHOR,
  keepalive: createAttachmentKeepalive(),
});

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
const loopTimers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const { startSseLoop } = createSseLoops({
  watchers,
  resolveBaseUrl,
  fetch: (url, init) => fetch(url, init),
  handleFrame: (raw) => handleFrame(raw),
  resetDedup: () => shouldForwardFrame.reset(),
  log: (...args) => console.error(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  timers: loopTimers,
});

/**
 * This session's ONE event stream, bound to this process. See mux-loop.ts —
 * every watched key rides it, which is what keeps a session with two hundred
 * watches from holding two hundred sockets against the shared server.
 */
const muxLoop = createMuxLoop({
  watchers,
  agentId: AUTHOR.id,
  resolveBaseUrl,
  fetch: (url, init) => fetch(url, init),
  handleFrame: (raw) => handleFrame(raw),
  resetDedup: () => shouldForwardFrame.reset(),
  log: (...args) => console.error(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  timers: loopTimers,
  authHeaders: () => agentTokens.headers(),
  forgetToken: () => agentTokens.forget(),
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
  mux: muxLoop,
  identityIsShared: IDENTITY_IS_SHARED,
  log: (...args) => console.error(...args),
});
const { watchDoc, watchWorkspace, unwatchDoc, refreshCoverage, watchPersistenceMode } = registry;

/**
 * The watch restore, bound to this process. See watch-restore.ts — it asks
 * the server for this identity's set, re-wires it, re-attaches to the boards
 * that were already this session's, and forwards the backlog the attach
 * response drains.
 */
const restore = createWatchRestore({
  http: (method, path, body) => http(method, path, body),
  registry,
  watchers,
  author: AUTHOR,
  pluginVersion: PLUGIN_VERSION,
  processId: PROCESS_ID,
  markAttached,
  notify: (n) => server.notification(n),
  emitChannelMessage: (event, payload) => channel.emitChannelMessage(event, payload),
  shouldForward: (event, payload) => shouldForwardFrame.shouldForward(event, payload),
  deferredEmits,
  identityIsShared: IDENTITY_IS_SHARED,
});
const { ensureWatchesRestored } = restore;

/** The REST call every tool goes through; throws on a non-2xx. */
const http = createHttp(
  resolveBaseUrl,
  (url, init) => fetch(url, init),
  (path) => agentTokens.headersFor(path),
);

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
