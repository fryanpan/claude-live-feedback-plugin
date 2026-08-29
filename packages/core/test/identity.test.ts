import { describe, expect, it } from 'vitest';
import {
  GUEST_ANIMALS,
  authorLabel,
  dismissNamePrompt,
  guestNameFor,
  needsNamePrompt,
  resolveUser,
  storeUserName,
} from '../src/identity.ts';

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
    expect(u1.name).toMatch(/^Anonymous [A-Z]/);
    expect(u1.name).toBe(u2.name);
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

describe('guest names', () => {
  // A guest who lands and doesn't pick a name still needs to be referable —
  // "Anon-a3f9k2" is an id with a human-readable costume on, and nobody can
  // say it out loud in a review. An animal is memorable and pronounceable.
  it('gives an unnamed guest a readable animal name', () => {
    const u = resolveUser(null, mockStorage());
    expect(u.kind).toBe('anon');
    expect(u.name).toMatch(/^Anonymous [A-Z][a-z]+$/);
  });

  it('keeps the SAME animal for the same browser across visits', () => {
    // The anon id is already stable and their earlier comments hang off it;
    // a name that reshuffled on reload would make one person look like many.
    const s = mockStorage();
    const first = resolveUser(null, s);
    const second = resolveUser(null, s);
    expect(second.name).toBe(first.name);
    expect(guestNameFor('abc123')).toBe(guestNameFor('abc123'));
  });

  it('gives different ids different animals often enough to be useful', () => {
    const names = new Set(Array.from({ length: 200 }, (_, i) => guestNameFor(`id-${i}`)));
    // Not a uniqueness guarantee — a hash over a finite list collides — but a
    // handful of concurrent guests should almost never clash.
    expect(names.size).toBeGreaterThan(GUEST_ANIMALS.length / 2);
  });

  it('every animal in the list is a single capitalized word', () => {
    for (const a of GUEST_ANIMALS) expect(a).toMatch(/^[A-Z][a-z]+$/);
    expect(new Set(GUEST_ANIMALS).size).toBe(GUEST_ANIMALS.length);
    expect(GUEST_ANIMALS.length).toBeGreaterThanOrEqual(24);
  });

  it('a guest who then names themselves drops the animal', () => {
    const s = mockStorage();
    expect(resolveUser(null, s).name).toMatch(/^Anonymous /);
    storeUserName(s, 'Casey');
    expect(resolveUser(null, s).name).toBe('Casey');
  });

  it('handles an empty id without throwing', () => {
    expect(guestNameFor('')).toMatch(/^Anonymous [A-Z][a-z]+$/);
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

describe('authorLabel — the shared identity renders as "Unnamed agent"', () => {
  it('labels the category and passes every real name through', () => {
    expect(authorLabel({ id: 'known-agent', name: 'Agent' })).toBe('Unnamed agent');
    expect(authorLabel({ id: 'agent', name: 'agent' })).toBe('Unnamed agent');
    expect(authorLabel({ id: 'agent-relay', name: 'Relay' })).toBe('Relay');
    expect(authorLabel({ id: 'known-bryan', name: 'Bryan' })).toBe('Bryan');
    expect(authorLabel({ id: 'anon-x', name: '' })).toBe('');
  });
});
