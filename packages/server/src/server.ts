import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Anchor, DocType, User } from '@feedback/core';
import { type CfAccessOptions, createCfAccessVerifier } from './middleware/cf-access.ts';
import { publicBaseUrl } from './public-host.ts';
import { type FeedbackWs, Rooms } from './rooms.ts';
import { CfApi } from './share/cf-api.ts';
import { Shares } from './share/shares.ts';
import type { ShareConfig } from './share/types.ts';
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
  /**
   * Cloudflare Access JWT verification config. When set, every non-OPTIONS
   * request must carry a valid `Cf-Access-Jwt-Assertion` header (or
   * `CF_Authorization` cookie) signed by the team's JWKS and matching the
   * given audience. When unset, the server runs unauthenticated — local
   * dev / Tailscale-only use is unchanged.
   *
   * When `share` is also set, the verifier only gates requests whose
   * Host header matches an active share — Tailscale traffic to the
   * canonical hostname stays unauthenticated.
   */
  cfAccess?: CfAccessOptions;
  /**
   * Cloudflare Access share machinery. When set, the server exposes
   * /api/share routes for creating/listing/revoking shares, instantiates
   * a CfApi client (uses `cfApi` directly if provided, else builds one
   * from `cfApiToken`), and wires the cf-access middleware's audience to
   * the shares registry so each share's hostname gets its own AUD.
   */
  share?: {
    config: ShareConfig;
    cfApiToken?: string;
    cfApi?: CfApi;
  };
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
  shares: Shares | null;
  webhookLog: WebhookLogEntry[];
  stop: () => Promise<void>;
}

