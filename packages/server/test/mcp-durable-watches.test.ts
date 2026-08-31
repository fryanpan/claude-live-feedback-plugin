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
import { connect as netConnect } from 'node:net';
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
    // The child's own diagnostics, off by default. `stdio` already pipes
    // stderr, so without this it is captured and thrown away — and everything
    // this suite is about (a restore that could not connect, an SSE loop
    // retrying) reports itself there and nowhere else. `MCP_CHILD_STDERR=1`
    // when a case here fails for a reason the assertions cannot name.
    if (process.env.MCP_CHILD_STDERR)
      this.child.stderr?.on('data', (d: Buffer) => console.error('[child]', d.toString().trim()));
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
  /**
   * The ids the server MINTED for the docs asked for as `dw-one` / `dw-two`.
   *
   * A watch is a durable key and an event carries the doc's ADDRESS, so both
   * are the minted id — the readable name is what the fixture asked for, not
   * what the watch store and the channel payloads speak in.
   */
  let dwOne: string;
  let dwTwo: string;

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
    handle = createServer({ dedicatedListener: true, port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    // Created under readable names; every assertion below speaks the ids the
    // server minted back.
    const mintedFor: Record<string, string> = {};
    for (const name of ['dw-one', 'dw-two']) {
      const path = join(dataDir, `${name}.md`);
      writeFileSync(path, `# ${name}\n\nA paragraph to anchor a thread on.\n`);
      const res = await rest('/api/docs', 'POST', { docId: name, sourceUrl: path });
      expect(res.status).toBe(200);
      mintedFor[name] = ((await res.json()) as { docId: string }).docId;
    }
    dwOne = mintedFor['dw-one'] as string;
    dwTwo = mintedFor['dw-two'] as string;
    expect(dwOne).toBeTruthy();
    expect(dwTwo).toBeTruthy();
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
    const w = (await first.tool('watch_doc', { docId: dwOne })) as {
      persisted: boolean;
      persistence: string;
      watching: string[];
    };
    expect(w.persisted).toBe(true);
    expect(w.persistence).toBe('server');
    const ws = (await first.tool('create_workspace', { name: 'dw-ws' })) as {
      workspaceId: string;
    };
    expect(ws.workspaceId).toBeTruthy();
    // And a doc touched through an ordinary tool (the auto-watch path).
    await first.tool('list_threads', { docId: dwTwo });

    // Server-side effect, not the tool's own account of itself.
    const stored = handle.agentWatches.list(AGENT_ID, () => true).watches.map((x) => x.key);
    expect(stored).toEqual([dwOne, `ws:${ws.workspaceId}`, dwTwo]);

    // The respawn: kill the child, start another with the SAME identity.
    first.kill();
    const second = await spawnChild({ FEEDBACK_AGENT_NAME: NAME });

    const restored = (await second.tool('list_watched_docs')) as {
      watching: string[];
      restore: { status: string; from: string; restored: string[]; pruned: string[]; at?: string };
    };
    expect(restored.restore.status).toBe('restored');
    expect(restored.restore.from).toBe('server');
    expect(restored.restore.restored.sort()).toEqual([dwOne, dwTwo, `ws:${ws.workspaceId}`].sort());
    expect(restored.restore.pruned).toEqual([]);
    expect(restored.watching.sort()).toEqual([dwOne, dwTwo, `ws:${ws.workspaceId}`].sort());

    // The session was TOLD, not left to ask: one channel line on restore.
    const notice = await second.waitForChannel((n) =>
      (n.params?.content ?? '').startsWith('[watches restored]'),
    );
    expect(notice.params?.content).toContain('3 watches');
    expect(notice.params?.content).toContain(NAME);

    // A restored watch that delivers nothing is the empty-list failure with
    // extra steps — so post a real thread on the restored doc and require it
    // to arrive in the NEW child as a channel message.
    const thread = await rest(`/api/docs/${dwOne}/threads/by_find`, 'POST', {
      find: 'paragraph to anchor',
      text: 'Does the restored watch hear this?',
      author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
    });
    expect(thread.status).toBe(200);
    const delivered = await second.waitForChannel(
      (n) =>
        n.params?.meta?.doc_id === dwOne &&
        (n.params?.content ?? '').includes('Does the restored watch hear this?'),
    );
    expect(delivered.params?.meta?.event).toBe('thread.created');

    // unwatch forgets it on the server too, so the NEXT respawn does not
    // resurrect it — and dw-two, untouched, comes back.
    const un = (await second.tool('unwatch_doc', { docId: dwOne })) as { persisted: boolean };
    expect(un.persisted).toBe(true);
    second.kill();
    const third = await spawnChild({ FEEDBACK_AGENT_NAME: NAME });
    const after = (await third.tool('list_watched_docs')) as {
      watching: string[];
      restore: { restored: string[] };
    };
    expect(after.watching).not.toContain(dwOne);
    expect(after.watching).toContain(dwTwo);
    expect(after.restore.restored).toContain(dwTwo);
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
    const w = (await anon.tool('watch_doc', { docId: dwTwo })) as {
      persisted: boolean;
      persistence: string;
      watching: string[];
    };
    // Locally wired — events still flow for THIS session…
    expect(w.watching).toEqual([dwTwo]);
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
    docName: string,
  ): Promise<{ workspaceId: string; docId: string }> => {
    const ws = (await (await rest('/api/workspaces', 'POST', { name })).json()) as {
      workspace: { id: string };
    };
    const workspaceId = ws.workspace.id;
    const path = join(dataDir, `${docName}.md`);
    writeFileSync(path, `# ${docName}\n\nA paragraph to anchor a thread on.\n`);
    // The board records the MINTED id, which is the key coverage matches a
    // watch against — so the fixture hands that back, not the name.
    const created = await rest('/api/docs', 'POST', {
      docId: docName,
      sourceUrl: path,
      hubWorkspaceId: workspaceId,
    });
    expect(created.status).toBe(200);
    const docId = ((await created.json()) as { docId: string }).docId;
    expect(docId).toBeTruthy();
    // A spoken change is what queues for a board's lead; with no live lead it
    // waits instead of being routed to anybody.
    const voice = await rest(`/api/workspaces/${workspaceId}/voice`, 'POST', {
      author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
      transcript: 'make cutting token usage the top goal',
    });
    expect(voice.status).toBe(200);
    expect(((await voice.json()) as { route: string }).route).toBe('agent-queued');
    return { workspaceId, docId };
  };

  it('a session watching docs on a board it never attached to is TOLD, on both surfaces', async () => {
    const NAME2 = 'Coverage Watch Tester';
    const AGENT2 = 'agent-coverage-watch-tester';
    const { workspaceId, docId: covDoc } = await boardWithBacklog('cov-board', 'cov-doc');

    const first = await spawnChild({ CW_AGENT_NAME: NAME2 });
    await first.tool('watch_doc', { docId: covDoc });
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
          queued: { queuedVoice: number };
        }>;
      };
    };
    expect(live.watching).toContain(covDoc);
    expect(live.coverage?.agentId).toBe(AGENT2);
    const row = live.coverage?.unattachedBoards.find((b) => b.workspaceId === workspaceId);
    expect(row).toBeDefined();
    expect(row?.name).toBe('cov-board');
    expect(row?.watchedDocs).toEqual([covDoc]);
    expect(row?.queued.queuedVoice).toBe(1);
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
    const { workspaceId, docId: seatedDoc } = await boardWithBacklog('seated-board', 'seated-doc');

    const first = await spawnChild({ CW_AGENT_NAME: NAME3 });
    await first.tool('watch_doc', { docId: seatedDoc });
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
    expect(notice.params?.content).toContain(seatedDoc);
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
    handle = createServer({ dedicatedListener: true, port: 0, dataDir, heartbeatFreshMs: 1_000 });
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

  it('is re-ATTACHED, not merely re-subscribed, and its lead-addressed asks arrive', async () => {
    const w = await rest('/api/workspaces', 'POST', { name: 'declared-board' });
    const workspaceId = ((await w.json()) as { workspace: { id: string } }).workspace.id;
    /** A spoken change is the lead-addressed ask that goes live or queues. */
    const speak = async (transcript: string): Promise<string> => {
      const res = await rest(`/api/workspaces/${workspaceId}/voice`, 'POST', {
        transcript,
        author: PERSON,
      });
      return ((await res.json()) as { route: string }).route;
    };

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
    // …and the ask below really can come back queued, so the delivered answer
    // after the respawn is about liveness rather than about a route that
    // always says the same thing.
    expect(await speak('park the export work until next week')).toBe('agent-queued');

    const second = await spawnChild({ CW_AGENT_NAME: NAME });
    // Any tool call drives the restore; this is one an agent would run.
    await second.tool('list_watched_docs');
    expect(await stateOf(workspaceId)).not.toBe('away');

    // The end-to-end consequence, and the only assertion that would have
    // caught this: a lead-addressed ask is DELIVERED rather than stored for a
    // lead the server cannot see. `agent-queued` here is the incident.
    expect(await speak('make cutting token usage the top goal')).toBe('agent');
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
    const w = await rest('/api/workspaces', 'POST', { name: 'someone-elses-board' });
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

/** Is a fresh TCP connect to `port` refused? Polls, because a stopped Bun
 *  server closes its listener on its own schedule. Returns false on timeout,
 *  so the caller asserts rather than hangs. */
async function waitForPortRefused(port: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const refused = await new Promise<boolean>((done) => {
      const sock = netConnect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        done(false);
      });
      sock.once('error', () => {
        sock.destroy();
        done(true);
      });
    });
    if (refused) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * A RESTORE THAT COULD NOT REACH THE SERVER SAYS SO — AND THE RETRY GETS IT BACK.
 *
 * `restore.status: 'failed'` and the capped backoff behind it shipped without
 * a single case that drives them. Everything above starts from a server that
 * answers, so the whole failure limb — the catch that records the error, the
 * `Date.now() < restoreRetryAt` gate that stops a down server being hammered
 * from every tool call, and the later call that actually re-wires the set —
 * ran only in production. A permanently-failed session and a recovering one
 * look identical from a green suite, which is the same "an empty list means
 * two things" problem the durable-watch work exists to end, one level up: a
 * `failed` that never becomes `restored` is silent deafness with a status
 * field attached.
 *
 * So this drives it end to end through the shipped BUNDLE: watch under a live
 * server, take that server away, respawn against the dead port, then bring the
 * SAME origin and data dir back and require a later tool call to flip to
 * `restored` and deliver a real event on the re-wired watch. Both halves are
 * load-bearing — without the second, a build that never retries passes.
 *
 * Timing: the first failure backs off `min(30s, 1s * 2**1)` = 2s, so the
 * recovery half waits just past that rather than the 30s cap. Fixtures are
 * synthetic. The repo is public.
 */
describe('a restore that could not reach the server fails loudly, then recovers', () => {
  const NAME = 'Restore Failure Tester';
  const AGENT_ID = 'agent-restore-failure-tester';
  const DOC_ID = 'rf-doc';
  /** min(30_000, 1_000 * 2 ** 1) — the wait after the FIRST failed attempt. */
  const FIRST_BACKOFF_MS = 2_000;
  let handle: ServerHandle | undefined;
  let dataDir: string;
  let port: number;
  /** What the MCP child is pointed at, and what phase one uses. */
  let base: string;
  /**
   * The SAME server, addressed by a spelling this process has never used.
   *
   * Phase two must not reuse phase one's connection pool, and this is not
   * hygiene — it is the whole fixture. Bun's `stop()` closes the LISTENER but
   * keeps already-accepted sockets serving, so after the restart a keep-alive
   * socket this process opened before the stop still answers 200 from the
   * DEAD instance while the child (a new process, new pool) talks to the live
   * one. Measured: the thread posted over the stale socket landed in the old
   * server's rooms and broadcast to nobody, so the delivery assertion below
   * failed while every other line passed. `127.0.0.1` keys a different pool,
   * so phase two connects fresh — the port is identical, which is what the
   * child requires.
   */
  let freshBase: string;
  const live: McpChild[] = [];

  const rest = (origin: string, path: string, method: string, body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        host: `localhost:${port}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const spawnChild = async (env: Record<string, string | undefined>): Promise<McpChild> => {
    const c = new McpChild(base, env);
    live.push(c);
    await c.init();
    return c;
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-restore-failure-'));
    // Bind on 0 to be handed a free port, then keep that NUMBER: the second
    // half needs the same origin to come back, because the child reads
    // FEEDBACK_BASE_URL once at spawn and a re-spawn is not what is being
    // measured here.
    handle = createServer({ dedicatedListener: true, port: 0, dataDir });
    port = handle.port;
    base = `http://localhost:${port}`;
    freshBase = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    for (const c of live) c.kill();
    await handle?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reports the unreachable server, holds off, then re-wires the set on a later call', async () => {
    const path = join(dataDir, `${DOC_ID}.md`);
    writeFileSync(path, `# ${DOC_ID}\n\nA paragraph to anchor a thread on.\n`);
    const createRes = await rest(base, '/api/docs', 'POST', { docId: DOC_ID, sourceUrl: path });
    expect(createRes.status).toBe(200);
    // `DOC_ID` is the READABLE name from here on; the doc's own id is what a
    // watch is stored and restored under, so the two are kept apart
    // deliberately — this test then proves they collapse to one doc.
    const mintedId = ((await createRes.json()) as { docId: string }).docId;
    expect(mintedId).not.toBe(DOC_ID);

    // A set worth restoring, persisted while the server is up.
    const first = await spawnChild({ CW_AGENT_NAME: NAME });
    const w = (await first.tool('watch_doc', { docId: DOC_ID })) as { persisted: boolean };
    expect(w.persisted).toBe(true);
    expect(handle?.agentWatches.list(AGENT_ID, () => true).watches.map((x) => x.key)).toEqual([
      mintedId,
    ]);
    first.kill();

    // Take the server away. Killing the child first closes its SSE stream, so
    // nothing of the child's holds the port.
    await handle?.stop();
    handle = undefined;
    // The precondition, measured rather than assumed — and the positive
    // control for the failure below, since a `failed` restore against a port
    // that was quietly still answering would prove nothing. A fresh TCP
    // connect rather than `fetch`, for the pooling reason on `freshBase`:
    // this process's pooled socket answers on a listener that has stopped
    // accepting, while the child about to spawn must dial in and cannot.
    expect(await waitForPortRefused(port)).toBe(true);

    // The respawn, against a dead port. `oninitialized` drives the first
    // attempt, so the failure is already recorded by the time a tool runs.
    const second = await spawnChild({ CW_AGENT_NAME: NAME });
    const failedAt = Date.now();
    const failed = (await second.tool('list_watched_docs')) as {
      watching: string[];
      coverage?: unknown;
      restore: { status: string; error?: string; attempts: number; restored: string[] };
    };
    expect(failed.restore.status).toBe('failed');
    // The error is CAPTURED, not swallowed. Pinned to what the field ACTUALLY
    // carries rather than to what would be useful: `http()` throws before it
    // has a status to report, so the message is whatever the runtime's fetch
    // said — Node reduces a refused connection to the bare string "fetch
    // failed", naming neither the port nor the cause. Recorded here so the
    // day that improves, this line says where to look.
    expect(failed.restore.error ?? '').not.toBe('');
    expect(failed.restore.error).toMatch(/fetch failed|ECONNREFUSED|refused/i);
    expect(failed.restore.attempts).toBe(1);
    expect(failed.restore.restored).toEqual([]);
    // Nothing is wired, and the session is not pretending otherwise.
    expect(failed.watching).toEqual([]);
    // `coverage` is ABSENT rather than empty when the server did not answer —
    // an empty block would read as "nothing is missing".
    expect(failed.coverage).toBeUndefined();

    // The backoff is doing something: an immediate second call does not spend
    // another attempt on a server that was unreachable milliseconds ago.
    const again = (await second.tool('list_watched_docs')) as {
      restore: { status: string; attempts: number };
    };
    expect(again.restore.status).toBe('failed');
    expect(again.restore.attempts).toBe(1);
    // Asserted about the WINDOW, so a machine slow enough to have left it
    // fails loudly instead of passing the line above for the wrong reason.
    expect(Date.now() - failedAt).toBeLessThan(FIRST_BACKOFF_MS);

    // Bring the same origin back, over the same data dir — so the set the
    // first child persisted is there to be restored.
    handle = createServer({ dedicatedListener: true, port, dataDir });
    expect(handle.port).toBe(port);
    expect(handle.agentWatches.list(AGENT_ID, () => true).watches.map((x) => x.key)).toEqual([
      mintedId,
    ]);

    // Past the backoff window, then any ordinary tool call.
    const remaining = failedAt + FIRST_BACKOFF_MS + 200 - Date.now();
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));

    const recovered = (await second.tool('list_watched_docs')) as {
      watching: string[];
      restore: { status: string; from: string; restored: string[]; attempts: number; at?: string };
    };
    expect(recovered.restore.status).toBe('restored');
    expect(recovered.restore.from).toBe('server');
    // Exactly one more attempt than the failure — the gate let the retry
    // through once, rather than the tool calls in between each spending one.
    expect(recovered.restore.attempts).toBe(2);
    expect(recovered.restore.restored).toEqual([mintedId]);
    expect(recovered.watching).toEqual([mintedId]);
    expect(recovered.restore.at).toBeTruthy();

    // A listed watch that delivers nothing is the failure this whole area
    // exists to prevent, so require a real event on the RE-WIRED stream.
    const thread = await rest(freshBase, `/api/docs/${DOC_ID}/threads/by_find`, 'POST', {
      find: 'paragraph to anchor',
      text: 'Does the retried watch hear this?',
      author: { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' },
    });
    expect(thread.status).toBe(200);
    const delivered = await second.waitForChannel(
      (n) =>
        n.params?.meta?.doc_id === mintedId &&
        (n.params?.content ?? '').includes('Does the retried watch hear this?'),
    );
    expect(delivered.params?.meta?.event).toBe('thread.created');
    second.kill();
  }, 60_000);
});
