import { escapeHtml, storeUserName } from '@feedback/core';
import { hasSignInPage, signInHref } from '../signin/write-gate.ts';

/**
 * The identity chip's menu — the sign-in entry point.
 *
 * The chip (`#board-me`) is where the app shows identity today, so it is where
 * a person claims one: tap → a small popover that says whether this browser
 * holds a verified session, with "Sign in" or "Sign out" accordingly. The
 * server is asked ON OPEN, not at boot — the session lives in an HttpOnly
 * cookie no script can read, and a stale cached answer would tell someone
 * they are signed in on a browser that is not.
 */

export interface MeSession {
  authenticated: boolean;
  user?: { name: string };
  /** Whether this deployment has a `/signin` page. Absent reads as yes, the
   *  way an unanswered session lookup does. */
  emailCodeSignIn?: boolean;
}

export interface MeMenuOpts {
  button: HTMLElement;
  menu: HTMLElement;
  /** The locally-stored display name the chip already renders. */
  localName: string;
  fetchSession?: () => Promise<MeSession>;
  signOut?: () => Promise<void>;
  /** Where "Sign in" goes. Carries `next` so finishing lands back here. */
  signinHref?: string;
  /** After sign-out — a reload, so nothing keeps rendering the old session. */
  onSignedOut?: () => void;
  /** Saves a new display name; resolves false when the server refused. */
  saveName?: (name: string) => Promise<boolean>;
  /** Persist the confirmed name where `ensureUserIdentity` reads it. */
  storeName?: (name: string) => void;
  /** After a rename — a reload, so every surface repaints the new name. */
  onRenamed?: () => void;
}

async function defaultFetchSession(): Promise<MeSession> {
  const res = await fetch('/api/auth/session');
  return (await res.json()) as MeSession;
}

async function defaultSignOut(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

/** The rename form's persist step when there is no session to write to —
 *  the local store, seeded by the caller, is the whole record. */
async function saveNothing(): Promise<boolean> {
  return true;
}

async function defaultSaveName(name: string): Promise<boolean> {
  const res = await fetch('/api/auth/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: name }),
  });
  return res.ok;
}

/** Re-exported shape, one definition. The write gate raises the same link
 *  from a refused write, and two spellings of a URL drift. */
export function defaultSigninHref(pathname: string, search: string): string {
  return signInHref(pathname, search);
}

