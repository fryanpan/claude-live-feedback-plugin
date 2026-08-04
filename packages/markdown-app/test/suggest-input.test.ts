import {
  SUGGEST_DELETE_MARK,
  SUGGEST_INSERT_MARK,
  type SuggestionAttrs,
  prose,
} from '@feedback/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import {
  handleSuggestCut,
  readSuggestModePref,
  setSuggesting,
  writeSuggestModePref,
} from '../src/suggest-input.ts';

/**
 * The Suggesting input mode (redlining Phase 2, commit 4): with the mode ON,
 * a ProseMirror plugin rewrites input so nothing the human types or deletes
 * becomes a direct edit — typed text carries suggestInsert (the serializer
 * omits it from disk), deletions become suggestDelete marks (the text stays
 * on disk) — the same accepted-state contract the agent-side suggestion
 * tools (commits 1-3) already pin. Tests run through a REAL createEditor
 * (the full app extension list over a Y.Doc), per the learnings: verify at
 * the layer the behavior lives in.
 */

const AUTHOR = { id: 'u-bryan', name: 'Bryan', color: '#2e7dd7' };

const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
  localStorage.clear();
});

function mountEditor(md: string) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push({ handle, parent });
  return { ydoc, fragment, handle, view: handle.editor.view as EditorView };
}

function suggestOn(view: EditorView): void {
  setSuggesting(view, { on: true, author: AUTHOR });
}

/** Simulate typing exactly the way ProseMirror delivers it (the 5th arg is
 *  the default-transaction builder PM 1.41+ passes to handleTextInput). */
function typeAt(view: EditorView, from: number, to: number, text: string): boolean {
  return (
    view.someProp('handleTextInput', (f) =>
      f(view, from, to, text, () => view.state.tr.insertText(text, from, to)),
    ) ?? false
  );
}

/** Simulate a keydown through the view's prop chain (our plugin first). */
function press(view: EditorView, key: string): boolean {
  return (
    view.someProp('handleKeyDown', (f) => f(view, new KeyboardEvent('keydown', { key }))) ?? false
  );
}

/** Simulate a paste through the view's prop chain (our plugin first). */
function pasteAt(view: EditorView, slice: Slice): boolean {
  return (
    view.someProp('handlePaste', (f) =>
      f(view, { preventDefault: vi.fn() } as unknown as ClipboardEvent, slice),
    ) ?? false
  );
}

function textSlice(view: EditorView, text: string): Slice {
  return new Slice(Fragment.from(view.state.schema.text(text)), 0, 0);
}

type DeltaOp = { insert?: string; attributes?: Record<string, unknown> };

function textDelta(fragment: Y.XmlFragment, blockIndex = 0): DeltaOp[] {
  const block = fragment.get(blockIndex) as Y.XmlElement;
  const text = block.toArray()[0] as Y.XmlText;
  return text.toDelta() as DeltaOp[];
}

function opsWith(delta: DeltaOp[], mark: string): DeltaOp[] {
  return delta.filter((op) => op.attributes?.[mark] != null);
}

function attrsOf(op: DeltaOp, mark: string): SuggestionAttrs {
  return op.attributes?.[mark] as SuggestionAttrs;
}

function docText(handle: EditorHandle): string {
  return handle.editor.state.doc.textContent;
}

