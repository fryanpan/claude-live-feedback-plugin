/**
 * Where the feedback server is, how this process talks to it, and the two
 * result shapes every tool answers with.
 *
 * Lifted out of `mcp.ts` unchanged, which is what makes any of it assertable:
 * that file starts an MCP server on import, so the discovery fallback and the
 * status-before-parse order could only ever be read, never run.
 *
 * Both of those exist because of a specific failure. Discovery is resolved
 * PER REQUEST, not frozen at module load: the MCP stdio child runs for the
 * life of a session — sometimes days — and the supervisor may not be running
 * at child-start, may move ports on restart, or may not have written its
 * discovery file yet. And the status is checked BEFORE the body is parsed,
 * because the server's catch-all answers unmatched routes with the bare
 * string `not found`, which explodes `JSON.parse` and buries the HTTP error
 * that was the actual news.
 */
import { readRenamedEnv } from '@feedback/core/env-names';
import { discoveryCandidates, resolveDiscoveryFile } from '@feedback/core/machine-paths';

/** The filesystem reads discovery needs, injectable for tests. */
export interface DiscoveryDeps {
  env: Record<string, string | undefined>;
  homedir: () => string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: 'utf8') => string;
}

/**
 * The base URL of the running feedback server.
 *
 * No silent default: port 8787 used to be the fallback, but it is squatted by
 * another MCP server on developer machines and silently routed every call to
 * the wrong process. If discovery is unavailable this throws, and the message
 * names both places it looked.
 */
export function resolveBaseUrl(deps: DiscoveryDeps): string {
  const override = readRenamedEnv(deps.env, 'CW_BASE_URL');
  if (override) return override;
  const discovery = resolveDiscoveryFile(deps.homedir(), deps.existsSync);
  if (discovery) {
    try {
      const j = JSON.parse(deps.readFileSync(discovery, 'utf8')) as { port?: number };
      if (j.port) return `http://localhost:${j.port}`;
    } catch {
      // fall through to throw — corrupt discovery file
    }
  }
  throw new Error(
    'claude-workspaces server not found — start it with `bun run dev` (or set CW_BASE_URL). ' +
      `Looked for a discovery file at ${discoveryCandidates(deps.homedir()).join(' and ')}.`,
  );
}

export type Http = (method: string, path: string, body?: unknown) => Promise<unknown>;

/**
 * The REST call every tool goes through; throws on a non-2xx.
 *
 * `authHeaders` is asked PER PATH, and answers `{}` for all but the one route
 * that reads this agent's own feed (see `pathNeedsAgentToken` in
 * agent-token.ts). Asked unconditionally, it would make the first tool call
 * of a session wait on a token mint that has nothing to do with it, coupling
 * every tool's availability to a request none of them need. It also resolves
 * to `{}` whenever no token could be had, which is exactly what this client
 * sent before the header existed.
 */
export function createHttp(
  resolve: () => string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  authHeaders: (path: string) => Promise<Record<string, string>> = async () => ({}),
): Http {
  return async (method, path, body) => {
    const baseUrl = resolve();
    const res = await fetchFn(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(await authHeaders(path)),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    // Check status before parsing — see the header.
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  };
}

/** A successful tool result: the data, pretty-printed. */
export function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** A failed tool result. `isError` is what the client branches on. */
export function err(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}
