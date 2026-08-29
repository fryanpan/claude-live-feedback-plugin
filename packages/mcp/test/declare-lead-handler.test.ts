/**
 * `set_workspace_lead` over the real MCP wire, in two identities.
 *
 * Replaces a test that grepped mcp.ts for `declared.isError === true ? err(`
 * — source text can match while the behaviour is gone (a refactor that keeps
 * the words and drops the branch), and cannot show what the OTHER side of
 * the wire sees. Here the bundle is spawned twice against a recording stub:
 *
 *  - without CW_AGENT_NAME, the tool answers `isError: true` naming the env
 *    var, and the stub receives NO attach and NO seat request — the refusal
 *    is before any seat change, which is the whole point of the finding;
 *  - with a name (POSITIVE CONTROL, same stub, same tool), the seat request
 *    goes out and the answer is not an error.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '../../plugin/mcp/index.js');
const WS = 'w-lead1';

type Recorded = { method: string; path: string };

class Child {
  private nextId = 1;
  private pending = '';
  private readonly waiters = new Map<number, (value: unknown) => void>();
  readonly proc: ChildProcess;

  constructor(port: number, agentName: string | undefined) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CW_BASE_URL: `http://127.0.0.1:${port}`,
      FEEDBACK_BASE_URL: `http://127.0.0.1:${port}`,
    };
    // The identity under test is decided by these three, so none may leak
    // in from the session that runs the suite.
    for (const k of ['CW_AGENT_NAME', 'FEEDBACK_AGENT_NAME', 'FEEDBACK_AUTHOR']) delete env[k];
    if (agentName !== undefined) env.CW_AGENT_NAME = agentName;
    this.proc = spawn(process.execPath, [BUNDLE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout?.on('data', (d) => {
      this.pending += d.toString();
      let nl = this.pending.indexOf('\n');
      while (nl !== -1) {
        const line = this.pending.slice(0, nl).trim();
        this.pending = this.pending.slice(nl + 1);
        if (line.startsWith('{')) {
          const msg = JSON.parse(line) as { id?: number; result?: unknown };
          if (typeof msg.id === 'number') this.waiters.get(msg.id)?.(msg.result);
        }
        nl = this.pending.indexOf('\n');
      }
    });
  }

  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiters.set(id, (v) => resolve(v as Record<string, unknown>));
      this.proc.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`,
      );
    });
  }

  kill(): void {
    this.proc.kill();
  }
}

let stub: Server;
let port = 0;
const seen: Recorded[] = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          workspace: { id: WS, leadAgentId: 'agent-named' },
          attachment: { agentId: 'agent-named' },
          gating: {},
          untriaged: [],
          watches: [],
          docs: [],
        }),
      );
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  port = (stub.address() as AddressInfo).port;
});

afterAll(() => {
  stub.close();
});

function text(result: Record<string, unknown>): string {
  const content = result.content as Array<{ text?: string }> | undefined;
  return (content ?? []).map((c) => c.text ?? '').join('\n');
}

describe('set_workspace_lead over the wire', () => {
  it('a session without CW_AGENT_NAME gets a tool error, and no seat request leaves the process', async () => {
    const child = new Child(port, undefined);
    try {
      seen.length = 0;
      const res = await child.call('set_workspace_lead', { workspaceId: WS });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/CW_AGENT_NAME/);
      // Refused BEFORE any seat change: nothing attached, nothing claimed.
      const seatOrAttach = seen.filter(
        (r) => /\/lead$/.test(r.path) || /\/attachments$/.test(r.path),
      );
      expect(seatOrAttach).toEqual([]);
    } finally {
      child.kill();
    }
  }, 20_000);

  it('POSITIVE CONTROL: a named session takes the seat through the same tool', async () => {
    const child = new Child(port, 'Named');
    try {
      seen.length = 0;
      const res = await child.call('set_workspace_lead', { workspaceId: WS });
      expect(res.isError, text(res)).not.toBe(true);
      expect(seen.some((r) => r.method === 'PUT' && r.path === `/api/workspaces/${WS}/lead`)).toBe(
        true,
      );
    } finally {
      child.kill();
    }
  }, 20_000);
});
