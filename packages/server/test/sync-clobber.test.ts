import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { getProseFragment } from '../../core/src/prose.ts';
import { Rooms } from '../src/rooms.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

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

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
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

describe('sync-clobber regressions', () => {
  let dataDir: string;
  let path: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-clobber-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    rooms = makeRooms(dataDir);
    rooms.getOrCreate('d1', { type: 'markdown', sourceUrl: path });
    expect(rooms.attachFile('d1', path).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('RC1 — serializer-space bookkeeping', () => {
    it('applies a second external edit instead of misjudging it a conflict', async () => {
      writeExternal(path, EXT_ONE);
      expect(rooms.reconcileNow('d1')).toBe('apply');

      // The live doc has NO un-flushed edits — the only "divergence" is that
      // the serializer normalizes the extra blank lines. The next external
      // edit must therefore be an apply, not a conflict.
      writeExternal(path, EXT_TWO);
      expect(rooms.reconcileNow('d1')).toBe('apply');
      expect(rooms.getDoc('d1')?.plainText).toContain('second external edit');

      // And nothing may flush a stale copy back over it.
      await sleep(1100);
      expect(readFileSync(path, 'utf8')).toContain('second external edit');
    });

    it('reparse_from_disk cancels a pending conflict reassert so disk keeps the forced version', async () => {
      // A genuine conflict: un-flushed live edit + external write.
      expect(
        rooms.findAndReplace('d1', {
          find: 'Intro paragraph.',
          replace: 'Live edit, not yet flushed.',
        }).ok,
      ).toBe(true);
      writeExternal(path, EXT_ONE);
      expect(rooms.reconcileNow('d1')).toBe('conflict');

      // The agent decides disk should win and force-pulls it. The conflict
      // path scheduled a reassert write — reparse must cancel it, or ~800ms
      // later the server rewrites the file (this is the "stale in-memory copy
      // flushed to disk" step of the 2026-08-03 incident).
      expect(rooms.reparseFromDisk('d1').ok).toBe(true);
      await sleep(1100);
      // Byte-identical: no post-reparse write-back may renormalize the file.
      expect(readFileSync(path, 'utf8')).toBe(EXT_ONE);
    });
  });

  describe('RC2 — no blind, unrecoverable overwrites', () => {
    it('backs up the external version before a conflict reasserts live edits', async () => {
      expect(
        rooms.findAndReplace('d1', {
          find: 'Intro paragraph.',
          replace: 'Live edit, not yet flushed.',
        }).ok,
      ).toBe(true);
      writeExternal(path, EXT_ONE);
      expect(rooms.reconcileNow('d1')).toBe('conflict');
      await sleep(1100);

      // Policy: live wins on disk...
      expect(readFileSync(path, 'utf8')).toContain('Live edit, not yet flushed.');
      // ...but the external version must survive somewhere, or "recoverable
      // with reparse_from_disk" is a lie (disk was already overwritten).
      const backupDir = join(dataDir, 'clobber-backups');
      expect(existsSync(backupDir)).toBe(true);
      const backups = readdirSync(backupDir);
      expect(backups.length).toBeGreaterThan(0);
      const backedUp = backups.map((f) => readFileSync(join(backupDir, f), 'utf8'));
      expect(backedUp.some((c) => c.includes('first external edit'))).toBe(true);
      // The doc reports WHY and WHERE, so an agent can recover.
      const syncError = rooms.getSyncError('d1');
      expect(syncError?.message).toContain('clobber-backups');
    });

    it('stats before writing: an external write inside the debounce window is not silently lost', async () => {
      expect(
        rooms.findAndReplace('d1', {
          find: 'Intro paragraph.',
          replace: 'Live edit racing the external write.',
        }).ok,
      ).toBe(true);
      // Land the external write just before the 800ms write-back fires, in
      // the window after the poll's last tick. Pre-fix the writer overwrites
      // it with zero trace.
      await sleep(700);
      writeExternal(path, EXT_ONE);
      await sleep(600);

      const backupDir = join(dataDir, 'clobber-backups');
      const backups = existsSync(backupDir) ? readdirSync(backupDir) : [];
      const backedUp = backups.map((f) => readFileSync(join(backupDir, f), 'utf8'));
      expect(backedUp.some((c) => c.includes('first external edit'))).toBe(true);
      expect(rooms.getSyncError('d1')).toBeDefined();
    });
  });

  describe('disk wins at rest — attach/hydrate gap', () => {
    it('picks up an edit made while the server was down', async () => {
      // Flush a live edit so the .ydoc has non-empty state on disk.
      expect(
        rooms.findAndReplace('d1', { find: 'Intro paragraph.', replace: 'Flushed edit.' }).ok,
      ).toBe(true);
      await sleep(1100);
      expect(readFileSync(path, 'utf8')).toContain('Flushed edit.');

      // "Server goes down"; the file is edited while it's away.
      writeExternal(path, EXT_ONE.replace('first external edit', 'edited while server was down'));

      // Fresh process over the same dataDir. attachFile used to skip the
      // non-empty fragment entirely and re-baseline the mtime poll — the
      // downtime edit was never seen, and the next flush overwrote it.
      const rooms2 = makeRooms(dataDir);
      expect(rooms2.getDoc('d1')?.plainText).toContain('edited while server was down');
    });

    it('a restart inside the write-back window does not revert the un-flushed edit', async () => {
      // The counter-case to disk-wins-at-rest (codex P1): the .ydoc persists
      // ~200ms after an edit, the .md ~800ms after. A crash in between leaves
      // the hydrated doc NEWER than the file — the attach-time reconcile must
      // compare mtimes and keep the live edit, not revert it from disk.
      expect(
        rooms.findAndReplace('d1', {
          find: 'Intro paragraph.',
          replace: 'Edit persisted to ydoc only.',
        }).ok,
      ).toBe(true);
      await sleep(350); // .ydoc saved (200ms debounce); .md write-back (800ms) has NOT run
      const rooms2 = makeRooms(dataDir);
      expect(rooms2.getDoc('d1')?.plainText).toContain('Edit persisted to ydoc only.');
      // And the reassert flushes the live edit to disk.
      await sleep(1100);
      expect(readFileSync(path, 'utf8')).toContain('Edit persisted to ydoc only.');
    });

    it('write-back preserves a symlinked bound path', async () => {
      // Rename-onto-path would replace a symlink with a regular file
      // (codex P2) — the write must land through the link at its target.
      const realDir = mkdtempSync(join(tmpdir(), 'lf-real-'));
      try {
        const realPath = join(realDir, 'real.md');
        writeFileSync(realPath, DOC);
        const linkPath = join(dataDir, 'link.md');
        symlinkSync(realPath, linkPath);
        rooms.getOrCreate('s1', { type: 'markdown', sourceUrl: linkPath });
        expect(rooms.attachFile('s1', linkPath).ok).toBe(true);
        expect(
          rooms.findAndReplace('s1', { find: 'Intro paragraph.', replace: 'Through the link.' }).ok,
        ).toBe(true);
        await sleep(1100);
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(readFileSync(realPath, 'utf8')).toContain('Through the link.');
      } finally {
        rmSync(realDir, { recursive: true, force: true });
      }
    });

    it('does not stack duplicate write-back observers on re-attach', () => {
      // observeDeep listeners live in the type's _dEH handler; each leaked
      // observer is a duplicate write-back scheduler with stale binding state.
      // (wireEvents holds one permanent observer of its own, so assert the
      // DELTA across re-attaches, not an absolute count.)
      const fragment = getProseFragment(rooms.get('d1')!.ydoc);
      const count = () => (fragment as unknown as { _dEH: { l: unknown[] } })._dEH.l.length;
      const before = count();
      expect(rooms.attachFile('d1', path).ok).toBe(true);
      expect(rooms.attachFile('d1', path).ok).toBe(true);
      expect(count()).toBe(before);
    });
  });

  describe('RC3 — setDocContent, the legitimate whole-doc rewrite', () => {
    it('rewrites the doc, keeps threads on untouched blocks, and flushes to disk', async () => {
      const created = await rooms.createThreadByFind(
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
      const res = rooms.setDocContent('d1', next);
      expect(res.ok).toBe(true);
      expect(rooms.getDoc('d1')?.plainText).toContain('Brand new section');

      // The thread on the untouched block still resolves.
      const thread = rooms.listThreads('d1')[0];
      const anchor = thread?.anchor as { startRel: Uint8Array; endRel: Uint8Array };
      const ydoc = rooms.get('d1')!.ydoc;
      for (const rel of [anchor.startRel, anchor.endRel]) {
        const abs = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(new Uint8Array(rel)),
          ydoc,
        );
        expect(abs).not.toBeNull();
      }

      // Unlike reparse, this is a doc-side edit: it must flush to disk.
      await sleep(1100);
      expect(readFileSync(path, 'utf8')).toContain('Brand new section');
    });

    it('rejects flat (code/diff) docs', () => {
      const codePath = join(dataDir, 'src.ts');
      writeFileSync(codePath, 'export const x = 1;\n');
      rooms.getOrCreate('c1', { type: 'code', sourceUrl: codePath });
      expect(rooms.attachReadonlyFile('c1', codePath).ok).toBe(true);
      expect(rooms.setDocContent('c1', 'nope')).toEqual({ ok: false, error: 'unsupported' });
    });

    it('rejects empty markdown instead of wiping the doc', () => {
      expect(rooms.setDocContent('d1', '   \n')).toEqual({ ok: false, error: 'empty' });
    });
  });
});

describe('sync-clobber HTTP surface', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let path: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-clobber-http-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('POST /api/docs/:id/content forwards the whole payload (route-layer test per learnings)', async () => {
    const create = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'h1', type: 'markdown', sourceUrl: path }),
    });
    expect(create.ok).toBe(true);

    const set = await fetch(`${base}/api/docs/h1/content`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '# Via HTTP\n\nRouted body.\n' }),
    });
    expect(set.ok).toBe(true);
    expect(((await set.json()) as { ok: boolean }).ok).toBe(true);

    const read = await fetch(`${base}/api/docs/h1/content`);
    expect(await read.text()).toContain('Routed body.');
  });

  it('edit responses surface a pending syncError so agents see trouble when they act', async () => {
    const create = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'h2', type: 'markdown', sourceUrl: path }),
    });
    expect(create.ok).toBe(true);

    // Force a genuine conflict through the rooms handle.
    expect(
      handle.rooms.findAndReplace('h2', { find: 'Intro paragraph.', replace: 'Un-flushed.' }).ok,
    ).toBe(true);
    writeExternal(path, EXT_ONE);
    expect(handle.rooms.reconcileNow('h2')).toBe('conflict');

    const res = await fetch(`${base}/api/docs/h2/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'Keep this sentence intact.', replace: 'Changed.' }),
    });
    const body = (await res.json()) as { ok: boolean; syncError?: { message: string } };
    expect(body.ok).toBe(true);
    expect(body.syncError?.message).toBeDefined();

    // Thread-anchored edits are the other common agent path (codex P2) —
    // the recovery signal must ride those responses too.
    const created = await handle.rooms.createThreadByFind(
      'h2',
      // The find_and_replace above already rewrote the original sentence.
      { find: 'Changed.' },
      { id: 'u1', kind: 'known', name: 'Reviewer', color: '#000' },
      'Anchor.',
    );
    if (!created.ok) throw new Error('thread create failed');
    const rewrite = await fetch(
      `${base}/api/docs/h2/threads/${encodeURIComponent(created.thread.id)}/rewrite_region`,
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
