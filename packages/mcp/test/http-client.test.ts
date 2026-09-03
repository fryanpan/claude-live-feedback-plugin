/**
 * Finding the server, and what happens when it answers badly.
 *
 * Both behaviours in here were previously unreachable: they lived in `mcp.ts`,
 * which starts an MCP server on import, so no test could call them. Each one
 * exists because of a specific field failure, and each is asserted here
 * against the failure rather than against the shape of the code.
 */
import { describe, expect, it } from 'vitest';
import { type DiscoveryDeps, createHttp, err, ok, resolveBaseUrl } from '../src/http-client.ts';

/** A discovery world where nothing exists and no env var is set. */
function emptyWorld(over: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return {
    env: {},
    homedir: () => '/home/tester',
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('no such file');
    },
    ...over,
  };
}

/** A world whose single discovery file holds `body`. */
function worldWithDiscovery(body: string, over: Partial<DiscoveryDeps> = {}): DiscoveryDeps {
  return emptyWorld({
    existsSync: () => true,
    readFileSync: () => body,
    ...over,
  });
}

describe('resolveBaseUrl', () => {
  it('prefers the environment override over any discovery file', () => {
    const deps = worldWithDiscovery(JSON.stringify({ port: 9999 }), {
      env: { CW_BASE_URL: 'http://staging.invalid:8788' },
    });
    expect(resolveBaseUrl(deps)).toBe('http://staging.invalid:8788');
  });

  it('reads the port out of the discovery file when no override is set', () => {
    expect(resolveBaseUrl(worldWithDiscovery(JSON.stringify({ port: 8787 })))).toBe(
      'http://localhost:8787',
    );
  });

  it('honours a non-default port, which is the whole reason discovery exists', () => {
    expect(resolveBaseUrl(worldWithDiscovery(JSON.stringify({ port: 51234 })))).toBe(
      'http://localhost:51234',
    );
  });

  /**
   * THE FAILURE THIS GUARDS. 8787 used to be a silent fallback, and on a
   * machine where another MCP server had taken that port every tool call went
   * to the wrong process and answered plausible nonsense. Absent discovery
   * must be loud.
   */
  it('throws rather than guessing a port when there is no discovery file', () => {
    expect(() => resolveBaseUrl(emptyWorld())).toThrow(/server not found/);
  });

  it('names both places it looked, so the message is actionable', () => {
    let message = '';
    try {
      resolveBaseUrl(emptyWorld());
    } catch (e) {
      message = (e as Error).message;
    }
    // Not a literal path: the candidates come from machine-paths, and what
    // matters is that the message points at the home directory it searched
    // and at the escape hatch.
    expect(message).toContain('/home/tester');
    expect(message).toContain('CW_BASE_URL');
  });

  it('throws on a corrupt discovery file instead of half-resolving it', () => {
    expect(() => resolveBaseUrl(worldWithDiscovery('{not json'))).toThrow(/server not found/);
  });

  it('throws when the discovery file parses but carries no port', () => {
    expect(() => resolveBaseUrl(worldWithDiscovery(JSON.stringify({ pid: 42 })))).toThrow(
      /server not found/,
    );
  });

  /**
   * Resolution happens per call, not once at module load. The stdio child
   * outlives server restarts — sometimes by days — and a restart can move the
   * port. A frozen base URL would send every later call into a closed socket.
   */
  it('re-reads discovery on every call, so a restarted server on a new port is followed', () => {
    let port = 8787;
    const deps = emptyWorld({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ port }),
    });
    expect(resolveBaseUrl(deps)).toBe('http://localhost:8787');
    port = 8790;
    expect(resolveBaseUrl(deps)).toBe('http://localhost:8790');
  });
});

/** A fetch fake that records its calls and replays scripted responses. */
function fakeFetch(script: Array<{ status: number; body: string }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    return new Response(next.body, { status: next.status });
  };
  return { fn, calls };
}

