/**
 * The browser half of Sentry: what every served shell has to carry so that a
 * page load shows up as a trace, tagged with WHICH KIND of page it was.
 *
 * ## Why a page type at all
 *
 * Asked on 2026-08-29: "I want to understand the load time for each page
 * (home page, doc, mockup, board) and see if there are issues sometimes."
 * Only the board could answer. There was exactly one browser Sentry init, in
 * `hub-app.ts`, reading a meta tag only `renderHubShell` emitted — so every
 * transaction Sentry held was a `/workspaces/...` path and every other
 * surface was silent. "Docs load fine" was not a finding anyone had made; it
 * was a question nobody could ask.
 *
 * Instrumenting the other three shells is only half of it. Their URLs carry
 * ids, so grouping by URL would neither compare across kinds nor be safe to
 * send — see `routePatternForSpan` and the scrub floor in
 * `@feedback/core/trace-privacy`. The `page_type` tag is what makes the
 * comparison a GROUP BY rather than a path-prefix guess: four values, one
 * median and p95 each, side by side.
 *
 * ## Why a separate script rather than an import in each app
 *
 * `/app/sentry.js` is its own build entry, loaded by a `<script type=
 * "module">` that a shell emits ONLY when a DSN is configured. Three reasons
 * it is not an `import()` inside app.js / hub.js / the widget:
 *
 * - `app.ts` and the widget build with `splitting: false`, so a dynamic
 *   `import('@sentry/browser')` inside either is INLINED into the entry —
 *   the SDK would ship in the bundle every doc load and every mockup fetches,
 *   configured or not. The widget bundle size is a hard project constraint.
 * - A page with no DSN then has no script tag at all, which is a stronger
 *   version of the "no DSN, no SDK, no outbound request" contract than a
 *   runtime `if`: there is nothing to fetch and nothing to run.
 * - The mockup surface is somebody else's HTML with the widget injected into
 *   it. It has no bundle of ours to put an import inside.
 *
 * The DSN itself is box config (`CW_SENTRY_DSN`), never the repo.
 */

/**
 * The kinds of page whose load times are compared. One value per surface a
 * human opens, not per route: `/workspaces/<id>/home`, `/tasks` and `/mine`
 * are all the board.
 */
export type PageType = 'board' | 'doc' | 'mockup' | 'landing' | 'signin';

export interface BrowserSentryConfig {
  /** `CW_SENTRY_DSN`. Absent config is `null`, not an empty string. */
  dsn: string;
  /**
   * What the browser bundle should call this deploy. The same string the
   * server stamps on its own events (`bin.ts` → `initServerSentry`), which is
   * `git describe`-derived provenance from the published release — so a
   * regression can be attributed to the deploy it arrived with, and a
   * browser trace and the server span it continues agree on the release.
   *
   * Deliberately NOT the client build id, which is a content hash of the
   * built assets: it tells you the bundle changed, never which commit it
   * came from. The build id is still sent, as a `build_id` TAG.
   */
  release?: string | null;
}

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The head tags a shell needs, or `''` when Sentry is unconfigured.
 *
 * The meta tags are how server config reaches a bundle that the server does
 * not template — `/app/sentry.js` is a static file, identical on every box.
 */
export function sentryHeadTags(cfg: BrowserSentryConfig | null, pageType: PageType): string {
  if (!cfg?.dsn) return '';
  const release = cfg.release?.trim();
  return [
    `<meta name="sentry-dsn" content="${escapeAttr(cfg.dsn)}" />`,
    `<meta name="sentry-page-type" content="${escapeAttr(pageType)}" />`,
    ...(release ? [`<meta name="sentry-release" content="${escapeAttr(release)}" />`] : []),
    '<script type="module" src="/app/sentry.js"></script>',
  ].join('\n    ');
}

/** `</head>`, `<head …>`, and a leading doctype — the three insertion points
 *  below, in the order they are tried. */
const HEAD_CLOSE = /<\/head\s*>/i;
const HEAD_OPEN = /<head(\s[^>]*)?>/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/**
 * Add the tags to an HTML document that this server did not template — the
 * built `index.html` every doc page is served from, and a mockup's own file.
 *
 * A mockup is somebody's hand-written page and may have no `<head>` at all,
 * so the insertion point degrades: before `</head>`, else just after
 * `<head …>`, else after the doctype (prepending BEFORE a doctype would put
 * the browser in quirks mode and change how the page they are reviewing
 * renders), else at the very start. Returns `html` untouched when Sentry is
 * unconfigured — the no-DSN path adds no bytes and no requests.
 */
export function injectSentryHead(
  html: string,
  cfg: BrowserSentryConfig | null,
  pageType: PageType,
): string {
  const tags = sentryHeadTags(cfg, pageType);
  if (!tags) return html;
  const block = `\n    ${tags}\n  `;
  if (HEAD_CLOSE.test(html)) return html.replace(HEAD_CLOSE, (m) => `${block}${m}`);
  if (HEAD_OPEN.test(html)) return html.replace(HEAD_OPEN, (m) => `${m}${block}`);
  const doctype = DOCTYPE.exec(html);
  if (doctype) return `${doctype[0]}${block}${html.slice(doctype[0].length)}`;
  return `${block}${html}`;
}
