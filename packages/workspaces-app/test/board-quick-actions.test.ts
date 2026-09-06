import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DetailHandlers } from '../src/board/board-detail-render.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import { renderQuickActions } from '../src/board/board-render.ts';
import { HUDDLE_MODE_PARAM } from '../src/huddle-entry.ts';
import {
  type Booted,
  WS,
  boardRow,
  bootTestBoard,
  click,
  closeDetailPanel,
  el,
  resetBoardServer,
  server,
  settle,
} from './support/board-drive.ts';
import { disposeTaskDetail, renderTaskDetail } from './support/task-detail.ts';

/**
 * The Board's quick-add text box is gone; in its slot are the three ways work
 * starts (Bryan, 2026-08-29: *"From board, have a quick flow to create a new
 * task (replace current text box) that creates an empty item in the usual
 * task detail view. And have another button to start a planning huddle."*).
 *
 * "New task" files an EMPTY row and opens the real panel with the title in
 * edit mode, so the first thing typed is the title. "Start a planning huddle"
 * creates the huddle doc and leaves for the editor with the mic flag. "Record
 * a conversation" is the same huddle for a room: it is a second BUTTON
 * because nothing announces an in-person conversation, so the press has to
 * be the announcement. None of them asks anything first. All fixtures
 * synthetic.
 */

const NOW = 1_700_000_000_000;

let seq = 0;
function task(overrides: Partial<BoardTask> = {}): BoardTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'bryan',
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

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});
afterEach(() => {
  disposeTaskDetail();
});

const pending = () => {
  let release = (_ok: boolean) => {};
  const promise = new Promise<boolean>((r) => {
    release = r;
  });
  return { promise, release: (ok: boolean) => release(ok) };
};

