/**
 * Resolve pasted workspace URLs to display titles — the async half of the
 * "a raw link reads as its title" feature.
 *
 * The renderer (`comment-markdown.ts`) stays synchronous: it emits an anchor
 * whose visible text is the raw URL, marked `data-ws-link` (+
 * `data-ws-pending` until resolved), and calls `scheduleLinkTitleHydration`.
 * A beat later this module batches every pending anchor in the document into
 * ONE `POST /api/links/titles`, caches the answers, and swaps each anchor's
 * TEXT for its title. The href — and the stored comment — keep the raw URL:
 * conversion is display-only, so it stays correct when a title changes and
 * never rewrites user content.
 *
 * Failure is always the raw URL: an unknown id caches as null and renders as
 * itself; a failed lookup leaves the anchors pending, so a later render
 * retries. Nothing here ever throws into a render path.
 */

const cache = new Map<string, string | null>();

/** The cached title for a URL: a string when known, null when the server said
 *  "not resolvable", undefined when never asked. */
export function cachedLinkTitle(url: string): string | null | undefined {
  return cache.get(url);
}

/** Seed the cache (tests, or a caller that already holds the title). */
export function primeLinkTitle(url: string, title: string | null): void {
  cache.set(url, title);
}

export function _resetLinkTitlesForTest(): void {
  cache.clear();
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

export async function hydrateLinkTitles(
  root: ParentNode,
  fetcher: LinkTitleFetcher = fetch,
): Promise<void> {
  const anchors = [...root.querySelectorAll<HTMLAnchorElement>('a[data-ws-link][data-ws-pending]')];
  if (anchors.length === 0) return;
  const wanted = [
    ...new Set(
      anchors.map((a) => a.getAttribute('data-ws-link') ?? '').filter((u) => u && !cache.has(u)),
    ),
  ].slice(0, BATCH_LIMIT);
  if (wanted.length > 0) {
    try {
      const res = await fetcher('/api/links/titles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls: wanted }),
      });
      if (!res.ok) return; // leave anchors pending — a later render retries
      const data = (await res.json()) as { titles?: Record<string, string | null> };
      for (const u of wanted) cache.set(u, data.titles?.[u] ?? null);
    } catch {
      return; // network failure: raw URLs stay visible, retry later
    }
  }
  for (const a of anchors) {
    const url = a.getAttribute('data-ws-link') ?? '';
    const title = cache.get(url);
    if (title === undefined) continue; // not in this batch (over the cap)
    // textContent, never innerHTML — the title is server data, not markup.
    if (title) a.textContent = title;
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
