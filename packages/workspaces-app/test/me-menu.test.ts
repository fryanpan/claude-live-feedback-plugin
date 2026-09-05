import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MeSession, defaultSigninHref, wireMeMenu } from '../src/board/me-menu.ts';

let button: HTMLButtonElement;
let menu: HTMLElement;
let dispose: (() => void) | null = null;

beforeEach(() => {
  button = document.createElement('button');
  menu = document.createElement('div');
  menu.className = 'board-me-menu hidden';
  document.body.append(button, menu);
});

afterEach(() => {
  dispose?.();
  dispose = null;
  button.remove();
  menu.remove();
});

function wire(session: MeSession, extra: Partial<Parameters<typeof wireMeMenu>[0]> = {}) {
  dispose = wireMeMenu({
    button,
    menu,
    localName: 'Casey',
    fetchSession: async () => session,
    signinHref: '/signin?next=%2Fworkspaces%2Fw-1',
    ...extra,
  });
}

describe('defaultSigninHref', () => {
  it('carries the current page as an encoded next', () => {
    expect(defaultSigninHref('/workspaces/w-1/home', '?as=x')).toBe(
      '/signin?next=%2Fworkspaces%2Fw-1%2Fhome%3Fas%3Dx',
    );
  });
});

describe('wireMeMenu', () => {
  it('opens on click and offers Sign in when no session exists', async () => {
    wire({ authenticated: false });
    button.click();
    expect(menu.classList.contains('hidden')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await vi.waitFor(() => {
      expect(menu.querySelector('a.board-me-action')?.getAttribute('href')).toBe(
        '/signin?next=%2Fworkspaces%2Fw-1',
      );
    });
    // The chip's name is a local claim, and the menu says so.
    expect(menu.textContent).toContain('not signed in');
    expect(menu.textContent).toContain('Casey');
  });

  it('shows the verified name and a working Sign out when signed in', async () => {
    const signOut = vi.fn(async () => {});
    const onSignedOut = vi.fn();
    wire({ authenticated: true, user: { name: 'Bryan' } }, { signOut, onSignedOut });
    button.click();
    await vi.waitFor(() => {
      expect(menu.textContent).toContain('Signed in as');
    });
    expect(menu.querySelector('b')?.textContent).toBe('Bryan');
    menu.querySelector<HTMLButtonElement>('.board-me-signout')?.click();
    await vi.waitFor(() => {
      expect(onSignedOut).toHaveBeenCalled();
    });
    expect(signOut).toHaveBeenCalled();
    expect(menu.classList.contains('hidden')).toBe(true);
  });

  it('renames through the profile route, seeds the local name, and reloads', async () => {
    const saveName = vi.fn(async () => true);
    const storeName = vi.fn();
    const onRenamed = vi.fn();
    wire({ authenticated: true, user: { name: 'Bryan' } }, { saveName, storeName, onRenamed });
    button.click();
    await vi.waitFor(() => {
      expect(menu.querySelector('.board-me-rename')).not.toBeNull();
    });
    menu.querySelector<HTMLButtonElement>('.board-me-rename')?.click();
    // The form has to be LOOKED AT, not merely present. A click on a control
    // inside the menu rewrites the menu's own innerHTML, which detaches the
    // clicked node before the document-level outside-click handler sees the
    // event — and that handler used to read the detached target as "outside"
    // and close the menu. The input was in the DOM the whole time and never
    // on screen for more than a frame.
    expect(menu.classList.contains('hidden')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const input = menu.querySelector<HTMLInputElement>('#board-me-name');
    expect(input?.value).toBe('Bryan');
    if (!input) throw new Error('no rename input');
    input.value = '  Bryan C. ';
    menu.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(onRenamed).toHaveBeenCalled();
    });
    expect(saveName).toHaveBeenCalledWith('Bryan C.');
    expect(storeName).toHaveBeenCalledWith('Bryan C.');
    expect(menu.classList.contains('hidden')).toBe(true);
  });

  it('keeps the rename form open with an error when the server refuses', async () => {
    const saveName = vi.fn(async () => false);
    const onRenamed = vi.fn();
    wire({ authenticated: true, user: { name: 'Bryan' } }, { saveName, onRenamed });
    button.click();
    await vi.waitFor(() => {
      expect(menu.querySelector('.board-me-rename')).not.toBeNull();
    });
    menu.querySelector<HTMLButtonElement>('.board-me-rename')?.click();
    const input = menu.querySelector<HTMLInputElement>('#board-me-name');
    if (!input) throw new Error('no rename input');
    input.value = 'Bryan C.';
    menu.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(menu.querySelector('.board-me-error')?.classList.contains('hidden')).toBe(false);
    });
    expect(onRenamed).not.toHaveBeenCalled();
    expect(menu.querySelector('#board-me-name')).not.toBeNull();
  });

  it('closes on a second click, an outside click, and Escape', async () => {
    wire({ authenticated: false });
    button.click();
    expect(menu.classList.contains('hidden')).toBe(false);
    button.click();
    expect(menu.classList.contains('hidden')).toBe(true);
    button.click();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(menu.classList.contains('hidden')).toBe(true);
    button.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.classList.contains('hidden')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the menu open when a click inside it re-renders the menu', async () => {
    wire({ authenticated: true, user: { name: 'Bryan' } });
    button.click();
    await vi.waitFor(() => {
      expect(menu.querySelector('.board-me-rename')).not.toBeNull();
    });
    const rename = menu.querySelector<HTMLButtonElement>('.board-me-rename');
    if (!rename) throw new Error('no rename button');
    // A real click, dispatched the way a browser dispatches one: it reaches
    // the button, the button rewrites the menu, and the event then carries on
    // to the document with a target that is no longer in the tree.
    rename.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(rename.isConnected).toBe(false);
    expect(menu.classList.contains('hidden')).toBe(false);
    expect(menu.querySelector('#board-me-name')).not.toBeNull();
  });

  it('lets an unsigned browser rename itself locally, with no profile write', async () => {
    const saveName = vi.fn(async () => true);
    const storeName = vi.fn();
    const onRenamed = vi.fn();
    wire({ authenticated: false }, { saveName, storeName, onRenamed });
    button.click();
    await vi.waitFor(() => {
      expect(menu.querySelector('.board-me-rename')).not.toBeNull();
    });
    // Signing in is still offered beside it — renaming is not a substitute.
    expect(menu.querySelector('a.board-me-action')?.textContent).toBe('Sign in');
    menu.querySelector<HTMLButtonElement>('.board-me-rename')?.click();
    expect(menu.classList.contains('hidden')).toBe(false);
    const input = menu.querySelector<HTMLInputElement>('#board-me-name');
    // Seeded from the chip's local name, which is the only name this browser has.
    expect(input?.value).toBe('Casey');
    if (!input) throw new Error('no rename input');
    input.value = 'Casey Jones';
    menu.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(onRenamed).toHaveBeenCalled();
    });
    // The local store is the whole record: there is no session to write to,
    // and posting to the profile route would just 401.
    expect(saveName).not.toHaveBeenCalled();
    expect(storeName).toHaveBeenCalledWith('Casey Jones');
    expect(menu.classList.contains('hidden')).toBe(true);
  });

  it('rejects an empty name and keeps the form up', async () => {
    const storeName = vi.fn();
    const onRenamed = vi.fn();
    wire({ authenticated: false }, { storeName, onRenamed });
    button.click();
    await vi.waitFor(() => {
      expect(menu.querySelector('.board-me-rename')).not.toBeNull();
    });
    menu.querySelector<HTMLButtonElement>('.board-me-rename')?.click();
    const input = menu.querySelector<HTMLInputElement>('#board-me-name');
    if (!input) throw new Error('no rename input');
    input.value = '   ';
    menu.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(storeName).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
    expect(menu.querySelector('#board-me-name')).not.toBeNull();
    expect(menu.classList.contains('hidden')).toBe(false);
  });

  it('falls back to the signed-out view when the session read fails', async () => {
    wire({ authenticated: false }, { fetchSession: async () => Promise.reject(new Error('down')) });
    button.click();
    await vi.waitFor(() => {
      expect(menu.textContent).toContain('Sign in');
    });
  });
});

describe('a deployment with no sign-in page', () => {
  it('says who you are commenting as, and offers no dead link', async () => {
    wire({ authenticated: false, emailCodeSignIn: false });
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(menu.textContent).toContain('Commenting as');
    expect(menu.querySelector('a')).toBeNull();
    // Not an empty menu: everything that does not depend on a sign-in page
    // is still here, so the assertion above is about the link and nothing else.
    expect(menu.querySelector('.board-me-rename')).not.toBeNull();
  });

  it('POSITIVE CONTROL: the same menu still links where sign-in exists', async () => {
    wire({ authenticated: false, emailCodeSignIn: true });
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(menu.querySelector('a')?.getAttribute('href')).toBe('/signin?next=%2Fworkspaces%2Fw-1');
  });
});
