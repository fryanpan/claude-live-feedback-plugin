/**
 * The `decision.answered` channel line, fed the rows the SERVER actually
 * writes rather than hand-written fixtures.
 *
 * Same lesson as `activity-lines.test.ts`: a renderer test that invents its
 * own payload proves the switch has a case for the event, never that the keys
 * it reads are the keys the store emits. The clause under test here is about
 * one of those keys — `links` — so a fixture would be exactly the wrong
 * evidence.
 *
 * `events.jsonl` is the read-back surface because `appendAudit` writes the
 * SSE payload byte-for-byte (`event` key, not `type`), so the row the log
 * holds is the frame the plugin's renderer receives.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type DecisionAnsweredPayload, decisionAnsweredLine } from '../../mcp/src/decision-line.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type Task, eventsLogPath } from '../src/tasks.ts';

const PERSON: User = { id: 'known-alex', name: 'Alex', kind: 'known', color: '#2e7dd7' };
const AGENT: User = {
  id: 'agent-index-rebuild',
  name: 'Index Rebuild',
  kind: 'known',
  color: '#888888',
};

const CLAUSE = 'walk its links as the propagation checklist';

describe('the decision.answered channel line only sends a reader to links that exist', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** The line an attached agent would see for the last answer recorded. */
  const lastAnsweredLine = (): string => {
    const path = eventsLogPath(dataDir, wsId);
    expect(existsSync(path), 'no events log — nothing was recorded').toBe(true);
    const rows = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { event: string } & DecisionAnsweredPayload)
      .filter((r) => r.event === 'decision.answered');
    const row = rows.at(-1);
    // A row that never reached the log would render nothing, which makes
    // every assertion below vacuous.
    expect(row, 'no decision.answered row in the log').toBeDefined();
    return decisionAnsweredLine(row as DecisionAnsweredPayload);
  };

  /** Answer a fresh decision task carrying `links`, and render its row. */
  const answerDecisionWith = async (links: unknown[]): Promise<string> => {
    const created = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Rebuild the index now or after the freeze?',
      assignee: 'human',
      needs: 'decision',
      body: 'Now or after the freeze? Now costs a night of downtime; after the freeze slips the search work a week. Blocked until answered: the query-latency fix.',
      links,
      author: AGENT,
    });
    expect(created.status).toBe(200);
    const task = ((await created.json()) as { task: Task }).task;
    const answered = await post(`/api/tasks/${task.id}/answer`, {
      text: 'Rebuild after the freeze.',
      author: PERSON,
    });
    expect(answered.status).toBe(200);
    return lastAnsweredLine();
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'decision-answered-line-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const ws = await post('/api/workspaces', { name: 'index-rebuild' });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('offers the checklist when the task has links to walk', async () => {
    const line = await answerDecisionWith([{ kind: 'doc', docId: 'search-plan' }]);
    // Positive control: the line renders at all, with the actor and the
    // verbatim answer that are the point of the row.
    expect(line).toContain('[decision.answered]');
    expect(line).toContain('Alex');
    expect(line).toContain('Rebuild after the freeze.');
    expect(line).toContain(CLAUSE);
  });

  it('omits the checklist when the task has no links', async () => {
    const line = await answerDecisionWith([]);
    // Same positive control, so "no clause" cannot be "no line".
    expect(line).toContain('[decision.answered]');
    expect(line).toContain('Alex');
    expect(line).toContain('Rebuild after the freeze.');
    expect(line).not.toContain(CLAUSE);
    // …and nothing is left dangling where the clause used to sit.
    expect(line.trimEnd()).toBe(line);
    expect(line).not.toMatch(/—\s*$/);
  });
});
