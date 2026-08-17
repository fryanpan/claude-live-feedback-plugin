#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveAgentAuthor } from './author.ts';
import { type ThreadCreateInput, threadCreateRequest } from './thread-create.ts';
import { RETRIAGE_SKILL, triageRequestLine } from './triage-line.ts';

/**
 * Thin MCP server that proxies tool calls to a running feedback server
 * over HTTP. Agents launch this binary via stdio; it calls the main
 * server's REST API so state is authoritative there.
 *
 * Base URL resolution (first hit wins):
 *   1. $FEEDBACK_BASE_URL — explicit override
 *   2. ~/.claude/live-feedback/server.json — written by scripts/serve.ts
 *      on startup so the MCP auto-finds whichever port the server landed on
 *   3. http://localhost:8787 — last-resort default
 *
 * env:
 *   FEEDBACK_BASE_URL    — optional override; usually discovery handles it
 *   FEEDBACK_AGENT_NAME  — this agent's display name (e.g. "Quick Build");
 *                          wins over FEEDBACK_AUTHOR, which the plugin's
 *                          .mcp.json pins to `agent` for every peer
 *   FEEDBACK_AUTHOR      — fallback author key/name (default: agent)
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
  if (process.env.FEEDBACK_BASE_URL) return process.env.FEEDBACK_BASE_URL;
  const discovery = join(homedir(), '.claude', 'live-feedback', 'server.json');
  if (existsSync(discovery)) {
    try {
      const j = JSON.parse(readFileSync(discovery, 'utf8')) as { port?: number };
      if (j.port) return `http://localhost:${j.port}`;
    } catch {
      // fall through to throw — corrupt discovery file
    }
  }
  throw new Error(
    'live-feedback server not found — start it with `bun run dev` (or set FEEDBACK_BASE_URL). ' +
      `Looked for discovery file at ${discovery}.`,
  );
}
const AUTHOR = resolveAgentAuthor({
  FEEDBACK_AUTHOR: process.env.FEEDBACK_AUTHOR,
  FEEDBACK_AGENT_NAME: process.env.FEEDBACK_AGENT_NAME,
});

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
const PLUGIN_VERSION = '0.1.45';

const server = new Server(
  {
    name: 'claude-live-feedback',
    version: PLUGIN_VERSION,
  },
  {
    capabilities: {
      tools: {},
      // Declares this server as a Claude Code channel — incoming feedback
      // events get pushed to the session as <channel source="live-feedback" …>
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
      'have destroyed content in the field). External edits (VS Code, git pull)',
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
      'them; refresh_workspace(reviewId) to re-sync membership and groupings as files move (threads survive); delete_workspace(reviewId) when the review is done.',
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
      '<channel source="live-feedback" doc_id="..." thread_id="..." event="..." author="..." sent_at="...">body</channel>',
      'messages. Treat each as an explicit ask from the reviewer; read, decide if it',
      "is in your domain, act via an edit tool. unwatch_doc when you're done.",
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
      'Chores awaiting triage — the create says so and hands you the goal',
      'bands, and placing it with set_task_goal IS the triage:',
      'pick the goal AND the exact position, and pass riskTier for how dangerous',
      'the ACTION is, not how important the task is). task_transition is the',
      'single gate for status changes — blockers come back in the result, and',
      'attach evidence ({commit} or {threadRef}) or the move is flagged unproven.',
      'attach_agent registers you as the workspace agent (heartbeat every few',
      'minutes to stay live; triage requests only reach live agents). Workspace',
      'events (task.*, decision.answered, triage.requested, workspace.goal_updated)',
      'arrive on the same channel as thread events once you create/attach.',
      'import_tasks_markdown moves an existing hand-maintained markdown tracker',
      'onto the board (dry-run first — review the mapping before apply:true).',
    ].join(' '),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_docs',
      description: 'List review docs currently registered on the server.',
      inputSchema: { type: 'object', properties: {} },
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
      description: 'Post a reply to an existing thread (as the configured author).',
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
      name: 'create_thread',
      description:
        'Open a new comment thread on a doc, seeded with an initial comment from the configured author. Use when the agent has editorial notes / suggestions that should land as durable threads (instead of one-shot chat messages) — e.g. running `/edit` on a blog draft and leaving anchored feedback at six different places. Pass `find` to anchor the thread to that text; disambiguation works the same as `find_and_replace` (`contextBefore`/`contextAfter` or `occurrence` if the text appears more than once). OMIT `find` to open a thread about the doc AS A WHOLE — this is how you discuss a hub task, whose body doc is `task:<taskId>` and is often still empty: `create_thread(docId="task:t-abc", text="...")`. A subject thread never orphans. Returns `{ thread }` with `thread.id` for follow-up `post_reply` calls, and fires the same `thread.created` event the editor uses, so watchers see it immediately.',
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
        "Generate the two summary lines (topic + discussion) shown on a thread's collapsed card, and store them on the thread so every open browser picks them up immediately. Normally you do NOT need this: the server generates a summary automatically ~3s after any thread change. Reach for it when you want a summary right now — e.g. you just posted a long reply and want the card to read correctly before you hand the review URL to someone. A thread whose stored summary already matches its current state is returned as-is with cached:true and costs nothing; pass force:true to regenerate anyway. Two expected failures come back as tool ERRORS, not as a result field — the error text carries the HTTP status. A 503 (summaries disabled) means no API key is configured or LF_SUMMARIES=0; the card keeps its deterministic lines, nothing is broken, and retrying will not help. A 409 (thread changed during generation) means a reply landed mid-call and the summary would have described the older thread — just call it again.",
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
        'Read the current state of a review doc: plain-text body, block structure (heading/paragraph/list hints), and thread summary. The plain text is the target surface for find_and_replace and reflects concurrent user edits.',
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'create_review_doc',
      description:
        "Create a markdown review doc backed by a file on disk. The server reads the file, parses it into the live editor, and sets up bidirectional sync — every edit (from the browser, the agent, or the widget) writes back to the .md within ~1 second, and external edits to the file (VS Code, git pull) flow into the live doc within ~1 second via fs.watch. Note: the disk→doc sync races against the doc→disk write-back; if you Write/Edit a bound .md while LF has any pending state, your file edit can be silently clobbered by the next flush. Route programmatic edits through the LF tools once a doc is bound — `find_and_replace` / `rewrite_thread_region` for targeted edits, `set_doc_content` for a whole-doc rewrite — and call `reparse_from_disk(docId)` only to force-pull an edit that already happened externally. `path` should be absolute; relative paths resolve against the server's cwd. The file must exist (create it first if it doesn't). Pass `setId` to group multiple docs for one review session — docs sharing a setId show up in each other's sidebar in the markdown editor, so the reviewer can hop between related files. The caller is auto-subscribed to thread events for this doc (`watch_doc`) on creation so comments arrive as channel messages without a separate call; pass `subscribe: false` for the rare drive-by case where another agent will own the review. Returns the review URL plus the attach result.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' },
          setId: { type: 'string' },
          subscribe: { type: 'boolean' },
          hubWorkspaceId: {
            type: 'string',
            description:
              'Optional hub workspace (board) to file this doc under — the id `create_workspace` returned, NOT a folder-bind grouping id. Omit it and the doc still lands in a workspace: the server files it under the default "Unfiled" board and returns `hubWorkspaceId` so you know where it went. Filing it later with attach_doc moves it out of Unfiled.',
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
        "Replace the WHOLE document with new markdown — the safe path for a comprehensive rewrite/restructure. Applies as a block-level diff on the live doc: blocks you didn't change keep their identity, so comment threads anchored to them survive, connected editors update live, and the result flushes to the bound .md within ~1s like any other edit. Use this INSTEAD of Write-ing the bound file (then reparse_from_disk) or the delete_doc → Write → create_review_doc dance — both race the write-back and have clobbered files in practice, and the latter orphans every comment thread. On a `task:<taskId>` docId (a task's description) this now does everything `update_task_body` does except retitle — preserves the row's original words into `quote` and records an attributed `task.body_edited` — so it no longer silently erases a capture; prefer `update_task_body` anyway, since it also retitles and hands back the `quote` it preserved. Returns ok:false with error 'unsupported' (code/diff docs are read-only), 'empty' (won't wipe a doc to nothing — use delete_doc if you mean that), 'parse-failed', or 'not-found'.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          markdown: { type: 'string', description: 'Full replacement markdown for the doc.' },
        },
        required: ['docId', 'markdown'],
      },
    },
    {
      name: 'reparse_from_disk',
      description:
        "Force-pull the bound .md file from disk into the live doc, replacing the doc's current content with a fresh parse of the file. Recovery tool for when an external edit (Write/Edit/git pull) didn't propagate — e.g. the file watcher went stale after an editor's rename-based save, or a prior reconcile failed. Bypasses the lastWritten / serialized-match guards that normally suppress redundant reparses. DESTRUCTIVE: any un-flushed live edits are overwritten by disk content, and thread anchors in replaced regions may orphan (auto-reanchor re-attaches the common case). Use it when get_doc returns stale content or a `syncError`. Returns ok:false with error 'no-binding' (doc isn't file-backed), 'missing' (file gone/empty), or 'not-found' (unknown docId).",
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'delete_doc',
      description:
        "Permanently delete a review doc you no longer need. Drops the live doc, cancels its sync, and removes the persisted state so it won't reload — but leaves the bound SOURCE .md file on disk untouched (only the review session is removed). Most review docs are short-lived: you bind one, get feedback for ~30 minutes, and then it's obsolete — call delete_doc to clean it up instead of letting it linger in list_docs forever. GUARDRAIL: refuses with ok:false, error:'has-open-threads' (+ openThreads count) if the doc still has OPEN comment threads, since that means someone is still waiting on that feedback — resolve_thread the threads first, or pass force:true to delete anyway. Also returns error:'not-found' for an unknown docId. Safe to call on a doc bound to a now-deleted file. Prefer this over leaving stale docs around.",
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
        "Bind an HTML mockup to a docId AND serve it. `sourceHtmlPath` is an absolute path to an HTML file (typically one the agent just wrote, embedding `<claude-feedback-widget doc-id=\"...\">`). The server reads the file at that path on each request and streams it as HTML at `/mockup/<docId>` — no symlinking into the plugin's `demos/` directory required. Returns `meta.reviewUrl` pointing at the served URL; hand that to a human. Also auto-subscribes the caller to thread events on the doc (same as `create_review_doc`). Pass `subscribe: false` to skip the auto-watch (rare). Idempotent — calling twice on the same docId is safe; just updates the bound source path. Single-file mockups only: HTML that references sibling CSS/JS via relative paths won't resolve through this route since we don't serve the source directory. For multi-file mockups, drop the directory into the plugin's `demos/` and use `/demos/<dirname>/` as before.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          sourceHtmlPath: { type: 'string' },
          title: { type: 'string' },
          subscribe: { type: 'boolean' },
          hubWorkspaceId: {
            type: 'string',
            description:
              'Optional hub workspace (board) to file this mockup under — the id `create_workspace` returned, NOT a folder-bind grouping id. Omit it and the mockup still lands in a workspace: the server files it under the default "Unfiled" board and returns `hubWorkspaceId` so you know where it went.',
          },
        },
        required: ['docId', 'sourceHtmlPath'],
      },
    },
    {
      name: 'bind_folder',
      description:
        'Alias for create_diff_review WITHOUT a base: binds a folder/worktree as a BROWSE workspace. One entry doc binds eagerly (README preferred; markdown opens editable); every other file appears in the all-files sidebar and opens lazily on click — no eager per-file binds, no file-count cap. Prefer create_diff_review directly: pass base to ALSO get the PR-style changed-files diff on top of browsing. Returns the workspace id (the grouping), the hub workspace it was filed on (hubWorkspaceId — the board, so the bind is discoverable without the URL), root, scan fileCount, and the entry file.',
      inputSchema: {
        type: 'object',
        properties: {
          folderPath: { type: 'string' },
          exclude: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Path prefixes (relative to the folder) to keep out of the workspace, e.g. ['node_modules', 'vendor']. Persisted, so refresh_workspace replays it.",
          },
          workspaceId: { type: 'string' },
          hubWorkspaceId: {
            type: 'string',
            description:
              'Optional hub workspace (board) to file this bind under — the id `create_workspace` returned, and deliberately NOT `workspaceId` above, which is the GROUPING id this bind creates for its own member files. Omit it and the bind still lands on a board: the server files it under the default "Unfiled" board and returns `hubWorkspaceId` so you know where it went. The whole bind is ONE row on the board, never one per file.',
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
        "Create a GitHub-PR-style review of a git diff: point it at a local repo and a base ref, and the server creates one review doc per changed file, grouped as a workspace — the reviewer gets a file tree with per-file A/M/D/R + line-count badges, a unified diff view with old/new line numbers and collapsed unchanged regions, a per-file Diff ↔ whole-File toggle, and line-anchored comment threads in both views. DEFAULT MODE (no `target`): diff base → the WORKING TREE, i.e. the folder as it is right now, uncommitted edits and untracked files included. The docs bind to the live files on disk, so as you keep editing the code the reviewer's diff re-renders within ~1s — this is the live-loop mode. Comments stay anchored to their lines through edits (snippet-based auto-reanchor); if an anchored line disappears, the thread lands in the existing Orphaned/outdated section where the reviewer can re-anchor it. Once the review EXISTS, prefer refresh_workspace(reviewId) over re-running this tool: it re-reads the diff from the stored base (no need to remember the ref), picks up files that changed since, and flags members whose change was reverted — all without re-minting a docId. Re-running this tool is still idempotent (same docIds, threads survive). PINNED MODE (pass `target`): content is frozen at the target commit; anchors can never drift; same reviewId with a different range is rejected. `repo` is an absolute path to a local checkout/worktree; `base`/`target` are any refs git can resolve (hashes, branches, HEAD~2). Binary files and files over 512 KB are skipped and reported in skipped[]. Pass `exclude` (path prefixes, e.g. ['src/main/assets/vendored-repo']) to keep vendored or generated directories out of the review. GUARDRAIL: more than `maxFiles` (default 300) changed files → error 'too-many-files'; narrow with `exclude` or raise `maxFiles`. The caller is auto-subscribed to thread events on every file doc (pass subscribe:false to skip). Returns {reviewId, hubWorkspaceId, entryUrl, files[{docId, relPath, status, additions, deletions, reviewUrl}], skipped[]} — `hubWorkspaceId` is the board the whole review was filed on as ONE row, so a reviewer can find it without the URL — hand `entryUrl` to the human (the file tree navigates to the rest). Clean up with delete_workspace(reviewId) when the review is done. Comments on DELETED lines aren't supported yet — ask the reviewer to comment on an adjacent kept line.",
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
              'Optional hub workspace (board) to file this review under — the id `create_workspace` returned, and deliberately NOT `reviewId` above, which is the GROUPING id holding the review\'s member files. Omit it and the review still lands on a board: the server files it under the default "Unfiled" board and returns `hubWorkspaceId` so you know where it went. The whole review is ONE row on the board, never one per changed file. Filing is sticky — re-running this tool without `hubWorkspaceId` leaves a review on the board it is already on.',
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
              'Logical file groups for the sidebar — organize the changed files by INTENT, the way you would split a branch into reviewable commits. First group is read first. Each path matches a changed file EXACTLY or as a DIRECTORY PREFIX (e.g. "src/foo" claims every file under src/foo/), so you need not enumerate every file. First group (in array order) to claim a file wins; unlisted files fall into an "Other" group ranked last. Array order is the sidebar order. Optional per-group `details` is a short "chapter intro" rendered under the group title. It is capped at 500 characters and a longer value is REJECTED, not truncated — this is deliberate: write a curated 1–2 sentence summary of what the group does, do NOT paste the commit body or a diff summary. If a call is rejected for over-long details, shorten the intro and retry. Omit `groups` to fall back to the Tests/Docs/Build + top-level-module heuristic.',
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
      name: 'delete_workspace',
      description:
        "Permanently delete a whole workspace as ONE unit. Handles BOTH things called a workspace, dispatching on the id you pass. (1) A DOC GROUPING (a folder bound via bind_folder, or a diff review): drops every member review doc and cancels their sync — the bound SOURCE files on disk are left untouched. Use this when a worktree/folder review is done instead of calling delete_doc once per file. Its guardrail is ALL-OR-NOTHING: without force, if ANY member file still has OPEN comment threads, nothing is deleted and it returns ok:false, error:'has-open-threads' with files:[{docId, openThreads}] listing the offenders. (2) A HUB BOARD (created by create_workspace): drops the board, all of its tasks, its board room, every per-task body room, its event log and its persisted state — so a board minted for a short experiment doesn't become permanent. Its guardrail counts OPEN TASKS, not threads: without force it refuses with error:'has-open-tasks' and openTasks:<count>, so finish or close them first, or pass force:true. Docs ATTACHED to a hub board are deliberately left alive at their own URLs — attaching is a link, not ownership. Either way pass force:true to delete regardless, and either way error:'not-found' means nothing exists under that id. On success returns {ok:true} plus deleted:<docs> for a grouping or deletedTasks:<count> for a board.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          force: {
            type: 'boolean',
            description: 'Delete even if some member files have open threads. Default false.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'refresh_workspace',
      description:
        "Re-reconcile a workspace or diff review against what's on disk RIGHT NOW, WITHOUT re-minting any docId — so every existing comment thread survives. Use this instead of re-running create_diff_review / bind_folder when the review already exists and the files have moved under it. For a DIFF REVIEW it re-runs the diff from the stored base, so files you changed after creating the review join it and per-file status/line counts refresh; a member whose change you reverted is marked stale rather than deleted (its comments are still someone's feedback, and the change may come back). For a BROWSE workspace members bind lazily, so what refresh adds is the reverse sweep: members whose file was deleted or renamed away get marked stale. Stale is always reversible — the next refresh that finds the file clears it and lists it under restored. PINNED diff reviews (created with a `target`) are refused with error:'pinned': their content is a commit, so there is nothing to re-read. The review's bind-time `exclude`, `groups` and `maxFiles` are replayed automatically, so a refresh never widens the scope you set or scatters new files into heuristic buckets. Returns {ok, kind:'diff'|'browse', added[], stale[{docId, relPath, openThreads}], restored[], fileCount}. Read `stale` after a rename: those threads are now stranded on a file nobody will open, so re-anchor or resolve them. Errors: 'too-many-files' (the review outgrew its cap — re-run the bind with a higher maxFiles, or narrow it with exclude), 'not-found' (nothing bound under that id — including a folder that was bound while EMPTY, which creates no docs; re-run bind_folder, it derives the same workspaceId so shares and threads survive), 'root-missing' (the folder itself is gone).",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description: 'Workspace id from bind_folder, or reviewId from create_diff_review.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'set_workspace_groups',
      description:
        "Re-group an EXISTING diff review's sidebar in place — same grouping model as create_diff_review's `groups`, but applied to a review that already has comments on it, so you don't have to tear the review down (and lose every thread) just to organize it better. A group's `paths` claim a file exactly or as a directory prefix, first group in the array wins, and anything unclaimed lands in an \"Other\" group listed last (returned in `ungrouped` so you can see what you missed). Optional per-group `details` renders as a short intro under the group title; over 500 chars is REJECTED, not truncated — write a 1–2 sentence intro, don't paste a commit body. Re-setting a group WITHOUT details clears the old one. Pass an EMPTY groups array to fall back to the built-in Tests/Docs/Build + module heuristic. Returns {ok, groups:[{title, fileCount}], ungrouped:[relPath]}. Errors: 'bad-groups' (a group is missing a title or paths — nothing is written, the review is untouched), 'not-found' (no such workspace), 'no-diff-members' (a browse-only workspace has no changed files to group — groups organize a diff), 'group-details-too-long'.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
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
        required: ['workspaceId', 'groups'],
      },
    },
    {
      name: 'find_and_replace',
      description:
        "Replace a string of plain text in the doc with another string. `find` must match the doc's plain text content (no markdown syntax — marks like bold/italic are preserved automatically). Use `contextBefore` / `contextAfter` to disambiguate repeated phrases. If the match is still ambiguous the tool returns a list of candidates. Use `occurrence` (1-indexed) to pick one explicitly. Pass `parseInlineMarks: true` to interpret `[label](url)` / `**bold**` / `*italic*` / `` `code` `` / `~~strike~~` in `replace` as marks on the inserted text instead of literal characters — required when adding a labeled link or other inline mark to text that doesn't already have one. Runs as a single Yjs transaction so it merges cleanly with concurrent user edits. Pass `suggest: true` to propose the change instead of applying it directly — the match is marked as a pending suggestion (visible in the live doc, attributed to this agent) instead of edited outright; disk and every other agent's read stay on the ACCEPTED state until a human (or `accept_suggestion`) accepts it. Returns `{ suggestionId }` when `suggest` is set. Use this for judgment-call edits where a one-tap human approval is better than a silent rewrite; use the plain edit for mechanical fixes.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          occurrence: { type: 'number' },
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
        "Rewrite the text a thread is anchored to. Primary path for comment-driven edits: the user commented, the agent fixes the exact range they commented on. Immune to concurrent user edits because the anchor is a Y.RelativePosition, resolved to current offsets at apply time. Pass `parseInlineMarks: true` to interpret `[label](url)` / `**bold**` / `*italic*` / `` `code` `` / `~~strike~~` in `replacement` as marks on the inserted text instead of literal characters. Returns `anchor-orphaned` if the user deleted the anchored text — fall back to find_and_replace in that case. Pass `suggest: true` to propose the rewrite instead of applying it directly — same semantics as find_and_replace's `suggest` flag: marked pending, attributed to this agent, invisible to disk until accepted. Returns `{ suggestionId }` when `suggest` is set.",
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
        'List every pending suggestion (from any author — human or agent) on a doc, in doc order. Each entry has `sid`, `author` ({id,name,color}), `kind` (insert/delete/replace), a human-readable `snippet` (inserted text, deleted text, or "old → new"), `blockContext` (the accepted-state text of the containing block), and `ts` (creation time, epoch ms). Use before `accept_suggestion` / `reject_suggestion` to find the sid, or to check whether your own earlier `suggest: true` proposal is still pending.',
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
        'Accept a pending suggestion by sid: it becomes real content and flows to disk via the normal debounced write-back within ~1s. Missing sid → an error (also the correct outcome for a double-accept race — someone else already resolved it).',
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
        "Insert one or more new block elements (paragraphs, headings, lists, blockquotes, code blocks) AFTER the block that contains the thread's anchor. Accepts markdown: `# heading`, `## sub`, `- bullet`, `1. numbered`, `> quote`, ```code blocks```, and `---` for a horizontal rule. Blank lines separate paragraphs. Use this for 'add a section', 'add a paragraph below', 'insert a bullet list here'.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          markdown: { type: 'string' },
        },
        required: ['docId', 'threadId', 'markdown'],
      },
    },
    {
      name: 'create_anchor',
      description:
        'Mint a private agent-side anchor at a specific text location and get back an anchor id. The anchor survives concurrent user edits just like a thread anchor, so you can pin 3 spots now and rewrite each later without worrying about offsets shifting. Uses the same find/context/occurrence disambiguation as find_and_replace.',
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
        "Apply an INLINE edit at a previously-created agent anchor. `op.kind` is 'replace' (rewrite the anchored range) or 'insert_after' (insert text right after the anchor's end). The text stays inside the anchor's block — use this for prose tweaks, not for adding new headings/paragraphs/lists/tables. For new blocks, use insert_blocks_at_anchor (which routes through the markdown parser so `## Heading` becomes a real heading element, not literal text). Runs as a Yjs transaction; merges cleanly with concurrent user edits.",
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
        "Parse markdown and insert the resulting blocks (headings, paragraphs, lists, blockquotes, code blocks, tables, horizontal rules) immediately AFTER the block that contains the agent anchor. Use this — not edit_at_anchor — for adding new sections / sub-headings / tables. edit_at_anchor with insert_after does a character-level insert that keeps the new text trapped inside the anchor's block, producing literal `## Heading` text instead of a heading element.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          anchorId: { type: 'string' },
          markdown: { type: 'string' },
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
        "Delete the entire block (paragraph, heading, blockquote, list item, table cell — whichever block contains the anchor) the anchor points at. Pass exactly one of `threadId` (a comment thread's anchor) or `anchorId` (an agent anchor minted via create_anchor). Use this when find_and_replace with an empty replacement isn't enough — empty-string find_and_replace empties the block's text but leaves a blank block element behind that the editor still renders. This removes the block entirely. NOTE: for an anchor inside a list item or table cell, only the innermost containing block (the list item's paragraph, the cell's paragraph) goes away — the list item / cell shell remains. Use delete_section or delete_blocks_in_range for whole-list / whole-section deletion.",
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
        'Delete every TOP-LEVEL block from the one containing `startFind` through the one containing `endFind`. Block-INCLUSIVE: a partial-string match still removes the entire containing block — this is intentional ("blow away the section that contains this string"). Use for trailing template cruft or any contiguous span where no heading bounds the area. Both finds use the same disambiguation as find_and_replace; pass `contextBefore` / `contextAfter` for shared disambiguation, or `startOccurrence` / `endOccurrence` (1-indexed) when the same string repeats. Errors: `no-match`, `ambiguous` (with `candidates` tagged `start` / `end`), `inverted-range` (end before start). For "delete this whole section" prefer delete_section, which is heading-aware.',
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
        'Delete a heading block plus every subsequent top-level block until the next heading at level ≤ the start heading\'s level (or end of doc). The highest-leverage tool for "delete the X section" — what a single call replaces in one go would otherwise take a dozen find_and_replace calls and still leave empty-paragraph residue. `heading` is the exact heading text (whitespace-trimmed); pass `level` (1..6) to disambiguate when the same text appears at multiple heading levels, `occurrence` (1-indexed) for repeats at the same level. Returns the heading that ended the run (or null if the section ran to the end of the doc) so you can confirm what was kept. Errors: `no-match`, `ambiguous`, `not-a-heading` (string matched body text, not a heading block).',
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
        "Start pushing live feedback events for this doc into the current Claude Code session as <channel source='live-feedback' …> messages. Every thread.created / thread.replied / thread.resolved / thread.reopened on the doc arrives as a channel event until you call unwatch_doc. NOTE: this is normally redundant — `create_review_doc`, `bind_mock`, and most other docId-bearing tools auto-subscribe the caller on first touch. Use `watch_doc` explicitly when you want to subscribe to a doc you haven't otherwise interacted with (e.g., a peer's doc you only want to observe). Idempotent.",
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'unwatch_doc',
      description: 'Stop pushing channel events for this doc.',
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' } },
        required: ['docId'],
      },
    },
    {
      name: 'list_watched_docs',
      description: 'Return the docIds this session is currently subscribed to for channel events.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'share_doc',
      description:
        "Publish a markdown review doc behind a Cloudflare Access gate so external reviewers (e.g. an outside team's email domain) can access it over the public internet for a bounded window. The doc must already exist via create_review_doc. Returns { share: { shareId, url, hostname, expiresAt, ... } }. Read .claude/live-feedback.json's `share.defaultAllowDomains` first; if a repo has no config, ASK THE USER which domain(s) to allow before calling — never default to 'anyone'. Default ttlSeconds is 72h. Reviewers hitting the share URL get a Cloudflare email-OTP login page; only allowed domains can complete login.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          allowDomains: {
            type: 'array',
            items: { type: 'string' },
            description: "Email domains, e.g. ['@partner-org.example']",
          },
          ttlSeconds: { type: 'number' },
          name: { type: 'string', description: 'Optional slug override for the subdomain' },
        },
        required: ['docId', 'allowDomains'],
      },
    },
    {
      name: 'share_workspace',
      description:
        "Publish a WHOLE workspace (a folder bind or diff review, created by bind_folder / create_diff_review) behind a Cloudflare Access gate, so external reviewers can browse the set — file tree, every member doc, cross-doc links, and per-file comment threads. Use this instead of share_doc whenever the reviewer needs to move between files; a share_doc share covers exactly one doc and renders without the sidebar. Returns { share: {...}, memberCount }. Read .claude/live-feedback.json's `share.defaultAllowDomains` first; if a repo has no config, ASK THE USER which domain(s) to allow before calling — never default to 'anyone'. Default ttlSeconds is 72h. Visitors can read, comment on, and co-edit members through the live editor — but cannot delete docs, replace a doc wholesale, reparse from disk, list other workspaces or docs, open files outside the workspace root, or manage shares.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          allowDomains: {
            type: 'array',
            items: { type: 'string' },
            description: "Email domains, e.g. ['@partner-org.example']",
          },
          entryDocId: {
            type: 'string',
            description: 'Doc the share URL opens. Defaults to the first member.',
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
        "Publish a review doc or workspace as an UNGUESSABLE LINK — no sign-in, no Cloudflare Access, no email allow-list. Anyone holding the URL can read, comment, and co-edit until it expires; the scope is identical to an Access share (their own doc or workspace only — no doc enumeration, no deleting, no wholesale rewrite, no share administration). This is the default way to share with someone outside the tailnet. Pass docId for ONE doc, or workspaceId for a whole folder bind / diff review (browsable with its file tree). Default TTL is one week; pass ttlSeconds to change it, or set_share_ttl later. Returns { share: { shareId, url, slug, expiresAt, ... } } — give the human the bare `url` on its own line. Because the link IS the credential, treat it like a password: don't post it anywhere durable, and prefer a short ttlSeconds for anything sensitive. Use share_doc / share_workspace instead when you need verified identities, per-person revocation, or attribution.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'Share exactly this doc.' },
          workspaceId: {
            type: 'string',
            description: 'Share a whole folder bind / diff review. Mutually exclusive with docId.',
          },
          entryDocId: {
            type: 'string',
            description: 'Doc the link opens for a workspace share. Defaults to the first member.',
          },
          ttlSeconds: { type: 'number', description: 'Defaults to one week (604800).' },
          label: { type: 'string', description: 'Human label shown in list_shares.' },
        },
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
        'Master switch for ALL external access. Turning it off makes every share host and link host answer 403 before authentication, and hangs up websockets and SSE streams that are already open — one call, rather than revoking shares individually. Existing shares are preserved and resume when it is turned back on. The local/tailnet surface is unaffected. Call with no argument to just read the current state. Refuses with env_locked when LF_SHARING_DISABLED is set in the service environment.',
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
        "Create a hub WORKSPACE — a goal + task board + linked docs, the unit Bryan reviews on the hub page (/workspaces/<id>). Distinct from a folder bind / diff review (those are doc groupings; link one to a hub workspace with attach_doc). `goal` is the north-star statement every triage decision is judged against — write it as a sentence or two of markdown, and keep it current with set_workspace_goal. Board sections come later via set_goal_list. YOU become the workspace's LEAD AGENT — the addressee for goal-edit re-triage — unless you pass a different `leadAgentId`; hand it over later with set_workspace_lead. Auto-subscribes this session to the workspace's event channel (task.*, decision.answered, triage.requested, …); pass subscribe:false to skip. Returns { workspaceId, leadAgentId } — the id is crypto-random because URLs hang off it.",
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short handle, e.g. "search-revamp".' },
          goal: { type: 'string', description: 'North-star goal statement (markdown).' },
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
      name: 'set_workspace_lead',
      description:
        "Hand the workspace's LEAD AGENT seat to another agent. The lead is who a goal edit's re-triage is addressed to — it is a standing assignment, not a session fact, so a goal change waits for the lead even while they are away rather than going to whoever happens to be connected. Use it when you are handing a board off, or to fill the seat on a board a person created.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'Hub workspace id from create_workspace.' },
          leadAgentId: { type: 'string', description: 'The agent id taking responsibility.' },
        },
        required: ['workspaceId', 'leadAgentId'],
      },
    },
    {
      name: 'attach_doc',
      description:
        "Link an EXISTING review doc, diff review, or folder bind to a hub workspace so it shows in the hub's docs sidebar. A link only — the doc keeps its own URL and metadata, nothing is migrated. `docId` may be a doc id or a diff-review/folder workspaceId (the whole review attaches as one unit). Idempotent. Returns the workspace's updated docIds.",
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
        'THE way to create tasks — always takes a LIST, and a single task is a one-row list, so reach for this one whether you have one idea or fifteen. Filing 24 things one at a time costs 78s against 13s for the same rows in one call, and that gap is a tooling choice rather than a floor. It is the ONLY create verb — the single-row form it replaced is gone, so there is no second way to file work that skips the batch and the placement report. Every rule applies PER ROW: an omitted `assignee` means YOU own that row, an omitted `goal` leaves that row UNPLACED at the bottom of Chores and routes it through triage, an explicit `order` places it. A row may name another row of the SAME batch in `after` / `afterEnforce` — by index (`0`) or by a `key` another row declares (`"#seed"`) — so a burst with internal ordering no longer needs a follow-up set_task_dependencies. Returns the created tasks IN BOARD ORDER — the ranking you just produced, without a second read — plus `failures: [{index, title, error, message}]` for any row that didn\'t land, plus `placement` when any row went in unplaced (the unplaced task ids and the ordered goal bands, so you can set_task_goal without reading the board first). A bad row NEVER rejects the batch: its neighbours are created and it comes back by index, so you fix and re-send that one row. The whole call is refused only when nothing could have landed anyway (unknown workspace, no rows).',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          tasks: {
            type: 'array',
            description:
              'The rows, at most 100 — an oversized batch is refused WHOLE rather than truncated, and a tracker that big belongs in import_tasks_markdown. Each row is {title, body?, key?, assignee?, needs?, options?, goal?, order?, after?, afterEnforce?, dueAt?, links?, quote?} — the per-field rules are on the row schema below, and they are the same rules the removed single-row create carried. `title` is the only required field — but write a `body` on every row you are not doing yourself within the hour: a bare title is not pickup-able by an agent that was not in the conversation. `key` is an optional label THIS batch uses to reference the row; it must be unique in the batch and must not be all digits or start with "#". Rows are created in the order given, so a row can only depend on a row ABOVE it — a forward reference is refused rather than silently dropped, and so is a reference to a row that failed (a task carrying a dependency that never blocks it is worse than a refusal). An entry with no "#" is still an existing task id, exactly as before.',
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
                title: { type: 'string' },
                body: {
                  type: 'string',
                  description:
                    'The description. Not schema-required — but WRITE ONE ANYWAY, on every row: a bare title is not pickup-able by an agent that was not in the conversation, and reconstructing intent from a title is how the wrong thing gets built. Shape it as a compact user story — `<persona> can <do x> so that <goal y>`, one persona (Agent / Bryan / Collaborator) — and add falsifiable "done when" criteria for anything handed to someone else or parked beyond today. Proportionate: work you will finish within the hour needs the story line and nothing more. Markdown; it renders on the task itself and comes back whole from next_tasks, so do not create a separate doc to hold it.\n\nWhen `needs` is \'decision\' this is REQUIRED and has a different shape — the question in one line, what is at stake in two or three, the options with what each one costs, then what is blocked until it is answered. A row with no question in it is REFUSED, because the failure this catches is filing a progress report as a decision: the field is populated, every check passes, and the person asked to decide has nothing to decide from. The other three parts come back as advisory `shapeGaps` on a successful create.',
                },
                key: {
                  type: 'string',
                  description:
                    'An optional label THIS batch uses to reference the row from a later row\'s `after` / `afterEnforce`. Unique within the batch; not all digits; must not start with "#". Means nothing outside this call.',
                },
                assignee: {
                  type: 'string',
                  description:
                    "Who owns this row: 'human' for work only a person can do, or a named identity (another agent, a person). Omit it and YOU own it — the API records your own name. It REFUSES a row whose owner comes out as the bare word 'agent', because that names a category rather than somebody, and a board of tasks owned by \"agent\" cannot answer who is doing what. If you get that refusal, your session was launched without FEEDBACK_AGENT_NAME.",
                },
                needs: {
                  type: 'string',
                  enum: ['action', 'decision'],
                  description:
                    "Only meaningful when assignee is a human. 'decision' makes it a decision task (answer_decision records the verbatim answer). A decision REQUIRES a decision-shaped `body` — see that field.",
                },
                options: {
                  type: 'array',
                  description:
                    'Candidate answers, decision rows only: [{label, detail?}]. `label` is the text recorded VERBATIM as the answer if it is picked; `detail` is what picking it costs. Supply them whenever you already have candidates in mind — that is the normal case, and without them the person deciding has to compose prose to say "the second one". They are a SHORTCUT, never a closed set: writing a different answer and asking for more information stay available next to them, so do not pad the list to look exhaustive. Two or more, or don\'t bother.',
                  items: { type: 'object' },
                },
                goal: {
                  type: 'string',
                  description:
                    'Goal/subgoal id, or "chores". OMIT to leave this row UNPLACED at the bottom of Chores and route it through triage. An explicit goal — even "chores" — is a placement and skips triage.',
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
                    'Subset of `after` that hard-blocks transitions while open. Every entry here MUST also appear in `after` — the gate walks `after` and reads this as a lookup set, so an entry in this array alone would gate nothing; the row is refused rather than silently widening `after`.',
                },
                dueAt: {
                  type: 'number',
                  description: 'Epoch ms. Optional at every level — never invent one.',
                },
                links: {
                  type: 'array',
                  description:
                    "Refs this task mentions: {kind:'doc',docId} | {kind:'thread',docId,threadId} | {kind:'task',taskId} | {kind:'diff',workspaceId} | {kind:'url',url}. Backlinks are computed. Use `url` for anything outside this server — a pull request, a decision page, a dashboard; http(s) only, since a ref is rendered as a clickable chip. Refs are NOT existence-checked, so a link that points nowhere is accepted and harmless. A malformed ref does not fail the row: it is dropped and returned in `ignoredLinks`, and the task is still created.",
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
        "Promote a comment thread into a task. Captures the origin ref (the thread backlinks to the task automatically), the latest HUMAN comment as the verbatim `quote` (agent replies never become the quote), and drafts a title + body from the quote when you don't supply them. Same goal semantics as create_tasks: omit `goal` to route the placement through triage. Returns { taskId, title, goal, order, quote } — trimmed.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          workspaceId: { type: 'string', description: 'Hub workspace the task lands in.' },
          title: { type: 'string', description: 'Override the drafted title.' },
          body: { type: 'string', description: 'Override the drafted body.' },
          assignee: {
            type: 'string',
            description:
              "Who owns it. Omit and you do — same rule as a create_tasks row's assignee.",
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
        'Read a hub workspace: its north-star goal, and the ORDERED goal list with per-goal task counts (todo / in-progress / done), parent goals followed by their subgoals, Chores last. Order IS priority — the first row is the highest band. Call this before deciding what to work on; without it goal order is invisible (list_tasks returns goal IDS only) and you will work the wrong band. Deliberately cheap — goals and counts, no tasks: pair it with next_tasks, which carries the tasks and their full descriptions. Each row carries `depth` (0 = top-level, 1 = subgoal), `parent` on subgoals, and `reorderable` — the three fields reorder_goals needs, so read here then reorder there with ids alone. `reorderable: false` marks the rows that are APPENDED rather than ordered (Chores, and a goal id left behind on a done task): they look exactly like a band, and sending them back is a 400, so scope a reorder as "the rows at my scope where reorderable is true", never "every depth-0 row".',
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
        required: ['workspaceId'],
      },
    },
    {
      name: 'next_tasks',
      description:
        'The work queue: what to pick up next, in priority order (goal band, then task order), already filtered to what you can actually DO. TAKE THE WHOLE READY SET, NOT THE TOP ROW — starting every ready row that does not collide with another is the default, and holding one task while the rest of the queue waits is the slowest way to work a board. Each row carries its FULL description, which is what tells you whether two tasks touch the same code and therefore have to be sequenced; that judgment is made from the text, not from a field. Also on each row: `blockedBy` (open dependencies — only `enforce` ones hold a task back) and `ready`. Hard-blocked rows are omitted unless includeBlocked. Pass assignee to get just your own queue. Make this call at the top of a work session and again whenever a line of work finishes — priorities move while you work.\n\nREAD `bodyWrittenAt` AND `premise` BEFORE YOU TRUST A DESCRIPTION. A body is a measurement taken on the day it was filed and rendered ever after in the present tense, on a codebase that moves several times a day — so `bodyWrittenAt` (on every row) tells you how old the claim is. `premise` appears only when that description has stood still for over a day while somebody kept commenting on the task, and it carries those comments VERBATIM in `notes`. That is where a previous reader wrote down what they found when they reproduced it: five times in one week a task claimed something was missing that had already shipped, twice within hours of the task being filed, and each time the correction existed as a comment nobody on the pickup path could see. Read the notes first — they may already have done the reproducing for you, and they routinely change the SIZE of the work. `premise` says NOTHING about whether the task is done; it never appears on a done task, and most rows carrying it still have real work left. It clears itself when the description is rewritten (update_task_body), which is the right move once you know what is actually true — attribute and date the correction, and keep what the body originally claimed, since the original measurement is evidence about when it was taken rather than a mistake to erase.',
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
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'list_tasks',
      description:
        'List a hub workspace\'s tasks, optionally filtered by goal / status / assignee / needs. Rows are trimmed (no body, no transition history — get specifics via the task board or the links routes). needs:"decision" + status filters give you the open-decisions strip; assignee:"human" is half of the "what needs a person" computation.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goal: { type: 'string' },
          status: { type: 'string', enum: ['todo', 'in-progress', 'done'] },
          assignee: { type: 'string' },
          needs: { type: 'string', enum: ['action', 'decision'] },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'task_transition',
      description:
        "The SINGLE gate for task status changes (todo | in-progress | done) — attributed to this agent, appended to the task's audit trail. Attach `evidence` ({commit} and/or {threadRef}) on forward moves or the move is flagged `unproven` (allowed, shaded on the board); if the evidence was missing or WRONG, do not re-send this call — it refuses with `same-status` — use `amend_evidence`, which appends a correction to the move that already happened. Open `after` dependencies come back in `blockers` — an edge marked enforce REFUSES the transition (HTTP 409) until the blocking task closes; read the blocker message, it names what to unblock. The task's riskTier gates forward moves the same way: a RED task refuses outright (a person has to make the move), and a YELLOW one needs `confirmed: true` — which means the human said yes after you showed them the concrete effect, never a flag you set to get past the gate. `usage` ({inputTokens, outputTokens}) reports what the task cost at done. Moving back to todo is never blocked.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          to: { type: 'string', enum: ['todo', 'in-progress', 'done'] },
          note: { type: 'string' },
          evidence: {
            type: 'object',
            properties: {
              commit: { type: 'string' },
              threadRef: { type: 'object' },
            },
          },
          usage: {
            type: 'object',
            properties: {
              inputTokens: { type: 'number' },
              outputTokens: { type: 'number' },
            },
          },
          confirmed: {
            type: 'boolean',
            description:
              "The human confirmed THIS move on a yellow-tier task, after being shown what it does. Not a retry flag — if they haven't answered, don't send it.",
          },
        },
        required: ['taskId', 'to'],
      },
    },
    {
      name: 'amend_evidence',
      description:
        "Attach evidence to a transition that ALREADY happened — the answer to 'the move was right, the proof was wrong or missing'. Two cases, both real: the `evidence` object never reached the server (the move landed `unproven` and the board shades it), or it arrived and was FALSE — a commit sha written from memory that resolves to nothing, which reads as proof and is worse. Re-sending task_transition fixes neither; it refuses with `same-status`. This APPENDS: the original row keeps saying what it said (with the bad sha struck through, not deleted), and your correction sits beside it with your name and the time. The `unproven` shading clears, because the move now has proof; that it arrived late stays visible in the row. Defaults to the most recent transition — pass `transitionTs` (a ts from the task's transitions) to correct an earlier one. Evidence that claims nothing is refused, so a correction can never blank the proof it was sent to fix. NOT validated: whether the sha resolves — evidence is a bare commit with no repo attached and this server has no checkout to look it up in, so getting it right is on you.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          evidence: {
            type: 'object',
            description: 'The proof the move should have carried. At least one of these.',
            properties: {
              commit: { type: 'string' },
              threadRef: { type: 'object' },
            },
          },
          note: {
            type: 'string',
            description: 'Why the correction was needed — it lands in the audit trail.',
          },
          transitionTs: {
            type: 'number',
            description:
              'Which transition to correct. Omit for the latest — the move you just made.',
          },
        },
        required: ['taskId', 'evidence'],
      },
    },
    {
      name: 'assign_task',
      description:
        "Hand a task to somebody: 'human' (it needs Bryan), or a named identity — a person, or the agent's own name. NOT the bare word 'agent': that names a category rather than somebody, so the board cannot say who is doing this and next_tasks?assignee=<me> matches nothing; the API refuses it. This is the hand-off gesture — use it the moment you discover a task is not yours to finish, rather than leaving it parked in your column: an unassigned blocker looks like work in flight to everyone reading the board. Status is untouched (re-assigning is not progress), and the move is recorded as task.assigned with both ends, so the direction of every hand-off is reviewable.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          assignee: {
            type: 'string',
            description:
              "'human', a person's name, or an agent's name (yours comes from FEEDBACK_AGENT_NAME). The bare word 'agent' is refused.",
          },
        },
        required: ['taskId', 'assignee'],
      },
    },
    {
      name: 'update_task_body',
      description:
        "Rewrite a task so it can be picked up — its description, and in the SAME act its title. The fix for a task filed thin, one whose acceptance criteria turned out to be wrong, and the write half of triage's shaping step: a raw capture arrives with a machine-clipped fragment for a title and its whole unedited utterance for a body, and this is what turns both into work. Whole-body replace, so send the full markdown you want the task to have; there is no partial edit. Pass `title` whenever the title no longer names what the task is (omit it to leave the title alone). Written through the task's live body doc as a block-level diff, so comment threads anchored to paragraphs you did not change keep their anchors and anyone reading the task on the board watches it update. Recorded as ONE task.body_edited carrying both titles, attributed to you, and the activity feed renders the rename with the old name — the only name the person who filed it would recognise. The row's ORIGINAL words are preserved to `quote` automatically on the first rewrite, so a rewrite is never the only record of what was said; a quote already there (a dictated transcript) is never overwritten. Keep the shape a task body owes its next reader — a compact user story plus falsifiable done-when criteria — because rewriting is also the moment to add the ones that were missing. Refuses an empty body: blanking a description is not an edit, and if the task should not exist, say so on it instead.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          markdown: {
            type: 'string',
            description: 'The FULL new description. Replaces what is there.',
          },
          title: {
            type: 'string',
            description:
              'A new title for the row, applied as part of the same act. Omit to keep the current one.',
          },
        },
        required: ['taskId', 'markdown'],
      },
    },
    {
      name: 'set_task_goal',
      description:
        "Place a task under a goal (or subgoal) at an exact position — this IS triage's write half: pick the spot, not just the bucket. Stamps triagedAgainst with the goal text judged against and clears the triage-pending marker; every move is recorded and fires task.regrouped, so regroup freely — the safety is the record, not asking first. When a move would cross a human's earlier placement, leave a task comment referencing it. Pass `riskTier` for how dangerous EXECUTING the task is (green: reversible/contained; yellow: outward-facing or hard to reverse; red: irreversible/one-way) — keyed to the action's damage, never its importance. `position` is fractional — there is always room between two tasks; omitted = bottom of the goal.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          goal: { type: 'string', description: 'Goal/subgoal id, or "chores".' },
          position: { type: 'number' },
          riskTier: { type: 'string', enum: ['green', 'yellow', 'red'] },
          batchId: {
            type: 'string',
            description:
              'Echo the batchId from a goal-change re-triage request. It ties this placement to the goal edit that asked for it, so the activity view reads N moves as one edit instead of N unexplained regroupings.',
          },
        },
        required: ['taskId', 'goal'],
      },
    },
    {
      name: 'set_goal_list',
      description:
        'Replace a workspace\'s ORDERED goal list — use this to ADD or REMOVE a goal. To RENAME one, use rename_goal: this call is keyed by ID, so submitting a new id with the new title is not a rename, it is a removal plus an addition, and it strands everything the old band held. To only change PRIORITY ORDER, use reorder_goals: it is permutation-only and cannot lose a goal. Each goal: {id, title, dueAt?, subgoals?: [{id, title, dueAt?}]} — one subgoal level max. "chores" is reserved (always rendered last, never in the list). DESTRUCTIVE EDGE, now GATED: this is a full REPLACE, so any id you leave out is removed — and if that id still holds tasks the call is REFUSED with error "would-strand-tasks", naming each band with its open and done counts. Nothing is written on a refusal. Removing a band that holds work therefore takes a second, deliberate call listing its id in `drop`; removing an EMPTY one needs no ceremony. On success the result reports movedToChores (open tasks swept to the bottom of Chores — re-place each with set_task_goal rather than leaving them piled) and strandedDone (done tasks still pointing at the removed id, which is what leaves a bare row in get_workspace).',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goals: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                dueAt: { type: 'number' },
                subgoals: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      title: { type: 'string' },
                      dueAt: { type: 'number' },
                    },
                    required: ['id', 'title'],
                  },
                },
              },
              required: ['id', 'title'],
            },
          },
          drop: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Goal/subgoal ids you INTEND to remove even though they still hold tasks — the acknowledgement that turns the refusal into the removal. Send it only after reading what the refusal said each band holds; a caller working from a stale list cannot name a band it never saw, which is exactly the accident this gate exists to catch. Ids that are not actually being removed are ignored, so it can never widen the replace.',
          },
        },
        required: ['workspaceId', 'goals'],
      },
    },
    {
      name: 'rename_goal',
      description:
        "Change a goal's or subgoal's TITLE in place, by id — the safe way to rename a band. Use this instead of set_goal_list whenever the id is staying the same, which is almost always: set_goal_list is a full replace keyed by id, so renaming through it means restating every other band from a list that may have moved, and giving the band a NEW id there reads as a removal plus an addition (its open tasks swept to Chores, its done tasks orphaned onto an id that no longer exists). Nothing can move here: a task's band IS its goal id, and no input to this call changes an id. `dueAt` is optional — a number sets it, null clears it, omitting it leaves it alone. Fires the same workspace.goals_changed edit the board and activity feed already render. `chores` is refused: its label is fixed.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goal: {
            type: 'string',
            description: 'The goal or subgoal id to retitle. Get it from get_workspace.',
          },
          title: { type: 'string', description: 'The new title.' },
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
        'Change the PRIORITY ORDER of a workspace\'s goals — order IS priority, so this is the gesture for "work 2.1 before 1.2". PERMUTATION ONLY: `order` must be exactly the goal ids already at one scope (the top-level list, or the subgoals of `parent`) — same ids, same count, no titles. Nothing is created, renamed, removed or reparented, and no task can move. An order that omits, repeats or invents an id is REFUSED with 400 naming the offending ids, so a list that another writer has changed since you read it makes you re-read rather than silently dropping a goal — which is exactly what set_goal_list does with the same mistake (its omissions dump that goal\'s open tasks into Chores). Get the ids from get_workspace and send back every row at your scope whose `reorderable` is true — that one filter is the whole rule, and it covers both kinds of row that are marked false (Chores, and a goal id left behind on a done task). Including either is a 400: `chores` comes back in `reservedIds` because it is a permanent bucket you simply drop, an orphaned id comes back in `unknownIds` because the goal really was removed. Reach for set_goal_list only when you actually mean to add, rename or remove a goal.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          order: {
            type: 'array',
            items: { type: 'string' },
            description:
              'EVERY reorderable goal id at this scope, in the new priority order, highest first. Leaving one out is an error, not a demotion; including a non-reorderable row (Chores) is an error too.',
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
      name: 'set_workspace_goal',
      description:
        "Edit the workspace's north-star goal statement — the text every triage decision is judged against. Emits workspace.goal_updated and requests a re-triage of all OPEN tasks from the workspace's LEAD AGENT. The request does not expire: `retriage.requested` says it reached the lead live, `retriage.queued` says the lead was away and it is WAITING for their next attach_agent (a workspace with no lead at all queues it too, and the board shows it as pending work). If the re-triage lands in YOUR channel — or arrives as `pendingRetriage` on your attach — walk the taskIds with set_task_goal, passing the request's batchId on each so the moves read as one goal edit.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goal: { type: 'string', description: 'The new north-star statement (markdown).' },
          summary: {
            type: 'string',
            description:
              "A ≤20-word line to DISPLAY in place of the goal — the board's goal strip and every task's 'Triaged against' row show this, with the full text one tap away. Send it WITHOUT `goal` to re-word just the display line (no re-triage, no event). Omit it and the surfaces show a deterministic clip of the goal's own opening words, which is a fine answer — never leave the goal unset waiting to write one. A goal edit that arrives without a summary DROPS the previous one, because it described the old goal. Empty string clears it.",
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'answer_decision',
      description:
        "Record the VERBATIM answer to a decision task (needs:'decision') on the human's behalf — use when they told you their answer in chat/voice and you're writing it down; in the UI they answer directly. Pass their exact words as `text`, never a paraphrase. Emits decision.answered carrying the answer plus the task's links — a ready-made propagation checklist: act on or create a task for each item, and prioritize them right away. Does NOT transition the task — close it with task_transition once the propagation is handled.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          text: { type: 'string', description: "The human's verbatim answer." },
          optionId: {
            type: 'string',
            description:
              "The id of the option they picked, when they picked one (from list_tasks / the task's `options`). The answer is STILL `text` — pass the option's label as the text; this only records which candidate the words came from. Omit when they answered in their own words.",
          },
        },
        required: ['taskId', 'text'],
      },
    },
    {
      name: 'set_task_dependencies',
      description:
        'Set what a task waits on, AFTER it was created. `after` lists the task ids it depends on; `afterEnforce` is the subset whose open state hard-blocks its transitions. Replaces the whole edge set — pass the full list you want, and an empty `after` clears the edges.\n\nUse it the moment you discover a task is waiting on an open decision: name that decision in the blocked task\'s `after`. That edge is the ONLY record of "this decision is blocking work now" — the board derives a decision\'s urgency from what depends on it, and there is deliberately no urgency field to set by hand, because a hand-set one would be set at creation, the moment its author knows least. A decision nothing points at reads as parked, however loudly its body says otherwise.',
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
        'Import a hand-maintained markdown task tracker (group headings + status tables) into a hub workspace — adoption is not re-keying. THE DEFAULT IS A DRY-RUN: it returns the mapping (headings → board goals, table rows → tasks with normalized todo/in-progress/done status, plus what was skipped and which columns were ignored) and creates NOTHING. Review the mapping with the human, then call again with apply:true. Apply appends the new goals (existing goals matched by title are reused, never clobbered), creates the tasks as explicit placements (no triage), walks imported statuses through the transition gate, and STAMPS the source file with a banner + hub link so the old tracker cannot quietly stay a second source of truth — a stamped file refuses re-import (409). Headings map to goals; rows before any heading land in Chores; a leading H1 is the document title, not a group.',
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
        "Link a task to a doc, thread, another task, or a diff review. Stored one way on the task; the reverse direction is computed, so doc and thread payloads grow task chips automatically. ref shapes: {kind:'doc',docId} | {kind:'thread',docId,threadId} | {kind:'task',taskId} | {kind:'diff',workspaceId}. Idempotent — `changed:false` means it was already linked. Target existence is not checked (a dangling annotation is visible and harmless).",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          ref: { type: 'object', description: 'The ref to link.' },
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
        "Which tasks point at this ref — across every workspace, since refs cross workspace boundaries. Same ref shapes as link_refs: {kind:'doc',docId} | {kind:'thread',docId,threadId} | {kind:'task',taskId} | {kind:'diff',workspaceId} | {kind:'url',url}. This is the question a url ref exists to answer: paste a pull request or a dashboard link and find out what work already cites it, before filing something that duplicates it. Counts a task's stored `links` AND its promotion `origin`, so a task promoted from a thread comes back for that thread without anyone having linked it by hand. Returns task chips (id, title, status, assignee), oldest first. An empty list means nobody points at it — a malformed ref is refused instead, so an empty answer is always a real one.",
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
        "Register this session as an agent attached to a hub workspace (§4). Defaults: agentId = this agent's identity, runtime = claude-code-local. The result is the fresh-context briefing: a one-line summary of open gating decisions ('2 open decisions gating 3 tasks'), the untriaged task ids to sweep — and sweeping one means SHAPING it, not only filing it: read the row's own words, decide whether it is zero / one / several tasks (an instruction about neighbouring text is zero), rewrite each with update_task_body into a title and a story-shaped body, then set_task_goal. A capture arrives with a machine-clipped title and its raw utterance for a body, and this is the only step that turns it into work. Then queuedVoice — voice change-requests that arrived while no agent was live; act on each transcript verbatim — and, if you LEAD this workspace, pendingRetriage: a goal edit made while you were away, whose taskIds you re-place with set_task_goal (echo its batchId on each). All three are drained by this call. Also auto-subscribes to the workspace event channel. STAY LIVE: call heartbeat every few minutes — triage requests are only delivered to attachments with a fresh heartbeat, and after ~5 minutes of silence the hub shows you as away and requests queue.",
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
        'Prove this attached agent is alive (and, implicitly, working — the call stamps lastToolCallAt now unless you pass an explicit earlier toolCallAt). Call every few minutes while attached to a workspace; a stale heartbeat (~5 min) marks you away and queues triage requests, and a fresh heartbeat with a 30-min-old toolCallAt renders as "process up, agent unresponsive".',
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
        "Ask this machine to fetch the newest live-feedback plugin from the marketplace. Call it when the board's presence strip says agents are running an older bundle than the one released — that notice and this tool are the two halves of the same thing. It REQUESTS rather than forces: the update rewrites a version-keyed cache, so no running session is interrupted and every peer (including you) picks the new version up at its own next restart. Safe to call from any session; concurrent asks collapse into one fetch. The result reports the cache version BEFORE and AFTER, read from disk rather than from the CLI's own success message, because `claude plugin update` reports success when it copies nothing. `changed: false` with matching versions means the cache was already current, which is a real answer and not a failure.",
      inputSchema: { type: 'object', properties: {} },
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
  triagePendingTs?: number;
  after?: string[];
  afterEnforce?: string[];
}

/** Trimmed create/promote result (§3.10: an edit returns ids + status, not
 *  the object the caller just wrote). `triagePending` tells the caller
 *  whether a triage request was actually delivered to a live agent. */
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
    triagePending: task.triagePendingTs !== undefined,
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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    await maybeAutoWatch(name, a);
    switch (name) {
      case 'list_docs': {
        const res = await http('GET', '/api/docs');
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
        const { docId, threadId, text } = a as { docId: string; threadId: string; text: string };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/comments`,
          { author: AUTHOR, text },
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
        const res = await http('GET', `/api/docs/${encodeURIComponent(docId)}/content`);
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
        const { docId, markdown } = a as { docId: string; markdown: string };
        // Sent so a rewrite of a `task:<id>` body room can be attributed the
        // way `update_task_body` is; ignored for every other doc.
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/content`, {
          markdown,
          author: AUTHOR,
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
          // The BOARD, next to the grouping id above. Two ids, two meanings,
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
          // The BOARD, next to the grouping id above. Two ids, two meanings,
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
      case 'delete_workspace': {
        const { workspaceId, force } = a as { workspaceId: string; force?: boolean };
        const qs = force ? '?force=true' : '';
        const res = await http('DELETE', `/api/workspaces/${encodeURIComponent(workspaceId)}${qs}`);
        return ok(res);
      }
      case 'refresh_workspace': {
        const { workspaceId } = a as { workspaceId: string };
        const res = await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/refresh`,
          {},
        );
        return ok(res);
      }
      case 'set_workspace_groups': {
        const { workspaceId, groups } = a as {
          workspaceId: string;
          groups: Array<{ title: string; paths: string[]; details?: string }>;
        };
        const res = await http(
          'POST',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/groups`,
          {
            groups,
          },
        );
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
          parseInlineMarks,
          suggest,
        } = a as {
          docId: string;
          find: string;
          replace: string;
          contextBefore?: string;
          contextAfter?: string;
          occurrence?: number;
          parseInlineMarks?: boolean;
          suggest?: boolean;
        };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/find_and_replace`, {
          find,
          replace,
          ...(contextBefore !== undefined ? { contextBefore } : {}),
          ...(contextAfter !== undefined ? { contextAfter } : {}),
          ...(occurrence !== undefined ? { occurrence } : {}),
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
        const { docId, threadId, markdown } = a as {
          docId: string;
          threadId: string;
          markdown: string;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/insert_blocks_after`,
          { markdown },
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
        const { docId, anchorId, markdown } = a as {
          docId: string;
          anchorId: string;
          markdown: string;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/agent_anchors/${encodeURIComponent(anchorId)}/insert_blocks`,
          { markdown },
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
        await watchDoc(docId);
        return ok({ docId, watching: Array.from(watchers.keys()) });
      }
      case 'unwatch_doc': {
        const { docId } = a as { docId: string };
        unwatchDoc(docId);
        return ok({ docId, watching: Array.from(watchers.keys()) });
      }
      case 'list_watched_docs': {
        return ok({ watching: Array.from(watchers.keys()) });
      }
      case 'share_doc': {
        const {
          docId,
          allowDomains,
          ttlSeconds,
          name: slug,
        } = a as {
          docId: string;
          allowDomains: string[];
          ttlSeconds?: number;
          name?: string;
        };
        const res = await http('POST', '/api/share/doc', {
          docId,
          allowDomains,
          ttlSeconds,
          name: slug,
        });
        return ok(res);
      }
      case 'share_workspace': {
        const {
          workspaceId,
          allowDomains,
          entryDocId,
          ttlSeconds,
          name: slug,
        } = a as {
          workspaceId: string;
          allowDomains: string[];
          entryDocId?: string;
          ttlSeconds?: number;
          name?: string;
        };
        const res = await http('POST', '/api/share/workspace', {
          workspaceId,
          allowDomains,
          entryDocId,
          ttlSeconds,
          name: slug,
        });
        return ok(res);
      }
      case 'share_link': {
        const { docId, workspaceId, entryDocId, ttlSeconds, label } = a as {
          docId?: string;
          workspaceId?: string;
          entryDocId?: string;
          ttlSeconds?: number;
          label?: string;
        };
        const res = await http('POST', '/api/share/link', {
          docId,
          workspaceId,
          entryDocId,
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
          goal,
          leadAgentId,
          subscribe,
        } = a as {
          name: string;
          goal?: string;
          leadAgentId?: string;
          subscribe?: boolean;
        };
        const res = (await http('POST', '/api/workspaces', {
          name: wsName,
          ...(goal !== undefined ? { goal } : {}),
          // The creating agent leads the board unless it says otherwise. A
          // board with no lead has nobody to address a goal edit to.
          leadAgentId: leadAgentId ?? AUTHOR.id,
        })) as {
          workspace: { id: string; name: string; goal: string; leadAgentId?: string };
        };
        if (subscribe !== false && res.workspace?.id) {
          await watchWorkspace(res.workspace.id);
        }
        return ok({
          workspaceId: res.workspace.id,
          name: res.workspace.name,
          goal: res.workspace.goal,
          leadAgentId: res.workspace.leadAgentId,
        });
      }
      case 'set_workspace_lead': {
        const { workspaceId, leadAgentId } = a as { workspaceId: string; leadAgentId: string };
        const res = (await http('PUT', `/api/workspaces/${encodeURIComponent(workspaceId)}/lead`, {
          leadAgentId,
          author: AUTHOR,
        })) as { changed: boolean; workspace?: { leadAgentId?: string } };
        return ok({
          workspaceId,
          changed: res.changed,
          leadAgentId: res.workspace?.leadAgentId ?? leadAgentId,
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
          placement?: { unplaced: string[]; triageDelivered: string[]; goals: unknown[] };
        };
        const gapsFor = (taskId: string) =>
          res.shapeGaps?.find((g) => g.taskId === taskId)?.gaps ?? undefined;
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
        const { docId, threadId, workspaceId, title, body, assignee, needs, goal, dueAt, links } =
          a as {
            docId: string;
            threadId: string;
            workspaceId: string;
            title?: string;
            body?: string;
            assignee?: string;
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
            goal: string;
            goalUpdatedAt: number;
            leadAgentId?: string;
          };
          goalSummary: unknown[];
          pendingRetriage?: { batchId: string; newGoal: string; taskIds: string[] };
        };
        return ok({
          workspaceId: res.workspace.id,
          name: res.workspace.name,
          goal: res.workspace.goal,
          goalUpdatedAt: res.workspace.goalUpdatedAt,
          // Absent means nobody is responsible for this board — a goal edit
          // here has no addressee until someone attaches or takes the seat.
          leadAgentId: res.workspace.leadAgentId,
          // A goal edit nobody has picked up yet. Only attach_agent drains
          // it — reading it here does not.
          pendingRetriage: res.pendingRetriage,
          goals: res.goalSummary,
        });
      }
      case 'next_tasks': {
        const { workspaceId, assignee, limit, includeBlocked } = a as {
          workspaceId: string;
          assignee?: string;
          limit?: number;
          includeBlocked?: boolean;
        };
        const qs = new URLSearchParams();
        if (assignee !== undefined) qs.set('assignee', assignee);
        if (limit !== undefined) qs.set('limit', String(limit));
        if (includeBlocked === true) qs.set('includeBlocked', 'true');
        const query = qs.size > 0 ? `?${qs.toString()}` : '';
        const res = (await http(
          'GET',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/next${query}`,
        )) as { tasks: unknown[] };
        return ok({ workspaceId, tasks: res.tasks });
      }
      case 'list_tasks': {
        const { workspaceId, goal, status, assignee, needs } = a as {
          workspaceId: string;
          goal?: string;
          status?: string;
          assignee?: string;
          needs?: string;
        };
        const qs = new URLSearchParams();
        if (goal !== undefined) qs.set('goal', goal);
        if (status !== undefined) qs.set('status', status);
        if (assignee !== undefined) qs.set('assignee', assignee);
        if (needs !== undefined) qs.set('needs', needs);
        const query = qs.size > 0 ? `?${qs.toString()}` : '';
        const res = (await http(
          'GET',
          `/api/workspaces/${encodeURIComponent(workspaceId)}/tasks${query}`,
        )) as { tasks: TaskPayload[] };
        // Trimmed rows: no body snapshot, no transition history.
        return ok({
          workspaceId,
          tasks: res.tasks.map(({ body: _body, transitions, ...rest }) => ({
            ...rest,
            transitionCount: transitions?.length ?? 0,
          })),
        });
      }
      case 'task_transition': {
        const { taskId, to, note, evidence, usage, confirmed } = a as {
          taskId: string;
          to: string;
          note?: string;
          evidence?: { commit?: string; threadRef?: unknown };
          usage?: { inputTokens: number; outputTokens: number };
          confirmed?: boolean;
        };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/transition`, {
          to,
          author: AUTHOR,
          ...(note !== undefined ? { note } : {}),
          ...(evidence !== undefined ? { evidence } : {}),
          ...(usage !== undefined ? { usage } : {}),
          ...(confirmed === true ? { confirmed } : {}),
        })) as { task: TaskPayload; blockers: unknown[]; unproven: boolean };
        return ok({
          taskId,
          status: res.task.status,
          blockers: res.blockers,
          unproven: res.unproven,
        });
      }
      case 'amend_evidence': {
        const { taskId, evidence, note, transitionTs } = a as {
          taskId: string;
          evidence: { commit?: string; threadRef?: unknown };
          note?: string;
          transitionTs?: number;
        };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/evidence`, {
          author: AUTHOR,
          evidence,
          ...(note !== undefined ? { note } : {}),
          ...(transitionTs !== undefined ? { transitionTs } : {}),
        })) as {
          transition: { ts: number; to: string };
          amendment: { evidence: unknown; supersedes?: unknown };
          unproven: boolean;
        };
        return ok({
          taskId,
          // What the caller needs to see is the EFFECT: which row now carries
          // what, and whether the shading cleared.
          transitionTs: res.transition.ts,
          to: res.transition.to,
          evidence: res.amendment.evidence,
          ...(res.amendment.supersedes !== undefined
            ? { superseded: res.amendment.supersedes }
            : {}),
          unproven: res.unproven,
        });
      }
      case 'assign_task': {
        const { taskId, assignee } = a as { taskId: string; assignee: string };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/assignee`, {
          assignee,
          author: AUTHOR,
        })) as { task: TaskPayload; changed: boolean };
        return ok({ taskId, assignee: res.task.assignee, changed: res.changed });
      }
      case 'update_task_body': {
        const { taskId, markdown, title } = a as {
          taskId: string;
          markdown: string;
          title?: string;
        };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/body`, {
          markdown,
          ...(title !== undefined ? { title } : {}),
          author: AUTHOR,
        })) as { task: TaskPayload };
        // `quote` back, because this call is the one that can have filled it:
        // the caller sees the words it just preserved without a second read.
        return ok({
          taskId,
          title: res.task?.title,
          body: res.task?.body,
          quote: res.task?.quote,
        });
      }
      case 'set_task_goal': {
        const { taskId, goal, position, riskTier, batchId } = a as {
          taskId: string;
          goal: string;
          position?: number;
          riskTier?: 'green' | 'yellow' | 'red';
          batchId?: string;
        };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/goal`, {
          goal,
          author: AUTHOR,
          ...(position !== undefined ? { position } : {}),
          ...(riskTier !== undefined ? { riskTier } : {}),
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
        })) as { changed: boolean; movedToChores: string[]; strandedDone: string[] };
        return ok({
          workspaceId,
          changed: res.changed,
          movedToChores: res.movedToChores,
          // Reported so the caller sees the half that used to be silent —
          // done tasks left pointing at an id the list no longer has.
          strandedDone: res.strandedDone,
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
      case 'set_workspace_goal': {
        const { workspaceId, goal, summary } = a as {
          workspaceId: string;
          goal?: string;
          summary?: string;
        };
        const res = (await http('PUT', `/api/workspaces/${encodeURIComponent(workspaceId)}/goal`, {
          // Both optional at this layer, and the route refuses a call that
          // names neither — omitting `goal` is how a caller re-words only the
          // display line without echoing back a north star that may have
          // moved since they read it.
          ...(goal !== undefined ? { goal } : {}),
          ...(summary !== undefined ? { summary } : {}),
          author: AUTHOR,
        })) as {
          changed: boolean;
          retriage?: { requested: boolean; queued: boolean; taskIds: string[]; batchId?: string };
        };
        return ok({
          workspaceId,
          changed: res.changed,
          retriage: res.retriage ?? { requested: false, queued: false, taskIds: [] },
        });
      }
      case 'answer_decision': {
        const { taskId, text, optionId } = a as {
          taskId: string;
          text: string;
          optionId?: string;
        };
        const res = (await http('POST', `/api/tasks/${encodeURIComponent(taskId)}/answer`, {
          text,
          ...(optionId !== undefined ? { optionId } : {}),
          author: AUTHOR,
        })) as { task: TaskPayload };
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
          },
        )) as {
          attachment?: { agentId?: string };
          gating?: unknown;
          untriaged?: string[];
          queuedVoice?: Array<{ transcript: string; ts: number }>;
          lead?: boolean;
          pendingRetriage?: {
            batchId: string;
            oldGoal: string;
            newGoal: string;
            taskIds: string[];
          };
        };
        if (subscribe !== false) await watchWorkspace(workspaceId);
        return ok({
          workspaceId,
          agentId: res.attachment?.agentId ?? agentId ?? AUTHOR.id,
          gating: res.gating,
          // Are you the board's LEAD agent? True if you already held the seat
          // or just claimed an empty one. The lead is where goal-edit
          // re-triage is addressed, so this says whether those land on you.
          lead: res.lead ?? false,
          untriaged: res.untriaged ?? [],
          // Voice change-requests that arrived while no agent was live
          // ("agent away — queued"): this attach is their delivery. Act on
          // each transcript, verbatim.
          queuedVoice: res.queuedVoice ?? [],
          // A goal edit made while you were away, waiting for you because
          // you lead this board. Walk its taskIds with set_task_goal against
          // the NEW goal, passing its batchId on each so the moves read as
          // one edit. It is drained by this call — nothing will offer it
          // again. `contract` names the same skill the live channel line
          // does: an away lead only ever sees THIS path, so leaving it off
          // here would tell half the fleet what to do and half of it only
          // that something happened.
          ...(res.pendingRetriage
            ? { pendingRetriage: { ...res.pendingRetriage, contract: RETRIAGE_SKILL } }
            : {}),
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
        return ok({ workspaceId, agentId: agentId ?? AUTHOR.id, state: res.attachment?.state });
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
}
const watchers = new Map<string, Watcher>();

async function watchDoc(docId: string): Promise<void> {
  if (watchers.has(docId)) return;
  const controller = new AbortController();
  watchers.set(docId, { controller, docId });
  void runSseLoop(docId, `/events/${encodeURIComponent(docId)}`, controller.signal).catch((err) => {
    console.error(`[live-feedback-mcp] watcher ${docId} crashed:`, err);
    watchers.delete(docId);
  });
}

/** Watch a whole workspace/diff review on ONE stream — every thread event on
 *  any member doc arrives here (server double-broadcasts per workspace). */
async function watchWorkspace(workspaceId: string): Promise<void> {
  const key = `ws:${workspaceId}`;
  if (watchers.has(key)) return;
  const controller = new AbortController();
  watchers.set(key, { controller, docId: key });
  void runSseLoop(
    key,
    `/events/workspace/${encodeURIComponent(workspaceId)}`,
    controller.signal,
  ).catch((err) => {
    console.error(`[live-feedback-mcp] workspace watcher ${workspaceId} crashed:`, err);
    watchers.delete(key);
  });
}

function unwatchDoc(docId: string): void {
  const w = watchers.get(docId);
  if (!w) return;
  w.controller.abort();
  watchers.delete(docId);
}

async function runSseLoop(label: string, path: string, signal: AbortSignal): Promise<void> {
  // Tight reconnect loop — the server sends keepalive comments every
  // ~15s, so an abrupt close is almost always a transient network blip.
  while (!signal.aborted) {
    try {
      const res = await fetch(`${resolveBaseUrl()}${path}`, {
        signal,
      });
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
          await handleFrame(frame);
          sep = buf.indexOf('\n\n');
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      console.error(`[live-feedback-mcp] ${label} sse error, retrying:`, err);
    }
    // Backoff before reconnect
    await new Promise((r) => setTimeout(r, 1500));
  }
}

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
  await emitChannelMessage(ev, payload);
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
  // Suggested edits (redline-suggestions phase 2): suggestion.created /
  // suggestion.accepted / suggestion.rejected carry `sid` + `suggestion`
  // instead of `threadId` + `thread`.
  sid?: string;
  suggestion?: { author?: { name?: string }; kind?: string; snippet?: string };
}

/** Hub/workspace event families formatted by emitHubChannelMessage. Thread
 *  and suggestion events on the same workspace stream keep the doc-shaped
 *  path below. */
const HUB_EVENT_RE = /^(task|decision|workspace|agent|triage|voice)\./;

interface HubEventPayload {
  workspaceId?: string;
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
  newGoal?: string;
  kind?: string;
  movedToChores?: string[];
  agentId?: string;
  leadAgentId?: string;
  batchId?: string;
  riskTier?: string;
  reason?: string;
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
    case 'task.gate_refused':
      body = `[task.gate_refused] ${p.taskId}: ${p.riskTier}-tier ${p.reason}${by} — → ${p.to} did NOT happen`;
      break;
    case 'decision.answered':
      body = `[decision.answered] ${p.taskId}${by}: "${truncate(p.answer ?? '', 120)}" — walk its links as the propagation checklist`;
      break;
    case 'workspace.goal_updated':
      body = `[workspace.goal_updated]${by}: "${truncate(p.newGoal ?? '', 120)}"`;
      break;
    case 'workspace.lead_changed':
      // Worth forwarding even though it is not a task: it changes WHO a goal
      // edit's re-triage will be addressed to, including when that is you.
      body =
        p.leadAgentId === AUTHOR.id
          ? `[workspace.lead_changed]${by}: you are now the lead agent — goal-edit re-triage is addressed to you`
          : `[workspace.lead_changed]${by}: lead agent is now ${p.leadAgentId ?? '?'}`;
      break;
    case 'workspace.goals_changed': {
      const moved = p.movedToChores?.length ?? 0;
      body = `[workspace.goals_changed] ${p.kind ?? 'edit'}${by}${
        moved > 0 ? ` — ${moved} task(s) moved to Chores, re-place with set_task_goal` : ''
      }`;
      break;
    }
    // The request reaches EVERY agent attached to the board, so who it is
    // addressed to has to survive into the wording — see triage-line.ts.
    case 'triage.requested':
      body = triageRequestLine(p, AUTHOR.id);
      break;
    // The audit row for the same goal edit the request above already asked
    // for. Forwarding both would say one thing twice, and only the request
    // is actionable — the row exists for the activity view and the review.
    case 'workspace.retriaged':
      return;
    case 'agent.attached':
    case 'agent.detached':
      body = `[${event}] ${p.agentId ?? '?'}`;
      break;
    case 'voice.request': {
      // The speaker's words arrive VERBATIM (§3.8: changes carry the
      // transcript verbatim); the context object says where they were.
      if (p.route === 'fast-path') return; // a lookup the server already answered
      const ctx = p.context
        ? ` (at ${p.context.surface ?? '?'}${p.context.docId ? ` ${p.context.docId}` : ''}${
            p.context.taskId ? ` ${p.context.taskId}` : ''
          }${p.context.visibleHeading ? `, near "${p.context.visibleHeading}"` : ''})`
        : '';
      body = `[voice.request]${by}${ctx}: "${p.transcript ?? ''}" — act on it through the task/edit tools; the speaker was told: "${truncate(p.ack ?? '', 120)}"`;
      break;
    }
    default:
      body = `[${event}]${p.taskId ? ` task ${p.taskId}` : ''}`;
  }

  await server.notification({
    method: 'notifications/claude/channel',
    params: {
      source: 'live-feedback',
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
}

async function emitChannelMessage(event: string, rawPayload: unknown): Promise<void> {
  if (HUB_EVENT_RE.test(event)) {
    await emitHubChannelMessage(event, rawPayload);
    return;
  }
  const p = (rawPayload ?? {}) as ChannelPayload;
  const docId = p.docId ?? 'unknown';

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
        source: 'live-feedback',
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
  const author = p.comment?.author?.name ?? p.thread?.comments?.[0]?.author?.name ?? '';
  const text = p.comment?.text ?? p.thread?.comments?.at(-1)?.text ?? '';
  const sentAt = new Date(p.comment?.ts ?? Date.now()).toISOString();

  // Human-readable body — what the agent reads in their context.
  const action = event.startsWith('thread.') ? event.slice('thread.'.length) : event;
  const header = snippet ? `on "${truncate(snippet, 60)}"` : '';
  const body = text
    ? `[${action}] ${author ? `${author}: ` : ''}${text}`
    : `[${action}] thread ${threadId} ${header}`.trim();

  await server.notification({
    method: 'notifications/claude/channel',
    params: {
      source: 'live-feedback',
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
