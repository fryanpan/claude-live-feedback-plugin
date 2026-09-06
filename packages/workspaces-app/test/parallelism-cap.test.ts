/**
 * The settings field for how many builders a board's lead may dispatch at
 * once (Bryan, by voice: "add support for limiting parallelism in the
 * workspace"). `register_dispatch` enforces the number server-side; this
 * pins the field's unhappy paths — a read that fails, an out-of-range typed
 * value, a refused write — the same shape `review-criteria.test.ts` uses for
 * its sibling field, and for the same reason: those are the paths that can
 * quietly write a made-up cap over the board's real one.
 *
 * All fixtures are synthetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ParallelismCap,
  mountParallelismCap,
  parallelismCapNote,
} from '../src/board/parallelism-cap.ts';
import {
  WS,
  boardRow,
  bootTestBoard,
  click,
  el,
  resetBoardServer,
  server,
} from './support/board-drive.ts';

function dom() {
  document.body.innerHTML = `
    <div class="board-settings-row board-settings-row--cap">
      <label class="board-settings-label" for="board-parallelism-cap">Parallelism cap
        <small id="board-parallelism-cap-note" class="board-settings-note"></small>
      </label>
      <input type="number" id="board-parallelism-cap" class="board-cap-input" />
      <div class="board-criteria-actions">
        <button type="button" id="board-parallelism-cap-save" class="board-btn"></button>
        <button type="button" id="board-parallelism-cap-default" class="board-btn"></button>
      </div>
    </div>`;
  return {
    box: document.getElementById('board-parallelism-cap') as HTMLInputElement,
    note: document.getElementById('board-parallelism-cap-note') as HTMLElement,
    save: document.getElementById('board-parallelism-cap-save') as HTMLButtonElement,
    useDefault: document.getElementById('board-parallelism-cap-default') as HTMLButtonElement,
  };
}

function mount(
  opts: {
    read?: () => Promise<ParallelismCap | null>;
    write?: (value: number | null) => Promise<boolean>;
  } = {},
) {
  const els = dom();
  const toasts: string[] = [];
  const write = opts.write ?? vi.fn(async () => true);
  const handle = mountParallelismCap({
    ...els,
    read: opts.read ?? (async () => ({ value: 2, isDefault: true, inUse: 0 })),
    write,
    toast: (m) => toasts.push(m),
  });
  return { ...els, handle, toasts, write };
}

describe('the parallelism cap field', () => {
  it('shows the board’s cap, says when it is the default, and states how many slots are in use', async () => {
    const f = mount({ read: async () => ({ value: 2, isDefault: true, inUse: 1 }) });
    await f.handle.refresh();
    expect(f.box.value).toBe('2');
    expect(f.box.disabled).toBe(false);
    expect(f.note.textContent).toContain('1 of 2 in use');
    expect(f.note.textContent).toContain('The default');
  });

  it('says when the board has set its own (control)', async () => {
    const f = mount({ read: async () => ({ value: 5, isDefault: false, inUse: 3 }) });
    await f.handle.refresh();
    expect(f.box.value).toBe('5');
    expect(f.note.textContent).toBe('3 of 5 in use. Edited for this board.');
  });

  it('says who set the cap and when, once somebody has', async () => {
    const now = Date.now();
    const f = mount({
      read: async () => ({
        value: 5,
        isDefault: false,
        inUse: 3,
        lastChange: { actorName: 'Jordan', ts: now - 2 * 60 * 60_000, from: 4, to: 5 },
      }),
    });
    await f.handle.refresh();
    expect(f.note.textContent).toBe('3 of 5 in use. Cap 5, set by Jordan 2h ago.');
  });

  it('a board put back on the default says who did that, and a board never asked says nothing', async () => {
    const now = Date.now();
    const reset = mount({
      read: async () => ({
        value: 4,
        isDefault: true,
        inUse: 0,
        lastChange: { actorName: 'Cartographer', ts: now - 5 * 60_000, from: 2, to: 4 },
      }),
    });
    await reset.handle.refresh();
    expect(reset.note.textContent).toContain('Back on the default, set by Cartographer 5m ago.');
    const never = mount({ read: async () => ({ value: 4, isDefault: true, inUse: 0 }) });
    await never.handle.refresh();
    expect(never.note.textContent).not.toContain('set by');
  });

  it('omits the in-use count rather than claiming zero when the read carried none', async () => {
    const f = mount({ read: async () => ({ value: 2, isDefault: true }) });
    await f.handle.refresh();
    expect(f.note.textContent).not.toContain('in use');
  });

  it('saves what was typed, then re-reads rather than trusting the send', async () => {
    const seen: Array<number | null> = [];
    let stored: ParallelismCap = { value: 2, isDefault: true };
    const f = mount({
      read: async () => stored,
      write: async (v) => {
        seen.push(v);
        stored = v === null ? { value: 2, isDefault: true } : { value: v, isDefault: false };
        return true;
      },
    });
    await f.handle.refresh();
    f.box.value = '4';
    f.save.click();
    await f.handle.settled();
    expect(seen).toEqual([4]);
    expect(f.box.value).toBe('4');
    expect(f.note.textContent).toBe('Edited for this board.');
    expect(f.toasts).toEqual(['Parallelism cap saved']);
  });

  it('restores the default through its own button, and puts the default’s value back', async () => {
    let stored: ParallelismCap = { value: 5, isDefault: false };
    const seen: Array<number | null> = [];
    const f = mount({
      read: async () => stored,
      write: async (v) => {
        seen.push(v);
        stored = v === null ? { value: 2, isDefault: true } : { value: v, isDefault: false };
        return true;
      },
    });
    await f.handle.refresh();
    expect(f.box.value).toBe('5');
    f.useDefault.click();
    await f.handle.settled();
    expect(seen).toEqual([null]);
    expect(f.box.value).toBe('2');
    expect(f.note.textContent).toContain('The default');
    expect(f.toasts).toEqual(['Parallelism cap back to the default']);
  });

  it('refuses to write a non-integer, an empty box, or a value below 1', async () => {
    const f = mount();
    await f.handle.refresh();
    f.box.value = '';
    f.save.click();
    await f.handle.settled();
    f.box.value = '0';
    f.save.click();
    await f.handle.settled();
    f.box.value = '1.5';
    f.save.click();
    await f.handle.settled();
    f.box.value = 'abc';
    f.save.click();
    await f.handle.settled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.toasts.every((t) => t.includes('whole number'))).toBe(true);
    expect(f.toasts.length).toBe(4);
  });

  it('a failed READ never becomes a destructive WRITE: the field locks and says so', async () => {
    const f = mount({ read: async () => null });
    await f.handle.refresh();
    expect(f.box.disabled).toBe(true);
    expect(f.save.disabled).toBe(true);
    expect(f.useDefault.disabled).toBe(true);
    expect(f.note.textContent).toContain('Could not read the cap');
    f.save.click();
    await f.handle.settled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('keeps the reader’s typed value when the write is refused', async () => {
    const f = mount({ write: async () => false });
    await f.handle.refresh();
    f.box.value = '7';
    f.save.click();
    await f.handle.settled();
    expect(f.box.value).toBe('7');
    expect(f.toasts).toEqual(['Could not save the parallelism cap']);
  });
});

/**
 * A module nobody mounts is the same bug review-criteria's own test found for
 * its sibling field: the panel has to be proven to actually carry it, not just
 * that the field behaves correctly in isolation.
 *
 * DRIVEN, NOT GREPPED. This used to read the seventeen board boot modules as
 * one string, slice out the settings panel's markup and match `id="..."` on
 * it, plus `mountParallelismCap({` and `parallelismCap.refresh()`. Every one
 * of those is a claim about how the boot is WRITTEN. The bug it stands in for
 * was found by a reviewer running a SELECTOR against the open gear panel and
 * getting nothing back — so run that selector. The field wired to a route
 * that answers nothing, or a gear press that never opens the panel, leaves
 * all four strings in the source and the reviewer's query still empty.
 */
