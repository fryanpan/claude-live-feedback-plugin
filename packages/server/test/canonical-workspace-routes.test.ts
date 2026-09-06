/**
 * The two board collections that now live at `/workspaces/<id>/…`, and the
 * proof that the addresses they left are gone.
 *
 * These are the route inventory's step-2 collisions: the agent roster sat on
 * `attachments`, which the glossary spends on docs, mockups, previews and
 * diffs, and the board's live feed sat at `/events/workspace/<id>`, which put
 * the workspace in a segment the guard could not read AND spelled the stream
 * `events` — the activity feed's name. Both moved under the workspace that
 * owns them, and neither old address is answered: no redirect, no alias.
 *
 * What each test is actually for:
 *
 *  - The OLD path 404s. A rename nobody can see is a rename that did not
 *    happen — a route left answering both spellings is the dual-prefix alias
 *    this cutover exists to remove, and it would keep every caller on the old
 *    name until something else broke.
 *  - The NEW path does what the old one did, verb by verb, so the move is a
 *    rename rather than a rewrite.
 *  - A FOREIGN workspace id is refused on both collections. The whole point
 *    of putting the workspace in the path is that the id in the path is the
 *    one the answer is scoped to; a route that ignores it has moved its
 *    address and kept its bug.
 *
 * All fixtures are synthetic — invented board and agent names. The repo is
 * public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { matchWorkspaceRoute } from '../src/workspace-path.ts';

describe('matchWorkspaceRoute', () => {
  it('splits a canonical path into the board and what was addressed under it', () => {
    expect(matchWorkspaceRoute('/workspaces/w-1/agents')).toEqual({
      workspaceId: 'w-1',
      rest: 'agents',
    });
    expect(matchWorkspaceRoute('/workspaces/w-1/agents/a-9/heartbeat')).toEqual({
      workspaceId: 'w-1',
      rest: 'agents/a-9/heartbeat',
    });
  });

  it('answers only the collection the caller asked about', () => {
    expect(matchWorkspaceRoute('/workspaces/w-1/agents', 'agents')).toBeDefined();
    // `events:stream` and `events` are different addresses on purpose: the
    // live stream and the activity feed used to share a name.
    expect(matchWorkspaceRoute('/workspaces/w-1/events', 'events:stream')).toBeUndefined();
    expect(matchWorkspaceRoute('/workspaces/w-1/events:stream', 'events:stream')).toBeDefined();
  });

  it('refuses a path that names no board, rather than matching an empty id', () => {
    // `/workspaces//agents` would otherwise hand the store an empty id and
    // fail one route further down, where the message is about the store.
    expect(matchWorkspaceRoute('/workspaces//agents')).toBeUndefined();
    // The board itself is not a collection: an empty remainder and "a
    // collection nobody named" would otherwise be the same value.
    expect(matchWorkspaceRoute('/workspaces/w-1')).toBeUndefined();
    // The parser reads the canonical prefix and only that. It used to be
    // proven against `/api/workspaces/<id>/agents`, which is a path that no
    // longer exists anywhere; a prefix that merely CONTAINS the canonical one
    // is the shape still worth refusing.
    expect(matchWorkspaceRoute('/api/workspaces/w-1/agents')).toBeUndefined();
    expect(matchWorkspaceRoute('/x/workspaces/w-1/agents')).toBeUndefined();
  });

  it('decodes the board segment, and answers itself on a malformed escape', () => {
    expect(matchWorkspaceRoute('/workspaces/w%2D1/agents')?.workspaceId).toBe('w-1');
    // A stray `%` is a caller's typo; throwing here would close the
    // connection with no response at all.
    expect(matchWorkspaceRoute('/workspaces/w%zz/agents')?.workspaceId).toBe('w%zz');
  });
});

describe('the board collections that moved under /workspaces/<id>', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, { method: 'POST', body: JSON.stringify(body) });

  const makeWorkspace = async (name: string): Promise<string> => {
    const r = await post('/workspaces', { name, goal: 'Ship it.' });
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'canonical-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves the agent roster at /workspaces/<id>/agents, through every verb', async () => {
    const ws = await makeWorkspace('canonical-roster');
    const attached = await post(`/workspaces/${ws}/agents`, {
      agentId: 'agent-kestrel',
      agentName: 'Kestrel',
      runtime: 'claude-code-local',
    });
    expect(attached.status).toBe(200);

    const listed = await local(`/workspaces/${ws}/agents`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      workspaceId: string;
      attachments: Array<{ agentId: string }>;
    };
    expect(body.workspaceId).toBe(ws);
    expect(body.attachments.map((a) => a.agentId)).toContain('agent-kestrel');

    expect((await post(`/workspaces/${ws}/agents/agent-kestrel/heartbeat`, {})).status).toBe(200);
    expect(
      (await local(`/workspaces/${ws}/agents/agent-kestrel`, { method: 'DELETE' })).status,
    ).toBe(200);
    expect(
      (await local(`/workspaces/${ws}/agents/agent-kestrel`, { method: 'DELETE' })).status,
    ).toBe(404);
  });

  it('refuses a roster read for a board that is not this one', async () => {
    // The id in the path is the id the answer is scoped to. A board that does
    // not exist and a board somebody else holds answer the same way — the
    // route is not an existence oracle.
    const ws = await makeWorkspace('canonical-scope');
    await post(`/workspaces/${ws}/agents`, { agentId: 'agent-wren', runtime: 'claude-code-local' });
    expect((await local('/workspaces/w-other/agents')).status).toBe(404);
    expect(
      (
        await post('/workspaces/w-other/agents', {
          agentId: 'agent-wren',
          runtime: 'claude-code-local',
        })
      ).status,
    ).toBe(404);
    expect((await post('/workspaces/w-other/agents/agent-wren/heartbeat', {})).status).toBe(404);
    expect(
      (await local('/workspaces/w-other/agents/agent-wren', { method: 'DELETE' })).status,
    ).toBe(404);
  });

  it('opens the board stream at /workspaces/<id>/events:stream, and 404s an unknown board', async () => {
    const ws = await makeWorkspace('canonical-stream');
    const res = await local(`/workspaces/${ws}/events:stream`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await (res.body as ReadableStream<Uint8Array>).cancel();

    const missing = await local('/workspaces/w-other/events:stream', {
      headers: { accept: 'text/event-stream' },
    });
    expect(missing.status).toBe(404);
    await missing.text();
  });

  it('answers nothing at the addresses these two collections left', async () => {
    // No redirect and no alias: the cutover's rule is that a caller on the
    // old spelling learns it immediately rather than working for another
    // release on a name that is going away.
    const ws = await makeWorkspace('canonical-old-paths');
    expect((await local(`/workspaces/${ws}/attachments`)).status).toBe(404);
    expect(
      (
        await post(`/workspaces/${ws}/attachments`, {
          agentId: 'agent-ghost',
          runtime: 'claude-code-local',
        })
      ).status,
    ).toBe(404);
    expect((await post(`/workspaces/${ws}/attachments/agent-ghost/heartbeat`, {})).status).toBe(
      404,
    );
    // The `/events/` prefix is gone with the rest of the pre-cutover paths —
    // a doc's stream is `/workspaces/<ws>/docs/<id>/events:stream` — so the
    // board's old address reaches nothing at all now rather than reaching the
    // per-doc stream and being refused by it.
    const oldStream = await local(`/events/workspace/${ws}`, {
      headers: { accept: 'text/event-stream' },
    });
    expect(oldStream.status).toBe(404);
  });
});
