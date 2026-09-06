/**
 * ── The prompt settings routes: read the seven, change the five ──
 *
 * `/settings/prompts` is a page outside any board, so its data comes from a
 * top-level resource rather than from a board's own settings. Three routes
 * and nothing else:
 *
 *   GET  /api/prompts        the list — names, purposes, and which are edited
 *   GET  /api/prompts/<id>   one prompt: the words in force and the default
 *   PUT  /api/prompts/<id>   save, or `null` to restore the default
 *
 * The list deliberately carries NO prompt text. Seven defaults come to about
 * 24 KB, and the list's job is to say what exists and what has been changed;
 * the words arrive when a row is opened.
 *
 * Two prompts' WORDS are not served here at all. The review criteria and the
 * effort estimate are fields on a BOARD, written through
 * `PUT /workspaces/<id>/settings`, and the list says so with `scope` so
 * the page can read and write those two against the board it was opened from.
 * They are still edited on the settings page like every other row — `scope`
 * only says which request carries the words, and the page never learns the
 * difference (`prompts-api.ts`).
 *
 * A share visitor gets 403 on all three. These words are the machine's
 * configuration rather than any board's content, and a workspace share is a
 * grant over one board.
 */
import { PROMPT_CATALOG, promptDefinition } from '../prompt-catalog.ts';
import { PROMPT_MAX_CHARS, type PromptStore } from '../prompt-store.ts';

/** What the prompt routes read. Built once per server. */
export interface PromptRoutesContext {
  promptStore: PromptStore;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
}

export interface PromptRouteRequest {
  req: Request;
  pathname: string;
  /** Truthy for a share or collaboration visitor — refused here. */
  visitor: unknown;
  /** The claimed author, resolved against this server's identities. */
  authorFor: (claimed: unknown) => { id: string; name: string } | undefined;
}

/** One row of the list. `edited` is the only marker the page paints. */
export interface PromptListRow {
  id: string;
  name: string;
  purpose: string;
  scope: 'server' | 'board';
  editable: boolean;
  /** Absent for a board-scoped row: this server does not hold its value. */
  edited?: boolean;
}

/** The list, built from the catalog and the store's edited set. */
export function promptList(store: PromptStore): PromptListRow[] {
  const edited = store.editedIds();
  return PROMPT_CATALOG.map((def) => ({
    id: def.id,
    name: def.name,
    purpose: def.purpose,
    scope: def.scope,
    editable: def.editable,
    ...(def.scope === 'server' ? { edited: edited.has(def.id) } : {}),
  }));
}

/** The message a refused write carries back, in the words the page shows. */
export function writeRefusal(error: string): { status: number; message: string } {
  switch (error) {
    case 'unknown-prompt':
      return { status: 404, message: 'no prompt with that id' };
    case 'read-only':
      return { status: 403, message: 'this prompt cannot be changed here' };
    case 'too-long':
      return { status: 400, message: `over ${PROMPT_MAX_CHARS} characters` };
    case 'empty':
      return { status: 400, message: 'a prompt cannot be empty — restore the default instead' };
    default:
      return { status: 500, message: 'could not save the prompt' };
  }
}

export async function handlePromptRoutes(
  ctx: PromptRoutesContext,
  rq: PromptRouteRequest,
): Promise<Response | undefined> {
  const { promptStore, j, safeJson } = ctx;
  const { req, pathname, visitor, authorFor } = rq;
  if (!pathname.startsWith('/api/prompts')) return undefined;
  // Configuration for the machine, not content on a board. A visitor holds a
  // grant over one workspace, which says nothing about this.
  if (visitor) return j(403, { error: 'not available to share visitors' });

  if (pathname === '/api/prompts' && req.method === 'GET') {
    return j(200, { prompts: promptList(promptStore) });
  }

  const one = pathname.match(/^\/api\/prompts\/([^/]+)$/);
  if (!one) return undefined;
  const id = decodeURIComponent(one[1] ?? '');
  const def = promptDefinition(id);
  if (!def) return j(404, { error: 'no prompt with that id' });
  // A board-scoped prompt is a field on a board. Answering here with the
  // shipped default and nothing else would look like a working read of a
  // value this route cannot see — so it names where the value lives instead.
  if (def.scope === 'board') {
    return j(409, {
      error: 'board-scoped',
      message: `${def.id} is a field on a board — read and write it at /workspaces/<id>/settings`,
    });
  }

  if (req.method === 'GET') {
    const view = promptStore.view(id);
    return j(200, {
      id: def.id,
      name: def.name,
      purpose: def.purpose,
      editable: def.editable,
      value: view.value,
      isDefault: view.isDefault,
      default: def.default,
      maxChars: PROMPT_MAX_CHARS,
    });
  }

  if (req.method === 'PUT') {
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const raw = body && Object.hasOwn(body, 'value') ? body.value : undefined;
    if (raw !== null && typeof raw !== 'string') {
      return j(400, { error: 'value must be a string, or null to restore the default' });
    }
    const res = promptStore.write(id, raw, { id: author.id, name: author.name });
    if (!res.ok) {
      const refusal = writeRefusal(res.error);
      return j(refusal.status, { error: res.error, message: refusal.message });
    }
    // Read back rather than echo what was sent: the store is what decides
    // whether these words are now an override, and a restore has to answer
    // with the default's own text for the page to put in the box.
    const view = promptStore.view(id);
    return j(200, { id: def.id, value: view.value, isDefault: view.isDefault });
  }

  return j(405, { error: 'method not allowed' });
}
