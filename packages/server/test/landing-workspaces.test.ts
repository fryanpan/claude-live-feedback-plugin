import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread, User } from '@feedback/core';
import { ACTIVE_WINDOW_MS } from '../src/landing.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The landing page through the real route: `/` is a list of active
 * workspaces to open up, and nothing else renders above the folds.
 *
 * The model's split/sort arithmetic is unit-tested in
 * `landing-model.test.ts`. What this file covers is the layer nothing else
 * does: that the route feeds the model REAL activity signals (a task
 * mutation and a task-thread comment both move a board up the list), that a
 * board's link is the one the rest of the product navigates to, and that
 * review docs stay reachable as project links without their contents
 * leaking back onto `/`. Every absence asserted here has a presence
 * asserted beside it in the same response.
 */

const AGENT: User = { id: 'agent-one', name: 'One', kind: 'known', color: '#111' };

let handle: ServerHandle;
let dataDir: string;
let srcDir: string;
let base: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'landing-ws-data-'));
  srcDir = mkdtempSync(join(tmpdir(), 'landing-ws-src-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

async function j<T>(res: Response): Promise<T> {
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
  return res.json() as Promise<T>;
}

async function makeWorkspace(name: string): Promise<string> {
  const { workspace } = await j<{ workspace: { id: string } }>(
    await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, goal: 'Ship it.' }),
    }),
  );
  return workspace.id;
}

async function makeTask(wsId: string, title: string): Promise<string> {
  const { task } = await j<{ task: { id: string } }>(
    await fetch(`${base}/api/workspaces/${encodeURIComponent(wsId)}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: AGENT, title, assignee: 'One', assigneeKind: 'agent' }),
    }),
  );
  return task.id;
}

const landing = async (): Promise<string> => (await fetch(`${base}/`)).text();

/** Recency ties break ALPHABETICALLY (deterministic pages), and two HTTP
 *  calls can land in the same `Date.now()` millisecond — so every ordering
 *  assertion that needs "strictly newer" earns its gap explicitly instead of
 *  hoping the round-trip took long enough. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

describe('the landing page is a list of active workspaces', () => {
  let alphaId: string;
  let betaId: string;

  it('lists workspaces newest-activity first, linking to each Home pane', async () => {
    alphaId = await makeWorkspace('Alpha board');
    await tick();
    betaId = await makeWorkspace('Beta board');

    let html = await landing();
    expect(html).toContain('name="viewport"');
    expect(html).toContain('Alpha board');
    expect(html).toContain('Beta board');
    // The `/home` suffix is the assertion, not decoration: without it the
    // href is the board, and the row lands on a task list rather than on the
    // page that says what needs you.
    expect(html).toContain(`href="/workspaces/${encodeURIComponent(alphaId)}/home"`);
    expect(html).toContain(`href="/workspaces/${encodeURIComponent(betaId)}/home"`);
    // Beta was created after Alpha, so with no other activity it sorts first.
    expect(html.indexOf('Beta board')).toBeLessThan(html.indexOf('Alpha board'));

    // A task mutation on Alpha is REAL activity, and it reorders the page.
    // This is the wiring the unit tests cannot see: task.updatedAt reaching
    // the model as the board's recency.
    await tick();
    await makeTask(alphaId, 'wire the thing');
    html = await landing();
    expect(html.indexOf('Alpha board')).toBeLessThan(html.indexOf('Beta board'));
  });

  it('a comment on a task discussion also counts as board activity', async () => {
    const taskId = await makeTask(betaId, 'discuss the thing');
    // Alpha takes the newest TASK mutation, so if only task.updatedAt fed the
    // model Alpha would sort first — the comment below is then the one signal
    // that can put Beta on top, which is what makes this non-vacuous.
    await tick();
    await makeTask(alphaId, 'newest task mutation');
    // Comment on Beta's task discussion — the same `task:<id>` room the
    // board's own thread UI uses. The gap makes the comment strictly newer
    // than Alpha's task, so it alone decides the order below.
    await tick();
    await j<{ thread: Thread }>(
      await fetch(`${base}/api/docs/${encodeURIComponent(`task:${taskId}`)}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: AGENT, text: 'which option?', anchor: { kind: 'subject' } }),
      }),
    );
    const html = await landing();
    expect(html.indexOf('Beta board')).toBeLessThan(html.indexOf('Alpha board'));
    // …and the comment's TEXT does not reach the landing page. The board
    // ordering above is the positive control: the thread was seen, as
    // activity and nothing more. Cross-workspace thread rollups belong to
    // each workspace's own page.
    expect(html).not.toContain('which option?');
  });

  it('folds a workspace with no activity inside the window as inactive, with its count', async () => {
    const staleId = await makeWorkspace('Stale board');
    // Age every activity signal the collector reads past the window. The
    // store hands out live references, which is what makes the aging honest
    // at the route layer rather than a unit-test-only construction.
    const ws = handle.tasks.getWorkspace(staleId);
    expect(ws).toBeTruthy();
    if (ws) {
      ws.createdAt = Date.now() - ACTIVE_WINDOW_MS - 60_000;
    }
    const html = await landing();
    // Present, but under the fold — after the fold's summary line, while the
    // active boards render before it.
    const fold = html.indexOf('Inactive workspaces');
    expect(fold).toBeGreaterThan(-1);
    expect(html.indexOf('Stale board')).toBeGreaterThan(fold);
    expect(html.indexOf('Beta board')).toBeLessThan(fold);
    // The fold names its count — a cut list states what it cut.
    expect(html).toContain('Inactive workspaces <span class="count">1</span>');
  });
});