describe('renderQuickActions — the buttons in the quick-add slot', () => {
  it('mounts New task (primary), the huddle and the conversation, and no text box', () => {
    renderQuickActions(root, {
      onNewTask: () => Promise.resolve(true),
      onStartHuddle: () => Promise.resolve(true),
      onStartConversation: () => Promise.resolve(true),
    });
    const wrap = root.querySelector('.board-quick-actions');
    expect(wrap).not.toBeNull();
    const buttons = Array.from(root.querySelectorAll('button'));
    expect(buttons).toHaveLength(3);
    const newTask = root.querySelector('.board-quick-new') as HTMLButtonElement;
    const huddle = root.querySelector('.board-huddle-start') as HTMLButtonElement;
    expect(newTask.textContent).toContain('New task');
    expect(newTask.classList.contains('board-btn-primary')).toBe(true);
    // Round-4 mock (Bryan, 2026-09-01): verb-first, outcome-named — you
    // leave with a plan doc, or with notes. The second became "Have a
    // meeting" on 2026-09-02. The renames touch these entry buttons only;
    // routes, params and class names keep the huddle name.
    expect(huddle.textContent).toContain('Make a plan');
    expect(huddle.classList.contains('board-btn')).toBe(true);
    const conversation = root.querySelector('.board-conversation-start') as HTMLButtonElement;
    expect(conversation.textContent).toContain('Have a meeting');
    expect(conversation.type).toBe('button');
    // Not a submit: there is no form here to submit, and a stray Enter must
    // not file anything.
    expect(newTask.type).toBe('button');
    expect(huddle.type).toBe('button');
    // The box this replaces is GONE, not hidden beside the buttons.
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('.board-quick-input')).toBeNull();
    expect(root.querySelector('form')).toBeNull();
  });

  it('disables all of them when the server will not accept writes from this browser', () => {
    // Error prevention, matching the doc surface's edit toggle: a signed-out
    // reader is told these are unavailable rather than pressing one and
    // receiving a refusal. Every one of them creates something on the board,
    // so none is exempt — the conversation button included.
    const onNewTask = vi.fn(() => Promise.resolve(true));
    renderQuickActions(root, {
      onNewTask,
      onStartHuddle: () => Promise.resolve(true),
      onStartConversation: () => Promise.resolve(true),
      canWrite: false,
    });
    const buttons = Array.from(root.querySelectorAll('button'));
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(b.disabled).toBe(true);
      // Says why. A disabled control with no explanation is a dead end.
      expect(b.title).toMatch(/sign in/i);
      expect(b.getAttribute('aria-label')).toMatch(/sign in/i);
    }
    (root.querySelector('.board-quick-new') as HTMLButtonElement).click();
    expect(onNewTask).not.toHaveBeenCalled();
  });

  it('leaves them live when nothing says otherwise', () => {
    // The control for the case above. Without it "both are disabled" would
    // also be true of a render that disabled them unconditionally — which is
    // every board today, since the gate ships off.
    renderQuickActions(root, {
      onNewTask: () => Promise.resolve(true),
      onStartHuddle: () => Promise.resolve(true),
      onStartConversation: () => Promise.resolve(true),
    });
    for (const b of Array.from(root.querySelectorAll('button'))) {
      expect(b.disabled).toBe(false);
    }
  });

  it('a press calls its own handler once and holds the button while the call is out', async () => {
    const newTask = pending();
    const onNewTask = vi.fn(() => newTask.promise);
    const onStartHuddle = vi.fn(() => Promise.resolve(true));
    const onStartConversation = vi.fn(() => Promise.resolve(true));
    renderQuickActions(root, { onNewTask, onStartHuddle, onStartConversation });
    const btn = root.querySelector('.board-quick-new') as HTMLButtonElement;
    btn.click();
    expect(onNewTask).toHaveBeenCalledTimes(1);
    expect(onStartHuddle).not.toHaveBeenCalled();
    // The reflex second tap while the POST is out would file two empty rows.
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onNewTask).toHaveBeenCalledTimes(1);
    newTask.release(true);
    await Promise.resolve();
    expect(btn.disabled).toBe(false);
  });

  it('the huddle press calls its own handler, and a refusal gives the button back', async () => {
    const huddle = pending();
    const onNewTask = vi.fn(() => Promise.resolve(true));
    const onStartHuddle = vi.fn(() => huddle.promise);
    const onStartConversation = vi.fn(() => Promise.resolve(true));
    renderQuickActions(root, { onNewTask, onStartHuddle, onStartConversation });
    const btn = root.querySelector('.board-huddle-start') as HTMLButtonElement;
    btn.click();
    expect(onStartHuddle).toHaveBeenCalledTimes(1);
    expect(onNewTask).not.toHaveBeenCalled();
    // The two mic buttons are two routes, not one with a modifier.
    expect(onStartConversation).not.toHaveBeenCalled();
    expect(btn.disabled).toBe(true);
    huddle.release(false);
    await Promise.resolve();
    // A failed start (offline, retired board) leaves a pressable button, not
    // a dead one — the toast said why, the button is the retry.
    expect(btn.disabled).toBe(false);
  });

  it('the conversation press is its own route, held while the call is out', async () => {
    const conversation = pending();
    const onNewTask = vi.fn(() => Promise.resolve(true));
    const onStartHuddle = vi.fn(() => Promise.resolve(true));
    const onStartConversation = vi.fn(() => conversation.promise);
    renderQuickActions(root, { onNewTask, onStartHuddle, onStartConversation });
    const btn = root.querySelector('.board-conversation-start') as HTMLButtonElement;
    btn.click();
    expect(onStartConversation).toHaveBeenCalledTimes(1);
    expect(onStartHuddle).not.toHaveBeenCalled();
    expect(btn.disabled).toBe(true);
    conversation.release(false);
    await Promise.resolve();
    expect(btn.disabled).toBe(false);
  });

  it('mounts once — a board repaint does not stack a second set', () => {
    const h = {
      onNewTask: () => Promise.resolve(true),
      onStartHuddle: () => Promise.resolve(true),
      onStartConversation: () => Promise.resolve(true),
    };
    renderQuickActions(root, h);
    renderQuickActions(root, h);
    expect(root.querySelectorAll('button')).toHaveLength(3);
  });
});

