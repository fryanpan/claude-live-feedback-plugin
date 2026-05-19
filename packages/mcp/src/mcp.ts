#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

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
 *   FEEDBACK_BASE_URL  — optional override; usually discovery handles it
 *   FEEDBACK_AUTHOR    — e.g. agent (used as the reply author)
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
const AUTHOR_ID = process.env.FEEDBACK_AUTHOR ?? 'agent';

const KNOWN_USERS: Record<
  string,
  { name: string; color: string; id: string; kind: 'known' | 'anon' }
> = {
  bryan: { name: 'Bryan', color: '#2e7dd7', id: 'known-bryan', kind: 'known' },
  agent: { name: 'Agent', color: '#e36f1e', id: 'known-agent', kind: 'known' },
};

const authorKey = AUTHOR_ID.toLowerCase();
const AUTHOR = KNOWN_USERS[authorKey] ??
  KNOWN_USERS.agent ?? {
    name: 'Agent',
    color: '#e36f1e',
    id: 'known-agent',
    kind: 'known' as const,
  };

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
      '— your filesystem edit gets clobbered by the next flush and diverges from',
      'what the reviewer sees. Route edits through the MCP tools below: find_and_replace',
      'for prose changes, rewrite_thread_region / insert_after_thread / insert_blocks_after_thread',
      'for comment-anchored edits. External edits to the bound file (VS Code, git pull)',
      'flow back into the live doc automatically via fs.watch.',
      '',
      'OBSERVE: call watch_doc(docId) once per doc to receive thread events as',
      '<channel source="live-feedback" doc_id="..." thread_id="..." event="..." author="..." sent_at="...">body</channel>',
      'messages. Treat each as an explicit ask from the reviewer; read, decide if it',
      "is in your domain, act via an edit tool. unwatch_doc when you're done.",
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
        "Create a markdown review doc backed by a file on disk. The server reads the file, parses it into the live editor, and sets up bidirectional sync — every edit (from the browser, the agent, or the widget) writes back to the .md within ~1 second, and external edits to the file (VS Code, git pull) flow into the live doc within ~1 second via fs.watch. `path` should be absolute; relative paths resolve against the server's cwd. The file must exist (create it first if it doesn't). Pass `setId` to group multiple docs for one review session — docs sharing a setId show up in each other's sidebar in the markdown editor, so the reviewer can hop between related files. The caller is auto-subscribed to thread events for this doc (`watch_doc`) on creation so comments arrive as channel messages without a separate call; pass `subscribe: false` for the rare drive-by case where another agent will own the review. Returns the review URL plus the attach result.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          path: { type: 'string' },
          title: { type: 'string' },
          setId: { type: 'string' },
          subscribe: { type: 'boolean' },
        },
        required: ['docId', 'path'],
      },
    },
    {
      name: 'bind_mock',
      description:
        'Bind an HTML mockup (or similar non-markdown review surface) to a docId. Use this when serving an HTML page that embeds `<claude-feedback-widget doc-id="...">` — declares the docId to the server proactively so the agent shows up in `list_docs` before the widget posts its first event, and auto-subscribes the caller to thread events on the doc. `sourceHtmlPath` is optional metadata so `list_docs` can surface the on-disk source. Pass `subscribe: false` to skip the auto-watch (rare). Idempotent — calling twice on the same docId is safe. Mirrors `create_review_doc` semantics for the HTML-widget path: no MCP entry point existed for this before, which made the auto-subscribe gap silent (agent serves HTML, user leaves comments, agent never gets events).',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          sourceHtmlPath: { type: 'string' },
          title: { type: 'string' },
          subscribe: { type: 'boolean' },
        },
        required: ['docId'],
      },
    },
    {
      name: 'find_and_replace',
      description:
        "Replace a string of plain text in the doc with another string. `find` must match the doc's plain text content (no markdown syntax — marks like bold/italic are preserved automatically). Use `contextBefore` / `contextAfter` to disambiguate repeated phrases. If the match is still ambiguous the tool returns a list of candidates. Use `occurrence` (1-indexed) to pick one explicitly. Pass `parseInlineMarks: true` to interpret `[label](url)` / `**bold**` / `*italic*` / `` `code` `` / `~~strike~~` in `replace` as marks on the inserted text instead of literal characters — required when adding a labeled link or other inline mark to text that doesn't already have one. Runs as a single Yjs transaction so it merges cleanly with concurrent user edits.",
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
        },
        required: ['docId', 'find', 'replace'],
      },
    },
    {
      name: 'rewrite_thread_region',
      description:
        'Rewrite the text a thread is anchored to. Primary path for comment-driven edits: the user commented, the agent fixes the exact range they commented on. Immune to concurrent user edits because the anchor is a Y.RelativePosition, resolved to current offsets at apply time. Pass `parseInlineMarks: true` to interpret `[label](url)` / `**bold**` / `*italic*` / `` `code` `` / `~~strike~~` in `replacement` as marks on the inserted text instead of literal characters. Returns `anchor-orphaned` if the user deleted the anchored text — fall back to find_and_replace in that case.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          replacement: { type: 'string' },
          parseInlineMarks: { type: 'boolean' },
        },
        required: ['docId', 'threadId', 'replacement'],
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
      name: 'delete_doc',
      description:
        "Fully remove a review doc — tears down the file binding + fs watcher, closes live ws connections, deletes the persisted .ydoc, and drops the in-memory room so it no longer appears in `list_docs`. The bound .md file (if any) is LEFT ALONE — that's user data, never owned by the server. Refuses by default if the doc has open (unresolved) threads to avoid an agent nuking human-authored feedback; pass `force: true` to override (typical case: cleaning up a stale binding whose source .md was already deleted, so its threads are orphaned anyway). Returns `{ ok: true, deletedYdocPath? }` on success or `{ ok: false, error: 'open-threads', openThreadCount }` when the guardrail trips. If you mean only to stop receiving events, use `unwatch_doc` instead — it leaves the doc intact.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          force: {
            type: 'boolean',
            description:
              'Delete even if open threads exist. Use for stale bindings whose .md is already gone.',
          },
        },
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
            description: "Email domains, e.g. ['@appdevforall.org']",
          },
          ttlSeconds: { type: 'number' },
          name: { type: 'string', description: 'Optional slug override for the subdomain' },
        },
        required: ['docId', 'allowDomains'],
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
 * - `delete_doc`: subscribing right before deleting is pointless; the
 *   doc will be gone before any event could fire.
 */
