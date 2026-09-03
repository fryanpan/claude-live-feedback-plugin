/**
 * The Google OAuth app this server signs calendar connections with, and the
 * Keychain the resulting refresh token rests in.
 *
 * Split out of `recall-calendar.ts` (A7), which is about Recall's Calendar V2
 * API — its client, its webhook, the connection store and the bot-eligibility
 * rules. This half never talks to Recall at all. It resolves two credentials,
 * builds the consent URL, exchanges the code, and keeps one token.
 *
 * SECRETS LIVE IN THE KEYCHAIN, NOT IN THE DATA DIR. A Google refresh token
 * is keystore-grade (security-posture rule 7): the app credentials and the
 * token share one service, under different accounts, and every `security`
 * call goes out as argv with no shell anywhere near it. That property is the
 * reason this is one file — the runner, the accounts and the service name
 * belong together, and a caller that could reach the service name without the
 * runner is a caller that could write the token somewhere else.
 *
 * Nothing below the seam reads any of it, so the move needed no back-import:
 * `recall-calendar.ts` does not import this file.
 */
import { spawnSync } from 'node:child_process';
import { type FetchLike, clip } from './recall.ts';
import { type KeychainRunner, readKeychainAccountPassword } from './share/keychain.ts';

// ---------------------------------------------------------------------------
// Google OAuth (server-side web flow)
// ---------------------------------------------------------------------------

/**
 * Keychain service holding the Google OAuth app credentials, one entry per
 * ACCOUNT under a single service — `-a client-id` and `-a client-secret` —
 * which is why `readKeychainPassword` (service-keyed, account = $USER) cannot
 * read them and the account-scoped reader below exists.
 */
export const GOOGLE_OAUTH_KEYCHAIN_SERVICE = 'claude-workspaces-google-oauth';

/** Env overrides, the deliberate per-launch choice — same rule as every key. */
export const GOOGLE_CLIENT_ID_ENV = 'GOOGLE_OAUTH_CLIENT_ID';
export const GOOGLE_CLIENT_SECRET_ENV = 'GOOGLE_OAUTH_CLIENT_SECRET';

