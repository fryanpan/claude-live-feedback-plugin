import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Anchor, DocType, User } from '@feedback/core';
import { Rooms, type FeedbackWs } from './rooms.ts';
import { openSseStream, SseHub } from './sse.ts';
import { createWebhookDispatcher, type WebhookLogEntry } from './webhooks.ts';
import { onClose, onMessage, onOpen } from './yjs-protocol.ts';

const DEFAULT_PORT = Number(process.env.PORT ?? 8787);

export interface ServerOptions {
  port?: number;
  dataDir?: string;
  /** Absolute path to the built widget dist dir, or null to skip. */
  widgetDistDir?: string | null;
  /** Absolute path to the built markdown-app dist dir. */
  markdownAppDistDir?: string | null;
  /** Absolute path to the demos dir (static HTML). */
  demosDir?: string | null;
}

const CT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface ServerHandle {
  port: number;
  rooms: Rooms;
  webhookLog: WebhookLogEntry[];
  stop: () => Promise<void>;
}

export function createServer(opts: ServerOptions = {}): ServerHandle {
  const port = opts.port ?? DEFAULT_PORT;
  const dataDir = opts.dataDir ?? join(process.cwd(), 'data');
  const widgetDist = opts.widgetDistDir ?? null;
  const markdownAppDist = opts.markdownAppDistDir ?? null;
  const demosDir = opts.demosDir ?? null;

  const sse = new SseHub();
  const webhookLog: WebhookLogEntry[] = [];
  const webhooks = createWebhookDispatcher({
    onLog: (e) => {
      webhookLog.push(e);
      if (webhookLog.length > 1000) webhookLog.shift();
    },
  });
  const rooms = new Rooms({ dataDir, sse, webhooks });

  const server = Bun.serve<{ docId: string }>({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      // --- WebSocket upgrade ---
      if (pathname.startsWith('/y/')) {
        const docId = decodeURIComponent(pathname.slice(3));
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        rooms.getOrCreate(docId);
        const upgraded = server.upgrade(req, { data: { docId } });
        if (!upgraded) return new Response('upgrade required', { status: 426 });
        return undefined;
      }

      // --- SSE ---
      if (pathname.startsWith('/events/')) {
        const docId = decodeURIComponent(pathname.slice('/events/'.length));
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        rooms.getOrCreate(docId);
        return openSseStream(sse, docId);
      }

      // --- REST: docs ---
      if (pathname === '/api/docs' && req.method === 'POST') {
        const body = await safeJson(req);
        const docId = (body?.docId as string) ?? '';
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        const room = rooms.getOrCreate(docId, {
          type: (body?.type as DocType) ?? 'markdown',
          sourceUrl: body?.sourceUrl as string | undefined,
          title: body?.title as string | undefined,
          webhookUrl: body?.webhookUrl as string | undefined,
        });
        return j(200, { docId: room.docId, meta: room.meta });
      }
      if (pathname === '/api/docs' && req.method === 'GET') {
        return j(200, { docs: rooms.list() });
      }
      const docMatch = pathname.match(/^\/api\/docs\/([^/]+)(?:\/(.*))?$/);
      if (docMatch) {
        const docId = decodeURIComponent(docMatch[1] ?? '');
        const rest = docMatch[2] ?? '';
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        const room = rooms.get(docId);
        if (!room) return j(404, { error: 'doc not found' });
        if (rest === '' && req.method === 'GET') {
          return j(200, { meta: room.meta });
        }
        if (rest === 'threads' && req.method === 'GET') {
          const status = url.searchParams.get('status') as 'open' | 'resolved' | null;
          return j(200, {
            threads: rooms.listThreads(docId, status ? { status } : undefined),
          });
        }
        const threadIdMatch = rest.match(/^threads\/([^/]+)(\/.*)?$/);
        if (threadIdMatch) {
          const threadId = decodeURIComponent(threadIdMatch[1] ?? '');
          const threadRest = threadIdMatch[2] ?? '';
          if (threadRest === '' && req.method === 'GET') {
            const t = rooms.getThread(docId, threadId);
            return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
          }
          if (threadRest === '/comments' && req.method === 'POST') {
            const body = await safeJson(req);
            const user = body?.author as User | undefined;
            const text = body?.text as string | undefined;
            if (!user || !text) return j(400, { error: 'author + text required' });
            const t = await rooms.postComment(docId, threadId, user, text);
            return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
          }
          if (threadRest === '/resolve' && req.method === 'POST') {
            const t = rooms.resolve(docId, threadId);
            return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
          }
          if (threadRest === '/reopen' && req.method === 'POST') {
            const t = rooms.reopen(docId, threadId);
            return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
          }
          if (threadRest === '/reanchor' && req.method === 'POST') {
            const body = await safeJson(req);
            const anchor = body?.anchor as Anchor | undefined;
            if (!anchor) return j(400, { error: 'anchor required' });
            const t = rooms.reanchor(docId, threadId, anchor);
            return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
          }
        }
        if (rest === 'threads' && req.method === 'POST') {
          const body = await safeJson(req);
          const user = body?.author as User | undefined;
          const text = body?.text as string | undefined;
          const anchor = body?.anchor as Anchor | undefined;
          if (!user || !text || !anchor) {
            return j(400, { error: 'author + text + anchor required' });
          }
          const t = await rooms.postComment(docId, null, user, text, anchor);
          return t ? j(200, { thread: t }) : j(500, { error: 'could not create thread' });
        }
        if (rest === 'edit' && req.method === 'POST') {
          const body = await safeJson(req);
          const start = Number(body?.start);
          const end = Number(body?.end);
          const replacement = String(body?.replacement ?? '');
          if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return j(400, { error: 'start/end required' });
          }
          const res = rooms.pushEdit(docId, start, end, replacement);
          return res.ok ? j(200, { ok: true, content: res.content }) : j(400, { error: 'edit failed' });
        }
        if (rest === 'hooks/fire' && req.method === 'POST') {
          // debug-fires the last thread update again
          const ts = rooms.listThreads(docId);
          if (ts.length === 0) return j(404, { error: 'no threads' });
          const last = ts[ts.length - 1]!;
          if (room.webhookUrl) {
            await webhooks.send(room.webhookUrl, {
              event: 'thread.replied',
              docId,
              threadId: last.id,
              thread: last,
              doc: room.meta,
              seq: ++room.seq,
            });
          }
          return j(200, { fired: !!room.webhookUrl });
        }
      }

      // --- Web log ---
      if (pathname === '/api/webhooks/log') {
        return j(200, { log: webhookLog.slice(-100) });
      }

      // --- Static: widget ---
      if (widgetDist && pathname.startsWith('/widget/')) {
        const p = join(widgetDist, pathname.slice('/widget/'.length));
        const resp = serveStatic(p);
        if (resp) return resp;
      }
      if (widgetDist && (pathname === '/widget.js' || pathname === '/widget.iife.js' || pathname === '/widget.esm.js')) {
        const map: Record<string, string> = {
          '/widget.js': 'widget.esm.js',
          '/widget.esm.js': 'widget.esm.js',
          '/widget.iife.js': 'widget.iife.js',
        };
        const file = map[pathname]!;
        const p = join(widgetDist, file);
        const resp = serveStatic(p);
        if (resp) return resp;
      }

      // --- Markdown app (surface 1) ---
      if (markdownAppDist && pathname.startsWith('/review/')) {
        const docId = decodeURIComponent(pathname.slice('/review/'.length));
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        rooms.getOrCreate(docId, { type: 'markdown' });
        const p = join(markdownAppDist, 'index.html');
        const resp = serveStatic(p);
        if (resp) return resp;
      }
      if (markdownAppDist && pathname.startsWith('/app/')) {
        const p = join(markdownAppDist, pathname.slice('/app/'.length));
        const resp = serveStatic(p);
        if (resp) return resp;
      }

      // --- Demos ---
      if (demosDir && pathname.startsWith('/demos/')) {
        let p = join(demosDir, pathname.slice('/demos/'.length));
        if (!extname(p)) p = join(p, 'index.html');
        const resp = serveStatic(p);
        if (resp) return resp;
      }

      // --- Landing ---
      if (pathname === '/') {
        return new Response(renderLanding(rooms.list()), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        const typed = ws as unknown as FeedbackWs;
        const room = rooms.get(typed.data.docId);
        if (!room) {
          ws.close(1008, 'no room');
          return;
        }
        onOpen(room, typed);
      },
      message(ws, message) {
        const typed = ws as unknown as FeedbackWs;
        const room = rooms.get(typed.data.docId);
        if (!room) return;
        let data: Uint8Array;
        if (typeof message === 'string') {
          data = new TextEncoder().encode(message);
        } else {
          // Bun's Buffer extends Uint8Array; copy to plain Uint8Array for y-protocols
          const buf = message as unknown as ArrayBufferView;
          data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        onMessage(room, typed, data);
      },
      close(ws) {
        onClose(ws as unknown as FeedbackWs);
      },
    },
  });

  return {
    port: server.port ?? port,
    rooms,
    webhookLog,
    stop: async () => {
      server.stop();
    },
  };
}