describe('the settings panel carries the field', () => {
  const CAP_SETTINGS = {
    parallelismCap: { value: 4, isDefault: false },
    dispatchesInUse: 2,
  };

  beforeEach(() => {
    resetBoardServer();
    server.on(`/workspaces/${WS}/settings`, CAP_SETTINGS);
  });

  // The panel is a popover with document-level listeners; leaving it open
  // would let a later test's unrelated click reach a torn-down handler.
  afterEach(async () => {
    const panel = document.getElementById('board-settings-panel');
    if (panel && !panel.classList.contains('hidden')) await click(el('board-settings'));
    document.body.innerHTML = '';
  });

  /** Press the gear the way a reader does, and hand back the panel. */
  async function openSettings(): Promise<HTMLElement> {
    await bootTestBoard({ tasks: [boardRow('t-1')] });
    await click(el('board-settings'));
    const panel = el('board-settings-panel');
    expect(panel.classList.contains('hidden'), 'the gear did not open the panel').toBe(false);
    return panel;
  }

  it('has the input, its note and both buttons inside the open panel', async () => {
    const panel = await openSettings();
    for (const id of [
      'board-parallelism-cap',
      'board-parallelism-cap-note',
      'board-parallelism-cap-save',
      'board-parallelism-cap-default',
    ]) {
      expect(panel.querySelector(`#${id}`), `#${id} is not in the settings panel`).not.toBeNull();
    }
    // The reviewer's own query, against the open panel — this is the read
    // that came back empty and started the ticket.
    expect(panel.querySelectorAll('[id*=parallelism]').length).toBeGreaterThan(0);
    // Control: the sibling field the same panel carries is found the same way,
    // so a panel that matched nothing at all could not pass this.
    expect(panel.querySelector('#board-review-criteria')).not.toBeNull();
  });

  it('mounts it and fills it from the board when the panel opens', async () => {
    const panel = await openSettings();
    const box = panel.querySelector('#board-parallelism-cap') as HTMLInputElement;
    const note = panel.querySelector('#board-parallelism-cap-note') as HTMLElement;
    // A mounted field carries the BOARD's cap, not a placeholder: the read
    // ran, resolved, and reached the DOM.
    expect(box.value).toBe('4');
    expect(box.disabled).toBe(false);
    // Read off the module rather than hand-copied, so the note cannot pass by
    // matching a string this test invented.
    expect(note.textContent).toBe(
      parallelismCapNote({ ...CAP_SETTINGS.parallelismCap, inUse: CAP_SETTINGS.dispatchesInUse }),
    );
    expect(note.textContent).toContain('2 of 4 in use');
  });

  it('re-reads on every open, so a cap moved from a tool lands here', async () => {
    // The reason `refresh()` is on the open rather than on the mount: an
    // agent can move the cap from an MCP tool while this tab sits here, and a
    // stale box that got saved would write the old number back.
    const panel = await openSettings();
    const box = panel.querySelector('#board-parallelism-cap') as HTMLInputElement;
    expect(box.value).toBe('4');

    server.on(`/workspaces/${WS}/settings`, {
      parallelismCap: { value: 1, isDefault: false },
      dispatchesInUse: 1,
    });
    await click(el('board-settings')); // close
    await click(el('board-settings')); // and open again
    expect(box.value).toBe('1');
  });

  it('a settings read that answers nothing disables the field rather than emptying it', async () => {
    // A failed READ must never become a destructive WRITE — the control that
    // says the two cases above are the read landing, not a default painted
    // over an unanswered route.
    server.on(`/workspaces/${WS}/settings`, {});
    const panel = await openSettings();
    const box = panel.querySelector('#board-parallelism-cap') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(panel.querySelector('#board-parallelism-cap-note')?.textContent).toContain(
      'Could not read the cap',
    );
  });
});
