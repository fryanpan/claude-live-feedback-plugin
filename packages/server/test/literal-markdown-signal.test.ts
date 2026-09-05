import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@feedback/core';
import * as Y from 'yjs';
import { Rooms } from '../src/rooms.ts';
import { withSyncError } from '../src/routes/docs.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * The signal that did not exist on 2026-09-04.
 *
 * A region of a bound research doc rendered as one paragraph with `###` and
 * `**` on screen. Every write returned ok, the file on disk stayed correct,
 * and the write-back serialized cleanly — so the writing agent had nothing
 * to read. The doc is inspected after each edit and the finding rides the
 * edit response as a `syncError`, which is the surface agents actually read.
 */

const DOC = `# Title

Intro paragraph.

Second paragraph.
`;

describe('a write that leaves literal markdown in the doc reports a syncError', () => {
  let dataDir: string;
  let path: string;
  let rooms: Rooms;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-literalmd-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    rooms = new Rooms({
      dataDir,
      sse: new SseHub(),
      webhooks: createWebhookDispatcher({ onLog: () => {} }),
    });
    rooms.getOrCreate('d1', { type: 'markdown', sourceUrl: path });
    expect(rooms.attachFile('d1', path).ok).toBe(true);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Put markdown syntax into a block as characters — the state the incident
   *  left the doc in, reached here without the verb that used to allow it. */
  function embedLiteral(text: string, at = 0): void {
    const room = rooms.peek('d1');
    if (!room) throw new Error('room not resident');
    const fragment = prose.getProseFragment(room.ydoc);
    const block = fragment.get(2) as Y.XmlElement;
    room.ydoc.transact(() => {
      (block.get(0) as Y.XmlText).insert(at, text);
    }, 'agent');
  }

  it('says nothing while the doc is clean', () => {
    expect(rooms.literalMarkdownSyncError('d1')).toBeUndefined();
    expect(withSyncError(rooms, 'd1', { ok: true })).toEqual({ ok: true });
  });

  it('names the block, the syntax and the verb to use instead', () => {
    embedLiteral('### Sources\n\n');
    const body = withSyncError(rooms, 'd1', { ok: true }) as {
      ok: boolean;
      syncError?: { message: string };
    };
    expect(body.syncError).toBeDefined();
    const message = body.syncError?.message ?? '';
    expect(message).toContain('block 2');
    expect(message).toContain('### Sources');
    expect(message).toContain('insert_blocks_after_thread');
  });

  it('catches a list marker at the head of a line', () => {
    embedLiteral('\n1. First step\n2. Second step', 17);
    expect(rooms.literalMarkdownSyncError('d1')?.message).toContain('ordered-list marker');
  });

  it('leaves an ordinary edit unreported', () => {
    expect(
      rooms.findAndReplace('d1', { find: 'Intro paragraph.', replace: 'Rewritten intro.' }).ok,
    ).toBe(true);
    expect(rooms.literalMarkdownSyncError('d1')).toBeUndefined();
  });
});
