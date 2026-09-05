/**
 * The client half of the agent-stream proof.
 *
 * Everything here is about the MCP child NOT breaking. The server's gate is
 * the thing that closes a door; this store's job is to fetch a token once and
 * then get out of the way, and every case below pins a way it could fail to
 * do that: minting on every call, dying when the server is old or down, or
 * clinging to a token the server has stopped honouring.
 *
 * All fixtures synthetic; no network, no server, no real agent names.
 */
import { describe, expect, it } from 'bun:test';
import { createAgentTokenStore } from '../src/agent-token.ts';

const AGENT = 'agent-mira';

interface Call {
  url: string;
}

function store(
  respond: (call: number) => Response,
  over: { identityIsShared?: boolean } = {},
): { headers: () => Promise<Record<string, string>>; forget: () => void; calls: Call[] } {
  const calls: Call[] = [];
  const s = createAgentTokenStore({
    agentId: AGENT,
    resolveBaseUrl: () => 'http://localhost:9999',
    fetch: async (url) => {
      calls.push({ url });
      return respond(calls.length);
    },
    log: () => {},
    identityIsShared: over.identityIsShared ?? false,
  });
  return { headers: () => s.headers(), forget: () => s.forget(), calls };
}

const okToken = (token: string): Response =>
  new Response(JSON.stringify({ agentId: AGENT, token }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('the MCP agent-token store', () => {
  it('asks the right route and puts the token on the header', async () => {
    const s = store(() => okToken('at1.agent-mira.macbytes'));
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.macbytes' });
    expect(s.calls[0]?.url).toBe('http://localhost:9999/api/agents/agent-mira/token');
  });

  it('mints once however many callers ask', async () => {
    // The restore, the first watch and the stream open within milliseconds
    // of each other at session start. Without single-flight that is three
    // mints racing.
    const s = store(() => okToken('at1.agent-mira.macbytes'));
    const [a, b, c] = await Promise.all([s.headers(), s.headers(), s.headers()]);
    expect([a, b, c].every((h) => h.authorization !== undefined)).toBe(true);
    expect(s.calls).toHaveLength(1);
    await s.headers();
    expect(s.calls).toHaveLength(1);
  });

  it('sends no header, and stops asking, against a server that predates the route', async () => {
    // A 404 is a server VERSION, not a blip. Re-asking on every tool call
    // would spend a round trip per call for the life of the session.
    const s = store(() => new Response('not found', { status: 404 }));
    expect(await s.headers()).toEqual({});
    expect(await s.headers()).toEqual({});
    expect(s.calls).toHaveLength(1);
  });

  it('sends no header when the server is down, and retries later', async () => {
    // The opposite of the 404 case: a throw is transient — the supervisor
    // restarts under us routinely — so the next call must try again.
    const s = store((n) => {
      if (n === 1) throw new Error('ECONNREFUSED');
      return okToken('at1.agent-mira.later');
    });
    expect(await s.headers()).toEqual({});
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.later' });
  });

  it('sends no header when the answer is a refusal rather than a token', async () => {
    const s = store(() => new Response(JSON.stringify({ error: 'nope' }), { status: 403 }));
    expect(await s.headers()).toEqual({});
  });

  it('never mints for the shared identity', async () => {
    // `known-agent` is every anonymous session at once, so a token over it
    // is a token all of them hold. The server refuses; this spares the trip.
    const s = store(() => okToken('at1.known-agent.macbytes'), { identityIsShared: true });
    expect(await s.headers()).toEqual({});
    expect(s.calls).toHaveLength(0);
  });

  it('mints again after the token is forgotten', async () => {
    // What a key rotation on the server looks like from here: the held
    // token stops verifying, the loop drops it, and the next attempt gets a
    // live one instead of redialling a dead value forever.
    const s = store((n) => okToken(n === 1 ? 'at1.agent-mira.old' : 'at1.agent-mira.new'));
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.old' });
    s.forget();
    expect(await s.headers()).toEqual({ authorization: 'Bearer at1.agent-mira.new' });
    expect(s.calls).toHaveLength(2);
  });
});
