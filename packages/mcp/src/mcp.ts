#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { readRenamedEnv } from '@feedback/core/env-names';
import { discoveryCandidates, resolveDiscoveryFile } from '@feedback/core/machine-paths';
import { parseThreadReviewItemId } from '@feedback/core/review-item-id';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { type BacklogCommentRow, deliverAttachBacklog } from './attach-backlog.ts';
import { createAttachmentKeepalive } from './attachment-keepalive.ts';
import { resolveAgentAuthor } from './author.ts';
import { isChannelEvent } from './channel-gate.ts';
import { type PresenceRow, claimWarning } from './claim-warning.ts';
import { decisionAnsweredLine } from './decision-line.ts';
import { declareWorkspaceLead } from './declare-lead.ts';
import { createDeferredEmitter } from './deferred-emit.ts';
import { createFrameDedup } from './frame-dedup.ts';
import {
  readyIdleLine,
  reviewAnsweredLine,
  reviewItemHeldLine,
  stalledLine,
} from './nudge-line.ts';
import type { HeldRowPayload, StalledRowPayload } from './nudge-line.ts';
import { parseCapArg } from './parallelism-cap.ts';
import { isSelfAuthoredEvent } from './self-authored.ts';
import { type SseCursor, deliverThenCommit } from './sse-cursor.ts';
import { projectTaskRows } from './task-projection.ts';
import { TOOL_LIST } from './tool-schemas.ts';
import { type DocsToolContext, handleDocsTool } from './tools/docs.ts';
import { voiceRequestLine } from './voice-line.ts';
import {
  type RestoreState,
  type WatchCoverage,
  boardsToReattach,
  parseCoverage,
  restoreNoticeContent,
} from './watch-coverage.ts';

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
const PLUGIN_VERSION = '0.1.148';

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

/** The task shape the hub routes return — only the fields the trimmed tool
 *  results read; the wire object carries more. */
interface TaskPayload {
  id: string;
  title: string;
  status: string;
  assignee: string;
  goal: string;
  order: number;
  body?: string;
  quote?: string;
  links?: unknown[];
  transitions?: unknown[];
  after?: string[];
  afterEnforce?: string[];
  archivedAt?: number;
  archivedBy?: string;
  archiveReason?: string;
}

/** Trimmed create/promote result (§3.10: an edit returns ids + status, not
 *  the object the caller just wrote). */
function taskCreatedSummary(
  task: TaskPayload,
  ignoredLinks?: unknown[],
  shapeGaps?: string[],
  placed?: boolean,
) {
  return {
    taskId: task.id,
    goal: task.goal,
    order: task.order,
    status: task.status,
    assignee: task.assignee,
    // Whether the CALLER named a goal — which is not the same question as
    // `goal === 'chores'`, because an explicit 'chores' is a placement and an
    // omitted goal that landed there is not. Only the create call can still
    // tell them apart, so it is the call that has to say.
    ...(placed !== undefined ? { placed } : {}),
    // Advisory, and only on decisions: which parts of the decision shape the
    // body doesn't visibly have. Returned rather than swallowed for the same
    // reason as ignoredLinks — the call succeeded, and the caller is the only
    // one who can still fix it.
    ...(shapeGaps !== undefined && shapeGaps.length > 0 ? { shapeGaps } : {}),
    // A dropped ref has to survive the trip back to the caller or the
    // partial-accept is just a silent loss with extra steps. The route
    // returns it; a summary that omits it is the same "one layer away"
    // failure as a route that doesn't forward a param.
    ...(ignoredLinks !== undefined && ignoredLinks.length > 0 ? { ignoredLinks } : {}),
  };
}

/**
 * ONE implementation of "record the answer to a question on a ticket",
 * reached by two verbs.
 *
 * `answer_decision` is the older one and keeps its exact signature, because a
 * peer's session resolved its bundle at launch and its prompts, skills and
 * habits all name that verb; `answer_review_item` is the entity's. What must
 * NOT happen is two hand-written copies of the routing rule, because that is
 * how two implementations of one act start disagreeing about what was
 * recorded — the same reason the store's `r-legacy` row delegates into
 * `answerDecision` rather than stamping its own answer.
 *
 * No `reviewItemId` means the OLD door, byte for byte, carrying the legacy
 * `optionId` key. That is not a fallback: on a ticket that is itself a
 * decision, the derived review item and the embedded decision are the same
 * question, and `/answer` is where it is answered.
 */
