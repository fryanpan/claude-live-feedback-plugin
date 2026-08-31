import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { getProseFragment } from '../../core/src/prose.ts';
import { Rooms } from '../src/rooms.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * Regression suite for the 2026-08-26 stale-rewrite incident: an agent
 * answered a scoped comment with set_doc_content built from an in-context
 * copy of the doc that predated the human's concurrent browser edits. The
 * write succeeded silently and destroyed the human's work (file in Dropbox,
 * no history). Two guarantees are pinned here:
 *
 *  1. set_doc_content REFUSES (409 stale-write) when a human has edited the
 *     doc since the calling agent last read it — or, when the caller's last
 *     read isn't trackable, when a human edited within the last 10 minutes.
 *     The refusal is structured: it names the human-edit timestamp and tells
 *     the agent to re-read with get_doc and retry with
 *     confirmOverwriteHumanEdits: true. Omitting fields must never bypass it.
 *
 *  2. Every ACCEPTED set_doc_content first snapshots the previous serialized
 *     markdown under <dataDir>/backups/<docId>/, so even a confirmed
 *     overwrite is recoverable.
 */

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

/** Minimal Yjs browser-client stand-in (same framing as ws.test.ts). */
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

  return { ws, ydoc, ready, close: () => ws.close() };
}

const DOC = `# Title

Intro paragraph.

## Section

Keep this sentence intact.
`;

const AGENT = { id: 'agent-guard-1', name: 'Guard Agent', color: '#123456', kind: 'known' };

describe('stale-write guard on POST /api/docs/:id/content', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let path: string;
  /** The server-minted canonical docId ('g1' is just the alias we address by). */
  let canonicalId: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-stale-write-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    handle = createServer({ dedicatedListener: true, port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;
    const create = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'g1', type: 'markdown', sourceUrl: path }),
    });
    expect(create.ok).toBe(true);
    canonicalId = ((await create.json()) as { docId: string }).docId;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Type into the doc over a real websocket, as the browser editor does. */
  async function humanEdit(text = 'Human addition.'): Promise<void> {
    const client = connectDoc(`${wsBase}/y/g1`);
    await waitForOpen(client.ws);
    await client.ready;
    const frag = getProseFragment(client.ydoc);
    client.ydoc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      p.insert(0, [t]);
      frag.push([p]);
      t.insert(0, text);
    });
    // Wait until the server has actually seen the human-origin update.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (handle.rooms.staleWriteCheck('g1')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    client.close();
    expect(handle.rooms.staleWriteCheck('g1')).not.toBeNull();
  }

  async function setContent(
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/api/docs/g1/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('no intervening human edits: the existing payload still lands (old bundles keep working)', async () => {
    const res = await setContent({ markdown: '# Rewritten\n\nFresh body.\n' });
    expect(res.status).toBe(200);
    const read = await fetch(`${base}/api/docs/g1/content`);
    expect(await read.text()).toContain('Fresh body.');
  });

  it('refuses with a structured 409 after a human edit when the caller has no tracked read', async () => {
    await humanEdit();
    const res = await setContent({ markdown: '# Clobber\n\nStale rewrite.\n' });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('stale-write');
    expect(typeof res.json.humanEditedAt).toBe('number');
    const message = String(res.json.message);
    expect(message).toContain('get_doc');
    expect(message).toContain('confirmOverwriteHumanEdits');
    // And the human's words are still there.
    const read = await fetch(`${base}/api/docs/g1/content`);
    const text = await read.text();
    expect(text).toContain('Human addition.');
    expect(text).not.toContain('Stale rewrite.');
  });

  it('confirmOverwriteHumanEdits: true lets a deliberate overwrite through', async () => {
    await humanEdit();
    const res = await setContent({
      markdown: '# Confirmed\n\nDeliberate rewrite.\n',
      confirmOverwriteHumanEdits: true,
    });
    expect(res.status).toBe(200);
    const read = await fetch(`${base}/api/docs/g1/content`);
    expect(await read.text()).toContain('Deliberate rewrite.');
  });

  it('a get_doc read AFTER the human edit clears the refusal for that reader', async () => {
    // The human edit is stamped a full minute in the past — explicitly, not
    // through the websocket — so the GET's own Date.now() stamp is STRICTLY
    // newer no matter which millisecond it lands in. Racing two real stamps
    // here made the test a coin flip on the same-tick boundary, which the
    // unit suite below owns; this test owns the ROUTE wiring: the reader
    // param records a read, and that read is what flips 409 to 200.
    handle.rooms.noteHumanEdit('g1', Date.now() - 60_000);
    const refused = await setContent({ markdown: '# Pre-read\n\nStale.\n', author: AGENT });
    expect(refused.status).toBe(409);
    const read = await fetch(`${base}/api/docs/g1/content?reader=${AGENT.id}`);
    expect(read.ok).toBe(true);
    const res = await setContent({
      markdown: '# Re-read\n\nRe-applied onto current content.\n',
      author: AGENT,
    });
    expect(res.status).toBe(200);
  });

  it('a read that PREDATES the human edit still refuses, and names both timestamps', async () => {
    // Explicit distinct timestamps, for the same reason as above: this test
    // asserts the refusal SHAPE when read < edit, not the clock boundary.
    const readAt = Date.now() - 120_000;
    handle.rooms.noteAgentRead('g1', AGENT.id, readAt);
    await humanEdit();
    const res = await setContent({ markdown: '# Stale\n\nOld copy.\n', author: AGENT });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('stale-write');
    expect(typeof res.json.humanEditedAt).toBe('number');
    expect(res.json.lastReadAt).toBe(readAt);
    expect(readAt).toBeLessThan(res.json.humanEditedAt as number);
  });

  it("agent edits through the MCP tools don't trip the guard", async () => {
    const far = await fetch(`${base}/api/docs/g1/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'Intro paragraph.', replace: 'Intro paragraph, edited.' }),
    });
    expect(far.ok).toBe(true);
    const res = await setContent({ markdown: '# After agent edit\n\nStill fine.\n' });
    expect(res.status).toBe(200);
  });

  it('backs up the previous markdown before every accepted rewrite', async () => {
    const res = await setContent({ markdown: '# First rewrite\n\nBody one.\n' });
    expect(res.status).toBe(200);
    const backupDir = join(dataDir, 'backups', canonicalId);
    const first = readdirSync(backupDir).filter((f) => f.endsWith('.md'));
    expect(first.length).toBe(1);
    expect(readFileSync(join(backupDir, first[0] ?? ''), 'utf8')).toContain(
      'Keep this sentence intact.',
    );

    const res2 = await setContent({ markdown: '# Second rewrite\n\nBody two.\n' });
    expect(res2.status).toBe(200);
    const after = readdirSync(backupDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    expect(after.length).toBe(2);
    const newest = after[after.length - 1] ?? '';
    expect(readFileSync(join(backupDir, newest), 'utf8')).toContain('Body one.');
  });

  it('rotates backups to a cap instead of growing without bound', async () => {
    for (let i = 0; i < 25; i++) {
      const res = await setContent({ markdown: `# Rewrite ${i}\n\nBody ${i}.\n` });
      expect(res.status).toBe(200);
    }
    const backupDir = join(dataDir, 'backups', canonicalId);
    const files = readdirSync(backupDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeLessThanOrEqual(20);
    // The newest backup is the content the last accepted write replaced.
    const newest = files.sort()[files.length - 1] ?? '';
    expect(readFileSync(join(backupDir, newest), 'utf8')).toContain('Rewrite 23');
  });
});

