import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { attachMarkdownField } from '../src/md-field.ts';

/**
 * Every composer is a markdown editor (approved design, review-flow-mock-v1,
 * design point 4): recorded answers RENDER markdown, so the box they were
 * typed into must say it speaks markdown and show what the words will become.
 *
 * The preview is input-driven and hidden while the box is empty — an
 * untouched composer stays one control tall, because the iPad's scarce axis
 * is height and most composers on a screen are never typed into.
 */

let form: HTMLFormElement;
let ta: HTMLTextAreaElement;

beforeEach(() => {
  document.body.replaceChildren();
  form = document.createElement('form');
  ta = document.createElement('textarea');
  form.append(ta);
  document.body.append(form);
});

/** Type the way a person does: value + the input event the browser fires. */
function type(value: string): void {
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

const preview = () => form.querySelector<HTMLElement>('.md-preview');

describe('attachMarkdownField', () => {
  it('says Markdown once, quietly, with the cheat sheet beside it', () => {
    attachMarkdownField(ta);
    expect(form.querySelector('.md-affordance .md-badge')?.textContent).toBe('Markdown');
    expect(form.querySelector('.md-affordance .md-hint')?.textContent).toBe(
      '**bold** · *italic* · `code` · [link](url) · - list',
    );
  });

  it('keeps the textarea in its form — attaching decorates, it does not move', () => {
    attachMarkdownField(ta);
    expect(ta.closest('form')).toBe(form);
  });

  it('stays one control tall until something is typed', () => {
    attachMarkdownField(ta);
    expect(preview()?.hidden).toBe(true);
    expect(preview()?.innerHTML).toBe('');
  });

  it('fills the preview in below as you type, rendered as markdown', () => {
    attachMarkdownField(ta);
    type('**two hops**');
    expect(preview()?.hidden).toBe(false);
    expect(preview()?.innerHTML).toContain('<strong>two hops</strong>');
  });

  it('hides and empties the preview when the box empties', () => {
    attachMarkdownField(ta);
    type('**two hops**');
    type('');
    expect(preview()?.hidden).toBe(true);
    expect(preview()?.innerHTML).toBe('');
  });

  it('whitespace is empty — a stray space does not open an empty preview', () => {
    attachMarkdownField(ta);
    type('   ');
    expect(preview()?.hidden).toBe(true);
  });

  it('keeps unsafe HTML escaped — the preview renders untrusted words', () => {
    attachMarkdownField(ta);
    type('<script>alert(1)</script> and <img src=x onerror=alert(1)>');
    expect(preview()?.querySelector('script')).toBeNull();
    expect(preview()?.querySelector('img')).toBeNull();
    expect(preview()?.innerHTML).toContain('&lt;script&gt;');
  });

  it('the returned refresh covers a programmatic clear — a send fires no input event', () => {
    const refresh = attachMarkdownField(ta);
    type('done, send it');
    // What every composer does on a successful send: set value directly.
    ta.value = '';
    refresh();
    expect(preview()?.hidden).toBe(true);
    expect(preview()?.innerHTML).toBe('');
  });
});

/**
 * happy-dom resolves no layout, so the stylesheet is read as text — same
 * pattern as `hub-decide-css.test.ts`, and for the same reason: classes
 * emitted with nothing styling them is a state no DOM test can see.
 */
describe('the markdown field is styled', () => {
  const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

  /** The body of one top-level rule, comments stripped. */
  function rule(selector: string): string {
    const at = new RegExp(
      `(^|\\n)${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    ).exec(stripped);
    return at?.[2] ?? '';
  }

  /** Every `@media (<q>) { … }` block's contents, brace-matched. */
  function mediaBlocks(q: string): string[] {
    const blocks: string[] = [];
    let i = stripped.indexOf(`@media (${q})`);
    while (i !== -1) {
      const open = stripped.indexOf('{', i);
      let depth = 1;
      let j = open + 1;
      while (depth > 0 && j < stripped.length) {
        if (stripped[j] === '{') depth += 1;
        else if (stripped[j] === '}') depth -= 1;
        j += 1;
      }
      blocks.push(stripped.slice(open + 1, j - 1));
      i = stripped.indexOf(`@media (${q})`, j);
    }
    return blocks;
  }

  it('styles every class the field emits', () => {
    for (const sel of ['.md-field', '.md-affordance', '.md-badge', '.md-hint', '.md-preview']) {
      expect(rule(sel), `no rule for ${sel}`).not.toBe('');
    }
  });

  it('the hint is monospace — it is showing syntax, not prose', () => {
    expect(rule('.md-hint')).toContain('--mono');
  });

  it('a hidden preview takes no height', () => {
    expect(rule('.md-preview[hidden]')).toContain('display: none');
  });

  it('drops the cheat sheet at phone width, so the badge alone carries it', () => {
    // POSITIVE CONTROL first: the extractor found the 720px band at all.
    const bands = mediaBlocks('max-width: 720px');
    expect(bands.length).toBeGreaterThan(0);
    const withHint = bands.filter((b) => b.includes('.md-hint'));
    expect(withHint.length, 'no 720px rule mentions .md-hint').toBeGreaterThan(0);
    expect(withHint.some((b) => /\.md-hint[^}]*\{[^}]*display:\s*none/.test(b))).toBe(true);
  });
});
