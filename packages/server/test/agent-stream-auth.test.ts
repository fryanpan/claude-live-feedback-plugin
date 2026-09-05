/**
 * Who may read ONE agent's feed.
 *
 * `/events/agent/<id>` carries every channel an agent watches on a single
 * socket, and `/api/agents/<id>/watches` is that feed's index -- it names
 * every key the stream will deliver. Both were gated on one thing: not being
 * a share visitor. And an agent id is `agentIdForName(name)`, a hash of a
 * name written on the board in plain sight, so knowing a peer's NAME was
 * enough to derive their id and open their whole feed without knowing a
 * single doc id.
 *
 * Two doors onto one feed, so every case here runs against BOTH. A gate
 * added to the stream and forgotten on the index would leave the same
 * information readable through the other door, and the index is the more
 * useful of the two to an attacker who wants to know where to look next.
 *
 * The cases split the way the gate does. The SHAPE refusals -- through the
 * edge, off the box, from a browser -- are enforced unconditionally, because
 * every MCP child that exists already satisfies all three. The token is what
 * says WHICH agent, needs a client change to present, and therefore rolls
 * out: `requireAgentToken: false` is the deprecation window and is what the
 * two legacy cases pin.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentTokenKey,
  authorizeAgentCaller,
  createLegacyAgentWarner,
  mintAgentToken,
  verifyAgentToken,
} from '../src/auth/agent-token.ts';
import { mintToken, tokenKey } from '../src/auth/signed-token.ts';
import { widgetToken } from '../src/auth/widget-token.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

/** Two invented agents. Neither name resolves to anything real. */
const MIRA = 'agent-mira';
const RENZO = 'agent-renzo';

/** Both doors onto the same feed, driven by every case below. */
const ROUTES = [
  { name: 'the watch set', path: (id: string) => `/api/agents/${id}/watches` },
  { name: 'the event stream', path: (id: string) => `/events/agent/${id}` },
] as const;

describe('an agent feed is readable only by that agent', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}`, ...headers } });

  /** The token this server would hand MIRA's own process. */
  const tokenFor = async (agentId: string): Promise<string> => {
    const res = await get(`/api/agents/${agentId}/token`);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { token: string }).token;
  };

  /** SSE responses hold their connection open; release it or the suite
   *  leaks one protocol control block per assertion. */
  const release = async (res: Response): Promise<void> => {
    await res.body?.cancel().catch(() => {});
  };

  const start = (opts: { requireAgentToken?: boolean } = {}): void => {
    handle = createServer({ port: 0, dataDir, ...opts });
    base = `http://localhost:${handle.port}`;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-stream-auth-'));
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('with the token required', () => {
    beforeEach(() => start({ requireAgentToken: true }));

    for (const route of ROUTES) {
      it(`serves ${route.name} to the agent's own token`, async () => {
        const res = await get(route.path(MIRA), {
          authorization: `Bearer ${await tokenFor(MIRA)}`,
        });
        // Status only, never the body: one of these two routes answers with
        // an SSE stream that stays open, so reading it waits forever.
        expect(res.status).toBe(200);
        await release(res);
      });

      it(`refuses ${route.name} to another agent's token`, async () => {
        // The whole point. Renzo's process holds a perfectly valid token --
        // it just does not speak for Mira, whose id Renzo could derive from
        // her name in a second.
        const res = await get(route.path(MIRA), {
          authorization: `Bearer ${await tokenFor(RENZO)}`,
        });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe('agent-token-mismatch');
      });

      it(`refuses ${route.name} to a caller with no token`, async () => {
        const res = await get(route.path(MIRA));
        expect(res.status).toBe(401);
        expect(((await res.json()) as { error: string }).error).toBe('agent-token-required');
      });

      it(`refuses ${route.name} to a forged token`, async () => {
        const res = await get(route.path(MIRA), {
          authorization: `Bearer at1.${MIRA}.notavalidmacatall`,
        });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe('agent-token-mismatch');
      });
    }
  });

  describe('during the deprecation window (no token required)', () => {
    beforeEach(() => start());

    for (const route of ROUTES) {
      it(`still serves ${route.name} to a caller on the old bundle`, async () => {
        // The rollout promise: a session running a bundle that predates the
        // header keeps its watch restore and its stream. Cutting it off is
        // the outage the multiplexed route was built to end.
        const res = await get(route.path(MIRA));
        expect(res.status).toBe(200);
        await release(res);
      });

      it(`refuses ${route.name} to another agent's token even now`, async () => {
        // A WRONG token is never a fall-back onto the legacy path. Without
        // this, presenting a bad token would be strictly better for an
        // attacker than presenting none.
        const res = await get(route.path(MIRA), {
          authorization: `Bearer ${await tokenFor(RENZO)}`,
        });
        expect(res.status).toBe(403);
      });

      it(`refuses ${route.name} to a browser`, async () => {
        // A page on another local port has a loopback peer address too, and
        // rides the owner's session. Enforced regardless of the flag.
        const res = await get(route.path(MIRA), { origin: 'http://localhost:5173' });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe('agent-stream-browser');
      });

      it(`refuses ${route.name} to a request that crossed the edge`, async () => {
        // cloudflared runs on this box, so a tunnelled request also has a
        // loopback peer; only `cf-ray` says it came through.
        //
        // The refusal here is the HOST GATE's, not this module's: a `cf-ray`
        // arriving on a `localhost` Host is a request claiming to have
        // crossed an edge that would never have routed it, and admission
        // answers `unknown_host` before any route runs. That is the stronger
        // of the two refusals and the reason this case asserts the status
        // rather than the code. The `agent-stream-proxied` refusal these
        // routes make on their own -- for a `cf-ray` on a host admission DOES
        // admit -- is pinned directly on `authorizeAgentCaller` below.
        const res = await get(route.path(MIRA), { 'cf-ray': '8f0aa11223344556-SJC' });
        expect(res.status).toBe(403);
      });
    }
  });

  describe('the mint route', () => {
    beforeEach(() => start());

    it('hands the same token back on every ask', async () => {
      // Stateless: the token is an HMAC over the id, so a re-mint is not a
      // rotation and a restarted child does not invalidate its own stream.
      expect(await tokenFor(MIRA)).toBe(await tokenFor(MIRA));
    });

    it('mints different tokens for different agents', async () => {
      expect(await tokenFor(MIRA)).not.toBe(await tokenFor(RENZO));
    });

    it('refuses a browser and a proxied request', async () => {
      expect((await get(`/api/agents/${MIRA}/token`, { origin: 'http://x.test' })).status).toBe(
        403,
      );
      // As above: on a loopback Host the host gate refuses the `cf-ray`
      // first. Still 403, still never a token.
      expect((await get(`/api/agents/${MIRA}/token`, { 'cf-ray': 'abc-SJC' })).status).toBe(403);
    });

    it('refuses the shared identity, whose token every session would hold', async () => {
      const res = await get('/api/agents/known-agent/token');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('shared-identity');
    });

    it('refuses an id that is not one', async () => {
      expect((await get('/api/agents/..%2F..%2Fetc/token')).status).toBe(400);
    });
  });
});

