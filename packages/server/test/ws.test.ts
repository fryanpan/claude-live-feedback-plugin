import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@feedback/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';

const MSG_SYNC = 0;

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onErr);
      resolve();
    };
    const onErr = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onErr);
      reject(new Error('ws error'));
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onErr);
  });
}

/**
 * Minimal Yjs client helper for tests — wires a Y.Doc to a WS via the
 * minimal sync/awareness framing the server implements.
 */
function connectDoc(url: string): {
  ws: WebSocket;
  ydoc: Y.Doc;
  ready: Promise<void>;
  close: () => void;
} {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let gotSyncStep2 = false;

  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const data = new Uint8Array(ev.data as ArrayBuffer);
    const dec = decoding.createDecoder(data);
    const kind = decoding.readVarUint(dec);
    if (kind === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (
        !gotSyncStep2 &&
        (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate)
      ) {
        gotSyncStep2 = true;
        resolveReady?.();
      }
    }
  });

  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });

  return {
    ws,
    ydoc,
    ready,
    close: () => ws.close(),
  };
}

describe('ws sync', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let wsBase: string;
  let restBase: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-ws-'));
    handle = createServer({ dedicatedListener: true, port: 0, dataDir });
    wsBase = `ws://localhost:${handle.port}`;
    restBase = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('two clients converge on text edits', async () => {
    const a = connectDoc(`${wsBase}/y/ws-1?type=mockup`);
    await waitForOpen(a.ws);
    await a.ready;
    const b = connectDoc(`${wsBase}/y/ws-1?type=mockup`);
    await waitForOpen(b.ws);
    await b.ready;

    a.ydoc.getText('content').insert(0, 'Hello from A');
    // give the message a beat to propagate
    await new Promise((r) => setTimeout(r, 150));

    b.ydoc.getText('content').insert(a.ydoc.getText('content').length, ' | Hello from B');
    await new Promise((r) => setTimeout(r, 200));

    expect(a.ydoc.getText('content').toString()).toBe('Hello from A | Hello from B');
    expect(b.ydoc.getText('content').toString()).toBe('Hello from A | Hello from B');

    a.close();
    b.close();
  });

  it('persists Y.Text to disk and reloads it on a new client', async () => {
    const a = connectDoc(`${wsBase}/y/ws-persist?type=mockup`);
    await waitForOpen(a.ws);
    await a.ready;
    a.ydoc.getText('content').insert(0, 'Persistent body');
    // wait for the debounced disk write
    await new Promise((r) => setTimeout(r, 400));
    a.close();
    // small delay to ensure close has been processed
    await new Promise((r) => setTimeout(r, 100));

    const b = connectDoc(`${wsBase}/y/ws-persist?type=mockup`);
    await waitForOpen(b.ws);
    await b.ready;
    expect(b.ydoc.getText('content').toString()).toBe('Persistent body');
    b.close();
  });

  it('an agent find_and_replace does not clobber a concurrent browser prose edit', async () => {
    // A peer reported that an agent's surgical edit (find_and_replace) on a
    // bound doc clobbered a human's in-progress browser edits. Agent edits run
    // as targeted Yjs transactions on the live doc — the SAME doc the browser
    // syncs to — so they CRDT-merge with concurrent human edits rather than
    // overwrite them. This pins that safety: a browser edits one paragraph
    // while the agent find_and_replaces another, and BOTH land on disk.
    const file = join(dataDir, 'concurrent.md');
    writeFileSync(file, 'Alpha line\n\nBravo line\n');
    const r = await fetch(`${restBase}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'concur-1', type: 'markdown', sourceUrl: file }),
    });
    expect(r.ok).toBe(true);

    // Connect a browser-shaped client and wait for the seeded prose to sync.
    const browser = connectDoc(`${wsBase}/y/concur-1`);
    await waitForOpen(browser.ws);
    await browser.ready;
    const frag = prose.getProseFragment(browser.ydoc);
    for (let i = 0; i < 50 && frag.length < 2; i++) {
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(frag.length).toBeGreaterThanOrEqual(2);

    // Human edit in the browser: append " EDIT" to the "Bravo line" paragraph.
    const bravoPara = frag.toArray()[1] as Y.XmlElement;
    const bravoText = bravoPara.toArray()[0] as Y.XmlText;
    bravoText.insert(bravoText.length, ' EDIT');

    // Concurrently, the agent rewrites the OTHER paragraph via REST.
    await fetch(`${restBase}/api/docs/concur-1/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'Alpha', replace: 'Alpha2' }),
    }).then((res) => expect(res.ok).toBe(true));

    // Wait for the debounced write-back (800ms) and assert both edits survive.
    let disk = '';
    for (let i = 0; i < 40; i++) {
      disk = readFileSync(file, 'utf8');
      if (disk.includes('Alpha2') && disk.includes('Bravo line EDIT')) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(disk).toContain('Alpha2 line');
    expect(disk).toContain('Bravo line EDIT');
    browser.close();
  });
});
