/**
 * Attach-time widget injection for bound mockups.
 *
 * The widget used to be something an agent typed into the page it was about
 * to hand over. That worked until the page was a file git tracks: a benchmark
 * harness bound for a public remote was measured shipping
 * `<claude-feedback-widget … user="…">`, a real reviewer's name in it, inside a
 * committed HTML template,
 * and its report generator then hard-failed when the tag was absent — review
 * scaffolding had become a build dependency, and a reviewer's name had become
 * public record.
 *
 * So the server puts it in instead. `bind_mock` already reads the file on
 * every request; adding the embed on the way out means the page on disk never
 * has to carry it, which is the only version of "don't commit the widget" that
 * does not depend on an agent remembering. The source file renders bare
 * everywhere else — in a browser, in CI, in whatever the generator writes.
 *
 * `observe_url` gets no equivalent and cannot: it hands back an SSE URL for a
 * dev server this process never proxies, so there are no bytes here to rewrite.
 * A dev server still embeds the widget by hand — in a file its build ignores.
 */

/**
 * Marks that mean the page already embeds the widget itself. A page that opted
 * in explicitly keeps its own embed: it may be passing `view`, a `server-url`,
 * or calling `FeedbackWidget.init` with derived options, and a second copy
 * bolted on underneath would fight it for the same `docId`.
 */
const ALREADY_EMBEDDED = /claude-feedback-widget|widget\.iife\.js|FeedbackWidget\s*\.\s*init/i;

/** Last `</body>`, case-insensitive — the insertion point when there is one. */
const BODY_CLOSE = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i;

const escapeAttr = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The embed itself. No `user` attribute on purpose — the widget resolves the
 * reviewer from the browser it is running in (`resolveUser` in
 * `@feedback/core/identity`), so a name baked into markup does not identify
 * the reader, it RE-BRANDS them: whoever opens the page is seeded as that
 * person in a fresh browser. A shared review URL makes that everyone.
 *
 * `server-url` is omitted for the same class of reason — the widget defaults
 * its socket to the origin the bundle came from, which is this server however
 * the reader reached it (loopback, tailnet, LAN, tunnel). A literal host would
 * be wrong for every reader who arrived by a different route.
 */
export function widgetEmbed(docId: string): string {
  return `<claude-feedback-widget doc-id="${escapeAttr(docId)}"></claude-feedback-widget><script src="/widget.iife.js"></script>`;
}

/**
 * Return `html` with the widget embed added, or unchanged when the page
 * already carries one. Appends when there is no `</body>` — a fragment or a
 * hand-written page without one is still a page a reviewer wants to comment on.
 */
export function injectWidget(html: string, docId: string): string {
  if (ALREADY_EMBEDDED.test(html)) return html;
  const embed = widgetEmbed(docId);
  if (BODY_CLOSE.test(html)) return html.replace(BODY_CLOSE, `${embed}$&`);
  return `${html}${embed}`;
}
