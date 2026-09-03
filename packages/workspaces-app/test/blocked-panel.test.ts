/**
 * Related Links on the task panel, once blocking tickets live in it.
 *
 * There is no Blocked control anywhere on the panel and no Blocked option in
 * the status picker: a ticket is blocked because it waits on another ticket,
 * and the panel's whole vocabulary for that is a Related Links entry wearing
 * the board's barred ring, an x that takes it back off, and one add box that
 * takes any URL.
 *
 * The cases below are the ones a reader would notice were wrong: what the
 * entries say, what the x reports, what the box does with each kind of
 * address, and that a repaint cannot eat what somebody is typing into it.
 *
 * Fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHORES_ID, type HubTask } from '../src/hub/hub-board-model.ts';
import { type DetailHandlers, type RelatedEntry } from '../src/hub/hub-detail-render.ts';
import { _resetLinkTitlesForTest, primeLinkTitle } from '../src/link-titles.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';
import { disposeTaskDetail, renderTaskDetail } from './support/task-detail.ts';

const NOW = 1_700_000_000_000;
let seq = 0;
function task(over: Partial<HubTask> = {}): HubTask {
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
    ...over,
  } as HubTask;
}

const handlers = (over: Partial<DetailHandlers> = {}): DetailHandlers => ({
  onClose: vi.fn(),
  onStatusSet: vi.fn(),
  onTitleCommit: vi.fn(),
  onAnswer: vi.fn(),
  onAssign: vi.fn(),
  workspaceId: 'w-test',
  ...over,
});

let root: HTMLElement;
beforeEach(() => {
  disposeTaskDetail();
  _resetLinkTitlesForTest();
  // Every doc these cases render is primed, so no title-hydration fetch is in
  // flight when happy-dom tears the window down — an aborted fetch prints a
  // stack that looks like a failure and is not one.
  primeLinkTitle('/workspaces/w-test/docs/d-plan', 'Sprint plan', null);
  primeLinkTitle('/workspaces/w-test/docs/d-notes', 'Design notes', null);
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

const items = (): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('.hub-related-links-list li'),
];
const addBtn = () => root.querySelector<HTMLButtonElement>('.hub-related-add-btn');
const addInput = () => root.querySelector<HTMLInputElement>('.hub-related-add-input');

function openBox(): HTMLInputElement {
  addBtn()?.click();
  const el = addInput();
  if (!el) throw new Error('no add box');
  return el;
}

function type(el: HTMLInputElement, value: string, key: string): void {
  el.value = value;
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('blocking tickets are Related Links entries', () => {
  it('lists them first, with the barred ring and a link to the ticket', () => {
    renderTaskDetail(
      root,
      task({ origin: { kind: 'doc', docId: 'd-plan' } }),
      handlers({
        blockers: [{ taskId: 't-gate', title: 'Split the huddle renderer' }],
        onRelatedRemove: vi.fn(),
      }),
    );
    const rows = items();
    expect(rows).toHaveLength(2);
    // The blocker, first, wearing the same ring the board draws on the row.
    expect(rows[0]?.querySelector('.hub-status-mark-blocked')).toBeTruthy();
    const a = rows[0]?.querySelector<HTMLAnchorElement>('.hub-related-link');
    expect(a?.textContent).toBe('Split the huddle renderer');
    expect(a?.getAttribute('href')).toBe('/workspaces/w-test?task=t-gate');
    // And nothing is WRITTEN to say it is a blocker — the ring is the whole
    // statement (owner's rule: affordances, not captions).
    expect(rows[0]?.textContent).toBe('Split the huddle renderer×');
    // The doc entry keeps its own shape and takes no ring.
    expect(rows[1]?.querySelector('.hub-status-mark-blocked')).toBeNull();
  });

  it('draws no x on the ORIGIN doc — there is nothing there to unlink', () => {
    renderTaskDetail(
      root,
      task({
        origin: { kind: 'doc', docId: 'd-plan' },
        links: [{ kind: 'doc', docId: 'd-notes' }],
      }),
      handlers({ onRelatedRemove: vi.fn() }),
    );
    const rows = items();
    expect(rows).toHaveLength(2);
    // The origin is where the row came from. `DELETE /links` filters `links`,
    // which never held it, so the button answered 200 changed:false and the
    // entry stayed — a click that did nothing and said nothing.
    expect(rows[0]?.querySelector('.hub-related-link-x')).toBeNull();
    // Positive control: a doc in `links`, on the same panel and the same
    // paint, does carry one — so the absence above is the origin and not a
    // missing handler.
    expect(rows[1]?.querySelector('.hub-related-link-x')).toBeTruthy();
  });

  it('reports which entry the x was pressed on, for each of the three kinds', () => {
    const onRelatedRemove = vi.fn();
    renderTaskDetail(
      root,
      task({
        links: [
          { kind: 'doc', docId: 'd-plan' },
          { kind: 'url', url: 'https://example.invalid/spec' },
        ],
      }),
      handlers({
        blockers: [{ taskId: 't-gate', title: 'Split the huddle renderer' }],
        onRelatedRemove,
      }),
    );
    const rows = items();
    expect(rows).toHaveLength(3);
    for (const row of rows) row.querySelector<HTMLButtonElement>('.hub-related-link-x')?.click();
    expect(onRelatedRemove.mock.calls.map((c) => c[1] as RelatedEntry)).toEqual([
      { kind: 'blocker', taskId: 't-gate' },
      { kind: 'doc', docId: 'd-plan' },
      { kind: 'url', url: 'https://example.invalid/spec' },
    ]);
  });

  it('draws no x at all on a surface that cannot remove — the goal panel', () => {
    renderTaskDetail(
      root,
      task({ links: [{ kind: 'doc', docId: 'd-plan' }] }),
      handlers({ blockers: [{ taskId: 't-gate', title: 'Gate' }] }),
    );
    expect(root.querySelector('.hub-related-link-x')).toBeNull();
    // Positive control: the same render WITH the handler draws them.
    renderTaskDetail(
      root,
      task({ links: [{ kind: 'doc', docId: 'd-plan' }] }),
      handlers({ blockers: [{ taskId: 't-gate', title: 'Gate' }], onRelatedRemove: vi.fn() }),
    );
    expect(root.querySelectorAll('.hub-related-link-x')).toHaveLength(2);
  });

  it('shows a foreign address as itself, and a workspace doc as its title', () => {
    primeLinkTitle('/workspaces/w-test/docs/d-named', 'Sprint plan', null);
    renderTaskDetail(
      root,
      task({
        origin: { kind: 'doc', docId: 'd-named' },
        links: [{ kind: 'url', url: 'https://example.invalid/spec' }],
      }),
      handlers(),
    );
    const links = [...root.querySelectorAll<HTMLAnchorElement>('.hub-related-link')];
    expect(links[0]?.textContent).toBe('Sprint plan');
    // No title to resolve to, so the address itself — not a guess at one.
    expect(links[1]?.textContent).toBe('https://example.invalid/spec');
    expect(links[1]?.getAttribute('href')).toBe('https://example.invalid/spec');
  });

  it('lists them on an IN-PROGRESS row, and marks it blocked', () => {
    renderTaskDetail(
      root,
      task({ status: 'in-progress' }),
      handlers({
        blockers: [{ taskId: 't-gate', title: 'Split the huddle renderer' }],
        onRelatedRemove: vi.fn(),
      }),
    );
    expect(items()).toHaveLength(1);
    expect(items()[0]?.textContent).toBe('Split the huddle renderer×');
    const mark = root.querySelector('.hub-detail-fields .hub-status-mark');
    expect(mark?.className).toContain('hub-status-mark-blocked');
    // Positive control: the same in-progress row with nothing holding it
    // keeps its own mark, so the ring above is the edge and not the status.
    renderTaskDetail(root, task({ status: 'in-progress' }), handlers({ blockers: [] }));
    expect(root.querySelector('.hub-detail-fields .hub-status-mark')?.className).toContain(
      'hub-status-mark-in-progress',
    );
  });

  it('never prints a raw task id — the blocker is a titled link or nothing', () => {
    renderTaskDetail(
      root,
      task({ after: ['t-gate'] }),
      handlers({
        blockers: [{ taskId: 't-gate', title: 'Split the huddle renderer' }],
        onRelatedRemove: vi.fn(),
      }),
    );
    // The panel used to carry `After: t-gate` as a meta row as well, which was
    // the same relationship told twice — the second time as an id a reader
    // cannot follow, and one that kept printing after the blocker closed.
    // Control that this assertion can fail: the Activity tab that used to
    // carry the meta row IS rendered here (hidden, not absent), so its text is
    // inside `root.textContent` and a surviving id would be seen.
    expect(root.querySelector('.hub-detail-tabpanel-activity')).toBeTruthy();
    expect(root.textContent ?? '').toContain('the first move, edit or note lands here');
    expect(root.textContent ?? '').not.toContain('t-gate');
    // …and the relationship IS on the panel, as a title.
    expect(root.textContent ?? '').toContain('Split the huddle renderer');
  });

  it('offers no Blocked status anywhere on the panel', () => {
    renderTaskDetail(
      root,
      task({ after: ['t-gate'] }),
      handlers({ blockers: [{ taskId: 't-gate', title: 'Gate' }], onRelatedRemove: vi.fn() }),
    );
    const status = root.querySelector<HTMLSelectElement>('.hub-detail-status');
    expect(status).toBeTruthy();
    expect([...(status?.options ?? [])].map((o) => o.value)).not.toContain('blocked');
    // The picker still reads "To do" — and the ring beside it carries the
    // state, the same ring the board draws on the row.
    expect(status?.value).toBe('todo');
    const ctl = root.querySelector('.hub-detail-statusctl .hub-status-mark');
    expect(ctl?.className).toContain('hub-status-mark-blocked');

    // Positive control: with nothing holding it, the same row's mark is the
    // plain todo ring.
    renderTaskDetail(root, task({ after: [] }), handlers({ onRelatedRemove: vi.fn() }));
    expect(root.querySelector('.hub-detail-statusctl .hub-status-mark')?.className).toContain(
      'hub-status-mark-todo',
    );
  });
});

describe('the add box', () => {
  it('is one box for any URL, quiet until it is used', () => {
    renderTaskDetail(root, task(), handlers({ onRelatedAdd: vi.fn() }));
    // The section stands even with nothing in it, so the first link has
    // somewhere to be added.
    expect(root.querySelector('.hub-related-links-k')?.textContent).toBe('Related Links');
    expect(items()).toHaveLength(0);
    expect(addBtn()?.textContent).toBe('+ Link');
    expect(addInput()?.className).toContain('hidden');
    openBox();
    expect(addInput()?.className).not.toContain('hidden');
    expect(addBtn()?.className).toContain('hidden');
  });

  it('hands the typed URL over on Enter and closes', () => {
    const onRelatedAdd = vi.fn();
    const row = task();
    renderTaskDetail(root, row, handlers({ onRelatedAdd }));
    type(openBox(), '  /workspaces/w-test?task=t-gate  ', 'Enter');
    // Trimmed, and verbatim otherwise: what the address NAMES is the app's
    // decision, not the panel's.
    expect(onRelatedAdd).toHaveBeenCalledWith(row, '/workspaces/w-test?task=t-gate');
    expect(addInput()?.className).toContain('hidden');
  });

  it('abandons on Escape, and files nothing for an empty box', () => {
    const onRelatedAdd = vi.fn();
    renderTaskDetail(root, task(), handlers({ onRelatedAdd }));
    type(openBox(), 'https://example.invalid/spec', 'Escape');
    expect(onRelatedAdd).not.toHaveBeenCalled();
    expect(addInput()?.className).toContain('hidden');
    type(openBox(), '   ', 'Enter');
    expect(onRelatedAdd).not.toHaveBeenCalled();
  });

  it('keeps a half-typed URL through a repaint', () => {
    const row = task();
    const h = handlers({ onRelatedAdd: vi.fn() });
    renderTaskDetail(root, row, h);
    const box = openBox();
    box.value = 'https://example.invalid/half';
    // A peer's edit, an SSE thread, the attachment poll: the panel repaints
    // with the same task. The list above the box is rebuilt on every one of
    // these, which is exactly why the box is not in it.
    renderTaskDetail(root, { ...row }, h);
    expect(addInput()).toBe(box);
    expect(addInput()?.value).toBe('https://example.invalid/half');
    expect(addInput()?.className).not.toContain('hidden');
  });

  it('is absent on a panel that cannot add', () => {
    renderTaskDetail(root, task({ origin: { kind: 'doc', docId: 'd-plan' } }), handlers());
    expect(root.querySelector('.hub-related-add-btn')).toBeNull();
    // And a row with nothing to show still renders no empty section.
    renderTaskDetail(root, task(), handlers());
    expect(root.querySelector('.hub-related-links-k')).toBeNull();
  });
});

/**
 * The x, as a reader on the owner's own device sees it.
 *
 * This is a COMPUTED-STYLE fact, not a DOM one: the button was in the markup
 * at every width, and every DOM assertion above passed, while at 1180 it was
 * `opacity: 0` and 32px — invisible and under the tap floor on the iPad the
 * board is mainly read on, which has a hardware keyboard but no hover
 * (found in review, 2026-09-03).
 */
