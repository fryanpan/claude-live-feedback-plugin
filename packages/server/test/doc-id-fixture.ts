/**
 * A `.ydoc` on disk whose PRIMARY id is a caller-chosen string — the shape
 * every doc created before opaque minting has, and the thing the migration
 * has to keep resolving.
 *
 * Written through the same `initDocMeta` / `writePrivateMeta` the server uses,
 * so the fixture cannot drift from the real on-disk format. The server picks
 * it up at boot via `hydrateFromDisk`, which reads the docId back off the
 * filename.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initDocMeta } from '@feedback/core';
import * as Y from 'yjs';
import { writePrivateMeta } from '../src/private-meta.ts';

export function writeLegacyYdoc(dataDir: string, docId: string, sourceUrl: string): void {
  const ydoc = new Y.Doc();
  initDocMeta(ydoc, {
    docId,
    type: 'markdown',
    createdAt: Date.now(),
  });
  writeFileSync(join(dataDir, `${docId}.ydoc`), Y.encodeStateAsUpdate(ydoc));
  writePrivateMeta(dataDir, docId, { sourceUrl });
}
