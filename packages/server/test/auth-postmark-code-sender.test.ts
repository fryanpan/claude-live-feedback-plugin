/**
 * Sending a login code through Postmark.
 *
 * The provider replaced Cloudflare Email Sending (Bryan, 2026-08-28, on the
 * design doc) but the seam is the same shape — an HTTPS call over `fetch`,
 * the token out of the Keychain, no new npm dependency — and so are the two
 * properties these tests exist to hold, because they are easy to get wrong
 * and impossible to notice afterwards:
 *
 * 1. **A failed send throws.** The route turns a rejection into a 502. A
 *    sender that resolved on a 4xx would leave somebody staring at a code
 *    entry box for a code that was never sent, with a happy log line as the
 *    only trace. A send that never answers is the same failure in slow
 *    motion, so it is cut off (5s) and thrown too.
 * 2. **The code never appears in an error.** Errors get logged, attached to
 *    tickets and pasted into chat; a six-digit code in one is a live
 *    credential in a place nobody is treating as secret.
 */
import { describe, expect, it } from 'bun:test';
import {
  createPostmarkCodeSender,
  resolvePostmarkCodeSender,
} from '../src/auth/postmark-code-sender.ts';

const config = {
  from: 'no-reply@example.com',
  token: 'tok-secret',
};

const req = { to: 'someone@example.com', code: '428550', expiresInMinutes: 10 };

function okFetch(seen: { url?: string; init?: RequestInit }) {
  return async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify({ ErrorCode: 0, Message: 'OK' }), { status: 200 });
  };
}

describe('the Postmark login-code sender', () => {
  it('names itself for the boot log and the health read', () => {
    const sender = createPostmarkCodeSender({ ...config, fetch: okFetch({}) });
    expect(sender.name).toBe('postmark');
  });

  it('posts the code to the Postmark email endpoint with the server token header', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const sender = createPostmarkCodeSender({ ...config, fetch: okFetch(seen) });
    await sender.send(req);

    expect(seen.url).toBe('https://api.postmarkapp.com/email');
    expect(seen.init?.method).toBe('POST');
    const headers = new Headers(seen.init?.headers);
    expect(headers.get('x-postmark-server-token')).toBe('tok-secret');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('carries the recipient, the sender, the code and how long it lasts', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const sender = createPostmarkCodeSender({ ...config, fetch: okFetch(seen) });
    await sender.send(req);

    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    expect(body.From).toBe('no-reply@example.com');
    expect(body.To).toBe('someone@example.com');
    expect(String(body.Subject)).toContain('428550');
    expect(String(body.TextBody)).toContain('428550');
    expect(String(body.TextBody)).toContain('10 minutes');
    expect(body.MessageStream).toBe('outbound');
  });

  it('throws when the provider refuses, so the route can answer 502', async () => {
    const sender = createPostmarkCodeSender({
      ...config,
      fetch: async () =>
        new Response(JSON.stringify({ ErrorCode: 400, Message: 'sender signature not defined' }), {
          status: 422,
        }),
    });
    await expect(sender.send(req)).rejects.toThrow(/sender signature not defined/);
  });

  it('throws when the transport itself fails rather than swallowing it', async () => {
    const sender = createPostmarkCodeSender({
      ...config,
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(sender.send(req)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('cuts off a send that never answers, and says how long it waited', async () => {
    const sender = createPostmarkCodeSender({
      ...config,
      timeoutMs: 20,
      // A fetch that hangs until the timeout signal fires — the shape of a
      // provider outage, which must not park the login route forever.
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    await expect(sender.send(req)).rejects.toThrow(/20ms/);
  });

  it('keeps the code and the token out of the error it throws', async () => {
    const sender = createPostmarkCodeSender({
      ...config,
      fetch: async () => new Response('{"ErrorCode":300,"Message":"bad request"}', { status: 422 }),
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
    expect(message).toContain('422');
    expect(message).toContain('bad request');
  });

  /**
   * The test above only proves we do not ADD the secrets ourselves. This one
   * covers the case that actually leaks: the provider quoting our own request
   * back at us. Postmark receives the code in both the subject and the body,
   * so any validation error that echoes a rejected field carries a live login
   * code into a string that gets logged, pasted into a ticket, and quoted in
   * chat. Whatever comes back over the wire is untrusted text, not a message.
   */
  it('redacts the code when the provider echoes it back in its own error', async () => {
    const sender = createPostmarkCodeSender({
      ...config,
      fetch: async () =>
        new Response(
          JSON.stringify({
            ErrorCode: 300,
            Message: 'Subject rejected: "428550 is your sign-in code"',
          }),
          { status: 422 },
        ),
    });
    let message = '';
    try {
      await sender.send(req);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('428550');
    expect(message).toContain('[redacted]');
    // Still says which field the provider objected to.
    expect(message).toContain('Subject rejected');
    expect(message).toContain('422');
  });

  it('redacts the token when a non-JSON body echoes the token header', async () => {
    const sender = createPostmarkCodeSender({
      ...config,
      fetch: async () =>
        new Response('Unauthorized: token tok-secret is not valid for this server', {
          status: 401,
        }),
    });
    let message = '';
    try {
      await sender.send(req);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('tok-secret');
    expect(message).toContain('[redacted]');
    expect(message).toContain('401');
  });
});

/**
 * Choosing the sender at boot.
 *
 * The resolver exists so that "not configured" is a SENTENCE rather than a
 * crash or a silence. Both inputs are things only the operator can create —
 * a verified sender signature and a server token — so the common state
 * during setup is partial configuration, and the useful behaviour there is to
 * keep the log sender and say precisely which piece is missing. A boot that
 * threw would take the whole server down over email; one that fell back
 * quietly would look identical to a working install right up until somebody
 * waited for mail.
 */
describe('choosing the login-code sender at boot', () => {
  const full = { AUTH_EMAIL_FROM: 'no-reply@example.com' };
  const readsToken = () => 'tok-secret';
  const noToken = () => {
    throw new Error('Keychain entry "postmark-api-token" not found. Add it with: …');
  };

  it('builds the Postmark sender when the address and the token are both there', () => {
    const { sender, reason } = resolvePostmarkCodeSender(full, readsToken);
    expect(sender?.name).toBe('postmark');
    expect(reason).toBeNull();
  });

  it('names the missing From address rather than guessing a domain', () => {
    const { sender, reason } = resolvePostmarkCodeSender({}, readsToken);
    expect(sender).toBeNull();
    expect(reason).toContain('AUTH_EMAIL_FROM');
  });

  it('passes the keychain hint through when the token is not set up yet', () => {
    const { sender, reason } = resolvePostmarkCodeSender(full, noToken);
    expect(sender).toBeNull();
    expect(reason).toContain('postmark-api-token');
  });

  it('never puts the token in the reason it reports', () => {
    const { reason } = resolvePostmarkCodeSender({}, readsToken);
    expect(reason ?? '').not.toContain('tok-secret');
  });
});
