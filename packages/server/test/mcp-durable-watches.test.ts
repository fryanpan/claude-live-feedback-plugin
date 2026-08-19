/**
 * Watches survive an MCP child respawn — end to end, through the SHIPPED
 * BUNDLE, against a real server.
 *
 * The scenario the task was filed on: a session watches docs, Claude Code
 * respawns (token switch, /clear, crash), and the new MCP child comes up with
 * an empty `watchers` map — `list_watched_docs` answers `[]`, indistinguishable
 * from a session that never subscribed. So this test kills the child and
 * starts another with the SAME identity, and asserts three things in order:
 * the set is back, `list_watched_docs` SAYS it came from the server, and an
 * event on a restored doc actually reaches the new child as a channel message
 * (a listed watch that delivers nothing is the drift strip's empty-list
 * failure with extra steps).
 *
 * Every absence sits beside its positive control in the same file: a child
 * with a DIFFERENT identity gets nothing back, and a child with NO identity
 * is told its watches are session-only rather than silently persisted under
 * the shared id.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const BUNDLE = resolve(import.meta.dir, '../../plugin/mcp/index.js');

interface Notification {
  method: string;
  params?: { content?: string; meta?: Record<string, unknown> };
}

/** One MCP child over stdio: JSON-RPC calls plus every notification it sends. */
class McpChild {
  private child: ChildProcess;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  private nextId = 1;
  readonly notifications: Notification[] = [];
  private waiters: Array<() => void> = [];

  constructor(baseUrl: string, env: Record<string, string | undefined>) {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // The parent session may itself carry an agent identity; the child must
      // get exactly the identity the test names, or the fixture measures the
      // wrong session.
      // Both spellings: the rename gave each of these a `CW_` name and kept
      // the old one working, so stripping only one half lets the parent's
      // identity through under the other and the fixture silently measures
      // the wrong session.
      if (
        k === 'FEEDBACK_AGENT_NAME' ||
        k === 'FEEDBACK_AUTHOR' ||
        k === 'FEEDBACK_BASE_URL' ||
        k === 'CW_AGENT_NAME' ||
        k === 'CW_AUTHOR' ||
        k === 'CW_BASE_URL'
      ) {
        continue;
      }
      if (v !== undefined) childEnv[k] = v;
    }
    childEnv.FEEDBACK_BASE_URL = baseUrl;
    for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
    this.child = spawn('node', [BUNDLE], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('{')) {
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (typeof msg.id === 'number') this.pending.get(msg.id)?.(msg);
          else if (typeof msg.method === 'string') {
            this.notifications.push(msg as Notification);
            for (const w of this.waiters.splice(0)) w();
          }
        }
        nl = buf.indexOf('\n');
      }
    });
  }

  call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async init(): Promise<void> {
    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'durable-watches-test', version: '0' },
    });
    this.child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  }

  async tool(name: string, args: unknown = {}): Promise<Record<string, unknown>> {
    const reply = (await this.call('tools/call', { name, arguments: args })) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: unknown;
    };
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).not.toBe(true);
    return JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
  }

  /** Wait until some channel notification satisfies `pred`, or time out. */
  waitForChannel(pred: (n: Notification) => boolean, timeoutMs = 10_000): Promise<Notification> {
    return new Promise((resolvePromise, reject) => {
      const check = () => {
        const hit = this.notifications.find(
          (n) => n.method === 'notifications/claude/channel' && pred(n),
        );
        if (hit) {
          clearTimeout(timer);
          resolvePromise(hit);
          return true;
        }
        return false;
      };
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `no matching channel notification within ${timeoutMs}ms; saw ${JSON.stringify(
                this.notifications.map((n) => n.params?.content ?? n.method),
              )}`,
            ),
          ),
        timeoutMs,
      );
      if (check()) return;
      const w = () => {
        if (!check()) this.waiters.push(w);
      };
      this.waiters.push(w);
    });
  }

  kill(): void {
    this.child.kill();
  }
}

