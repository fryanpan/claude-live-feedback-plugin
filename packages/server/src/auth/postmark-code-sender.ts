/**
 * Delivering a login code through Postmark.
 *
 * Postmark replaced Cloudflare Email Sending here (Bryan, 2026-08-28, on the
 * design doc) — the Cloudflare service never left public beta and was never
 * configured in prod, so the swap is exactly what the `CodeSender` seam was
 * for: one HTTPS call through `fetch`, the token read from the Keychain at
 * boot, and no new npm dependency — an SDK would add weight to a bundle this
 * repo measures in order to save a dozen lines.
 *
 * TWO RULES THIS FILE EXISTS TO HOLD:
 *
 * - **A refusal throws.** `code-sender.ts` explains why at length: a sender
 *   that resolved on a 4xx would leave somebody in front of a code box for a
 *   code that was never sent, with a cheerful log line as the only evidence.
 *   A send that never answers is the same failure in slow motion, so every
 *   request carries a timeout (5s) and hitting it throws too.
 * - **The code and the token never reach an error message.** Errors get
 *   logged, pasted into tickets and quoted in chat. A six-digit login code in
 *   one is a live credential sitting somewhere nobody treats as secret, and a
 *   token in one is worse. The error says what the provider said and what
 *   status it said it with — enough to act on, and nothing that grants
 *   access. Note that holding this rule takes more than declining to write
 *   the code down: the provider is handed the code and can quote it back, so
 *   its reply is redacted rather than trusted.
 */
import { type CodeSender, loginCodeSubject, loginCodeText } from './code-sender.ts';

/** The subset of `fetch` this needs, so a test can hand it a function. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const ENDPOINT = 'https://api.postmarkapp.com/email';

/** How long a send may take before it is cut off and thrown. Postmark
 *  answers in well under a second; a login route parked behind a hung
 *  provider is the "waiting for mail that never comes" failure with extra
 *  steps. */
export const SEND_TIMEOUT_MS = 5_000;

export interface PostmarkCodeSenderConfig {
  /** The From address. Must match a verified sender signature, or every send 422s. */
  from: string;
  /** Server API token. Never logged, never in an error. */
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Strike the live secrets out of text we did not write.
 *
 * Not writing the code into an error ourselves is the easy half. The half
 * that actually leaks is the provider quoting our own request back: it
 * receives the code in both the subject and the body, so any validation error
 * naming the field it rejected carries a working login code into a string
 * that gets logged, pasted into a ticket, and quoted in chat. A response body
 * is untrusted text, so it is filtered rather than trusted to behave.
 *
 * Over-redaction is the safe direction. If a six-digit code happens to appear
 * inside an unrelated id, that id comes back partly starred and the error is
 * still actionable; the other way round hands out a credential.
 */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue; // replaceAll('') would splice the marker between every character.
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

/** What the provider said, reduced to something safe to write down. A body
 *  we cannot parse is truncated rather than dropped: "422" on its own has
 *  never once been enough to fix anything. */
function providerMessage(status: number, body: string, secrets: readonly string[]): string {
  let detail = body.trim().slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { Message?: string };
    if (typeof parsed.Message === 'string' && parsed.Message.length > 0) {
      detail = parsed.Message;
    }
  } catch {
    // Not JSON. The truncated body is still the most useful thing available.
  }
  return `Postmark refused the login code (HTTP ${status}): ${redact(detail, secrets)}`;
}

export function createPostmarkCodeSender(config: PostmarkCodeSenderConfig): CodeSender {
  const doFetch = config.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = config.timeoutMs ?? SEND_TIMEOUT_MS;
  return {
    name: 'postmark',
    async send(req): Promise<void> {
      const body = JSON.stringify({
        From: config.from,
        To: req.to,
        Subject: loginCodeSubject(req.code),
        TextBody: loginCodeText(req),
        MessageStream: 'outbound',
      });
      let res: Response;
      try {
        // A transport failure propagates as-is: it already names the cause
        // ("ECONNREFUSED"), and wrapping it would only bury that behind our
        // own wording. Nothing secret is in it — the request never got sent.
        res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'x-postmark-server-token': config.token,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Except the timeout, whose stock message ("The operation timed
        // out") names neither the provider nor the wait.
        if (err instanceof Error && err.name === 'TimeoutError') {
          throw new Error(`Postmark did not answer within ${timeoutMs}ms`);
        }
        throw err;
      }
      if (!res.ok) {
        throw new Error(providerMessage(res.status, await res.text(), [req.code, config.token]));
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

/** The Keychain service holding the Postmark server token. Its own entry —
 *  a token scoped to one job cannot be widened by accident when another
 *  service's token is rotated. */
export const EMAIL_TOKEN_SERVICE = 'postmark-api-token';

/**
 * Decide whether real email can be sent, WITHOUT throwing.
 *
 * Both inputs are things only the operator can create — a verified sender
 * signature in the Postmark dashboard, and a server token — so partial
 * configuration is the normal state during setup, not an error. Falling back
 * to the log sender keeps login working end to end; naming the missing piece
 * is what stops that fallback from looking like a working install.
 *
 * The From address is deliberately NOT defaulted. Guessing an address here
 * would produce a sender that builds cleanly at boot and 422s on the first
 * real login, which is the worst of both: configured-looking and broken.
 */
export function resolvePostmarkCodeSender(
  env: Record<string, string | undefined>,
  readToken: (service: string) => string,
): CodeSenderResolution {
  const from = env.AUTH_EMAIL_FROM;
  if (!from) {
    return {
      sender: null,
      reason:
        'no AUTH_EMAIL_FROM, so login codes still print to the log. Set it to an address with a verified Postmark sender signature.',
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
  return { sender: createPostmarkCodeSender({ from, token }), reason: null };
}
