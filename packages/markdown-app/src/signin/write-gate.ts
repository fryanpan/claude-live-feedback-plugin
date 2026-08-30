/**
 * What a refused write looks like to the person who made it.
 *
 * The server refuses an unsigned browser write with 401 and
 * `{"error":"sign_in_required"}` (server/src/middleware/write-gate.ts). On its
 * own that is invisible: this app has no shared fetch wrapper, and its
 * twenty-odd write call sites variously throw into a `catch` that shows
 * "Failed — try again", return `false`, or ignore the response entirely. A
 * person whose comment was refused for want of a session would have been told
 * to try again, and trying again would have failed the same way forever.
 *
 * Two halves, and both are needed.
 *
 * **Before** — `applyWriteAccess` asks the server whether this browser may
 * write, and if not says so up front and keeps the doc in view mode. This is
 * the half that matters for prose: doc text goes over the yjs socket, which
 * the server holds open in read-only mode so reading is unaffected, and a
 * person allowed to type into a socket that drops every keystroke has been
 * told nothing at all — the text appears, syncs to nobody, and is gone on
 * reload.
 *
 * **After** — `installWriteGateNotice` wraps `fetch` once and turns any
 * `sign_in_required` refusal into a prompt. One wrapper rather than an edit
 * at each call site, because the question this gate has to answer is "how do
 * you know you covered every write", and a list of call sites is a list that
 * silently stops being complete. It only ever reads the body of a 401 and
 * never changes what the caller receives, so every existing error path still
 * runs exactly as it did.
 */

/** The server's code for "you must sign in first". Contract with
 *  server/src/middleware/write-gate.ts. */
export const SIGN_IN_REQUIRED = 'sign_in_required';

/** Where a refused writer goes, with a way back to where they were. */
export function signInHref(pathname: string, search: string): string {
  return `/signin?next=${encodeURIComponent(pathname + search)}`;
}

/** `true` for the body the server sends with a refused write. Shape-checked
 *  rather than assumed: a 401 from anything else (a dead widget token, a
 *  route with its own auth) must not raise this prompt. */
export function isSignInRequired(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { error?: unknown }).error === SIGN_IN_REQUIRED
  );
}

/** What the server says about this browser's ability to write. */
export interface WriteAccess {
  /** The deployment refuses unsigned browser writes. */
  signInToWrite: boolean;
  /** THIS browser may write. False only when the gate is on and nothing is
   *  proven — a cookie, a Cloudflare Access claim, or a widget token. */
  canWrite: boolean;
}

/**
 * Ask the server. A route that throws, 404s, or answers with junk reads as
 * "may write": an unreachable session route must never lock a person out of
 * a surface the server would have accepted them on.
 */
export async function fetchWriteAccess(): Promise<WriteAccess> {
  try {
    const res = await fetch('/api/auth/session');
    if (!res.ok) return { signInToWrite: false, canWrite: true };
    const body = (await res.json()) as Partial<WriteAccess>;
    return {
      signInToWrite: body.signInToWrite === true,
      canWrite: body.canWrite !== false,
    };
  } catch {
    return { signInToWrite: false, canWrite: true };
  }
}

/**
 * When this browser last did something a person meant.
 *
 * The gate refuses EVERY unsigned write, and the app makes several on its
 * own: the reading tracker posts time-on-page, link titles are resolved, the
 * push subscription is reconciled. Measured on a real load of a gated doc,
 * one of those fired within a second and raised the modal over a document
 * the reader had not touched — a sign-in demand as the first thing they saw,
 * for a write they never made.
 *
 * So the modal is reserved for a refusal that FOLLOWS a gesture. A
 * background POST has none behind it; a person pressing Comment has one
 * milliseconds earlier. Both still get the standing bar, which is the
 * honest answer to "this browser cannot write here" — it just does not
 * interrupt someone who was only reading.
 */
let lastGestureAt = 0;
const GESTURE_WINDOW_MS = 5_000;

function watchGestures(): void {
  if (typeof document === 'undefined') return;
  const mark = () => {
    lastGestureAt = Date.now();
  };
  for (const type of ['pointerdown', 'keydown']) {
    // Capture phase, so a handler that stops propagation cannot hide the
    // gesture from us.
    document.addEventListener(type, mark, { capture: true, passive: true });
  }
}

/** `true` when a refusal can be attributed to something the person just did.
 *  Exported for tests, which have no real input events to fire. */
export function recentGesture(now: number = Date.now()): boolean {
  return lastGestureAt !== 0 && now - lastGestureAt <= GESTURE_WINDOW_MS;
}

/** Test seam: pretend a person just acted. */
export function markGestureForTest(at: number = Date.now()): void {
  lastGestureAt = at;
}