describe('Rooms.staleWriteCheck (10-minute fallback window)', () => {
  let dataDir: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-stale-rooms-'));
    rooms = new Rooms({
      dataDir,
      sse: new SseHub(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    rooms.getOrCreate('d1', { type: 'markdown' });
    rooms.setDocContent('d1', '# Doc\n\nBody.\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is quiet when no human has ever edited', () => {
    expect(rooms.staleWriteCheck('d1')).toBeNull();
    expect(rooms.staleWriteCheck('d1', 'agent-x')).toBeNull();
  });

  it('an untracked caller is refused inside the window and allowed outside it', () => {
    const now = Date.now();
    rooms.noteHumanEdit('d1', now - 9 * 60_000);
    expect(rooms.staleWriteCheck('d1', undefined, now)).toEqual({
      humanEditedAt: now - 9 * 60_000,
    });
    rooms.noteHumanEdit('d1', now - 11 * 60_000);
    expect(rooms.staleWriteCheck('d1', undefined, now)).toBeNull();
  });

  it('a same-millisecond read and edit is a TIE — order unknowable — and a tie refuses', () => {
    // Date.now() has millisecond resolution: a read and a human edit landing
    // in the same tick carry no order at all. Treating the read as fresh
    // (the old `>=`) made a human edit in that tick silently overwritable —
    // and made the boundary a coin flip CI kept losing. The safe verdict for
    // an unknowable order is refuse; a re-read one tick later clears it.
    const now = Date.now();
    rooms.noteAgentRead('d1', 'agent-x', now - 5_000);
    rooms.noteHumanEdit('d1', now - 5_000);
    expect(rooms.staleWriteCheck('d1', 'agent-x', now)).toEqual({
      humanEditedAt: now - 5_000,
      lastReadAt: now - 5_000,
    });
    // One millisecond of provable order is enough.
    rooms.noteAgentRead('d1', 'agent-x', now - 4_999);
    expect(rooms.staleWriteCheck('d1', 'agent-x', now)).toBeNull();
  });

  it('a tracked reader is judged by read-vs-edit order, not the clock', () => {
    const now = Date.now();
    // Human edit 30 minutes ago — outside the window — but this reader's
    // last read is OLDER still, so its in-context copy predates the edit.
    rooms.noteHumanEdit('d1', now - 30 * 60_000);
    rooms.noteAgentRead('d1', 'agent-x', now - 60 * 60_000);
    expect(rooms.staleWriteCheck('d1', 'agent-x', now)).toEqual({
      humanEditedAt: now - 30 * 60_000,
      lastReadAt: now - 60 * 60_000,
    });
    // Re-read after the edit: safe again.
    rooms.noteAgentRead('d1', 'agent-x', now - 60_000);
    expect(rooms.staleWriteCheck('d1', 'agent-x', now)).toBeNull();
  });
});
