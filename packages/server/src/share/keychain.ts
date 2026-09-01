import { spawnSync } from 'node:child_process';

/**
 * Read a generic-password entry from macOS Keychain.
 *
 * Set up the entry once with:
 *   security add-generic-password -a "$USER" -s "<serviceName>" -w "<value>"
 *
 * The lookup is by SERVICE, tried under the login account first and then
 * under any account. The service name is what every install hint in this
 * repo agrees on; the account has not been — one hint said `-a "$USER"`, a
 * review item said `-a claude-workspaces` — and an entry stored under the
 * "wrong" account made a configured engine report itself as unconfigured
 * (Soniox, 2026-08-31). The account-scoped attempt stays first so a user
 * with two entries for one service gets their own.
 *
 * Returns the password or throws with that exact install hint embedded so
 * the operator can copy-paste a fix on the first failure.
 */
export function readKeychainPassword(
  serviceName: string,
  run: KeychainRunner = spawnKeychain,
): string {
  // Allow process-env override so tests can inject a token without
  // touching the real Keychain. Convention: env var name uppercases the
  // service and strips dashes — `cloudflare-api-token` → `CLOUDFLARE_API_TOKEN`.
  const envOverride = process.env[envVarName(serviceName)];
  if (envOverride) return envOverride;

  for (const args of keychainLookups(serviceName, process.env.USER)) {
    const result = run(args);
    if (result.status === 0) return result.stdout.trim();
  }
  throw new Error(
    `Keychain entry "${serviceName}" not found. Add it with:\n` +
      `  security add-generic-password -a "$USER" -s "${serviceName}" -w "<paste-token>"\n` +
      `Or set ${envVarName(serviceName)} for one-off use.`,
  );
}

/** What `security` is asked, in order: this account's entry, then any account's. */
export function keychainLookups(serviceName: string, account: string | undefined): string[][] {
  const byAccount = account
    ? [['find-generic-password', '-a', account, '-s', serviceName, '-w']]
    : [];
  return [...byAccount, ['find-generic-password', '-s', serviceName, '-w']];
}

/** The `security` invocation, injectable so a test never touches a real Keychain. */
export type KeychainRunner = (args: string[]) => { status: number | null; stdout: string };

function spawnKeychain(args: string[]): { status: number | null; stdout: string } {
  const proc = spawnSync('security', args);
  return { status: proc.status, stdout: proc.stdout ? proc.stdout.toString('utf8') : '' };
}

function envVarName(serviceName: string): string {
  return serviceName.toUpperCase().replace(/-/g, '_');
}
