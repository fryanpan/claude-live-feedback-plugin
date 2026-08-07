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
    const docPath = join(dataDir, 'notes.md');
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
