/**
 * The Board's two quick actions, server side.
 *
 * A huddle is a live conversation over a doc, before there is a task. The
 * Board starts one with a single call and gets back a doc it can open at
 * once: a workspace-tied markdown doc, titled by the clock, empty (or headed
 * by the topic when one was given), filed on the board exactly like every
 * other board doc — so `list_docs` and the hub's docs list see it with no
 * new verb — and MARKED as a huddle, so the hub can dress it as one.
 *
 * The other action files an EMPTY task: a person taps "New task" and types
 * straight into the title. The store refuses a blank title at every door, so
 * the route takes an explicit `untitled: true` instead, stores the
 * placeholder title, and flags the row so the hub can draw it as empty —
 * and the flag clears the moment somebody names the row.
 *
 * Both routes hold the sibling posture: local host only; a share visitor's
 * cookie reaches the hub page and is refused here.
 *
 * All fixtures synthetic; no port is bound (port: 0). The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';
import { UNTITLED_TASK_TITLE } from '../src/tasks.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const PUBLIC_HOST = 'feedback.example.com';
/** "Huddle 2026-08-29 14:05" — the clock, to the minute, in local time. */
const HUDDLE_TITLE = /^Huddle \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

interface HuddleResponse {
  docId: string;
  url: string;
  reviewUrl?: string;
  hubWorkspaceId: string;
  meta: { docId: string; title?: string; type?: string; huddle?: boolean };
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

describe('POST /api/workspaces/:id/huddles and the empty task', () => {
  let handle: ServerHandle;
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
    (await jj<{ docs: DocRow[] }>(await local(`/api/docs?workspaceId=${ws}`))).docs;
  const startHuddle = (ws: string, body: unknown = {}) =>
    post(`/api/workspaces/${ws}/huddles`, body);
  const newBoard = async (name: string): Promise<string> =>
    (await jj<{ workspace: { id: string } }>(await post('/api/workspaces', { name }))).workspace.id;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'huddle-routes-'));
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
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
      expect(r.meta.title).toMatch(HUDDLE_TITLE);
      expect(r.meta.huddle).toBe(true);

