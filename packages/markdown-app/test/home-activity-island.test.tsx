/**
 * The Home "Recent activity" Preact island: what moved lately, grouped BY
 * TASK, straight from the projected tasks the vanilla loader already holds.
 *
 * Two families of properties:
 *
 *  1. Rendering from seeded projected tasks — group order, the header row's
 *     real `.hub-review-row` anatomy opening the task, one flag badge, note
 *     lines newest first with bare age and muted agent, "+N more", the
 *     empty state, and the island contract (own wrapper, render(null) on
 *     dispose).
 *
 *  2. Layout at the two sizes the project verifies (1180×820 iPad landscape,
 *     where HEIGHT is the scarce axis; 430px phone, where thumbs are).
 *     happy-dom has no layout engine, so the DOM side asserts the line
 *     budget the pane may spend and the CSS side asserts the declarations
 *     that keep every line to one line and every row to 44px.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Thread, User } from '@feedback/core';
import { describe, expect, it, vi } from 'vitest';
import { ACTIVITY_GROUP_CAP, ACTIVITY_NOTE_CAP } from '../src/hub/activity-model.ts';
import {
  type ActivityHandlers,
  homeActivityData,
  mountHomeActivityIsland,
} from '../src/hub/home-activity-island.tsx';
import { CHORES_ID, type HubGoal, type HubNote, type HubTask } from '../src/hub/hub-model.ts';

/** All fixtures are synthetic — invented agents, short fake ids. */

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Component re-renders from a signal write are scheduled — settle them. */
const tick = () => new Promise((r) => setTimeout(r, 0));

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'in-progress',
    assignee: 'Quick Build',
    goal: 'g-pr',
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - 3 * HOUR,
    ...overrides,
  };
}

function note(agoMs: number, text: string, overrides: Partial<HubNote> = {}): HubNote {
  return { at: NOW - agoMs, kind: 'turn', text, agent: 'Quick Build', ...overrides };
}

const GOALS: HubGoal[] = [
  { id: 'g-pr', title: '1. Get the PR out' },
  { id: 'g-blog', title: '2. Blog post' },
];

const ME: User = { id: 'u-me', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

const handlers = (): ActivityHandlers => ({
  onOpenTask: vi.fn(),
  onComment: vi.fn().mockResolvedValue(null),
  onReply: vi.fn().mockResolvedValue(null),
});

function mount(
  tasks: HubTask[],
  h = handlers(),
  asks: { taskId: string; text: string }[] = [],
): { host: HTMLElement; h: ActivityHandlers; unmount: () => void } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  homeActivityData.value = { tasks, goals: GOALS, asks, now: NOW };
  const unmount = mountHomeActivityIsland(host, h, ME);
  return { host, h, unmount };
}

/** The pill keys off `selectionchange`, debounced — wait it out. */
const settle = () => new Promise((r) => setTimeout(r, 160));

