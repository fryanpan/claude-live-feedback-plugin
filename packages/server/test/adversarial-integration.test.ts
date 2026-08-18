import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DocMeta,
  type ElementAnchor,
  type User,
  createThread,
  initDocMeta,
} from '@feedback/core';
import * as Y from 'yjs';
import { runBackfill } from '../src/activity-backfill.ts';
import { activityLogPath } from '../src/activity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * Adversarial integration verification of BOTH areas on this branch:
 *   (A) hands-on activity stream — live person comment + read_session + backfill
 *   (B) project/artifacts landing + delete_workspace guardrail.
 *
 * Runs on a THROWAWAY server (port:0, tmp dataDir). Never touches the
 * long-running :8787 server. Asserts the exact schema contracts the Weekly
 * Review agent depends on, then confirms no .ydoc was deleted by the backfill.
 */

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

const fakeAnchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Go',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Go' },
};

interface ActivityEvent {
  eventId: string;
  ts: string;
  type: string;
  actor: string;
  actorId: string;
  actorName: string;
  isOwner: boolean;
  threadId?: string;
  doc: {
    docId: string;
    kind: string;
    repo: { owner: string; name: string };
    producedBy: { agentId: string | null; sessionId: string | null; cwd: string | null };
  };
  payload: { text?: string; wordCount?: number; durationMs?: number; interactionBounded?: boolean };
}

function readEvents(dataDir: string): ActivityEvent[] {
  const path = activityLogPath(dataDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ActivityEvent);
}

describe('ADVERSARIAL: activity stream e2e (throwaway server)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adv-act-data-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  it('PERSON comment appends a fully-formed comment event', async () => {
    const file = join(dataDir, 'adv-doc.md');
    writeFileSync(file, '# Heading\n\nSome prose to comment on.\n');
    await j(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'adv-doc', type: 'markdown', sourceUrl: file }),
      }),
    );

    await j(
      await fetch(`${base}/api/docs/adv-doc/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: bryan,
          text: 'this whole section needs more detail please',
          anchor: fakeAnchor,
        }),
      }),
    );

    const events = readEvents(dataDir);
    const c = events.find((e) => e.type === 'comment' && e.doc.docId === 'adv-doc');
    expect(c, 'a comment event was appended').toBeDefined();
    expect(c!.type).toBe('comment');
    expect(c!.actor).toBe('person');
    // ts is ISO-8601 UTC ending in Z, millisecond precision.
    expect(c!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(c!.ts.endsWith('Z')).toBe(true);
    // stable, deterministic eventId.
    expect(c!.eventId).toMatch(/^[0-9a-f]{24}$/);
    // doc.repo present.
    expect(c!.doc.repo).toBeDefined();
    expect(typeof c!.doc.repo.owner).toBe('string');
    expect(c!.doc.repo.owner.length).toBeGreaterThan(0);
    expect(typeof c!.doc.repo.name).toBe('string');
    // payload.wordCount > 0.
    expect(c!.payload.wordCount).toBeGreaterThan(0);
    expect(c!.payload.wordCount).toBe(7);
  });

  it('read_session appends with interactionBounded:true + durationMs', async () => {
    const r = await fetch(`${base}/api/docs/adv-doc/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'read_session',
        author: bryan,
        payload: {
          sessionId: 'adv-sess-1',
          durationMs: 27_500,
          interactionBounded: true,
          maxScrollDepthPct: 88,
        },
      }),
    });
    expect(r.status).toBe(200);

    const read = readEvents(dataDir).find(
      (e) => e.type === 'read_session' && e.doc.docId === 'adv-doc',
    );
    expect(read, 'a read_session event was appended').toBeDefined();
    expect(read!.actor).toBe('person');
    expect(read!.payload.interactionBounded).toBe(true);
    expect(read!.payload.durationMs).toBe(27_500);
    expect(read!.ts.endsWith('Z')).toBe(true);
  });
});

