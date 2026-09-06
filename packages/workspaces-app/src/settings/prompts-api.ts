/**
 * Where the prompts page gets its data, and the one thing it has to hide.
 *
 * Five of the seven prompts belong to the SERVER and are served by
 * `/api/prompts`. Two of them — the review-item criteria and the effort
 * estimate — are fields on a BOARD, and have been since before this page
 * existed: they live on the board's record and are written through
 * `PUT /api/workspaces/<id>/settings`.
 *
 * That split is a fact about storage, not something the reader can act on
 * (Bryan, 2026-09-04, on the mock: no label saying which prompts are per
 * board and which are per server). So it is hidden HERE rather than in the
 * page: this module answers the same three questions for all seven, and the
 * page never learns which route it went to.
 */

/** One row of the list. `edited` is the only state a row carries. */
export interface PromptRow {
  id: string;
  name: string;
  purpose: string;
  scope: 'server' | 'board';
  editable: boolean;
  edited: boolean;
}

/** One prompt, opened. */
export interface PromptDetail {
  id: string;
  name: string;
  purpose: string;
  editable: boolean;
  /** The words in force: the override, or the shipped default. */
  value: string;
  isDefault: boolean;
  /** The shipped words, for the "Show the default" disclosure. */
  default: string;
}

export interface SaveResult {
  ok: boolean;
  /** One line the page shows when a save was refused. */
  message?: string;
}

export interface PromptsApi {
  /** The seven rows. `null` is a failed read, never an empty list. */
  list(): Promise<PromptRow[] | null>;
  /** One prompt. `null` is a failed read, never empty words. */
  detail(id: string): Promise<PromptDetail | null>;
  /** Save. `null` restores the default. */
  save(id: string, value: string | null): Promise<SaveResult>;
}

/** The two board-scoped prompts, and the field each one is on its board. */
const BOARD_FIELD: Record<string, 'reviewItemCriteria' | 'effortEstimatePrompt'> = {
  'review-item-criteria': 'reviewItemCriteria',
  'effort-estimate': 'effortEstimatePrompt',
};

interface BoardSettings {
  reviewItemCriteria?: { value?: string; isDefault?: boolean; default?: string };
  effortEstimatePrompt?: { value?: string; isDefault?: boolean; default?: string };
}

interface ServerPromptRow {
  id: string;
  name: string;
  purpose: string;
  scope: 'server' | 'board';
  editable: boolean;
  edited?: boolean;
}

export interface PromptsApiDeps {
  /** The board this page was opened from, or null when it was opened cold.
   *  Without it the two board-scoped rows have no value to read. */
  workspaceId: string | null;
  author: { id: string; name: string; kind?: string; color?: string };
  fetchJson<T>(path: string): Promise<T | null>;
  send(
    path: string,
    method: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown }>;
}

export function createPromptsApi(deps: PromptsApiDeps): PromptsApi {
  const { workspaceId, author, fetchJson, send } = deps;
  // `/workspaces/<id>/settings`, NOT `/api/…`. The board's settings routes
  // predate the `/api` prefix and never took it — `board-settings-panel.ts`
  // has always called this exact path. Getting it wrong does not error
  // visibly: the read 404s, `boardSettings()` answers null, and `list()`
  // reads that as "no board in context" and silently drops both rows, so the
  // page looks finished with five of the seven prompts on it.
  const boardPath = workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}/settings` : null;

  async function boardSettings(): Promise<BoardSettings | null> {
    if (!boardPath) return null;
    return await fetchJson<BoardSettings>(boardPath);
  }

  return {
    async list(): Promise<PromptRow[] | null> {
      const data = await fetchJson<{ prompts: ServerPromptRow[] }>('/api/prompts');
      if (!data || !Array.isArray(data.prompts)) return null;
      const board = await boardSettings();
      return data.prompts
        .filter((row) => {
          // A board-scoped prompt with no board in context has no value to
          // read and nowhere to write. It is left OUT rather than shown
          // dead: a row that cannot be opened is worse than a row that is
          // not there, and the page is always reached from a board.
          if (row.scope === 'board') return board !== null;
          return true;
        })
        .map((row) => {
          if (row.scope !== 'board') {
            return { ...row, edited: row.edited === true };
          }
          const field = BOARD_FIELD[row.id];
          const stored = field ? board?.[field] : undefined;
          return { ...row, edited: stored?.isDefault === false };
        });
    },

    async detail(id: string): Promise<PromptDetail | null> {
      const field = BOARD_FIELD[id];
      if (!field) {
        return await fetchJson<PromptDetail>(`/api/prompts/${encodeURIComponent(id)}`);
      }
      // A board prompt's words come off the board, but its NAME and its
      // purpose line come off the catalogue like every other row's — one
      // list, written once.
      const [rows, board] = await Promise.all([
        fetchJson<{ prompts: ServerPromptRow[] }>('/api/prompts'),
        boardSettings(),
      ]);
      const row = rows?.prompts?.find((r) => r.id === id);
      const stored = board?.[field];
      if (!row || !stored || typeof stored.value !== 'string') return null;
      return {
        id: row.id,
        name: row.name,
        purpose: row.purpose,
        editable: row.editable,
        value: stored.value,
        isDefault: stored.isDefault === true,
        default: typeof stored.default === 'string' ? stored.default : stored.value,
      };
    },

    async save(id: string, value: string | null): Promise<SaveResult> {
      const field = BOARD_FIELD[id];
      const res = field
        ? boardPath
          ? await send(boardPath, 'PUT', { [field]: value, author })
          : { ok: false, status: 0, body: null }
        : await send(`/api/prompts/${encodeURIComponent(id)}`, 'PUT', { value, author });
      if (res.ok) return { ok: true };
      const body = res.body as { message?: string; error?: string } | null;
      return {
        ok: false,
        ...(body?.message ? { message: body.message } : {}),
      };
    },
  };
}