/** Select `phrase` inside `el` the way a finger does, and let the pill hear. */
async function select(el: HTMLElement, phrase: string): Promise<void> {
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

const pillIn = (host: HTMLElement) => host.querySelector('.acti-pill') as HTMLElement;
const pillShown = (host: HTMLElement) => !pillIn(host).classList.contains('hidden');
const composer = (host: HTMLElement) =>
  host.querySelector('.acti-thread textarea') as HTMLTextAreaElement;
const replyButton = (host: HTMLElement) =>
  host.querySelector('.acti-thread .thread-actions button.primary') as HTMLButtonElement;

/** Type into the real card's box and tap its one button. */
function reply(host: HTMLElement, text: string): void {
  composer(host).value = text;
  replyButton(host).click();
}

const groupsIn = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.acti-group')];
const notesIn = (g: Element) =>
  [...g.querySelectorAll('.hub-activity-note')].map((n) => n.textContent ?? '');

describe('home-activity island rendering', () => {
  it('heads the section "Recent activity", groups by task newest first, and says who said what when', () => {
    const quiet = task({
      id: 't-q',
      title: 'Quiet one',
      notes: [note(2 * HOUR, 'Opened PR, CI running')],
    });
    const busy = task({
      id: 't-b',
      title: 'Busy one',
      notes: [
        note(4 * MIN, 'CSV writer done'),
        note(8 * MIN, 'Picked this up', { agent: 'Helper' }),
      ],
    });
    const { host, unmount } = mount([quiet, busy]);
    expect(host.querySelector('.hub-activity-card .hub-home-heading')?.textContent).toBe(
      'Recent activity',
    );
    const groups = groupsIn(host);
    expect(groups.map((g) => g.dataset.taskId)).toEqual(['t-b', 't-q']);

    // The header row is the queue's own row anatomy: the title in
    // .hub-review-row-title, the status as a tiny mark, no counters anywhere.
    const head = groups[0]?.querySelector('.hub-review-row') as HTMLElement;
    expect(head.querySelector('.hub-review-row-title')?.textContent).toBe('Busy one');
    expect(head.querySelector('.acti-mark')?.className).toContain('acti-mark-in-progress');
    expect(head.getAttribute('title')).toContain('Busy one');

    // Note lines: text, then the bare age, then the agent muted — newest first.
    expect(notesIn(groups[0] as Element)).toEqual([
      'CSV writer done · 4m · Quick Build',
      'Picked this up · 8m · Helper',
    ]);
    const agent = groups[0]?.querySelector('.hub-activity-note .acti-agent');
    expect(agent?.textContent).toBe('Quick Build');
    expect(groups[0]?.querySelector('.hub-activity-note .acti-age')?.textContent).toBe('4m');
    expect(notesIn(groups[1] as Element)).toEqual(['Opened PR, CI running · 2h · Quick Build']);
    // Nothing in the pane counts anything.
    expect(host.querySelector('.hub-activity-card')?.textContent).not.toMatch(/\d+ notes?/);
    unmount();
    host.remove();
  });

  it('tapping the header row opens the task — click, Enter and Space', () => {
    const t = task({ id: 't-open', notes: [note(MIN, 'Working')] });
    const { host, h, unmount } = mount([t]);
    const head = host.querySelector('.acti-group .hub-review-row') as HTMLElement;
    head.click();
    expect(h.onOpenTask).toHaveBeenCalledWith('t-open');
    head.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    head.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(h.onOpenTask).toHaveBeenCalledTimes(3);
    // A tap on a note line is not a tap on the row: the lines are for reading
    // (and, next, for commenting on) — not a second way out of Home.
    (host.querySelector('.hub-activity-note') as HTMLElement).click();
    expect(h.onOpenTask).toHaveBeenCalledTimes(3);
    unmount();
    host.remove();
  });

  it('wears at most one flag badge, worded off-band / stale / dark', () => {
    const off = task({
      id: 't-off',
      goal: CHORES_ID,
      notes: [note(MIN, 'Picked this up from the backlog')],
    });
    const stale = task({
      id: 't-stale',
      notes: [
        note(2 * MIN, 'Still waiting on login'),
        note(20 * MIN, 'Still waiting on login'),
        note(40 * MIN, 'Still waiting on login'),
      ],
    });
    const dark = task({ id: 't-dark', notes: [note(50 * MIN, 'Opened PR, CI running')] });
    const clean = task({ id: 't-clean', notes: [note(3 * MIN, 'CI green')] });
    const { host, unmount } = mount([off, stale, dark, clean]);
    const byId = new Map(groupsIn(host).map((g) => [g.dataset.taskId, g]));
    const badge = (id: string) => byId.get(id)?.querySelector('.hub-badge');
    expect(badge('t-off')?.textContent).toBe('off-band');
    expect(badge('t-off')?.className).toContain('hub-badge-offband');
    expect(badge('t-stale')?.textContent).toBe('stale');
    expect(badge('t-stale')?.className).toContain('hub-badge-stale');
    expect(badge('t-dark')?.textContent).toBe('dark');
    expect(badge('t-dark')?.className).toContain('hub-badge-dark');
    expect(badge('t-clean')).toBeNull();
    for (const g of byId.values()) expect(g.querySelectorAll('.hub-badge').length).toBeLessThan(2);
    unmount();
    host.remove();
  });

  it('shows three lines then a muted "+N more"', () => {
    const t = task({
      id: 't-many',
      notes: [1, 2, 3, 4, 5].map((i) => note(i * MIN, `Step ${i}`)),
    });
    const { host, unmount } = mount([t]);
    const g = groupsIn(host)[0] as HTMLElement;
    expect(g.querySelectorAll('.hub-activity-note')).toHaveLength(ACTIVITY_NOTE_CAP);
    expect(g.querySelector('.acti-more')?.textContent).toBe('+2 more');
    unmount();
    host.remove();
  });

  it('a group with nothing off the cap has no "+N more" line', () => {
    const t = task({ id: 't-few', notes: [note(MIN, 'One'), note(2 * MIN, 'Two')] });
    const { host, unmount } = mount([t]);
    expect(host.querySelector('.acti-more')).toBeNull();
    unmount();
    host.remove();
  });

  it('denials read "blocked: <shape>" and moves read as note lines, each marked by kind', () => {
    const t = task({
      id: 't-mv',
      assignee: 'Bike Map',
      notes: [note(12 * MIN, 'git rm in this repo', { kind: 'denial', agent: 'Bike Map' })],
      transitions: [
        {
          ts: NOW - 30 * MIN,
          from: 'todo',
          to: 'in-progress',
          by: { name: 'Team Lead', kind: 'agent' },
        },
      ],
    });
    const { host, unmount } = mount([t]);
    const lines = [...(groupsIn(host)[0]?.querySelectorAll('.hub-activity-note') ?? [])];
    expect(lines.map((l) => l.textContent)).toEqual([
      'blocked: git rm in this repo · 12m · Bike Map',
      'handed to Bike Map · 30m · Team Lead',
    ]);
    expect(lines[0]?.className).toContain('hub-activity-note-denial');
    expect(lines[1]?.className).toContain('hub-activity-note-move');
    unmount();
    host.remove();
  });

  it('a denial tints the refused SHAPE only — "blocked: " stays prose, as the approved mock has it', () => {
    const t = task({
      id: 't-dn',
      notes: [note(12 * MIN, 'git rm in this repo', { kind: 'denial', agent: 'Bike Map' })],
    });
    const { host, unmount } = mount([t]);
    const line = host.querySelector('.hub-activity-note-denial') as HTMLElement;
    expect(line.textContent).toBe('blocked: git rm in this repo · 12m · Bike Map');
    const shape = line.querySelector('.acti-text code.acti-shape');
    expect(shape?.textContent).toBe('git rm in this repo');
    // The prefix is outside the shape.
    expect(line.querySelector('.acti-text')?.firstChild?.textContent).toBe('blocked: ');
    unmount();
    host.remove();
  });

  it('a note that repeats an ask already in the queue above is not said twice', () => {
    const t = task({
      id: 't-ask',
      notes: [note(MIN, 'Which cache do we keep?'), note(5 * MIN, 'Wrote the two options up')],
    });
    const { host, unmount } = mount([t], handlers(), [
      { taskId: 't-ask', text: 'Which cache do we keep?' },
    ]);
    expect(notesIn(groupsIn(host)[0] as Element)).toEqual([
      'Wrote the two options up · 5m · Quick Build',
    ]);
    unmount();
    host.remove();
  });

  it('empty state is one muted line, and no groups', () => {
    const { host, unmount } = mount([task(), task({ notes: [] })]);
    expect(host.querySelector('.hub-home-quiet')?.textContent).toBe(
      'Nothing yet — agents post a line per turn once they restart on 0.1.124.',
    );
    expect(host.querySelectorAll('.acti-group')).toHaveLength(0);
    unmount();
    host.remove();
  });

  it('re-renders from a signal write, keeping an unchanged group as the IDENTICAL node', async () => {
    const a = task({ id: 't-a', notes: [note(MIN, 'A one')] });
    const b = task({ id: 't-b', notes: [note(2 * MIN, 'B one')] });
    const { host, unmount } = mount([a, b]);
    const groupB = groupsIn(host)[1] as HTMLElement;
    expect(groupB.dataset.taskId).toBe('t-b');
    homeActivityData.value = {
      tasks: [{ ...a, notes: [note(MIN, 'A one'), note(30_000, 'A two')] }, b],
      goals: GOALS,
      now: NOW,
    };
    await tick();
    const after = groupsIn(host);
    expect(notesIn(after[0] as Element)[0]).toBe('A two · 30s · Quick Build');
    expect(after[1]).toBe(groupB);
    unmount();
    host.remove();
  });

  it('owns a dedicated wrapper, disposes with render(null), and leaves the host’s children alone', () => {
    const host = document.createElement('div');
    const vanillaChild = document.createElement('p');
    host.appendChild(vanillaChild);
    document.body.appendChild(host);
    homeActivityData.value = { tasks: [task({ notes: [note(MIN, 'x')] })], goals: GOALS, now: NOW };
    const unmount = mountHomeActivityIsland(host, handlers());
    const wrapper = host.querySelector('[data-preact-island="home-activity"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.hub-activity-card')).not.toBeNull();
    expect(host.firstChild).toBe(vanillaChild);
    unmount();
    expect(wrapper?.childNodes.length).toBe(0);
    expect(host.contains(wrapper)).toBe(false);
    expect(host.childNodes.length).toBe(1);
    host.remove();
  });
});

