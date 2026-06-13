import { describe, expect, it } from 'vitest';
import { renderCommentMarkdown } from '../src/comment-markdown.ts';

describe('renderCommentMarkdown', () => {
  it('escapes HTML — no XSS passthrough', () => {
    const out = renderCommentMarkdown('<img src=x onerror=alert(1)><script>alert(2)</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
    expect(out).toContain('&lt;script');
  });

  it('renders bold, italic, code, strike', () => {
    expect(renderCommentMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderCommentMarkdown('*it*')).toContain('<em>it</em>');
    expect(renderCommentMarkdown('_it_')).toContain('<em>it</em>');
    expect(renderCommentMarkdown('`code`')).toContain('<code>code</code>');
    expect(renderCommentMarkdown('~~s~~')).toContain('<del>s</del>');
  });

  it('renders http/https/mailto links, refuses javascript: urls', () => {
    const a = renderCommentMarkdown('[a](https://x.com/p)');
    expect(a).toContain('<a href="https://x.com/p" target="_blank" rel="noopener noreferrer">');
    expect(a).toContain('>a</a>');
    const js = renderCommentMarkdown('[a](javascript:alert(1))');
    expect(js).not.toContain('<a '); // no anchor created for an unsafe scheme
  });

  it('renders bullet lists', () => {
    const out = renderCommentMarkdown('- one\n- two');
    expect(out).toContain('<ul class="cm-list">');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<li>two</li>');
  });

  it('keeps inline-code content literal (snake_case is not italicized)', () => {
    expect(renderCommentMarkdown('`estimated_effort_h`')).toContain(
      '<code>estimated_effort_h</code>',
    );
  });

  it('splits blank-line-separated paragraphs and keeps single newlines as <br>', () => {
    const out = renderCommentMarkdown('line1\nline2\n\npara2');
    expect(out).toContain('line1<br>line2');
    expect(out.match(/<p>/g)?.length).toBe(2);
  });
});
