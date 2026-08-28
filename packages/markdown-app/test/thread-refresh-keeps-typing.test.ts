import type { Comment, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ComposerEditor,
  type ComposerEditorModule,
  type ComposerSelection,
  composerSelection,
  focusMarkdownComposer,
  isComposerFocused,
  setComposerEditorLoader,
} from '../src/md-composer.ts';
import { ThreadPanel, type ThreadPanelOpts } from '../src/threads.ts';

/**
 * A background refresh while somebody is typing a reply.
 *
 * Reported by Bryan (2026-08-27, by voice): typing in a document comment box,
 * an incoming background update scrolled the view back to the top and took
 * the keyboard with it. The panel rebuilds its whole list on any
 * display-relevant change — a peer's reply on a DIFFERENT thread, a summary
 * landing — and the rebuild preserved the draft's words but destroyed the
 * focused composer (focus → body, iPad keyboard dismisses) and emptied the
 * scrolled pane (scrollTop clamps to 0 while the list is empty).
 *
 * These assert the rebuild carries all three: the words (existing behaviour,
 * kept as the control), the caret, and the scroll position.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const bob: User = { id: 'u2', name: 'Bob', kind: 'known', color: '#e36f1e' };

let ts = 1_700_000_000_000;
function comment(author: User, text: string): Comment {
  ts += 1000;
  return { id: `c${ts}`, author, text, ts };
}

function makeThread(over: Partial<Thread> & { id: string; comments: Comment[] }): Thread {
  const comments = over.comments;
  return {
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'the anchor' } },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: comments[0]?.author ?? alice,
    ...over,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  setComposerEditorLoader(null);
});

function mountPanel(over: Partial<ThreadPanelOpts> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const panel = new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
    ...over,
  });
  const taFor = (id: string): HTMLTextAreaElement => {
    const ta = container.querySelector<HTMLTextAreaElement>(
      `.thread[data-thread-id="${id}"] textarea`,
    );
    if (!ta) throw new Error(`no reply box rendered for ${id}`);
    return ta;
  };
  return { panel, container, taFor };
}

/** A reply from Bob lands on t2 — the background event that rebuilds the
 *  list out from under the reader typing on t1. */
function withReply(t: Thread): Thread {
  const c = comment(bob, 'a background reply');
  return {
    ...t,
    comments: [...t.comments, c],
    commentCount: t.commentCount + 1,
    lastActivity: c.ts,
  };
}

describe('a background refresh while typing a reply (plain textarea)', () => {
  it('keeps focus, caret and draft in the reply box when another thread changes', () => {
    // The composer chunk never lands — the plain textarea is the surface the
    // reader is typing in (the state a slow network leaves every box in).
    setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
    const t1 = makeThread({ id: 't1', comments: [comment(alice, 'first thread')] });
    const t2 = makeThread({ id: 't2', comments: [comment(bob, 'second thread')] });
    const { panel, taFor } = mountPanel();
    panel.setThreads([t1, t2]);
    // Typing happens in an EXPANDED card — a folded card's detail face is
    // inert and refuses focus.
    panel.setActive('t1');

    const ta = taFor('t1');
    ta.value = 'half a thought';
    ta.focus();
    ta.setSelectionRange(6, 6);
    expect(document.activeElement, 'focus never landed — the rest is vacuous').toBe(ta);

    panel.setThreads([t1, withReply(t2)]);

    const rebuilt = taFor('t1');
    expect(rebuilt).not.toBe(ta); // positive control: the card WAS rebuilt
    expect(rebuilt.value).toBe('half a thought');
    expect(document.activeElement).toBe(rebuilt);
    expect(rebuilt.selectionStart).toBe(6);
    expect(rebuilt.selectionEnd).toBe(6);
  });

  it('does not steal focus that was never in the panel', () => {
    setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
    const t1 = makeThread({ id: 't1', comments: [comment(alice, 'first thread')] });
    const { panel } = mountPanel();
    panel.setThreads([t1]);

    const outside = document.createElement('input');
    document.body.appendChild(outside);
    cleanups.push(() => outside.remove());
    outside.focus();

    panel.setThreads([withReply(t1)]);
    expect(document.activeElement).toBe(outside);
  });
});

