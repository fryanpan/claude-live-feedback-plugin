/**
 * Voice routing (§2.4 / §3.8, commit 9): POST /api/workspaces/:id/voice takes
 * a transcript + per-surface context, classifies it (Haiku fast path — via an
 * injected `complete`, tests never reach the network), and answers EVERY
 * utterance with an explicit ack naming what was heard and which route
 * handles it — including "agent away — queued".
 *
 * Driven through the real route table wherever a route exists (the `groups`
 * lesson: the route layer hand-copies fields and nothing type-checks it), and
 * every absence assertion has a positive control.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { KEYCHAIN_SERVICE, KEYCHAIN_SERVICE_LEGACY } from '../src/summarize.ts';
import { TaskStore, type TaskStoreEvent, voiceQueuePath } from '../src/tasks.ts';
import {
  RESOURCE_MAX,
  type VoiceContext,
  type VoiceResource,
  VoiceRouter,
  haikuVoiceComplete,
  parseVoiceReply,
  resolveVoiceAction,
} from '../src/voice.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Agent', kind: 'agent', color: '#7d2ed7' };

/** Threads need an anchor; nothing here reads it back. */
const ANCHOR = {
  kind: 'element' as const,
  fingerprint: {
    tag: 'P',
    stableAttrs: {},
    classes: [],
    text: 'Body.',
    path: 'P[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Body.' },
};

