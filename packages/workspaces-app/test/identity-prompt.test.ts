import { describe, expect, it } from 'vitest';
import { ensureUserIdentity } from '../src/identity-prompt.ts';

function mockStorage() {
  const m = new Map<string, string>();
  return {
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

describe('ensureUserIdentity', () => {
  it('resolves immediately without showing a prompt when a name is stored', async () => {
    const s = mockStorage();
    s.set('feedback-user-name', 'Casey');
    const user = await ensureUserIdentity(null, s);
    expect(user.name).toBe('Casey');
    expect(document.querySelector('.identity-prompt')).toBeNull();
  });

  it('resolves immediately for a known ?as= param', async () => {
    const user = await ensureUserIdentity('bryan', mockStorage());
    expect(user.name).toBe('Bryan');
    expect(document.querySelector('.identity-prompt')).toBeNull();
  });

  it('shows the prompt on first arrival and resolves with the typed name', async () => {
    const s = mockStorage();
    const pending = ensureUserIdentity(null, s);
    const overlay = document.querySelector<HTMLElement>('.identity-prompt');
    expect(overlay).not.toBeNull();
    const input = overlay?.querySelector('input');
    const submit = overlay?.querySelector('button[type="submit"]');
    if (!input || !submit) throw new Error('prompt is missing its input or submit button');
    input.value = 'Casey';
    (submit as HTMLButtonElement).click();
    const user = await pending;
    expect(user.name).toBe('Casey');
    expect(user.kind).toBe('known');
    expect(s.get('feedback-user-name')).toBe('Casey');
    expect(document.querySelector('.identity-prompt')).toBeNull();
  });

  it('skip resolves anonymous and never asks this browser again', async () => {
    const s = mockStorage();
    const pending = ensureUserIdentity(null, s);
    const skip = document.querySelector<HTMLButtonElement>('.identity-prompt .identity-skip');
    if (!skip) throw new Error('prompt is missing its skip control');
    skip.click();
    const user = await pending;
    expect(user.kind).toBe('anon');
    expect(document.querySelector('.identity-prompt')).toBeNull();
    const again = await ensureUserIdentity(null, s);
    expect(again.kind).toBe('anon');
    expect(document.querySelector('.identity-prompt')).toBeNull();
  });

  it('an unknown ?as= value prefills the name field', async () => {
    const s = mockStorage();
    const pending = ensureUserIdentity('Casey', s);
    const input = document.querySelector<HTMLInputElement>('.identity-prompt input');
    expect(input?.value).toBe('Casey');
    const submit = document.querySelector<HTMLButtonElement>(
      '.identity-prompt button[type="submit"]',
    );
    submit?.click();
    const user = await pending;
    expect(user.name).toBe('Casey');
  });

  it('Escape resolves anonymous WITHOUT persisting the skip (asks again next visit)', async () => {
    const s = mockStorage();
    const pending = ensureUserIdentity(null, s);
    const overlay = document.querySelector<HTMLElement>('.identity-prompt');
    overlay
      ?.querySelector('input')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const user = await pending;
    expect(user.kind).toBe('anon');
    expect(document.querySelector('.identity-prompt')).toBeNull();
    expect(s.get('feedback-name-prompt-dismissed')).toBeNull();
  });

  it('the dialog carries basic modal semantics', async () => {
    const pending = ensureUserIdentity(null, mockStorage());
    const dialog = document.querySelector<HTMLElement>('.identity-prompt [role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    document.querySelector<HTMLButtonElement>('.identity-prompt .identity-skip')?.click();
    await pending;
  });

  it('submitting an empty name keeps the prompt open', async () => {
    const s = mockStorage();
    const pending = ensureUserIdentity(null, s);
    const overlay = document.querySelector<HTMLElement>('.identity-prompt');
    const submit = overlay?.querySelector<HTMLButtonElement>('button[type="submit"]');
    submit?.click();
    expect(document.querySelector('.identity-prompt')).not.toBeNull();
    const input = overlay?.querySelector('input');
    if (!input || !submit) throw new Error('prompt is missing its input or submit button');
    input.value = 'Casey';
    submit.click();
    const user = await pending;
    expect(user.name).toBe('Casey');
  });
});

describe('ensureUserIdentity follows the signed-in session', () => {
  it('a verified session is the identity, with no prompt and no anon id', async () => {
    const s = mockStorage();
    const user = await ensureUserIdentity(null, s, {
      fetchSession: async () => ({
        authenticated: true,
        user: { id: 'user-abc123', name: 'Reviewer', kind: 'known', color: '#123456' },
      }),
    });
    expect(user.id).toBe('user-abc123');
    expect(user.name).toBe('Reviewer');
    expect(document.querySelector('.identity-prompt')).toBeNull();
    // The name is stored where the chip and the rest of the app read it.
    expect(s.get('feedback-user-name')).toBe('Reviewer');
  });

  it('the signed-in name wins over a name this browser typed earlier', async () => {
    const s = mockStorage();
    s.set('feedback-user-name', 'Casey');
    const user = await ensureUserIdentity(null, s, {
      fetchSession: async () => ({
        authenticated: true,
        user: { id: 'user-abc123', name: 'Reviewer', kind: 'known', color: '#123456' },
      }),
    });
    expect(user.name).toBe('Reviewer');
    expect(user.id).toBe('user-abc123');
  });

  it('POSITIVE CONTROL: not signed in falls back to the stored name and stable anon id', async () => {
    const s = mockStorage();
    s.set('feedback-user-name', 'Casey');
    const user = await ensureUserIdentity(null, s, {
      fetchSession: async () => ({ authenticated: false }),
    });
    expect(user.name).toBe('Casey');
    expect(user.id.startsWith('anon-')).toBe(true);
  });

  it('a session lookup that throws is not signed in', async () => {
    const s = mockStorage();
    s.set('feedback-user-name', 'Casey');
    const user = await ensureUserIdentity(null, s, {
      fetchSession: async () => {
        throw new Error('offline');
      },
    });
    expect(user.name).toBe('Casey');
  });
});