async function recordReviewAnswer(args: {
  taskId: string;
  text: string;
  reviewItemId?: string;
  answeredWith?: string;
}): Promise<{ task: TaskPayload }> {
  const { taskId, text, reviewItemId, answeredWith } = args;
  if (reviewItemId === undefined) {
    return (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/answer`, {
      text,
      ...(answeredWith !== undefined ? { optionId: answeredWith } : {}),
      author: AUTHOR,
    })) as { task: TaskPayload };
  }
  return (await http(
    'POST',
    `/api/tasks/${encodeURIComponent(taskId)}/review-items/${encodeURIComponent(reviewItemId)}/answer`,
    {
      text,
      ...(answeredWith !== undefined ? { answeredWith } : {}),
      author: AUTHOR,
    },
  )) as { task: TaskPayload };
}

/**
 * WHERE a bare `reviewItemId` lives — the lookup that makes the id a
 * universal address across every review-item tool.
 *
 * Two id families, two paths: a derived `rt-…` id IS its address (the triple
 * decodes locally, no round-trip — the doc route it is then used against
 * still 404s a forged one), and a minted `r-…` id is resolved through
 * `GET /api/review-items/:id`, which also names the workspace whose board
 * the item is judged on. The fixed `r-legacy` id is refused there by name —
 * it is on every legacy-decision ticket at once, so alone it addresses
 * nothing; the ticket's own decision is addressed by `taskId` with no
 * `reviewItemId`, as it always was.
 */
async function resolveReviewItemId(
  reviewItemId: string,
): Promise<
  | { kind: 'doc-thread'; docId: string; threadId: string; commentId: string }
  | { kind: 'task-item'; taskId: string; workspaceId?: string }
> {
  const thread = parseThreadReviewItemId(reviewItemId);
  if (thread) return { kind: 'doc-thread', ...thread };
  const res = (await http('GET', `/api/review-items/${encodeURIComponent(reviewItemId)}`)) as {
    taskId: string;
    workspaceId?: string;
  };
  return {
    kind: 'task-item',
    taskId: res.taskId,
    ...(res.workspaceId !== undefined ? { workspaceId: res.workspaceId } : {}),
  };
}

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
function toolContext(): DocsToolContext {
  return {
    http,
    ok,
    err,
    AUTHOR,
    STATUS_TEXT_MAX,
    suggestionAuthor,
    resolveBaseUrl,
    watchers,
    watchDoc,
    watchWorkspace,
    unwatchDoc,
    refreshCoverage,
    watchPersistenceMode,
    restoreState,
    lastPersistError,
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
    // Documents, their threads and the review surfaces over them answer from
    // tools/docs.ts. A domain handler returns `undefined` for a name that is
    // not its own, so the families chain the way the server's route files do.
    const fromDocs = await handleDocsTool(name, a, toolContext());
    if (fromDocs) return fromDocs;
    switch (name) {
      // ── Workspace hub tools (plan §3.10). Results are TRIMMED per the
      // edit-interface conventions: an edit returns ids + status, not the
      // full object the caller just wrote. Mutations that carry authorship
      // send AUTHOR — the same identity every other MCP call uses.
      case 'create_workspace': {
        const {
          name: wsName,
          leadAgentId,
          subscribe,
        } = a as {
          name: string;
          leadAgentId?: string;
          subscribe?: boolean;
        };
        const res = (await http('POST', '/api/workspaces', {
          name: wsName,
          // The creating agent leads the board unless it says otherwise. A
          // board with no lead has nobody to address its asks to.
          leadAgentId: leadAgentId ?? AUTHOR.id,
        })) as {
          workspace: { id: string; name: string; leadAgentId?: string };
        };
        if (subscribe !== false && res.workspace?.id) {
          await watchWorkspace(res.workspace.id);
        }
        return ok({
          workspaceId: res.workspace.id,
          name: res.workspace.name,
          leadAgentId: res.workspace.leadAgentId,
        });
      }
      case 'rename_workspace': {
        const { workspaceId, name: nextName } = a as { workspaceId: string; name: string };
        const res = (await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/rename`,
          { name: nextName, author: AUTHOR },
        )) as {
          changed: boolean;
          workspace: { name: string };
          sameName?: Array<{ workspaceId: string; name: string }>;
        };
        return ok({
          workspaceId,
          name: res.workspace.name,
          changed: res.changed,
          // Only present when the rename LANDED on a name another live board
          // already had. Passed through rather than swallowed: a duplicate
          // name is the failure this verb exists to prevent, and the caller
          // is the only party still in a position to fix it cheaply.
          ...(res.sameName ? { sameName: res.sameName } : {}),
        });
      }
      // Two cases rather than one fall-through, because `tool-wiring.test.ts`
      // reads this switch as SOURCE — `case 'x': {` is how it proves every
      // advertised tool has a handler, and a shared block would hide one of
      // these two from it.
      case 'retire_workspace': {
        const { workspaceId, reason } = a as { workspaceId: string; reason?: string };
        return ok(await setBoardRetired(workspaceId, true, reason));
      }
      case 'unretire_workspace': {
        const { workspaceId } = a as { workspaceId: string };
        return ok(await setBoardRetired(workspaceId, false));
      }
      case 'set_workspace_lead': {
        const { workspaceId, leadAgentId, takeover } = a as {
          workspaceId: string;
          leadAgentId?: string;
          takeover?: boolean;
        };
        // Declaring yourself is attach → subscribe → seat, and hands back the
        // backlog the attach drained. Naming somebody else is the seat alone.
        // See declare-lead.ts for why the order is load-bearing.
        const declared = await declareWorkspaceLead(
          {
            workspaceId,
            ...(leadAgentId !== undefined ? { leadAgentId } : {}),
            ...(takeover === true ? { takeover: true } : {}),
          },
          {
            http,
            watchWorkspace,
            self: AUTHOR,
            // A session without CW_AGENT_NAME is refused before any seat
            // change — as a tool error, not a warning on a success.
            identityIsShared: IDENTITY_IS_SHARED,
            runtime: 'claude-code-local',
            pluginVersion: PLUGIN_VERSION,
            processId: PROCESS_ID,
          },
        );
        return declared.isError === true ? err(String(declared.message)) : ok(declared);
      }
      case 'set_review_item_criteria': {
        const { workspaceId, criteria, reviewItemId } = a as {
          workspaceId?: string;
          criteria?: string;
          reviewItemId?: string;
        };
        let effectiveWorkspaceId = workspaceId;
        if (effectiveWorkspaceId === undefined) {
          if (reviewItemId === undefined) {
            return err(
              'which board? Pass workspaceId, or a reviewItemId — the criteria then land on the board that judges that item',
            );
          }
          // Deliberately the server resolve for BOTH id families: unlike the
          // item-addressed tools, this one needs the containing workspace,
          // which a locally-decoded rt-… triple does not name.
          const res = (await http(
            'GET',
            `/api/review-items/${encodeURIComponent(reviewItemId)}`,
          )) as { workspaceId?: string };
          if (res.workspaceId === undefined) {
            return err(
              "that item's doc is not attached to any workspace, so it names no board — pass workspaceId",
            );
          }
          effectiveWorkspaceId = res.workspaceId;
        }
        const res = (await http(
          'PUT',
          `/api/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/settings`,
          {
            // `null` is the route's spelling of "back to the default"; an
            // omitted or blank string means the same thing to the caller.
            reviewItemCriteria: criteria !== undefined && criteria.trim() !== '' ? criteria : null,
            author: AUTHOR,
          },
        )) as { reviewItemCriteria: { value: string; isDefault: boolean } };
        return ok({
          workspaceId: effectiveWorkspaceId,
          criteria: res.reviewItemCriteria.value,
          isDefault: res.reviewItemCriteria.isDefault,
        });
      }
      case 'attach_doc': {
        const { workspaceId, docId } = a as { workspaceId: string; docId: string };
        const res = (await http('POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/docs`, {
          docId,
        })) as { workspace?: { docIds?: string[] } };
        return ok({ ok: true, workspaceId, docIds: res.workspace?.docIds ?? [] });
      }
      case 'create_tasks': {
        const { workspaceId, tasks, sourceDoc } = a as {
          workspaceId: string;
          tasks: unknown[];
          sourceDoc?: { docId: string; mode?: 'plan' | 'discussion' };
        };
        const res = (await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks/batch`,
          { tasks, author: AUTHOR, ...(sourceDoc !== undefined ? { sourceDoc } : {}) },
        )) as {
          tasks: TaskPayload[];
          failures: Array<{ index: number; title?: string; error: string; message?: string }>;
          ignoredLinks?: Array<{ taskId: string; ignored: unknown[] }>;
          shapeGaps?: Array<{ taskId: string; gaps: string[] }>;
          reviewAdvice?: Array<{ taskId: string; advice: string }>;
          held?: Array<{
            taskId: string;
            reviewItemId: string;
            heldReason: string;
            message: string;
          }>;
          visibility?: Array<{ taskId: string; note: string }>;
          placement?: { unplaced: string[]; goals: unknown[] };
          sourceDoc?: { docId: string; mode: string; held: boolean };
        };
        const gapsFor = (taskId: string) =>
          res.shapeGaps?.find((g) => g.taskId === taskId)?.gaps ?? undefined;
        // Two advice vocabularies on one response, each about its own half:
        // `shapeGaps` describes a decision-shaped BODY, `reviewAdvice` a
        // review item's payload. Renaming the older one would be a narrowing
        // for callers nobody here can restart, so both are forwarded.
        const adviceFor = (taskId: string) =>
          res.reviewAdvice?.find((r) => r.taskId === taskId)?.advice ?? undefined;
        // The row's ACTUAL visibility, stated plainly per row: a triage row
        // is returned by no dispatch read until transitioned, and a filed
        // review item is on the addressee's Home queue regardless of the
        // row's status. Forwarded verbatim — a success-shaped response for an
        // invisible ask is the defect this field exists to close.
        const visibilityFor = (taskId: string) =>
          res.visibility?.find((v) => v.taskId === taskId)?.note ?? undefined;
        const droppedFor = (taskId: string) =>
          res.ignoredLinks?.find((l) => l.taskId === taskId)?.ignored ?? undefined;
        // The quality gate's hold on a review filed WITH the row: the item
        // is on the ticket and OFF the reader's queue, and the same
        // one-layer-away failure applies — a success-shaped row for a hidden
        // ask, with no id to revise. Same fields as add_review_item's.
        const heldFor = (taskId: string) => {
          const h = res.held?.find((r) => r.taskId === taskId);
          return h === undefined
            ? {}
            : { reviewItemId: h.reviewItemId, ...heldResult({ held: true, ...h }) };
        };
        const unplaced = new Set(res.placement?.unplaced ?? []);
        return ok({
          // Board order, carrying the title so the caller can match rows back
          // to what it sent without holding its own index — the returned
          // order is deliberately NOT the order it sent them in.
          created: res.tasks.map((t) => ({
            title: t.title,
            ...taskCreatedSummary(t, droppedFor(t.id), gapsFor(t.id), !unplaced.has(t.id)),
            ...(adviceFor(t.id) !== undefined ? { reviewAdvice: adviceFor(t.id) } : {}),
            ...heldFor(t.id),
            ...(visibilityFor(t.id) !== undefined ? { visibility: visibilityFor(t.id) } : {}),
          })),
          // Always present, even when empty: a caller that has to check for
          // the KEY before checking the count reads "no failures" as "the
          // field is missing because this build doesn't report them".
          failures: res.failures,
          // Absent when every row was placed. One band list for the whole
          // call — the same answer repeated per row in a hundred-row burst
          // is noise, and the rows that need naming are the unplaced ones.
          ...(res.placement !== undefined ? { placement: res.placement } : {}),
          // What the doc gate did with this batch: held:true means every row
          // is a triage draft until the plan doc is approved on its page.
          ...(res.sourceDoc !== undefined ? { sourceDoc: res.sourceDoc } : {}),
        });
      }
      case 'promote_to_task': {
        const {
          docId,
          threadId,
          workspaceId,
          title,
          body,
          assignee,
          assigneeKind,
          needs,
          goal,
          dueAt,
          links,
        } = a as {
          docId: string;
          threadId: string;
          workspaceId: string;
          title?: string;
          body?: string;
          assignee?: string;
          assigneeKind?: 'person' | 'agent';
          needs?: 'action' | 'decision';
          goal?: string;
          dueAt?: number;
          links?: unknown[];
        };
        const res = (await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/promote`,
          {
            workspaceId,
            ...(title !== undefined ? { title } : {}),
            ...(body !== undefined ? { body } : {}),
            ...(assignee !== undefined ? { assignee } : {}),
            ...(assigneeKind !== undefined ? { assigneeKind } : {}),
            ...(needs !== undefined ? { needs } : {}),
            ...(goal !== undefined ? { goal } : {}),
            ...(dueAt !== undefined ? { dueAt } : {}),
            ...(links !== undefined ? { links } : {}),
            author: AUTHOR,
          },
        )) as {
          task: TaskPayload;
          ignoredLinks?: unknown[];
          placement?: { placed: boolean; goals?: unknown[] };
        };
        return ok({
          ...taskCreatedSummary(res.task, res.ignoredLinks, undefined, res.placement?.placed),
          ...(res.placement?.goals !== undefined ? { goals: res.placement.goals } : {}),
          title: res.task.title,
          quote: res.task.quote,
        });
      }
      case 'get_workspace': {
        const { workspaceId } = a as { workspaceId: string };
        const res = (await http('GET', `/api/workspaces/${encodeURIComponent(workspaceId)}`)) as {
          workspace: {
            id: string;
            name: string;
            leadAgentId?: string;
            reviewItemCriteria?: string;
          };
          goalSummary: unknown[];
          parallelismCap?: {
            value: number;
            isDefault: boolean;
            inUse: number;
            free: number;
            lastChange?: {
              actor: { id: string; name: string; kind?: string };
              ts: number;
              from: number;
              to: number;
            };
          };
          retired?: { since: number; reason?: string; notice: string };
        };
        return ok({
          workspaceId: res.workspace.id,
          name: res.workspace.name,
          // How many builders this board may run, how many it is running —
          // and, once somebody has moved the cap, who, when, from what. A
          // lowered cap with no author is a mystery the lead goes looking
          // for; here it is a fact with a name on it.
          ...(res.parallelismCap !== undefined ? { parallelismCap: res.parallelismCap } : {}),
          // Absent means nobody is responsible for this board — its asks
          // have no addressee until someone attaches or takes the seat.
          leadAgentId: res.workspace.leadAgentId,
          // The board's OWN criteria for the review-item quality gate, when
          // somebody has written some; absent means the default applies.
          ...(res.workspace.reviewItemCriteria !== undefined
            ? { reviewItemCriteria: res.workspace.reviewItemCriteria }
            : {}),
          // Present only when this board has been stood down. Carried FIRST
          // in spirit even though it reads last: an agent that got this far
          // is about to decide what to work on, and a retired board's goal
          // list looks exactly like a live one's.
          ...(res.retired ? { retired: res.retired } : {}),
          goals: res.goalSummary,
        });
      }
      case 'next_tasks': {
        const { workspaceId, assignee, limit, includeBlocked, includeArchived } = a as {
          workspaceId: string;
          assignee?: string;
          limit?: number;
          includeBlocked?: boolean;
          includeArchived?: boolean;
        };
        const qs = new URLSearchParams();
        if (assignee !== undefined) qs.set('assignee', assignee);
        if (limit !== undefined) qs.set('limit', String(limit));
        if (includeBlocked === true) qs.set('includeBlocked', 'true');
        if (includeArchived === true) qs.set('includeArchived', 'true');
        const query = qs.size > 0 ? `?${qs.toString()}` : '';
        const res = (await http(
          'GET',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/next${query}`,
        )) as { tasks: unknown[]; retired?: { since: number; reason?: string; notice: string } };
        // This is the "what should I do next" call, so a retired board has to
        // say so HERE — the queue still ranks (in-flight work is finishable)
        // and would otherwise read exactly like a live board's.
        return ok({
          workspaceId,
          ...(res.retired ? { retired: res.retired } : {}),
          tasks: res.tasks,
        });
      }
      case 'list_tasks': {
        const { workspaceId, goal, status, assignee, needs, fields, includeArchived } = a as {
          workspaceId: string;
          goal?: string;
          status?: string;
          assignee?: string;
          needs?: string;
          fields?: string[];
          includeArchived?: boolean;
        };
        const qs = new URLSearchParams();
        if (goal !== undefined) qs.set('goal', goal);
        if (status !== undefined) qs.set('status', status);
        if (assignee !== undefined) qs.set('assignee', assignee);
        if (needs !== undefined) qs.set('needs', needs);
        if (includeArchived === true) qs.set('includeArchived', 'true');
        const query = qs.size > 0 ? `?${qs.toString()}` : '';
        const res = (await http(
          'GET',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks${query}`,
        )) as { tasks: TaskPayload[] };
        // Trimmed handler-side, NOT at the route — an old bundle keeps
        // calling the REST route forever and must keep reading its shape.
        // Default: no body snapshot, no transition history. With `fields`:
        // exactly the picked keys per row.
        return ok({
          workspaceId,
          tasks: projectTaskRows(res.tasks, fields),
        });
      }
      case 'task_transition': {
        const { taskId, to, note, usage } = a as {
          taskId: string;
          to: string;
          note?: string;
          usage?: { inputTokens: number; outputTokens: number };
        };
        // WHO IS ALREADY ON THIS ROW — read BEFORE the move, because after it
        // the latest claim is this session's own. Only on a pickup: the
        // question is meaningless on a move to done or back to todo, and a
        // second GET on every transition would be a cost with no reader.
        //
        // Best-effort by construction. It is a warning, so a presence read
        // that fails must never take the transition with it — an agent that
        // cannot claim a task because the advisory read 500'd is strictly
        // worse off than one that claims it uninformed.
        const claimNotice = to === 'in-progress' ? await claimNoticeFor(taskId) : undefined;
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/transition`, {
          to,
          author: AUTHOR,
          ...(note !== undefined ? { note } : {}),
          ...(usage !== undefined ? { usage } : {}),
        })) as { task: TaskPayload; blockers: unknown[] };
        return ok({
          taskId,
          status: res.task.status,
          blockers: res.blockers,
          // Additive and advisory. The status code, the refusal semantics and
          // every other field are untouched — an old bundle calling this from
          // a session that cannot restart reads exactly what it always did,
          // which is the compat question CLAUDE.md says to ask at a
          // narrowing: there IS a caller that cannot be restarted, so nothing
          // narrows.
          ...(claimNotice !== undefined ? { warning: claimNotice } : {}),
        });
      }
      case 'assign_task': {
        const { taskId, assignee, assigneeKind } = a as {
          taskId: string;
          assignee: string;
          assigneeKind?: 'person' | 'agent';
        };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/assignee`, {
          assignee,
          ...(assigneeKind !== undefined ? { assigneeKind } : {}),
          author: AUTHOR,
        })) as { task: TaskPayload; changed: boolean; ownerKind?: string };
        // `ownerKind` is what the BOARD now says this owner is — the answer
        // the caller actually wanted, and not the same as "the call didn't
        // error". `unknown` here means the row will draw as "not recorded":
        // say `assigneeKind` and call again.
        return ok({
          taskId,
          assignee: res.task.assignee,
          changed: res.changed,
          ...(res.ownerKind !== undefined ? { ownerKind: res.ownerKind } : {}),
        });
      }
      case 'park_task': {
        const { taskId, until, reason } = a as {
          taskId: string;
          until?: number | string | null;
          reason?: string;
        };
        // A date STRING is normalized here rather than at the route, which
        // stays strict: this layer is where an agent's natural spelling
        // ("2026-09-02") becomes the number, and where a typo becomes a
        // refusal the caller can read instead of a park on the wrong day.
        //
        // Three cases, and the middle one is why they are told apart at all.
        // `until: null` used to mean "un-park now" and older bundles still
        // send it that way, so it is forwarded AS null and the route answers
        // that it does nothing. Omitting `until` is the new spelling for
        // "no revisit date" — a shape no old caller emits, because the old
        // schema required the field.
        let parkedUntil: number | null | undefined;
        if (until === undefined) {
          parkedUntil = undefined;
        } else if (until === null) {
          parkedUntil = null;
        } else if (typeof until === 'number') {
          if (!Number.isFinite(until)) return err('until must be a date, or omitted');
          parkedUntil = until;
        } else {
          const parsed = Date.parse(until);
          if (Number.isNaN(parsed)) {
            return err(
              `could not read "${until}" as a date — pass epoch ms, "YYYY-MM-DD", or a full ISO timestamp`,
            );
          }
          parkedUntil = parsed;
        }
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/park`, {
          ...(parkedUntil !== undefined ? { parkedUntil } : {}),
          ...(reason !== undefined ? { reason } : {}),
          author: AUTHOR,
        })) as {
          task: TaskPayload;
          changed: boolean;
          commented: boolean;
          message?: string;
        };
        // The STORED status back, not an echo of what was sent, and whether
        // the comment actually landed — the comment IS the record now, so a
        // park that moved the row and wrote nothing is a park that lost the
        // reason, and the caller has to be able to see that.
        return ok({
          taskId,
          status: res.task.status,
          moved: res.changed,
          commented: res.commented,
          ...(res.message !== undefined ? { message: res.message } : {}),
        });
      }
      case 'archive_task': {
        const { taskId, reason } = a as { taskId: string; reason?: string };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/archive`, {
          ...(reason !== undefined ? { reason } : {}),
          author: AUTHOR,
        })) as { task: TaskPayload; changed: boolean };
        // The STORED stamps back rather than an echo of what was sent:
        // `changed: false` is the honest answer to archiving a row that was
        // already archived, and reading it beats inferring anything from a
        // 200.
        return ok({
          taskId,
          archivedAt: res.task.archivedAt ?? null,
          ...(res.task.archiveReason !== undefined
            ? { archiveReason: res.task.archiveReason }
            : {}),
          changed: res.changed,
        });
      }
      case 'unarchive_task': {
        const { taskId } = a as { taskId: string };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/restore`, {
          author: AUTHOR,
        })) as { task: TaskPayload; changed: boolean };
        return ok({
          taskId,
          goal: res.task.goal,
          status: res.task.status,
          changed: res.changed,
        });
      }
      case 'rewrite_task': {
        const { taskId, title, body, reason } = a as {
          taskId: string;
          title?: string;
          body?: string;
          reason?: string;
        };
        if (body === undefined && title === undefined) {
          return err('nothing to rewrite — pass title, body, or both');
        }
        if (body !== undefined) {
          // Body (with or without a title): one attributed act through the
          // /body route — ONE task.body_edited carrying both titles when the
          // same call renamed the row.
          const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/body`, {
            markdown: body,
            ...(title !== undefined ? { title } : {}),
            ...(reason !== undefined ? { reason } : {}),
            author: AUTHOR,
          })) as { task: TaskPayload };
          // `quote` back, because this call is the one that can have filled
          // it: the caller sees the words it just preserved without a second
          // read.
          return ok({
            taskId,
            title: res.task?.title,
            body: res.task?.body,
            quote: res.task?.quote,
          });
        }
        // Title-only: the /title route, which emits an attributed
        // task.retitled when the name actually moves.
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/title`, {
          title,
          ...(reason !== undefined ? { reason } : {}),
          author: AUTHOR,
        })) as { task: TaskPayload; changed?: boolean };
        return ok({ taskId, title: res.task?.title, changed: res.changed ?? false });
      }
      case 'set_task_goal': {
        const { taskId, goal, position, batchId } = a as {
          taskId: string;
          goal: string;
          position?: number;
          batchId?: string;
        };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/goal`, {
          goal,
          author: AUTHOR,
          ...(position !== undefined ? { position } : {}),
          ...(batchId !== undefined ? { batchId } : {}),
        })) as { task: TaskPayload; changed: boolean };
        return ok({ taskId, goal: res.task.goal, order: res.task.order, changed: res.changed });
      }
      case 'set_goal_list': {
        const { workspaceId, goals, drop } = a as {
          workspaceId: string;
          goals: unknown[];
          drop?: string[];
        };
        const res = (await http('PUT', `/api/workspaces/${encodeURIComponent(workspaceId)}/goals`, {
          goals,
          ...(drop !== undefined ? { drop } : {}),
          author: AUTHOR,
        })) as {
          changed: boolean;
          created: Array<{ id: string; title: string }>;
          movedToChores: string[];
          strandedDone: string[];
          bucketReview?: {
            requested: boolean;
            queued: boolean;
            taskIds: string[];
            newBands: Array<{ id: string; title: string }>;
            batchId?: string;
          };
        };
        return ok({
          workspaceId,
          changed: res.changed,
          // The ONLY place a caller learns the id of a band it just created —
          // it never chose one. Dropping this here would make the create
          // gesture unusable while every layer under it reported success.
          created: res.created,
          movedToChores: res.movedToChores,
          // Reported so the caller sees the half that used to be silent —
          // done tasks left pointing at an id the list no longer has.
          strandedDone: res.strandedDone,
          // Adding a band asks the LEAD to re-look at the unknown-goal
          // bucket: `taskIds` is that bucket, `requested` says it reached
          // them live, `queued` says it is waiting for their next attach.
          // Nothing was placed — the ask is to look.
          ...(res.bucketReview ? { bucketReview: res.bucketReview } : {}),
        });
      }
      case 'rename_goal': {
        const { workspaceId, goal, title, dueAt } = a as {
          workspaceId: string;
          goal: string;
          title: string;
          dueAt?: number | null;
        };
        const res = (await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/goals/rename`,
          {
            goal,
            title,
            ...(dueAt !== undefined ? { dueAt } : {}),
            author: AUTHOR,
          },
        )) as { changed: boolean; goal: { id: string; title: string; dueAt?: number } };
        return ok({ workspaceId, goal: res.goal, changed: res.changed });
      }
      case 'reorder_goals': {
        const { workspaceId, order } = a as {
          workspaceId: string;
          order: string[];
        };
        const res = (await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/goals/reorder`,
          { order, author: AUTHOR },
        )) as { changed: boolean; order: string[] };
        return ok({
          workspaceId,
          order: res.order,
          changed: res.changed,
        });
      }
      case 'add_review_item': {
        const { taskId, review } = a as { taskId: string; review: unknown };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/review-items`, {
          review,
          author: AUTHOR,
        })) as {
          item?: { id?: string };
          reviewAdvice?: string;
          held?: boolean;
          heldReason?: string;
          message?: string;
        };
        return ok({
          taskId,
          reviewItemId: res.item?.id,
          // The gaps the server found in the shape. Dropping it here is the
          // "one layer away from where it's consumed" failure: the server
          // computed the advice, and the only party that can still act on it
          // never hears it.
          ...(res.reviewAdvice !== undefined ? { reviewAdvice: res.reviewAdvice } : {}),
          // The quality gate's verdict, when it held the item. Same failure
          // if dropped: the item is on the ticket and off the queue, and the
          // filer would read a bare id as "filed".
          ...heldResult(res),
        });
      }
      case 'answer_review_item': {
        const { taskId, reviewItemId, text, answeredWith } = a as {
          taskId?: string;
          reviewItemId?: string;
          text: string;
          answeredWith?: string;
        };
        let effectiveTaskId = taskId;
        if (effectiveTaskId === undefined) {
          if (reviewItemId === undefined) {
            return err(
              'which item? Pass its reviewItemId (from the queue row or the ticket), or taskId — alone for a ticket that is itself a decision, with reviewItemId for one of the items filed on it',
            );
          }
          const address = await resolveReviewItemId(reviewItemId);
          // An item raised on a doc thread records its answer where the ask
          // lives — the same door the reader's own tap goes through.
          if (address.kind === 'doc-thread') {
            await http(
              'POST',
              `/api/docs/${encodeURIComponent(address.docId)}/threads/${encodeURIComponent(
                address.threadId,
              )}/answer`,
              {
                text,
                commentId: address.commentId,
                ...(answeredWith !== undefined ? { optionId: answeredWith } : {}),
                author: AUTHOR,
              },
            );
            return ok({
              reviewItemId,
              docId: address.docId,
              threadId: address.threadId,
              commentId: address.commentId,
              recorded: true,
            });
          }
          effectiveTaskId = address.taskId;
        }
        const res = await recordReviewAnswer({
          taskId: effectiveTaskId,
          text,
          ...(reviewItemId !== undefined ? { reviewItemId } : {}),
          ...(answeredWith !== undefined ? { answeredWith } : {}),
        });
        return ok({
          taskId: effectiveTaskId,
          ...(reviewItemId !== undefined ? { reviewItemId } : {}),
          recorded: true,
          links: res.task.links ?? [],
        });
      }
      case 'revise_review_item': {
        const {
          taskId,
          reviewItemId,
          docId,
          threadId,
          commentId,
          headline,
          detail,
          options,
          reply,
          revisedRange,
        } = a as {
          taskId?: string;
          reviewItemId?: string;
          docId?: string;
          threadId?: string;
          commentId?: string;
          headline?: string;
          detail?: string;
          options?: unknown;
          reply?: string;
          revisedRange?: { start: number; end: number };
        };
        // The correction itself is the same words on either surface; only the
        // handle differs, so the patch is built once and posted at whichever
        // address the caller named.
        const patch = {
          ...(headline !== undefined ? { headline } : {}),
          ...(detail !== undefined ? { detail } : {}),
          ...(options !== undefined ? { options } : {}),
          ...(revisedRange !== undefined ? { revisedRange } : {}),
          author: AUTHOR,
        };
        // An item raised on a doc thread is a review payload on a COMMENT, so
        // it is addressed (docId, threadId, commentId) — three ids, all or
        // none. Half an address is a caller who meant one surface and mistyped
        // it; picking a surface for them would revise an item nobody named.
        if (docId !== undefined || threadId !== undefined || commentId !== undefined) {
          if (taskId !== undefined || reviewItemId !== undefined) {
            return err(
              'two addresses in one call — pass taskId + reviewItemId for an item on a ticket, or docId + threadId + commentId for one raised on a doc thread, not both',
            );
          }
          if (docId === undefined || threadId === undefined || commentId === undefined) {
            return err(
              'the doc-thread form needs all three of docId + threadId + commentId — commentId is the thread.comments[].id that create_thread / post_reply returned when you raised the item',
            );
          }
          // Dropping it silently would lose the one sentence the caller wrote
          // for a person to read.
          if (reply !== undefined) {
            return err(
              '`reply` is ticket-only — a doc-thread item already lives in its thread, so point at the change there with post_reply',
            );
          }
          const docRes = (await http(
            'POST',
            `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/revise`,
            { ...patch, commentId },
          )) as { held?: boolean; heldReason?: string; message?: string };
          // The hold, forwarded. This used to be dropped with a comment
          // saying the doc route runs no gate — true when it was written and
          // false since the gate reached this surface, which left a filer
          // reading `revised: true` for an item the queue still omits.
          return ok({ docId, threadId, commentId, revised: true, ...heldResult(docRes) });
        }
        let effectiveTaskId = taskId;
        if (effectiveTaskId === undefined) {
          if (reviewItemId === undefined) {
            return err(
              'which item? A bare reviewItemId (from the queue row or the ticket), taskId (+ reviewItemId for one of the items filed on the ticket), or docId + threadId + commentId for one raised on a doc thread',
            );
          }
          // The universal address: the id alone says where the item lives.
          const address = await resolveReviewItemId(reviewItemId);
          if (address.kind === 'doc-thread') {
            if (reply !== undefined) {
              return err(
                '`reply` is ticket-only — a doc-thread item already lives in its thread, so point at the change there with post_reply',
              );
            }
            const docRes = (await http(
              'POST',
              `/api/docs/${encodeURIComponent(address.docId)}/threads/${encodeURIComponent(
                address.threadId,
              )}/revise`,
              { ...patch, commentId: address.commentId },
            )) as { held?: boolean; heldReason?: string; message?: string };
            return ok({
              reviewItemId,
              docId: address.docId,
              threadId: address.threadId,
              commentId: address.commentId,
              revised: true,
              ...heldResult(docRes),
            });
          }
          effectiveTaskId = address.taskId;
        }
        // `reviewItemId` omitted means the TICKET'S OWN decision — the row
        // whose words are the ticket's title, body and options, and which has
        // no item id of its own. The same shape `answer_decision` has always
        // taken for the same row, and the address a hold on it hands back.
        // `reply` is refused there for the doc form's reason inverted: the
        // ticket's decision has no item thread of its own to answer on.
        if (reviewItemId === undefined && reply !== undefined) {
          return err(
            "`reply` needs an item thread to land on, and a ticket's own decision has none — revise without `reply`, then point at the change with post_reply on the task",
          );
        }
        const targetItemId = reviewItemId ?? 'r-legacy';
        const res = (await http(
          'POST',
          `/api/tasks/${encodeURIComponent(effectiveTaskId)}/review-items/${encodeURIComponent(targetItemId)}/revise`,
          { ...patch, ...(reply !== undefined ? { reply } : {}) },
        )) as {
          threadId?: string;
          reviewAdvice?: string;
          held?: boolean;
          heldReason?: string;
          message?: string;
        };
        return ok({
          taskId: effectiveTaskId,
          ...(reviewItemId !== undefined ? { reviewItemId } : { decision: true }),
          revised: true,
          ...(res.threadId !== undefined ? { threadId: res.threadId } : {}),
          ...(reply !== undefined && res.threadId !== undefined ? { replied: true } : {}),
          ...(res.reviewAdvice !== undefined ? { reviewAdvice: res.reviewAdvice } : {}),
          // Re-judged on every revision; still held means still off the queue.
          ...heldResult(res),
        });
      }
      case 'withdraw_review_item': {
        const { reviewItemId, taskId, docId, threadId, commentId, reason, undo } = a as {
          reviewItemId?: string;
          taskId?: string;
          docId?: string;
          threadId?: string;
          commentId?: string;
          reason?: string;
          undo?: boolean;
        };
        const body = { author: AUTHOR, ...(reason !== undefined ? { reason } : {}) };
        const docWithdraw = async (address: {
          docId: string;
          threadId: string;
          commentId: string;
        }) => {
          await http(
            'POST',
            `/api/docs/${encodeURIComponent(address.docId)}/threads/${encodeURIComponent(
              address.threadId,
            )}/withdraw${undo ? '/undo' : ''}`,
            { ...body, commentId: address.commentId },
          );
          return ok({
            ...(reviewItemId !== undefined ? { reviewItemId } : {}),
            ...address,
            withdrawn: undo !== true,
          });
        };
        if (reviewItemId !== undefined) {
          if (docId !== undefined || threadId !== undefined || commentId !== undefined) {
            return err(
              'two addresses in one call — pass reviewItemId alone (it carries its own address), or the docId + threadId + commentId triple, not both',
            );
          }
          // A caller who already knows the ticket skips the resolve
          // round-trip; a bare minted id is looked up first.
          const address =
            taskId !== undefined
              ? { kind: 'task-item' as const, taskId }
              : await resolveReviewItemId(reviewItemId);
          if (address.kind === 'doc-thread') return docWithdraw(address);
          await http(
            'POST',
            `/api/tasks/${encodeURIComponent(address.taskId)}/review-items/${encodeURIComponent(
              reviewItemId,
            )}/withdraw${undo ? '/undo' : ''}`,
            body,
          );
          return ok({ taskId: address.taskId, reviewItemId, withdrawn: undo !== true });
        }
        // The original doc-thread address, byte for byte — the callers that
        // learned it from the thread they raised keep working unchanged.
        if (docId === undefined || threadId === undefined || commentId === undefined) {
          return err(
            'which item? Pass its reviewItemId (from the queue row or the ticket), or the full docId + threadId + commentId triple for one raised on a doc thread',
          );
        }
        return docWithdraw({ docId, threadId, commentId });
      }
      case 'request_more_info': {
        const { taskId, reviewItemId, question } = a as {
          taskId?: string;
          reviewItemId?: string;
          question: string;
        };
        let effectiveTaskId = taskId;
        if (effectiveTaskId === undefined) {
          if (reviewItemId === undefined) {
            return err(
              'which item? Pass its reviewItemId (from the queue row or the ticket), or taskId — alone for a ticket that is itself a decision, with reviewItemId for one of the items filed on it',
            );
          }
          // Resolved through the SERVER even for a decodable rt-… id, unlike
          // the sibling tools: they hand a decoded address to a doc route
          // that itself refuses a comment carrying no review, while this
          // branch posts an ORDINARY reply — so if the item's existence is
          // not checked here, a stale or forged id would land a question on
          // whatever unrelated thread it happens to name (codex review).
          const address = (await http(
            'GET',
            `/api/review-items/${encodeURIComponent(reviewItemId)}`,
          )) as
            | { kind: 'doc-thread'; docId: string; threadId: string }
            | { kind: 'task-item'; taskId: string };
          // A doc-thread item's conversation IS its thread — asking back is a
          // reply there, where the asker is already listening. No answer is
          // stamped, so the item stays open and stays on the queue, exactly
          // as the ticket form's info request does.
          if (address.kind === 'doc-thread') {
            await http(
              'POST',
              `/api/docs/${encodeURIComponent(address.docId)}/threads/${encodeURIComponent(
                address.threadId,
              )}/comments`,
              { author: AUTHOR, text: question },
            );
            return ok({
              reviewItemId,
              docId: address.docId,
              threadId: address.threadId,
              asked: true,
            });
          }
          effectiveTaskId = address.taskId;
        }
        const path =
          reviewItemId === undefined
            ? `/api/tasks/${encodeURIComponent(effectiveTaskId)}/more-info`
            : `/api/tasks/${encodeURIComponent(effectiveTaskId)}/review-items/${encodeURIComponent(reviewItemId)}/more-info`;
        const res = (await http('POST', path, { question, author: AUTHOR })) as {
          task: TaskPayload;
        };
        return ok({
          taskId: effectiveTaskId,
          ...(reviewItemId !== undefined ? { reviewItemId } : {}),
          asked: true,
          links: res.task.links ?? [],
        });
      }
      case 'answer_decision': {
        const { taskId, text, optionId, reviewItemId } = a as {
          taskId: string;
          text: string;
          optionId?: string;
          reviewItemId?: string;
        };
        // `optionId` is the legacy spelling of `answeredWith`; one helper
        // decides which door to knock on so the two verbs cannot drift into
        // two answers of the same act.
        const res = await recordReviewAnswer({
          taskId,
          text,
          ...(reviewItemId !== undefined ? { reviewItemId } : {}),
          ...(optionId !== undefined ? { answeredWith: optionId } : {}),
        });
        return ok({ taskId, recorded: true, links: res.task.links ?? [] });
      }
      case 'set_task_dependencies': {
        const { taskId, after, afterEnforce } = a as {
          taskId: string;
          after: string[];
          afterEnforce?: string[];
        };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/after`, {
          after,
          ...(afterEnforce !== undefined ? { afterEnforce } : {}),
          author: AUTHOR,
        })) as { task: TaskPayload; changed: boolean };
        return ok({
          taskId,
          changed: res.changed,
          after: res.task.after ?? [],
          afterEnforce: res.task.afterEnforce ?? [],
        });
      }
      case 'import_tasks_markdown': {
        const { workspaceId, path, apply } = a as {
          workspaceId: string;
          path: string;
          apply?: boolean;
        };
        // The route result is already the trimmed shape: the mapping on a
        // dry-run; ids + titles + counts (never full task objects) on apply.
        const res = await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/import-tasks`,
          { path, ...(apply !== undefined ? { apply } : {}), author: AUTHOR },
        );
        return ok(res);
      }
      case 'link_refs': {
        const { taskId, ref } = a as { taskId: string; ref: unknown };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/links`, {
          ref,
        })) as { changed: boolean };
        return ok({ taskId, changed: res.changed });
      }
      case 'list_backlinks': {
        const { ref } = a as { ref: unknown };
        const res = (await http('POST', '/api/refs/backlinks', { ref })) as {
          tasks: unknown[];
        };
        return ok({ ref, tasks: res.tasks });
      }
      case 'unlink_refs': {
        const { taskId, ref } = a as { taskId: string; ref: unknown };
        const res = (await http('DELETE', `/api/tasks/${encodeURIComponent(taskId)}/links`, {
          ref,
        })) as { changed: boolean };
        return ok({ taskId, changed: res.changed });
      }
      case 'attach_agent': {
        const { workspaceId, agentId, runtime, capabilities, subscribe } = a as {
          workspaceId: string;
          agentId?: string;
          runtime?: string;
          capabilities?: string[];
          subscribe?: boolean;
        };
        const res = (await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`,
          {
            agentId: agentId ?? AUTHOR.id,
            // Only when attaching as ITSELF: the roster row for somebody
            // else's id must not be named after this session.
            ...(agentId === undefined || agentId === AUTHOR.id ? { agentName: AUTHOR.name } : {}),
            runtime: runtime ?? 'claude-code-local',
            ...(capabilities !== undefined ? { capabilities } : {}),
            // What this session can actually DO is decided by the bundle it
            // loaded at launch, not by what its machine's cache holds now.
            // Reporting it is what lets the board say a merge never arrived.
            pluginVersion: PLUGIN_VERSION,
            // Same-process re-attaches must not re-hand rows still in
            // flight to this very process — see PROCESS_ID.
            processId: PROCESS_ID,
          },
        )) as {
          attachment?: { agentId?: string };
          gating?: unknown;
          untriaged?: string[];
          queuedVoice?: Array<{ transcript: string; ts: number; applied?: string }>;
          queuedComments?: Array<{
            id: string;
            docId: string;
            threadId?: string;
            event: string;
            author?: { id?: string; name?: string };
            text: string;
            ts: number;
          }>;
          lead?: boolean;
          retired?: { since: number; reason?: string; notice: string };
          leadNameConflicts?: {
            boards: Array<{ workspaceId: string; name: string }>;
            notice: string;
          };
          seat?: {
            leadAgentId?: string;
            live: boolean;
            stale: boolean;
            unattached?: boolean;
            notice?: string;
          };
          seatTakenFrom?: string;
          watching?: number;
          notes?: string[];
        };
        // Only when this session attached as ITSELF: the keepalive proves
        // THIS process is alive, and refreshing somebody else's attachment
        // from here would assert liveness for an agent that may be gone.
        if (agentId === undefined || agentId === AUTHOR.id) markAttached(workspaceId);
        if (subscribe !== false) await watchWorkspace(workspaceId);
        // These rows are now in this process's hands — this response is their
        // delivery — so send each receipt. Unlike queuedVoice the server did
        // NOT drain them: a row it holds until this ack is a row a crash
        // between the attach and here re-offers after the grace window,
        // instead of losing with the response body.
        for (const q of res.queuedComments ?? []) {
          if (typeof q?.id !== 'string') continue;
          try {
            await http(
              'POST',
              `/api/workspaces/${encodeURIComponent(workspaceId)}/comment-queue/${encodeURIComponent(q.id)}/ack`,
              {},
            );
          } catch {
            // Left on the queue on purpose — redelivered after the grace.
          }
        }
        return ok({
          workspaceId,
          agentId: res.attachment?.agentId ?? agentId ?? AUTHOR.id,
          // THE BOARD YOU JUST ATTACHED TO HAS BEEN STOOD DOWN. It takes no
          // new work and is not ranked; read the notice before you plan
          // anything here. First in the payload because a retired board's
          // gating, queues and untriaged list all read exactly like a live
          // board's, and by the time you reach them you have already decided
          // to work here.
          ...(res.retired ? { retired: res.retired } : {}),
          // YOU LEAD ANOTHER LIVE BOARD WITH THE SAME NAME. Two boards, one
          // name, one lead is how a session works the stale one for a night
          // and misses the goals on the live one — it happened, which is why
          // this field exists. Read both goal lists, then rename or retire
          // whichever is not the live board before doing anything else.
          ...(res.leadNameConflicts ? { leadNameConflicts: res.leadNameConflicts } : {}),
          gating: res.gating,
          // Are you the board's LEAD agent? True if you already held the seat
          // or just claimed an empty one. The lead is the addressee for
          // anything this board needs a responsible party for.
          lead: res.lead ?? false,
          untriaged: res.untriaged ?? [],
          // Voice change-requests that arrived while no agent was live
          // ("agent away — queued"): this attach is their delivery. Act on
          // each transcript, verbatim — EXCEPT for the part named by
          // `applied`, which the voice fast path already did to the board on
          // the speaker's behalf. Pick up only what the utterance asked for
          // beyond it; redoing it posts the same words twice.
          queuedVoice: res.queuedVoice ?? [],
          // Comments addressed to YOU that arrived while your stream was
          // down — a person (or peer) commented on a task or doc you watch or
          // lead, and nobody was listening. Read each and act on it where it
          // lives (post_reply on the thread / resolve when addressed). This
          // response is their delivery; the receipts are already sent.
          queuedComments: (res.queuedComments ?? []).map((q) => ({
            docId: q.docId,
            ...(q.threadId !== undefined ? { threadId: q.threadId } : {}),
            event: q.event,
            ...(q.author !== undefined ? { author: q.author } : {}),
            text: q.text,
            ts: q.ts,
          })),
          // WHAT THIS ATTACH DID NOT GIVE YOU. A session that respawns under
          // a new name attaches successfully and comes up with no watches and
          // no seat, and the success is all it was ever told — which is how a
          // board went four and a half hours with its asks reaching nobody.
          // These three fields are that silence made readable, and `notes`
          // says in words what to do about it. Absent from an older server.
          ...(res.notes !== undefined && res.notes.length > 0 ? { notes: res.notes } : {}),
          ...(res.watching !== undefined ? { watching: res.watching } : {}),
          // The board's lead seat as it stands now, INCLUDING when somebody
          // else holds it: `stale` means its holder has stopped answering, so
          // nothing addressed to the lead is arriving.
          ...(res.seat !== undefined ? { seat: res.seat } : {}),
          // This attach TOOK the seat from a holder that was gone. Say so
          // wherever you report in — a handover is not a detail.
          ...(res.seatTakenFrom !== undefined ? { seatTakenFrom: res.seatTakenFrom } : {}),
        });
      }
      case 'heartbeat': {
        const { workspaceId, agentId, toolCallAt } = a as {
          workspaceId: string;
          agentId?: string;
          toolCallAt?: number;
        };
        const res = (await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(agentId ?? AUTHOR.id)}/heartbeat`,
          // The heartbeat call is itself a tool call — stamp the work clock
          // too unless the caller reports an explicit (earlier) time.
          { toolCallAt: toolCallAt ?? Date.now() },
        )) as { attachment?: { state?: string } };
        if (agentId === undefined || agentId === AUTHOR.id) markAttached(workspaceId);
        return ok({ workspaceId, agentId: agentId ?? AUTHOR.id, state: res.attachment?.state });
      }
      case 'get_unfiled_ask_count': {
        const { agent } = a as { agent?: string };
        const who = agent?.trim() || AUTHOR.name;
        return ok(await http('GET', `/api/chat-audit/${encodeURIComponent(who)}`));
      }
      case 'publish_chat_audit': {
        const { day, entries } = a as {
          day?: string;
          entries: Array<{
            agent: string;
            unfiledAsks: number;
            totalAsks?: number;
            sessionId?: string;
            note?: string;
          }>;
        };
        return ok(
          await http('POST', '/api/chat-audit', {
            ...(day !== undefined ? { day } : {}),
            auditor: AUTHOR.name,
            entries,
          }),
        );
      }
      case 'register_dispatch': {
        const { taskId, worktreePath } = a as { taskId: string; worktreePath: string };
        return ok(await http('POST', '/api/dispatches', { taskId, worktreePath }));
      }
      case 'close_dispatch': {
        const { taskId } = a as { taskId: string };
        return ok(await http('DELETE', `/api/dispatches/${encodeURIComponent(taskId)}`));
      }
      case 'set_parallelism_cap': {
        const { workspaceId, cap: rawCap } = a as { workspaceId: string; cap: unknown };
        // Refuse a bad cap here, with a sentence, rather than relaying the
        // route's 400 as a thrown status. Nothing is sent for a value that
        // could never land.
        const parsed = parseCapArg(rawCap);
        if (!parsed.ok) return err(parsed.error);
        // The same PUT the board's panel and Team Lead's REST calls use, so
        // the change is recorded through the one store method with THIS
        // agent as the actor — `author: AUTHOR`, as every write tool sends.
        const res = (await http(
          'PUT',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/parallelism-cap`,
          { cap: parsed.cap, author: AUTHOR },
        )) as {
          cap: number;
          isDefault: boolean;
          default: number;
          inUse: number;
          free: number;
          holders: Array<{ taskId: string; title?: string; agentName?: string }>;
          lastChange?: { actor: unknown; ts: number; from: number; to: number };
        };
        return ok({
          workspaceId,
          cap: res.cap,
          isDefault: res.isDefault,
          default: res.default,
          inUse: res.inUse,
          free: res.free,
          holders: res.holders,
          lastChange: res.lastChange,
        });
      }
      case 'request_plugin_refresh': {
        // No arguments reach the process this runs — the server's argv is
        // fixed. Nothing a caller can send gets spawned.
        return ok(await http('POST', '/api/plugin/refresh'));
      }
      case 'list_attachments': {
        const { workspaceId } = a as { workspaceId: string };
        const res = await http(
          'GET',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`,
        );
        return ok(res);
      }
      default:
        return err(`unknown tool: ${name}`);
    }
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

