import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * HTTP e2e for the Milestone-2 landing redesign + workspace deletion:
 *   - GET / renders the project → artifacts page (grouped, with the folder
 *     artifact expandable and a per-artifact open badge)
 *   - GET /api/workspaces lists the rolled-up summary
 *   - DELETE /api/workspaces/:id enforces the all-or-nothing open-thread
 *     guardrail and force-deletes the whole folder as a unit
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

  it('GET / renders the grouped project → artifacts HTML', async () => {
    const r = await fetch(`${base}/`);
    expect(r.ok).toBe(true);
    const html = await r.text();

    // Mobile is load-bearing (Bryan reviews on his phone): the landing page
    // MUST ship the responsive viewport meta or it renders at ~980px and
    // scales down to unreadable on a phone.
    expect(html).toContain('name="viewport"');
    // Project header derives from the owner cwd basename.
    expect(html).toContain('alpha');
    // The folder artifact appears as an expandable <details> with a folder glyph,
    // labeled by its workspaceId, and nests its member files (README.md, index.ts).
    expect(html).toContain('<details>');
    expect(html).toContain(workspaceId);
    expect(html).toContain('README.md');
    expect(html).toContain('src/index.ts');
    // The standalone markdown artifact shows its source basename + a markdown
    // kind label, linking to its own review URL.
    expect(html).toContain('STANDALONE.md');
    expect(html).toContain('review/standalone-doc');
    expect(html).toContain('markdown');
    // Summary line counts artifacts (the folder counts as ONE artifact + the
    // standalone = 2), not member files.
    expect(html).toContain('2 artifacts');
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

  it('DELETE /api/workspaces/:id?force=true removes the whole folder', async () => {
    const r = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}?force=true`, {
      method: 'DELETE',
    });
    const body = await j<{ ok: true; deleted: number }>(r);
    expect(body.deleted).toBe(2);
    for (const f of files.values()) expect(handle.rooms.get(f.docId)).toBeUndefined();
    // Standalone doc is untouched.
    expect(handle.rooms.get('standalone-doc')).toBeTruthy();
  });

  it('DELETE on an unknown workspace returns 404', async () => {
    const r = await fetch(`${base}/api/workspaces/nope-${Date.now()}`, { method: 'DELETE' });
    expect(r.status).toBe(404);
  });
});
