#!/usr/bin/env bun
/**
 * Local reverse proxy for `*.tunnel.<user-domain>`.
 *
 * A single long-running cloudflared named tunnel routes every request
 * under `*.tunnel.<user-domain>` to this process (default port 9900).
 * This process reads a registry file at `~/.live-feedback/registry.json`
 * keyed by subdomain slug and proxies each request to the correct
 * local feedback-server port:
 *
 *   { "abc123": { "port": 8790, "pid": 12345, "ts": 1776000000000 } }
 *
 * Subdomain slug is extracted from Host: e.g. `abc123.tunnel.fryanpan.com`
 * maps to `abc123` → port 8790.
 *
 * HTTP is forwarded via fetch. WebSocket upgrades are forwarded by
 * opening an outbound WebSocket to the target port and piping bytes
 * bidirectionally.
 *
 * Agents/users never talk to this router directly in normal flows —
 * `scripts/register-preview.ts` writes a registry entry, prints the
 * stable URL, and cloudflared + this router handle the rest.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROUTER_PORT = Number(process.env.ROUTER_PORT ?? 9900);
const REGISTRY_PATH =
  process.env.REGISTRY_PATH ?? join(homedir(), '.live-feedback', 'registry.json');
const DEFAULT_BASE_DOMAIN = process.env.BASE_DOMAIN ?? '';

interface RegistryEntry {
  port: number;
  pid?: number;
  ts?: number;
}
type Registry = Record<string, RegistryEntry>;

function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as Registry;
  } catch {
    return {};
  }
}

function slugFromHost(host: string): string | null {
  // host looks like "abc123.tunnel.fryanpan.com" or just "tunnel.fryanpan.com"
  const h = host.toLowerCase().split(':')[0] ?? '';
  // If BASE_DOMAIN is set (e.g. "tunnel.fryanpan.com"), expect host === "<slug>.<base>"
  if (DEFAULT_BASE_DOMAIN) {
    if (h === DEFAULT_BASE_DOMAIN) return null;
    const suffix = `.${DEFAULT_BASE_DOMAIN}`;
    if (!h.endsWith(suffix)) return null;
    return h.slice(0, -suffix.length);
  }
  // fallback: take the leftmost label
  const labels = h.split('.');
  return labels.length >= 3 ? (labels[0] ?? null) : null;
}

const server = Bun.serve<{ slug: string; targetPort: number }>({
  port: ROUTER_PORT,
  async fetch(req, srv) {
    const host = req.headers.get('host') ?? '';
    const slug = slugFromHost(host);
    if (!slug) {
      return new Response(`No slug in host "${host}"`, { status: 400 });
    }
    const registry = loadRegistry();
    const entry = registry[slug];
    if (!entry) {
      return new Response(`No registered preview for "${slug}"`, { status: 404 });
    }
    const targetPort = entry.port;

    // WebSocket upgrade path: Bun's server.upgrade() takes over this req.
    const upgradeHdr = req.headers.get('upgrade');
    if (upgradeHdr && upgradeHdr.toLowerCase() === 'websocket') {
      const upgraded = srv.upgrade(req, { data: { slug, targetPort } });
      if (upgraded) return undefined;
      return new Response('upgrade required', { status: 426 });
    }

    // HTTP: rewrite URL host to localhost:<targetPort> and forward.
    const target = new URL(req.url);
    target.protocol = 'http:';
    target.host = `127.0.0.1:${targetPort}`;
    const forwarded = new Request(target.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
    });
    try {
      const res = await fetch(forwarded);
      // Copy headers so content-type etc. pass through
      const out = new Response(res.body, { status: res.status, headers: res.headers });
      return out;
    } catch (err) {
      return new Response(`Origin :${targetPort} unreachable: ${err}`, { status: 502 });
    }
  },
  websocket: {
    open(ws) {
      const { targetPort } = ws.data;
      const originalPath = (ws as { originalPath?: string }).originalPath ?? '/';
      const target = `ws://127.0.0.1:${targetPort}${originalPath}`;
      const outbound = new WebSocket(target);
      outbound.binaryType = 'arraybuffer';

      const pending: Array<string | ArrayBuffer | Uint8Array> = [];
      let outboundOpen = false;
      outbound.addEventListener('open', () => {
        outboundOpen = true;
        for (const msg of pending) outbound.send(msg);
        pending.length = 0;
      });
      outbound.addEventListener('message', (ev) => {
        try {
          if (typeof ev.data === 'string') ws.send(ev.data);
          else if (ev.data instanceof ArrayBuffer) ws.sendBinary(new Uint8Array(ev.data));
          else ws.sendBinary(ev.data as Uint8Array);
        } catch {}
      });
      outbound.addEventListener('close', () => {
        try {
          ws.close();
        } catch {}
      });
      outbound.addEventListener('error', () => {
        try {
          ws.close(1011, 'upstream error');
        } catch {}
      });

      (ws as { _outbound?: WebSocket; _pending?: unknown[]; _outboundOpen?: boolean })._outbound =
        outbound;
      (ws as { _pending?: unknown[] })._pending = pending;
      Object.defineProperty(ws, '_outboundOpen', {
        get: () => outboundOpen,
        configurable: true,
      });
    },
    message(ws, message) {
      const outbound = (ws as { _outbound?: WebSocket })._outbound;
      if (!outbound) return;
      const open = (ws as { _outboundOpen?: boolean })._outboundOpen;
      let payload: string | Uint8Array;
      if (typeof message === 'string') {
        payload = message;
      } else {
        const buf = message as unknown as ArrayBufferView;
        payload = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      if (open && outbound.readyState === WebSocket.OPEN) {
        outbound.send(payload as never);
      } else {
        const pending = (ws as { _pending?: unknown[] })._pending;
        pending?.push(payload);
      }
    },
    close(ws) {
      const outbound = (ws as { _outbound?: WebSocket })._outbound;
      try {
        outbound?.close();
      } catch {}
    },
  },
});

console.log(`[router] listening on :${server.port}`);
console.log(`[router] registry file: ${REGISTRY_PATH}`);
console.log(`[router] base domain: ${DEFAULT_BASE_DOMAIN || '(none, using leftmost label)'}`);
