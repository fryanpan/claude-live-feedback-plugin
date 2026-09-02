/**
 * The shared signed-token construction, exercised through a fake format so
 * these tests say nothing about sessions, shares or origins. The real
 * formats' wire compatibility is proven in signed-token-compat.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import {
  type TokenFormat,
  mintToken,
  tokenClaims,
  tokenKey,
  verifyToken,
} from '../src/auth/signed-token.ts';

const BASE_KEY = 'a'.repeat(64);
const NOW = 1_800_000_000_000;

interface Ticket {
  holder: string;
  expiresAt: number | null;
}

/** A tagged, expiring format — the shape session and widget tokens share. */
const tagged: TokenFormat<Ticket> = {
  purpose: 'test-tagged',
  keyDomain: 'test-tagged-v1',
  tags: ['tk1'],
  encode: (t) => `tk1.${t.holder}.${t.expiresAt ?? 0}`,
  decode(payload) {
    const parts = payload.split('.');
    if (parts.length !== 3) return null;
    const [version, holder, expiresRaw] = parts;
    if (version !== 'tk1' || !holder) return null;
    const expiresAt = Number(expiresRaw);
    if (!Number.isSafeInteger(expiresAt)) return null;
    return { holder, expiresAt };
  },
  expiresAt: (t) => t.expiresAt,
};

/** An untagged, never-expiring format — the shape the share cookie has. */
const untagged: TokenFormat<string> = {
  purpose: 'test-untagged',
  keyDomain: null,
  tags: null,
  encode: (id) => id,
  decode: (payload) => payload,
  expiresAt: () => null,
};

describe('tokenKey', () => {
  it('derives a distinct key per domain, and passes the base key through when there is none', () => {
    expect(tokenKey(BASE_KEY, tagged)).not.toBe(BASE_KEY);
    expect(tokenKey(BASE_KEY, tagged)).toBe(tokenKey(BASE_KEY, tagged));
    expect(tokenKey(BASE_KEY, { keyDomain: 'other' })).not.toBe(tokenKey(BASE_KEY, tagged));
    expect(tokenKey(BASE_KEY, untagged)).toBe(BASE_KEY);
  });
});

describe('mint and verify', () => {
  const key = tokenKey(BASE_KEY, tagged);

  it('round-trips claims', () => {
    const value = mintToken(tagged, { holder: 'ada', expiresAt: NOW + 1000 }, key);
    const result = verifyToken(tagged, value, key, NOW);
    expect(result).toEqual({ ok: true, claims: { holder: 'ada', expiresAt: NOW + 1000 } });
  });

  it('appends the MAC after a final dot and leaves the payload readable', () => {
    const value = mintToken(tagged, { holder: 'ada', expiresAt: 0 }, key);
    expect(value.startsWith('tk1.ada.0.')).toBe(true);
  });

  it('names why it refused', () => {
    const value = mintToken(tagged, { holder: 'ada', expiresAt: NOW + 1000 }, key);
    expect(verifyToken(tagged, undefined, key, NOW)).toEqual({ ok: false, reason: 'absent' });
    expect(verifyToken(tagged, '', key, NOW)).toEqual({ ok: false, reason: 'absent' });
    expect(verifyToken(tagged, 'nodots', key, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyToken(tagged, `${value}x`, key, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyToken(tagged, value.replace('ada', 'eve'), key, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyToken(tagged, value, tokenKey('b'.repeat(64), tagged), NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('reports a genuine token for another tag as wrong_purpose, not as junk', () => {
    // Same key, a payload this format would never mint. Only a holder of the
    // key can produce one, which is what separates it from a forgery.
    const otherTag: TokenFormat<Ticket> = {
      ...tagged,
      tags: ['zz9'],
      encode: (t) => `zz9.${t.holder}`,
    };
    const stranger = mintToken(otherTag, { holder: 'ada', expiresAt: null }, key);
    expect(verifyToken(tagged, stranger, key, NOW)).toEqual({
      ok: false,
      reason: 'wrong_purpose',
    });
  });

  it('reports a signed but unparseable payload as malformed', () => {
    const shortPayload: TokenFormat<Ticket> = { ...tagged, encode: () => 'tk1.ada' };
    const bad = mintToken(shortPayload, { holder: 'ada', expiresAt: null }, key);
    expect(verifyToken(tagged, bad, key, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it("expires on the format's own clock, and not a moment before", () => {
    const value = mintToken(tagged, { holder: 'ada', expiresAt: NOW }, key);
    expect(verifyToken(tagged, value, key, NOW)).toEqual({ ok: false, reason: 'expired' });
    // Positive control: the same value one millisecond earlier still verifies.
    expect(verifyToken(tagged, value, key, NOW - 1).ok).toBe(true);
  });

  it('never expires a format that carries no expiry', () => {
    const value = mintToken(untagged, 'share-abc', BASE_KEY);
    const farFuture = NOW + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(verifyToken(untagged, value, BASE_KEY, farFuture)).toEqual({
      ok: true,
      claims: 'share-abc',
    });
  });

  it('keeps a payload with dots in it whole', () => {
    const value = mintToken(untagged, 'share.with.dots', BASE_KEY);
    expect(tokenClaims(untagged, value, BASE_KEY, NOW)).toBe('share.with.dots');
  });

  it('collapses every refusal to null for callers that authorize', () => {
    expect(tokenClaims(tagged, 'nodots', key, NOW)).toBeNull();
    expect(tokenClaims(tagged, null, key, NOW)).toBeNull();
  });
});
