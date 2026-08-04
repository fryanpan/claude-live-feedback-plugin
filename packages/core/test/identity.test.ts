import { describe, expect, it } from 'vitest';
import { dismissNamePrompt, needsNamePrompt, resolveUser, storeUserName } from '../src/identity.ts';

function mockStorage() {
  const m = new Map<string, string>();
  return {
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

describe('resolveUser', () => {
  it('returns Bryan for ?as=bryan', () => {
    const u = resolveUser('bryan', mockStorage());
    expect(u.kind).toBe('known');
    expect(u.name).toBe('Bryan');
    expect(u.id).toBe('known-bryan');
  });

  it('returns Agent for ?as=agent (case-insensitive)', () => {
    const u = resolveUser('AGENT', mockStorage());
    expect(u.kind).toBe('known');
    expect(u.name).toBe('Agent');
  });

  it('returns anon with stable id from storage', () => {
    const s = mockStorage();
    const u1 = resolveUser(null, s);
    const u2 = resolveUser(null, s);
    expect(u1.kind).toBe('anon');
    expect(u1.id).toBe(u2.id);
    expect(u1.name).toMatch(/^Anon-/);
  });

  it('anon has a deterministic color per id', () => {
    const s = mockStorage();
    const u1 = resolveUser(null, s);
    const u2 = resolveUser(null, s);
    expect(u1.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(u1.color).toBe(u2.color);
  });

  it('falls back to anon for unknown `as` param', () => {
    const u = resolveUser('someone-else', mockStorage());
    expect(u.kind).toBe('anon');
  });

  it('uses the stored name when one exists', () => {
    const s = mockStorage();
    storeUserName(s, 'Casey');
    const u = resolveUser(null, s);
    expect(u.kind).toBe('known');
    expect(u.name).toBe('Casey');
  });

  it('keeps the stable anon id when a name is stored (identity continuity)', () => {
    const s = mockStorage();
    const before = resolveUser(null, s);
    storeUserName(s, 'Casey');
    const after = resolveUser(null, s);
    expect(after.id).toBe(before.id);
  });

  it('derives the named color from the name, not the id (cross-device match)', () => {
    const s1 = mockStorage();
    const s2 = mockStorage();
    storeUserName(s1, 'Casey');
    storeUserName(s2, 'Casey');
    expect(resolveUser(null, s1).color).toBe(resolveUser(null, s2).color);
  });

  it('a stored name matching a known user resolves to the full known identity', () => {
    const s = mockStorage();
    storeUserName(s, 'Bryan');
    const u = resolveUser(null, s);
    expect(u.id).toBe('known-bryan');
    expect(u.color).toBe('#2e7dd7');
  });

  it('?as= seeds the stored name so the param is one-time', () => {
    const s = mockStorage();
    resolveUser('bryan', s);
    const u = resolveUser(null, s);
    expect(u.name).toBe('Bryan');
    expect(u.id).toBe('known-bryan');
  });

  it('?as= does NOT overwrite an already-stored name (shared URLs must not rebrand the reviewer)', () => {
    const s = mockStorage();
    storeUserName(s, 'Casey');
    const withParam = resolveUser('bryan', s);
    expect(withParam.name).toBe('Bryan'); // param wins for THIS load only
    const after = resolveUser(null, s);
    expect(after.name).toBe('Casey');
  });

  it('caps stored names at 40 chars (UI maxlength is advisory only)', () => {
    const s = mockStorage();
    storeUserName(s, 'x'.repeat(500));
    expect(resolveUser(null, s).name.length).toBeLessThanOrEqual(40);
  });
});

describe('needsNamePrompt', () => {
  it('true on first arrival with nothing stored', () => {
    expect(needsNamePrompt(null, mockStorage())).toBe(true);
  });

  it('false when a known ?as= param is present', () => {
    expect(needsNamePrompt('bryan', mockStorage())).toBe(false);
  });

  it('false once a name is stored', () => {
    const s = mockStorage();
    storeUserName(s, 'Casey');
    expect(needsNamePrompt(null, s)).toBe(false);
  });

  it('false after the prompt was dismissed (stay anonymous, do not nag)', () => {
    const s = mockStorage();
    dismissNamePrompt(s);
    expect(needsNamePrompt(null, s)).toBe(false);
    expect(resolveUser(null, s).kind).toBe('anon');
  });

  it('ignores whitespace-only stored names', () => {
    const s = mockStorage();
    storeUserName(s, '   ');
    expect(needsNamePrompt(null, s)).toBe(true);
    expect(resolveUser(null, s).kind).toBe('anon');
  });
});
