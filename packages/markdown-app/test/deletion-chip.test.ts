import { prose } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  type LiveRedlineSurface,
  createLiveRedlineEditor,
} from '../src/redline/live-redline-editor.ts';

/**
 * Mobile fallback (<1100px, styles.css): each deletion group also gets an
 * inline "⌫ N lines" tappable chip decoration at its anchor in the live
 * ProseMirror doc — the balloon margin's mobile equivalent, hidden on wide
 * screens via CSS where the balloon already shows the same content. Grouped
 * the same way (`groupDeletions`) so a chip and its balloon always agree on
 * what counts as "one deletion".
 */

const open: Array<{ surface: LiveRedlineSurface; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.surface.destroy();
    o.parent.remove();
  }
});

function mount(baseText: string, md: string, debounceMs = 0) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = createLiveRedlineEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    baseText,
    debounceMs,
  });
  open.push({ surface, parent });
  return { ydoc, fragment, parent, surface };
}

/** Let the (0ms in tests) markup debounce fire and the view repaint. */
const tick = () => new Promise((r) => setTimeout(r, 25));

describe('live markup — mobile deletion chip decoration', () => {
  it('renders one chip at the deletion position with a line-count label', async () => {
    const { parent } = mount('Alpha.\n\nRemoved paragraph.\n\nBravo.\n', 'Alpha.\n\nBravo.\n');
    await tick();
    const chip = parent.querySelector('.lf-del-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('⌫ 1 line');
    expect((chip as HTMLElement).dataset.lfDelText).toContain('Removed paragraph.');
  });

  it('pluralizes the label and joins consecutive deletions into one chip', async () => {
    const { parent } = mount('A.\n\nOne.\n\nTwo.\n\nB.\n', 'A.\n\nB.\n');
    await tick();
    const chips = parent.querySelectorAll('.lf-del-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe('⌫ 2 lines');
  });

  it('collapses two inline deletions in the same paragraph into one chip', async () => {
    const { parent } = mount('Alpha beta gamma delta epsilon.\n', 'Alpha gamma epsilon.\n');
    await tick();
    expect(parent.querySelectorAll('.lf-del-chip')).toHaveLength(1);
  });

  it('renders separate chips for deletions anchored in different paragraphs', async () => {
    const { parent } = mount(
      'One.\n\nFirst removed.\n\nTwo.\n\nSecond removed.\n\nThree.\n',
      'One.\n\nTwo.\n\nThree.\n',
    );
    await tick();
    expect(parent.querySelectorAll('.lf-del-chip')).toHaveLength(2);
  });

  it('renders no chips for an added file (empty base)', async () => {
    const { parent } = mount('', '# New file\n\nBody.\n');
    await tick();
    expect(parent.querySelectorAll('.lf-del-chip')).toHaveLength(0);
  });

  it('is excluded from the editable content model (contenteditable=false)', async () => {
    const { parent } = mount('Kept.\n\nGone.\n', 'Kept.\n');
    await tick();
    const chip = parent.querySelector('.lf-del-chip') as HTMLElement;
    expect(chip.contentEditable).toBe('false');
  });

  it('never shows the deleted text as visible content (only in the data attribute)', async () => {
    const { parent } = mount('Kept.\n\nSecret gone text.\n', 'Kept.\n');
    await tick();
    const chip = parent.querySelector('.lf-del-chip') as HTMLElement;
    expect(chip.textContent).not.toContain('Secret gone text.');
    expect(chip.dataset.lfDelText).toContain('Secret gone text.');
  });
});
