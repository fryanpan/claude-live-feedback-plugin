/**
 * The spin-off menu (src/spinoff-menu.ts) — the five ways a line of a huddle
 * doc leaves the doc as work.
 *
 * Two halves, tested apart: `runSpinoff` is the verb chain and is driven
 * entirely through an injected fetch, so no server runs here; `mountSpinoffMenu`
 * is the popover, and what matters about it is that every row is a real
 * control a keyboard and a thumb can both reach.
 *
 * The branch that decides a huddle doc gets this menu at all lives in
 * `app.ts`, which runs `main()` on import and cannot be mounted from a test
 * (see doc-meta.ts's own note on that seam). It is verified in a browser at
 * 1180×820 and 430px instead, and reported with the PR.
 *
 * Fixtures are synthetic (jordan@partner.example register).
 */
import type { User } from '@feedback/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPINOFF_ACTIONS,
  SPINOFF_QUESTION_TEXT,
  type SpinoffAnchor,
  type SpinoffDeps,
  boardIdFor,
  clipTitle,
  mountSpinoffMenu,
  runSpinoff,
  taskLinkHref,
} from '../src/spinoff-menu.ts';

const JORDAN: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#336699' };
const ANCHOR: SpinoffAnchor = {
  kind: 'text-range',
  startRel: [1, 2],
  endRel: [3, 4],
  snippet: { text: 'Check whether Cloudflare Access covers the mockup route too.' },
};

interface Call {
  url: string;
  method?: string;
  body: Record<string, unknown>;
}

