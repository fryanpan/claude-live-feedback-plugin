import { describe, expect, it } from 'vitest';
import { resolveUser } from '../src/identity.ts';

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
});