describe('Suggesting input mode — typing', () => {
  it('marks typed text suggestInsert with the current user identity; disk serialization omits it', () => {
    const { fragment, handle, view } = mountEditor('Alpha gamma.\n');
    suggestOn(view);
    const handled = typeAt(view, 7, 7, 'beta ');
    expect(handled).toBe(true);
    expect(docText(handle)).toBe('Alpha beta gamma.');
    const ins = opsWith(textDelta(fragment), SUGGEST_INSERT_MARK);
    expect(ins).toHaveLength(1);
    expect(ins[0].insert).toBe('beta ');
    const attrs = attrsOf(ins[0], SUGGEST_INSERT_MARK);
    expect(attrs.authorId).toBe('u-bryan');
    expect(attrs.authorName).toBe('Bryan');
    expect(attrs.authorColor).toBe('#2e7dd7');
    expect(typeof attrs.ts).toBe('number');
    expect(attrs.sid.length).toBeGreaterThan(0);
    // The crux: disk sees the ACCEPTED state — the proposal is invisible.
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha gamma.\n');
  });

  it('a contiguous typing burst shares one sid; typing elsewhere starts a new one', () => {
    const { fragment, view } = mountEditor('Alpha gamma.\n');
    suggestOn(view);
    typeAt(view, 7, 7, 'be');
    typeAt(view, 9, 9, 'ta '); // caret continued at the burst end
    typeAt(view, 1, 1, 'X'); // jumped to doc start — a separate proposal
    const ins = opsWith(textDelta(fragment), SUGGEST_INSERT_MARK);
    const bodies = ins.map((op) => op.insert);
    expect(bodies).toContain('beta ');
    expect(bodies).toContain('X');
    const sids = new Set(ins.map((op) => attrsOf(op, SUGGEST_INSERT_MARK).sid));
    expect(sids.size).toBe(2);
  });

  it('typing over a selection proposes a REPLACE: one sid across suggestDelete + suggestInsert', () => {
    const { fragment, handle, view } = mountEditor('Alpha beta gamma.\n');
    suggestOn(view);
    const handled = typeAt(view, 7, 11, 'delta'); // selection over 'beta'
    expect(handled).toBe(true);
    // Both the old and the new text are visible in the live doc…
    expect(docText(handle)).toBe('Alpha betadelta gamma.');
    const delta = textDelta(fragment);
    const del = opsWith(delta, SUGGEST_DELETE_MARK);
    const ins = opsWith(delta, SUGGEST_INSERT_MARK);
    expect(del).toHaveLength(1);
    expect(del[0].insert).toBe('beta');
    expect(ins).toHaveLength(1);
    expect(ins[0].insert).toBe('delta');
    expect(attrsOf(del[0], SUGGEST_DELETE_MARK).sid).toBe(attrsOf(ins[0], SUGGEST_INSERT_MARK).sid);
    // …but disk still shows the accepted state: the original, unreplaced.
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha beta gamma.\n');
  });
});

