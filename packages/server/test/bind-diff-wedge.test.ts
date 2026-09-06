/**
 * Binding a diff over a tree that has stopped answering.
 *
 * `hydrate-wedge-unprewarmed.test.ts` covers the hydration doors. This covers
 * the other half of the same hazard: a BIND, which is the one operation that
 * opens many caller-supplied paths in a row. `create_diff_review` walks every
 * changed file in a repository the caller named, and until this was fixed each
 * one of them was a `readFileSync` on the main thread — so a single file in a
 * cloud-sync folder whose provider had stopped answering parked the whole
 * server for the length of one bind, and a bigger review meant more chances to
 * do it.
 *
 * A FIFO with no writer reproduces the sick provider exactly: `stat` answers,
 * `open` blocks until somebody opens the other end, and nobody here ever does.
 * `git diff --name-status` still lists such a file as modified (its `--numstat`
 * pass fails cleanly and the review simply carries no line counts), so the bind
 * reaches the read with a member it fully intends to open.
 *
 * The repository, its files and its contents are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { makeFifo, releaseFifosIn } from './fifo.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * The budget an unrelated route has while the bind is parked on a file that
 * will not answer.
 *
 * The supervisor's liveness check is a TCP bind probe rather than an HTTP
 * route, so what this is really asking is whether the event loop is still
 * running. `GET /api/docs` reads the index and hydrates nothing, so the only
 * thing that can delay it is a blocked loop — and 100ms is two orders of
 * magnitude under the read deadline the bind is waiting out.
 */
const HEALTH_MS = 100;

function git(repo: string, args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
}

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('binding a diff over a tree that has stopped answering', () => {
  let dataDir: string;
  let repo: string;
  let wedged: string;
  let readable: string;
  let handle: ServerHandle | undefined;

  beforeEach(async () => {
    boundFiles.reset();
    dataDir = mkdtempSync(join(tmpdir(), 'bind-wedge-data-'));
    repo = mkdtempSync(join(tmpdir(), 'bind-wedge-repo-'));
    wedged = join(repo, 'meeting-notes.md');
    readable = join(repo, 'agenda.md');

    git(repo, ['init', '-q', '.']);
    git(repo, ['config', 'user.email', 'reviewer@example.invalid']);
    git(repo, ['config', 'user.name', 'Test Reviewer']);
    writeFileSync(wedged, '# Meeting notes\n\nThe committed version.\n');
    writeFileSync(readable, '# Agenda\n\nOne committed item.\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'base']);

    // The folder goes bad under one of the two changed files. It still exists
    // and still stats — which is what made the real failure invisible — but
    // `open` on it never returns. The other file changes normally, so the bind
    // has real work to finish once it has walked away from this one.
    unlinkSync(wedged);
    makeFifo(wedged);
    appendFileSync(readable, 'A second item.\n');
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    // A read parked on a pipe that has been unlinked can never be released,
    // and it owns its pool thread until it is. This throws rather than letting
    // the runner hang on one.
    await releaseFifosIn(repo);
    boundFiles.reset();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  /** An unrelated route answers within its budget; never rejects. */
  function healthAnswers(base: string): Promise<string> {
    const probe = fetch(`${base}/workspaces/${WS}/docs`).then((r) => `answered:${r.status}`);
    const tooSlow = new Promise<string>((resolve) =>
      setTimeout(() => resolve('wedged'), HEALTH_MS),
    );
    return Promise.race([probe, tooSlow]);
  }

  it('parks the file that will not answer and leaves the server answering', async () => {
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
    // Warm the route first. The very first request to a fresh server pays for
    // module loading and route compilation, and a budget this tight would
    // otherwise be measuring that rather than the event loop.
    expect((await fetch(`${base}/workspaces/${WS}/docs`)).status).toBe(200);

    // Caught, not bare: if the assertion below fails, `afterEach` stops the
    // server while this is still in flight, and a bare rejection would be
    // reported against whichever test runs next.
    const bind = fetch(`${base}/workspaces/${WS}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, base: 'HEAD' }),
    }).catch((err: unknown) => err as Error);

    // The assertion the incident is about. Nothing in this request touches the
    // review; if the bind is holding the only thread that runs JavaScript, it
    // cannot be served at all.
    expect(await healthAnswers(base)).toBe('answered:200');

    const res = await bind;
    if (res instanceof Error) throw res;
    expect(res.status).toBeLessThan(500);
    const body = (await res.json()) as {
      ok?: boolean;
      files?: Array<{ relPath: string }>;
      skipped?: Array<{ path: string; reason: string }>;
    };

    // The bind finishes, and finishes HONESTLY: the file that would not answer
    // is reported as skipped rather than bound to content nobody read, and the
    // healthy file beside it is a member.
    expect(body.ok).toBe(true);
    expect(body.skipped?.map((s) => s.path)).toContain('meeting-notes.md');
    expect(body.files?.map((f) => f.relPath)).toEqual(['agenda.md']);
    // And the pool knows why, so the next caller does not pay the deadline.
    expect(boundFiles.quarantined(wedged)).toBe(true);
  });

  it('positive control: the same bind reads the same tree when the file answers', async () => {
    // Without this the test above would pass on a server that had simply
    // stopped binding anything at all.
    unlinkSync(wedged);
    writeFileSync(wedged, '# Meeting notes\n\nThe committed version.\nA new line.\n');

    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);

    const res = await fetch(`${base}/workspaces/${WS}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, base: 'HEAD' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      files?: Array<{ docId: string; relPath: string }>;
      skipped?: Array<{ path: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.files?.map((f) => f.relPath).sort()).toEqual(['agenda.md', 'meeting-notes.md']);
    expect(body.skipped ?? []).toEqual([]);
    expect(boundFiles.quarantined(wedged)).toBe(false);

    // Bound to the real file, with the real bytes — so the door did a read
    // rather than merely declining to hang.
    const member = body.files?.find((f) => f.relPath === 'meeting-notes.md');
    expect(member).toBeDefined();
    expect(handle.docStore.boundPathOf(member?.docId ?? '')).toBe(wedged);
  });
});
