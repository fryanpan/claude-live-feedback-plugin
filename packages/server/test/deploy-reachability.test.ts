/**
 * Who can trigger a deploy?
 *
 * The plugin refresh next door is safe to expose widely because it cannot
 * interrupt anybody — it rewrites a version-keyed cache and every running
 * session keeps loading the path it resolved at launch. **A deploy does not
 * inherit that argument.** It restarts this process, which drops every live
 * editor websocket and every SSE stream on the box. So the reachability
 * question has to be asked again from scratch rather than copied from the
 * route above it.
 *
 * Three layers, because each one is the only thing that catches its class:
 *
 * 1. `shareScopeAllows` — a share visitor never reaches the route at all.
 *    Pinned here because "closed by default" is a property of a file somebody
 *    can edit, and the allowlist has been widened before.
 * 2. `isLoopbackAddress` — the PEER address, not the Host header. Measured
 *    2026-08-17 against a real `Bun.serve`: a LAN client (192.168.x.x) and a
 *    tailnet client (100.x.x.x) both connected while sending
 *    `Host: localhost:1`, and `server.requestIP()` reported their true
 *    addresses. A Host-based loopback check would therefore have been
 *    spoofable by exactly the callers it was meant to exclude.
 * 3. The route, end to end, over a real socket from a real address.
 *
 * Every test that asserts a refusal asserts a permission first, on the same
 * fixture in the same pass.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DeployResult, Deployer } from '../src/deploy.ts';
import { isLoopbackAddress, shareScopeAllows } from '../src/middleware/host-guard.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const DEPLOYED: DeployResult = {
  ok: true,
  status: 'deployed',
  changed: true,
  before: 'aaaaaaa',
  after: 'bbbbbbb',
  behind: 1,
  ahead: 0,
  message: 'fixture deploy',
  ranAt: 1,
  restartRequested: true,
};

describe('a share visitor cannot reach the deploy route', () => {
  // The layer the gate actually lives in. An end-to-end 403 here would be
  // measuring the allowlist while claiming to measure the route — the exact
  // mistake recorded for the refresh route's first test.
  const HUB = { docId: '', workspaceId: 'hub-1' };
  const DOC = { docId: 'auth-rfc', workspaceId: 'ws-a' };
  const wsOf = (d: string) =>
    d === 'auth-rfc' ? ['ws-a'] : d.startsWith('hub-1:') ? ['hub-1'] : [];

  it('refuses /api/deploy for every share target and both methods', () => {
    for (const target of [HUB, DOC]) {
      expect(shareScopeAllows('/api/deploy', 'POST', target, wsOf)).toBe(false);
      expect(shareScopeAllows('/api/deploy', 'GET', target, wsOf)).toBe(false);
    }
    // Positive control: these same targets DO reach their own surfaces, so
    // the refusals above are about this path and not about the fixture.
    expect(shareScopeAllows('/workspaces/hub-1', 'GET', HUB, wsOf)).toBe(true);
    expect(shareScopeAllows('/api/docs/auth-rfc', 'GET', DOC, wsOf)).toBe(true);
  });
});

describe('isLoopbackAddress', () => {
  it('accepts what a loopback peer actually looks like, mapped form included', () => {
    // `::ffff:127.0.0.1` is the form Bun reports for an IPv4 loopback peer on
    // this machine — measured, not assumed. A naive `=== '127.0.0.1'` would
    // refuse the only caller the gate exists to allow.
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true); // 127.0.0.0/8 is all loopback
  });

  it('refuses LAN, tailnet, public, and unknown peers', () => {
    // The two middle cases are this machine's real address families, taken
    // from the measurement in the module header.
    expect(isLoopbackAddress('::ffff:192.168.50.71')).toBe(false);
    expect(isLoopbackAddress('::ffff:100.81.139.70')).toBe(false);
    expect(isLoopbackAddress('192.168.50.71')).toBe(false);
    expect(isLoopbackAddress('100.81.139.70')).toBe(false);
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('fails closed on an address it cannot read', () => {
    // `requestIP` answers null for a socket that has already gone away.
    // Unknown must mean refuse; the alternative is a deploy authorised by a
    // missing value.
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
    // A bind wildcard is not a peer address. It appears in the Host-matching
    // loopback set next door, which is why it is named here explicitly.
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('::')).toBe(false);
  });

  it('is not fooled by an address that merely starts with 127', () => {
    expect(isLoopbackAddress('127.0.0.1.evil.example')).toBe(false);
    expect(isLoopbackAddress('1270.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::ffff:127.0.0.1.evil')).toBe(false);
  });
});

describe('POST /api/deploy over a real socket', () => {
  let handle: ServerHandle | null = null;
  let dataDir: string | null = null;
  const runs = { n: 0 };

  const start = () => {
    runs.n = 0;
    dataDir = mkdtempSync(join(tmpdir(), 'deploy-reach-'));
    handle = createServer({
      port: 0,
      dataDir,
      // Whatever address the probe connects FROM is a trusted local host as
      // far as the Host guard is concerned — that is the point. Without this
      // the LAN probe below would be refused as an unknown host and the test
      // would pass for the wrong reason.
      trustedHosts: nonLoopbackAddresses(),
      deployer: new Deployer({
        run: async () => {
          runs.n++;
          return DEPLOYED;
        },
        now: () => 1,
      }),
    });
    return handle.port;
  };

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it('a loopback caller deploys — the gate does not refuse the one caller it is for', async () => {
    // Positive control for every refusal below. The follow-up `request_deploy`
    // MCP tool resolves `http://localhost:<port>`, so this is the real path.
    const port = start();
    const res = await fetch(`http://127.0.0.1:${port}/api/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(runs.n).toBe(1);
  });

  it('a non-loopback caller is refused, and cannot talk its way in with a Host header', async () => {
    const addrs = nonLoopbackAddresses();
    if (addrs.length === 0) {
      // Stated rather than silently skipped: a machine with no non-loopback
      // IPv4 cannot host this scenario, and a quiet pass would read like
      // evidence. The predicate table above still covers the logic.
      expect(addrs).toEqual([]);
      return;
    }
    const from = addrs[0] as string;
    const port = start();

    // Assert the SHAPE before the behaviour: this probe must genuinely be
    // arriving from a non-loopback address, or the 403 proves nothing.
    expect(isLoopbackAddress(from)).toBe(false);

    const res = await fetch(`http://${from}:${port}/api/deploy`, {
      method: 'POST',
      // The spoof attempt is the test. A Host-based gate would let this in.
      headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('loopback');
    // The refusal has to be a refusal, not a 403 rendered after the work.
    expect(runs.n).toBe(0);

    // Positive control on the SAME address in the SAME pass: this caller is
    // otherwise a fully trusted local client. Without this the 403 above is
    // indistinguishable from "that address cannot reach the server at all".
    const ok = await fetch(`http://${from}:${port}/api/docs`, {
      headers: { host: `localhost:${port}` },
    });
    expect(ok.status).toBe(200);
  });

  it('GET stays reachable from a trusted local caller — reading is not deploying', async () => {
    // The read is deliberately NOT loopback-only: a board surface showing
    // deploy state is served over the tailnet, and reporting what already
    // happened cannot restart anything.
    const addrs = nonLoopbackAddresses();
    const port = start();
    const from = addrs[0] ?? '127.0.0.1';
    const res = await fetch(`http://${from}:${port}/api/deploy`, {
      headers: { host: `localhost:${port}` },
    });
    expect(res.status).toBe(200);
    expect(runs.n).toBe(0); // a read that deploys would turn a page load into a deploy
  });
});

/** This machine's non-loopback IPv4 addresses, used to reach its own server
 *  from an address that is genuinely not loopback. */
function nonLoopbackAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}
