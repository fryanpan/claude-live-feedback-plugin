import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CfApi } from './cf-api.ts';
import {
  type CreateShareLinkReq,
  type CreateShareWorkspaceReq,
  DEFAULT_LINK_TTL_SECONDS,
  DEFAULT_TTL_SECONDS,
  type Share,
  type ShareConfig,
  type ShareSurface,
} from './types.ts';
import { loadUrlKey, signedSharePath, verifySignedShare } from './url-signing.ts';

const REGISTRY_FILENAME = 'shares.json';

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
  private shares: Share[] = [];
  private urlKeyCache: string | null = null;

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
   * Share a BOARD by signed link. No Cloudflare Access app, no email policy
   * — the URL's HMAC signature is the credential until `expiresAt` (the
   * S3-presigned pattern; see share/url-signing.ts). Validation throws
   * BEFORE anything is signed or saved, so a refused mint leaves no grant.
   *
   * There is no single-doc form and no single-review form: a board is the
   * unit of sharing. Both of those grants minted a share scoped to something
   * smaller, which is exactly what went away, so an older caller still
   * asking for one is refused at the route rather than quietly re-scoped to
   * something it did not ask for.
   */
  async createShareLink(req: CreateShareLinkReq): Promise<Share> {
    if (!this.config.publicHostname) {
      throw new Error(
        'link shares need config.publicHostname (the single hostname the tunnel serves)',
      );
    }
    if (!req.workspaceId) throw new Error('workspaceId is required');
    // Redemption lands on the board page, so there is no entry doc and the
    // guard scopes by workspaceId alone.
    const docId = '';

    const hostname = this.config.publicHostname;
    const ttl = assertTtl(
      req.ttlSeconds ?? this.config.defaultTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS,
    );
    const shareId = randomHex(8);
    const expiresAt = Date.now() + ttl * 1000;
    const share: Share = {
      shareId,
      surface: 'workspace',
      mode: 'link',
      docId,
      workspaceId: req.workspaceId,
      hostname,
      url: await this.signedLinkUrl(shareId, expiresAt, hostname),
      ...(req.label ? { label: req.label } : {}),
      createdAt: Date.now(),
      expiresAt,
    };
    this.shares.push(share);
    this.save();
    return share;
  }

  /**
   * Verify a presented `/share/<id>?exp&sig` tuple and resolve the LIVE link
   * share it names, or null. Signature and URL expiry first (attacker-typed
   * input proves itself before it earns a registry lookup), then the record:
   * `findLive` re-checks the share's own `expiresAt`, which is what makes
   * early revocation and TTL shortening bite even against a validly signed
   * URL — the app never trusts that the edge Worker ran.
   */
  async verifySignedLink(
    shareId: string,
    exp: string,
    sig: string,
    now: number = Date.now(),
  ): Promise<Share | null> {
    if (!(await verifySignedShare(shareId, exp, sig, this.urlKey(), now))) return null;
    const share = this.findLive(shareId, now);
    return share?.mode === 'link' ? share : null;
  }

  /**
   * The share with its `url` recomputed to the CURRENT signed form — link
   * mode only; anything else passes through. This is also the migration for
   * records minted before signing existed: their stored `/s/<slug>` url is
   * simply never served, and listing them hands back a signed URL computed
   * on demand from the same record.
   */
  async withSignedUrl(share: Share): Promise<Share> {
    if (share.mode !== 'link') return share;
    const hostname = this.config.publicHostname ?? share.hostname;
    return { ...share, url: await this.signedLinkUrl(share.shareId, share.expiresAt, hostname) };
  }

  private async signedLinkUrl(
    shareId: string,
    expiresAt: number,
    hostname: string,
  ): Promise<string> {
    return `https://${hostname}${await signedSharePath(shareId, expiresAt, this.urlKey())}`;
  }

  private urlKey(): string {
    this.urlKeyCache ??= loadUrlKey(this.dataDir);
    return this.urlKeyCache;
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
    if (s.mode === 'link') {
      s.url = await this.signedLinkUrl(
        s.shareId,
        s.expiresAt,
        this.config.publicHostname ?? s.hostname,
      );
    }
    this.save();
    return s;
  }

  private async create(req: {
    surface: ShareSurface;
    docId: string;
    workspaceId: string;
    allowDomains: string[];
    ttlSeconds?: number;
    name?: string;
  }): Promise<Share> {
    if (!req.allowDomains || req.allowDomains.length === 0) {
      throw new Error('allowDomains must be a non-empty array');
    }

    const shareId = randomHex(8);
    const slug = req.name ?? `${dateSlug(new Date())}-${randomHex(3)}`;
    const hostname = `share-${slug}.${this.config.baseHostname}`;
    // A hub workspace share (empty docId) opens the hub page directly.
    const url = req.docId
      ? `https://${hostname}/review/${encodeURIComponent(req.docId)}`
      : `https://${hostname}/workspaces/${encodeURIComponent(req.workspaceId)}`;
    const ttl = req.ttlSeconds ?? this.config.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = Date.now() + ttl * 1000;

    if (!this.cfApi) throw new Error('Cloudflare API not configured — use a link share instead');
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
      include: req.allowDomains.map((d) => ({
        email_domain: { domain: d.startsWith('@') ? d.slice(1) : d },
      })),
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

  /** `list()` with every link share's url recomputed — what the API serves. */
  listWithUrls(): Promise<Share[]> {
    return Promise.all(this.shares.map((s) => this.withSignedUrl(s)));
  }

  /** The single hostname link shares are served from, if configured. */
  get publicHostname(): string | null {
    return this.config.publicHostname ?? null;
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
