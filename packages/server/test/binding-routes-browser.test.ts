/**
 * The file-binding routes are for agents, not pages.
 *
 * `POST /api/docs` (bind a file as a doc), `POST /api/workspaces` with a
 * `folderPath` (bind a folder), and `POST /api/workspaces/<id>/import-tasks`
 * (read a markdown file off disk) each turn a host path into server-readable
 * content. Nothing in the browser apps calls them — every caller is an MCP
 * tool, a hook, or a curl over loopback, none of which send `Origin`.
 *
 * The cross-origin write gate already refuses a page the origin policy does
 * not know. What it ADMITS is the problem: on the local surface any origin
 * on a machine-local hostname passes, so a dev server on `localhost:5173` —
 * or any page the person has open on this machine — could bind and read any
 * file the server can (Urgent-fixes ticket, 2026-09-02). So the binding
 * routes refuse every request that looks like a browser, whichever origin it
 * claims, and the agent path is the positive control on each one.
 *
 * Fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('file-binding routes refuse browser callers', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let scratch: string;
  let base: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'bind-browser-data-'));
    scratch = mkdtempSync(join(tmpdir(), 'bind-browser-files-'));
    writeFileSync(join(scratch, 'doc.md'), '# fixture\n');
    writeFileSync(join(scratch, 'tasks.md'), '# Tasks\n\n- [ ] one\n');
    // The sign-in gate is ON by default and would refuse these browser
    // writes first, with a different error. Off here, so what refuses a bind
    // is the binding gate alone — the thing this file is about.
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  /** What a page on another local port sends: the origin policy admits it. */
  const devServerPage = (): Record<string, string> => ({
    origin: 'http://localhost:5173',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'cors',
  });
  /** The app's own origin — same-origin, the widest trust the policy has. */
  const samePage = (): Record<string, string> => ({
    origin: base,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
  });

  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...extra,
      },
      body: JSON.stringify(body),
    });

  const expectRefused = async (r: Response) => {
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe('browser_cannot_bind');
  };

  describe('POST /api/docs', () => {
    const body = (docId: string) => ({
      docId,
      type: 'markdown',
      sourceUrl: join(scratch, 'doc.md'),
    });

    it('positive control: an agent (no Origin) binds the file', async () => {
      const r = await post('/api/docs', body('agent-bind'));
      expect(r.status).toBe(200);
    });

    it('positive control: the MCP child under node binds the file', async () => {
      // Node's fetch sends `sec-fetch-mode: cors` and nothing else — the
      // exact header set the plugin's MCP bundle arrives with. It is an
      // agent, and the gate must read it as one.
      const r = await post('/api/docs', body('node-bind'), { 'sec-fetch-mode': 'cors' });
      expect(r.status).toBe(200);
    });

    it('a page on another local port cannot bind a path', async () => {
      await expectRefused(await post('/api/docs', body('dev-bind'), devServerPage()));
    });

    it('nor can a same-origin page — the app never binds from the browser', async () => {
      await expectRefused(await post('/api/docs', body('same-bind'), samePage()));
    });
  });

  describe('POST /api/workspaces', () => {
    it('positive control: an agent binds a folder', async () => {
      const r = await post('/api/workspaces', { folderPath: scratch });
      expect(r.status).toBe(200);
    });

    it('a page cannot bind a folder', async () => {
      await expectRefused(await post('/api/workspaces', { folderPath: scratch }, devServerPage()));
    });

    it('but a page may still create a board by name — no file is involved', async () => {
      const r = await post('/api/workspaces', { name: 'Browser board' }, samePage());
      expect(r.status).toBe(200);
    });
  });

  describe('POST /api/workspaces/<id>/import-tasks', () => {
    let workspaceId: string;
    beforeEach(async () => {
      const r = await post('/api/workspaces', { name: 'Import target' });
      workspaceId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    });

    it('positive control: an agent reads the file (dry run)', async () => {
      const r = await post(`/api/workspaces/${workspaceId}/import-tasks`, {
        path: join(scratch, 'tasks.md'),
        author: { id: 'agent-x', name: 'Agent X', kind: 'agent' },
      });
      expect(r.status).toBe(200);
    });

    it('a page cannot point the import at a path', async () => {
      await expectRefused(
        await post(
          `/api/workspaces/${workspaceId}/import-tasks`,
          {
            path: join(scratch, 'tasks.md'),
            author: { id: 'agent-x', name: 'Agent X', kind: 'agent' },
          },
          devServerPage(),
        ),
      );
    });
  });
});
