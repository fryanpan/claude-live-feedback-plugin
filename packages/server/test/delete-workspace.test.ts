import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocStore } from '../src/doc-store.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

function makeDocStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

/** Materialize a whole folder as workspace members — bindFolder now binds
 *  lazily (entry only), so tests that need every file as a doc open the
 *  rest explicitly, mirroring what a reviewer clicking through does. */
async function bindAllFiles(
  docStore: DocStore,
  folderPath: string,
  owner?: string,
): Promise<
  | {
      ok: true;
      workspaceId: string;
      root: string;
      fileCount: number;
      files: Array<{ docId: string; relPath: string; type: string; title: string }>;
    }
  | { ok: false }
> {
  const bound = await docStore.bindFolder({ folderPath, owner });
  if (!bound.ok) return { ok: false };
  const all = docStore.listRepoFiles(bound.workspaceId);
  const files: Array<{ docId: string; relPath: string; type: string; title: string }> = [];
  for (const f of all.files ?? []) {
    const opened = await docStore.openContextFile(bound.workspaceId, f.relPath);
    if (opened.ok) {
      files.push({
        docId: opened.docId,
        relPath: f.relPath,
        type: docStore.get(opened.docId)?.meta.type ?? 'code',
        title: f.relPath,
      });
    }
  }
  return {
    ok: true,
    workspaceId: bound.workspaceId,
    root: bound.root,
    fileCount: files.length,
    files,
  };
}

describe('DocStore.deleteWorkspace + listWorkspaces', () => {
  let dataDir: string;
  let folder: string;
  let docStore: DocStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'dw-data-'));
    folder = mkdtempSync(join(tmpdir(), 'dw-src-'));
    docStore = makeDocStore(dataDir);
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'README.md'), '# Project\n\nthe unique md line\n');
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const answer = 42;\n');
    writeFileSync(join(folder, 'src', 'data.json'), '{"key":"value"}\n');
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('returns not-found for an unknown workspaceId', () => {
    const res = docStore.deleteWorkspace('nope');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('deletes every member doc when no member has open threads', async () => {
    const bound = await bindAllFiles(docStore, folder, '/cwd');
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const before = docStore.list().length;
    expect(before).toBe(3);

    const res = docStore.deleteWorkspace(bound.workspaceId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deleted).toBe(3);
    // Every member room is gone.
    expect(docStore.list().length).toBe(0);
    for (const f of bound.files) expect(docStore.get(f.docId)).toBeUndefined();
  });

  it('all-or-nothing guardrail: one open thread aborts the WHOLE delete', async () => {
    const bound = await bindAllFiles(docStore, folder, '/cwd');
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const mdDocId = bound.files.find((f) => f.relPath === 'README.md')!.docId;

    // Open a thread on exactly one member file.
    const created = await docStore.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
      'keep this',
    );
    expect(created.ok).toBe(true);

    const res = docStore.deleteWorkspace(bound.workspaceId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('has-open-threads');
    if (res.error !== 'has-open-threads') return;
    // Only the offending file is reported, with its open count.
    expect(res.files).toEqual([{ docId: mdDocId, openThreads: 1 }]);
    // NOTHING was deleted — all three member docs survive.
    expect(docStore.list().length).toBe(3);
    for (const f of bound.files) expect(docStore.get(f.docId)).toBeTruthy();
  });

  it('force deletes all members even with open threads', async () => {
    const bound = await bindAllFiles(docStore, folder, '/cwd');
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const mdDocId = bound.files.find((f) => f.relPath === 'README.md')!.docId;
    await docStore.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
      'keep this',
    );

    const res = docStore.deleteWorkspace(bound.workspaceId, { force: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deleted).toBe(3);
    expect(docStore.list().length).toBe(0);
  });

  it('listWorkspaces rolls up fileCount + openThreads + owner', async () => {
    const bound = await bindAllFiles(docStore, folder, '/cwd');
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const mdDocId = bound.files.find((f) => f.relPath === 'README.md')!.docId;
    await docStore.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
      'expand',
    );

    const ws = docStore.listWorkspaces();
    expect(ws.length).toBe(1);
    const w = ws[0]!;
    expect(w.workspaceId).toBe(bound.workspaceId);
    expect(w.fileCount).toBe(3);
    expect(w.openThreads).toBe(1);
    expect(w.owner).toBe('/cwd');
    expect(w.root).toBe(bound.root);
  });

  it('listWorkspaces.allIdle is true only when every member is idle >24h', async () => {
    const bound = await bindAllFiles(docStore, folder, '/cwd');
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    // Fresh bind: lastActivityAt is ~now, so with now=now nothing is idle.
    const liveNow = docStore.listWorkspaces(Date.now());
    expect(liveNow[0]!.allIdle).toBe(false);

    // Pretend it's far in the future — every member is now idle >24h.
    const future = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const idle = docStore.listWorkspaces(future);
    expect(idle[0]!.allIdle).toBe(true);
  });
});
