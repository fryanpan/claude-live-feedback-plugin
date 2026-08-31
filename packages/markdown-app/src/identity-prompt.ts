import {
  type User,
  dismissNamePrompt,
  hashToColor,
  needsNamePrompt,
  resolveUser,
  storeUserName,
} from '@feedback/core';

type IdentityStorage = { get(k: string): string | null; set(k: string, v: string): void };

/** What `/api/auth/session` answers — the verified identity, if this browser
 *  holds one. Same shape `me-menu.ts` reads. */
export interface SessionAnswer {
  authenticated: boolean;
  user?: Partial<User>;
}

export interface EnsureIdentityOptions {
  /** Asks the server whether this browser is signed in. Injectable so a test
   *  can answer without a server; the default fetches the real route and
   *  treats any failure as "not signed in". */
  fetchSession?: () => Promise<SessionAnswer>;
  /**
   * Do not ask this browser to type a name.
   *
   * Set when the server requires a session to write (see
   * signin/write-gate.ts). A typed name is worth nothing there — the server
   * will refuse every write it labels — so asking for one is a modal that
   * blocks boot to collect an answer nobody can use, and it arrives instead
   * of the one question that matters. The caller shows the sign-in route;
   * this option just gets the pointless prompt out of the way, leaving the
   * stored-or-anonymous identity that labels a READER, which is what this
   * person is.
   */
  suppressNamePrompt?: boolean;
}

/** Bounded, because this gates the editor's first packet: a server that
 *  never answers must fall through to the local identity, not hang boot. */
const SESSION_LOOKUP_MS = 4000;

async function defaultFetchSession(): Promise<SessionAnswer> {
  const timeout = new Promise<SessionAnswer>((resolve) =>
    setTimeout(() => resolve({ authenticated: false }), SESSION_LOOKUP_MS),
  );
  const lookup = (async (): Promise<SessionAnswer> => {
    const res = await fetch('/api/auth/session');
    if (!res.ok) return { authenticated: false };
    return (await res.json()) as SessionAnswer;
  })();
  return Promise.race([lookup, timeout]);
}

/**
 * Resolve the reviewer's identity.
 *
 * A VERIFIED session wins (Bryan, 2026-08-29: a verified name is never worse
 * than a typed one). When `/api/auth/session` says this browser is signed
 * in, the editor's user is the roster identity — `user-<hash>` and the
 * roster's display name — so comments and awareness stamp that instead of
 * the per-browser `anon-*` id, whether or not sign-in is required here.
 * The name is stored where the rest of the app reads it, so the chip and
 * every surface that reads storage agree with the server.
 *
 * Otherwise, the first-arrival name prompt shows when nothing is stored
 * yet, and resolves once the user submits a name (persisted to storage) or
 * skips (stays anonymous; the skip is remembered so this browser is never
 * asked again). When identity is already determined — stored name, known
 * `?as=` param, or a prior skip — no UI is shown.
 */
export async function ensureUserIdentity(
  asParam: string | null | undefined,
  storage: IdentityStorage | null,
  opts: EnsureIdentityOptions = {},
): Promise<User> {
  const session = sessionUser(opts.fetchSession ?? defaultFetchSession);
  const adopt = (signedIn: User): User => {
    storeUserName(storage, signedIn.name);
    return signedIn;
  };
  if (opts.suppressNamePrompt || !needsNamePrompt(asParam, storage)) {
    const signedIn = await session;
    return signedIn ? adopt(signedIn) : resolveUser(asParam, storage);
  }
  // First arrival: the prompt shows NOW, synchronously, so the page never
  // sits blank while the session lookup is in flight — and a session that
  // answers "signed in" takes the prompt down and wins over anything typed.
  return new Promise((resolve) => {
    let settled = false;
    const settle = (user: User) => {
      if (settled) return;
      settled = true;
      resolve(user);
    };
    void session.then((signedIn) => {
      if (!signedIn || settled) return;
      overlay.remove();
      settle(adopt(signedIn));
    });
    const overlay = document.createElement('div');
    overlay.className = 'identity-prompt';
    // Static template only — never interpolate anything user-controlled here.
    overlay.innerHTML = `
      <form class="identity-card" role="dialog" aria-modal="true" aria-labelledby="identity-title">
        <h2 id="identity-title">Who's reviewing?</h2>
        <p>Your name labels your comments and edits for everyone else on this doc.</p>
        <input type="text" name="name" autocomplete="name" placeholder="Your name" maxlength="40" />
        <div class="identity-actions">
          <button type="button" class="identity-skip">Stay anonymous</button>
          <button type="submit">Continue</button>
        </div>
      </form>`;
    const form = overlay.querySelector('form');
    const input = overlay.querySelector('input');
    const skip = overlay.querySelector('.identity-skip');
    // An unrecognized ?as= value can't resolve to a known identity, but it's
    // a perfectly good default answer — prefill so one tap confirms it.
    if (input && asParam) input.value = asParam;
    const finish = (user: User) => {
      overlay.remove();
      settle(user);
    };
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input?.value.trim() ?? '';
      if (!name) {
        input?.focus();
        return;
      }
      storeUserName(storage, name);
      finish(resolveUser(null, storage));
    });
    skip?.addEventListener('click', () => {
      dismissNamePrompt(storage);
      finish(resolveUser(null, storage));
    });
    // Escape = "not now": continue anonymous for THIS visit without
    // remembering the dismissal, so the prompt can ask again next time.
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') finish(resolveUser(null, storage));
    });
    document.body.appendChild(overlay);
    input?.focus();
  });
}

/** The verified user, or null for anything short of a well-formed one. A
 *  session route that throws, 500s, or answers without an id is "not signed
 *  in" — never a half-identity the editor would then broadcast. */
async function sessionUser(fetchSession: () => Promise<SessionAnswer>): Promise<User | null> {
  try {
    const answer = await fetchSession();
    if (!answer?.authenticated || !answer.user) return null;
    const { id, name, color } = answer.user;
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim()) return null;
    return {
      id,
      name: name.trim(),
      kind: 'known',
      color: typeof color === 'string' && color ? color : hashToColor(name),
    };
  } catch {
    return null;
  }
}
