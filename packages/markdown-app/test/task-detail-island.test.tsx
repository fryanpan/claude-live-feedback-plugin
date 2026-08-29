import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Thread, User } from '@feedback/core';
import { options } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ActivityEvent,
  CHORES_ID,
  type HubNote,
  type HubTask,
  type HubTransition,
} from '../src/hub/hub-model.ts';
import type { DetailHandlers, TaskDiscussion } from '../src/hub/hub-render.ts';
import { mountTaskDetailIsland, taskDetailData } from '../src/hub/task-detail-island.tsx';
import { frame, surfaceOf, typeInComposer } from './support/composer.ts';

/**
 * The island's own contract, as opposed to what the panel SHOWS — that is
 * `hub-render.test.ts`, which drives the same island through the app's call
 * shape and is where every behavioural assertion still lives.
 *
 * What is pinned here is the four things that stop being true the moment the
 * panel goes back to being rebuilt from scratch: a wrapper of its own, a
 * disposal that tears the tree down instead of orphaning it, a wrapper that is
 * out of layout, and — the whole reason for the move — node identity across a
 * repaint. Before this, every one of those was carried by a snapshot taken
 * just before `replaceChildren()` and put back just after.
 *
 * All fixtures are synthetic.
 */

const NOW = 1_700_000_000_000;

// A signal write re-renders on the next microtask, which is still before the
// next paint and still after the next line of a test. Flushed inline.
options.debounceRendering = (cb: () => void) => cb();

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const handlers = (extra: Partial<DetailHandlers> = {}): DetailHandlers => ({
  onClose: vi.fn(),
  onStatusSet: vi.fn(),
  onTitleCommit: vi.fn(),
  onAnswer: vi.fn(),
  onAssign: vi.fn(),
  ...extra,
});

const EMPTY: TaskDiscussion = { loading: false, threads: [] };

/** A host with an island in it, disposed after the test. An island left alive
 *  keeps its subscription to the module-level signal, so the next test's first
 *  write would paint a panel into a detached tree. */
let live: (() => void) | null = null;
function mount(): HTMLElement {
  const host = document.createElement('div');
  host.className = 'hub-detail hidden';
  document.body.replaceChildren(host);
  live = mountTaskDetailIsland(host);
  return host;
}

/** A repaint: the same task, arriving again the way an SSE event delivers it.
 *  The object is fresh — `taskDetailData.value = <same object>` would not
 *  notify, and a test whose repaint is a no-op proves nothing. */
function repaint(t: HubTask, discussion?: TaskDiscussion, extra?: Partial<DetailHandlers>): void {
  taskDetailData.value = {
    task: { ...t },
    discussion,
    handlers: handlers(extra),
  };
}

afterEach(() => {
  live?.();
  live = null;
  taskDetailData.value = { task: null, handlers: handlers() };
});

describe('which tab the panel opens on', () => {
  const selected = (host: HTMLElement, id: string) =>
    host.querySelector(`.hub-detail-tab-${id}`)?.getAttribute('aria-selected') === 'true';
  const shown = (host: HTMLElement, id: string) =>
    host.querySelector(`.hub-detail-tabpanel-${id}`)?.classList.contains('hidden') === false;

  it('opens on Activity when the opener asks for it — the Home activity pane’s title tap', () => {
    const host = mount();
    taskDetailData.value = { task: task(), tab: 'activity', handlers: handlers() };
    expect(selected(host, 'activity')).toBe(true);
    expect(shown(host, 'activity')).toBe(true);
    expect(shown(host, 'comments')).toBe(false);
  });

  it('opens on Comments by default — a board row, a deep link (positive control)', () => {
    const host = mount();
    taskDetailData.value = { task: task(), handlers: handlers() };
    expect(selected(host, 'comments')).toBe(true);
    expect(shown(host, 'comments')).toBe(true);
    expect(shown(host, 'activity')).toBe(false);
  });
});

