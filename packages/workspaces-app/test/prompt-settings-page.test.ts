import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_LABEL } from '../src/settings/prompt-editor.ts';
import type { PromptDetail, PromptRow, PromptsApi } from '../src/settings/prompts-api.ts';
import { mountPromptsPage, parsePromptsRoute } from '../src/settings/prompts-page.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The prompts page, driven rather than read.
 *
 * The page is a list, an editor and a router over two addresses, so what is
 * worth pinning is what a reader's actions DO: opening a row, saving words,
 * emptying the box, restoring the default, and coming back with Back. The API
 * is a stub — the routes over it have their own HTTP-level tests in
 * `packages/server/test/prompt-settings.test.ts`, and pairing the two here
 * would only test the stub.
 *
 * The last block is the CSS half, read off the cascade at the two viewports
 * this project verifies: the rail and the section nav go away on the phone,
 * and the words the reader came to edit take the height instead.
 *
 * All fixtures are synthetic. The repo is public.
 */

const ROWS: PromptRow[] = [
  {
    id: 'meeting-notes',
    name: 'Notetaking instructions',
    purpose: 'How the live note-taker writes the notes while the room talks.',
    scope: 'server',
    editable: true,
    edited: true,
  },
  {
    id: 'thread-summary',
    name: 'Thread summary',
    purpose: 'The two lines that summarise a comment thread on its card.',
    scope: 'server',
    editable: false,
    edited: false,
  },
  {
    id: 'review-item-criteria',
    name: 'Review item criteria',
    purpose: "What an agent's ask has to do before it reaches your queue.",
    scope: 'board',
    editable: true,
    edited: true,
  },
];

const NOTES: PromptDetail = {
  id: 'meeting-notes',
  name: 'Notetaking instructions',
  purpose: 'How the live note-taker writes the notes while the room talks.',
  editable: true,
  value: 'Two bullets per topic.',
  isDefault: false,
  default: 'The shipped notetaking instructions.',
};

const SUMMARY: PromptDetail = {
  id: 'thread-summary',
  name: 'Thread summary',
  purpose: 'The two lines that summarise a comment thread on its card.',
  editable: false,
  value: 'The shipped summary prompt.',
  isDefault: true,
  default: 'The shipped summary prompt.',
};

/** An API whose saves are recorded and whose reads follow what was saved. */
function stubApi(overrides: Partial<PromptsApi> = {}): {
  api: PromptsApi;
  saves: Array<{ id: string; value: string | null }>;
} {
  const saves: Array<{ id: string; value: string | null }> = [];
  const details: Record<string, PromptDetail> = {
    'meeting-notes': { ...NOTES },
    'thread-summary': { ...SUMMARY },
  };
  const api: PromptsApi = {
    list: async () => ROWS,
    detail: async (id) => details[id] ?? null,
    save: async (id, value) => {
      saves.push({ id, value });
      const detail = details[id];
      if (detail) {
        detail.value = value ?? detail.default;
        detail.isDefault = value === null;
      }
      return { ok: true };
    },
    ...overrides,
  };
  return { api, saves };
}

function env(pathname: string, api: PromptsApi) {
  const loc = { pathname, search: '?ws=w-Test123', assign: vi.fn() };
  return {
    loc,
    pageEnv: {
      document,
      location: loc,
      history: {
        pushState: (_d: unknown, _t: string, url: string) => {
          const parsed = new URL(url, 'http://x');
          loc.pathname = parsed.pathname;
          loc.search = parsed.search;
        },
      },
      api,
    },
  };
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  root.id = 'settings-root';
  document.body.appendChild(root);
});
afterEach(() => {
  root.remove();
  document.body.innerHTML = '';
});

describe('the address', () => {
  it('separates the list from one prompt, and carries the board along', () => {
    expect(parsePromptsRoute('/settings/prompts', '?ws=w-A')).toEqual({
      promptId: null,
      workspaceId: 'w-A',
    });
    expect(parsePromptsRoute('/settings/prompts/meeting-notes', '?ws=w-A')).toEqual({
      promptId: 'meeting-notes',
      workspaceId: 'w-A',
    });
    // No board in context is a real state, not a crash: the page is still
    // the five server-wide prompts.
    expect(parsePromptsRoute('/settings/prompts', '')).toEqual({
      promptId: null,
      workspaceId: null,
    });
  });
});

