/**
 * Where a doc lives in the URL, in one place.
 *
 * A doc is addressed at `/workspaces/<workspaceId>/docs/<docId>` — the same
 * shape as every other resource, so a reader can tell from the address which
 * workspace they are in. `/review/<docId>` is the address it used to have and
 * still answers: bookmarks, older plugin bundles, and every URL already
 * pasted into a comment thread say that, and none of them can be restarted.
 * So both shapes parse here, and only one is ever built.
 *
 * Four call sites parsed the old path with their own regex (router, voice
 * dock, diff nav, and the click interceptor) and four more built it by hand.
 * Eight spellings of one rule is how half of them get missed; this module is
 * the rule.
 */

const DOC_PATH = /\/workspaces\/[^/?#]+\/docs\/([^/?#]+)/;
const LEGACY_DOC_PATH = /\/review\/([^/?#]+)/;
const WORKSPACE_PATH = /^\/workspaces\/([^/?#]+)/;

/** Strip an absolute URL down to its path — sidebar hrefs can be either. */
function pathOf(urlOrPath: string): string {
  if (!urlOrPath.includes('://')) return urlOrPath;
  try {
    return new URL(urlOrPath).pathname;
  } catch {
    return urlOrPath;
  }
}

/**
 * The docId this path addresses, or `'default'` when it addresses no doc.
 *
 * `'default'` rather than null is deliberate and inherited: the router mounts
 * a doc named `default` when the path names none, which is what the widget's
 * unbound surface uses.
 */
export function docIdFromPath(urlOrPath: string): string {
  return docIdFromPathOrNull(urlOrPath) ?? 'default';
}

/**
 * The docId this path addresses, or null when it addresses none.
 *
 * The distinction matters to the sidebar, which asks "is this href a doc
 * link" — a `'default'` answer there would treat every non-doc anchor as a
 * link to a doc called default.
 */
export function docIdFromPathOrNull(urlOrPath: string): string | null {
  const p = pathOf(urlOrPath);
  const m = p.match(DOC_PATH) ?? p.match(LEGACY_DOC_PATH);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/**
 * The workspace this path is under, or null.
 *
 * Null on a legacy `/review/<docId>` path, which names no workspace — callers
 * that need one fall back to `backTo` from `/api/docs/<id>`. Reading it from
 * the URL first matters for share visitors: `backTo` is owner-only (a
 * workspace id is an unguessable capability and a doc-scoped visitor must not
 * learn one from a member doc), but a visitor who arrived through a share
 * link is already standing on the workspace path, so the URL can tell them
 * what the API deliberately will not.
 */
export function workspaceIdFromPath(urlOrPath: string): string | null {
  const m = pathOf(urlOrPath).match(WORKSPACE_PATH);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** The address to link a doc at. Pass the workspace when one is known. */
export function docHref(docId: string, workspaceId: string | null, search = ''): string {
  const q = search ? `?${search.replace(/^\?/, '')}` : '';
  const id = encodeURIComponent(docId);
  return workspaceId
    ? `/workspaces/${encodeURIComponent(workspaceId)}/docs/${id}${q}`
    : `/review/${id}${q}`;
}
