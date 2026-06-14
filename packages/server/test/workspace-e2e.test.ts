import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * End-to-end HTTP smoke test for the folder-review feature (folder bind →
 * file tree with counts → read-only code content). Exercises the actual
 * REST routes against a throwaway server on a temp dataDir + temp folder —
 * NOT the in-process Rooms API (bind-folder.test.ts already covers that).
 */
describe('workspace folder-review e2e (HTTP)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-e2e-data-'));
    folder = mkdtempSync(join(tmpdir(), 'ws-e2e-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    // A small workspace: one markdown, one ts, one json — nested so the tree
    // has a real directory level to roll up through.
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'README.md'), '# Project\n\nthe unique md line\n');
    writeFileSync(join(folder, 'src', 'index.ts'), 'export const answer = 42;\nconst x = 1;\n');
    writeFileSync(join(folder, 'src', 'data.json'), '{\n  "key": "value"\n}\n');
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

  type BindFile = {
    relPath: string;
    docId: string;
    type: 'markdown' | 'code';
    reviewUrl?: string;
  };
  type BindResp = { ok: true; workspaceId: string; root: string; files: BindFile[] };

  let workspaceId: string;
  let files: Map<string, BindFile>;

  it('(a) POST /api/workspaces binds the folder and lists the 3 files with types', async () => {
    const r = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder, owner: '/cwd' }),
    });
    const body = await j<BindResp>(r);
    expect(body.ok).toBe(true);
    workspaceId = body.workspaceId;
    files = new Map(body.files.map((f) => [f.relPath, f]));

    expect([...files.keys()].sort()).toEqual(['README.md', 'src/data.json', 'src/index.ts']);
    expect(files.get('README.md')?.type).toBe('markdown');
    expect(files.get('src/index.ts')?.type).toBe('code');
    expect(files.get('src/data.json')?.type).toBe('code');
    // Code files get a /review reviewUrl decorated by withReviewUrl.
    expect(files.get('src/index.ts')?.reviewUrl).toContain('/review/');
  });

  it('(b) GET /api/workspaces/:id/tree returns the nested tree with zero open counts', async () => {
    const r = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/tree`);
    type FileNode = { type: 'file'; relPath: string; openCount: number; fileType: string };
    type DirNode = { type: 'dir'; name: string; openCount: number; children: Node[] };
    type Node = FileNode | DirNode;
    const tree = await j<{ workspaceId: string; totalOpen: number; tree: DirNode }>(r);

    expect(tree.workspaceId).toBe(workspaceId);
    expect(tree.totalOpen).toBe(0);

    // Top level: the `src` dir (dirs sort first) + README.md.
    const topNames = tree.tree.children.map((c) => (c.type === 'dir' ? c.name : c.relPath));
    expect(topNames).toContain('src');
    expect(topNames).toContain('README.md');

    // Every file leaf starts at openCount 0.
    const fileLeaves: FileNode[] = [];
    const walk = (n: Node) => {
      if (n.type === 'file') fileLeaves.push(n);
      else for (const c of n.children) walk(c);
    };
    walk(tree.tree);
    expect(fileLeaves.length).toBe(3);
    expect(fileLeaves.every((f) => f.openCount === 0)).toBe(true);
  });

  it('(c) creating a thread on src/index.ts rolls openCount up to the src folder + total', async () => {
    const codeDocId = files.get('src/index.ts')!.docId;

    // Build a text-range anchor against the live `content` Y.Text exactly the
    // way the read-only code surface does (code-anchor.ts): CM offsets are
    // byte-identical to indices into `content`. Send rel positions as
    // number[] — the wire shape the editor + REST routes round-trip cleanly.
    const room = handle.rooms.get(codeDocId);
    expect(room).toBeTruthy();
    const content = room!.ydoc.getText('content');
    const source = content.toString();
    const from = source.indexOf('export const answer');
    const to = source.indexOf('\n', from); // end of the first line
    expect(from).toBeGreaterThanOrEqual(0);
    const startRel = Array.from(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, from)),
    );
    const endRel = Array.from(
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, to)),
    );

    const anchor = {
      kind: 'text-range',
      startRel,
      endRel,
      snippet: { text: source.slice(from, to) },
    };

    const tr = await fetch(`${base}/api/docs/${encodeURIComponent(codeDocId)}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: { id: 'u1', name: 'Reviewer', kind: 'known', color: '#2e7dd7' },
        text: 'why 42?',
        anchor,
      }),
    });
    const { thread } = await j<{ thread: { id: string; status: string } }>(tr);
    expect(thread.status).toBe('open');

    // Re-fetch the tree: the code file's openCount is 1, and it rolls up
    // through the `src` folder and the workspace total.
    const r2 = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/tree`);
    type FileNode = { type: 'file'; relPath: string; openCount: number };
    type DirNode = { type: 'dir'; name: string; openCount: number; children: Node[] };
    type Node = FileNode | DirNode;
    const tree = await j<{ totalOpen: number; tree: DirNode }>(r2);

    expect(tree.totalOpen).toBe(1);
    const srcDir = tree.tree.children.find(
      (c): c is DirNode => c.type === 'dir' && c.name === 'src',
    )!;
    expect(srcDir.openCount).toBe(1);

    const flat = new Map<string, number>();
    const walk = (n: Node) => {
      if (n.type === 'file') flat.set(n.relPath, n.openCount);
      else for (const c of n.children) walk(c);
    };
    walk(tree.tree);
    expect(flat.get('src/index.ts')).toBe(1);
    expect(flat.get('src/data.json')).toBe(0);
    expect(flat.get('README.md')).toBe(0);
  });

  it('(d) GET /api/docs/:codeDocId/content returns the raw source as a code block', async () => {
    const codeDocId = files.get('src/index.ts')!.docId;
    const r = await fetch(`${base}/api/docs/${encodeURIComponent(codeDocId)}/content`);
    const doc = await j<{
      plainText: string;
      blocks: Array<{ type: string | null; text: string }>;
    }>(r);

    const expected = 'export const answer = 42;\nconst x = 1;\n';
    expect(doc.plainText).toBe(expected);
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0]!.type).toBe('code');
    expect(doc.blocks[0]!.text).toBe(expected);
  });
});