describe('voice routing (§3.8)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let hubId: string;
  let taskId: string;
  let docId: string;
  /** A SECOND board, so "belongs to another workspace" is a real fixture and
   *  not a made-up id the store would reject anyway. */
  let otherHubId: string;
  let otherTaskId: string;
  let otherDocId: string;
  /** Lives on the second board: its title alone blows the resource budget. */
  let bigTaskId: string;
  /** On `hubId`, carries links + an assignee — the resource block's payload. */
  let linkedTaskId: string;
  /** Per-test fast-path behavior. null = "fast path unavailable". */
  let completeImpl: ((args: { system: string; user: string }) => Promise<string>) | null = null;
  /** What the last classification call received — proves the route forwards
   *  the transcript + context all the way into the prompt. (A holder, not a
   *  bare let: TS narrows a `= null` assignment to `null` and can't see the
   *  closure write.) */
  const lastPrompt: { value: { system: string; user: string } | null } = { value: null };
  /** Fresh read — sidesteps TS narrowing `.value` to null after a reset. */
  const promptUser = (): string => lastPrompt.value?.user ?? '';
  const promptSystem = (): string => lastPrompt.value?.system ?? '';

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

  const voice = (body: unknown) => post(`/api/workspaces/${hubId}/voice`, body);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'voice-data-'));
    handle = createServer({
      port: 0,
      dataDir,
      voiceComplete: (args) => {
        lastPrompt.value = args;
        if (!completeImpl) return Promise.reject(new Error('fast path down'));
        return completeImpl(args);
      },
    });
    base = `http://localhost:${handle.port}`;

    const ws = await post('/api/workspaces', {
      name: 'search-revamp',
      goal: 'Ship the new search.',
    });
    expect(ws.status).toBe(200);
    hubId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    const t = await post(`/api/workspaces/${hubId}/tasks`, {
      title: 'Wire the results page',
      author: PERSON,
    });
    expect(t.status).toBe(200);
    taskId = ((await t.json()) as { task: { id: string } }).task.id;

    // One attached doc so doc lookups have a target.
    docId = 'expansion-plan';
    const p = join(dataDir, `${docId}.md`);
    writeFileSync(p, '# Expansion plan\n\nBody.\n');
    expect((await post('/api/docs', { docId, type: 'markdown', sourceUrl: p })).status).toBe(200);
    expect((await post(`/api/workspaces/${hubId}/docs`, { docId })).status).toBe(200);

    // A task carrying links + an owner, so the resource block has something to
    // render beyond a title.
    const linked = await post(`/api/workspaces/${hubId}/tasks`, {
      title: 'Fold the expansion plan into the results page',
      assignee: 'Jordan',
      assigneeKind: 'person',
      needs: 'action',
      links: [
        { kind: 'doc', docId },
        { kind: 'thread', docId, threadId: 'th-synthetic' },
      ],
      author: PERSON,
    });
    expect(linked.status).toBe(200);
    linkedTaskId = ((await linked.json()) as { task: { id: string } }).task.id;

    // ── The second board: everything here is FOREIGN to `hubId` ────────────
    const other = await post('/api/workspaces', {
      name: 'billing-cleanup',
      goal: 'Retire the old invoicing path.',
    });
    expect(other.status).toBe(200);
    otherHubId = ((await other.json()) as { workspace: { id: string } }).workspace.id;

    const ot = await post(`/api/workspaces/${otherHubId}/tasks`, {
      title: 'Drop the legacy invoice job',
      author: PERSON,
    });
    expect(ot.status).toBe(200);
    otherTaskId = ((await ot.json()) as { task: { id: string } }).task.id;

    const big = await post(`/api/workspaces/${otherHubId}/tasks`, {
      title: `Rewrite the invoicing narrative ${'and reconcile every ledger row '.repeat(60)}`,
      author: PERSON,
    });
    expect(big.status).toBe(200);
    bigTaskId = ((await big.json()) as { task: { id: string } }).task.id;

    otherDocId = 'invoice-runbook';
    const op = join(dataDir, `${otherDocId}.md`);
    writeFileSync(op, '# Invoice runbook\n\nBody.\n');
    expect(
      (await post('/api/docs', { docId: otherDocId, type: 'markdown', sourceUrl: op })).status,
    ).toBe(200);
    expect((await post(`/api/workspaces/${otherHubId}/docs`, { docId: otherDocId })).status).toBe(
      200,
    );
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('route validation', () => {
    it('400 without a transcript, 400 without an author, 404 on unknown workspace', async () => {
      expect((await voice({ author: PERSON })).status).toBe(400);
      expect((await voice({ transcript: '   ', author: PERSON })).status).toBe(400);
      expect((await voice({ transcript: 'hello' })).status).toBe(400);
      expect(
        (await post('/api/workspaces/nope/voice', { transcript: 'hello', author: PERSON })).status,
      ).toBe(404);
    });
  });

  describe('fast path (lookups only)', () => {
    it('a task lookup navigates to the task and acks what was heard', async () => {
      completeImpl = () =>
        Promise.resolve(JSON.stringify({ kind: 'lookup', target: 'task', id: taskId }));
      lastPrompt.value = null;
      const r = await voice({
        transcript: 'take me to the results page task',
        context: { surface: 'hub' },
        author: PERSON,
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { route: string; ack: string; navigate?: string };
      expect(body.route).toBe('fast-path');
      expect(body.navigate).toBe(`/workspaces/${hubId}?task=${taskId}`);
      expect(body.ack).toContain('take me to the results page task');
      expect(body.ack).toContain('Wire the results page');
      // The route forwarded the transcript into the classification prompt,
      // and the prompt carries the workspace index the model searches.
      expect(promptUser()).toContain('take me to the results page task');
      expect(promptUser()).toContain('Wire the results page');
    });

    it('the per-surface context rides into the prompt (doc surface + visibleHeading)', async () => {
      completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
      lastPrompt.value = null;
      const r = await voice({
        transcript: 'rewrite this section',
        context: { surface: 'doc', docId, visibleHeading: 'Rollout risks' },
        author: PERSON,
      });
      expect(r.status).toBe(200);
      expect(promptUser()).toContain('Rollout risks');
      expect(promptUser()).toContain(docId);
    });

    it('a doc lookup navigates to the review page', async () => {
      completeImpl = () =>
        Promise.resolve(JSON.stringify({ kind: 'lookup', target: 'doc', id: docId }));
      const r = await voice({
        transcript: 'open the expansion plan',
        context: { surface: 'hub' },
        author: PERSON,
      });
      const body = (await r.json()) as { route: string; navigate?: string };
      expect(body.route).toBe('fast-path');
      expect(body.navigate).toBe(`/review/${encodeURIComponent(docId)}`);
    });

    it('a lookup naming an id that does not exist answers honestly, with no navigation', async () => {
      completeImpl = () =>
        Promise.resolve(JSON.stringify({ kind: 'lookup', target: 'task', id: 't-invented' }));
      const r = await voice({
        transcript: 'open the flux capacitor task',
        author: PERSON,
      });
      const body = (await r.json()) as { route: string; ack: string; navigate?: string };
      expect(body.route).toBe('fast-path');
      expect(body.navigate).toBeUndefined();
      expect(body.ack).toContain('nothing');
      expect(body.ack).toContain('open the flux capacitor task');
    });
  });

  describe('agent route (changes) + the queued fallback', () => {
    it('with no live attachment, a change is QUEUED and the ack says so', async () => {
      completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
      const r = await voice({
        transcript: 'rework these into different groupings',
        context: { surface: 'hub' },
        author: PERSON,
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { route: string; ack: string };
      expect(body.route).toBe('agent-queued');
      expect(body.ack).toContain('rework these into different groupings');
      expect(body.ack.toLowerCase()).toContain('queued');
      // "Queued" is grounded: the request is on disk, not just promised.
      const qPath = voiceQueuePath(dataDir, hubId);
      expect(existsSync(qPath)).toBe(true);
      expect(readFileSync(qPath, 'utf8')).toContain('rework these into different groupings');
    });

    it('attaching an agent DRAINS the queue into the attach result', async () => {
      const r = await post(`/api/workspaces/${hubId}/attachments`, {
        agentId: 'agent-search-revamp',
        runtime: 'claude-code-local',
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        queuedVoice?: Array<{ transcript: string }>;
      };
      expect(body.queuedVoice?.map((q) => q.transcript)).toContain(
        'rework these into different groupings',
      );
      expect(existsSync(voiceQueuePath(dataDir, hubId))).toBe(false);
      // Drained means drained: a second attach delivers nothing again.
      const r2 = await post(`/api/workspaces/${hubId}/attachments`, {
        agentId: 'agent-search-revamp',
        runtime: 'claude-code-local',
      });
      const body2 = (await r2.json()) as { queuedVoice?: unknown[] };
      expect(body2.queuedVoice ?? []).toHaveLength(0);
    });

    it('with a live attachment, a change goes to the agent and emits voice.request', async () => {
      completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
      const seen: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((ev) => seen.push(ev));
      const r = await voice({
        transcript: 'add a task to benchmark the crawler',
        context: { surface: 'hub' },
        author: PERSON,
      });
      off();
      expect(r.status).toBe(200);
      const body = (await r.json()) as { route: string; ack: string };
      expect(body.route).toBe('agent');
      expect(body.ack).toContain('workspace agent');
      const ev = seen.find((e) => e.type === 'voice.request');
      expect(ev).toBeDefined();
      if (ev?.type === 'voice.request') {
        expect(ev.transcript).toBe('add a task to benchmark the crawler');
        expect(ev.route).toBe('agent');
        expect(ev.ack).toBe(body.ack);
      }
    });

    it('a failing fast path still answers: the utterance falls to the agent route', async () => {
      completeImpl = null; // complete rejects
      const r = await voice({
        transcript: 'take me to the expansion budget decision',
        author: PERSON,
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { route: string; ack: string };
      expect(body.route).toBe('agent');
      expect(body.ack).toContain('take me to the expansion budget decision');
      expect(body.ack.toLowerCase()).toContain('fast path unavailable');
    });

    it('garbage from the model is a fast-path failure, never a crash', async () => {
      completeImpl = () => Promise.resolve('well, that depends on what you mean by task');
      const r = await voice({ transcript: 'open the plan', author: PERSON });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { route: string };
      expect(body.route).toBe('agent');
    });
  });

  describe('every utterance is audited (§3.6 voice.request)', () => {
    it('the events.jsonl audit log carries the transcript, route, and ack verbatim', async () => {
      const r = await local(`/api/workspaces/${hubId}/events`);
      expect(r.status).toBe(200);
      const { events } = (await r.json()) as {
        events: Array<{ event: string; transcript?: string; route?: string; ack?: string }>;
      };
      const voiceEvents = events.filter((e) => e.event === 'voice.request');
      // Positive control: the log sees voice events at all.
      expect(voiceEvents.length).toBeGreaterThan(0);
      const queued = voiceEvents.find(
        (e) => e.transcript === 'rework these into different groupings',
      );
      expect(queued?.route).toBe('agent-queued');
      expect(queued?.ack?.toLowerCase()).toContain('queued');
      const looked = voiceEvents.find((e) => e.transcript === 'take me to the results page task');
      expect(looked?.route).toBe('fast-path');
    });
  });

  // The context arrives from the client and `parseVoiceContext` only clamps
  // its LENGTH — so an id from another board would resolve through the global
  // task index. Harmless while context ids never drive a write; the point of
  // checking membership here is that it stops being harmless the moment they
  // do. One predicate, the one the lookup validation already spells.
  describe('the context is trusted only after a membership check', () => {
    it('drops a taskId belonging to another workspace (control: this workspace renders)', async () => {
      completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
      lastPrompt.value = null;
      await voice({
        transcript: 'mark this done',
        context: { surface: 'task', taskId: otherTaskId },
        author: PERSON,
      });
      expect(promptUser()).not.toContain(otherTaskId);
      expect(promptUser()).not.toContain('task=');
      expect(promptUser()).not.toContain('Resource in view:');
      expect(promptUser()).not.toContain('Drop the legacy invoice job');

      // Positive control: the same shape with a task that IS on this board
      // renders both the location id and the resource block.
      lastPrompt.value = null;
      await voice({
        transcript: 'mark this done',
        context: { surface: 'task', taskId },
        author: PERSON,
      });
      expect(promptUser()).toContain(`task=${taskId}`);
      expect(promptUser()).toContain('Resource in view:');
      expect(promptUser()).toContain('Wire the results page');
    });

    it('drops a docId not attached to this workspace (control: an attached doc renders)', async () => {
      completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
      lastPrompt.value = null;
      await voice({
        transcript: 'summarize this',
        context: { surface: 'doc', docId: otherDocId },
        author: PERSON,
      });
      expect(promptUser()).not.toContain(otherDocId);
      expect(promptUser()).not.toContain('doc=');
      expect(promptUser()).not.toContain('Resource in view:');

      lastPrompt.value = null;
      await voice({
        transcript: 'summarize this',
        context: { surface: 'doc', docId },
        author: PERSON,
      });
      expect(promptUser()).toContain(`doc=${docId}`);
      expect(promptUser()).toContain('Resource in view:');
    });
  });

  describe('the resource in view rides into the prompt', () => {
    it('a task carries title, status, assignee and its links', async () => {
      completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
      lastPrompt.value = null;
      await voice({
        transcript: 'assign this to me',
        context: { surface: 'task', taskId: linkedTaskId },
        author: PERSON,
      });
      const prompt = promptUser();
      expect(prompt).toContain(`Resource in view: task ${linkedTaskId}`);
      expect(prompt).toContain('Fold the expansion plan into the results page');
      expect(prompt).toContain('status: todo');
      expect(prompt).toContain('assignee: Jordan');
      expect(prompt).toContain('needs: action');
      expect(prompt).toContain(`doc ${docId}`);
      expect(prompt).toContain('th-synthetic');
      // Control for the truncation test below: a normal task is not labelled.
      expect(prompt).not.toContain('truncated');
    });

    it('a doc carries its title and the open review items scoped to it', async () => {
      // An open thread whose newest comment is an agent's IS a review item.
      const t = await post(`/api/docs/${docId}/threads`, {
        author: AGENT,
        text: 'Jordan, should the rollout wait for the crawler benchmark?',
        anchor: ANCHOR,
      });
      expect(t.status).toBe(200);

      completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
      lastPrompt.value = null;
      await voice({
        transcript: 'reply to that review comment',
        context: { surface: 'doc', docId },
        author: PERSON,
      });
      const prompt = promptUser();
      expect(prompt).toContain(`Resource in view: doc ${docId}`);
      expect(prompt).toContain('crawler benchmark');
    });

    it('over-budget resource content is truncated and SAYS it was', async () => {
      completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
      lastPrompt.value = null;
      const r = await post(`/api/workspaces/${otherHubId}/voice`, {
        transcript: 'mark this done',
        context: { surface: 'task', taskId: bigTaskId },
        author: PERSON,
      });
      expect(r.status).toBe(200);
      const prompt = promptUser();
      const start = prompt.indexOf('Resource in view:');
      expect(start).toBeGreaterThanOrEqual(0);
      const block = prompt.slice(start, prompt.indexOf('\nUtterance:', start));
      expect(block).toContain('truncated');
      // The budget is the point: the block cannot grow with the content.
      expect(new TextEncoder().encode(block).length).toBeLessThanOrEqual(RESOURCE_MAX + 200);
    });
  });

  // A third classification. The guardrails ship BEFORE the writers do, so the
  // rule that decides whether a spoken action may touch anything is reviewable
  // on its own — and provably fails closed. Nothing here writes: an action
  // still takes the agent route until the executors land.
  describe('resolveVoiceAction — a target only ever comes from the validated context', () => {
    const PERSON_ACTOR = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
    const TASK_CONTEXT: VoiceContext = { surface: 'task', taskId: 't-fixture' };
    const taskResource = (over: Partial<Extract<VoiceResource, { kind: 'task' }>> = {}) =>
      ({
        kind: 'task',
        id: 't-fixture',
        title: 'Wire the results page',
        status: 'todo',
        assignee: '',
        links: [],
        ...over,
      }) satisfies VoiceResource;

    const resolve = (
      raw: string,
      over: {
        actor?: { id: string; name: string; kind?: string };
        context?: VoiceContext;
        resource?: VoiceResource;
        transcript?: string;
      } = {},
    ) =>
      resolveVoiceAction({
        classification: parseVoiceReply(raw),
        actor: over.actor ?? PERSON_ACTOR,
        transcript: over.transcript ?? 'mark this done',
        ...(over.context !== undefined ? { context: over.context } : { context: TASK_CONTEXT }),
        ...(over.resource !== undefined
          ? { resource: over.resource }
          : { resource: taskResource() }),
      });

    const MARK_DONE = '{"kind":"action","action":"set-status","status":"done"}';

    it('POSITIVE CONTROL: a well-formed action over a validated task resolves', () => {
      expect(resolve(MARK_DONE)).toEqual({
        action: 'set-status',
        taskId: 't-fixture',
        status: 'done',
        actor: PERSON_ACTOR,
      });
    });

    it('an action verb outside the scoped set never parses, so it never resolves', () => {
      expect(parseVoiceReply('{"kind":"action","action":"delete-the-workspace"}')).toBeNull();
      expect(resolve('{"kind":"action","action":"delete-the-workspace"}')).toBeNull();
      // A status the store has no word for is the same failure.
      expect(resolve('{"kind":"action","action":"set-status","status":"shipped"}')).toBeNull();
      // And a classification that is not an action at all.
      expect(resolve('{"kind":"change"}')).toBeNull();
      expect(resolve('{"kind":"lookup","target":"task","id":"t-fixture"}')).toBeNull();
    });

    it('the deictic "mark this done" from the hub — no id in context — resolves to nothing', () => {
      const noResource = { surface: 'hub' as const };
      expect(
        resolveVoiceAction({
          classification: parseVoiceReply(MARK_DONE),
          actor: PERSON_ACTOR,
          transcript: 'mark this done',
          context: noResource,
        }),
      ).toBeNull();
      // A resource without the matching context id is the same hole from the
      // other side: the resource must be the thing the context named.
      expect(resolve(MARK_DONE, { context: { surface: 'task' } })).toBeNull();
      expect(resolve(MARK_DONE, { context: { surface: 'task', taskId: 't-other' } })).toBeNull();
    });

    it('a model-named id that disagrees with the context is refused', () => {
      expect(
        resolve('{"kind":"action","action":"set-status","status":"done","id":"t-someone-elses"}'),
      ).toBeNull();
      // Naming the id it was told not to name is fine when it is the SAME id —
      // the rule is about acting on a target the speaker never had in view.
      expect(
        resolve('{"kind":"action","action":"set-status","status":"done","id":"t-fixture"}'),
      ).not.toBeNull();
    });

    it('an actor with no declared kind is refused (classifyActor would file it as an agent)', () => {
      expect(resolve(MARK_DONE, { actor: { id: 'known-jordan', name: 'Jordan' } })).toBeNull();
      expect(
        resolve(MARK_DONE, { actor: { id: 'known-jordan', name: 'Jordan', kind: '' } }),
      ).toBeNull();
    });

    it('set-assignee needs a name, and "me" is the speaker', () => {
      expect(resolve('{"kind":"action","action":"set-assignee","assignee":"me"}')).toEqual({
        action: 'set-assignee',
        taskId: 't-fixture',
        assignee: 'Jordan',
        actor: PERSON_ACTOR,
      });
      expect(resolve('{"kind":"action","action":"set-assignee"}')).toBeNull();
    });

    it('a comment carries the transcript verbatim, on the task or the doc in view', () => {
      expect(
        resolve('{"kind":"action","action":"comment"}', { transcript: 'this needs a benchmark' }),
      ).toEqual({
        action: 'comment',
        target: { kind: 'task', taskId: 't-fixture' },
        text: 'this needs a benchmark',
        actor: PERSON_ACTOR,
      });
    });

    it('answer-review resolves the thread from the doc, and refuses when it is ambiguous', () => {
      const docContext: VoiceContext = { surface: 'doc', docId: 'expansion-plan' };
      const withItems = (n: number): VoiceResource => ({
        kind: 'doc',
        id: 'expansion-plan',
        reviewItems: Array.from({ length: n }, (_, i) => ({
          threadId: `th-${i}`,
          ask: 'Should the rollout wait?',
          askedBy: 'Search Agent',
        })),
      });
      expect(
        resolve('{"kind":"action","action":"answer-review"}', {
          context: docContext,
          resource: withItems(1),
          transcript: 'yes, wait for it',
        }),
      ).toEqual({
        action: 'answer-review',
        docId: 'expansion-plan',
        threadId: 'th-0',
        text: 'yes, wait for it',
        actor: PERSON_ACTOR,
      });
      // Nothing open, or more than one open: which one "that comment" means is
      // not knowable from the context, so it is the agent's call.
      for (const n of [0, 2]) {
        expect(
          resolve('{"kind":"action","action":"answer-review"}', {
            context: docContext,
            resource: withItems(n),
          }),
        ).toBeNull();
      }
    });

    it('open-link resolves the sole ref, and refuses to guess between several', () => {
      const one = taskResource({ links: [{ kind: 'doc', docId: 'expansion-plan' }] });
      expect(resolve('{"kind":"action","action":"open-link"}', { resource: one })).toEqual({
        action: 'open-link',
        taskId: 't-fixture',
        ref: { kind: 'doc', docId: 'expansion-plan' },
      });
      const two = taskResource({
        links: [
          { kind: 'doc', docId: 'expansion-plan' },
          { kind: 'url', url: 'https://example.invalid/mockup' },
        ],
      });
      expect(resolve('{"kind":"action","action":"open-link"}', { resource: two })).toBeNull();
      expect(resolve('{"kind":"action","action":"open-link"}')).toBeNull();
    });

    it('the enumerated action shapes reach the model', async () => {
      completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'change' }));
      lastPrompt.value = null;
      await voice({ transcript: 'mark this done', context: { surface: 'hub' }, author: PERSON });
      const system = promptSystem();
      expect(system).toContain('"kind":"action"');
      expect(system).toContain('set-status');
      expect(system).toContain('answer-review');
      // The standing rules survive the addition.
      expect(system).toContain('{"kind":"change"}');
      expect(system.toLowerCase()).toContain('never name an id');
    });

    it('an action classification still takes the agent route, and writes nothing', async () => {
      completeImpl = () =>
        Promise.resolve(JSON.stringify({ kind: 'action', action: 'set-status', status: 'done' }));
      const before = await local(`/api/workspaces/${hubId}/tasks`);
      const beforeTask = (
        (await before.json()) as { tasks: Array<{ id: string; status: string }> }
      ).tasks.find((t) => t.id === taskId);
      expect(beforeTask?.status).toBe('todo');

      const r = await voice({
        transcript: 'mark this done',
        context: { surface: 'task', taskId },
        author: PERSON,
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { route: string; ack: string; navigate?: string };
      expect(['agent', 'agent-queued']).toContain(body.route);
      expect(body.ack).toContain('mark this done');
      expect(body.navigate).toBeUndefined();

      const after = await local(`/api/workspaces/${hubId}/tasks`);
      const afterTask = (
        (await after.json()) as { tasks: Array<{ id: string; status: string }> }
      ).tasks.find((t) => t.id === taskId);
      expect(afterTask?.status).toBe('todo');
    });
  });

  describe('VoiceRouter without a configured fast path', () => {
    it('routes a change honestly and reports unknown workspaces', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'voice-unit-'));
      const store = new TaskStore({ dataDir: dir, debounceMs: 1 });
      const ws = store.createWorkspace('bare', 'Goal.');
      const router = new VoiceRouter({ tasks: store });
      const res = await router.handle(ws.id, {
        transcript: 'regroup everything',
        actor: { id: 'known-jordan', name: 'Jordan' },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.route).toBe('agent-queued');
        expect(res.ack).toContain('regroup everything');
      }
      const missing = await router.handle('nope', {
        transcript: 'hello',
        actor: { id: 'known-jordan', name: 'Jordan' },
      });
      expect(missing.ok).toBe(false);
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('parseVoiceReply', () => {
    it('reads JSON even when wrapped in prose/fences, and rejects non-answers', () => {
      expect(parseVoiceReply('{"kind":"change"}')).toEqual({ kind: 'change' });
      expect(
        parseVoiceReply('Sure!\n```json\n{"kind":"lookup","target":"task","id":"t-1"}\n```'),
      ).toEqual({ kind: 'lookup', target: 'task', id: 't-1' });
      expect(parseVoiceReply('{"kind":"lookup"}')).toEqual({ kind: 'lookup' });
      expect(parseVoiceReply('no json here')).toBeNull();
      expect(parseVoiceReply('{"kind":"weird"}')).toBeNull();
    });
  });

  // The summarizer already falls back to the pre-rename keychain entry
  // (resolveKeyFrom); the voice completer must resolve its key the same way,
  // or a machine holding only the legacy entry has working summaries and a
  // silently dead voice fast path — which is exactly how it shipped.
  describe('haikuVoiceComplete — which keychain service the key comes from', () => {
    const fakeKeychain = (entries: Record<string, string>) => {
      const asked: string[] = [];
      const readKey = (service: string): string => {
        asked.push(service);
        const value = entries[service];
        if (!value) throw new Error(`no entry for ${service}`);
        return value;
      };
      return { asked, readKey };
    };

    it('resolves through the injected reader, new name first', () => {
      const k = fakeKeychain({ [KEYCHAIN_SERVICE]: 'new-key' });
      const complete = haikuVoiceComplete({ readKey: k.readKey });
      expect(complete).not.toBeNull();
      expect(k.asked).toEqual([KEYCHAIN_SERVICE]);
    });

    it('falls back to the legacy service when only the old entry exists', () => {
      const k = fakeKeychain({ [KEYCHAIN_SERVICE_LEGACY]: 'old-key' });
      const complete = haikuVoiceComplete({ readKey: k.readKey });
      expect(complete).not.toBeNull();
      expect(k.asked).toEqual([KEYCHAIN_SERVICE, KEYCHAIN_SERVICE_LEGACY]);
    });

    it('returns null when neither entry exists', () => {
      const k = fakeKeychain({});
      expect(haikuVoiceComplete({ readKey: k.readKey })).toBeNull();
      expect(k.asked).toEqual([KEYCHAIN_SERVICE, KEYCHAIN_SERVICE_LEGACY]);
    });

    it('an explicit apiKey wins and the keychain is never consulted', () => {
      const k = fakeKeychain({ [KEYCHAIN_SERVICE]: 'ignored' });
      expect(haikuVoiceComplete({ apiKey: 'explicit', readKey: k.readKey })).not.toBeNull();
      expect(haikuVoiceComplete({ apiKey: null, readKey: k.readKey })).toBeNull();
      expect(k.asked).toEqual([]);
    });
  });
});