describe('the task detail island’s mount contract', () => {
  it('owns a dedicated wrapper and leaves the host’s vanilla children alone', () => {
    const host = document.createElement('div');
    const vanillaChild = document.createElement('p');
    vanillaChild.textContent = 'vanilla-owned';
    host.appendChild(vanillaChild);
    document.body.replaceChildren(host);

    taskDetailData.value = { task: task(), handlers: handlers() };
    const unmount = mountTaskDetailIsland(host);

    const wrapper = host.querySelector('[data-preact-island="task-detail"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.hub-detail-panel')).not.toBeNull();
    expect(host.firstChild).toBe(vanillaChild);

    unmount();
    // render(null, el) ran before el.remove(): teardown, not bare removal. An
    // orphaned tree keeps its effects, its ResizeObserver and its signal
    // subscription, and goes on answering events nobody can see.
    expect(wrapper?.childNodes.length).toBe(0);
    expect(host.querySelector('[data-preact-island="task-detail"]')).toBeNull();
    expect(host.firstChild).toBe(vanillaChild);
    expect(host.childNodes.length).toBe(1);
  });

  it('the wrapper is out of layout, so the panel stays a direct child of the backdrop', () => {
    // happy-dom resolves no layout, so this is pinned at the rule level:
    // `.hub-detail` is a centring flex container, and without
    // `display: contents` the wrapper — not the panel — becomes the flex item,
    // so the panel stretches to fill it and the `min(var(--hub-detail-w), …)`
    // width above stops describing anything on screen.
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const rule = css.match(/\.hub-detail\s*>\s*\[data-preact-island\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('display'); // positive control: found the rule
    expect(rule).toMatch(/display:\s*contents/);
  });

  it('closes on a backdrop tap, and stops listening once disposed', () => {
    const host = mount();
    const onClose = vi.fn();
    repaint(task(), EMPTY, { onClose });

    // The tap has to be the backdrop itself. A click inside the panel bubbles
    // through the same listener and must not close the task the reader is
    // reading — the assertion pair below is what tells those two apart.
    (host.querySelector('.hub-detail-panel') as HTMLElement).dispatchEvent(
      new Event('click', { bubbles: true }),
    );
    expect(onClose).not.toHaveBeenCalled();
    host.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);

    live?.();
    live = null;
    host.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the host when the panel closes, and shows it again on the next task', () => {
    const host = mount();
    repaint(task(), EMPTY);
    expect(host.classList.contains('hidden')).toBe(false);

    taskDetailData.value = { task: null, handlers: handlers() };
    expect(host.classList.contains('hidden')).toBe(true);
    expect(host.querySelector('.hub-detail-panel')).toBeNull();
    // Still mounted, though — the wrapper is the island's for as long as the
    // app runs, and a closed panel is a render of nothing rather than an
    // unmount.
    expect(host.querySelector('[data-preact-island="task-detail"]')).not.toBeNull();

    repaint(task(), EMPTY);
    expect(host.classList.contains('hidden')).toBe(false);
  });
});