interface Watcher {
  controller: AbortController;
  docId: string;
  /**
   * Whether this watcher's stream is CURRENTLY connected — not whether a
   * watcher object exists.
   *
   * The two used to be conflated, and that is how a tool could answer
   * `subscribed: true` while its loop sat in backoff after a refused connect.
   * The loop maintains this; a caller that needs to tell a live subscription
   * from a registered intention reads it rather than the map's `has`.
   */
  open: boolean;
}
const watchers = new Map<string, Watcher>();

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

const IDENTITY_IS_SHARED = AUTHOR.id === 'known-agent';
const SHARED_IDENTITY_REASON =
  'CW_AGENT_NAME is not set, so this session has no identity to key its watches on; ' +
  'they will not survive a restart. Set it in the launch environment and restart the session.';

let restoreState: RestoreState = IDENTITY_IS_SHARED
  ? { status: 'session-only', from: 'session', restored: [], pruned: [], attempts: 0 }
  : { status: 'pending', from: 'session', restored: [], pruned: [], attempts: 0 };
let restoreInFlight: Promise<void> | null = null;
/** After a failed restore, don't hammer a down server from every tool call —
 *  back off (capped at 30s), then try again on the next call after that. */
let restoreRetryAt = 0;
let lastPersistError: string | undefined;

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
 * The server's last answer to "what am I MISSING?", or undefined for "not
 * known" — an older server, the shared-identity refusal, an unreachable box.
 * Deliberately not defaulted to an empty block: unknown rendered as empty
 * reads as "nothing is missing", which is exactly the confident wrong answer
 * this whole readout exists to replace.
 */
