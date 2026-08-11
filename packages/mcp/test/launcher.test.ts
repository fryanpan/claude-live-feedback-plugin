import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The plugin's MCP server has to start from sessions that were not launched by
 * an interactive shell — launchd, a GUI app, cron. `"command": "node"` did not:
 * on a machine where node comes from nvm, PATH is built in ~/.zshrc, so `node`
 * resolves interactively and nowhere else. Those sessions got a bare ENOENT and
 * no live-feedback tools at all.
 *
 * These tests run the launcher with a PATH that deliberately has no node on it.
 */

const REPO = resolve(__dirname, '../../..');
const LAUNCHER = resolve(REPO, 'packages/plugin/bin/live-feedback-mcp.sh');
const BUNDLE = resolve(REPO, 'packages/plugin/mcp/index.js');
const MCP_JSON = resolve(REPO, 'packages/plugin/.mcp.json');

/** A PATH with the usual system dirs and no node — what launchd hands a process. */
const NODELESS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function run(
  command: string,
  args: string[],
  { stdin, timeoutMs = 20_000 }: { stdin?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env: { PATH: NODELESS_PATH, HOME: process.env.HOME ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const done = (code: number | null) => resolvePromise({ code, stdout, stderr });

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      // The server stays alive after answering; stop as soon as it has framed a reply.
      if (stdout.includes('\n')) child.kill();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += String(err);
      done(null);
    });
    child.on('close', done);

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => clearTimeout(timer));

    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'launcher-test', version: '0' },
  },
})}\n`;

describe('plugin MCP launcher', () => {
  // Positive control for the negative test below: proves this harness can detect
  // a launcher that fails to start, so "it handshook" is not a vacuous pass.
  it('bare `node` cannot start the bundle on a node-less PATH', async () => {
    const { code, stdout, stderr } = await run('node', [BUNDLE], { stdin: INITIALIZE });

    expect(stdout).not.toContain('"result"');
    expect(code === 0 && stdout.length > 0).toBe(false);
    expect(`${stderr}`).toMatch(/ENOENT|not found|no such file/i);
  });

  it('completes an MCP initialize handshake with no node on PATH', async () => {
    const { stdout } = await run('/bin/sh', [LAUNCHER, BUNDLE], { stdin: INITIALIZE });

    const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
    expect(
      line,
      `no JSON-RPC line in output: ${JSON.stringify(stdout.slice(0, 400))}`,
    ).toBeTruthy();

    const reply = JSON.parse(line as string);
    expect(reply.id).toBe(1);
    expect(reply.error).toBeUndefined();
    expect(reply.result?.serverInfo?.name).toBeTruthy();

    // The version a client sees had drifted three minor releases behind the
    // plugin manifest, because nothing tied the two together.
    const pluginVersion = JSON.parse(
      readFileSync(resolve(REPO, 'packages/plugin/.claude-plugin/plugin.json'), 'utf8'),
    ).version;
    expect(reply.result.serverInfo.version).toBe(pluginVersion);
  });

  it('fails loudly, not silently, when no node exists anywhere', async () => {
    // The fixed fallback locations are baked into the script, and a CI runner has
    // a real /usr/bin/node — so the environment alone cannot produce "no node
    // anywhere" portably. Run a copy with those paths redirected at nothing.
    // Trade-off: this exercises the failure branch and its message, but not the
    // literal contents of the candidate list.
    const dir = mkdtempSync(join(tmpdir(), 'lf-launcher-'));
    const stripped = readFileSync(LAUNCHER, 'utf8').replace(
      /^(\s*)(\/opt\/homebrew|\/usr\/local|\/usr|\/snap)\/bin\/node(\s*\\?)$/gm,
      '$1/nonexistent$2/bin/node$3',
    );
    const copy = join(dir, 'launcher.sh');
    writeFileSync(copy, stripped);
    // Non-vacuity: if the rewrite silently matched nothing, this test would be
    // asserting against the unmodified script and could never fail for the right reason.
    expect(stripped).not.toBe(readFileSync(LAUNCHER, 'utf8'));
    expect(stripped).toContain('/nonexistent/usr/bin/node');

    const child = await new Promise<{ code: number | null; stderr: string }>((res) => {
      const c = spawn('/bin/sh', [copy, BUNDLE], {
        // HOME has no .nvm, PATH has no node, and the fallbacks now point nowhere.
        env: { PATH: join(dir, 'empty-bin'), HOME: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      c.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      c.on('close', (code) => res({ code, stderr }));
    });

    expect(child.code).toBe(127);
    expect(child.stderr).toContain('could not find a node binary');
  });
});

describe('plugin MCP registration', () => {
  const config = JSON.parse(readFileSync(MCP_JSON, 'utf8'));
  const server = config.mcpServers['live-feedback'];

  it('does not invoke a bare interpreter name from PATH', () => {
    // The regression itself: `command` must be an absolute path, since whatever
    // PATH the session inherited is exactly what cannot be trusted here.
    expect(server.command.startsWith('/')).toBe(true);
    expect(server.command).not.toBe('node');
  });

  it('keeps the server name that existing tool permissions are keyed to', () => {
    // Approved entries across the fleet read mcp__plugin_live-feedback_live-feedback__*.
    // Renaming this key silently invalidates every one of them.
    expect(Object.keys(config.mcpServers)).toEqual(['live-feedback']);
  });
});
