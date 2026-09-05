/**
 * The tool registry: what `tools/list` answers with, and nothing else.
 *
 * 94 tool schemas, declarative, with no logic in them at all — names,
 * descriptions and JSON Schema for the arguments. This lived at the top of
 * `mcp.ts`, directly above the dispatch switch that answers the same 94
 * names, and the two are different kinds of thing: a table an agent READS to
 * decide what to call, and the code that runs when it calls. A change here is
 * a wording or an argument; a change in `tools/` is behaviour.
 *
 * The descriptions ARE the product surface. An agent picks a tool from this
 * text alone, so a description that omits the failure mode a parameter exists
 * for is a bug in the same sense a dropped parameter is — several of them say
 * so at length, deliberately.
 *
 * Exported as the whole `tools/list` RESULT rather than a bare array, which
 * is also what keeps the schemas literally unmoved: nested one level inside
 * `{ tools: [ … ] }` they sit at exactly the indentation they had inside the
 * handler's return, so the extraction changed no line of the table. The type
 * annotation is load-bearing too — inline, the object literals were
 * contextually typed, and `type: 'object'` would widen to `string` the moment
 * they became a standalone const.
 *
 * `tool-wiring.test.ts` reads this file's `name:` lines against the `case`
 * labels in `tools/`, so a tool declared here and dispatched nowhere fails a
 * gate rather than shipping visible, callable, and answering "unknown tool".
 */
import { TASK_STATUSES } from '@feedback/core/task-wire';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

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
    "Declares this a Review Item, putting it on the reviewer's Home queue once it passes the board's quality gate. Omit it for ordinary comments — status notes and closing remarks are not review items. headline is the row title; missing or multi-line is refused, over-long files anyway with advice. Everything else goes in detail, in whatever shape the ask wants to read.",
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