describe('Suggesting input mode — deleting', () => {
  it('Backspace marks the previous char suggestDelete instead of removing it; a burst shares one sid', () => {
    const { fragment, handle, view } = mountEditor('Alpha beta gamma.\n');
    suggestOn(view);
    handle.editor.commands.setTextSelection(11); // caret after 'beta'
    expect(press(view, 'Backspace')).toBe(true);
    expect(press(view, 'Backspace')).toBe(true);
    expect(docText(handle)).toBe('Alpha beta gamma.'); // nothing actually removed
    const del = opsWith(textDelta(fragment), SUGGEST_DELETE_MARK);
    expect(del).toHaveLength(1);
    expect(del[0].insert).toBe('ta');
    // Disk unchanged: a proposed deletion still serializes.
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha beta gamma.\n');
  });

  it('Delete (forward) marks the next char and steps the caret past it', () => {
    const { fragment, handle, view } = mountEditor('Alpha beta gamma.\n');
    suggestOn(view);
    handle.editor.commands.setTextSelection(7); // caret before 'beta'
    expect(press(view, 'Delete')).toBe(true);
    expect(press(view, 'Delete')).toBe(true);
    expect(docText(handle)).toBe('Alpha beta gamma.');
    const del = opsWith(textDelta(fragment), SUGGEST_DELETE_MARK);
    expect(del).toHaveLength(1);
    expect(del[0].insert).toBe('be');
    const sids = new Set(del.map((op) => attrsOf(op, SUGGEST_DELETE_MARK).sid));
    expect(sids.size).toBe(1);
  });

  it('Backspace over YOUR OWN pending suggestInsert is not intercepted — the text really deletes', () => {
    const { fragment, handle, view } = mountEditor('Alpha gamma.\n');
    suggestOn(view);
    typeAt(view, 7, 7, 'beta ');
    handle.editor.commands.setTextSelection(12); // caret at the end of 'beta '
    // Our plugin DECLINES (returns false) so the browser's native
    // contenteditable deletion applies — the char really goes away. Headless
    // there is no native editing, so the pin is: declined, nothing marked,
    // nothing changed by us.
    expect(press(view, 'Backspace')).toBe(false);
    expect(docText(handle)).toBe('Alpha beta gamma.');
    expect(opsWith(textDelta(fragment), SUGGEST_DELETE_MARK)).toHaveLength(0);
    // Still nothing on disk — the pending proposal stays a proposal.
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha gamma.\n');
  });

  it('Backspace over an already-proposed deletion skips the caret without changing the doc', () => {
    const { fragment, handle, view } = mountEditor('Alpha beta gamma.\n');
    suggestOn(view);
    handle.editor.commands.setTextSelection(11);
    press(view, 'Backspace'); // marks 'a' → caret now at 10
    const before = JSON.stringify(textDelta(fragment));
    handle.editor.commands.setTextSelection(11); // caret right after the marked 'a' again
    expect(press(view, 'Backspace')).toBe(true);
    expect(JSON.stringify(textDelta(fragment))).toBe(before); // no new marks, no deletions
    expect(view.state.selection.from).toBe(10); // caret stepped over the marked char
  });

  it('deleting a selection marks plain text and REALLY deletes pending-insert segments inside it', () => {
    const { fragment, handle, view } = mountEditor('Alpha beta gamma.\n');
    suggestOn(view);
    typeAt(view, 7, 7, 'NEW '); // pending insert inside the future selection
    handle.editor.commands.setTextSelection({ from: 1, to: 15 }); // 'Alpha NEW beta'
    expect(press(view, 'Backspace')).toBe(true);
    // The pending insert is gone for real; everything else survives, marked.
    expect(docText(handle)).toBe('Alpha beta gamma.');
    const delta = textDelta(fragment);
    expect(opsWith(delta, SUGGEST_INSERT_MARK)).toHaveLength(0);
    const del = opsWith(delta, SUGGEST_DELETE_MARK);
    expect(del.map((op) => op.insert).join('')).toBe('Alpha beta');
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha beta gamma.\n');
  });

  it('Enter is suppressed in Suggesting mode — a block split would leak a structural edit to disk', () => {
    const { fragment, handle, view } = mountEditor('Alpha beta gamma.\n');
    suggestOn(view);
    handle.editor.commands.setTextSelection(7);
    expect(press(view, 'Enter')).toBe(true);
    expect(fragment.length).toBe(1); // still one paragraph
    expect(docText(handle)).toBe('Alpha beta gamma.');
  });
});

describe('Suggesting input mode — cut, composition backstop, toggle off', () => {
  it('cut copies the selection but marks it suggestDelete instead of removing it', () => {
    const { fragment, handle, view } = mountEditor('Alpha beta gamma.\n');
    suggestOn(view);
    handle.editor.commands.setTextSelection({ from: 7, to: 11 });
    const ev = {
      preventDefault: vi.fn(),
      clipboardData: { setData: vi.fn() },
    } as unknown as ClipboardEvent;
    expect(handleSuggestCut(view, ev)).toBe(true);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.clipboardData?.setData).toHaveBeenCalledWith('text/plain', 'beta');
    expect(docText(handle)).toBe('Alpha beta gamma.');
    const del = opsWith(textDelta(fragment), SUGGEST_DELETE_MARK);
    expect(del[0]?.insert).toBe('beta');
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha beta gamma.\n');
  });

  it('local inserts that bypass handleTextInput (IME commit, paste) get marked by the appended-transaction backstop', () => {
    const { fragment, handle, view } = mountEditor('Alpha gamma.\n');
    suggestOn(view);
    // insertContentAt dispatches a plain local transaction — the same shape a
    // composition commit or paste produces (no handleTextInput call).
    handle.editor.commands.insertContentAt(7, 'pasted ');
    expect(docText(handle)).toBe('Alpha pasted gamma.');
    const ins = opsWith(textDelta(fragment), SUGGEST_INSERT_MARK);
    expect(ins[0]?.insert).toBe('pasted ');
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha gamma.\n');
  });

  it('remote (Yjs) transactions are never rewritten by the backstop — agent direct edits stay direct', () => {
    const { ydoc, fragment, handle, view } = mountEditor('Alpha gamma.\n');
    suggestOn(view);
    const block = fragment.get(0) as Y.XmlElement;
    const text = block.toArray()[0] as Y.XmlText;
    ydoc.transact(() => text.insert(6, 'direct ', {}), 'agent');
    expect(docText(handle)).toBe('Alpha direct gamma.');
    expect(opsWith(textDelta(fragment), SUGGEST_INSERT_MARK)).toHaveLength(0);
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha direct gamma.\n');
  });

  it('toggling Suggesting off restores direct editing', () => {
    const { fragment, view } = mountEditor('Alpha gamma.\n');
    suggestOn(view);
    setSuggesting(view, { on: false });
    expect(typeAt(view, 7, 7, 'beta ')).toBe(false); // plugin declines; default input applies
    press(view, 'Backspace'); // falls through to the default keymap
    expect(opsWith(textDelta(fragment), SUGGEST_INSERT_MARK)).toHaveLength(0);
    expect(opsWith(textDelta(fragment), SUGGEST_DELETE_MARK)).toHaveLength(0);
  });
});

