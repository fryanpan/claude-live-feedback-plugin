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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type ParallelismCap, mountParallelismCap } from '../src/hub/parallelism-cap.ts';

function dom() {
  document.body.innerHTML = `
    <div class="hub-settings-row hub-settings-row--cap">
      <label class="hub-settings-label" for="hub-parallelism-cap">Parallelism cap
        <small id="hub-parallelism-cap-note" class="hub-settings-note"></small>
      </label>
      <input type="number" id="hub-parallelism-cap" class="hub-cap-input" />
      <div class="hub-criteria-actions">
        <button type="button" id="hub-parallelism-cap-save" class="hub-btn"></button>
        <button type="button" id="hub-parallelism-cap-default" class="hub-btn"></button>
      </div>
    </div>`;
  return {
    box: document.getElementById('hub-parallelism-cap') as HTMLInputElement,
    note: document.getElementById('hub-parallelism-cap-note') as HTMLElement,
    save: document.getElementById('hub-parallelism-cap-save') as HTMLButtonElement,
    useDefault: document.getElementById('hub-parallelism-cap-default') as HTMLButtonElement,
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
 * its sibling field: pinned here so the panel is proven to actually carry it,
 * not just that the field behaves correctly in isolation.
 */
describe('the settings panel carries the field', () => {
  const shell = readFileSync(resolve(import.meta.dirname, '../src/hub/hub-app.ts'), 'utf8');

  it('has the input, its note and both buttons inside the settings panel', () => {
    const panel = shell.slice(
      shell.indexOf('id="hub-settings-panel"'),
      shell.indexOf('id="hub-connection"'),
    );
    expect(panel).not.toBe('');
    for (const id of [
      'hub-parallelism-cap',
      'hub-parallelism-cap-note',
      'hub-parallelism-cap-save',
      'hub-parallelism-cap-default',
    ]) {
      expect(panel).toContain(`id="${id}"`);
    }
    expect(panel).toContain('id="hub-review-criteria"');
  });

  it('mounts it and refreshes it when the panel opens', () => {
    expect(shell).toContain('mountParallelismCap({');
    expect(shell).toContain('parallelismCap.refresh()');
  });
});
