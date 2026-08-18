/**
 * The layer nothing type-checks: `bin.ts` hand-parses argv, so `--deploy`
 * can be declared and silently dropped — and this repo has shipped exactly
 * that bug at the route layer.
 *
 * Both arms run against a REAL spawned `bin.ts`, because the claim under
 * test is about the seam: a server that was not told it is the deploy must
 * not be able to pull or restart anything, and the flag that tells it must
 * actually arrive.
 *
 * Neither arm ever POSTs to /api/deploy. A GET is read-only by construction
 * (it reports the last result and runs nothing), which is precisely what
 * makes it safe to point at a process that IS holding a real deployer.
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

async function withServer(
  extraArgs: string[],
  body: (port: number, headers: Record<string, string>) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'lf-deploy-wiring-'));
  const port = 9700 + Math.floor(Math.random() * 250);
  const child = spawn(
    'bun',
    [
      'run',
      join(repoRoot, 'packages', 'server', 'src', 'bin.ts'),
      '--port',
      String(port),
      '--data-dir',
      dataDir,
      ...extraArgs,
    ],
    { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, LF_SUMMARIES: '0' } },
  );
  const headers = { host: `localhost:${port}`, 'content-type': 'application/json' };
  try {
    // Positive control: wait until the process is answering SOMETHING, so an
    // assertion about /api/deploy is never really an assertion about a dead
    // port. `/api/docs` is a peer route with no bearing on deploying.
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        up = (await fetch(`http://127.0.0.1:${port}/api/docs`, { headers })).ok;
      } catch {}
    }
    expect(up).toBe(true);
    await body(port, headers);
  } finally {
    child.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('bin.ts --deploy', () => {
  it('a server that was not told it is the deploy refuses to be one', async () => {
    await withServer([], async (port, headers) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/deploy`, { headers });
      expect(res.status).toBe(501);
      expect(((await res.json()) as { error: string }).error).toContain('not enabled');
    });
  }, 25_000);

  it('and one that was told, answers as the deploy', async () => {
    // Read-only: `deploy: null` says a deployer exists and has never run.
    // A 501 here would mean prod's flag never reaches the server and the
    // whole feature is dead on the one machine it is for.
    await withServer(['--deploy'], async (port, headers) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/deploy`, { headers });
      expect(res.status).toBe(200);
      expect((await res.json()) as { deploy: unknown }).toEqual({ deploy: null });
    });
  }, 25_000);
});