describe('commenting on a note like a doc', () => {
  const noteTask = () =>
    task({
      id: 't-c',
      title: 'Bryan can export a board as CSV',
      notes: [
        note(MIN, 'CSV writer done; adding the download route next'),
        note(8 * MIN, 'Picked this up'),
      ],
    });

  it('selecting a phrase in a note line shows the walkthrough’s comment pill; selecting elsewhere hides it', async () => {
    const { host, unmount } = mount([noteTask()]);
    const pill = pillIn(host);
    expect(pill, 'no pill rendered').not.toBeNull();
    expect(pill.classList.contains('comment-pill')).toBe(true);
    expect(pillShown(host)).toBe(false);
    await select(host, 'download route');
    expect(pillShown(host)).toBe(true);
    // No hover hints, no comment box, no other buttons in the pane.
    expect(host.querySelectorAll('.acti-group button').length).toBe(0);
    expect(host.querySelector('.acti-thread')).toBeNull();
    // A selection somewhere else on the page is not this pane's.
    const elsewhere = document.createElement('p');
    elsewhere.textContent = 'other words';
    document.body.append(elsewhere);
    await select(elsewhere, 'other');
    expect(pillShown(host)).toBe(false);
    elsewhere.remove();
    window.getSelection()?.removeAllRanges();
    unmount();
    host.remove();
  });

  it('selecting words of the title shows the pill, and a tap on the header with words selected does not open the task', async () => {
    const { host, h, unmount } = mount([noteTask()]);
    await select(host, 'export a board');
    expect(pillShown(host)).toBe(true);
    (host.querySelector('.acti-head') as HTMLElement).click();
    expect(h.onOpenTask).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
    unmount();
    host.remove();
  });

  it('the pill opens the real thread card in the group’s wrap, quoting the phrase and marking it in the line', async () => {
    const { host, unmount } = mount([noteTask()]);
    await select(host, 'download route');
    pillIn(host).click();
    await tick();
    const wrap = host.querySelector('.acti-group-wrap-open') as HTMLElement;
    expect(wrap, 'no open wrap').not.toBeNull();
    expect(wrap.querySelector('.acti-group')?.getAttribute('data-task-id')).toBe('t-c');
    // The real card: threads.ts `renderThread` anatomy, expanded, with the
    // reply box addressed to the reader.
    const card = wrap.querySelector('.acti-thread .thread') as HTMLElement;
    expect(card, 'no .thread card').not.toBeNull();
    expect(card.classList.contains('expanded')).toBe(true);
    expect(card.querySelector('.thread-head .thread-who')?.textContent).toBe('Bryan');
    expect(card.querySelector('.thread-topic')?.textContent).toBe('download route');
    expect(composer(host).placeholder).toBe('Reply as Bryan…');
    // The phrase is marked in the line the way a doc marks a thread's range.
    const mark = wrap.querySelector('.acti-group mark.thread-range') as HTMLElement;
    expect(mark?.textContent).toBe('download route');
    // The pill is gone and the selection with it.
    expect(pillShown(host)).toBe(false);
    unmount();
    host.remove();
  });

  it('Reply creates the thread on the task with the phrase, then shows that thread; a further reply goes to it', async () => {
    const created = threadOn('download route', 'Which route?');
    const replied: Thread = {
      ...created,
      commentCount: 2,
      comments: [
        ...created.comments,
        { id: 'c-2', author: ME, text: 'And the auth?', ts: NOW + 1 },
      ],
    };
    const h = handlers();
    (h.onComment as ReturnType<typeof vi.fn>).mockResolvedValue(created);
    (h.onReply as ReturnType<typeof vi.fn>).mockResolvedValue(replied);
    const { host, unmount } = mount([noteTask()], h);
    await select(host, 'download route');
    pillIn(host).click();
    await tick();
    reply(host, 'Which route?');
    expect(h.onComment).toHaveBeenCalledWith('t-c', { text: 'download route' }, 'Which route?');
    await tick();
    await tick();
    const card = host.querySelector('.acti-thread .thread') as HTMLElement;
    expect(card.getAttribute('data-thread-id')).toBe('th-1');
    expect(card.querySelector('.thread-message')?.textContent).toContain('Which route?');
    expect(composer(host).value).toBe('');
    reply(host, 'And the auth?');
    expect(h.onReply).toHaveBeenCalledWith('t-c', 'th-1', 'And the auth?');
    await tick();
    await tick();
    expect(host.querySelector('.acti-thread .comments')?.textContent).toContain('And the auth?');
    unmount();
    host.remove();
  });

  it('a refused comment leaves the words in the box', async () => {
    const { host, h, unmount } = mount([noteTask()]);
    await select(host, 'download route');
    pillIn(host).click();
    await tick();
    reply(host, 'Which route?');
    expect(h.onComment).toHaveBeenCalled();
    await tick();
    await tick();
    expect(composer(host).value).toBe('Which route?');
    expect(host.querySelector('.acti-thread .thread')).not.toBeNull();
    unmount();
    host.remove();
  });

  it('a background refresh keeps an open draft card and the words being typed in it', async () => {
    const other = task({ id: 't-o', title: 'Other task', notes: [note(MIN, 'Other work')] });
    const { host, unmount } = mount([noteTask(), other]);
    await select(host, 'download route');
    pillIn(host).click();
    await tick();
    const before = host.querySelector('.acti-thread .thread') as HTMLElement;
    expect(before).not.toBeNull();
    composer(host).value = 'Which rou';
    // Every board event rewrites the signal with a fresh `now`; here another
    // task also grew a line, which is the common shape of one.
    homeActivityData.value = {
      tasks: [
        noteTask(),
        { ...other, notes: [note(20_000, 'Other done'), ...(other.notes ?? [])] },
      ],
      goals: GOALS,
      now: NOW + 5_000,
    };
    await tick();
    const wrap = host.querySelector('.acti-group-wrap-open') as HTMLElement;
    expect(wrap, 'the draft card was closed by the refresh').not.toBeNull();
    expect(wrap.querySelector('.acti-group')?.getAttribute('data-task-id')).toBe('t-c');
    expect(host.querySelector('.acti-thread .thread')).not.toBeNull();
    expect(composer(host).value).toBe('Which rou');
    // The other group did take the new line, aged against the NEW now.
    expect(notesIn(groupsIn(host)[0] as Element)[0]).toBe('Other done · 25s · Quick Build');
    unmount();
    host.remove();
  });

  it('the pill is for the words only: an age, an agent name, a badge or "+N more" gets none', async () => {
    const t = task({
      id: 't-w',
      goal: CHORES_ID,
      notes: [1, 2, 3, 4].map((i) => note(i * MIN, `Step ${i}`)),
    });
    const { host, unmount } = mount([t]);
    const g = groupsIn(host)[0] as HTMLElement;
    const selectAll = async (el: Element): Promise<void> => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
      await settle();
    };
    await selectAll(g.querySelector('.acti-age') as Element);
    expect(pillShown(host), 'pill on an age').toBe(false);
    await selectAll(g.querySelector('.acti-agent') as Element);
    expect(pillShown(host), 'pill on an agent name').toBe(false);
    await selectAll(g.querySelector('.hub-badge') as Element);
    expect(pillShown(host), 'pill on a badge').toBe(false);
    await selectAll(g.querySelector('.acti-more') as Element);
    expect(pillShown(host), 'pill on "+N more"').toBe(false);
    // Positive controls: the note text and the title.
    await selectAll(g.querySelector('.acti-text') as Element);
    expect(pillShown(host), 'no pill on the note text').toBe(true);
    await select(host, 'Task');
    expect(pillShown(host), 'no pill on the title').toBe(true);
    window.getSelection()?.removeAllRanges();
    unmount();
    host.remove();
  });

  it('Escape puts a draft away, and so does folding its card', async () => {
    const { host, unmount } = mount([noteTask()]);
    await select(host, 'download route');
    pillIn(host).click();
    await tick();
    expect(host.querySelector('.acti-thread')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(host.querySelector('.acti-thread')).toBeNull();
    expect(host.querySelector('.acti-group-wrap-open')).toBeNull();
    expect(host.querySelector('mark.thread-range')).toBeNull();

    await select(host, 'Picked this up');
    pillIn(host).click();
    await tick();
    (host.querySelector('.acti-thread .thread-caret') as HTMLElement).click();
    await tick();
    expect(host.querySelector('.acti-thread')).toBeNull();
    unmount();
    host.remove();
  });

  it('a selection that runs across two groups is nobody’s: the pill stays hidden rather than dead', async () => {
    const { host, unmount } = mount([
      noteTask(),
      task({ id: 't-d', title: 'Other task', notes: [note(MIN, 'Other work')] }),
    ]);
    const find = (phrase: string): Text => {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const t = walker.currentNode as Text;
        if (t.data.includes(phrase)) return t;
      }
      throw new Error(`no text node holds “${phrase}”`);
    };
    const r = document.createRange();
    r.setStart(find('download route'), 0);
    r.setEnd(find('Other work'), 5);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    await settle();
    expect(pillShown(host)).toBe(false);
    pillIn(host).click();
    await tick();
    expect(host.querySelector('.acti-thread')).toBeNull();
    // Positive control: the same gesture inside ONE group shows it.
    await select(host, 'Other work');
    expect(pillShown(host)).toBe(true);
    window.getSelection()?.removeAllRanges();
    unmount();
    host.remove();
  });

  it('the marked phrase lands inside a denial’s shape', async () => {
    const { host, unmount } = mount([
      task({
        id: 't-dn',
        notes: [note(12 * MIN, 'git rm in this repo', { kind: 'denial', agent: 'Bike Map' })],
      }),
    ]);
    await select(host, 'git rm');
    pillIn(host).click();
    await tick();
    const mark = host.querySelector('.acti-shape mark.thread-range');
    expect(mark?.textContent).toBe('git rm');
    unmount();
    host.remove();
  });

  it('a second selection replaces the open draft rather than stacking a card', async () => {
    const { host, unmount } = mount([
      noteTask(),
      task({ id: 't-d', notes: [note(MIN, 'Other work')] }),
    ]);
    await select(host, 'download route');
    pillIn(host).click();
    await tick();
    await select(host, 'Other work');
    pillIn(host).click();
    await tick();
    expect(host.querySelectorAll('.acti-thread').length).toBe(1);
    expect(
      host.querySelector('.acti-group-wrap-open .acti-group')?.getAttribute('data-task-id'),
    ).toBe('t-d');
    unmount();
    host.remove();
  });
});

