/**
 * Status chips on workspace task links inside doc prose.
 *
 * The load-bearing promise is the negative one: the chip is a render-time
 * decoration and the STORED doc never changes — a meeting note that links a
 * task keeps exactly the markdown the composer wrote, however many times the
 * chip repaints or the status flips. All fixtures are synthetic; the repo is
 * public.
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetLinkTitlesForTest, primeLinkTitle } from '../src/link-titles.ts';
import {
  TaskLinkChips,
  refreshTaskLinkChips,
  taskLinkChipsKey,
  taskLinkRunsIn,
} from '../src/task-link-chips.ts';

const TASK_URL = '/workspaces/w-b?task=t-9';

function mount(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit.configure({ undoRedo: false }), TaskLinkChips],
    content,
  });
}

function chipSpecs(editor: Editor): string[] {
  const state = taskLinkChipsKey.getState(editor.state);
  const deco = (state as { deco?: { find: () => Array<{ spec: { key?: string } }> } })?.deco;
  return (deco?.find() ?? []).map((d) => d.spec.key ?? '');
}

beforeEach(() => _resetLinkTitlesForTest());
afterEach(() => {
  document.body.innerHTML = '';
});

describe('taskLinkRunsIn', () => {
  it('finds a workspace task link and its end position', () => {
    const editor = mount(`<p>Tracked: <a href="${TASK_URL}">the strip task</a> already.</p>`);
    const runs = taskLinkRunsIn(editor.state.doc);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.url).toBe(TASK_URL);
    expect(editor.state.doc.textBetween(runs[0]!.from, runs[0]!.to)).toBe('the strip task');
    editor.destroy();
  });

  it('ignores links that are not workspace resources', () => {
    const editor = mount(
      '<p><a href="https://example.com/workspaces/nope">out</a> and <a href="/elsewhere">in-site</a>.</p>',
    );
    expect(taskLinkRunsIn(editor.state.doc)).toHaveLength(0);
    editor.destroy();
  });
});

describe('the chip decoration', () => {
  it('wears the cached status beside the link', () => {
    primeLinkTitle(TASK_URL, 'Strip overlaps navbar', 'todo');
    const editor = mount(`<p><a href="${TASK_URL}">the strip task</a></p>`);
    expect(chipSpecs(editor)).toEqual([`${TASK_URL}|todo`]);
    editor.destroy();
  });

  it('renders no chip for a link the server said is not a task', () => {
    primeLinkTitle(TASK_URL, 'Some doc', null);
    const editor = mount(`<p><a href="${TASK_URL}">a doc link</a></p>`);
    expect(chipSpecs(editor)).toEqual([]);
    editor.destroy();
  });

  it('repaints on refresh when the status flips — the dispatch moment', () => {
    primeLinkTitle(TASK_URL, 'Strip overlaps navbar', 'todo');
    const editor = mount(`<p><a href="${TASK_URL}">the strip task</a></p>`);
    primeLinkTitle(TASK_URL, 'Strip overlaps navbar', 'in-progress');
    refreshTaskLinkChips(editor.view);
    expect(chipSpecs(editor)).toEqual([`${TASK_URL}|in-progress`]);
    editor.destroy();
  });

  it('NEVER rewrites the stored doc: text and markup stay exactly as written', () => {
    primeLinkTitle(TASK_URL, 'Strip overlaps navbar', 'todo');
    const editor = mount(`<p><a href="${TASK_URL}">the strip task</a></p>`);
    // The chip's words are nowhere in the document content…
    expect(editor.state.doc.textContent).toBe('the strip task');
    // …and the serialized doc holds the plain link, chipless.
    const html = editor.getHTML();
    expect(html).toContain('the strip task');
    expect(html).not.toContain('ws-status-chip');
    expect(html).not.toContain('To do');
    editor.destroy();
  });

  it('tracks edits: the chip follows its link as text is typed before it', () => {
    primeLinkTitle(TASK_URL, 'Strip overlaps navbar', 'todo');
    const editor = mount(`<p>Note: <a href="${TASK_URL}">the strip task</a></p>`);
    const before = taskLinkRunsIn(editor.state.doc)[0]!;
    editor.chain().focus().insertContentAt(1, 'Oh! ').run();
    const after = taskLinkRunsIn(editor.state.doc)[0]!;
    expect(after.to).toBe(before.to + 'Oh! '.length);
    expect(chipSpecs(editor)).toEqual([`${TASK_URL}|todo`]);
    editor.destroy();
  });
});
