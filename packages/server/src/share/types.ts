/**
 * Share types — how a review surface is published to someone outside the
 * tailnet, and what they're allowed to reach.
 *
 * Two auth modes:
 *
 * - `link` — an unguessable slug IS the credential (a capability URL).
 *   Needs no Cloudflare Zero Trust at all: no team domain, no account id,
 *   no API token. Opening `/s/<slug>` exchanges the slug for a signed
 *   session cookie; every later request is authorized from that cookie.
 *   Anyone holding the link is in, so TTLs are short and the scope check
 *   (middleware/host-guard.ts) is what bounds a leak.
 *
 * - `access` — Cloudflare Access in front of a per-share hostname. The
 *   visitor proves an email address, and the per-app AUD means a token
 *   minted for one share is rejected at another. Use when the content is
 *   sensitive, the audience is more than a couple of people, or you need
 *   attribution and per-person revocation.
 *
 * Both modes share one scope engine — the mode only decides how we answer
 * "which share is this request for?".
 *
 * Dev server and mockup surfaces are scoped for a follow-up: they need
 * additional cloudflared ingress wiring + a small static-file server.
 */

export type ShareSurface = 'doc' | 'workspace' | 'site' | 'mockup';

export type ShareMode = 'link' | 'access';

/** A week. Long enough for a review to sit over a weekend, short enough
 *  that a forgotten link doesn't live forever. Callers may override. */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface Share {
  /** Random 8-hex id used as the registry primary key. */
  shareId: string;
  surface: ShareSurface;
  /** How a visitor is authorized. Absent on pre-link-mode records = 'access'. */
  mode?: ShareMode;
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
  /**
   * `link` mode only: the unguessable capability slug (128 bits of CSPRNG).
   * Possession of this grants access until `expiresAt`, so treat it like a
   * password — never log it, never put it in an error message.
   */
  slug?: string;
  /** Public hostname the reviewer visits. */
  hostname: string;
  /** Full URL the reviewer clicks. */
  url: string;
  /** `access` mode only: Cloudflare Access AUD tag the JWT must match. */
  audience?: string;
  /** `access` mode only: Cloudflare Access app id (used to revoke). */
  appId?: string;
  /** `access` mode only: Cloudflare Access policy id (sibling to appId). */
  policyId?: string;
  /** `access` mode only: allowed email domains, e.g. `["@partner.example"]`. */
  allowDomains?: string[];
  /** Optional human label, e.g. what the review is for. */
  label?: string;
  createdAt: number;
  expiresAt: number;
}

export interface CreateShareLinkReq {
  /** One of these two decides the scope. */
  docId?: string;
  workspaceId?: string;
  /** Doc the link opens. Required for a workspace share. */
  entryDocId?: string;
  /** Defaults to DEFAULT_TTL_SECONDS (one week). */
  ttlSeconds?: number;
  /** Optional human label shown in list_shares. */
  label?: string;
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
  /** `access` mode only. */
  cfAccountId?: string;
  /** `access` mode only. */
  cfTeamDomain?: string;
  /**
   * Base hostname used for per-share Access subdomains. Share hostnames
   * will be `share-<slug>.<baseHostname>`, which must match the cloudflared
   * tunnel's wildcard ingress rule. `access` mode only.
   */
  baseHostname?: string;
  /**
   * The single public hostname link-mode shares are served from, e.g.
   * `feedback.example.com`. Requests arriving on it are authorized by the
   * session cookie rather than by hostname. Required for `link` mode.
   */
  publicHostname?: string;
  /** Default TTL for new shares in seconds. Defaults to one week. */
  defaultTtlSeconds?: number;
}
