import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { getProseFragment, serializeFragmentToMarkdown, walkProse } from '../../core/src/prose.ts';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { pastWriteBack } from './wait-for.ts';

/**
 * DocStore-level suggestion operations (redline-suggestions phase 2, commit 2):
 * list/accept/reject/resolve-all + the creation primitive, exercised through
 * the REAL file binding — accepted changes flow to disk via the normal
 * debounced write-back, pending proposals never do, concurrent human edits
 * CRDT-merge with agent proposals, restarts hydrate pending proposals, and
 * an external rewrite of a block carrying suggestions drops them AND records
 * the dropped sids (the syncError recoverability pattern).
 */

function makeDocStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Force a strictly-increasing mtime — coarse temp filesystems can land two
 *  saves in the same tick, making the second invisible (learnings). */
function bumpMtime(path: string): void {
  const t = statSync(path).mtimeMs / 1000 + 2;
  utimesSync(path, t, t);
}

const author = { id: 'agent-1', name: 'Docs Agent', color: '#7c5cff' };

const MD = '# Title\n\nAlpha beta gamma.\n\nSecond paragraph here.\n';

describe('doc-store suggestion operations', () => {
  let dataDir: string;
  let path: string;
  let docStore: DocStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-suggest-ops-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, MD);
    docStore = makeDocStore(dataDir);
    docStore.getOrCreate('sg1', { type: 'markdown', sourceUrl: path });
    expect(docStore.attachFile('sg1', path).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('create → pending never reaches disk; accept applies and flows to disk via write-back', async () => {
    const created = docStore.createSuggestion('sg1', { find: 'beta', replace: 'delta', author });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The proposal is pending: the write-back window passes and the FILE is
    // byte-identical (proposal isolation, outcome 1 of the plan).
    // timed: only an elapsed window can prove the proposal never landed.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).toBe(MD);

    const list = docStore.listSuggestions('sg1');
    expect(list).toHaveLength(1);
    expect(list[0]!.sid).toBe(created.suggestionId);
    expect(list[0]!.kind).toBe('replace');
    expect(list[0]!.author).toEqual({ id: 'agent-1', name: 'Docs Agent', color: '#7c5cff' });

    // Accept → the change becomes real and the normal debounced write-back
    // carries it to disk (assert the FILE, not just the doc).
    expect(docStore.acceptSuggestion('sg1', created.suggestionId)).toEqual({ ok: true });
    let disk = '';
    for (let i = 0; i < 40; i++) {
      disk = readFileSync(path, 'utf8');
      if (disk.includes('delta')) break;
      await sleep(50);
    }
    expect(disk).toBe('# Title\n\nAlpha delta gamma.\n\nSecond paragraph here.\n');
    expect(docStore.listSuggestions('sg1')).toHaveLength(0);
  });

  it('reject restores exactly the pre-suggestion text, in the doc and on disk', async () => {
    const created = docStore.createSuggestion('sg1', { find: 'beta', replace: 'delta', author });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(docStore.rejectSuggestion('sg1', created.suggestionId)).toEqual({ ok: true });
    const ydoc = docStore.get('sg1')!.ydoc;
    expect(serializeFragmentToMarkdown(getProseFragment(ydoc))).toBe(MD);
    // No residual marks in the live doc either.
    expect(walkProse(getProseFragment(ydoc)).plainText).not.toContain('delta');
    // timed: same negative — the rejected text must still be absent after the
    // window in which a write-back could have carried it out.
    await sleep(pastWriteBack());
    expect(readFileSync(path, 'utf8')).toBe(MD);
    expect(docStore.listSuggestions('sg1')).toHaveLength(0);
  });

  it('double accept: the second caller gets not-found (the race is idempotent)', () => {
    const created = docStore.createSuggestion('sg1', { find: 'beta', replace: 'delta', author });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(docStore.acceptSuggestion('sg1', created.suggestionId)).toEqual({ ok: true });
    expect(docStore.acceptSuggestion('sg1', created.suggestionId)).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(docStore.rejectSuggestion('sg1', created.suggestionId)).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('unknown doc → not-found / empty list', () => {
    expect(docStore.acceptSuggestion('nope', 'x')).toEqual({ ok: false, error: 'not-found' });
    expect(docStore.rejectSuggestion('nope', 'x')).toEqual({ ok: false, error: 'not-found' });
    expect(docStore.listSuggestions('nope')).toEqual([]);
    const created = docStore.createSuggestion('nope', { find: 'a', replace: 'b', author });
    expect(created.ok).toBe(false);
    expect(docStore.resolveAllSuggestions('nope', { action: 'accept' })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });

  it('resolveAllSuggestions accepts everything and the result flows to disk', async () => {
    expect(docStore.createSuggestion('sg1', { find: 'beta', replace: 'delta', author }).ok).toBe(
      true,
    );
    expect(
      docStore.createSuggestion('sg1', { find: 'paragraph', replace: 'section', author }).ok,
    ).toBe(true);
    const res = docStore.resolveAllSuggestions('sg1', { action: 'accept' });
    expect(res).toEqual({ ok: true, resolved: 2, sids: expect.any(Array) });
    let disk = '';
    for (let i = 0; i < 40; i++) {
      disk = readFileSync(path, 'utf8');
      if (disk.includes('delta') && disk.includes('section')) break;
      await sleep(50);
    }
    expect(disk).toBe('# Title\n\nAlpha delta gamma.\n\nSecond section here.\n');
  });

  it('a concurrent human edit in the SAME paragraph CRDT-merges with an agent suggestion', async () => {
    const serverDoc = docStore.get('sg1')!.ydoc;
    // Browser-shaped replica, synced then edited OFFLINE (true concurrency).
    const browser = new Y.Doc();
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(serverDoc));

    // Human types at the end of the same paragraph the agent will touch.
    const bFrag = getProseFragment(browser);
    const bPara = bFrag.get(1) as Y.XmlElement; // [heading, para, para]
    const bText = bPara.toArray()[0] as Y.XmlText;
    bText.insert(bText.length, ' HUMAN');

    // Concurrently, the agent files a suggestion on the server copy.
    const created = docStore.createSuggestion('sg1', { find: 'beta', replace: 'delta', author });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Merge both ways — nothing may be lost.
    Y.applyUpdate(serverDoc, Y.encodeStateAsUpdate(browser), 'remote');
    Y.applyUpdate(browser, Y.encodeStateAsUpdate(serverDoc), 'remote');

    const plain = walkProse(getProseFragment(serverDoc)).plainText;
    expect(plain).toContain('HUMAN');
    const list = docStore.listSuggestions('sg1');
    expect(list).toHaveLength(1);
    expect(list[0]!.sid).toBe(created.suggestionId);

    // Accept after the merge: both the human edit and the accepted
    // replacement land on disk.
    expect(docStore.acceptSuggestion('sg1', created.suggestionId)).toEqual({ ok: true });
    let disk = '';
    for (let i = 0; i < 40; i++) {
      disk = readFileSync(path, 'utf8');
      if (disk.includes('delta') && disk.includes('HUMAN')) break;
      await sleep(50);
    }
    expect(disk).toBe('# Title\n\nAlpha delta gamma. HUMAN\n\nSecond paragraph here.\n');
  });

  it('agent suggestion transactions never land on a default-origins UndoManager (undo discipline)', () => {
    const ydoc = docStore.get('sg1')!.ydoc;
    const um = new Y.UndoManager(getProseFragment(ydoc)); // trackedOrigins: {null}, like a local editor
    const created = docStore.createSuggestion('sg1', { find: 'beta', replace: 'delta', author });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(docStore.acceptSuggestion('sg1', created.suggestionId)).toEqual({ ok: true });
    expect(um.undoStack.length).toBe(0); // Cmd-Z would revert NOTHING of the agent's
    // Sanity contrast: an origin-less (human-shaped) edit IS tracked.
    const para = getProseFragment(ydoc).get(1) as Y.XmlElement;
    (para.toArray()[0] as Y.XmlText).insert(0, 'x');
    expect(um.undoStack.length).toBe(1);
    um.destroy();
  });

  it('.ydoc persist/hydrate keeps pending suggestions operable after a restart', async () => {
    const created = docStore.createSuggestion('sg1', { find: 'beta', replace: 'delta', author });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Drain the .ydoc persist debounce rather than outwaiting it, so the
    // restart below is reading a snapshot that definitely exists.
    docStore.flush();

    const docStore2 = makeDocStore(dataDir);
    const list = docStore2.listSuggestions('sg1');
    expect(list).toHaveLength(1);
    expect(list[0]!.sid).toBe(created.suggestionId);
    expect(list[0]!.kind).toBe('replace');
    // The hydrated proposal is still actionable.
    expect(docStore2.acceptSuggestion('sg1', created.suggestionId)).toEqual({ ok: true });
    let disk = '';
    for (let i = 0; i < 40; i++) {
      disk = readFileSync(path, 'utf8');
      if (disk.includes('delta')) break;
      await sleep(50);
    }
    expect(disk).toBe('# Title\n\nAlpha delta gamma.\n\nSecond paragraph here.\n');
  });

  it('an external rewrite of a block carrying suggestions drops them AND records the dropped sids', async () => {
    const dropped = docStore.createSuggestion('sg1', { find: 'beta', replace: 'delta', author });
    const survivor = docStore.createSuggestion('sg1', {
      find: 'paragraph',
      replace: 'section',
      author,
    });
    expect(dropped.ok && survivor.ok).toBe(true);
    if (!dropped.ok || !survivor.ok) return;
    // Let the write-back settle (it writes the accepted state — identical
    // bytes — and advances lastWritten bookkeeping).
    docStore.flush();
    expect(readFileSync(path, 'utf8')).toBe(MD);

    // External tool rewrites ONLY the first paragraph.
    writeFileSync(path, '# Title\n\nAlpha rewritten completely.\n\nSecond paragraph here.\n');
    bumpMtime(path);
    expect(docStore.reconcileNow('sg1')).toBe('apply');

    // The suggestion inside the rewritten block is gone; the one in the
    // untouched block keeps its Y.XmlText identity and survives.
    const list = docStore.listSuggestions('sg1');
    expect(list).toHaveLength(1);
    expect(list[0]!.sid).toBe(survivor.suggestionId);

    // ...and the drop is RECORDED, not silently swallowed (syncError pattern
    // — same recoverability philosophy as clobber-backups).
    const err = docStore.getSyncError('sg1');
    expect(err).toBeDefined();
    expect(err!.message).toContain(dropped.suggestionId);
    expect(err!.message).not.toContain(survivor.suggestionId);

    // A later clean reconcile clears the note.
    writeFileSync(path, readFileSync(path, 'utf8'));
    bumpMtime(path);
    docStore.reconcileNow('sg1');
    // (in-sync/catch-up leaves the note; only the next successful APPLY with
    // no drops clears it — assert the survivor is still operable either way)
    expect(docStore.acceptSuggestion('sg1', survivor.suggestionId)).toEqual({ ok: true });
  });
});