let lastCoverage: WatchCoverage | undefined;

/** Ask the server for a fresh coverage read. Never throws and never
 *  fabricates: an unreachable server leaves the previous answer alone rather
 *  than manufacturing an all-clear out of a failed request. */
async function refreshCoverage(): Promise<WatchCoverage | undefined> {
  if (IDENTITY_IS_SHARED) return undefined;
  try {
    lastCoverage = parseCoverage(await http('GET', watchesPath())) ?? lastCoverage;
  } catch {
    // Leave `lastCoverage` as it was; `list_watched_docs` omits the field
    // entirely when it is undefined.
  }
  return lastCoverage;
}

function watchPersistenceMode(): 'server' | 'session-only' {
  return IDENTITY_IS_SHARED ? 'session-only' : 'server';
}

const watchesPath = () => `/api/agents/${encodeURIComponent(AUTHOR.id)}/watches`;

/** Mirror a local watch/unwatch to the server. Never throws. */
async function persistWatchChange(change: { add?: string[]; remove?: string[] }): Promise<boolean> {
  if (IDENTITY_IS_SHARED) return false;
  try {
    await http('POST', watchesPath(), { ...change, name: AUTHOR.name });
    lastPersistError = undefined;
    return true;
  } catch (err) {
    lastPersistError = err instanceof Error ? err.message : String(err);
    console.error('[claude-workspaces-mcp] could not persist watch change:', lastPersistError);
    return false;
  }
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
      const res = (await http('GET', watchesPath())) as {
        watches?: Array<{ key: string }>;
        pruned?: string[];
      };
      lastCoverage = parseCoverage(res);
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
      for (const workspaceId of boardsToReattach(lastCoverage)) {
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
    coverage: lastCoverage,
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
        ...(lastCoverage ? { unattachedBoards: lastCoverage.unattachedBoards } : {}),
      },
    },
  });
}

