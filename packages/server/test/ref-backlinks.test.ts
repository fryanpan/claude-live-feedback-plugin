/**
 * POST /workspaces/<ws>/refs:backlinks — which of a board's tasks point at
 * THIS ref.
 *
 * `backlinksFor(ref)` has always been able to answer it for any ref kind.
 * The HTTP surface could only ask it about a `task` ref (`GET
 * /api/tasks/<id>/links`) or a doc/thread (`GET /api/docs/<id>/tasks`), so
 * the question the `url` kind was ADDED for — "which tasks point at this
 * pull request" — was answerable in the store and nowhere else. `diff` refs
 * had no route at all.
 *
 * A POST for a read is deliberate: a ref is a structured value of up to
 * three fields, one of which is an arbitrary URL. Encoding that into a
 * query string puts caller URLs into every access log and proxy on the
 * path, for no gain — the route has no side effects either way.
 *
 * Route-level, per the groups lesson: the store method was already correct
 * and unit-tested; the layer that was missing is the one nothing
 * type-checks.
 *
 * The board in the address is the question's OWNER, not a hint. Until the
 * canonical-routes cutover this route sat outside `/workspaces/` and answered
 * across every board on the server, so a member of one board could read a
 * private row's title, id, status and assignee off another by asking about a
 * ref they both happened to cite. The tests below are written from both
 * sides of that boundary: each board sees its own citer and not the other's,
 * and neither is ever answered with the union.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Ref, Task, TaskChip } from '../src/tasks.ts';

const AGENT: User = {
  id: 'agent-search-revamp',
  name: 'Search Revamp',
  kind: 'known',
  color: '#888888',
};

const PR = 'https://github.com/example-org/example-repo/pull/41';
const OTHER_PR = 'https://github.com/example-org/example-repo/pull/42';

describe('POST /workspaces/<ws>/refs:backlinks', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;
  let otherWsId: string;
  let citesPr: Task;
  let alsoCitesPr: Task;
  let citesOtherPr: Task;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const mkTask = async (workspaceId: string, title: string, links: Ref[]): Promise<Task> => {
    const r = await post(`/workspaces/${workspaceId}/tasks`, {
      title,
      goal: 'chores',
      author: AGENT,
      body: `Agent can ${title} so that the queue keeps moving.`,
      links,
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { task: Task }).task;
  };

  /** The route under test, as a caller uses it: always from some board. */
  const backlinks = async (
    ref: unknown,
    workspaceId = wsId,
  ): Promise<{ status: number; tasks?: TaskChip[] }> => {
    const r = await post(`/workspaces/${workspaceId}/refs:backlinks`, { ref });
    const payload = (await r.json()) as { tasks?: TaskChip[] };
    return { status: r.status, tasks: payload.tasks };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ref-backlinks-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;

    const ws = await post('/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const other = await post('/workspaces', { name: 'billing', goal: 'Ship invoices.' });
    otherWsId = ((await other.json()) as { workspace: { id: string } }).workspace.id;

    citesPr = await mkTask(wsId, 'review the ranking change', [{ kind: 'url', url: PR }]);
    // A second citer of the SAME ref on a DIFFERENT board. It is what makes
    // the scoping assertions below mean anything: with only one citer on the
    // server, a route that answered across every board would look identical
    // to one that answers within a board.
    alsoCitesPr = await mkTask(otherWsId, 'update the invoice copy', [{ kind: 'url', url: PR }]);
    citesOtherPr = await mkTask(wsId, 'bump the client', [{ kind: 'url', url: OTHER_PR }]);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers "which of MY board\'s tasks point at this pull request"', async () => {
    const res = await backlinks({ kind: 'url', url: PR });
    expect(res.status).toBe(200);
    const ids = (res.tasks ?? []).map((t) => t.id).sort();
    expect(ids).toEqual([citesPr.id]);
    // Discrimination, not just presence: the task citing a DIFFERENT PR
    // exists on this same board and is not in the answer. Without this the
    // assertion above would pass on a route that returned every task.
    expect(ids).not.toContain(citesOtherPr.id);
  });

  it("does not leak the other board's citer of the same ref", async () => {
    // `alsoCitesPr` cites the very same PR and is real — the assertion in the
    // test above is what proves the route can see it at all when asked from
    // the right board. Here it must be absent, and its own board must be the
    // place it does show up: an empty answer both ways would pass a route
    // that had simply stopped working.
    expect((await backlinks({ kind: 'url', url: PR })).tasks?.map((t) => t.id)).not.toContain(
      alsoCitesPr.id,
    );
    const fromOther = await backlinks({ kind: 'url', url: PR }, otherWsId);
    expect(fromOther.status).toBe(200);
    expect((fromOther.tasks ?? []).map((t) => t.id)).toEqual([alsoCitesPr.id]);
  });

  it('404s a board that does not exist rather than answering from nowhere', async () => {
    // The board is part of the address, so an unknown one is an unknown
    // resource — not an empty backlink list, which would read as "nothing
    // cites this PR" for a caller who fat-fingered a board id.
    const res = await backlinks({ kind: 'url', url: PR }, 'no-such-board');
    expect(res.status).toBe(404);
    expect(res.tasks).toBeUndefined();
  });

  it('returns chips, not whole tasks — the visitor-safe shape', async () => {
    const [chip] = (await backlinks({ kind: 'url', url: OTHER_PR })).tasks ?? [];
    expect(chip).toBeDefined();
    expect(chip?.id).toBe(citesOtherPr.id);
    expect(chip?.title).toBe('bump the client');
    // The agent that filed it has not been vetted yet, and the chip reports
    // the row's real status rather than a flattened one.
    expect(chip?.status).toBe('triage');
    // The body is real on this task (positive control lives in the create),
    // so its absence here is the chip shape holding, not an empty task.
    expect(Object.keys(chip as object).sort()).toEqual(['assignee', 'id', 'status', 'title']);
  });

  it('answers for a doc ref too, so the route is not url-only', async () => {
    const t = await mkTask(wsId, 'fold in the spec', [{ kind: 'doc', docId: 'spec-doc' }]);
    const res = await backlinks({ kind: 'doc', docId: 'spec-doc' });
    expect(res.status).toBe(200);
    expect((res.tasks ?? []).map((c) => c.id)).toEqual([t.id]);
  });

  it('a ref nobody points at is an empty answer, not a 404', async () => {
    // 404 would mean "no such ref", and there is no such thing — refs are
    // not existence-checked anywhere in this model. The caller asked a
    // question with a real answer: nobody.
    const res = await backlinks({ kind: 'url', url: 'https://example.com/nothing-cites-this' });
    expect(res.status).toBe(200);
    expect(res.tasks).toEqual([]);
  });

  it('refuses a malformed ref rather than answering "nobody"', async () => {
    // The dangerous failure is a typo'd ref returning [] — indistinguishable
    // from a true empty answer, so a caller reads "no tasks point at this PR"
    // when the truth is "I did not understand what you asked".
    const res = await backlinks({ kind: 'url', url: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(res.tasks).toBeUndefined();

    expect((await backlinks({ kind: 'nonsense' })).status).toBe(400);
    expect((await backlinks(undefined)).status).toBe(400);
  });
});
