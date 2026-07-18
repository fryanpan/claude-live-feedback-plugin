import { describe, expect, it } from 'vitest';
import { type GroupedFile, renderGroupFolderTree } from '../src/diff-nav.ts';

/**
 * The grouped Changed-Files view renders each group's changed files as a
 * compact folder tree (VS Code "Compact Folders"): linear single-child dir
 * chains collapse into one node, branching keeps folders separate, root files
 * stay at root, and each leaf keeps its churn + open-comment badges.
 */

function gf(relPath: string, extra: Partial<GroupedFile> = {}): GroupedFile {
  return {
    docId: relPath,
    name: relPath.split('/').pop() ?? relPath,
    relPath,
    openCount: 0,
    reviewUrl: `/review/${relPath}`,
    diffStatus: 'modified',
    diffAdditions: 1,
    diffDeletions: 0,
    ...extra,
  };
}

/** All folder-node labels, in document order. */
function dirLabels(html: string): string[] {
  const div = document.createElement('div');
  div.innerHTML = html;
  return Array.from(
    div.querySelectorAll<HTMLElement>('li.tree-dir > details > summary > span.tree-name'),
  ).map((el) => el.textContent ?? '');
}

describe('renderGroupFolderTree', () => {
  it('collapses a linear single-child chain into one node', () => {
    const html = renderGroupFolderTree([gf('packages/widget/src/index.ts')], '');
    // The whole chain folds to a single compacted folder node.
    expect(dirLabels(html)).toEqual(['packages/widget/src']);
    expect(html).toContain('<span class="diff-file-name">index.ts</span>');
  });

  it('stops collapsing where a directory branches', () => {
    const html = renderGroupFolderTree([gf('src/a/x.ts'), gf('src/b/y.ts')], '');
    // src branches into a and b, so it is NOT folded into either.
    expect(dirLabels(html)).toEqual(['src', 'a', 'b']);
  });

  it('stops collapsing where a directory also holds a file', () => {
    // src/index.ts sits beside src/util/, so src must not fold into util.
    const html = renderGroupFolderTree([gf('src/index.ts'), gf('src/util/helper.ts')], '');
    expect(dirLabels(html)).toEqual(['src', 'util']);
    expect(html).toContain('<span class="diff-file-name">index.ts</span>');
    expect(html).toContain('<span class="diff-file-name">helper.ts</span>');
  });

  it('keeps a file at the group root at the root (no folder node)', () => {
    const html = renderGroupFolderTree([gf('README.md'), gf('src/a.ts')], '');
    expect(dirLabels(html)).toEqual(['src']); // only src is a folder
    // README.md renders as a diff-file row NOT nested under any folder node.
    const div = document.createElement('div');
    div.innerHTML = `<ul>${html}</ul>`;
    const readme = Array.from(div.querySelectorAll<HTMLElement>('li.diff-file')).find((li) =>
      li.textContent?.includes('README.md'),
    );
    expect(readme).toBeTruthy();
    expect(readme?.closest('li.tree-dir')).toBeNull();
  });

  it('sorts directories before files, each alphabetically', () => {
    const html = renderGroupFolderTree([gf('zeta.ts'), gf('alpha/a.ts'), gf('beta/b.ts')], '');
    // Directories (alpha, beta) come before the root file (zeta.ts).
    const alpha = html.indexOf('alpha');
    const beta = html.indexOf('beta');
    const zeta = html.indexOf('zeta.ts');
    expect(alpha).toBeLessThan(beta);
    expect(beta).toBeLessThan(zeta);
  });

  it('keeps churn and open-comment badges on each leaf file', () => {
    const html = renderGroupFolderTree(
      [gf('src/a.ts', { diffAdditions: 5, diffDeletions: 2, openCount: 3 })],
      '',
    );
    expect(html).toContain('+5');
    expect(html).toContain('−2'); // − (minus sign) 2, as fileRow emits
    expect(html).toContain('badge-open');
    expect(html).toContain('>3<'); // the open-comment count
  });

  it('marks the active file', () => {
    const html = renderGroupFolderTree([gf('src/a.ts'), gf('src/b.ts')], 'src/a.ts');
    expect(html).toMatch(/href="\/review\/src\/a\.ts"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/href="\/review\/src\/b\.ts"[^>]*aria-current="page"/);
  });

  it('creates no directory nodes for a flat group of root files', () => {
    const html = renderGroupFolderTree([gf('a.ts'), gf('b.ts')], '');
    expect(dirLabels(html)).toEqual([]);
    expect(html).toContain('<span class="diff-file-name">a.ts</span>');
    expect(html).toContain('<span class="diff-file-name">b.ts</span>');
  });
});
