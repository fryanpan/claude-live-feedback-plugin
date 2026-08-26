/**
 * Sending a login code through Cloudflare Email Sending.
 *
 * The provider was chosen because it is infrastructure this deployment
 * already pays for, and because `CodeSender` was designed for exactly this
 * shape — an HTTPS call over `fetch`, the token out of the Keychain, no new
 * npm dependency. Everything here is about the two properties that are easy
 * to get wrong and impossible to notice afterwards:
 *
 * 1. **A failed send throws.** The route turns a rejection into a 502. A
 *    sender that resolved on a 4xx would leave somebody staring at a code
 *    entry box for a code that was never sent, with a happy log line as the
 *    only trace.
 * 2. **The code never appears in an error.** Errors get logged, attached to
 *    tickets and pasted into chat; a six-digit code in one is a live
 *    credential in a place nobody is treating as secret.
 *
 * The wire shape is from Cloudflare's public-beta docs. It is beta, so the
 * request is built in one place and the sender stays swappable — that is the
 * point of the seam, not a hedge.
 */
import { describe, expect, it } from 'bun:test';
import {
  createCloudflareCodeSender,
  resolveCloudflareCodeSender,
} from '../src/auth/cloudflare-code-sender.ts';

const config = {
  accountId: 'acct-123',
  from: 'no-reply@example.com',
  token: 'tok-secret',
};

const req = { to: 'someone@example.com', code: '428550', expiresInMinutes: 10 };

function okFetch(seen: { url?: string; init?: RequestInit }) {
  return async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
}

describe('the Cloudflare login-code sender', () => {
  it('names itself for the boot log and the health read', () => {
    const sender = createCloudflareCodeSender({ ...config, fetch: okFetch({}) });
    expect(sender.name).toBe('cloudflare');
  });

  it('posts the code to the account it was configured with, as a bearer call', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const sender = createCloudflareCodeSender({ ...config, fetch: okFetch(seen) });
    await sender.send(req);

    expect(seen.url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct-123/email/sending/send',
    );
    expect(seen.init?.method).toBe('POST');
    const headers = new Headers(seen.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok-secret');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('carries the recipient, the sender, the code and how long it lasts', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const sender = createCloudflareCodeSender({ ...config, fetch: okFetch(seen) });
    await sender.send(req);

    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    expect(body.from).toBe('no-reply@example.com');
    expect(JSON.stringify(body.to)).toContain('someone@example.com');
    expect(String(body.subject)).toContain('428550');
    expect(String(body.text)).toContain('428550');
    expect(String(body.text)).toContain('10 minutes');
  });

  it('throws when the provider refuses, so the route can answer 502', async () => {
    const sender = createCloudflareCodeSender({
      ...config,
      fetch: async () =>
        new Response(JSON.stringify({ errors: [{ message: 'domain not onboarded' }] }), {
          status: 403,
        }),
    });
    await expect(sender.send(req)).rejects.toThrow(/domain not onboarded/);
  });

  it('throws when the transport itself fails rather than swallowing it', async () => {
    const sender = createCloudflareCodeSender({
      ...config,
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(sender.send(req)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('keeps the code and the token out of the error it throws', async () => {
    const sender = createCloudflareCodeSender({
      ...config,
      fetch: async () => new Response('{"errors":[{"message":"bad request"}]}', { status: 400 }),
    });
    let message = '';
    try {
      await sender.send(req);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('428550');
    expect(message).not.toContain('tok-secret');
    // It still has to say enough to act on.
    expect(message).toContain('400');
    expect(message).toContain('bad request');
  });
});

/**
 * Choosing the sender at boot.
 *
 * The resolver exists so that "not configured" is a SENTENCE rather than a
 * crash or a silence. Two of the three inputs are things only the operator
 * can create — an onboarded domain and a scoped token — so the common state
 * during setup is partial configuration, and the useful behaviour there is to
 * keep the log sender and say precisely which piece is missing. A boot that
 * threw would take the whole server down over email; one that fell back
 * quietly would look identical to a working install right up until somebody
 * waited for mail.
 */
describe('choosing the login-code sender at boot', () => {
  const full = {
    AUTH_EMAIL_FROM: 'no-reply@example.com',
    CF_ACCOUNT_ID: 'acct-123',
  };
  const readsToken = () => 'tok-secret';
  const noToken = () => {
    throw new Error('Keychain entry "cloudflare-email-api-token" not found. Add it with: …');
  };

  it('builds the Cloudflare sender when the address, the account and the token are all there', () => {
    const { sender, reason } = resolveCloudflareCodeSender(full, readsToken);
    expect(sender?.name).toBe('cloudflare');
    expect(reason).toBeNull();
  });

  it('names the missing From address rather than guessing a domain', () => {
    const { sender, reason } = resolveCloudflareCodeSender(
      { CF_ACCOUNT_ID: 'acct-123' },
      readsToken,
    );
    expect(sender).toBeNull();
    expect(reason).toContain('AUTH_EMAIL_FROM');
  });

  it('names the missing account', () => {
    const { sender, reason } = resolveCloudflareCodeSender(
      { AUTH_EMAIL_FROM: 'no-reply@example.com' },
      readsToken,
    );
    expect(sender).toBeNull();
    expect(reason).toContain('CF_ACCOUNT_ID');
  });

  it('passes the keychain hint through when the token is not set up yet', () => {
    const { sender, reason } = resolveCloudflareCodeSender(full, noToken);
    expect(sender).toBeNull();
    expect(reason).toContain('cloudflare-email-api-token');
  });

  it('never puts the token in the reason it reports', () => {
    const { reason } = resolveCloudflareCodeSender({ CF_ACCOUNT_ID: 'acct-123' }, readsToken);
    expect(reason ?? '').not.toContain('tok-secret');
  });

  it('prefers a dedicated email account id over the shared one', () => {
    const { sender } = resolveCloudflareCodeSender(
      { ...full, AUTH_EMAIL_CF_ACCOUNT_ID: 'acct-email' },
      readsToken,
    );
    expect(sender).not.toBeNull();
  });
});