describe('the at1 token format', () => {
  const KEY = agentTokenKey('a-test-base-key-that-is-not-a-real-one');

  it('round-trips the agent it was minted for', () => {
    expect(verifyAgentToken(mintAgentToken(MIRA, KEY), KEY)?.agentId).toBe(MIRA);
  });

  it('does not verify under a different base key', () => {
    const other = agentTokenKey('a-different-base-key');
    expect(verifyAgentToken(mintAgentToken(MIRA, KEY), other)).toBeNull();
  });

  it('refuses a genuine token from another protocol signed with the same base key', () => {
    // The whole reason `keyDomain` exists. A widget token minted from the
    // same key file must never read as an agent token, however the payloads
    // happen to line up.
    const base = 'a-test-base-key-that-is-not-a-real-one';
    const foreign = mintToken(
      widgetToken,
      {
        identityId: MIRA,
        sessionId: 's1',
        sessionIssuedAt: 1,
        expiresAt: Date.now() + 60_000,
        origin: 'http://localhost:5173',
      },
      tokenKey(base, widgetToken),
    );
    expect(verifyAgentToken(foreign, agentTokenKey(base))).toBeNull();
  });

  it('refuses a tampered agent id', () => {
    const minted = mintAgentToken(MIRA, KEY);
    expect(verifyAgentToken(minted.replace(MIRA, RENZO), KEY)).toBeNull();
  });
});

describe('authorizeAgentCaller', () => {
  const KEY = agentTokenKey('another-test-base-key');
  const req = (headers: Record<string, string> = {}): Request =>
    new Request('http://localhost/api/agents/x/watches', { headers });

  const check = (over: Partial<Parameters<typeof authorizeAgentCaller>[0]> = {}) =>
    authorizeAgentCaller({
      agentId: MIRA,
      req: req(),
      address: '127.0.0.1',
      key: KEY,
      requireToken: false,
      ...over,
    });

  it('reads an IPv4-mapped IPv6 loopback peer as local', () => {
    expect(check({ address: '::ffff:127.0.0.1' }).ok).toBe(true);
  });

  it('refuses a peer address that only looks loopback', () => {
    // `isLoopbackAddress` is anchored; this is the control that proves the
    // refusal is not just matching a prefix.
    const verdict = check({ address: '127.0.0.1.evil.example' });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.body.error).toBe('agent-stream-remote');
  });

  it('refuses a tailnet peer', () => {
    expect(check({ address: '100.64.0.7' }).ok).toBe(false);
  });

  it('reports a token caller as proven and a bare one as legacy', () => {
    const withToken = check({
      req: req({ authorization: `Bearer ${mintAgentToken(MIRA, KEY)}` }),
    });
    expect(withToken).toEqual({ ok: true, proof: 'token' });
    expect(check()).toEqual({ ok: true, proof: 'legacy' });
  });

  it('checks the edge before it checks the token', () => {
    // Order matters: a caller that could never be an agent must learn
    // nothing about the token grammar from a value it could not sign.
    const verdict = check({
      req: req({ 'cf-ray': 'x-SJC', authorization: 'Bearer at1.whatever.mac' }),
    });
    expect(verdict.ok === false && verdict.body.error).toBe('agent-stream-proxied');
  });

  it('ignores a bearer for another protocol rather than mis-reading it', () => {
    // `wt1.…` is not shaped like ours, so it is not offered to the verifier
    // at all and the caller falls through to the legacy path -- it does not
    // become an `agent-token-mismatch`, which would be a claim we cannot
    // make about somebody else's value.
    expect(check({ req: req({ authorization: 'Bearer wt1.someone.else' }) })).toEqual({
      ok: true,
      proof: 'legacy',
    });
  });
});

describe('the deprecation-window warning', () => {
  it('logs once per agent id per route, not once per request', () => {
    const lines: string[] = [];
    const warn = createLegacyAgentWarner((m) => lines.push(m));
    warn(MIRA, '/events/agent/<id>');
    warn(MIRA, '/events/agent/<id>');
    warn(MIRA, '/api/agents/<id>/watches');
    warn(RENZO, '/events/agent/<id>');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(MIRA);
    expect(lines[0]).toContain('CW_REQUIRE_AGENT_TOKEN');
  });
});