export function wireMeMenu(opts: MeMenuOpts): () => void {
  const { button, menu } = opts;
  const fetchSession = opts.fetchSession ?? defaultFetchSession;
  const signOut = opts.signOut ?? defaultSignOut;
  const signinHref = opts.signinHref ?? defaultSigninHref(location.pathname, location.search);
  const onSignedOut = opts.onSignedOut ?? (() => location.reload());
  const saveName = opts.saveName ?? defaultSaveName;
  const storeName =
    opts.storeName ??
    ((name: string) =>
      storeUserName(
        { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) },
        name,
      ));
  const onRenamed = opts.onRenamed ?? (() => location.reload());

  const close = () => {
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
  };

  const renderMenu = (session: MeSession | null) => {
    if (session === null) {
      menu.innerHTML = `<p class="board-me-row board-me-note">Checking session…</p>`;
      return;
    }
    if (session.authenticated && session.user) {
      menu.innerHTML = `
        <p class="board-me-row">Signed in as <b>${escapeHtml(session.user.name)}</b></p>
        <div class="board-me-actions">
          <button type="button" class="board-me-action board-me-rename">Change name</button>
          <button type="button" class="board-me-action board-me-signout">Sign out</button>
        </div>`;
      menu.querySelector('.board-me-rename')?.addEventListener('click', () => {
        renderRename(session.user?.name ?? '', saveName);
      });
      menu.querySelector('.board-me-signout')?.addEventListener('click', () => {
        void signOut().then(() => {
          close();
          onSignedOut();
        });
      });
      return;
    }
    // The chip's name comes from this browser's storage, not a session — say
    // so, or "Signed in as Bryan" (the chip's tooltip) reads as verified.
    // "Change name" is offered here as well as when signed in: the name on
    // this row is the one every comment from this browser is stamped with,
    // and until now the only way to change it was to sign in first.
    //
    // "Sign in" is offered only where the server still has a `/signin` page.
    // Under access-only it does not, and a link to a 404 is worse than none —
    // the session says which deployment this is.
    const offerSignIn = session.emailCodeSignIn !== false && hasSignInPage();
    menu.innerHTML = `
      <p class="board-me-row board-me-note">Commenting as <b>${escapeHtml(opts.localName)}</b> — not signed in</p>
      <div class="board-me-actions">
        <button type="button" class="board-me-action board-me-rename">Change name</button>
        ${offerSignIn ? `<a class="board-me-action" href="${escapeHtml(signinHref)}">Sign in</a>` : ''}
      </div>`;
    menu.querySelector('.board-me-rename')?.addEventListener('click', () => {
      // No server call: an unsigned browser has no profile to write to, so
      // the local store IS the record. `saveNothing` keeps one submit path.
      renderRename(opts.localName, saveNothing);
    });
  };

  /** The rename form — what "You can change this later from the board"
   *  promises. `save` is where the name goes first: the profile route for a
   *  verified session, nowhere for an unsigned browser. Either way the
   *  confirmed name is seeded locally and the page reloads, so every surface —
   *  awareness, the chip, comment attribution — repaints as this name. */
  const renderRename = (current: string, save: (name: string) => Promise<boolean>) => {
    menu.innerHTML = `
      <form class="board-me-rename-form">
        <label class="board-me-row" for="board-me-name">Display name</label>
        <input id="board-me-name" type="text" maxlength="40" autocomplete="name" value="${escapeHtml(current)}" />
        <div class="board-me-actions">
          <button type="submit" class="board-me-action">Save</button>
        </div>
        <p class="board-me-row board-me-note board-me-error hidden" role="alert"></p>
      </form>`;
    const input = menu.querySelector<HTMLInputElement>('#board-me-name');
    menu.querySelector('form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input?.value.trim() ?? '';
      if (!name) {
        input?.focus();
        return;
      }
      void save(name).then((ok) => {
        if (!ok) {
          const err = menu.querySelector<HTMLElement>('.board-me-error');
          if (err) {
            err.textContent = 'Couldn’t save the name. Try again.';
            err.classList.remove('hidden');
          }
          return;
        }
        storeName(name);
        close();
        onRenamed();
      });
    });
    input?.focus();
    input?.select();
  };

  const open = () => {
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    renderMenu(null);
    void fetchSession()
      .then((s) => {
        if (!menu.classList.contains('hidden')) renderMenu(s);
      })
      .catch(() => {
        if (!menu.classList.contains('hidden')) {
          renderMenu({ authenticated: false });
        }
      });
  };

  const onClick = () => {
    if (menu.classList.contains('hidden')) open();
    else close();
  };
  /**
   * Close on a click that landed outside the chip and its menu.
   *
   * Registered on the CAPTURE phase, and that is the whole fix for the bug
   * this comment exists for. In the bubble phase this handler runs AFTER the
   * in-menu button that was clicked has already run — and "Change name"
   * rewrites `menu.innerHTML`, which detaches the very node the event is
   * still carrying as its target. `menu.contains(t)` then answers false for a
   * click that came from inside the menu, so the menu closed itself the
   * instant it rendered the rename form: the input appeared for one frame and
   * vanished, which is exactly what a person sees as a flicker and no input.
   * Capture runs before any of that, while the target is still in the tree.
   */
  const onDocClick = (ev: Event) => {
    if (menu.classList.contains('hidden')) return;
    const t = ev.target as Node;
    if (menu.contains(t) || button.contains(t)) return;
    close();
  };
  const onKeydown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') close();
  };

  button.addEventListener('click', onClick);
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onKeydown);
  return () => {
    button.removeEventListener('click', onClick);
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeydown);
  };
}
