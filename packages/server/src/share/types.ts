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
 * **A BOARD is the unit of sharing** (Bryan, 2026-08-17: "Workspace only — a
 * review must be filed on a board before it can be shared"). Two grants were
 * removed to get there, and they needed different mechanisms:
 *
 * - **Per-doc.** `surface: 'doc'` and the `createShareDoc` / `docId`-only
 *   `createShareLink` paths are gone, and `Shares.load` drops any legacy
 *   record carrying no `workspaceId`. A load-time drop works there because
 *   the record itself says which kind it is.
 * - **Per-grouping.** A folder bind and a diff review are not boards, and
 *   could each be shared alone. `Shares` cannot drop those at load: nothing
 *   on the record distinguishes a board id from a grouping id, and only
 *   `taskStore` knows the difference. So it is enforced where the share is
 *   RESOLVED for serving (see `boardShareTarget` in server.ts) and the row
 *   stays on disk — a capability removed, not user content deleted.
 *
 * File the review on a board and share the board; everything in a workspace
 * is available to everyone in it (see `.claude/rules/workspace-board.md`).
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
  /** The BOARD in scope. There is no `docId` and no `entryDocId`
   *  alternative: file the review on a board and share the board. */
  workspaceId: string;
  /** Defaults to DEFAULT_TTL_SECONDS (one week). */
  ttlSeconds?: number;
  /** Optional human label shown in list_shares. */
  label?: string;
}

export interface CreateShareWorkspaceReq {
  /** The BOARD in scope. See CreateShareLinkReq. */
  workspaceId: string;
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
