/**
 * The Board's two quick actions, server side.
 *
 * A huddle is a live conversation over a doc, before there is a task. The
 * Board starts one with a single call and gets back a doc it can open at
 * once: a workspace-tied markdown doc, titled by the clock, empty (or headed
 * by the topic when one was given), filed on the board exactly like every
 * other board doc — so `list_docs` and the board's docs list see it with no
 * new verb — and MARKED as a huddle, so the board can dress it as one.
 *
 * The other action files an EMPTY task: a person taps "New task" and types
 * straight into the title. The store refuses a blank title at every door, so
 * the route takes an explicit `untitled: true` instead, stores the
 * placeholder title, and flags the row so the board can draw it as empty —
 * and the flag clears the moment somebody names the row.
 *
 * Both routes hold the sibling posture: local host only; a share visitor's
 * cookie reaches the board page and is refused here.
 *
 * All fixtures synthetic; no port is bound (port: 0). The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { UNTITLED_TASK_TITLE } from '../src/tasks.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
/**
 * The doc's KIND, then the clock to the minute in local time — "Meeting notes
 * 2026-08-29 14:05" / "Plan 2026-08-29 14:05". The word is what a person
 * reads, so the two kinds are asserted apart: a plan titled "Meeting notes"
 * is the bug this pair exists to catch.
 */
const MEETING_TITLE = /^Meeting notes \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const PLAN_TITLE = /^Plan \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

interface HuddleResponse {
  docId: string;
  url: string;
  reviewUrl?: string;
  hubWorkspaceId: string;
  meta: {
    docId: string;
    title?: string;
    type?: string;
    huddle?: boolean;
    huddleKind?: 'plan' | 'discussion';
  };
}

interface DocRow {
  docId: string;
  title?: string;
  huddle?: boolean;
  reviewUrl?: string;
}

interface TaskRow {
  id: string;
  title: string;
  untitled?: boolean;
  status: string;
  assignee: string;
}

