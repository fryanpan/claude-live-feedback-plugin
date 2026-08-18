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

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-harbor', name: 'Harbor Agent', kind: 'known', color: '#888888' };

interface HomePayload {
  workspaceId: string;
  lastReadAt: number;
  since: number;
  instructions: string;
  brief: { markdown: string; generatedAt: number; source: 'generated' | 'deterministic' };
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

  const home = async (user = 'Bryan'): Promise<HomePayload> => {
    const res = await h.local(`/api/workspaces/${ws}/home?user=${encodeURIComponent(user)}`);
    expect(res.status).toBe(200);
    return (await res.json()) as HomePayload;
  };

  it('GET requires a user and a real workspace', async () => {
    expect((await h.local(`/api/workspaces/${ws}/home`)).status).toBe(400);
    expect((await h.local('/api/workspaces/w-none/home?user=Bryan')).status).toBe(404);
  });

  it('a fresh reader gets the deterministic brief with the queue denominator, never generating', async () => {
    const payload = await home();
    expect(payload.lastReadAt).toBe(0);
    expect(payload.brief.source).toBe('deterministic');
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
    // Jordan marking read must not move Bryan's marker.
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
    const res = await h.local(`/api/workspaces/${ws}/home?user=Bryan`);
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