/* ---------------------------------------------------------------------- */

const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of `selector`'s rule — top level unless `within` is a media
 *  extract, where the selector is indented. */
function rule(selector: string, within?: string): string {
  const escaped = selector.replace(/[.+*[\]()]/g, '\\$&');
  const at = new RegExp(
    within === undefined
      ? `(^|\\n)${escaped}\\s*\\{([^}]*)\\}`
      : `(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`,
  ).exec(within ?? declarationsOnly(CSS));
  return at?.[2] ?? '';
}

/** Every `@media <query> { … }` block in the sheet, joined. */
function media(query: string): string {
  const src = declarationsOnly(CSS);
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(`@media ${query}`, from);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) break;
    blocks.push(src.slice(start, end));
    from = end;
  }
  return blocks.join('\n');
}

describe('the activity pane at 1180×820 spends a bounded number of lines', () => {
  it('never draws more than 8 groups of a header plus 3 note lines', () => {
    // Twelve busy tasks: the pane may draw at most 8 × (1 + 3) lines, plus a
    // small "+N more" per group. What HEIGHT that is in pixels is the CSS
    // below's job: one line per row, nothing fixed.
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({
        id: `t-h${i}`,
        notes: [1, 2, 3, 4, 5, 6].map((n) => note(n * MIN + i * 1000, `Line ${n} of ${i}`)),
      }),
    );
    const { host, unmount } = mount(tasks);
    const groups = groupsIn(host);
    expect(groups.length).toBe(ACTIVITY_GROUP_CAP);
    const headers = host.querySelectorAll('.acti-group .hub-review-row').length;
    const lines = host.querySelectorAll('.hub-activity-note').length;
    expect(headers).toBe(ACTIVITY_GROUP_CAP);
    expect(lines).toBeLessThanOrEqual(ACTIVITY_GROUP_CAP * ACTIVITY_NOTE_CAP);
    expect(headers + lines).toBeLessThanOrEqual(ACTIVITY_GROUP_CAP * (1 + ACTIVITY_NOTE_CAP));
    expect(host.querySelectorAll('.acti-more')).toHaveLength(ACTIVITY_GROUP_CAP);
    unmount();
    host.remove();
  });

  it('the card takes no fixed height, and each title and note line is ONE line at the tablet tier', () => {
    const card = rule('.hub-activity-card');
    expect(card, '.hub-activity-card has no rule').not.toBe('');
    expect(card).not.toMatch(/(^|[^-])height:/);
    expect(card).not.toMatch(/min-height:/);
    // A header is one line: the title clips with an ellipsis rather than
    // wrapping, so 8 groups cost 8 header lines, never 16.
    const title = rule('.acti-title-text');
    expect(title, '.acti-title-text has no rule').not.toBe('');
    expect(title).toMatch(/white-space:\s*nowrap/);
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    // A note line is one line for the same reason.
    const line = rule('.hub-activity-note');
    expect(line, '.hub-activity-note has no rule').not.toBe('');
    expect(line).toMatch(/white-space:\s*nowrap/);
    expect(line).toMatch(/text-overflow:\s*ellipsis/);
    expect(line).toMatch(/overflow:\s*hidden/);
  });

  it('the thread card sits BESIDE the group at the tablet tier, in a 300px column, and carries no second action', () => {
    const wrap = rule('.acti-group-wrap-open');
    expect(wrap, '.acti-group-wrap-open has no rule').not.toBe('');
    expect(wrap).toMatch(/display:\s*grid/);
    expect(wrap).toMatch(/grid-template-columns:[^;]*300px/);
    // One action only: the real card's Resolve foot is not offered here.
    expect(rule('.acti-thread .thread-foot')).toMatch(/display:\s*none/);
    // The marked phrase gets the editor's range colours, which are scoped to
    // the editor and so have to be restated for the pane.
    expect(rule('.acti-group .thread-range')).toMatch(/background:/);
  });

  it('a denial’s mono/danger tint is on the shape, not the whole line', () => {
    const shape = rule('.hub-activity-note-denial .acti-shape');
    expect(shape, '.hub-activity-note-denial .acti-shape has no rule').not.toBe('');
    expect(shape).toMatch(/font-family:\s*var\(--mono\)/);
    expect(shape).toMatch(/background:\s*var\(--danger-bg\)/);
    expect(rule('.hub-activity-note-denial .acti-text')).not.toMatch(/background:/);
  });

  it('the notes sit indented under the title, past the status mark', () => {
    const notes = rule('.acti-notes');
    expect(notes, '.acti-notes has no rule').not.toBe('');
    expect(notes).toMatch(/margin(-left)?:[^;]*17px/);
  });
});