describe('Suggesting input mode — paste and drop', () => {
  it('pasting over a non-empty selection proposes a REPLACE — the selected accepted text is NOT deleted', () => {
    const { fragment, handle, view } = mountEditor('Alpha beta gamma.\n');
    suggestOn(view);
    handle.editor.commands.setTextSelection({ from: 7, to: 11 }); // 'beta'
    expect(pasteAt(view, textSlice(view, 'delta'))).toBe(true);
    // Both old and new text visible in the live doc…
    expect(docText(handle)).toBe('Alpha betadelta gamma.');
    const delta = textDelta(fragment);
    const del = opsWith(delta, SUGGEST_DELETE_MARK);
    const ins = opsWith(delta, SUGGEST_INSERT_MARK);
    expect(del).toHaveLength(1);
    expect(del[0].insert).toBe('beta');
    expect(ins).toHaveLength(1);
    expect(ins[0].insert).toBe('delta');
    // One sid across both ranges: a single "replace X with Y" proposal.
    expect(attrsOf(del[0], SUGGEST_DELETE_MARK).sid).toBe(attrsOf(ins[0], SUGGEST_INSERT_MARK).sid);
    // …and disk keeps the accepted state: nothing was really deleted.
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha beta gamma.\n');
  });

  it('a multi-block paste mid-paragraph flattens into one text proposal — no block split leaks to disk', () => {
    const { fragment, handle, view } = mountEditor('Alpha gamma.\n');
    suggestOn(view);
    handle.editor.commands.setTextSelection(7);
    const schema = view.state.schema;
    const twoParagraphs = new Slice(
      Fragment.from([
        schema.nodes.paragraph.create(null, schema.text('one')),
        schema.nodes.paragraph.create(null, schema.text('two')),
      ]),
      1,
      1,
    );
    expect(pasteAt(view, twoParagraphs)).toBe(true);
    expect(fragment.length).toBe(1); // the host paragraph was NOT split
    expect(docText(handle)).toBe('Alpha one twogamma.');
    const ins = opsWith(textDelta(fragment), SUGGEST_INSERT_MARK);
    expect(ins[0]?.insert).toBe('one two');
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha gamma.\n');
  });

  it('drop is suppressed in Suggesting mode — a drag-move would really delete the source text', () => {
    const { view } = mountEditor('Alpha gamma.\n');
    const slice = textSlice(view, 'x');
    const dropWhileOff =
      view.someProp('handleDrop', (f) => f(view, {} as unknown as DragEvent, slice, true)) ?? false;
    expect(dropWhileOff).toBe(false); // normal mode: default drop applies
    suggestOn(view);
    const dropWhileOn =
      view.someProp('handleDrop', (f) => f(view, {} as unknown as DragEvent, slice, true)) ?? false;
    expect(dropWhileOn).toBe(true); // Suggesting: blocked, nothing deleted
  });
});

