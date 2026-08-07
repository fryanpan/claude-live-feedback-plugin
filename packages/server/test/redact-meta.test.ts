import { describe, expect, it } from 'bun:test';
import type { DocMeta } from '@feedback/core';
import { redactMetaForVisitor, relativeReviewUrl } from '../src/share/redact-meta.ts';

const FULL: DocMeta & { reviewUrl?: string } = {
  docId: 'ws-1:src~a.ts',
  type: 'diff',
  createdAt: 1,
  title: 'src/a.ts',
  relPath: 'src/a.ts',
  workspaceId: 'ws-1',
  setId: 'ws-1',
  sourceUrl: '/Volumes/Data/Users/someone/dev/private-repo/src/a.ts',
  owner: '/Volumes/Data/Users/someone/dev/private-repo',
  workspaceRoot: '/Volumes/Data/Users/someone/dev/private-repo',
  reviewUrl: 'http://host-name.tailnet.ts.net:8787/review/ws-1%3Asrc~a.ts',
  producedBy: { agentId: 'some-agent', sessionId: 'sess-9' },
  diffBase: 'abc123def456',
  diffTarget: 'def456abc789',
  diffStatus: 'modified',
  diffAdditions: 4,
  diffDeletions: 2,
  diffGroup: 'Core',
  diffGroupRank: 0,
  lastActivityAt: 99,
};

describe('redactMetaForVisitor', () => {
  const out = redactMetaForVisitor(FULL, { workspaceScoped: true }) as Record<string, unknown>;

  it('drops every path that describes the host machine', () => {
    for (const k of ['sourceUrl', 'owner', 'workspaceRoot']) {
      expect(out[k]).toBeUndefined();
    }
    // Belt and braces: no absolute path survives anywhere in the payload.
    expect(JSON.stringify(out)).not.toContain('/Volumes/');
  });

  it('drops the tailnet review URL', () => {
    expect(out.reviewUrl).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('tailnet');
  });

  it('drops provenance', () => {
    expect(out.producedBy).toBeUndefined();
  });

  it('KEEPS diffTarget — the client reads it as "this review is pinned"', () => {
    // editable-policy.ts unlocks the editor when diffTarget is empty. Dropping
    // it made every shared pinned review look live and let a visitor type into
    // immutable content — no write-back, but the Yjs doc mutates for everyone.
    // The hashes cost nothing: a visitor is already reading the diff itself.
    expect(out.diffTarget).toBe(FULL.diffTarget);
    expect(out.diffBase).toBe(FULL.diffBase);
  });

  it('leaves a working-tree review looking editable', () => {
    const live = redactMetaForVisitor(
      { ...FULL, diffTarget: undefined },
      { workspaceScoped: true },
    ) as Record<string, unknown>;
    expect(live.diffTarget).toBeUndefined();
  });

  it('keeps what the reviewer actually needs to render the doc', () => {
    expect(out.docId).toBe(FULL.docId);
    expect(out.type).toBe('diff');
    expect(out.relPath).toBe('src/a.ts');
    expect(out.workspaceId).toBe('ws-1');
    expect(out.diffStatus).toBe('modified');
    expect(out.diffAdditions).toBe(4);
    expect(out.diffGroup).toBe('Core');
  });

  it('is an ALLOWLIST — a field added later is redacted by default', () => {
    const withNewField = { ...FULL, someFutureSecret: '/Volumes/secret' } as unknown as DocMeta;
    const res = redactMetaForVisitor(res_in(withNewField), { workspaceScoped: true }) as Record<
      string,
      unknown
    >;
    expect(res.someFutureSecret).toBeUndefined();
  });

  it('withholds workspaceId from a DOC-scoped share of a workspace member', () => {
    // The client reads any non-empty workspaceId as permission to render
    // workspace nav and poll /api/workspaces/<id>/… every 30s — which
    // shareScopeAllows refuses for a doc share. Advertising it buys the
    // visitor a broken sidebar and a loop of 403s.
    const solo = redactMetaForVisitor(FULL) as Record<string, unknown>;
    expect(solo.workspaceId).toBeUndefined();
    expect(solo.setId).toBeUndefined();
    // ...and the doc itself still renders.
    expect(solo.docId).toBe(FULL.docId);
    expect(solo.relPath).toBe('src/a.ts');
    expect(solo.diffStatus).toBe('modified');
  });

  it('keeps a filename so a shared code doc still highlights', () => {
    // The client picks its syntax-highlighting language off this path.
    // Dropping it outright would silently render a visitor's code as plain
    // text — the directories are what we withhold, not the extension.
    const standalone = redactMetaForVisitor({
      docId: 'solo',
      type: 'code',
      createdAt: 1,
      sourceUrl: '/Volumes/Data/Users/someone/dev/private-repo/src/deep/Thing.kt',
    } as DocMeta) as Record<string, unknown>;
    expect(standalone.relPath).toBe('Thing.kt');
    expect(JSON.stringify(standalone)).not.toContain('/Volumes/');
    expect(JSON.stringify(standalone)).not.toContain('private-repo');
  });

  it('prefers the real relPath over the basename when both exist', () => {
    expect((redactMetaForVisitor(FULL) as Record<string, unknown>).relPath).toBe('src/a.ts');
  });

  it('omits absent optionals rather than emitting undefined keys', () => {
    const bare = redactMetaForVisitor({
      docId: 'd',
      type: 'markdown',
      createdAt: 1,
    } as DocMeta) as Record<string, unknown>;
    expect(Object.keys(bare).sort()).toEqual(['createdAt', 'docId', 'type']);
  });
});

// Tiny identity helper so the allowlist test reads clearly.
function res_in<T>(v: T): T {
  return v;
}

describe('relativeReviewUrl', () => {
  it('strips the host so no hostname reaches the visitor', () => {
    expect(relativeReviewUrl('http://host.tailnet.ts.net:8787/review/abc?x=1')).toBe(
      '/review/abc?x=1',
    );
  });

  it('passes an already-relative path through', () => {
    expect(relativeReviewUrl('/review/abc')).toBe('/review/abc');
  });

  it('returns undefined for nothing or nonsense', () => {
    expect(relativeReviewUrl(undefined)).toBeUndefined();
    expect(relativeReviewUrl('not a url')).toBeUndefined();
  });
});
