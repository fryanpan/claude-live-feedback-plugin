/**
 * Can an agent tell deafness from silence — from the inside?
 *
 * The measured incident: a peer held six docs under `watch_doc` and believed
 * it was listening. It had never called `attach_agent` on the board those
 * docs live on. A voice note and a re-triage request queued SILENTLY, and
 * every probe the agent could run answered confidently: `list_watched_docs`
 * said six watches, all live. Six watches IS the true answer to the question
 * that probe asks. It is the wrong question.
 *
 * So `GET /api/agents/:id/watches` grows a `coverage` block that answers the
 * question the agent actually has: not "what am I watching" but "what am I
 * MISSING". `unattachedBoards` is that incident rendered as a row — six docs
 * watched, zero attachments, four items waiting for a lead that is not there.
 *
 * Every absence assertion here sits beside a positive control in the same
 * read, because "no row" and "a probe that cannot see" are the two things
 * this whole ticket exists to tell apart.
 *
 * Reading coverage must never DRAIN a queue. A read that delivered would
 * reintroduce the bug one layer down: the counts would be right once and the
 * items would be gone, with the attach that was supposed to receive them
 * finding nothing and nobody able to say why. Asserted explicitly below.
 *
 * All fixtures synthetic. No port is bound (port: 0); no production server is
 * touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
const AGENT = 'agent-coverage';

interface CoverageQueue {
  queuedVoice: number;
  pendingRetriage: number;
  pendingBucketReview: number;
  taskReviews: number;
}
interface CoverageWorkspaceRow {
  key: string;
  workspaceId: string;
  kind: 'board' | 'grouping';
  name?: string;
  attached?: boolean;
  heartbeatFresh?: boolean;
  lead?: boolean;
  queued?: CoverageQueue;
  queuedTotal?: number;
}
interface UnattachedBoard {
  workspaceId: string;
  name: string;
  watchedDocs: string[];
  queued: CoverageQueue;
  queuedTotal: number;
  attached: boolean;
  heartbeatFresh: boolean;
  leadAgentId?: string;
  leadLive: boolean;
}
interface Coverage {
  agentId: string;
  workspaces: CoverageWorkspaceRow[];
  unattachedBoards: UnattachedBoard[];
}

describe('watch coverage — what an agent is missing, not what it holds', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, { method: 'POST', body: JSON.stringify(body) });
  const put = (path: string, body: unknown) =>
    local(path, { method: 'PUT', body: JSON.stringify(body) });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-coverage-'));
    srcDir = mkdtempSync(join(tmpdir(), 'agent-coverage-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const watchesPath = (agentId = AGENT) => `/api/agents/${encodeURIComponent(agentId)}/watches`;

  /** The restore read — and now the coverage read, on the same route. */
  const readWatches = async (agentId = AGENT) => {
    const res = await local(watchesPath(agentId));
    return {
      status: res.status,
      json: (await res.json()) as { coverage?: Coverage } & Record<string, unknown>,
    };
  };
  const coverageOf = async (agentId = AGENT): Promise<Coverage> => {
    const { status, json } = await readWatches(agentId);
    expect(status).toBe(200);
    if (!json.coverage) throw new Error('no coverage block on the watches read');
    return json.coverage;
  };

  const watch = (keys: string[], agentId = AGENT) =>
    post(watchesPath(agentId), { add: keys, name: agentId });

  const makeBoard = async (name: string): Promise<string> => {
    const r = await post('/api/workspaces', { name, goal: 'Ship the index.' });
    expect(r.status).toBe(200);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };

  const makeDoc = async (docId: string, hubWorkspaceId?: string): Promise<void> => {
    const path = join(srcDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nFirst paragraph.\n`);
    const res = await post('/api/docs', {
      docId,
      sourceUrl: path,
      title: docId,
      ...(hubWorkspaceId ? { hubWorkspaceId } : {}),
    });
    expect(res.status).toBe(200);
  };

  const attach = (workspaceId: string, agentId = AGENT) =>
    post(`/api/workspaces/${workspaceId}/attachments`, {
      agentId,
      runtime: 'claude-code-local',
    });

  /**
   * Three of the four things that queue for a board's lead, produced the way
   * they actually happen: a filed row wants its shape reviewed, a spoken
   * change has nobody to route to, a goal edit has nobody to re-triage.
   * `pendingBucketReview` needs a band change and stays 0 here — its count is
   * still reported, so the shape a reader learns is complete.
   */
  const queueThreeForLead = async (workspaceId: string): Promise<void> => {
    // `goal` set on create is what routes a new row through task review.
    const t = await post(`/api/workspaces/${workspaceId}/tasks`, {
      author: PERSON,
      title: 'An open row',
      goal: 'chores',
    });
    expect(t.status).toBe(200);
    const voice = await post(`/api/workspaces/${workspaceId}/voice`, {
      transcript: 'make cutting token usage the top goal',
      author: PERSON,
    });
    expect(((await voice.json()) as { route: string }).route).toBe('agent-queued');
    const goal = await put(`/api/workspaces/${workspaceId}/goal`, {
      goal: 'Cut token usage per session in half.',
      author: PERSON,
    });
    expect(((await goal.json()) as { retriage: { queued: boolean } }).retriage.queued).toBe(true);
  };

  it('names the board holding this agent’s watched docs where it has no attachment, with what is waiting', async () => {
    const boardId = await makeBoard('coverage-board');
    await makeDoc('doc-one', boardId);
    await makeDoc('doc-two', boardId);
    await queueThreeForLead(boardId);
    // Exactly the incident: docs watched, board never attached.
    expect((await watch(['doc-one', 'doc-two'])).status).toBe(200);

    const coverage = await coverageOf();
    expect(coverage.agentId).toBe(AGENT);
    // No `ws:` key in the set, so nothing to report there — and the row
    // below proves the reader is not simply blind.
    expect(coverage.workspaces).toEqual([]);
    expect(coverage.unattachedBoards).toHaveLength(1);
    const row = coverage.unattachedBoards[0] as UnattachedBoard;
    expect(row.workspaceId).toBe(boardId);
    expect(row.name).toBe('coverage-board');
    expect(row.watchedDocs).toEqual(['doc-one', 'doc-two']);
    expect(row.queued).toEqual({
      queuedVoice: 1,
      pendingRetriage: 1,
      pendingBucketReview: 0,
      taskReviews: 1,
    });
    expect(row.queuedTotal).toBe(3);
  });

  it('reading coverage does not DRAIN the queue it reports', async () => {
    const boardId = await makeBoard('non-draining-board');
    await makeDoc('doc-one', boardId);
    await queueThreeForLead(boardId);
    await watch(['doc-one']);

    const first = await coverageOf();
    expect(first.unattachedBoards[0]?.queuedTotal).toBe(3);
    // A read that delivered would be right once and empty forever after.
    const second = await coverageOf();
    expect(second.unattachedBoards[0]?.queued).toEqual(
      first.unattachedBoards[0]?.queued as CoverageQueue,
    );

    // And the real delivery still finds all of it — the probe looked, the
    // attach received.
    const drained = (await (await attach(boardId)).json()) as {
      queuedVoice: Array<{ transcript: string }>;
      pendingRetriage?: { taskIds: string[] };
      taskReviews?: Array<{ taskId: string }>;
    };
    expect(drained.queuedVoice).toHaveLength(1);
    expect(drained.pendingRetriage?.taskIds).toHaveLength(1);
    expect(drained.taskReviews).toHaveLength(1);
  });

  it('POSITIVE CONTROL 1: after attaching, the board leaves unattachedBoards and reports attached + lead truthfully', async () => {
    const boardId = await makeBoard('seated-board');
    await makeDoc('doc-one', boardId);
    await queueThreeForLead(boardId);
    await watch(['doc-one', `ws:${boardId}`]);

    // Before: the gap is real, so the absence after means something.
    const before = await coverageOf();
    expect(before.unattachedBoards.map((b) => b.workspaceId)).toEqual([boardId]);
    const beforeWs = before.workspaces[0] as CoverageWorkspaceRow;
    expect(beforeWs.kind).toBe('board');
    expect(beforeWs.attached).toBe(false);
    expect(beforeWs.lead).toBe(false);
    expect(beforeWs.heartbeatFresh).toBe(false);

    expect((await attach(boardId)).status).toBe(200);

    const after = await coverageOf();
    expect(after.unattachedBoards).toEqual([]);
    const ws = after.workspaces[0] as CoverageWorkspaceRow;
    expect(ws.key).toBe(`ws:${boardId}`);
    expect(ws.workspaceId).toBe(boardId);
    expect(ws.kind).toBe('board');
    expect(ws.name).toBe('seated-board');
    expect(ws.attached).toBe(true);
    expect(ws.heartbeatFresh).toBe(true);
    // The empty seat is claimed by attaching, so this agent leads — and the
    // queue it just drained now reads as empty rather than as unknown.
    expect(ws.lead).toBe(true);
    expect(ws.queuedTotal).toBe(0);
  });

  it('POSITIVE CONTROL 2: a doc on a board the agent IS attached to is never listed', async () => {
    const seated = await makeBoard('board-with-seat');
    const absent = await makeBoard('board-without-seat');
    await makeDoc('doc-seated', seated);
    await makeDoc('doc-absent', absent);
    await attach(seated);
    await watch(['doc-seated', 'doc-absent']);

    const coverage = await coverageOf();
    // The board it is attached to is absent from the alarm list; the board it
    // is not attached to is present in the SAME read. Without the second, the
    // first would prove only that the builder produced nothing at all.
    expect(coverage.unattachedBoards.map((b) => b.workspaceId)).toEqual([absent]);
    expect(coverage.unattachedBoards[0]?.watchedDocs).toEqual(['doc-absent']);
  });

  it('POSITIVE CONTROL 3: a `ws:` key naming a GROUPING is reported as a grouping and raises no board alarm', async () => {
    // A folder bind / diff review puts ONE row on the board — the GROUPING —
    // and the agent watches the grouping's own channel. It never asked about
    // the board, so a board row here would be an alarm about somebody else's
    // seat, on a key that is not a hub board at all.
    const boardId = await makeBoard('holding-board');
    writeFileSync(join(srcDir, 'README.md'), '# Bound folder\n\nBody.\n');
    const bound = await post('/api/workspaces', { folderPath: srcDir, hubWorkspaceId: boardId });
    expect(bound.status).toBe(200);
    const groupingId = ((await bound.json()) as { workspaceId: string }).workspaceId;
    expect(groupingId).not.toBe(boardId);
    await queueThreeForLead(boardId);

    await watch([`ws:${groupingId}`]);
    const coverage = await coverageOf();
    expect(coverage.workspaces).toHaveLength(1);
    const row = coverage.workspaces[0] as CoverageWorkspaceRow;
    expect(row.key).toBe(`ws:${groupingId}`);
    expect(row.workspaceId).toBe(groupingId);
    expect(row.kind).toBe('grouping');
    // Attachment / lead / heartbeat are hub-board facts. Printing `false` for
    // a grouping would read as a gap that cannot exist.
    expect(row.attached).toBeUndefined();
    expect(row.lead).toBeUndefined();
    expect(coverage.unattachedBoards).toEqual([]);

    // Positive control on that empty list, in the same pass: the board really
    // does have three items waiting and no attachment — watching one of its
    // DOCS surfaces it immediately.
    await makeDoc('doc-on-board', boardId);
    await watch(['doc-on-board']);
    const widened = await coverageOf();
    expect(widened.unattachedBoards.map((b) => b.workspaceId)).toEqual([boardId]);
    expect(widened.unattachedBoards[0]?.queuedTotal).toBe(3);
  });

  /**
   * THE STATE THIS READOUT WAS BLIND TO — and it is the state the whole
   * feature creates.
   *
   * An agent that adopts `set_workspace_lead(workspaceId)` holds exactly ONE
   * key: `ws:<board>`. It holds no doc keys at all. `unattachedBoards` was
   * built only from non-`ws:` keys, so that agent could never appear on it;
   * and the attachment test was "a record exists", which an hour-old
   * heartbeat satisfies while every delivery gate answers `away`. So the one
   * agent this branch teaches the fleet to be was the one agent the probe
   * could not see, in the one state that matters: heartbeat dead, work
   * visibly queued, `unattachedBoards: []`, and a restore notice that says
   * nothing.
   *
   * These use a tight `heartbeatFreshMs` because the real window is five
   * minutes and a test must not sleep through it.
   */
  describe('a declared lead whose heartbeat went stale', () => {
    let tight: ServerHandle;
    let tightDir: string;
    let tightBase: string;

    const tpost = (path: string, body: unknown) =>
      fetch(`${tightBase}${path}`, {
        method: 'POST',
        headers: { host: `localhost:${tight.port}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const tput = (path: string, body: unknown) =>
      fetch(`${tightBase}${path}`, {
        method: 'PUT',
        headers: { host: `localhost:${tight.port}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const tcoverage = async (agentId = AGENT): Promise<Coverage> => {
      const res = await fetch(`${tightBase}/api/agents/${encodeURIComponent(agentId)}/watches`, {
        headers: { host: `localhost:${tight.port}` },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { coverage?: Coverage };
      if (!json.coverage) throw new Error('no coverage block');
      return json.coverage;
    };

    beforeEach(() => {
      tightDir = mkdtempSync(join(tmpdir(), 'agent-coverage-tight-'));
      // 40ms of freshness: an attachment made at the top of a test is `away`
      // by the time the same test reads coverage.
      tight = createServer({ port: 0, dataDir: tightDir, heartbeatFreshMs: 40 });
      tightBase = `http://localhost:${tight.port}`;
    });
    afterEach(async () => {
      await tight.stop();
      rmSync(tightDir, { recursive: true, force: true });
    });

    const seedBoard = async (name: string): Promise<string> => {
      const r = await tpost('/api/workspaces', { name, goal: 'Ship the index.' });
      return ((await r.json()) as { workspace: { id: string } }).workspace.id;
    };

    /** The queue, produced the way it actually happens. Deliberately called
     *  AFTER the attachment has aged out — an attach drains what is waiting,
     *  so queueing first and attaching second would leave nothing to find and
     *  the assertion would pass for the wrong reason. */
    const queueThree = async (boardId: string): Promise<void> => {
      await tpost(`/api/workspaces/${boardId}/tasks`, {
        author: PERSON,
        title: 'An open row',
        goal: 'chores',
      });
      const voice = await tpost(`/api/workspaces/${boardId}/voice`, {
        transcript: 'make cutting token usage the top goal',
        author: PERSON,
      });
      // The incident's own signature: routed to a queue, not to an agent.
      expect(((await voice.json()) as { route: string }).route).toBe('agent-queued');
      const goal = await tput(`/api/workspaces/${boardId}/goal`, {
        goal: 'Cut token usage per session in half.',
        author: PERSON,
      });
      expect(((await goal.json()) as { retriage: { queued: boolean } }).retriage.queued).toBe(true);
    };

    it('reports a stale-heartbeat lead holding only a ws: key, with what is queued', async () => {
      const boardId = await seedBoard('lead-gone-quiet');
      await tpost(`/api/workspaces/${boardId}/attachments`, {
        agentId: AGENT,
        runtime: 'claude-code-local',
      });
      await tpost(`/api/agents/${AGENT}/watches`, { add: [`ws:${boardId}`], name: AGENT });
      await new Promise((r) => setTimeout(r, 60)); // heartbeat ages out
      await queueThree(boardId);

      const coverage = await tcoverage();
      const row = coverage.workspaces[0] as CoverageWorkspaceRow;
      expect(row.kind).toBe('board');
      expect(row.attached).toBe(true);
      expect(row.heartbeatFresh).toBe(false);
      expect(row.lead).toBe(true);
      expect((row.queuedTotal ?? 0) > 0).toBe(true);
      // The alarm the agent actually reads. An attachment RECORD is not
      // coverage — every delivery gate asks whether the heartbeat is fresh.
      expect(coverage.unattachedBoards.map((b) => b.workspaceId)).toEqual([boardId]);
      const alarm = coverage.unattachedBoards[0] as UnattachedBoard;
      expect(alarm.attached).toBe(true);
      expect(alarm.heartbeatFresh).toBe(false);
      expect(alarm.leadAgentId).toBe(AGENT);
      // Nobody else is live on it either, so nothing is draining that queue.
      expect(alarm.leadLive).toBe(false);
      expect(alarm.watchedDocs).toEqual([]);
    });

    // POSITIVE CONTROL 4 — the same board, the same single `ws:` key, with a
    // FRESH heartbeat raises no alarm. Without this the row above would prove
    // only that the builder lists every board it can reach.
    it('POSITIVE CONTROL: a live attachment on the same key raises no alarm', async () => {
      const boardId = await seedBoard('lead-still-here');
      await tpost(`/api/workspaces/${boardId}/attachments`, {
        agentId: AGENT,
        runtime: 'claude-code-local',
      });
      await tpost(`/api/agents/${AGENT}/watches`, { add: [`ws:${boardId}`], name: AGENT });

      const coverage = await tcoverage();
      expect((coverage.workspaces[0] as CoverageWorkspaceRow).heartbeatFresh).toBe(true);
      expect(coverage.unattachedBoards).toEqual([]);
      // …and it goes back to being an alarm once the heartbeat ages out, in
      // the same test, so "no alarm" is a state and not a permanent silence.
      await new Promise((r) => setTimeout(r, 60));
      expect((await tcoverage()).unattachedBoards.map((b) => b.workspaceId)).toEqual([boardId]);
    });

    /**
     * The takeover hazard: the alert used to end "set_workspace_lead(...)
     * hands the backlog over in one call" with no idea who was sitting there.
     * A board whose lead is somebody else and LIVE must say so, or following
     * the advice evicts a working peer.
     */
    it('names the incumbent lead and whether it is live', async () => {
      const boardId = await seedBoard('board-with-a-live-lead');
      // The incumbent attaches (claiming the empty seat) and stays fresh.
      await tpost(`/api/workspaces/${boardId}/attachments`, {
        agentId: 'agent-incumbent',
        runtime: 'claude-code-local',
      });
      // A second agent watches a doc on the board, never attaches.
      const path = join(srcDir, 'doc-shared.md');
      writeFileSync(path, '# doc-shared\n\nBody.\n');
      await tpost('/api/docs', {
        docId: 'doc-shared',
        sourceUrl: path,
        title: 'doc-shared',
        hubWorkspaceId: boardId,
      });
      await tpost(`/api/agents/${AGENT}/watches`, { add: ['doc-shared'], name: AGENT });

      const alarm = (await tcoverage()).unattachedBoards[0] as UnattachedBoard;
      expect(alarm.workspaceId).toBe(boardId);
      expect(alarm.leadAgentId).toBe('agent-incumbent');
      expect(alarm.leadLive).toBe(true);
      expect(alarm.attached).toBe(false);

      // POSITIVE CONTROL 5 — once the incumbent's heartbeat ages out the same
      // row reports `leadLive: false`, so the field tracks the incumbent
      // rather than being a constant.
      await new Promise((r) => setTimeout(r, 60));
      const later = (await tcoverage()).unattachedBoards[0] as UnattachedBoard;
      expect(later.leadAgentId).toBe('agent-incumbent');
      expect(later.leadLive).toBe(false);
    });
  });
});
