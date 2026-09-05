import { prose, suggestOps } from '@feedback/core';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { SuggestDelete, SuggestInsert } from '../src/suggest-marks.ts';
import { SuggestionChips, suggestionChipEnds } from '../src/suggestions/suggestion-chips.ts';
import { mountSuggestionsSummary } from '../src/suggestions/suggestions-summary.ts';

/**
 * Suggestions render OUTSIDE the redline change view.
 *
 * This is what moving `suggestion-chips.ts` and `suggestions-summary.ts` out
 * of `redline/` into `suggestions/` is for (glossary Decision 5): Redline is
 * the change view — struck deletions, marked insertions, margin balloons —
 * while a suggestion is the proposal itself, and the proposal has to reach a
 * reader on the plain markdown surface, on the board's task-body editor, and
 * later inside a mockup, none of which mount a redline module.
 *
 * The file therefore imports nothing from `../src/redline/`, and it asserts
 * both halves of the suggestion UI on a surface that never sets
 * `body.redline-mode`: the per-suggestion chip (an editor decoration from the
 * BASE extension list) and the doc-level "N pending suggestions" badge.
 *
 * A test that merely called the modules would pass from inside `redline/`
 * too, so the mount is a real base-schema Tiptap editor over the same
 * Collaboration → y-prosemirror path the app uses, and the redline-mode class
 * is asserted absent throughout.
 */

const author = { id: 'agent-1', name: 'Docs Agent', color: '#7c5cff' };

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.className = '';
  document.body.innerHTML = '';
});

function docFrom(md: string): Y.Doc {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  return ydoc;
}

/** The PLAIN markdown surface's extension list — the base set from
 *  `editor.ts`, with no redline extension and no redline mount. */
function plainEditorOver(ydoc: Y.Doc): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      SuggestInsert,
      SuggestDelete,
      SuggestionChips,
      Collaboration.configure({ document: ydoc, field: 'prose' }),
    ],
  });
  open.push(() => editor.destroy());
  return editor;
}

function mountTopbarDom(): void {
  document.body.innerHTML = `
    <button
      type="button"
      id="toggle-suggestions"
      class="icon-btn suggestions-toggle hidden"
      aria-haspopup="true"
      aria-expanded="false"
    >
      ✎
      <span id="suggestions-count" class="badge">0</span>
    </button>
    <div id="suggestions-menu" class="suggestions-menu hidden" aria-hidden="true">
      <button type="button" id="suggestions-accept-all">Accept all</button>
      <button type="button" id="suggestions-reject-all">Reject all</button>
    </div>
  `;
}

describe('suggestions render outside the redline view', () => {
  it('mints the ✎ suggestion chip on the plain markdown surface', () => {
    const ydoc = docFrom('Alpha bravo gamma.\n');
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author });
    const editor = plainEditorOver(ydoc);

    // The surface never declares itself a redline one.
    expect(document.body.classList.contains('redline-mode')).toBe(false);

    const chips = editor.view.dom.querySelectorAll('button.cw-suggest-chip');
    expect(chips.length).toBe(1);
    expect(chips[0]?.textContent).toBe('✎ suggestion');
    expect((chips[0] as HTMLElement).dataset.lfSuggestSid).toBeTruthy();
  });

  it('places one chip per proposal, not one per marked range', () => {
    // A replace carries BOTH a suggestDelete and an adjacent suggestInsert
    // under one sid; two chips would be two tap targets for one decision.
    const ydoc = docFrom('Alpha bravo gamma.\n');
    suggestOps.suggestReplace(ydoc, { find: 'bravo', replace: 'BRAVO', author });
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author });
    const editor = plainEditorOver(ydoc);

    expect(editor.view.dom.querySelectorAll('button.cw-suggest-chip').length).toBe(2);
    expect(suggestionChipEnds(editor.state.doc).size).toBe(2);
  });

  it('shows the doc-level pending badge with no redline surface mounted', () => {
    const ydoc = docFrom('Alpha bravo gamma.\n');
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author });
    mountTopbarDom();
    const scope = new MountScope();
    open.push(() => scope.dispose());
    const handle = mountSuggestionsSummary({ docId: 'd1', ydoc, scope });
    handle.refresh();

    expect(document.body.classList.contains('redline-mode')).toBe(false);
    const toggle = document.getElementById('toggle-suggestions') as HTMLElement;
    expect(toggle.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('suggestions-count')?.textContent).toBe('1');
  });
});
