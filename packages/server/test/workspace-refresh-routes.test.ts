/**
 * The workspace-refresh surface, driven through the real route table.
 *
 * These routes exist so a review can OUTLIVE the churn inside it: a refresh
 * that reconciles membership without re-minting docIds, and a regroup that
 * doesn't require tearing the review down. The route layer is the one that
 * nothing type-checks (it hand-copies body fields), so each one gets an
 * HTTP-level test, not just a unit test against Rooms.
 *
 * A third route used to be covered here — `GET /s/:slug` re-resolving a
 * share's ENTRY DOC at redemption, so a renamed entry file did not leave the
 * link pointing at nothing. That whole describe block was removed with
 * board-only sharing rather than migrated: a BOARD is the unit of sharing, a
 * board share lands on `/workspaces/<id>`, and a board has no entry doc for
 * anything to resolve. The capability is gone, not broken — `resolveShareEntry`
 * and the `currentWorkspaceEntry` / `liveFileEntry` / `repairStaleReviewUrl`
 * closures went with it — so there is nothing left for those tests to assert.
 * What replaced the behaviour they guarded is asserted where it now lives:
 * redemption landing on the board (link-share.test.ts,
 * grouping-share-removed.test.ts) and a stale `/review/<docId>` getting the
 * ordinary out-of-scope 403, indistinguishable from a doc in someone else's
 * workspace (host-scope.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const PUBLIC_HOST = 'feedback.example.com';

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

describe('workspace refresh routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let repo: string;
  let repoBase: string;
  let base: string;
  let workspaceId: string;
  let reviewId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wsr-data-'));
    folder = mkdtempSync(join(tmpdir(), 'wsr-folder-'));
    repo = mkdtempSync(join(tmpdir(), 'wsr-repo-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nRead me.\n');
    writeFileSync(join(folder, 'design.md'), '# Design\n\nThe plan.\n');

    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(repo, 'test', 'a.test.ts'), 'check a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    repoBase = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 2;\n');

    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    const bind = await post('/api/workspaces', { folderPath: folder });
    workspaceId = ((await bind.json()) as { workspaceId: string }).workspaceId;

    const diff = await post('/api/diffs', { repo, base: repoBase });
    reviewId = ((await diff.json()) as { reviewId: string }).reviewId;
  });

  afterAll(async () => {
    await handle.stop();
    for (const d of [dataDir, folder, repo]) rmSync(d, { recursive: true, force: true });
  });

  describe('POST /api/workspaces/:id/refresh', () => {
    it('404s an unknown workspace', async () => {
      const r = await post('/api/workspaces/nope/refresh', {});
      expect(r.status).toBe(404);
    });

    it('reports a renamed browse member as stale and keeps its doc', async () => {
      const opened = await post(`/api/workspaces/${workspaceId}/context-file`, {
        relPath: 'design.md',
      });
      expect(opened.status).toBe(200);
      const docId = ((await opened.json()) as { docId: string }).docId;

      renameSync(join(folder, 'design.md'), join(folder, 'design-v2.md'));
      const r = await post(`/api/workspaces/${workspaceId}/refresh`, {});
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        kind: string;
        stale: Array<{ docId: string; relPath: string; openThreads: number }>;
      };
      expect(body.kind).toBe('browse');
      expect(body.stale).toEqual([{ docId, relPath: 'design.md', openThreads: 0 }]);

      // The doc survives — only the marker changed.
      const doc = await local(`/api/docs/${encodeURIComponent(docId)}`);
      expect(doc.status).toBe(200);
      expect(((await doc.json()) as { meta: { stale?: boolean } }).meta.stale).toBe(true);

      renameSync(join(folder, 'design-v2.md'), join(folder, 'design.md'));
      const back = await post(`/api/workspaces/${workspaceId}/refresh`, {});
      expect(((await back.json()) as { restored: unknown[] }).restored).toHaveLength(1);
    });

    it('adds a file that changed after the diff review was created', async () => {
      writeFileSync(join(repo, 'test', 'a.test.ts'), 'check a harder\n');
      const r = await post(`/api/workspaces/${reviewId}/refresh`, {});
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        kind: string;
        added: Array<{ relPath: string }>;
        fileCount: number;
      };
      expect(body.kind).toBe('diff');
      expect(body.added.map((a) => a.relPath)).toEqual(['test/a.test.ts']);
      expect(body.fileCount).toBe(2);
    });
  });

  describe('POST /api/workspaces/:id/groups', () => {
    it('rejects a missing groups array rather than silently regrouping', async () => {
      const r = await post(`/api/workspaces/${reviewId}/groups`, {});
      expect(r.status).toBe(400);
    });

    it('regroups in place and the grouped view reflects it', async () => {
      const r = await post(`/api/workspaces/${reviewId}/groups`, {
        groups: [
          { title: 'The change', paths: ['src'], details: 'what actually moved' },
          { title: 'Coverage', paths: ['test'] },
        ],
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { groups: Array<{ title: string; fileCount: number }> };
      expect(body.groups.map((g) => g.title)).toEqual(['The change', 'Coverage']);

      const grouped = await local(`/api/workspaces/${reviewId}/grouped`);
      const view = (await grouped.json()) as {
        groups: Array<{ title: string; details?: string }>;
      };
      expect(view.groups.map((g) => g.title)).toEqual(['The change', 'Coverage']);
      expect(view.groups[0]?.details).toBe('what actually moved');
    });

    it('400s a malformed group WITHOUT poisoning the workspace', async () => {
      // The route only knows `groups` is an array — everything about what is
      // inside it is checked below it. A bad spec used to be persisted before
      // the assignment threw, which left refresh permanently broken.
      const r = await post(`/api/workspaces/${reviewId}/groups`, {
        groups: [{ title: 'No paths' }],
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('bad-groups');
      // …and the review still refreshes.
      const after = await post(`/api/workspaces/${reviewId}/refresh`, {});
      expect(after.status).toBe(200);
    });

    it('rejects an over-long details intro', async () => {
      const r = await post(`/api/workspaces/${reviewId}/groups`, {
        groups: [{ title: 'Long', paths: ['src'], details: 'x'.repeat(501) }],
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('group-details-too-long');
    });
  });
});
