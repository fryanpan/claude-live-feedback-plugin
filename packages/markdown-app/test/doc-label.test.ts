import { describe, expect, it } from 'vitest';
import { docLabel } from '../src/review-chrome.ts';

/**
 * The topbar label used to come from the Yjs meta map's `sourceUrl`. That key
 * left the CRDT (it named a path on the host, and the CRDT syncs to share
 * visitors), which would have silently demoted every untitled file-backed doc
 * to its opaque docId. The path now arrives from the REST meta as `labelHint`.
 */
describe('docLabel', () => {
  it('labels a diff doc with its repo-relative path', () => {
    expect(
      docLabel({
        type: 'diff',
        relPath: 'src/a.ts',
        labelHint: '/Volumes/Data/repo/src/a.ts',
        docId: 'rev1:src~a.ts',
      }),
    ).toBe('src/a.ts');
  });

  it('gives the owner the same full path as before', () => {
    // The regression this guards: no title, no relPath, sourceUrl no longer in
    // the CRDT — the label fell through to the docId.
    expect(
      docLabel({ type: 'markdown', labelHint: '/Volumes/Data/repo/notes.md', docId: 'shared' }),
    ).toBe('/Volumes/Data/repo/notes.md');
  });

  it('gives a share visitor the basename, never the docId', () => {
    // A visitor's redacted meta has no sourceUrl; relPath is the basename, and
    // the router passes it through as the hint.
    expect(docLabel({ type: 'markdown', labelHint: 'notes.md', docId: 'shared' })).toBe('notes.md');
  });

  it('prefers an explicit title when there is no path at all', () => {
    expect(docLabel({ type: 'markdown', title: 'Launch plan', docId: 'd1' })).toBe('Launch plan');
  });

  it('falls back to the docId only when nothing else exists', () => {
    expect(docLabel({ type: 'markdown', docId: 'd1' })).toBe('d1');
  });

  it('prefers the hint over the title for file-backed docs', () => {
    // Matches the pre-change order (sourceUrl ?? title), so a doc that has both
    // keeps labelling by path.
    expect(docLabel({ type: 'markdown', labelHint: '/repo/notes.md', title: 'Notes' })).toBe(
      '/repo/notes.md',
    );
  });

  it('falls back to the hint for a diff doc that somehow has no relPath', () => {
    // Degenerate, but it's what the pre-change order did (sourceUrl next), and
    // a path beats an opaque id.
    expect(
      docLabel({ type: 'diff', labelHint: '/Volumes/Data/repo/src/a.ts', title: 'a.ts' }),
    ).toBe('/Volumes/Data/repo/src/a.ts');
  });
});
