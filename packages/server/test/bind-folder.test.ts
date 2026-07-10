import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

/**
 * bind_folder is now an alias for a BROWSE-mode workspace (bindDiff without
 * a base): one eagerly-bound entry doc, everything else lazily opened via
 * openContextFile. These tests cover the new contract.
 */
describe('Rooms.bindFolder (browse-mode alias)', () => {
  let dataDir: string;
  let folder: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'bf-data-'));
    folder = mkdtempSync(join(tmpdir(), 'bf-src-'));
    rooms = makeRooms(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  function seedFolder(): void {
    writeFileSync(join(folder, 'README.md'), '# Hello\n\nbody\n');
    writeFileSync(join(folder, 'index.ts'), 'export const x = 1;\n');
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'util.ts'), 'export const y = 2;\n');
  }

  it('errors not-found for a missing folder', () => {
    const res = rooms.bindFolder({ folderPath: join(folder, 'nope') });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('binds ONE entry doc (README preferred, editable markdown); fileCount is the scan count', () => {
    seedFolder();
    const res = rooms.bindFolder({ folderPath: folder, owner: '/cwd' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.fileCount).toBe(3); // scan count, not bound-docs count
    expect(res.files).toHaveLength(1); // only the entry binds eagerly
    expect(res.files[0]?.relPath).toBe('README.md');
    expect(res.files[0]?.type).toBe('markdown');

    const entry = rooms.get(res.files[0]?.docId ?? '');
    expect(entry?.meta.workspaceId).toBe(res.workspaceId);
    expect(entry?.meta.workspaceRoot).toBe(res.root);
    // Markdown entry is EDITABLE (prose-bound, not flat content).
    expect(entry?.meta.type).toBe('markdown');
  });

  it('remaining files open lazily with md → editable markdown, code → read-only', () => {
    seedFolder();
    const res = rooms.bindFolder({ folderPath: folder });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const code = rooms.openContextFile(res.workspaceId, 'src/util.ts');
    expect(code.ok).toBe(true);
    if (!code.ok) return;
    expect(rooms.get(code.docId)?.meta.type).toBe('code');
    expect(rooms.get(code.docId)?.ydoc.getText('content').toString()).toContain('const y = 2');

    // Re-open is idempotent.
    const again = rooms.openContextFile(res.workspaceId, 'src/util.ts');
    expect(again.ok && again.docId === code.docId).toBe(true);

    // listRepoFiles surfaces everything, none marked changed (no diff).
    const all = rooms.listRepoFiles(res.workspaceId);
    expect(all.ok).toBe(true);
    expect((all.files ?? []).map((f) => f.relPath).sort()).toEqual([
      'README.md',
      'index.ts',
      'src/util.ts',
    ]);
    expect((all.files ?? []).every((f) => !f.changed)).toBe(true);
  });

  it('is idempotent — re-binding maps to the same workspace + entry doc', () => {
    seedFolder();
    const a = rooms.bindFolder({ folderPath: folder });
    const b = rooms.bindFolder({ folderPath: folder });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.workspaceId).toBe(a.workspaceId);
    expect(b.files[0]?.docId).toBe(a.files[0]?.docId);
  });

  it('empty folder is a degenerate success (no entry to bind)', () => {
    const res = rooms.bindFolder({ folderPath: folder });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fileCount).toBe(0);
    expect(res.files).toHaveLength(0);
  });

  it('workspace tree still rolls up counts across lazily-opened members', async () => {
    seedFolder();
    const res = rooms.bindFolder({ folderPath: folder });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const opened = rooms.openContextFile(res.workspaceId, 'src/util.ts');
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const created = await rooms.createThreadByFind(
      opened.docId,
      { find: 'const y = 2' },
      { id: 'u1', name: 'T', kind: 'known', color: '#000' },
      'why 2?',
    );
    expect(created.ok).toBe(true);
    const tree = rooms.buildWorkspaceTree(res.workspaceId);
    expect(tree.totalOpen).toBe(1);
  });
});