function deps(over: Partial<SpinoffDeps> = {}): { deps: SpinoffDeps; calls: Call[] } {
  const calls: Call[] = [];
  const base: SpinoffDeps = {
    docId: 'd-huddle',
    workspaceId: 'w-board',
    user: JORDAN,
    quote: ANCHOR.snippet.text,
    anchor: ANCHOR,
    docTitle: 'Discussion — widget rollout',
    fetchJson: (url, init) => {
      calls.push({
        url,
        method: init?.method,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return Promise.resolve(
        url.endsWith('/threads') ? { thread: { id: 'th-1' } } : { task: { id: 't-99' } },
      );
    },
    ...over,
  };
  return { deps: base, calls };
}

describe('the five actions', () => {
  it('are the mock’s five, in its order', () => {
    expect(SPINOFF_ACTIONS.map((a) => a.id)).toEqual([
      'task',
      'start',
      'research',
      'question',
      'comment',
    ]);
    expect(SPINOFF_ACTIONS.map((a) => a.label)).toEqual([
      'Create a task',
      'Start now',
      'Research and come back',
      'Answer a question',
      'Leave a comment',
    ]);
  });
});

describe('clipTitle', () => {
  it('leaves a short line alone and collapses its whitespace', () => {
    expect(clipTitle('Ship the widget')).toBe('Ship the widget');
    expect(clipTitle('  Ship   the\nwidget  ')).toBe('Ship the widget');
  });

  it('cuts at a word boundary, never mid-word', () => {
    // The limit is chosen to land INSIDE "covers" — a limit that happens to
    // fall on a space passes whether the boundary walk exists or not, which
    // is exactly how the first draft of this test passed a mutant that had
    // deleted the walk.
    const long = 'Check whether Cloudflare Access covers the mockup route too and the share links';
    const out = clipTitle(long, 36);
    expect(out.length).toBeLessThanOrEqual(36);
    expect(out.endsWith('…')).toBe(true);
    const kept = out.slice(0, -1);
    // A prefix of the source…
    expect(long.startsWith(kept)).toBe(true);
    // …that ends where a word ends. The defect this prevents is
    // "…Access cov…", a word sliced in half by the generator.
    expect(long.slice(kept.length, kept.length + 1)).toMatch(/\s/);
    expect(kept.trimEnd()).toBe(kept);
  });

  it('still caps a single word with no boundary to fall back to', () => {
    const out = clipTitle('supercalifragilisticexpialidocious', 12);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('boardIdFor', () => {
  /**
   * The bug this was extracted for, found in a browser on staging: a huddle
   * doc has NO `meta.workspaceId` at all — its board is `backTo`. Reading the
   * wrong id gave the empty string, which is not `undefined`, so the
   * "is it on a board" guard passed and the create went to
   * `/api/workspaces//tasks`. The person got a toast reading "404".
   */
  it('prefers the board the doc was reached from', () => {
    expect(boardIdFor({ backTo: { workspaceId: 'w-board' }, workspaceId: 'w-grouping' })).toBe(
      'w-board',
    );
  });

  it('is the board of a huddle doc, which carries no grouping id at all', () => {
    expect(boardIdFor({ backTo: { workspaceId: 'w-board' }, workspaceId: '' })).toBe('w-board');
  });

  it('falls back to the grouping id when there is no board link', () => {
    // A diff review's own workspace: no `backTo`, and its grouping id IS
    // where a row filed from it belongs.
    expect(boardIdFor({ workspaceId: 'w-grouping' })).toBe('w-grouping');
  });

  it('treats every empty shape as no board — not as a board named ""', () => {
    // Each of these used to build `/api/workspaces//tasks`.
    expect(boardIdFor({})).toBe('');
    expect(boardIdFor({ workspaceId: '' })).toBe('');
    expect(boardIdFor({ backTo: {}, workspaceId: '' })).toBe('');
    expect(boardIdFor({ backTo: { workspaceId: '   ' }, workspaceId: '  ' })).toBe('');
  });
});

describe('taskLinkHref', () => {
  it('is the root-relative form the chip decorator recognises', () => {
    expect(taskLinkHref('w-board', 't-99')).toBe('/workspaces/w-board?task=t-99');
  });

  it('escapes ids rather than trusting them into a URL', () => {
    expect(taskLinkHref('w a/b', 't?1')).toBe('/workspaces/w%20a%2Fb?task=t%3F1');
  });
});

describe('runSpinoff', () => {
  it('Create a task files a row on the board, from the doc, owned by the presser', async () => {
    const { deps: d, calls } = deps();
    const made = await runSpinoff('task', d);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('/api/workspaces/w-board/tasks');
    expect(call.method).toBe('POST');
    expect(call.body.title).toBe(ANCHOR.snippet.text);
    // The author is the PERSON who tapped — an agent-authored create would
    // land at triage instead of todo, which is not what a tap means.
    expect(call.body.author).toEqual(JORDAN);
    // Where it came from, machine-readable…
    expect(call.body.origin).toEqual({ kind: 'doc', docId: 'd-huddle' });
    // …and in words, for whoever reads the ticket a week later.
    expect(String(call.body.body)).toContain('Discussion — widget rollout');
    expect(String(call.body.body)).toContain(ANCHOR.snippet.text);
    expect(made).toEqual({
      action: 'task',
      taskId: 't-99',
      href: '/workspaces/w-board?task=t-99',
    });
  });

  it('Start now is the same row placed at the top — not a status claim', async () => {
    const { deps: d, calls } = deps();
    await runSpinoff('start', d);
    expect(calls[0]?.body.order).toBe(0);
    // Nothing is actually being worked the instant somebody taps a line, so
    // the row must NOT claim in-progress, and there is no second call to
    // transition it.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.status).toBeUndefined();
    // Control: the plain create does NOT ask for the top.
    const plain = deps();
    await runSpinoff('task', plain.deps);
    expect(plain.calls[0]?.body.order).toBeUndefined();
  });

  it('Research and come back names itself as research in the title', async () => {
    const { deps: d, calls } = deps({ quote: 'Does Cloudflare Access cover the mockup route?' });
    await runSpinoff('research', d);
    expect(String(calls[0]?.body.title)).toBe(
      'Research: Does Cloudflare Access cover the mockup route?',
    );
  });

  it('keeps a research title inside the cap once the prefix is on it', async () => {
    const { deps: d, calls } = deps({ quote: 'x'.repeat(200) });
    await runSpinoff('research', d);
    expect(String(calls[0]?.body.title).length).toBeLessThanOrEqual(80);
    expect(String(calls[0]?.body.title).startsWith('Research: ')).toBe(true);
  });

  it('Answer a question opens an anchored thread — not a review item', async () => {
    const { deps: d, calls } = deps();
    const made = await runSpinoff('question', d);
    expect(calls[0]?.url).toBe('/api/docs/d-huddle/threads');
    expect(calls[0]?.body.anchor).toEqual(ANCHOR);
    expect(calls[0]?.body.text).toBe(SPINOFF_QUESTION_TEXT);
    // A `review` payload addresses a PERSON's Home queue. This asks the agent
    // watching the doc, which is what a plain thread's `thread.created` does.
    expect(calls[0]?.body.review).toBeUndefined();
    expect(made).toEqual({ action: 'question', threadId: 'th-1' });
    // No task, so nothing to link into the prose.
    expect(made?.href).toBeUndefined();
  });

  it('Leave a comment touches the network not at all', async () => {
    const { deps: d, calls } = deps();
    expect(await runSpinoff('comment', d)).toEqual({ action: 'comment' });
    expect(calls).toHaveLength(0);
  });

  it('reports a server that answered without an id rather than inventing one', async () => {
    const { deps: d } = deps({ fetchJson: () => Promise.resolve({}) });
    expect(await runSpinoff('task', d)).toBeNull();
    const { deps: q } = deps({ fetchJson: () => Promise.resolve({}) });
    expect(await runSpinoff('question', q)).toBeNull();
  });

  it('lets a refusal through to the caller instead of swallowing it', async () => {
    const { deps: d } = deps({ fetchJson: () => Promise.reject(new Error('workspace-retired')) });
    await expect(runSpinoff('task', d)).rejects.toThrow('workspace-retired');
  });
});

describe('mountSpinoffMenu', () => {
  let pill: HTMLElement;
  beforeEach(() => {
    document.body.replaceChildren();
    pill = document.createElement('button');
    document.body.append(pill);
  });

  function rows(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.spinoff-menu-item'));
  }

  it('renders one real control per action, labelled and named for a screen reader', () => {
    const menu = mountSpinoffMenu({ anchorEl: pill, onPick: () => {} });
    expect(rows()).toHaveLength(5);
    expect(rows().map((r) => r.textContent)).toEqual(SPINOFF_ACTIONS.map((a) => a.label));
    for (const row of rows()) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.getAttribute('role')).toBe('menuitem');
    }
    expect(document.querySelector('.spinoff-menu')?.getAttribute('role')).toBe('menu');
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    menu.destroy();
  });

  it('renders a label as TEXT, never as markup', () => {
    // The labels are ours today; the row builder must stay markup-free so
    // that stays true of whatever is added to the list later.
    const menu = mountSpinoffMenu({ anchorEl: pill, onPick: () => {} });
    const label = document.querySelector('.spinoff-menu-label') as HTMLElement;
    expect(label.children).toHaveLength(0);
    menu.destroy();
  });

  it('picks an action, closes, and does not also call dismiss', () => {
    const onPick = vi.fn();
    const onDismiss = vi.fn();
    mountSpinoffMenu({ anchorEl: pill, onPick, onDismiss });
    rows()[1]?.click();
    expect(onPick).toHaveBeenCalledWith('start');
    expect(onDismiss).not.toHaveBeenCalled();
    expect(document.querySelector('.spinoff-menu')).toBeNull();
    expect(pill.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on the scrim and on Escape, reporting a dismissal each time', () => {
    const onDismiss = vi.fn();
    mountSpinoffMenu({ anchorEl: pill, onPick: () => {}, onDismiss });
    document.querySelector<HTMLElement>('.spinoff-menu-scrim')?.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.spinoff-menu')).toBeNull();

    mountSpinoffMenu({ anchorEl: pill, onPick: () => {}, onDismiss });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.spinoff-menu')).toBeNull();
  });

  it('stops listening once destroyed — a later Escape reaches nothing', () => {
    const onDismiss = vi.fn();
    const menu = mountSpinoffMenu({ anchorEl: pill, onPick: () => {}, onDismiss });
    menu.destroy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onDismiss).not.toHaveBeenCalled();
    // And destroying twice is not an error the caller has to guard.
    expect(() => menu.destroy()).not.toThrow();
  });

  it('gives the keyboard somewhere to land', () => {
    const menu = mountSpinoffMenu({ anchorEl: pill, onPick: () => {} });
    expect(document.activeElement).toBe(rows()[0]);
    menu.destroy();
  });
});
