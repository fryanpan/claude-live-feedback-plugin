import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prose } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { mountPointerPillLayer } from '../src/doc/doc-pointer-pill.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import * as realChunk from '../src/md-composer-chunk.ts';
import { type ComposerEditorModule, setComposerEditorLoader } from '../src/md-composer.ts';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';
import { surfaceOf } from './support/composer.ts';

/**
 * Pressing Comment on the pointer pill: what the reader gets, on the wiring
 * `app.ts` actually builds.
 *
 * Bryan's acceptance criteria, verbatim (2026-09-04): *"when user clicks
 * comment, focus immediately on the text input and suggest in placeholder
 * text that they can request research, ask for edits, or ask to create
 * task(s)"*. Two claims, and neither can be checked on either half alone —
 * `doc-pointer-pill.test.ts` hands the pill a spy for a composer, and the
 * composer suites open the composer by calling it. So this file wires the
 * real layer to the real chrome, exactly the way the markdown mount does,
 * and presses the button.
 *
 * IMMEDIATELY means in the click's own tick. The caret used to be scheduled
 * 30ms out, and iOS raises the keyboard only for a focus that happens inside
 * the gesture that asked for it — so those 30ms cost the reader a second tap
 * on the device this pill is mostly used from. The focus tests run under fake
 * timers and NEVER advance them: anything that came back as a timer would read
 * here as no focus at all.
 *
 * The caret lands on one of two surfaces, and both are driven. Until the
 * editor chunk arrives the textarea IS the box, and the focus is plainly
 * synchronous. Once the editor is live the focus goes through Tiptap, which
 * calls `view.dom.focus()` synchronously for iOS, iPadOS and desktop Safari
 * and defers only the ProseMirror-level selection into a frame
 * (`@tiptap/core`, `src/commands/focus.ts`) — so the live-editor test states
 * an iPad's user agent, and fails without it, which is the control for a test
 * that would otherwise be asserting happy-dom's defaults.
 *
 * What none of this reaches is the keyboard itself: no headless browser is an
 * iPad. That half is Bryan's, and the browser check reported with the PR only
 * shows the composer open with its input focused.
 *
 * The shell is the shipped one, read as the fixture it is: the placeholder
 * this asserts on is an attribute in `index.html`, and a hand-written copy of
 * the composer markup would assert the copy.
 */

/** The shipped shell's body, minus the script that would fetch the bundle. */
const SHELL = (() => {
  const html = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('>', html.indexOf('<body')) + 1;
  return html.slice(start, html.indexOf('</body>')).replace(/<script\b[\s\S]*?<\/script>/g, '');
})();

function fakeSurface(): ReviewSurface {
  return {
    getSelectionRel: () => null,
    resolveRel: () => null,
    scrollToPos: () => {},
    pulseRange: () => {},
    setThreadRanges: () => {},
    destroy: () => {},
  };
}

/** The anchored words the pill was grown over. */
const SELECTION = {
  start: new Uint8Array([1]),
  end: new Uint8Array([2]),
  snippet: 'Cloudflare Access covers the mockup route',
};

const composerText = () => document.getElementById('composer-text') as HTMLTextAreaElement;
const composerEl = () => document.getElementById('composer') as HTMLElement;
const commentBtn = () =>
  document.querySelector<HTMLButtonElement>('.pointer-pill button[data-action="comment"]');

const open: Array<() => void> = [];

/**
 * The markdown mount's own wiring, cut down to the two modules this is about:
 * the chrome that owns the composer, and the pill layer that presses it.
 * `openComposer` is passed exactly as `app.ts` passes it — a bare call, with
 * nothing awaited between the click and the focus.
 */
function mount() {
  document.body.innerHTML = SHELL;
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks('Ship the balloon margin\n'));
  const scope = new MountScope();
  const opts: ChromeOpts = {
    docId: 'd-huddle',
    user: { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#336699' },
    ydoc,
    surface: fakeSurface(),
    whenSynced: (cb) => cb(),
    canWrite: true,
    selectHint: 'Select some text first',
    reanchorHint: '',
    getSelection: () => SELECTION,
    scope,
  };
  const chrome = mountReviewChrome(opts);
  const editorMount = document.getElementById('editor') as HTMLElement;
  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness: new Awareness(ydoc),
  });
  editor.editor.commands.setTextSelection({ from: 1, to: 24 });
  const layer = mountPointerPillLayer({
    huddle: true,
    editor,
    editorMount,
    scope,
    getSelection: () => SELECTION,
    hideAll: () => {},
    openComposer: () => chrome.openComposer(),
  });
  open.push(() => {
    scope.dispose();
    editor.destroy();
  });
  layer.show(1, 24);
  return { chrome, layer, scope };
}

afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setComposerEditorLoader(null);
  document.body.innerHTML = '';
});

describe('pressing Comment on the pill', () => {
  it('opens the composer and takes the caret in the same tick', () => {
    // The chunk is still in flight, which is the state a reader who pressed
    // the pill seconds after the page loaded is in — and the state whose
    // focus is plain enough to read: the textarea IS the box until the editor
    // mounts over it.
    setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
    vi.useFakeTimers();
    mount();
    // Control: the caret is not in the box before the press, so what the
    // assertion below reads is the press and not the mount.
    expect(document.activeElement).not.toBe(composerText());
    expect(composerEl().classList.contains('hidden')).toBe(true);

    commentBtn()?.click();

    // No `advanceTimersByTime`, deliberately: this is the whole test. The
    // 30ms schedule this replaced would leave both of these false.
    expect(composerEl().classList.contains('hidden')).toBe(false);
    expect(document.activeElement).toBe(composerText());
  });

  it('leaves no timer behind that could take the caret later', () => {
    setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
    vi.useFakeTimers();
    mount();
    commentBtn()?.click();
    // Dismissing hands the caret back — a box nobody can see must not keep
    // swallowing what is typed next.
    document.getElementById('composer-scrim')?.click();
    expect(document.activeElement).not.toBe(composerText());
    // And nothing pending re-takes it a moment later, which is what the old
    // timer could do to a composer the reader had already dismissed.
    vi.advanceTimersByTime(1000);
    expect(document.activeElement).not.toBe(composerText());
  });

  it('reaches a mounted editor in the same tick on an iPad’s user agent', () => {
    // The state above is a composer whose chunk has not landed. On a warm
    // page the editor IS live, and the focus goes through Tiptap — which
    // calls `view.dom.focus()` synchronously for iOS, iPadOS and Safari and
    // defers only the ProseMirror selection into a frame. iPadOS reports a
    // Mac user agent with touch, which is exactly what `isiOS()` looks for,
    // so this is Bryan's device as far as that branch is concerned. Without
    // it, no timers are run here at all and the caret would still be in the
    // body.
    vi.stubGlobal('navigator', {
      ...navigator,
      platform: 'iPad',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    });
    setComposerEditorLoader(() => realChunk);
    vi.useFakeTimers();
    mount();
    expect(document.activeElement).not.toBe(
      surfaceOf(composerText())?.querySelector('.ProseMirror'),
    );

    commentBtn()?.click();

    expect(document.activeElement).toBe(surfaceOf(composerText())?.querySelector('.ProseMirror'));
  });

  it('shows the anchored words it is about', () => {
    setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
    mount();
    commentBtn()?.click();
    expect(document.getElementById('composer-quote')?.textContent).toBe(SELECTION.snippet);
  });
});

describe('the box says what can be asked for', () => {
  /** The three things Bryan named, each as the reader would recognise it. */
  const ASKS = [/research/i, /edit/i, /task/i];

  it('offers research, edits and a task in the placeholder', () => {
    setComposerEditorLoader(() => new Promise<ComposerEditorModule>(() => {}));
    mount();
    commentBtn()?.click();
    const hint = composerText().placeholder;
    for (const ask of ASKS) expect(hint).toMatch(ask);
    // Still a comment box first: the pill's one button says Comment, and a
    // placeholder that only listed errands would read as a different field.
    expect(hint).toMatch(/^comment/i);
  });

  it('carries that hint onto the editor the reader actually types in', () => {
    // The textarea goes off screen the moment the chunk lands, so an
    // attribute nobody carried over would be a placeholder on a hidden
    // control — visibly an empty box with no suggestion in it.
    setComposerEditorLoader(() => realChunk);
    mount();
    commentBtn()?.click();
    const shown = surfaceOf(composerText())
      ?.querySelector('.ProseMirror')
      ?.firstElementChild?.getAttribute('data-placeholder');
    expect(shown).toBe(composerText().placeholder);
    for (const ask of ASKS) expect(shown ?? '').toMatch(ask);
  });
});
