/**
 * The page a share link renders when it does not open.
 *
 * ONE page for every reason. Revoked, expired, never existed, malformed, and
 * "the board behind it is no longer a board" all render this, because four
 * pages would turn the redeem route into an oracle: anyone could walk ids and
 * learn which ones are real from the difference between the answers. The
 * operator sees the real state in `list_shares`, where the question is asked
 * by someone who already holds the record.
 *
 * It names no workspace, no board title and no owner — a visitor who reached
 * a revoked link learns only that it is not usable.
 *
 * Rendered with no bundle, no session and no doc, like `renderLinkNotFound`
 * in the auth-share routes: the caller has no credential and the page has to
 * stand on its own. Kept in its own module rather than beside that one
 * because the gate serves it before any route block runs.
 *
 * It is deliberately a single column with a `max-width` in `rem` and a
 * viewport meta, so the same markup reads at 1180x820 and at 430px without a
 * media query — there is nothing here that could reflow into two columns.
 */
export function renderShareLinkUnavailable(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link revoked · Workspaces</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1c1e;background:#fff;
margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:2rem 1.25rem}
main{max-width:26rem}
h1{font-size:1.375rem;line-height:1.25;margin:0 0 .625rem;font-weight:600}
p{color:#5b5b60;margin:0}
@media(prefers-color-scheme:dark){body{background:#131316;color:#ececf0}p{color:#a0a0a8}}
</style>
<main>
<h1>This link has been revoked</h1>
<p>It may have been revoked or expired. Ask whoever shared it for a new one.</p>
</main></html>`;
}
