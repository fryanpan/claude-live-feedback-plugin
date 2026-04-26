import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Anchor, DocType, User } from '@feedback/core';
import { publicBaseUrl } from './public-host.ts';
import { type FeedbackWs, Rooms, type RoomsConfig } from './rooms.ts';
import { SseHub, openSseStream } from './sse.ts';
import { type WebhookLogEntry, createWebhookDispatcher } from './webhooks.ts';
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
  // Lazy ref so `withReviewUrl` (defined after Bun.serve) can be reused
  // for SSE/webhook payloads via the Rooms decorator.
  let decorateDocMeta: RoomsConfig['decorateDocMeta'];
  const rooms = new Rooms({
    dataDir,
    sse,
    webhooks,
    decorateDocMeta: (m) => decorateDocMeta?.(m) ?? m,
  });

  const server = Bun.serve<{ docId: string }>({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      // --- WebSocket upgrade ---
      if (pathname.startsWith('/y/')) {
        const docId = decodeURIComponent(pathname.slice(3));
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        const type = url.searchParams.get('type') as DocType | null;
        const sourceUrl = url.searchParams.get('sourceUrl') ?? undefined;
        rooms.getOrCreate(docId, {
          type: type && ['markdown', 'mockup', 'dev'].includes(type) ? type : undefined,
          sourceUrl,
        });
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
        return j(200, { docId: room.docId, meta: withReviewUrl(room.meta) });
      }
      if (pathname === '/api/docs' && req.method === 'GET') {
        return j(200, { docs: rooms.list().map(withReviewUrl) });
      }
      const docMatch = pathname.match(/^\/api\/docs\/([^/]+)(?:\/(.*))?$/);
      if (docMatch) {
        const docId = decodeURIComponent(docMatch[1] ?? '');
        const rest = docMatch[2] ?? '';
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        // Auto-create ONLY for thread creation — the single path a widget/
        // integration hits before anything else exists. Replies, edits,
        // resolves etc. need a real prior doc; making them auto-create
        // turns this endpoint into a trivial open-write target behind any
        // tunnel. Thread creation itself is gated by the existence of a
        // valid anchor further down.
        const isThreadCreate = rest === 'threads' && req.method === 'POST';
        const room = isThreadCreate ? rooms.getOrCreate(docId) : rooms.get(docId);
        if (!room) return j(404, { error: 'doc not found' });
        if (rest === '' && req.method === 'GET') {
          return j(200, { meta: withReviewUrl(room.meta) });
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
          if (threadRest === '/rewrite_region' && req.method === 'POST') {
            const body = await safeJson(req);
            const replacement = String(body?.replacement ?? '');
            const res = rooms.rewriteThreadRegion(docId, threadId, replacement);
            return res.ok ? j(200, res) : j(409, res);
          }
          if (threadRest === '/insert_after' && req.method === 'POST') {
            const body = await safeJson(req);
            const text = String(body?.text ?? '');
            const res = rooms.insertAfterThread(docId, threadId, text);
            return res.ok ? j(200, res) : j(409, res);
          }
          if (threadRest === '/insert_blocks_after' && req.method === 'POST') {
            const body = await safeJson(req);
            const markdown = String(body?.markdown ?? '');
            const res = rooms.insertBlocksAfterThread(docId, threadId, markdown);
            return res.ok ? j(200, res) : j(409, res);
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
        if (rest === 'content' && req.method === 'GET') {
          const doc = rooms.getDoc(docId);
          if (!doc) return j(404, { error: 'doc not found' });
          return j(200, doc);
        }
        if (rest === 'seed' && req.method === 'POST') {
          const body = await safeJson(req);
          const markdown = String(body?.markdown ?? '');
          if (markdown.length === 0) return j(400, { error: 'markdown is required' });
          const res = rooms.seedDoc(docId, markdown);
          return res.ok ? j(200, res) : j(409, res);
        }
        if (rest === 'attach_file' && req.method === 'POST') {
          const body = await safeJson(req);
          const path = String(body?.path ?? '');
          const res = rooms.attachFile(docId, path);
          return res.ok ? j(200, res) : j(409, res);
        }
        if (rest === 'reparse_from_disk' && req.method === 'POST') {
          const res = rooms.reparseFromDisk(docId);
          return res.ok ? j(200, res) : j(409, res);
        }
        if (rest === 'agent_anchors' && req.method === 'POST') {
          const body = await safeJson(req);
          const find = String(body?.find ?? '');
          if (find.length === 0) return j(400, { error: 'find is required' });
          const res = rooms.createAgentAnchor(docId, {
            find,
            contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
            contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
            occurrence: typeof body?.occurrence === 'number' ? body.occurrence : undefined,
            label: body?.label ? String(body.label) : undefined,
          });
          return res.ok ? j(200, res) : j(409, res);
        }
        const anchorMatch = rest.match(/^agent_anchors\/([^/]+)(\/.*)?$/);
        if (anchorMatch) {
          const anchorId = decodeURIComponent(anchorMatch[1] ?? '');
          const anchorRest = anchorMatch[2] ?? '';
          if (anchorRest === '/edit' && req.method === 'POST') {
            const body = await safeJson(req);
            const kind = body?.kind as 'replace' | 'insert_after' | undefined;
            const text = String(body?.text ?? '');
            if (kind !== 'replace' && kind !== 'insert_after') {
              return j(400, { error: 'kind must be replace or insert_after' });
            }
            const res = rooms.editAtAgentAnchor(docId, anchorId, { kind, text });
            return res.ok ? j(200, res) : j(409, res);
          }
          if (anchorRest === '' && req.method === 'DELETE') {
            const removed = rooms.deleteAgentAnchor(docId, anchorId);
            return removed ? j(200, { ok: true }) : j(404, { error: 'anchor not found' });
          }
        }
        if (rest === 'find_and_replace' && req.method === 'POST') {
          const body = await safeJson(req);
          const find = String(body?.find ?? '');
          const replace = String(body?.replace ?? '');
          if (find.length === 0) return j(400, { error: 'find is required' });
          const res = rooms.findAndReplace(docId, {
            find,
            replace,
            contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
            contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
            occurrence: typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
          });
          return res.ok ? j(200, res) : j(409, res);
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
              doc: withReviewUrl(room.meta),
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
      if (
        widgetDist &&
        (pathname === '/widget.js' ||
          pathname === '/widget.iife.js' ||
          pathname === '/widget.esm.js')
      ) {
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
        // Device-frame simulation: when ?mobile=<preset> is on the URL,
        // return an HTML shell that hosts the real page in an iframe sized
        // to the preset's viewport. Media queries inside the iframe see
        // the small width correctly.
        const mobilePreset = url.searchParams.get('mobile');
        if (mobilePreset) {
          return new Response(renderDeviceFrame(mobilePreset, url), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
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

  // Decorate doc metadata with a `reviewUrl` that's actually reachable from
  // other devices on the tailnet / LAN. Markdown docs render at /review/...;
  // mockup and dev surfaces are hosted by their own integrations, so we
  // don't fabricate a URL for those.
  function withReviewUrl<T extends { docId: string; type: string }>(
    meta: T,
  ): T & { reviewUrl?: string } {
    if (meta.type !== 'markdown') return meta;
    const base = publicBaseUrl(server.port ?? port);
    return { ...meta, reviewUrl: `${base}/review/${encodeURIComponent(meta.docId)}` };
  }
  decorateDocMeta = withReviewUrl;

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
  // Allow a reasonable set of URL-safe chars. Disallow leading dot so IDs
  // can't masquerade as hidden files on disk. Length cap protects the
  // filename from being pathological.
  if (!s || s.startsWith('.')) return false;
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

// Viewport presets for ?mobile=<preset>. CSS px sizes (logical).
const DEVICE_PRESETS: Record<string, { w: number; h: number; label: string }> = {
  iphone16pm: { w: 440, h: 956, label: 'iPhone 16 Pro Max' },
  iphone16: { w: 393, h: 852, label: 'iPhone 16' },
  iphone15: { w: 393, h: 852, label: 'iPhone 15' },
  iphonese: { w: 375, h: 667, label: 'iPhone SE' },
  pixel8: { w: 412, h: 915, label: 'Pixel 8' },
};

function renderDeviceFrame(presetName: string, url: URL): string {
  const preset = DEVICE_PRESETS[presetName] ?? DEVICE_PRESETS.iphone16pm!;
  // Build the inner URL with the mobile param stripped to avoid recursion
  const innerParams = new URLSearchParams(url.searchParams);
  innerParams.delete('mobile');
  const innerQs = innerParams.toString();
  const innerUrl = `${url.pathname}${innerQs ? `?${innerQs}` : ''}`;
  const asParam = url.searchParams.get('as') ?? 'bryan';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${escape(preset.label)} · ${escape(url.pathname)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1e2228; font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #eee; }
  body { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 8px; box-sizing: border-box; overflow: auto; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #cfd3d9; }
  .bar .label { background: rgba(0,0,0,0.5); padding: 3px 9px; border-radius: 99px; }
  .bar a { color: #8fbfff; text-decoration: none; background: rgba(0,0,0,0.5); padding: 3px 9px; border-radius: 99px; }
  .bar a:hover { background: rgba(0,0,0,0.75); }
  .bar a.current { background: #8fbfff; color: #1e2228; }
  .device {
    width: ${preset.w}px;
    height: ${preset.h}px;
    background: #fff;
    border: 1px solid #3a3e45;
    border-radius: 18px;
    box-shadow: 0 14px 40px rgba(0,0,0,0.45);
    overflow: hidden;
    flex: 0 0 auto;
  }
  .device iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    background: #fff;
  }
</style>
</head><body>
<div class="bar">
  <span class="label">${escape(preset.label)} · ${preset.w}×${preset.h}</span>
  <a href="?as=${escape(asParam)}">← exit</a>
  <a class="${presetName === 'iphone16pm' ? 'current' : ''}" href="?mobile=iphone16pm&as=${escape(asParam)}">16 Pro Max</a>
  <a class="${presetName === 'iphone16' ? 'current' : ''}" href="?mobile=iphone16&as=${escape(asParam)}">16</a>
  <a class="${presetName === 'iphonese' ? 'current' : ''}" href="?mobile=iphonese&as=${escape(asParam)}">SE</a>
  <a class="${presetName === 'pixel8' ? 'current' : ''}" href="?mobile=pixel8&as=${escape(asParam)}">Pixel 8</a>
</div>
<div class="device"><iframe src="${escape(innerUrl)}" allow="clipboard-write"></iframe></div>
</body></html>`;
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