export const TOOL_LIST: ListToolsResult = {
  tools: [
    {
      name: 'list_docs',
      description:
        'List review docs registered on the server — ONE PAGE at a time. The default answer is the 50 most recently active docs as compact rows (docId, title, type, sourceUrl, relPath, setId, boardId, timestamps, thread counts, reviewUrl) plus `nextCursor`; pass it back as `cursor` for the next page, and stop when it is null. It is never the whole server: the unscoped dump ran to several megabytes. Narrow with `workspaceId`, `kind`, `query` (case-insensitive substring over title / docId / alias / relPath / sourceUrl — the cheap way to ask "is this file under review?"), or `sourcePrefix`. `full: true` swaps the compact row for the whole doc meta on that page; walk the cursor with `full: true` and `limit: 500` when you really need everything.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'Only docs in this workspace. Matches hub-board membership and the reviewId folder binds / diff reviews stamp on their members. An unknown id returns an empty list.',
          },
          kind: {
            type: 'string',
            enum: ['markdown', 'mockup', 'code', 'diff', 'workspace'],
            description: 'Only docs of this type.',
          },
          query: {
            type: 'string',
            description:
              'Case-insensitive substring matched against title, docId, alias, relPath and sourceUrl. A file basename finds the doc bound to that file.',
          },
          sourcePrefix: {
            type: 'string',
            description: 'Only docs whose sourceUrl or relPath starts with this path.',
          },
          limit: {
            type: 'number',
            description: 'Rows per page, 1–500. Default 50.',
          },
          cursor: {
            type: 'string',
            description: 'The `nextCursor` from the previous page. Omit for the first page.',
          },
          full: {
            type: 'boolean',
            description:
              'Return the whole doc meta for each row on this page (bind configuration, diff fields, owner, provenance) instead of the compact row. Default false.',
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
        'Reply to an existing thread. Pass review when the reply is asking a person to decide or look; without it, it is an ordinary comment and does not enter the queue. A review payload is judged by the same quality gate a ticket item passes: `held: true` means the item is off the queue until you revise it, and the result names the gap plus the revise_review_item(docId=…, threadId=…, commentId=…) call that ends the hold. A comment is an ask, a decision, or a reply to a person — where the work stands goes through post_status instead. Returns threadUrl, the link to hand a peer.',
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
      name: 'post_status',
      description:
        "One line to a few sentences on where the work stands; lands on the task's Activity tab, never as a comment. Omit taskId to post to your current in-progress task. Your end-of-turn message already reaches the same tab on its own, so this is for a milestone worth naming — started, blocked on what, PR open, done. Refused when empty or over 4000 chars.",
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          taskId: {
            type: 'string',
            description:
              'The row to report on. Omit it and the note lands on your current in-progress task; with none, it is kept on your own recent-activity list only.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'create_thread',
      description:
        "Open a comment thread on a doc. Pass find to anchor it to a phrase; omit find entirely for a thread about the doc as a whole — that is how you comment on a task, whose body doc is task:<taskId> and is often empty. Pass review when you are asking a person to decide or look; leave it off for notes you are recording. A review payload goes through the same quality gate a ticket item does: `held: true` in the result means it is off the reader's queue until you revise it, and the result carries the reason plus the exact revise_review_item(docId=…, threadId=…, commentId=…) call that lifts it. Returns threadUrl — hand that to a peer instead of pasting the report into chat.",
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
      description:
        'Mark a thread as resolved. THREAD-SCOPED: it retires every review item on the thread, so use withdraw_review_item to take back one of your own asks while the others stay answerable.',
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
      name: 'attach_mockup',
      description:
        'Serve an HTML mockup at /mockup/<docId> and bind it for comments — the server reads the file at sourceHtmlPath on each request, so edits show up on reload, and captures what it read so the link keeps working after your scratch directory is cleaned up. An unreadable sourceHtmlPath fails HERE rather than 404ing later in front of the reviewer. Hand the returned meta.reviewUrl to a person. Single-file mockups only: relative CSS/JS siblings will not resolve. Idempotent.',
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
      name: 'attach_folder',
      description:
        'Attach a folder or worktree as a browsable workspace — an alias for create_diff_review with no base. The reviewer picks files from the menu under the filename in the topbar — they open lazily, and markdown opens editable. Prefer create_diff_review directly: passing a base gets you the changed-files diff on top of browsing.',
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
            description: 'reviewId from create_diff_review, or setId from attach_folder.',
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
            description: 'reviewId from create_diff_review, or setId from attach_folder.',
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
        'Permanently delete a board and all of its tasks, rooms and history. Reach for archive_workspace instead in almost every case — this one cannot be undone. Refuses while open tasks remain unless you pass force. Docs attached to the board survive: attaching is a link, not ownership.',
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
            description: 'reviewId from create_diff_review, or setId from attach_folder.',
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
        "Replace plain text in a doc with other plain text. find matches the doc's plain text, not markdown — marks are preserved automatically. Exception: a find that IS pipe-table row syntax (| a | b |) matches table rows structurally, cells compared by text with whitespace ignored, so a row quoted from the .md works; the replace must keep the same row/cell shape. Disambiguate repeats with contextBefore / contextAfter or occurrence, or pass replaceAll for a mechanical sweep. A no-match returns a hint quoting the doc's actual characters; copy the find from that rather than guessing. Pass parseInlineMarks to read markdown in replace as real marks, and suggest: true to propose the edit instead of applying it. INLINE ONLY: replace goes inside one existing block, so block-level markdown in it — a heading, a list item, a rule, a fence — is refused with block-markdown-in-replacement; use insert_blocks_after_thread or insert_blocks_at_anchor for those.",
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
        "Subscribe this session to a doc's comment events, delivered as channel messages. Usually unnecessary — create_review_doc, attach_mockup and most docId-bearing tools subscribe you already, and set_workspace_lead covers every doc on your board. Reach for it for a doc you have not otherwise touched, such as a peer's review you only want to observe. persisted: false means a restart will drop it.",
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
        "Mint a share link for a board: anyone you send it to signs in once with their email and is a member of that board from then on; already signed in means straight in. A board is the unit of sharing — file a doc or review on one first; a review id is refused. Everything on that board travels with the share, so check what else is filed there, or give the review its own board. Returns a share.<domain>/s/<id> URL. Links are long-living: pass ttlSeconds only when you want one to lapse. allowDomains no longer restricts anything (one Access application covers the share hostname and the server records members itself) — it is accepted and ignored, and the reply says so. unshare stops new people redeeming without ejecting the ones already in; remove_share_member ends one person's access.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: {
            type: 'string',
            description:
              'The BOARD to share — the id create_workspace returned, or the hubWorkspaceId attach_folder / create_diff_review reported. NOT a review/review id.',
          },
          ttlSeconds: {
            type: 'number',
            description:
              'Optional lifetime in seconds. Omit for a link with no expiry, which is the default.',
          },
          label: { type: 'string', description: 'Human label shown in list_shares.' },
          allowDomains: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Accepted and IGNORED — kept so an older caller is not refused. Anyone who opens the link and signs in becomes a member.',
          },
        },
        required: ['workspaceId'],
      },
    },
    {
      name: 'remove_share_member',
      description:
        "End one person's access to a board they joined through a share link. Their next request is refused, and any live editing socket or event stream that membership had already opened is hung up — the reply says how many of each. Membership is per board, so their connections to any OTHER board they hold are untouched. This is the verb for ejecting somebody — unshare only stops new people redeeming the link, and never removes anyone already in. list_shares names every member and which link they came through.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string', description: 'The board to remove them from.' },
          email: { type: 'string', description: 'The address to remove, as list_shares shows it.' },
        },
        required: ['workspaceId', 'email'],
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
        'Every share of every board: the links, who has redeemed each one and when, and whether each is live, revoked or expired — plus any shares still on the retired per-hostname mode, with their hostnames and allowed domains.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'unshare',
      description:
        'Revoke a share by id. For a share link this stops anyone NEW redeeming it and leaves the people who already joined as members — use remove_share_member to eject somebody. For a share on the retired per-hostname mode it deletes the Cloudflare Access app and policy and removes the entry. Use it for early teardown; a link with a TTL otherwise lapses on its own, and one without never does.',
      inputSchema: {
        type: 'object',
        properties: { shareId: { type: 'string' } },
        required: ['shareId'],
      },
    },
    {
      name: 'set_sharing_enabled',
      description:
        'Master switch for all external access. Off makes every share and link answer 403 — one call instead of revoking shares individually. It also hangs up open connections belonging to per-share visitors and to share-link members; a COLLABORATION-hostname visitor carries neither a share nor a membership, so their open socket survives until it drops. Existing shares are preserved and resume when it is back on; the local and tailnet surface is unaffected. Call with no argument to read the current state.',
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
        "Change a board's name. Nothing else moves — same id, same URL, same tasks, so every existing link keeps working. Renaming into a name another live board holds is allowed; the response names the collision in sameName. Use archive_workspace when the answer is that one of the two is over.",
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
      name: 'archive_workspace',
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
        "File work on a board. Always takes a list; one task is a one-row list, so this is the only create verb. Per row: omit assignee and you own it, omit goal and it lands unplaced at the bottom of Backlog. Rows you file land in triage — on the board, but not in anyone's queue until somebody moves them out with task_transition. A bad row never rejects the batch; it comes back in failures by index. Anything on a row that will reach the reader's queue passes the board's quality gate — a `review` payload, and the row's own question when it is `needs: 'decision'`. A row that comes back `held: true` is filed but OFF that queue until you close the gap in `heldReason`; the result carries the exact revise_review_item(…) call that lifts it, and every revision is judged again.",
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
                    'Goal id, or "chores". OMIT to leave this row UNPLACED at the bottom of Backlog for the lead to place. An explicit goal — even "chores" — is a placement.',
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
                    "The human's VERBATIM words, for chat-born asks — kept forever on the task. (For thread-born asks use spin_off_task, which captures the quote itself.)",
                },
              },
              required: ['title'],
            },
            maxItems: 100,
          },
          sourceDoc: {
            type: 'object',
            description:
              "The doc these rows were derived from — set it whenever you are filing tasks out of a doc, and every row gets a structured origin ref back to it (no separate link call). `mode` says what kind of doc: 'plan' (the default for an ordinary doc) files the rows as DRAFTS — visible on the board, in no dispatch read, held in triage until a person approves the plan on the doc page, which releases them; 'discussion' (the default for a meeting notes doc) files them live immediately. A later edit to the doc flags still-open derived rows as possibly stale.",
            properties: {
              docId: { type: 'string' },
              mode: { type: 'string', enum: ['plan', 'discussion'] },
            },
            required: ['docId'],
          },
        },
        required: ['workspaceId', 'tasks'],
      },
    },
    {
      name: 'spin_off_task',
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
          goal: { type: 'string', description: 'Goal id. OMIT to route through triage.' },
          dueAt: { type: 'number' },
          links: { type: 'array', items: { type: 'object' } },
        },
        required: ['docId', 'threadId', 'workspaceId'],
      },
    },
    {
      name: 'set_review_item_criteria',
      description:
        "Set what this board's quality gate judges a review item against — a natural-language prompt the judge reads verbatim before each add_review_item / revise_review_item. Omit `criteria` (or pass an empty string) to restore the default, which asks for a headline in the reader's words, stakes and what to look at in the detail, a cost on every option, inline links, and no raw ids or unexpanded acronyms. get_workspace shows the current text.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          reviewItemId: {
            type: 'string',
            description:
              'Instead of workspaceId: any review item id, addressing the board that judges that item.',
          },
          criteria: {
            type: 'string',
            description:
              'The criteria, as prose the judge will read. Up to 4,000 characters. Omit to restore the default.',
          },
        },
        required: [],
      },
    },
    {
      name: 'get_workspace',
      description:
        "Read a board's goals in priority order, with per-goal task counts, plus the parallelism cap — its value, slots in use and free, and who last moved it and when. First row is the highest band. Call it before deciding what to work on — list_tasks returns goal ids only, so without this the ordering is invisible. Cheap by design: pair it with next_tasks, which carries the tasks themselves.",
      inputSchema: {
        type: 'object',
        properties: { workspaceId: { type: 'string' } },
        required: ['workspaceId'],
      },
    },
    {
      name: 'find_related_work',
      description:
        "Before writing a plan, or creating a goal, ask what on this board already covers the request. Returns the goals and plan docs that line up — each with a score, a one-line reason and a relative link — or an empty list when nothing does. Cheap: token overlap plus the board's own links, no model call. If anything comes back, file ONE decision review item (extend / replace / new) and wait for the answer; if nothing does, plan from scratch. Either way the goal you create or update gets a description and a link to the doc the request came from.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          text: {
            type: 'string',
            description:
              'The request in the words it was asked in. Scoring does not depend on length, so paste the whole ask rather than boiling it down to a keyword.',
          },
          docId: {
            type: 'string',
            description:
              'The doc the request came out of — meeting notes, a huddle, a thread. A goal that already links it is returned even when its title shares no word with the request.',
          },
          limit: { type: 'number', description: 'How many matches to return. Default 5, max 20.' },
        },
        required: ['workspaceId', 'text'],
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
            enum: [...TASK_STATUSES],
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
        "The single gate for status changes (triage | todo | in-progress | done), attributed to you on the task's trail. It is also the only way to clear a triage row. Takes a GOAL id as `taskId` too: a goal in triage is a band nobody has agreed to — every row under it is held out of next_tasks and the ready nudge, and the stall check does not judge them — so moving a goal to `todo` releases its band and moving it to `triage` holds it again. Say what you did in `note` — the commit, the PR, what you verified — because the note is the whole of what the trail keeps. Re-sending the same status refuses; there is nothing to change.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          to: { type: 'string', enum: [...TASK_STATUSES] },
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
      name: 'block_task',
      description:
        'Say what a task is waiting for: name the ticket or tickets that have to close first. The row reads as Blocked on the board from that moment — the edge IS the state, there is no status to set — it leaves next_tasks and the stall check, and it comes free by itself when the last blocker closes, with a note on its Activity tab saying what cleared it. A todo row and an in-progress row both read as Blocked; blocking one you are already working on is legitimate and says so on the board rather than silently dropping it from the queue. Adds to whatever the row already waits on; remove an edge with set_task_dependencies. This replaces park_task: "not now" belongs to whatever the work is waiting for, and triage is for rows nobody has vetted yet. A row waiting on a PERSON is not blocked — leave it in-progress and file the ask with add_review_item.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          blockedBy: {
            description:
              'The task id, or ids, this row waits on. Each must be a task on the same board; an unknown id is refused rather than recorded, because a dangling edge blocks nothing and says it does.',
            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
        },
        required: ['taskId', 'blockedBy'],
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
          goal: { type: 'string', description: 'Goal id, or "chores".' },
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
        "Add or remove a goal by submitting the board's whole ordered list. Send an entry with no id to add a band (the server mints it); send an existing id exactly as get_workspace reports it to keep one. A band you add starts in `triage` — not ready to work on: nothing under it is dispatched until somebody moves the goal to `todo` with task_transition(taskId: <goal id>, to: 'todo'). Use rename_goal to retitle and reorder_goals to re-prioritise — both are safer, because this is a full replace and any id you leave out is removed. Removing a band that still holds tasks is refused until you name it in drop.",
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
              },
              required: ['title'],
            },
          },
          drop: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Goal ids you intend to remove even though they still hold tasks — the acknowledgement that turns the refusal into the removal. Read what the refusal said each band holds first. Ids that are not actually being removed are ignored.',
          },
        },
        required: ['workspaceId', 'goals'],
      },
    },
    {
      name: 'rename_goal',
      description:
        "Change a goal's title in place, by id. The id never moves, so no task moves. Use this rather than set_goal_list, which would make you restate every other band. dueAt is optional: a number sets it, null clears it, omitting it leaves it alone.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          goal: {
            type: 'string',
            description: 'The goal id to retitle. Get it from get_workspace.',
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
        "Change the priority order of a board's goals — order is priority. Permutation only: order must be exactly the ids the board already holds, so nothing can be created, renamed or lost. Take the ids from get_workspace and send every row whose reorderable is true. Use set_goal_list only when you actually mean to add or remove a band.",
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          order: {
            type: 'array',
            items: { type: 'string' },
            description:
              'EVERY reorderable goal id, in the new priority order, highest first. Leaving one out is an error, not a demotion; including a non-reorderable row (Backlog) is an error too.',
          },
        },
        required: ['workspaceId', 'order'],
      },
    },
    {
      name: 'add_review_item',
      description:
        'Hang a question on a ticket that already exists — the verb for a question that came up while working it, so the ask stays attached to the work that raised it. A ticket carries several at once, each answered on its own, so the title keeps naming the work and a second question needs no second ticket. When you are filing the work and the question together, use review on a create_tasks row instead. Every item passes a quality gate (the board’s criteria, see set_review_item_criteria): a result with `held: true` means it is on the ticket but OFF the reader’s queue — fix the gap in `heldReason` with revise_review_item, which judges it again.',
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
              "Which item is being answered (from list_tasks / the ticket's `reviews`, or any queue row). Alone — no taskId — it addresses the item wherever it lives, a doc-thread item included. Omit it on a ticket that is itself a decision — the answer then lands on that decision.",
          },
          text: { type: 'string', description: "The human's verbatim answer." },
          answeredWith: {
            type: 'string',
            description:
              "The id of the option they picked, if they picked one. The answer is still `text` — pass the option's label as the text. Omit when they answered in their own words.",
          },
        },
        required: ['text'],
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
              'Which item is being asked about. Alone — no taskId — it addresses the item wherever it lives; on a doc-thread item the question posts as a reply on its thread. Omit on a ticket that is itself an old-style decision, same rule as answer_review_item.',
          },
          question: { type: 'string', description: 'What they want to know, verbatim.' },
        },
        required: ['question'],
      },
    },
    {
      name: 'revise_review_item',
      description:
        "Rewrite one of your review items in place — the answer to a question somebody asked ON it, or the fix for an item the quality gate HELD (`held: true` from add_review_item, or a workspace.review_item_held wake). Pass only the fields that change; the previous words are kept as history. Address the item wherever you raised it: on a TICKET, `taskId` + `reviewItemId` (the id rides with the question on the task's thread); for the TICKET'S OWN decision — a `needs: 'decision'` row, which has no item id because its words ARE the title, body and options — `taskId` alone, the shape answer_decision takes for the same row; on a DOC THREAD, `docId` + `threadId` + `commentId` — the review is a payload on one comment, and `commentId` is the `thread.comments[].id` that create_thread / post_reply already handed you when you raised it. Half a doc address is refused, not guessed. EVERY form re-judges every revision — a held item reaches the reader's queue when it passes, and a revision that still misses the mark comes back `held: true` with the gap named. The ticket form additionally returns an already-queued item marked Revised, with their question quoted and the changed span highlighted, and `reply` posts on the asking thread in the same call. Revising a ticket's own decision rewrites the row's words, so rewrite_task does the same job and is judged the same way. The doc form has no `reply`; it rewrites the item, judges it, and tells the thread's watchers.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description:
              "Ticket form: the ticket. With reviewItemId, one of the items filed on it; alone, the ticket's OWN decision.",
          },
          reviewItemId: {
            type: 'string',
            description:
              "Which item to revise. Alone — no taskId — it addresses the item wherever it lives, a doc-thread item included. With taskId, one of the items filed on that ticket. Omit for the ticket's own decision — the question a `needs: 'decision'` row asks in its title and body, which carries no item id.",
          },
          docId: {
            type: 'string',
            description:
              'Doc-thread form: the doc the thread lives on. Pass with threadId and commentId.',
          },
          threadId: {
            type: 'string',
            description: 'Doc-thread form: the thread the item was raised on.',
          },
          commentId: {
            type: 'string',
            description:
              'Doc-thread form: the comment carrying the review payload — `thread.comments[].id` in what create_thread / post_reply returned when you raised the item.',
          },
          headline: TASK_REVIEW_ITEM_SCHEMA.properties.headline,
          detail: TASK_REVIEW_ITEM_SCHEMA.properties.detail,
          options: TASK_REVIEW_ITEM_SCHEMA.properties.options,
          reply: {
            type: 'string',
            description:
              'A reply on the thread that asked — one or two sentences pointing at what changed. Refused when nobody has asked on this item yet. Ticket form only: a doc-thread item already lives in a thread, so point at the change there with post_reply.',
          },
          revisedRange: {
            type: 'object',
            description:
              'Which span of the NEW detail changed, as character offsets, when the diff would not say it well (you moved a paragraph, say). Omitted, the changed span is derived.',
            properties: { start: { type: 'number' }, end: { type: 'number' } },
            required: ['start', 'end'],
          },
        },
        // No unconditional required list: which ids are required depends on
        // which of the two addresses the caller is using, and the handler
        // refuses a half-written one by name.
        required: [],
      },
    },
    {
      name: 'withdraw_review_item',
      description:
        'Take back a review item — normally one you raised, for an ask that turned out to be wrong or that a later one replaced; any agent in the workspace can retire a stale one, and the item records who did. Address it by bare reviewItemId wherever it lives (a ticket item or a doc-thread item alike), or by the doc-thread triple as before. The reader stops being asked: it leaves their queue and reads as withdrawn where it was raised, with your reason beside it. Your words stay there verbatim, because they may already have read them. Prefer revise_review_item when the question still stands and only its wording is wrong; withdraw is for when there is nothing left to ask. On a shared doc thread this is how you clean up one of TWO items without touching the other — resolve_thread would retire the whole thread and take the live ask with it. Refused on an item somebody has already answered: that would retract their answer. `undo: true` puts it back.',
      inputSchema: {
        type: 'object',
        properties: {
          reviewItemId: {
            type: 'string',
            description:
              'The item, by its id — from the queue row, the ticket, or add_review_item. Addresses either surface; no other id needed.',
          },
          taskId: {
            type: 'string',
            description:
              'Optional with reviewItemId: the ticket you already know holds the item, skipping a lookup.',
          },
          docId: { type: 'string', description: 'Doc-thread form: the doc the thread lives on.' },
          threadId: {
            type: 'string',
            description: 'Doc-thread form: the thread the item was raised on.',
          },
          commentId: {
            type: 'string',
            description:
              'Doc-thread form: the comment carrying the review payload — `thread.comments[].id` in what create_thread / post_reply returned when you raised the item.',
          },
          reason: {
            type: 'string',
            description:
              'One line on why, shown with the retracted item. Worth writing: "superseded by the item below" is the difference between a disappearance and a correction.',
          },
          undo: {
            type: 'boolean',
            description: 'Put a withdrawn item back in front of the reader.',
          },
        },
        // Which ids are required depends on which address the caller is
        // using — a bare reviewItemId, or the doc-thread triple — and the
        // handler refuses a half-written one by name.
        required: [],
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
      name: 'register_dispatch',
      description:
        "Tell the board a builder is working a task in a private git worktree, so the stall loop can read the worktree's file activity as the row moving instead of waking the lead over silence it cannot see. Call it when you spawn a builder; re-registering the same task replaces the old worktree. Close it with close_dispatch when the builder reaches terminal (done or died) — a worktree that is deleted closes its own dispatch.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task the builder is working.' },
          worktreePath: {
            type: 'string',
            description: "Absolute path to the builder's git worktree on this machine.",
          },
        },
        required: ['taskId', 'worktreePath'],
      },
    },
    {
      name: 'close_dispatch',
      description:
        "Close a builder dispatch registered with register_dispatch — the builder reached terminal (done or died), so the task's worktree no longer vouches for it. closed: false means no dispatch was open for that task, which is fine to ignore.",
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string', description: 'The task whose dispatch to close.' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'set_parallelism_cap',
      description:
        'Set how many builders a board may have dispatched at once — the dispatch rule the lead skill describes. Every board starts on the default (4); lower it to keep this board from starving higher-priority projects, raise it when there is room. The change is recorded with you as the actor and takes effect on the next dispatch: nothing running is touched, register_dispatch simply refuses past the new number. Answers with the full view — the cap, the slots in use and who holds them, how many are free, and lastChange (who moved it, when, from what) — so you see in the same reply whether the board is already over it. The floor is one; pausing a board is archive_workspace, not a cap of zero.',
      inputSchema: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          cap: {
            type: 'integer',
            minimum: 1,
            description:
              'The new cap: a positive integer. get_workspace shows the current one and the default.',
          },
        },
        required: ['workspaceId', 'cap'],
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
};
