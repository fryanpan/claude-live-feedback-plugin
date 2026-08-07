import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CfApi } from './cf-api.ts';
import {
  type CreateShareDocReq,
  type CreateShareLinkReq,
  type CreateShareWorkspaceReq,
  DEFAULT_TTL_SECONDS,
  type Share,
  type ShareConfig,
  type ShareSurface,
} from './types.ts';

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
/** 128 bits — unguessable in practice, and short enough to paste. */
const SLUG_BYTES = 16;

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

  constructor(opts: SharesOptions) {
    this.dataDir = opts.dataDir;
    this.cfApi = opts.cfApi ?? null;
    this.config = opts.config;
    if (!existsSync(opts.dataDir)) mkdirSync(opts.dataDir, { recursive: true });
    this.load();
  }

  /** Share ONE doc: the visitor reaches that doc and nothing else. */
  async createShareDoc(req: CreateShareDocReq): Promise<Share> {
    return this.create({ ...req, surface: 'doc', docId: req.docId });
  }

  /**
   * Share a whole workspace (folder bind / diff review). The visitor reaches
   * every member doc plus the navigation endpoints, so the set browses with
   * its sidebar intact — see middleware/host-guard.ts for the exact scope.
   * The URL opens `entryDocId`.
   */
  async createShareWorkspace(req: CreateShareWorkspaceReq): Promise<Share> {
    return this.create({
      ...req,
      surface: 'workspace',
      docId: req.entryDocId,
      workspaceId: req.workspaceId,
    });
  }

  /**
   * Share by unguessable link. No Cloudflare Access app, no email policy —
   * possession of the slug is the credential until `expiresAt`. Pass either
   * `docId` (one doc) or `workspaceId` (+ `entryDocId`, the whole set).
   */
  createShareLink(req: CreateShareLinkReq): Share {
    if (!this.config.publicHostname) {
      throw new Error(
        'link shares need config.publicHostname (the single hostname the tunnel serves)',
      );
    }
    const docId = req.workspaceId ? (req.entryDocId ?? '') : (req.docId ?? '');
    if (!docId) throw new Error('docId (or entryDocId for a workspace) is required');
    if (req.docId && req.workspaceId) {
      throw new Error('pass docId OR workspaceId, not both');
    }

    const slug = randomBytes(SLUG_BYTES).toString('hex');
    const hostname = this.config.publicHostname;
    const ttl = assertTtl(req.ttlSeconds ?? this.config.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS);
    const share: Share = {
      shareId: randomHex(8),
      surface: req.workspaceId ? 'workspace' : 'doc',
      mode: 'link',
      docId,
      ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
      slug,
      hostname,
      url: `https://${hostname}/s/${slug}`,
      ...(req.label ? { label: req.label } : {}),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
    };
    this.shares.push(share);
    this.save();
    return share;
  }

  /** Look up a live link share by its slug. Expired slugs resolve to null. */
  findBySlug(slug: string, now: number = Date.now()): Share | null {
    const s = this.shares.find((x) => x.mode === 'link' && x.slug === slug);
    if (!s) return null;
    return s.expiresAt > now ? s : null;
  }

  /** Look up a live share by id. Expired shares resolve to null. */
  findLive(shareId: string, now: number = Date.now()): Share | null {
    const s = this.shares.find((x) => x.shareId === shareId);
    if (!s) return null;
    return s.expiresAt > now ? s : null;
  }

  /**
   * Change a LIVE share's expiry. `ttlSeconds` is measured from now.
   *
   * An already-expired share is deliberately NOT extendable: its URL may
   * have been forwarded or archived in the meantime, and reviving it would
   * silently hand access back to everyone who kept a copy. Mint a fresh
   * link instead — that rotates the slug.
   */
  setTtl(shareId: string, ttlSeconds: number): Share | null {
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
    workspaceId?: string;
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
    const url = `https://${hostname}/review/${encodeURIComponent(req.docId)}`;
    const ttl = req.ttlSeconds ?? this.config.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = Date.now() + ttl * 1000;

    if (!this.cfApi) throw new Error('Cloudflare API not configured — use a link share instead');
    const app = await this.cfApi.createApp({
      name: `live-feedback-share-${slug}`,
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
      ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
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

  /** Resolver for the cf-access middleware's `audience` option. */
  audienceResolver = (host: string): string | null => {
    return this.findByHostname(host)?.audience ?? null;
  };

  private load(): void {
    const path = join(this.dataDir, REGISTRY_FILENAME);
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) this.shares = parsed as Share[];
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

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, bytes);
}

function dateSlug(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