export function createServer(opts: ServerOptions = {}): ServerHandle {
  const port = opts.port ?? DEFAULT_PORT;
  const dataDir = opts.dataDir ?? join(process.cwd(), 'data');
  const widgetDist = opts.widgetDistDir ?? null;
  const markdownAppDist = opts.markdownAppDistDir ?? null;
  const demosDir = opts.demosDir ?? null;

  let shares: Shares | null = null;
  if (opts.share) {
    const cfApi =
      opts.share.cfApi ??
      new CfApi({
        accountId: opts.share.config.cfAccountId,
        token: opts.share.cfApiToken ?? '',
      });
    shares = new Shares({
      dataDir,
      cfApi,
      config: opts.share.config,
    });
  }

  // When shares is wired, automatically derive the cf-access audience from
  // the registry so each share-<slug> host can use its own AUD. Callers
  // can still override by passing cfAccess.audience explicitly.
  const cfAccessConfig =
    opts.cfAccess && shares
      ? { ...opts.cfAccess, audience: shares.audienceResolver }
      : opts.cfAccess;
  const cfAccessVerifier = cfAccessConfig ? createCfAccessVerifier(cfAccessConfig) : null;

  const sse = new SseHub();
  const webhookLog: WebhookLogEntry[] = [];
  const webhooks = createWebhookDispatcher({
    onLog: (e) => {
      webhookLog.push(e);
      if (webhookLog.length > 1000) webhookLog.shift();
    },
  });
  // `withReviewUrl` is a hoisted function declaration; it captures
  // `server` lazily and is only invoked during requests / thread events,
  // after Bun.serve has assigned. Same instance is reused for SSE +
  // webhook payloads via the Rooms decorator.
  const rooms = new Rooms({ dataDir, sse, webhooks, decorateDocMeta: withReviewUrl });

  const server = Bun.serve<{ docId: string }>({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      // --- CORS preflight ---
      // The canonical embed loads the widget bundle from this server but
      // runs on a different origin (e.g. an Astro dev server on :4321).
      // Every REST call from the widget is therefore cross-origin and
      // browsers preflight non-simple requests (POST + JSON body) with an
      // OPTIONS. Reply once here so we don't have to thread the response
      // through every route handler.
      if (req.method === 'OPTIONS') {
        return withCors(req, new Response(null, { status: 204 }));
      }

      // --- Cloudflare Access gate ---
      // When cfAccess is configured (server is reachable via a public
      // tunnel), gate the request. Two modes:
      //   - With shares wired: gate ONLY requests whose Host matches an
      //     active share. Tailscale/LAN traffic to the canonical hostname
      //     stays unauthenticated, so the agent's MCP tools can still
      //     hit /api/share over loopback.
      //   - Without shares: gate everything (legacy/test mode).
      if (cfAccessVerifier) {
        const host = req.headers.get('host')?.toLowerCase() ?? '';
        const isShareHost = shares ? shares.findByHostname(host) !== null : false;
        const shouldGate = shares ? isShareHost : true;
        if (shouldGate) {
          const result = await cfAccessVerifier(req);
          if (!result.ok) return j(result.status, { error: result.error });
        }
      }

      // --- REST: shares ---
      if (pathname === '/api/share' && req.method === 'GET') {
        if (!shares) return j(404, { error: 'sharing not enabled' });
        return j(200, { shares: shares.list() });
      }
      if (pathname === '/api/share/doc' && req.method === 'POST') {
        if (!shares) return j(404, { error: 'sharing not enabled' });
        const body = await safeJson(req);
        const docId = (body?.docId as string) ?? '';
        const allowDomains = (body?.allowDomains as string[]) ?? [];
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        if (!rooms.get(docId)) return j(404, { error: 'doc not found' });
        if (!Array.isArray(allowDomains) || allowDomains.length === 0) {
          return j(400, { error: 'allowDomains must be a non-empty array' });
        }
        try {
          const share = await shares.createShareDoc({
            docId,
            allowDomains,
            ttlSeconds: typeof body?.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
            name: typeof body?.name === 'string' ? body.name : undefined,
          });
          return j(200, { share });
        } catch (err) {
          const error = err instanceof Error ? err.message : 'create_share_failed';
          return j(502, { error });
        }
      }
      const shareIdMatch = pathname.match(/^\/api\/share\/([^/]+)$/);
      if (shareIdMatch && req.method === 'DELETE') {
        if (!shares) return j(404, { error: 'sharing not enabled' });
        const shareId = decodeURIComponent(shareIdMatch[1] ?? '');
        try {
          const result = await shares.deleteShare(shareId);
          return result.ok ? j(200, { ok: true }) : j(404, { error: 'share not found' });
        } catch (err) {
          const error = err instanceof Error ? err.message : 'delete_share_failed';
          return j(502, { error });
        }
      }

      // --- WebSocket upgrade ---
      if (pathname.startsWith('/y/')) {
        const docId = decodeURIComponent(pathname.slice(3));
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        const type = url.searchParams.get('type') as DocType | null;
        const sourceUrl = url.searchParams.get('sourceUrl') ?? undefined;
        // Mockup/dev docs auto-create on WS — the widget connects first
        // with a known type + sourceUrl. Markdown docs MUST be created
        // upfront via POST /api/docs (which auto-attaches a file). The
        // browser navigating to /review/<docId> before the agent has
        // created the doc gets a clean 404 from /review's own handler.
        if (!rooms.get(docId)) {
          if (type === 'mockup' || type === 'dev') {
            rooms.getOrCreate(docId, { type, sourceUrl });
          } else {
            return j(404, { error: 'doc not found' });
          }
        }
        const upgraded = server.upgrade(req, { data: { docId } });
        if (!upgraded) return new Response('upgrade required', { status: 426 });
        return undefined;
      }

      // --- SSE ---
      if (pathname.startsWith('/events/')) {
        const docId = decodeURIComponent(pathname.slice('/events/'.length));
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        if (!rooms.get(docId)) return j(404, { error: 'doc not found' });
        return openSseStream(sse, docId);
      }

      // --- REST: docs ---
      if (pathname === '/api/docs' && req.method === 'POST') {
        const body = await safeJson(req);
        const docId = (body?.docId as string) ?? '';
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        const type = (body?.type as DocType) ?? 'markdown';
        const sourceUrl = body?.sourceUrl as string | undefined;
        // Every markdown doc is file-backed. POST /api/docs is the sole
        // creation path for markdown — sourceUrl is required, and the
        // server attaches the file (loads content + sets up bidirectional
        // disk sync) before returning. Mockup/dev docs are about
        // commenting on running surfaces, not about a markdown buffer,
        // so they don't need a file.
        if (type === 'markdown' && !sourceUrl) {
          return j(400, {
            error: 'sourceUrl required',
            hint: 'Markdown review docs are always backed by a .md file. Pass sourceUrl: "/abs/path/to/file.md" in the POST body. The server will load the file and bidirectionally sync edits.',
          });
        }
        const room = rooms.getOrCreate(docId, {
          type,
          sourceUrl,
          title: body?.title as string | undefined,
          setId: body?.setId as string | undefined,
          webhookUrl: body?.webhookUrl as string | undefined,
        });
        let attached: ReturnType<typeof rooms.attachFile> | undefined;
        if (type === 'markdown' && sourceUrl) {
          attached = rooms.attachFile(docId, sourceUrl);
          if (!attached.ok) return j(409, { error: 'attach_failed', attached });
        }
        return j(200, {
          docId: room.docId,
          meta: withReviewUrl(room.meta),
          ...(attached ? { attached } : {}),
        });
      }
      if (pathname === '/api/docs' && req.method === 'GET') {
        return j(200, { docs: rooms.list().map(withReviewUrl) });
      }
      const docMatch = pathname.match(/^\/api\/docs\/([^/]+)(?:\/(.*))?$/);
      if (docMatch) {
        const docId = decodeURIComponent(docMatch[1] ?? '');
        const rest = docMatch[2] ?? '';
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        const room = rooms.get(docId);
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
          if (anchorRest === '/insert_blocks' && req.method === 'POST') {
            const body = await safeJson(req);
            const markdown = String(body?.markdown ?? '');
            if (markdown.length === 0) return j(400, { error: 'markdown is required' });
            const res = rooms.insertBlocksAtAnchor(docId, anchorId, markdown);
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
        // Markdown docs are file-backed and must be created upfront via
        // POST /api/docs with sourceUrl. Navigating here before the
        // agent has done that gets a clean 404 — the markdown app
        // can't render anything useful for a doc that doesn't exist.
        if (!rooms.get(docId)) {
          return new Response(renderReviewNotFound(docId), {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
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
        const summaries = rooms.list().map((m) => {
          const threads = rooms.listThreads(m.docId);
          const open = threads.filter((t) => t.status === 'open').length;
          const lastActivity = threads.reduce((max, t) => Math.max(max, t.lastActivity), 0);
          return { ...m, openCount: open, threadCount: threads.length, lastActivity };
        });
        return new Response(renderLanding(summaries), {
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
  function withReviewUrl<T extends { docId: string; type: DocType }>(
    meta: T,
  ): T & { reviewUrl?: string } {
    if (meta.type !== 'markdown') return meta;
    const base = publicBaseUrl(server.port ?? port);
    return { ...meta, reviewUrl: `${base}/review/${encodeURIComponent(meta.docId)}` };
  }

  return {
    port: server.port ?? port,
    rooms,
    shares,
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
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

// The canonical embed loads the widget bundle from this server but runs the
// host page on a different origin (e.g. an Astro dev server on a different
// port). Every REST call from the widget is therefore cross-origin and needs
// CORS. The widget posts comments without credentials (auth is via the
// request body's `author` field, not cookies), so `*` is safe and avoids
// the per-request-Origin echo dance.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '600',
} as const;

// withCors is still useful for non-j() responses (preflight 204, static
// bundle response when the consumer wants to fetch() it instead of using a
// script tag). Cheap to merge headers — no body copy.
function withCors(_req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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

function renderReviewNotFound(docId: string): string {
  const safe = escape(docId);
  return `<!doctype html><meta charset="utf-8"><title>Doc not found · Live Feedback</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Doc not found</h1>
<p>No review doc exists for <code>${safe}</code>. Markdown review docs are
created by an agent calling <code>POST /api/docs</code> with a
<code>sourceUrl</code> pointing at a markdown file on disk.</p>
<p>Ask the agent who shared this URL to create the doc, then refresh this page.</p>
<p><small><a href="/">all docs</a></small></p>`;
}

interface LandingDoc {
  docId: string;
  type: string;
  title?: string;
  sourceUrl?: string;
  setId?: string;
  openCount: number;
  threadCount: number;
  lastActivity: number;
  createdAt?: number;
}

function renderLanding(docs: LandingDoc[]): string {
  // Sort by signal: docs with open feedback float to the top, then by most
  // recent activity, then alphabetically. Mirrors how a reviewer scans the
  // list — "what needs my attention?" is the primary question.
  const sorted = [...docs].sort((a, b) => {
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
    return a.docId.localeCompare(b.docId);
  });
  const rows = sorted
    .map((d) => {
      const title = d.title || d.docId;
      const titleHtml = `<a href="/review/${encodeURIComponent(d.docId)}">${escape(title)}</a>`;
      const titleDiffersFromId = title !== d.docId;
      const idSubtitle = titleDiffersFromId ? `<span class="docid">${escape(d.docId)}</span>` : '';
      const openBadge =
        d.openCount > 0
          ? `<span class="badge badge-open">${d.openCount} open</span>`
          : d.threadCount > 0
            ? `<span class="badge badge-resolved">all resolved</span>`
            : '';
      const setBadge = d.setId
        ? `<span class="badge badge-set">set: ${escape(d.setId)}</span>`
        : '';
      const typeBadge = `<span class="badge badge-type">${escape(d.type)}</span>`;
      const sourceLine = d.sourceUrl ? `<div class="src">${escape(d.sourceUrl)}</div>` : '';
      const activityLine =
        d.lastActivity > 0
          ? `<div class="meta">last activity ${escape(formatRelative(d.lastActivity))}</div>`
          : d.createdAt
            ? `<div class="meta">created ${escape(formatRelative(d.createdAt))} · no comments yet</div>`
            : '';
      return `<li class="${d.openCount > 0 ? 'has-open' : ''}">
        <div class="row">
          <div class="title">${titleHtml}</div>
          <div class="badges">${openBadge}${setBadge}${typeBadge}</div>
        </div>
        ${idSubtitle}
        ${sourceLine}
        ${activityLine}
      </li>`;
    })
    .join('');
  const total = docs.length;
  const totalOpen = docs.reduce((sum, d) => sum + d.openCount, 0);
  const summary =
    total === 0
      ? ''
      : `${total} doc${total === 1 ? '' : 's'} · ${totalOpen} open thread${totalOpen === 1 ? '' : 's'}`;
  return `<!doctype html><meta charset="utf-8"><title>Live Feedback</title>
<style>
body{font:14px/1.5 system-ui, -apple-system, sans-serif;margin:32px auto;max-width:760px;padding:0 16px;color:#1b1f23}
h1{font-size:22px;margin:0 0 4px}
.summary{color:#6e7781;font-size:12px;margin-bottom:20px}
ul{padding:0;list-style:none;margin:0}
li{padding:12px 0;border-bottom:1px solid #eef0f2}
li.has-open{border-left:3px solid #e36f1e;padding-left:10px;margin-left:-13px}
.row{display:flex;align-items:baseline;gap:10px}
.title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.title a{color:#2e7dd7;text-decoration:none;font-weight:600;font-size:15px}
.title a:hover{text-decoration:underline}
.badges{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.badge{font-size:10.5px;padding:1.5px 7px;border-radius:99px;background:#f6f8fa;color:#6e7781;font-weight:500}
.badge-open{background:#fff1e6;color:#bf5b16}
.badge-resolved{background:#e8f5ed;color:#2da44e}
.badge-set{background:#ecf3fb;color:#2e7dd7}
.badge-type{background:#f6f8fa;color:#8b95a1;font-variant-numeric:tabular-nums}
.docid{display:block;color:#8b95a1;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:2px}
.src{color:#6e7781;font-size:12px;margin-top:3px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{color:#8b95a1;font-size:11px;margin-top:3px}
.empty{color:#6e7781;padding:24px 0;text-align:center;font-style:italic}
footer{margin-top:24px;color:#8b95a1;font-size:11px}
</style>
<h1>Live Feedback</h1>
<div class="summary">${summary}</div>
<ul>${rows || '<li class="empty">No docs yet — POST /api/docs to create one.</li>'}</ul>
<footer>POST /api/docs · /widget.iife.js · /demos/mockup</footer>`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
