/**
 * Bare workspace URLs pasted into a comment render as the linked resource's
 * TITLE, not the raw address (render-time only — the stored comment text is
 * never rewritten). All ids/hosts are synthetic fixtures; the repo is public.
 *
 * Only SAME-ORIGIN URLs (and relative paths) qualify: a foreign-origin URL
 * that merely matches a workspace path shape must stay raw text, or a trusted
 * title would dress up an attacker's href.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { renderCommentMarkdown } from '../src/comment-markdown.ts';
import {
  _resetLinkTitlesForTest,
  hydrateLinkTitles,
  primeLinkTitle,
  staleTaskLinkStatuses,
} from '../src/link-titles.ts';

// happy-dom's page origin — the one origin the renderer may trust.
const DOC_URL = `${location.origin}/workspaces/w-abc123/docs/doc-1`;

beforeEach(() => {
  _resetLinkTitlesForTest();
});

describe('renderCommentMarkdown — bare workspace URLs', () => {
  it('turns a bare same-origin workspace URL into an anchor marked for title hydration', () => {
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

  it('keeps the label of an explicit markdown link but marks it for status hydration', () => {
    const out = renderCommentMarkdown(`[the design doc](${DOC_URL})`);
    // The author chose the text — the title never replaces it — but the
    // anchor is still marked so a task/goal target can grow a status chip.
    expect(out).toContain('>the design doc<');
    expect(out).toContain('data-ws-link=');
    expect(out).toContain('data-ws-custom');
  });

  it('leaves an explicit link to a NON-workspace URL entirely alone', () => {
    const out = renderCommentMarkdown('[the PR](https://github.com/owner/repo/pull/1)');
    expect(out).toContain('>the PR</a>');
    expect(out).not.toContain('data-ws-link');
  });

  it('leaves non-workspace URLs untouched', () => {
    const out = renderCommentMarkdown('https://github.com/owner/repo/pull/1');
    expect(out).not.toContain('<a ');
    expect(out).toContain('https://github.com/owner/repo/pull/1');
  });

  it('leaves a FOREIGN-origin URL raw even when its path matches a workspace shape', () => {
    // The spoofing path: a valid doc id on an attacker host. Linkifying it
    // and hydrating the trusted title would label a phishing href "Q3 Plan".
    const spoof = 'https://attacker.example/review/doc-1';
    primeLinkTitle(spoof, 'Q3 Plan'); // even a poisoned cache must not render
    const out = renderCommentMarkdown(`see ${spoof} now`);
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('Q3 Plan');
    expect(out).toContain(spoof);
  });

  it('treats a same-host different-port URL as foreign', () => {
    const otherPort = 'http://localhost:9999/review/doc-1';
    const out = renderCommentMarkdown(otherPort);
    expect(out).not.toContain('<a ');
    expect(out).toContain(otherPort);
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
    const taskUrl = `${location.origin}/workspaces/w-abc123?task=t-42fixture`;
    const el = mount(`${DOC_URL}\n\n${taskUrl}`);
    let requested: string[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
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

  it('appends a status chip when the server says the target is a task/goal', async () => {
    const taskUrl = `${location.origin}/workspaces/w-abc123?task=t-42fixture`;
    const el = mount(taskUrl);
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          titles: { [taskUrl]: 'Ship the widget' },
          statuses: { [taskUrl]: 'in-progress' },
        }),
        { status: 200 },
      );
    await hydrateLinkTitles(el, fetcher);
    const a = el.querySelector('a');
    expect(a?.textContent).toBe('Ship the widgetIn progress');
    const chip = a?.querySelector('.ws-status-chip');
    expect(chip?.textContent).toBe('In progress');
    expect(chip?.classList.contains('ws-chip-in-progress')).toBe(true);
  });

  it('keeps a custom label and still appends the chip', async () => {
    const taskUrl = `${location.origin}/workspaces/w-abc123?task=t-42fixture`;
    const el = mount(`[my words](${taskUrl})`);
    const fetcher = async () =>
      new Response(
        JSON.stringify({
          titles: { [taskUrl]: 'Ship the widget' },
          statuses: { [taskUrl]: 'done' },
        }),
        { status: 200 },
      );
    await hydrateLinkTitles(el, fetcher);
    const a = el.querySelector('a');
    expect(a?.textContent).toBe('my wordsDone');
    expect(a?.textContent).not.toContain('Ship the widget');
    expect(a?.querySelector('.ws-status-chip')?.classList.contains('ws-chip-done')).toBe(true);
  });

  it('adds no chip when the server returns no status for the URL', async () => {
    const el = mount(DOC_URL);
    const fetcher = async () =>
      new Response(JSON.stringify({ titles: { [DOC_URL]: 'Redline Design' } }), { status: 200 });
    await hydrateLinkTitles(el, fetcher);
    expect(el.querySelector('.ws-status-chip')).toBeNull();
  });

  it('renders the chip synchronously on re-render once the status is cached', () => {
    const taskUrl = `${location.origin}/workspaces/w-abc123?task=t-42fixture`;
    primeLinkTitle(taskUrl, 'Ship the widget', 'todo');
    const out = renderCommentMarkdown(taskUrl);
    expect(out).toContain(
      '>Ship the widget<span class="ws-status-chip ws-chip-todo">To do</span></a>',
    );
  });

  it('staleTaskLinkStatuses re-pends chipped anchors so the next pass refreshes them', async () => {
    const taskUrl = `${location.origin}/workspaces/w-abc123?task=t-42fixture`;
    const el = mount(taskUrl);
    const respond = (status: string) => async () =>
      new Response(
        JSON.stringify({
          titles: { [taskUrl]: 'Ship the widget' },
          statuses: { [taskUrl]: status },
        }),
        { status: 200 },
      );
    await hydrateLinkTitles(el, respond('todo'));
    expect(el.querySelector('.ws-status-chip')?.textContent).toBe('To do');

    staleTaskLinkStatuses(el);
    expect(el.querySelector('a')?.hasAttribute('data-ws-pending')).toBe(true);
    await hydrateLinkTitles(el, respond('done'));
    const chips = el.querySelectorAll('.ws-status-chip');
    expect(chips.length).toBe(1);
    expect(chips[0]?.textContent).toBe('Done');
  });

  it('keeps batching past the 100-URL cap until every pending link is resolved', async () => {
    // 120 distinct links: more than one batch. Anchors are built directly —
    // this is the hydrator's contract, not the renderer's.
    const el = document.createElement('div');
    const urls = Array.from({ length: 120 }, (_, i) => `/review/bulk-${i}`);
    el.innerHTML = urls
      .map((u) => `<a href="${u}" data-ws-link="${u}" data-ws-pending="">${u}</a>`)
      .join(' ');
    document.body.appendChild(el);
    const batches: number[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      const asked = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
      batches.push(asked.length);
      const titles = Object.fromEntries(asked.map((u) => [u, `Title ${u}`]));
      return new Response(JSON.stringify({ titles }), { status: 200 });
    };
    await hydrateLinkTitles(el, fetcher);
    expect(batches).toEqual([100, 20]);
    const pending = el.querySelectorAll('a[data-ws-pending]');
    expect(pending.length).toBe(0);
    expect(el.querySelector(`a[data-ws-link="/review/bulk-119"]`)?.textContent).toBe(
      'Title /review/bulk-119',
    );
  });
});
