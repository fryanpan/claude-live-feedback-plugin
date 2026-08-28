/**
 * The origin checks, driven through the real route table.
 *
 * browser-origin.test.ts covers the predicate. These exist because the route
 * layer is the part nothing type-checks — a correct predicate wired after a
 * route that already answered would still pass the unit tests. Both holes here
 * were reproduced against the running server first: a cross-origin `fetch`
 * returned the full doc list, and a websocket handshake carrying
 * `Origin: https://evil.example.com` synced a real document's contents.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';

const EVIL = 'https://evil.example.com';
const CANARY = 'CanaryDocBody';

describe('cross-origin access to the trusted host', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let host: string;
  let docPath: string;

  const req = (path: string, origin: string | null, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host,
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cross-origin-'));
    docPath = join(dataDir, 'notes.md');
    writeFileSync(docPath, `# Notes\n\n${CANARY}.\n`);
    handle = createServer({
      port: 0,
      dataDir,
      // trustedHosts feeds BOTH the host gate and the origin policy's notion
      // of "this machine" — a dev server on the tailnet/LAN embeds the widget
      // from one of these names.
      trustedHosts: ['mac-mini.example.ts.net'],
      allowedOrigins: ['https://mockups.example.com'],
    });
    base = `http://localhost:${handle.port}`;
    host = `localhost:${handle.port}`;
    await req('/api/docs', null, {
      method: 'POST',
      body: JSON.stringify({ docId: 'doc-1', type: 'markdown', sourceUrl: docPath }),
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('REST', () => {
    it('does not grant an arbitrary origin permission to read the doc list', async () => {
      const r = await req('/api/docs', EVIL);
      // The server still ANSWERS — it must, since it can't tell a browser from
      // curl, and CORS is the browser's to enforce. What matters is that we
      // send no permission, which is what makes the browser discard it.
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('never answers with a wildcard origin', async () => {
      // The specific bug: `access-control-allow-origin: *` on every response.
      for (const origin of [EVIL, 'http://localhost:3000', null]) {
        const r = await req('/api/docs', origin);
        expect(r.headers.get('access-control-allow-origin')).not.toBe('*');
      }
    });

    it('grants a loopback dev server — the widget depends on it', async () => {
      // POSITIVE CONTROL: if this fails, the "no header" assertions above
      // would pass trivially on a server that never sends CORS at all.
      const r = await req('/api/docs', 'http://localhost:3000');
      expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(r.headers.get('vary')).toBe('Origin');
    });

    it('grants a dev server on 0.0.0.0 — what Vite prints for all-interfaces', async () => {
      // host-guard already treats 0.0.0.0 as local; the origin policy is meant
      // to mirror it, and dropping it would refuse a widget the host gate
      // considers local.
      const r = await req('/api/docs', 'http://0.0.0.0:5173');
      expect(r.headers.get('access-control-allow-origin')).toBe('http://0.0.0.0:5173');
    });

    it('grants a dev server on one of this machine’s own hostnames', async () => {
      // codex flagged this: restricting cross-origin to loopback would have
      // broken the documented setup where the reviewed app is served from the
      // tailnet/LAN and points back at this server.
      const r = await req('/api/docs', 'http://mac-mini.example.ts.net:3000');
      expect(r.headers.get('access-control-allow-origin')).toBe(
        'http://mac-mini.example.ts.net:3000',
      );
    });

    it('still refuses a lookalike of that hostname', async () => {
      const r = await req('/api/docs', 'http://mac-mini.example.ts.net.evil.example.com');
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('grants an explicitly configured origin', async () => {
      const r = await req('/api/docs', 'https://mockups.example.com');
      expect(r.headers.get('access-control-allow-origin')).toBe('https://mockups.example.com');
    });

    it('refuses the preflight for a cross-origin write', async () => {
      const evil = await req('/api/docs', EVIL, {
        method: 'OPTIONS',
        headers: { 'access-control-request-method': 'POST' },
      });
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
      // ...while the widget's preflight still succeeds.
      const ok = await req('/api/docs', 'http://localhost:3000', {
        method: 'OPTIONS',
        headers: { 'access-control-request-method': 'POST' },
      });
      expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
      expect(ok.status).toBe(204);
    });

    it('REFUSES a simple-request write from a disallowed origin', async () => {
      // CORS only withholds the RESPONSE. A `text/plain` POST is a "simple
      // request", so it is never preflighted — the browser sends it and the
      // write lands, the page just can't read the reply. safeJson() parses the
      // body regardless of content-type, so this was a working CSRF write:
      // post comments, or create a doc bound to any file on the machine.
      const r = await req('/api/docs', EVIL, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ docId: 'csrf-made-this', type: 'markdown', sourceUrl: docPath }),
      });
      expect(r.status).toBe(403);
      // The write must not have happened. Fetched as a non-browser caller so
      // this checks the SERVER's state, not what CORS let us see.
      expect((await req('/api/docs/csrf-made-this', null)).status).toBe(404);
    });

    it('refuses a DELETE from a disallowed origin', async () => {
      const r = await req('/api/docs/doc-1', EVIL, { method: 'DELETE' });
      expect(r.status).toBe(403);
      expect((await req('/api/docs/doc-1', null)).status).toBe(200);
    });

    it('still allows writes from an allowed origin — POSITIVE CONTROL', async () => {
      // Otherwise the two assertions above would pass on a server that refuses
      // every write from everyone.
      const r = await req('/api/docs', 'http://localhost:3000', {
        method: 'POST',
        body: JSON.stringify({ docId: 'widget-made-this', type: 'markdown', sourceUrl: docPath }),
      });
      expect(r.status).toBe(200);
      expect((await req('/api/docs/widget-made-this', null)).status).toBe(200);
    });

    it('still allows writes from a non-browser caller — agents and MCP', async () => {
      const r = await req('/api/docs', null, {
        method: 'POST',
        body: JSON.stringify({ docId: 'agent-made-this', type: 'markdown', sourceUrl: docPath }),
      });
      expect(r.status).toBe(200);
    });

    it('still lets a disallowed origin issue a GET — CORS withholds the body', async () => {
      // Blocking reads outright isn't the job here: the response simply never
      // reaches the page. Keeping GET working avoids breaking <script>/<img>
      // style loads of the widget bundle from arbitrary dev sites.
      expect((await req('/api/docs/doc-1', EVIL)).status).toBe(200);
    });

    it('still serves same-origin and non-browser callers normally', async () => {
      expect((await req('/api/docs/doc-1', null)).status).toBe(200);
      expect((await req('/api/docs/doc-1', `http://${host}`)).status).toBe(200);
    });
  });

  describe('websocket — CORS cannot help here', () => {
    const sync = async (
      origin: string | null,
    ): Promise<{ opened: boolean; text: string; closeCode: number | null }> => {
      const ydoc = new Y.Doc();
      const ws = new WebSocket(`ws://localhost:${handle.port}/y/doc-1`, {
        headers: { host, ...(origin ? { origin } : {}) },
      } as unknown as string[]);
      ws.binaryType = 'arraybuffer';
      let opened = false;
      let closeCode: number | null = null;
      ws.addEventListener('open', () => {
        opened = true;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.writeSyncStep1(enc, ydoc);
        ws.send(encoding.toUint8Array(enc));
      });
      ws.addEventListener('close', (ev) => {
        closeCode = (ev as CloseEvent).code;
      });
      ws.addEventListener('message', (ev) => {
        const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
        if (decoding.readVarUint(dec) !== 0) return;
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      });
      await new Promise((r) => setTimeout(r, 1200));
      const text = ydoc.getXmlFragment('prose').toString();
      try {
        ws.close();
      } catch {}
      return { opened, text, closeCode };
    };

    it('lets a same-origin page sync — POSITIVE CONTROL', async () => {
      // Without this, "evil got nothing" would be indistinguishable from a
      // socket that never works for anyone.
      const ok = await sync(`http://${host}`);
      expect(ok.opened).toBe(true);
      expect(ok.text).toContain(CANARY);
    });

    it('lets a loopback dev server sync — the widget', async () => {
      const ok = await sync('http://localhost:3000');
      expect(ok.text).toContain(CANARY);
    });

    it('lets a dev server on this machine’s tailnet name sync', async () => {
      const ok = await sync('http://mac-mini.example.ts.net:3000');
      expect(ok.text).toContain(CANARY);
    });

    it('lets a non-browser client sync — agents and the MCP child', async () => {
      const ok = await sync(null);
      expect(ok.text).toContain(CANARY);
    });

    it('REFUSES an arbitrary origin, and it gets no document text', async () => {
      const evil = await sync(EVIL);
      expect(evil.text).not.toContain(CANARY);
      expect(evil.text).toBe('');
    });
  });
});

/**
 * The share surface must not honour the dev-server allowances. A share
 * visitor holds a SameSite=Lax cookie, and websockets ignore CORS entirely,
 * so an allowed origin that is same-SITE with the share host would carry that
 * cookie into /y/<docId> and act as a logged-in visitor.
 */
