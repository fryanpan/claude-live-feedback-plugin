import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Anchor, DocType, User } from '@feedback/core';
import { type CfAccessOptions, createCfAccessVerifier } from './middleware/cf-access.ts';
import { publicBaseUrl } from './public-host.ts';
import { type FeedbackWs, Rooms, type WorkspaceDirNode, type WorkspaceFileNode } from './rooms.ts';
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
        if ((type === 'markdown' || type === 'code') && !sourceUrl) {
          return j(400, {
            error: 'sourceUrl required',
            hint: 'Markdown and code review docs are backed by a file on disk. Pass sourceUrl: "/abs/path/to/file" in the POST body.',
          });
        }
        const room = rooms.getOrCreate(docId, {
          type,
          sourceUrl,
          title: body?.title as string | undefined,
          setId: body?.setId as string | undefined,
          webhookUrl: body?.webhookUrl as string | undefined,
          owner: body?.owner as string | undefined,
          workspaceId: body?.workspaceId as string | undefined,
          relPath: body?.relPath as string | undefined,
          workspaceRoot: body?.workspaceRoot as string | undefined,
          producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
        });
        let attached: ReturnType<typeof rooms.attachFile> | undefined;
        if (type === 'markdown' && sourceUrl) {
          attached = rooms.attachFile(docId, sourceUrl);
          if (!attached.ok) return j(409, { error: 'attach_failed', attached });
        } else if (type === 'code' && sourceUrl) {
          attached = rooms.attachReadonlyFile(docId, sourceUrl);
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

      // --- REST: workspaces (folder bind) ---
      if (pathname === '/api/workspaces' && req.method === 'POST') {
        const body = await safeJson(req);
        const folderPath = body?.folderPath as string | undefined;
        if (!folderPath || typeof folderPath !== 'string') {
          return j(400, { error: 'folderPath required' });
        }
        const res = rooms.bindFolder({
          folderPath,
          workspaceId: body?.workspaceId as string | undefined,
          title: body?.title as string | undefined,
          include: Array.isArray(body?.include) ? (body.include as string[]) : undefined,
          maxFiles: typeof body?.maxFiles === 'number' ? Number(body.maxFiles) : undefined,
          owner: body?.owner as string | undefined,
          producedBy: body?.producedBy as { agentId?: string; sessionId?: string } | undefined,
        });
        if (!res.ok) {
          // not-found → 404; too-many-files → 409 (guardrail, caller must
          // narrow the folder or raise maxFiles).
          return j(res.error === 'not-found' ? 404 : 409, res);
        }
        return j(200, {
          ...res,
          files: res.files.map((f) => ({
            ...f,
            reviewUrl: withReviewUrl({ docId: f.docId, type: f.type }).reviewUrl,
          })),
        });
      }
      // List bound workspaces with rolled-up triage signals (fileCount,
      // openThreads, allIdle, owner, lastActivityAt). The daily triage uses
      // this to treat a folder bind as one cleanup unit.
      if (pathname === '/api/workspaces' && req.method === 'GET') {
        return j(200, { workspaces: rooms.listWorkspaces() });
      }
      // Delete a whole workspace as one unit (all-or-nothing open-thread
      // guardrail; ?force=true to override). Member SOURCE files are left
      // untouched, same as DELETE /api/docs/:id.
      const wsDeleteMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (wsDeleteMatch && req.method === 'DELETE') {
        const workspaceId = decodeURIComponent(wsDeleteMatch[1] ?? '');
        const force = url.searchParams.get('force') === 'true';
        const res = rooms.deleteWorkspace(workspaceId, { force });
        if (res.ok) return j(200, res);
        return j(res.error === 'has-open-threads' ? 409 : 404, res);
      }
      // File-tree view for a bound workspace: nested directory tree with
      // per-file unresolved-comment counts + folder roll-ups. Files are
      // decorated with reviewUrl by the rooms decorator (withReviewUrl).
      const wsTreeMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
      if (wsTreeMatch && req.method === 'GET') {
        const workspaceId = decodeURIComponent(wsTreeMatch[1] ?? '');
        const tree = rooms.buildWorkspaceTree(workspaceId);
        if (tree.tree.children.length === 0) {
          return j(404, { error: 'workspace not found', workspaceId });
        }
        return j(200, tree);
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
        if (rest === '' && req.method === 'DELETE') {
          const force = url.searchParams.get('force') === 'true';
          const res = rooms.deleteDoc(docId, { force });
          if (res.ok) return j(200, res);
          return j(res.error === 'has-open-threads' ? 409 : 404, res);
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
            const body = await safeJson(req);
            const author = body?.author as User | undefined;
            const t = rooms.resolve(docId, threadId, author);
            return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
          }
          if (threadRest === '/reopen' && req.method === 'POST') {
            const body = await safeJson(req);
            const author = body?.author as User | undefined;
            const t = rooms.reopen(docId, threadId, author);
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
            const parseInlineMarks = body?.parseInlineMarks === true;
            const res = rooms.rewriteThreadRegion(docId, threadId, replacement, {
              parseInlineMarks,
            });
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
        if (rest === 'threads/by_find' && req.method === 'POST') {
          const body = await safeJson(req);
          const author = body?.author as User | undefined;
          const text = body?.text as string | undefined;
          const find = body?.find ? String(body.find) : '';
          if (!author || !text || find.length === 0) {
            return j(400, { error: 'author + text + find required' });
          }
          const res = await rooms.createThreadByFind(
            docId,
            {
              find,
              contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
              contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
              occurrence:
                typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
            },
            author,
            text,
          );
          return res.ok ? j(200, { thread: res.thread }) : j(409, res);
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
        // Browser-originated reading activity (read_session / doc_open). The
        // markdown/code review surfaces POST interaction-bounded reading
        // sessions here; the server resolves doc/repo/producedBy and stamps
        // actor=person. Unknown types are ignored (400). See activity.ts.
        if (rest === 'activity' && req.method === 'POST') {
          const body = await safeJson(req);
          const type = body?.type as 'read_session' | 'doc_open' | undefined;
          if (type !== 'read_session' && type !== 'doc_open') {
            return j(400, { error: 'type must be read_session or doc_open' });
          }
          const payload = (body?.payload as Record<string, unknown> | undefined) ?? {};
          const author = (body?.author as User | undefined) ?? {
            id: 'known-bryan',
            name: 'Bryan',
            kind: 'known' as const,
            color: '#2e7dd7',
          };
          const res = rooms.recordReadEvent(docId, type, payload, author);
          return res.ok ? j(200, { ok: true }) : j(404, res);
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
            parseInlineMarks: body?.parseInlineMarks === true,
          });
          return res.ok ? j(200, res) : j(409, res);
        }
        if (rest === 'delete_block_at_anchor' && req.method === 'POST') {
          const body = await safeJson(req);
          const threadId = body?.threadId ? String(body.threadId) : undefined;
          const anchorId = body?.anchorId ? String(body.anchorId) : undefined;
          if ((threadId && anchorId) || (!threadId && !anchorId)) {
            return j(400, { error: 'exactly one of threadId or anchorId required' });
          }
          const res = threadId
            ? rooms.deleteBlockAtThread(docId, threadId)
            : rooms.deleteBlockAtAgentAnchor(docId, anchorId!);
          return res.ok ? j(200, res) : j(409, res);
        }
        if (rest === 'delete_blocks_in_range' && req.method === 'POST') {
          const body = await safeJson(req);
          const startFind = String(body?.startFind ?? '');
          const endFind = String(body?.endFind ?? '');
          if (startFind.length === 0 || endFind.length === 0) {
            return j(400, { error: 'startFind and endFind are required' });
          }
          const res = rooms.deleteBlocksInRange(docId, {
            startFind,
            endFind,
            contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
            contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
            startOccurrence:
              typeof body?.startOccurrence === 'number' ? Number(body.startOccurrence) : undefined,
            endOccurrence:
              typeof body?.endOccurrence === 'number' ? Number(body.endOccurrence) : undefined,
          });
          return res.ok ? j(200, res) : j(409, res);
        }
        if (rest === 'delete_section' && req.method === 'POST') {
          const body = await safeJson(req);
          const heading = String(body?.heading ?? '');
          if (heading.length === 0) return j(400, { error: 'heading is required' });
          const res = rooms.deleteSection(docId, {
            heading,
            level: typeof body?.level === 'number' ? Number(body.level) : undefined,
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

      // --- Mockup HTML — bound to a docId via bind_mock / POST /api/docs
      //     with type='mockup'. Reads the file at the room's sourceUrl
      //     (any absolute path on disk) and streams it as text/html. The
      //     pre-bind_mock workflow required symlinking each new HTML
      //     into <plugin-repo>/demos/ — `/mockup/<docId>` replaces that
      //     dance and matches the contract of `/review/<docId>` for
      //     markdown docs: one MCP call, one URL, no filesystem juggling.
      //     Single-file mockups only — assets the HTML references via
      //     relative paths won't resolve since we don't serve the source
      //     directory. Use the existing /demos/ multi-page path for
      //     mockups that ship with sibling files.
      if (pathname.startsWith('/mockup/')) {
        const slug = decodeURIComponent(pathname.slice('/mockup/'.length));
        // Tolerate `/mockup/<docId>.html` AND `/mockup/<docId>` — agents
        // share whichever URL feels natural.
        const docId = slug.replace(/\.html?$/i, '');
        if (!isValidDocId(docId)) return j(400, { error: 'bad docId' });
        const room = rooms.get(docId);
        if (!room || room.meta.type !== 'mockup' || !room.meta.sourceUrl) {
          return new Response(renderMockupNotFound(docId), {
            status: 404,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        }
        const resp = serveStatic(room.meta.sourceUrl);
        if (resp) return resp;
        return new Response(renderMockupNotFound(docId), {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
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
        return new Response(renderLanding(buildLandingModel(rooms, withReviewUrl)), {
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
  // mockup docs bound to a file on disk render at /mockup/<docId> — same
  // one-call-one-URL contract as markdown. Mockup docs without a sourceUrl
  // (e.g. dev-server surfaces hosted elsewhere) get no URL — there's nothing
  // for us to serve.
  function withReviewUrl<T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ): T & { reviewUrl?: string } {
    const base = publicBaseUrl(server.port ?? port);
    if (meta.type === 'markdown' || meta.type === 'code') {
      // Code review shares the same SPA route; the app branches the editor
      // on the doc's type at boot.
      return { ...meta, reviewUrl: `${base}/review/${encodeURIComponent(meta.docId)}` };
    }
    if (meta.type === 'mockup' && meta.sourceUrl) {
      return { ...meta, reviewUrl: `${base}/mockup/${encodeURIComponent(meta.docId)}` };
    }
    return meta;
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
  // filename from being pathological. `~` is permitted because workspace
  // member docIds encode the relPath's `/` separators as `~`
  // (`${workspaceId}:${relPath.replaceAll('/', '~')}` in rooms.ts), so any
  // file in a subdirectory of a bound folder needs `~` to be reachable via
  // the /api/docs/:docId routes. `~` is RFC 3986 unreserved (URL-safe) and a
  // valid filename char, matching the .ydoc-on-disk naming.
  if (!s || s.startsWith('.')) return false;
  return /^[a-zA-Z0-9_.:~\-]{1,100}$/.test(s);
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

function renderMockupNotFound(docId: string): string {
  const safe = escape(docId);
  return `<!doctype html><meta charset="utf-8"><title>Mockup not found · Live Feedback</title>
<style>body{font:15px/1.55 system-ui, sans-serif;margin:60px auto;max-width:560px;color:#222;padding:0 20px}
h1{font-size:22px}code{background:#f3f3f3;padding:1px 5px;border-radius:3px;font-size:90%}
small{color:#777}</style>
<h1>Mockup not found</h1>
<p>No mockup is bound to <code>${safe}</code>, or its source file isn't readable.
Mockups are bound by an agent calling <code>bind_mock</code> with an absolute path
to an HTML file. Once bound, the file is served here without any symlink dance.</p>
<p>Ask the agent who shared this URL to call <code>bind_mock(docId, sourceHtmlPath)</code>, then refresh.</p>`;
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

// --- Landing page: project → artifacts model ---
//
// The landing page answers "what does this project have under review, and what
// needs my attention?". It groups by PROJECT (the creating agent's cwd =
// doc.owner; 'ungrouped' when absent), and within a project lists ARTIFACTS.
// An artifact is one of:
//   - a workspace (bound folder/worktree; docs sharing a workspaceId) →
//     one expandable row with a rolled-up open-count badge and a nested file
//     list, each file linking to its reviewUrl
//   - a single markdown file, a code file, a mockup, or a dev server
// Each artifact carries its open-comment count and a kind glyph/label.

type ArtifactKind = 'workspace' | 'markdown' | 'code' | 'mockup' | 'dev';

interface LandingFile {
  name: string;
  reviewUrl?: string;
  openCount: number;
}

interface LandingArtifact {
  kind: ArtifactKind;
  /** Display name (file basename, workspace title, or docId fallback). */
  name: string;
  /** docId for standalone artifacts; workspaceId for workspaces. */
  id: string;
  reviewUrl?: string;
  openCount: number;
  threadCount: number;
  lastActivity: number;
  /** Nested file list (workspace artifacts only). */
  files?: LandingFile[];
}

interface LandingProject {
  /** Project key = creating agent's cwd, or 'ungrouped'. */
  owner: string;
  totalOpen: number;
  artifacts: LandingArtifact[];
}

interface LandingModel {
  projects: LandingProject[];
  totalArtifacts: number;
  totalOpen: number;
}

// Glyph + human label per artifact kind. The glyph keeps the kinds visually
// distinct at a glance; the label disambiguates for screen readers / clarity.
const ARTIFACT_KIND: Record<ArtifactKind, { glyph: string; label: string }> = {
  workspace: { glyph: '📁', label: 'folder' },
  markdown: { glyph: '📄', label: 'markdown' },
  code: { glyph: '⟨⟩', label: 'code' },
  mockup: { glyph: '🖼', label: 'mockup' },
  dev: { glyph: '⚡', label: 'dev server' },
};

/** Flatten a workspace tree into a sorted file list for the landing nesting. */
function flattenWorkspaceFiles(node: WorkspaceDirNode | WorkspaceFileNode): LandingFile[] {
  if (node.type === 'file') {
    return [{ name: node.relPath, reviewUrl: node.reviewUrl, openCount: node.openCount }];
  }
  return node.children.flatMap(flattenWorkspaceFiles);
}

/**
 * Build the project → artifacts model from the live rooms. Pure data shaping —
 * all HTML lives in `renderLanding`. Exported-shape via the route only.
 */
function buildLandingModel(
  rooms: Rooms,
  decorate: <T extends { docId: string; type: DocType; sourceUrl?: string }>(
    meta: T,
  ) => T & { reviewUrl?: string },
): LandingModel {
  // workspaceId → accumulating workspace artifact (filled from buildWorkspaceTree).
  const workspaceArtifacts = new Map<string, LandingArtifact>();
  // owner → its standalone + workspace artifacts.
  const projects = new Map<string, LandingProject>();

  const ensureProject = (owner: string): LandingProject => {
    let p = projects.get(owner);
    if (!p) {
      p = { owner, totalOpen: 0, artifacts: [] };
      projects.set(owner, p);
    }
    return p;
  };

  for (const meta of rooms.list()) {
    const threads = rooms.listThreads(meta.docId);
    const openCount = threads.filter((t) => t.status === 'open').length;
    const lastActivity = Math.max(
      meta.lastActivityAt ?? 0,
      threads.reduce((max, t) => Math.max(max, t.lastActivity), 0),
    );
    const owner = meta.owner || 'ungrouped';

    if (meta.workspaceId) {
      // Workspace member — fold into (or create) the workspace artifact. The
      // per-file detail comes from buildWorkspaceTree; here we just track the
      // owner/lastActivity rollup and ensure the artifact is registered.
      let art = workspaceArtifacts.get(meta.workspaceId);
      if (!art) {
        const tree = rooms.buildWorkspaceTree(meta.workspaceId);
        const files = flattenWorkspaceFiles(tree.tree);
        art = {
          kind: 'workspace',
          name: meta.workspaceId,
          id: meta.workspaceId,
          openCount: tree.totalOpen,
          threadCount: 0,
          lastActivity: 0,
          files,
        };
        workspaceArtifacts.set(meta.workspaceId, art);
        ensureProject(owner).artifacts.push(art);
      }
      art.threadCount += threads.length;
      if (lastActivity > art.lastActivity) art.lastActivity = lastActivity;
      continue;
    }

    // Standalone artifact (single file / mockup / dev).
    const decorated = decorate(meta);
    const kind = (meta.type as ArtifactKind) ?? 'markdown';
    const name = meta.sourceUrl ? basenameOf(meta.sourceUrl) : meta.title || meta.docId;
    ensureProject(owner).artifacts.push({
      kind,
      name,
      id: meta.docId,
      reviewUrl: decorated.reviewUrl,
      openCount,
      threadCount: threads.length,
      lastActivity,
    });
  }

  // Sort artifacts within each project, then projects by total open desc.
  const projectList = Array.from(projects.values());
  for (const p of projectList) {
    p.totalOpen = p.artifacts.reduce((sum, a) => sum + a.openCount, 0);
    p.artifacts.sort((a, b) => {
      if (a.openCount !== b.openCount) return b.openCount - a.openCount;
      if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
      return a.name.localeCompare(b.name);
    });
  }
  projectList.sort((a, b) => {
    if (a.totalOpen !== b.totalOpen) return b.totalOpen - a.totalOpen;
    return a.owner.localeCompare(b.owner);
  });

  const totalArtifacts = projectList.reduce((sum, p) => sum + p.artifacts.length, 0);
  const totalOpen = projectList.reduce((sum, p) => sum + p.totalOpen, 0);
  return { projects: projectList, totalArtifacts, totalOpen };
}

function basenameOf(p: string): string {
  let s = p;
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {}
  const m = s.match(/[^/\\]+$/);
  return m ? m[0] : s;
}

/** Display label for a project owner (cwd) — its basename, or the raw key. */
function projectLabel(owner: string): string {
  if (owner === 'ungrouped') return 'Ungrouped';
  return basenameOf(owner) || owner;
}

function renderLandingFile(f: LandingFile): string {
  const link = f.reviewUrl
    ? `<a href="${escape(f.reviewUrl)}">${escape(f.name)}</a>`
    : escape(f.name);
  const badge = f.openCount > 0 ? `<span class="badge badge-open">${f.openCount} open</span>` : '';
  return `<li class="ws-file"><span class="ws-file-name">${link}</span>${badge}</li>`;
}

function renderLandingArtifact(a: LandingArtifact): string {
  const kind = ARTIFACT_KIND[a.kind];
  const openBadge =
    a.openCount > 0
      ? `<span class="badge badge-open">${a.openCount} open</span>`
      : a.threadCount > 0
        ? `<span class="badge badge-resolved">all resolved</span>`
        : '';
  const kindBadge = `<span class="badge badge-kind">${kind.glyph} ${escape(kind.label)}</span>`;
  const activityLine =
    a.lastActivity > 0
      ? `<div class="meta">last activity ${escape(formatRelative(a.lastActivity))}</div>`
      : '';

  if (a.kind === 'workspace') {
    const fileCount = a.files?.length ?? 0;
    const files = (a.files ?? []).map(renderLandingFile).join('');
    // Native <details> so folder expansion needs no JS.
    return `<li class="artifact ${a.openCount > 0 ? 'has-open' : ''}">
      <details>
        <summary>
          <span class="art-glyph">${kind.glyph}</span>
          <span class="art-name">${escape(a.name)}</span>
          <span class="art-sub">${fileCount} file${fileCount === 1 ? '' : 's'}</span>
          <span class="badges">${openBadge}<span class="badge badge-kind">${escape(kind.label)}</span></span>
        </summary>
        <ul class="ws-files">${files || '<li class="ws-file empty">(no files)</li>'}</ul>
      </details>
      ${activityLine}
    </li>`;
  }

  const link = a.reviewUrl
    ? `<a href="${escape(a.reviewUrl)}">${escape(a.name)}</a>`
    : escape(a.name);
  return `<li class="artifact ${a.openCount > 0 ? 'has-open' : ''}">
    <div class="row">
      <span class="art-glyph">${kind.glyph}</span>
      <span class="art-name">${link}</span>
      <span class="badges">${openBadge}${kindBadge}</span>
    </div>
    ${activityLine}
  </li>`;
}

function renderLanding(model: LandingModel): string {
  const projectsHtml = model.projects
    .map((p) => {
      const openBadge =
        p.totalOpen > 0 ? `<span class="badge badge-open">${p.totalOpen} open</span>` : '';
      const arts = p.artifacts.map(renderLandingArtifact).join('');
      return `<section class="project">
        <h2 class="project-head">${escape(projectLabel(p.owner))}${openBadge}</h2>
        <ul class="artifacts">${arts}</ul>
      </section>`;
    })
    .join('');
  const summary =
    model.totalArtifacts === 0
      ? ''
      : `${model.totalArtifacts} artifact${model.totalArtifacts === 1 ? '' : 's'} · ${model.totalOpen} open thread${model.totalOpen === 1 ? '' : 's'}`;
  return `<!doctype html><meta charset="utf-8"><title>Live Feedback</title>
<style>
body{font:14px/1.5 system-ui, -apple-system, sans-serif;margin:32px auto;max-width:760px;padding:0 16px;color:#1b1f23}
h1{font-size:22px;margin:0 0 4px}
.summary{color:#6e7781;font-size:12px;margin-bottom:20px}
ul{padding:0;list-style:none;margin:0}
.project{margin-bottom:26px}
.project-head{font-size:13px;font-weight:600;color:#57606a;margin:0 0 8px;display:flex;align-items:center;gap:8px;text-transform:none;border-bottom:1px solid #eef0f2;padding-bottom:6px}
li.artifact{padding:10px 0;border-bottom:1px solid #f3f4f6}
li.artifact.has-open{border-left:3px solid #e36f1e;padding-left:10px;margin-left:-13px}
.row{display:flex;align-items:baseline;gap:8px}
.art-glyph{flex-shrink:0;font-size:13px;width:1.4em;text-align:center}
.art-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.art-name a{color:#2e7dd7;text-decoration:none;font-weight:600;font-size:15px}
.art-name a:hover{text-decoration:underline}
.art-sub{color:#8b95a1;font-size:11px;flex-shrink:0}
.badges{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.badge{font-size:10.5px;padding:1.5px 7px;border-radius:99px;background:#f6f8fa;color:#6e7781;font-weight:500}
.badge-open{background:#fff1e6;color:#bf5b16}
.badge-resolved{background:#e8f5ed;color:#2da44e}
.badge-kind{background:#f6f8fa;color:#8b95a1}
.meta{color:#8b95a1;font-size:11px;margin-top:3px;padding-left:1.4em}
details > summary{display:flex;align-items:baseline;gap:8px;cursor:pointer;list-style:none}
details > summary::-webkit-details-marker{display:none}
details > summary::before{content:'▸';color:#8b95a1;font-size:11px;flex-shrink:0}
details[open] > summary::before{content:'▾'}
.ws-files{margin:6px 0 0 1.8em;border-left:1px solid #eef0f2;padding-left:10px}
.ws-file{display:flex;align-items:baseline;gap:8px;padding:3px 0}
.ws-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.ws-file-name a{color:#2e7dd7;text-decoration:none}
.ws-file-name a:hover{text-decoration:underline}
.ws-file.empty{color:#8b95a1;font-style:italic}
.empty{color:#6e7781;padding:24px 0;text-align:center;font-style:italic}
footer{margin-top:24px;color:#8b95a1;font-size:11px}
</style>
<h1>Live Feedback</h1>
<div class="summary">${summary}</div>
${projectsHtml || '<div class="empty">No docs yet — POST /api/docs to create one.</div>'}
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
