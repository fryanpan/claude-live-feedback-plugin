/**
 * The predicate that lets Recall's two callbacks past Cloudflare Access on
 * the operator's own proxied hostname — and, far more importantly, lets
 * nothing else past.
 *
 * Two axes, both load-bearing:
 *
 *   1. SHAPE. Only `GET /recall/<32 hex>` and `POST /api/recall/status`, both
 *      matched whole. Every near-miss below was chosen because a sloppier
 *      match (prefix, `startsWith`, a decoded path, a loose token regex)
 *      would have accepted it and put an unauthenticated door on the public
 *      internet.
 *   2. CREDENTIAL. Each exemption is conditional on the credential it rests
 *      on actually being configured. The false-flag cases are the ones that
 *      must go red if the conditions are ever dropped — an "it works" test
 *      alone passes against a build that exempts both paths always.
 *
 * The HTTP layer is covered separately in recall-callback-gate-http.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { recallCallbackExempt } from '../src/middleware/recall-callback-gate.ts';

/** A token shaped exactly as `mintToken` produces one. */
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const BOTH = { relayConfigured: true, webhookSecretSet: true };
const NEITHER = { relayConfigured: false, webhookSecretSet: false };

describe('the two callbacks, when their credentials are configured', () => {
  it('exempts the websocket upgrade Recall dials', () => {
    expect(recallCallbackExempt(`/recall/${TOKEN}`, 'GET', BOTH)).toBe(true);
    // The relay's own flag is the only one that matters for this path.
    expect(
      recallCallbackExempt(`/recall/${TOKEN}`, 'GET', {
        relayConfigured: true,
        webhookSecretSet: false,
      }),
    ).toBe(true);
  });

  it('exempts the signed status webhook', () => {
    expect(recallCallbackExempt('/api/recall/status', 'POST', BOTH)).toBe(true);
    expect(
      recallCallbackExempt('/api/recall/status', 'POST', {
        relayConfigured: false,
        webhookSecretSet: true,
      }),
    ).toBe(true);
  });

  it('compares the method case-insensitively, not the path', () => {
    // A method arrives uppercase over HTTP, but the predicate is called with
    // whatever the caller has; the path must never be folded, because a
    // token is lowercase hex by construction.
    expect(recallCallbackExempt(`/recall/${TOKEN}`, 'get', BOTH)).toBe(true);
    expect(recallCallbackExempt(`/recall/${TOKEN.toUpperCase()}`, 'GET', BOTH)).toBe(false);
  });
});

describe('the credential conditions — the guards that must not be dropped', () => {
  it('refuses the websocket when the relay is NOT configured', () => {
    // Nothing can have minted a token on this server, so there is no
    // credential behind the exemption — only a hole.
    expect(
      recallCallbackExempt(`/recall/${TOKEN}`, 'GET', {
        relayConfigured: false,
        webhookSecretSet: true,
      }),
    ).toBe(false);
  });

  it('refuses the status webhook when no signing secret is set', () => {
    // With the secret unset the route accepts UNSIGNED bodies. That mode
    // must never be reachable from the tunnel without an Access token.
    expect(
      recallCallbackExempt('/api/recall/status', 'POST', {
        relayConfigured: true,
        webhookSecretSet: false,
      }),
    ).toBe(false);
  });

  it('refuses both when nothing is configured', () => {
    expect(recallCallbackExempt(`/recall/${TOKEN}`, 'GET', NEITHER)).toBe(false);
    expect(recallCallbackExempt('/api/recall/status', 'POST', NEITHER)).toBe(false);
  });
});

describe('near-misses fail closed', () => {
  it('refuses a token of the wrong shape', () => {
    expect(recallCallbackExempt('/recall/abc', 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt(`/recall/${TOKEN.slice(0, 31)}`, 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt(`/recall/${TOKEN}0`, 'GET', BOTH)).toBe(false);
    // Non-hex, right length.
    expect(recallCallbackExempt('/recall/g1b2c3d4e5f60718293a4b5c6d7e8f90', 'GET', BOTH)).toBe(
      false,
    );
  });

  it('refuses anything under, beside or around the token', () => {
    expect(recallCallbackExempt(`/recall/${TOKEN}/x`, 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt(`/recall/${TOKEN}/`, 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt('/recall/', 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt('/recall', 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt(`//recall/${TOKEN}`, 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt(`/api/recall/${TOKEN}`, 'GET', BOTH)).toBe(false);
  });

  it('refuses a percent-encoded spelling of a real token', () => {
    // The ROUTE decodes before it looks the token up, so this would reach a
    // real bot. The gate deliberately does not: Recall dials the literal URL
    // we minted, so the encoded form is never a real caller.
    expect(recallCallbackExempt(`/recall/%61${TOKEN.slice(1)}`, 'GET', BOTH)).toBe(false);
  });

  it('refuses the wrong method on either path', () => {
    expect(recallCallbackExempt(`/recall/${TOKEN}`, 'POST', BOTH)).toBe(false);
    expect(recallCallbackExempt(`/recall/${TOKEN}`, 'DELETE', BOTH)).toBe(false);
    expect(recallCallbackExempt('/api/recall/status', 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt('/api/recall/status', 'PUT', BOTH)).toBe(false);
  });

  it('refuses near-misses of the status path', () => {
    expect(recallCallbackExempt('/api/recall/status/', 'POST', BOTH)).toBe(false);
    expect(recallCallbackExempt('//api/recall/status', 'POST', BOTH)).toBe(false);
    expect(recallCallbackExempt('/api/recall/status/x', 'POST', BOTH)).toBe(false);
    expect(recallCallbackExempt('/api/recall/statuses', 'POST', BOTH)).toBe(false);
    expect(recallCallbackExempt('/api/recall', 'POST', BOTH)).toBe(false);
  });

  it('refuses the rest of the product, which is the whole point', () => {
    // The routes an unauthenticated tunnel visitor would most want.
    expect(recallCallbackExempt('/api/docs', 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt('/api/deploy', 'POST', BOTH)).toBe(false);
    expect(recallCallbackExempt('/', 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt('/y/some-doc', 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt('/audio/some-doc', 'GET', BOTH)).toBe(false);
    expect(recallCallbackExempt('', 'GET', BOTH)).toBe(false);
  });
});