/** Returns whether the watch was persisted on the server (false when this
 *  identity is shared, the server refused, or it was unreachable). */
async function watchDoc(docId: string, persist = true): Promise<boolean> {
  if (!watchers.has(docId)) {
    const controller = new AbortController();
    watchers.set(docId, { controller, docId, open: false });
    await startSseLoop(docId, `/events/${encodeURIComponent(docId)}`, controller);
  }
  // Persist even when already locally watched: an earlier persist may have
  // failed (server down at the time), and the POST is idempotent.
  return persist ? persistWatchChange({ add: [docId] }) : false;
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
  workspaceId: string,
  persist = true,
): Promise<{ open: boolean; persisted: boolean }> {
  const key = `ws:${workspaceId}`;
  let open = watchers.get(key)?.open === true;
  if (!watchers.has(key)) {
    const controller = new AbortController();
    watchers.set(key, { controller, docId: key, open: false });
    // Name ourselves on the stream. This socket is held for the life of the
    // session, so it is the most reliable evidence the server can have that a
    // delivery to this agent will land — but only if the server can tell WHICH
    // agent is on it. Without the id it is one more anonymous subscriber,
    // indistinguishable from a browser tab, and the server falls back to
    // asking how recently the model happened to call a tool. That clock
    // expires under an agent doing local work: measured 2026-08-19 at a
    // 19.1-minute grep-and-read gap against a 15-minute window, with this
    // stream open throughout and a voice note queued instead of delivered.
    open = await startSseLoop(
      key,
      `/events/workspace/${encodeURIComponent(workspaceId)}?agentId=${encodeURIComponent(AUTHOR.id)}`,
      controller,
    );
  }
  // Two failures, reported apart. A stream that did not open loses events NOW;
  // a watch that did not persist loses them at the next respawn. Collapsing
  // them into one boolean is how a caller ends up reassured about the half
  // that worked.
  const persisted = persist ? await persistWatchChange({ add: [key] }) : false;
  return { open, persisted };
}

