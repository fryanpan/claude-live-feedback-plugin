import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createThread,
  getContent,
  initDocMeta,
  listThreads,
  markOrphan,
  postReply,
  readDocMeta,
  replaceAnchor,
  setStatus,
} from '../src/schema.ts';
import type { Anchor, User } from '../src/types.ts';

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const agent: User = { id: 'known-agent', name: 'Agent', kind: 'known', color: '#e36f1e' };

const sampleAnchor: Anchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: { 'aria-label': 'Submit' },
    classes: ['btn', 'primary'],
    text: 'Submit',
    path: 'BUTTON[0] > FORM[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Submit' },
};

describe('schema', () => {
  it('persists and reads doc meta', () => {
    const doc = new Y.Doc();
    initDocMeta(doc, { docId: 'd1', type: 'markdown', createdAt: 1, sourceUrl: '/x.md' });
    const m = readDocMeta(doc);
    expect(m.docId).toBe('d1');
    expect(m.type).toBe('markdown');
    // sourceUrl is deliberately NOT persisted into the CRDT: the whole doc
    // syncs to every client, share visitors included, and an absolute host
    // path is exactly what they must not receive. The server keeps it in a
    // sidecar (server/src/private-meta.ts).
    expect(m.sourceUrl).toBeUndefined();
  });

  it('keeps host-describing fields out of the CRDT entirely', () => {
    const doc = new Y.Doc();
    initDocMeta(doc, {
      docId: 'd2',
      type: 'markdown',
      createdAt: 1,
      title: 'Public title',
      relPath: 'notes.md',
      sourceUrl: '/Volumes/Data/private/notes.md',
      owner: '/Volumes/Data/private',
      workspaceRoot: '/Volumes/Data/private',
      producedBy: { agentId: 'some-agent', sessionId: 's1' },
    });
    const raw = JSON.stringify((doc.getMap('meta') as Y.Map<unknown>).toJSON());
    expect(raw).not.toContain('/Volumes/');
    expect(raw).not.toContain('some-agent');
    // ...while everything that describes the DOCUMENT still round-trips.
    const m = readDocMeta(doc);
    expect(m.title).toBe('Public title');
    expect(m.relPath).toBe('notes.md');
  });

  it('persists code-doc workspace fields', () => {
    const doc = new Y.Doc();
    initDocMeta(doc, {
      docId: 'ws1:src~a.ts',
      type: 'code',
      createdAt: 2,
      sourceUrl: '/repo/src/a.ts',
      setId: 'ws1',
      workspaceId: 'ws1',
      workspaceRoot: '/repo',
      relPath: 'src/a.ts',
    });
    const m = readDocMeta(doc);
    expect(m.type).toBe('code');
    expect(m.workspaceId).toBe('ws1');
    expect(m.relPath).toBe('src/a.ts');
    // workspaceRoot is private (see above) — it names a directory on the host.
    expect(m.workspaceRoot).toBeUndefined();
  });

  it('persists diff-doc fields', () => {
    const doc = new Y.Doc();
    initDocMeta(doc, {
      docId: 'rev1:src~a.ts',
      type: 'diff',
      createdAt: 3,
      setId: 'rev1',
      workspaceId: 'rev1',
      workspaceRoot: '/repo',
      relPath: 'src/a.ts',
      diffBase: 'aaa111',
      diffTarget: 'bbb222',
      diffStatus: 'renamed',
      diffOldPath: 'src/old.ts',
      diffAdditions: 12,
      diffDeletions: 3,
    });
    const m = readDocMeta(doc);
    expect(m.type).toBe('diff');
    expect(m.diffBase).toBe('aaa111');
    expect(m.diffTarget).toBe('bbb222');
    expect(m.diffStatus).toBe('renamed');
    expect(m.diffOldPath).toBe('src/old.ts');
    expect(m.diffAdditions).toBe(12);
    expect(m.diffDeletions).toBe(3);
  });

  it('creates a thread with a first comment', () => {
    const doc = new Y.Doc();
    const t = createThread(doc, {
      threadId: 't1',
      anchor: sampleAnchor,
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'this button is ugly' },
    });
    expect(t.id).toBe('t1');
    expect(t.status).toBe('open');
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]?.author.id).toBe('known-bryan');
    expect(t.comments[0]?.text).toBe('this button is ugly');
  });

  it('listThreads returns all created threads', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor: sampleAnchor,
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'one' },
    });
    createThread(doc, {
      threadId: 't2',
      anchor: sampleAnchor,
      createdBy: agent,
      firstComment: { id: 'c2', text: 'two' },
    });
    const all = listThreads(doc);
    expect(all.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('postReply appends to comments', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor: sampleAnchor,
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'hi' },
    });
    const reply = postReply(doc, 't1', { id: 'c2', author: agent, text: 'fixed' });
    expect(reply?.text).toBe('fixed');
    const [t] = listThreads(doc);
    expect(t?.comments).toHaveLength(2);
    expect(t?.commentCount).toBe(2);
  });

  it('setStatus resolves/reopens', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor: sampleAnchor,
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'x' },
    });
    const resolved = setStatus(doc, 't1', 'resolved');
    expect(resolved?.status).toBe('resolved');
    const reopened = setStatus(doc, 't1', 'open');
    expect(reopened?.status).toBe('open');
  });

  it('markOrphan wraps current anchor', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor: sampleAnchor,
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'x' },
    });
    const t = markOrphan(doc, 't1');
    expect(t?.anchor.kind).toBe('orphan');
    if (t?.anchor.kind === 'orphan') {
      expect(t.anchor.original.kind).toBe('element');
    }
  });

  it('markOrphan is a no-op on already-orphan anchors', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor: sampleAnchor,
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'x' },
    });
    const t1 = markOrphan(doc, 't1');
    const ts1 = t1?.anchor.kind === 'orphan' ? t1.anchor.lastSeenAt : 0;
    const t2 = markOrphan(doc, 't1');
    const ts2 = t2?.anchor.kind === 'orphan' ? t2.anchor.lastSeenAt : 0;
    expect(ts1).toBe(ts2);
  });

  it('replaceAnchor swaps anchor (used on re-anchor)', () => {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 't1',
      anchor: sampleAnchor,
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'x' },
    });
    markOrphan(doc, 't1');
    const t = replaceAnchor(doc, 't1', sampleAnchor);
    expect(t?.anchor.kind).toBe('element');
  });

  it('two Yjs docs converge after exchanging updates', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    createThread(a, {
      threadId: 't1',
      anchor: sampleAnchor,
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'from a' },
    });
    // sync a -> b
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    postReply(b, 't1', { id: 'c2', author: agent, text: 'from b' });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const ta = listThreads(a);
    const tb = listThreads(b);
    expect(ta).toHaveLength(1);
    expect(tb).toHaveLength(1);
    expect(ta[0]?.comments.map((c) => c.text).sort()).toEqual(['from a', 'from b']);
  });

  it('content Y.Text survives concurrent edits', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    getContent(a).insert(0, 'Hello');
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    getContent(a).insert(5, ' A');
    getContent(b).insert(5, ' B');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(getContent(a).toString()).toBe(getContent(b).toString());
  });
});
