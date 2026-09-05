/**
 * Share types — how a review surface is published to someone outside the
 * tailnet, and what they're allowed to reach.
 *
 * ONE auth mode. A visitor proves an email address to Cloudflare Access in
 * front of a per-share hostname, and the per-app AUD means a token minted for
 * one share is rejected at another.
 *
 * `link` mode is RETIRED (Bryan, 2026-09-02: *"Every access including share
 * link or reading requires sign in via one time code or otherwise."*). It was
 * a signed capability URL — `/share/<id>?exp=…&sig=…`, an HMAC over the id
 * and the expiry — exchanged once for a session cookie, and anyone holding
 * the link was in with no identity at all. That is the surface the decision
 * closes, so nothing mints one any more and `/share/<id>` redeems nothing.
 *
 * The RECORDS stay. Removing a capability is not deleting user content: a
 * link record still lists, still shows who it was for and when it expires,
 * and can still be revoked. `listForApi` marks every one of them
 * `redeemable: false`, and `retired: 'link_mode'` says why.
 *
 * **A BOARD is the unit of sharing** (Bryan, 2026-08-17: "Workspace only — a
 * review must be filed on a board before it can be shared"). Two grants were
 * removed to get there, and they needed different mechanisms:
 *
 * - **Per-doc.** `surface: 'doc'` and the `createShareDoc` / `docId`-only
 *   `createShareLink` paths are gone, and `Shares.load` drops any legacy
 *   record carrying no `workspaceId`. A load-time drop works there because
 *   the record itself says which kind it is.
 * - **Per-review.** A folder bind and a diff review are not boards, and
 *   could each be shared alone. `Shares` cannot drop those at load: nothing
 *   on the record distinguishes a board id from a review id, and only
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
 *  that a forgotten link doesn't live forever. Callers may override.
 *  `access` mode only — link mode has its own default below. */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Two weeks — the link-mode default (Bryan, 2026-08-28: share links are
 *  temporary-use). The expiry is embedded in the signed URL at issue time,
 *  and the TTL tooling (`setTtl`) re-issues the URL when it moves. */
export const DEFAULT_LINK_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface Share {
  /** Random 8-hex id used as the registry primary key. */
  shareId: string;
  surface: ShareSurface;
  /**
   * How a visitor is authorized. Absent on pre-link-mode records = 'access'.
   * `'link'` appears only on records minted before the retirement; nothing
   * writes it now, and every serving path refuses it.
   */
  mode?: ShareMode;
  /**
   * The doc this share's URL OPENS — the workspace's entry doc, or `''` for
   * a board share, which lands on the board instead. It is a landing address,
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
   * LEGACY, `link` mode: the pre-signing capability slug. `/s/<slug>` no
   * longer redeems — the signed URL replaced it — but records that carry one
   * keep it (soft behavior: a capability removed, not user content deleted).
   * New link shares mint no slug at all.
   */
  slug?: string;
  /** Public hostname the reviewer visits. */
  hostname: string;
  /**
   * Full URL the reviewer clicks. For `link` mode this is a SIGNED URL
   * whose `exp` mirrors `expiresAt` at the moment it was computed — the API
   * layer recomputes it on demand (`signedUrlFor`), which is also how a
   * legacy `/s/` record migrates: its stored url is simply never served.
   */
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

export interface CreateShareWorkspaceReq {
  /** The BOARD in scope. There is no `docId` and no `entryDocId`
   *  alternative: file the review on a board and share the board. */
  workspaceId: string;
  /**
   * Who the Access application admits. Each entry is either an ADDRESS
   * (`someone@partner.example`) or a DOMAIN (`@partner.example`, or the bare
   * `partner.example`) — see `accessPolicyRule` in shares.ts, which is what
   * turns one into a Cloudflare policy rule. Must be non-empty: an Access app
   * with no allow policy admits nobody.
   */
  allowDomains: string[];
  ttlSeconds?: number;
  /** Optional human label shown in list_shares. */
  label?: string;
  /** Optional slug override. Default is `<YYYY-MM-DD>-<3hex>`. */
  name?: string;
}

/**
 * A share as the API serves it: the stored record plus the one thing the
 * record cannot say about itself.
 *
 * `redeemable` is false for every retired link-mode record and for anything
 * past its expiry. It exists so a caller reading `list_shares` does not have
 * to know the retirement happened to understand why a URL in the list does
 * not open.
 */
export type ListedShare = Share & {
  redeemable: boolean;
  retired?: 'link_mode';
};

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
   * RETIRED. The single public hostname link-mode shares were served from.
   * Accepted so a box that still sets `CF_SHARE_PUBLIC_HOSTNAME` starts and
   * keeps a share config, and ignored everywhere else: nothing classifies a
   * host by it and no route redeems on it.
   */
  publicHostname?: string;
  /** Default TTL for new shares in seconds. Defaults to one week. */
  defaultTtlSeconds?: number;
  /**
   * Ceiling on any share's TTL, in seconds — a mint or an extension asking
   * for more is clamped to this and told so (`ttlClamped` on the reply).
   * Absent = no ceiling. `CF_SHARE_MAX_TTL` in bin.ts.
   */
  maxTtlSeconds?: number;
}
