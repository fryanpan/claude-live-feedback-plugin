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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReviewCriteria,
  criteriaNote,
  mountReviewCriteria,
} from '../src/board/review-criteria.ts';
import {
  WS,
  boardRow,
  bootTestBoard,
  click,
  el,
  resetBoardServer,
  server,
} from './support/board-drive.ts';

const DEFAULT_TEXT = 'A good review item can be answered from the card alone.';
const OWN_TEXT = 'Every headline is a question, and every option names its cost.';

function dom() {
  document.body.innerHTML = `
    <div class="board-settings-row board-settings-row--criteria">
      <label class="board-settings-label" for="board-review-criteria">What makes a good review item
        <small id="board-review-criteria-note" class="board-settings-note"></small>
      </label>
      <textarea id="board-review-criteria" class="board-criteria"></textarea>
      <div class="board-criteria-actions">
        <button type="button" id="board-review-criteria-save" class="board-btn"></button>
        <button type="button" id="board-review-criteria-default" class="board-btn"></button>
      </div>
    </div>`;
  return {
    box: document.getElementById('board-review-criteria') as HTMLTextAreaElement,
    note: document.getElementById('board-review-criteria-note') as HTMLElement,
    save: document.getElementById('board-review-criteria-save') as HTMLButtonElement,
    useDefault: document.getElementById('board-review-criteria-default') as HTMLButtonElement,
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
 * behaviour is pinned above; this pins that the panel actually carries it.
 *
 * DRIVEN, NOT GREPPED. This used to read the seventeen board boot modules as
 * one string, slice out the settings panel's markup and match `id="..."` on
 * it, plus `mountReviewCriteria({` and `reviewCriteria.refresh()`. The bug it
 * stands in for was found by a reviewer running `[id*=criteri]` against the
 * OPEN gear panel and getting nothing back — so run that query. A gate wired
 * to a payload the server does not send, or a gear press that never paints
 * the panel, leaves all four strings in the source and the reviewer's query
 * still empty.
 */
describe('the settings panel carries the field', () => {
  const CRITERIA_SETTINGS = { reviewItemCriteria: { value: OWN_TEXT, isDefault: false } };

  beforeEach(() => {
    resetBoardServer();
    server.on(`/workspaces/${WS}/settings`, CRITERIA_SETTINGS);
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

  it('answers the reviewer’s own query — [id*=criteri] against the open panel', async () => {
    const panel = await openSettings();
    // The query that came back empty and started the ticket.
    expect(panel.querySelectorAll('[id*=criteri]').length).toBeGreaterThan(0);
    for (const id of [
      'board-review-criteria',
      'board-review-criteria-note',
      'board-review-criteria-save',
      'board-review-criteria-default',
    ]) {
      expect(panel.querySelector(`#${id}`), `#${id} is not in the settings panel`).not.toBeNull();
    }
    // Control: the row the reviewer DID find is in the same panel, so a panel
    // that matched nothing at all could not pass this.
    expect(panel.querySelector('#board-done-filter')).not.toBeNull();
  });

  it('mounts it and fills it with the board’s own criteria when the panel opens', async () => {
    const panel = await openSettings();
    const box = panel.querySelector('#board-review-criteria') as HTMLTextAreaElement;
    const note = panel.querySelector('#board-review-criteria-note') as HTMLElement;
    // The words the gate judges against, in the box a reader can edit — which
    // is the whole ticket: they shipped visible only to an MCP tool.
    expect(box.value).toBe(OWN_TEXT);
    expect(box.disabled).toBe(false);
    expect(note.textContent).toBe(criteriaNote({ value: OWN_TEXT, isDefault: false }));
  });

  it('re-reads on every open, so criteria rewritten from a tool land here', async () => {
    // Why `refresh()` is on the open rather than on the mount: an agent can
    // rewrite the criteria while this tab sits here, and a stale box that got
    // saved would put the old words back.
    const panel = await openSettings();
    const box = panel.querySelector('#board-review-criteria') as HTMLTextAreaElement;
    expect(box.value).toBe(OWN_TEXT);

    server.on(`/workspaces/${WS}/settings`, {
      reviewItemCriteria: { value: DEFAULT_TEXT, isDefault: true },
    });
    await click(el('board-settings')); // close
    await click(el('board-settings')); // and open again
    expect(box.value).toBe(DEFAULT_TEXT);
  });

  it('a settings read that answers nothing disables the field rather than emptying it', async () => {
    // A failed READ must never become a destructive WRITE — the control that
    // says the two cases above are the read landing, not a default painted
    // over an unanswered route.
    server.on(`/workspaces/${WS}/settings`, {});
    const panel = await openSettings();
    const box = panel.querySelector('#board-review-criteria') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(panel.querySelector('#board-review-criteria-note')?.textContent).toContain(
      'Could not read the criteria',
    );
  });
});
