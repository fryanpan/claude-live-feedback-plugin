/**
 * The done-artifact check: a task marked done whose links promise a checkable
 * artifact gets that promise verified, advisorily, after the transition
 * commits.
 *
 * Three contracts under test:
 *
 *  - Classification: a GitHub PR URL and a doc ref are checkable; every other
 *    ref kind and URL is `not-checkable`, recorded as such and never a
 *    failure.
 *  - Verdicts degrade, never block: a 404 is `missing`, a rate limit or a
 *    network failure is `unverified`, and none of them touches the transition
 *    itself — it has already succeeded by the time the check runs.
 *  - Visibility: only `missing` makes noise (a system comment on the task's
 *    discussion, the park-note pattern); a healthy artifact records
 *    `verified` silently, and a task with no links records nothing at all.
 *
 * All fixtures are synthetic — example-org/example-repo, invented doc ids.
 * The mock fetch never reaches GitHub. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactChecker,
  classifyArtifactLink,
  missingNoteText,
  runArtifactCheck,
} from '../src/artifact-check.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId } from '../src/task-projection.ts';
import { type ArtifactCheck, type Ref, type Task, TaskStore } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const PR_URL = 'https://github.com/example-org/example-repo/pull/1669';

const prRef = (url: string): Ref => ({ kind: 'url', url });
const docRef = (docId: string): Ref => ({ kind: 'doc', docId });

/** A fetch stub keyed by nothing: every call answers with `status` and
 *  `body`. `calls` records the URLs so a test can assert what was asked. */
function fetchStub(status: number, body: unknown): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

/** A fetch that never answers but honors its abort signal — the only way a
 *  timeout test can end. */
const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  })) as typeof fetch;

describe('classifyArtifactLink', () => {
  it('recognizes a GitHub PR URL and extracts owner/repo/number', () => {
    const cls = classifyArtifactLink(prRef(PR_URL));
    expect(cls).toEqual({
      kind: 'github-pr',
      owner: 'example-org',
      repo: 'example-repo',
      number: 1669,
      url: PR_URL,
    });
  });

  it('accepts the URL shapes a pasted PR link actually arrives in', () => {
    for (const url of [
      'http://github.com/example-org/example-repo/pull/7',
      'https://www.github.com/example-org/example-repo/pull/7',
      'https://github.com/example-org/example-repo/pull/7/files',
      'https://github.com/example-org/example-repo/pull/7?diff=split',
      'https://github.com/example-org/example-repo/pull/7#discussion_r1',
    ]) {
      const cls = classifyArtifactLink(prRef(url));
      expect(cls.kind).toBe('github-pr');
      if (cls.kind === 'github-pr') expect(cls.number).toBe(7);
    }
  });

  it('classifies a doc ref as checkable', () => {
    expect(classifyArtifactLink(docRef('launch-plan'))).toEqual({
      kind: 'doc',
      docId: 'launch-plan',
    });
  });

  it('leaves everything else not-checkable — recorded, never a failure', () => {
    const refs: Ref[] = [
      { kind: 'url', url: 'https://github.com/example-org/example-repo/issues/12' },
      { kind: 'url', url: 'https://github.com/example-org/example-repo' },
      { kind: 'url', url: 'https://example.com/a/pull/7' },
      { kind: 'thread', docId: 'launch-plan', threadId: 'th-1' },
      { kind: 'task', taskId: 'other-task' },
      { kind: 'diff', workspaceId: 'some-board' },
    ];
    for (const ref of refs) {
      expect(classifyArtifactLink(ref).kind).toBe('not-checkable');
    }
  });
});

