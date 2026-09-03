import { type User, cssColor, escapeHtml as escape } from '@feedback/core';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * Workspace sign-in — the popup-token handshake, and the POST that carries
 * the token.
 *
 * Split out of `widget.ts` unchanged: every verb here was a private method on
 * the custom element and is now a function taking that element first, so the
 * element is still the only thing holding the state. The type import above is
 * erased (`verbatimModuleSyntax`), so at runtime this file is a leaf and
 * nothing imports the file that imports it.
 */

/** localStorage keys for the popup-token handshake. Always under `cfw:` —
 *  the token belongs to the widget even when identityScope is 'host'.
 *  Host-page storage is readable by every script on that origin, which is
 *  why the handshake is a dev-server-only opt-in — see `authOffer`. */
const AUTH_TOKEN_KEY = 'cfw:authToken';
const AUTH_USER_KEY = 'cfw:authUser';

/**
 * `true` when a 401 is the workspace saying "sign in first" rather than
 * "your token is dead". Read off a CLONE so the caller still gets an
 * unconsumed response, and false for anything unparseable — an unreadable
 * body must not turn a dead token into a sign-in prompt.
 */
async function isSignInRequired(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return body?.error === 'sign_in_required';
  } catch {
    return false;
  }
}

export function httpBase(el: FeedbackWidgetEl): string {
  return el.opts.serverUrl.replace(/^ws/, 'http');
}

/** The one origin the message listener will take a token from. */
function serverOrigin(el: FeedbackWidgetEl): string {
  return new URL(httpBase(el)).origin;
}

/**
 * The cheap question on load: does this workspace refuse unsigned writes?
 * One GET, no token, and a route that fails or is missing (an older
 * server) reads as "open" — the 401 on the first write remains the
 * backstop, so a wrong "open" costs one refused post, never a comment.
 */
export async function askIfSignInRequired(el: FeedbackWidgetEl): Promise<void> {
  try {
    const res = await fetch(`${httpBase(el)}/api/auth/session`);
    // The route is never gated and always 200s; anything else here is a
    // proxy page, which is not JSON and lands in the catch.
    const body = (await res.json()) as { signInToWrite?: unknown };
    if (body.signInToWrite === true) requireSignIn(el);
  } catch {}
}

/**
 * The workspace needs a signed-in writer. Adopt the token a previous visit
 * left in storage (validated before it is trusted with a post — a dead one
 * clears and the offer returns), and put the offer in the panel. A plain
 * embed on an OPEN workspace never reaches here, so it still adopts
 * nothing and shows nothing — see WidgetOpts.authOffer.
 */
function requireSignIn(el: FeedbackWidgetEl): void {
  if (el.signInToWrite) return;
  el.signInToWrite = true;
  if (!el.opts.authOffer) {
    loadStoredAuth(el);
    void validateStoredAuth(el);
  }
  updateAuthUi(el);
  el.scheduleRender();
}

export function loadStoredAuth(el: FeedbackWidgetEl): void {
  try {
    el.authToken = localStorage.getItem(AUTH_TOKEN_KEY);
    const raw = localStorage.getItem(AUTH_USER_KEY);
    el.authUser = raw ? (JSON.parse(raw) as User) : null;
  } catch {
    el.authToken = null;
    el.authUser = null;
  }
  if (el.authUser) el.user = el.authUser;
}

/**
 * Ask the server whether the stored token still stands. The server 401s a
 * dead one (revoked, expired, tampered) — that clears it and the offer
 * returns; it never silently keeps a token the server would refuse.
 */
export async function validateStoredAuth(el: FeedbackWidgetEl): Promise<void> {
  if (!el.authToken) return;
  try {
    const res = await fetch(`${httpBase(el)}/api/auth/widget-session`, {
      headers: { authorization: `Bearer ${el.authToken}` },
    });
    if (!res.ok) {
      clearAuth(el);
      return;
    }
    const body = (await res.json()) as { authenticated: boolean; user?: User };
    if (!body.authenticated || !body.user) {
      clearAuth(el);
      return;
    }
    setAuth(el, el.authToken, body.user);
  } catch {
    // Offline is not signed-out: keep the token, the next post decides.
  }
}

function setAuth(el: FeedbackWidgetEl, token: string, user: User): void {
  el.authToken = token;
  el.authUser = user;
  el.user = user;
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  } catch {}
  updateAuthUi(el);
  el.scheduleRender();
  // The post this sign-in was for. Rebuilt from the composer, so it goes
  // out under the identity the widget now holds, token and name both. A
  // second refusal re-arms it only after an await, so clearing here is safe.
  el.retryAfterSignIn?.();
  el.retryAfterSignIn = null;
}

/** Local only — the workspace session lives on, sign-out there revokes. */
function clearAuth(el: FeedbackWidgetEl): void {
  el.authToken = null;
  el.authUser = null;
  el.user = el.anonUser;
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  } catch {}
  updateAuthUi(el);
  el.scheduleRender();
}

