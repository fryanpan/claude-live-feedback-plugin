/**
 * Per-doc sharing is gone — a WORKSPACE is the unit of sharing.
 *
 * Bryan, 2026-08-17: "Remove all code for sharing docs, reviews and so on
 * individually. Share a workspace."
 *
 * Three things have to be true for that removal to be real, and each fails
 * differently:
 *
 *  1. Nothing can MINT a doc-scoped share any more — including an older
 *     plugin bundle, which keeps calling the shared :8787 routes with the
 *     payload ITS bundle sends long after this one stopped sending it. Every
 *     request below is transcribed verbatim from the committed bundle at
 *     0.1.41 (`packages/plugin/mcp/index.js`, `case "share_doc"` and
 *     `case "share_link"`), not from today's source.
 *
 *  2. A doc-scoped share already ON DISK stops being honoured. Removing the
 *     mint path alone would retire the feature everywhere except where it is
 *     actually exercised — the registry is what the gate reads.
 *
 *  3. The replacement still works. Every assertion here is an absence, so
 *     each one is paired with a live share doing the same thing in the same
 *     test. Without that pair, a server that answered nothing at all would
 *     pass this entire file.
 *
 * Those positive controls used to be minted over the folder bind. A BOARD is
 * the unit of sharing now — the grouping removal that followed this one is
 * covered in grouping-share-removed.test.ts — so the bind is FILED on a board
 * and the control shares the board. The pairing is the point, and it only
 * works if the control is something that still mints.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';
import { Shares } from '../src/share/shares.ts';
import type { Share } from '../src/share/types.ts';

const PUBLIC_HOST = 'feedback.example.test';

describe('per-doc sharing is removed', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  /** The board every positive control below is minted over. */
  let boardId: string;
  /** The folder bind filed on it — a GROUPING, not shareable on its own. */
  let workspaceId: string;
  let memberDocId: string;
  const SOLO = 'solo-doc';

  const local = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'per-doc-removed-data-'));
    folder = mkdtempSync(join(tmpdir(), 'per-doc-removed-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nThe workspace entry.\n');
    writeFileSync(join(folder, 'design.md'), '# Design\n\nA sibling file.\n');

    handle = createServer({
      port: 0,
      dataDir,
      // Link mode only — it needs no Cloudflare credentials at all.
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    // A loose doc, filed on nothing. This is exactly what `share_doc` used to
    // take, and it is now unshareable by design.
    const soloPath = join(dataDir, `${SOLO}.md`);
    writeFileSync(soloPath, `# ${SOLO}\n\nBody.\n`);
    const mk = await local('/api/docs', { docId: SOLO, type: 'markdown', sourceUrl: soloPath });
    expect(mk.status).toBe(200);

    const board = await local('/api/workspaces', { name: 'Per-doc removal board' });
    expect(board.status).toBe(200);
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    expect(boardId).toBeTruthy();

    const bind = await local('/api/workspaces', { folderPath: folder, hubWorkspaceId: boardId });
    expect(bind.status).toBe(200);
    const bound = (await bind.json()) as {
      workspaceId: string;
      files: Array<{ docId: string }>;
    };
    workspaceId = bound.workspaceId;
    memberDocId = bound.files[0]?.docId ?? '';
    expect(workspaceId).toBeTruthy();
    expect(memberDocId).toBeTruthy();
    expect(workspaceId).not.toBe(boardId);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  describe('an older bundle calling the shared routes', () => {
    it('refuses share_doc’s payload by name, while share_workspace’s path still mints', async () => {
      // Verbatim from the 0.1.41 bundle's `case "share_doc"`.
      const old = await local('/api/share/doc', {
        docId: SOLO,
        allowDomains: ['@partner.example'],
        ttlSeconds: 3600,
        name: undefined,
      });
      expect(old.status).toBe(410);
      const body = (await old.json()) as { error: string; hint: string };
      expect(body.error).toBe('per_doc_sharing_removed');
      // The reply has to point somewhere, or it reads as a broken server.
      expect(body.hint).toContain('workspace');

      // Positive control, same server, same pass: the board route works.
      const ws = await local('/api/share/link', { workspaceId: boardId });
      expect(ws.status).toBe(200);
      expect(((await ws.json()) as { share: Share }).share.workspaceId).toBe(boardId);
    });

    it('refuses share_link’s DOC form while its BOARD form still works', async () => {
      // The 0.1.41 bundle destructures `{ docId, workspaceId, entryDocId,
      // ttlSeconds, label }` and forwards all five. For a per-doc call that
      // means docId is set and workspaceId is undefined.
      const doc = await local('/api/share/link', {
        docId: SOLO,
        workspaceId: undefined,
        entryDocId: undefined,
        ttlSeconds: undefined,
        label: 'solo review',
      });
      expect(doc.status).toBe(410);
      expect(((await doc.json()) as { error: string }).error).toBe('per_doc_sharing_removed');

      // The SAME old bundle, sharing a board, sends the identical shape with
      // docId undefined — which JSON.stringify drops, so the body never
      // carries the key and the call keeps working. That is the whole reason
      // the guard tests for the KEY rather than for a truthy value: an old
      // peer's board shares must not break with its doc shares.
      //
      // `entryDocId` is dropped from this control rather than left at
      // `memberDocId`: it is refused now too (a board share opens the board),
      // and a control that 400s is no control. That refusal has its own test
      // in grouping-share-removed.test.ts, where it is the subject rather than
      // a side effect. An old bundle sharing a board sends it undefined, which
      // JSON.stringify drops, exactly like docId above.
      const ws = await local('/api/share/link', {
        docId: undefined,
        workspaceId: boardId,
        entryDocId: undefined,
        ttlSeconds: undefined,
        label: 'board review',
      });
      expect(ws.status).toBe(200);
      const share = ((await ws.json()) as { share: Share }).share;
      expect(share.workspaceId).toBe(boardId);
      expect(share.surface).toBe('workspace');
    });

    it('refuses a share_link with no scope at all, and says which field', async () => {
      const none = await local('/api/share/link', { label: 'nothing' });
      expect(none.status).toBe(400);
      expect(((await none.json()) as { error: string }).error).toBe('workspaceId required');

      // Positive control: adding the one named field is all it takes.
      const ok = await local('/api/share/link', { label: 'nothing', workspaceId: boardId });
      expect(ok.status).toBe(200);
    });
  });

  describe('a doc-scoped share already on disk', () => {
    /**
     * The registry is what every lookup reads, so a record written before the
     * removal would keep granting after it. `Shares.load` drops it.
     *
     * Built by hand rather than by minting one, because minting one is the
     * thing that no longer exists — which is the point.
     */
    const legacyDocShare = (slug: string): Record<string, unknown> => ({
      shareId: 'legacy01',
      surface: 'doc',
      mode: 'link',
      docId: SOLO,
      slug,
      hostname: PUBLIC_HOST,
      url: `https://${PUBLIC_HOST}/s/${slug}`,
      label: 'legacy doc share',
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });

    it('is dropped at load, while a workspace record in the same file survives', () => {
      const dir = mkdtempSync(join(tmpdir(), 'legacy-registry-'));
      const keep = {
        shareId: 'keepme01',
        surface: 'workspace',
        mode: 'link',
        docId: 'ws-1:README.md',
        workspaceId: 'ws-1',
        slug: 'b'.repeat(32),
        hostname: PUBLIC_HOST,
        url: `https://${PUBLIC_HOST}/s/${'b'.repeat(32)}`,
        createdAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
      };
      writeFileSync(
        join(dir, 'shares.json'),
        JSON.stringify([legacyDocShare('a'.repeat(32)), keep], null, 2),
      );

      const shares = new Shares({ dataDir: dir, config: { publicHostname: PUBLIC_HOST } });
      const ids = shares.list().map((s) => s.shareId);
      // Positive control first: the load read the file at all.
      expect(ids).toContain('keepme01');
      expect(ids).not.toContain('legacy01');

      // And the drop is persisted, so it does not have to be re-decided on
      // every boot — a half-dropped registry is a registry that disagrees
      // with itself depending on who read it last.
      const onDisk = JSON.parse(readFileSync(join(dir, 'shares.json'), 'utf8')) as Share[];
      expect(onDisk.map((s) => s.shareId)).toEqual(['keepme01']);

      rmSync(dir, { recursive: true, force: true });
    });

    /**
     * Asserted at the registry rather than through the redeem route
     * deliberately. `findLive` is the lookup every serving path makes, so
     * this is the layer the decision lives in — and reaching the route half
     * would need a server restart, whose OTHER failure mode (a workspace
     * whose members have not rehydrated yet) would make the control fail for
     * a reason that has nothing to do with this change. A control that is
     * flaky for unrelated reasons is worse than one taken a layer down.
     * (Slugs as such resolve NOWHERE any more — signed-link-share.test.ts
     * owns that removal at the route.)
     */
    it('no longer resolves, where a workspace share still does', () => {
      const dir = mkdtempSync(join(tmpdir(), 'legacy-redeem-'));
      const legacySlug = 'c'.repeat(32);
      const liveSlug = 'd'.repeat(32);
      writeFileSync(
        join(dir, 'shares.json'),
        JSON.stringify([
          legacyDocShare(legacySlug),
          {
            shareId: 'live0001',
            surface: 'workspace',
            mode: 'link',
            docId: 'ws-1:README.md',
            workspaceId: 'ws-1',
            slug: liveSlug,
            hostname: PUBLIC_HOST,
            url: `https://${PUBLIC_HOST}/s/${liveSlug}`,
            createdAt: Date.now(),
            expiresAt: Date.now() + 86_400_000,
          },
        ]),
      );

      const shares = new Shares({ dataDir: dir, config: { publicHostname: PUBLIC_HOST } });
      // Positive control: the lookup can find something at all.
      expect(shares.findLive('live0001')?.shareId).toBe('live0001');
      // The legacy doc record is indistinguishable from one that never existed.
      expect(shares.findLive('legacy01')).toBeNull();

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('what replaces it', () => {
    it('files a loose doc on a workspace, on a board, and shares the board', async () => {
      // The whole migration story in one test: a doc nobody could share
      // becomes reachable by being filed, and a share of the board it ends up
      // on reaches it.
      const dir = join(folder, 'nested');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'note.md'), '# Note\n\nFiled, therefore shareable.\n');

      const opened = await local(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/context-file`,
        {
          relPath: 'nested/note.md',
        },
      );
      expect(opened.status).toBe(200);
      const { docId } = (await opened.json()) as { docId: string };
      expect(docId).toBeTruthy();

      const mint = await local('/api/share/link', { workspaceId: boardId });
      expect(mint.status).toBe(200);
      const share = ((await mint.json()) as { share: Share }).share;

      const shareUrl = new URL(share.url);
      const r = await fetch(`${base}${shareUrl.pathname}${shareUrl.search}`, {
        headers: { host: PUBLIC_HOST },
        redirect: 'manual',
      });
      expect(r.status).toBe(302);
      // Redemption lands on the board, not on any doc — there is no entry doc
      // to land on, which is why `entryDocId` is gone from the mint payload.
      expect(r.headers.get('location')).toBe(`/workspaces/${encodeURIComponent(boardId)}`);
      const cookie = (r.headers.get('set-cookie') ?? '').match(
        new RegExp(`${SHARE_COOKIE}=([^;]+)`),
      )?.[1];
      expect(cookie).toBeTruthy();

      const asVisitor = (path: string) =>
        fetch(`${base}${path}`, {
          headers: { host: PUBLIC_HOST, cookie: `${SHARE_COOKIE}=${cookie}` },
        });

      // The newly filed doc is in scope because it is a MEMBER — never
      // because anything named it.
      expect((await asVisitor(`/api/docs/${encodeURIComponent(docId)}`)).status).toBe(200);
      // And the loose doc, filed on nothing, still is not.
      expect((await asVisitor(`/api/docs/${SOLO}`)).status).toBe(403);
    });
  });
});
