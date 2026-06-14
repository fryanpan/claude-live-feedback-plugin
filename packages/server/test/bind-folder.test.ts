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
  });
}

describe('Rooms.bindFolder', () => {
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

  it('errors not-found for a missing folder', () => {
    const res = rooms.bindFolder({ folderPath: join(folder, 'nope') });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-found');
  });

  it('creates one doc per supported file with relPath + type, skipping junk dirs and binaries', () => {
    // Supported files
    writeFileSync(join(folder, 'README.md'), '# Hello\n\nbody\n');
    writeFileSync(join(folder, 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(folder, 'data.json'), '{"a":1}\n');
    // Nested supported file
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'util.ts'), 'export const y = 2;\n');
    // Unsupported extension — ignored entirely (not even in skipped)
    writeFileSync(join(folder, 'notes.txt'), 'plain\n');
    // Skipped dirs (readdir fallback path — no git repo here)
    mkdirSync(join(folder, 'node_modules'));
    writeFileSync(join(folder, 'node_modules', 'dep.js'), 'module.exports = {}\n');
    mkdirSync(join(folder, '.git'));
    writeFileSync(join(folder, '.git', 'config.js'), 'x\n');
    // Too-big file
    writeFileSync(join(folder, 'big.js'), 'a'.repeat(512 * 1024 + 1));
    // Binary file (NUL byte) with a code extension
    writeFileSync(join(folder, 'bin.json'), Buffer.from([0x7b, 0x00, 0x7d]));

    const res = rooms.bindFolder({ folderPath: folder, owner: '/cwd' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const byRel = new Map(res.files.map((f) => [f.relPath, f]));
    expect([...byRel.keys()].sort()).toEqual(['README.md', 'data.json', 'index.ts', 'src/util.ts']);
    expect(byRel.get('README.md')?.type).toBe('markdown');
    expect(byRel.get('index.ts')?.type).toBe('code');
    expect(byRel.get('data.json')?.type).toBe('code');
    expect(res.fileCount).toBe(4);

    // node_modules + .git contents never appear
    expect(res.files.some((f) => f.relPath.includes('node_modules'))).toBe(false);
    expect(res.files.some((f) => f.relPath.includes('.git'))).toBe(false);

    // big + binary recorded in skipped
    const reasons = new Map(res.skipped.map((s) => [s.path, s.reason]));
    expect(reasons.get('big.js')).toBe('too-large');
    expect(reasons.get('bin.json')).toBe('binary');

    // Docs actually exist and carry workspace metadata.
    const file = byRel.get('src/util.ts')!;
    expect(file.docId).toContain(':');
    const room = rooms.get(file.docId);
    expect(room).toBeTruthy();
    expect(room?.meta.workspaceId).toBe(res.workspaceId);
    expect(room?.meta.relPath).toBe('src/util.ts');
    expect(room?.meta.workspaceRoot).toBe(res.root);
    expect(room?.meta.setId).toBe(res.workspaceId);
  });

  it('is idempotent — re-binding maps to the same docIds', () => {
    writeFileSync(join(folder, 'a.ts'), 'const a = 1;\n');
    const first = rooms.bindFolder({ folderPath: folder });
    const second = rooms.bindFolder({ folderPath: folder });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.files[0]!.docId).toBe(second.files[0]!.docId);
    expect(first.workspaceId).toBe(second.workspaceId);
  });

  it('guardrail: too-many-files returns without creating any docs', () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(folder, `f${i}.ts`), `const f = ${i};\n`);
    }
    const before = rooms.list().length;
    const res = rooms.bindFolder({ folderPath: folder, maxFiles: 3 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('too-many-files');
    expect(res.fileCount).toBe(5);
    // Nothing created.
    expect(rooms.list().length).toBe(before);
  });
});
