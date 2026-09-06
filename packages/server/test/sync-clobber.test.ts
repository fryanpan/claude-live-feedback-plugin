import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { getProseFragment } from '../../core/src/prose.ts';
import { DocStore } from '../src/doc-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { insideWriteBack, pastWriteBack, waitFor, waitForFile } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * Regression suite for the disk-clobber incident class (2026-07-15 and
 * 2026-08-03, reconstructed from fleet transcripts). The recurring shape:
 * an agent writes the bound .md directly, the reconcile misjudges the state,
 * and the server's own write-back flushes a stale in-memory copy over the
 * agent's file — after which even `reparse_from_disk` pulls the stale copy
 * back, because disk now holds it.
 *
 * Three root causes, each pinned by tests below:
 *  RC1  decideReconcile compared raw disk bytes against normalized serializer
 *       output, so after any applied external edit the binding looked
 *       permanently diverged and the NEXT external edit was a false conflict.
 *  RC2  scheduleFileWrite wrote blind — an external write landing inside the
 *       800ms debounce window was silently overwritten, unrecoverably.
 *  RC3  there was no whole-doc rewrite tool, which is what pushed agents into
 *       direct Writes in the first place.
 */

/**
 * Every DocStore built by a test, so `afterEach` can stop them all.
 *
 * A store nobody stopped keeps its mtime sweep running — over a dataDir the
 * teardown then deletes, and alongside whichever store the NEXT test builds.
 * These tests deliberately build two stores over one dataDir, which is the
 * case `DocStore.stop()` exists for.
 */
const liveStores: DocStore[] = [];

function makeDocStore(dataDir: string): DocStore {
  const store = new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
  liveStores.push(store);
  return store;
}

