import { spawnSync } from 'node:child_process';

/**
 * Read a generic-password entry from macOS Keychain.
 *
 * Set up the entry once with:
 *   security add-generic-password -a "$USER" -s "<serviceName>" -w "<value>"
 *
 * Returns the password or throws with that exact install hint embedded so
 * the operator can copy-paste a fix on the first failure.
 */
export function readKeychainPassword(serviceName: string): string {
  // Allow process-env override so tests can inject a token without
  // touching the real Keychain. Convention: env var name uppercases the
  // service and strips dashes — `cloudflare-api-token` → `CLOUDFLARE_API_TOKEN`.
  const envOverride = process.env[envVarName(serviceName)];
  if (envOverride) return envOverride;

  const proc = spawnSync('security', [
    'find-generic-password',
    '-a',
    process.env.USER ?? '',
    '-s',
    serviceName,
    '-w',
  ]);
  if (proc.status === 0) return proc.stdout.toString('utf8').trim();
  throw new Error(
    `Keychain entry "${serviceName}" not found. Add it with:\n` +
      `  security add-generic-password -a "$USER" -s "${serviceName}" -w "<paste-token>"\n` +
      `Or set ${envVarName(serviceName)} for one-off use.`,
  );
}

function envVarName(serviceName: string): string {
  return serviceName.toUpperCase().replace(/-/g, '_');
}
