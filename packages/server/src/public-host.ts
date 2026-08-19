import { existsSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';

/**
 * Pick the best hostname to advertise to humans.
 *
 * Priority: Tailscale MagicDNS name > LAN hostname > localhost. The first
 * two only matter when Bryan is reviewing from a different device than
 * the one running the server (laptop / tablet / couch). On a single-box
 * setup or in CI the helpers return empty and callers fall back to
 * localhost.
 */

export function tailscaleHost(): string | null {
  const candidates = [
    '/usr/local/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ];
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    try {
      const out = Bun.spawnSync({ cmd: [bin, 'status', '--json'], stdout: 'pipe' });
      const j = JSON.parse(out.stdout.toString('utf8')) as { Self?: { DNSName?: string } };
      const dns = j.Self?.DNSName?.replace(/\.$/, '');
      if (dns) return dns;
    } catch {
      // ignore — try next candidate
    }
  }
  return null;
}

export function lanHostnames(): string[] {
  const out: string[] = [];
  const h = hostname().replace(/\.local$/, '');
  if (h) out.push(`${h}.local`);
  const nets = networkInterfaces();
  for (const infos of Object.values(nets)) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

/**
 * Cache the host across calls — `tailscale status` shells out and we
 * embed `reviewUrl` on every doc response. TTL'd at 60s so a server
 * started before the tailscale daemon eventually picks up the
 * MagicDNS name without a restart.
 */
let cachedPublicHost: string | undefined;
let cachedAt = 0;
const HOST_TTL_MS = 60_000;
export function publicHost(): string {
  const now = Date.now();
  if (cachedPublicHost !== undefined && now - cachedAt < HOST_TTL_MS) return cachedPublicHost;
  const ts = tailscaleHost();
  if (ts) {
    cachedPublicHost = ts;
  } else {
    const [first] = lanHostnames();
    cachedPublicHost = first ?? 'localhost';
  }
  cachedAt = now;
  return cachedPublicHost;
}

export function publicBaseUrl(port: number): string {
  return `http://${publicHost()}:${port}`;
}

/**
 * The operator-declared external base URL, normalized — or null when unset.
 *
 * The server does not terminate TLS. When something in front of it does
 * (`tailscale serve` maps `https://<tailnet-name>` onto this process on
 * loopback), the process has no way to learn its own external origin: the
 * socket is plain http, and the only hostname it can discover is the one it
 * would have guessed anyway. So the operator states it, and every URL the
 * server hands a human is built from it.
 *
 * This matters more than cosmetics. `publicBaseUrl` is the single source of
 * `reviewUrl`, `entryUrl` and the task-import banner's `hubUrl` — the links
 * agents paste to Bryan. Left at `http://<host>:<port>` behind a TLS
 * frontend, every one of those links lands on the INSECURE origin, which is
 * exactly the origin where the microphone does not exist. The whole point of
 * putting TLS in front is undone by the links still pointing past it.
 *
 * Strict, and it THROWS rather than falling back. A silent fallback here is
 * the "fallback nobody knows they are on" failure: the server would keep
 * serving, every link would keep working, and they would all quietly point
 * at the origin the deploy was meant to leave behind. A typo must be a boot
 * failure someone reads, not a degradation nobody sees.
 *
 * Rejected on purpose:
 *   - a scheme other than http/https — nothing else is a browser origin
 *   - a path, query or fragment — routes mount at the root, and a base with
 *     a path would build `https://h/x/review/<id>`, which this server does
 *     not serve
 *   - embedded credentials — these strings are pasted to humans
 */
export function normalizePublicBaseUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  const bad = (why: string): never => {
    throw new Error(`CW_PUBLIC_BASE_URL is invalid (${why}): ${JSON.stringify(s)}`);
  };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return bad('not a URL — expected e.g. https://host.example.ts.net');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return bad('scheme must be http or https');
  if (u.hostname === '') return bad('no hostname');
  if (u.username !== '' || u.password !== '') return bad('must not embed credentials');
  if (u.search !== '') return bad('must not carry a query string');
  if (u.hash !== '') return bad('must not carry a fragment');
  // `new URL('https://h')` normalizes the path to '/', which is the only path
  // this accepts — anything longer is a subpath mount the routes cannot serve.
  if (u.pathname !== '/' && u.pathname !== '') return bad('must not include a path');
  // `URL.origin` drops a default port (443 for https, 80 for http) and keeps
  // an explicit non-default one — exactly the shape the callers concatenate.
  return u.origin;
}

/**
 * Every hostname that resolves to THIS machine — loopback aside — cached the
 * same way and for the same reason as `publicHost()`: `tailscaleHost()` shells
 * out to `tailscale status --json`, and the host gate and the browser-origin
 * policy both need this on every request, including every websocket handshake.
 * Uncached it meant two or three subprocess spawns before any real work.
 *
 * Same 60s TTL, so a server that started before the tailscale daemon still
 * picks up the MagicDNS name without a restart.
 */
let cachedLocalNames: string[] | undefined;
let localNamesAt = 0;
export function localHostnames(): string[] {
  const now = Date.now();
  if (cachedLocalNames !== undefined && now - localNamesAt < HOST_TTL_MS) return cachedLocalNames;
  const ts = tailscaleHost();
  cachedLocalNames = [...(ts ? [ts] : []), ...lanHostnames()];
  localNamesAt = now;
  return cachedLocalNames;
}
