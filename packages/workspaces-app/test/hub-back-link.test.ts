import { describe, expect, it } from 'vitest';
import { buildShell } from '../src/hub/hub-shell.ts';

/**
 * The topbar `←` on the BOARD goes to `/`, the all-workspaces page.
 *
 * On a share or collaboration hostname `/` is not a page: the host guard
 * refuses every path that names no workspace, so the arrow landed a visitor
 * on a raw JSON refusal. A member was given one board and there is nothing
 * above it, so the arrow is left out rather than pointed somewhere it does
 * not belong.
 *
 * The server is the only side that knows which hostname class served the
 * page, so it stamps `data-visitor="1"` on `#hub-root` and the shell reads it.
 */
describe('the board’s back arrow', () => {
  const shellFor = (visitor: boolean): HTMLElement => {
    const root = document.createElement('div');
    root.id = 'hub-root';
    root.dataset.workspaceId = 'w-abc';
    if (visitor) root.dataset.visitor = '1';
    document.body.append(root);
    buildShell(document, root, 'search-revamp', 'w-abc');
    return root;
  };

  it('is there for the owner, and points at the index', () => {
    // The positive control: without it, "absent for a visitor" would pass on
    // a shell that stopped rendering a topbar at all.
    const link = shellFor(false).querySelector('.back-link');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/');
  });

  it('is left out entirely for a share member', () => {
    const root = shellFor(true);
    expect(root.querySelector('.back-link')).toBeNull();
    // …and the rest of the topbar is untouched, so this removed a link and
    // not the header it lived in.
    expect(root.querySelector('.hub-topbar')).not.toBeNull();
    expect(root.querySelector('.hub-ws-name-text')?.textContent).toBe('search-revamp');
  });

  it('treats any other value as the owner — only the server’s own flag hides it', () => {
    for (const value of ['0', 'true', '']) {
      const root = document.createElement('div');
      root.id = 'hub-root';
      root.dataset.visitor = value;
      document.body.append(root);
      buildShell(document, root, 'n', 'w-abc');
      expect(root.querySelector('.back-link'), value).not.toBeNull();
    }
  });
});