describe('createHttp', () => {
  it('sends the method and joins the path onto the resolved base URL', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: '{"ok":true}' }]);
    const http = createHttp(() => 'http://localhost:8787', fn);
    await http('GET', '/api/docs');
    expect(calls[0].url).toBe('http://localhost:8787/api/docs');
    expect(calls[0].init?.method).toBe('GET');
  });

  it('serialises a body and declares it JSON', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: '{}' }]);
    const http = createHttp(() => 'http://localhost:8787', fn);
    await http('POST', '/api/tasks', { title: 'ship it' });
    expect(calls[0].init?.body).toBe('{"title":"ship it"}');
    expect(calls[0].init?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('sends no body and no content-type when there is nothing to send', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: '{}' }]);
    const http = createHttp(() => 'http://localhost:8787', fn);
    await http('GET', '/api/docs');
    expect(calls[0].init?.body).toBeUndefined();
    expect(calls[0].init?.headers).toEqual({});
  });

  it('returns the parsed JSON body', async () => {
    const { fn } = fakeFetch([{ status: 200, body: '{"docId":"d-1","threads":[]}' }]);
    const http = createHttp(() => 'http://localhost:8787', fn);
    expect(await http('GET', '/api/docs/d-1')).toEqual({ docId: 'd-1', threads: [] });
  });

  it('returns an empty object for an empty 200, rather than throwing on the parse', async () => {
    const { fn } = fakeFetch([{ status: 204, body: '' }]);
    const http = createHttp(() => 'http://localhost:8787', fn);
    expect(await http('DELETE', '/api/docs/d-1')).toEqual({});
  });

  /**
   * THE FAILURE THIS GUARDS. The server's catch-all answers an unmatched
   * route with the bare string `not found`, which is not JSON. Parsing before
   * checking the status turned every 404 into a `SyntaxError` about an
   * unexpected token, and the actual news — wrong path — never reached the
   * agent.
   */
  it('reports the status and the route on a 404 whose body is not JSON', async () => {
    const { fn } = fakeFetch([{ status: 404, body: 'not found' }]);
    const http = createHttp(() => 'http://localhost:8787', fn);
    await expect(http('POST', '/api/typo')).rejects.toThrow(/POST \/api\/typo/);
    await expect(http('POST', '/api/typo')).rejects.toThrow(/404/);
    // And specifically NOT a JSON parse error, which is what buried it.
    await expect(http('POST', '/api/typo')).rejects.not.toThrow(/JSON/);
  });

  it('surfaces a 500 body verbatim, since that is where the server explains itself', async () => {
    const { fn } = fakeFetch([{ status: 500, body: 'room d-1 has no bound path' }]);
    const http = createHttp(() => 'http://localhost:8787', fn);
    await expect(http('POST', '/api/docs/d-1/reparse')).rejects.toThrow(
      /room d-1 has no bound path/,
    );
  });

  it('resolves the base URL per call, so a moved server is followed mid-session', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: '{}' }]);
    let base = 'http://localhost:8787';
    const http = createHttp(() => base, fn);
    await http('GET', '/a');
    base = 'http://localhost:8790';
    await http('GET', '/b');
    expect(calls.map((c) => c.url)).toEqual(['http://localhost:8787/a', 'http://localhost:8790/b']);
  });

  it('propagates a resolver that cannot find the server, rather than calling fetch', async () => {
    let fetched = 0;
    const http = createHttp(
      () => {
        throw new Error('claude-workspaces server not found');
      },
      async () => {
        fetched += 1;
        return new Response('{}');
      },
    );
    await expect(http('GET', '/api/docs')).rejects.toThrow(/server not found/);
    expect(fetched).toBe(0);
  });
});

describe('tool results', () => {
  it('ok carries the data as pretty-printed JSON text', () => {
    const r = ok({ docId: 'd-1', threads: 2 });
    expect(r.content[0].type).toBe('text');
    expect(JSON.parse(r.content[0].text)).toEqual({ docId: 'd-1', threads: 2 });
    // Pretty-printed: an agent reads these, and one long line is unreadable.
    expect(r.content[0].text.split('\n').length).toBeGreaterThan(1);
  });

  it('ok has no error flag, which is what a client branches on', () => {
    expect('isError' in ok({})).toBe(false);
  });

  it('err flags the failure and passes the message through unchanged', () => {
    const r = err('unknown tool: watch_dock');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('unknown tool: watch_dock');
  });
});
