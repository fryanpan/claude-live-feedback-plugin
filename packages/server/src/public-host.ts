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