describe('the public share host is same-origin only', () => {
  const PUBLIC_HOST = 'feedback.example.com';
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-origin-'));
    const docPath = join(dataDir, 'notes.md');
    writeFileSync(docPath, `# Notes\n\n${CANARY}.\n`);
    handle = createServer({
      port: 0,
      dataDir,
      allowedOrigins: ['https://mockups.example.com'],
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;
    const local = (p: string, i: RequestInit = {}) =>
      fetch(`${base}${p}`, {
        ...i,
        headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      });
    // A BOARD is the unit of sharing: file the doc on a grouping, file the
    // grouping on a board, share the board. `shared` is the grouping's only
    // member, so the visitor's reach — and therefore what a forged origin
    // could steal through it — is exactly what it was.
    await local('/api/docs', {
      method: 'POST',
      body: JSON.stringify({
        docId: 'shared',
        type: 'markdown',
        sourceUrl: docPath,
        workspaceId: 'ws-shared',
      }),
    });
    const board = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Cross-origin board' }),
    });
    expect(board.status).toBe(200);
    const boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    const filed = await local(`/api/workspaces/${encodeURIComponent(boardId)}/docs`, {
      method: 'POST',
      body: JSON.stringify({ docId: 'ws-shared' }),
    });
    expect(filed.status).toBe(200);
    const mint = await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: boardId }),
    });
    expect(mint.status).toBe(200);
    const { share } = (await mint.json()) as { share: { url: string } };
    const shareUrl = new URL(share.url);
    const redeemed = await fetch(`${base}${shareUrl.pathname}${shareUrl.search}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    cookie = (redeemed.headers.get('set-cookie') ?? '').match(/lf_share=([^;]+)/)?.[1] ?? '';
    expect(cookie).not.toBe('');
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // cloudflared terminates TLS and forwards plain http, stamping the original
  // scheme — so the browser's origin is https even though our socket is http.
  // Sending it here is what makes the same-origin comparison realistic.
  const asVisitor = (path: string, origin: string | null) =>
    fetch(`${base}${path}`, {
      headers: {
        host: PUBLIC_HOST,
        'x-forwarded-proto': 'https',
        cookie: `lf_share=${cookie}`,
        ...(origin ? { origin } : {}),
      },
    });

  it('grants the share host its own origin — POSITIVE CONTROL', async () => {
    const r = await asVisitor('/api/docs/shared', `https://${PUBLIC_HOST}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe(`https://${PUBLIC_HOST}`);
  });

  it('refuses a plain-http page on the same hostname', async () => {
    // http://x and https://x are different browser origins. The share host is
    // https; a page served over http on that name must not be trusted.
    const r = await asVisitor('/api/docs/shared', `http://${PUBLIC_HOST}`);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('matches when a proxy forwards Host with the default port', async () => {
    // cloudflared (or any proxy) may forward `feedback.example.com:443` while
    // the browser sends `Origin: https://feedback.example.com`. A raw string
    // compare would treat every legitimate request as foreign and 403 the
    // websocket — an outage, not a hardening.
    const r = await fetch(`${base}/api/docs/shared`, {
      headers: {
        host: `${PUBLIC_HOST}:443`,
        'x-forwarded-proto': 'https',
        cookie: `lf_share=${cookie}`,
        origin: `https://${PUBLIC_HOST}`,
      },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe(`https://${PUBLIC_HOST}`);
  });

  it('refuses a forged x-forwarded-proto that rewrites the origin', async () => {
    // The scheme is concatenated into a URL string, so an unvalidated value
    // rewrites the origin we compare against: this one parses as
    // `https://evil.example.com#://feedback.example.com`, whose .origin is the
    // ATTACKER's. On the share host, same-origin is the only rule left, so
    // that was the entire boundary. Found by an independent review pass after
    // three codex rounds missed it.
    for (const forged of [
      'https://evil.example.com#',
      'https://evil.example.com#, https',
      'https://evil.example.com/',
    ]) {
      const r = await fetch(`${base}/api/docs/shared`, {
        headers: {
          host: PUBLIC_HOST,
          'x-forwarded-proto': forged,
          cookie: `lf_share=${cookie}`,
          origin: 'https://evil.example.com',
        },
      });
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('refuses a forged x-forwarded-proto on the WEBSOCKET too', async () => {
    // The socket is where this actually paid out: the reviewer synced a whole
    // document through it.
    const ws = new WebSocket(`ws://localhost:${handle.port}/y/shared`, {
      headers: {
        host: PUBLIC_HOST,
        'x-forwarded-proto': 'https://evil.example.com#',
        cookie: `lf_share=${cookie}`,
        origin: 'https://evil.example.com',
      },
    } as unknown as string[]);
    const ydoc = new Y.Doc();
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, ydoc);
      ws.send(encoding.toUint8Array(enc));
    });
    ws.addEventListener('message', (ev) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      if (decoding.readVarUint(dec) !== 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect(ydoc.getXmlFragment('prose').toString()).toBe('');
    try {
      ws.close();
    } catch {}
  });

  it('still honours a LEGITIMATE x-forwarded-proto — POSITIVE CONTROL', async () => {
    // Rejecting every forwarded scheme would pass the tests above and take
    // every share websocket down with it.
    const r = await asVisitor('/api/docs/shared', `https://${PUBLIC_HOST}`);
    expect(r.headers.get('access-control-allow-origin')).toBe(`https://${PUBLIC_HOST}`);
  });

  it('does NOT honour ALLOWED_ORIGINS on the share host', async () => {
    const r = await asVisitor('/api/docs/shared', 'https://mockups.example.com');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does NOT honour loopback on the share host', async () => {
    const r = await asVisitor('/api/docs/shared', 'http://localhost:3000');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a websocket from an allowlisted origin on the share host', async () => {
    // The one CORS genuinely cannot protect: the browser would send the
    // SameSite=Lax cookie and hand the page the doc regardless of headers.
    const ws = new WebSocket(`ws://localhost:${handle.port}/y/shared`, {
      headers: {
        host: PUBLIC_HOST,
        'x-forwarded-proto': 'https',
        cookie: `lf_share=${cookie}`,
        origin: 'https://mockups.example.com',
      },
    } as unknown as string[]);
    const ydoc = new Y.Doc();
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.writeSyncStep1(enc, ydoc);
      ws.send(encoding.toUint8Array(enc));
    });
    ws.addEventListener('message', (ev) => {
      const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      if (decoding.readVarUint(dec) !== 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect(ydoc.getXmlFragment('prose').toString()).toBe('');
    try {
      ws.close();
    } catch {}
  });
});