describe('runArtifactCheck', () => {
  const noDocs = () => 'missing' as const;

  it('a live PR records verified with its state, silently', async () => {
    const { impl, calls } = fetchStub(200, { state: 'open', merged_at: null });
    const result = await runArtifactCheck([prRef(PR_URL)], {
      fetchImpl: impl,
      docStatus: noDocs,
    });
    expect(result.links).toEqual([{ ref: prRef(PR_URL), verdict: 'verified', detail: 'open' }]);
    expect(calls).toEqual(['https://api.github.com/repos/example-org/example-repo/pulls/1669']);
  });

  it('a merged PR reads merged, not closed', async () => {
    const { impl } = fetchStub(200, { state: 'closed', merged_at: '2026-08-27T00:00:00Z' });
    const result = await runArtifactCheck([prRef(PR_URL)], {
      fetchImpl: impl,
      docStatus: noDocs,
    });
    expect(result.links[0]?.verdict).toBe('verified');
    expect(result.links[0]?.detail).toBe('merged');
  });

  it('a 404 is missing — the claim the whole feature exists to catch', async () => {
    const { impl } = fetchStub(404, { message: 'Not Found' });
    const result = await runArtifactCheck([prRef(PR_URL)], {
      fetchImpl: impl,
      docStatus: noDocs,
    });
    expect(result.links[0]?.verdict).toBe('missing');
  });

  it('a rate limit is unverified, not missing — absence of proof only', async () => {
    const { impl } = fetchStub(403, { message: 'rate limit exceeded' });
    const result = await runArtifactCheck([prRef(PR_URL)], {
      fetchImpl: impl,
      docStatus: noDocs,
    });
    expect(result.links[0]?.verdict).toBe('unverified');
  });

  it('a network failure is unverified and does not throw', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const result = await runArtifactCheck([prRef(PR_URL)], {
      fetchImpl: failing,
      docStatus: noDocs,
    });
    expect(result.links[0]?.verdict).toBe('unverified');
  });

  it('a hung fetch is cut off by the timeout and reads unverified', async () => {
    const result = await runArtifactCheck([prRef(PR_URL)], {
      fetchImpl: hangingFetch,
      docStatus: noDocs,
      timeoutMs: 20,
    });
    expect(result.links[0]?.verdict).toBe('unverified');
  });

  it('doc refs resolve through the probe: live and archived exist, missing does not', async () => {
    const statuses: Record<string, 'live' | 'archived' | 'missing'> = {
      'launch-plan': 'live',
      'retired-notes': 'archived',
      'never-was': 'missing',
    };
    const result = await runArtifactCheck(
      [docRef('launch-plan'), docRef('retired-notes'), docRef('never-was')],
      { docStatus: (docId) => statuses[docId] ?? 'missing' },
    );
    expect(result.links.map((l) => l.verdict)).toEqual(['verified', 'verified', 'missing']);
  });

  it('a probe that throws degrades to unverified', async () => {
    const result = await runArtifactCheck([docRef('launch-plan')], {
      docStatus: () => {
        throw new Error('store unavailable');
      },
    });
    expect(result.links[0]?.verdict).toBe('unverified');
  });

  it('mixed links each get their own verdict, in link order', async () => {
    const { impl } = fetchStub(200, { state: 'open' });
    const result = await runArtifactCheck(
      [prRef(PR_URL), docRef('never-was'), { kind: 'url', url: 'https://example.com/dashboard' }],
      { fetchImpl: impl, docStatus: () => 'missing' },
    );
    expect(result.links.map((l) => l.verdict)).toEqual(['verified', 'missing', 'not-checkable']);
    expect(result.ts).toBeGreaterThan(0);
  });
});

