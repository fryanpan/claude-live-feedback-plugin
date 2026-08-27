#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readRenamedEnv } from '../../core/src/env-names.ts';
import { discoveryCandidates, resolveDiscoveryFile } from '../../core/src/machine-paths.ts';
import { type BacklogCommentRow, deliverAttachBacklog } from './attach-backlog.ts';
import { createAttachmentKeepalive } from './attachment-keepalive.ts';
import { resolveAgentAuthor } from './author.ts';
import { type PresenceRow, claimWarning } from './claim-warning.ts';
import { decisionAnsweredLine } from './decision-line.ts';
import { declareWorkspaceLead } from './declare-lead.ts';
import { createDeferredEmitter } from './deferred-emit.ts';
import { createFrameDedup } from './frame-dedup.ts';
import { readyIdleLine, reviewAnsweredLine } from './nudge-line.ts';
import { isSelfAuthoredEvent } from './self-authored.ts';
import { type SseCursor, deliverThenCommit } from './sse-cursor.ts';
import { projectTaskRows } from './task-projection.ts';
import { type ThreadCreateInput, threadCreateRequest } from './thread-create.ts';
import { voiceRequestLine } from './voice-line.ts';
import {
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
 *   CW_AGENT_NAME  — this agent's display name (e.g. "Quick Build");
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
const PLUGIN_VERSION = '0.1.117';

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

/**
 * A Review Item: the declaration that turns a comment into a row on a
 * person's Home queue.
 *
 * Declaring is the whole point. Before this existed the queue INFERRED its
 * membership — any agent comment nobody had replied to — which meant a
 * finished exchange left a permanent row behind, and the queue grew by one
 * for every thing the agents got right. Nothing here is derived: if you did
 * not ask for something, do not pass `review`, and your comment stays out of
 * the queue.
 *
 * A TITLE AND A DETAIL, and nothing else. `why` and `lookFor` were part of
 * this schema until 2026-08-25; Bryan, having asked twice for their removal:
 * *"It imposes a structure that's too rigid and leaves not enough room to
 * manouevwd. Title and detail is enough."* An old bundle still sending them is
 * NOT refused — their text is folded into the body server-side, so no word an
 * author typed is lost by their session being the one that has not restarted.
 *
 * `headline` is the row. Its character budget is an aim, not a gate:
 * over-running it wraps the row and comes back as advice on the 200, because
 * refusing bounced honest asks two words over budget at the exact moment an
 * agent was routing one to the queue instead of to chat. What still refuses is
 * a MISSING or multi-line headline — the row cannot be built without it, and
 * clipping one is exactly the unreadable row this replaces. Write it like a
 * ticket title, not like the first sentence of the explanation.
 */
const REVIEW_ITEM_SCHEMA = {
  type: 'object',
  description:
    "Declares this a Review Item, putting it on the reviewer's Home queue. Omit it for ordinary comments — status notes and closing remarks are not review items. headline is the row title; missing or multi-line is refused, over-long files anyway with advice. Everything else goes in detail, in whatever shape the ask wants to read.",
  properties: {
    review_type: {
      type: 'string',
      enum: ['decision', 'question'],
      description:
        "'decision' offers named options to pick between (2-6 required). 'question' asks someone to read or look at something and answer in their own words.",
    },
    shape: {
      type: 'string',
      enum: ['decision', 'review'],
    },
    headline: {
      type: 'string',
      description:
        'Name what needs deciding, in words someone who has not seen this work would use. One line.',
    },
    detail: {
      type: 'string',
      description:
        'Everything the reader needs and does not have — what is at stake, what to look at, the context behind it — in whatever order the ask reads best. No prescribed structure. Write it for someone reading on a phone, away from the work: spell out names and acronyms the first time, and prefer a plain sentence to a compressed one. Markdown and inline links welcome.',
    },
    options: {
      type: 'array',
      description: "For 'decision' only: 2-6 options. Refused on a 'question'.",
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Stable id; the answer records which one was picked.',
          },
          label: {
            type: 'string',
            description:
              'The button the reader taps, in their words rather than yours — one to three words, ≤28 chars.',
          },
          detail: {
            type: 'string',
            description: 'What choosing it costs or buys, in a plain sentence. Aim for ≤50 words.',
          },
        },
        required: ['id', 'label'],
      },
    },
  },
  required: ['headline'],
} as const;

/**
 * The SAME payload, hanging off a TICKET instead of a comment.
 *
 * One entity, one shape — the properties come from the schema above rather
 * than from a second copy, because two spellings of one payload is precisely
 * what this replaced: a ticket used to BE a decision (one `needs` flag, one
 * embedded `options` array, its own answer path), so the two surfaces could
 * drift on what a headline may contain and nothing would say so.
 *
 * Only the DESCRIPTION differs, and it has to: the comment version says "this
 * comment", which is the wrong noun on a ticket row and would teach an agent
 * that a ticket's question has to be a comment somewhere.
 */
const TASK_REVIEW_ITEM_SCHEMA = {
  ...REVIEW_ITEM_SCHEMA,
  description:
    'A review item on this ticket — the question, with its own blurb above its own options. A ticket can carry several open at once, so the ticket title keeps naming the work while headline names what is being asked. Same payload and same refusals as a comment-borne declaration.',
} as const;

/**
 * The same payload again, on a row this call is CREATING. It differs only in
 * saying where a question belongs: filed with the work when both arrive
 * together, hung on the existing ticket with add_review_item when the question
 * came up mid-work. Nothing anywhere used to say that, and the ask arriving
 * severed from the work that raised it is the failure it exists to prevent.
 */