describe('the activity pane at 430px is thumb-sized and lets the words wrap', () => {
  it('the header row keeps the queue row’s 44px floor on the phone tier', () => {
    // The base row rule is the floor; the phone block must not lower it.
    expect(rule('.hub-review-row')).toMatch(/min-height:\s*44px/);
    const phone = media('(max-width: 1100px)');
    expect(phone, 'no ≤1100px block').not.toBe('');
    const phoneRow = rule('.hub-review-row', phone);
    if (phoneRow !== '') expect(phoneRow).not.toMatch(/min-height:\s*([0-3]\d|4[0-3])px/);
    const head = rule('.acti-head');
    expect(head, '.acti-head has no rule').not.toBe('');
    expect(head).not.toMatch(/min-height:/);
  });

  it('on the phone tier a title and a note line may wrap — clipping is a tablet economy', () => {
    const phone = media('(max-width: 1100px)');
    const title = rule('.acti-title-text', phone);
    expect(title, '.acti-title-text has no phone rule').not.toBe('');
    expect(title).toMatch(/white-space:\s*normal/);
    const line = rule('.hub-activity-note', phone);
    expect(line, '.hub-activity-note has no phone rule').not.toBe('');
    expect(line).toMatch(/white-space:\s*normal/);
  });

  it('the thread card goes UNDER the group on the phone tier and the pill grows to a thumb', () => {
    const phone = media('(max-width: 1100px)');
    const wrap = rule('.acti-group-wrap-open', phone);
    expect(wrap, '.acti-group-wrap-open has no phone rule').not.toBe('');
    expect(wrap).toMatch(/display:\s*flex/);
    expect(wrap).toMatch(/flex-direction:\s*column/);
    const pill = rule('.acti-pill', phone);
    expect(pill, '.acti-pill has no phone rule').not.toBe('');
    expect(pill).toMatch(/min-width:\s*44px/);
    expect(pill).toMatch(/min-height:\s*44px/);
  });

  it('negative control: a selector the sheet does not have reads as empty', () => {
    expect(rule('.acti-nonesuch')).toBe('');
    expect(rule('.acti-nonesuch', media('(max-width: 1100px)'))).toBe('');
  });
});