describe('watches survive an MCP child respawn (through the real bundle)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const live: McpChild[] = [];
  const NAME = 'Durable Watch Tester';
  const AGENT_ID = 'agent-durable-watch-tester';

  const spawnChild = async (env: Record<string, string | undefined>): Promise<McpChild> => {
    const c = new McpChild(base, env);
    live.push(c);
    await c.init();
    return c;
  };

  const rest = (path: string, method: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        host: `localhost:${handle.port}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-durable-watches-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    for (const docId of ['dw-one', 'dw-two']) {
      const path = join(dataDir, `${docId}.md`);
      writeFileSync(path, `# ${docId}\n\nA paragraph to anchor a thread on.\n`);
      const res = await rest('/api/docs', 'POST', { docId, sourceUrl: path });
      expect(res.status).toBe(200);
    }
  });

  afterAll(async () => {
    for (const c of live) c.kill();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a fresh identity reads an EMPTY restored set — never-watched, and it says so', async () => {
    const first = await spawnChild({ FEEDBACK_AGENT_NAME: NAME });
    const list = (await first.tool('list_watched_docs')) as {
      watching: string[];
      persistence: { mode: string; agentId: string };
      restore: { status: string; from: string; restored: string[] };
    };
    expect(list.watching).toEqual([]);
    expect(list.persistence.mode).toBe('server');
    expect(list.persistence.agentId).toBe(AGENT_ID);
    // The distinguishing mark: this `[]` was RESTORED from the server, and
    // the server had nothing — so it means never-watched, not dropped.
    expect(list.restore.status).toBe('restored');
    expect(list.restore.from).toBe('server');
    expect(list.restore.restored).toEqual([]);

    // Watch one doc explicitly and one workspace via auto-subscribe.
    const w = (await first.tool('watch_doc', { docId: 'dw-one' })) as {
      persisted: boolean;
      persistence: string;
      watching: string[];
    };
    expect(w.persisted).toBe(true);
    expect(w.persistence).toBe('server');
    const ws = (await first.tool('create_workspace', { name: 'dw-ws', goal: 'Watch me.' })) as {
      workspaceId: string;
    };
    expect(ws.workspaceId).toBeTruthy();
    // And a doc touched through an ordinary tool (the auto-watch path).
    await first.tool('list_threads', { docId: 'dw-two' });

    // Server-side effect, not the tool's own account of itself.
    const stored = handle.agentWatches.list(AGENT_ID, () => true).watches.map((x) => x.key);
    expect(stored).toEqual(['dw-one', `ws:${ws.workspaceId}`, 'dw-two']);

    // The respawn: kill the child, start another with the SAME identity.
    first.kill();
    const second = await spawnChild({ FEEDBACK_AGENT_NAME: NAME });

    const restored = (await second.tool('list_watched_docs')) as {
      watching: string[];
      restore: { status: string; from: string; restored: string[]; pruned: string[]; at?: string };
    };
    expect(restored.restore.status).toBe('restored');
    expect(restored.restore.from).toBe('server');
    expect(restored.restore.restored.sort()).toEqual(
      ['dw-one', 'dw-two', `ws:${ws.workspaceId}`].sort(),
    );
    expect(restored.restore.pruned).toEqual([]);
    expect(restored.watching.sort()).toEqual(['dw-one', 'dw-two', `ws:${ws.workspaceId}`].sort());

    // The session was TOLD, not left to ask: one channel line on restore.
    const notice = await second.waitForChannel((n) =>
      (n.params?.content ?? '').startsWith('[watches restored]'),
    );
    expect(notice.params?.content).toContain('3 watches');
    expect(notice.params?.content).toContain(NAME);

    // A restored watch that delivers nothing is the empty-list failure with
    // extra steps — so post a real thread on the restored doc and require it
    // to arrive in the NEW child as a channel message.
    const thread = await rest('/api/docs/dw-one/threads/by_find', 'POST', {
      find: 'paragraph to anchor',
      text: 'Does the restored watch hear this?',
      author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
    });
    expect(thread.status).toBe(200);
    const delivered = await second.waitForChannel(
      (n) =>
        n.params?.meta?.doc_id === 'dw-one' &&
        (n.params?.content ?? '').includes('Does the restored watch hear this?'),
    );
    expect(delivered.params?.meta?.event).toBe('thread.created');

    // unwatch forgets it on the server too, so the NEXT respawn does not
    // resurrect it — and dw-two, untouched, comes back.
    const un = (await second.tool('unwatch_doc', { docId: 'dw-one' })) as { persisted: boolean };
    expect(un.persisted).toBe(true);
    second.kill();
    const third = await spawnChild({ FEEDBACK_AGENT_NAME: NAME });
    const after = (await third.tool('list_watched_docs')) as {
      watching: string[];
      restore: { restored: string[] };
    };
    expect(after.watching).not.toContain('dw-one');
    expect(after.watching).toContain('dw-two');
    expect(after.restore.restored).toContain('dw-two');
    third.kill();
  }, 30_000);

  it('a DIFFERENT identity on the same server gets nothing back (positive control for the restore above)', async () => {
    const other = await spawnChild({ FEEDBACK_AGENT_NAME: 'Some Other Peer' });
    const list = (await other.tool('list_watched_docs')) as {
      watching: string[];
      restore: { status: string; restored: string[] };
    };
    expect(list.restore.status).toBe('restored');
    expect(list.watching).toEqual([]);
    expect(list.restore.restored).toEqual([]);
    other.kill();
  }, 30_000);

  it('a session with no agent name is told its watches are session-only, and nothing lands under the shared id', async () => {
    // What the plugin's own .mcp.json pins for every peer. Deliberately the
    // CURRENT spelling: the cases above pass the legacy names and pass, which
    // is what makes them the regression test for the rename's fallback.
    const anon = await spawnChild({ CW_AGENT_NAME: undefined, CW_AUTHOR: 'agent' });
    const w = (await anon.tool('watch_doc', { docId: 'dw-two' })) as {
      persisted: boolean;
      persistence: string;
      watching: string[];
    };
    // Locally wired — events still flow for THIS session…
    expect(w.watching).toEqual(['dw-two']);
    // …but the response is honest that a restart drops it.
    expect(w.persisted).toBe(false);
    expect(w.persistence).toBe('session-only');
    const list = (await anon.tool('list_watched_docs')) as {
      persistence: { mode: string; reason?: string; agentId: string };
      restore: { status: string; from: string };
    };
    expect(list.persistence.mode).toBe('session-only');
    expect(list.persistence.agentId).toBe('known-agent');
    expect(list.persistence.reason).toContain('CW_AGENT_NAME');
    expect(list.restore.status).toBe('session-only');
    expect(list.restore.from).toBe('session');
    // The server never heard about it under the shared identity — the store
    // is empty there, and the named identity's set from the test above is
    // the positive control that the store CAN hold entries.
    expect(handle.agentWatches.list('known-agent', () => true).watches).toEqual([]);
    expect(handle.agentWatches.list(AGENT_ID, () => true).watches.length).toBeGreaterThan(0);
    anon.kill();
  }, 30_000);

  // ───────────────────────────────────────────────────────────────────────
  // Coverage: can the session tell DEAFNESS from SILENCE?
  //
  // Everything above proves a restored watch delivers. None of it would have
  // caught the measured incident, because there the watches were fine: six
  // docs, all live, all delivering. What was missing was an ATTACHMENT on the
  // board those docs sit on, and every delivery gate asks about that rather
  // than about watches — so a voice note and a re-triage request queued in
  // silence while every probe the agent could run answered "all good".
  //
  // These two cases run the same shape end to end through the real bundle:
  // one session that is missing an attachment and must be told, and one that
  // is not and must be left alone.
  // ───────────────────────────────────────────────────────────────────────

  /** A board with something waiting for a lead nobody is filling, plus a doc
   *  on it — the fixture the incident was made of. */
  const boardWithBacklog = async (
    name: string,
    docId: string,
  ): Promise<{ workspaceId: string }> => {
    const ws = (await (
      await rest('/api/workspaces', 'POST', {
        name,
        goal: 'Ship the index.',
      })
    ).json()) as { workspace: { id: string } };
    const workspaceId = ws.workspace.id;
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nA paragraph to anchor a thread on.\n`);
    expect(
      (await rest('/api/docs', 'POST', { docId, sourceUrl: path, hubWorkspaceId: workspaceId }))
        .status,
    ).toBe(200);
    // `goal` on create is what routes a new row to the lead for a shape
    // review; with no live lead it queues instead.
    expect(
      (
        await rest(`/api/workspaces/${workspaceId}/tasks`, 'POST', {
          author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
          title: 'An open row',
          goal: 'chores',
        })
      ).status,
    ).toBe(200);
    return { workspaceId };
  };

  it('a session watching docs on a board it never attached to is TOLD, on both surfaces', async () => {
    const NAME2 = 'Coverage Watch Tester';
    const AGENT2 = 'agent-coverage-watch-tester';
    const { workspaceId } = await boardWithBacklog('cov-board', 'cov-doc');

    const first = await spawnChild({ CW_AGENT_NAME: NAME2 });
    await first.tool('watch_doc', { docId: 'cov-doc' });
    // The probe an agent already knows to run, in the state the incident was
    // in: watching, never attached.
    const live = (await first.tool('list_watched_docs')) as {
      watching: string[];
      coverage?: {
        agentId: string;
        unattachedBoards: Array<{
          workspaceId: string;
          name: string;
          watchedDocs: string[];
          queuedTotal: number;
          queued: { taskReviews: number };
        }>;
      };
    };
    expect(live.watching).toContain('cov-doc');
    expect(live.coverage?.agentId).toBe(AGENT2);
    const row = live.coverage?.unattachedBoards.find((b) => b.workspaceId === workspaceId);
    expect(row).toBeDefined();
    expect(row?.name).toBe('cov-board');
    expect(row?.watchedDocs).toEqual(['cov-doc']);
    expect(row?.queued.taskReviews).toBe(1);
    expect(row?.queuedTotal).toBeGreaterThan(0);

    // And the unprompted half: an agent that does not know the gap exists
    // never runs the probe, so the respawn has to say it without being asked.
    first.kill();
    const second = await spawnChild({ CW_AGENT_NAME: NAME2 });
    const notice = await second.waitForChannel((n) =>
      (n.params?.content ?? '').includes('[not covered]'),
    );
    expect(notice.params?.content).toContain('cov-board');
    expect(notice.params?.content).toContain('set_workspace_lead');
    // The restore line still rides the same message — the alert is added, not
    // substituted for what the session was already told.
    expect(notice.params?.content).toContain('[watches restored]');
    second.kill();
  }, 40_000);

  it('POSITIVE CONTROL: a session that IS attached to the board hears the restore line and no alarm', async () => {
    const NAME3 = 'Seated Watch Tester';
    const { workspaceId } = await boardWithBacklog('seated-board', 'seated-doc');

    const first = await spawnChild({ CW_AGENT_NAME: NAME3 });
    await first.tool('watch_doc', { docId: 'seated-doc' });
    // The one difference from the case above — and it goes through the TOOL
    // rather than a REST POST on purpose. Being seated is two things: a
    // record, and a channel open to receive what the record makes you the
    // addressee for. `attach_agent` does both; posting the record from
    // outside describes a session that registered and never connected, which
    // is precisely the state the alarm exists to report.
    expect(await first.tool('attach_agent', { workspaceId })).toBeDefined();
    const live = (await first.tool('list_watched_docs')) as {
      coverage?: { unattachedBoards: Array<{ workspaceId: string }> };
    };
    // The block is PRESENT and says nothing is missing — which is a different
    // answer from the block being absent, and the whole reason coverage is
    // omitted rather than emptied when the server cannot say.
    expect(live.coverage).toBeDefined();
    expect(live.coverage?.unattachedBoards.map((b) => b.workspaceId)).not.toContain(workspaceId);

    first.kill();
    const second = await spawnChild({ CW_AGENT_NAME: NAME3 });
    const notice = await second.waitForChannel((n) =>
      (n.params?.content ?? '').startsWith('[watches restored]'),
    );
    // Same message the alarmed session got, minus the alarm. Asserted on the
    // notice that DID arrive rather than on a timeout, so the absence is an
    // answer about this session and not about a notice that never fired.
    expect(notice.params?.content).toContain('seated-doc');
    expect(notice.params?.content).not.toContain('[not covered]');
    second.kill();
  }, 40_000);
});

/**
 * A DECLARED LEAD SURVIVES ITS OWN RESPAWN — the ticket's second DONE-WHEN,
 * and the half that was missing.
 *
 * `set_workspace_lead` gives the session one `ws:<id>` key and one attachment.
 * The restore path re-wired the key and stopped there: the attachment record
 * hydrates with the heartbeat from BEFORE the restart, so the board reads the
 * returning lead as `away` and every lead-addressed delivery keeps queuing.
 * Subscribed, seated, and invisible — with a restore notice that said
 * "watches restored" and nothing else.
 *
 * Driven through the shipped BUNDLE, because that is what a peer loads. Its
 * own server with a one-second freshness window, so "went away" is reachable
 * inside a test instead of five minutes later; sharing the suite's server
 * would age every other session in the file too.
 */
describe('a declared lead comes back live after a respawn', () => {
  const NAME = 'Declared Lead Tester';
  const AGENT_ID = 'agent-declared-lead-tester';
  const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const live: McpChild[] = [];

  const rest = (path: string, method: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        host: `localhost:${handle.port}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-declared-lead-'));
    handle = createServer({ port: 0, dataDir, heartbeatFreshMs: 1_000 });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    for (const c of live) c.kill();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const spawnChild = async (env: Record<string, string | undefined>): Promise<McpChild> => {
    const c = new McpChild(base, env);
    live.push(c);
    await c.init();
    return c;
  };

  const stateOf = async (workspaceId: string): Promise<string | undefined> => {
    const res = (await (
      await rest(`/api/workspaces/${workspaceId}/attachments`, 'GET')
    ).json()) as {
      attachments: Array<{ agentId: string; state: string }>;
    };
    return res.attachments.find((a) => a.agentId === AGENT_ID)?.state;
  };

  it('is re-ATTACHED, not merely re-subscribed, and its goal edits arrive', async () => {
    const w = await rest('/api/workspaces', 'POST', {
      name: 'declared-board',
      goal: 'Ship the index.',
    });
    const workspaceId = ((await w.json()) as { workspace: { id: string } }).workspace.id;
    // A goal edit re-triages the board's OPEN ROWS, so an empty board has
    // nothing to ask about and reports `requested: false` for a reason that
    // has nothing to do with attachment. One row makes the later assertion
    // about liveness rather than about emptiness.
    expect(
      (
        await rest(`/api/workspaces/${workspaceId}/tasks`, 'POST', {
          author: PERSON,
          title: 'An open row',
        })
      ).status,
    ).toBe(200);

    const first = await spawnChild({ CW_AGENT_NAME: NAME });
    const declared = (await first.tool('set_workspace_lead', { workspaceId })) as {
      leadAgentId: string;
      subscribed: boolean;
    };
    expect(declared.leadAgentId).toBe(AGENT_ID);
    first.kill();

    // The respawn gap, which a real one produces simply by taking a moment.
    await new Promise((r) => setTimeout(r, 1_200));
    // The precondition, asserted rather than assumed: the session really is
    // away here, so what follows is a repair and not a no-op.
    expect(await stateOf(workspaceId)).toBe('away');

    const second = await spawnChild({ CW_AGENT_NAME: NAME });
    // Any tool call drives the restore; this is one an agent would run.
    await second.tool('list_watched_docs');
    expect(await stateOf(workspaceId)).not.toBe('away');

    // The end-to-end consequence, and the only assertion that would have
    // caught this: a goal edit is DELIVERED rather than stored for a lead the
    // server cannot see. `queued: true` here is the incident.
    const goal = await rest(`/api/workspaces/${workspaceId}/goal`, 'PUT', {
      goal: 'Cut token usage per session in half.',
      author: PERSON,
    });
    const retriage = ((await goal.json()) as { retriage: { requested: boolean; queued: boolean } })
      .retriage;
    expect(retriage.requested).toBe(true);
    expect(retriage.queued).toBe(false);
    second.kill();
  }, 40_000);

  /**
   * POSITIVE CONTROL on the re-attach: a session that only WATCHES a doc on
   * somebody else's board must not be re-attached to it. `attachAgent` claims
   * an empty seat, so a restore that attached to every board a watched doc
   * touches would have respawns quietly taking seats nobody gave them.
   */
  it('POSITIVE CONTROL: does not attach a respawn to a board it only watches', async () => {
    const OTHER = 'Bystander Tester';
    const OTHER_ID = 'agent-bystander-tester';
    const w = await rest('/api/workspaces', 'POST', {
      name: 'someone-elses-board',
      goal: 'Ship the index.',
    });
    const workspaceId = ((await w.json()) as { workspace: { id: string } }).workspace.id;
    const path = join(dataDir, 'bystander-doc.md');
    writeFileSync(path, '# bystander-doc\n\nBody.\n');
    await rest('/api/docs', 'POST', {
      docId: 'bystander-doc',
      sourceUrl: path,
      title: 'bystander-doc',
      hubWorkspaceId: workspaceId,
    });

    const first = await spawnChild({ CW_AGENT_NAME: OTHER });
    await first.tool('watch_doc', { docId: 'bystander-doc' });
    first.kill();
    const second = await spawnChild({ CW_AGENT_NAME: OTHER });
    await second.tool('list_watched_docs');

    const res = (await (
      await rest(`/api/workspaces/${workspaceId}/attachments`, 'GET')
    ).json()) as {
      attachments: Array<{ agentId: string }>;
    };
    expect(res.attachments.map((a) => a.agentId)).not.toContain(OTHER_ID);
    // …and the seat is still empty, rather than quietly taken by a bystander.
    const board = (await (await rest(`/api/workspaces/${workspaceId}`, 'GET')).json()) as {
      workspace: { leadAgentId?: string };
    };
    expect(board.workspace.leadAgentId).toBeUndefined();
    second.kill();
  }, 40_000);
});
