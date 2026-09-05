/**
 * Oversized tool results, both halves of the fix:
 *
 *  - `list_tasks` returned 122KB on a real board — every row still carried
 *    reviews (quotes/answers), infoRequests, options. `fields`
 *    lets a caller pick the keys it needs. Handler-side ONLY: the REST
 *    route is untouched, so no old bundle's call changes shape.
 *  - `doc_status` is the new cheap read for a doc (`get_doc` hit 320KB);
 *    the MCP tool must actually reach GET /api/docs/:id/status.
 *
 * The projection is a real unit (task-projection.ts exports it). The wiring
 * used to be checked by slicing `mcp.ts` and then asserting the built bundle
 * contains the strings `doc_status` and `projectTaskRows` — which is true of a
 * bundle where nothing calls either. It is now driven through the committed
 * bundle: the rows a caller receives are trimmed for real, and doc_status'
 * request is the one the stub recorded. All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectTaskRows } from '../src/task-projection.ts';
import { type BundleHarness, type Recorded, startBundle } from './harness/mcp-bundle.ts';

const rows = [
  {
    id: 't-1',
    title: 'First task',
    status: 'todo',
    body: 'a long body that must not ride along by default',
    transitions: [{ to: 'todo' }, { to: 'in-progress' }],
    reviews: [{ quote: 'heavy' }],
    infoRequests: [{ q: 'heavy' }],
    options: [{ id: 'o-1', label: 'heavy' }],
  },
  {
    id: 't-2',
    title: 'Second task',
    status: 'done',
    body: 'another body',
    transitions: [],
  },
];

describe('projectTaskRows — the default is byte-for-byte the old trim', () => {
  it('strips body and transitions, keeps everything else, adds transitionCount', () => {
    const out = projectTaskRows(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 't-1',
      title: 'First task',
      status: 'todo',
      reviews: [{ quote: 'heavy' }],
      infoRequests: [{ q: 'heavy' }],
      options: [{ id: 'o-1', label: 'heavy' }],
      transitionCount: 2,
    });
    expect(out[1]).toEqual({
      id: 't-2',
      title: 'Second task',
      status: 'done',
      transitionCount: 0,
    });
  });

  it('an empty fields list means the default trim, not empty rows', () => {
    expect(projectTaskRows(rows, [])).toEqual(projectTaskRows(rows));
  });
});

describe('projectTaskRows — fields picks exactly those keys, id always included', () => {
  it('fields: [title, status] → rows are exactly {id, title, status}', () => {
    expect(projectTaskRows(rows, ['title', 'status'])).toEqual([
      { id: 't-1', title: 'First task', status: 'todo' },
      { id: 't-2', title: 'Second task', status: 'done' },
    ]);
  });

  it('a field the row does not have is omitted, not null', () => {
    const out = projectTaskRows(rows, ['reviews']);
    expect(out[0]).toEqual({ id: 't-1', reviews: [{ quote: 'heavy' }] });
    expect(out[1]).toEqual({ id: 't-2' });
  });

  it('transitionCount is computable under projection without hauling transitions', () => {
    expect(projectTaskRows(rows, ['transitionCount'])).toEqual([
      { id: 't-1', transitionCount: 2 },
      { id: 't-2', transitionCount: 0 },
    ]);
  });

  it('an explicit ask still gets the heavy field (projection filters, it does not censor)', () => {
    expect(projectTaskRows(rows, ['body'])[0]).toEqual({
      id: 't-1',
      body: 'a long body that must not ride along by default',
    });
  });
});

let mcp: BundleHarness;

beforeAll(async () => {
  mcp = await startBundle((req: Recorded) =>
    req.path.endsWith('/status') ? { docId: 'doc-1', blocks: 12, threads: 3 } : { tasks: rows },
  );
}, 60_000);
afterAll(async () => {
  await mcp?.stop();
});

describe('list_tasks wiring', () => {
  it('POSITIVE CONTROL: the running bundle serves a known tool', () => {
    expect(mcp.tool('list_agents')).toBeDefined();
    expect(mcp.tool('list_task_fields')).toBeUndefined();
  });

  it('declares the optional fields param and its description says what it drops', () => {
    const fields = mcp.tool('list_tasks')?.inputSchema?.properties?.fields;
    expect(fields).toBeDefined();
    expect(fields?.description ?? '').toMatch(/reviews|infoRequests/);
    expect(mcp.tool('list_tasks')?.inputSchema?.required).not.toContain('fields');
  });

  it('trims the heavy keys off every row by default', async () => {
    const res = await mcp.call('list_tasks', { workspaceId: 'w-1' });
    expect(res.isError).toBe(false);
    const out = res.json as { tasks: Array<Record<string, unknown>> };
    expect(out.tasks.map((t) => t.id)).toEqual(['t-1', 't-2']);
    for (const t of out.tasks) {
      expect(t).not.toHaveProperty('body');
      expect(t).not.toHaveProperty('transitions');
    }
    expect(out.tasks[0]).toHaveProperty('transitionCount', 2);
  });

  it('picks exactly the asked-for keys when fields is given', async () => {
    const res = await mcp.call('list_tasks', { workspaceId: 'w-1', fields: ['title', 'status'] });
    const out = res.json as { tasks: Array<Record<string, unknown>> };
    expect(Object.keys(out.tasks[0] ?? {}).sort()).toEqual(['id', 'status', 'title']);
  });

  it('sends the workspace filters as query params, not as a body', async () => {
    const res = await mcp.call('list_tasks', { workspaceId: 'w-1', status: 'todo' });
    const get = res.sent.find((r) => r.method === 'GET');
    expect(get?.path).toBe('/api/workspaces/w-1/tasks');
    expect(get?.query.get('status')).toBe('todo');
    // `fields` is a handler-side trim: the route never learns about it, which
    // is what keeps an old bundle's call shape unchanged.
    expect(get?.query.get('fields')).toBeNull();
  });
});

describe('doc_status wiring', () => {
  it('is declared, and the description says it is the cheap non-content read', () => {
    const decl = mcp.tool('doc_status');
    expect(decl).toBeDefined();
    expect((decl?.description ?? '').toLowerCase()).toMatch(
      /without .*(body|content)|no (body|content)/,
    );
  });

  it('GETs /api/docs/:id/status and returns what it got', async () => {
    const res = await mcp.call('doc_status', { docId: 'doc-1' });
    const status = res.sent.find((r) => r.path.endsWith('/status'));
    expect(status?.method).toBe('GET');
    expect(status?.path).toBe('/api/docs/doc-1/status');
    expect(res.json).toEqual({ docId: 'doc-1', blocks: 12, threads: 3 });
  });
});
