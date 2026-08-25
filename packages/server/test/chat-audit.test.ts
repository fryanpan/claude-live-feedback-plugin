/**
 * Chat-audit counters — the store, and the routes in front of it.
 *
 * The number an agent reads here is NOT a live measurement: the server cannot
 * see chat (it lives in each session's terminal), so the daily chat audit —
 * an agent that mines transcripts — publishes per-agent counts and the server
 * stores and serves them. One number, one implementation: what the audit
 * publishes is exactly what a session reads back about itself.
 *
 * Store tests cover parsing/latest-wins/persistence; route tests cover the
 * layer a unit test misses. Absence assertions sit next to their positive
 * controls. Fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatAudit, chatAuditLogPath, normalizeAgent } from '../src/chat-audit.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('ChatAudit store', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('publishes entries and reads the latest row back per agent', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    let t = Date.parse('2026-08-25T10:00:00.000Z');
    const store = new ChatAudit({ dataDir: dir, now: () => t });
    const first = store.publish({
      day: '2026-08-24',
      auditor: 'Team Lead',
      entries: [
        { agent: 'Alpha Agent', unfiledAsks: 3, totalAsks: 5 },
        { agent: 'Beta Agent', unfiledAsks: 0 },
      ],
    });
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0]?.day).toBe('2026-08-24');

    // A later publish for the same agent supersedes — latest wins, and the
    // earlier row stays on disk (append-only; corrections are new rows).
    t += 60_000;
    store.publish({
      day: '2026-08-25',
      auditor: 'Team Lead',
      entries: [{ agent: 'alpha agent', unfiledAsks: 1, note: 'one ask at 09:12' }],
    });

    const read = store.readFor('Alpha Agent', '2026-08-25');
    expect(read.latest?.unfiledAsks).toBe(1);
    expect(read.latest?.day).toBe('2026-08-25');
    expect(read.today?.unfiledAsks).toBe(1);
    // Positive control for the day filter: on a day with no row, `today` is
    // null while `latest` still answers.
    const stale = store.readFor('Beta Agent', '2026-08-25');
    expect(stale.today).toBeNull();
    expect(stale.latest?.unfiledAsks).toBe(0);
  });

  it('matches agents case- and whitespace-insensitively', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    const store = new ChatAudit({ dataDir: dir });
    store.publish({ entries: [{ agent: '  Live Feedback ', unfiledAsks: 2 }] });
    expect(store.readFor('live feedback', '2000-01-01').latest?.unfiledAsks).toBe(2);
    // Positive control: a different name still reads nothing.
    expect(store.readFor('other agent', '2000-01-01').latest).toBeNull();
    expect(normalizeAgent('  Live Feedback ')).toBe('live feedback');
  });

  it('survives a new instance over the same data dir, skipping corrupt lines', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    new ChatAudit({ dataDir: dir }).publish({
      day: '2026-08-24',
      entries: [{ agent: 'Alpha', unfiledAsks: 4 }],
    });
    appendFileSync(chatAuditLogPath(dir), 'not json\n');
    const again = new ChatAudit({ dataDir: dir });
    expect(again.readFor('Alpha', '2026-08-24').today?.unfiledAsks).toBe(4);
    expect(again.loadError).toContain('skipped');
  });

  it('refuses invalid entries: shared identity, negative or non-integer counts, bad day', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    const store = new ChatAudit({ dataDir: dir });
    expect(() => store.publish({ entries: [{ agent: 'agent', unfiledAsks: 1 }] })).toThrow(
      /shared identity/i,
    );
    expect(() => store.publish({ entries: [{ agent: 'Alpha', unfiledAsks: -1 }] })).toThrow();
    expect(() => store.publish({ entries: [{ agent: 'Alpha', unfiledAsks: 1.5 }] })).toThrow();
    expect(() =>
      store.publish({ day: 'yesterday', entries: [{ agent: 'Alpha', unfiledAsks: 1 }] }),
    ).toThrow(/day/);
    expect(() => store.publish({ entries: [] })).toThrow(/entries/);
    // Nothing landed on disk from the refusals.
    expect(store.latestPerAgent()).toEqual([]);
  });

  it('latestPerAgent lists one row per agent, the newest', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-audit-'));
    let t = 1_000_000_000_000;
    const store = new ChatAudit({ dataDir: dir, now: () => t });
    store.publish({ day: '2026-08-23', entries: [{ agent: 'Alpha', unfiledAsks: 5 }] });
    t += 1000;
    store.publish({
      day: '2026-08-24',
      entries: [
        { agent: 'Alpha', unfiledAsks: 2 },
        { agent: 'Beta', unfiledAsks: 1 },
      ],
    });
    const rows = store.latestPerAgent();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.agent === 'Alpha')?.unfiledAsks).toBe(2);
    expect(rows.find((r) => r.agent === 'Beta')?.unfiledAsks).toBe(1);
  });
});

describe('/api/chat-audit routes', () => {
  let handle: ServerHandle | null = null;
  let dataDir: string | null = null;

  const start = () => {
    dataDir = mkdtempSync(join(tmpdir(), 'chat-audit-route-'));
    handle = createServer({ port: 0, dataDir });
    return `http://localhost:${handle.port}`;
  };

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  const call = async (base: string, path: string, method: 'GET' | 'POST', body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        host: `localhost:${handle?.port ?? 0}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('a session reads its own number back: null before any audit, the count after', async () => {
    const base = start();

    // Before any publish: a real answer, not an error — and explicitly null.
    const before = await call(base, '/api/chat-audit/Alpha%20Agent', 'GET');
    expect(before.status).toBe(200);
    expect(before.json.latest).toBeNull();
    expect(before.json.today).toBeNull();
    expect(typeof before.json.day).toBe('string');

    const day = before.json.day as string;
    const post = await call(base, '/api/chat-audit', 'POST', {
      day,
      auditor: 'Team Lead',
      entries: [{ agent: 'Alpha Agent', unfiledAsks: 3, note: 'two asks in chat, one filed' }],
    });
    expect(post.status).toBe(200);
    expect((post.json.rows as Array<{ unfiledAsks: number }>)[0]?.unfiledAsks).toBe(3);

    // The positive control for `before`: the same probe now sees the number.
    const after = await call(base, '/api/chat-audit/Alpha%20Agent', 'GET');
    expect(after.status).toBe(200);
    expect((after.json.today as { unfiledAsks: number }).unfiledAsks).toBe(3);
    expect((after.json.latest as { auditor?: string }).auditor).toBe('Team Lead');

    // A different agent still reads null — counts are per agent.
    const other = await call(base, '/api/chat-audit/Beta%20Agent', 'GET');
    expect(other.json.latest).toBeNull();
  });

  it('lists the latest row per agent for the audit to reference', async () => {
    const base = start();
    await call(base, '/api/chat-audit', 'POST', {
      entries: [
        { agent: 'Alpha', unfiledAsks: 2 },
        { agent: 'Beta', unfiledAsks: 0 },
      ],
    });
    const list = await call(base, '/api/chat-audit', 'GET');
    expect(list.status).toBe(200);
    expect(list.json.rows as unknown[]).toHaveLength(2);
  });

  it('refuses a bad publish with a 400 that names the problem', async () => {
    const base = start();
    const noEntries = await call(base, '/api/chat-audit', 'POST', { entries: [] });
    expect(noEntries.status).toBe(400);
    const shared = await call(base, '/api/chat-audit', 'POST', {
      entries: [{ agent: 'agent', unfiledAsks: 1 }],
    });
    expect(shared.status).toBe(400);
    const sharedRead = await call(base, '/api/chat-audit/agent', 'GET');
    expect(sharedRead.status).toBe(400);
  });
});
