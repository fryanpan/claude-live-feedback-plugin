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
 * **Before** — `fetchWriteAccess` asks the server whether this browser may
 * write, ONCE, before the router starts, and the answer travels to every
 * surface on `MountContext.canWrite` so each one mounts already knowing. This
 * is the half that matters for prose: doc text goes over the yjs socket,
 * which the server holds open in read-only mode so reading is unaffected, and
 * a person allowed to type into a socket that drops every keystroke has been
 * told nothing at all — the text appears, syncs to nobody, and is gone on
 * reload.
 *
 * It is a value passed down rather than a call each surface makes, and that
 * is the whole lesson of the second review pass: a surface that asks for
 * itself is EDITABLE WHILE IT ASKS. There used to be an `applyWriteAccess()`
 * here that did exactly that, and the doc mount awaited it after it had
 * already gone live.
 *
 * **After** — `installWriteGateNotice` wraps `fetch` once and turns any
 * `sign_in_required` refusal into a prompt. One wrapper rather than an edit
 * at each call site, because the question this gate has to answer is "how do
 * you know you covered every write", and a list of call sites is a list that
 * silently stops being complete. It only ever reads the body of a 401 and
 * never changes what the caller receives, so every existing error path still
 * runs exactly as it did.
 */

import { applyReadingCrumb } from '../huddle-entry.ts';

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
 * How long boot waits for the answer before going on without it.
 *
 * `identity-prompt.ts` reached this number first, against the same route and
 * for the same reason — *"a server that never answers must fall through to
 * the local identity, not hang boot"*. This call sits UPSTREAM of that guard
 * (every surface awaits it before the name prompt is even considered), so
 * without its own bound it hands the whole app the failure that one was
 * written to prevent.
 */
export const WRITE_ACCESS_LOOKUP_MS = 4000;

/**
 * Ask the server. A route that throws, 404s, answers with junk, or NEVER
 * ANSWERS AT ALL reads as "may write": an unreachable session route must
 * never lock a person out of a surface the server would have accepted them
 * on, and a silent one must never stop the document rendering.
 *
 * The timeout is the case the other three do not cover, and it is the one
 * that cost a whole app. `!res.ok` needs a response and `catch` needs a
 * rejection; a request left hanging produces neither, and `await` on it is
 * forever. Measured against an origin/main control with the route held open:
 * main rendered the document, this branch showed permanently blank chrome.
 *
 * Failing OPEN on a timeout is the same call the other three failure modes
 * make. It is also the safe direction: the socket is independently read-only
 * server-side for a browser that has proven nobody, so the worst case is a
 * surface that looks writable and refuses, not one that writes unchecked.
 */
export async function fetchWriteAccess(): Promise<WriteAccess> {
  const open: WriteAccess = { signInToWrite: false, canWrite: true };
  const lookup = (async (): Promise<WriteAccess> => {
    try {
      const res = await fetch('/api/auth/session');
      if (!res.ok) return open;
      const body = (await res.json()) as Partial<WriteAccess>;
      return {
        signInToWrite: body.signInToWrite === true,
        canWrite: body.canWrite !== false,
      };
    } catch {
      return open;
    }
  })();
  // `race`, not an AbortController: aborting would make the answer
  // unavailable to anything else, and a late answer is simply unwanted here
  // rather than harmful. The lookup can no longer reject, so the race cannot.
  const timeout = new Promise<WriteAccess>((resolve) => {
    setTimeout(() => resolve(open), WRITE_ACCESS_LOOKUP_MS);
  });
  return Promise.race([lookup, timeout]);
}

/**
 * Which refusals interrupt, and how that is decided.
 *
 * The gate refuses EVERY unsigned write, and the app makes several on its
 * own: the reading tracker posts time-on-page, the push subscription is
 * reconciled. Measured on a real load of a gated doc, one of those fired
 * within a second and raised the modal over a document the reader had not
 * touched — a sign-in demand as the first thing they saw, for a write they
 * never made.
 *
 * The first fix keyed the modal on a recent pointerdown, and that was a
 * CLOCK: any background write landing within five seconds of any click
 * inherited a gesture it had nothing to do with. It was right about most
 * sequences and unable to be right about any particular one.
 *
 * So the call site says which it is, and the marked set is the SMALL one.
 * Marking every deliberate write would be the enumeration this file exists
 * to avoid — twenty-odd call sites, and a new one defaults to silence.
 * Marking the background writers is three call sites that are already
 * unusual enough to name, and a write nobody marked defaults to being
 * treated as a person's, which errs toward telling them too much rather
 * than losing their words.
 */
let backgroundDepth = 0;

/**
 * Run a fetch the person did not ask for, so a refusal raises the standing
 * bar instead of a modal.
 *
 * Synchronous by contract: the flag is read when `fetch` is CALLED, so the
 * callback must start its request before it awaits anything. Returns
 * whatever the callback returns, and restores the flag even if it throws.
 */
export function asBackgroundWrite<T>(run: () => T): T {
  backgroundDepth++;
  try {
    return run();
  } finally {
    backgroundDepth--;
  }
}

/** `true` when the write now being issued was the app's idea, not a
 *  person's. Exported for tests. */
export function inBackgroundWrite(): boolean {
  return backgroundDepth > 0;
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
  // Clicking the scrim dismisses, the way every other scrim does. Guarded on
  // the target being the scrim itself: a click that started inside the card
  // bubbles up here too, and closing on that would make the card unusable.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  actions.append(later, go);
  card.append(title, body, actions);
  overlay.append(card);
  document.body.appendChild(overlay);
  go.focus();
}

