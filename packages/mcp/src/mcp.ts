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

function resolveBaseUrl(): string {
  if (process.env.FEEDBACK_BASE_URL) return process.env.FEEDBACK_BASE_URL;
  const discovery = join(homedir(), '.claude', 'live-feedback', 'server.json');
  if (existsSync(discovery)) {
    try {
      const j = JSON.parse(readFileSync(discovery, 'utf8')) as { port?: number };
      if (j.port) return `http://localhost:${j.port}`;
    } catch {
      // ignore — fall through to default
    }
  }
  return 'http://localhost:8787';
}

const BASE_URL = resolveBaseUrl();
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
      'Channel events arrive as <channel source="live-feedback" doc_id="..." ',
      'thread_id="..." event="..." author="..." sent_at="...">body</channel>.',
      'Treat them as explicit asks from the reviewer: read, decide if the',
      'comment is in your domain, and act via the edit tools',
      '(rewrite_thread_region / find_and_replace / insert_blocks_after_thread).',
      'Call watch_doc(docId) to start receiving events for a doc; unwatch_doc to stop.',
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
      name: 'seed_doc',
      description:
        'One-shot initial content load for a brand-new empty review doc. Accepts markdown (headings, paragraphs, lists, blockquotes, code blocks, horizontal rules — same parser as insert_blocks_after_thread). Fails with `non-empty` if the doc already has any content — this tool NEVER clobbers existing text. Use when an agent creates a doc via POST /api/docs and wants to populate it without waiting for a browser session to open the URL.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          markdown: { type: 'string' },
        },
        required: ['docId', 'markdown'],
      },
    },
    {
      name: 'find_and_replace',
      description:
        "Replace a string of plain text in the doc with another string. `find` must match the doc's plain text content (no markdown syntax — marks like bold/italic are preserved automatically). Use `contextBefore` / `contextAfter` to disambiguate repeated phrases. If the match is still ambiguous the tool returns a list of candidates. Use `occurrence` (1-indexed) to pick one explicitly. Runs as a single Yjs transaction so it merges cleanly with concurrent user edits.",
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          find: { type: 'string' },
          replace: { type: 'string' },
          contextBefore: { type: 'string' },
          contextAfter: { type: 'string' },
          occurrence: { type: 'number' },
        },
        required: ['docId', 'find', 'replace'],
      },
    },
    {
      name: 'rewrite_thread_region',
      description:
        'Rewrite the text a thread is anchored to. Primary path for comment-driven edits: the user commented, the agent fixes the exact range they commented on. Immune to concurrent user edits because the anchor is a Y.RelativePosition, resolved to current offsets at apply time. Returns `anchor-orphaned` if the user deleted the anchored text — fall back to find_and_replace in that case.',
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
          threadId: { type: 'string' },
          replacement: { type: 'string' },
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
        "Apply an edit at a previously-created agent anchor. `op.kind` is 'replace' (rewrite the anchored range) or 'insert_after' (insert text right after the anchor's end). Runs as a Yjs transaction; merges cleanly with concurrent user edits.",
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
      name: 'delete_anchor',
      description: 'Remove a previously-created agent anchor. Useful for cleanup between tasks.',
      inputSchema: {
        type: 'object',
        properties: { docId: { type: 'string' }, anchorId: { type: 'string' } },
        required: ['docId', 'anchorId'],
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
        "Start pushing live feedback events for this doc into the current Claude Code session as <channel source='live-feedback' …> messages. Every thread.created / thread.replied / thread.resolved / thread.reopened on the doc arrives as a channel event until you call unwatch_doc.",
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
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
      case 'seed_doc': {
        const { docId, markdown } = a as { docId: string; markdown: string };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/seed`, {
          markdown,
        });
        return ok(res);
      }
      case 'find_and_replace': {
        const { docId, find, replace, contextBefore, contextAfter, occurrence } = a as {
          docId: string;
          find: string;
          replace: string;
          contextBefore?: string;
          contextAfter?: string;
          occurrence?: number;
        };
        const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/find_and_replace`, {
          find,
          replace,
          ...(contextBefore !== undefined ? { contextBefore } : {}),
          ...(contextAfter !== undefined ? { contextAfter } : {}),
          ...(occurrence !== undefined ? { occurrence } : {}),
        });
        return ok(res);
      }
      case 'rewrite_thread_region': {
        const { docId, threadId, replacement } = a as {
          docId: string;
          threadId: string;
          replacement: string;
        };
        const res = await http(
          'POST',
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/rewrite_region`,
          { replacement },
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
      case 'delete_anchor': {
        const { docId, anchorId } = a as { docId: string; anchorId: string };
        const res = await http(
          'DELETE',
          `/api/docs/${encodeURIComponent(docId)}/agent_anchors/${encodeURIComponent(anchorId)}`,
        );
        return ok(res);
      }
      case 'observe_url': {
        const { docId } = a as { docId: string };
        return ok({ sseUrl: `${BASE_URL}/events/${encodeURIComponent(docId)}` });
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
      const res = await fetch(`${BASE_URL}/events/${encodeURIComponent(docId)}`, { signal });
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
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return json;
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
console.error(`[mcp] connected — base ${BASE_URL}, author ${AUTHOR.name}`);
