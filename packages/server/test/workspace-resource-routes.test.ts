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
import { seedBoard } from './workspace-seed.ts';

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

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
    WS = await seedBoard(base);
    const ws = await post('/workspaces', { name: 'route-home', goal: 'Route it.' });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    WS = wsId;
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
      const r = await post(`/workspaces/${wsId}/docs`, {
        docId: 'plan-doc',
        type: 'markdown',
        sourceUrl: mdFile('plan.md'),
      });
      expect(r.status).toBe(200);
      planDocId = ((await r.json()) as { docId: string }).docId;
    });

    it('serves at /workspaces/<id>/docs/<docId>', async () => {
      const r = await local(`/workspaces/${wsId}/docs/plan-doc`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
    });

    it('404s the address it used to have — the old path is deleted', async () => {
      // Not a redirect and not a 410. A redirect keeps `/review/<id>` working,
      // so nothing that emits it is ever rewritten and the second address
      // stays in the product for as long as the redirect does. Both spellings
      // the old link could carry — the readable name and the minted id — get
      // the same 404.
      expect((await local('/review/plan-doc')).status).toBe(404);
      expect((await local(`/review/${planDocId}`)).status).toBe(404);
      expect((await local('/review/plan-doc?mobile=iphone-16')).status).toBe(404);
    });

    it('404s a docId that does not exist', async () => {
      expect((await local(`/workspaces/${wsId}/docs/no-such-doc`)).status).toBe(404);
    });

    it('404s a doc under a workspace that does not hold it — the segment IS the check', async () => {
      // THE BEHAVIOUR CHANGE, and the point of the whole cutover. This used to
      // serve: the workspace segment was context and the host guard did the
      // authorizing, so any board id in front of any doc id opened the doc.
      // Now the segment is the check — one middleware resolves the board and
      // refuses a doc that is not filed on it — and the refusal is a 404
      // rather than a 403, so a board id that turns out to be real learns
      // nothing from being real.
      const other = await post('/workspaces', { name: 'elsewhere', goal: 'Other.' });
      const otherId = ((await other.json()) as { workspace: { id: string } }).workspace.id;
      expect((await local(`/workspaces/${otherId}/docs/plan-doc`)).status).toBe(404);
      // Positive control: the same doc under the board that DOES hold it is
      // still served, so the 404 above is the pair and not a broken route.
      expect((await local(`/workspaces/${wsId}/docs/plan-doc`)).status).toBe(200);
    });
  });

  describe('a mockup', () => {
    let mockDocId: string;

    beforeAll(async () => {
      const p = join(folder, 'mock.html');
      writeFileSync(p, '<!doctype html><title>Mock</title><p>hello mock');
      const r = await post(`/workspaces/${wsId}/docs`, {
        docId: 'mock-doc',
        type: 'mockup',
        sourceUrl: p,
      });
      expect(r.status).toBe(200);
      mockDocId = ((await r.json()) as { docId: string }).docId;
    });

    it('serves its HTML at /workspaces/<id>/mockups/<docId>', async () => {
      const r = await local(`/workspaces/${wsId}/mockups/mock-doc`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('hello mock');
    });

    it('404s the old /mockup/<docId>, suffix and all', async () => {
      // Including `.html`, which that route tolerated because agents shared
      // whichever URL felt natural. Both are gone, and a mockup is reached at
      // `/workspaces/<ws>/mockups/<id>` like every other resource.
      expect((await local('/mockup/mock-doc')).status).toBe(404);
      expect((await local('/mockup/mock-doc.html')).status).toBe(404);
      expect((await local(`/mockup/${mockDocId}`)).status).toBe(404);
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
      const bound = await post(`/workspaces/${WS}/reviews`, { repo: folder, hubWorkspaceId: wsId });
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

    it('404s a member doc’s old /review/ URL', async () => {
      // The case that cost the most to give up, said out loud: every
      // diff-review URL ever handed to a reviewer is this shape. They break,
      // by decision — the cutover ships as one version bump with a session
      // restart behind it, and a redirect would have kept the old shape alive
      // in every comment thread that carries one.
      expect((await local(`/review/${encodeURIComponent(entryDocId)}`)).status).toBe(404);
      // Positive control: the doc itself is fine at its canonical address, so
      // the 404 is the deleted route and not a broken review.
      expect(
        (await local(`/workspaces/${wsId}/docs/${encodeURIComponent(entryDocId)}`)).status,
      ).toBe(200);
    });
  });

  describe('a doc on no workspace at all', () => {
    it('has no address — every spelling 404s, and that is the useful answer', async () => {
      // Reachable when filing fails or is undone. `/review/<id>` used to serve
      // it in place, which is what made "unfiled" survivable: the doc still
      // had a URL, so nobody ever noticed it belonged nowhere. It has none
      // now, and the 404 is the prompt to file it on a board — the thing the
      // caller has to do anyway before handing the link to a person.
      const p = mdFile('orphan.md');
      const made = await post(`/workspaces/${WS}/docs`, {
        docId: 'orphan-doc',
        type: 'markdown',
        sourceUrl: p,
      });
      expect(made.status).toBe(200);
      const orphanId = ((await made.json()) as { docId: string }).docId;
      // Unfile it from every board, through the store: there is no route that
      // detaches a doc from a board, which is itself part of why "unfiled" was
      // a state nobody met — `/review/<id>` served one, so it never showed.
      for (const w of handle.tasks.listWorkspaces()) {
        handle.tasks.detachDoc(w.id, orphanId);
      }
      expect((await local('/review/orphan-doc')).status).toBe(404);
      // …and under a board that exists but does not hold it, which is the
      // only other spelling there is.
      expect((await local(`/workspaces/${wsId}/docs/orphan-doc`)).status).toBe(404);
    });
  });
});
