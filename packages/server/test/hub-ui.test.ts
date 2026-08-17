/**
 * Routes added for the hub UI (plan §3.12 commit 7):
 *
 *   GET  /workspaces/:id        — the hub page shell (server-rendered, loads /app/hub.js)
 *   POST /api/tasks/:id/title   — in-place task title edit (§3.9)
 *   GET  /api/workspaces/:id/events — the activity view's audit-log read (§3.9)
 *
 * Route-layer lesson applies: every param goes over real HTTP and the stored
 * EFFECT is read back (including the ydoc projection the board renders from).
 * Every absence assertion sits next to a positive control.
 *
 * All fixtures are synthetic — invented names, jordan@partner.example register.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { HUB_FEEDBACK_DOC_ID, type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';
import type { Task } from '../src/tasks.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

describe('hub UI routes (plan §3.12 commit 7)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function seedWorkspace(name = 'search-revamp'): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name, goal: 'Ship search v2.' }),
    );
    return workspace.id;
  }

  async function seedTask(workspaceId: string, title = 'Fix the ranking clause'): Promise<Task> {
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, { assignee: 'human', title }),
    );
    return task;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-hub-ui-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('GET /workspaces/:id (hub page shell)', () => {
    it('serves an HTML shell for a hub workspace, name escaped, hub bundle referenced', async () => {
      const wsId = await seedWorkspace('a<b workspace');
      const res = await fetch(`${base}/workspaces/${wsId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/html');
      const html = await res.text();
      // Positive control: the page is really about this workspace…
      expect(html).toContain('a&lt;b workspace');
      // …and the raw (unescaped) name never reaches the markup.
      expect(html).not.toContain('a<b workspace');
      expect(html).toContain('/app/hub.js');
      // §3.9: the browser tab is a workspace switcher.
      expect(html).toContain('Workspace Hub');
    });

    // Every hub carries the widget, and every hub's widget writes to the SAME
    // doc — feedback on the hub UI is about the product, not about whichever
    // workspace you were standing in, so it must reach one place from all of
    // them. Two workspaces asserted, because "the widget is present" would
    // pass for a per-workspace doc too.
    it('embeds the feedback widget on every hub, pointed at one shared doc', async () => {
      const a = await seedWorkspace('alpha');
      const b = await seedWorkspace('beta');
      const htmlA = await (await fetch(`${base}/workspaces/${a}`)).text();
      const htmlB = await (await fetch(`${base}/workspaces/${b}`)).text();

      for (const html of [htmlA, htmlB]) {
        expect(html).toContain('/widget.esm.js');
        expect(html).toContain('<claude-feedback-widget');
        expect(html).toContain(`doc-id="${HUB_FEEDBACK_DOC_ID}"`);
      }
      // The workspace name rides along as `view` so a thread reads without
      // anyone resolving an id — and it differs per hub, which is the
      // positive control that these two responses aren't the same page.
      expect(htmlA).toContain('view="alpha"');
      expect(htmlB).toContain('view="beta"');
    });

    // Without this attribute the widget keeps its identity under its own `cfw:`
    // prefix — correct on a stranger's page, wrong here, because the hub has
    // already asked this reader their name under the UNPREFIXED key. The
    // observed symptom was a board greeting the reader by the name they gave,
    // while every comment the widget posted from that same page was signed
    // "Anonymous <animal>".
    it('tells the widget to adopt the hub page own identity', async () => {
      const id = await seedWorkspace('gamma');
      const html = await (await fetch(`${base}/workspaces/${id}`)).text();
      // Positive control first: the widget is on this page at all.
      expect(html).toContain('<claude-feedback-widget');
      expect(html).toContain('identity-scope="host"');
    });

    // The doc must be findable by an agent that never opened a hub — a room
    // conjured by the first `/y/<id>` connect has no title and no type.
    it('materializes the shared feedback doc at startup', async () => {
      const res = await fetch(`${base}/api/docs/${HUB_FEEDBACK_DOC_ID}`);
      expect(res.status).toBe(200);
      const meta = (await res.json()) as { meta?: { title?: string } };
      expect(meta.meta?.title ?? '').toContain('Hub feedback');
    });

    // …but it is infrastructure, so it must not sit in the landing index
    // forever as an ungrouped artifact. Absence asserted only after the
    // presence above proves the doc actually exists to be hidden.
    it('keeps the feedback doc out of the landing index', async () => {
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('Live Feedback'); // the real landing page
      expect(html).not.toContain(HUB_FEEDBACK_DOC_ID);
      expect(html).not.toContain('Hub feedback (all workspaces)');
    });

    it('404s (as a page, not JSON) for an unknown workspace id', async () => {
      const res = await fetch(`${base}/workspaces/ws-does-not-exist`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type') ?? '').toContain('text/html');
    });
  });

  describe('POST /api/tasks/:id/title', () => {
    it('renames the task; the store AND the board projection both carry the new title', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId, 'Old title');
      const res = await jj<{ ok: boolean; task: Task; changed: boolean }>(
        await post(`/api/tasks/${task.id}/title`, { title: 'New sharper title', author: PERSON }),
      );
      expect(res.changed).toBe(true);
      expect(res.task.title).toBe('New sharper title');

      const { tasks } = await jj<{ tasks: Task[] }>(
        await fetch(`${base}/api/workspaces/${wsId}/tasks`),
      );
      expect(tasks.find((t) => t.id === task.id)?.title).toBe('New sharper title');

      // The board renders from the ws:<id> ydoc projection — assert the
      // rename reached the layer the UI actually reads.
      const room = handle.rooms.get(workspaceRoomId(wsId));
      expect(room).toBeDefined();
      const projected = room?.ydoc.getMap('tasks').get(task.id) as { title?: string } | undefined;
      expect(projected?.title).toBe('New sharper title');
    });

    it('reports changed:false for a same-title rename', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId, 'Stable title');
      const res = await jj<{ changed: boolean }>(
        await post(`/api/tasks/${task.id}/title`, { title: 'Stable title', author: PERSON }),
      );
      expect(res.changed).toBe(false);
    });

    it('400s on a missing/blank title and on a missing author; 404s on an unknown task', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      expect((await post(`/api/tasks/${task.id}/title`, { author: PERSON })).status).toBe(400);
      expect(
        (await post(`/api/tasks/${task.id}/title`, { title: '   ', author: PERSON })).status,
      ).toBe(400);
      expect((await post(`/api/tasks/${task.id}/title`, { title: 'x' })).status).toBe(400);
      expect(
        (await post('/api/tasks/t-missing/title', { title: 'x', author: PERSON })).status,
      ).toBe(404);
      // Positive control: the failed attempts really left the title alone.
      const { tasks } = await jj<{ tasks: Task[] }>(
        await fetch(`${base}/api/workspaces/${wsId}/tasks`),
      );
      expect(tasks.find((t) => t.id === task.id)?.title).toBe('Fix the ranking clause');
    });
  });

  describe('GET /api/workspaces/:id/events (activity view)', () => {
    it('returns the audit rows the store appended, oldest first as written', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId, 'Audited task');
      await jj(
        await post(`/api/tasks/${task.id}/transition`, { to: 'in-progress', author: PERSON }),
      );
      const { events } = await jj<{ events: Array<{ event: string; ts: number }> }>(
        await fetch(`${base}/api/workspaces/${wsId}/events`),
      );
      // Positive control: the probe can see events at all.
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.some((e) => e.event === 'task.created')).toBe(true);
      expect(events.some((e) => e.event === 'task.transitioned')).toBe(true);
      for (const e of events) expect(typeof e.ts).toBe('number');
    });

    it('returns an empty list for a workspace with no audit log yet', async () => {
      const wsId = await seedWorkspace('untouched');
      const { events } = await jj<{ events: unknown[] }>(
        await fetch(`${base}/api/workspaces/${wsId}/events`),
      );
      expect(events).toEqual([]);
    });

    it('404s for an unknown workspace', async () => {
      const res = await fetch(`${base}/api/workspaces/ws-nope/events`);
      expect(res.status).toBe(404);
    });
  });
});