function startSignIn(el: FeedbackWidgetEl): void {
  const url = `${httpBase(el)}/widget-auth?origin=${encodeURIComponent(location.origin)}`;
  el.authPopup = window.open(url, 'cw-widget-auth', 'popup,width=420,height=560');
  if (!el.authMsgHandler) {
    el.authMsgHandler = (ev: MessageEvent) => {
      // Both walls, independently: the token may only arrive FROM the
      // workspace origin, and only from the window this widget opened.
      if (ev.origin !== serverOrigin(el)) return;
      if (!el.authPopup || ev.source !== el.authPopup) return;
      const data = ev.data as { type?: string; token?: string; user?: User } | null;
      if (!data || data.type !== 'cw-widget-auth') return;
      if (typeof data.token !== 'string' || !data.user) return;
      setAuth(el, data.token, data.user);
    };
    window.addEventListener('message', el.authMsgHandler);
  }
}

export function updateAuthUi(el: FeedbackWidgetEl): void {
  const actions = el.shadow.querySelector('.panel-actions') as HTMLElement | null;
  if (!actions) return;
  const me = actions.querySelector('.me') as HTMLElement | null;
  if (!me) return;
  actions.querySelector('.auth-signin')?.remove();
  if (el.user) {
    me.innerHTML = `<span class="swatch" style="background:${cssColor(el.user.color)}"></span>${escape(el.user.name)}`;
  }
  // Sign-in UI exists when this embed opted in, or when it has to.
  if (!el.opts.authOffer && !el.signInToWrite) return;
  if (el.authToken) {
    const out = document.createElement('button');
    out.className = 'auth-signout';
    out.textContent = 'sign out';
    out.addEventListener('click', () => clearAuth(el));
    me.appendChild(out);
  } else {
    const btn = document.createElement('button');
    btn.className = 'auth-signin';
    btn.title = 'Sign in with your workspace session to comment as yourself';
    btn.textContent = 'Sign in';
    btn.addEventListener('click', () => startSignIn(el));
    actions.appendChild(btn);
  }
}

/**
 * POST with the token when one is held. On a 401 the server has refused
 * the token (revoked, expired) — sign out locally and retry once without
 * it, so the comment lands as anonymous rather than vanishing.
 *
 * Takes a BUILDER, not a built request: the body names `el.user` as the
 * claimed author, and the server trusts that claim on the local surface.
 * A retry that re-sent the request built before `clearAuth()` would carry
 * the revoked person's name without their token — exactly the attribution
 * the 401 just refused. Rebuilding after the sign-out sends the anonymous
 * identity the widget now actually holds.
 */
export async function authedPost(
  el: FeedbackWidgetEl,
  url: string,
  build: () => RequestInit,
): Promise<Response> {
  const send = (): Promise<Response> => {
    const init = build();
    if (!el.authToken) return fetch(url, init);
    return fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        authorization: `Bearer ${el.authToken}`,
      },
    });
  };
  const res = await send();
  if (res.status !== 401) return res;
  // TWO different 401s, and the old code could only see one of them.
  //
  // `sign_in_required` is the workspace refusing an UNSIGNED write
  // (server/src/middleware/write-gate.ts). Clearing a token we do not hold
  // and retrying anonymously produces the identical refusal, forever, and
  // every caller here ignores the response — so the comment simply
  // vanished, which is the exact failure the gate exists to replace.
  if (await isSignInRequired(res)) {
    requireSignIn(el);
    return res;
  }
  // Anything else with a token is the token being refused (revoked,
  // expired): sign out locally and retry once so the comment lands as
  // anonymous rather than vanishing. Rebuilt after `clearAuth`, so the
  // retry carries the identity the widget now actually holds.
  if (!el.authToken) return res;
  clearAuth(el);
  return send();
}

/**
 * Say, inside the composer and beside the draft it blocks, that posting
 * needs a signed-in person — and arm the retry, so signing in finishes the
 * post rather than asking for a second click.
 *
 * ALWAYS a control the person clicks — never an automatic `window.open`.
 * After a refusal this runs past an awaited request and a parsed body, by
 * which point the submit click's transient activation has expired, so a
 * popup opened here is exactly what a popup blocker exists to stop. The
 * click on this control carries its own activation.
 *
 * The retry checks the composer is still on the page: a draft cancelled
 * while the popup was open must not be posted by the token arriving.
 */
export function composerSignIn(
  el: FeedbackWidgetEl,
  composer: HTMLElement,
  submit: HTMLButtonElement,
): void {
  // No `type="button"` on any widget control: nothing in the shadow root
  // is a form, so the default cannot submit — and each one shipped bytes.
  const btn = document.createElement('button');
  btn.className = 'auth-signin';
  btn.textContent = 'Sign in';
  btn.addEventListener('click', () => startSignIn(el));
  composerNote(composer, 'Sign in to post. Your draft is kept. ').appendChild(btn);
  el.retryAfterSignIn = () => {
    if (composer.isConnected) submit.click();
  };
}

/** The composer's one line of news, created on first use. */
export function composerNote(composer: HTMLElement, text: string): HTMLElement {
  let err = composer.querySelector('.composer-err') as HTMLElement | null;
  if (!err) {
    err = document.createElement('div');
    err.className = 'composer-err';
    composer.appendChild(err);
  }
  err.textContent = text;
  return err;
}
