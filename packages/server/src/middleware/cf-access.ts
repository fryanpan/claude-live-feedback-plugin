import {
  type JSONWebKeySet,
  type JWTVerifyGetKey,
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
} from 'jose';

export interface CfAccessOptions {
  /** Cloudflare Zero Trust team domain, e.g. "fryanpan.cloudflareaccess.com". */
  teamDomain: string;
  /**
   * AUD tag(s) the verifier accepts. Can be:
   *   - a string: every request must match this single AUD (simple env-driven setup)
   *   - a function: resolve AUD per Host header — used by the share module so
   *     each share-<slug>.tunnel.fryanpan.com gets its own AUD without restarts.
   *     Return null when the host has no active share (request is rejected).
   *   - absent: a team domain with NO audience to check against. Every token
   *     is refused. This is what bin.ts hands over when CF_ACCESS_TEAM_DOMAIN
   *     is set and CF_ACCESS_AUD is not; it used to be a placeholder STRING,
   *     which made every "is a static audience configured?" check answer yes
   *     and left the fail-closed rules depending on bin.ts emptying the host
   *     lists. An absent audience answers no by its type.
   */
  audience?: string | ((host: string) => string | null);
  /** For tests: pass a static JWKS instead of fetching from the team domain. */
  jwks?: JSONWebKeySet;
}

export interface CfAccessSuccess {
  ok: true;
  email: string | undefined;
}

export interface CfAccessFailure {
  ok: false;
  status: number;
  error: string;
}

export type CfAccessResult = CfAccessSuccess | CfAccessFailure;

export type CfAccessVerifier = (req: Request) => Promise<CfAccessResult>;

export function createCfAccessVerifier(opts: CfAccessOptions): CfAccessVerifier {
  const issuer = `https://${opts.teamDomain}`;
  const getKey: JWTVerifyGetKey = opts.jwks
    ? createLocalJWKSet(opts.jwks)
    : createRemoteJWKSet(new URL(`https://${opts.teamDomain}/cdn-cgi/access/certs`));

  return async function verify(req: Request): Promise<CfAccessResult> {
    const token = extractToken(req);
    if (!token) return { ok: false, status: 401, error: 'missing_jwt' };
    let audience: string;
    if (typeof opts.audience === 'function') {
      const host = req.headers.get('host')?.toLowerCase() ?? '';
      const resolved = opts.audience(host);
      if (!resolved) return { ok: false, status: 401, error: 'no_share_for_host' };
      audience = resolved;
    } else if (typeof opts.audience === 'string') {
      audience = opts.audience;
    } else {
      return { ok: false, status: 401, error: 'no_audience_configured' };
    }
    try {
      // `exp` is REQUIRED, not merely checked when present: jose enforces an
      // expiry it finds and says nothing about one that is missing, and a
      // token that never expires is a credential that is never revoked.
      const { payload } = await jwtVerify(token, getKey, {
        issuer,
        audience,
        requiredClaims: ['exp'],
      });
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      return { ok: true, email };
    } catch {
      // Generic on purpose. jose's messages name the check that failed
      // ("unexpected aud", "exp timestamp check failed"), which is a guide to
      // what the next forged token needs. The operator reads the real reason
      // in Cloudflare's own logs; a caller learns only that it did not pass.
      return { ok: false, status: 401, error: 'access_token_invalid' };
    }
  };
}

function extractToken(req: Request): string | null {
  const header = req.headers.get('cf-access-jwt-assertion');
  if (header) return header.trim();
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === 'CF_Authorization') return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