/**
 * The one scope asked for. Read-only: Recall lists events and never writes,
 * and a consent screen asking to MANAGE calendars for a note-taking bot is
 * the kind of over-ask a person correctly refuses.
 */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export interface GoogleOauthCreds {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve the Google OAuth app credentials: env first, then Keychain, both
 * halves required. Null is the documented "calendar connect not configured"
 * state, never an error — the same shape `resolveRecallKey` gives a missing
 * key. One half without the other is ALSO null, because a client id with no
 * secret can begin a consent flow it can never finish.
 */
export function resolveGoogleOauthCreds(
  env: Record<string, string | undefined>,
  run?: KeychainRunner,
): GoogleOauthCreds | null {
  const clientId = env[GOOGLE_CLIENT_ID_ENV] || readKeychainAccount('client-id', run);
  const clientSecret = env[GOOGLE_CLIENT_SECRET_ENV] || readKeychainAccount('client-secret', run);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function readKeychainAccount(account: string, run?: KeychainRunner): string | null {
  return readKeychainAccountPassword(GOOGLE_OAUTH_KEYCHAIN_SERVICE, account, run);
}

/**
 * The consent flow plus the two token calls, bound to one OAuth app.
 *
 * Carries the app credentials because `POST /api/v2/calendars/` needs them in
 * its body — Recall refreshes the token itself, so the vendor holds the same
 * triple this object does. Nothing here ever logs or returns the secret.
 */
export interface GoogleOauthApp {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  consentUrl(state: string): string;
  /** Exchange the callback's code. Throws when Google returns no refresh token. */
  exchange(code: string): Promise<{ refreshToken: string }>;
  /** Revoke a granted token at Google. Idempotent at Google's end. */
  revoke(token: string): Promise<void>;
}

export function createGoogleOauthApp(opts: {
  creds: GoogleOauthCreds;
  redirectUri: string;
  fetch?: FetchLike;
}): GoogleOauthApp {
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const { clientId, clientSecret } = opts.creds;
  return {
    clientId,
    clientSecret,
    redirectUri: opts.redirectUri,
    consentUrl(state: string): string {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', opts.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPE);
      // Both required for a REFRESH token, which is the only thing this flow
      // is for: `offline` asks for one at all, and `prompt=consent` forces a
      // re-grant to carry one even when the user consented before — without
      // it a reconnect after a disconnect comes back with an access token
      // only, and the calendar create fails with nothing actionable.
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
      url.searchParams.set('state', state);
      return url.toString();
    },
    async exchange(code: string): Promise<{ refreshToken: string }> {
      const res = await doFetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: opts.redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });
      if (!res.ok) {
        // Google's error body names the grant problem (`invalid_grant`,
        // `redirect_uri_mismatch`) and never contains a credential.
        const detail = await res.text().catch(() => '');
        throw new Error(`google: code exchange failed (${res.status})${clip(detail)}`);
      }
      const body = (await res.json()) as Record<string, unknown>;
      const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
      if (!refreshToken) {
        throw new Error(
          'google: token response carried no refresh_token — the consent screen was ' +
            'skipped. Remove the prior grant at myaccount.google.com/permissions and connect again.',
        );
      }
      return { refreshToken };
    },
    async revoke(token: string): Promise<void> {
      const res = await doFetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
      // An already-revoked token answers 400; that is the state we wanted.
      if (!res.ok && res.status !== 400) {
        const detail = await res.text().catch(() => '');
        throw new Error(`google: revoke failed (${res.status})${clip(detail)}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Where the refresh token rests between connect and disconnect
// ---------------------------------------------------------------------------

/**
 * The refresh token is handed to Recall at connect; the ONLY reason a copy
 * stays on this machine is that disconnect promises a real revoke at Google,
 * and Google's revoke endpoint wants the token itself. An OAuth refresh token
 * is a keystore-grade credential (security-posture rule 7), so the real vault
 * is the macOS Keychain — same service as the app credentials, account
 * `refresh-token` — not a file in the data dir.
 */
export interface RefreshTokenVault {
  save(token: string): void;
  load(): string | null;
  clear(): void;
}

const VAULT_ACCOUNT = 'refresh-token';

export function createKeychainRefreshTokenVault(run?: KeychainRunner): RefreshTokenVault {
  const spawn = run ?? defaultKeychainRunner;
  return {
    save(token: string): void {
      // `-U` updates in place, so a reconnect replaces the old grant's token
      // rather than erroring on the duplicate.
      const result = spawn([
        'add-generic-password',
        '-U',
        '-a',
        VAULT_ACCOUNT,
        '-s',
        GOOGLE_OAUTH_KEYCHAIN_SERVICE,
        '-w',
        token,
      ]);
      if (result.status !== 0) throw new Error('keychain: could not store the refresh token');
    },
    load(): string | null {
      const result = spawn([
        'find-generic-password',
        '-a',
        VAULT_ACCOUNT,
        '-s',
        GOOGLE_OAUTH_KEYCHAIN_SERVICE,
        '-w',
      ]);
      return result.status === 0 ? result.stdout.trim() || null : null;
    },
    clear(): void {
      // A missing entry is the state clear() promises; its "failure" is fine.
      spawn(['delete-generic-password', '-a', VAULT_ACCOUNT, '-s', GOOGLE_OAUTH_KEYCHAIN_SERVICE]);
    },
  };
}

function defaultKeychainRunner(args: string[]): { status: number | null; stdout: string } {
  // argv, never a shell, so the token is not shell-interpolated anywhere.
  const proc = spawnSync('security', args);
  return { status: proc.status, stdout: proc.stdout ? proc.stdout.toString('utf8') : '' };
}