async function unwatchDoc(docId: string): Promise<boolean> {
  const w = watchers.get(docId);
  if (w) {
    w.controller.abort();
    watchers.delete(docId);
  }
  // Forget it on the server even if it was not locally wired — a sibling
  // session may have recorded it, and an explicit unwatch means "stop".
  return persistWatchChange({ remove: [docId] });
}

async function runSseLoop(
  label: string,
  path: string,
  signal: AbortSignal,
  onFirstAttempt?: (open: boolean) => void,
): Promise<void> {
  // Tight reconnect loop — the server sends keepalive comments every
  // ~15s, so an abrupt close is almost always a transient network blip.
  //
  // `onFirstAttempt` fires once, after the first connect attempt has an
  // outcome, and is HANDED that outcome: `true` only when headers came back
  // 200 with a body, so the stream is live from here. It is
  // what lets `watch_doc` return only once the stream is actually open, so a
  // reply posted the moment the tool answers is not lost in the gap between
  // "watcher registered" and "connection established". Not "on first
  // success": the auto-watch fires BEFORE the tool that creates the doc, so a
  // 404 on the first attempt is normal there and must not hold the tool call.
  let first = onFirstAttempt;
  const settleFirst = (open: boolean) => {
    if (!first) return;
    const f = first;
    first = undefined;
    f(open);
  };
  // The watcher record is the durable answer to "is this stream up right
  // now", read by anything that must not claim a subscription it does not
  // have. `settleFirst` only ever fires once; this keeps tracking.
  const setOpen = (open: boolean) => {
    const w = watchers.get(label);
    if (w) w.open = open;
  };
  // The wire id of the last frame this loop DELIVERED, presented back on
  // every reconnect. This loop is a hand-rolled fetch stream, not a native
  // EventSource, so nothing sends `Last-Event-ID` for us — without this line
  // the 1.5s retry below reconnects fast and resumes WITH A HOLE: everything
  // broadcast inside the gap used to be lost permanently. Delivered, not
  // seen: the cursor advances only after `handleFrame` resolves (see
  // sse-cursor.ts for the loss that committing it early caused).
  const cursor: SseCursor = { lastEventId: undefined };
  while (!signal.aborted) {
    try {
      const res = await fetch(`${resolveBaseUrl()}${path}`, {
        signal,
        ...(cursor.lastEventId ? { headers: { 'Last-Event-ID': cursor.lastEventId } } : {}),
      });
      const live = res.ok && res.body !== null;
      setOpen(live);
      settleFirst(live);
      if (!res.ok || !res.body) throw new Error(`sse ${path} → ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Split on blank-line boundaries per SSE framing.
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          // Deliver, THEN advance the cursor — a frame whose delivery threw
          // must be re-presented on reconnect, not skipped past. On a
          // delivered gap the cursor drops (the held id points at nothing
          // the server can replay) and the dedup window drops with it, since
          // after a refetch-worthy gap every held key may collide with a
          // genuinely new event.
          await deliverThenCommit(frame, handleFrame, cursor, () => shouldForwardFrame.reset());
          sep = buf.indexOf('\n\n');
        }
      }
    } catch (err) {
      setOpen(false);
      settleFirst(false);
      if (signal.aborted) return;
      console.error(`[claude-workspaces-mcp] ${label} sse error, retrying:`, err);
    }
    // A clean end-of-stream lands here too, and it is just as much "not
    // connected" as a throw is.
    setOpen(false);
    // Backoff before reconnect
    await new Promise((r) => setTimeout(r, 1500));
    // A reconnect is what a server restart looks like from in here, and a
    // restart rebuilt every room with `seq` back at 0 — so every key the
    // dedup is holding can now collide with a genuinely NEW event and
    // silently swallow it. Drop the window: the cost is at most a duplicate
    // of something in flight, and the cost of keeping it is a comment nobody
    // ever hears about. (A current server also stamps a unique `eid`, which
    // makes this belt-and-braces; the fallback key is what an un-restarted
    // box still sends.)
    shouldForwardFrame.reset();
  }
  setOpen(false);
  settleFirst(false);
}

/**
 * Start an SSE loop and resolve once its first connect attempt has an outcome
 * — capped so a wedged connect never stalls a tool call. The loop itself keeps
 * running for the life of the watcher.
 *
 * Resolves to whether the stream is actually OPEN. `false` covers all three
 * ways it can fail to be: a throw, a non-200, and the 3s cap expiring with the
 * connect still in flight. A caller that reports a subscription to an agent
 * must branch on this rather than on the call having returned — "it returned"
 * was the old signal, and it is true in every one of those cases.
 */
function startSseLoop(label: string, path: string, controller: AbortController): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const cap = setTimeout(() => resolve(false), 3_000);
    void runSseLoop(label, path, controller.signal, (open) => {
      clearTimeout(cap);
      resolve(open);
    }).catch((err) => {
      console.error(`[claude-workspaces-mcp] watcher ${label} crashed:`, err);
      watchers.delete(label);
      clearTimeout(cap);
      resolve(false);
    });
  });
}

/** Shared across every SSE loop in this process — the whole point is to catch
 *  a frame arriving on the board stream that the review stream already
 *  delivered, so a per-loop instance would see nothing. See frame-dedup.ts
 *  for what identifies an event (the server's `eid` first, `event#docId#seq`
 *  for an older one), why the fallback needs a window, and why anything it
 *  cannot identify is forwarded rather than dropped. */
const shouldForwardFrame = createFrameDedup();

async function handleFrame(raw: string): Promise<void> {
  // Only forward data frames — ignore keepalive ':ok' comments.
  const lines = raw.split('\n');
  let ev = 'message';
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) ev = line.slice(6).trim();
    else if (line.startsWith('data:')) dataParts.push(line.slice(5).trimStart());
  }
  if (dataParts.length === 0) return;
  let payload: unknown;
  try {
    payload = JSON.parse(dataParts.join('\n'));
  } catch {
    return;
  }
  if (ev === 'replay.gap') {
    // An explicit hole: the server is saying it CANNOT replay what this
    // session missed while disconnected. Surface it as its own channel line —
    // the doc-shaped formatter below would render it as a garbled comment —
    // so the agent refetches (get_doc / list_threads / next_tasks) instead of
    // trusting the stream to have been complete. No receipt: a gap notice
    // carries no queue row, and acking one would claim delivery of the very
    // frames it is reporting as missing.
    const p = (payload ?? {}) as { docId?: string };
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        source: 'claude-workspaces',
        sent_at: new Date().toISOString(),
        content: `[replay.gap] events on ${p.docId ?? 'a watched channel'} may have been missed while this session was disconnected — refetch state (get_doc / list_threads / next_tasks) rather than assuming the stream was complete`,
        meta: { event: 'replay.gap', ...(p.docId ? { doc_id: p.docId } : {}) },
      },
    });
    return;
  }
  // The kind gate FIRST, then the dedup: a word-rate frame must never reach
  // the dedup's window, let alone the channel (channel-gate.ts).
  if (isChannelEvent(ev) && shouldForwardFrame.shouldForward(ev, payload)) {
    await emitChannelMessage(ev, payload);
  }
  // The receipt for a durable comment row, AFTER the forward attempt (same
  // ordering rationale as the voice ack below: an ack sent first would clear
  // the durable copy on the strength of an intent). Deliberately OUTSIDE the
  // dedup gate: a redelivered frame reuses the original event's eid — it IS
  // the same event — so dedup rightly hides the duplicate from the session,
  // but the receipt must still go back or the server re-offers the row after
  // every grace window, forever. "The frame is in this process's hands" is
  // exactly what the receipt asserts, forwarded or collapsed.
  await ackCommentRow(payload);
}

