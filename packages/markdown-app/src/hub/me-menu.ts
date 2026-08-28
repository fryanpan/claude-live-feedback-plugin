import { escapeHtml, storeUserName } from '@feedback/core';

/**
 * The identity chip's menu — the sign-in entry point.
 *
 * The chip (`#hub-me`) is where the app shows identity today, so it is where
 * a person claims one: tap → a small popover that says whether this browser
 * holds a verified session, with "Sign in" or "Sign out" accordingly. The
 * server is asked ON OPEN, not at boot — the session lives in an HttpOnly
 * cookie no script can read, and a stale cached answer would tell someone
 * they are signed in on a browser that is not.
 */

export interface MeSession {
  authenticated: boolean;
  user?: { name: string };
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

async function defaultSaveName(name: string): Promise<boolean> {
  const res = await fetch('/api/auth/profile', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: name }),
  });
  return res.ok;
}

export function defaultSigninHref(pathname: string, search: string): string {
  return `/signin?next=${encodeURIComponent(pathname + search)}`;
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
      menu.innerHTML = `<p class="hub-me-row hub-me-note">Checking session…</p>`;
      return;
    }
    if (session.authenticated && session.user) {
      menu.innerHTML = `
        <p class="hub-me-row">Signed in as <b>${escapeHtml(session.user.name)}</b></p>
        <div class="hub-me-actions">
          <button type="button" class="hub-me-action hub-me-rename">Change name</button>
          <button type="button" class="hub-me-action hub-me-signout">Sign out</button>
        </div>`;
      menu.querySelector('.hub-me-rename')?.addEventListener('click', () => {
        renderRename(session.user?.name ?? '');
      });
      menu.querySelector('.hub-me-signout')?.addEventListener('click', () => {
        void signOut().then(() => {
          close();
          onSignedOut();
        });
      });
      return;
    }
    // The chip's name comes from this browser's storage, not a session — say
    // so, or "Signed in as Bryan" (the chip's tooltip) reads as verified.
    menu.innerHTML = `
      <p class="hub-me-row hub-me-note">Commenting as <b>${escapeHtml(opts.localName)}</b> — not signed in</p>
      <a class="hub-me-action" href="${escapeHtml(signinHref)}">Sign in</a>`;
  };

  /** The rename form — what "You can change this later from the board"
   *  promises. Saves through the same profile route the sign-in flow uses,
   *  seeds the confirmed name locally, then reloads so every surface —
   *  awareness, the chip, comment attribution — repaints as this name. */
  const renderRename = (current: string) => {
    menu.innerHTML = `
      <form class="hub-me-rename-form">
        <label class="hub-me-row" for="hub-me-name">Display name</label>
        <input id="hub-me-name" type="text" maxlength="40" autocomplete="name" value="${escapeHtml(current)}" />
        <div class="hub-me-actions">
          <button type="submit" class="hub-me-action">Save</button>
        </div>
        <p class="hub-me-row hub-me-note hub-me-error hidden" role="alert"></p>
      </form>`;
    const input = menu.querySelector<HTMLInputElement>('#hub-me-name');
    menu.querySelector('form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = input?.value.trim() ?? '';
      if (!name) {
        input?.focus();
        return;
      }
      void saveName(name).then((ok) => {
        if (!ok) {
          const err = menu.querySelector<HTMLElement>('.hub-me-error');
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
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onKeydown);
  return () => {
    button.removeEventListener('click', onClick);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onKeydown);
  };
}
