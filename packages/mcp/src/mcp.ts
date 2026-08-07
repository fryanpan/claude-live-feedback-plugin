#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveAgentAuthor } from './author.ts';

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

const server = new Server(
  {
    name: 'claude-live-feedback',
    version: '0.0.1',
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
        'Open a new comment thread anchored to a `find` text range, seeded with an initial comment from the configured author. Use when the agent has editorial notes / suggestions that should land as durable threads on the doc (instead of one-shot chat messages) — e.g. running `/edit` on a blog draft and leaving anchored feedback at six different places. Disambiguation works the same as `find_and_replace`: pass `contextBefore`/`contextAfter` or `occurrence` if the text appears more than once. Returns `{ thread }` with `thread.id` for follow-up `post_reply` calls. The thread fires the same `thread.created` event the editor uses, so watchers see it immediately.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          find: { type: 'string' },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          occurrence: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['docId', 'find', 'text'],
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
        "Replace the WHOLE document with new markdown — the safe path for a comprehensive rewrite/restructure. Applies as a block-level diff on the live doc: blocks you didn't change keep their identity, so comment threads anchored to them survive, connected editors update live, and the result flushes to the bound .md within ~1s like any other edit. Use this INSTEAD of Write-ing the bound file (then reparse_from_disk) or the delete_doc → Write → create_review_doc dance — both race the write-back and have clobbered files in practice, and the latter orphans every comment thread. Returns ok:false with error 'unsupported' (code/diff docs are read-only), 'empty' (won't wipe a doc to nothing — use delete_doc if you mean that), 'parse-failed', or 'not-found'.",
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
        },
        required: ['docId', 'sourceHtmlPath'],
      },
    },
    {
      name: 'bind_folder',
      description:
        'Alias for create_diff_review WITHOUT a base: binds a folder/worktree as a BROWSE workspace. One entry doc binds eagerly (README preferred; markdown opens editable); every other file appears in the all-files sidebar and opens lazily on click — no eager per-file binds, no file-count cap. Prefer create_diff_review directly: pass base to ALSO get the PR-style changed-files diff on top of browsing. Returns the workspace id, root, scan fileCount, and the entry file.',
      inputSchema: {
        type: 'object',
        properties: {
          folderPath: { type: 'string' },
          workspaceId: { type: 'string' },
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
        "Create a GitHub-PR-style review of a git diff: point it at a local repo and a base ref, and the server creates one review doc per changed file, grouped as a workspace — the reviewer gets a file tree with per-file A/M/D/R + line-count badges, a unified diff view with old/new line numbers and collapsed unchanged regions, a per-file Diff ↔ whole-File toggle, and line-anchored comment threads in both views. DEFAULT MODE (no `target`): diff base → the WORKING TREE, i.e. the folder as it is right now, uncommitted edits and untracked files included. The docs bind to the live files on disk, so as you keep editing the code the reviewer's diff re-renders within ~1s — this is the live-loop mode. Comments stay anchored to their lines through edits (snippet-based auto-reanchor); if an anchored line disappears, the thread lands in the existing Orphaned/outdated section where the reviewer can re-anchor it. Once the review EXISTS, prefer refresh_workspace(reviewId) over re-running this tool: it re-reads the diff from the stored base (no need to remember the ref), picks up files that changed since, and flags members whose change was reverted — all without re-minting a docId. Re-running this tool is still idempotent (same docIds, threads survive). PINNED MODE (pass `target`): content is frozen at the target commit; anchors can never drift; same reviewId with a different range is rejected. `repo` is an absolute path to a local checkout/worktree; `base`/`target` are any refs git can resolve (hashes, branches, HEAD~2). Binary files and files over 512 KB are skipped and reported in skipped[]. Pass `exclude` (path prefixes, e.g. ['src/main/assets/vendored-repo']) to keep vendored or generated directories out of the review. GUARDRAIL: more than `maxFiles` (default 300) changed files → error 'too-many-files'; narrow with `exclude` or raise `maxFiles`. The caller is auto-subscribed to thread events on every file doc (pass subscribe:false to skip). Returns {reviewId, entryUrl, files[{docId, relPath, status, additions, deletions, reviewUrl}], skipped[]} — hand `entryUrl` to the human (the file tree navigates to the rest). Clean up with delete_workspace(reviewId) when the review is done. Comments on DELETED lines aren't supported yet — ask the reviewer to comment on an adjacent kept line.",
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
        "Permanently delete a whole workspace (a folder bound via bind_folder) as ONE unit: drops every member review doc, cancels their sync, and removes the persisted state — but leaves the bound SOURCE files on disk untouched. Use this when a worktree/folder review is done instead of calling delete_doc once per file. GUARDRAIL is ALL-OR-NOTHING: without force, if ANY member file still has OPEN comment threads, nothing is deleted and it returns ok:false, error:'has-open-threads' with files:[{docId, openThreads}] listing the offenders — resolve those threads first, or pass force:true to delete everything regardless. Returns error:'not-found' if no docs carry that workspaceId. On success returns {ok:true, deleted:<count>}.",
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
        "Re-reconcile a workspace or diff review against what's on disk RIGHT NOW, WITHOUT re-minting any docId — so every existing comment thread survives. Use this instead of re-running create_diff_review / bind_folder when the review already exists and the files have moved under it. For a DIFF REVIEW it re-runs the diff from the stored base, so files you changed after creating the review join it and per-file status/line counts refresh; a member whose change you reverted is marked stale rather than deleted (its comments are still someone's feedback, and the change may come back). For a BROWSE workspace members bind lazily, so what refresh adds is the reverse sweep: members whose file was deleted or renamed away get marked stale. Stale is always reversible — the next refresh that finds the file clears it and lists it under restored. PINNED diff reviews (created with a `target`) are refused with error:'pinned': their content is a commit, so there is nothing to re-read. Returns {ok, kind:'diff'|'browse', added[], stale[{docId, relPath, openThreads}], restored[], fileCount}. Read `stale` after a rename: those threads are now stranded on a file nobody will open, so re-anchor or resolve them. Errors: 'not-found' (no such workspace), 'root-missing' (the folder itself is gone).",
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
        "Re-group an EXISTING diff review's sidebar in place — same grouping model as create_diff_review's `groups`, but applied to a review that already has comments on it, so you don't have to tear the review down (and lose every thread) just to organize it better. A group's `paths` claim a file exactly or as a directory prefix, first group in the array wins, and anything unclaimed lands in an \"Other\" group listed last (returned in `ungrouped` so you can see what you missed). Optional per-group `details` renders as a short intro under the group title; over 500 chars is REJECTED, not truncated — write a 1–2 sentence intro, don't paste a commit body. Re-setting a group WITHOUT details clears the old one. Pass an EMPTY groups array to fall back to the built-in Tests/Docs/Build + module heuristic. Returns {ok, groups:[{title, fileCount}], ungrouped:[relPath]}. Errors: 'not-found' (no such workspace), 'no-diff-members' (a browse-only workspace has no changed files to group — groups organize a diff), 'group-details-too-long'.",
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
const NO_AUTO_WATCH_TOOLS = new Set(['unwatch_doc', 'watch_doc', 'observe_url']);

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
        const { docId, find, contextBefore, contextAfter, occurrence, text } = a as {
          docId: string;
          find: string;
          contextBefore?: string;
          contextAfter?: string;
          occurrence?: number;
          text: string;
        };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/threads/by_find`, {
          author: AUTHOR,
          text,
          find,
          ...(contextBefore !== undefined ? { contextBefore } : {}),
          ...(contextAfter !== undefined ? { contextAfter } : {}),
          ...(occurrence !== undefined ? { occurrence } : {}),
        });
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
        const { docId, path, title, setId, producedBy } = a as {
          docId: string;
          path: string;
          title?: string;
          setId?: string;
          producedBy?: { agentId?: string; sessionId?: string };
        };
        const res = await http('POST', '/api/docs', {
          docId,
          type: 'markdown',
          sourceUrl: path,
          owner: process.cwd(),
          ...(title ? { title } : {}),
          ...(setId ? { setId } : {}),
          ...(producedBy ? { producedBy } : {}),
        });
        return ok(res);
      }
      case 'set_doc_content': {
        const { docId, markdown } = a as { docId: string; markdown: string };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/content`, {
          markdown,
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
        const { docId, sourceHtmlPath, title } = a as {
          docId: string;
          sourceHtmlPath?: string;
          title?: string;
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
        });
        return ok(res);
      }
      case 'bind_folder': {
        const { folderPath, workspaceId, title, include, maxFiles, subscribe, producedBy } = a as {
          folderPath: string;
          workspaceId?: string;
          title?: string;
          include?: string[];
          maxFiles?: number;
          subscribe?: boolean;
          producedBy?: { agentId?: string; sessionId?: string };
        };
        const res = (await http('POST', '/api/workspaces', {
          folderPath,
          owner: process.cwd(),
          ...(workspaceId ? { workspaceId } : {}),
          ...(title ? { title } : {}),
          ...(include ? { include } : {}),
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

async function emitChannelMessage(event: string, rawPayload: unknown): Promise<void> {
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