describe('the task detail island keeps its nodes across a repaint', () => {
  it('reuses the panel and the head for the same task, and rebuilds them for another', () => {
    const host = mount();
    const t = task();
    repaint(t, EMPTY);
    const panel = host.querySelector('.hub-detail-panel');
    const title = host.querySelector('.hub-detail-title');
    expect(panel).not.toBeNull();

    // A status flip lands: the same ticket, drawn again.
    repaint({ ...t, status: 'in-progress' }, EMPTY);
    expect(host.querySelector('.hub-detail-panel')).toBe(panel);
    expect(host.querySelector('.hub-detail-title')).toBe(title);
    // …and it really was a repaint rather than a skipped render.
    expect(host.querySelector<HTMLSelectElement>('.hub-detail-status')?.value).toBe('in-progress');

    // A different ticket is a different panel. Keyed on the task id precisely
    // so this case does NOT reuse: one reader's half-typed comment must not
    // reappear in a box belonging to somebody else's task.
    repaint(task(), EMPTY);
    expect(host.querySelector('.hub-detail-panel')).not.toBe(panel);
  });

  it('keeps the comment composer itself — the node, its words and its caret', async () => {
    // The composer is the case that forced the island's shape. Attaching one
    // REPLACES the textarea with a wrapper and moves the textarea inside it,
    // so its DOM is not the DOM Preact rendered. The answer is that the
    // `<form>` is Preact's and its children are nobody's: a vnode with no
    // children diffs against nothing, so a repaint leaves everything inside
    // untouched.
    const host = mount();
    const t = task();
    repaint(t, EMPTY, { onComment: vi.fn() });
    const ta = host.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    expect(ta).not.toBeNull();
    const surface = surfaceOf(ta as HTMLTextAreaElement);
    expect(surface).not.toBeNull(); // control: a live editor, not a bare box
    await typeInComposer(ta as HTMLTextAreaElement, 'half a sentence', 4);

    repaint({ ...t, status: 'in-progress' }, EMPTY, { onComment: vi.fn() });
    await frame();

    const after = host.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    // The same node, so nothing had to be carried across: no `keepFields`
    // snapshot, no `restoreFields` pass, and no editor torn down and rebuilt
    // under a caret that was in it.
    expect(after).toBe(ta);
    expect(surfaceOf(after as HTMLTextAreaElement)).toBe(surface);
    expect(after?.value).toBe('half a sentence');
  });

  it('empties the composer when the panel moves to another task', async () => {
    // The other half of the same rule, and the reason identity is keyed rather
    // than global: a draft belongs to the ticket it was typed on.
    const host = mount();
    repaint(task(), EMPTY, { onComment: vi.fn() });
    const ta = host.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    await typeInComposer(ta as HTMLTextAreaElement, 'meant for this one');

    repaint(task(), EMPTY, { onComment: vi.fn() });
    await frame();
    const after = host.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    expect(after).not.toBe(ta);
    expect(after?.value).toBe('');
  });

  it('leaves an open capture open, because nothing writes `open` back', () => {
    // `<details open>` is deliberately NOT a prop. Passing it would make every
    // repaint an instruction to close what the reader opened — the same defect
    // in a new place, since Preact would be reasserting a value the DOM has
    // moved on from.
    const host = mount();
    const t = task({ quote: 'the original words, verbatim' });
    repaint(t, EMPTY);
    const quote = host.querySelector('.hub-detail-quote-block') as HTMLDetailsElement;
    quote.open = true;

    repaint({ ...t, status: 'in-progress' }, EMPTY);
    const after = host.querySelector('.hub-detail-quote-block') as HTMLDetailsElement;
    expect(after).toBe(quote);
    expect(after.open).toBe(true);
  });
});

// ── The Activity tab as ONE feed, and a feed that takes comments ───────────

const MIN = 60_000;
const ME: User = { id: 'u-me', name: 'Sam Reviewer', kind: 'known', color: '#2e7dd7' };

function note(agoMs: number, text: string, overrides: Partial<HubNote> = {}): HubNote {
  return { at: NOW - agoMs, kind: 'turn', text, agent: 'Beacon Bot', ...overrides };
}

function move(agoMs: number, from: string, to: string): HubTransition {
  return { ts: NOW - agoMs, from, to, by: { name: 'Beacon Bot', kind: 'agent' } };
}

function retitled(agoMs: number, taskId: string): ActivityEvent {
  return {
    event: 'task.retitled',
    ts: NOW - agoMs,
    taskId,
    actor: { name: 'Sam Reviewer' },
    titleFrom: 'Old name',
    titleTo: 'New name',
  };
}

/** Open `t` on its Activity tab with the feed handlers wired. Every call is
 *  a fresh handlers object, as every paint of the real app is. */
function openActivity(
  t: HubTask,
  extra: Partial<DetailHandlers> = {},
  events: ActivityEvent[] = [],
): DetailHandlers {
  const h = handlers({
    now: NOW,
    activity: events,
    user: ME,
    onActivityComment: vi.fn().mockResolvedValue(null),
    onActivityReply: vi.fn().mockResolvedValue(null),
    ...extra,
  });
  taskDetailData.value = { task: { ...t }, tab: 'activity', discussion: EMPTY, handlers: h };
  return h;
}

const rowsIn = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>('.hub-detail-transitions > li'),
];

/** The pill keys off `selectionchange`, debounced — wait it out. */
const settle = () => new Promise((r) => setTimeout(r, 160));

/** Select `phrase` inside `el` the way a finger does, and let the pill hear. */
async function select(el: Element, phrase: string): Promise<void> {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (t.data.includes(phrase)) {
      node = t;
      break;
    }
  }
  if (!node) throw new Error(`no text node holds “${phrase}”`);
  const r = document.createRange();
  r.setStart(node, node.data.indexOf(phrase));
  r.setEnd(node, node.data.indexOf(phrase) + phrase.length);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
  await settle();
}

