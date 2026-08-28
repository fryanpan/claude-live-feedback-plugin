/**
 * Signed share URLs — the S3-presigned pattern.
 *
 * A share link is `/share/<id>?exp=<unix-seconds>&sig=<hex>`: the id says
 * which share, `exp` says until when, and `sig` is an HMAC-SHA256 over
 * `<id>.<exp>` under a key only the server (and the edge Worker, as a deploy
 * secret) holds. Nothing in the URL is secret on its own — the signature is
 * the credential, and it covers the expiry, so neither can be changed
 * without the other going stale.
 *
 * Two independent verifiers run the SAME check: the Cloudflare Worker in
 * `infra/share-link-worker/` gates `/share/*` at the edge, and the server
 * re-validates on every request as defense-in-depth — the app never trusts
 * that the Worker ran. Both use Web Crypto (`crypto.subtle`) so one
 * implementation shape verifies in both runtimes; the HMAC key material is
 * the UTF-8 bytes of the key STRING (the hex file content as-is, no hex
 * decode), because that is the one convention a copy-pasted Worker secret
 * cannot get wrong.
 *
 * The URL's `exp` is embedded at issue time from the share's `expiresAt`,
 * so the existing TTL tooling feeds it; the registry's own `expiresAt` is
 * still re-checked per request, which is what makes early revocation work
 * (a revoked share refuses even a validly signed URL).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const URL_KEY_FILENAME = 'share-url.key';

/**
 * Load the URL-signing key, generating it on first use. Mode 600 — anyone
 * who can read it can mint a URL for any share. Deliberately NOT the
 * session-cookie key: this one leaves the box (Bryan sets it as the edge
 * Worker's secret), and it must not carry the power to mint session cookies
 * with it.
 */
export function loadUrlKey(dataDir: string): string {
  const path = join(dataDir, URL_KEY_FILENAME);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const key = randomBytes(32).toString('hex');
  writeFileSync(path, key, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // pre-existing file keeps its old mode otherwise
  } catch {}
  return key;
}

/** `/share/<id>?exp=<unix-seconds>&sig=<hex>` for a share expiring at `expiresAtMs`. */
export async function signedSharePath(
  shareId: string,
  expiresAtMs: number,
  key: string,
): Promise<string> {
  const exp = String(Math.floor(expiresAtMs / 1000));
  const sig = hex(await crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), payload(shareId, exp)));
  return `/share/${encodeURIComponent(shareId)}?exp=${exp}&sig=${sig}`;
}

/**
 * Verify a presented (id, exp, sig) tuple: well-formed, signature genuine,
 * not yet expired. Malformed input answers false rather than throwing —
 * every caller is holding attacker-typed strings. `crypto.subtle.verify`
 * compares in constant time.
 */
export async function verifySignedShare(
  shareId: string,
  exp: string,
  sig: string,
  key: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!/^\d{1,15}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Number(exp) * 1000 <= nowMs) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(key, 'verify'), unhex(sig), payload(shareId, exp));
}

const payload = (shareId: string, exp: string): Uint8Array =>
  new TextEncoder().encode(`${shareId}.${exp}`);

const hmacKey = (key: string, usage: 'sign' | 'verify'): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

const unhex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/.{2}/g) ?? [], (b) => Number.parseInt(b, 16));