const NEW_TASK_REVIEW_ITEM_SCHEMA = {
  ...REVIEW_ITEM_SCHEMA,
  description:
    'A question about the work this row creates — for when you are filing the work and the question together. If the question came up while working a task that already exists, hang it there with add_review_item instead, so the ask keeps the context of the work that raised it. The ticket title names the work; headline names the ask.',
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_docs',
      description:
        'List review docs currently registered on the server. Pass workspaceId to scope the list to one workspace (hub board or review id) — omit it to list every doc on the server.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'Only docs in this workspace. Matches hub-board membership and the reviewId folder binds / diff reviews stamp on their members. An unknown id returns an empty list.',
          },
        },
      },
    },
    {
      name: 'list_threads',
      description: 'List comment threads in a doc, optionally filtered by status.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          status: { type: 'string', enum: ['open', 'resolved'] },
        },
        required: ['docId'],
      },
    },
    {
      name: 'get_thread',
      description: 'Fetch a single thread by id with all comments.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
        },
        required: ['docId', 'threadId'],
      },
    },
    {
      name: 'post_reply',
      description:
        'Reply to an existing thread. Pass review when the reply is asking a person to decide or look; without it, it is an ordinary comment and does not enter the queue, which is right for status notes. Returns threadUrl, the link to hand a peer.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          text: { type: 'string' },
          review: REVIEW_ITEM_SCHEMA,
        },
        required: ['docId', 'threadId', 'text'],
      },
    },
    {
      name: 'create_thread',
      description:
        'Open a comment thread on a doc. Pass find to anchor it to a phrase; omit find entirely for a thread about the doc as a whole — that is how you comment on a task, whose body doc is task:<taskId> and is often empty. Pass review when you are asking a person to decide or look; leave it off for notes you are recording. Returns threadUrl — hand that to a peer instead of pasting the report into chat.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'Doc id. A task\'s discussion lives on "task:<taskId>".',
          },
          find: {
            type: 'string',
            description:
              'Text to anchor to. Omit entirely for a thread about the whole doc; an empty string is rejected rather than treated as "no anchor".',
          },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          occurrence: { type: 'number' },
          text: { type: 'string' },
          review: REVIEW_ITEM_SCHEMA,
        },
        required: ['docId', 'text'],
      },
    },
    {
      name: 'resolve_thread',
      description: 'Mark a thread as resolved.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
        },
        required: ['docId', 'threadId'],
      },
    },
    {
      name: 'summarize_thread',
      description:
        "Regenerate a thread's collapsed-card summary lines now. Normally unnecessary — the server does it automatically about 3s after any change — so reach for it only when you need the card correct before handing someone the URL. A 503 means summaries are disabled and retrying will not help; a 409 means a reply landed mid-call, so just call again.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          force: {
            type: 'boolean',
            description:
              'Regenerate even when the stored summary is already current. Use when the existing line reads wrong, not routinely — it is a billed call.',
          },
        },
        required: ['docId', 'threadId'],
      },
    },
    {
      name: 'reopen_thread',
      description: 'Reopen a resolved thread.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
        },
        required: ['docId', 'threadId'],
      },
    },
    {
      name: 'get_doc',
      description:
        "Read a doc's plain text and block structure. The plain text is the surface find_and_replace matches against and reflects concurrent edits. The result is body-sized and has run to 320KB on a real doc — if the question is health or shape rather than text, call doc_status.",
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'doc_status',
      description:
        'Cheap doc health check — metadata and counts, no body, a few hundred bytes where get_doc can run to hundreds of KB. Use it to ask whether a doc is still bound and where, whether the last sync wedged (syncError), how big get_doc would be, and whether anything is waiting.',
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'create_review_doc',
      description:
        'Bring a markdown file under live review: the server parses it into the editor and keeps file and doc in sync both ways, within about a second. The file must already exist and path should be absolute. Once bound, never Write/Edit that file — route edits through find_and_replace or set_doc_content, or the next flush silently overwrites them. Returns the minted docId — store that, not the name you passed — plus the review URL. Auto-subscribes you to its comments.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description:
              "A readable name for the doc, not its address — the server mints the real id and returns it, and the name becomes an alias that also works. Store the returned id. Reusing a name reuses that doc. `task:`, `ws:` and `goal:` are the server's namespaces and are refused.",
          },
          path: { type: 'string' },
          title: { type: 'string' },
          setId: { type: 'string' },
          subscribe: { type: 'boolean' },
          hubWorkspaceId: {
            type: 'string',
            description:
              'Optional board to file this under — the id `create_workspace` returned, not a grouping/review id. Omit it and it still lands on a board: the server files it under the default "Unfiled" board and returns `hubWorkspaceId` so you know where it went.',
          },
          producedBy: {
            type: 'object',
            description:
              'Optional provenance for the activity event stream: {agentId?, sessionId?}. Captured into doc meta so hands-on activity events can attribute the doc to the producing agent + session. If omitted, agentId is derived from the owner cwd and sessionId stays null.',
            properties: {
              agentId: { type: 'string' },
              sessionId: { type: 'string' },
            },
          },
        },
        required: ['docId', 'path'],
      },
    },
    {
      name: 'set_doc_content',
      description:
        'Replace a whole doc with new markdown — the safe path for a comprehensive rewrite, and a LAST resort while a human is in the doc: a scoped request gets a scoped tool (find_and_replace, rewrite_thread_region, edit_at_anchor), never a full rewrite from your in-context copy. If a human edited after your last read the server refuses with 409 stale-write (their edit time included) — re-read with get_doc, re-apply your change onto the current content, and only then retry with confirmOverwriteHumanEdits: true. Every accepted rewrite first backs up the replaced markdown under the server data dir. Applies as a block-level diff, so untouched blocks keep their comment threads. Use this rather than writing the bound file or deleting and re-creating the doc; both race the write-back and both have destroyed content. On a task body prefer rewrite_task, which also retitles and carries a reason. Refuses an empty document.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          markdown: { type: 'string', description: 'Full replacement markdown for the doc.' },
          confirmOverwriteHumanEdits: {
            type: 'boolean',
            description:
              'Acknowledge a 409 stale-write refusal AFTER re-reading the doc and re-applying your change onto its current content. Never pass it pre-emptively — it disables the guard that keeps a stale copy from destroying a human’s concurrent edits.',
          },
        },
        required: ['docId', 'markdown'],
      },
    },
    {
      name: 'reparse_from_disk',
      description:
        'Force-pull a bound file from disk into the live doc — recovery for when an external edit did not propagate. Destructive: un-flushed live edits are overwritten and anchors in replaced regions can orphan. Reach for it when get_doc returns stale content or a syncError, not routinely.',
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'delete_doc',
      description:
        'Permanently delete a review doc, including the record the activity analyses are rebuilt from. Reach for archive_doc instead unless you mean to destroy it — that retires the doc the same way and unarchive_doc reverses it. The source .md on disk is untouched either way. Refuses while open threads remain unless you pass force.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          force: {
            type: 'boolean',
            description: 'Delete even if open threads exist. Default false.',
          },
        },
        required: ['docId'],
      },
    },
    {
      name: 'bind_mock',
      description:
        'Serve an HTML mockup at /mockup/<docId> and bind it for comments — the server reads the file at sourceHtmlPath on each request, so edits show up on reload. Hand the returned meta.reviewUrl to a person. Single-file mockups only: relative CSS/JS siblings will not resolve. Idempotent.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description:
              "A readable name for the doc, not its address — the server mints the real id and returns it, and the name becomes an alias that also works. Store the returned id. Reusing a name reuses that doc. `task:`, `ws:` and `goal:` are the server's namespaces and are refused.",
          },
          sourceHtmlPath: { type: 'string' },
          title: { type: 'string' },
          subscribe: { type: 'boolean' },
          hubWorkspaceId: {
            type: 'string',
            description:
              'Optional board to file this under — the id `create_workspace` returned, not a grouping/review id. Omit it and it still lands on a board: the server files it under the default "Unfiled" board and returns `hubWorkspaceId` so you know where it went.',
          },
        },
        required: ['docId', 'sourceHtmlPath'],
      },
    },
    {
      name: 'bind_folder',
      description:
        'Bind a folder or worktree as a browsable workspace — an alias for create_diff_review with no base. The reviewer picks files from the menu under the filename in the topbar — they open lazily, and markdown opens editable. Prefer create_diff_review directly: passing a base gets you the changed-files diff on top of browsing.',
      inputSchema: {
        type: 'object',
        properties: {
          folderPath: { type: 'string' },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Path prefixes (relative to the folder) to keep out of the review, e.g. ['node_modules', 'vendor']. Persisted, so refresh_review replays it.",
          },
          workspaceId: { type: 'string' },
          hubWorkspaceId: {
            type: 'string',
            description:
              'Optional board to file this under — the id `create_workspace` returned, not a grouping/review id. Omit it and it still lands on a board: the server files it under the default "Unfiled" board and returns `hubWorkspaceId` so you know where it went.',
          },
          title: { type: 'string' },
          include: { type: 'array', items: { type: 'string' } },
          maxFiles: { type: 'number' },
          subscribe: { type: 'boolean' },
          producedBy: {
            type: 'object',
            description:
              'Optional provenance for the activity event stream: {agentId?, sessionId?}. Stored on every doc the bind creates so hands-on activity events can attribute them to the producing agent + session.',
            properties: {
              agentId: { type: 'string' },
              sessionId: { type: 'string' },
            },
          },
        },
        required: ['folderPath'],
      },
    },
    {
      name: 'create_diff_review',
      description:
        'Review a git diff PR-style: one doc per changed file, unified diffs with line-anchored comments. By default it diffs base against the working tree and re-renders within a second as you keep editing — the live-loop mode; pass target to freeze it at a commit, or omit base to browse a folder with no diff. Once the review exists prefer refresh_review, which re-reads without re-minting docIds. Hand the human entryUrl. Narrow a large repo with exclude before raising maxFiles.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Absolute path to the local git repo/worktree.' },
          base: {
            type: 'string',
            description:
              'Base ref (the "before" side). OMIT for a BROWSE workspace: no diff — the whole folder is navigable from the all-files sidebar, files open lazily (markdown editable, source read-only).',
          },
          target: {
            type: 'string',
            description:
              'Optional target ref. Omit to review the LIVE working tree (default); pass a ref to pin the review to that commit.',
          },
          reviewId: {
            type: 'string',
            description:
              'Optional review/workspace id. Defaults to <repo-basename>-<base7>-<target7|live>.',
          },
          hubWorkspaceId: {
            type: 'string',
            description:
              'Optional board to file this under — the id `create_workspace` returned, not a grouping/review id. Omit it and it still lands on a board: the server files it under the default "Unfiled" board and returns `hubWorkspaceId` so you know where it went.',
          },
          title: { type: 'string' },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description: 'Path prefixes (relative to repo root) to leave out of the review.',
          },
          groups: {
            type: 'array',
            description:
              'Split the changed files by intent, the way you would split a branch into commits; first group is read first. A path matches a file exactly or as a directory prefix, first group wins, unlisted files land in "Other". Optional `details` is a 1–2 sentence intro under the group title, capped at 500 characters — a longer one is rejected, not truncated. Omit `groups` for the built-in heuristic.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                paths: { type: 'array', items: { type: 'string' } },
                details: { type: 'string' },
              },
              required: ['title', 'paths'],
            },
          },
          maxFiles: { type: 'number' },
          subscribe: { type: 'boolean' },
          producedBy: {
            type: 'object',
            description:
              'Optional provenance for the activity event stream: {agentId?, sessionId?}. Stored on every doc the review creates.',
            properties: {
              agentId: { type: 'string' },
              sessionId: { type: 'string' },
            },
          },
        },
        required: ['repo'],
      },
    },
    {
      name: 'delete_review',
      description:
        'Retire a whole review — a diff review or a folder bind — as one unit. It archives by default: rooms stop, the review drops off the workspace listing and any board, source files are untouched, and unarchive_review reverses it. Prefer archive_review, which takes a reason and needs no force. purge: true is the destructive path; it removes the records the activity analyses are rebuilt from. Refuses all-or-nothing while any member has open threads.',
      inputSchema: {
        type: 'object',
        properties: {
          setId: {
            type: 'string',
            description: 'reviewId from create_diff_review, or setId from bind_folder.',
          },
          force: {
            type: 'boolean',
            description: 'Proceed even if some member files have open threads. Default false.',
          },
          purge: {
            type: 'boolean',
            description:
              'Destroy the persisted state instead of archiving it. Default false, and leaving it false is almost always right — a purged .ydoc cannot be restored and silently shortens the history the weekly analyses read.',
          },
        },
        required: ['setId'],
      },
    },
    {
      name: 'archive_review',
      description:
        'Retire a finished review without deleting anything — the verb for when the work a diff review covered has merged. Members drop off the workspace listing and stop costing a poll; nothing is destroyed, and unarchive_review restores the whole thing, threads and board links included. Open threads do not block it; that is the point. Pass a reason — usually the PR that merged.',
      inputSchema: {
        type: 'object',
        properties: {
          setId: {
            type: 'string',
            description: 'reviewId from create_diff_review, or setId from bind_folder.',
          },
          reason: {
            type: 'string',
            description: 'Why this review is finished — e.g. "merged in #301".',
          },
        },
        required: ['setId'],
      },
    },
    {
      name: 'unarchive_review',
      description:
        'Bring an archived review back: every member returns with its threads, its file bindings and its board rows intact. This is what makes archive_review safe to call. restore-collision means a docId was re-minted while it was away and nothing moved.',
      inputSchema: {
        type: 'object',
        properties: {
          setId: { type: 'string' },
        },
        required: ['setId'],
      },
    },
    {
      name: 'archive_doc',
      description:
        'Retire one finished doc — a bound markdown doc or a mockup — without deleting anything. It drops off the workspace listing and any board and stops costing a poll; the source file and the record are untouched, and unarchive_doc restores it. Prefer this over delete_doc, which purges. Use archive_review instead if the doc belongs to a review; task bodies and board rooms cannot be archived.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          reason: {
            type: 'string',
            description: 'Why this doc is finished — e.g. "draft published".',
          },
        },
        required: ['docId'],
      },
    },
    {
      name: 'unarchive_doc',
      description:
        'Bring an archived doc back with its threads, file binding and board rows intact. This is what makes archive_doc safe to call.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'list_archived_reviews',
      description:
        'Everything archived on this server, newest first, in two keys: archived for whole reviews (feed to unarchive_review) and docs for single docs (feed to unarchive_doc). Each carries when, by whom, the reason, and the boards it will return to. This is the answer to "what can I bring back".',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'delete_workspace',
      description:
        'Permanently delete a board and all of its tasks, rooms and history. Reach for retire_workspace instead in almost every case — this one cannot be undone. Refuses while open tasks remain unless you pass force. Docs attached to the board survive: attaching is a link, not ownership.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          force: {
            type: 'boolean',
            description: 'Delete even if the board has open tasks. Default false.',
          },
          purge: {
            type: 'boolean',
            description:
              'Only meaningful when the id turns out to be a REVIEW: destroy its persisted state instead of archiving it. Default false.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'refresh_review',
      description:
        'Re-reconcile an existing review against what is on disk now, without re-minting any docId — so every comment thread survives. Use it instead of re-running the bind when files have moved under the review. Files you changed since join it; a file reverted, deleted or renamed away is marked stale rather than removed. Read stale after a rename — those threads are stranded on a file nobody will open. Pinned reviews are refused; their content is a commit.',
      inputSchema: {
        type: 'object',
        properties: {
          setId: {
            type: 'string',
            description: 'reviewId from create_diff_review, or setId from bind_folder.',
          },
        },
        required: ['setId'],
      },
    },
    {
      name: 'set_review_groups',
      description:
        'Re-group an existing diff review\'s file list in place, so you can organise it without tearing the review down and losing its comments. Groups claim files by exact path or directory prefix, first group wins, and anything unclaimed lands in "Other". Pass an empty array to fall back to the built-in heuristic. Optional per-group details is a one- or two-sentence intro; over 500 chars is rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          setId: {
            type: 'string',
            description: 'reviewId from create_diff_review.',
          },
          groups: {
            type: 'array',
            description: 'Ordered groups. Empty array = fall back to the heuristic.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                paths: { type: 'array', items: { type: 'string' } },
                details: { type: 'string' },
              },
              required: ['title', 'paths'],
            },
          },
        },
        required: ['setId', 'groups'],
      },
    },
    {
      name: 'find_and_replace',
      description:
        "Replace plain text in a doc with other plain text. find matches the doc's plain text, not markdown — marks are preserved automatically. Exception: a find that IS pipe-table row syntax (| a | b |) matches table rows structurally, cells compared by text with whitespace ignored, so a row quoted from the .md works; the replace must keep the same row/cell shape. Disambiguate repeats with contextBefore / contextAfter or occurrence, or pass replaceAll for a mechanical sweep. A no-match returns a hint quoting the doc's actual characters; copy the find from that rather than guessing. Pass parseInlineMarks to read markdown in replace as real marks, and suggest: true to propose the edit instead of applying it.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          occurrence: { type: 'number' },
          replaceAll: {
            type: 'boolean',
            description:
              'Replace every occurrence in one call, marks carried per site — for a mechanical sweep, instead of looping occurrence by occurrence. Mutually exclusive with `occurrence` and with `suggest`.',
          },
          parseInlineMarks: { type: 'boolean' },
          suggest: {
            type: 'boolean',
            description:
              'Propose the change instead of applying it. Returns { suggestionId } instead of ok:true.',
          },
        },
        required: ['docId', 'find', 'replace'],
      },
    },
    {
      name: 'rewrite_thread_region',
      description:
        'Rewrite the text a thread is anchored to — the primary path for comment-driven edits, where a person commented and you are fixing exactly the range they commented on. Immune to concurrent edits, since the anchor resolves at apply time. Returns anchor-orphaned if they deleted the text; fall back to find_and_replace.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          replacement: { type: 'string' },
          parseInlineMarks: { type: 'boolean' },
          suggest: {
            type: 'boolean',
            description:
              'Propose the rewrite instead of applying it. Returns { suggestionId } instead of ok:true.',
          },
        },
        required: ['docId', 'threadId', 'replacement'],
      },
    },
    {
      name: 'list_suggestions',
      description:
        'List every pending suggestion on a doc, from any author, in doc order. Use it to find a sid before accepting or rejecting, or to check whether your own suggest: true proposal is still pending.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'accept_suggestion',
      description:
        'Accept a pending suggestion by sid: it becomes real content and flushes to disk within about a second. A missing sid errors, which is also the right outcome when somebody else already resolved it.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          sid: { type: 'string' },
        },
        required: ['docId', 'sid'],
      },
    },
    {
      name: 'reject_suggestion',
      description:
        'Reject a pending suggestion by sid: restores exactly the pre-suggestion text (the proposed insert is removed, the proposed deletion is un-marked and kept). Missing sid → an error.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          sid: { type: 'string' },
        },
        required: ['docId', 'sid'],
      },
    },
    {
      name: 'resolve_all_suggestions',
      description:
        "Accept or reject EVERY pending suggestion on a doc in one call — the doc-level accept-all / reject-all. Pass `authorId` to resolve only one author's proposals, leaving everyone else's pending (list_suggestions returns each entry's `author.id`). Returns the count resolved and their sids.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          action: { type: 'string', enum: ['accept', 'reject'] },
          authorId: { type: 'string' },
        },
        required: ['docId', 'action'],
      },
    },
    {
      name: 'insert_after_thread',
      description:
        "Insert text at the END of a thread's anchored range (INLINE — stays in the same paragraph/heading). For 'add a note right after this sentence.' If you want to add a whole new block after the anchor's block, use insert_blocks_after_thread instead.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['docId', 'threadId', 'text'],
      },
    },
    {
      name: 'insert_blocks_after_thread',
      description:
        'Insert new blocks — paragraphs, headings, lists, quotes, code — after the block holding a thread\'s anchor. Takes markdown. Use it for "add a section" or "add a paragraph below"; insert_after_thread is the inline sibling. An anchor inside a list item nests the new blocks under that item unless you pass placement top-level.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          markdown: { type: 'string' },
          placement: {
            type: 'string',
            enum: ['after-block', 'top-level'],
            description:
              "Where to splice. Default 'after-block' inserts after the anchor's innermost block, which nests under a list item when the anchor sits in one. Pass 'top-level' to insert after the whole containing list or table.",
          },
        },
        required: ['docId', 'threadId', 'markdown'],
      },
    },
    {
      name: 'create_anchor',
      description:
        'Mint a private anchor at a text location and get back an id. It survives concurrent edits, so you can pin several spots now and rewrite each later without offsets shifting under you. Same disambiguation as find_and_replace.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          find: { type: 'string' },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          occurrence: { type: 'number' },
          label: { type: 'string' },
        },
        required: ['docId', 'find'],
      },
    },
    {
      name: 'edit_at_anchor',
      description:
        "Apply an inline edit at an anchor — replace the anchored range or insert_after it. The text stays inside the anchor's block, so use it for prose, not new structure. For headings, paragraphs, lists or tables use insert_blocks_at_anchor, or you get a literal ## Heading instead of a heading.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          anchorId: { type: 'string' },
          op: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['replace', 'insert_after'] },
              text: { type: 'string' },
            },
            required: ['kind', 'text'],
          },
        },
        required: ['docId', 'anchorId', 'op'],
      },
    },
    {
      name: 'insert_blocks_at_anchor',
      description:
        'Parse markdown and insert the resulting blocks after the block holding an anchor. This is the one for new sections, sub-headings and tables; edit_at_anchor keeps text trapped inside the block. An anchor inside a list item nests under that item unless you pass placement top-level.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          anchorId: { type: 'string' },
          markdown: { type: 'string' },
          placement: {
            type: 'string',
            enum: ['after-block', 'top-level'],
            description:
              "Where to splice. Default 'after-block' inserts after the anchor's innermost block, which nests under a list item when the anchor sits in one. Pass 'top-level' to insert after the whole containing list or table.",
          },
        },
        required: ['docId', 'anchorId', 'markdown'],
      },
    },
    {
      name: 'delete_anchor',
      description: 'Remove a previously-created agent anchor. Useful for cleanup between tasks.',
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' }, anchorId: { type: 'string' } },
        required: ['docId', 'anchorId'],
      },
    },
    {
      name: 'delete_block_at_anchor',
      description:
        "Delete the whole block an anchor points at. Use it when an empty find_and_replace is not enough — that empties a block's text but leaves the empty block rendering. For an anchor inside a list item or table cell only the innermost block goes; for a whole list or section use delete_blocks_in_range or delete_section.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          anchorId: { type: 'string' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'delete_blocks_in_range',
      description:
        'Delete every top-level block from the one containing startFind through the one containing endFind. Block-inclusive on purpose: a partial match removes the entire containing block. Use it for trailing cruft or a span no heading bounds; for "delete this section" prefer delete_section, which is heading-aware.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          startFind: { type: 'string' },
          endFind: { type: 'string' },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          startOccurrence: { type: 'number' },
          endOccurrence: { type: 'number' },
        },
        required: ['docId', 'startFind', 'endFind'],
      },
    },
    {
      name: 'delete_section',
      description:
        'Delete a heading and everything under it, down to the next heading at the same level or above. The tool for "delete the X section" — a dozen find_and_replace calls in one, without the empty blocks they leave behind. Pass level or occurrence when the heading text repeats. Returns the heading that ended the run, so you can confirm what was kept.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          heading: { type: 'string' },
          level: { type: 'number' },
          occurrence: { type: 'number' },
        },
        required: ['docId', 'heading'],
      },
    },
    {
      name: 'observe_url',
      description:
        'Return the SSE URL that streams live thread events for a doc. Useful for long-running agents.',
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'watch_doc',
      description:
        "Subscribe this session to a doc's comment events, delivered as channel messages. Usually unnecessary — create_review_doc, bind_mock and most docId-bearing tools subscribe you already, and set_workspace_lead covers every doc on your board. Reach for it for a doc you have not otherwise touched, such as a peer's review you only want to observe. persisted: false means a restart will drop it.",
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'unwatch_doc',
      description:
        'Stop pushing channel events for this doc, and forget it on the server so a respawn does not bring it back.',
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'list_watched_docs',
      description:
        'What this session is subscribed to — and, more usefully, what it is missing. coverage.unattachedBoards names boards you follow but are not live on, with what is queued for their lead and the remedy for each: set_workspace_lead when the seat is empty, heartbeat when it is yours and you went quiet, attach_agent when a live peer holds it. restore.status tells an empty list apart from a failed restore. coverage absent means unknown, never all-clear.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'share_workspace',
      description:
        "Publish a board behind a Cloudflare Access gate so named external reviewers can read, comment and co-edit. A board is the unit of sharing — file a doc or review on one first; a review id is refused. Everything on that board travels with the share, so check what else is filed there, or give the review its own board. Read .claude/claude-workspaces.json's share.defaultAllowDomains; if there is none, ask which domains to allow — never default to anyone. Default TTL 72h.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The BOARD to share — the id create_workspace returned, or the hubWorkspaceId bind_folder / create_diff_review reported. NOT a review/review id.',
          },
          allowDomains: {
            type: 'array',
            items: { type: 'string' },
            description: "Email domains, e.g. ['@partner-org.example']",
          },
          ttlSeconds: { type: 'number' },
          name: { type: 'string', description: 'Optional slug override for the subdomain' },
        },
        required: ['workspaceId', 'allowDomains'],
      },
    },
    {
      name: 'share_link',
      description:
        'Publish a board as an unguessable link — no sign-in, the default way to share outside the tailnet. Same scope as an Access share, and a board is still the unit. The link is the credential: treat it like a password, keep the TTL short for anything sensitive, and give the person the bare URL on its own line. Use share_workspace when you need verified identities, per-person revocation, or attribution. Default TTL one week.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The BOARD to share — the id create_workspace returned, or the hubWorkspaceId bind_folder / create_diff_review reported. NOT a review/review id.',
          },
          ttlSeconds: { type: 'number', description: 'Defaults to one week (604800).' },
          label: { type: 'string', description: 'Human label shown in list_shares.' },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'set_share_ttl',
      description:
        'Extend or shorten a live share. `ttlSeconds` is measured from now, so passing 3600 makes it expire an hour from this call regardless of when it was created. Takes effect immediately — an already-open browser is refused on its next request once the share lapses.',
      inputSchema: {
        type: 'object',
        properties: {
          shareId: { type: 'string' },
          ttlSeconds: { type: 'number' },
        },
        required: ['shareId', 'ttlSeconds'],
      },
    },
    {
      name: 'list_shares',
      description:
        'List currently active shares with their hostnames, allowed domains, and expiry.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'unshare',
      description:
        'Revoke a share by id. Deletes the Cloudflare Access app + policy and removes the registry entry. Use this for early teardown — shares otherwise expire on their own at the configured TTL.',
      inputSchema: {
        type: 'object',
        properties: { shareId: { type: 'string' } },
        required: ['shareId'],
      },
    },
    {
      name: 'set_sharing_enabled',
      description:
        'Master switch for all external access. Off makes every share and link answer 403 and hangs up open connections — one call instead of revoking shares individually. Existing shares are preserved and resume when it is back on; the local and tailnet surface is unaffected. Call with no argument to read the current state.',
      inputSchema: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'Omit to read the current state without changing it.',
          },
        },
      },
    },
    {
      name: 'create_workspace',
      description:
        'Create a board: goals, tasks, and the docs and reviews filed on it, opened at /workspaces/<id>. You become its lead agent unless you pass leadAgentId. A board starts with no goals — write them with set_goal_list. A folder bind or diff review is content to file on a board, not another board.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short handle, e.g. "search-revamp".' },
          leadAgentId: {
            type: 'string',
            description:
              "The agent responsible for this board. Defaults to this agent's identity — pass another only when you are setting a board up for someone else.",
          },
          subscribe: { type: 'boolean' },
        },
        required: ['name'],
      },
    },
    {
      name: 'rename_workspace',
      description:
        "Change a board's name. Nothing else moves — same id, same URL, same tasks, so every existing link keeps working. Renaming into a name another live board holds is allowed; the response names the collision in sameName. Use retire_workspace when the answer is that one of the two is over.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Hub workspace id.' },
          name: { type: 'string', description: 'The new name. Trimmed; may not be empty.' },
        },
        required: ['workspaceId', 'name'],
      },
    },
    {
      name: 'retire_workspace',
      description:
        'Stand a board down reversibly, when it is superseded, finished, or a duplicate. It stops ranking, refuses new tasks, and tells anyone who reads it why — but destroys nothing, and unretire_workspace reverses it. This is the one to reach for; delete_workspace is not reversible. Pass a reason; it is replayed in every refusal, and it is usually the board that replaced this one.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Hub workspace id.' },
          reason: {
            type: 'string',
            description:
              'Why, in one line. Shown to every agent that hits the retired board — name the board that replaced it if there is one.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'unretire_workspace',
      description:
        'Bring a retired hub board back. It ranks again, takes new work again, and stops warning readers. Nothing has to be restored — retiring only ever wrote one field — so this is a plain reversal and not a recovery.',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string', description: 'Hub workspace id.' } },
        required: ['workspaceId'],
      },
    },
    {
      name: 'set_workspace_lead',
      description:
        'Declare yourself lead of a board. One call at session start and everything on it reaches you — task, decision and thread events on every doc filed there, plus voice notes — and it drains whatever queued while the seat was empty. Staying live is separate: delivery is gated on the server having observed you recently, so a quiet session drops out. Call heartbeat, and check list_watched_docs rather than assuming. Pass leadAgentId to hand the board to somebody else.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Hub workspace id from create_workspace.' },
          leadAgentId: {
            type: 'string',
            description:
              'The agent id taking responsibility. Omit it to declare yourself — the common case, and the only form that also attaches and subscribes you. Naming another agent hands the seat over and does nothing else.',
          },
          takeover: {
            type: 'boolean',
            description:
              'Take the seat from a different agent that currently holds it and is live — it evicts them silently and reroutes every lead-addressed delivery, so coordinate first. Default false: without it you get `declined: "lead-held"` naming the incumbent, and you stay attached either way.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'attach_doc',
      description:
        "File an existing doc, diff review or folder bind onto a board, so its open comment threads reach that board's Home queue. A link only — the doc keeps its own URL and nothing is migrated. docId also accepts a review id, which attaches the whole review as one unit. Idempotent.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Hub workspace id from create_workspace.' },
          docId: { type: 'string', description: 'Doc id, or a diff-review/folder-bind id.' },
        },
        required: ['workspaceId', 'docId'],
      },
    },
    {
      name: 'create_tasks',
      description:
        "File work on a board. Always takes a list; one task is a one-row list, so this is the only create verb. Per row: omit assignee and you own it, omit goal and it lands unplaced at the bottom of Backlog. Rows you file land in triage — on the board, but not in anyone's queue until somebody moves them out with task_transition. A bad row never rejects the batch; it comes back in failures by index.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          tasks: {
            type: 'array',
            description:
              'The rows, at most 100 — an oversized batch is refused whole; a tracker that big belongs in import_tasks_markdown. `title` is the only required field. `key` labels a row so a later row in the same batch can reference it: unique in the batch, not all digits, no leading "#". Rows are created in order, so a row can only depend on one above it; a forward reference is refused.',
            // The row contract used to live on the single-row create verb's
            // declaration, and `tasks` merely pointed at it. Removing that
            // tool would have removed every field description with it — the
            // schema would still validate and an agent would have nothing
            // left to read about what a row owes. Moved here rather than
            // deleted. (The verb is not named here on purpose: the absence
            // test in create-tasks-tool.test.ts scans this source too, and a
            // comment is exactly the kind of mention that keeps a removal
            // from being a removal.)
            items: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description:
                    "One line naming the work, in the form `<persona> can <do x> so that <goal y>` — one persona (Agent, Bryan, Collaborator), 20 words or less. A title that states an observation rather than an outcome gives a column of rows nothing to prioritise by. Never refused; the lead's shape review is where a rough one gets rewritten.",
                },
                body: {
                  type: 'string',
                  description:
                    'What the row is for, as a compact user story — `<persona> can <do x> so that <goal y>`, one persona (Agent, Bryan, Collaborator) — plus "done when" criteria for anything you hand over or park. Markdown; it comes back whole from next_tasks. On a `needs:\'decision\'` row this is required and must contain the actual question, the stakes, and what each option costs; a body with no question in it is refused.',
                },
                key: {
                  type: 'string',
                  description:
                    'An optional label THIS batch uses to reference the row from a later row\'s `after` / `afterEnforce`. Unique within the batch; not all digits; must not start with "#". Means nothing outside this call.',
                },
                assignee: {
                  type: 'string',
                  description:
                    "Who owns this row: 'human', or a named person or agent. Omit it and you own it. The bare word 'agent' is refused — it names a category rather than somebody; that refusal means your session was launched without CW_AGENT_NAME.",
                },
                assigneeKind: {
                  type: 'string',
                  enum: ['person', 'agent'],
                  description:
                    "'person' or 'agent' — say which whenever `assignee` is a name that is not your own. The board cannot tell a person from an agent of the same name and will not guess, so an undeclared owner shows as \"not recorded\". Not needed for yourself or for 'human'.",
                },
                needs: {
                  type: 'string',
                  enum: ['action', 'decision'],
                  description:
                    "Only meaningful when assignee is a human. 'decision' makes the ticket itself one decision, answered verbatim through answer_decision; it requires a decision-shaped `body`. The `review` field lets the ticket carry several separately-answered questions alongside the work.",
                },
                options: {
                  type: 'array',
                  description:
                    "Candidate answers for this row's one decision: [{label, detail?}]. `label` is recorded verbatim as the answer if picked; `detail` is what picking it costs. Two or more. They are a shortcut, not a closed set — writing a different answer stays available, so do not pad the list.",
                  items: { type: 'object' },
                },
                review: NEW_TASK_REVIEW_ITEM_SCHEMA,
                goal: {
                  type: 'string',
                  description:
                    'Goal/subgoal id, or "chores". OMIT to leave this row UNPLACED at the bottom of Backlog for the lead to place. An explicit goal — even "chores" — is a placement.',
                },
                order: { type: 'number', description: 'Fractional position within the goal.' },
                after: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'What this row waits on ("don\'t start yet" is a dependency, not a status). An existing task id, or a row of THIS batch by index (`0`) or by another row\'s `key` (`"#seed"`).',
                },
                afterEnforce: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Subset of `after` that hard-blocks transitions while open. Every entry must also appear in `after`, or the row is refused rather than silently widening the gate.',
                },
                dueAt: {
                  type: 'number',
                  description: 'Epoch ms. Optional at every level — never invent one.',
                },
                links: {
                  type: 'array',
                  description:
                    "Refs this task mentions: {kind:'doc',docId} | {kind:'thread',docId,threadId} | {kind:'task',taskId} | {kind:'diff',workspaceId} | {kind:'url',url}. Use `url` for anything outside this server; http(s) only. A malformed ref is dropped into `ignoredLinks` rather than failing the row.",
                  items: { type: 'object' },
                },
                quote: {
                  type: 'string',
                  description:
                    "The human's VERBATIM words, for chat-born asks — kept forever on the task. (For thread-born asks use promote_to_task, which captures the quote itself.)",
                },
              },
              required: ['title'],
            },
            maxItems: 100,
          },
        },
        required: ['workspaceId', 'tasks'],
      },
    },
    {
      name: 'promote_to_task',
      description:
        "Turn a comment thread into a task. Captures the backlink and the latest human comment as the verbatim quote, and drafts a title and body from it when you don't supply them. This is the verb for thread-born asks; create_tasks is for everything else.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          workspaceId: { type: 'string', description: 'Hub workspace the task lands in.' },
          title: {
            type: 'string',
            description:
              'Override the drafted title \u2014 worth sending, since the draft is a clip of a comment and names what was said rather than what will be done. `<persona> can <do x> so that <goal y>`, 20 words or less.',
          },
          body: { type: 'string', description: 'Override the drafted body.' },
          assignee: {
            type: 'string',
            description:
              "Who owns it. Omit and you do — same rule as a create_tasks row's assignee.",
          },
          assigneeKind: {
            type: 'string',
            enum: ['person', 'agent'],
            description:
              "'person' or 'agent' — say which whenever `assignee` is a name that is not your own. The board cannot tell a person from an agent of the same name and will not guess, so an undeclared owner shows as \"not recorded\". Not needed for yourself or for 'human'.",
          },
          needs: { type: 'string', enum: ['action', 'decision'] },
          goal: { type: 'string', description: 'Goal/subgoal id. OMIT to route through triage.' },
          dueAt: { type: 'number' },
          links: { type: 'array', items: { type: 'object' } },
        },
        required: ['docId', 'threadId', 'workspaceId'],
      },
    },
    {
      name: 'get_workspace',
      description:
        "Read a board's goals in priority order, with per-goal task counts. First row is the highest band. Call it before deciding what to work on — list_tasks returns goal ids only, so without this the ordering is invisible. Cheap by design: pair it with next_tasks, which carries the tasks themselves.",
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
        required: ['workspaceId'],
      },
    },
    {
      name: 'next_tasks',
      description:
        'The work queue: what to pick up next, in priority order, filtered to what you can actually do. Take the whole ready set, not the top row. Each row carries its full description, blockedBy, ready, and bodyWrittenAt — descriptions age, so check that date before trusting one. Skip any row whose claimedBy is an active session that is not you. Triage rows are never returned; read those with list_tasks(status:"triage").',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          assignee: { type: 'string', description: 'Usually your own agent name.' },
          limit: { type: 'number' },
          includeBlocked: {
            type: 'boolean',
            description: 'Include tasks held by an enforced open dependency.',
          },
          includeArchived: {
            type: 'boolean',
            description:
              'Include soft-deleted rows. Default false, and leave it false here: an archived task is one somebody decided is not going to happen, so it is not work to pick up. Use `list_tasks` with this flag to FIND archived rows.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'list_tasks',
      description:
        "List a board's tasks, filtered by goal / status / assignee / needs. Rows are trimmed — no body, no transition history. Pass fields to narrow further; the default rows run large on a big board. Archived rows need includeArchived: true.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goal: { type: 'string' },
          status: {
            type: 'string',
            enum: ['triage', 'todo', 'in-progress', 'done'],
            description:
              'status:"triage" is the sweep for rows an agent filed that nobody has vetted. next_tasks never returns them, so this filter is the only way to enumerate what is waiting on a look.',
          },
          assignee: { type: 'string' },
          needs: { type: 'string', enum: ['action', 'decision'] },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Project each row to just these keys (`id` always included). Use it for board-wide sweeps so heavy per-row fields — reviews, infoRequests, options — don't overflow the result: fields:['title','status','assignee'] answers most triage questions in a few KB.",
          },
          includeArchived: {
            type: 'boolean',
            description:
              'Include soft-deleted rows, which are hidden by default. Each comes back carrying `archivedAt`, `archivedBy` and `archiveReason`, so this is the read behind "what did we archive, and why". `unarchive_task` puts one back.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'task_transition',
      description:
        "The single gate for status changes (triage | todo | in-progress | done), attributed to you on the task's trail. It is also the only way to clear a triage row. Say what you did in `note` — the commit, the PR, what you verified — because the note is the whole of what the trail keeps. Re-sending the same status refuses; there is nothing to change.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          to: { type: 'string', enum: ['triage', 'todo', 'in-progress', 'done'] },
          note: { type: 'string' },
          usage: {
            type: 'object',
            properties: {
              inputTokens: { type: 'number' },
              outputTokens: { type: 'number' },
            },
          },
        },
        required: ['taskId', 'to'],
      },
    },
    {
      name: 'assign_task',
      description:
        "Hand a task to somebody: 'human', a person, or an agent's name. Use it the moment you find a task is not yours to finish — an unassigned blocker looks like work in flight to everyone reading the board. Refuses the bare word 'agent', which names a category rather than somebody. Status is untouched.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          assignee: {
            type: 'string',
            description:
              "'human', a person's name, or an agent's name (yours comes from CW_AGENT_NAME). The bare word 'agent' is refused.",
          },
          assigneeKind: {
            type: 'string',
            enum: ['person', 'agent'],
            description:
              "'person' or 'agent' — say which whenever `assignee` is a name that is not your own. The board cannot tell a person from an agent of the same name and will not guess, so an undeclared owner shows as \"not recorded\". Not needed for yourself or for 'human'.",
          },
        },
        required: ['taskId', 'assignee'],
      },
    },
    {
      name: 'park_task',
      description:
        'Defer a task: "not now". Moves the row to triage and posts a comment recording why and when to come back to it. Reach for it instead of moving the row to in-progress or inventing a dependency to quiet the ready-work nudge — both make the board say something untrue. Write a reason: triage says a decision was made, and the comment is the only place that says what it was waiting for. There is no un-park — when the row is ready again, move it on with task_transition like any other triage row.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          until: {
            description:
              'When to come back to it, if you know. An epoch-ms number, or a date string ("2026-09-02", or a full ISO timestamp for a specific hour — a bare date is read as UTC midnight). Omit it for "not now, and I do not know when" — the comment says so rather than inventing a date. `null` is the retired un-park: accepted, and it does nothing.',
            type: ['number', 'string', 'null'],
          },
          reason: {
            type: 'string',
            description:
              'Why, in one line — e.g. "waiting on the index rebuild". It goes in the comment, which is the record a reader argues with weeks later.',
          },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'archive_task',
      description:
        'Take a task off the board without destroying it — the soft delete, and the only removal a task has. Reach for it freely for a duplicate, a row the goal moved past, or a capture that turned out not to be work. It writes three fields and nothing else, so unarchive_task is a field clear rather than a restore. Archiving is not completing — if the work happened, use done. Write a reason.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          reason: {
            type: 'string',
            description:
              'Why, in one line — e.g. "duplicate of the index row" or "the goal moved past this". Capped at 200 characters. Optional, and the row is archived either way; it is the half a later reader acts on.',
          },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'unarchive_task',
      description:
        'Put an archived task back — it rejoins its band at the position, status and owner it always had. Find archived rows with list_tasks(includeArchived: true). A row that was not archived answers changed: false rather than erroring.',
      inputSchema: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
    },
    {
      name: 'rewrite_task',
      description:
        "Rewrite a task's title, body, or both, with a reason that rides the audit trail. Body is a whole-body replace — send the full markdown. The row's original words are preserved to quote automatically, so a rewrite is never the only record of what was said. When the words are a person's deliberate phrasing, ask on the task instead of replacing them.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          title: {
            type: 'string',
            description:
              'The new one-line name. Omit to keep the current one. Aim for `<persona> can <do x> so that <goal y>` — one persona, 20 words or less, never clipped mid-word; the full standard is in the `claude-workspaces:working-in-a-workspace` skill.',
          },
          body: {
            type: 'string',
            description:
              'The FULL new description, replacing what is there. Omit to leave the body alone (a title-only fix). Open with the user story, keep it phone-readable, and state a falsifiable done-when.',
          },
          reason: {
            type: 'string',
            description:
              'Why you are rewriting, in one line — e.g. "title named the artifact, not the outcome". Recorded on the audit row and rendered in the activity feed, so the filer can see what the rewrite was for.',
          },
        },
        required: ['taskId', 'reason'],
      },
    },
    {
      name: 'set_task_goal',
      description:
        'Place a task under a goal at an exact position — pick the spot, not just the bucket. position is fractional, so there is always room between two rows; omit it for the bottom of the band. Every move is recorded, so regroup freely. When your move crosses a placement a person made, say why in a comment on the task.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          goal: { type: 'string', description: 'Goal/subgoal id, or "chores".' },
          position: { type: 'number' },
          batchId: {
            type: 'string',
            description:
              'Echo the batchId from the `workspace.goals_changed` event this placement answers. It ties the move to the goal edit that prompted it, so the activity view reads N moves as one edit instead of N unexplained rereviews.',
          },
        },
        required: ['taskId', 'goal'],
      },
    },
    {
      name: 'set_goal_list',
      description:
        "Add or remove a goal by submitting the board's whole ordered list. Send an entry with no id to add a band (the server mints it); send an existing id exactly as get_workspace reports it to keep one. Use rename_goal to retitle and reorder_goals to re-prioritise — both are safer, because this is a full replace and any id you leave out is removed. Removing a band that still holds tasks is refused until you name it in drop.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description:
                    'Omit to create this band — the server mints an opaque id and returns it in `created`. Include it, exactly as get_workspace reports it, to keep a band you already have. Goal ids are generated and permanent; an id this board does not hold is refused as `unknown-goal-id`.',
                },
                title: { type: 'string' },
                dueAt: { type: 'number' },
                subgoals: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'string',
                        description: 'Omit to create; include to keep. Same rule as a goal id.',
                      },
                      title: { type: 'string' },
                      dueAt: { type: 'number' },
                    },
                    required: ['title'],
                  },
                },
              },
              required: ['title'],
            },
          },
          drop: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Goal/subgoal ids you intend to remove even though they still hold tasks — the acknowledgement that turns the refusal into the removal. Read what the refusal said each band holds first. Ids that are not actually being removed are ignored.',
          },
        },
        required: ['workspaceId', 'goals'],
      },
    },
    {
      name: 'rename_goal',
      description:
        "Change a goal's or subgoal's title in place, by id. The id never moves, so no task moves. Use this rather than set_goal_list, which would make you restate every other band. dueAt is optional: a number sets it, null clears it, omitting it leaves it alone.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goal: {
            type: 'string',
            description: 'The goal or subgoal id to retitle. Get it from get_workspace.',
          },
          title: { type: 'string' },
          dueAt: {
            type: ['number', 'null'],
            description: 'Epoch ms to set, null to clear, omit to leave unchanged.',
          },
        },
        required: ['workspaceId', 'goal', 'title'],
      },
    },
    {
      name: 'reorder_goals',
      description:
        "Change the priority order of a board's goals — order is priority. Permutation only: order must be exactly the ids already at one scope, so nothing can be created, renamed or lost. Take the ids from get_workspace and send every row at your scope whose reorderable is true. Use set_goal_list only when you actually mean to add or remove a band.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          order: {
            type: 'array',
            items: { type: 'string' },
            description:
              'EVERY reorderable goal id at this scope, in the new priority order, highest first. Leaving one out is an error, not a demotion; including a non-reorderable row (Backlog) is an error too.',
          },
          parent: {
            type: 'string',
            description:
              "Reorder this goal's SUBGOALS instead of the top-level list. Omit for the top level. A subgoal id is not a valid parent — nesting is one level deep.",
          },
        },
        required: ['workspaceId', 'order'],
      },
    },
    {
      name: 'add_review_item',
      description:
        'Hang a question on a ticket that already exists — the verb for a question that came up while working it, so the ask stays attached to the work that raised it. A ticket carries several at once, each answered on its own, so the title keeps naming the work and a second question needs no second ticket. When you are filing the work and the question together, use review on a create_tasks row instead.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The ticket the question hangs on.' },
          review: TASK_REVIEW_ITEM_SCHEMA,
        },
        required: ['taskId', 'review'],
      },
    },
    {
      name: 'answer_review_item',
      description:
        "Record a person's verbatim answer to one review item on their behalf, for when they told you in chat or voice — in the UI they answer directly. Pass their exact words, never a paraphrase. Naming reviewItemId is what keeps several open questions on one ticket independently answerable. Does not transition the ticket; close it with task_transition once you have acted on the returned links.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          reviewItemId: {
            type: 'string',
            description:
              "Which item is being answered (from list_tasks / the ticket's `reviews`). Omit it on a ticket that is itself a decision — the answer then lands on that decision.",
          },
          text: { type: 'string', description: "The human's verbatim answer." },
          answeredWith: {
            type: 'string',
            description:
              "The id of the option they picked, if they picked one. The answer is still `text` — pass the option's label as the text. Omit when they answered in their own words.",
          },
        },
        required: ['taskId', 'text'],
      },
    },
    {
      name: 'request_more_info',
      description:
        "Ask a question BACK at a review item instead of answering it, on the human's behalf. The item stays open and stays counted on the queue, and the agent that raised it owes the context. This is what keeps a set of options from being a closed set — 'none of these, tell me X' is a real response to a decision.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          reviewItemId: {
            type: 'string',
            description:
              'Which item is being asked about. Omit on a ticket that is itself an old-style decision, same rule as answer_review_item.',
          },
          question: { type: 'string', description: 'What they want to know, verbatim.' },
        },
        required: ['taskId', 'question'],
      },
    },
    {
      name: 'answer_decision',
      description:
        "Record a person's verbatim answer to a decision task on their behalf, for when they told you in chat or voice — in the UI they answer directly. Pass their exact words, never a paraphrase. This answers the ticket's own decision; answer_review_item answers one of the items hanging on a ticket. Neither transitions the ticket — close it with task_transition once you have acted on the returned links.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          text: { type: 'string', description: "The human's verbatim answer." },
          optionId: {
            type: 'string',
            description:
              "The id of the option they picked, if they picked one. The answer is still `text` — pass the option's label as the text. Omit when they answered in their own words.",
          },
          reviewItemId: {
            type: 'string',
            description:
              "Which of the ticket's review items is being answered. Omit — as every caller before this field existed does — and the answer lands on the ticket's own decision, exactly as it always has.",
          },
        },
        required: ['taskId', 'text'],
      },
    },
    {
      name: 'set_task_dependencies',
      description:
        'Set what a task waits on after it was created. after lists the ids it depends on; afterEnforce is the subset that hard-blocks its transitions. Replaces the whole edge set, so pass the full list. Reach for it the moment you find a task waiting on an open decision — that edge is the only record that the decision is blocking work.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The BLOCKED task — the one that waits.' },
          after: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Task ids this waits on, in full. Must exist in the same workspace; a self-reference is refused.',
          },
          afterEnforce: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Subset of `after` that hard-blocks transitions while open. Every id here MUST also appear in `after` — the call is refused rather than silently widening `after`.',
          },
        },
        required: ['taskId', 'after'],
      },
    },
    {
      name: 'import_tasks_markdown',
      description:
        'Move a hand-maintained markdown tracker (headings + status tables) onto a board. Defaults to a dry run — it returns the mapping and creates nothing, so review that with the human, then call again with apply: true. Apply stamps the source file with a banner and a link so the old tracker cannot quietly stay a second source of truth, and a stamped file refuses re-import.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Hub workspace id from create_workspace.' },
          path: { type: 'string', description: 'Absolute path to the tracker .md file.' },
          apply: {
            type: 'boolean',
            description: 'Omit or false = dry-run (the mapping only). true = create + stamp.',
          },
        },
        required: ['workspaceId', 'path'],
      },
    },
    {
      name: 'link_refs',
      description:
        'Link a task to a doc, thread, another task, a diff review, or a URL. Stored one way; the reverse direction is computed, so doc and thread payloads grow task chips automatically. Target existence is not checked — a dangling ref is visible and harmless.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          ref: { type: 'object' },
        },
        required: ['taskId', 'ref'],
      },
    },
    {
      name: 'unlink_refs',
      description:
        'Remove a stored ref from a task (the exact ref, same shapes as link_refs). Idempotent — `changed:false` means it was not linked. Cannot remove the `origin` ref a promotion recorded; origin is history, not a link.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          ref: { type: 'object' },
        },
        required: ['taskId', 'ref'],
      },
    },
    {
      name: 'list_backlinks',
      description:
        "Which tasks point at this ref, across every board. This is what a url ref is for: paste a pull request or a dashboard link and find what work already cites it before filing a duplicate. Counts a promotion's origin too, so a task promoted from a thread comes back for that thread without anyone linking it by hand.",
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'object', description: 'The ref to find citers of.' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'attach_agent',
      description:
        'Register this session on a board without taking the lead seat — for a peer or subagent picking up work. The response is your fresh-context briefing: open gating decisions, the untriaged rows to shape, and, if you lead the board, the voice notes that queued while nobody was live. It auto-subscribes you to board events. Call heartbeat every few minutes; after about five minutes of silence you show as away.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          agentId: { type: 'string', description: "Defaults to this agent's MCP identity." },
          runtime: {
            type: 'string',
            enum: ['claude-code-local', 'managed-agent', 'webhook'],
            description: 'Defaults to claude-code-local.',
          },
          capabilities: {
            type: 'array',
            items: { type: 'string' },
            description: "e.g. ['tasks.write', 'docs.edit']",
          },
          subscribe: { type: 'boolean' },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'heartbeat',
      description:
        'Prove this attached session is alive. Call it every few minutes while attached — after about five minutes you show as away, and lead-addressed deliveries only reach sessions the server has observed recently. Ordinary tool calls count too, so this matters most during a long stretch of thinking or a long-running command.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          agentId: { type: 'string', description: "Defaults to this agent's MCP identity." },
          toolCallAt: {
            type: 'number',
            description: 'Epoch ms of your last real tool call. Defaults to now.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'request_plugin_refresh',
      description:
        "Ask this machine to fetch the newest plugin from the marketplace. Call it when a board's settings panel says sessions are running an older bundle. It requests rather than forces — the update rewrites a version-keyed cache, so nothing running is interrupted and each session picks it up at its next restart. changed: false with matching versions means the cache was already current.",
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_unfiled_ask_count',
      description:
        'Read your own unfiled-ask count — asks that appeared in your chat with no matching filed review item. Query it at session start or before standing down; above zero is drift to fix by filing review items instead. Not a live measurement: the server cannot see chat, so the number is whatever the daily audit last published. `today: null` means no audit covered today and `latest: null` means none ever covered you — neither is innocence.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: "Display name to read; defaults to this session's own (CW_AGENT_NAME).",
          },
        },
      },
    },
    {
      name: 'publish_chat_audit',
      description:
        "For the daily chat audit: publish per-agent unfiled-ask counts so each session can read its own back with get_unfiled_ask_count. Both numbers are the same stored row, so reference these counts in the audit report rather than recomputing them. Publishing again for the same agent supersedes — latest wins, history kept. The bare name 'agent' is refused: counts belong to somebody.",
      inputSchema: {
        type: 'object',
        properties: {
          day: { type: 'string', description: 'Audited day, YYYY-MM-DD. Defaults to today.' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                agent: {
                  type: 'string',
                  description: 'Display name (CW_AGENT_NAME) the count belongs to.',
                },
                unfiledAsks: {
                  type: 'number',
                  description:
                    "Asks that appeared in that agent's chat with no matching filed review item.",
                },
                totalAsks: { type: 'number' },
                sessionId: { type: 'string' },
                note: { type: 'string', description: 'Evidence pointer.' },
              },
              required: ['agent', 'unfiledAsks'],
            },
          },
        },
        required: ['entries'],
      },
    },
    {
      name: 'list_attachments',
      description:
        "List the agents attached to a hub workspace with their derived state: active, 'process up, agent unresponsive' (fresh heartbeat, stale tool calls), or 'away — requests queue'. The ambient-awareness read: who is where, and is anyone wedged.",
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
        required: ['workspaceId'],
      },
    },
  ],
}));

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
    switch (name) {
      case 'list_docs': {
        // The param has to reach the wire: this handler used to issue a bare
        // GET, so a caller's workspaceId was accepted and silently dropped —
        // a board-scoped question answered with the whole server.
        const { workspaceId } = a as { workspaceId?: string };
        const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
        const res = await http('GET', `/api/docs${qs}`);
        return ok(res);
      }
      case 'list_threads': {
        const { docId, status } = a as { docId: string; status?: string };
        const qs = status ? `?status=${encodeURIComponent(status)}` : '';
        const res = await http('GET', `/api/docs/${encodeURIComponent(docId)}/threads${qs}`);
        return ok(res);
      }
      case 'get_thread': {
        const { docId, threadId } = a as { docId: string; threadId: string };
        const res = await http(
          'GET',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}`,
        );
        return ok(res);
      }
      case 'post_reply': {
        const { docId, threadId, text, review } = a as {
          docId: string;
          threadId: string;
          text: string;
          review?: unknown;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/comments`,
          { author: AUTHOR, text, ...(review !== undefined ? { review } : {}) },
        );
        return ok(res);
      }
      case 'create_thread': {
        // Two endpoints; omitting `find` opens the thread on the subject.
        // See thread-create.ts.
        const { path, body } = threadCreateRequest(a as unknown as ThreadCreateInput, AUTHOR);
        const res = await http('POST', path, body);
        return ok(res);
      }
      case 'resolve_thread': {
        const { docId, threadId } = a as { docId: string; threadId: string };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/resolve`,
        );
        return ok(res);
      }
      case 'summarize_thread': {
        const { docId, threadId, force } = a as {
          docId: string;
          threadId: string;
          force?: boolean;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/summary`,
          force ? { force: true } : undefined,
        );
        return ok(res);
      }
      case 'reopen_thread': {
        const { docId, threadId } = a as { docId: string; threadId: string };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/reopen`,
        );
        return ok(res);
      }
      case 'get_doc': {
        const { docId } = a as { docId: string };
        // `reader` records that THIS session's copy of the doc is current as
        // of now — the marker the stale-write guard compares against the last
        // human edit before allowing a set_doc_content from this author.
        const res = await http(
          'GET',
          `/api/docs/${encodeURIComponent(docId)}/content?reader=${encodeURIComponent(AUTHOR.id)}`,
        );
        return ok(res);
      }
      case 'doc_status': {
        const { docId } = a as { docId: string };
        const res = await http('GET', `/api/docs/${encodeURIComponent(docId)}/status`);
        return ok(res);
      }
      case 'create_review_doc': {
        const { docId, path, title, setId, hubWorkspaceId, producedBy } = a as {
          docId: string;
          path: string;
          title?: string;
          setId?: string;
          hubWorkspaceId?: string;
          producedBy?: { agentId?: string; sessionId?: string };
        };
        const res = await http('POST', '/api/docs', {
          docId,
          type: 'markdown',
          sourceUrl: path,
          owner: process.cwd(),
          ...(title ? { title } : {}),
          ...(setId ? { setId } : {}),
          ...(hubWorkspaceId ? { hubWorkspaceId } : {}),
          ...(producedBy ? { producedBy } : {}),
        });
        return ok(res);
      }
      case 'set_doc_content': {
        const { docId, markdown, confirmOverwriteHumanEdits } = a as {
          docId: string;
          markdown: string;
          confirmOverwriteHumanEdits?: boolean;
        };
        // Author: sent so a rewrite of a `task:<id>` body room can be
        // attributed the way `rewrite_task` is — and so the stale-write guard
        // can judge this caller by its own get_doc reads instead of the blunt
        // 10-minute window. The confirm flag is forwarded only when true:
        // the default path stays the protected one.
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/content`, {
          markdown,
          author: AUTHOR,
          ...(confirmOverwriteHumanEdits === true ? { confirmOverwriteHumanEdits: true } : {}),
        });
        return ok(res);
      }
      case 'reparse_from_disk': {
        const { docId } = a as { docId: string };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/reparse_from_disk`);
        return ok(res);
      }
      case 'delete_doc': {
        const { docId, force } = a as { docId: string; force?: boolean };
        const qs = force ? '?force=true' : '';
        const res = await http('DELETE', `/api/docs/${encodeURIComponent(docId)}${qs}`);
        return ok(res);
      }
      case 'bind_mock': {
        const { docId, sourceHtmlPath, title, hubWorkspaceId } = a as {
          docId: string;
          sourceHtmlPath?: string;
          title?: string;
          hubWorkspaceId?: string;
        };
        // Same POST /api/docs route as create_review_doc, with type='mockup'.
        // The server's getOrCreate accepts both shapes; `sourceUrl` is optional
        // for mockups (mockups are served via /demos/ rather than file-watched).
        const res = await http('POST', '/api/docs', {
          docId,
          type: 'mockup',
          owner: process.cwd(),
          ...(sourceHtmlPath ? { sourceUrl: sourceHtmlPath } : {}),
          ...(title ? { title } : {}),
          ...(hubWorkspaceId ? { hubWorkspaceId } : {}),
        });
        return ok(res);
      }
      case 'bind_folder': {
        const {
          folderPath,
          workspaceId,
          hubWorkspaceId,
          title,
          include,
          exclude,
          maxFiles,
          subscribe,
          producedBy,
        } = a as {
          folderPath: string;
          workspaceId?: string;
          hubWorkspaceId?: string;
          title?: string;
          include?: string[];
          exclude?: string[];
          maxFiles?: number;
          subscribe?: boolean;
          producedBy?: { agentId?: string; sessionId?: string };
        };
        const res = (await http('POST', '/api/workspaces', {
          folderPath,
          owner: process.cwd(),
          ...(workspaceId ? { workspaceId } : {}),
          // The BOARD, next to the review id above. Two ids, two meanings,
          // one payload — which is why they are spelled apart.
          ...(hubWorkspaceId ? { hubWorkspaceId } : {}),
          ...(title ? { title } : {}),
          ...(include ? { include } : {}),
          ...(exclude ? { exclude } : {}),
          ...(maxFiles !== undefined ? { maxFiles } : {}),
          ...(producedBy ? { producedBy } : {}),
        })) as { ok?: boolean; files?: Array<{ docId: string }> };
        // One workspace-level stream covers every member doc (including
        // files the reviewer opens lazily later). Opt out with subscribe:false.
        if (subscribe !== false && (res as { ok?: boolean; workspaceId?: string })?.workspaceId) {
          await watchWorkspace((res as { workspaceId: string }).workspaceId);
        }
        return ok(res);
      }
      case 'create_diff_review': {
        const {
          repo,
          base,
          target,
          reviewId,
          hubWorkspaceId,
          title,
          exclude,
          groups,
          maxFiles,
          subscribe,
          producedBy,
        } = a as {
          repo: string;
          base: string;
          target?: string;
          reviewId?: string;
          hubWorkspaceId?: string;
          title?: string;
          exclude?: string[];
          groups?: Array<{ title: string; paths: string[]; details?: string }>;
          maxFiles?: number;
          subscribe?: boolean;
          producedBy?: { agentId?: string; sessionId?: string };
        };
        const res = (await http('POST', '/api/diffs', {
          repo,
          base,
          ...(target ? { target } : {}),
          owner: process.cwd(),
          ...(reviewId ? { reviewId } : {}),
          // The BOARD, next to the review id above. Two ids, two meanings,
          // one payload — which is why they are spelled apart.
          ...(hubWorkspaceId ? { hubWorkspaceId } : {}),
          ...(title ? { title } : {}),
          ...(exclude ? { exclude } : {}),
          ...(groups ? { groups } : {}),
          ...(maxFiles !== undefined ? { maxFiles } : {}),
          ...(producedBy ? { producedBy } : {}),
        })) as { ok?: boolean; files?: Array<{ docId: string }> };
        // One workspace-level stream covers every member doc (including
        // files opened lazily from the all-files sidebar later). Opt out
        // with subscribe:false.
        if (subscribe !== false && (res as { reviewId?: string })?.reviewId) {
          await watchWorkspace((res as { reviewId: string }).reviewId);
        }
        return ok(res);
      }
      case 'delete_review': {
        const { setId, force, purge } = a as { setId: string; force?: boolean; purge?: boolean };
        const params = [force ? 'force=true' : '', purge ? 'purge=true' : ''].filter(Boolean);
        const qs = params.length > 0 ? `?${params.join('&')}` : '';
        const res = await http('DELETE', `/api/reviews/${encodeURIComponent(setId)}${qs}`);
        return ok(res);
      }
      case 'archive_review': {
        const { setId, reason } = a as { setId: string; reason?: string };
        const res = await http('POST', `/api/reviews/${encodeURIComponent(setId)}/archive`, {
          author: AUTHOR,
          ...(reason !== undefined ? { reason } : {}),
        });
        return ok(res);
      }
      case 'unarchive_review': {
        const { setId } = a as { setId: string };
        const res = await http('POST', `/api/reviews/${encodeURIComponent(setId)}/unarchive`, {
          author: AUTHOR,
        });
        return ok(res);
      }
      case 'archive_doc': {
        const { docId, reason } = a as { docId: string; reason?: string };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/archive`, {
          author: AUTHOR,
          ...(reason !== undefined ? { reason } : {}),
        });
        return ok(res);
      }
      case 'unarchive_doc': {
        const { docId } = a as { docId: string };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/unarchive`, {
          author: AUTHOR,
        });
        return ok(res);
      }
      case 'list_archived_reviews': {
        const res = await http('GET', '/api/reviews/archived');
        return ok(res);
      }
      case 'delete_workspace': {
        const { workspaceId, force, purge } = a as {
          workspaceId: string;
          force?: boolean;
          purge?: boolean;
        };
        const params = [force ? 'force=true' : '', purge ? 'purge=true' : ''].filter(Boolean);
        const qs = params.length > 0 ? `?${params.join('&')}` : '';
        // The one route that still fronts both stores, dispatching by id — a
        // board here, a review if that is what the id turns out to be. See
        // the compat note on it in the server's route table. `purge` only
        // reaches the review branch; a board's delete is unchanged.
        const res = await http('DELETE', `/api/workspaces/${encodeURIComponent(workspaceId)}${qs}`);
        return ok(res);
      }
      // COMPAT: `refresh_workspace` and `set_workspace_groups` are the names
      // these two had before a review stopped being called a workspace. An
      // agent working from a stale skill or from memory reaches for the old
      // name, and either key for the id; both are accepted here so it lands
      // instead of erroring. The tool LIST advertises the new names only.
      case 'refresh_workspace':
      case 'refresh_review': {
        const { setId, workspaceId } = a as { setId?: string; workspaceId?: string };
        const id = setId ?? workspaceId ?? '';
        const res = await http('POST', `/api/reviews/${encodeURIComponent(id)}/refresh`, {});
        return ok(res);
      }
      case 'set_workspace_groups':
      case 'set_review_groups': {
        const { setId, workspaceId, groups } = a as {
          setId?: string;
          workspaceId?: string;
          groups: Array<{ title: string; paths: string[]; details?: string }>;
        };
        const id = setId ?? workspaceId ?? '';
        const res = await http('POST', `/api/reviews/${encodeURIComponent(id)}/groups`, {
          groups,
        });
        return ok(res);
      }
      case 'find_and_replace': {
        const {
          docId,
          find,
          replace,
          contextBefore,
          contextAfter,
          occurrence,
          replaceAll,
          parseInlineMarks,
          suggest,
        } = a as {
          docId: string;
          find: string;
          replace: string;
          contextBefore?: string;
          contextAfter?: string;
          occurrence?: number;
          replaceAll?: boolean;
          parseInlineMarks?: boolean;
          suggest?: boolean;
        };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/find_and_replace`, {
          find,
          replace,
          ...(contextBefore !== undefined ? { contextBefore } : {}),
          ...(contextAfter !== undefined ? { contextAfter } : {}),
          ...(occurrence !== undefined ? { occurrence } : {}),
          ...(replaceAll === true ? { replaceAll: true } : {}),
          ...(parseInlineMarks === true ? { parseInlineMarks: true } : {}),
          ...(suggest === true ? { suggest: true, author: suggestionAuthor() } : {}),
        });
        return ok(res);
      }
      case 'rewrite_thread_region': {
        const { docId, threadId, replacement, parseInlineMarks, suggest } = a as {
          docId: string;
          threadId: string;
          replacement: string;
          parseInlineMarks?: boolean;
          suggest?: boolean;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/rewrite_region`,
          {
            replacement,
            ...(parseInlineMarks === true ? { parseInlineMarks: true } : {}),
            ...(suggest === true ? { suggest: true, author: suggestionAuthor() } : {}),
          },
        );
        return ok(res);
      }
      case 'list_suggestions': {
        const { docId } = a as { docId: string };
        const res = await http('GET', `/api/docs/${encodeURIComponent(docId)}/suggestions`);
        return ok(res);
      }
      case 'accept_suggestion': {
        const { docId, sid } = a as { docId: string; sid: string };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(sid)}/accept`,
        );
        return ok(res);
      }
      case 'reject_suggestion': {
        const { docId, sid } = a as { docId: string; sid: string };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(sid)}/reject`,
        );
        return ok(res);
      }
      case 'resolve_all_suggestions': {
        const { docId, action, authorId } = a as {
          docId: string;
          action: 'accept' | 'reject';
          authorId?: string;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/suggestions/resolve_all`,
          { action, ...(authorId !== undefined ? { authorId } : {}) },
        );
        return ok(res);
      }
      case 'insert_after_thread': {
        const { docId, threadId, text } = a as {
          docId: string;
          threadId: string;
          text: string;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/insert_after`,
          { text },
        );
        return ok(res);
      }
      case 'insert_blocks_after_thread': {
        const { docId, threadId, markdown, placement } = a as {
          docId: string;
          threadId: string;
          markdown: string;
          placement?: 'after-block' | 'top-level';
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/insert_blocks_after`,
          { markdown, ...(placement !== undefined ? { placement } : {}) },
        );
        return ok(res);
      }
      case 'create_anchor': {
        const { docId, find, contextBefore, contextAfter, occurrence, label } = a as {
          docId: string;
          find: string;
          contextBefore?: string;
          contextAfter?: string;
          occurrence?: number;
          label?: string;
        };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/agent_anchors`, {
          find,
          ...(contextBefore !== undefined ? { contextBefore } : {}),
          ...(contextAfter !== undefined ? { contextAfter } : {}),
          ...(occurrence !== undefined ? { occurrence } : {}),
          ...(label !== undefined ? { label } : {}),
        });
        return ok(res);
      }
      case 'edit_at_anchor': {
        const { docId, anchorId, op } = a as {
          docId: string;
          anchorId: string;
          op: { kind: 'replace' | 'insert_after'; text: string };
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/agent_anchors/${encodeURIComponent(anchorId)}/edit`,
          op,
        );
        return ok(res);
      }
      case 'insert_blocks_at_anchor': {
        const { docId, anchorId, markdown, placement } = a as {
          docId: string;
          anchorId: string;
          markdown: string;
          placement?: 'after-block' | 'top-level';
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/agent_anchors/${encodeURIComponent(anchorId)}/insert_blocks`,
          { markdown, ...(placement !== undefined ? { placement } : {}) },
        );
        return ok(res);
      }
      case 'delete_anchor': {
        const { docId, anchorId } = a as { docId: string; anchorId: string };
        const res = await http(
          'DELETE',
          `/api/docs/${encodeURIComponent(docId)}/agent_anchors/${encodeURIComponent(anchorId)}`,
        );
        return ok(res);
      }
      case 'delete_block_at_anchor': {
        const { docId, threadId, anchorId } = a as {
          docId: string;
          threadId?: string;
          anchorId?: string;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/delete_block_at_anchor`,
          {
            ...(threadId !== undefined ? { threadId } : {}),
            ...(anchorId !== undefined ? { anchorId } : {}),
          },
        );
        return ok(res);
      }
      case 'delete_blocks_in_range': {
        const {
          docId,
          startFind,
          endFind,
          contextBefore,
          contextAfter,
          startOccurrence,
          endOccurrence,
        } = a as {
          docId: string;
          startFind: string;
          endFind: string;
          contextBefore?: string;
          contextAfter?: string;
          startOccurrence?: number;
          endOccurrence?: number;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/delete_blocks_in_range`,
          {
            startFind,
            endFind,
            ...(contextBefore !== undefined ? { contextBefore } : {}),
            ...(contextAfter !== undefined ? { contextAfter } : {}),
            ...(startOccurrence !== undefined ? { startOccurrence } : {}),
            ...(endOccurrence !== undefined ? { endOccurrence } : {}),
          },
        );
        return ok(res);
      }
      case 'delete_section': {
        const { docId, heading, level, occurrence } = a as {
          docId: string;
          heading: string;
          level?: number;
          occurrence?: number;
        };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/delete_section`, {
          heading,
          ...(level !== undefined ? { level } : {}),
          ...(occurrence !== undefined ? { occurrence } : {}),
        });
        return ok(res);
      }
      case 'observe_url': {
        const { docId } = a as { docId: string };
        return ok({ sseUrl: `${resolveBaseUrl()}/events/${encodeURIComponent(docId)}` });
      }
      case 'watch_doc': {
        const { docId } = a as { docId: string };
        const persisted = await watchDoc(docId);
        return ok({
          docId,
          watching: Array.from(watchers.keys()),
          persisted,
          persistence: watchPersistenceMode(),
        });
      }
      case 'unwatch_doc': {
        const { docId } = a as { docId: string };
        const persisted = await unwatchDoc(docId);
        return ok({
          docId,
          watching: Array.from(watchers.keys()),
          persisted,
          persistence: watchPersistenceMode(),
        });
      }
      case 'list_watched_docs': {
        // `watching` answers "what am I subscribed to". `coverage` answers
        // the question that actually goes wrong: what am I MISSING. Six live
        // watches is a true answer to the first and an all-clear to nobody —
        // the peer that measured this held exactly that while a voice note
        // queued for a board it had never attached to. Absent rather than
        // empty when the server did not say.
        const coverage = await refreshCoverage();
        return ok({
          watching: Array.from(watchers.keys()),
          persistence: {
            mode: watchPersistenceMode(),
            agentId: AUTHOR.id,
            ...(IDENTITY_IS_SHARED ? { reason: SHARED_IDENTITY_REASON } : {}),
          },
          restore: restoreState,
          ...(coverage ? { coverage } : {}),
          ...(lastPersistError ? { lastPersistError } : {}),
        });
      }
      case 'share_workspace': {
        const {
          workspaceId,
          allowDomains,
          ttlSeconds,
          name: slug,
        } = a as {
          workspaceId: string;
          allowDomains: string[];
          ttlSeconds?: number;
          name?: string;
        };
        const res = await http('POST', '/api/share/workspace', {
          workspaceId,
          allowDomains,
          ttlSeconds,
          name: slug,
        });
        return ok(res);
      }
      case 'share_link': {
        const { workspaceId, ttlSeconds, label } = a as {
          workspaceId: string;
          ttlSeconds?: number;
          label?: string;
        };
        const res = await http('POST', '/api/share/link', {
          workspaceId,
          ttlSeconds,
          label,
        });
        return ok(res);
      }
      case 'set_share_ttl': {
        const { shareId, ttlSeconds } = a as { shareId: string; ttlSeconds: number };
        const res = await http('POST', `/api/share/${encodeURIComponent(shareId)}/ttl`, {
          ttlSeconds,
        });
        return ok(res);
      }
      case 'list_shares': {
        const res = await http('GET', '/api/share');
        return ok(res);
      }
      case 'unshare': {
        const { shareId } = a as { shareId: string };
        const res = await http('DELETE', `/api/share/${encodeURIComponent(shareId)}`);
        return ok(res);
      }
      case 'set_sharing_enabled': {
        const { enabled } = a as { enabled?: boolean };
        // No argument = read-only. GET /api/share carries the same `sharing`
        // object the POST returns, so a status check costs nothing and can't
        // change anything by accident.
        if (typeof enabled !== 'boolean') {
          const res = await http('GET', '/api/share');
          return ok(res);
        }
        const res = await http('POST', '/api/share/enabled', { enabled });
        return ok(res);
      }
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
        return ok(
          await declareWorkspaceLead(
            {
              workspaceId,
              ...(leadAgentId !== undefined ? { leadAgentId } : {}),
              ...(takeover === true ? { takeover: true } : {}),
            },
            {
              http,
              watchWorkspace,
              self: AUTHOR,
              runtime: 'claude-code-local',
              pluginVersion: PLUGIN_VERSION,
              processId: PROCESS_ID,
            },
          ),
        );
      }
      case 'attach_doc': {
        const { workspaceId, docId } = a as { workspaceId: string; docId: string };
        const res = (await http('POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/docs`, {
          docId,
        })) as { workspace?: { docIds?: string[] } };
        return ok({ ok: true, workspaceId, docIds: res.workspace?.docIds ?? [] });
      }
      case 'create_tasks': {
        const { workspaceId, tasks } = a as { workspaceId: string; tasks: unknown[] };
        const res = (await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks/batch`,
          { tasks, author: AUTHOR },
        )) as {
          tasks: TaskPayload[];
          failures: Array<{ index: number; title?: string; error: string; message?: string }>;
          ignoredLinks?: Array<{ taskId: string; ignored: unknown[] }>;
          shapeGaps?: Array<{ taskId: string; gaps: string[] }>;
          reviewAdvice?: Array<{ taskId: string; advice: string }>;
          visibility?: Array<{ taskId: string; note: string }>;
          placement?: { unplaced: string[]; goals: unknown[] };
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
        const unplaced = new Set(res.placement?.unplaced ?? []);
        return ok({
          // Board order, carrying the title so the caller can match rows back
          // to what it sent without holding its own index — the returned
          // order is deliberately NOT the order it sent them in.
          created: res.tasks.map((t) => ({
            title: t.title,
            ...taskCreatedSummary(t, droppedFor(t.id), gapsFor(t.id), !unplaced.has(t.id)),
            ...(adviceFor(t.id) !== undefined ? { reviewAdvice: adviceFor(t.id) } : {}),
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
          };
          goalSummary: unknown[];
          retired?: { since: number; reason?: string; notice: string };
        };
        return ok({
          workspaceId: res.workspace.id,
          name: res.workspace.name,
          // Absent means nobody is responsible for this board — its asks
          // have no addressee until someone attaches or takes the seat.
          leadAgentId: res.workspace.leadAgentId,
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
          created: Array<{ id: string; title: string; parent?: string }>;
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
        const { workspaceId, order, parent } = a as {
          workspaceId: string;
          order: string[];
          parent?: string;
        };
        const res = (await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/goals/reorder`,
          {
            order,
            ...(parent !== undefined ? { parent } : {}),
            author: AUTHOR,
          },
        )) as { changed: boolean; order: string[] };
        return ok({
          workspaceId,
          ...(parent !== undefined ? { parent } : {}),
          order: res.order,
          changed: res.changed,
        });
      }
      case 'add_review_item': {
        const { taskId, review } = a as { taskId: string; review: unknown };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/review-items`, {
          review,
          author: AUTHOR,
        })) as { item?: { id?: string }; reviewAdvice?: string };
        return ok({
          taskId,
          reviewItemId: res.item?.id,
          // The gaps the server found in the shape. Dropping it here is the
          // "one layer away from where it's consumed" failure: the server
          // computed the advice, and the only party that can still act on it
          // never hears it.
          ...(res.reviewAdvice !== undefined ? { reviewAdvice: res.reviewAdvice } : {}),
        });
      }
      case 'answer_review_item': {
        const { taskId, reviewItemId, text, answeredWith } = a as {
          taskId: string;
          reviewItemId?: string;
          text: string;
          answeredWith?: string;
        };
        const res = await recordReviewAnswer({
          taskId,
          text,
          ...(reviewItemId !== undefined ? { reviewItemId } : {}),
          ...(answeredWith !== undefined ? { answeredWith } : {}),
        });
        return ok({
          taskId,
          ...(reviewItemId !== undefined ? { reviewItemId } : {}),
          recorded: true,
          links: res.task.links ?? [],
        });
      }
      case 'request_more_info': {
        const { taskId, reviewItemId, question } = a as {
          taskId: string;
          reviewItemId?: string;
          question: string;
        };
        const path =
          reviewItemId === undefined
            ? `/api/tasks/${encodeURIComponent(taskId)}/more-info`
            : `/api/tasks/${encodeURIComponent(taskId)}/review-items/${encodeURIComponent(reviewItemId)}/more-info`;
        const res = (await http('POST', path, { question, author: AUTHOR })) as {
          task: TaskPayload;
        };
        return ok({
          taskId,
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

interface RestoreState {
  /** `restored` — the server answered and its set is wired (possibly empty:
   *  never watched anything under this identity). `session-only` — no stable
   *  identity, nothing to restore from. `pending` — not tried yet. `failed` —
   *  the server did not answer; retried on the next tool call. */
  status: 'pending' | 'restored' | 'session-only' | 'failed';
  from: 'server' | 'session';
  /** Keys re-wired from the server's set on this process's restore. */
  restored: string[];
  /** Boards this session was re-ATTACHED to on restore — the half a
   *  re-wired watch key does not cover, since every delivery gate asks for a
   *  live attachment and the old record comes back stale. */
  reattached?: string[];
  /** Keys the server dropped as dead (their doc no longer exists). */
  pruned: string[];
  at?: string;
  error?: string;
  attempts: number;
}

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
  if (shouldForwardFrame.shouldForward(ev, payload)) {
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
  thread?: {
    anchor?: { snippet?: { text?: string }; original?: { snippet?: { text?: string } } };
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
async function emitHubChannelMessage(event: string, rawPayload: unknown): Promise<void> {
  const p = (rawPayload ?? {}) as HubEventPayload;
  if (event === 'agent.heartbeat') return;
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
  const body = text
    ? `[${action}] ${author ? `${author}: ` : ''}${text}`
    : `[${action}]${author ? ` by ${author} —` : ''} thread ${threadId} ${header}`.trim();

  await server.notification({
    method: 'notifications/claude/channel',
    params: {
      source: 'claude-workspaces',
      sent_at: sentAt,
      content: body,
      meta: {
        doc_id: docId,
        thread_id: threadId,
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