describe('the panel opens an untitled task with the title ready to type', () => {
  it('shows the placeholder, muted, when nobody has named the task yet', () => {
    renderTaskDetail(root, task({ title: 'Untitled task', untitled: true }), handlers());
    const title = root.querySelector('.board-detail-title') as HTMLElement;
    expect(title.textContent).toBe('Untitled task');
    expect(title.classList.contains('board-detail-title-placeholder')).toBe(true);
    // Not in edit mode on its own: only the New task flow asks for that.
    expect(title.querySelector('input')).toBeNull();
  });

  it('a titled task carries no placeholder dressing', () => {
    renderTaskDetail(root, task({ title: 'Ship the rollout' }), handlers());
    const title = root.querySelector('.board-detail-title') as HTMLElement;
    expect(title.textContent).toBe('Ship the rollout');
    expect(title.classList.contains('board-detail-title-placeholder')).toBe(false);
  });

  it('with focusTitle the title is an EMPTY focused input, and Enter commits what was typed', () => {
    const onTitleCommit = vi.fn();
    const t = task({ title: 'Untitled task', untitled: true });
    renderTaskDetail(root, t, handlers({ focusTitle: true, onTitleCommit }));
    const input = root.querySelector('.board-detail-title input') as HTMLInputElement;
    expect(input).not.toBeNull();
    // Empty, not "Untitled task": the placeholder is the server's stand-in,
    // and typing into it would mean deleting it first.
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    input.value = 'Ship the rollout';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onTitleCommit).toHaveBeenCalledWith(t, 'Ship the rollout');
  });

  it('Escape on the empty input puts the placeholder back, and a repaint does not reopen it', () => {
    const t = task({ title: 'Untitled task', untitled: true });
    const h = handlers({ focusTitle: true });
    renderTaskDetail(root, t, h);
    const input = root.querySelector('.board-detail-title input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const title = root.querySelector('.board-detail-title') as HTMLElement;
    expect(title.querySelector('input')).toBeNull();
    expect(title.textContent).toBe('Untitled task');
    expect(title.classList.contains('board-detail-title-placeholder')).toBe(true);
    // The focus is an OPEN-time act. A projection repaint of the same task
    // (a peer's comment landing) must not drag the reader back into rename.
    renderTaskDetail(root, { ...t }, h);
    expect(root.querySelector('.board-detail-title input')).toBeNull();
  });

  it('a rename that lands clears the placeholder dressing on the next paint', () => {
    const t = task({ title: 'Untitled task', untitled: true });
    renderTaskDetail(root, t, handlers());
    renderTaskDetail(root, { ...t, title: 'Ship the rollout', untitled: undefined }, handlers());
    const title = root.querySelector('.board-detail-title') as HTMLElement;
    expect(title.textContent).toBe('Ship the rollout');
    expect(title.classList.contains('board-detail-title-placeholder')).toBe(false);
  });
});

/**
 * Which button calls which verb, on a real board.
 *
 * DRIVEN, NOT GREPPED. This used to read the seventeen boot modules as one
 * string, cut `newTask` and `startHuddle` out of `board-actions.ts` with a
 * regex, and match `untitled: true`, `location.assign(`, `HUDDLE_MODE_PARAM`
 * and `'.board-quick-new'` inside them. Every one of those is a claim about
 * how the verb is WRITTEN, and the two that matter most are ABSENCES —
 * `not.toContain('assignee')` over a function body, which any rename or any
 * move of the same behaviour into a helper satisfies. What is in question is
 * the request that leaves the page and the address the browser is sent to,
 * so press the buttons and read the fake server's log.
 *
 * The buttons above are the island's own unit tests. These are the wiring.
 */
