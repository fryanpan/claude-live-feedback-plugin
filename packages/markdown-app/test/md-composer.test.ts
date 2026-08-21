import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as realChunk from '../src/md-composer-chunk.ts';
import {
  type ComposerEditor,
  type ComposerEditorModule,
  type ComposerSelection,
  attachMarkdownComposer,
  composerSelection,
  composerState,
  focusMarkdownComposer,
  isComposerFocused,
  refreshMarkdownComposer,
  setComposerEditorLoader,
} from '../src/md-composer.ts';
import { frame, renderedHtml, surfaceOf } from './support/composer.ts';

/**
 * Every composer is a markdown editor (approved design, review-flow-mock-v1,
 * design point 4) — and an editor is what the task description already is:
 * you type `**bold**` and the words go bold. The first attempt at this
 * shipped a cheat sheet over the box and a rendering of it underneath, and
 * Bryan rejected it in one line: *"the reply and comment inputs should be
 * markdown editors like the task description"*.
 *
 * The textarea stays underneath as the value, which is what lets five
 * composers become editors without any of them changing how they send.
 */

let form: HTMLFormElement;
let ta: HTMLTextAreaElement;

beforeEach(() => {
  document.body.replaceChildren();
  form = document.createElement('form');
  ta = document.createElement('textarea');
  ta.placeholder = 'Reply as Bryan…';
  ta.rows = 3;
  form.append(ta);
  document.body.append(form);
});

afterEach(() => {
  setComposerEditorLoader(() => realChunk);
});

describe('attachMarkdownComposer — the real editor', () => {
  it('puts an editor beside the box and takes the box off screen', () => {
    attachMarkdownComposer(ta);
    expect(ta.parentElement?.className).toBe('md-composer md-composer-live');
    expect(surfaceOf(ta)?.querySelector('.ProseMirror')).not.toBeNull();
  });

  it('keeps the textarea in its form — attaching decorates, it does not move', () => {
    attachMarkdownComposer(ta);
    expect(ta.closest('form')).toBe(form);
  });

  it('edits markdown live: what is in the box is shown as what it means', () => {
    const refresh = attachMarkdownComposer(ta);
    ta.value = '**two hops** and\n\n- a bullet';
    refresh();
    expect(renderedHtml(ta)).toContain('<strong>two hops</strong>');
    expect(renderedHtml(ta)).toContain('<li>');
  });

  it('carries the box’s placeholder onto the editor — the label is the box', () => {
    attachMarkdownComposer(ta);
    const p = surfaceOf(ta)?.querySelector('.ProseMirror p');
    expect(p?.getAttribute('data-placeholder')).toBe('Reply as Bryan…');
  });

  it('carries the box’s rows, so a 3-row answer box is still three rows tall', () => {
    attachMarkdownComposer(ta);
    expect(ta.parentElement?.style.getPropertyValue('--md-rows')).toBe('3');
  });

  it('a programmatic clear empties the editor with the box — a send fires no event', () => {
    const refresh = attachMarkdownComposer(ta);
    ta.value = 'done, **send it**';
    refresh();
    expect(renderedHtml(ta)).toContain('<strong>send it</strong>');
    // What every composer does on a successful send: set the value directly.
    ta.value = '';
    refresh();
    expect(renderedHtml(ta)).not.toContain('send it');
  });

  it('hands refused words back VERBATIM — seeding the editor must not rewrite them', () => {
    // The seed runs the words through the parser; if it also ran the parse
    // back out through the serializer and into `ta.value`, a retry would
    // offer the reviewer a subtly rewritten version of what they wrote.
    const refresh = attachMarkdownComposer(ta);
    const typed = 'Alphabetical, *final*.\n\n*   loose bullet';
    ta.value = typed;
    refresh();
    expect(ta.value).toBe(typed);
  });

  it('escapes the words — a composer takes untrusted input', () => {
    const refresh = attachMarkdownComposer(ta);
    ta.value = '<script>alert(1)</script> and <img src=x onerror=alert(1)>';
    refresh();
    expect(surfaceOf(ta)?.querySelector('script')).toBeNull();
    expect(surfaceOf(ta)?.querySelector('img')).toBeNull();
  });

  it('focuses the editor, at the caret it was given', async () => {
    const refresh = attachMarkdownComposer(ta);
    ta.value = 'drop the second half';
    refresh();
    focusMarkdownComposer(ta, { from: 10, to: 10 });
    await frame();
    expect(isComposerFocused(ta)).toBe(true);
    expect(composerSelection(ta)).toEqual({ from: 10, to: 10 });
  });

  it('attaching twice returns the field that is already there', () => {
    attachMarkdownComposer(ta);
    attachMarkdownComposer(ta);
    expect(document.querySelectorAll('.md-composer')).toHaveLength(1);
    expect(document.querySelectorAll('.md-composer-surface')).toHaveLength(1);
  });
});

