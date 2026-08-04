/**
 * Cloudflare Access share — types shared across the share module.
 *
 * MVP supports `surface: 'doc'` only (markdown). Dev server and mockup
 * surfaces are scoped for a follow-up — they need additional
 * cloudflared ingress wiring + (for mockup) a small static-file server.
 */

export type ShareSurface = 'doc' | 'site' | 'mockup';

export interface Share {
  /** Random 8-hex id used as the registry primary key. */
  shareId: string;
  surface: ShareSurface;
  /** The live-feedback docId this share is bound to. */
  docId: string;
  /** Public hostname e.g. `share-2026-05-07-a3f.tunnel.fryanpan.com`. */
  hostname: string;
  /** Full review URL the reviewer clicks. */
  url: string;
  /** Cloudflare Access AUD tag for this app — what the JWT middleware verifies against. */
  audience: string;
  /** Cloudflare Access app id (used to revoke). */
  appId: string;
  /** Cloudflare Access policy id (sibling to appId). */
  policyId: string;
  /** Allowed email domains, e.g. `["@partner-org.example"]`. */
  allowDomains: string[];
  createdAt: number;
  expiresAt: number;
}

export interface CreateShareDocReq {
  docId: string;
  allowDomains: string[];
  ttlSeconds?: number;
  /** Optional slug override. Default is `<YYYY-MM-DD>-<3hex>`. */
  name?: string;
}

export interface ShareConfig {
  cfAccountId: string;
  cfTeamDomain: string;
  /**
   * Base hostname used for share subdomains. Share hostnames will be
   * `share-<slug>.<baseHostname>`. Must match the cloudflared tunnel's
   * wildcard ingress rule (e.g. `*.tunnel.fryanpan.com`).
   */
  baseHostname: string;
  /** Default TTL for new shares in seconds. Defaults to 72h. */
  defaultTtlSeconds?: number;
}
