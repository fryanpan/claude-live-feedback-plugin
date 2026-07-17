import { computeRedline } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import {
  annotateBlockMarkdown,
  applyAttrs,
  renderRedlineHtml,
  stripTrailingEmptyParagraphs,
} from '../src/redline/redline-html.ts';

/** Stand-in for the scratch-editor conversion: wraps in <p> so the attribute
 *  injection has an element to land on, without pulling Tiptap into a unit
 *  test of pure string handling. */
const fakeToHtml = (md: string) => `<p>${md}</p>`;

describe('annotateBlockMarkdown', () => {
  it('wraps changed words and leaves same text bare', () => {
    const blocks = computeRedline('The quick brown fox.\n', 'The quick red fox.\n');
    const md = annotateBlockMarkdown(blocks[0].segments);
    expect(md).toContain('<del>brown</del>');
    expect(md).toContain('<ins>red</ins>');
    expect(md).toContain('The quick');
  });

  it('keeps a leading heading marker literal', () => {
    // Wrapping the `## ` would render the heading as a paragraph of
    // struck-through hashes.
    const md = annotateBlockMarkdown([
      { kind: 'same', text: '## ' },
      { kind: 'del', text: 'Old' },
      { kind: 'ins', text: 'New' },
    ]);
    expect(md.startsWith('## ')).toBe(true);
    expect(md).toContain('<del>Old</del>');
  });

  it('keeps a marker literal even when the marker itself is inserted', () => {
    // A new list item's `- ` is structure, not prose. Wrapped, it stops being
    // a list item at all.
    const md = annotateBlockMarkdown([{ kind: 'ins', text: '- new item' }]);
    expect(md.startsWith('- ')).toBe(true);
    expect(md).toContain('<ins>new item</ins>');
    expect(md).not.toContain('<ins>- ');
  });

  it('never lets a wrapper cross a newline', () => {
    // Probed: `- one\n<ins>- two</ins>` merges the items into "one - two".
    const md = annotateBlockMarkdown([{ kind: 'ins', text: '- one\n- two' }]);
    for (const line of md.split('\n')) {
      const opens = (line.match(/<ins>/g) ?? []).length;
      const closes = (line.match(/<\/ins>/g) ?? []).length;
      expect(opens).toBe(closes);
    }
    expect(md.split('\n')).toHaveLength(2);
  });

  it('handles markers on every line of a multi-item list, not just the first', () => {
    const md = annotateBlockMarkdown([
      { kind: 'same', text: '- one\n' },
      { kind: 'ins', text: '- two' },
    ]);
    expect(md.split('\n')[1].startsWith('- ')).toBe(true);
  });

  it('does not wrap whitespace-only runs', () => {
    const md = annotateBlockMarkdown([
      { kind: 'same', text: 'a' },
      { kind: 'ins', text: '  ' },
      { kind: 'same', text: 'b' },
    ]);
    expect(md).not.toContain('<ins>  </ins>');
  });

  it('reassembles a same-only block verbatim', () => {
    const text = '# Title with **bold** and a [link](http://x.test)';
    expect(annotateBlockMarkdown([{ kind: 'same', text }])).toBe(text);
  });
});

describe('applyAttrs', () => {
  it('puts attributes on the outer element', () => {
    const out = applyAttrs('<p>Body.</p>', { 'data-lf-from': '12', 'data-lf-to': '25' });
    expect(out).toContain('data-lf-from="12"');
    expect(out).toContain('data-lf-to="25"');
    expect(out).toContain('Body.');
  });

  it('preserves inner markup rather than flattening it', () => {
    const out = applyAttrs('<h2>A <del>x</del> b</h2>', { 'data-lf-from': '1' });
    expect(out).toContain('<del>x</del>');
    expect(out).toMatch(/^<h2 /);
  });

  it('is a no-op for no attributes', () => {
    expect(applyAttrs('<p>x</p>', {})).toBe('<p>x</p>');
  });

  it('returns the input unchanged when there is no element to attribute', () => {
    expect(applyAttrs('', { 'data-lf-from': '1' })).toBe('');
  });
});

describe('renderRedlineHtml', () => {
  it('emits from/to provenance for a block that exists on the new side', () => {
    const html = renderRedlineHtml(computeRedline('A.\n', 'A.\n\nB.\n'), fakeToHtml);
    expect(html).toMatch(/data-lf-from="\d+"/);
    expect(html).toMatch(/data-lf-to="\d+"/);
  });

  it('emits data-lf-snap instead of from/to on a deleted block', () => {
    const html = renderRedlineHtml(computeRedline('A.\n\nGone.\n\nC.\n', 'A.\n\nC.\n'), fakeToHtml);
    expect(html).toContain('data-lf-snap=');
    expect(html).toContain('<del>Gone.</del>');
  });

  it('marks changed blocks with data-lf-change and leaves same blocks unmarked', () => {
    const html = renderRedlineHtml(
      computeRedline('# T\n\nOne.\n', '# T\n\nOne changed.\n'),
      fakeToHtml,
    );
    expect(html).toContain('data-lf-change="changed"');
    // The untouched heading must not be marked as a change.
    const headingChunk = html.split('</p>')[0];
    expect(headingChunk).not.toContain('data-lf-change');
  });

  it('converts each block in isolation — one toHtml call per block', () => {
    const seen: string[] = [];
    renderRedlineHtml(computeRedline('A.\n\nB.\n', 'A.\n\nB.\n'), (md) => {
      seen.push(md);
      return `<p>${md}</p>`;
    });
    // Isolation is the point: a shared parse merges adjacent same-type lists.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('A.');
    expect(seen[1]).toContain('B.');
  });

  it('produces a block per redline block for a mixed document', () => {
    const blocks = computeRedline('# T\n\nAlpha.\n', '# T\n\nBeta.\n\n- x\n');
    const calls: string[] = [];
    renderRedlineHtml(blocks, (md) => {
      calls.push(md);
      return `<p>${md}</p>`;
    });
    expect(calls).toHaveLength(blocks.length);
  });
});

describe('stripTrailingEmptyParagraphs', () => {
  it('drops the trailing empty paragraph Tiptap appends after a block', () => {
    // Left in, it renders as blank filler AND inherits the real block's
    // provenance, so a comment can resolve onto the filler instead.
    expect(stripTrailingEmptyParagraphs('<h1>T</h1><p></p>')).toBe('<h1>T</h1>');
  });

  it('drops a trailing paragraph holding only a br placeholder', () => {
    const out = stripTrailingEmptyParagraphs(
      '<h1>T</h1><p><br class="ProseMirror-trailingBreak"></p>',
    );
    expect(out).toBe('<h1>T</h1>');
  });

  it('drops several trailing empties', () => {
    expect(stripTrailingEmptyParagraphs('<p>x</p><p></p><p></p>')).toBe('<p>x</p>');
  });

  it('keeps real content, including a paragraph with only an image', () => {
    expect(stripTrailingEmptyParagraphs('<p>real</p>')).toBe('<p>real</p>');
    const img = '<p><img src="x.png"></p>';
    expect(stripTrailingEmptyParagraphs(img)).toBe(img);
  });

  it('does not strip an empty paragraph that is not trailing', () => {
    expect(stripTrailingEmptyParagraphs('<p></p><p>x</p>')).toBe('<p></p><p>x</p>');
  });
});