describe('missingNoteText', () => {
  it('says nothing when nothing is missing', () => {
    const result: ArtifactCheck = {
      ts: Date.now(),
      links: [
        { ref: prRef(PR_URL), verdict: 'verified', detail: 'merged' },
        { ref: { kind: 'url', url: 'https://example.com' }, verdict: 'not-checkable' },
      ],
    };
    expect(missingNoteText(result)).toBeNull();
  });

  it('names each missing artifact and counts the rest', () => {
    const result: ArtifactCheck = {
      ts: Date.now(),
      links: [
        { ref: prRef(PR_URL), verdict: 'missing', detail: 'GitHub answered 404' },
        { ref: docRef('never-was'), verdict: 'missing' },
        { ref: prRef('https://github.com/example-org/example-repo/pull/2'), verdict: 'verified' },
      ],
    };
    const text = missingNoteText(result);
    expect(text).toContain('example-org/example-repo#1669');
    expect(text).toContain('never-was');
    expect(text).toContain('1 verified');
  });
});

describe('ArtifactChecker on a real store', () => {
  let dataDir: string;
  let store: TaskStore;
  let notes: Array<{ taskId: string; text: string }>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'artifact-check-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    notes = [];
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function install(fetchImpl: typeof fetch): ArtifactChecker {
    const checker = new ArtifactChecker({
      getTask: (id) => store.getTask(id),
      record: (id, result) => void store.recordArtifactCheck(id, result),
      docStatus: () => 'missing',
      postMissingNote: async (task, text) => {
        notes.push({ taskId: task.id, text });
      },
      fetchImpl,
    });
    checker.install(store);
    return checker;
  }

  function doneTask(links: Ref[]): Task {
    const ws = store.createWorkspace('launch-board');
    const created = store.createTask(ws.id, { title: 'Land the watcher fix', links });
    if (!created.ok) throw new Error('create failed');
    return created.task;
  }

  it('a done task with a dead PR link gets a missing verdict AND a visible note', async () => {
    const checker = install(fetchStub(404, { message: 'Not Found' }).impl);
    const task = doneTask([prRef(PR_URL)]);
    const moved = store.transition(task.id, 'done', { actor: PERSON });
    expect(moved.ok).toBe(true); // advisory: the transition never blocks
    await checker.settle();
    const after = store.getTask(task.id);
    expect(after?.artifactCheck?.links[0]?.verdict).toBe('missing');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.taskId).toBe(task.id);
    expect(notes[0]?.text).toContain('example-org/example-repo#1669');
  });

  it('a healthy PR records verified and stays silent', async () => {
    const checker = install(fetchStub(200, { state: 'open' }).impl);
    const task = doneTask([prRef(PR_URL)]);
    store.transition(task.id, 'done', { actor: PERSON });
    await checker.settle();
    expect(store.getTask(task.id)?.artifactCheck?.links[0]?.verdict).toBe('verified');
    expect(notes).toHaveLength(0);
  });

  it('a network failure records unverified — no note, no block, no throw', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const checker = install(failing);
    const task = doneTask([prRef(PR_URL)]);
    const moved = store.transition(task.id, 'done', { actor: PERSON });
    expect(moved.ok).toBe(true);
    await checker.settle();
    expect(store.getTask(task.id)?.artifactCheck?.links[0]?.verdict).toBe('unverified');
    expect(notes).toHaveLength(0);
  });

  it('a task with no links records nothing at all — no noise', async () => {
    const checker = install(fetchStub(200, { state: 'open' }).impl);
    const task = doneTask([]);
    store.transition(task.id, 'done', { actor: PERSON });
    await checker.settle();
    expect(store.getTask(task.id)?.artifactCheck).toBeUndefined();
    expect(notes).toHaveLength(0);
  });

  it('only the move to done checks — starting work is not a claim', async () => {
    const { impl, calls } = fetchStub(200, { state: 'open' });
    const checker = install(impl);
    const task = doneTask([prRef(PR_URL)]);
    store.transition(task.id, 'in-progress', { actor: PERSON });
    await checker.settle();
    expect(calls).toHaveLength(0);
    expect(store.getTask(task.id)?.artifactCheck).toBeUndefined();
  });
});