/** POST the receipt for a frame that carries a durable comment-queue row id.
 *  Never throws: a failed ack leaves the row on the queue, so the cost is a
 *  redelivery after the grace window — late and duplicated beats silently
 *  dropped, and that asymmetry is why the receipt lives on this side. */
async function ackCommentRow(payload: unknown): Promise<void> {
  const p = payload as { commentQueueId?: unknown; workspaceId?: unknown };
  if (typeof p?.commentQueueId !== 'string' || typeof p?.workspaceId !== 'string') return;
  try {
    await http(
      'POST',
      `/api/workspaces/${encodeURIComponent(p.workspaceId)}/comment-queue/${encodeURIComponent(p.commentQueueId)}/ack`,
      {},
    );
  } catch {
    // Left on the queue on purpose — see above.
  }
}

interface ChannelPayload {
  docId?: string;
  threadId?: string;
  /** A comment ON a review item: the item's id, stamped by the server at the
   *  top level (also on `thread.anchor` for a `review-item` anchor). */
  reviewItemId?: string;
  thread?: {
    anchor?: {
      kind?: string;
      reviewItemId?: string;
      snippet?: { text?: string };
      original?: { snippet?: { text?: string } };
    };
    status?: string;
    comments?: Array<{ author?: { name?: string }; text?: string; ts?: number }>;
  };
  comment?: { author?: { name?: string }; text?: string; ts?: number };
  /** Who performed a resolve/reopen — the frame's own attribution, present
   *  on servers that stamp it. Comment events carry `comment.author`. */
  actor?: { name?: string };
  // Suggested edits (redline-suggestions phase 2): suggestion.created /
  // suggestion.accepted / suggestion.rejected carry `sid` + `suggestion`
  // instead of `threadId` + `thread`.
  sid?: string;
  suggestion?: { author?: { name?: string }; kind?: string; snippet?: string };
  // doc.sync_error: a disk↔doc sync failure on a bound file. `message` names
  // what happened and how to recover; `backupPath` is where the overwritten
  // external bytes were saved, when a backup applied.
  path?: string;
  backupPath?: string;
  message?: string;
}

/** Hub/workspace event families formatted by emitHubChannelMessage. Thread
 *  and suggestion events on the same workspace stream keep the doc-shaped
 *  path below. */
const HUB_EVENT_RE = /^(task|decision|workspace|agent|voice)\./;

interface HubEventPayload {
  workspaceId?: string;
  /** On `voice.request`: the durable queue row this frame came from. Sending
   *  it back is what takes the row off the queue. Absent from a server older
   *  than the durable queue, in which case the frame is all there is and
   *  there is nothing to acknowledge. */
  queueId?: string;
  taskId?: string;
  taskIds?: string[];
  task?: { title?: string };
  actor?: { id?: string; name?: string };
  goal?: string;
  assignee?: string;
  from?: string;
  to?: string;
  note?: string;
  fromGoal?: string;
  toGoal?: string;
  answer?: string;
  /** `decision.answered` and `workspace.review_answered`: the answered task's
   *  links, which decide whether the line offers a propagation checklist.
   *  See decision-line.ts and nudge-line.ts. */
  links?: unknown[];
  newGoal?: string;
  kind?: string;
  movedToChores?: string[];
  agentId?: string;
  leadAgentId?: string;
  batchId?: string;
  riskTier?: string;
  reason?: string;
  titleFrom?: string;
  titleTo?: string;
  title?: string;
  /** `workspace.ready_idle` only: how much was ready and how long the board
   *  had stood still when the wake fired. See ready-nudge.ts. */
  readyCount?: number;
  idleMs?: number;
  /** `workspace.ready_idle` only: the DENOMINATOR — how many open rows the
   *  pass examined — plus what it withheld and why, and the rows it could not
   *  evaluate at all. All three absent from a server older than the
   *  dependency-state gate, which is why the line renders without them. */
  consideredCount?: number;
  held?: Record<string, number>;
  undetermined?: { count?: number; reasons?: string[] };
  /** `workspace.stalled` only: how many rows have stopped moving, the rows
   *  themselves, and the rows waiting on a person nobody has actually asked.
   *  See stall-nudge.ts and nudge-line.ts. */
  stalledCount?: number;
  rows?: StalledRowPayload[];
  unfiled?: StalledRowPayload[];
  /** `workspace.stalled`: review items the quality gate is holding past the
   *  window. `workspace.review_item_held`: the one item this frame is about.
   *  See nudge-line.ts. */
  heldItems?: HeldRowPayload[];
  reviewItemId?: string;
  headline?: string;
  overdue?: boolean;
  heldMs?: number;
  trigger?: string;
  transcript?: string;
  ack?: string;
  route?: string;
  context?: { surface?: string; docId?: string; taskId?: string; visibleHeading?: string };
}

/**
 * Forward a workspace-hub event as a compact channel message. Two §3.7-style
 * suppressions, both deliberate: `agent.heartbeat` never forwards (a
 * clock tick every few minutes is pure context noise), and an event whose
 * actor is THIS agent never forwards (never deliver an author's own events
 * back to them — §3.10 companion rule).
 */
/**
 * The quality gate's verdict as a tool result carries it: present only when
 * the item was HELD, with the reason and the server's own next-step line.
 * One helper for both doors (add, revise) so they cannot spell it two ways.
 */
function heldResult(res: { held?: boolean; heldReason?: string; message?: string }): {
  held?: true;
  heldReason?: string;
  message?: string;
} {
  if (res.held !== true) return {};
  return {
    held: true,
    ...(res.heldReason !== undefined ? { heldReason: res.heldReason } : {}),
    ...(res.message !== undefined ? { message: res.message } : {}),
  };
}