/**
 * Where the bar goes, per surface.
 *
 * It used to be one `position: fixed` box under the top of the viewport,
 * offset by the doc topbar's measured height. That was wrong twice. On the
 * board there is no `#topbar` at all, so the measurement fell back to a 52px
 * constant and the bar landed on the action row — "Start a planning huddle"
 * failed hit-testing entirely. At 430px on the doc it covered the H1 and the
 * formatting toolbar. A fixed overlay covers whatever is beneath it, and a
 * notice that says "reading is unchanged" cannot be the thing eating the
 * document's title.
 *
 * So it is a LAYOUT ROW: it takes space and pushes the page down, on both
 * surfaces, at every width. Each surface has one header the page starts
 * with, and the row goes directly under it.
 */
function mountSignInBar(bar: HTMLElement): void {
  // The board. `#hub-root` is ordinary flow, and `.conn-banner` already
  // occupies this exact slot for the same kind of message.
  const hubTopbar = document.querySelector('.hub-topbar');
  if (hubTopbar?.parentElement) {
    hubTopbar.insertAdjacentElement('afterend', bar);
    return;
  }
  // The doc. `#shell` is a two-row grid (`48px 1fr`), so declaring the row is
  // as necessary as inserting it — appended without the class the bar would
  // land in the topbar's 48px track and be clipped.
  const shell = document.getElementById('shell');
  if (shell) {
    shell.insertBefore(bar, shell.firstChild);
    document.body.classList.add('signin-gated');
    return;
  }
  // Any other surface: still say it, and float, because there is no header
  // here to sit under and no layout to be sure of.
  bar.classList.add('signin-bar--floating');
  document.body.appendChild(bar);
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
  mountSignInBar(bar);
}

/**
 * The marker on every control that can make the document editable.
 *
 * There were two of them and the gate knew about one. The edit toggle was
 * disabled; Suggesting was not, and one click on it set
 * `contenteditable="true"`, took the reader's typing, said "All changes
 * saved", and lost every word on reload — verbatim the failure the top of
 * this file describes as the reason the gate exists.
 *
 * A list in the gate's own code is the wrong place to keep that set: it is
 * read by nobody who adds a button. The marker is an attribute in the markup,
 * beside the button, where somebody adding the third one is already looking.
 */
export const WRITE_CONTROL_ATTR = 'data-write-control';

/**
 * Lock a doc surface to reading: every marked control disabled and saying
 * why, the chrome describing a reader rather than a writer, and the caller's
 * own state put back to view.
 *
 * Disabled, not hidden. A control that vanishes teaches nothing about why,
 * and this reader can fix it — the bar above says how.
 *
 * The CHROME is in here rather than at the call site because it was at the
 * call site and only one of three surfaces got it. The markdown mount put
 * back the crumb and blanked the save-state chip; the redline and code
 * surfaces went on saying "Editing: notes.md" and "All changes saved" beside
 * an editor that would take nothing — a true sentence describing a thing that
 * is not happening, which is worse than silence. One function is what stops
 * the fourth surface drifting the same way.
 *
 * Both callbacks are optional: the redline and code surfaces have neither a
 * Suggesting mode nor a view/edit toggle of their own to put back, and a
 * surface with nothing to undo should not have to pass two empty functions to
 * say so.
 */
export function lockDocToReading(opts: {
  /** Leave Suggesting, if it was on. It is not a milder form of editing —
   *  proposals ride the same socket the server is dropping. */
  stopSuggesting?: () => void;
  /** Put the editor back in view mode. */
  toViewMode?: () => void;
  root?: ParentNode;
}): HTMLButtonElement[] {
  const root = opts.root ?? (typeof document === 'undefined' ? null : document);
  if (!root) return [];
  opts.stopSuggesting?.();
  opts.toViewMode?.();
  // "Editing:" → "Reading:". The word claims the second thing, and this
  // reader cannot do it.
  if (typeof document !== 'undefined') applyReadingCrumb(document);
  // Nothing to report about saving on a surface that cannot save.
  const saveState = (
    root as ParentNode & { querySelector: ParentNode['querySelector'] }
  ).querySelector?.('#save-state');
  if (saveState) {
    saveState.classList.remove('save-state--saved', 'save-state--dirty', 'save-state--offline');
    saveState.textContent = '';
  }
  const locked = Array.from(root.querySelectorAll<HTMLButtonElement>(`[${WRITE_CONTROL_ATTR}]`));
  for (const btn of locked) {
    btn.disabled = true;
    btn.title = 'Sign in to edit this doc';
    btn.setAttribute('aria-label', 'Sign in to edit this doc');
  }
  return locked;
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
  const original = window.fetch.bind(window);
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Read BEFORE the await. `asBackgroundWrite` is synchronous, so the flag
    // is only true during the call itself; by the time the response lands the
    // stack that set it is long gone.
    const background = inBackgroundWrite();
    const res = await original(input, init);
    // 401 only, so the common path costs one integer comparison and no clone.
    if (res.status === 401) {
      try {
        const body = (await res.clone().json()) as unknown;
        if (isSignInRequired(body)) {
          // A refusal the person can act on, either way — but only one of
          // them interrupts. See `backgroundDepth`.
          if (background) showSignInBar();
          else promptSignIn((body as { message?: string }).message);
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
