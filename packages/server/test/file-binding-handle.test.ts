/**
 * The bindings, driven through a FAKE host.
 *
 * `FileBindings` is the disk half of a room: the mtime poll, the debounced
 * write-back, and the reconcile that arbitrates when both sides moved. It
 * reaches the room lifecycle only through `FileBindingHost`, and this file is
 * what pins that boundary — a real binding over a real file, but with a
 * hand-built host that records every call in order.
 *
 * Two things it proves that the end-to-end suites cannot:
 *
 *  - the ORDER the host is called in on each path, which is the contract that
 *    made the split safe. A write-back that reached disk must tell the host
 *    its pending write is gone; one that found disk moved must NOT, because
 *    the bytes never landed.
 *  - the reconcile arm is chosen by the doc's dirtiness, not by luck. The
 *    dirty case is the one with a positive control right beside it: the same
 *    external write against a CLEAN doc applies instead of conflicting.
 *
 * Synthetic temp dirs. No server, no port, no production data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DocMeta, type WebhookPayload, prose } from '@feedback/core';
import * as Y from 'yjs';
import { DOC_STORE_TIMINGS } from '../src/doc-store-timings.ts';
import type { DocRoom } from '../src/doc-store.ts';
import { type FileBindingHost, FileBindings } from '../src/file-binding.ts';
import { waitFor } from './wait-for.ts';

const DOC_ID = 'bound-doc';

/** A room with only the parts a binding touches: the ydoc, the meta it
 *  stamps `sourceUrl` on, and the `seq` a sync-error broadcast bumps. */
function fakeRoom(docId: string): DocRoom {
  const ydoc = new Y.Doc();
  const meta = { docId, type: 'markdown', createdAt: Date.now() } as unknown as DocMeta;
  return {
    docId,
    ydoc,
    get awareness(): never {
      throw new Error('a binding must never reach for presence');
    },
    peekAwareness: () => null,
    conns: new Set(),
    meta,
    seq: 0,
  } as unknown as DocRoom;
}

type Recorder = {
  host: FileBindingHost;
  calls: string[];
  broadcasts: WebhookPayload[];
  /** Move the residency clock, which is the ONLY clock the fast lane reads. */
  advance(ms: number): void;
};

