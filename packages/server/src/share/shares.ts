import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CfApi, PolicyRule } from './cf-api.ts';
import {
  type CreateShareWorkspaceReq,
  DEFAULT_LINK_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  type ListedShare,
  type Share,
  type ShareConfig,
  type ShareSurface,
} from './types.ts';

const REGISTRY_FILENAME = 'shares.json';

/**
 * What a mint throws when this deployment has no Cloudflare Access wiring.
 *
 * Every share is an Access share now, so there is nothing to fall back to:
 * the operator has to set `CF_ACCOUNT_ID`, `CF_SHARE_BASE_HOSTNAME`,
 * `CF_ACCESS_TEAM_DOMAIN` and put a Cloudflare API token in the Keychain.
 * Exported so the route can answer with the same words rather than matching
 * on a message.
 */
export const ACCESS_NOT_CONFIGURED = 'access_sharing_not_configured';

/**
 * A TTL must be a positive, finite number of seconds. Zero, negative, NaN
 * and Infinity all produce a share that is broken on arrival (already
 * expired, or with a nonsense expiresAt) — refuse them at the door rather
 * than hand back a 200 and a dead URL.
 */
function assertTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive, finite number of seconds');
  }
  return ttlSeconds;
}

export interface SharesOptions {
  dataDir: string;
  /** Only needed for `access` mode; link mode makes no Cloudflare calls. */
  cfApi?: CfApi;
  config: ShareConfig;
}

export class Shares {
  private readonly dataDir: string;
  private readonly cfApi: CfApi | null;
  private readonly config: ShareConfig;

  /** The TTL ceiling the routes clamp to; undefined = none configured. */
  get maxTtlSeconds(): number | undefined {
    return this.config.maxTtlSeconds;
  }

  /** What `share_link` gets when the caller names no TTL. Two weeks — kept
   *  at the link-mode default through the retirement, because the ask a
   *  caller makes with `share_link` did not change, only how it is served. */
  get defaultLinkTtlSeconds(): number {
    return this.config.defaultTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS;
  }
  private shares: Share[] = [];

  constructor(opts: SharesOptions) {
    this.dataDir = opts.dataDir;
    this.cfApi = opts.cfApi ?? null;
    this.config = opts.config;
    if (!existsSync(opts.dataDir)) mkdirSync(opts.dataDir, { recursive: true });
    this.load();
  }

  /**
   * Share a BOARD behind Cloudflare Access. The URL opens the board, and the
   * visitor reaches every doc filed on it plus the navigation endpoints — see
   * middleware/host-guard.ts for the exact scope.
   *
   * There is no entry doc: a board share lands on `/workspaces/<id>`, so
   * `docId` is always empty on a record minted today. Legacy records may
   * carry one; it was only ever a landing address, never a grant.
   */
  async createShareWorkspace(req: CreateShareWorkspaceReq): Promise<Share> {
    return this.create({
      ...req,
      surface: 'workspace',
      docId: '',
      workspaceId: req.workspaceId,
    });
  }

  /**
   * Every LIVE share whose scope is exactly this workspace.
   *
   * This is the record the collaboration hostname reads to answer "was this
   * person given this board?" — a share is the only place an email is ever
   * written down against a workspace, so the union of these shares' allow
   * lists IS the membership set (plus the owner allowlist, which the server
   * folds in; it is not a share and does not belong in the registry).
   *
   * Live, not merely present, for the reason `findLiveByHostname` exists: an
   * expired grant that still admitted its audience would mean a share's TTL
   * revoked one hostname and left the collaboration hostname open.
   *
   * `link`-mode records are excluded. They are retired and every serving path
   * already refuses them, so honouring one here would revive a grant through
   * the one door that never checked the mode.
   */
  liveForWorkspace(workspaceId: string, now: number = Date.now()): Share[] {
    if (!workspaceId) return [];
    return this.shares.filter(
      (s) => s.mode !== 'link' && s.workspaceId === workspaceId && s.expiresAt > now,
    );
  }