describe('a background refresh while typing a reply (live composer)', () => {
  /** A synchronous fake editor: enough of the ComposerEditor contract for
   *  focus/caret to round-trip, mounted in the same tick it was attached. */
  function fakeModule(): ComposerEditorModule {
    return {
      createComposerEditor: () => {
        let md = '';
        let focused = false;
        let sel: ComposerSelection = { from: 1, to: 1 };
        const editor: ComposerEditor = {
          getMarkdown: () => md,
          setMarkdown: (m) => {
            md = m;
          },
          focus: (s) => {
            focused = true;
            if (s) sel = s;
          },
          selection: () => sel,
          isFocused: () => focused,
          setEditable: () => {},
          destroy: () => {
            focused = false;
          },
        };
        return editor;
      },
    };
  }

  it('hands the caret to the rebuilt card’s editor at the same selection', () => {
    setComposerEditorLoader(fakeModule);
    const t1 = makeThread({ id: 't1', comments: [comment(alice, 'first thread')] });
    const t2 = makeThread({ id: 't2', comments: [comment(bob, 'second thread')] });
    const { panel, taFor } = mountPanel();
    panel.setThreads([t1, t2]);
    panel.setActive('t1');

    const ta = taFor('t1');
    ta.value = 'half a thought';
    focusMarkdownComposer(ta, { from: 3, to: 5 });
    expect(isComposerFocused(ta), 'editor focus never landed — vacuous').toBe(true);

    panel.setThreads([t1, withReply(t2)]);

    const rebuilt = taFor('t1');
    expect(rebuilt).not.toBe(ta); // positive control: the card WAS rebuilt
    expect(rebuilt.value).toBe('half a thought');
    expect(isComposerFocused(rebuilt)).toBe(true);
    expect(composerSelection(rebuilt)).toEqual({ from: 3, to: 5 });
  });
});

describe('a background refresh while the pane is scrolled', () => {
  it('puts the scroll position back after the rebuild', () => {
    setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);
    cleanups.push(() => scroller.remove());
    const container = document.createElement('div');
    scroller.appendChild(container);
    const { panel } = mountPanel({ container });

    const t1 = makeThread({ id: 't1', comments: [comment(alice, 'first thread')] });
    const t2 = makeThread({ id: 't2', comments: [comment(bob, 'second thread')] });
    panel.setThreads([t1, t2]);
    scroller.scrollTop = 240;

    // happy-dom has no layout, so emulate what a real browser does at the
    // moment the list empties: the pane's scrollHeight collapses and its
    // scrollTop clamps to 0. Keyed to the same `innerHTML = ''` the render
    // uses to clear.
    let desc: PropertyDescriptor | undefined;
    for (let p = Object.getPrototypeOf(container); p && !desc; p = Object.getPrototypeOf(p)) {
      desc = Object.getOwnPropertyDescriptor(p, 'innerHTML');
    }
    if (!desc?.set || !desc.get) throw new Error('no innerHTML accessor to wrap');
    const { get, set } = desc;
    Object.defineProperty(container, 'innerHTML', {
      configurable: true,
      get: () => get.call(container) as string,
      set: (v: string) => {
        set.call(container, v);
        if (container.childElementCount === 0) scroller.scrollTop = 0;
      },
    });

    panel.setThreads([t1, withReply(t2)]);
    expect(
      container.childElementCount,
      'nothing was rebuilt — the clamp never fired and the assertion is vacuous',
    ).toBeGreaterThan(0);
    expect(scroller.scrollTop).toBe(240);
  });
});
