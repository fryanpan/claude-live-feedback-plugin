/**
 * Voice navigation to places that have no TITLE.
 *
 * Observed at the hub (Bryan, 2026-08-29): "can you open up my top goal" and
 * "can you take me to the homepage" both came back "Nothing here matched —
 * sent to the lead agent". The lead agent cannot drive a browser, so a
 * lookup miss on a destination the hub itself owns is a dead end. Two kinds
 * of ask resolve here without any model:
 *
 *  - the hub's own destinations — Home, the board, My tasks, Activity — by a
 *    small explicit phrase table (never a regex that would swallow a task
 *    whose title contains "home");
 *  - a goal by ORDINAL — "my top goal", "the second goal", "the last goal" —
 *    resolved against the workspace's goal priority order; and a goal by
 *    NAME, which used to be absent from the title index altogether.
 *
 * Every fixture phrase is Bryan's own wording or a near paraphrase. Names are
 * synthetic; the repo is public. No live model call: the completer is a seam
 * the test watches, and the deterministic paths must never reach it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { goalOrdinalAsk, hubDestinationAsk, resolveByTitle, spokenKind } from '../src/voice.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

// ── Unit: the deterministic pieces ─────────────────────────────────────────

describe('hubDestinationAsk: the hub’s own destinations, by explicit phrase', () => {
  it('hears Bryan’s two phrasings of Home', () => {
    expect(hubDestinationAsk('can you take me to the homepage')).toBe('home');
    expect(hubDestinationAsk('take me to the homepage')).toBe('home');
    expect(hubDestinationAsk('go home')).toBe('home');
    expect(hubDestinationAsk('open home')).toBe('home');
    expect(hubDestinationAsk('Take me to the home page.')).toBe('home');
  });

  it('hears the board, my tasks and activity', () => {
    expect(hubDestinationAsk('show me the board')).toBe('tasks');
    expect(hubDestinationAsk('go to the task board')).toBe('tasks');
    expect(hubDestinationAsk('open my tasks')).toBe('mine');
    expect(hubDestinationAsk('show me the activity pane')).toBe('activity');
  });

  it('a trailing "in <board>" names the workspace, not the destination', () => {
    expect(hubDestinationAsk('take me to the homepage in QB', ['QB'])).toBe('home');
  });

  it('is a table, not a substring: a task with "home" in its name is NOT a destination', () => {
    expect(hubDestinationAsk('open the home page redesign')).toBeNull();
    expect(hubDestinationAsk('open the homepage copy task')).toBeNull();
    expect(hubDestinationAsk('mark the home page done')).toBeNull();
    expect(hubDestinationAsk('brief status')).toBeNull();
    expect(hubDestinationAsk('go home and rest')).toBeNull();
  });
});

describe('goalOrdinalAsk: a goal by its place in the priority order', () => {
  it('"top", "first" and "last" against three goals', () => {
    expect(goalOrdinalAsk('open my top goal', 3)).toBe(0);
    expect(goalOrdinalAsk('can you open up my top goal', 3)).toBe(0);
    expect(goalOrdinalAsk('open the first goal', 3)).toBe(0);
    expect(goalOrdinalAsk('show me the second goal', 3)).toBe(1);
    expect(goalOrdinalAsk('go to the last goal', 3)).toBe(2);
    expect(goalOrdinalAsk('open goal number two', 3)).toBe(1);
  });

  it('an ordinal past the end, a name, or no goals at all is not a hit', () => {
    expect(goalOrdinalAsk('open the fourth goal', 3)).toBeNull();
    expect(goalOrdinalAsk('open my top goal', 0)).toBeNull();
    expect(goalOrdinalAsk('open the sign-in goal', 3)).toBeNull();
    expect(goalOrdinalAsk('open the top task', 3)).toBeNull();
    expect(goalOrdinalAsk('the second one', 3)).toBeNull();
  });
});

describe('resolveByTitle: goals are candidates too', () => {
  it('"goal" is a kind word — "the sign-in goal" is the goal, not the task called Sign-in', () => {
    expect(spokenKind('the sign-in goal')).toBe('goal');
    const r = resolveByTitle('sign-in goal', [
      { id: 't-signin', kind: 'task', title: 'Sign-in button' },
      { id: 'g-signin', kind: 'goal', title: 'Sign-in that just works' },
    ]);
    expect(r.kind).toBe('hit');
    if (r.kind === 'hit') expect(r.match.id).toBe('g-signin');
  });
});

// ── Route: the whole path, no model ────────────────────────────────────────

describe('voice navigation (route)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let hubId: string;
  /** Goal ids in PRIORITY order, as `PUT /goals` returned them. */
  let goalIds: string[] = [];
  let homeTaskId: string;
  /** Per-test classification; null = fast path down. */
  let completeImpl: (() => Promise<string>) | null = null;
  const calls = { n: 0 };

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown, method = 'POST') =>
    local(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const say = async (
    transcript: string,
    workspaceId = hubId,
  ): Promise<{ route: string; ack: string; navigate?: string }> => {
    const r = await post(`/api/workspaces/${workspaceId}/voice`, {
      transcript,
      context: { surface: 'hub' },
      author: PERSON,
    });
    expect(r.status).toBe(200);
    return (await r.json()) as { route: string; ack: string; navigate?: string };
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'voice-nav-'));
    handle = createServer({
      port: 0,
      dataDir,
      voiceComplete: () => {
        calls.n += 1;
        if (!completeImpl) return Promise.reject(new Error('fast path down'));
        return completeImpl();
      },
    });
    base = `http://localhost:${handle.port}`;

    const ws = await post('/api/workspaces', { name: 'QB', goal: 'Ship onboarding.' });
    expect(ws.status).toBe(200);
    hubId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    const goals = await post(
      `/api/workspaces/${hubId}/goals`,
      {
        author: PERSON,
        goals: [
          { title: 'Sign-in that just works' },
          { title: 'Ship the activity pane' },
          { title: 'Retire the old widget' },
        ],
      },
      'PUT',
    );
    expect(goals.status).toBe(200);
    goalIds = (handle.tasks.getWorkspace(hubId)?.goals ?? []).map((g) => g.id);
    expect(goalIds).toHaveLength(3);

    // The swallow control: a TASK whose title contains "home page".
    const t = await post(`/api/workspaces/${hubId}/tasks`, {
      title: 'Home page redesign',
      author: PERSON,
    });
    expect(t.status).toBe(200);
    homeTaskId = ((await t.json()) as { task: { id: string } }).task.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('"take me to the homepage" opens the workspace Home, and no model was asked', async () => {
    calls.n = 0;
    const body = await say('can you take me to the homepage');
    expect(body.route).toBe('fast-path');
    expect(body.navigate).toBe(`/workspaces/${hubId}/home`);
    expect(body.ack).toContain('Home');
    expect(calls.n).toBe(0);
  });

  it('"go home" and "open home" are the same ask', async () => {
    expect((await say('go home')).navigate).toBe(`/workspaces/${hubId}/home`);
    expect((await say('open home')).navigate).toBe(`/workspaces/${hubId}/home`);
  });

  it('"show me the board" opens the board — the bare workspace path', async () => {
    calls.n = 0;
    const body = await say('show me the board');
    expect(body.route).toBe('fast-path');
    expect(body.navigate).toBe(`/workspaces/${hubId}`);
    expect(body.ack.toLowerCase()).toContain('board');
    expect(calls.n).toBe(0);
  });

  it('"open my tasks" and "show me the activity pane" reach the other two destinations', async () => {
    expect((await say('open my tasks')).navigate).toBe(`/workspaces/${hubId}/mine`);
    expect((await say('show me the activity pane')).navigate).toBe(`/workspaces/${hubId}/activity`);
  });

  it('"open my top goal" opens the highest-priority goal’s detail, naming it', async () => {
    calls.n = 0;
    const body = await say('can you open up my top goal');
    expect(body.route).toBe('fast-path');
    expect(body.navigate).toBe(`/workspaces/${hubId}?goal=${goalIds[0]}`);
    expect(body.ack).toContain('Sign-in that just works');
    expect(calls.n).toBe(0);
    expect((await say('open the first goal')).navigate).toBe(
      `/workspaces/${hubId}?goal=${goalIds[0]}`,
    );
  });

  it('"the second goal" is index 1; "the last goal" is the bottom of the order', async () => {
    expect((await say('show me the second goal')).navigate).toBe(
      `/workspaces/${hubId}?goal=${goalIds[1]}`,
    );
    expect((await say('go to the last goal')).navigate).toBe(
      `/workspaces/${hubId}?goal=${goalIds[2]}`,
    );
  });

  it('POSITIVE CONTROL: a goal by NAME still resolves by name', async () => {
    calls.n = 0;
    const body = await say('open the sign-in goal');
    expect(body.route).toBe('fast-path');
    expect(body.navigate).toBe(`/workspaces/${hubId}?goal=${goalIds[0]}`);
    expect(body.ack).toContain('Sign-in that just works');
    expect(calls.n).toBe(0);
  });

  it('a task with "home page" in its title is still the TASK, not Home', async () => {
    calls.n = 0;
    const body = await say('open the home page redesign');
    expect(body.navigate).toBe(`/workspaces/${hubId}?task=${homeTaskId}`);
    expect(calls.n).toBe(0);
  });

  it('NEGATIVE CONTROL: a workspace with no goals takes the existing miss path, unchanged', async () => {
    const bare = handle.tasks.createWorkspace('bare');
    calls.n = 0;
    completeImpl = () => Promise.resolve(JSON.stringify({ kind: 'lookup' }));
    const body = await say('open my top goal', bare.id);
    expect(body.navigate).toBeUndefined();
    expect(body.ack).toContain('Nothing here matched');
    // It reached the model, exactly as a miss did before.
    expect(calls.n).toBe(1);
    // Home is still a place on an empty board.
    expect((await say('take me to the homepage', bare.id)).navigate).toBe(
      `/workspaces/${bare.id}/home`,
    );
  });
});