  /** Look up a live share by id. Expired shares resolve to null. */
  findLive(shareId: string, now: number = Date.now()): Share | null {
    const s = this.shares.find((x) => x.shareId === shareId);
    if (!s) return null;
    return s.expiresAt > now ? s : null;
  }

  /**
   * Change a LIVE share's expiry. `ttlSeconds` is measured from now. A link
   * share's signed URL embeds the expiry, so moving it re-issues the URL —
   * the previously handed-out URL keeps its OWN `exp`, and whichever bound
   * is tighter (the old signature's exp, or the record's new `expiresAt`,
   * re-checked per request) wins.
   *
   * An already-expired share is deliberately NOT extendable: its URL may
   * have been forwarded or archived in the meantime, and reviving it would
   * silently hand access back to everyone who kept a copy. Mint a fresh
   * link instead — that rotates the signature.
   */
  async setTtl(shareId: string, ttlSeconds: number): Promise<Share | null> {
    const ttl = assertTtl(ttlSeconds);
    const s = this.findLive(shareId);
    if (!s) return null;
    s.expiresAt = Date.now() + ttl * 1000;
    this.save();
    return s;
  }

  private async create(req: {
    surface: ShareSurface;
    docId: string;
    workspaceId: string;
    allowDomains: string[];
    ttlSeconds?: number;
    label?: string;
    name?: string;
  }): Promise<Share> {
    if (!req.allowDomains || req.allowDomains.length === 0) {
      throw new Error('allowDomains must be a non-empty array');
    }
    // Two checks the LINK mint carried and this one did not, moved here when
    // link mode retired and this became the only mint there is. Both run
    // BEFORE any Cloudflare call, so a refused mint leaves no Access
    // application behind — the same ordering rule the link mint had about
    // signing and saving.
    //
    // Typed non-optional and checked anyway: `workspaceId` arrives from a
    // JSON body through a route, and a compiler cannot refuse what a caller
    // did not send. An empty one would mint a share whose scope predicate
    // (`shareScopeAllows`) refuses everything, shell included — a grant that
    // exists, costs a Cloudflare app, and opens nothing.
    if (!req.workspaceId) throw new Error('workspaceId is required');
    if (req.ttlSeconds !== undefined) assertTtl(req.ttlSeconds);

    const shareId = randomHex(8);
    const slug = req.name ?? `${dateSlug(new Date())}-${randomHex(3)}`;
    const hostname = `share-${slug}.${this.config.baseHostname}`;
    // A board workspace share (empty docId) opens the board page directly; a
    // doc share opens the doc UNDER the board it was shared with, which is
    // the only address a doc has and also the only one this visitor's own
    // scope will accept.
    const url = req.docId
      ? `https://${hostname}/workspaces/${encodeURIComponent(req.workspaceId)}/docs/${encodeURIComponent(req.docId)}`
      : `https://${hostname}/workspaces/${encodeURIComponent(req.workspaceId)}`;
    const ttl = req.ttlSeconds ?? this.config.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = Date.now() + ttl * 1000;

    // Named rather than generic: link mode was the fallback this message used
    // to point at, and it is retired, so the only way forward is to configure
    // Access. The route turns this into a 503 the caller can act on.
    if (!this.cfApi) throw new Error(ACCESS_NOT_CONFIGURED);
    const app = await this.cfApi.createApp({
      // Only NEW applications get the new name. Teardown does not match on it
      // — `deleteShare` calls `deleteApp(share.appId)` with the id stored at
      // creation — so existing shares are unaffected by the rename.
      name: `claude-workspaces-share-${slug}`,
      domain: hostname,
      sessionDuration: `${Math.ceil(ttl / 3600)}h`,
    });

    const policy = await this.cfApi.createPolicy(app.id, {
      name: `allow ${req.allowDomains.join(', ')}`,
      decision: 'allow',
      include: req.allowDomains.map(accessPolicyRule),
    });

    const share: Share = {
      shareId,
      surface: req.surface,
      docId: req.docId,
      workspaceId: req.workspaceId,
      hostname,
      url,
      audience: app.aud,
      appId: app.id,
      policyId: policy.id,
      allowDomains: req.allowDomains.slice(),
      ...(req.label ? { label: req.label } : {}),
      createdAt: Date.now(),
      expiresAt,
    };
    this.shares.push(share);
    this.save();
    return share;
  }