/**
 * The wiring between the editor and the textarea, driven through a stand-in
 * so a test can be the one deciding when an edit happens. The editor itself
 * is covered above, against the real thing.
 */
describe('attachMarkdownComposer — what the box and the editor owe each other', () => {
  interface Fake extends ComposerEditor {
    md: string;
    editable: boolean;
    destroyed: boolean;
    /** Edit it the way a person does — the editor announces it. */
    edit: (md: string) => void;
  }
  let made: Fake[];

  function fakeModule(): ComposerEditorModule {
    return {
      createComposerEditor(opts) {
        const el = document.createElement('div');
        el.className = 'ProseMirror';
        opts.parent.append(el);
        const f: Fake = {
          md: '',
          editable: true,
          destroyed: false,
          edit(md) {
            f.md = md;
            opts.onUpdate();
          },
          getMarkdown: () => f.md,
          setMarkdown: (md) => {
            f.md = md;
          },
          focus: () => {},
          selection: () => ({ from: 1, to: 1 }) as ComposerSelection,
          isFocused: () => false,
          setEditable: (on) => {
            f.editable = on;
          },
          destroy: () => {
            f.destroyed = true;
          },
        };
        made.push(f);
        return f;
      },
    };
  }

  beforeEach(() => {
    made = [];
    setComposerEditorLoader(fakeModule);
  });

  it('every edit lands in the textarea as markdown, and says so', () => {
    const onInput = vi.fn();
    ta.addEventListener('input', onInput);
    attachMarkdownComposer(ta);
    made[0].edit('a **second** thought');
    expect(ta.value).toBe('a **second** thought');
    // The "write something first" note clears on the next thing typed, and it
    // is listening on the box.
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it('seeds the editor from whatever the box already held', () => {
    ta.value = 'a draft restored after a repaint';
    attachMarkdownComposer(ta);
    expect(made[0].md).toBe('a draft restored after a repaint');
  });

  it('Enter reaches the listener the composer put on the box', () => {
    const onKey = vi.fn((ev: Event) => ev.preventDefault());
    ta.addEventListener('keydown', onKey);
    attachMarkdownComposer(ta);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    surfaceOf(ta)?.dispatchEvent(ev);
    expect(onKey).toHaveBeenCalledTimes(1);
    // The handler sent the reply, so the editor must not also take the key
    // and open a paragraph in the box that was just emptied.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('a key nobody claimed stays with the editor — Shift+Enter is a line break', () => {
    // The composers that send on Enter all ignore it when Shift is down.
    ta.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).shiftKey) return;
      ev.preventDefault();
    });
    attachMarkdownComposer(ta);
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    surfaceOf(ta)?.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('leaves every other key alone — the editor owns typing', () => {
    const onKey = vi.fn();
    ta.addEventListener('keydown', onKey);
    attachMarkdownComposer(ta);
    surfaceOf(ta)?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }),
    );
    expect(onKey).not.toHaveBeenCalled();
  });

  it('disabling the box disables the editor — that is how a send says "sending"', async () => {
    attachMarkdownComposer(ta);
    ta.disabled = true;
    // The mirror is a MutationObserver, which delivers on a microtask.
    await Promise.resolve();
    expect(made[0].editable).toBe(false);
    expect(ta.parentElement?.classList.contains('md-composer-disabled')).toBe(true);
    ta.disabled = false;
    await Promise.resolve();
    expect(made[0].editable).toBe(true);
  });

  it('destroys the editor a repaint threw away, and only that one', () => {
    attachMarkdownComposer(ta);
    const first = made[0];
    // What a repaint does: build the replacement, then swap the old DOM out.
    const next = document.createElement('textarea');
    const nextForm = document.createElement('form');
    nextForm.append(next);
    attachMarkdownComposer(next);
    expect(first.destroyed).toBe(false);

    document.body.replaceChildren(nextForm);
    // The sweep runs on the next attach or refresh — both of which a repaint
    // does. Without it every board event would leave a view behind.
    refreshMarkdownComposer(next);
    expect(first.destroyed).toBe(true);
    expect(made[1].destroyed).toBe(false);
  });
});

