import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { insideWriteBack, waitFor } from './wait-for.ts';

/**
 * A lost write into a bound doc must tell SOMEBODY — the syncError needs an
 * event on the doc's watch channel.
 *
 * Measured twice before this suite existed (in-process DocStore and HTTP against
 * a spawned server): when an external write lands inside the 800ms write
 * debounce it is silently overwritten, and the resulting syncError was only
 * readable via get_doc or a later edit response. The party who LOST content —
 * whoever ran the git command or saved in the editor — never touches those
 * surfaces; the watching agent does. So recording a syncError must also
 * broadcast a `doc.sync_error` event on the doc's SSE channel, carrying the
 * docId, the bound path, and the clobber-backup path so recovery is one
 * read away instead of an archaeology dig.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Write + force a strictly newer mtime (temp filesystems can land rapid
 *  writes in the same mtime tick, invisible to the poll). */
let mtimeBump = 0;
function writeExternal(path: string, content: string): void {
  writeFileSync(path, content);
  mtimeBump += 2;
  const t = new Date(Date.now() + mtimeBump * 1000);
  require('node:fs').utimesSync(path, t, t);
}

const DOC = `# Title

Intro paragraph.

## Section

Keep this sentence intact.
`;

const EXT_ONE = `# Title


Intro paragraph, first external edit.


## Section

Keep this sentence intact.
`;

interface SyncErrorEvent {
  event: string;
  docId?: string;
  path?: string;
  backupPath?: string;
  message?: string;
}

describe('doc.sync_error broadcast (in-process DocStore)', () => {
  let dataDir: string;
  let path: string;
  let sse: SseHub;
  let docStore: DocStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-syncerr-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    sse = new SseHub();
    docStore = new DocStore({
      dataDir,
      sse,
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    docStore.getOrCreate('d1', { type: 'markdown', sourceUrl: path });
    expect(docStore.attachFile('d1', path).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function syncErrorEvents(docId: string): SyncErrorEvent[] {
    return sse
      .eventsOn(docId)
      .map((e) => e.payload as SyncErrorEvent)
      .filter((p) => p.event === 'doc.sync_error');
  }

  it('a conflict reassert (editor-save shape) broadcasts the event with path + backup', () => {
    expect(
      docStore.findAndReplace('d1', {
        find: 'Intro paragraph.',
        replace: 'Live edit, not yet flushed.',
      }).ok,
    ).toBe(true);
    writeExternal(path, EXT_ONE);
    expect(docStore.reconcileNow('d1')).toBe('conflict');

    const events = syncErrorEvents('d1');
    expect(events.length).toBe(1);
    const ev = events[0] as SyncErrorEvent;
    expect(ev.docId).toBe('d1');
    expect(ev.path).toBe(path);
    expect(ev.backupPath).toContain('clobber-backups');
    // The backup the event points at actually holds the overwritten bytes —
    // an event naming a path nobody can read is the old silence with a bow.
    expect(readFileSync(ev.backupPath as string, 'utf8')).toContain('first external edit');
    expect(ev.message).toContain('collided');
  });

  it('a git-shaped overwrite inside the 800ms write debounce broadcasts the event', async () => {
    expect(
      docStore.findAndReplace('d1', {
        find: 'Intro paragraph.',
        replace: 'Live edit racing the external write.',
      }).ok,
    ).toBe(true);
    // Land the external write just before the write-back fires — the
    // stat-before-write guard routes this through the conflict arm.
    // timed: the write has to land INSIDE the 800ms window; the delay is the
    // setup for the race, not a wait for a result.
    await sleep(insideWriteBack());
    writeExternal(path, EXT_ONE);

    const events = await waitFor(
      () => {
        const found = syncErrorEvents('d1');
        return found.length > 0 ? found : false;
      },
      { describe: 'the conflict arm to broadcast doc.sync_error' },
    );
    expect(events.length).toBeGreaterThan(0);
    const ev = events[0] as SyncErrorEvent;
    expect(ev.docId).toBe('d1');
    expect(ev.backupPath).toContain('clobber-backups');
  });

  it('a clean reconcile broadcasts nothing', () => {
    writeExternal(path, EXT_ONE);
    expect(docStore.reconcileNow('d1')).toBe('apply');
    expect(syncErrorEvents('d1').length).toBe(0);
  });
});

describe('doc.sync_error reaches a watching SSE stream (HTTP end-to-end)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let path: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-syncerr-http-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a watcher on /events/<docId> receives doc.sync_error after an overwrite conflict', async () => {
    const create = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'h1', type: 'markdown', sourceUrl: path }),
    });
    expect(create.ok).toBe(true);
    // `h1` was the NAME; the server minted the id. The doc-store handle keys on
    // the canonical one, and the stream below is opened by the name — so this
    // exercise is also the alias contract: a watcher that subscribed by name
    // and a writer that fired on the doc's own id have to meet.
    const h1 = ((await create.json()) as { docId: string }).docId;

    // Subscribe the way the MCP child does: a live SSE stream on the doc.
    const controller = new AbortController();
    const res = await fetch(`${base}/events/h1`, { signal: controller.signal });
    expect(res.ok).toBe(true);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const gotEvent = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        const idx = buffer.indexOf('event: doc.sync_error');
        if (idx < 0) continue;
        const dataStart = buffer.indexOf('data: ', idx);
        const dataEnd = buffer.indexOf('\n\n', dataStart);
        if (dataStart < 0 || dataEnd < 0) continue;
        return JSON.parse(buffer.slice(dataStart + 'data: '.length, dataEnd)) as SyncErrorEvent;
      }
    })();

    // The git-shaped overwrite: un-flushed live edits, then the file is
    // rewritten out from under the doc.
    expect(
      handle.docStore.findAndReplace(h1, { find: 'Intro paragraph.', replace: 'Un-flushed.' }).ok,
    ).toBe(true);
    writeExternal(path, EXT_ONE);
    expect(handle.docStore.reconcileNow(h1)).toBe('conflict');

    // timed: a failure DEADLINE, not a wait — the race settles the instant the
    // event arrives, and only a stream that never delivers pays the 3s.
    const ev = await Promise.race([gotEvent, sleep(3000).then(() => null)]);
    controller.abort();
    if (!ev) throw new Error('watching stream never received doc.sync_error');
    expect(ev.docId).toBe(h1);
    expect(ev.path).toBe(path);
    expect(ev.backupPath).toContain('clobber-backups');
    expect(readFileSync(ev.backupPath as string, 'utf8')).toContain('first external edit');
  });
});
