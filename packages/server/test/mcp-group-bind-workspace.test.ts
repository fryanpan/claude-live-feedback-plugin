/**
 * create_diff_review / bind_folder file their review on a board — through the
 * SHIPPED BUNDLE.
 *
 * A param can be declared in a tool's inputSchema and never put on the wire.
 * That is exactly how `groups` was accepted and discarded, and a unit test on
 * either side of that gap passes the whole time — so this spawns
 * `packages/plugin/mcp/index.js` (the artifact peers actually load, not the
 * TypeScript source) over stdio and asserts the server-side EFFECT.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const BUNDLE = resolve(import.meta.dir, '../../plugin/mcp/index.js');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

describe('the group-bind MCP tools file the review on a board, through the real bundle', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let repoBase: string;
  let folder: string;
  let child: ReturnType<typeof spawn>;
  let pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let nextId = 1;

  const call = (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolvePromise(msg);
      });
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };

  const callTool = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
    const reply = (await call('tools/call', { name, arguments: args })) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    expect(reply.error).toBeUndefined();
    return JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-group-ws-'));
    repo = mkdtempSync(join(tmpdir(), 'mcp-group-repo-'));
    folder = mkdtempSync(join(tmpdir(), 'mcp-group-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nRead me.\n');

    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    repoBase = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 2;\n');

    handle = createServer({ dedicatedListener: true, port: 0, dataDir });

    child = spawn('node', [BUNDLE], {
      env: {
        ...process.env,
        // The MCP prefers this over port discovery, so the child talks to THIS
        // server and never to whatever prod instance is running on the box.
        FEEDBACK_BASE_URL: `http://localhost:${handle.port}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('{')) {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
        }
        nl = buf.indexOf('\n');
      }
    });

    await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'group-bind-workspace-test', version: '0' },
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  });

  afterAll(async () => {
    child?.kill();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    pending = new Map();
  });

  it('create_diff_review forwards a caller-named board all the way to the store', async () => {
    const ws = (await callTool('create_workspace', {
      name: 'mcp-diff-board',
      goal: 'Ship it.',
    })) as { workspaceId?: string };
    const boardId = ws.workspaceId as string;
    // Positive control on the harness itself: the tool call reached the server
    // and came back with real state, so a missing field below means the param
    // was dropped rather than that nothing ran.
    expect(boardId).toBeTruthy();

    const res = (await callTool('create_diff_review', {
      repo,
      base: repoBase,
      reviewId: 'mcp-rev-named',
      hubWorkspaceId: boardId,
      subscribe: false,
    })) as { hubWorkspaceId?: string };

    expect(res.hubWorkspaceId).toBe(boardId);
    expect(handle.tasks.workspaceOfDoc('mcp-rev-named')).toBe(boardId);
  });

  it('create_diff_review with no board still lands the review on one, in a single call', async () => {
    const res = (await callTool('create_diff_review', {
      repo,
      base: repoBase,
      reviewId: 'mcp-rev-unfiled',
      subscribe: false,
    })) as { hubWorkspaceId?: string; entryUrl?: string };

    // One call: the URL a human gets AND the board it landed on.
    expect(res.entryUrl).toBeTruthy();
    expect(res.hubWorkspaceId).toBeTruthy();
    expect(handle.tasks.workspaceOfDoc('mcp-rev-unfiled')).toBe(res.hubWorkspaceId as string);
  });

  it('bind_folder forwards it too — a second tool reaches a second route', async () => {
    const ws = (await callTool('create_workspace', { name: 'mcp-folder-board' })) as {
      workspaceId?: string;
    };
    const boardId = ws.workspaceId as string;
    expect(boardId).toBeTruthy();

    const res = (await callTool('bind_folder', {
      folderPath: folder,
      workspaceId: 'mcp-folder-grouping',
      hubWorkspaceId: boardId,
      subscribe: false,
    })) as { hubWorkspaceId?: string; workspaceId?: string };

    // `workspaceId` here is the GROUPING the bind created; `hubWorkspaceId` is
    // the board it was filed on. Both in one payload, kept apart by name.
    expect(res.workspaceId).toBe('mcp-folder-grouping');
    expect(res.hubWorkspaceId).toBe(boardId);
    expect(handle.tasks.workspaceOfDoc('mcp-folder-grouping')).toBe(boardId);
  });
});
