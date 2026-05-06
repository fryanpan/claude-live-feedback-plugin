/**
 * Typed Cloudflare Access REST client.
 *
 * Only the operations the share module needs — `apps` and `policies`
 * under a given account. Constructed with `accountId + token`. Every
 * call surfaces non-2xx responses as Errors so callers don't have to
 * check `ok` themselves.
 *
 * Tests pass `fetchImpl` to inject a fake — the production path uses
 * the global `fetch`.
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

type FetchLike = typeof fetch;

export interface CfApiOptions {
  accountId: string;
  token: string;
  fetchImpl?: FetchLike;
  apiBase?: string;
}

export interface CfAccessApp {
  id: string;
  name: string;
  domain: string;
  aud: string;
  session_duration?: string;
}

export interface CfAccessPolicy {
  id: string;
  name: string;
  decision: 'allow' | 'deny';
}

export interface CreateAppParams {
  name: string;
  domain: string;
  /** e.g. "72h" — Cloudflare format */
  sessionDuration: string;
}

export interface CreatePolicyParams {
  name: string;
  decision: 'allow' | 'deny';
  include: PolicyRule[];
}

export type PolicyRule = { email_domain: { domain: string } } | { email: { email: string } };

export class CfApi {
  private readonly accountId: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;

  constructor(opts: CfApiOptions) {
    this.accountId = opts.accountId;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? CF_API_BASE;
  }

  async createApp(params: CreateAppParams): Promise<CfAccessApp> {
    const body = {
      name: params.name,
      domain: params.domain,
      session_duration: params.sessionDuration,
      type: 'self_hosted',
    };
    const res = await this.req('POST', `/accounts/${this.accountId}/access/apps`, body);
    return res.result as CfAccessApp;
  }

  async createPolicy(appId: string, params: CreatePolicyParams): Promise<CfAccessPolicy> {
    const body = {
      name: params.name,
      decision: params.decision,
      include: params.include,
    };
    const res = await this.req(
      'POST',
      `/accounts/${this.accountId}/access/apps/${appId}/policies`,
      body,
    );
    return res.result as CfAccessPolicy;
  }

  async deleteApp(appId: string): Promise<void> {
    await this.req('DELETE', `/accounts/${this.accountId}/access/apps/${appId}`);
  }

  async listApps(domain?: string): Promise<CfAccessApp[]> {
    const qs = domain ? `?domain=${encodeURIComponent(domain)}` : '';
    const res = await this.req('GET', `/accounts/${this.accountId}/access/apps${qs}`);
    return res.result as CfAccessApp[];
  }

  private async req(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ success: boolean; result: unknown; errors?: unknown[] }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const url = `${this.apiBase}${path}`;
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`CF API ${method} ${path} → ${res.status}: ${text}`);
    }
    if (text.length === 0) return { success: true, result: null };
    return JSON.parse(text);
  }
}
