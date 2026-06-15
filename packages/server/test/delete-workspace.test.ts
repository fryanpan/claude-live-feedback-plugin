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

describe('Rooms.deleteWorkspace + listWorkspaces', () => {
  let dataDir: string;
  let folder: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'dw-data-'));
    folder = mkdtempSync(join(tmpdir(), 'dw-src-'));
    rooms = makeRooms(dataDir);
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
    const res = rooms.deleteWorkspace('nope');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('deletes every member doc when no member has open threads', () => {
    const bound = rooms.bindFolder({ folderPath: folder, owner: '/cwd' });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const before = rooms.list().length;
    expect(before).toBe(3);

    const res = rooms.deleteWorkspace(bound.workspaceId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deleted).toBe(3);
    // Every member room is gone.
    expect(rooms.list().length).toBe(0);
    for (const f of bound.files) expect(rooms.get(f.docId)).toBeUndefined();
  });

  it('all-or-nothing guardrail: one open thread aborts the WHOLE delete', async () => {
    const bound = rooms.bindFolder({ folderPath: folder, owner: '/cwd' });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const mdDocId = bound.files.find((f) => f.relPath === 'README.md')!.docId;

    // Open a thread on exactly one member file.
    const created = await rooms.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
      'keep this',
    );
    expect(created.ok).toBe(true);

    const res = rooms.deleteWorkspace(bound.workspaceId);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('has-open-threads');
    if (res.error !== 'has-open-threads') return;
    // Only the offending file is reported, with its open count.
    expect(res.files).toEqual([{ docId: mdDocId, openThreads: 1 }]);
    // NOTHING was deleted — all three member docs survive.
    expect(rooms.list().length).toBe(3);
    for (const f of bound.files) expect(rooms.get(f.docId)).toBeTruthy();
  });

  it('force deletes all members even with open threads', async () => {
    const bound = rooms.bindFolder({ folderPath: folder, owner: '/cwd' });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const mdDocId = bound.files.find((f) => f.relPath === 'README.md')!.docId;
    await rooms.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
      'keep this',
    );

    const res = rooms.deleteWorkspace(bound.workspaceId, { force: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deleted).toBe(3);
    expect(rooms.list().length).toBe(0);
  });

  it('listWorkspaces rolls up fileCount + openThreads + owner', async () => {
    const bound = rooms.bindFolder({ folderPath: folder, owner: '/cwd' });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const mdDocId = bound.files.find((f) => f.relPath === 'README.md')!.docId;
    await rooms.createThreadByFind(
      mdDocId,
      { find: 'the unique md line' },
      { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
      'expand',
    );

    const ws = rooms.listWorkspaces();
    expect(ws.length).toBe(1);
    const w = ws[0]!;
    expect(w.workspaceId).toBe(bound.workspaceId);
    expect(w.fileCount).toBe(3);
    expect(w.openThreads).toBe(1);
    expect(w.owner).toBe('/cwd');
    expect(w.root).toBe(bound.root);
  });

  it('listWorkspaces.allIdle is true only when every member is idle >24h', () => {
    const bound = rooms.bindFolder({ folderPath: folder, owner: '/cwd' });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    // Fresh bind: lastActivityAt is ~now, so with now=now nothing is idle.
    const liveNow = rooms.listWorkspaces(Date.now());
    expect(liveNow[0]!.allIdle).toBe(false);

    // Pretend it's far in the future — every member is now idle >24h.
    const future = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const idle = rooms.listWorkspaces(future);
    expect(idle[0]!.allIdle).toBe(true);
  });
});
