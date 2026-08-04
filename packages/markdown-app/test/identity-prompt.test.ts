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
