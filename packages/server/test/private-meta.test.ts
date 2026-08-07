import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMeta } from '@feedback/core';
import * as Y from 'yjs';
import {
  PRIVATE_META_KEYS,
  isPrivateMetaKey,
  liftPrivateMetaFromYdoc,
  readPrivateMeta,
  writePrivateMeta,
} from '../src/private-meta.ts';

/**
 * The private keys describe the HOST MACHINE, not the document: an absolute
 * `sourceUrl`, the creating agent's cwd (`owner`), the repo root, and the
 * agent/session that produced the doc. `redactMetaForVisitor` strips them from
 * `GET /api/docs/<id>` — but they also lived in the Yjs `meta` map, which the
 * server hands to every client that opens `/y/<docId>`, share visitors
 * included. A visitor holding one link could read the full filesystem layout
 * and private repo names straight off the sync channel. These keys are only
 * ever read server-side, so they move to a sidecar file that never syncs.
 */
describe('private meta keys', () => {
  it('names exactly the host-describing fields', () => {
    expect([...PRIVATE_META_KEYS].sort()).toEqual([
      'owner',
      'producedBy',
      'sourceUrl',
      'workspaceRoot',
    ]);
  });

  it('recognises its own keys and nothing else', () => {
    expect(isPrivateMetaKey('sourceUrl')).toBe(true);
    expect(isPrivateMetaKey('owner')).toBe(true);
    // relPath deliberately stays public — it's the path WITHIN the review,
    // which is the thing being reviewed.
    expect(isPrivateMetaKey('relPath')).toBe(false);
    expect(isPrivateMetaKey('diffBase')).toBe(false);
  });
});

describe('sidecar round-trip', () => {
  it('writes and reads back only the private fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-'));
    writePrivateMeta(dir, 'doc-1', {
      docId: 'doc-1',
      type: 'markdown',
      createdAt: 1,
      title: 'public title',
      relPath: 'src/a.ts',
      sourceUrl: '/Volumes/Data/x/a.ts',
      owner: '/Volumes/Data/x',
      workspaceRoot: '/Volumes/Data/x',
      producedBy: { agentId: 'a', sessionId: 's' },
    });
    const back = readPrivateMeta(dir, 'doc-1');
    expect(back).toEqual({
      sourceUrl: '/Volumes/Data/x/a.ts',
      owner: '/Volumes/Data/x',
      workspaceRoot: '/Volumes/Data/x',
      producedBy: { agentId: 'a', sessionId: 's' },
    });
    // The public fields are NOT duplicated into the sidecar — the ydoc is
    // still their home, and two homes means two versions of the truth.
    const raw = readFileSync(join(dir, 'doc-1.private.json'), 'utf8');
    expect(raw).not.toContain('public title');
    expect(raw).not.toContain('src/a.ts');
  });

  it('omits keys the doc does not have rather than writing nulls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-'));
    writePrivateMeta(dir, 'doc-2', {
      docId: 'doc-2',
      type: 'markdown',
      createdAt: 1,
      sourceUrl: '/x/a.md',
    });
    expect(readPrivateMeta(dir, 'doc-2')).toEqual({ sourceUrl: '/x/a.md' });
  });

  it('returns an empty object when there is no sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-'));
    expect(readPrivateMeta(dir, 'never-written')).toEqual({});
  });

  it('survives a corrupt sidecar instead of taking the room down', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-'));
    writeFileSync(join(dir, 'doc-3.private.json'), '{not json');
    expect(readPrivateMeta(dir, 'doc-3')).toEqual({});
  });

  it('deletes the sidecar when a doc has no private fields left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-'));
    writePrivateMeta(dir, 'doc-4', {
      docId: 'doc-4',
      type: 'markdown',
      createdAt: 1,
      sourceUrl: '/x/a.md',
    });
    writePrivateMeta(dir, 'doc-4', { docId: 'doc-4', type: 'markdown', createdAt: 1 });
    expect(readPrivateMeta(dir, 'doc-4')).toEqual({});
  });
});

describe('liftPrivateMetaFromYdoc (legacy migration)', () => {
  it('reads the legacy values out AND removes them from the CRDT', () => {
    // Every .ydoc persisted before this change carries the private keys in
    // its meta map. Reading them isn't enough — they have to leave the doc,
    // or the next share visitor syncs them anyway.
    const ydoc = new Y.Doc();
    const m = getMeta(ydoc);
    ydoc.transact(() => {
      m.set('docId', 'legacy');
      m.set('type', 'markdown');
      m.set('title', 'Keep me');
      m.set('sourceUrl', '/Volumes/Data/private/notes.md');
      m.set('owner', '/Volumes/Data/private');
      m.set('workspaceRoot', '/Volumes/Data/private');
      m.set('producedBy', { agentId: 'secret-agent', sessionId: 'sess-1' });
    });

    const lifted = liftPrivateMetaFromYdoc(ydoc);

    expect(lifted).toEqual({
      sourceUrl: '/Volumes/Data/private/notes.md',
      owner: '/Volumes/Data/private',
      workspaceRoot: '/Volumes/Data/private',
      producedBy: { agentId: 'secret-agent', sessionId: 'sess-1' },
    });
    for (const k of PRIVATE_META_KEYS) expect(m.has(k)).toBe(false);
    expect(m.get('title')).toBe('Keep me');
    expect(JSON.stringify(m.toJSON())).not.toContain('/Volumes/');
  });

  it('is a no-op on a doc that never had them', () => {
    const ydoc = new Y.Doc();
    const m = getMeta(ydoc);
    ydoc.transact(() => m.set('docId', 'clean'));
    expect(liftPrivateMetaFromYdoc(ydoc)).toEqual({});
    expect(m.get('docId')).toBe('clean');
  });
});
