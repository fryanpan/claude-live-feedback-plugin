/**
 * Paging, filtering and the compact row for `GET /api/docs`.
 *
 * Measured 2026-09-01 on the live server: the unscoped listing answered
 * 7,420,585 bytes for 5,919 docs — about 1.25 KB a row, and none of it a
 * body. The weight is metadata replicated onto every member of a bind
 * (`workspaceGroups`, `workspaceRoot`, `diffGroupDetails`), plus one
 * `sourceUrl` and one `reviewUrl` per row, times a corpus that is mostly
 * diff-review members nobody will open again. A fresh session's first tool
 * call was that whole payload, pretty-printed by the MCP child on the way
 * through.
 *
 * Two things fix that, and both live here so the route stays a transcription:
 *
 *   • A PAGE. `?limit=` switches the route into paged mode: rows sorted by
 *     most recent activity, `limit` of them, and an opaque `nextCursor` the
 *     caller hands back to continue. The cursor is keyset (the last row's
 *     sort key), not an offset, so a doc that changes rank between pages
 *     cannot make another row appear twice or vanish — a walk covers the set
 *     as it stood when each page was cut.
 *
 *   • A COMPACT ROW. In paged mode each row is the handful of fields a
 *     caller identifies a doc by — id, title, kind, source path, the review
 *     and board it sits under, timestamps, thread counts and its URL — and
 *     nothing replicated from its bind. `?full=1` restores the whole meta for
 *     that page, which is how the old dump stays reachable on purpose rather
 *     than by default.
 *
 * Without `?limit=` the route answers exactly as it always has (every
 * matching row, full meta, `{ docs }`), because REST callers exist that this
 * change cannot restart. The filters below apply in both modes.
 */
import type { DocMeta } from '@feedback/core';
import { attachmentIdOf } from '@feedback/core';

/** The page size when a paged caller names none. */
export const DEFAULT_PAGE_LIMIT = 50;
/** The largest page a caller may ask for. A whole-corpus read walks pages. */
export const MAX_PAGE_LIMIT = 500;

export interface ListDocsQuery {
  workspaceId?: string;
  setId?: string;
  /** `DocMeta.type`, spelled `kind` on the wire because that is the word a
   *  caller reaches for; `type` is accepted as an alias. */
  kind?: string;
  /** Case-insensitive substring over title, docId, alias, relPath and
   *  sourceUrl — "the doc for this file" in one call. */
  query?: string;
  /** `sourceUrl` or `relPath` starts with this. */
  sourcePrefix?: string;
  /** Present → paged mode. Already clamped to [1, MAX_PAGE_LIMIT]. */
  limit?: number;
  cursor?: string;
  /** Paged mode only: whole meta per row instead of the compact row. */
  full: boolean;
}

/** The row a paged listing answers with. Every field is one a caller can
 *  filter, open or rank by; nothing here is replicated bind configuration. */
export interface CompactDocRow {
  docId: string;
  alias?: string;
  type: DocMeta['type'];
  title?: string;
  sourceUrl?: string;
  relPath?: string;
  /** The review (folder bind / diff review) this doc is a member of. */
  setId?: string;
  /** The board the doc is addressed under — the one in `reviewUrl`. */
  boardId?: string;
  createdAt: number;
  lastActivityAt?: number;
  threads: { open: number; total: number };
  reviewUrl?: string;
  stale?: boolean;
  huddle?: boolean;
}