describe('when the editor’s chunk never arrives', () => {
  it('leaves the plain box on screen, still able to send', async () => {
    setComposerEditorLoader(() => Promise.reject(new Error('offline')));
    attachMarkdownComposer(ta);
    await frame();
    expect(composerState(ta)).toBe('none');
    expect(surfaceOf(ta)).toBeNull();
    ta.value = 'typed into the fallback';
    expect(ta.value).toBe('typed into the fallback');
    // And focus still goes somewhere a person can see.
    focusMarkdownComposer(ta);
    expect(document.activeElement).toBe(ta);
  });

  it('remembers a focus asked for while the chunk is still in flight', async () => {
    let land: (m: ComposerEditorModule) => void = () => {};
    setComposerEditorLoader(() => new Promise<ComposerEditorModule>((r) => (land = r)));
    attachMarkdownComposer(ta);
    expect(composerState(ta)).toBe('pending');
    // `restoreFields` hits exactly this on the first repaint of a page load.
    focusMarkdownComposer(ta, { from: 1, to: 1 });
    land(realChunk);
    await frame();
    await frame();
    expect(composerState(ta)).toBe('live');
    expect(isComposerFocused(ta)).toBe(true);
  });
});

/**
 * happy-dom resolves no layout, so the stylesheet is read as text — same
 * pattern as `hub-decide-css.test.ts`, and for the same reason: classes
 * emitted with nothing styling them is a state no DOM test can see.
 */
describe('the markdown composer is styled', () => {
  const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

  /** The body of one top-level rule, comments stripped. */
  function rule(selector: string): string {
    const at = new RegExp(
      `(^|\\n)${selector.replace(/[.+*[\]()>]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    ).exec(stripped);
    return at?.[2] ?? '';
  }

  it('styles every class the composer emits', () => {
    for (const sel of [
      '.md-composer',
      '.md-composer-surface',
      '.md-composer-disabled .md-composer-surface',
      '.md-composer-surface .ProseMirror',
    ]) {
      expect(rule(sel), `no rule for ${sel}`).not.toBe('');
    }
  });

  it('the editor is off screen until it exists, and takes the box’s place when it does', () => {
    expect(rule('.md-composer > .md-composer-surface')).toContain('display: none');
    expect(rule('.md-composer-live > .md-composer-surface')).toContain('display: block');
    expect(rule('.md-composer-live > textarea')).toContain('display: none');
  });

  it('clamps its height — a growing composer must not push itself off screen', () => {
    // The preview this replaced was measured doing exactly that at 820px.
    expect(rule('.md-composer-surface')).toMatch(/max-height:\s*min\(/);
    expect(rule('.md-composer-surface')).toContain('overflow-y: auto');
  });

  it('renders the placeholder, which is the only label these boxes have', () => {
    expect(
      rule('.md-composer-surface .ProseMirror p.is-editor-empty:first-child::before'),
    ).toContain('attr(data-placeholder)');
  });

  it('keeps the document surface’s type off a composer nested inside it', () => {
    // An inline thread card lives inside `#editor` and carries a reply
    // composer, so `#editor .ProseMirror` as a DESCENDANT selector reached the
    // composer's editor and won — an id outranks any number of classes. The
    // measured result at 820px: an empty reply box 18px serif and 60vh tall,
    // with the Reply button pushed off the bottom of the screen.
    // POSITIVE CONTROL: those rules are still here to be got wrong.
    expect(stripped).toContain('#editor > .ProseMirror');
    expect(stripped).not.toMatch(/#editor\s+\.ProseMirror/);
  });

  it('dresses the surface wherever a composer lives — one look per context', () => {
    // POSITIVE CONTROL: the extractor can see a rule that is definitely there.
    expect(stripped).toContain('.thread-reply textarea');
    for (const context of [
      '.thread-reply',
      '.hub-comment-form',
      '.hub-answer-form',
      '.hub-walk-answer',
      '.composer-inner',
    ]) {
      expect(stripped, `${context} does not dress .md-composer-surface`).toContain(
        `${context} .md-composer-surface`,
      );
    }
  });
});
