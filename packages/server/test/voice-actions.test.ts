/**
 * Voice ACTIONS (§2.4 / §3.8): the scoped verb set, end to end.
 *
 * A spoken "mark this done" over a ticket in view no longer waits for an
 * agent — the router runs it through `taskStore.transition` /
 * `taskStore.setAssignee` / `rooms.postComment` / `rooms.answerReviewItem`,
 * the SAME choke points the REST routes use, so the move is attributed to the
 * speaker and lands in `events.jsonl` exactly as a tapped one does. Anything
 * outside the scoped verb set still goes to the agent, unchanged.
 *
 * The two TEXT verbs are asserted with exact equality rather than
 * containment, on purpose: what must never happen is the model's prose being
 * posted under the speaker's name, and a truncated reply is a substring of
 * nothing — but a containment assertion passes on a body that merely holds
 * the transcript somewhere inside a sentence the speaker never said.
 *
 * Driven through the real route table (POST /api/workspaces/:id/voice): the
 * route layer hand-copies fields and nothing type-checks it, so a unit test on
 * the router alone would not prove the actor ever arrives.
 *
 * The audit assertions read `events.jsonl` off DISK rather than trusting the
 * ack. An ack that names a transition is what a router which wrote nothing
 * would also produce; the log row is what makes the attribution real.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public. No live model call: the classification is
 * stubbed at the injected `voiceComplete` seam.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { eventsLogPath, voiceQueuePath } from '../src/tasks.ts';

/** A person: `classifyActor` reads `kind: 'known'` as `person`. */
const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
/** The hazard actor — no `kind` at all, which `classifyActor` reads as an
 *  AGENT. Every write it could make would be misattributed, so it makes none. */
const KINDLESS = { id: 'u-rowan', name: 'Rowan', color: '#d72e7d' };
/** `classifyActor` reads an `agent-` id as an agent — which is what puts a
 *  thread INTO the review queue: the queue is "the newest word is an agent's". */
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

interface AuditRow {
  event?: string;
  taskId?: string;
  from?: string;
  to?: string;
  actor?: { id?: string; name?: string; kind?: string };
}

interface StoredThread {
  id: string;
  anchor?: { kind?: string };
  comments?: Array<{ text?: string; author?: { id?: string; name?: string } }>;
}

/**
 * Every navigation this server hands a voice client must be a SAME-ORIGIN
 * path. Both clients call `location.assign` on it unconditionally, so a value
 * starting `//` is a protocol-relative jump to another host and a value with a
 * scheme is an open redirect. One leading slash, and the next character is not
 * one.
 */
const SAME_ORIGIN = /^\/[^/]/;