function truthy(v: string | null): boolean {
  return v !== null && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

/** Read the listing's query string. Unknown or malformed values fall back
 *  rather than fail: a bad `limit` is the default, a bad `cursor` is page one. */
export function parseListDocsQuery(params: URLSearchParams): ListDocsQuery {
  const str = (k: string): string | undefined => {
    const v = params.get(k);
    return v && v.length > 0 ? v : undefined;
  };
  const rawLimit = params.get('limit');
  let limit: number | undefined;
  if (rawLimit !== null) {
    const n = Number.parseInt(rawLimit, 10);
    limit = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT;
  }
  // A cursor alone is a paged request too — it is a continuation of one.
  if (limit === undefined && str('cursor')) limit = DEFAULT_PAGE_LIMIT;
  return {
    workspaceId: str('workspaceId'),
    setId: str('setId'),
    kind: str('kind') ?? str('type'),
    query: str('query'),
    sourcePrefix: str('sourcePrefix'),
    limit,
    cursor: str('cursor'),
    full: truthy(params.get('full')),
  };
}

/** The filters that apply in both modes. `workspaceId` and `setId` are the
 *  route's own (they need the board index), so they are not here. */
export function matchesDocFilters(meta: DocMeta, q: ListDocsQuery): boolean {
  if (q.kind && meta.type !== q.kind) return false;
  if (q.sourcePrefix) {
    const hit =
      (meta.sourceUrl?.startsWith(q.sourcePrefix) ?? false) ||
      (meta.relPath?.startsWith(q.sourcePrefix) ?? false);
    if (!hit) return false;
  }
  if (q.query) {
    const needle = q.query.toLowerCase();
    const hay = [meta.title, meta.docId, meta.alias, meta.relPath, meta.sourceUrl];
    if (!hay.some((s) => s?.toLowerCase().includes(needle))) return false;
  }
  return true;
}

/** What a row is ranked by: its last activity, or its creation when nothing
 *  has happened since. */
export function activityOf(meta: Pick<DocMeta, 'lastActivityAt' | 'createdAt'>): number {
  return meta.lastActivityAt ?? meta.createdAt ?? 0;
}

/** Most recent first; ties broken by docId so the order is total, which a
 *  keyset cursor needs. */
export function compareByActivity(a: DocMeta, b: DocMeta): number {
  const d = activityOf(b) - activityOf(a);
  if (d !== 0) return d;
  return a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0;
}

interface CursorKey {
  t: number;
  d: string;
}

export function encodeCursor(meta: DocMeta): string {
  const key: CursorKey = { t: activityOf(meta), d: meta.docId };
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Null for anything that is not a cursor this module minted — the caller
 *  starts from page one rather than failing the listing. */
export function decodeCursor(cursor: string | undefined): CursorKey | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as CursorKey).t === 'number' &&
      typeof (parsed as CursorKey).d === 'string'
    ) {
      return { t: (parsed as CursorKey).t, d: (parsed as CursorKey).d };
    }
  } catch {
    // fall through
  }
  return null;
}

/** True when `meta` sorts strictly AFTER the cursor's row. */
function afterCursor(meta: DocMeta, key: CursorKey): boolean {
  const t = activityOf(meta);
  if (t !== key.t) return t < key.t;
  return meta.docId > key.d;
}

export interface DocPage<T> {
  docs: T[];
  /** Rows matching the filters, across every page. */
  total: number;
  limit: number;
  /** Hand this back as `?cursor=` for the next page; null on the last one. */
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Cut one page out of the filtered rows. `project` turns each DocMeta into
 * the row shape the caller asked for — compact or full — and runs only on
 * the rows that ship, so a decorated URL is minted `limit` times, not once
 * per doc on the server.
 */
export function pageDocs<T>(
  rows: DocMeta[],
  q: { limit: number; cursor?: string },
  project: (meta: DocMeta) => T,
): DocPage<T> {
  const sorted = [...rows].sort(compareByActivity);
  const key = decodeCursor(q.cursor);
  const from = key ? sorted.filter((m) => afterCursor(m, key)) : sorted;
  const slice = from.slice(0, q.limit);
  const hasMore = from.length > slice.length;
  const last = slice.at(-1);
  return {
    docs: slice.map(project),
    total: sorted.length,
    limit: q.limit,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    hasMore,
  };
}

/** The compact row, from a decorated meta and the counts the caller looked up. */
export function compactDocRow(
  meta: DocMeta & { reviewUrl?: string },
  extras: { boardId: string | null; threads: { open: number; total: number } },
): CompactDocRow {
  const row: CompactDocRow = {
    docId: meta.docId,
    type: meta.type,
    createdAt: meta.createdAt,
    threads: extras.threads,
  };
  // Optional keys are omitted rather than sent as null: on a 50-row page
  // the absent ones are most of the keys, and a key that is not there costs
  // nothing.
  if (meta.alias !== undefined) row.alias = meta.alias;
  if (meta.title !== undefined) row.title = meta.title;
  if (meta.sourceUrl !== undefined) row.sourceUrl = meta.sourceUrl;
  if (meta.relPath !== undefined) row.relPath = meta.relPath;
  const setId = attachmentIdOf(meta);
  if (setId !== undefined) row.setId = setId;
  if (extras.boardId) row.boardId = extras.boardId;
  if (meta.lastActivityAt !== undefined) row.lastActivityAt = meta.lastActivityAt;
  if (meta.reviewUrl !== undefined) row.reviewUrl = meta.reviewUrl;
  if (meta.stale) row.stale = true;
  if (meta.huddle) row.huddle = true;
  return row;
}