/**
 * The blocking prompt a refused write raises.
 *
 * Blocking on purpose. A toast would be the honest size of the message and
 * the wrong size of the consequence: the person's typed comment is still on
 * screen behind this, and what they need is the one action that makes
 * sending it work.
 */
export function promptSignIn(message?: string): void {
  if (typeof document === 'undefined') return;
  // Keyed on the DOM, never on a module flag. A flag that says "already
  // open" survives the overlay being removed by anything other than its own
  // button — a route change, a re-render — and then the prompt never appears
  // again for the life of the tab, which is the failure this whole file
  // exists to prevent.
  if (document.querySelector('.signin-required')) return;
  const overlay = document.createElement('div');
  // Shares the identity prompt's scrim and card so this needs no layout of
  // its own; `signin-required` carries only what differs.
  overlay.className = 'identity-prompt signin-required';
  const card = document.createElement('div');
  card.className = 'identity-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'signin-required-title');

  const title = document.createElement('h2');
  title.id = 'signin-required-title';
  title.textContent = 'Sign in to write here';
  const body = document.createElement('p');
  // The server's own sentence, set as TEXT — never innerHTML. It is a fixed
  // string today, and a response body is not a place to start trusting
  // markup tomorrow.
  body.textContent = message ?? 'Sign in to comment or edit here. Reading needs no account.';

  const actions = document.createElement('div');
  actions.className = 'identity-actions';
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'identity-skip';
  later.textContent = 'Not now';
  const go = document.createElement('a');
  go.className = 'signin-required-go';
  go.textContent = 'Sign in';
  go.href = signInHref(location.pathname, location.search);

  const close = () => overlay.remove();
  later.addEventListener('click', close);
  overlay.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  });

  actions.append(later, go);
  card.append(title, body, actions);
  overlay.append(card);
  document.body.appendChild(overlay);
  go.focus();
}

/**
 * The standing notice for a browser that already knows it cannot write.
 *
 * Not blocking: this person can read the whole document and every comment on
 * it, which is most of what they came for. The bar says what is missing and
 * how to fix it, and stays out of the way of the reading.
 */
export function showSignInBar(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('.signin-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'signin-bar';
  bar.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = 'You are not signed in — reading only.';
  const link = document.createElement('a');
  link.textContent = 'Sign in to comment or edit';
  link.href = signInHref(location.pathname, location.search);
  bar.append(text, link);
  // The topbar's REAL height. A constant here would be wrong on at least one
  // of the three width tiers, and wrong in the direction that covers the doc
  // title.
  const topbar = document.getElementById('topbar');
  if (topbar) {
    bar.style.setProperty(
      '--signin-bar-top',
      `${Math.round(topbar.getBoundingClientRect().height)}px`,
    );
  }
  document.body.appendChild(bar);
}

/**
 * Ask the server whether this browser may write, and if not, say so and hand
 * the caller the answer so it can lock its own surface (the editor's edit
 * toggle, a composer, a button).
 *
 * Returns `canWrite`, so a caller that does nothing else still reads
 * correctly as a boolean.
 */
export async function applyWriteAccess(): Promise<boolean> {
  const access = await fetchWriteAccess();
  if (access.canWrite) return true;
  showSignInBar();
  return false;
}

let installed = false;

/**
 * Wrap `fetch` once so a refused write raises the prompt wherever it
 * happened.
 *
 * Deliberately transparent: the original response is returned untouched (the
 * body is read off a `clone`), every failure inside the wrapper is swallowed,
 * and a rejected fetch rejects exactly as before. The worst case is that the
 * prompt does not appear — never that a write path breaks because the notice
 * did.
 */
export function installWriteGateNotice(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  watchGestures();
  const original = window.fetch.bind(window);
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await original(input, init);
    // 401 only, so the common path costs one integer comparison and no clone.
    if (res.status === 401) {
      try {
        const body = (await res.clone().json()) as unknown;
        if (isSignInRequired(body)) {
          // A refusal the person can act on, either way — but only one of
          // them interrupts. See `lastGestureAt`.
          if (recentGesture()) promptSignIn((body as { message?: string }).message);
          else showSignInBar();
        }
      } catch {
        // Not JSON, already consumed, or a body that cannot be cloned. A
        // notice we could not raise is not a reason to disturb the response.
      }
    }
    return res;
  };
  // Carry over whatever else the runtime hangs off `fetch` (Bun's
  // `preconnect`, and anything a future runtime adds). Replacing the function
  // must not quietly delete sibling properties other code may call.
  window.fetch = Object.assign(wrapped, window.fetch) as typeof window.fetch;
}
