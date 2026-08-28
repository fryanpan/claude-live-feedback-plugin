import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MeSession, defaultSigninHref, wireMeMenu } from '../src/hub/me-menu.ts';

let button: HTMLButtonElement;
let menu: HTMLElement;
let dispose: (() => void) | null = null;

beforeEach(() => {
  button = document.createElement('button');
  menu = document.createElement('div');
  menu.className = 'hub-me-menu hidden';
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
      expect(menu.querySelector('a.hub-me-action')?.getAttribute('href')).toBe(
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
    menu.querySelector<HTMLButtonElement>('.hub-me-signout')?.click();
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
      expect(menu.querySelector('.hub-me-rename')).not.toBeNull();
    });
    menu.querySelector<HTMLButtonElement>('.hub-me-rename')?.click();
    const input = menu.querySelector<HTMLInputElement>('#hub-me-name');
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
      expect(menu.querySelector('.hub-me-rename')).not.toBeNull();
    });
    menu.querySelector<HTMLButtonElement>('.hub-me-rename')?.click();
    const input = menu.querySelector<HTMLInputElement>('#hub-me-name');
    if (!input) throw new Error('no rename input');
    input.value = 'Bryan C.';
    menu.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(menu.querySelector('.hub-me-error')?.classList.contains('hidden')).toBe(false);
    });
    expect(onRenamed).not.toHaveBeenCalled();
    expect(menu.querySelector('#hub-me-name')).not.toBeNull();
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

  it('falls back to the signed-out view when the session read fails', async () => {
    wire({ authenticated: false }, { fetchSession: async () => Promise.reject(new Error('down')) });
    button.click();
    await vi.waitFor(() => {
      expect(menu.textContent).toContain('Sign in');
    });
  });
});