describe('Normal mode — no suggestion-mark inheritance', () => {
  const AGENT_ATTRS: SuggestionAttrs = {
    sid: 's-agent',
    authorId: 'agent-1',
    authorName: 'Docs Agent',
    authorColor: '#7c5cff',
    ts: 1754200000000,
  };

  it('typing inside a pending suggestInsert span stays a direct edit — the keystroke reaches disk', () => {
    const { ydoc, fragment, handle, view } = mountEditor('Alpha gamma.\n');
    const block = fragment.get(0) as Y.XmlElement;
    const text = block.toArray()[0] as Y.XmlText;
    ydoc.transact(() => text.insert(6, 'beta ', { [SUGGEST_INSERT_MARK]: AGENT_ATTRS }), 'agent');
    expect(docText(handle)).toBe('Alpha beta gamma.');
    // Suggesting mode is OFF (default). Type mid-span the way the default
    // input path does — tr.insertText inherits the marks at the caret.
    view.dispatch(view.state.tr.insertText('X', 9, 9));
    expect(docText(handle)).toBe('Alpha beXta gamma.');
    // The keystroke must NOT be swallowed into the pending proposal…
    const ins = opsWith(textDelta(fragment), SUGGEST_INSERT_MARK);
    expect(ins.map((op) => op.insert).join('')).toBe('beta ');
    // …and it reaches disk like any direct edit.
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha Xgamma.\n');
  });

  it('typing inside a pending suggestDelete span does not inherit the strikethrough proposal', () => {
    const { ydoc, fragment, handle, view } = mountEditor('Alpha beta gamma.\n');
    const block = fragment.get(0) as Y.XmlElement;
    const text = block.toArray()[0] as Y.XmlText;
    ydoc.transact(() => text.format(6, 5, { [SUGGEST_DELETE_MARK]: AGENT_ATTRS }), 'agent');
    view.dispatch(view.state.tr.insertText('X', 9, 9));
    expect(docText(handle)).toBe('Alpha beXta gamma.');
    // The keystroke is not part of the proposed deletion (it would be
    // destroyed on accept otherwise)…
    const del = opsWith(textDelta(fragment), SUGGEST_DELETE_MARK);
    expect(del.map((op) => op.insert).join('')).toBe('beta ');
    // …and disk holds everything: del text serializes, the keystroke too.
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('Alpha beXta gamma.\n');
  });
});

describe('Suggesting mode — undo discipline', () => {
  it("Cmd-Z undoes the human's OWN suggestion (their origin is tracked)", () => {
    const { fragment, handle, view } = mountEditor('Alpha gamma.\n');
    suggestOn(view);
    typeAt(view, 7, 7, 'beta ');
    expect(docText(handle)).toBe('Alpha beta gamma.');
    handle.editor.commands.undo();
    expect(docText(handle)).toBe('Alpha gamma.');
    expect(opsWith(textDelta(fragment), SUGGEST_INSERT_MARK)).toHaveLength(0);
  });

  it("Cmd-Z does NOT revert an AGENT's suggestion (server origin is untracked)", () => {
    const { ydoc, fragment, handle } = mountEditor('Alpha gamma.\n');
    const block = fragment.get(0) as Y.XmlElement;
    const text = block.toArray()[0] as Y.XmlText;
    const attrs: SuggestionAttrs = {
      sid: 's-agent',
      authorId: 'agent-1',
      authorName: 'Docs Agent',
      authorColor: '#7c5cff',
      ts: 1754200000000,
    };
    ydoc.transact(() => text.insert(6, 'beta ', { [SUGGEST_INSERT_MARK]: attrs }), 'agent');
    expect(docText(handle)).toBe('Alpha beta gamma.');
    handle.editor.commands.undo();
    expect(docText(handle)).toBe('Alpha beta gamma.');
    expect(opsWith(textDelta(fragment), SUGGEST_INSERT_MARK)).toHaveLength(1);
  });
});

describe('Suggesting mode — persistence', () => {
  it('persists per doc: off by default, round-trips, and does not leak across docs', () => {
    expect(readSuggestModePref('doc-a')).toBe(false);
    writeSuggestModePref('doc-a', true);
    expect(readSuggestModePref('doc-a')).toBe(true);
    expect(readSuggestModePref('doc-b')).toBe(false);
    writeSuggestModePref('doc-a', false);
    expect(readSuggestModePref('doc-a')).toBe(false);
  });
});
