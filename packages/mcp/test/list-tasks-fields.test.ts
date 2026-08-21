/**
 * Oversized tool results, both halves of the fix:
 *
 *  - `list_tasks` returned 122KB on a real board — every row still carried
 *    reviews (quotes/answers), infoRequests, options, evidence. `fields`
 *    lets a caller pick the keys it needs. Handler-side ONLY: the REST
 *    route is untouched, so no old bundle's call changes shape.
 *  - `doc_status` is the new cheap read for a doc (`get_doc` hit 320KB);
 *    the MCP tool must actually reach GET /api/docs/:id/status.
 *
 * The projection is behavioral (task-projection.ts exports it); the wiring
 * is source-read like tool-wiring.test.ts, because mcp.ts is a bundle entry
 * point and exports nothing. All fixtures are synthetic.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectTaskRows } from '../src/task-projection.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

/** The `case 'x': {` block for one tool, up to the next case. */
function handlerFor(tool: string): string {
  const start = SRC.indexOf(`case '${tool}': {`);
  expect(start, `no handler for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  return rest.slice(0, rest.indexOf('case '));
}

/** The declaration block for one tool, up to the next tool entry. */
function declarationFor(tool: string): string {
  const start = SRC.indexOf(`name: '${tool}',\n      description:`);
  expect(start, `no declaration for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  return rest.slice(0, rest.indexOf('},\n    {'));
}

const rows = [
  {
    id: 't-1',
    title: 'First task',
    status: 'todo',
    body: 'a long body that must not ride along by default',
    transitions: [{ to: 'todo' }, { to: 'in-progress' }],
    reviews: [{ quote: 'heavy' }],
    infoRequests: [{ q: 'heavy' }],
    evidence: { commit: 'abc' },
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
      evidence: { commit: 'abc' },
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

describe('list_tasks wiring', () => {
  it('declares the optional fields param and its description says what it drops', () => {
    const decl = declarationFor('list_tasks');
    expect(decl).toContain('fields: {');
    expect(decl).toMatch(/reviews|infoRequests/);
  });

  it('the handler routes rows through projectTaskRows with the fields arg', () => {
    const h = handlerFor('list_tasks');
    expect(h).toContain('projectTaskRows(');
    expect(h).toContain('fields');
  });
});

describe('doc_status wiring', () => {
  it('is declared, and the description says it is the cheap non-content read', () => {
    const decl = declarationFor('doc_status');
    expect(decl.toLowerCase()).toMatch(/without .*(body|content)|no (body|content)/);
  });

  it('the handler calls GET /api/docs/:id/status', () => {
    const h = handlerFor('doc_status');
    expect(h).toMatch(/'GET'/);
    expect(h).toContain('/status');
  });
});

describe('the committed bundle peers load carries all of it', () => {
  it('has doc_status and the fields projection', () => {
    // Positive control first: a long-shipped tool is present, so a useless
    // bundle read fails here rather than passing the rest vacuously.
    expect(BUNDLE).toContain('list_attachments');
    expect(BUNDLE).toContain('doc_status');
    expect(BUNDLE).toContain('projectTaskRows');
  });
});