const AUTHOR = { id: 'u1', kind: 'known' as const, name: 'Reviewer', color: '#000' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Write + force a strictly newer mtime (learnings: temp filesystems can land
 *  rapid writes in the same mtime tick, making them invisible to the poll). */
let mtimeBump = 0;
function writeExternal(path: string, content: string): void {
  writeFileSync(path, content);
  mtimeBump += 2;
  const t = new Date(Date.now() + mtimeBump * 1000);
  // utimes wants seconds resolution to be strictly increasing across calls
  require('node:fs').utimesSync(path, t, t);
}

const DOC = `# Title

Intro paragraph.

## Section

Keep this sentence intact.
`;

// External rewrites written with extra blank lines: byte-different from what
// the serializer would emit for the same content, which is exactly the
// normalization drift that made RC1 fire.
const EXT_ONE = `# Title


Intro paragraph, first external edit.


## Section

Keep this sentence intact.
`;

const EXT_TWO = `# Title


Intro paragraph, second external edit.


## Section

Keep this sentence intact.
`;

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

/**
 * Build the state a crash inside the write-back window leaves behind: the
 * `.ydoc` saved, the `.md` still holding the pre-edit bytes.
 *
 * Waiting for the `.ydoc` to be REWRITTEN, then dropping the pending file
 * write, replaces a `sleep(afterPersist())` that had to land between a ~20ms
 * persist and an ~80ms write-back. Neither half is a race any more: the wait
 * returns when the persist has actually happened, and the write it drops can
 * no longer fire late. A loaded runner overshooting that window was enough to
 * turn "the reassert snapshots the disk version" red — measured, +120ms.
 */
async function crashAfterPersist(
  store: DocStore,
  dataDir: string,
  docId: string,
  edit: string,
): Promise<void> {
  const ydoc = join(dataDir, `${docId}.ydoc`);
  // The snapshot's own bytes, not its mtime: a persist that predates the edit
  // would bump the mtime and let the "crash" happen before the state it is
  // supposed to have saved. The CRDT update carries inserted text verbatim.
  await waitFor(() => existsSync(ydoc) && readFileSync(ydoc).includes(Buffer.from(edit)), {
    describe: `the .ydoc snapshot for ${docId} to hold ${JSON.stringify(edit)}`,
  });
  store.simulateCrash();
}

describe('sync-clobber regressions', () => {
  let dataDir: string;
  let path: string;
  let docStore: DocStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-clobber-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    docStore = makeDocStore(dataDir);
    docStore.getOrCreate('d1', { type: 'markdown', sourceUrl: path });
    expect(docStore.attachFile('d1', path).ok).toBe(true);
  });

  afterEach(() => {
    for (const store of liveStores.splice(0)) store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('RC1 — serializer-space bookkeeping', () => {
    it('applies a second external edit instead of misjudging it a conflict', async () => {
      writeExternal(path, EXT_ONE);
      expect(docStore.reconcileNow('d1')).toBe('apply');

      // The live doc has NO un-flushed edits — the only "divergence" is that
      // the serializer normalizes the extra blank lines. The next external
      // edit must therefore be an apply, not a conflict.
      writeExternal(path, EXT_TWO);
      expect(docStore.reconcileNow('d1')).toBe('apply');
      expect(docStore.getDoc('d1')?.plainText).toContain('second external edit');

      // And nothing may flush a stale copy back over it.
      // timed: the write-back fires at ~800ms, so only a fully elapsed
      // window can say a stale copy never landed.
      await sleep(pastWriteBack());
      expect(readFileSync(path, 'utf8')).toContain('second external edit');
    });

    it('reparse_from_disk cancels a pending conflict reassert so disk keeps the forced version', async () => {
      // A genuine conflict: un-flushed live edit + external write.
      expect(
        docStore.findAndReplace('d1', {
          find: 'Intro paragraph.',
          replace: 'Live edit, not yet flushed.',
        }).ok,
      ).toBe(true);
      writeExternal(path, EXT_ONE);
      expect(docStore.reconcileNow('d1')).toBe('conflict');

      // The agent decides disk should win and force-pulls it. The conflict
      // path scheduled a reassert write — reparse must cancel it, or ~800ms
      // later the server rewrites the file (this is the "stale in-memory copy
      // flushed to disk" step of the 2026-08-03 incident).
      expect(docStore.reparseFromDisk('d1').ok).toBe(true);
      // timed: the cancelled reassert would have fired at ~800ms; the file can
      // only be believed byte-identical once that moment has passed.
      await sleep(pastWriteBack());
      // Byte-identical: no post-reparse write-back may renormalize the file.
      expect(readFileSync(path, 'utf8')).toBe(EXT_ONE);
    });
  });

  describe('RC2 — no blind, unrecoverable overwrites', () => {
    it('backs up the external version before a conflict reasserts live edits', async () => {
      expect(
        docStore.findAndReplace('d1', {
          find: 'Intro paragraph.',
          replace: 'Live edit, not yet flushed.',
        }).ok,
      ).toBe(true);
      writeExternal(path, EXT_ONE);
      expect(docStore.reconcileNow('d1')).toBe('conflict');

      // Policy: live wins on disk...
      await waitForFile(path, (t) => t.includes('Live edit, not yet flushed.'));
      // ...but the external version must survive somewhere, or "recoverable
      // with reparse_from_disk" is a lie (disk was already overwritten).
      const backupDir = join(dataDir, 'clobber-backups');
      expect(existsSync(backupDir)).toBe(true);
      const backups = readdirSync(backupDir);
      expect(backups.length).toBeGreaterThan(0);
      const backedUp = backups.map((f) => readFileSync(join(backupDir, f), 'utf8'));
      expect(backedUp.some((c) => c.includes('first external edit'))).toBe(true);
      // The doc reports WHY and WHERE, so an agent can recover.
      const syncError = docStore.getSyncError('d1');
      expect(syncError?.message).toContain('clobber-backups');
    });

    it('stats before writing: an external write inside the debounce window is not silently lost', async () => {
      expect(
        docStore.findAndReplace('d1', {
          find: 'Intro paragraph.',
          replace: 'Live edit racing the external write.',
        }).ok,
      ).toBe(true);
      // Land the external write just before the 800ms write-back fires, in
      // the window after the poll's last tick. Pre-fix the writer overwrites
      // it with zero trace.
      // timed: the write has to land INSIDE the 800ms window, after the
      // poll's last tick — the delay is the thing being set up, not a wait.
      await sleep(insideWriteBack());
      writeExternal(path, EXT_ONE);

      const backupDir = join(dataDir, 'clobber-backups');
      const backedUp = await waitFor(
        () => {
          if (!existsSync(backupDir)) return false;
          const found = readdirSync(backupDir).map((f) => readFileSync(join(backupDir, f), 'utf8'));
          return found.some((c) => c.includes('first external edit')) ? found : false;
        },
        { describe: 'the racing external write to be backed up' },
      );
      expect(backedUp.some((c) => c.includes('first external edit'))).toBe(true);
      expect(docStore.getSyncError('d1')).toBeDefined();
    });
  });

  describe('disk wins at rest — attach/hydrate gap', () => {
    it('picks up an edit made while the server was down', async () => {
      // Flush a live edit so the .ydoc has non-empty state on disk.
      expect(
        docStore.findAndReplace('d1', { find: 'Intro paragraph.', replace: 'Flushed edit.' }).ok,
      ).toBe(true);
      await waitForFile(path, (t) => t.includes('Flushed edit.'));

      // "Server goes down" — and it has to ACTUALLY go down, because this
      // store is the one whose absence the test is about. Left running it
      // keeps polling the same file, and on a loaded runner its poll reads the
      // external write as a conflict and reasserts its own live content over
      // it (measured: the file reverts ~100ms after the write, with the
      // external version moved into clobber-backups). After that the wait
      // below cannot succeed at any budget — disk no longer holds the edit —
      // which is how this failed in CI: `last value: false` at the timeout,
      // not a slow arrival.
      docStore.simulateCrash();
      // …the file is edited while it's away.
      writeExternal(path, EXT_ONE.replace('first external edit', 'edited while server was down'));

      // Fresh process over the same dataDir. attachFile used to skip the
      // non-empty fragment entirely and re-baseline the mtime poll — the
      // downtime edit was never seen, and the next flush overwrote it.
      const docStore2 = makeDocStore(dataDir);
      // The hydrate answers now and binds a moment later, off the thread pool
      // (`DocStore.prereadFor`), and the attach-time reconcile this test is about
      // happens with the bind. Waiting is the assertion: a hydrate that never
      // picked disk up would never satisfy it.
      await waitFor(
        () => (docStore2.getDoc('d1')?.plainText ?? '').includes('edited while server was down'),
        { describe: 'the restart hydrate to pick up the edit made while it was down' },
      );
    });

    it('a restart inside the write-back window does not revert the un-flushed edit', async () => {
      // The counter-case to disk-wins-at-rest (codex P1): the .ydoc persists
      // ~200ms after an edit, the .md ~800ms after. A crash in between leaves
      // the hydrated doc NEWER than the file — the attach-time reconcile must
      // compare mtimes and keep the live edit, not revert it from disk.
      expect(
        docStore.findAndReplace('d1', {
          find: 'Intro paragraph.',
          replace: 'Edit persisted to ydoc only.',
        }).ok,
      ).toBe(true);
      // The whole case is a crash BETWEEN the two debounces: the .ydoc saved,
      // the .md write-back never fired. Built, not timed — see
      // `crashAfterPersist`.
      await crashAfterPersist(docStore, dataDir, 'd1', 'Edit persisted to ydoc only.');
      expect(readFileSync(path, 'utf8')).not.toContain('Edit persisted to ydoc only.');
      const docStore2 = makeDocStore(dataDir);
      expect(docStore2.getDoc('d1')?.plainText).toContain('Edit persisted to ydoc only.');
      // And the reassert flushes the live edit to disk.
      await waitForFile(path, (t) => t.includes('Edit persisted to ydoc only.'));
    });

    it('write-back preserves a symlinked bound path', async () => {
      // Rename-onto-path would replace a symlink with a regular file
      // (codex P2) — the write must land through the link at its target.
      const realDir = mkdtempSync(join(tmpdir(), 'cw-real-'));
      try {
        const realPath = join(realDir, 'real.md');
        writeFileSync(realPath, DOC);
        const linkPath = join(dataDir, 'link.md');
        symlinkSync(realPath, linkPath);
        docStore.getOrCreate('s1', { type: 'markdown', sourceUrl: linkPath });
        expect(docStore.attachFile('s1', linkPath).ok).toBe(true);
        expect(
          docStore.findAndReplace('s1', { find: 'Intro paragraph.', replace: 'Through the link.' })
            .ok,
        ).toBe(true);
        await waitForFile(realPath, (t) => t.includes('Through the link.'));
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(realDir, { recursive: true, force: true });
      }
    });

    it('a never-edited doc with pure normalization drift is not rewritten at restart', async () => {
      // Field finding (weekly-review, 2026-08-03): binding stamps the .ydoc
      // AFTER the .md was last written, so every never-edited doc hydrates
      // with ydoc-newer-than-md skew. If its disk bytes differ from the
      // serializer's output only by normalization (blank-line runs etc.),
      // the reassert branch rewrote the file — mtime churn and a byte-level
      // rewrite of a doc nobody touched. Semantically-equal must mean
      // in-sync: no write, no backup, mtime untouched.
      const p2 = join(dataDir, 'never-edited.md');
      writeFileSync(p2, EXT_ONE); // extra blank lines = pure normalization drift
      docStore.getOrCreate('n1', { type: 'markdown', sourceUrl: p2 });
      expect(docStore.attachFile('n1', p2).ok).toBe(true);
      // The skew this test is about is the .ydoc being NEWER than the .md, so
      // wait for that to be true on disk rather than sleeping a length that
      // usually makes it true — a restart that ran before the persist would
      // find no skew and the test would pass having exercised nothing.
      await waitFor(() => statSync(join(dataDir, 'n1.ydoc')).mtimeMs > statSync(p2).mtimeMs, {
        describe: 'the .ydoc snapshot to land after the .md, the skew this test needs',
      });
      const bytesBefore = readFileSync(p2, 'utf8');
      const mtimeBefore = statSync(p2).mtimeMs;
      docStore.simulateCrash(); // it is a RESTART: the old store must not be polling p2

      makeDocStore(dataDir); // restart
      // timed: a wrongly-scheduled reassert would flush at ~800ms, so the
      // "no write happened" claim needs that window to have passed.
      await sleep(pastWriteBack());

      expect(readFileSync(p2, 'utf8')).toBe(bytesBefore);
      expect(statSync(p2).mtimeMs).toBe(mtimeBefore);
      expect(existsSync(join(dataDir, 'clobber-backups'))).toBe(false);
    });

    it('a genuine restart reassert snapshots the disk version it overwrites', async () => {
      // The reassert branch is the ONE writer that replaces disk content the
      // server never backed up — make it symmetric with the apply branch,
      // which snapshots the live side before pulling disk in.
      expect(
        docStore.findAndReplace('d1', { find: 'Intro paragraph.', replace: 'Unflushed edit.' }).ok,
      ).toBe(true);
      // The restart must find the .ydoc saved and the .md un-flushed — that is
      // what makes the reassert fire, and it is built rather than timed.
      await crashAfterPersist(docStore, dataDir, 'd1', 'Unflushed edit.');
      const diskBefore = readFileSync(path, 'utf8');
      expect(diskBefore).not.toContain('Unflushed edit.');

      makeDocStore(dataDir); // restart inside the write-back window
      await waitForFile(path, (t) => t.includes('Unflushed edit.'));
      const backupDir = join(dataDir, 'clobber-backups');
      const backups = readdirSync(backupDir);
      const snapshot = backups.find((f) => readFileSync(join(backupDir, f), 'utf8') === diskBefore);
      expect(snapshot).toBeDefined();
    });

    it('re-attach during the flush window after a suppressed drift is not a false conflict', async () => {
      // Suppression leaves lastWritten in serializer-space while disk keeps
      // its drifty bytes. A later re-attach with un-flushed edits then saw
      // md !== prior and fell into reconcile → 'conflict' → backup +
      // syncError, though disk never changed. Disk that NORMALIZES to prior
      // must re-arm the flush, exactly like md === prior.
      const p2 = join(dataDir, 'drifty.md');
      writeFileSync(p2, EXT_ONE);
      docStore.getOrCreate('r1', { type: 'markdown', sourceUrl: p2 });
      expect(docStore.attachFile('r1', p2).ok).toBe(true);
      // The hydrate has to see the .ydoc as newer than the .md, so wait for
      // that ordering rather than for a duration that usually produces it.
      await waitFor(() => statSync(join(dataDir, 'r1.ydoc')).mtimeMs > statSync(p2).mtimeMs, {
        describe: 'the .ydoc snapshot to land after the .md, the skew the hydrate reads',
      });
      // A restart, so the first store stops: left polling p2 it is a second
      // writer on the file, and the `clobber-backups` assertion below cannot
      // tell its conflict from the false one this test is about.
      docStore.simulateCrash();
      const docStore2 = makeDocStore(dataDir); // suppression fires on hydrate
      // Suppression fires when the deferred bind lands, not when `get`
      // returns — see `DocStore.prereadFor`. Editing before it would be a
      // different test (an edit into the attach gap), and the re-attach below
      // is what this one is about.
      expect(docStore2.get('r1')).toBeDefined();
      await waitFor(() => docStore2.boundPathOf('r1') === p2, {
        describe: 'the hydrate bind that suppresses the normalization drift',
      });
      expect(
        docStore2.findAndReplace('r1', { find: 'first external edit', replace: 'edited live' }).ok,
      ).toBe(true);
      expect(docStore2.attachFile('r1', p2).ok).toBe(true); // inside the 800ms window
      expect(docStore2.getSyncError('r1')).toBeUndefined();
      expect(existsSync(join(dataDir, 'clobber-backups'))).toBe(false);
      await waitForFile(p2, (t) => t.includes('edited live'));
    });

    it('a normalization-only external save while edits are un-flushed is not a conflict', async () => {
      // Format-on-save rewrites the bound file with different bytes but the
      // same content as our last write. decideReconcile compares bytes, so
      // this classified as 'conflict': backup + syncError + the reassert
      // overwrote the external formatting — while the human was typing.
      expect(
        docStore.findAndReplace('d1', { find: 'Intro paragraph.', replace: 'Live edit pending.' })
          .ok,
      ).toBe(true);
      writeExternal(path, DOC.replace(/\n\n/g, '\n\n\n'));
      expect(docStore.reconcileNow('d1')).toBe('catch-up');
      expect(docStore.getSyncError('d1')).toBeUndefined();
      expect(existsSync(join(dataDir, 'clobber-backups'))).toBe(false);
      await waitForFile(path, (t) => t.includes('Live edit pending.'));
    });

    it('a normalization-only external save with no live edits does not rewrite blocks', () => {
      // The 'apply' path replaces every block whose BYTES changed — for a
      // formatting-only save that breaks anchors in blocks whose content is
      // identical. Semantically-equal disk must read as in-sync (and the
      // file keeps the external formatting at rest).
      writeExternal(path, DOC.replace(/\n\n/g, '\n\n\n'));
      expect(docStore.reconcileNow('d1')).toBe('in-sync');
      expect(docStore.getSyncError('d1')).toBeUndefined();
    });

    it('does not stack duplicate write-back observers on re-attach', () => {
      // observeDeep listeners live in the type's _dEH handler; each leaked
      // observer is a duplicate write-back scheduler with stale binding state.
      // (wireEvents holds one permanent observer of its own, so assert the
      // DELTA across re-attaches, not an absolute count.)
      const fragment = getProseFragment(docStore.get('d1')!.ydoc);
      const count = () => (fragment as unknown as { _dEH: { l: unknown[] } })._dEH.l.length;
      const before = count();
      expect(docStore.attachFile('d1', path).ok).toBe(true);
      expect(docStore.attachFile('d1', path).ok).toBe(true);
      expect(count()).toBe(before);
    });
  });

  describe('RC3 — setDocContent, the legitimate whole-doc rewrite', () => {
    it('rewrites the doc, keeps threads on untouched blocks, and flushes to disk', async () => {
      const created = await docStore.createThreadByFind(
        'd1',
        { find: 'Keep this sentence intact.' },
        AUTHOR,
        'Anchor here.',
      );
      expect(created.ok).toBe(true);

      const next = `# Rewritten title

A completely new introduction.

## Section

Keep this sentence intact.

## Brand new section

With new body text.
`;
      const res = docStore.setDocContent('d1', next);
      expect(res.ok).toBe(true);
      expect(docStore.getDoc('d1')?.plainText).toContain('Brand new section');

      // The thread on the untouched block still resolves.
      const thread = docStore.listThreads('d1')[0];
      const anchor = thread?.anchor as { startRel: Uint8Array; endRel: Uint8Array };
      const ydoc = docStore.get('d1')!.ydoc;
      for (const rel of [anchor.startRel, anchor.endRel]) {
        const abs = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(new Uint8Array(rel)),
          ydoc,
        );
        expect(abs).not.toBeNull();
      }

      // Unlike reparse, this is a doc-side edit: it must flush to disk.
      await waitForFile(path, (t) => t.includes('Brand new section'));
    });

    it('rejects flat (code/diff) docs', () => {
      const codePath = join(dataDir, 'src.ts');
      writeFileSync(codePath, 'export const x = 1;\n');
      docStore.getOrCreate('c1', { type: 'code', sourceUrl: codePath });
      expect(docStore.attachReadonlyFile('c1', codePath).ok).toBe(true);
      expect(docStore.setDocContent('c1', 'nope')).toEqual({ ok: false, error: 'unsupported' });
    });

    it('rejects empty markdown instead of wiping the doc', () => {
      expect(docStore.setDocContent('d1', '   \n')).toEqual({ ok: false, error: 'empty' });
    });
  });
});