describe('ADVERSARIAL: backfill idempotence + non-destructiveness', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adv-bf-data-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeYdocWithOneComment(docId: string): string {
    const ydoc = new Y.Doc();
    const meta: DocMeta = {
      docId,
      type: 'markdown',
      sourceUrl: join(dataDir, `${docId}.md`),
      createdAt: Date.parse('2026-05-01T00:00:00Z'),
      owner: dataDir,
    };
    initDocMeta(ydoc, meta);
    const t = createThread(ydoc, {
      threadId: 'adv-thread',
      anchor: { kind: 'element', fingerprint: fakeAnchor.fingerprint, snippet: { text: 'x' } },
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'a backfillable point' },
    });
    const threads = ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>;
    const comments = threads.get(t.id)!.get('comments') as Y.Array<Y.Map<unknown>>;
    ydoc.transact(() => {
      (comments.get(0) as Y.Map<unknown>).set('ts', Date.parse('2026-05-02T10:00:00Z'));
    });
    const ydocPath = join(dataDir, `${docId}.ydoc`);
    writeFileSync(ydocPath, Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    return ydocPath;
  }

  it('re-running the backfill yields IDENTICAL eventIds and never deletes a .ydoc', () => {
    const ydocPath = writeYdocWithOneComment('adv-bf-doc');
    const ydocBytesBefore = readFileSync(ydocPath).length;
    const ydocCountBefore = readdirSync(dataDir).filter((f) => f.endsWith('.ydoc')).length;

    const first = runBackfill({ dataDir });
    expect(first.byType.comment).toBe(1);
    const ids1 = readEvents(dataDir)
      .filter((e) => e.doc.docId === 'adv-bf-doc')
      .map((e) => e.eventId);
    expect(ids1).toHaveLength(1);

    runBackfill({ dataDir });
    const ids2 = readEvents(dataDir)
      .filter((e) => e.doc.docId === 'adv-bf-doc')
      .map((e) => e.eventId);

    // The dedupe contract is at the eventId level: every emitted line for this
    // doc carries the SAME deterministic id, so a consumer dedupes a re-run.
    expect(new Set(ids2)).toEqual(new Set(ids1));
    for (const id of ids2) expect(id).toBe(ids1[0]!);

    // Non-destructive: the .ydoc is untouched (same count, same bytes).
    expect(readdirSync(dataDir).filter((f) => f.endsWith('.ydoc')).length).toBe(ydocCountBefore);
    expect(existsSync(ydocPath)).toBe(true);
    expect(readFileSync(ydocPath).length).toBe(ydocBytesBefore);
  });
});

describe('ADVERSARIAL: landing project->artifacts + delete_workspace guardrail', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'adv-land-data-'));
    folder = mkdtempSync(join(tmpdir(), 'adv-land-src-'));
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'README.md'), '# Proj\n\nthe distinct readme line\n');
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const x = 1;\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  type BindFile = { relPath: string; docId: string };
  let workspaceId: string;
  let files: Map<string, BindFile>;

  it('GET / rows the project, and /projects/<owner> shows the workspace as ONE artifact', async () => {
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder, owner: '/proj/adv' }),
    });
    const body = await j<{ ok: true; workspaceId: string; files: BindFile[] }>(r);
    workspaceId = body.workspaceId;
    files = new Map(body.files.map((f) => [f.relPath, f]));
    // bind is lazy now (entry only) — open the rest like a reviewer would.
    const allR = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/files`);
    const all = await j<{ files: Array<{ relPath: string }> }>(allR);
    for (const f of all.files) {
      if (files.has(f.relPath)) continue;
      const cr = await fetch(
        `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/context-file`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: f.relPath }),
        },
      );
      const opened = await j<{ docId: string }>(cr);
      files.set(f.relPath, { docId: opened.docId, relPath: f.relPath });
    }

    const html = await (await fetch(`${base}/`)).text();
    // One LINK for the project behind the review-docs fold, by owner
    // basename. `/` itself is a list of active workspaces (Bryan's re-scope,
    // task t-UZMXu32nt4wN), so the project carries no artifact counts here.
    expect(html).toContain('adv');
    expect(html).toContain(`/projects/${encodeURIComponent('/proj/adv')}`);
    // …and none of its contents: the per-artifact detail is what moved off the
    // landing response. The presences above are this absence's positive
    // control — a real page rendered, it just does not carry the file list.
    expect(html).not.toContain('src/index.ts');
    expect(html).not.toContain('README.md');

    // The detail lives one hop away, and it is still ONE expandable folder
    // artifact nesting its members.
    const proj = await (await fetch(`${base}/projects/${encodeURIComponent('/proj/adv')}`)).text();
    expect(proj).toContain('<details');
    expect(proj).toContain(workspaceId);
    expect(proj).toContain('README.md');
    expect(proj).toContain('src/index.ts');
    expect(proj).toContain('1 artifact');
  });

  it('DELETE /api/workspaces/:id without force is refused all-or-nothing with an open thread', async () => {
    const mdDocId = files.get('README.md')!.docId;
    await j(
      await fetch(`${base}/api/docs/${encodeURIComponent(mdDocId)}/threads/by_find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: { id: 'u9', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
          text: 'hold this folder',
          find: 'the distinct readme line',
        }),
      }),
    );

    const r = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('has-open-threads');
    // All-or-nothing: BOTH members survive.
    expect(handle.rooms.get(mdDocId)).toBeTruthy();
    expect(handle.rooms.get(files.get('src/index.ts')!.docId)).toBeTruthy();
  });

  it('DELETE /api/workspaces/:id?force=true removes ALL members', async () => {
    const r = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}?force=true`, {
      method: 'DELETE',
    });
    const body = await j<{ ok: true; deleted: number }>(r);
    expect(body.deleted).toBe(2);
    for (const f of files.values()) expect(handle.rooms.get(f.docId)).toBeUndefined();
  });
});
