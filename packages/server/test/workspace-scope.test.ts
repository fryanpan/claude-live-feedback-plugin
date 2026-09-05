/**
 * The one middleware that resolves a canonical `/workspaces/<id>/…` request,
 * driven both directly and over the real routes.
 *
 * WHY THIS FILE EXISTS. The routes cutover put the board in the PATH so that
 * the access question could be answered once, above every handler, by
 * something that reads paths — `middleware/workspace-scope.ts`. A rule that
 * runs in one place is only worth the move if it is asserted in one place
 * too, so this drives it directly for the shapes a route cannot produce, and
 * then over HTTP for every collection that moved, because the route layer is
 * the part nothing type-checks.
 *
 * TWO THINGS ARE ASSERTED, and the second is the one the old shape could not
 * even express. A board that does not exist is refused. And a ROW filed on
 * another board, named under a board that does exist, is refused as well —
 * `/workspaces/<A>/goals/<band-on-B>` was not a shape a request could have
 * while the path was `/api/goals/<id>` and named no board at all.
 *
 * Every refusal is 404 with no detail, and the tests say so on purpose: a
 * 403 on a foreign id confirms the id is real to whoever guessed it.
 *
 * All fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceScope } from '../src/middleware/workspace-scope.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };

describe('resolveWorkspaceScope', () => {
  const j = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const deps = {
    workspaceExists: (id: string) => id === 'w-here',
    workspaceOfRow: (rowId: string) =>
      rowId === 'g-here' ? 'w-here' : rowId === 'g-elsewhere' ? 'w-other' : undefined,
    j,
  };
  const ask = (pathname: string, method = 'GET') =>
    resolveWorkspaceScope(deps, { pathname, method, url: new URL(`http://x${pathname}`) });

  it('passes a path that is not a board’s at all', () => {
    for (const p of ['/api/docs/d-1', '/', '/signin', '/workspaces']) {
      expect(ask(p).kind, p).toBe('pass');
    }
  });

  it('passes the board’s own address, because that path fronts two stores', () => {
    // `/workspaces/<id>` is a board id OR an attachment set's, dispatched by
    // whichever store knows it. An existence check here would have to ask
    // both — and asking the doc store means scanning every doc per request.
    expect(ask('/workspaces/w-nope').kind).toBe('pass');
    expect(ask('/workspaces/w-nope', 'DELETE').kind).toBe('pass');
  });

  it('passes the board’s HTML pages, unknown board included', () => {
    // A browser gets the shell's own not-found, not a JSON body. The list is
    // shared with the thing that serves them — see workspace-path.ts.
    for (const p of ['', '/home', '/tasks', '/mine', '/activity', '/docs/d-1', '/reviews/r-1']) {
      expect(ask(`/workspaces/w-nope${p}`).kind, p).toBe('pass');
    }
  });

  it('claims the same addresses once ?format=json asks for data', async () => {
    const asked = resolveWorkspaceScope(deps, {
      pathname: '/workspaces/w-nope/home',
      method: 'GET',
      url: new URL('http://x/workspaces/w-nope/home?format=json'),
    });
    expect(asked.kind).toBe('refused');
    if (asked.kind !== 'refused') throw new Error('unreachable');
    expect(asked.response.status).toBe(404);
  });

  it('refuses a board nothing knows, and hands the scope back for one it does', () => {
    expect(ask('/workspaces/w-nope/settings').kind).toBe('refused');
    const ok = ask('/workspaces/w-here/settings');
    expect(ok.kind).toBe('scope');
    if (ok.kind !== 'scope') throw new Error('unreachable');
    expect(ok.scope).toEqual({ workspaceId: 'w-here', rest: 'settings' });
  });

  it('refuses a goal band filed on ANOTHER board', () => {
    expect(ask('/workspaces/w-here/goals/g-here/archive', 'POST').kind).toBe('scope');
    expect(ask('/workspaces/w-here/goals/g-elsewhere/archive', 'POST').kind).toBe('refused');
    expect(ask('/workspaces/w-here/goals/g-unknown/archive', 'POST').kind).toBe('refused');
  });

  it('does not read a goal VERB as a row id', () => {
    // `goals/add`, `goals/rename` and `goals/reorder` put a custom verb
    // exactly where an id goes. A rule keyed on "the segment after the
    // collection" would look `rename` up as a band and refuse every one of
    // them; a row is addressed only when something follows its id.
    for (const verb of ['add', 'rename', 'reorder']) {
      expect(ask(`/workspaces/w-here/goals/${verb}`, 'POST').kind, verb).toBe('scope');
    }
  });

  it('answers a malformed escape rather than throwing on it', () => {
    // A URIError thrown inside a route match closes the connection with no
    // response at all — neither an allow nor a deny, chosen by the caller.
    // A verdict here IS the assertion: it cannot be reached if the call threw.
    expect(ask('/workspaces/w-here/goals/%E0%A4%A/archive', 'POST').kind).toBe('refused');
  });
});

describe('the canonical routes, over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let board: string;
  let other: string;
  let bandOnOther: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-scope-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const mk = async (name: string): Promise<string> => {
      const r = await post('/workspaces', { name, goal: 'Ship it.' });
      return ((await r.json()) as { workspace: { id: string } }).workspace.id;
    };
    board = await mk('near board');
    other = await mk('far board');
    const added = await post(`/workspaces/${other}/goals/add`, {
      title: 'A band on the far board',
      author: PERSON,
    });
    expect(added.status).toBe(200);
    bandOnOther = ((await added.json()) as { goal: { id: string } }).goal.id;
    expect(bandOnOther).not.toBe('');
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * Every collection a board owns, as `<method> <sub>` — with a body where
   * the handler needs one, so a 400 can never be mistaken for the 404 under
   * test. The point of the list is that it is a LIST: a collection missing
   * from it is a collection whose ids nothing checks.
   */
  const COLLECTIONS: Array<[string, string, unknown]> = [
    ['GET', 'home?format=json&user=Jordan', undefined],
    ['GET', 'tasks?format=json', undefined],
    ['GET', 'settings', undefined],
    ['GET', 'events', undefined],
    ['GET', 'agents', undefined],
    ['GET', 'review-items', undefined],
    ['GET', 'next', undefined],
    ['GET', 'related-work', undefined],
    ['POST', 'tasks', { title: 'Filed nowhere', author: PERSON }],
    ['POST', 'goals/add', { title: 'A band', author: PERSON }],
    ['POST', 'goals/reorder', { order: [], author: PERSON }],
    ['POST', 'load-reports', { ms: 12 }],
    ['PUT', 'retired', { retired: true, author: PERSON }],
  ];

  it('refuses every collection on a board id nothing answers to', async () => {
    for (const [method, sub, body] of COLLECTIONS) {
      const r = await local(`/workspaces/w-not-a-board/${sub}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      expect(r.status, `${method} ${sub}`).toBe(404);
    }
  });

  it('POSITIVE CONTROL: the same calls answer on a board that exists', async () => {
    // Without this, "404 everywhere" would also be satisfied by a middleware
    // that refused the whole prefix, which is the failure mode a negative
    // test cannot see.
    for (const [method, sub, body] of COLLECTIONS) {
      const r = await local(`/workspaces/${board}/${sub}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      expect(r.status, `${method} ${sub}`).not.toBe(404);
    }
  });

  it('refuses a goal band that belongs to another board, and says nothing more', async () => {
    const foreign = await post(`/workspaces/${board}/goals/${bandOnOther}/archive`, {
      author: PERSON,
    });
    expect(foreign.status).toBe(404);
    // The same body an unknown board gets: the two answers are deliberately
    // indistinguishable, so a guessed id learns nothing from being real.
    const unknown = await post(`/workspaces/${board}/goals/g-invented/archive`, { author: PERSON });
    expect(unknown.status).toBe(404);
    // POSITIVE CONTROL: the band DOES archive from its own board, so the
    // refusal above is the board boundary rather than a route that is gone.
    const home = await post(`/workspaces/${other}/goals/${bandOnOther}/archive`, {
      author: PERSON,
    });
    expect(home.status).toBe(200);
  });

  it('answers nothing at the retired /api spellings', async () => {
    // No old-path support: the previous addresses were deleted in the same
    // change that moved every caller. A 404 here is the whole of criterion 3
    // that a test can see.
    for (const p of [
      `/api/workspaces/${board}`,
      `/api/workspaces/${board}/tasks`,
      `/api/workspaces/${board}/home`,
      `/api/workspaces/${board}/settings`,
      `/api/goals/${bandOnOther}/cascade`,
    ]) {
      expect((await local(p)).status, p).toBe(404);
    }
    expect((await post(`/api/goals/${bandOnOther}/archive`, { author: PERSON })).status).toBe(404);
  });
});