describe('TaskStore.recordArtifactCheck', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'artifact-record-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an unknown task is not-found', () => {
    expect(store.recordArtifactCheck('no-such-task', { ts: 1, links: [] }).ok).toBe(false);
  });

  it('the verdict persists: a rehydrated store still carries it', async () => {
    const ws = store.createWorkspace('launch-board');
    const created = store.createTask(ws.id, {
      title: 'Land the watcher fix',
      links: [prRef(PR_URL)],
    });
    if (!created.ok) throw new Error('create failed');
    const result: ArtifactCheck = {
      ts: Date.now(),
      links: [{ ref: prRef(PR_URL), verdict: 'verified', detail: 'merged' }],
    };
    expect(store.recordArtifactCheck(created.task.id, result).ok).toBe(true);
    // Let the debounced save land before reading the sidecar back.
    await new Promise((r) => setTimeout(r, 60));
    store.stop();
    const rehydrated = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(rehydrated.getTask(created.task.id)?.artifactCheck).toEqual(result);
    } finally {
      rehydrated.stop();
    }
  });
});

describe('server wiring: REST done-transition triggers the check', () => {
  // Route-level proof of the glue in server.ts: the subscription, the store
  // write, and the system comment on the task's body room — with the fetch
  // stubbed through ServerOptions so nothing leaves the process.
  const REST_PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

  async function until<T>(read: () => T | undefined): Promise<T> {
    for (let i = 0; i < 80; i++) {
      const v = read();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('condition never held');
  }

  async function withServer(
    status: number,
    body: unknown,
    fn: (ctx: {
      handle: ServerHandle;
      post: (path: string, payload: unknown) => Promise<Response>;
    }) => Promise<void>,
  ): Promise<void> {
    const dataDir = mkdtempSync(join(tmpdir(), 'artifact-wire-'));
    const { impl } = fetchStub(status, body);
    const handle = createServer({ port: 0, dataDir, artifactCheckFetch: impl });
    const post = (path: string, payload: unknown) =>
      fetch(`http://localhost:${handle.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    try {
      await fn({ handle, post });
    } finally {
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  async function doneTaskOver(
    post: (path: string, payload: unknown) => Promise<Response>,
  ): Promise<string> {
    const ws = await post('/api/workspaces', { name: 'launch-board' });
    const { workspace } = (await ws.json()) as { workspace: { id: string } };
    const created = await post(`/api/workspaces/${workspace.id}/tasks`, {
      author: REST_PERSON,
      title: 'Land the watcher fix',
      links: [{ kind: 'url', url: PR_URL }],
    });
    const { task } = (await created.json()) as { task: { id: string } };
    const moved = await post(`/api/tasks/${task.id}/transition`, {
      to: 'done',
      author: REST_PERSON,
    });
    expect(moved.status).toBe(200);
    return task.id;
  }

  it('a dead PR surfaces as a system comment on the task discussion', async () => {
    await withServer(404, { message: 'Not Found' }, async ({ handle, post }) => {
      const taskId = await doneTaskOver(post);
      const check = await until(() => handle.tasks.getTask(taskId)?.artifactCheck);
      expect(check.links[0]?.verdict).toBe('missing');
      const doc = await until(() => {
        const d = handle.rooms.getDoc(taskBodyDocId(taskId));
        return d && d.threads.length > 0 ? d : undefined;
      });
      const comment = doc.threads[0]?.comments[0];
      expect(comment?.text).toContain('example-org/example-repo#1669');
      expect(comment?.author.name).toBe('Claude Workspaces');
    });
  });

  it('a healthy PR records verified and leaves the discussion empty', async () => {
    await withServer(200, { state: 'open' }, async ({ handle, post }) => {
      const taskId = await doneTaskOver(post);
      const check = await until(() => handle.tasks.getTask(taskId)?.artifactCheck);
      expect(check.links[0]?.verdict).toBe('verified');
      expect(handle.rooms.getDoc(taskBodyDocId(taskId))?.threads ?? []).toHaveLength(0);
    });
  });
});
