/**
 * The spin-off menu (src/spinoff-menu.ts) — the four ways a line of a huddle
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
  SPINOFF_QUESTION_PREFILL,
  type SpinoffAnchor,
  type SpinoffDeps,
  boardIdFor,
  clipTitle,
  deriveTaskTitle,
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
      // The doc GET is the research path's lead lookup — a second call, and
      // the reason the create is found by method rather than by index.
      if (init?.method !== 'POST') return Promise.resolve({ leadAgentId: 'Workspaces' });
      return Promise.resolve(
        url.endsWith('/threads') ? { thread: { id: 'th-1' } } : { task: { id: 't-99' } },
      );
    },
    ...over,
  };
  return { deps: base, calls };
}

/** The create, found by method — the research path makes a GET first. */
function created(calls: Call[]): Call | undefined {
  return calls.find((c) => c.method === 'POST');
}

describe('the four actions', () => {
  it('are four, in frequency order — "Start now" is gone', () => {
    // It was second, and it did what "Create a task" did plus `order: 0`.
    // Two rows with one outcome is not a choice, and a reviewer could not
    // tell them apart in the running product (Bryan's call, 2026-09-01).
    expect(SPINOFF_ACTIONS.map((a) => a.id)).toEqual(['task', 'research', 'question', 'comment']);
    expect(SPINOFF_ACTIONS.map((a) => a.label)).toEqual([
      'Create a task',
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

/**
 * The titles a fresh-eyes review actually got on the board, and what each
 * should have been. What shipped first was the raw selection, so a tap on a
 * heading filed a row called "## Cloudflare".
 */
describe('deriveTaskTitle', () => {
  it('keeps an ordinary line as it stands', () => {
    expect(deriveTaskTitle('Check whether Access covers the mockup route')).toBe(
      'Check whether Access covers the mockup route',
    );
  });

  it('drops the markdown marker, which is structure and not words', () => {
    expect(deriveTaskTitle('## Cloudflare Access')).toBe('Cloudflare Access');
    expect(deriveTaskTitle('- Check the tunnel config')).toBe('Check the tunnel config');
    expect(deriveTaskTitle('* Check the tunnel config')).toBe('Check the tunnel config');
    expect(deriveTaskTitle('1. Check the tunnel config')).toBe('Check the tunnel config');
    expect(deriveTaskTitle('2) Check the tunnel config')).toBe('Check the tunnel config');
    expect(deriveTaskTitle('> Check the tunnel config')).toBe('Check the tunnel config');
  });

  it('takes the first sentence and leaves the elaboration to the body', () => {
    expect(
      deriveTaskTitle('Do the iPad review pass. It has to happen before we share anything.'),
    ).toBe('Do the iPad review pass');
  });

  it('does not read an abbreviation as the end of the sentence', () => {
    // The `{12,}` floor. Without it this files a row called "Ask Dr".
    expect(deriveTaskTitle('Ask Dr. Reyes whether the tunnel is in scope')).toBe(
      'Ask Dr. Reyes whether the tunnel is in scope',
    );
  });

  it('ends on a word, never on the comma a clipped clause ends with', () => {
    expect(deriveTaskTitle('so we should check whether Access covers it,')).toBe(
      'so we should check whether Access covers it',
    );
    expect(deriveTaskTitle('Ship the widget —')).toBe('Ship the widget');
  });

  it('flattens the whitespace a multi-line selection carries', () => {
    expect(deriveTaskTitle('  Ship   the\nwidget  ')).toBe('Ship the widget');
  });

  it('still caps a long line, at a word boundary', () => {
    const long = `${'word '.repeat(40)}end`;
    const out = deriveTaskTitle(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to the raw words rather than filing an empty title', () => {
    // Everything the tidying steps strip, and nothing else. A row with no
    // title at all is worse than a row called "???".
    expect(deriveTaskTitle('???')).toBe('???');
    expect(deriveTaskTitle('##')).toBe('##');
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
    // The TITLE is derived, not the raw selection — the trailing full stop
    // is a seam between two sentences and not part of the row's name.
    expect(call.body.title).toBe('Check whether Cloudflare Access covers the mockup route too');
    // The author is the PERSON who tapped — an agent-authored create would
    // land at triage instead of todo, which is not what a tap means.
    expect(call.body.author).toEqual(JORDAN);
    // Where it came from, machine-readable…
    expect(call.body.origin).toEqual({ kind: 'doc', docId: 'd-huddle' });
    // …and in words, VERBATIM, for whoever reads the ticket a week later:
    // the body quotes what was actually said, punctuation and all, which is
    // the half the title is allowed to tidy because the body keeps it.
    expect(String(call.body.body)).toContain('Discussion — widget rollout');
    expect(String(call.body.body)).toContain(ANCHOR.snippet.text);
    expect(made).toEqual({
      action: 'task',
      taskId: 't-99',
      title: 'Check whether Cloudflare Access covers the mockup route too',
      href: '/workspaces/w-board?task=t-99',
    });
  });

  it('hands the title back, so the toast can name what it made', async () => {
    // The reviewer got "Task created." over and over with no way to tell
    // which row, or whether the title had come out sane, without leaving the
    // doc for the board.
    const { deps: d } = deps({ quote: '## Cloudflare Access' });
    expect((await runSpinoff('task', d))?.title).toBe('Cloudflare Access');
  });

  /**
   * Where a spun-off row lands, now that "Start now" is gone and the button
   * pressed no longer decides it. A person's create normally lands in To do;
   * a spin-off's words are SELECTED rather than written, and the reviewer's
   * pass filed rows called "Cloudflare" that nobody could pick up.
   */
  describe('To do or Triage', () => {
    it('sends a row nobody could act on to Triage', async () => {
      const { deps: d, calls } = deps({ quote: 'Cloudflare' });
      await runSpinoff('task', d);
      expect(calls[0]?.body.title).toBe('Cloudflare');
      expect(calls[0]?.body.triage).toBe(true);
    });

    it('leaves a row with something to do in it alone, for To do', async () => {
      const { deps: d, calls } = deps();
      await runSpinoff('task', d);
      // Nothing said means the ordinary person-filed derivation, which is
      // To do — the claim is only ever made in one direction.
      expect(calls[0]?.body.triage).toBeUndefined();
    });

    it('reads the column back off the server instead of predicting it', async () => {
      // The toast names the column. If this were predicted client-side, the
      // toast could tell somebody their row is somewhere it is not.
      const { deps: d } = deps({
        fetchJson: () => Promise.resolve({ task: { id: 't-99', status: 'triage' } }),
      });
      expect((await runSpinoff('task', d))?.status).toBe('triage');
    });
  });

  describe('Research and come back', () => {
    it('belongs to the board’s agent, not to whoever tapped it', async () => {
      // Left unsaid, the create route falls the assignee back to the author —
      // which put "go and find out about this" on the plate of the person who
      // asked the question (Bryan, 2026-09-01).
      const { deps: d, calls } = deps();
      await runSpinoff('research', d);
      const create = created(calls);
      expect(create?.body.assignee).toBe('Workspaces');
      expect(create?.body.assigneeKind).toBe('agent');
      expect(create?.body.triage).toBeUndefined();
    });

    it('goes to Triage when no agent can be named, rather than to the tapper', async () => {
      // A research errand with nobody to run it says what to find out and not
      // who is finding it out, which is thin in the same way a two-word title
      // is. Guessing a name would be worse than routing it to be given one.
      const { deps: d, calls } = deps({
        fetchJson: (url, init) => {
          calls.push({
            url,
            method: init?.method,
            body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
          });
          if (init?.method !== 'POST') return Promise.resolve({});
          return Promise.resolve({ task: { id: 't-99', status: 'triage' } });
        },
      });
      await runSpinoff('research', d);
      const create = calls.find((c) => c.method === 'POST');
      expect(create?.body.assignee).toBeUndefined();
      expect(create?.body.triage).toBe(true);
    });

    it('survives a lead lookup that fails outright', async () => {
      const { deps: d, calls } = deps({
        fetchJson: (url, init) => {
          calls.push({
            url,
            method: init?.method,
            body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
          });
          if (init?.method !== 'POST') return Promise.reject(new Error('offline'));
          return Promise.resolve({ task: { id: 't-99' } });
        },
      });
      expect(await runSpinoff('research', d)).not.toBeNull();
      expect(calls.find((c) => c.method === 'POST')?.body.triage).toBe(true);
    });

    it('does NOT go looking for a lead on the ordinary create', async () => {
      // One round trip for a task, two for research. The lookup exists for
      // the one action whose owner is not the person who tapped it.
      const { deps: d, calls } = deps();
      await runSpinoff('task', d);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe('POST');
    });
  });

  it('asks for no placement of its own — where it lands is the row’s own doing', async () => {
    // "Start now" used to send `order: 0` and was otherwise identical to
    // "Create a task", which is why a reviewer could not tell them apart.
    // Bryan collapsed them (2026-09-01), and nothing may quietly reintroduce
    // a second placement rule keyed on which button was pressed.
    const { deps: d, calls } = deps();
    await runSpinoff('task', d);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.order).toBeUndefined();
    // And it does not claim a status either: nothing is actually being worked
    // the instant somebody taps a line.
    expect(calls[0]?.body.status).toBeUndefined();
  });

  it('Research and come back names itself as research in the title', async () => {
    const { deps: d, calls } = deps({ quote: 'Does Cloudflare Access cover the mockup route?' });
    await runSpinoff('research', d);
    expect(String(created(calls)?.body.title)).toBe(
      'Research: Does Cloudflare Access cover the mockup route?',
    );
  });

  it('keeps a research title inside the cap once the prefix is on it', async () => {
    const { deps: d, calls } = deps({ quote: 'x'.repeat(200) });
    await runSpinoff('research', d);
    expect(String(created(calls)?.body.title).length).toBeLessThanOrEqual(80);
    expect(String(created(calls)?.body.title).startsWith('Research: ')).toBe(true);
  });

  it('Answer a question posts NOTHING — the person writes their own words', async () => {
    // It used to POST a fixed sentence the instant the row was tapped, so a
    // thread appeared under somebody's name containing words they had never
    // written. One tap is not consent to be quoted.
    const { deps: d, calls } = deps();
    const made = await runSpinoff('question', d);
    expect(calls).toHaveLength(0);
    expect(made).toEqual({ action: 'question' });
    // Nothing was created, so there is nothing to link into the prose.
    expect(made?.href).toBeUndefined();
    expect(made?.threadId).toBeUndefined();
  });

  it('offers the question as a prefill the person can edit or clear', () => {
    // A starting point, not a sentence: it ends open so the ask continues it,
    // and it never claims anything on the person's behalf.
    expect(SPINOFF_QUESTION_PREFILL.trim().endsWith('?')).toBe(true);
    expect(SPINOFF_QUESTION_PREFILL.endsWith(' ')).toBe(true);
  });

  it('Leave a comment touches the network not at all', async () => {
    const { deps: d, calls } = deps();
    expect(await runSpinoff('comment', d)).toEqual({ action: 'comment' });
    expect(calls).toHaveLength(0);
  });

  it('reports a server that answered without an id rather than inventing one', async () => {
    // Only the two task-creating actions can hit this: `question` and
    // `comment` post nothing, so there is no id for a server to omit.
    for (const action of ['task', 'research'] as const) {
      const { deps: d } = deps({ fetchJson: () => Promise.resolve({}) });
      expect(await runSpinoff(action, d)).toBeNull();
    }
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
    expect(rows()).toHaveLength(4);
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
    expect(onPick).toHaveBeenCalledWith('research');
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
