/**
 * The MCP tools, end to end, against a real server.
 *
 * A param can be declared in a tool's inputSchema and never put on the wire —
 * that is exactly how `groups` was accepted and discarded, and a unit test on
 * either side would have passed the whole time. So this drives the SHIPPED
 * BUNDLE (`packages/plugin/mcp/index.js`, the artifact peers actually load,
 * not the TypeScript source) over stdio and checks the server-side EFFECT.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const BUNDLE = resolve(import.meta.dir, '../../plugin/mcp/index.js');

describe('the MCP tools file a doc in a workspace, through the real bundle', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let child: ReturnType<typeof spawn>;
  let pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let nextId = 1;

  /** One JSON-RPC round trip to the child over stdio. */
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

  /** The tool's own JSON payload, unwrapped from the MCP content envelope. */
  const callTool = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
    const reply = (await call('tools/call', { name, arguments: args })) as {
      result?: { content?: Array<{ text?: string }> };
      error?: unknown;
    };
    expect(reply.error).toBeUndefined();
    return JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-doc-ws-'));
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
      clientInfo: { name: 'doc-workspace-test', version: '0' },
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  });

  afterAll(async () => {
    child?.kill();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    pending = new Map();
  });

  it('create_review_doc forwards a caller-named workspace all the way to the store', async () => {
    const ws = (await callTool('create_workspace', {
      name: 'mcp-named-ws',
      goal: 'Ship it.',
    })) as { workspaceId?: string };
    const wsId = ws.workspaceId as string;
    // Positive control on the harness itself: the tool call reached the server
    // and came back with real state, so a null result below means the param
    // was dropped rather than that nothing ran.
    expect(wsId).toBeTruthy();

    const path = join(dataDir, 'mcp-named.md');
    writeFileSync(path, '# Named\n\nBody.\n');
    const res = (await callTool('create_review_doc', {
      docId: 'mcp-doc-named',
      path,
      hubWorkspaceId: wsId,
    })) as { docId?: string; hubWorkspaceId?: string };

    // The server MINTS the id; `mcp-doc-named` is the readable alias for it.
    const docId = res.docId as string;
    expect(docId).toBeTruthy();
    expect(res.hubWorkspaceId).toBe(wsId);
    expect(handle.tasks.workspaceOfDoc(docId)).toBe(wsId);
    // ...and the name the tool was given still reaches the same room.
    expect(handle.rooms.get('mcp-doc-named')?.docId).toBe(docId);
  });

  it('create_review_doc with no workspace still lands the doc in one, in a single call', async () => {
    const path = join(dataDir, 'mcp-unfiled.md');
    writeFileSync(path, '# Unfiled\n\nBody.\n');
    const res = (await callTool('create_review_doc', {
      docId: 'mcp-doc-unfiled',
      path,
    })) as { docId?: string; hubWorkspaceId?: string; meta?: { reviewUrl?: string } };

    // One call: the review URL a human gets AND the workspace it landed in.
    expect(res.meta?.reviewUrl).toBeTruthy();
    expect(res.hubWorkspaceId).toBeTruthy();
    expect(res.docId).toBeTruthy();
    expect(handle.tasks.workspaceOfDoc(res.docId as string)).toBe(res.hubWorkspaceId as string);
    expect(handle.rooms.get('mcp-doc-unfiled')?.docId).toBe(res.docId as string);
  });

  it('bind_mock forwards it too — two tools reach the one route', async () => {
    const ws = (await callTool('create_workspace', { name: 'mcp-mock-ws' })) as {
      workspaceId?: string;
    };
    const wsId = ws.workspaceId as string;
    expect(wsId).toBeTruthy();

    const html = join(dataDir, 'mock.html');
    writeFileSync(html, '<!doctype html><title>Mock</title><p>Hi.</p>');
    const res = (await callTool('bind_mock', {
      docId: 'mcp-mock-named',
      sourceHtmlPath: html,
      hubWorkspaceId: wsId,
    })) as { docId?: string; hubWorkspaceId?: string };

    const docId = res.docId as string;
    expect(docId).toBeTruthy();
    expect(res.hubWorkspaceId).toBe(wsId);
    expect(handle.tasks.workspaceOfDoc(docId)).toBe(wsId);
    expect(handle.rooms.get('mcp-mock-named')?.docId).toBe(docId);
  });
});
