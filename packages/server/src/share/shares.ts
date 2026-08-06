import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CfApi } from './cf-api.ts';
import type {
  CreateShareDocReq,
  CreateShareWorkspaceReq,
  Share,
  ShareConfig,
  ShareSurface,
} from './types.ts';

const DEFAULT_TTL_SECONDS = 72 * 60 * 60;
const REGISTRY_FILENAME = 'shares.json';

export interface SharesOptions {
  dataDir: string;
  cfApi: CfApi;
  config: ShareConfig;
}

export class Shares {
  private readonly dataDir: string;
  private readonly cfApi: CfApi;
  private readonly config: ShareConfig;
  private shares: Share[] = [];

  constructor(opts: SharesOptions) {
    this.dataDir = opts.dataDir;
    this.cfApi = opts.cfApi;
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
      await this.cfApi.deleteApp(share.appId);
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

  findByHostname(host: string): Share | null {
    const h = host.toLowerCase();
    return this.shares.find((s) => s.hostname.toLowerCase() === h) ?? null;
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
