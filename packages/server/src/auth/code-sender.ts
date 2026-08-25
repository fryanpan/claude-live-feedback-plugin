/**
 * Delivering a login code.
 *
 * There is NO email capability anywhere in this repo today, so this is a
 * seam and a default rather than an integration. The default prints the code
 * to the server log, which is what makes the whole login flow exercisable end
 * to end — start, read the log, verify, hold a session — before anybody has
 * picked a provider or created a key.
 *
 * WHY A LOG SENDER AND NOT A STUB THAT SUCCEEDS SILENTLY. A sender that
 * accepted the code and dropped it would make every login fail in the one way
 * nothing reports: the person waits for mail that was never sent, and the
 * server's own logs say the send went fine. Printing it is the honest version
 * of "not wired yet" — visibly not private, and visibly working.
 *
 * WHEN A PROVIDER IS PICKED, the shape it takes is decided and small:
 *
 *   - an HTTPS API call through `fetch`, and NO new npm dependency. Every
 *     provider worth using has a JSON endpoint; an SDK would add a dependency
 *     to a bundle this repo measures, to save a dozen lines.
 *   - the API key read from the macOS Keychain via `readKeychainPassword`,
 *     the same pattern as `scrub-haiku-api-key` and the Cloudflare token —
 *     never from a file in the repo, never from a commit.
 *   - a non-2xx response must THROW, so the route turns it into a 502. See
 *     below for why that is the load-bearing half.
 *
 * A SEND FAILURE IS A 502, NEVER A SILENT 200. This is the rule the interface
 * exists to enforce. A route that answered 200 whatever the sender did would
 * put the reviewer in front of a code entry box for a code that does not
 * exist, and the only evidence anywhere would be a line in a log nobody is
 * reading. `send` therefore rejects on failure rather than returning a
 * status: a sender cannot fail quietly by forgetting to check a flag.
 */

export interface CodeSendRequest {
  /** Normalized recipient address. */
  to: string;
  /** The six digits. Never logged by anything but the log sender. */
  code: string;
  /** How long the code stays usable, for the message body. */
  expiresInMinutes: number;
}

export interface CodeSender {
  /** Named for the boot log and for a health read — "log", "resend", … */
  readonly name: string;
  /**
   * Deliver the code, or REJECT. Resolving means it was handed to something
   * that accepted responsibility for delivering it; anything else must throw.
   */
  send(req: CodeSendRequest): Promise<void>;
}

/** Subject line, shared by every sender so the wording lives in one place. */
export function loginCodeSubject(code: string): string {
  return `${code} is your sign-in code`;
}

export function loginCodeText(req: CodeSendRequest): string {
  return [
    `Your sign-in code is ${req.code}.`,
    '',
    `It expires in ${req.expiresInMinutes} minutes and can be used once.`,
    'If you did not ask to sign in, you can ignore this message.',
  ].join('\n');
}

/**
 * The default: print the code to the server log.
 *
 * `log` is injectable so a test can read what was sent without scraping
 * stdout, and so a future caller could route it somewhere else.
 */
export function createLogCodeSender(log: (line: string) => void = console.log): CodeSender {
  return {
    name: 'log',
    async send(req: CodeSendRequest): Promise<void> {
      log(`[auth] login code for ${req.to}: ${req.code} (expires in ${req.expiresInMinutes}m)`);
    },
  };
}
