/**
 * Bare workspace URLs pasted into a comment render as the linked resource's
 * TITLE, not the raw address (render-time only — the stored comment text is
 * never rewritten). All ids/hosts are synthetic fixtures; the repo is public.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { renderCommentMarkdown } from '../src/comment-markdown.ts';
import { _resetLinkTitlesForTest, hydrateLinkTitles, primeLinkTitle } from '../src/link-titles.ts';

const DOC_URL = 'http://reviewhost.example:8787/workspaces/w-abc123/docs/doc-1';

beforeEach(() => {
  _resetLinkTitlesForTest();
});

describe('renderCommentMarkdown — bare workspace URLs', () => {
  it('turns a bare workspace URL into an anchor marked for title hydration', () => {
    const out = renderCommentMarkdown(`see ${DOC_URL} for details`);
    expect(out).toContain(`<a href="${DOC_URL}"`);
    expect(out).toContain('data-ws-link=');
    // Until the title resolves, the visible text is the raw URL — never blank.
    expect(out).toContain(`>${DOC_URL}</a>`);
  });

  it('renders the title synchronously when it is already cached', () => {
    primeLinkTitle(DOC_URL, 'Redline Design');
    const out = renderCommentMarkdown(DOC_URL);
    expect(out).toContain('>Redline Design</a>');
    expect(out).toContain(`<a href="${DOC_URL}"`);
  });

  it('escapes a hostile cached title', () => {
    primeLinkTitle(DOC_URL, '<img src=x onerror=alert(1)>');
    const out = renderCommentMarkdown(DOC_URL);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('leaves the label of an explicit markdown link alone — the author chose it', () => {
    const out = renderCommentMarkdown(`[the design doc](${DOC_URL})`);
    expect(out).toContain('>the design doc</a>');
    expect(out).not.toContain('data-ws-link');
  });

  it('leaves non-workspace URLs untouched', () => {
    const out = renderCommentMarkdown('https://github.com/owner/repo/pull/1');
    expect(out).not.toContain('<a ');
    expect(out).toContain('https://github.com/owner/repo/pull/1');
  });

  it('leaves a URL inside inline code untouched', () => {
    const out = renderCommentMarkdown(`\`${DOC_URL}\``);
    expect(out).not.toContain('<a ');
    expect(out).toContain(`<code>${DOC_URL}</code>`);
  });

  it('does not swallow trailing punctuation or an escaped bracket', () => {
    const out = renderCommentMarkdown(`(${DOC_URL})`);
    expect(out).toContain(`<a href="${DOC_URL}"`);
    expect(out).toContain(`>${DOC_URL}</a>)`);
  });

  it('linkifies a bare RELATIVE workspace path', () => {
    const out = renderCommentMarkdown('see /review/doc-1 next');
    expect(out).toContain('<a href="/review/doc-1"');
    expect(out).toContain('>/review/doc-1</a>');
  });
});

describe('hydrateLinkTitles', () => {
  const mount = (markdown: string): HTMLElement => {
    const el = document.createElement('div');
    el.innerHTML = renderCommentMarkdown(markdown);
    document.body.appendChild(el);
    return el;
  };

  it('swaps the raw URL for the resolved title, keeping the href', async () => {
    const el = mount(DOC_URL);
    const fetcher = async () =>
      new Response(JSON.stringify({ titles: { [DOC_URL]: 'Redline Design' } }), { status: 200 });
    await hydrateLinkTitles(el, fetcher);
    const a = el.querySelector('a');
    expect(a?.textContent).toBe('Redline Design');
    expect(a?.getAttribute('href')).toBe(DOC_URL);
  });

  it('keeps the raw URL when the server cannot resolve the id', async () => {
    const el = mount(DOC_URL);
    const fetcher = async () =>
      new Response(JSON.stringify({ titles: { [DOC_URL]: null } }), { status: 200 });
    await hydrateLinkTitles(el, fetcher);
    expect(el.querySelector('a')?.textContent).toBe(DOC_URL);
  });

  it('keeps the raw URL when the lookup fails outright — never blank, never an error', async () => {
    const el = mount(DOC_URL);
    const fetcher = async () => {
      throw new Error('network down');
    };
    await hydrateLinkTitles(el, fetcher);
    expect(el.querySelector('a')?.textContent).toBe(DOC_URL);
  });

  it('resolves distinct URLs in one batch', async () => {
    const taskUrl = 'http://reviewhost.example:8787/workspaces/w-abc123?task=t-42fixture';
    const el = mount(`${DOC_URL}\n\n${taskUrl}`);
    let requested: string[] = [];
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      requested = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
      return new Response(
        JSON.stringify({ titles: { [DOC_URL]: 'Redline Design', [taskUrl]: 'Ship the widget' } }),
        { status: 200 },
      );
    };
    await hydrateLinkTitles(el, fetcher);
    expect(requested.sort()).toEqual([DOC_URL, taskUrl].sort());
    const texts = [...el.querySelectorAll('a')].map((a) => a.textContent);
    expect(texts).toContain('Redline Design');
    expect(texts).toContain('Ship the widget');
  });
});