function recorder(dataDir: string, room: DocRoom): Recorder {
  const calls: string[] = [];
  const broadcasts: WebhookPayload[] = [];
  const touched = new Map<string, number>();
  let clock = 1_000_000;
  const host: FileBindingHost = {
    dataDir: () => dataDir,
    room: (docId) => {
      calls.push(`room(${docId})`);
      return docId === room.docId ? room : undefined;
    },
    residentRoom: (docId) => (docId === room.docId ? room : undefined),
    ydocPath: (docId) => join(dataDir, `${docId}.ydoc`),
    schedulePersist: () => calls.push('schedulePersist'),
    persistNow: () => calls.push('persistNow'),
    clearPendingFileWrite: (docId) => calls.push(`clearPendingFileWrite(${docId})`),
    now: () => clock,
    lastTouchedAt: (docId) => touched.get(docId),
    noteTouched: (docId, at) => {
      calls.push('noteTouched');
      touched.set(docId, at);
    },
    broadcast: (_room, payload) => {
      calls.push(`broadcast(${payload.event})`);
      broadcasts.push(payload);
    },
    decorate: (meta) => meta,
  };
  return {
    host,
    calls,
    broadcasts,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/**
 * Write a file the way something outside the server does — and make the
 * mtime actually move.
 *
 * The poll detects change by `statSync().mtimeMs` and nothing else, and a
 * write landing in the same filesystem timestamp tick as the attach is
 * invisible to it forever. That is a real property of the mechanism, not a
 * bug to hide: it is why the write-back stamps its own mtime. Bumping the
 * stamp here (the same helper `doc-origin-repo-binding.test.ts` uses) is what makes
 * the assertion about the SWEEP rather than about how fast this machine is.
 */
let mtimeBump = 0;
function writeExternal(path: string, content: string): void {
  const before = statSync(path).mtimeMs;
  writeFileSync(path, content);
  mtimeBump += 2;
  const t = new Date(Date.now() + mtimeBump * 1000);
  utimesSync(path, t, t);
  // The premise the poll rests on. Without this the test could pass or fail
  // on timestamp granularity and report neither.
  if (statSync(path).mtimeMs === before) throw new Error('mtime did not move');
}

function proseText(room: DocRoom): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
}

/** An edit the way an agent's edit tool makes one: a string origin that is
 *  neither of the binding's own two, so the write-back observer arms. */
function edit(room: DocRoom, markdown: string): void {
  const fragment = prose.getProseFragment(room.ydoc);
  room.ydoc.transact(() => {
    prose.applyMarkdownToFragment(fragment, markdown);
  }, 'agent-edit');
}

describe('a binding drives its room only through the host', () => {
  let dataDir: string;
  let srcDir: string;
  let filePath: string;
  let room: DocRoom;
  let rec: Recorder;
  let bindings: FileBindings;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'fb-data-'));
    srcDir = mkdtempSync(join(tmpdir(), 'fb-src-'));
    filePath = join(srcDir, 'doc.md');
    writeFileSync(filePath, '# Doc\n\nfrom disk\n');
    room = fakeRoom(DOC_ID);
    rec = recorder(dataDir, room);
    bindings = new FileBindings(rec.host);
  });

  afterEach(() => {
    bindings.discard(DOC_ID);
    bindings.stopPolling();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('attaches through the host: resolves the room, seeds it, records the path', () => {
    const res = bindings.attachFile(DOC_ID, filePath);
    expect(res).toMatchObject({ ok: true, seeded: true, resolvedPath: filePath });
    // The room came from the host, not from a field the bindings hold.
    expect(rec.calls[0]).toBe(`room(${DOC_ID})`);
    // `sourceUrl` is sidecar state, so recording it asks the host to persist.
    expect(rec.calls).toContain('schedulePersist');
    expect(room.meta.sourceUrl).toBe(filePath);
    expect(proseText(room)).toContain('from disk');
    expect(bindings.has(DOC_ID)).toBe(true);
    expect(bindings.pathOf(DOC_ID)).toBe(filePath);
  });

  it('a write-back that lands tells the host the pending write is gone, in that order', async () => {
    bindings.attachFile(DOC_ID, filePath);
    rec.calls.length = 0;

    edit(room, '# Doc\n\nlive edit\n');
    // Control: the edit really armed a write-back. Without this the ordering
    // assertion below would pass on a binding that never scheduled anything.
    expect(bindings.pendingWriteDocIds()).toEqual([DOC_ID]);
    expect(bindings.hasPendingWrite(DOC_ID)).toBe(true);

    await waitFor(() => readFileSync(filePath, 'utf8').includes('live edit'), {
      describe: 'the write-back to reach disk',
      timeout: DOC_STORE_TIMINGS.writeBackMs + 4000,
    });

    // The host is told LAST, and only once the bytes are on disk: the flag it
    // clears is what a restart would otherwise use to reassert this doc.
    expect(rec.calls.at(-1)).toBe(`clearPendingFileWrite(${DOC_ID})`);
    expect(rec.calls.filter((c) => c.startsWith('broadcast'))).toEqual([]);
    expect(bindings.hasPendingWrite(DOC_ID)).toBe(false);
    expect(bindings.hasFailedWrite(DOC_ID)).toBe(false);
  });

  it('a disk change while the doc is DIRTY takes the reconcile path: backup, sync_error, reassert', () => {
    bindings.attachFile(DOC_ID, filePath);
    // Un-flushed live edits: the doc has diverged from what we last wrote.
    edit(room, '# Doc\n\nlive edit nobody has flushed\n');
    expect(bindings.hasPendingWrite(DOC_ID)).toBe(true);
    rec.calls.length = 0;

    // Somebody else writes the file underneath it.
    writeFileSync(filePath, '# Doc\n\nexternal edit\n');

    expect(bindings.reconcileNow(DOC_ID)).toBe('conflict');

    // The live edits won and were re-armed for disk...
    expect(proseText(room)).toContain('live edit nobody has flushed');
    expect(bindings.hasPendingWrite(DOC_ID)).toBe(true);
    // ...the overwritten external version was snapshotted first...
    const backups = readdirSync(join(dataDir, 'clobber-backups'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(dataDir, 'clobber-backups', backups[0]), 'utf8')).toContain(
      'external edit',
    );
    // ...and the loss was announced on the room, through the host.
    expect(rec.calls).toContain('broadcast(doc.sync_error)');
    const announced = rec.broadcasts.at(-1) as { message?: string } | undefined;
    expect(announced?.message ?? '').toContain('collided with un-flushed live edits');
    expect(bindings.getSyncError(DOC_ID)?.message).toContain('reasserted them to disk');
    // The backup is named in the message, or "recoverable" would be a lie.
    expect(announced?.message ?? '').toContain('clobber-backups');
  });

  it('POSITIVE CONTROL: the same disk change against a CLEAN doc applies instead', () => {
    bindings.attachFile(DOC_ID, filePath);
    // No live edit this round — the doc still equals what we last read.
    expect(bindings.hasPendingWrite(DOC_ID)).toBe(false);
    rec.calls.length = 0;

    writeFileSync(filePath, '# Doc\n\nexternal edit\n');

    expect(bindings.reconcileNow(DOC_ID)).toBe('apply');
    expect(proseText(room)).toContain('external edit');
    expect(bindings.getSyncError(DOC_ID)).toBeUndefined();
    expect(rec.calls.filter((c) => c.startsWith('broadcast'))).toEqual([]);
    expect(existsSync(join(dataDir, 'clobber-backups'))).toBe(false);
  });

  it('the poll asks the host for the clock and stamps the access before reading', async () => {
    bindings.attachFile(DOC_ID, filePath);
    rec.calls.length = 0;

    // An access is what puts a binding in the fast lane, and it is the host's
    // clock — not Date.now() — that decides how long it stays there.
    bindings.touchDoc(DOC_ID);
    expect(rec.calls).toContain('noteTouched');
    expect(bindings.stats(rec.host.now()).active).toBe(1);

    // Move the host's clock past the active window and the binding falls back
    // to the idle rotation. A binding reading the real clock would still read
    // as active here, which is the failure this asserts against.
    rec.advance(120_000);
    expect(bindings.stats(rec.host.now()).active).toBe(0);
    expect(bindings.stats(rec.host.now()).count).toBe(1);

    // An external write reaches the doc through the shared sweep, and the
    // poll's own promotion is another host stamp.
    writeExternal(filePath, '# Doc\n\nseen by the poll\n');
    await waitFor(() => proseText(room).includes('seen by the poll'), {
      describe: 'the mtime poll to pull the external edit in',
      timeout: DOC_STORE_TIMINGS.filePollMs + DOC_STORE_TIMINGS.readDebounceMs + 4000,
    });
  });

  it('discard lets go of the file: no binding, no timers, no further writes', () => {
    bindings.attachFile(DOC_ID, filePath);
    edit(room, '# Doc\n\nnever flushed\n');
    expect(bindings.pendingWriteDocIds()).toEqual([DOC_ID]);

    bindings.discard(DOC_ID);

    expect(bindings.has(DOC_ID)).toBe(false);
    expect(bindings.pendingWriteDocIds()).toEqual([]);
    expect(bindings.describe(DOC_ID)).toBeUndefined();
    expect(bindings.stats(rec.host.now()).count).toBe(0);
    // The cancelled write really was cancelled: the file still holds what it
    // held before the edit.
    expect(readFileSync(filePath, 'utf8')).not.toContain('never flushed');
  });
});