  async deleteShare(shareId: string): Promise<{ ok: boolean }> {
    const idx = this.shares.findIndex((s) => s.shareId === shareId);
    if (idx < 0) return { ok: false };
    const share = this.shares[idx]!;
    try {
      // Link shares have no Cloudflare app to tear down — dropping the
      // registry entry is the revocation, and it takes effect immediately
      // because every request re-checks the share.
      if (share.appId && this.cfApi) await this.cfApi.deleteApp(share.appId);
    } catch (err) {
      // If the CF app is already gone, drop the registry entry anyway.
      // Re-throw on real errors so the caller knows.
      if (!(err instanceof Error && /404/.test(err.message))) throw err;
    }
    this.shares.splice(idx, 1);
    this.save();
    return { ok: true };
  }

  list(): Share[] {
    return this.shares.slice();
  }

  /**
   * `list()` with the one thing a record cannot say about itself: whether it
   * can still be redeemed.
   *
   * This used to be `listWithUrls`, and it RE-SIGNED every link record's URL
   * on the way out — which was the migration path for anything minted before
   * URL signing existed. Link mode is retired (2026-09-02), so handing back a
   * freshly signed URL would now be handing back a credential-shaped string
   * for a door that no longer opens. The record is served exactly as stored,
   * with `redeemable: false` and `retired: 'link_mode'` on it, so an operator
   * can still see it, name it and revoke it.
   */
  listForApi(): ListedShare[] {
    return this.shares.map((s) =>
      s.mode === 'link'
        ? { ...s, redeemable: false, retired: 'link_mode' as const }
        : { ...s, redeemable: s.expiresAt > Date.now() },
    );
  }

  /** An `access`-mode share owning this hostname (link shares all share one). */
  findByHostname(host: string): Share | null {
    const h = host.toLowerCase();
    return this.shares.find((s) => s.mode !== 'link' && s.hostname.toLowerCase() === h) ?? null;
  }

  /**
   * The same lookup, but only while the share is still live.
   *
   * This is what the host gate must use. Link mode has always re-checked
   * liveness per request (linkSessionTarget → findLive), so an expired link
   * stops working the moment it lapses. Access mode resolved its host with
   * `findByHostname`, which ignores `expiresAt` — so a share past its TTL kept
   * classifying as a share, kept passing the Access gate, and kept serving the
   * doc. Closing its websockets didn't help; the visitor simply reconnected.
   */
  findLiveByHostname(host: string, now: number = Date.now()): Share | null {
    const s = this.findByHostname(host);
    if (!s) return null;
    return s.expiresAt > now ? s : null;
  }

  /** Resolver for the cf-access middleware's `audience` option. Live shares
   *  only — expiry-blind resolution here would let a stale-but-valid Access
   *  JWT keep matching a lapsed grant, and this runs before classifyHost has
   *  had any say. */
  audienceResolver = (host: string): string | null => {
    return this.findLiveByHostname(host)?.audience ?? null;
  };