describe('voice actions (§3.8): status and assignee, on the speaker’s authority', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let hubId: string;
  /** A second board with NO attachment, so "queued" is a real fixture rather
   *  than a test-ordering artifact. */
  let quietHubId: string;
  let doneTaskId: string;
  let assignTaskId: string;
  let blockerTaskId: string;
  let blockedTaskId: string;
  let kindlessTaskId: string;
  let quietTaskId: string;
  let commentTaskId: string;
  let linkedTaskId: string;
  let urlOnlyTaskId: string;
  /** Docs attached to `hubId`, carrying one / two / no open review items. */
  let oneItemDocId: string;
  let twoItemDocId: string;
  let noItemDocId: string;
  let linkedDocId: string;
  let oneItemThreadId: string;
  /** Per-test classification. */
  let completeImpl: (() => Promise<string>) | null = null;

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

  const voice = (workspaceId: string, body: unknown) =>
    post(`/api/workspaces/${workspaceId}/voice`, body);

  const say = async (
    workspaceId: string,
    transcript: string,
    context: unknown,
    author: unknown = PERSON,
  ): Promise<{ route: string; ack: string; navigate?: string }> => {
    const r = await voice(workspaceId, { transcript, context, author });
    expect(r.status).toBe(200);
    return (await r.json()) as { route: string; ack: string; navigate?: string };
  };

  const classify = (reply: Record<string, unknown>): void => {
    completeImpl = () => Promise.resolve(JSON.stringify(reply));
  };

  /** The workspace's audit log, straight off disk. */
  const audit = (workspaceId: string): AuditRow[] => {
    const path = eventsLogPath(dataDir, workspaceId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as AuditRow];
        } catch {
          return [];
        }
      });
  };

  const transitionsFor = (workspaceId: string, taskId: string): AuditRow[] =>
    audit(workspaceId).filter((r) => r.event === 'task.transitioned' && r.taskId === taskId);

  const newTask = async (workspaceId: string, body: Record<string, unknown>): Promise<string> => {
    const r = await post(`/api/workspaces/${workspaceId}/tasks`, { author: PERSON, ...body });
    expect(r.status).toBe(200);
    return ((await r.json()) as { task: { id: string } }).task.id;
  };

  /** A doc room on disk, attached to `hubId` — the shape `docResource` reads. */
  const newDoc = async (docId: string): Promise<string> => {
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, '# Ranking\n\nthe ranking clause\n');
    expect((await post('/api/docs', { docId, type: 'markdown', sourceUrl: file })).status).toBe(
      200,
    );
    expect((await post(`/api/workspaces/${hubId}/docs`, { docId })).status).toBe(200);
    return docId;
  };

  /** An open review item: an AGENT declares, so the run is unanswered and the
   *  thread is genuinely in the queue rather than merely present. */
  const declare = async (docId: string, headline: string): Promise<string> => {
    const r = await post(`/api/docs/${docId}/threads`, {
      author: AGENT,
      text: `${headline} — both paths are built either way.`,
      anchor: { kind: 'subject' },
      // A 'review' rather than a 'decision': answered in the person's own
      // words, which is exactly the shape a spoken answer takes. (A decision
      // needs two named options and a voice reply names none.)
      review: {
        shape: 'review',
        headline,
        why: 'Blocks the rollout; the wording is yours.',
        lookFor: 'Whether the shorter clause still reads as a rule.',
      },
    });
    const payload = (await r.json()) as { thread?: { id: string }; error?: string };
    expect(r.status, payload.error ?? '').toBe(200);
    return payload.thread?.id ?? '';
  };

  /** Threads read back off the store, never out of a write's response body. */
  const threadsOf = async (docId: string): Promise<StoredThread[]> => {
    const r = await local(`/api/docs/${docId}/threads`);
    expect(r.status).toBe(200);
    return ((await r.json()) as { threads: StoredThread[] }).threads;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'voice-actions-'));
    handle = createServer({
      port: 0,
      dataDir,
      voiceComplete: () => {
        if (!completeImpl) return Promise.reject(new Error('fast path down'));
        return completeImpl();
      },
    });
    base = `http://localhost:${handle.port}`;

    const ws = await post('/api/workspaces', {
      name: 'search-revamp',
      goal: 'Ship the new search.',
    });
    expect(ws.status).toBe(200);
    hubId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    doneTaskId = await newTask(hubId, { title: 'Wire the results page' });
    assignTaskId = await newTask(hubId, { title: 'Benchmark the crawler', assignee: 'human' });
    kindlessTaskId = await newTask(hubId, { title: 'Rename the settings panel' });
    blockerTaskId = await newTask(hubId, { title: 'Land the schema migration' });
    blockedTaskId = await newTask(hubId, { title: 'Cut over the read path' });
    expect(
      (
        await post(`/api/tasks/${blockedTaskId}/after`, {
          after: [blockerTaskId],
          afterEnforce: [blockerTaskId],
          author: PERSON,
        })
      ).status,
    ).toBe(200);

    // A live agent on this board, so the agent route is 'agent' here and the
    // queued fallback is proved on a board that genuinely has nobody.
    expect(
      (
        await post(`/api/workspaces/${hubId}/attachments`, {
          agentId: 'agent-search-revamp',
          runtime: 'claude-code-local',
        })
      ).status,
    ).toBe(200);

    const quiet = await post('/api/workspaces', {
      name: 'billing-cleanup',
      goal: 'Retire the old invoicing path.',
    });
    expect(quiet.status).toBe(200);
    quietHubId = ((await quiet.json()) as { workspace: { id: string } }).workspace.id;
    quietTaskId = await newTask(quietHubId, { title: 'Drop the legacy invoice job' });

    // ── Commit 4 fixtures: comment / answer-review / open-link ──────────────
    commentTaskId = await newTask(hubId, { title: 'Tune the ranking weights' });

    linkedDocId = await newDoc('voice-linked-notes');
    linkedTaskId = await newTask(hubId, {
      title: 'Review the ranking notes',
      links: [{ kind: 'doc', docId: linkedDocId }],
    });
    urlOnlyTaskId = await newTask(hubId, {
      title: 'Chase the upstream ticket',
      links: [{ kind: 'url', url: 'https://example.invalid/tickets/9' }],
    });

    oneItemDocId = await newDoc('voice-review-one');
    oneItemThreadId = await declare(oneItemDocId, 'Which ranking clause ships?');
    twoItemDocId = await newDoc('voice-review-two');
    await declare(twoItemDocId, 'Which ranking clause ships?');
    await declare(twoItemDocId, 'Do we keep the legacy sort?');
    noItemDocId = await newDoc('voice-review-none');
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('set-status', () => {
    it('“mark this done” transitions the task and acks the title and from→to', async () => {
      classify({ kind: 'action', action: 'set-status', status: 'done' });
      const body = await say(hubId, 'mark this done', { surface: 'task', taskId: doneTaskId });

      expect(body.route).toBe('fast-path-action');
      // The human in the room is the only verifier this design has, so the
      // ack has to name the task it moved and both ends of the move.
      expect(body.ack).toContain('Wire the results page');
      expect(body.ack).toContain('todo');
      expect(body.ack).toContain('done');
      expect(body.ack).toContain('mark this done');
      expect(handle.tasks.getTask(doneTaskId)?.status).toBe('done');
    });

    it('the move is attributed to the SPEAKER and lands in events.jsonl', () => {
      const rows = audit(hubId);
      // Positive control: this probe can see the log at all.
      expect(rows.length).toBeGreaterThan(0);
      const moves = rows.filter((r) => r.event === 'task.transitioned' && r.taskId === doneTaskId);
      expect(moves).toHaveLength(1);
      const move = moves[0];
      expect(move?.from).toBe('todo');
      expect(move?.to).toBe('done');
      // Not the agent, and not an anonymous write: `classifyActor` maps a
      // kind-less author to 'agent', so 'person' here is the whole point.
      expect(move?.actor?.id).toBe(PERSON.id);
      expect(move?.actor?.name).toBe(PERSON.name);
      expect(move?.actor?.kind).toBe('person');
    });

    it('re-sending the same transition acks SUCCESS — the board is already right', async () => {
      classify({ kind: 'action', action: 'set-status', status: 'done' });
      const body = await say(hubId, 'mark this done', { surface: 'task', taskId: doneTaskId });

      expect(body.route).toBe('fast-path-action');
      expect(body.ack).toContain('Wire the results page');
      expect(body.ack.toLowerCase()).toContain('already');
      expect(body.ack.toLowerCase()).not.toContain('sent to the workspace agent');
      // Acked as success, and still exactly one move on the record.
      expect(transitionsFor(hubId, doneTaskId)).toHaveLength(1);
    });

    it('a transition refused as BLOCKED writes nothing and hands the utterance to the agent', async () => {
      classify({ kind: 'action', action: 'set-status', status: 'done' });
      const body = await say(hubId, 'mark this done', { surface: 'task', taskId: blockedTaskId });

      expect(body.route).toBe('agent');
      // The speaker is told WHY it went to the agent, by name.
      expect(body.ack).toContain('Land the schema migration');
      expect(handle.tasks.getTask(blockedTaskId)?.status).toBe('todo');
      expect(transitionsFor(hubId, blockedTaskId)).toHaveLength(0);
    });

    it('an actor with no `kind` writes NOTHING — attribution would be a lie', async () => {
      classify({ kind: 'action', action: 'set-status', status: 'done' });
      const body = await say(
        hubId,
        'mark this done',
        { surface: 'task', taskId: kindlessTaskId },
        KINDLESS,
      );

      expect(body.route).toBe('agent');
      expect(handle.tasks.getTask(kindlessTaskId)?.status).toBe('todo');
      expect(transitionsFor(hubId, kindlessTaskId)).toHaveLength(0);
    });
  });

  describe('set-assignee', () => {
    it('“assign this to me” resolves to the SPEAKER’s name, in the router', async () => {
      classify({ kind: 'action', action: 'set-assignee', assignee: 'me' });
      const body = await say(hubId, 'assign this to me', {
        surface: 'task',
        taskId: assignTaskId,
      });

      expect(body.route).toBe('fast-path-action');
      expect(body.ack).toContain('Benchmark the crawler');
      expect(body.ack).toContain('Jordan');
      expect(handle.tasks.getTask(assignTaskId)?.assignee).toBe('Jordan');

      const assigned = audit(hubId).filter(
        (r) => r.event === 'task.assigned' && r.taskId === assignTaskId,
      );
      expect(assigned).toHaveLength(1);
      expect(assigned[0]?.from).toBe('human');
      expect(assigned[0]?.to).toBe('Jordan');
      expect(assigned[0]?.actor?.kind).toBe('person');
    });
  });

  describe('comment', () => {
    it('posts the transcript VERBATIM on task:<taskId>, attributed to the speaker', async () => {
      const said = 'note that the crawler is flaky on retries';
      classify({ kind: 'action', action: 'comment' });
      const body = await say(hubId, said, { surface: 'task', taskId: commentTaskId });

      expect(body.route).toBe('fast-path-action');
      expect(body.ack).toContain('Tune the ranking weights');

      const threads = await threadsOf(`task:${commentTaskId}`);
      expect(threads).toHaveLength(1);
      const comments = threads[0]?.comments ?? [];
      expect(comments).toHaveLength(1);
      // EXACT equality, not containment. A truncated model reply would post a
      // half sentence attributed to the speaker, and containment would pass.
      expect(comments[0]?.text).toBe(said);
      expect(comments[0]?.author?.id).toBe(PERSON.id);
      // A task discussion is about the task, not a span inside its body.
      expect(threads[0]?.anchor?.kind).toBe('subject');
    });

    it('an actor with no `kind` posts NOTHING — the comment would be misattributed', async () => {
      classify({ kind: 'action', action: 'comment' });
      const body = await say(
        hubId,
        'the retry backoff looks wrong',
        { surface: 'task', taskId: kindlessTaskId },
        KINDLESS,
      );

      expect(body.route).toBe('agent');
      expect(await threadsOf(`task:${kindlessTaskId}`)).toHaveLength(0);
    });
  });

  describe('answer-review', () => {
    it('answers when EXACTLY ONE open item is in scope, verbatim and as the speaker', async () => {
      const said = 'go with the shorter clause, it reads better on mobile';
      classify({ kind: 'action', action: 'answer-review' });
      const body = await say(hubId, said, { surface: 'doc', docId: oneItemDocId });

      expect(body.route).toBe('fast-path-action');

      const threads = await threadsOf(oneItemDocId);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe(oneItemThreadId);
      const comments = threads[0]?.comments ?? [];
      expect(comments).toHaveLength(2);
      expect(comments[1]?.text).toBe(said);
      expect(comments[1]?.author?.id).toBe(PERSON.id);
    });

    it('with TWO open items in scope it writes NOTHING and hands the utterance to the agent', async () => {
      classify({ kind: 'action', action: 'answer-review' });
      const body = await say(hubId, 'yes, do that one', { surface: 'doc', docId: twoItemDocId });

      expect(body.route).toBe('agent');
      // Both threads still hold exactly the agent's declaration.
      const threads = await threadsOf(twoItemDocId);
      expect(threads).toHaveLength(2);
      for (const t of threads) expect(t.comments ?? []).toHaveLength(1);
    });

    it('with NO open item in scope it writes nothing either', async () => {
      classify({ kind: 'action', action: 'answer-review' });
      const body = await say(hubId, 'yes, do that one', { surface: 'doc', docId: noItemDocId });

      expect(body.route).toBe('agent');
      expect(await threadsOf(noItemDocId)).toHaveLength(0);
    });
  });

  describe('open-link', () => {
    it('“open the linked doc” navigates to the task’s own doc ref', async () => {
      classify({ kind: 'action', action: 'open-link' });
      const body = await say(hubId, 'open the linked doc', {
        surface: 'task',
        taskId: linkedTaskId,
      });

      // 'fast-path', not 'fast-path-action': nothing was written, and the MCP
      // suppresses exactly "a lookup the server already answered".
      expect(body.route).toBe('fast-path');
      expect(body.navigate).toBe(`/review/${linkedDocId}`);
      expect(body.navigate).toMatch(SAME_ORIGIN);
    });

    it('a task whose only link is a `url` ref navigates nowhere and goes to the agent', async () => {
      classify({ kind: 'action', action: 'open-link' });
      const body = await say(hubId, 'open the linked mockup', {
        surface: 'task',
        taskId: urlOnlyTaskId,
      });

      expect(body.route).toBe('agent');
      expect(body.navigate).toBeUndefined();
    });
  });

  describe('positive control: everything outside the scoped set is unchanged', () => {
    it('“rewrite the goal list” still goes to the attached agent, with the old ack', async () => {
      classify({ kind: 'change' });
      const body = await say(hubId, 'rewrite the goal list', { surface: 'hub' });

      expect(body.route).toBe('agent');
      expect(body.ack).toContain('rewrite the goal list');
      expect(body.ack).toContain('Sent to the workspace agent.');
      expect(body.ack).not.toContain('Fast path unavailable');
    });

    it('and it QUEUES on a board with nobody attached', async () => {
      classify({ kind: 'change' });
      const body = await say(quietHubId, 'rewrite the goal list', {
        surface: 'task',
        taskId: quietTaskId,
      });

      expect(body.route).toBe('agent-queued');
      expect(body.ack.toLowerCase()).toContain('queued');
      const qPath = voiceQueuePath(dataDir, quietHubId);
      expect(existsSync(qPath)).toBe(true);
      expect(readFileSync(qPath, 'utf8')).toContain('rewrite the goal list');
    });

    it('a LOOKUP still answers on the plain fast-path route', async () => {
      classify({ kind: 'lookup', target: 'task', id: doneTaskId });
      const body = await say(hubId, 'take me to the results page task', { surface: 'hub' });

      // Distinct from 'fast-path-action' on purpose: the MCP suppresses this
      // one as "a lookup the server already answered", and an executed action
      // is not that.
      expect(body.route).toBe('fast-path');
      expect(body.navigate).toBe(`/workspaces/${hubId}?task=${doneTaskId}`);
      // The same-origin assertion is applied to EVERY navigate the router
      // returns, so the pre-existing lookup paths have to keep satisfying it.
      expect(body.navigate).toMatch(SAME_ORIGIN);
    });

    it('a DOC lookup still navigates, which is the assertion’s positive control', async () => {
      classify({ kind: 'lookup', target: 'doc', id: noItemDocId });
      const body = await say(hubId, 'open the ranking notes', { surface: 'hub' });

      expect(body.route).toBe('fast-path');
      expect(body.navigate).toBe(`/review/${noItemDocId}`);
      expect(body.navigate).toMatch(SAME_ORIGIN);
    });
  });
});
