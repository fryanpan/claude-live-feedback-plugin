/**
 * The spin-off verbs (src/spinoff-menu.ts) — the two ways a line of a huddle
 * doc leaves the doc as work.
 *
 * `runSpinoff` is the verb chain and is driven entirely through an injected
 * fetch, so no server runs here. The pill that offers the two verbs is
 * `pointer-pill.ts`, tested beside this file.
 *
 * The branch that decides a huddle doc gets the pill at all lives in the
 * per-doc markdown mount in `app.ts`, which the boot suite does not reach:
 * `bootApp` is driveable, but `mountMarkdown` runs per doc rather than per
 * page. It is verified in a browser at 1180×820 and 430px instead, and
 * reported with the PR.
 *
 * Fixtures are synthetic (jordan@partner.example register).
 */
import type { User } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import {
  POINTER_PILL_ACTIONS,
  SPINOFF_ACTIONS,
  type SpinoffAnchor,
  type SpinoffDeps,
  boardIdFor,
  clipTitle,
  deriveTaskTitle,
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
      // No path makes a GET any more (the research path's lead lookup moved
      // to the server); answering one keeps the helper honest if that changes.
      if (init?.method !== 'POST') return Promise.resolve({ leadAgentId: 'Workspaces' });
      if (url.endsWith('/research-request')) {
        return Promise.resolve({ threadId: 'th-1', section: 'Research: …', placeholder: true });
      }
      return Promise.resolve({ task: { id: 't-99' } });
    },
    ...over,
  };
  return { deps: base, calls };
}

/** The create, found by method rather than by index. */
function created(calls: Call[]): Call | undefined {
  return calls.find((c) => c.method === 'POST');
}

describe('the two actions', () => {
  it('are exactly Research and Create Task, in that order, as plain text', () => {
    // Bryan's round-4 call (2026-09-01): two text buttons and nothing else.
    // "Start now" went because it was "Create a task" under another name;
    // "Answer a question" and "Leave a comment" went with the menu they
    // lived in, since both only ever opened the composer.
    expect(SPINOFF_ACTIONS.map((a) => a.id)).toEqual(['research', 'task']);
    expect(SPINOFF_ACTIONS.map((a) => a.label)).toEqual(['Research', 'Create Task']);
    for (const a of SPINOFF_ACTIONS) expect(Object.keys(a).sort()).toEqual(['id', 'label']);
  });

  it('the pointer pill offers Comment ahead of the two spin-offs, with Research in the accent', () => {
    // Owner (2026-09-01): "keep a comment option available" — the first cut
    // of the pill carried only the spin-offs.
    expect(POINTER_PILL_ACTIONS.map((a) => a.id)).toEqual(['comment', 'research', 'task']);
    expect(POINTER_PILL_ACTIONS.map((a) => a.label)).toEqual([
      'Comment',
      'Research',
      'Create Task',
    ]);
    expect(POINTER_PILL_ACTIONS.filter((a) => a.primary === true).map((a) => a.id)).toEqual([
      'research',
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
    // …and the way back: the doc under its board, root-relative, so the
    // row can be followed to the line it came from.
    expect(String(call.body.body)).toContain('](/workspaces/w-board/docs/d-huddle)');
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
    const made = await runSpinoff('task', d);
    expect(made?.action === 'task' ? made.title : undefined).toBe('Cloudflare Access');
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
      const made = await runSpinoff('task', d);
      expect(made?.action === 'task' ? made.status : undefined).toBe('triage');
    });
  });

  describe('Research', () => {
    // It used to file a lead-addressed task. Bryan pressed it on prod and
    // found a board row where the approved mock had a section in the notes
    // (2026-09-01: "it just creates a task — does not follow the flow in
    // the mockups"). Now the ask goes to the DOC: an anchored thread on the
    // selected line plus a placeholder section under it, both the server's
    // doing over one route.
    it('asks the doc, on the selected line, and files no task', async () => {
      const { deps: d, calls } = deps({ quote: 'Does Cloudflare Access cover the mockup route?' });
      const made = await runSpinoff('research', d);
      expect(made).toEqual({
        action: 'research',
        threadId: 'th-1',
        section: 'Research: …',
        placeholder: true,
      });
      // ONE round trip, to the doc — no create anywhere.
      expect(calls.map((c) => c.url)).toEqual(['/api/docs/d-huddle/research-request']);
    });

    it('sends the presser, the selection as the anchor, and the topic as a title', async () => {
      const { deps: d, calls } = deps({ quote: 'Does Cloudflare Access cover the mockup route?' });
      await runSpinoff('research', d);
      const ask = created(calls);
      expect(ask?.url).toBe('/api/docs/d-huddle/research-request');
      expect(ask?.body.author).toEqual(JORDAN);
      expect(ask?.body.anchor).toEqual(ANCHOR);
      // The topic is the selection read as a title — marker and trailing
      // seam gone — and NOT prefixed here: the server owns the heading.
      expect(ask?.body.topic).toBe('Does Cloudflare Access cover the mockup route?');
      expect(ask?.body.title).toBeUndefined();
      expect(ask?.body.assignToLead).toBeUndefined();
    });

    it('keeps the topic short enough for a heading once the prefix is on it', async () => {
      const { deps: d, calls } = deps({ quote: 'x'.repeat(200) });
      await runSpinoff('research', d);
      expect(String(created(calls)?.body.topic).length).toBeLessThanOrEqual(70);
    });

    it('falls back to its own heading when the server names none', async () => {
      const { deps: d } = deps({
        quote: 'Check the mockup route',
        fetchJson: () => Promise.resolve({ threadId: 'th-8' }),
      });
      const made = await runSpinoff('research', d);
      expect(made).toEqual({
        action: 'research',
        threadId: 'th-8',
        section: 'Research: Check the mockup route',
        placeholder: false,
      });
    });

    it('does not address the ordinary create to the board', async () => {
      // A to-do somebody captures is theirs; only research is the agent's.
      const { deps: d, calls } = deps();
      await runSpinoff('task', d);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body.assignToLead).toBeUndefined();
    });
  });

  it('asks the board to PLACE the row — top active goal, the lead, todo', async () => {
    // Bryan (2026-09-01): "Tasks were created in Backlog and not
    // automatically started". The rule is the server's; the pill asks.
    const { deps: d, calls } = deps();
    await runSpinoff('task', d);
    expect(calls[0]?.body.spinoff).toBe(true);
    // And names no goal or owner itself — an explicit one would override
    // the rule, and the pill has no better information than the board.
    expect(calls[0]?.body.goal).toBeUndefined();
    expect(calls[0]?.body.assignee).toBeUndefined();
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

  it('reports a server that answered without an id rather than inventing one', async () => {
    for (const action of ['task', 'research'] as const) {
      const { deps: d } = deps({ fetchJson: () => Promise.resolve({}) });
      expect(await runSpinoff(action, d)).toBeNull();
    }
    // And a research answer with a thread id but the wrong type is no id.
    const { deps: d } = deps({ fetchJson: () => Promise.resolve({ threadId: 7 }) });
    expect(await runSpinoff('research', d)).toBeNull();
  });

  it('lets a refusal through to the caller instead of swallowing it', async () => {
    const { deps: d } = deps({ fetchJson: () => Promise.reject(new Error('workspace-retired')) });
    await expect(runSpinoff('task', d)).rejects.toThrow('workspace-retired');
  });
});
