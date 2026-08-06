/**
 * Cloudflare Access share — types shared across the share module.
 *
 * Supports `surface: 'doc'` (one markdown doc) and `surface: 'workspace'`
 * (a folder bind or diff review, browsable as a set). Dev server and mockup
 * surfaces are scoped for a follow-up — they need additional
 * cloudflared ingress wiring + (for mockup) a small static-file server.
 */

export type ShareSurface = 'doc' | 'workspace' | 'site' | 'mockup';

export interface Share {
  /** Random 8-hex id used as the registry primary key. */
  shareId: string;
  surface: ShareSurface;
  /**
   * The live-feedback docId this share opens. For a workspace share this
   * is the entry doc — the whole workspace is in scope, see `workspaceId`.
   */
  docId: string;
  /**
   * Set for `surface: 'workspace'`. The visitor may reach every member doc
   * of this workspace plus its navigation endpoints, so the folder or diff
   * review browses as a set. Absent on a single-doc share.
   */
  workspaceId?: string;
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

export interface CreateShareWorkspaceReq {
  workspaceId: string;
  /** Doc the share URL opens. Callers usually pass the workspace entry. */
  entryDocId: string;
  allowDomains: string[];
  ttlSeconds?: number;
  /** Optional slug override. Default is `<YYYY-MM-DD>-<3hex>`. */
  name?: string;
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
