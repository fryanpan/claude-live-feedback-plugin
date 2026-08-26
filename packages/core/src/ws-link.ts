/**
 * Which URLs count as "workspace links", in one place.
 *
 * A pasted address for a board, task, doc, mockup, or review should render as
 * the resource's TITLE wherever comments are shown — so both halves of that
 * feature (the client renderer that marks the link, the server route that
 * resolves the title) must agree on what shapes qualify. This module is the
 * agreement; each half interpreting the URL with its own regex is how the two
 * drift apart.
 *
 * Host-agnostic on purpose: the same server is reached as `localhost`, a
 * tailnet name, and a LAN IP, and a URL pasted under one host is read under
 * another (`toSameOriginPath` in the router exists for exactly this). A
 * foreign URL that happens to match a shape resolves to no title and falls
 * back to its raw text, so the permissiveness costs nothing.
 *
 * Path shapes mirror `doc-path.ts` (client) and the canonical block in
 * `server.ts`: `/workspaces/<ws>[/docs|mockups|reviews/<id>]`, the legacy
 * `/review/<id>` and `/mockup/<id>`, and the board's `?task=<id>` deep link.
 */

export type WorkspaceLink =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'task'; workspaceId: string; taskId: string }
  | { kind: 'doc'; workspaceId: string | null; docId: string }
  | { kind: 'mockup'; workspaceId: string | null; docId: string }
  | { kind: 'review'; workspaceId: string; reviewId: string };

const WS_PATH = /^\/workspaces\/([^/?#]+)\/?$/;
const WS_CHILD_PATH = /^\/workspaces\/([^/?#]+)\/(docs|mockups|reviews)\/([^/?#]+)\/?$/;
const LEGACY_PATH = /^\/(review|mockup)\/([^/?#]+)\/?$/;

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Parse a URL (absolute http/https, or a root-relative path) into the
 * workspace resource it addresses, or null when it addresses none.
 */
export function parseWorkspaceLink(urlOrPath: string): WorkspaceLink | null {
  const trimmed = urlOrPath.trim();
  if (!trimmed) return null;
  // Only http(s) absolute URLs and root-relative paths can be workspace
  // links; every other scheme (mailto:, javascript:, …) is not ours.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null;
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('/')) return null;
  let u: URL;
  try {
    u = new URL(trimmed, 'http://placeholder.invalid');
  } catch {
    return null;
  }

  const ws = u.pathname.match(WS_PATH);
  if (ws?.[1]) {
    const workspaceId = decode(ws[1]);
    const taskId = u.searchParams.get('task');
    return taskId ? { kind: 'task', workspaceId, taskId } : { kind: 'workspace', workspaceId };
  }

  const child = u.pathname.match(WS_CHILD_PATH);
  if (child?.[1] && child[2] && child[3]) {
    const workspaceId = decode(child[1]);
    const id = decode(child[3]);
    if (child[2] === 'docs') return { kind: 'doc', workspaceId, docId: id };
    if (child[2] === 'mockups') return { kind: 'mockup', workspaceId, docId: id };
    return { kind: 'review', workspaceId, reviewId: id };
  }

  const legacy = u.pathname.match(LEGACY_PATH);
  if (legacy?.[1] && legacy[2]) {
    const id = decode(legacy[2]);
    return legacy[1] === 'review'
      ? { kind: 'doc', workspaceId: null, docId: id }
      : { kind: 'mockup', workspaceId: null, docId: id };
  }

  return null;
}
