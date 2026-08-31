import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHORES_ID, type HubTask } from '../src/hub/hub-model.ts';
import { type DetailHandlers, renderQuickActions } from '../src/hub/hub-render.ts';
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
function task(overrides: Partial<HubTask> = {}): HubTask {
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
    const wrap = root.querySelector('.hub-quick-actions');
    expect(wrap).not.toBeNull();
    const buttons = Array.from(root.querySelectorAll('button'));
    expect(buttons).toHaveLength(3);
    const newTask = root.querySelector('.hub-quick-new') as HTMLButtonElement;
    const huddle = root.querySelector('.hub-huddle-start') as HTMLButtonElement;
    expect(newTask.textContent).toContain('New task');
    expect(newTask.classList.contains('hub-btn-primary')).toBe(true);
    expect(huddle.textContent).toContain('Start a planning huddle');
    expect(huddle.classList.contains('hub-btn')).toBe(true);
    const conversation = root.querySelector('.hub-conversation-start') as HTMLButtonElement;
    expect(conversation.textContent).toContain('Record a conversation');
    expect(conversation.type).toBe('button');
    // Not a submit: there is no form here to submit, and a stray Enter must
    // not file anything.
    expect(newTask.type).toBe('button');
    expect(huddle.type).toBe('button');
    // The box this replaces is GONE, not hidden beside the buttons.
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('.hub-quick-input')).toBeNull();
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
    (root.querySelector('.hub-quick-new') as HTMLButtonElement).click();
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
    const btn = root.querySelector('.hub-quick-new') as HTMLButtonElement;
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
    const btn = root.querySelector('.hub-huddle-start') as HTMLButtonElement;
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
    const btn = root.querySelector('.hub-conversation-start') as HTMLButtonElement;
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
    const title = root.querySelector('.hub-detail-title') as HTMLElement;
    expect(title.textContent).toBe('Untitled task');
    expect(title.classList.contains('hub-detail-title-placeholder')).toBe(true);
    // Not in edit mode on its own: only the New task flow asks for that.
    expect(title.querySelector('input')).toBeNull();
  });

  it('a titled task carries no placeholder dressing', () => {
    renderTaskDetail(root, task({ title: 'Ship the rollout' }), handlers());
    const title = root.querySelector('.hub-detail-title') as HTMLElement;
    expect(title.textContent).toBe('Ship the rollout');
    expect(title.classList.contains('hub-detail-title-placeholder')).toBe(false);
  });

  it('with focusTitle the title is an EMPTY focused input, and Enter commits what was typed', () => {
    const onTitleCommit = vi.fn();
    const t = task({ title: 'Untitled task', untitled: true });
    renderTaskDetail(root, t, handlers({ focusTitle: true, onTitleCommit }));
    const input = root.querySelector('.hub-detail-title input') as HTMLInputElement;
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
    const input = root.querySelector('.hub-detail-title input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const title = root.querySelector('.hub-detail-title') as HTMLElement;
    expect(title.querySelector('input')).toBeNull();
    expect(title.textContent).toBe('Untitled task');
    expect(title.classList.contains('hub-detail-title-placeholder')).toBe(true);
    // The focus is an OPEN-time act. A projection repaint of the same task
    // (a peer's comment landing) must not drag the reader back into rename.
    renderTaskDetail(root, { ...t }, h);
    expect(root.querySelector('.hub-detail-title input')).toBeNull();
  });

  it('a rename that lands clears the placeholder dressing on the next paint', () => {
    const t = task({ title: 'Untitled task', untitled: true });
    renderTaskDetail(root, t, handlers());
    renderTaskDetail(root, { ...t, title: 'Ship the rollout', untitled: undefined }, handlers());
    const title = root.querySelector('.hub-detail-title') as HTMLElement;
    expect(title.textContent).toBe('Ship the rollout');
    expect(title.classList.contains('hub-detail-title-placeholder')).toBe(false);
  });
});

/**
 * hub-app has no boot harness (main() runs on import against a real shell), so
 * its wiring is pinned by source text — the established shape for hub-app in
 * this suite (board-url-wiring.test.ts).
 */
describe('hub-app wires the two buttons to the two routes', () => {
  const HUB_APP = readFileSync(resolve(import.meta.dirname, '../src/hub/hub-app.ts'), 'utf8');
  const SHORTCUTS = readFileSync(
    resolve(import.meta.dirname, '../src/hub/hub-shortcuts.ts'),
    'utf8',
  );
  const fn = (name: string): string => {
    const m = HUB_APP.match(new RegExp(`async function ${name}\\([^)]*\\)[\\s\\S]*?\\n {2}\\}\\n`));
    return m?.[0] ?? '';
  };

  it('mounts the buttons into the quick slot and no longer mounts the box', () => {
    expect(HUB_APP).toContain("renderQuickActions(el('hub-quick')");
    expect(HUB_APP).not.toContain('renderQuickAdd(');
  });

  it('New task posts an untitled row as the person, with nobody else assigned', () => {
    const body = fn('newTask');
    expect(body, 'newTask went missing').not.toBe('');
    expect(body).toContain('untitled: true');
    expect(body).toContain('author');
    // The old capture box handed every idea to the lead agent. An empty row
    // Bryan is about to type into is his — the route assigns it to the author
    // when nobody is named.
    expect(body).not.toContain('assignee');
    // Opens the panel on the new id; the row itself arrives over the ydoc and
    // renderDetail paints it when it lands, the way a boot deep link does.
    expect(body).toContain('state.detailTaskId = ');
    expect(body).toContain('renderDetail()');
  });

  it('the panel is told to open in rename for exactly the row New task filed', () => {
    expect(HUB_APP).toMatch(/focusTitle:\s*focusTitleTaskId === task\.id/);
  });

  it('Start a planning huddle posts to the huddle route and leaves with the mic flag', () => {
    const body = fn('startHuddle');
    expect(body, 'startHuddle went missing').not.toBe('');
    expect(body).toMatch(/\/huddles`/);
    expect(body).toContain('location.assign(');
    expect(body).toMatch(/huddle=1/);
    // The mode goes on the address too: the press on THIS page is the only
    // thing that knows whether anyone else is in the room, and the editor
    // that opens the mic is a different page.
    expect(body).toContain('HUDDLE_MODE_PARAM');
  });

  it('the two mic buttons are the same route with different modes', () => {
    expect(HUB_APP).toContain("onStartHuddle: () => startHuddle('solo')");
    expect(HUB_APP).toContain("onStartConversation: () => startHuddle('conversation')");
  });

  it('the c shortcut presses New task now that there is no box to focus', () => {
    expect(SHORTCUTS).toContain("'.hub-quick-new'");
    expect(SHORTCUTS).not.toContain('.hub-quick-input');
  });
});
