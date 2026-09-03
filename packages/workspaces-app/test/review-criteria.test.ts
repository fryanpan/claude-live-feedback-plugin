/**
 * The settings field that says what makes a good review item.
 *
 * The gate shipped judging every agent's ask against a prompt the owner could
 * not see: with the panel open, nothing matching `criteri` was in the DOM, and
 * the only ways in were an MCP tool and a raw PUT (UX review, 2026-08-29).
 * What is pinned here is the field's unhappy paths — a read that fails, an
 * empty box, a refused write — because those are the ones that can quietly
 * turn the gate off or overwrite the board's real criteria.
 *
 * All fixtures are synthetic.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type ReviewCriteria, mountReviewCriteria } from '../src/hub/review-criteria.ts';

const DEFAULT_TEXT = 'A good review item can be answered from the card alone.';
const OWN_TEXT = 'Every headline is a question, and every option names its cost.';

function dom() {
  document.body.innerHTML = `
    <div class="hub-settings-row hub-settings-row--criteria">
      <label class="hub-settings-label" for="hub-review-criteria">What makes a good review item
        <small id="hub-review-criteria-note" class="hub-settings-note"></small>
      </label>
      <textarea id="hub-review-criteria" class="hub-criteria"></textarea>
      <div class="hub-criteria-actions">
        <button type="button" id="hub-review-criteria-save" class="hub-btn"></button>
        <button type="button" id="hub-review-criteria-default" class="hub-btn"></button>
      </div>
    </div>`;
  return {
    box: document.getElementById('hub-review-criteria') as HTMLTextAreaElement,
    note: document.getElementById('hub-review-criteria-note') as HTMLElement,
    save: document.getElementById('hub-review-criteria-save') as HTMLButtonElement,
    useDefault: document.getElementById('hub-review-criteria-default') as HTMLButtonElement,
  };
}

function mount(
  opts: {
    read?: () => Promise<ReviewCriteria | null>;
    write?: (value: string | null) => Promise<boolean>;
  } = {},
) {
  const els = dom();
  const toasts: string[] = [];
  const write = opts.write ?? vi.fn(async () => true);
  const handle = mountReviewCriteria({
    ...els,
    read: opts.read ?? (async () => ({ value: DEFAULT_TEXT, isDefault: true })),
    write,
    toast: (m) => toasts.push(m),
  });
  return { ...els, handle, toasts, write };
}

describe('the review-item criteria field', () => {
  it('shows the board’s criteria, and says when they are still the default', async () => {
    const f = mount();
    await f.handle.refresh();
    expect(f.box.value).toBe(DEFAULT_TEXT);
    expect(f.box.disabled).toBe(false);
    expect(f.note.textContent).toContain('The default');
    // The reader has to be able to tell "nobody has written these" from
    // "somebody wrote these" — it is the difference between reading a shipped
    // opinion and reading their own.
    expect(f.note.textContent).toContain('judged against it');
  });

  it('says when the board has written its own (control)', async () => {
    const f = mount({ read: async () => ({ value: OWN_TEXT, isDefault: false }) });
    await f.handle.refresh();
    expect(f.box.value).toBe(OWN_TEXT);
    expect(f.note.textContent).toBe('Edited for this board.');
  });

  it('saves what was typed, then re-reads rather than trusting the send', async () => {
    const seen: Array<string | null> = [];
    let stored: ReviewCriteria = { value: DEFAULT_TEXT, isDefault: true };
    const f = mount({
      read: async () => stored,
      write: async (v) => {
        seen.push(v);
        stored =
          v === null ? { value: DEFAULT_TEXT, isDefault: true } : { value: v, isDefault: false };
        return true;
      },
    });
    await f.handle.refresh();
    f.box.value = `  ${OWN_TEXT}  `;
    f.save.click();
    await f.handle.settled();
    expect(seen).toEqual([OWN_TEXT]);
    expect(f.box.value).toBe(OWN_TEXT);
    expect(f.note.textContent).toBe('Edited for this board.');
    expect(f.toasts).toEqual(['Criteria saved']);
  });

  it('restores the default through its own button, and puts the default’s words back', async () => {
    let stored: ReviewCriteria = { value: OWN_TEXT, isDefault: false };
    const seen: Array<string | null> = [];
    const f = mount({
      read: async () => stored,
      write: async (v) => {
        seen.push(v);
        stored =
          v === null ? { value: DEFAULT_TEXT, isDefault: true } : { value: v, isDefault: false };
        return true;
      },
    });
    await f.handle.refresh();
    expect(f.box.value).toBe(OWN_TEXT);
    f.useDefault.click();
    await f.handle.settled();
    expect(seen).toEqual([null]);
    expect(f.box.value).toBe(DEFAULT_TEXT);
    expect(f.note.textContent).toContain('The default');
    expect(f.toasts).toEqual(['Criteria back to the default']);
  });

  it('refuses to write an empty box — that is a slip, and “use the default” is the real verb', async () => {
    const f = mount();
    await f.handle.refresh();
    f.box.value = '   ';
    f.save.click();
    await f.handle.settled();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.toasts[0]).toContain('cannot be empty');
  });

  it('a failed READ never becomes a destructive WRITE: the field locks and says so', async () => {
    const f = mount({ read: async () => null });
    await f.handle.refresh();
    expect(f.box.disabled).toBe(true);
    expect(f.save.disabled).toBe(true);
    expect(f.useDefault.disabled).toBe(true);
    expect(f.note.textContent).toContain('Could not read the criteria');
    // The control: a read that works unlocks it again.
    f.save.click();
    await f.handle.settled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('keeps the reader’s words when the write is refused', async () => {
    const f = mount({ write: async () => false });
    await f.handle.refresh();
    f.box.value = OWN_TEXT;
    f.save.click();
    await f.handle.settled();
    expect(f.box.value).toBe(OWN_TEXT);
    expect(f.toasts).toEqual(['Could not save the criteria']);
  });
});

/**
 * A module nobody mounts is the same bug the review found. The field's
 * behaviour is pinned above; this pins that the panel actually carries it —
 * the reviewer's query was `[id*=criteri]` against the open gear panel, and
 * it returned nothing.
 */
describe('the settings panel carries the field', () => {
  const shell = readFileSync(resolve(import.meta.dirname, '../src/hub/hub-app.ts'), 'utf8');

  it('has the textarea, its note and both buttons inside the settings panel', () => {
    const panel = shell.slice(
      shell.indexOf('id="hub-settings-panel"'),
      shell.indexOf('id="hub-connection"'),
    );
    expect(panel).not.toBe('');
    for (const id of [
      'hub-review-criteria',
      'hub-review-criteria-note',
      'hub-review-criteria-save',
      'hub-review-criteria-default',
    ]) {
      expect(panel).toContain(`id="${id}"`);
    }
    // The control: the ids the reviewer DID find are in the same slice, so a
    // mis-sliced panel cannot pass this by matching nothing.
    expect(panel).toContain('id="hub-done-filter"');
  });

  it('mounts it and refreshes it when the panel opens', () => {
    expect(shell).toContain('mountReviewCriteria({');
    expect(shell).toContain('reviewCriteria.refresh()');
  });
});
