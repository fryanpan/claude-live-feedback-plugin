/**
 * Delivering a login code through Cloudflare Email Sending.
 *
 * Chosen because this deployment already runs on Cloudflare and already pays
 * for the plan it needs, so it adds no vendor. It fits `CodeSender` without
 * bending it: one HTTPS call through `fetch`, the token read from the
 * Keychain at construction, and no new npm dependency — an SDK would add
 * weight to a bundle this repo measures in order to save a dozen lines.
 *
 * The service is in PUBLIC BETA. That is not a reason to avoid it, but it is
 * a reason to keep the wire shape in one function and the sender swappable,
 * which is what the seam was for. If the endpoint moves, one file changes.
 *
 * TWO RULES THIS FILE EXISTS TO HOLD:
 *
 * - **A refusal throws.** `code-sender.ts` explains why at length: a sender
 *   that resolved on a 4xx would leave somebody in front of a code box for a
 *   code that was never sent, with a cheerful log line as the only evidence.
 * - **The code and the token never reach an error message.** Errors get
 *   logged, pasted into tickets and quoted in chat. A six-digit login code in
 *   one is a live credential sitting somewhere nobody treats as secret, and a
 *   token in one is worse. The error says what the provider said and what
 *   status it said it with — enough to act on, and nothing that grants
 *   access.
 */
import { type CodeSender, loginCodeSubject, loginCodeText } from './code-sender.ts';

/** The subset of `fetch` this needs, so a test can hand it a function. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudflareCodeSenderConfig {
  /** Cloudflare account the sending domain is onboarded under. */
  accountId: string;
  /** The From address. Its domain must be onboarded, or every send 403s. */
  from: string;
  /** API token with email-sending permission. Never logged, never in an error. */
  token: string;
  fetch?: FetchLike;
}

function endpoint(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`;
}

/** What the provider said, reduced to something safe to write down. A body
 *  we cannot parse is truncated rather than dropped: "400" on its own has
 *  never once been enough to fix anything. */
function providerMessage(status: number, body: string): string {
  let detail = body.trim().slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ message?: string }> };
    const messages = (parsed.errors ?? [])
      .map((e) => e.message)
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
    if (messages.length > 0) detail = messages.join('; ');
  } catch {
    // Not JSON. The truncated body is still the most useful thing available.
  }
  return `Cloudflare refused the login code (HTTP ${status}): ${detail}`;
}

export function createCloudflareCodeSender(config: CloudflareCodeSenderConfig): CodeSender {
  const doFetch = config.fetch ?? ((url, init) => fetch(url, init));
  return {
    name: 'cloudflare',
    async send(req): Promise<void> {
      const body = JSON.stringify({
        from: config.from,
        to: [{ email: req.to }],
        subject: loginCodeSubject(req.code),
        text: loginCodeText(req),
      });
      // A transport failure propagates as-is: it already names the cause
      // ("ECONNREFUSED"), and wrapping it would only bury that behind our own
      // wording. Nothing secret is in it — the request never got sent.
      const res = await doFetch(endpoint(config.accountId), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body,
      });
      if (!res.ok) {
        throw new Error(providerMessage(res.status, await res.text()));
      }
    },
  };
}

/** What the boot decided, and why — the reason is what gets logged when there
 *  is no sender, so it has to be a sentence somebody can act on. */
export interface CodeSenderResolution {
  sender: CodeSender | null;
  /** Null when a sender was built. Otherwise names the missing piece. */
  reason: string | null;
}

/** The Keychain service holding the email-sending token. Separate from
 *  `cloudflare-api-token`, which the share module uses: these want different
 *  permissions, and a token scoped to one job cannot be widened by accident
 *  when the other one is rotated. */
export const EMAIL_TOKEN_SERVICE = 'cloudflare-email-api-token';

/**
 * Decide whether real email can be sent, WITHOUT throwing.
 *
 * Two of the three inputs are things only the operator can create — a domain
 * onboarded in the dashboard, and a scoped token — so partial configuration
 * is the normal state during setup, not an error. Falling back to the log
 * sender keeps login working end to end; naming the missing piece is what
 * stops that fallback from looking like a working install.
 *
 * The From address is deliberately NOT defaulted. Guessing a domain here
 * would produce a sender that builds cleanly at boot and 403s on the first
 * real login, which is the worst of both: configured-looking and broken.
 */
export function resolveCloudflareCodeSender(
  env: Record<string, string | undefined>,
  readToken: (service: string) => string,
): CodeSenderResolution {
  const from = env.AUTH_EMAIL_FROM;
  const accountId = env.AUTH_EMAIL_CF_ACCOUNT_ID ?? env.CF_ACCOUNT_ID;
  if (!from) {
    return {
      sender: null,
      reason:
        'no AUTH_EMAIL_FROM, so login codes still print to the log. Set it to an address on a domain onboarded for Cloudflare Email Sending.',
    };
  }
  if (!accountId) {
    return {
      sender: null,
      reason:
        'no CF_ACCOUNT_ID (or AUTH_EMAIL_CF_ACCOUNT_ID), so login codes still print to the log.',
    };
  }
  let token: string;
  try {
    token = readToken(EMAIL_TOKEN_SERVICE);
  } catch (err) {
    // The reader's own message carries the copy-pasteable `security
    // add-generic-password` line, which is the whole point of surfacing it
    // rather than replacing it with wording of our own.
    return {
      sender: null,
      reason: `login codes still print to the log — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { sender: createCloudflareCodeSender({ accountId, from, token }), reason: null };
}
