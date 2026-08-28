/**
 * Resolve pasted workspace URLs to display titles and status chips — the
 * async half of the "a raw link reads as its title" feature.
 *
 * The renderer (`comment-markdown.ts`) stays synchronous: it emits an anchor
 * whose visible text is the raw URL (or the author's own label, marked
 * `data-ws-custom`), marked `data-ws-link` (+ `data-ws-pending` until
 * resolved), and calls `scheduleLinkTitleHydration`. A beat later this module
 * gathers every pending anchor in the document into route-sized
 * `POST /api/links/titles` batches, caches the answers, swaps each bare
 * anchor's TEXT for its title, and appends a status chip when the target is a
 * task or goal (a custom label keeps its words and still gets the chip). The
 * href — and the stored comment — keep the raw URL: conversion is
 * display-only, so it stays correct when a title changes and never rewrites
 * user content.
 *
 * Failure is always the raw URL: an unknown id caches as null and renders as
 * itself; a failed lookup leaves the anchors pending, so a later render
 * retries. Nothing here ever throws into a render path.
 */

/** What one URL resolved to. `status` is null when the target is not a
 *  task/goal — the "no chip" answer, distinct from "never asked". */
interface LinkInfo {
  title: string | null;
  status: string | null;
}

const cache = new Map<string, LinkInfo>();

/** The cached title for a URL: a string when known, null when the server said
 *  "not resolvable", undefined when never asked. */
export function cachedLinkTitle(url: string): string | null | undefined {
  return cache.has(url) ? (cache.get(url)?.title ?? null) : undefined;
}

/** The cached status for a URL — same undefined/null contract as the title. */
export function cachedLinkStatus(url: string): string | null | undefined {
  return cache.has(url) ? (cache.get(url)?.status ?? null) : undefined;
}

/** Seed the cache (tests, or a caller that already holds the answer). */
export function primeLinkTitle(
  url: string,
  title: string | null,
  status: string | null = null,
): void {
  cache.set(url, { title, status });
}

export function _resetLinkTitlesForTest(): void {
  cache.clear();
}

/** Chip words, mirroring hub-model's STATUS_LABEL — copied rather than
 *  imported so the doc page's renderer does not pull the hub module in.
 *  An unknown status renders as its raw string: not nice, but TRUE. */
const STATUS_CHIP_LABEL: Record<string, string> = {
  triage: 'Triage',
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done',
};

export function statusChipLabel(status: string): string {
  return STATUS_CHIP_LABEL[status] ?? status;
}

function statusChipEl(status: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = `ws-status-chip ws-chip-${status}`;
  chip.textContent = statusChipLabel(status);
  return chip;
}

/** How many URLs one lookup carries — mirrors the route's own cap. */
const BATCH_LIMIT = 100;

/**
 * Resolve every pending workspace link under `root` and write titles into the
 * DOM. Batched: one request per call, however many anchors. Safe to call with
 * nothing pending (no request is made).
 */
/** The one slice of `fetch` the lookup uses — narrow so tests stub it flat. */
export type LinkTitleFetcher = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Ask the server about `urls` (uncached ones only) and fill the cache.
 * Returns whether anything new landed. Shared by the DOM hydration below and
 * the doc editor's chip decorations (`task-link-chips.ts`), which has no
 * `data-ws-link` anchors to walk.
 */
export async function fetchLinkInfos(
  urls: readonly string[],
  fetcher: LinkTitleFetcher = fetch,
): Promise<boolean> {
  const wanted = [...new Set(urls.filter((u) => u && !cache.has(u)))];
  let landed = false;
  // Every uncached URL gets asked, one route-sized batch at a time — a page
  // with more links than one batch must not leave the tail raw forever.
  for (let i = 0; i < wanted.length; i += BATCH_LIMIT) {
    const chunk = wanted.slice(i, i + BATCH_LIMIT);
    try {
      const res = await fetcher('/api/links/titles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls: chunk }),
      });
      if (!res.ok) break; // leave the rest pending — a later render retries
      const data = (await res.json()) as {
        titles?: Record<string, string | null>;
        statuses?: Record<string, string>;
      };
      for (const u of chunk)
        cache.set(u, { title: data.titles?.[u] ?? null, status: data.statuses?.[u] ?? null });
      landed = true;
    } catch {
      break; // network failure: raw URLs stay visible, retry later
    }
  }
  return landed;
}

export async function hydrateLinkTitles(
  root: ParentNode,
  fetcher: LinkTitleFetcher = fetch,
): Promise<void> {
  const anchors = [...root.querySelectorAll<HTMLAnchorElement>('a[data-ws-link][data-ws-pending]')];
  if (anchors.length === 0) return;
  await fetchLinkInfos(
    anchors.map((a) => a.getAttribute('data-ws-link') ?? ''),
    fetcher,
  );
  for (const a of anchors) {
    const url = a.getAttribute('data-ws-link') ?? '';
    const info = cache.get(url);
    if (info === undefined) continue; // not in this batch (over the cap)
    // textContent, never innerHTML — the title is server data, not markup.
    // A custom label (`data-ws-custom`) is the author's text and stays.
    if (info.title && !a.hasAttribute('data-ws-custom')) a.textContent = info.title;
    a.querySelector('.ws-status-chip')?.remove();
    if (info.status) a.append(statusChipEl(info.status));
    a.removeAttribute('data-ws-pending');
  }
}

let scheduled = false;

/**
 * Ask for a document-wide hydration pass on the next macrotask. Called by the
 * renderer whenever it emits a pending link; debounced so a burst of renders
 * (a thread list, a board of cards) costs one request. A macrotask rather
 * than a microtask so the caller's `innerHTML =` assignment has landed.
 */
export function scheduleLinkTitleHydration(): void {
  if (scheduled || typeof document === 'undefined') return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    void hydrateLinkTitles(document);
  }, 0);
}

/**
 * A task somewhere changed status: forget every cached status and mark the
 * chipped anchors pending again, so the next hydration pass re-asks. Wired to
 * the hub's `task.transitioned` SSE event — the chip's freshness rides the
 * same push every other REST-fed region refreshes on. Whole-cache on purpose:
 * the event does not say which URL the row was pasted under, and the refetch
 * is one debounced batch.
 */
export function staleTaskLinkStatuses(root: ParentNode | null = null): void {
  const staleUrls = new Set<string>();
  for (const [url, info] of cache) {
    if (info.status) {
      staleUrls.add(url);
      cache.delete(url);
    }
  }
  if (staleUrls.size === 0) return;
  const scope = root ?? (typeof document === 'undefined' ? null : document);
  if (!scope) return;
  for (const a of scope.querySelectorAll<HTMLAnchorElement>('a[data-ws-link]')) {
    if (staleUrls.has(a.getAttribute('data-ws-link') ?? '')) a.setAttribute('data-ws-pending', '');
  }
  scheduleLinkTitleHydration();
}