const NO_AUTO_WATCH_TOOLS = new Set(['unwatch_doc', 'watch_doc', 'observe_url', 'delete_doc']);

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
        const { docId, path, title, setId } = a as {
          docId: string;
          path: string;
          title?: string;
          setId?: string;
        };
        const res = await http('POST', '/api/docs', {
          docId,
          type: 'markdown',
          sourceUrl: path,
          ...(title ? { title } : {}),
          ...(setId ? { setId } : {}),
        });
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
          ...(sourceHtmlPath ? { sourceUrl: sourceHtmlPath } : {}),
          ...(title ? { title } : {}),
        });
        return ok(res);
      }
      case 'find_and_replace': {
        const { docId, find, replace, contextBefore, contextAfter, occurrence, parseInlineMarks } =
          a as {
            docId: string;
            find: string;
            replace: string;
            contextBefore?: string;
            contextAfter?: string;
            occurrence?: number;
            parseInlineMarks?: boolean;
          };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/find_and_replace`, {
          find,
          replace,
          ...(contextBefore !== undefined ? { contextBefore } : {}),
          ...(contextAfter !== undefined ? { contextAfter } : {}),
          ...(occurrence !== undefined ? { occurrence } : {}),
          ...(parseInlineMarks === true ? { parseInlineMarks: true } : {}),
        });
        return ok(res);
      }
      case 'rewrite_thread_region': {
        const { docId, threadId, replacement, parseInlineMarks } = a as {
          docId: string;
          threadId: string;
          replacement: string;
          parseInlineMarks?: boolean;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/rewrite_region`,
          {
            replacement,
            ...(parseInlineMarks === true ? { parseInlineMarks: true } : {}),
          },
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
      case 'delete_doc': {
        const { docId, force } = a as { docId: string; force?: boolean };
        // Drop our channel subscription first so the SSE loop doesn't
        // race with the server tearing down the room.
        unwatchDoc(docId);
        const qs = force ? '?force=1' : '';
        const res = await http('DELETE', `/api/docs/${encodeURIComponent(docId)}${qs}`);
        return ok(res);
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
  void runSseLoop(docId, controller.signal).catch((err) => {
    console.error(`[live-feedback-mcp] watcher ${docId} crashed:`, err);
    watchers.delete(docId);
  });
}

function unwatchDoc(docId: string): void {
  const w = watchers.get(docId);
  if (!w) return;
  w.controller.abort();
  watchers.delete(docId);
}

async function runSseLoop(docId: string, signal: AbortSignal): Promise<void> {
  // Tight reconnect loop — the server sends keepalive comments every
  // ~15s, so an abrupt close is almost always a transient network blip.
  while (!signal.aborted) {
    try {
      const res = await fetch(`${resolveBaseUrl()}/events/${encodeURIComponent(docId)}`, {
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`sse /events/${docId} → ${res.status}`);
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
      console.error(`[live-feedback-mcp] ${docId} sse error, retrying:`, err);
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
}

async function emitChannelMessage(event: string, rawPayload: unknown): Promise<void> {
  const p = (rawPayload ?? {}) as ChannelPayload;
  const docId = p.docId ?? 'unknown';
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
