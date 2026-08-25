/**
 * The Home pane's routes, driven through the real route table over HTTP —
 * the route layer hand-copies body fields and nothing type-checks it, so
 * every parameter is exercised end-to-end and every stored effect is read
 * back with a fresh GET rather than trusted from the POST's response.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The generated-brief cases inject a
 * summarizer with a stub fetch and a literal test key; the no-summarizer
 * cases prove the deterministic brief is what a bare server answers. All
 * fixtures synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.ts';
import { ThreadSummarizer } from '../src/summarize.ts';

const PERSON = { id: 'known-riley', name: 'Riley', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-harbor', name: 'Harbor Agent', kind: 'known', color: '#888888' };

interface HomePayload {
  workspaceId: string;
  lastReadAt: number;
  since: number;
  instructions: string;
  brief: {
    markdown: string;
    generatedAt: number;
    source: 'generated' | 'deterministic';
    coversFrom: number;
  };
  generating: boolean;
}

function makeHarness(summarizer?: ThreadSummarizer) {
  const dataDir = mkdtempSync(join(tmpdir(), 'home-routes-'));
  const handle = createServer({ port: 0, dataDir, ...(summarizer ? { summarizer } : {}) });
  const base = `http://localhost:${handle.port}`;
  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const send = (method: string) => (path: string, body: unknown) =>
    local(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { dataDir, handle, local, post: send('POST'), put: send('PUT') };
}

async function makeWorkspace(h: ReturnType<typeof makeHarness>): Promise<string> {
  const res = await h.post('/api/workspaces', { name: 'Synthetic Board', goal: 'Ship it' });
  const data = (await res.json()) as { workspace: { id: string } };
  return data.workspace.id;
}

describe('home routes — deterministic server (no summarizer)', () => {
  let h: ReturnType<typeof makeHarness>;
  let ws: string;

  beforeAll(async () => {
    h = makeHarness();
    ws = await makeWorkspace(h);
  });
  afterAll(async () => {
    await h.handle.stop();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  const home = async (user = 'Riley'): Promise<HomePayload> => {
    const res = await h.local(`/api/workspaces/${ws}/home?user=${encodeURIComponent(user)}`);
    expect(res.status).toBe(200);
    return (await res.json()) as HomePayload;
  };

  it('GET requires a user and a real workspace', async () => {
    expect((await h.local(`/api/workspaces/${ws}/home`)).status).toBe(400);
    expect((await h.local('/api/workspaces/w-none/home?user=Riley')).status).toBe(404);
  });

  it('a fresh reader gets the deterministic brief with the queue denominator, never generating', async () => {
    const payload = await home();
    expect(payload.lastReadAt).toBe(0);
    expect(payload.brief.source).toBe('deterministic');
    // The card labels the brief with where its CONTENT starts, so the payload
    // has to carry that separately from the reader's window. Uncapped, the two
    // agree — which is the positive control for the capped case below.
    expect(payload.brief.coversFrom).toBe(payload.since);
    expect(payload.generating).toBe(false);
    expect(payload.brief.markdown).toContain('queued for your review');
    expect(payload.instructions).toContain('Under 110 words');
  });

  it('board changes since the marker show up in the brief; the queue counts open decisions', async () => {
    const created = await h.post(`/api/workspaces/${ws}/tasks`, {
      title: 'Rewrite the retry helper',
      author: AGENT,
      assignee: AGENT.name,
    });
    expect(created.status).toBe(200);
    const decision = await h.post(`/api/workspaces/${ws}/tasks`, {
      title: 'Which fallback should the reconciler keep?',
      body: 'Keep the degraded response, or fail loudly? Blocked until answered: the retry PR.',
      author: AGENT,
      assignee: 'human',
      needs: 'decision',
    });
    expect(decision.status).toBe(200);
    const payload = await home();
    expect(payload.brief.markdown).toContain('**Filed:** 2 new tasks');
    expect(payload.brief.markdown).toContain('Rewrite the retry helper');
    // The closing line states presence, never a number (t-0iestDQdJTOZ).
    expect(payload.brief.markdown).toContain('What needs your review is queued below.');
  });

  it('mark caught up moves the marker per PERSON, the brief covers from it, and undo restores', async () => {
    // Jordan marking read must not move Riley's marker.
    const jordan = await h.post(`/api/workspaces/${ws}/home/read`, {
      author: { name: 'Jordan' },
    });
    expect(jordan.status).toBe(200);
    expect((await home()).lastReadAt).toBe(0);

    const marked = await h.post(`/api/workspaces/${ws}/home/read`, { author: PERSON });
    const markedBody = (await marked.json()) as {
      ok: boolean;
      lastReadAt: number;
      previous: number;
    };
    expect(markedBody.ok).toBe(true);
    expect(markedBody.previous).toBe(0);
    expect(markedBody.lastReadAt).toBeGreaterThan(0);

    // Read back with a fresh GET, not from the POST's own response.
    const after = await home();
    expect(after.lastReadAt).toBe(markedBody.lastReadAt);
    expect(after.since).toBe(markedBody.lastReadAt);
    // Everything before the marker is read: the brief goes quiet.
    expect(after.brief.markdown).toContain('Quiet since you last caught up');
    // …but the presence line still renders — a quiet brief with no line
    // would read as an all-clear over a queue with an open item.
    expect(after.brief.markdown).toContain('What needs your review is queued below.');

    // Undo: post the previous value back.
    const undone = await h.post(`/api/workspaces/${ws}/home/read`, {
      author: PERSON,
      at: markedBody.previous,
    });
    expect(undone.status).toBe(200);
    expect((await home()).lastReadAt).toBe(0);
  });

  it('rejects a mark with no author name', async () => {
    expect((await h.post(`/api/workspaces/${ws}/home/read`, {})).status).toBe(400);
  });

  it('instructions persist workspace-wide and come back on GET', async () => {
    const put = await h.put(`/api/workspaces/${ws}/home/instructions`, {
      instructions: 'Be terse. Two lines max.',
      author: PERSON,
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as HomePayload;
    expect(putBody.instructions).toBe('Be terse. Two lines max.');
    // Fresh GET — and a different person sees the same workspace instructions.
    expect((await home('Jordan')).instructions).toBe('Be terse. Two lines max.');
  });

  it('refuses empty instructions — blanking the recipe is not expressible', async () => {
    const put = await h.put(`/api/workspaces/${ws}/home/instructions`, {
      instructions: '   ',
      author: PERSON,
    });
    expect(put.status).toBe(400);
  });

  it('serves the hub shell at /workspaces/:id/home (deep-linkable pane)', async () => {
    const page = await h.local(`/workspaces/${ws}/home`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('hub-root');
    // A missing workspace still 404s crisply on the /home spelling.
    expect((await h.local('/workspaces/w-none/home')).status).toBe(404);
  });

  it('serves the shell on every nav suffix, so a reload or a shared link works', async () => {
    // `navPath` mints all four of these and `setNav` pushes them into history,
    // so a suffix the server does not serve costs nothing until somebody
    // reloads or pastes the URL — at which point the product's own link 404s.
    // Measured that way: /home answered 200 while /tasks, /mine and /activity
    // all 404'd.
    for (const suffix of ['', '/home', '/tasks', '/mine', '/activity']) {
      const page = await h.local(`/workspaces/${ws}${suffix}`);
      expect({ suffix, status: page.status }).toEqual({ suffix, status: 200 });
      expect(await page.text()).toContain('hub-root');
    }
    // Negative control, so the widening is a list and not a catch-all: an
    // unknown suffix must still 404 rather than serving a board for a
    // destination the client cannot route to.
    expect((await h.local(`/workspaces/${ws}/not-a-destination`)).status).toBe(404);
    // …and a real destination on a workspace that does not exist still 404s.
    expect((await h.local('/workspaces/w-none/tasks')).status).toBe(404);
  });
});

/**
 * A blocker is task state, not a review item (commit 6 of this branch took it
 * out of the client's reviewQueue). The brief's closing line is a promise
 * about the LIST rendered under it, so the server's count must agree: a
 * person whose only "item" is their own task other work waits on gets
 * "Nothing is queued", not a pointer at a queue that renders nothing.
 */