function threadOn(phrase: string, text: string, id = 'th-1'): Thread {
  return {
    id,
    status: 'open',
    anchor: { kind: 'subject' },
    commentCount: 1,
    lastActivity: NOW,
    createdBy: ME,
    comments: [{ id: 'c-1', author: ME, text: `> ${phrase}\n\n${text}`, ts: NOW }],
  };
}

const pillIn = (host: HTMLElement) => host.querySelector('.hub-hist-pill') as HTMLElement;
const pillShown = (host: HTMLElement) => !pillIn(host).classList.contains('hidden');
const composer = (host: HTMLElement) =>
  host.querySelector('.acti-thread textarea') as HTMLTextAreaElement;
const replyButton = (host: HTMLElement) =>
  host.querySelector('.acti-thread .thread-actions button.primary') as HTMLButtonElement;
function reply(host: HTMLElement, text: string): void {
  composer(host).value = text;
  replyButton(host).click();
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the Activity tab is one feed: moves, audit rows and every note in full', () => {
  it('merges transitions, audit rows and notes newest first in one list', () => {
    const host = mount();
    const t = task({
      id: 't-feed',
      transitions: [move(30 * MIN, 'todo', 'in-progress')],
      notes: [note(2 * MIN, 'Newest note'), note(10 * MIN, 'Older note', { kind: 'status' })],
    });
    openActivity(t, {}, [retitled(5 * MIN, 't-feed'), retitled(50 * MIN, 't-other')]);
    const rows = rowsIn(host).map((li) => li.textContent ?? '');
    expect(rows.length).toBe(4);
    expect(rows[0]).toContain('Newest note');
    expect(rows[1]).toContain('renamed');
    expect(rows[2]).toContain('Older note');
    expect(rows[3]).toContain('todo → in-progress');
  });

  it('a note row names the agent, the age, its kind, and the WHOLE text as markdown', () => {
    const host = mount();
    const t = task({
      notes: [note(4 * MIN, 'Shipped the CSV route\n\n- writer done\n- download tests next')],
    });
    openActivity(t);
    const row = rowsIn(host)[0] as HTMLElement;
    expect(row.classList.contains('hub-hist-row-turn')).toBe(true);
    expect(row.querySelector('.hub-note-agent')?.textContent).toBe('Beacon Bot');
    expect(row.querySelector('.hub-note-age')?.textContent).toBe('4m');
    expect(row.querySelector('.hub-note-kind')?.textContent).toBe('turn');
    const body = row.querySelector('.hub-note-body') as HTMLElement;
    expect(body.querySelector('p')?.textContent).toBe('Shipped the CSV route');
    const bullets = [...body.querySelectorAll('li')].map((li) => li.textContent);
    expect(bullets).toEqual(['writer done', 'download tests next']);
    // Nothing folds a two-paragraph note.
    expect(body.classList.contains('is-folded')).toBe(false);
    expect(row.querySelector('.hub-note-more')).toBeNull();
  });

  it('a status note is labelled status; a denial is labelled blocked with its shape in code', () => {
    const host = mount();
    const t = task({
      notes: [
        note(1 * MIN, 'Waiting on CI', { kind: 'status' }),
        note(2 * MIN, 'rm -rf dist', { kind: 'denial' }),
      ],
    });
    openActivity(t);
    const [status, denial] = rowsIn(host) as [HTMLElement, HTMLElement];
    expect(status.querySelector('.hub-note-kind')?.textContent).toBe('status');
    expect(status.querySelector('.hub-note-body')?.textContent).toBe('Waiting on CI');
    expect(denial.classList.contains('hub-hist-row-denial')).toBe(true);
    expect(denial.querySelector('.hub-note-kind')?.textContent).toBe('blocked');
    // The kind token already says "blocked"; the body is just the shape.
    expect(denial.querySelector('.hub-note-body')?.textContent).toBe('rm -rf dist');
    expect(denial.querySelector('.hub-note-body code.acti-shape')?.textContent).toBe('rm -rf dist');
  });

  it('at an equal timestamp a move sorts above an audit row, and both above a note', () => {
    // The tie-break is the build order of the feed, pinned so a reorder of
    // the sources cannot silently change what the reader sees first.
    const host = mount();
    const t = task({
      id: 't-tie',
      transitions: [move(5 * MIN, 'todo', 'in-progress')],
      notes: [note(5 * MIN, 'Tied note')],
    });
    openActivity(t, {}, [retitled(5 * MIN, 't-tie')]);
    const rows = rowsIn(host).map((li) => li.textContent ?? '');
    expect(rows.length).toBe(3);
    expect(rows[0]).toContain('todo → in-progress');
    expect(rows[1]).toContain('renamed');
    expect(rows[2]).toContain('Tied note');
  });

  it('two notes from the same agent in the same millisecond both render', () => {
    // Row keys are built from a note's facts; two identical tuples used to
    // collide and Preact folded them into one row.
    const host = mount();
    const t = task({
      notes: [
        note(MIN, 'First status', { kind: 'status' }),
        note(MIN, 'Second status', { kind: 'status' }),
      ],
    });
    openActivity(t);
    const rows = rowsIn(host);
    expect(rows.length).toBe(2);
    const texts = rows.map((r) => r.querySelector('.hub-note-body')?.textContent);
    expect(texts).toEqual(['First status', 'Second status']);
    const keys = rows.map((r) => r.dataset.histKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('a fenced block in a note renders as one code block, not as prose lines', () => {
    const host = mount();
    const t = task({ notes: [note(MIN, 'Ran:\n```\n# not a heading\n- not a bullet\n```')] });
    openActivity(t);
    const body = rowsIn(host)[0]?.querySelector('.hub-note-body') as HTMLElement;
    expect(body.querySelector('pre.cm-code code')?.textContent).toBe(
      '# not a heading\n- not a bullet',
    );
    expect(body.querySelector('.cm-h')).toBeNull();
    expect(body.querySelector('li')).toBeNull();
    expect(body.textContent).not.toContain('```');
  });

  it('a long note folds after six lines behind a "more" toggle that opens it', () => {
    const host = mount();
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const t = task({ notes: [note(MIN, lines)] });
    openActivity(t);
    const row = rowsIn(host)[0] as HTMLElement;
    const body = row.querySelector('.hub-note-body') as HTMLElement;
    expect(body.classList.contains('is-folded')).toBe(true);
    const more = row.querySelector('.hub-note-more') as HTMLButtonElement;
    expect(more.textContent).toBe('more');
    more.click();
    expect(body.classList.contains('is-folded')).toBe(false);
    expect(more.textContent).toBe('less');
    // The choice survives a repaint of the same task.
    openActivity(t);
    expect(
      (rowsIn(host)[0] as HTMLElement)
        .querySelector('.hub-note-body')
        ?.classList.contains('is-folded'),
    ).toBe(false);
  });
});

describe('commenting on the feed like a doc', () => {
  const feedTask = () =>
    task({
      id: 't-c',
      title: 'Bryan can export a board as CSV',
      transitions: [move(30 * MIN, 'todo', 'in-progress')],
      notes: [
        note(MIN, 'CSV writer done; adding the download route next'),
        note(8 * MIN, 'Picked this up'),
      ],
    });

  afterEach(() => window.getSelection()?.removeAllRanges());

  it('selecting a phrase of a note shows the shared comment pill; a selection elsewhere hides it', async () => {
    const host = mount();
    openActivity(feedTask());
    const pill = pillIn(host);
    expect(pill, 'no pill rendered').not.toBeNull();
    expect(pill.classList.contains('comment-pill')).toBe(true);
    expect(pillShown(host)).toBe(false);
    await select(host.querySelector('.hub-detail-transitions') as Element, 'download route');
    expect(pillShown(host)).toBe(true);
    const elsewhere = document.createElement('p');
    elsewhere.textContent = 'other words';
    document.body.append(elsewhere);
    await select(elsewhere, 'other');
    expect(pillShown(host)).toBe(false);
    elsewhere.remove();
  });

  it('the pill is for the words only: an age, a kind label or an agent name gets none; a move row’s words do', async () => {
    const host = mount();
    openActivity(feedTask());
    const list = host.querySelector('.hub-detail-transitions') as HTMLElement;
    const selectAll = async (el: Element): Promise<void> => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
      await settle();
    };
    for (const sel of ['.hub-note-age', '.hub-note-kind', '.hub-note-agent']) {
      await selectAll(list.querySelector(sel) as Element);
      expect(pillShown(host), sel).toBe(false);
    }
    await select(list, 'todo → in-progress');
    expect(pillShown(host)).toBe(true);
  });

  it('the pill opens the real thread card UNDER that row, quoting the phrase and marking it in the note', async () => {
    const host = mount();
    openActivity(feedTask());
    const list = host.querySelector('.hub-detail-transitions') as HTMLElement;
    await select(list, 'download route');
    pillIn(host).click();
    const row = rowsIn(host)[0] as HTMLElement;
    const card = row.querySelector('.acti-thread .thread') as HTMLElement;
    expect(card, 'no .thread card under the note row').not.toBeNull();
    expect(card.classList.contains('expanded')).toBe(true);
    expect(card.querySelector('.thread-head .thread-who')?.textContent).toBe('Sam Reviewer');
    expect(card.querySelector('.thread-topic')?.textContent).toBe('download route');
    expect(composer(host).placeholder).toBe('Reply as Sam Reviewer…');
    const mark = row.querySelector('.hub-note-body mark.thread-range') as HTMLElement;
    expect(mark?.textContent).toBe('download route');
    expect(pillShown(host)).toBe(false);
    // One card: no other row carries one.
    expect(host.querySelectorAll('.acti-thread').length).toBe(1);
  });

  it('Reply posts the activity comment request for the phrase, then shows the thread; a further reply goes to it', async () => {
    const host = mount();
    const created = threadOn('download route', 'Which route?');
    const replied: Thread = {
      ...created,
      commentCount: 2,
      comments: [
        ...created.comments,
        { id: 'c-2', author: ME, text: 'And the auth?', ts: NOW + 1 },
      ],
    };
    const t = feedTask();
    const h = openActivity(t, {
      onActivityComment: vi.fn().mockResolvedValue(created),
      onActivityReply: vi.fn().mockResolvedValue(replied),
    });
    await select(host.querySelector('.hub-detail-transitions') as Element, 'download route');
    pillIn(host).click();
    reply(host, 'Which route?');
    expect(h.onActivityComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-c' }),
      { text: 'download route' },
      'Which route?',
    );
    await tick();
    await tick();
    const card = host.querySelector('.acti-thread .thread') as HTMLElement;
    expect(card.getAttribute('data-thread-id')).toBe('th-1');
    expect(card.querySelector('.thread-message')?.textContent).toContain('Which route?');
    expect(composer(host).value).toBe('');
    reply(host, 'And the auth?');
    expect(h.onActivityReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-c' }),
      'th-1',
      'And the auth?',
    );
    await tick();
    await tick();
    expect(host.querySelector('.acti-thread .comments')?.textContent).toContain('And the auth?');
  });

  it('a background repaint keeps the open draft card and the words being typed in it', async () => {
    const host = mount();
    const t = feedTask();
    openActivity(t);
    await select(host.querySelector('.hub-detail-transitions') as Element, 'download route');
    pillIn(host).click();
    composer(host).value = 'Which rou';
    // A board event: the same task, a new note on top, a fresh handlers object.
    openActivity(
      { ...t, notes: [note(10_000, 'Route landed'), ...(t.notes ?? [])] },
      { now: NOW + 5_000 },
    );
    const rows = rowsIn(host);
    expect(rows[0]?.textContent).toContain('Route landed');
    const card = rows[1]?.querySelector('.acti-thread .thread');
    expect(card, 'the draft card was closed by the repaint').not.toBeNull();
    expect(composer(host).value).toBe('Which rou');
  });

  it('Escape puts a draft away, and so does folding its card', async () => {
    const host = mount();
    openActivity(feedTask());
    await select(host.querySelector('.hub-detail-transitions') as Element, 'download route');
    pillIn(host).click();
    expect(host.querySelector('.acti-thread')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(host.querySelector('.acti-thread')).toBeNull();
    expect(host.querySelector('mark.thread-range')).toBeNull();
    await select(host.querySelector('.hub-detail-transitions') as Element, 'download route');
    pillIn(host).click();
    (host.querySelector('.acti-thread .thread-caret') as HTMLElement).click();
    expect(host.querySelector('.acti-thread')).toBeNull();
  });
});
