/**
 * Doc ids: opaque minting, the readable-alias layer, and the two namespace
 * holes that let a caller write into a server-owned namespace.
 *
 * The holes are reproduced through the real route table rather than against
 * the helpers, because both of them are exactly the case where a helper's
 * contract and the route's behaviour disagreed.
 *
 * All fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';
import { writeLegacyYdoc } from './doc-id-fixture.ts';

const AGENT = { id: 'agent-fixture', name: 'Fixture Agent', kind: 'known', color: '#888888' };

describe('doc ids', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;

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

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'docid-data-'));
    folder = mkdtempSync(join(tmpdir(), 'docid-src-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nRead me.\n');
    writeFileSync(join(folder, 'notes.md'), '# Notes\n\nSome notes.\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    for (const d of [dataDir, folder]) rmSync(d, { recursive: true, force: true });
  });

  const listDocIds = async (): Promise<string[]> => {
    const r = await local('/api/docs');
    const { docs } = (await r.json()) as { docs: Array<{ docId: string }> };
    return docs.map((d) => d.docId);
  };

  // ---------------------------------------------------------------- hole (a)
  describe('a caller cannot bind a folder into the task namespace', () => {
    it('refuses a setId that would mint member docs under `task:`', async () => {
      const r = await post('/api/workspaces', { folderPath: folder, setId: 'task' });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('reserved-namespace');

      // Nothing was created on the way to the refusal.
      expect(await listDocIds()).not.toContain('task:README.md');
    });

    it('positive control: an ordinary setId still binds and still mints members', async () => {
      const r = await post('/api/workspaces', { folderPath: folder, setId: 'notes-review' });
      expect(r.status).toBe(200);
      const ids = await listDocIds();
      expect(ids.some((id) => id.startsWith('notes-review:'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------- hole (b)
  describe('a caller cannot address a task body as a doc it creates', () => {
    it('refuses POST /api/docs for a `task:<taskId>` docId, leaving the description intact', async () => {
      const ws = (await (await post('/api/workspaces', { name: 'doc-id-fixture' })).json()) as {
        workspace: { id: string };
      };
      const { task } = (await (
        await post(`/api/workspaces/${ws.workspace.id}/tasks`, {
          author: AGENT,
          title: 'Keep this description',
          body: 'The original body, which must survive the attempted overwrite.',
        })
      ).json()) as { task: Task };

      const decoy = join(folder, 'decoy.md');
      writeFileSync(decoy, '# Replaced\n\nThe attacker-supplied body.\n');

      const r = await post('/api/docs', {
        docId: `task:${task.id}`,
        type: 'markdown',
        sourceUrl: decoy,
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('reserved-namespace');

      // The description is untouched...
      const listed = (await (await local(`/api/workspaces/${ws.workspace.id}/tasks`)).json()) as {
        tasks: Task[];
      };
      expect(listed.tasks.find((t) => t.id === task.id)?.body).toContain('must survive');

      // ...and the body room was never bound to the decoy file, which is the
      // half that would have kept writing after the request returned.
      const status = (await (
        await local(`/api/docs/${encodeURIComponent(`task:${task.id}`)}/status`)
      ).json()) as { path?: string };
      expect(status.path).toBeUndefined();
    });

    it('positive control: an ordinary docId still binds and still accepts content', async () => {
      const r = await post('/api/docs', {
        docId: 'ordinary-doc',
        type: 'markdown',
        sourceUrl: join(folder, 'notes.md'),
      });
      expect(r.status).toBe(200);
      const { docId } = (await r.json()) as { docId: string };

      const content = await local(`/api/docs/${encodeURIComponent(docId)}/content`);
      expect(content.status).toBe(200);
      expect(((await content.json()) as { plainText: string }).plainText).toContain('Some notes');
    });
  });

  // ------------------------------------------------------------------ minting
  describe('the server mints a doc id and the caller names an alias', () => {
    it('mints an opaque id; the requested docId is not the doc id', async () => {
      const r = await post('/api/docs', {
        docId: 'my-readable-plan',
        type: 'markdown',
        sourceUrl: join(folder, 'notes.md'),
      });
      expect(r.status).toBe(200);
      const { docId } = (await r.json()) as { docId: string };
      expect(docId).not.toBe('my-readable-plan');
      expect(docId).toMatch(/^d-[A-Za-z0-9_-]{12}$/);
    });

    it('resolves the readable alias to the minted doc', async () => {
      const created = (await (
        await post('/api/docs', {
          docId: 'aliased-plan',
          type: 'markdown',
          sourceUrl: join(folder, 'notes.md'),
        })
      ).json()) as { docId: string };

      const viaAlias = await local('/api/docs/aliased-plan');
      expect(viaAlias.status).toBe(200);
      // The canonical id comes back, not the alias that was used to ask.
      expect(((await viaAlias.json()) as { meta: { docId: string } }).meta.docId).toBe(
        created.docId,
      );
    });

    it('is idempotent: re-creating under the same alias reuses the same doc', async () => {
      const first = (await (
        await post('/api/docs', {
          docId: 'stable-alias',
          type: 'markdown',
          sourceUrl: join(folder, 'notes.md'),
        })
      ).json()) as { docId: string };
      const second = (await (
        await post('/api/docs', {
          docId: 'stable-alias',
          type: 'markdown',
          sourceUrl: join(folder, 'README.md'),
        })
      ).json()) as { docId: string };

      expect(second.docId).toBe(first.docId);
      expect((await listDocIds()).filter((id) => id === first.docId)).toHaveLength(1);
    });

    it('never repoints an alias: a second doc cannot claim a taken name', async () => {
      const first = (await (
        await post('/api/docs', {
          docId: 'contested-name',
          type: 'markdown',
          sourceUrl: join(folder, 'notes.md'),
        })
      ).json()) as { docId: string };

      // Same alias, different source file — the only shape that could repoint.
      const second = (await (
        await post('/api/docs', {
          docId: 'contested-name',
          type: 'markdown',
          sourceUrl: join(folder, 'README.md'),
        })
      ).json()) as { docId: string };
      expect(second.docId).toBe(first.docId);

      // And the alias still names the doc it was minted with.
      const viaAlias = await local('/api/docs/contested-name');
      expect(((await viaAlias.json()) as { meta: { docId: string } }).meta.docId).toBe(first.docId);
    });

    /**
     * The test above cannot reach the refusal, and that is worth saying: with
     * both docs live, the second create RESOLVES the name to the first doc
     * and never claims anything, so the write-once rule is never consulted.
     * Verified by allowing a repoint in `claimAlias` and watching that test
     * stay green.
     *
     * Two docs really can carry one alias, and this is how: a doc is
     * archived, which releases its name; something else takes the name while
     * it is away; then it comes back. Both `.ydoc`s now say `alias: 'x'` and
     * one of them has to lose. The holder keeps it — the returning doc does
     * not get to silently redirect a name somebody has been linking to.
     */
    it('a doc returning from the archive does not take back a name someone else now holds', async () => {
      const first = (await (
        await post('/api/docs', {
          docId: 'reclaimed-name',
          type: 'markdown',
          sourceUrl: join(folder, 'notes.md'),
        })
      ).json()) as { docId: string };

      await post(`/api/docs/${encodeURIComponent(first.docId)}/archive`, {
        author: { id: 'known-t', name: 'Tester', kind: 'known', color: '#2e7dd7' },
      });

      // With the first doc away, the name is free and a NEW doc takes it.
      const second = (await (
        await post('/api/docs', {
          docId: 'reclaimed-name',
          type: 'markdown',
          sourceUrl: join(folder, 'README.md'),
        })
      ).json()) as { docId: string };
      expect(second.docId).not.toBe(first.docId);

      await post(`/api/docs/${encodeURIComponent(first.docId)}/unarchive`, {
        author: { id: 'known-t', name: 'Tester', kind: 'known', color: '#2e7dd7' },
      });

      // Both docs exist and both carry the alias in their meta. It resolves
      // to the one that holds it, not to the one that just came back.
      const resolved = (await (await local('/api/docs/reclaimed-name')).json()) as {
        meta: { docId: string };
      };
      expect(resolved.meta.docId).toBe(second.docId);
      expect(resolved.meta.docId).not.toBe(first.docId);

      // Positive control: the returning doc is genuinely back and reachable
      // by its own id — so the assertion above is about the NAME, not about
      // the unarchive having failed.
      const byOwnId = await local(`/api/docs/${encodeURIComponent(first.docId)}`);
      expect(byOwnId.status).toBe(200);
    });

    it('a pre-migration doc keeps its own id even when a live alias spells the same', async () => {
      // The other way two docs can want one string: a doc whose PRIMARY id is
      // `taken-name` hydrates from disk while an alias of that name already
      // resolves elsewhere. The primary wins — it is the older address, and
      // the one already written down in links people saved.
      const aliased = (await (
        await post('/api/docs', {
          docId: 'taken-name',
          type: 'markdown',
          sourceUrl: join(folder, 'notes.md'),
        })
      ).json()) as { docId: string };

      await handle.stop();
      writeLegacyYdoc(dataDir, 'taken-name', join(folder, 'README.md'));
      handle = createServer({ port: 0, dataDir });
      base = `http://localhost:${handle.port}`;

      const resolved = (await (await local('/api/docs/taken-name')).json()) as {
        meta: { docId: string };
      };
      expect(resolved.meta.docId).toBe('taken-name');
      expect(resolved.meta.docId).not.toBe(aliased.docId);

      // Positive control: the aliased doc is still there under its own id.
      expect((await local(`/api/docs/${encodeURIComponent(aliased.docId)}`)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- migration
  describe('a review URL captured before the migration still resolves', () => {
    it('resolves /review/<caller-chosen-id> for a doc that predates minting', async () => {
      // A doc whose PRIMARY id is a caller-chosen string is exactly what every
      // pre-migration `.ydoc` on disk is. Write one, then bring a server up
      // over that data dir the way a restart would.
      await handle.stop();
      writeLegacyYdoc(dataDir, 'legacy-plan', join(folder, 'notes.md'));
      handle = createServer({ port: 0, dataDir });
      base = `http://localhost:${handle.port}`;

      // The id the captured URL carries still names the doc, and still reads.
      const meta = await local('/api/docs/legacy-plan');
      expect(meta.status).toBe(200);
      expect(((await meta.json()) as { meta: { docId: string } }).meta.docId).toBe('legacy-plan');
      const content = await local('/api/docs/legacy-plan/content');
      expect(content.status).toBe(200);
      expect(((await content.json()) as { plainText: string }).plainText).toContain('Some notes');

      // And the review URL itself resolves: filed on a board, `/review/<id>`
      // redirects to the canonical address rather than 404ing. (The 302 branch
      // is the only one observable headlessly — the 200 branch needs a built
      // client bundle, which a unit run has no reason to have.)
      const ws = (await (await post('/api/workspaces', { name: 'migration-board' })).json()) as {
        workspace: { id: string };
      };
      await post(`/api/workspaces/${ws.workspace.id}/docs`, { docId: 'legacy-plan' });
      const review = await local('/review/legacy-plan', { redirect: 'manual' });
      expect(review.status).toBe(302);
      expect(review.headers.get('location')).toContain('legacy-plan');
    });

    it('resolves /review/<alias> for a doc created after minting', async () => {
      const created = (await (
        await post('/api/docs', {
          docId: 'post-migration-plan',
          type: 'markdown',
          sourceUrl: join(folder, 'notes.md'),
        })
      ).json()) as { docId: string; hubWorkspaceId?: string };

      const review = await local('/review/post-migration-plan', { redirect: 'manual' });
      expect(review.status).toBe(302);
      // The redirect lands on the CANONICAL id, not the alias it was asked by.
      expect(review.headers.get('location')).toContain(created.docId);
    });
  });

  // ------------------------------------------------------------------- re-key
  describe('no API path changes an existing doc id', () => {
    it('keeps the minted id when the same doc is re-created under a new alias', async () => {
      const first = (await (
        await post('/api/docs', {
          docId: 'first-name',
          type: 'markdown',
          sourceUrl: join(folder, 'notes.md'),
        })
      ).json()) as { docId: string };

      // Binding the same FILE under a different requested name is the closest
      // thing the API has to a rename. It must not move the existing doc.
      const renamed = (await (
        await post('/api/docs', {
          docId: 'second-name',
          type: 'markdown',
          sourceUrl: join(folder, 'notes.md'),
        })
      ).json()) as { docId: string };

      const stillThere = await local(`/api/docs/${encodeURIComponent(first.docId)}`);
      expect(stillThere.status).toBe(200);
      expect(((await stillThere.json()) as { meta: { docId: string } }).meta.docId).toBe(
        first.docId,
      );
      expect(renamed.docId).not.toBe(first.docId);
    });
  });
});