describe('board-app wires the three buttons to their routes', () => {
  const NEW_ID = 't-new';

  beforeEach(() => {
    resetBoardServer();
    server.on(`/workspaces/${WS}/tasks`, { task: { id: NEW_ID } });
    server.on(`/workspaces/${WS}/huddles`, { url: `/workspaces/${WS}/docs/d-huddle` });
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Where the huddle press sent the browser, read off the boot's own address.
   *
   * `startHuddle` used to call the AMBIENT `location.assign` rather than the
   * `location` the boot was handed — in a browser the two are the same object,
   * so nothing was wrong on the board, but the fake could not see the hop and
   * this helper had to stub the global to observe it at all. It goes through
   * `BoardActionDeps.location` now, so the destination is read the same way
   * every other navigation in the boot is: off `board.location.navigations`.
   * `biome.json` bans the ambient global under `src/board/**` so the next one
   * added cannot come back.
   */
  async function navigatingPress(board: Booted, cls: string): Promise<readonly string[]> {
    const before = board.location.navigations.length;
    await click(quick(cls));
    return board.location.navigations.slice(before);
  }

  /** The one POST the press made to `path`, or undefined. */
  const posted = (path: string) =>
    server.calls.find((c) => c.method === 'POST' && c.url.includes(path));

  const quick = (cls: string) =>
    document.querySelector(`.board-quick-actions .${cls}`) as HTMLButtonElement;

  it('mounts the three buttons into the quick slot and no text box', async () => {
    await bootTestBoard({ tasks: [boardRow('t-1')] });
    const slot = el('board-quick');
    expect(slot.querySelector('.board-quick-new'), 'no New task button').not.toBeNull();
    expect(slot.querySelector('.board-huddle-start'), 'no Make a plan button').not.toBeNull();
    expect(slot.querySelector('.board-conversation-start'), 'no meeting button').not.toBeNull();
    // The box it replaced: an input in the slot is the thing that went away.
    expect(slot.querySelector('input')).toBeNull();
    expect(slot.querySelector('.board-quick-input')).toBeNull();
  });

  it('New task posts an untitled row as the person, with nobody else assigned', async () => {
    await bootTestBoard({ tasks: [boardRow('t-1')] });
    await click(quick('board-quick-new'));
    const call = posted(`/workspaces/${WS}/tasks`);
    expect(call, 'New task filed nothing').toBeDefined();
    const body = call?.body as Record<string, unknown>;
    expect(body.untitled).toBe(true);
    // The old capture box handed every idea to the lead agent. An empty row
    // Bryan is about to type into is his — the route assigns it to the author
    // when nobody is named, so the request must not name one.
    expect(body.author, 'the row was filed by nobody').toBeDefined();
    expect(Object.keys(body), 'the press named an assignee').not.toContain('assignee');
  });

  it('the panel opens on exactly the row New task filed, in rename', async () => {
    const board = await bootTestBoard({ tasks: [boardRow('t-1', { title: 'Measure it' })] });
    await click(quick('board-quick-new'));
    // The address is the board's one record of which panel is open.
    expect(board.history.url(), 'the panel did not open on the filed row').toContain(
      `task=${NEW_ID}`,
    );
    // The row itself arrives over the ydoc afterwards, the way a boot deep
    // link's does — and when it lands the title is an empty focused input.
    await board.project([
      boardRow('t-1', { title: 'Measure it' }),
      boardRow(NEW_ID, { title: 'Untitled task', untitled: true, order: 2 }),
    ]);
    const input = document.querySelector('.board-detail-title input') as HTMLInputElement | null;
    expect(input, 'the panel did not open in rename').not.toBeNull();
    expect(input?.value).toBe('');

    // …and for exactly that row: the panel opened on any OTHER task is not in
    // rename, which is what `focusTitleTaskId === task.id` buys.
    await board.traverseTo(`https://board.test/workspaces/${WS}/tasks?task=t-1`);
    expect(document.querySelector('.board-detail-title input')).toBeNull();
    await closeDetailPanel(board);
  });

  it('Make a plan posts a plan huddle and leaves with the mic flag and the mode', async () => {
    const board = await bootTestBoard({ tasks: [boardRow('t-1')] });
    const went = await navigatingPress(board, 'board-huddle-start');
    expect((posted(`/workspaces/${WS}/huddles`)?.body as { kind?: string })?.kind).toBe('plan');
    // The KIND rides the request body — the server seeds a plan doc with the
    // Goal heading — and the MODE rides the address, because the press on
    // THIS page is the only thing that knows whether anyone else is in the
    // room and the editor that opens the mic is a different page.
    expect(went, 'the press never left the board').toHaveLength(1);
    const left = new URL(went[0] as string, 'https://board.test');
    expect(left.pathname).toBe(`/workspaces/${WS}/docs/d-huddle`);
    expect(left.searchParams.get('huddle')).toBe('1');
    expect(left.searchParams.get(HUDDLE_MODE_PARAM)).toBe('solo');
  });

  it('Have a meeting is the same route with the other kind and the other mode', async () => {
    const board = await bootTestBoard({ tasks: [boardRow('t-1')] });
    const went = await navigatingPress(board, 'board-conversation-start');
    expect((posted(`/workspaces/${WS}/huddles`)?.body as { kind?: string })?.kind).toBe(
      'discussion',
    );
    expect(went, 'the press never left the board').toHaveLength(1);
    const left = new URL(went[0] as string, 'https://board.test');
    expect(left.pathname).toBe(`/workspaces/${WS}/docs/d-huddle`);
    expect(left.searchParams.get('huddle')).toBe('1');
    expect(left.searchParams.get(HUDDLE_MODE_PARAM)).toBe('conversation');
  });

  it('the c shortcut presses New task now that there is no box to focus', async () => {
    await bootTestBoard({ tasks: [boardRow('t-1')] });
    expect(posted(`/workspaces/${WS}/tasks`), 'a row was filed before the key').toBeUndefined();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    await settle();
    expect(posted(`/workspaces/${WS}/tasks`), 'c filed nothing').toBeDefined();
  });
});
