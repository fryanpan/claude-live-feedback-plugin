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
  /** AUD tag from the Cloudflare Access application. */
  audience: string;
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
    try {
      const { payload } = await jwtVerify(token, getKey, {
        issuer,
        audience: opts.audience,
      });
      const email = typeof payload.email === 'string' ? payload.email : undefined;
      return { ok: true, email };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'invalid_jwt';
      return { ok: false, status: 401, error };
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