describe('POST /workspaces/:id/huddles and the empty task', () => {
  let handle: ServerHandle;
  let access: AccessHarness;
  let dataDir: string;
  let base: string;
  let workspaceId: string;

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
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const boardDocs = async (ws: string): Promise<DocRow[]> =>
    (await jj<{ docs: DocRow[] }>(await local(`/workspaces/${ws}/docs`))).docs;
  const startHuddle = (ws: string, body: unknown = {}) => post(`/workspaces/${ws}/huddles`, body);
  const newBoard = async (name: string): Promise<string> =>
    (await jj<{ workspace: { id: string } }>(await post('/workspaces', { name }))).workspace.id;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'huddle-routes-'));
    access = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
    });
    base = `http://localhost:${handle.port}`;
    workspaceId = await newBoard('huddle-board');
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('starting a huddle', () => {
    it('creates an empty, clock-titled doc on the board, flagged as a huddle', async () => {
      const r = await jj<HuddleResponse>(await startHuddle(workspaceId));
      expect(r.docId).toMatch(/^d-[A-Za-z0-9_-]{12}$/);
      expect(r.hubWorkspaceId).toBe(workspaceId);
      // Where the Board opens it: the SPA doc route under this board.
      expect(r.url).toBe(`/workspaces/${workspaceId}/docs/${r.docId}`);
      expect(r.meta.type).toBe('markdown');
      expect(r.meta.title).toMatch(MEETING_TITLE);
      expect(r.meta.huddle).toBe(true);

      // Genuinely empty: no seeded blocks, nothing on disk to be read back.
      const doc = await jj<{ blocks: unknown[]; plainText: string }>(
        await local(`/workspaces/${workspaceId}/docs/${r.docId}/content`),
      );
      expect(doc.blocks).toHaveLength(0);
      expect(doc.plainText.trim()).toBe('');
    });

    it('started for a task, links the doc onto that task — and refuses a task from elsewhere', async () => {
      const ws = await newBoard('for-a-task');
      const owner = await jj<{ task: TaskRow & { links?: unknown[] } }>(
        await post(`/workspaces/${ws}/tasks`, { title: 'Plan the strip', author: PERSON }),
      );
      const r = await jj<HuddleResponse & { taskId?: string }>(
        await startHuddle(ws, { kind: 'discussion', taskId: owner.task.id }),
      );
      expect(r.taskId).toBe(owner.task.id);
      const row = (
        await jj<{ tasks: Array<TaskRow & { links?: unknown[] }> }>(
          await local(`/workspaces/${ws}/tasks?format=json`),
        )
      ).tasks.find((t) => t.id === owner.task.id);
      expect(row?.links).toEqual([{ kind: 'doc', docId: r.docId }]);

      // A task on another board is not this board's to huddle for, and a
      // malformed id is refused before any doc is minted: the board's doc
      // list is unchanged by either.
      const before = (await boardDocs(ws)).length;
      const stranger = await jj<{ task: TaskRow }>(
        await post(`/workspaces/${workspaceId}/tasks`, { title: 'Elsewhere', author: PERSON }),
      );
      expect((await startHuddle(ws, { taskId: stranger.task.id })).status).toBe(404);
      expect((await startHuddle(ws, { taskId: 42 })).status).toBe(400);
      expect((await boardDocs(ws)).length).toBe(before);
    });

    it('is listed among the board docs with the flag — and an ordinary doc is not flagged', async () => {
      const ws = await newBoard('listing-board');
      // Positive control on the LISTING: an ordinary doc filed the usual way
      // lands in the same list with no huddle mark, so a `huddle: true`
      // below is a fact about the huddle and not about the route.
      const plainPath = join(dataDir, 'plain.md');
      writeFileSync(plainPath, '# Plain\n\nBody.\n');
      const plain = await jj<{ docId: string }>(
        await post(`/workspaces/${ws}/docs`, {
          docId: 'plain-doc',
          type: 'markdown',
          sourceUrl: plainPath,
        }),
      );
      const huddle = await jj<HuddleResponse>(await startHuddle(ws));

      const docs = await boardDocs(ws);
      const plainRow = docs.find((d) => d.docId === plain.docId);
      const huddleRow = docs.find((d) => d.docId === huddle.docId);
      expect(plainRow).toBeDefined();
      expect(plainRow?.huddle).toBeUndefined();
      expect(huddleRow).toBeDefined();
      expect(huddleRow?.huddle).toBe(true);
      expect(huddleRow?.title).toMatch(MEETING_TITLE);
      // And it is NOT on any other board.
      expect((await boardDocs(workspaceId)).some((d) => d.docId === huddle.docId)).toBe(false);
    });

    it('puts the topic as the first heading when one is given', async () => {
      const r = await jj<HuddleResponse>(
        await startHuddle(workspaceId, { topic: '  Onboarding flow  ' }),
      );
      const doc = await jj<{
        blocks: Array<{ type: string | null; headingLevel?: number; text: string }>;
      }>(await local(`/workspaces/${workspaceId}/docs/${r.docId}/content`));
      expect(doc.blocks.length).toBeGreaterThan(0);
      expect(doc.blocks[0]?.type).toBe('heading');
      expect(doc.blocks[0]?.headingLevel).toBe(1);
      // Block text is rendered markdown, so the heading keeps its marker.
      expect(doc.blocks[0]?.text).toBe('# Onboarding flow');
      // The title is still the clock — the topic is content, not a name.
      expect(r.meta.title).toMatch(MEETING_TITLE);
    });

    it('kind "plan" stamps huddleKind and seeds the Goal heading', async () => {
      // The Board's "Make a plan": the doc opens goal-shaped, so the person
      // types (or says) the problem under a heading that names what the doc
      // is for. The kind lands in CRDT meta so the editor can dress the doc
      // — placeholder copy, the Make Plan float — without a second fetch.
      const r = await jj<HuddleResponse>(await startHuddle(workspaceId, { kind: 'plan' }));
      expect(r.meta.huddleKind).toBe('plan');
      expect(r.meta.huddle).toBe(true);
      expect(r.meta.title).toMatch(PLAN_TITLE);
      const doc = await jj<{
        blocks: Array<{ type: string | null; headingLevel?: number; text: string }>;
      }>(await local(`/workspaces/${workspaceId}/docs/${r.docId}/content`));
      expect(doc.blocks[0]?.type).toBe('heading');
      expect(doc.blocks[0]?.headingLevel).toBe(1);
      expect(doc.blocks[0]?.text).toBe('# Goal');
      const file = join(dataDir, 'huddles', `${r.docId}.md`);
      expect(readFileSync(file, 'utf8')).toBe('# Goal\n');
    });

    it('kind "plan" with a topic keeps the Goal heading and files the topic under it', async () => {
      const r = await jj<HuddleResponse>(
        await startHuddle(workspaceId, { kind: 'plan', topic: 'Zoom notes to board' }),
      );
      const file = join(dataDir, 'huddles', `${r.docId}.md`);
      expect(readFileSync(file, 'utf8')).toBe('# Goal\n\nZoom notes to board\n');
    });

    it('kind "discussion" stamps huddleKind and stays empty like today', async () => {
      const r = await jj<HuddleResponse>(await startHuddle(workspaceId, { kind: 'discussion' }));
      expect(r.meta.huddleKind).toBe('discussion');
      // The other half of the pair above: the same route, the other kind,
      // the other word. "Huddle" is gone from every title the server mints.
      expect(r.meta.title).toMatch(MEETING_TITLE);
      expect(r.meta.title).not.toContain('Huddle');
      const doc = await jj<{ plainText: string }>(
        await local(`/workspaces/${workspaceId}/docs/${r.docId}/content`),
      );
      expect(doc.plainText.trim()).toBe('');
    });

    it('no kind stamps nothing — an old caller gets exactly the old doc', async () => {
      // Back-compat: the shared server's REST routes can be called by a
      // client that cannot be restarted. A missing kind is the old payload.
      const r = await jj<HuddleResponse>(await startHuddle(workspaceId));
      expect(r.meta.huddleKind).toBeUndefined();
    });

    it('400s a kind that is not one of the two', async () => {
      const res = await startHuddle(workspaceId, { kind: 'seance' });
      expect(res.status).toBe(400);
    });

    it('keeps the doc as a file-backed record under the data dir', async () => {
      const r = await jj<HuddleResponse>(await startHuddle(workspaceId, { topic: 'Kept' }));
      const file = join(dataDir, 'huddles', `${r.docId}.md`);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('# Kept\n');
    });

    it('survives a restart with the flag and the title', async () => {
      const r = await jj<HuddleResponse>(await startHuddle(workspaceId));
      await handle.stop();
      handle = createServer({
        port: 0,
        dataDir,
        ...access.serverOptions,
      });
      base = `http://localhost:${handle.port}`;
      const row = (await boardDocs(workspaceId)).find((d) => d.docId === r.docId);
      expect(row?.huddle).toBe(true);
      expect(row?.title).toBe(r.meta.title);
    });

    it('404s an unknown board and 400s a malformed topic', async () => {
      expect((await startHuddle('w-nope')).status).toBe(404);
      expect((await startHuddle(workspaceId, { topic: 42 })).status).toBe(400);
      expect((await startHuddle(workspaceId, { topic: 'x'.repeat(201) })).status).toBe(400);
      // A missing body is the bare button press, and it is fine.
      const bare = await local(`/workspaces/${workspaceId}/huddles`, { method: 'POST' });
      expect(bare.status).toBe(200);
    });
  });

  describe('filing an empty task', () => {
    it('lands as a placeholder-titled todo owned by the caller, flagged untitled', async () => {
      const { task } = await jj<{ task: TaskRow }>(
        await post(`/workspaces/${workspaceId}/tasks`, { untitled: true, author: PERSON }),
      );
      expect(task.title).toBe(UNTITLED_TASK_TITLE);
      expect(task.untitled).toBe(true);
      // A person's row starts where a person-filed row starts today.
      expect(task.status).toBe('todo');
      expect(task.assignee).toBe(PERSON.name);
    });

    it('still refuses a blank title that does not say so', async () => {
      // Negative control for the allowance: the flag is the only door.
      const r = await post(`/workspaces/${workspaceId}/tasks`, { title: '', author: PERSON });
      expect(r.status).toBe(400);
      const r2 = await post(`/workspaces/${workspaceId}/tasks`, { author: PERSON });
      expect(r2.status).toBe(400);
    });

    it('drops the flag once the row is named', async () => {
      const { task } = await jj<{ task: TaskRow }>(
        await post(`/workspaces/${workspaceId}/tasks`, { untitled: true, author: PERSON }),
      );
      const renamed = await jj<{ task: TaskRow }>(
        await post(`/workspaces/${workspaceId}/tasks/${task.id}/title`, {
          title: 'Ship the huddle',
          author: PERSON,
        }),
      );
      expect(renamed.task.title).toBe('Ship the huddle');
      expect(renamed.task.untitled).toBeUndefined();
      // And the projected row the board reads agrees.
      const { tasks } = await jj<{ tasks: TaskRow[] }>(
        await local(`/workspaces/${workspaceId}/tasks?format=json`),
      );
      const row = tasks.find((t) => t.id === task.id);
      expect(row?.untitled).toBeUndefined();
    });

    it('drops the flag when the name given IS the placeholder text', async () => {
      // A person naming the row is the signal, whatever they typed. The
      // stored title of an unnamed row already equals the placeholder, so a
      // rename to that literal used to read as a no-op and keep the flag —
      // and a flagged row's rename box shows blank, so it could never be
      // named again.
      const { task } = await jj<{ task: TaskRow }>(
        await post(`/workspaces/${workspaceId}/tasks`, { untitled: true, author: PERSON }),
      );
      const renamed = await jj<{ task: TaskRow }>(
        await post(`/workspaces/${workspaceId}/tasks/${task.id}/title`, {
          title: UNTITLED_TASK_TITLE,
          author: PERSON,
        }),
      );
      expect(renamed.task.title).toBe(UNTITLED_TASK_TITLE);
      expect(renamed.task.untitled).toBeUndefined();
      const { tasks } = await jj<{ tasks: TaskRow[] }>(
        await local(`/workspaces/${workspaceId}/tasks?format=json`),
      );
      expect(tasks.find((t) => t.id === task.id)?.untitled).toBeUndefined();
    });

    it('a same-text rename of a row that was never untitled sets nothing', async () => {
      // Negative control: the fix must not turn every no-op rename into a
      // write. A named row renamed to its own title stays unchanged and
      // unflagged.
      const { task } = await jj<{ task: TaskRow }>(
        await post(`/workspaces/${workspaceId}/tasks`, { title: 'Plain row', author: PERSON }),
      );
      expect(task.untitled).toBeUndefined();
      const same = await jj<{ task: TaskRow; changed: boolean }>(
        await post(`/workspaces/${workspaceId}/tasks/${task.id}/title`, {
          title: 'Plain row',
          author: PERSON,
        }),
      );
      expect(same.changed).toBe(false);
      expect(same.task.title).toBe('Plain row');
      expect(same.task.untitled).toBeUndefined();
    });
  });

  describe('share members', () => {
    it('starts a huddle on the board, and is told nothing about the machine', async () => {
      const visitor = await mintAccessShare(base, access, workspaceId, { label: 'board share' });
      const visitorHeaders = { ...visitor.headers, 'content-type': 'application/json' };
      // Presence: the cookie DOES reach the board page.
      const page = await fetch(`${base}/workspaces/${workspaceId}?format=json`, {
        headers: visitorHeaders,
      });
      expect(page.status).toBe(200);
      const before = (await boardDocs(workspaceId)).length;
      // "Make a plan" / "Have a meeting" is a member's, since 2026-09-03: a
      // share link means full access to the board, and holding a meeting is
      // one of the things a board is for.
      const huddle = await fetch(`${base}/workspaces/${workspaceId}/huddles`, {
        method: 'POST',
        headers: visitorHeaders,
        body: JSON.stringify({}),
      });
      expect(huddle.status, await huddle.clone().text()).toBe(200);
      const made = (await huddle.json()) as {
        docId: string;
        hubWorkspaceId: string;
        meta: Record<string, unknown>;
      };
      expect(made.hubWorkspaceId).toBe(workspaceId);
      // The doc really landed on the board.
      expect((await boardDocs(workspaceId)).length).toBe(before + 1);
      // A huddle is seeded into a file under the owner's data directory, and
      // this route answers with the doc's own meta — so it is a second door
      // beside `GET /api/docs/<id>`, and it is redacted the same way.
      expect(made.meta.sourceUrl).toBeUndefined();
      expect(made.meta.owner).toBeUndefined();
      expect(made.meta.workspaceRoot).toBeUndefined();
      expect(JSON.stringify(made.meta)).not.toContain(dataDir);

      // Positive control on the same visitor: filing a row still answers, so
      // nothing above passed because the member had stopped working.
      const task = await fetch(`${base}/workspaces/${workspaceId}/tasks`, {
        method: 'POST',
        headers: visitorHeaders,
        body: JSON.stringify({ untitled: true, author: PERSON }),
      });
      expect(task.status, await task.clone().text()).toBe(200);
    });
  });
});
