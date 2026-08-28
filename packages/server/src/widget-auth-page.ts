/**
 * The widget sign-in popup — the one page in the popup-token handshake.
 *
 * The widget (on a dev server's origin) opens this page ON the workspace
 * origin, so the `cw_session` cookie flows: `window.open` is a top-level
 * navigation, which SameSite=Lax permits. The page exchanges that session
 * for a widget token (`POST /api/auth/widget-token`) and hands the token to
 * `window.opener` via postMessage — targeted at the SERVER-VALIDATED origin
 * the response echoes back, never `*`, so the browser refuses delivery to
 * anything but the embedding page the server approved.
 *
 * Served with `X-Frame-Options: DENY` (see the route): inside an iframe the
 * handshake would run with no visible popup, which is exactly the silent
 * mint this flow must not allow.
 */

export function widgetAuthPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to comment</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f6f7f9; color: #1c2733; }
  main { max-width: 320px; padding: 32px; text-align: center; }
  a { color: #2e7dd7; }
</style>
</head>
<body>
<main>
  <p id="status">Signing in…</p>
</main>
<script>
(async () => {
  const status = document.getElementById('status');
  const say = (html) => { status.innerHTML = html; };
  const origin = new URLSearchParams(location.search).get('origin') || '';
  if (!window.opener) {
    say('This page is opened by the feedback widget\\u2019s \\u201cSign in\\u201d button \\u2014 it does nothing on its own.');
    return;
  }
  try {
    const res = await fetch('/api/auth/widget-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === 'not_signed_in' || body.error === 'session_needs_refresh') {
        say('Sign in to the workspace first, then tap the widget\\u2019s sign-in button again. <br><a href="/" target="_blank" rel="opener">Open the workspace</a>');
      } else if (body.error === 'origin_not_allowed') {
        say('This page\\u2019s origin is not one the workspace server trusts, so it cannot receive a sign-in.');
      } else {
        say('Could not sign the widget in. Close this window and try again.');
      }
      return;
    }
    // body.origin is the server-validated recipient. The browser enforces
    // that only a window on that exact origin receives the message.
    window.opener.postMessage({ type: 'cw-widget-auth', token: body.token, user: body.user }, body.origin);
    say('Signed in \\u2014 you can close this window.');
    window.close();
  } catch {
    say('Could not reach the workspace server. Close this window and try again.');
  }
})();
</script>
</body>
</html>
`;
}
