import { describe, expect, it } from 'vitest';
import { createPromptsApi } from '../src/settings/prompts-api.ts';

/**
 * Which request carries which prompt's words — asserted on the PATHS asked
 * for, not on what a stub chose to answer.
 *
 * This module exists to hide one fact from the page: five of the seven
 * prompts belong to the server and two are fields on a board, so `list`,
 * `detail` and `save` each go to one of two places. Nothing above it can tell
 * the difference, which is the point — and is also why a wrong path here is
 * invisible. A board read that 404s makes `boardSettings()` answer null,
 * `list()` reads that as "no board in context", and the page paints five rows
 * and looks finished. That is not hypothetical: it shipped that way, against
 * `/api/workspaces/<id>/settings`, a prefix the board's settings routes never
 * took. So the first test here pins the literal path.
 *
 * All fixtures are synthetic. The repo is public.
 */

const SERVER_ROWS = {
  prompts: [
    {
      id: 'meeting-notes',
      name: 'Notetaking instructions',
      purpose: 'How the live note-taker writes the notes while the room talks.',
      scope: 'server' as const,
      editable: true,
      edited: true,
    },
    {
      id: 'review-item-criteria',
      name: 'Review item criteria',
      purpose: "What an agent's ask has to do before it reaches your queue.",
      scope: 'board' as const,
      editable: true,
    },
  ],
};

const BOARD_SETTINGS = {
  reviewItemCriteria: {
    value: 'Answerable from the card alone.',
    isDefault: false,
    default: 'The shipped criteria.',
  },
};

/** Records every path asked for, and answers from a table keyed by path. */
function harness(table: Record<string, unknown>, workspaceId: string | null = 'w-Test123') {
  const reads: string[] = [];
  const writes: Array<{ path: string; method: string; body: unknown }> = [];
  const api = createPromptsApi({
    workspaceId,
    author: { id: 'user-a', name: 'Robin Vale' },
    async fetchJson<T>(path: string): Promise<T | null> {
      reads.push(path);
      return (table[path] as T) ?? null;
    },
    async send(path, method, body) {
      writes.push({ path, method, body });
      return { ok: true, status: 200, body: null };
    },
  });
  return { api, reads, writes };
}

const TABLE = {
  '/api/prompts': SERVER_ROWS,
  '/workspaces/w-Test123/settings': BOARD_SETTINGS,
};

describe('where a prompt’s words come from', () => {
  it('reads a board’s prompts from /workspaces/<id>/settings, with no /api prefix', async () => {
    const { api, reads } = harness(TABLE);
    await api.list();
    // The literal, because the wrong one fails silently rather than loudly.
    expect(reads).toContain('/workspaces/w-Test123/settings');
    expect(reads).not.toContain('/api/workspaces/w-Test123/settings');
  });

  it('lists both scopes as one list, and marks each one edited or not', async () => {
    const { api } = harness(TABLE);
    const rows = await api.list();
    expect(rows?.map((r) => r.id)).toEqual(['meeting-notes', 'review-item-criteria']);
    // A board row's "edited" comes off the board's own isDefault, not off
    // the server list, which does not carry one for it.
    expect(rows?.map((r) => r.edited)).toEqual([true, true]);
  });

  it('drops the board rows when the page was opened with no board', async () => {
    const { api, reads } = harness(TABLE, null);
    const rows = await api.list();
    // A row that cannot be opened is worse than a row that is not there.
    expect(rows?.map((r) => r.id)).toEqual(['meeting-notes']);
    expect(reads.some((p) => p.includes('/settings'))).toBe(false);
  });

  it('opens a board prompt with the board’s words and the catalogue’s name', async () => {
    const { api } = harness(TABLE);
    const detail = await api.detail('review-item-criteria');
    expect(detail?.name).toBe('Review item criteria');
    expect(detail?.value).toBe('Answerable from the card alone.');
    expect(detail?.default).toBe('The shipped criteria.');
    expect(detail?.isDefault).toBe(false);
  });

  it('opens a server prompt straight off /api/prompts/<id>', async () => {
    const detail = {
      id: 'meeting-notes',
      name: 'Notetaking instructions',
      purpose: 'p',
      editable: true,
      value: 'v',
      isDefault: false,
      default: 'd',
    };
    const { api, reads } = harness({ ...TABLE, '/api/prompts/meeting-notes': detail });
    expect(await api.detail('meeting-notes')).toEqual(detail);
    expect(reads).toContain('/api/prompts/meeting-notes');
  });
});

describe('where a save goes', () => {
  it('writes a board prompt onto its own field on the board', async () => {
    const { api, writes } = harness(TABLE);
    await api.save('review-item-criteria', 'Shorter, please.');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/workspaces/w-Test123/settings');
    expect(writes[0]?.method).toBe('PUT');
    expect(writes[0]?.body).toMatchObject({ reviewItemCriteria: 'Shorter, please.' });
  });

  it('writes a server prompt to the prompt route', async () => {
    const { api, writes } = harness(TABLE);
    await api.save('meeting-notes', 'Two bullets per topic.');
    expect(writes[0]?.path).toBe('/api/prompts/meeting-notes');
    expect(writes[0]?.body).toMatchObject({ value: 'Two bullets per topic.' });
  });

  it('sends null through to restore, rather than an empty string', async () => {
    const { api, writes } = harness(TABLE);
    await api.save('meeting-notes', null);
    // The server treats an empty string as a refusal and null as a restore;
    // collapsing them here would make the Restore button fail as "empty".
    expect((writes[0]?.body as { value: unknown }).value).toBeNull();
  });

  it('refuses a board save when there is no board, instead of posting nowhere', async () => {
    const { api, writes } = harness(TABLE, null);
    expect((await api.save('review-item-criteria', 'x')).ok).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
