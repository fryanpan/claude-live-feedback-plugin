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
 * **A WORKSPACE is the unit of sharing** (Bryan, 2026-08-17). There is no
 * per-doc share: `surface: 'doc'` and the `createShareDoc` / `docId`-only
 * `createShareLink` paths that minted one are gone, and `Shares.load` drops
 * any legacy record that carries no `workspaceId` rather than keep honouring
 * a grant the product no longer offers. Share the workspace a doc is filed
 * on; everything in a workspace is available to everyone in it (see
 * `.claude/rules/workspace-board.md`).
 *
 * Dev server and mockup surfaces are scoped for a follow-up: they need
 * additional cloudflared ingress wiring + a small static-file server.
 */

export type ShareSurface = 'workspace' | 'site' | 'mockup';

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
   * The doc this share's URL OPENS — the workspace's entry doc, or `''` for
   * a hub share, which lands on the board instead. It is a landing address,
   * not a grant: scope comes entirely from `workspaceId`, and the entry doc
   * is reachable because it is a member, not because it is named here.
   */
  docId: string;
  /**
   * The workspace in scope. The visitor may reach every member doc plus the
   * navigation endpoints, so the folder or diff review browses as a set.
   *
   * REQUIRED — a workspace is the unit of sharing. It was optional while a
   * single doc could be shared on its own; a record without it now names a
   * grant nothing can mint, and `load()` drops it.
   */
  workspaceId: string;
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
  /** The workspace in scope. A workspace is the unit of sharing, so there is
   *  no `docId` alternative: file the doc on a workspace and share that. */
  workspaceId: string;
  /** Doc the link opens. Required unless `hub`. */
  entryDocId?: string;
  /**
   * A HUB workspace share (§3.12 commit 8): the visitor lands on the hub
   * page (`/workspaces/<id>`), not on a review doc, so there is no entry
   * doc and `docId` stays empty. Scope comes entirely from `workspaceId`.
   */
  hub?: boolean;
  /** Defaults to DEFAULT_TTL_SECONDS (one week). */
  ttlSeconds?: number;
  /** Optional human label shown in list_shares. */
  label?: string;
}

export interface CreateShareWorkspaceReq {
  workspaceId: string;
  /** Doc the share URL opens. Callers usually pass the workspace entry.
   *  Omitted for a `hub` share, whose URL opens the hub page instead. */
  entryDocId?: string;
  /** See CreateShareLinkReq.hub — the visitor lands on `/workspaces/<id>`. */
  hub?: boolean;
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
