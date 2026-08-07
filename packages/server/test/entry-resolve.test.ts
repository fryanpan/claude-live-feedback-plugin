import { describe, expect, it } from 'bun:test';
import { type EntryCandidate, resolveShareEntry } from '../src/share/entry-resolve.ts';

function m(docId: string, relPath?: string, stale = false): EntryCandidate {
  return { docId, ...(relPath ? { relPath } : {}), ...(stale ? { stale: true } : {}) };
}

describe('resolveShareEntry', () => {
  it('keeps the preferred doc when it is still a member', () => {
    const members = [m('w:a.md', 'a.md'), m('w:README.md', 'README.md')];
    expect(resolveShareEntry('w:a.md', members)).toBe('w:a.md');
  });

  it('falls back to README when the preferred doc is gone', () => {
    // The whole point: the entry file was renamed, so its docId no longer
    // exists. The link must still land somewhere useful.
    const members = [m('w:notes.md', 'notes.md'), m('w:README.md', 'README.md')];
    expect(resolveShareEntry('w:index.md', members)).toBe('w:README.md');
  });

  it('matches README case-insensitively and in a subdirectory', () => {
    expect(resolveShareEntry(undefined, [m('w:x.ts', 'x.ts'), m('w:Readme.MD', 'Readme.MD')])).toBe(
      'w:Readme.MD',
    );
    expect(
      resolveShareEntry(undefined, [m('w:z.ts', 'z.ts'), m('w:docs~README.md', 'docs/README.md')]),
    ).toBe('w:docs~README.md');
  });

  it('prefers a root README over a nested one', () => {
    const members = [m('w:docs~README.md', 'docs/README.md'), m('w:README.md', 'README.md')];
    expect(resolveShareEntry(undefined, members)).toBe('w:README.md');
  });

  it('falls back to the first markdown when there is no README', () => {
    const members = [
      m('w:src~a.ts', 'src/a.ts'),
      m('w:zeta.md', 'zeta.md'),
      m('w:beta.md', 'beta.md'),
    ];
    expect(resolveShareEntry('gone', members)).toBe('w:beta.md');
  });

  it('falls back to the first file of any kind when there is no markdown', () => {
    const members = [m('w:src~b.ts', 'src/b.ts'), m('w:src~a.ts', 'src/a.ts')];
    expect(resolveShareEntry('gone', members)).toBe('w:src~a.ts');
  });

  it('sorts by docId when members carry no relPath', () => {
    expect(resolveShareEntry('gone', [m('w:b'), m('w:a')])).toBe('w:a');
  });

  it('returns null for an empty workspace', () => {
    expect(resolveShareEntry('w:a.md', [])).toBeNull();
  });

  it('skips stale members when a live one exists', () => {
    // A member whose file was deleted still holds its threads, but landing a
    // visitor on a tombstone is a worse first impression than any live file.
    const members = [m('w:README.md', 'README.md', true), m('w:guide.md', 'guide.md')];
    expect(resolveShareEntry(undefined, members)).toBe('w:guide.md');
  });

  it('abandons a STALE preferred doc for a live member', () => {
    // The rescue case: the sharer picked the entry, then the entry file was
    // renamed away. Landing on the tombstone is what this exists to avoid.
    const members = [m('w:index.md', 'index.md', true), m('w:guide.md', 'guide.md')];
    expect(resolveShareEntry('w:index.md', members)).toBe('w:guide.md');
  });

  it('honours a preferred doc even when stale, if it is the only thing left', () => {
    const members = [m('w:README.md', 'README.md', true)];
    expect(resolveShareEntry('w:README.md', members)).toBe('w:README.md');
  });

  it('still resolves when every member is stale', () => {
    const members = [m('w:b.md', 'b.md', true), m('w:a.md', 'a.md', true)];
    expect(resolveShareEntry('gone', members)).toBe('w:a.md');
  });
});