async function emitHubChannelMessage(event: string, rawPayload: unknown): Promise<void> {
  const p = (rawPayload ?? {}) as HubEventPayload;
  if (event === 'agent.heartbeat') return;
  // A per-turn note from another agent's Stop hook. The server keeps it off
  // the workspace stream (server.ts, the broadcast listener); this is the
  // belt to that suspender, so a replayed or older-server frame still does
  // not cost this session a wake turn — and, relayed, its own Stop hook
  // would post a note that wakes the first agent back.
  if (event === 'task.noted') return;
  if (p.actor?.id === AUTHOR.id) return;

  const by = p.actor?.name ? ` by ${p.actor.name}` : '';
  let body: string;
  switch (event) {
    case 'task.created':
      body = `[task.created] "${truncate(p.task?.title ?? p.taskId ?? '', 60)}" → ${p.goal ?? '?'}${
        p.assignee ? ` (assignee ${p.assignee})` : ''
      }`;
      break;
    case 'task.transitioned':
      body = `[task.transitioned] ${p.taskId}: ${p.from} → ${p.to}${by}${
        p.note ? ` — ${truncate(p.note, 80)}` : ''
      }`;
      break;
    case 'task.assigned':
      body = `[task.assigned] ${p.taskId}: ${p.from} → ${p.to}${by}`;
      break;
    case 'task.regrouped':
      body = `[task.regrouped] ${p.taskId}: ${p.fromGoal} → ${p.toGoal}${by}`;
      break;
    // Both rewrite events lead with the OLD name when it moved — the only
    // name a reader who filed the row would recognise.
    case 'task.retitled':
      body = `[task.retitled] "${truncate(p.titleFrom ?? '', 60)}" → "${truncate(p.titleTo ?? '', 60)}"${by}${
        p.reason ? ` — ${truncate(p.reason, 80)}` : ''
      }`;
      break;
    case 'task.body_edited':
      body =
        p.titleFrom && p.titleTo
          ? `[task.body_edited] reshaped "${truncate(p.titleFrom, 60)}" → "${truncate(p.titleTo, 60)}"${by}${
              p.reason ? ` — ${truncate(p.reason, 80)}` : ''
            }`
          : `[task.body_edited] ${p.taskId}${by}${p.reason ? ` — ${truncate(p.reason, 80)}` : ''}`;
      break;
    // Nothing emits this since the risk gate was removed (2026-08-18). Kept
    // so a replayed or historical row still relays as a sentence rather than
    // falling through to the bare-slug default.
    case 'task.gate_refused':
      body = `[task.gate_refused] ${p.taskId}: ${p.riskTier}-tier ${p.reason}${by} — → ${p.to} did NOT happen`;
      break;
    // The propagation clause is conditional on the task having links, so the
    // wording is a decision that has to be assertable — see decision-line.ts.
    case 'decision.answered':
      body = decisionAnsweredLine(p);
      break;
    case 'workspace.lead_changed':
      // Worth forwarding even though it is not a task: it changes WHO the
      // board's lead-addressed asks go to, including when that is you.
      body =
        p.leadAgentId === AUTHOR.id
          ? `[workspace.lead_changed]${by}: you are now the lead agent — this board's asks are addressed to you`
          : `[workspace.lead_changed]${by}: lead agent is now ${p.leadAgentId ?? '?'}`;
      break;
    case 'workspace.goals_changed': {
      const moved = p.movedToChores?.length ?? 0;
      body = `[workspace.goals_changed] ${p.kind ?? 'edit'}${by}${
        moved > 0 ? ` — ${moved} task(s) moved to Backlog, re-place with set_task_goal` : ''
      }`;
      break;
    }
    // The board waking its lead. Addressed rather than broadcast, and it costs
    // the recipient a turn — so it must name what is waiting rather than fall
    // through to the bare-slug default, which is where both of these landed
    // until now. See nudge-line.ts.
    case 'workspace.ready_idle':
      body = readyIdleLine(p);
      break;
    case 'workspace.review_answered':
      body = reviewAnsweredLine(p);
      break;
    // The third wake, and the one that names work somebody said they were
    // doing. Its own case rather than a shape shared with ready_idle: the
    // reader's next act is to drive a named list of rows, not to take the top
    // of the queue.
    case 'workspace.stalled':
      body = stalledLine(p);
      break;
    // The quality gate holding one of THIS agent's items — addressed to the
    // filer, so it is always about the reader's own filing. Rendered with the
    // ids and the reason because the next act is one revise call.
    case 'workspace.review_item_held':
      body = reviewItemHeldLine(p);
      break;
    case 'agent.attached':
    case 'agent.detached':
      body = `[${event}] ${p.agentId ?? '?'}`;
      break;
    // Three routes, three different things to say — and one of them is "say
    // nothing". An action the fast path already applied must NOT read as work
    // to do; see voice-line.ts.
    case 'voice.request': {
      const line = voiceRequestLine(p);
      if (line === null) return;
      body = line;
      break;
    }
    default:
      body = `[${event}]${p.taskId ? ` task ${p.taskId}` : ''}`;
  }

  await server.notification({
    method: 'notifications/claude/channel',
    params: {
      source: 'claude-workspaces',
      sent_at: new Date().toISOString(),
      content: body,
      meta: {
        workspace_id: p.workspaceId ?? 'unknown',
        ...(p.taskId ? { task_id: p.taskId } : {}),
        event,
        ...(p.actor?.name ? { author: p.actor.name } : {}),
      },
    },
  });

  // The frame is now in this session's hands, so tell the server it can stop
  // holding the row. Deliberately AFTER the notification and not before: an
  // ack sent first would clear the durable copy on the strength of an intent,
  // which is the same fire-and-forget the queue exists to replace.
  //
  // Never throws and never blocks the frame. A failed ack leaves the row on
  // the queue, so the cost is that the utterance is offered again once the
  // grace window lapses — late and duplicated beats silently dropped, and
  // that asymmetry is the whole reason the receipt is on this side.
  if (event === 'voice.request' && typeof p.queueId === 'string' && p.workspaceId) {
    try {
      await http(
        'POST',
        `/api/workspaces/${encodeURIComponent(p.workspaceId)}/voice-queue/${encodeURIComponent(p.queueId)}/ack`,
        {},
      );
    } catch {
      // Left on the queue on purpose — see above.
    }
  }
}

async function emitChannelMessage(event: string, rawPayload: unknown): Promise<void> {
  if (HUB_EVENT_RE.test(event)) {
    await emitHubChannelMessage(event, rawPayload);
    return;
  }
  // The doc-shaped companion to the actor check in emitHubChannelMessage:
  // never deliver an author's own thread event back to them. The fan-out
  // reaches the author's own watch stream by design (it is one subscriber
  // among many), so the suppression belongs at the render point, where it
  // covers the doc channel, every board channel, and the replay buffer with
  // one gate — and where it cannot affect a browser, which must still watch
  // its own comment appear. Fails OPEN on any ambiguity; see self-authored.ts.
  if (isSelfAuthoredEvent(event, rawPayload, AUTHOR.id)) return;
  const p = (rawPayload ?? {}) as ChannelPayload;
  const docId = p.docId ?? 'unknown';

  // A recorded syncError means somebody's write into the bound file just
  // lost — rendered as a sentence naming the file, what happened, and where
  // the overwritten bytes went, because the bare-slug fallback below would
  // bury exactly the event whose whole point is being noticed.
  if (event === 'doc.sync_error') {
    const where = p.path ?? docId;
    const body = `[sync error] ${where}: ${p.message ?? 'disk↔doc sync failed — call get_doc for details'}`;
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        source: 'claude-workspaces',
        sent_at: new Date().toISOString(),
        content: body,
        meta: {
          doc_id: docId,
          event,
          ...(p.path ? { path: p.path } : {}),
          ...(p.backupPath ? { backup_path: p.backupPath } : {}),
        },
      },
    });
    return;
  }

  if (event.startsWith('suggestion.')) {
    const sid = p.sid ?? '';
    const action = event.slice('suggestion.'.length); // created | accepted | rejected
    const author = p.suggestion?.author?.name ?? '';
    const snippet = p.suggestion?.snippet ?? '';
    const kind = p.suggestion?.kind ?? '';
    const header = snippet ? `"${truncate(snippet, 60)}"` : sid;
    const body = `[suggestion ${action}] ${author ? `${author}: ` : ''}${kind} ${header}`.trim();
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        source: 'claude-workspaces',
        sent_at: new Date().toISOString(),
        content: body,
        meta: {
          doc_id: docId,
          sid,
          event,
          author,
          anchor_text: snippet,
        },
      },
    });
    return;
  }

  const threadId = p.threadId ?? '';
  const snippet =
    p.thread?.anchor?.snippet?.text ?? p.thread?.anchor?.original?.snippet?.text ?? '';
  // A comment ON one of this agent's review items. The server stamps the id
  // at the top level; an older server sends only the anchor. Named in the
  // readable line, not just the meta, because the line is what the agent
  // reads — and "which item do they mean" is the lookup revise_review_item
  // should not need.
  const reviewItemId =
    p.reviewItemId ??
    (p.thread?.anchor?.kind === 'review-item' ? p.thread.anchor.reviewItemId : undefined);
  // Resolve/reopen are STATUS changes, not speech: the person who clicked is
  // `actor` on the frame, never any comment author. The old comments[0]
  // fallback named the thread's CREATOR as the resolver, and the
  // comments.at(-1) fallback put someone else's words in their mouth — 17
  // resolves in the field, every one misattributed. An older server sends no
  // actor; a blank author is honest there, a guessed one is the bug.
  const statusChange = event === 'thread.resolved' || event === 'thread.reopened';
  const author = statusChange
    ? (p.actor?.name ?? '')
    : (p.comment?.author?.name ?? p.thread?.comments?.[0]?.author?.name ?? '');
  const text = statusChange ? '' : (p.comment?.text ?? p.thread?.comments?.at(-1)?.text ?? '');
  const sentAt = new Date(p.comment?.ts ?? Date.now()).toISOString();

  // Human-readable body — what the agent reads in their context.
  const action = event.startsWith('thread.') ? event.slice('thread.'.length) : event;
  const header = snippet ? `on "${truncate(snippet, 60)}"` : '';
  const onItem = reviewItemId
    ? ` on review item ${reviewItemId}${snippet ? ` "${truncate(snippet, 60)}"` : ''} —`
    : '';
  const body = text
    ? `[${action}]${onItem} ${author ? `${author}: ` : ''}${text}`
    : `[${action}]${onItem}${author ? ` by ${author} —` : ''} thread ${threadId} ${header}`.trim();

  await server.notification({
    method: 'notifications/claude/channel',
    params: {
      source: 'claude-workspaces',
      sent_at: sentAt,
      content: body,
      meta: {
        doc_id: docId,
        thread_id: threadId,
        ...(reviewItemId ? { review_item_id: reviewItemId } : {}),
        event,
        author,
        anchor_text: snippet,
      },
    },
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * The body of retire_workspace and unretire_workspace, which are one route
 * call with the boolean flipped. Shared here rather than as a fall-through
 * case so each tool keeps its own `case` block — that is the shape
 * `tool-wiring.test.ts` reads to prove no advertised tool is unhandled.
 */
async function setBoardRetired(
  workspaceId: string,
  retired: boolean,
  reason?: string,
): Promise<Record<string, unknown>> {
  const res = (await http('PUT', `/api/workspaces/${encodeURIComponent(workspaceId)}/retired`, {
    retired,
    ...(retired && reason !== undefined ? { reason } : {}),
    author: AUTHOR,
  })) as { changed: boolean; workspace: { name: string; retiredAt?: number } };
  return {
    workspaceId,
    name: res.workspace.name,
    retired,
    // False means it was ALREADY in this state — worth reporting rather than
    // flattening to success, because a caller re-running a cleanup wants to
    // know it changed nothing this time.
    changed: res.changed,
    ...(res.workspace.retiredAt !== undefined ? { retiredAt: res.workspace.retiredAt } : {}),
  };
}

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
