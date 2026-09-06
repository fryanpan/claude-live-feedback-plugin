import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSidebarSignature } from '../src/sidebar-nav-key.ts';
import { renderWorkspaceTree } from '../src/workspace-tree.ts';

/**
 * The sidebar tree calls a set of attached files an ATTACHMENT SET, never a
 * "review".
 *
 * Glossary Decision 2: "review" means the person-facing queue of review items
 * and nothing else, so a string about membership in a bound folder or a diff
 * has to say attachment. The stale-member tooltip is the one user-visible
 * string in this tree that names the set, and it is reachable only through a
 * hover — no snapshot covers it, which is how it survived the rename pass.
 *
 * The assertion runs the real `renderWorkspaceTree` over a stubbed tree fetch
 * rather than calling the private node renderer, so it fails if the wording
 * moves OR if the stale row stops rendering the tooltip at all.
 */

function mountSidebar(): HTMLElement {
  document.body.innerHTML = `<div id="set-pane"><div id="set-pane-list"></div></div>`;
  return document.getElementById('set-pane-list') as HTMLElement;
}

/** One stale file and one live file, as `/api/reviews/:id/tree` returns them. */
function treeResponse() {
  const file = (name: string, stale: boolean) => ({
    type: 'file',
    docId: `doc-${name}`,
    name,
    relPath: name,
    fileType: 'md',
    openCount: 1,
    threadCount: 1,
    stale,
  });
  return {
    ok: true,
    json: async () => ({
      tree: {
        type: 'dir',
        name: '',
        openCount: 2,
        children: [file('gone.md', true), file('here.md', false)],
      },
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSidebarSignature();
  document.body.innerHTML = '';
  document.body.className = '';
});

describe('the attached-file tree names the attachment set', () => {
  it('tells a reader a stale file left the ATTACHMENT SET, not "this review"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => treeResponse()),
    );
    const list = mountSidebar();

    await renderWorkspaceTree('doc-here.md', 'set-1', true);

    const stale = list.querySelector<HTMLAnchorElement>('a.stale');
    expect(stale).toBeTruthy();
    const tip = stale?.getAttribute('title') ?? '';
    expect(tip).toContain('No longer in this attachment set');
    // The whole point of the rename: the attachment sense of "review" is gone
    // from the string a person actually reads.
    expect(tip.toLowerCase()).not.toContain('review');
  });

  it('puts the tooltip only on the stale row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => treeResponse()),
    );
    const list = mountSidebar();

    await renderWorkspaceTree('doc-here.md', 'set-1', true);

    const live = Array.from(list.querySelectorAll<HTMLAnchorElement>('a')).find(
      (a) => !a.classList.contains('stale'),
    );
    expect(live).toBeTruthy();
    expect(live?.hasAttribute('title')).toBe(false);
  });
});