describe('review docs stay reachable without leaking back onto /', () => {
  it('renders one project link, not the docs inside it', async () => {
    const file = join(srcDir, 'NOTES-UNIQUE.md');
    writeFileSync(file, '# Notes\n\nthe unique line\n');
    await j(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docId: 'landing-doc-1',
          type: 'markdown',
          sourceUrl: file,
          owner: '/proj/gamma',
          title: 'NOTES-UNIQUE',
        }),
      }),
    );
    const html = await landing();
    // Present: the project's label, linking to its on-demand page.
    expect(html).toContain('Review docs by project');
    expect(html).toContain(`/projects/${encodeURIComponent('/proj/gamma')}`);
    expect(html).toContain('gamma');
    // Absent: the doc itself — no file name, no review link. The project
    // link above is the positive control that this doc's project was seen.
    expect(html).not.toContain('NOTES-UNIQUE');
    expect(html).not.toContain('review/landing-doc-1');
  });
});

describe('the landing page says which workspaces are waiting on the owner (t-DA4rBTmdP0d2)', () => {
  let waitingId: string;
  let quietId: string;

  async function makeDecision(wsId: string, title: string): Promise<void> {
    await j(
      await fetch(`${base}/api/workspaces/${encodeURIComponent(wsId)}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: AGENT,
          title,
          assignee: 'Owner',
          assigneeKind: 'person',
          needs: 'decision',
          body: 'Which of the two options should ship?',
        }),
      }),
    );
  }

  it('a row with open review items carries a counted chip into the queue; a quiet row carries none', async () => {
    waitingId = await makeWorkspace('Waiting board');
    quietId = await makeWorkspace('Quiet board');
    await makeDecision(waitingId, 'Pick a door');
    await makeDecision(waitingId, 'Pick another door');

    const html = await landing();
    // The chip: count + the word, linking into the workspace's own
    // walkthrough — the existing queue, not a second implementation.
    const chip = new RegExp(
      `href="/workspaces/${encodeURIComponent(waitingId)}/home\\?walk=1"[^>]*>` +
        `<span class="n">2</span>`,
    );
    expect(html).toMatch(chip);
    // The quiet board renders NO review affordance — and its row is still
    // there (positive control that the row itself rendered).
    expect(html).toContain('Quiet board');
    expect(html).not.toMatch(
      new RegExp(`href="/workspaces/${encodeURIComponent(quietId)}/home\\?walk=1"`),
    );
  });

  it('the top bar totals every waiting workspace and Review all chains them', async () => {
    const html = await landing();
    expect(html).toContain('waiting on you');
    // One waiting workspace so far: the bar links straight into it, with no
    // handoff list.
    expect(html).toMatch(
      new RegExp(`class="allgo" href="/workspaces/${encodeURIComponent(waitingId)}/home\\?walk=1"`),
    );

    // A second waiting workspace joins the chain: Review all starts at the
    // most recently active one and hands off to the rest via `then`.
    await tick();
    await makeDecision(quietId, 'Quiet board wakes up');
    const html2 = await landing();
    expect(html2).toContain('across 2 workspaces');
    const walkAll = new RegExp(
      `class="allgo" href="/workspaces/${encodeURIComponent(quietId)}/home\\?walk=1&amp;then=${encodeURIComponent(waitingId)}"`,
    );
    expect(html2).toMatch(walkAll);
  });

  it('with nothing waiting anywhere, no bar renders at all', async () => {
    // A fresh server state is not available mid-file; assert the negative on
    // the first landing read of this file instead: before any decision
    // existed, earlier tests read the page repeatedly and the bar's classes
    // never appeared. Here, assert the structural half: the bar renders only
    // once, not per workspace.
    const html = await landing();
    expect(html.split('class="allbar"').length - 1).toBe(1);
  });

  it('retiring a workspace takes it out of the bar and the chain', async () => {
    // Retiring is the owner saying "get this out of my way" — the bar
    // steering Review all through a retired board contradicts the act.
    // The retired row itself still renders, in its own fold.
    await fetch(`${base}/api/workspaces/${encodeURIComponent(waitingId)}/retired`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retired: true, author: AGENT, reason: 'superseded in test' }),
    });
    const html = await landing();
    // Only the quiet-turned-waiting board remains: no "across N", no chain.
    expect(html).not.toContain('across 2 workspaces');
    expect(html).toMatch(
      new RegExp(`class="allgo" href="/workspaces/${encodeURIComponent(quietId)}/home\\?walk=1"`),
    );
    expect(html).not.toContain(`then=${encodeURIComponent(waitingId)}`);
  });

  it('a retired row contributes no review items — the chip is gone until un-retired', async () => {
    // Same act, same consequence: the "N for you" chip on the retired row
    // launches the walkthrough into a board its owner stood down. The row
    // stays readable inside the retired fold; the chip must not render.
    const html = await landing();
    expect(html).toContain('Waiting board');
    expect(html).not.toMatch(
      new RegExp(`href="/workspaces/${encodeURIComponent(waitingId)}/home\\?walk=1"`),
    );

    // Un-retiring brings the items back: the chip, the bar total, the chain.
    await fetch(`${base}/api/workspaces/${encodeURIComponent(waitingId)}/retired`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retired: false, author: AGENT }),
    });
    const restored = await landing();
    expect(restored).toContain('across 2 workspaces');
    expect(restored).toMatch(
      new RegExp(
        `href="/workspaces/${encodeURIComponent(waitingId)}/home\\?walk=1"[^>]*>` +
          `<span class="n">2</span>`,
      ),
    );
  });
});