function isValidDocId(s: string): boolean {
  return /^[a-zA-Z0-9_.:\-]{1,100}$/.test(s);
}

function j(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function serveStatic(p: string): Response | null {
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  const ct = CT[extname(p).toLowerCase()] ?? 'application/octet-stream';
  return new Response(buf, { headers: { 'content-type': ct, 'cache-control': 'no-cache' } });
}

function renderLanding(docs: { docId: string; type: string; title?: string }[]): string {
  const rows = docs
    .map(
      (d) =>
        `<li><a href="/review/${encodeURIComponent(d.docId)}">${escape(d.title ?? d.docId)}</a> <small>${d.type}</small></li>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>Live Feedback</title>
<style>body{font:14px/1.4 system-ui, sans-serif;margin:40px auto;max-width:640px;color:#222}
h1{font-size:20px}a{color:#2e7dd7}ul{padding:0;list-style:none}li{padding:6px 0;border-bottom:1px solid #eee}
small{color:#999;margin-left:8px}</style>
<h1>Live Feedback</h1>
<p>Open docs to review:</p>
<ul>${rows || '<li><em>none yet — POST /api/docs to create one</em></li>'}</ul>
<p><small>API: POST /api/docs &middot; widget: /widget.iife.js &middot; demo: /demos/mockup</small></p>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c] ?? c;
  });
}