  /**
   * Read the registry, dropping any record that predates workspace-only
   * sharing.
   *
   * A workspace is the unit of sharing, and nothing can mint a doc-scoped
   * share any more — but a record already on disk would keep being honoured
   * by every lookup below, because the gate reads the registry rather than
   * the code that wrote it. Removing the mint path and leaving the grants
   * standing would retire the feature everywhere except where it is actually
   * exercised. A dropped record is a revoked share, which is the intended
   * end state; it is logged rather than silently discarded so an operator can
   * see it happen and re-mint against a workspace.
   */
  private load(): void {
    const path = join(this.dataDir, REGISTRY_FILENAME);
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(parsed)) return;
      const all = parsed as Share[];
      this.shares = all.filter((s) => typeof s?.workspaceId === 'string' && s.workspaceId !== '');
      const dropped = all.length - this.shares.length;
      if (dropped > 0) {
        console.warn(
          `[feedback] dropped ${dropped} legacy doc-scoped share(s) from ${REGISTRY_FILENAME} — a workspace is the unit of sharing; re-share the workspace the doc is filed on`,
        );
        this.save();
      }
    } catch {
      // Corrupt registry — start clean. Better than crashing the server.
      this.shares = [];
    }
  }

  private save(): void {
    const path = join(this.dataDir, REGISTRY_FILENAME);
    writeFileSync(path, JSON.stringify(this.shares, null, 2));
  }
}

/**
 * `bytes` random bytes, hex-encoded — so 2*bytes characters.
 *
 * It used to `.slice(0, bytes)` the encoded string, throwing away half the
 * entropy it had just generated: `randomHex(8)` returned 32 bits, not 64, and
 * `randomHex(3)` returned 12 bits — 4096 possibilities for the date-suffixed
 * Access share slug, which is also its public hostname. Neither value is a
 * bearer credential (a link URL's credential is its HMAC signature, and an
 * Access hostname is gated by a JWT), so this was a collision bug rather
 * than a guessing one — but a function named for a byte count should return
 * that many bytes.
 */
function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function dateSlug(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * One entry of a share's audience, as a Cloudflare Access policy rule.
 *
 * Two shapes, because the audience list now carries both. It used to be
 * domains only — every entry became `email_domain`, and `@` was stripped if
 * present — which was right while the only caller was `share_workspace`,
 * whose argument is literally named `allowDomains`. `share_link` mints Access
 * shares now (link mode is retired), and when its caller names nobody the
 * server falls back to the OPERATOR ALLOWLIST, which is a list of addresses.
 * Feeding an address through the old branch produced
 * `email_domain: { domain: 'someone@example.com' }` — a domain no token can
 * ever match, so the share would exist and admit nobody, which is a silent
 * lockout rather than an error anyone reads.
 *
 * The discriminator is an `@` with something in front of it: `a@b.example`
 * is a person, `@b.example` and `b.example` are a domain.
 */
export function accessPolicyRule(entry: string): PolicyRule {
  const at = entry.indexOf('@');
  if (at > 0) return { email: { email: entry } };
  return { email_domain: { domain: at === 0 ? entry.slice(1) : entry } };
}

/**
 * Does one entry of a share's audience admit this email?
 *
 * The READING half of `accessPolicyRule`, and it sits next to it because the
 * two must agree: that function tells Cloudflare who may reach a share
 * hostname, this one tells our own gate who may reach the same workspace over
 * the collaboration hostname. Split them across files and the day someone
 * adds a third entry shape, one door opens for it and the other does not.
 *
 * Same discriminator, therefore: an `@` with something in front of it is a
 * person (`a@b.example` matches that address and no other), anything else is
 * a domain (`@b.example` and `b.example` both match every address at it).
 * Matching is case-insensitive on both sides, because Cloudflare's is and
 * because the verified claim arrives however the IdP spells it.
 *
 * An entry that is neither — an empty string, a bare `@` — admits nobody
 * rather than everybody. That is not hypothetical tidiness: `allowDomains` is
 * a JSON array off a request body, and the failure mode of a permissive parse
 * here is a workspace open to every admitted email on the deployment.
 */
export function audienceEntryAdmits(entry: string, email: string): boolean {
  const who = email.trim().toLowerCase();
  const at = who.lastIndexOf('@');
  if (at <= 0 || at === who.length - 1) return false;
  const rule = entry.trim().toLowerCase();
  const ruleAt = rule.indexOf('@');
  if (ruleAt > 0) return rule === who;
  const domain = ruleAt === 0 ? rule.slice(1) : rule;
  if (domain === '') return false;
  return who.slice(at + 1) === domain;
}
