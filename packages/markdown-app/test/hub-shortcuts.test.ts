import { describe, expect, it } from 'vitest';
import { hubShortcutKeydown } from '../src/hub/hub-shortcuts.ts';

// The regression this file pins: opening a task detail moves focus INTO the
// panel (deliberately — hold-to-talk needs a focus target), which left the
// Gmail-style row shortcuts anchored on document.activeElement with no row
// focused. j restarted from the top row and o/s/a went dead in exactly the
// state a keyboard user is in right after opening a task. The handler must
// fall back to the OPEN task's row when the detail panel holds focus — and
// only then, so an unrelated focus does not silently inherit a row.

function row(taskId: string): HTMLElement {
  const r = document.createElement('div');
  r.className = 'hub-task-row';
  r.tabIndex = 0;
  r.dataset.taskId = taskId;
  const status = document.createElement('select');
  status.className = 'hub-status-select';
  const assignee = document.createElement('select');
  assignee.className = 'hub-row-assignee';
  r.append(status, assignee);
  return r;
}

function fixture(detailTaskId: string | null) {
  document.body.innerHTML = '';
  const help = document.createElement('div');
  help.id = 'hub-help';
  help.classList.add('hidden');
  const rows = [row('t1'), row('t2'), row('t3')];
  const panel = document.createElement('div');
  panel.className = 'hub-detail-panel';
  panel.tabIndex = -1;
  document.body.append(help, ...rows, panel);
  const state = {
    detailTaskId,
    tasks: new Map([
      ['t1', { id: 't1' }],
      ['t2', { id: 't2' }],
      ['t3', { id: 't3' }],
    ]),
  };
  const opened: string[] = [];
  let closed = 0;
  const handler = hubShortcutKeydown({
    state,
    helpEl: () => help,
    openDetail: (id) => {
      opened.push(id);
      state.detailTaskId = id;
    },
    closeDetail: () => {
      closed += 1;
      state.detailTaskId = null;
    },
  });
  return {
    handler,
    help,
    rows,
    panel,
    state,
    opened,
    closedCount: () => closed,
  };
}

/** Dispatch a real bubbling keydown from the currently focused element so the
 *  handler sees a populated composedPath, exactly as it would live. */
function press(key: string, handler: (ev: KeyboardEvent) => void): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true });
  document.addEventListener('keydown', handler as EventListener, { once: true });
  (document.activeElement ?? document.body).dispatchEvent(ev);
  return ev;
}

describe('hub row shortcuts with the detail panel focused (the #250 focus steal)', () => {
  it('j continues from the open task, not from the top row', () => {
    const f = fixture('t2');
    f.panel.focus();
    expect(document.activeElement).toBe(f.panel); // control: the steal happened
    press('j', f.handler);
    expect(document.activeElement).toBe(f.rows[2]);
  });

  it('k steps back from the open task', () => {
    const f = fixture('t2');
    f.panel.focus();
    press('k', f.handler);
    expect(document.activeElement).toBe(f.rows[0]);
  });

  it('s opens the open task row status dropdown instead of doing nothing', () => {
    const f = fixture('t2');
    f.panel.focus();
    press('s', f.handler);
    expect(document.activeElement).toBe(f.rows[1]?.querySelector('.hub-status-select'));
  });

  it('a focuses the open task row assignee picker', () => {
    const f = fixture('t2');
    f.panel.focus();
    press('a', f.handler);
    expect(document.activeElement).toBe(f.rows[1]?.querySelector('.hub-row-assignee'));
  });

  it('a focused row still outranks the fallback', () => {
    const f = fixture('t2');
    f.rows[0]?.focus();
    press('j', f.handler);
    expect(document.activeElement).toBe(f.rows[1]);
  });

  it('an unrelated focus does NOT inherit the open task anchor', () => {
    const f = fixture('t2');
    const settings = document.createElement('button');
    document.body.append(settings);
    settings.focus();
    press('s', f.handler);
    // `s` from a non-row, non-panel element stays dead rather than acting on
    // a row the user is not looking at...
    expect(document.activeElement).toBe(settings);
    press('j', f.handler);
    // ...and j starts from the top, the pre-detail behavior.
    expect(document.activeElement).toBe(f.rows[0]);
  });

  it('with no detail open, j from nowhere starts at the top row', () => {
    const f = fixture(null);
    f.panel.focus();
    press('j', f.handler);
    expect(document.activeElement).toBe(f.rows[0]);
  });

  it('never fires while typing', () => {
    const f = fixture('t2');
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    press('j', f.handler);
    expect(document.activeElement).toBe(input);
  });

  it('Escape still closes the open detail', () => {
    const f = fixture('t2');
    f.panel.focus();
    press('Escape', f.handler);
    expect(f.closedCount()).toBe(1);
  });
});
