import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * HTTP e2e for the landing page + workspace deletion:
 *   - GET / renders ONE row per project and no per-artifact detail — the
 *     artifacts moved to /projects/<owner>, which is what keeps the landing
 *     response small
 *   - GET /projects/<owner> renders that project's artifacts, folder members
 *     nested under one expandable row
 *   - GET /api/workspaces lists the rolled-up summary
 *   - DELETE /api/workspaces/:id enforces the all-or-nothing open-thread
 *     guardrail and force-retires the whole folder as a unit — ARCHIVING it
 *     by default, and purging only when ?purge=true asks for it
 */

describe('landing + delete_workspace e2e (HTTP)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let standaloneDir: string;
  let standalone: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'land-data-'));
    folder = mkdtempSync(join(tmpdir(), 'land-src-'));
    // The standalone doc lives OUTSIDE the bound folder so bind_folder doesn't
    // pull it into the workspace — it must surface as its own artifact.
    standaloneDir = mkdtempSync(join(tmpdir(), 'land-alone-'));
    standalone = join(standaloneDir, 'STANDALONE.md');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'README.md'), '# Project\n\nthe unique md line\n');
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const answer = 42;\n');
    writeFileSync(standalone, '# Standalone\n\nplain body\n');
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    rmSync(standaloneDir, { recursive: true, force: true });
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  type BindFile = { relPath: string; docId: string };
  type BindResp = { ok: true; workspaceId: string; files: BindFile[] };

  let workspaceId: string;
  let files: Map<string, BindFile>;

  it('binds a folder + a standalone doc as artifacts under one project owner', async () => {
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder, owner: '/proj/alpha' }),
    });
    const body = await j<BindResp>(r);
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
      files.set(f.relPath, { docId: opened.docId, relPath: f.relPath } as BindFile);
    }

    // Standalone markdown doc under the same project owner.
    const sr = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: 'standalone-doc',
        type: 'markdown',
        sourceUrl: standalone,
        owner: '/proj/alpha',
        title: 'Standalone',
      }),
    });
    await j(sr);
  });

  it('GET / renders a project LINK for the review docs and NOT their artifacts', async () => {
    const r = await fetch(`${base}/`);
    expect(r.ok).toBe(true);
    const html = await r.text();

    // Mobile is load-bearing (Bryan reviews on his phone): the landing page
    // MUST ship the responsive viewport meta or it renders at ~980px and
    // scales down to unreadable on a phone.
    expect(html).toContain('name="viewport"');
    // The review docs surface as one per-project link behind the fold,
    // deriving from the owner cwd basename and linking to the project's own
    // on-demand page.
    expect(html).toContain('Review docs by project');
    expect(html).toContain('alpha');
    expect(html).toContain(`/projects/${encodeURIComponent('/proj/alpha')}`);

    // …and NONE of the per-artifact detail. This is the whole point: the
    // member file list and the per-doc review links are what made this
    // response 910 KB on the live server, and Bryan's re-scope of `/` is "a
    // list of active workspaces to open up". The assertions below are
    // absences, so the presences above are their positive control — this
    // response is a rendered page, not an error or an empty body.
    expect(html).not.toContain('README.md');
    expect(html).not.toContain('src/index.ts');
    expect(html).not.toContain('review/standalone-doc');
    // A landing response measured in kilobytes, not hundreds of them.
    expect(html.length).toBeLessThan(20_000);
  });

  it('GET /projects/<owner> renders that project artifacts on demand', async () => {
    const r = await fetch(`${base}/projects/${encodeURIComponent('/proj/alpha')}`);
    expect(r.ok).toBe(true);
    const html = await r.text();
    // The folder artifact is one expandable <details> labeled by its
    // workspaceId, nesting its member files.
    expect(html).toContain('<details');
    expect(html).toContain(workspaceId);
    expect(html).toContain('README.md');
    expect(html).toContain('src/index.ts');
    // The standalone markdown artifact shows its source basename + a markdown
    // kind label, linking to its own review URL.
    expect(html).toContain('STANDALONE.md');
    expect(html).toContain('/docs/standalone-doc');
    expect(html).toContain('markdown');
    // Back to the index.
    expect(html).toContain('href="/"');
  });

  it('GET /projects/<unknown> is a 404, not an empty-looking success', async () => {
    const r = await fetch(`${base}/projects/${encodeURIComponent('/proj/nope')}`);
    expect(r.status).toBe(404);
  });

  it('GET /api/workspaces lists the rolled-up summary', async () => {
    const r = await fetch(`${base}/api/workspaces`);
    const body = await j<{
      workspaces: Array<{
        workspaceId: string;
        fileCount: number;
        openThreads: number;
        owner?: string;
        allIdle: boolean;
      }>;
    }>(r);
    const w = body.workspaces.find((x) => x.workspaceId === workspaceId)!;
    expect(w).toBeTruthy();
    expect(w.fileCount).toBe(2);
    expect(w.openThreads).toBe(0);
    expect(w.owner).toBe('/proj/alpha');
  });

  it('DELETE /api/workspaces/:id is blocked all-or-nothing when a member has open threads', async () => {
    // Open a thread on the markdown member.
    const mdDocId = files.get('README.md')!.docId;
    const tr = await fetch(`${base}/api/docs/${encodeURIComponent(mdDocId)}/threads/by_find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
        text: 'wait on this',
        find: 'the unique md line',
      }),
    });
    await j(tr);

    const r = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as {
      ok: boolean;
      error: string;
      files: Array<{ docId: string; openThreads: number }>;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('has-open-threads');
    expect(body.files).toEqual([{ docId: mdDocId, openThreads: 1 }]);
    // Nothing deleted — both members survive.
    expect(handle.rooms.get(mdDocId)).toBeTruthy();
    expect(handle.rooms.get(files.get('src/index.ts')!.docId)).toBeTruthy();
  });

  it('DELETE /api/workspaces/:id?force=true ARCHIVES the whole folder', async () => {
    // The old payload still means "retire this review" and still takes every
    // member out of the live server — what changed is that the persisted
    // state is parked in `_archive` instead of destroyed, so this is
    // recoverable. `deleted` is gone from the response because nothing was.
    const r = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}?force=true`, {
      method: 'DELETE',
    });
    const body = await j<{ ok: true; archived: number; docIds: string[] }>(r);
    expect(body.archived).toBe(2);
    for (const f of files.values()) expect(handle.rooms.get(f.docId)).toBeUndefined();
    for (const f of files.values()) {
      expect(existsSync(join(dataDir, '_archive', `${f.docId}.ydoc`))).toBe(true);
    }
    // Standalone doc is untouched.
    expect(handle.rooms.get('standalone-doc')).toBeTruthy();
  });

  it('DELETE ?purge=true is the destructive half, and it has to be asked for', async () => {
    // Bring back what the previous test archived, which is the round trip
    // that makes archiving safe to be the default.
    const restored = await fetch(
      `${base}/api/reviews/${encodeURIComponent(workspaceId)}/unarchive`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect((await j<{ ok: true; restored: number }>(restored)).restored).toBe(2);
    for (const f of files.values()) expect(handle.rooms.get(f.docId)).toBeTruthy();

    const r = await fetch(
      `${base}/api/workspaces/${encodeURIComponent(workspaceId)}?force=true&purge=true`,
      { method: 'DELETE' },
    );
    const body = await j<{ ok: true; deleted: number }>(r);
    expect(body.deleted).toBe(2);
    for (const f of files.values()) {
      expect(handle.rooms.get(f.docId)).toBeUndefined();
      expect(existsSync(join(dataDir, `${f.docId}.ydoc`))).toBe(false);
      expect(existsSync(join(dataDir, '_archive', `${f.docId}.ydoc`))).toBe(false);
    }
  });

  it('DELETE on an unknown workspace returns 404', async () => {
    const r = await fetch(`${base}/api/workspaces/nope-${Date.now()}`, { method: 'DELETE' });
    expect(r.status).toBe(404);
  });
});