      // Genuinely empty: no seeded blocks, nothing on disk to be read back.
      const doc = await jj<{ blocks: unknown[]; plainText: string }>(
        await local(`/api/docs/${r.docId}/content`),
      );
      expect(doc.blocks).toHaveLength(0);
      expect(doc.plainText.trim()).toBe('');
    });

    it('is listed among the board docs with the flag — and an ordinary doc is not flagged', async () => {
      const ws = await newBoard('listing-board');
      // Positive control on the LISTING: an ordinary doc filed the usual way
      // lands in the same list with no huddle mark, so a `huddle: true`
      // below is a fact about the huddle and not about the route.
      const plainPath = join(dataDir, 'plain.md');
      writeFileSync(plainPath, '# Plain\n\nBody.\n');
      const plain = await jj<{ docId: string }>(
        await post('/api/docs', {
          docId: 'plain-doc',
          type: 'markdown',
          sourceUrl: plainPath,
          hubWorkspaceId: ws,
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
      expect(huddleRow?.title).toMatch(HUDDLE_TITLE);
      // And it is NOT on any other board.
      expect((await boardDocs(workspaceId)).some((d) => d.docId === huddle.docId)).toBe(false);
    });

    it('puts the topic as the first heading when one is given', async () => {
      const r = await jj<HuddleResponse>(
        await startHuddle(workspaceId, { topic: '  Onboarding flow  ' }),
      );
      const doc = await jj<{
        blocks: Array<{ type: string | null; headingLevel?: number; text: string }>;
      }>(await local(`/api/docs/${r.docId}/content`));
      expect(doc.blocks.length).toBeGreaterThan(0);
      expect(doc.blocks[0]?.type).toBe('heading');
      expect(doc.blocks[0]?.headingLevel).toBe(1);
      // Block text is rendered markdown, so the heading keeps its marker.
      expect(doc.blocks[0]?.text).toBe('# Onboarding flow');
      // The title is still the clock — the topic is content, not a name.
      expect(r.meta.title).toMatch(HUDDLE_TITLE);
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
        share: { config: { publicHostname: PUBLIC_HOST } },
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
      const bare = await local(`/api/workspaces/${workspaceId}/huddles`, { method: 'POST' });
      expect(bare.status).toBe(200);
    });
  });

  describe('filing an empty task', () => {
    it('lands as a placeholder-titled todo owned by the caller, flagged untitled', async () => {
      const { task } = await jj<{ task: TaskRow }>(
        await post(`/api/workspaces/${workspaceId}/tasks`, { untitled: true, author: PERSON }),
      );
      expect(task.title).toBe(UNTITLED_TASK_TITLE);
      expect(task.untitled).toBe(true);
      // A person's row starts where a person-filed row starts today.
      expect(task.status).toBe('todo');
      expect(task.assignee).toBe(PERSON.name);
    });

    it('still refuses a blank title that does not say so', async () => {
      // Negative control for the allowance: the flag is the only door.
      const r = await post(`/api/workspaces/${workspaceId}/tasks`, { title: '', author: PERSON });
      expect(r.status).toBe(400);
      const r2 = await post(`/api/workspaces/${workspaceId}/tasks`, { author: PERSON });
      expect(r2.status).toBe(400);
    });

    it('drops the flag once the row is named', async () => {
      const { task } = await jj<{ task: TaskRow }>(
        await post(`/api/workspaces/${workspaceId}/tasks`, { untitled: true, author: PERSON }),
      );
      const renamed = await jj<{ task: TaskRow }>(
        await post(`/api/tasks/${task.id}/title`, { title: 'Ship the huddle', author: PERSON }),
      );
      expect(renamed.task.title).toBe('Ship the huddle');
      expect(renamed.task.untitled).toBeUndefined();
      // And the projected row the board reads agrees.
      const { tasks } = await jj<{ tasks: TaskRow[] }>(
        await local(`/api/workspaces/${workspaceId}/tasks`),
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
        await post(`/api/workspaces/${workspaceId}/tasks`, { untitled: true, author: PERSON }),
      );
      const renamed = await jj<{ task: TaskRow }>(
        await post(`/api/tasks/${task.id}/title`, { title: UNTITLED_TASK_TITLE, author: PERSON }),
      );
      expect(renamed.task.title).toBe(UNTITLED_TASK_TITLE);
      expect(renamed.task.untitled).toBeUndefined();
      const { tasks } = await jj<{ tasks: TaskRow[] }>(
        await local(`/api/workspaces/${workspaceId}/tasks`),
      );
      expect(tasks.find((t) => t.id === task.id)?.untitled).toBeUndefined();
    });

    it('a same-text rename of a row that was never untitled sets nothing', async () => {
      // Negative control: the fix must not turn every no-op rename into a
      // write. A named row renamed to its own title stays unchanged and
      // unflagged.
      const { task } = await jj<{ task: TaskRow }>(
        await post(`/api/workspaces/${workspaceId}/tasks`, { title: 'Plain row', author: PERSON }),
      );
      expect(task.untitled).toBeUndefined();
      const same = await jj<{ task: TaskRow; changed: boolean }>(
        await post(`/api/tasks/${task.id}/title`, { title: 'Plain row', author: PERSON }),
      );
      expect(same.changed).toBe(false);
      expect(same.task.title).toBe('Plain row');
      expect(same.task.untitled).toBeUndefined();
    });
  });

  describe('share visitors', () => {
    it('can reach the hub page but neither quick action (403)', async () => {
      const { share } = await jj<{ share: { url: string } }>(
        await post('/api/share/link', { workspaceId, label: 'hub share' }),
      );
      const shareUrl = new URL(share.url);
      const redeem = await fetch(`${base}${shareUrl.pathname}${shareUrl.search}`, {
        redirect: 'manual',
        headers: { host: PUBLIC_HOST },
      });
      expect(redeem.status).toBe(302);
      const cookie = (redeem.headers.get('set-cookie') ?? '').match(
        new RegExp(`${SHARE_COOKIE}=([^;]+)`),
      )?.[1];
      expect(cookie).toBeTruthy();
      const visitorHeaders = {
        host: PUBLIC_HOST,
        cookie: `${SHARE_COOKIE}=${cookie}`,
        'content-type': 'application/json',
      };
      // Presence: the cookie DOES reach the hub page.
      const page = await fetch(`${base}/workspaces/${workspaceId}`, { headers: visitorHeaders });
      expect(page.status).toBe(200);
      const before = (await boardDocs(workspaceId)).length;
      // Absence: the same credentials start nothing.
      const huddle = await fetch(`${base}/api/workspaces/${workspaceId}/huddles`, {
        method: 'POST',
        headers: visitorHeaders,
        body: JSON.stringify({}),
      });
      expect(huddle.status).toBe(403);
      expect((await boardDocs(workspaceId)).length).toBe(before);
      const task = await fetch(`${base}/api/workspaces/${workspaceId}/tasks`, {
        method: 'POST',
        headers: visitorHeaders,
        body: JSON.stringify({ untitled: true, author: PERSON }),
      });
      expect(task.status).toBe(403);
    });
  });
});
