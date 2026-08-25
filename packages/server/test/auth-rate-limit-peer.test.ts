/**
 * The per-peer login limits at the HTTP layer — the part nothing typechecks.
 *
 * `client-address.test.ts` pins the derivation as a pure function. This file
 * proves the two routes actually USE it, because the defect being fixed was
 * never in a predicate: it was `server.requestIP(req)?.address` written
 * inline at both call sites, which is loopback for every reviewer arriving
 * through `tailscale serve` or the cloudflared tunnel.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STARTS_PER_PEER } from '../src/auth/email-code.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

let handle: ServerHandle;
let dataDir: string;
let base: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'auth-peer-rl-test-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A login start, optionally claiming to have been forwarded for `xff`. */
async function start(email: string, xff?: string, origin = base): Promise<Response> {
  return await fetch(`${origin}/api/auth/start`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(xff ? { 'x-forwarded-for': xff } : {}),
    },
    body: JSON.stringify({ email }),
  });
}

/** Unique per call, so the per-EMAIL limit never fires first and masks this. */
let n = 0;
const freshEmail = (tag: string) => `${tag}-${n++}-${Date.now()}@example.com`;

/** Spend a peer's whole start budget. Returns the status of the last call. */
async function exhaust(xff: string | undefined, tag: string): Promise<number> {
  let last = 0;
  for (let i = 0; i < MAX_STARTS_PER_PEER; i++) {
    last = (await start(freshEmail(tag), xff)).status;
  }
  return last;
}

describe('per-peer login limits key on the forwarded client', () => {
  it('does not lock out a second reviewer behind the same proxy', async () => {
    // Both of these arrive on a loopback socket, exactly as they do through
    // `tailscale serve` and the tunnel. Before the fix they shared ONE
    // 15-start bucket, so this second reviewer was refused a login because
    // somebody else had been retrying.
    expect(await exhaust('203.0.113.10', 'peer-a')).toBe(200);
    const spent = await start(freshEmail('peer-a'), '203.0.113.10');
    expect(spent.status).toBe(429);
    expect(await spent.json()).toMatchObject({ error: 'rate_limited' });

    const other = await start(freshEmail('peer-b'), '203.0.113.11');
    expect(other.status).toBe(200);
  });

  it('still bites the client that is actually retrying', async () => {
    // The limit must not become decorative: one client, one bucket.
    expect(await exhaust('203.0.113.20', 'peer-c')).toBe(200);
    expect((await start(freshEmail('peer-c'), '203.0.113.20')).status).toBe(429);
  });

  it('reads the RIGHTMOST entry, so a proxied client cannot forge a fresh one', async () => {
    // Measured: Cloudflare APPENDS, so a client that sends `9.9.9.9` reaches
    // the origin as `9.9.9.9,<real>`. Keying on the leftmost entry would let
    // it mint a new bucket per request and never be limited at all.
    expect(await exhaust('198.51.100.30', 'peer-d')).toBe(200);
    expect((await start(freshEmail('peer-d'), '198.51.100.30')).status).toBe(429);
    // Same real client, a different forged prefix each time: still refused.
    for (const forged of ['1.2.3.4', '5.6.7.8', '9.10.11.12']) {
      const res = await start(freshEmail('peer-d'), `${forged},198.51.100.30`);
      expect(res.status).toBe(429);
    }
  });

  it('serves a direct loopback request that carries no headers at all', async () => {
    // The agent's own MCP calls. Nothing forwards them and nothing should
    // break for want of a header.
    const res = await start(freshEmail('plain'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

/**
 * The forged-header case from a peer that is NOT behind our proxy, over a
 * real socket rather than a stubbed address.
 *
 * Skipped when the machine has no non-loopback IPv4 to dial (a sandboxed CI
 * container), because a test that silently passes on a missing interface is
 * worse than one that says it did not run. The same branch is pinned
 * deterministically in `client-address.test.ts`.
 */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

describe.if(Boolean(lanAddress))('a non-proxied client cannot choose its bucket', () => {
  it('ignores x-forwarded-for from a peer that did not come through a proxy', async () => {
    const remote = `http://${lanAddress}:${handle.port}`;
    // Positive control: this origin is reachable and the route answers on it.
    // Without it, a 403 from the host guard would make every assertion below
    // pass for the wrong reason.
    const control = await start(freshEmail('lan-control'), undefined, remote);
    expect(control.status).toBe(200);

    // Spend the budget for this real peer, each call claiming a different
    // forwarded identity. If the header were trusted, each would land in its
    // own bucket and none of them would ever be refused.
    let refused = false;
    for (let i = 0; i < MAX_STARTS_PER_PEER + 2; i++) {
      const res = await start(freshEmail('lan'), `10.0.0.${i}`, remote);
      if (res.status === 429) {
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
  });
});