describe('home brief queue count — blockers are not review items', () => {
  let h: ReturnType<typeof makeHarness>;
  let ws: string;

  beforeAll(async () => {
    h = makeHarness();
    ws = await makeWorkspace(h);
  });
  afterAll(async () => {
    await h.handle.stop();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  const briefLine = async (): Promise<string> => {
    const res = await h.local(`/api/workspaces/${ws}/home?user=Riley`);
    expect(res.status).toBe(200);
    return ((await res.json()) as HomePayload).brief.markdown;
  };

  it('a person-owned blocker with an open dependent does not count as queued', async () => {
    const blocker = await h.post(`/api/workspaces/${ws}/tasks`, {
      title: 'Ship the export fix',
      author: AGENT,
      assignee: 'human', // reserved word: unconditionally a person
    });
    expect(blocker.status).toBe(200);
    const blockerId = ((await blocker.json()) as { task: { id: string } }).task.id;
    const dependent = await h.post(`/api/workspaces/${ws}/tasks`, {
      title: 'Wire the importer to the fixed export',
      author: AGENT,
      assignee: AGENT.name,
    });
    expect(dependent.status).toBe(200);
    const dependentId = ((await dependent.json()) as { task: { id: string } }).task.id;
    const wired = await h.post(`/api/tasks/${dependentId}/after`, {
      after: [blockerId],
      author: AGENT,
    });
    expect(wired.status).toBe(200);

    const md = await briefLine();
    expect(md).toContain('Nothing is queued for your review right now.');
    expect(md).not.toContain('What needs your review is queued below.');
  });

  it('positive control: a real open decision flips the same line', async () => {
    // Proves the probe can see a queued item at all — without this, the
    // assertion above would also pass on a brief that never counts anything.
    const decision = await h.post(`/api/workspaces/${ws}/tasks`, {
      title: 'Which export format do we keep?',
      body: 'CSV or Parquet? Blocked until answered: the importer wiring.',
      author: AGENT,
      assignee: 'human',
      needs: 'decision',
    });
    expect(decision.status).toBe(200);
    const md = await briefLine();
    expect(md).toContain('What needs your review is queued below.');
  });
});

describe('home routes — generated brief (stub summarizer)', () => {
  let h: ReturnType<typeof makeHarness>;
  let ws: string;
  let calls: string[];

  const REPLY = '**Harbor moved.** The retry rewrite landed; one decision is queued below.';

  beforeAll(async () => {
    calls = [];
    const impl = (async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ content: [{ text: REPLY }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    h = makeHarness(new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl }));
    ws = await makeWorkspace(h);
    await h.post(`/api/workspaces/${ws}/tasks`, {
      title: 'Ship the fuzzy matcher',
      author: AGENT,
      assignee: AGENT.name,
    });
  });
  afterAll(async () => {
    await h.handle.stop();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  const home = async (): Promise<HomePayload> => {
    const res = await h.local(`/api/workspaces/${ws}/home?user=Riley`);
    return (await res.json()) as HomePayload;
  };

  it('first read answers deterministic + generating, then the generated brief lands', async () => {
    const first = await home();
    expect(first.brief.source).toBe('deterministic');
    expect(first.generating).toBe(true);

    // Poll until the stored brief is served (the generation is async).
    let payload = first;
    for (let i = 0; i < 40 && payload.brief.source !== 'generated'; i++) {
      await new Promise((r) => setTimeout(r, 25));
      payload = await home();
    }
    expect(payload.brief.source).toBe('generated');
    expect(payload.brief.markdown).toBe(REPLY);
    expect(payload.generating).toBe(false);

    // The digest that left the machine named the real task AS A DEEP LINK
    // into this workspace (the route is the layer that supplies the id — a
    // unit test over the pure half cannot prove it was wired), carried the
    // instructions — and the burst of polls cost ONE call.
    expect(calls.length).toBe(1);
    const sent = JSON.parse(calls[0] ?? '{}') as {
      system: string;
      messages: [{ content: string }];
    };
    expect(sent.messages[0].content).toContain(
      `[Ship the fuzzy matcher](/workspaces/${encodeURIComponent(ws)}?task=`,
    );
    expect(sent.system).toContain('Under 110 words');
    expect(sent.system).toContain('never fabricate a URL');
    // Nothing was dropped from this window, so the prompt says so plainly and
    // the served brief reports the window's own start.
    expect(sent.messages[0].content).toContain('Covering: everything since ');
    expect(sent.messages[0].content).not.toContain('most recent changes');
    // `coversFrom` is frozen at GENERATION time, while a fresh reader's window
    // slides with the clock — so these are close, not equal, and asserting
    // equality here fails by the tens of milliseconds the polls take.
    expect(payload.brief.coversFrom).toBeGreaterThan(first.since - 60_000);
    expect(payload.brief.coversFrom).toBeLessThanOrEqual(payload.since);
  });

  it('a fresh generated brief is served from the cache without a second call', async () => {
    const before = calls.length;
    const payload = await home();
    expect(payload.brief.source).toBe('generated');
    expect(calls.length).toBe(before);
  });

  it('a board change stales the brief; saving instructions drops every cached brief', async () => {
    const before = calls.length;
    await h.post(`/api/workspaces/${ws}/tasks`, {
      title: 'Prune the device pool',
      author: AGENT,
      assignee: AGENT.name,
    });
    const stale = await home();
    expect(stale.generating).toBe(true);
    let payload = stale;
    for (let i = 0; i < 40 && payload.generating; i++) {
      await new Promise((r) => setTimeout(r, 25));
      payload = await home();
    }
    expect(calls.length).toBe(before + 1);

    // Save & Update Summary: the instructions ride the next prompt.
    const put = await h.put(`/api/workspaces/${ws}/home/instructions`, {
      instructions: 'Only ever write ONE sentence.',
      author: PERSON,
    });
    const putBody = (await put.json()) as HomePayload;
    expect(putBody.generating).toBe(true);
    let regenerated = putBody;
    for (let i = 0; i < 40 && regenerated.generating; i++) {
      await new Promise((r) => setTimeout(r, 25));
      regenerated = (await home()) as HomePayload;
    }
    const last = JSON.parse(calls[calls.length - 1] ?? '{}') as { system: string };
    expect(last.system).toContain('Only ever write ONE sentence.');
  });
});

describe('the queue count matches what Home places — thread rows', () => {
  /**
   * The brief's closing line is `homeQueueTotal`'s only surface (presence /
   * absence — the line never states a number), and that count is a PROMISE
   * about the list Home renders. This suite pins the promise across the
   * 2026-08-21 membership change end-to-end: a status note ships no row and
   * counts nothing; a surviving direct ask and a declared item each ship one
   * row, are placed by the browser, and flip the line; a person's reply
   * drains the direct ask and flips it back. Before the change the count
   * included inferred rows Home never drew — "something needs you" printed
   * over a list that showed nothing.
   */
  let h: ReturnType<typeof makeHarness>;
  let ws: string;
  let taskId: string;

  beforeAll(async () => {
    h = makeHarness();
    ws = await makeWorkspace(h);
    const created = await h.post(`/api/workspaces/${ws}/tasks`, {
      title: 'Sweep the cache dir',
      body: 'Agent can sweep the cache dir so that the disk stops filling up.',
      author: AGENT,
      assignee: AGENT.name,
    });
    expect(created.status).toBe(200);
    taskId = ((await created.json()) as { task: { id: string } }).task.id;
  });
  afterAll(async () => {
    await h.handle.stop();
    rmSync(h.dataDir, { recursive: true, force: true });
  });

  const briefLine = async (): Promise<string> => {
    const res = await h.local(`/api/workspaces/${ws}/home?user=Riley`);
    expect(res.status).toBe(200);
    return ((await res.json()) as HomePayload).brief.markdown;
  };
  const rows = async (): Promise<Array<Record<string, unknown>>> => {
    const res = await h.local(`/api/workspaces/${ws}/review-items`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: Array<Record<string, unknown>> }).items;
  };

  it('counts a status note as nothing, because Home draws nothing for it', async () => {
    const opened = await h.post(`/api/docs/task:${taskId}/threads`, {
      anchor: { kind: 'subject' },
      text: 'Started on the sweep; nothing needs a look yet.',
      author: AGENT,
    });
    expect(opened.status).toBe(200);
    // The route ships no row for it, so the count agrees with the empty list.
    expect(await rows()).toEqual([]);
    expect(await briefLine()).toContain('Nothing is queued for your review right now.');
  });

  it('counts a surviving direct ask, and stops when a person answers it', async () => {
    // A person speaks first — that seeds the roster of addressable names the
    // ask detector reads — then the agent asks them by name.
    const opened = await h.post(`/api/docs/task:${taskId}/threads`, {
      anchor: { kind: 'subject' },
      text: 'How is the sweep going?',
      author: PERSON,
    });
    expect(opened.status).toBe(200);
    const threadId = ((await opened.json()) as { thread: { id: string } }).thread.id;
    const asked = await h.post(`/api/docs/task:${taskId}/threads/${threadId}/comments`, {
      text: 'Riley — should the sweep also purge the staging dir?',
      author: AGENT,
    });
    expect(asked.status).toBe(200);

    const shipped = await rows();
    expect(shipped).toHaveLength(1);
    expect(shipped[0]).toMatchObject({ kind: 'task-thread', band: 'unreplied', direct: true });
    expect(await briefLine()).toContain('What needs your review is queued below.');

    // The person's reply ends the unanswered run — no resolve, no flag.
    const answered = await h.post(`/api/docs/task:${taskId}/threads/${threadId}/comments`, {
      text: 'Yes, purge it too.',
      author: PERSON,
    });
    expect(answered.status).toBe(200);
    expect(await rows()).toEqual([]);
    expect(await briefLine()).toContain('Nothing is queued for your review right now.');
  });

  it('counts a declared item until it is resolved', async () => {
    const declared = await h.post(`/api/docs/task:${taskId}/threads`, {
      anchor: { kind: 'subject' },
      text: 'The sweep schedule needs a call before this merges.',
      author: AGENT,
      review: {
        shape: 'review',
        headline: 'Pick the sweep schedule',
      },
    });
    expect(declared.status).toBe(200);
    const threadId = ((await declared.json()) as { thread: { id: string } }).thread.id;

    const shipped = await rows();
    expect(shipped).toHaveLength(1);
    expect(shipped[0]).toMatchObject({ kind: 'task-thread', band: 'declared' });
    expect(await briefLine()).toContain('What needs your review is queued below.');

    const resolved = await h.post(`/api/docs/task:${taskId}/threads/${threadId}/resolve`, {
      author: PERSON,
    });
    expect(resolved.status).toBe(200);
    expect(await rows()).toEqual([]);
    expect(await briefLine()).toContain('Nothing is queued for your review right now.');
  });
});
