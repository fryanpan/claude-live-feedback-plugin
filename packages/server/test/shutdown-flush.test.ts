import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../src/rooms.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * Graceful shutdown must flush the debounced persistence timers — the 200ms
 * `.ydoc` save and the ~800ms bound-file write-back. Before this suite,
 * `handle.stop()` flushed taskProjection and taskStore but never Rooms, so a
 * SIGTERM (what the deploy path sends; bin.ts routes it through
 * `handle.stop()`) lost exactly as much just-typed content as a SIGKILL.
 *
 * The two death models here:
 *  - SIGKILL-shaped: the process vanishes mid-debounce; nothing runs. We
 *    model it by simply abandoning the Rooms instance and re-hydrating a
 *    fresh one from the same dataDir.
 *  - SIGTERM-shaped: bin.ts awaits `handle.stop()`. We call it directly.
 */

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lf-shutdown-'));
  dirs.push(d);
  return d;
}

let handles: ServerHandle[] = [];

afterEach(async () => {
  for (const h of handles) {
    try {
      await h.stop();
    } catch {}
  }
  handles = [];
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

describe('shutdown flush of room save timers', () => {
  it('SIGKILL-shaped death inside the 200ms debounce window loses the burst (the loss window is real)', () => {
    const dataDir = tempDir();
    const rooms = makeRooms(dataDir);
    const room = rooms.getOrCreate('burst-doc', { type: 'code' });
    room.ydoc.getText('content').insert(0, 'burst-typed-just-before-death');
    // No stop, no wait: the 200ms save timer never fires. A fresh hydrate
    // from the same dataDir must NOT see the burst — this is the positive
    // premise the SIGTERM test below differs from.
    const rehydrated = makeRooms(dataDir).getOrCreate('burst-doc', { type: 'code' });
    expect(rehydrated.ydoc.getText('content').toString()).not.toContain(
      'burst-typed-just-before-death',
    );
  });

  it('graceful stop() flushes the 200ms .ydoc debounce — SIGTERM now keeps the burst SIGKILL loses', async () => {
    // Named red test: remove the rooms flush from handle.stop() and this
    // fails, because the burst dies inside the debounce window.
    const dataDir = tempDir();
    const handle = createServer({ port: 0, dataDir });
    handles.push(handle);
    const room = handle.rooms.getOrCreate('burst-doc', { type: 'code' });
    room.ydoc.getText('content').insert(0, 'burst-typed-just-before-death');
    await handle.stop();
    const rehydrated = makeRooms(dataDir).getOrCreate('burst-doc', { type: 'code' });
    expect(rehydrated.ydoc.getText('content').toString()).toContain(
      'burst-typed-just-before-death',
    );
  });

  it('positive control: 2000ms idle keeps the content under BOTH death models', async () => {
    const killDir = tempDir();
    const termDir = tempDir();
    const killRooms = makeRooms(killDir);
    killRooms
      .getOrCreate('idle-doc', { type: 'code' })
      .ydoc.getText('content')
      .insert(0, 'settled-content');
    const handle = createServer({ port: 0, dataDir: termDir });
    handles.push(handle);
    handle.rooms
      .getOrCreate('idle-doc', { type: 'code' })
      .ydoc.getText('content')
      .insert(0, 'settled-content');
    // Let the 200ms debounce fire on its own — the idle path must not depend
    // on the shutdown flush at all.
    await sleep(2000);
    const afterKill = makeRooms(killDir).getOrCreate('idle-doc', { type: 'code' });
    expect(afterKill.ydoc.getText('content').toString()).toContain('settled-content');
    await handle.stop();
    const afterTerm = makeRooms(termDir).getOrCreate('idle-doc', { type: 'code' });
    expect(afterTerm.ydoc.getText('content').toString()).toContain('settled-content');
  });

  it('a bound .md with an un-flushed ~800ms write-back lands on disk on the graceful path', async () => {
    const dataDir = tempDir();
    const docsDir = tempDir();
    const mdPath = join(docsDir, 'note.md');
    writeFileSync(mdPath, '# Title\n\nOriginal paragraph.\n');
    const handle = createServer({ port: 0, dataDir });
    handles.push(handle);
    handle.rooms.getOrCreate('bound-doc', { type: 'markdown' });
    const attached = handle.rooms.attachFile('bound-doc', mdPath);
    expect(attached.ok).toBe(true);
    const set = handle.rooms.setDocContent(
      'bound-doc',
      '# Title\n\nEdited just before shutdown.\n',
    );
    expect(set.ok).toBe(true);
    // The edit is now inside the 800ms write-back debounce. Stop must not
    // strand it in memory.
    await handle.stop();
    expect(readFileSync(mdPath, 'utf8')).toContain('Edited just before shutdown.');
  });
});
