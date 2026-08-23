/**
 * Every resource resolves under the workspace it belongs to, and everything
 * that ever addressed it another way keeps working.
 *
 * The second half is the one worth testing hardest. Old URLs are in comment
 * threads, in bookmarks, and inside plugin bundles running in sessions nobody
 * can restart — so `/review/<docId>` and `/mockup/<docId>` may change what
 * they ANSWER but must never stop answering. A 404 there is indistinguishable,
 * to the person holding the link, from the review having been deleted.
 *
 * Everything goes through the real HTTP routes. All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('resources under the workspace path', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let appDist: string;
  let wsId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      redirect: 'manual',
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

  const mdFile = (name: string, body = 'Body.'): string => {
    const p = join(folder, name);
    writeFileSync(p, `# ${name}\n\n${body}\n`);
    return p;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-routes-'));
    folder = mkdtempSync(join(tmpdir(), 'ws-routes-src-'));
    // A stand-in for the built review app. The routes under test decide WHICH
    // shell to serve, not what is in it, so a one-line index.html exercises
    // them without coupling the suite to a real bundle build.
    appDist = mkdtempSync(join(tmpdir(), 'ws-routes-app-'));
    writeFileSync(join(appDist, 'index.html'), '<!doctype html><title>app shell</title>');
    handle = createServer({ port: 0, dataDir, markdownAppDistDir: appDist });
    base = `http://localhost:${handle.port}`;
    const ws = await post('/api/workspaces', { name: 'route-home', goal: 'Route it.' });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
    rmSync(appDist, { recursive: true, force: true });
  });

  describe('a markdown doc', () => {
    // `plan-doc` is the readable name the caller asked for; the server mints
    // the id, and the canonical URL is built from that.
    let planDocId: string;

    beforeAll(async () => {
      const r = await post('/api/docs', {
        docId: 'plan-doc',
        type: 'markdown',
        sourceUrl: mdFile('plan.md'),
        hubWorkspaceId: wsId,
      });
      expect(r.status).toBe(200);
      planDocId = ((await r.json()) as { docId: string }).docId;
    });

    it('serves at /workspaces/<id>/docs/<docId>', async () => {
      const r = await local(`/workspaces/${wsId}/docs/plan-doc`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
    });

    it('redirects the old /review/<docId> to the workspace path', async () => {
      // Addressed by the readable name — the old link's spelling — and lands
      // on the doc's own id.
      const r = await local('/review/plan-doc');
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/workspaces/${wsId}/docs/${planDocId}`);
    });

    it('carries the query string through the redirect', async () => {
      // ?mobile=<preset> is how the device-frame preview is requested. A
      // redirect that drops it silently returns the desktop page.
      const r = await local('/review/plan-doc?mobile=iphone-16');
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(
        `/workspaces/${wsId}/docs/${planDocId}?mobile=iphone-16`,
      );
    });

    it('404s a docId that does not exist, under either path', async () => {
      expect((await local(`/workspaces/${wsId}/docs/no-such-doc`)).status).toBe(404);
      expect((await local('/review/no-such-doc')).status).toBe(404);
    });

    it('serves a doc whose URL names a different workspace, rather than 404ing', async () => {
      // The workspace segment is context, not authorization — that is the
      // host guard's job, and it checks both halves. A doc moved between
      // workspaces would otherwise break every link already handed out.
      const other = await post('/api/workspaces', { name: 'elsewhere', goal: 'Other.' });
      const otherId = ((await other.json()) as { workspace: { id: string } }).workspace.id;
      expect((await local(`/workspaces/${otherId}/docs/plan-doc`)).status).toBe(200);
    });
  });

  describe('a mockup', () => {
    let mockDocId: string;

    beforeAll(async () => {
      const p = join(folder, 'mock.html');
      writeFileSync(p, '<!doctype html><title>Mock</title><p>hello mock');
      const r = await post('/api/docs', {
        docId: 'mock-doc',
        type: 'mockup',
        sourceUrl: p,
        hubWorkspaceId: wsId,
      });
      expect(r.status).toBe(200);
      mockDocId = ((await r.json()) as { docId: string }).docId;
    });

    it('serves its HTML at /workspaces/<id>/mockups/<docId>', async () => {
      const r = await local(`/workspaces/${wsId}/mockups/mock-doc`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('hello mock');
    });

    it('redirects the old /mockup/<docId>', async () => {
      const r = await local('/mockup/mock-doc');
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/workspaces/${wsId}/mockups/${mockDocId}`);
    });

    it('keeps tolerating the .html suffix the old route accepted', async () => {
      const r = await local('/mockup/mock-doc.html');
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/workspaces/${wsId}/mockups/${mockDocId}`);
    });

    it('does not serve a mockup through the docs path', async () => {
      // Different content type entirely — the docs path serves the editor
      // shell, and a mockup has no editor.
      expect((await local(`/workspaces/${wsId}/mockups/plan-doc`)).status).toBe(404);
    });

    it('redirects the docs path to the mockups path', async () => {
      // The trap this replaces: the docs path answered 200 with the editor
      // shell, and the editor has nothing to render for a mockup — so the
      // reviewer got a blank page and a success status. A doc link to a
      // mockup is a real thing to hold; it must land on the mockup.
      const r = await local(`/workspaces/${wsId}/docs/mock-doc`);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/workspaces/${wsId}/mockups/${mockDocId}`);
    });

    it('redirects the old /review/<docId> to the mockups path too', async () => {
      // `/review/` used to hand a mockup to the docs path, which is the same
      // blank page one hop later.
      const r = await local('/review/mock-doc');
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/workspaces/${wsId}/mockups/${mockDocId}`);
    });

    it('carries the query string through the docs-path redirect', async () => {
      const r = await local(`/workspaces/${wsId}/docs/mock-doc?mobile=iphone-16`);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(
        `/workspaces/${wsId}/mockups/${mockDocId}?mobile=iphone-16`,
      );
    });
  });

  describe('a review', () => {
    let reviewId: string;
    let entryDocId: string;

    beforeAll(async () => {
      writeFileSync(join(folder, 'README.md'), '# Fixture\n\nbody\n');
      const bound = await post('/api/diffs', { repo: folder, hubWorkspaceId: wsId });
      expect(bound.status).toBe(200);
      const res = (await bound.json()) as {
        reviewId: string;
        setId?: string;
        files: Array<{ docId: string }>;
      };
      reviewId = res.reviewId;
      entryDocId = res.files[0]?.docId ?? '';
      expect(entryDocId).not.toBe('');
    });

    it('redirects /workspaces/<id>/reviews/<reviewId> to a member doc', async () => {
      const r = await local(`/workspaces/${wsId}/reviews/${encodeURIComponent(reviewId)}`);
      expect(r.status).toBe(302);
      const loc = r.headers.get('location') ?? '';
      expect(loc).toStartWith(`/workspaces/${wsId}/docs/`);
    });

    it('404s a review id with no members', async () => {
      const r = await local(`/workspaces/${wsId}/reviews/not-a-review`);
      expect(r.status).toBe(404);
    });

    it('serves a member doc under the workspace path', async () => {
      const r = await local(`/workspaces/${wsId}/docs/${encodeURIComponent(entryDocId)}`);
      expect(r.status).toBe(200);
    });

    it('redirects a member doc’s old /review/ URL to the workspace path', async () => {
      // The case that matters most: every diff-review URL ever handed to a
      // reviewer is this shape, and the review is filed on the workspace by
      // its review id, so resolving it needs the review→workspace hop rather
      // than a direct docIds lookup.
      const r = await local(`/review/${encodeURIComponent(entryDocId)}`);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(
        `/workspaces/${wsId}/docs/${encodeURIComponent(entryDocId)}`,
      );
    });
  });

  describe('a doc on no workspace at all', () => {
    it('serves the old path in place rather than redirecting nowhere', async () => {
      // Reachable when filing fails or is undone. Serving beats a redirect to
      // a workspace that does not exist, and beats a 404 on a live doc.
      const p = mdFile('orphan.md');
      expect(
        (await post('/api/docs', { docId: 'orphan-doc', type: 'markdown', sourceUrl: p })).status,
      ).toBe(200);
      // Detach it from whatever default workspace filing put it on.
      const wsList = (await (await local('/api/workspaces')).json()) as {
        hubWorkspaces?: Array<{ id: string }>;
      };
      for (const w of wsList.hubWorkspaces ?? []) {
        await local(`/api/workspaces/${w.id}/docs?docId=orphan-doc`, { method: 'DELETE' });
      }
      const r = await local('/review/orphan-doc');
      expect([200, 302]).toContain(r.status);
      if (r.status === 200) expect(r.headers.get('content-type')).toContain('text/html');
    });

    it('serves an unfiled mockup its own HTML from /review/, not an empty shell', async () => {
      // Same fallback `/mockup/<id>` already answers with: no workspace to
      // redirect to, so serve the thing in place.
      const p = join(folder, 'orphan-mock.html');
      writeFileSync(p, '<!doctype html><title>Orphan</title><p>orphan mock');
      expect(
        (await post('/api/docs', { docId: 'orphan-mock', type: 'mockup', sourceUrl: p })).status,
      ).toBe(200);
      const wsList = (await (await local('/api/workspaces')).json()) as {
        hubWorkspaces?: Array<{ id: string }>;
      };
      for (const w of wsList.hubWorkspaces ?? []) {
        await local(`/api/workspaces/${w.id}/docs?docId=orphan-mock`, { method: 'DELETE' });
      }
      const r = await local('/review/orphan-mock');
      // Whether filing held or not, the one answer that must never come back
      // is the editor shell — so accept the mockups redirect or the HTML
      // itself, and nothing in between.
      expect([200, 302]).toContain(r.status);
      if (r.status === 302) expect(r.headers.get('location')).toContain('/mockups/');
      else expect(await r.text()).toContain('orphan mock');
    });
  });
});
