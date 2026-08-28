import { escapeHtml, storeUserName } from '@feedback/core';

/**
 * The sign-in page: three states of one card, mounted at /signin.
 *
 * 1. Email entry — ask for an address, POST /api/auth/start.
 * 2. Code entry — six auto-advancing digit boxes, POST /api/auth/verify.
 * 3. Display name — FIRST sign-in only (the verify response says so), so a
 *    returning person who already chose a name is never asked again.
 *
 * Identity, not access: the tailnet reaches everything signed out, and this
 * page only lets a person claim who they are. That is why finishing seeds the
 * same localStorage name `ensureUserIdentity` reads — the signed-in name must
 * be the one awareness broadcasts and comments carry, not a second identity
 * living beside it.
 */

/** The server's code-box count. Six digits — see auth/email-code.ts. */
export const CODE_LENGTH = 6;

/** Client-side resend cooldown, seconds. UX pacing only — the server's real
 *  budget is 5 starts per address per 15 minutes, which this stays inside. */
export const RESEND_COOLDOWN_S = 60;

/**
 * Where to land after signing in. Same-origin PATHS only: `next` arrives on
 * the URL, and an absolute or scheme-relative value would make the sign-in
 * page an open redirect for whoever composes a link. The second character
 * may be neither `/` nor `\` — browsers treat backslashes as forward
 * slashes when parsing special-scheme URLs, so `/\evil.com` navigates to
 * `http://evil.com/` exactly like `//evil.com` does.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !/^\/(?![/\\])/.test(raw)) return '/';
  return raw;
}

/** "It expires in 10 minutes." — from the server's real TTL, never a copy of
 *  the constant, so the page cannot drift when the backend changes it. */
