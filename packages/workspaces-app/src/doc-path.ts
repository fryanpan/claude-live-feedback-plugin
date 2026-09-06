/**
 * Where a doc lives in the URL, in one place.
 *
 * A doc is addressed at `/workspaces/<workspaceId>/docs/<docId>` — the same
 * shape as every other resource, so a reader can tell from the address which
 * workspace they are in. `/review/<docId>` was the address it used to have
 * and is DELETED — not redirected, and not parsed either: a stale bookmark
 * addresses no doc, which is the same answer the router gives any other path
 * that names none. Recognising it here would be the dual-address the cutover
 * exists to remove.
 *
 * Four call sites parsed the old path with their own regex (router, voice
 * dock, diff nav, and the click interceptor) and four more built it by hand.
 * Eight spellings of one rule is how half of them get missed; this module is
 * the rule.
 */

const DOC_PATH = /\/workspaces\/[^/?#]+\/docs\/([^/?#]+)/;
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
  const m = p.match(DOC_PATH);
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
 * Every page this bundle serves is under `/workspaces/<id>/…`, so a null
 * here means the path is not one of ours. Reading the board from the URL
 * matters for share visitors: `backTo` on a doc read is owner-only (a
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

/**
 * The address to link a doc at.
 *
 * `workspaceId` is not optional in practice — a doc has no address without a
 * board — but the parameter stays nullable because half the callers read it
 * from the page they are on. A null produces `/workspaces//docs/<id>`, which
 * 404s loudly at the first click, and that is the intended failure: the
 * alternative was `/review/<id>`, a second address that looked like it worked
 * and quietly kept the old shape alive in every link the board rendered.
 */
export function docHref(docId: string, workspaceId: string | null, search = ''): string {
  const q = search ? `?${search.replace(/^\?/, '')}` : '';
  const id = encodeURIComponent(docId);
  return `/workspaces/${encodeURIComponent(workspaceId ?? '')}/docs/${id}${q}`;
}

/**
 * The board this page is standing on.
 *
 * Read from the URL, which is now the only place it can come from and the
 * only place it needs to: every page this bundle serves is under
 * `/workspaces/<id>/…`. It used to be resolvable from `backTo` on a doc read
 * as well, because `/review/<docId>` named no board — and that address is
 * gone, so there is no longer a page this bundle can boot on without one.
 */
export function currentWorkspaceId(): string | null {
  return workspaceIdFromPath(
    typeof location === 'undefined' ? '' : location.pathname + location.search,
  );
}

/**
 * The address of something under the board — `api('docs/d-1/threads')` →
 * `/workspaces/<ws>/docs/d-1/threads`.
 *
 * ONE builder, for the same reason `docHref` is one builder: seventy-one call
 * sites spelled `/api/docs/${id}/…` by hand, and the cutover's whole premise
 * is that the board is part of every resource address. Seventy-one hand-built
 * prefixes is seventy-one places to forget it, and a forgotten one is a 404
 * that looks like a missing feature.
 *
 * `workspaceId` defaults to the board in the URL. Pass it explicitly wherever
 * the caller is acting on a DIFFERENT board than the page is on — the board
 * list, and the sidebar's links into other boards.
 *
 * Returns a path that cannot resolve when no board is known, rather than
 * silently dropping the segment: `/workspaces//docs/d-1` answers 404 at the
 * router's own parser (an empty workspace segment is not a match), which is a
 * loud failure on a page that should never have rendered rather than a
 * request that quietly reaches the wrong board.
 */
export function api(sub: string, workspaceId?: string | null): string {
  const ws = workspaceId === undefined ? currentWorkspaceId() : workspaceId;
  return `/workspaces/${encodeURIComponent(ws ?? '')}/${sub}`;
}

/**
 * The live-editing socket for a doc — `/workspaces/<ws>/docs/<id>/y`.
 *
 * It was `/y/<docId>`: a doc id in the first segment of a path that named no
 * board, which is exactly why it was the one socket on the server that no
 * board rule could be applied to. Three call sites built that string by hand
 * (the doc app, the board's markdown mount, and the redline surface); this is
 * the one builder, for the reason `api` above is one builder.
 *
 * `origin` is passed rather than read so the caller's injected `location`
 * (tests boot against a fake one) decides the host, and `workspaceId`
 * defaults to the board in the URL — the same fallback `api` makes, and the
 * same loud 404 when there is none.
 */
export function docSocketUrl(
  origin: { protocol: string; host: string },
  docId: string,
  type: string,
  workspaceId?: string | null,
): string {
  const ws = workspaceId === undefined ? currentWorkspaceId() : workspaceId;
  const proto = origin.protocol === 'https:' ? 'wss' : 'ws';
  return (
    `${proto}://${origin.host}/workspaces/${encodeURIComponent(ws ?? '')}` +
    `/docs/${encodeURIComponent(docId)}/y?type=${encodeURIComponent(type)}`
  );
}

/**
 * The BOARD's own room — `/workspaces/<ws>/y`.
 *
 * A separate builder rather than `docSocketUrl('ws:<id>', …)` because the
 * board doc's address is not under `docs/`: the doc is still keyed `ws:<id>`
 * in the store, but the board is the resource and the socket is a verb on it.
 * Spelling it as a doc would have put the board id back inside an id.
 */
export function boardSocketUrl(
  origin: { protocol: string; host: string },
  workspaceId: string,
): string {
  const proto = origin.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${origin.host}/workspaces/${encodeURIComponent(workspaceId)}/y?type=workspace`;
}