describe('the list', () => {
  it('names every prompt with its purpose, and marks the edited ones', async () => {
    const { api } = stubApi();
    const { pageEnv } = env('/settings/prompts', api);
    await mountPromptsPage(root, pageEnv).render();
    const rows = root.querySelectorAll('.prompt-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('.prompt-name')?.textContent).toBe('Notetaking instructions');
    expect(rows[0]?.querySelector('.prompt-purpose')?.textContent).toContain(
      'while the room talks',
    );
    // The one marker a row carries — how you find what you changed last week.
    expect(rows[0]?.querySelector('.prompt-edited')?.textContent).toBe('Edited');
    expect(rows[1]?.querySelector('.prompt-edited')).toBeNull();
  });

  it('opens a board-scoped row on this page like any other', async () => {
    const { api } = stubApi();
    const { pageEnv } = env('/settings/prompts', api);
    await mountPromptsPage(root, pageEnv).render();
    const criteria = root.querySelector('a[data-prompt-id="review-item-criteria"]');
    // The review criteria keep their words on the BOARD and also have a
    // field in the board's own settings panel — neither fact reaches the
    // row. A row that looks like its siblings and lands somewhere else is
    // the wrong-target surprise this page is shaped to avoid; which request
    // carries the words is `prompts-api.ts`'s business.
    expect(criteria?.getAttribute('href')).toBe(
      '/settings/prompts/review-item-criteria?ws=w-Test123',
    );
    expect(criteria?.getAttribute('data-external')).toBeNull();
  });

  it('says so rather than emptying the page when the read fails', async () => {
    const { api } = stubApi({ list: async () => null });
    const { pageEnv } = env('/settings/prompts', api);
    await mountPromptsPage(root, pageEnv).render();
    expect(root.textContent).toContain('Could not read the prompts');
  });
});

describe('one prompt, open', () => {
  it('shows the words, the default behind a disclosure, and Save', async () => {
    const { api } = stubApi();
    const { pageEnv } = env('/settings/prompts/meeting-notes', api);
    await mountPromptsPage(root, pageEnv).render();
    const box = root.querySelector('#prompt-box') as HTMLTextAreaElement;
    expect(box.value).toBe('Two bullets per topic.');
    // Collapsed, because on the iPad height is the scarce axis and the thing
    // he came to edit must not be pushed down by a copy of itself.
    const disclosure = root.querySelector('details.prompt-default-view') as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('summary')?.textContent).toBe('Show the default');
    expect(disclosure.querySelector('pre')?.textContent).toBe(
      'The shipped notetaking instructions.',
    );
    // The Save button carries the promise; there is no caption under it.
    expect(root.querySelector('#prompt-save')?.textContent).toBe(SAVE_LABEL);
    // And the promise is stated in words that are true of all seven prompts.
    // It read "the next NOTE uses this" until that was seen on the review
    // criteria row, where only one of the seven writes notes.
    expect(SAVE_LABEL).not.toMatch(/note/i);
  });

  it('saves what was typed and repaints from what the server holds', async () => {
    const { api, saves } = stubApi();
    const { pageEnv } = env('/settings/prompts/meeting-notes', api);
    const page = mountPromptsPage(root, pageEnv);
    await page.render();
    const box = root.querySelector('#prompt-box') as HTMLTextAreaElement;
    box.value = '  One bullet per topic.  ';
    (root.querySelector('#prompt-save') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(saves).toEqual([{ id: 'meeting-notes', value: 'One bullet per topic.' }]);
    expect((root.querySelector('#prompt-box') as HTMLTextAreaElement).value).toBe(
      'One bullet per topic.',
    );
  });

  it('refuses an empty box instead of writing emptiness over the words', async () => {
    const { api, saves } = stubApi();
    const { pageEnv } = env('/settings/prompts/meeting-notes', api);
    await mountPromptsPage(root, pageEnv).render();
    const box = root.querySelector('#prompt-box') as HTMLTextAreaElement;
    box.value = '   ';
    (root.querySelector('#prompt-save') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    // Select-all-delete is a slip far more often than a request to send no
    // instructions, and restoring the default has its own button.
    expect(saves).toEqual([]);
    expect(document.getElementById('settings-toast')?.textContent).toContain('cannot be empty');
  });

  it('restores the default and comes back with the default’s own words', async () => {
    const { api, saves } = stubApi();
    const { pageEnv } = env('/settings/prompts/meeting-notes', api);
    await mountPromptsPage(root, pageEnv).render();
    (root.querySelector('#prompt-restore') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(saves).toEqual([{ id: 'meeting-notes', value: null }]);
    expect((root.querySelector('#prompt-box') as HTMLTextAreaElement).value).toBe(
      'The shipped notetaking instructions.',
    );
    // Edited marker gone, because the words are the shipped ones again.
    expect(root.querySelector('.prompt-editor-head .prompt-edited')).toBeNull();
  });

  it('shows the thread summary without anything to type in', async () => {
    const { api } = stubApi();
    const { pageEnv } = env('/settings/prompts/thread-summary', api);
    await mountPromptsPage(root, pageEnv).render();
    // Read-only by decision, not by omission: every edit marks ~900 stored
    // summaries stale and the next backfill re-pays for all of them.
    expect(root.querySelector('#prompt-box')).toBeNull();
    expect(root.querySelector('#prompt-save')).toBeNull();
    expect(root.querySelector('#prompt-readonly')?.textContent).toBe('The shipped summary prompt.');
    // No disclosure either: with no override possible the default is the text
    // already on screen, so "Show the default" would open onto a copy of it.
    expect(root.querySelector('.prompt-default-view')).toBeNull();
  });

  it('disables rather than empties the box when the read fails', async () => {
    const { api } = stubApi({ detail: async () => null });
    const { pageEnv } = env('/settings/prompts/meeting-notes', api);
    await mountPromptsPage(root, pageEnv).render();
    expect(root.textContent).toContain('Could not read this prompt');
    expect(root.querySelector('#prompt-box')).toBeNull();
  });
});

describe('moving between the two', () => {
  it('opens a row and comes back to the list', async () => {
    const { api } = stubApi();
    const { pageEnv, loc } = env('/settings/prompts', api);
    const page = mountPromptsPage(root, pageEnv);
    await page.render();
    page.go('/settings/prompts/meeting-notes?ws=w-Test123');
    await new Promise((r) => setTimeout(r, 0));
    expect(loc.pathname).toBe('/settings/prompts/meeting-notes');
    expect(root.querySelector('#prompt-box')).not.toBeNull();
    // Back re-reads the address rather than repainting a remembered route.
    loc.pathname = '/settings/prompts';
    await page.render();
    expect(root.querySelectorAll('.prompt-row')).toHaveLength(3);
  });
});

describe('the page at both sizes', () => {
  let cleanup = () => {};
  beforeEach(() => {
    // The order renderSettingsShell links them: shared tokens, then the
    // page's own rules. tokens.css is left out for the reason css-harness
    // gives — the mapping half alone re-points every colour at nothing.
    cleanup = installSheets('styles.css', 'settings.css');
  });
  afterEach(() => cleanup());

  async function mountAt(width: number, height: number, path: string): Promise<void> {
    setViewport({ width, height });
    const { api } = stubApi();
    const { pageEnv } = env(path, api);
    await mountPromptsPage(root, pageEnv).render();
  }

  it('keeps the rail and the section nav on the iPad', async () => {
    await mountAt(IPAD.width, IPAD.height, '/settings/prompts');
    const rail = root.querySelector('.settings-rail') as HTMLElement;
    const subnav = root.querySelector('.settings-subnav') as HTMLElement;
    expect(styleOf(rail).display).not.toBe('none');
    expect(styleOf(subnav).display).not.toBe('none');
  });

  it('drops both at 430px and gives the words the room', async () => {
    await mountAt(PHONE.width, PHONE.height, '/settings/prompts/meeting-notes');
    // The rail and the section nav are the two things a phone cannot pay for.
    expect(styleOf(root.querySelector('.settings-rail') as HTMLElement).display).toBe('none');
    expect(styleOf(root.querySelector('.settings-subnav') as HTMLElement).display).toBe('none');
    // The box grows into what is left rather than sitting at a fixed height.
    const box = styleOf(root.querySelector('#prompt-box') as HTMLElement);
    expect(box.flexGrow).toBe('1');
    expect(box.minHeight).toBe('220px');
    // The way back is a tap target on the phone, where the rail is gone.
    expect(styleOf(root.querySelector('#settings-back') as HTMLElement).display).toBe('flex');
    const save = styleOf(root.querySelector('#prompt-save') as HTMLElement);
    expect(Number.parseInt(save.minHeight, 10)).toBeGreaterThanOrEqual(44);
  });
});