export function expiresCopy(expiresInSeconds: number): string {
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  return `It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

interface StartOk {
  ok: true;
  email: string;
  expiresInSeconds: number;
}

interface VerifyOk {
  ok: true;
  user: { id: string; name: string; color?: string };
  firstSignIn?: boolean;
}

type ApiError = {
  error?: string;
  retryAfterSeconds?: number;
  attemptsLeft?: number;
};

/** One line the user can act on, for every error shape the routes answer. */
export function errorMessage(status: number, body: ApiError): string {
  switch (body.error) {
    case 'invalid_email':
      return 'That doesn’t look like an email address.';
    case 'rate_limited':
      return body.retryAfterSeconds
        ? `Too many attempts. Try again in ${describeWait(body.retryAfterSeconds)}.`
        : 'Too many attempts. Try again in a little while.';
    case 'code_send_failed':
      return 'We couldn’t send the email. Try again in a moment.';
    case 'invalid_code':
      return body.attemptsLeft === 1
        ? 'That code didn’t match. 1 try left.'
        : `That code didn’t match.${body.attemptsLeft ? ` ${body.attemptsLeft} tries left.` : ''}`;
    case 'no_challenge':
      return 'That code has expired. Send a new one.';
    case 'too_many_attempts':
      return 'Too many wrong tries. Send a new code.';
    case 'identity_archived':
      return 'This account has been archived. Ask the workspace owner to restore it.';
    case 'not_signed_in':
      return 'Your session ended. Start over with your email.';
    default:
      return status >= 500
        ? 'Something went wrong on the server. Try again.'
        : 'Something went wrong. Try again.';
  }
}

function describeWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

type State =
  | { step: 'email'; email: string }
  | { step: 'code'; email: string; expiresInSeconds: number }
  | { step: 'name'; suggested: string };

interface SigninStorage {
  get(k: string): string | null;
  set(k: string, v: string): void;
}

export interface SigninOpts {
  /** Injected for tests; defaults wrap localStorage (null in private mode). */
  storage?: SigninStorage | null;
  /** Injected for tests; defaults to `location.assign`. */
  navigate?: (path: string) => void;
  /** The `?next=` target, already parsed. Defaults from location.search. */
  next?: string;
}

function defaultStorage(): SigninStorage | null {
  try {
    localStorage.getItem('feedback-user-name');
    return {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    };
  } catch {
    return null;
  }
}

/** Mount the sign-in card into `root`. Returns a disposer (tests only). */
export function mountSignin(root: HTMLElement, opts: SigninOpts = {}): () => void {
  const storage = opts.storage !== undefined ? opts.storage : defaultStorage();
  const navigate = opts.navigate ?? ((path: string) => location.assign(path));
  const next = opts.next ?? safeNextPath(new URLSearchParams(location.search).get('next'));

  let state: State = { step: 'email', email: '' };
  let resendTimer: ReturnType<typeof setInterval> | null = null;

  const stopResendTimer = () => {
    if (resendTimer) clearInterval(resendTimer);
    resendTimer = null;
  };

  /** Everything ends here: the chosen name becomes the one the whole app
   *  reads (awareness, comments, the board's "who am I" chip). */
  const finish = (name: string) => {
    storeUserName(storage, name);
    navigate(next);
  };

  async function post(path: string, body: unknown): Promise<Response> {
    return await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  const setError = (msg: string) => {
    const el = root.querySelector<HTMLElement>('.signin-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('hidden', msg === '');
  };

  const setBusy = (busy: boolean) => {
    const btn = root.querySelector<HTMLButtonElement>('.signin-btn');
    if (btn) btn.disabled = busy;
  };

  async function startCode(email: string): Promise<void> {
    setError('');
    setBusy(true);
    try {
      const res = await post('/api/auth/start', { email });
      const body = (await res.json()) as StartOk & ApiError;
      if (!res.ok) {
        setError(errorMessage(res.status, body));
        return;
      }
      state = { step: 'code', email: body.email, expiresInSeconds: body.expiresInSeconds };
      render();
    } catch {
      setError('Couldn’t reach the server. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(email: string, code: string): Promise<void> {
    setError('');
    setBusy(true);
    try {
      const res = await post('/api/auth/verify', { email, code });
      const body = (await res.json()) as VerifyOk & ApiError;
      if (!res.ok) {
        setError(errorMessage(res.status, body));
        clearCodeBoxes();
        return;
      }
      stopResendTimer();
      if (body.firstSignIn) {
        state = { step: 'name', suggested: body.user.name };
        render();
        return;
      }
      finish(body.user.name);
    } catch {
      setError('Couldn’t reach the server. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function saveName(name: string): Promise<void> {
    setError('');
    setBusy(true);
    try {
      const res = await post('/api/auth/profile', { displayName: name });
      const body = (await res.json()) as VerifyOk & ApiError;
      if (!res.ok) {
        setError(errorMessage(res.status, body));
        return;
      }
      finish(body.user.name);
    } catch {
      setError('Couldn’t reach the server. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const clearCodeBoxes = () => {
    const boxes = [...root.querySelectorAll<HTMLInputElement>('.signin-code input')];
    for (const b of boxes) b.value = '';
    boxes[0]?.focus();
  };

  const codeValue = (): string =>
    [...root.querySelectorAll<HTMLInputElement>('.signin-code input')].map((b) => b.value).join('');

  /** Arm the 60s resend cooldown: the link goes inert and counts down. */
  const armResendCooldown = () => {
    stopResendTimer();
    const link = root.querySelector<HTMLButtonElement>('.signin-resend');
    if (!link) return;
    let left = RESEND_COOLDOWN_S;
    link.disabled = true;
    link.textContent = `Send a new code (${left}s)`;
    resendTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        stopResendTimer();
        link.disabled = false;
        link.textContent = 'Send a new code';
        return;
      }
      link.textContent = `Send a new code (${left}s)`;
    }, 1000);
  };

  function render(): void {
    stopResendTimer();
    if (state.step === 'email') renderEmail(state.email);
    else if (state.step === 'code') renderCode(state.email, state.expiresInSeconds);
    else renderName(state.suggested);
  }

  function card(inner: string): void {
    root.innerHTML = `
      <div class="signin-card">
        <p class="signin-wordmark">Fryanpan Workspaces</p>
        ${inner}
        <p class="signin-error hidden" role="alert"></p>
      </div>`;
  }

  function renderEmail(prefill: string): void {
    card(`
      <h1>Sign in</h1>
      <p class="signin-sub">Enter your email and we&rsquo;ll send you a code. No password needed.</p>
      <form class="signin-form" novalidate>
        <label class="signin-field-label" for="signin-email">Email</label>
        <input id="signin-email" type="email" placeholder="you@example.com" autocomplete="email" value="${escapeHtml(prefill)}" />
        <button type="submit" class="signin-btn">Email me a code</button>
      </form>`);
    const input = root.querySelector<HTMLInputElement>('#signin-email');
    root.querySelector('form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = input?.value.trim() ?? '';
      if (!email) {
        input?.focus();
        return;
      }
      state = { step: 'email', email };
      void startCode(email);
    });
    input?.focus();
  }

  function renderCode(email: string, expiresInSeconds: number): void {
    const boxes = Array.from({ length: CODE_LENGTH })
      .map(
        (_, i) =>
          // `one-time-code` on the FIRST box, where iOS offers the mailed
          // code; the paste handler spreads the digits across all six.
          `<input type="text" inputmode="numeric" maxlength="1" aria-label="Digit ${i + 1}"${
            i === 0 ? ' autocomplete="one-time-code"' : ''
          } />`,
      )
      .join('');
    card(`
      <h1>Check your email</h1>
      <p class="signin-sub">We sent a 6-digit code to <strong>${escapeHtml(email)}</strong>. ${expiresCopy(expiresInSeconds)}</p>
      <form class="signin-form" novalidate>
        <div class="signin-code" aria-label="6-digit code">${boxes}</div>
        <button type="submit" class="signin-btn">Sign in</button>
      </form>
      <p class="signin-quiet">Didn&rsquo;t get it? <button type="button" class="signin-link signin-resend">Send a new code</button><br />
      <span class="signin-note">You can ask for a new one every ${RESEND_COOLDOWN_S} seconds.</span></p>
      <p class="signin-switch"><button type="button" class="signin-link signin-switch-email">Use a different email</button></p>`);
    wireCodeBoxes();
    armResendCooldown();
    root.querySelector('form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = codeValue();
      if (code.length < CODE_LENGTH) {
        setError('Enter all six digits.');
        return;
      }
      void verifyCode(email, code);
    });
    root.querySelector('.signin-resend')?.addEventListener('click', () => {
      armResendCooldown();
      void resend(email);
    });
    root.querySelector('.signin-switch-email')?.addEventListener('click', () => {
      stopResendTimer();
      state = { step: 'email', email };
      render();
    });
    root.querySelector<HTMLInputElement>('.signin-code input')?.focus();
  }

  /** A resend stays on the code screen — only the expiry copy could change,
   *  and re-rendering would throw away half-typed digits for no reason. */
  async function resend(email: string): Promise<void> {
    setError('');
    try {
      const res = await post('/api/auth/start', { email });
      if (!res.ok) {
        const body = (await res.json()) as ApiError;
        setError(errorMessage(res.status, body));
      }
    } catch {
      setError('Couldn’t reach the server. Check the connection and try again.');
    }
  }

  function renderName(suggested: string): void {
    card(`
      <h1>What should we call you?</h1>
      <p class="signin-sub">This name appears on your comments and edits.</p>
      <form class="signin-form" novalidate>
        <label class="signin-field-label" for="signin-name">Name</label>
        <input id="signin-name" type="text" autocomplete="name" maxlength="40" value="${escapeHtml(suggested)}" />
        <button type="submit" class="signin-btn">Start working</button>
      </form>
      <div class="signin-attribution"><b></b>&nbsp; commented just now &mdash; &ldquo;Looks good, ship it.&rdquo;</div>
      <p class="signin-quiet">You can change this later from the board.</p>`);
    const input = root.querySelector<HTMLInputElement>('#signin-name');
    const preview = root.querySelector<HTMLElement>('.signin-attribution b');
    const paint = () => {
      if (preview) preview.textContent = input?.value.trim() || suggested;
    };
    paint();
    input?.addEventListener('input', paint);
    root.querySelector('form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input?.value.trim() ?? '';
      if (!name) {
        input?.focus();
        return;
      }
      void saveName(name);
    });
    input?.focus();
    input?.select();
  }

  /** Type-to-advance, backspace-to-retreat, paste-to-fill — the code boxes. */
  function wireCodeBoxes(): void {
    const boxes = [...root.querySelectorAll<HTMLInputElement>('.signin-code input')];
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        const digits = box.value.replace(/\D/g, '');
        // More than one digit lands here when iOS autofills or the user
        // pastes into a box — spread the run forward instead of truncating.
        if (digits.length > 1) {
          fillFrom(boxes, i, digits);
          return;
        }
        box.value = digits;
        if (digits && i < boxes.length - 1) boxes[i + 1]?.focus();
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1]?.focus();
      });
      box.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData('text') ?? '';
        const digits = text.replace(/\D/g, '');
        if (!digits) return;
        e.preventDefault();
        fillFrom(boxes, i, digits);
      });
    });
  }

  function fillFrom(boxes: HTMLInputElement[], start: number, digits: string): void {
    let at = start;
    for (const d of digits) {
      if (at >= boxes.length) break;
      const box = boxes[at];
      if (box) box.value = d;
      at += 1;
    }
    boxes[Math.min(at, boxes.length - 1)]?.focus();
  }

  render();
  return () => {
    stopResendTimer();
    root.innerHTML = '';
  };
}