describe('sync-clobber HTTP surface', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let path: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-clobber-http-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it(`POST /workspaces/${WS}/docs/:id/content forwards the whole payload (route-layer test per learnings)`, async () => {
    const create = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'h1', type: 'markdown', sourceUrl: path }),
    });
    expect(create.ok).toBe(true);

    const set = await fetch(`${base}/workspaces/${WS}/docs/h1/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# Via HTTP\n\nRouted body.\n' }),
    });
    expect(set.ok).toBe(true);
    expect(((await set.json()) as { ok: boolean }).ok).toBe(true);

    const read = await fetch(`${base}/workspaces/${WS}/docs/h1/content`);
    expect(await read.text()).toContain('Routed body.');
  });

  it('edit responses surface a pending syncError so agents see trouble when they act', async () => {
    const create = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'h2', type: 'markdown', sourceUrl: path }),
    });
    expect(create.ok).toBe(true);
    // `h2` was the NAME the caller chose; the server minted the id. The doc-store
    // handle keys on the canonical one, while the HTTP paths below stay
    // addressed by the readable name — which is the alias contract holding in
    // both directions on one doc.
    const h2 = ((await create.json()) as { docId: string }).docId;

    // Force a genuine conflict through the doc-store handle.
    expect(
      handle.docStore.findAndReplace(h2, { find: 'Intro paragraph.', replace: 'Un-flushed.' }).ok,
    ).toBe(true);
    writeExternal(path, EXT_ONE);
    expect(handle.docStore.reconcileNow(h2)).toBe('conflict');

    const res = await fetch(`${base}/workspaces/${WS}/docs/h2/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'Keep this sentence intact.', replace: 'Changed.' }),
    });
    const body = (await res.json()) as { ok: boolean; syncError?: { message: string } };
    expect(body.ok).toBe(true);
    expect(body.syncError?.message).toBeDefined();

    // Thread-anchored edits are the other common agent path (codex P2) —
    // the recovery signal must ride those responses too.
    const created = await handle.docStore.createThreadByFind(
      h2,
      // The find_and_replace above already rewrote the original sentence.
      { find: 'Changed.' },
      { id: 'u1', kind: 'known', name: 'Reviewer', color: '#000' },
      'Anchor.',
    );
    if (!created.ok) throw new Error('thread create failed');
    const rewrite = await fetch(
      `${base}/workspaces/${WS}/docs/h2/threads/${encodeURIComponent(created.thread.id)}/rewrite_region`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ replacement: 'Rewritten via thread.' }),
      },
    );
    const rewriteBody = (await rewrite.json()) as { ok: boolean; syncError?: { message: string } };
    expect(rewriteBody.ok).toBe(true);
    expect(rewriteBody.syncError?.message).toBeDefined();
  });
});