describe('the x can be seen and hit', () => {
  let sheets = () => {};
  beforeEach(() => {
    sheets = installSheets('tokens.css', 'hub.css', 'styles.css');
  });
  afterEach(() => {
    sheets();
  });

  function paintOne(): HTMLElement {
    renderTaskDetail(
      root,
      task({}),
      handlers({
        blockers: [{ taskId: 't-gate', title: 'Split the huddle renderer' }],
        onRelatedRemove: vi.fn(),
      }),
    );
    const x = root.querySelector<HTMLElement>('.hub-related-link-x');
    if (!x) throw new Error('no x');
    return x;
  }

  it('is visible without hovering, at the tablet width and at the phone one', () => {
    for (const vp of [IPAD, PHONE]) {
      setViewport(vp);
      const x = paintOne();
      // Positive control FIRST: a hidden-until-hover control from the same
      // stylesheet, in the same document, reads 0 here. Without it, "the x is
      // not hidden" would pass just as well on a harness that cannot resolve
      // opacity at all — which is what this assertion looked like when the
      // rule was simply deleted.
      const hidden = document.createElement('button');
      hidden.className = 'hub-drag-handle';
      root.append(hidden);
      expect(styleOf(hidden).opacity, `${vp.width}px control`).toBe('0');
      expect(styleOf(x).opacity, `${vp.width}px`).not.toBe('0');
      hidden.remove();
    }
  });

  it('clears the 36px tap floor at the tablet width', () => {
    setViewport(IPAD);
    const style = styleOf(paintOne());
    expect(style.width).toBe('36px');
    expect(style.height).toBe('36px');
    // The 44px bump rides `(hover: none), (pointer: coarse)`, which happy-dom
    // resolves against the viewport rather than the pointer, so it cannot be
    // asserted here. It is measured with touch emulation in the headless pass.
  });
});
