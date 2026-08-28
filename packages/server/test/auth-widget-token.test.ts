import { describe, expect, it } from 'bun:test';
import {
  WIDGET_TOKEN_TTL_MS,
  mintWidgetToken,
  verifyWidgetToken,
  widgetTokenKey,
} from '../src/auth/widget-token.ts';
import { mintSession } from '../src/auth/session.ts';

const KEY = widgetTokenKey('test-cookie-key');

describe('widgetTokenKey', () => {
  it('is domain-separated from the raw cookie key', () => {
    expect(widgetTokenKey('k')).not.toBe('k');
    expect(widgetTokenKey('k')).toBe(widgetTokenKey('k'));
    expect(widgetTokenKey('k')).not.toBe(widgetTokenKey('k2'));
  });
});

describe('mintWidgetToken', () => {
  it('mints a verifiable token carrying the session it came from', () => {
    const now = 1_700_000_000_000;
    const session = mintSession('user-abc123', now);
    const token = mintWidgetToken(session, KEY, now);
    expect(token).not.toBeNull();
    const claims = verifyWidgetToken(token as string, KEY, now);
    expect(claims).toEqual({
      identityId: 'user-abc123',
      sessionId: session.sessionId as string,
      sessionIssuedAt: now,
      expiresAt: now + WIDGET_TOKEN_TTL_MS,
    });
  });

  it('refuses to mint from a session with no session id (surviving v1 cookie)', () => {
    // A v1 session cannot be individually revoked, so a token tied to it
    // could not die with a logout. The daily sliding refresh upgrades those
    // cookies; until then the popup answers "sign in again".
    const token = mintWidgetToken(
      { identityId: 'user-abc123', sessionId: null, issuedAt: 1, expiresAt: null },
      KEY,
    );
    expect(token).toBeNull();
  });
});

describe('verifyWidgetToken', () => {
  const now = 1_700_000_000_000;
  const session = mintSession('user-abc123', now);
  const token = mintWidgetToken(session, KEY, now) as string;

  it('refuses an expired token', () => {
    expect(verifyWidgetToken(token, KEY, now + WIDGET_TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(verifyWidgetToken(token, KEY, now + WIDGET_TOKEN_TTL_MS)).toBeNull();
  });

  it('refuses a tampered token', () => {
    // Flip the identity while keeping the mac — every field is signed.
    const swapped = token.replace('user-abc123', 'user-evil99');
    expect(swapped).not.toBe(token);
    expect(verifyWidgetToken(swapped, KEY, now)).toBeNull();
  });

  it('refuses a token signed with a different key', () => {
    expect(verifyWidgetToken(token, widgetTokenKey('other-cookie-key'), now)).toBeNull();
  });

  it('refuses a session cookie value — the formats never cross', () => {
    // A widget token is narrower than the session; a captured cookie value
    // must not double as one (and vice versa — different derived keys AND
    // different formats).
    expect(verifyWidgetToken('v2.user-abc123.sid.123.mac', KEY, now)).toBeNull();
    expect(verifyWidgetToken('', KEY, now)).toBeNull();
    expect(verifyWidgetToken('wt1', KEY, now)).toBeNull();
    expect(verifyWidgetToken(null, KEY, now)).toBeNull();
    expect(verifyWidgetToken(undefined, KEY, now)).toBeNull();
  });
});
