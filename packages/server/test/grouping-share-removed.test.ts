/**
 * A BOARD is the only thing that can be shared.
 *
 * Bryan, 2026-08-17: "Workspace only — a review must be filed on a board
 * before it can be shared." The per-doc half shipped separately (see
 * `per-doc-share-removed.test.ts`); this file is the GROUPING half — the
 * folder bind and the diff review, which used to be shareable on their own
 * because `POST /api/share/link` forked on `taskStore.getWorkspace(id)` and
 * fell through to a member lookup when the id was not a board.
 *
 * The discriminator here is NOT the shape of the payload, which is what made
 * the per-doc removal cheap to guard. An older bundle sends a grouping id and
 * a board id in the SAME `workspaceId` field, so the only thing that can tell
 * them apart is a lookup: a board is what `taskStore` answers for, and a
 * grouping is what only `rooms` knows about. Every assertion below therefore
 * pairs a refusal with a board doing the same thing on the same server — a
 * server that answered nothing at all would otherwise pass this whole file.
 *
 * Three separate things have to be true, and each fails differently:
 *
 *  1. Nothing can MINT a grouping share, including an older peer's bundle
 *     calling the shared :8787 with the payload ITS bundle sends. Requests
 *     below are transcribed from the committed 0.1.80 bundle
 *     (`packages/plugin/mcp/index.js`, `case "share_workspace"` and
 *     `case "share_link"`), not from today's source.
 *
 *  2. A grouping share already ON DISK stops granting. Removing the mint
 *     path alone retires the feature everywhere except where it is exercised.
 *     Unlike the per-doc case this cannot be a load-time drop — `Shares` has
 *     no way to ask what a board is — so it is enforced where the share is
 *     resolved for serving, and the record stays on disk (soft delete).
 *
 *  3. The replacement still works AND is still fast: filing a review on a
 *     board and sharing the board reaches every member, in one create call
 *     plus one share call.
 *
 * All fixtures are synthetic — invented names in the partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CfAccessApp, CfAccessPolicy } from '../src/share/cf-api.ts';
import { CfApi } from '../src/share/cf-api.ts';
import { SHARE_COOKIE, loadCookieKey, signSession } from '../src/share/link-session.ts';
import type { Share } from '../src/share/types.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PUBLIC_HOST = 'feedback.example.test';
const BASE_HOST = 'example.test';

/** Cloudflare Access, faked. Only the two calls `create()` makes. */
function makeMockCfApi(state: { apps: CfAccessApp[]; policies: CfAccessPolicy[] }) {
  // biome-ignore lint/suspicious/noExplicitAny: Bun fetch type compatibility
  const fetchImpl: any = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/access/apps')) {
      const body = JSON.parse(init?.body as string);
      const app: CfAccessApp = {
        id: `app-${state.apps.length + 1}`,
        name: body.name,
        domain: body.domain,
        aud: `aud-${state.apps.length + 1}`,
        session_duration: body.session_duration,
      };
      state.apps.push(app);
      return new Response(JSON.stringify({ success: true, result: app }), { status: 200 });
    }
    const policyMatch = url.match(/access\/apps\/([^/]+)\/policies$/);
    if (method === 'POST' && policyMatch) {
      const body = JSON.parse(init?.body as string);
      const policy: CfAccessPolicy = {
        id: `policy-${state.policies.length + 1}`,
        name: body.name,
        decision: body.decision,
      };
      state.policies.push(policy);
      return new Response(JSON.stringify({ success: true, result: policy }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
  };
  return new CfApi({ accountId: 'acct', token: 'tok', fetchImpl });
}

describe('a grouping cannot be shared on its own', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let repo: string;
  let base: string;

  /** A folder-bind grouping id. */
  let bindGroupingId: string;
  /** A diff-review grouping id. */
  let diffGroupingId: string;
  /** A real hub board — the only shareable thing. */
  let boardId: string;
  /** A doc that is a member of the diff review filed on `boardId`. */
  let diffMemberDocId: string;

  const local = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}${path}`, {
      method,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'grouping-share-data-'));
    folder = mkdtempSync(join(tmpdir(), 'grouping-share-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nThe bind entry.\n');

    // A real git repo, so create_diff_review has something to diff.
    repo = mkdtempSync(join(tmpdir(), 'grouping-share-repo-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@partner.example',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@partner.example',
        },
      });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'app.md'), '# App\n\nBefore.\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    writeFileSync(join(repo, 'app.md'), '# App\n\nAfter the change.\n');

    handle = createServer({
      port: 0,
      dataDir,
      share: {
        config: { publicHostname: PUBLIC_HOST, baseHostname: BASE_HOST, cfAccountId: 'acct' },
        cfApi: makeMockCfApi({ apps: [], policies: [] }),
        cfApiToken: 'tok',
      },
    });
    base = `http://localhost:${handle.port}`;

    // A real board. This is what `create_workspace` makes, and it is the
    // only id the share routes will accept after this change.
    const board = await local('/api/workspaces', { name: 'Partner review' });
    expect(board.status).toBe(200);
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    expect(boardId).toBeTruthy();

    // A folder bind — a GROUPING. Filed onto the board, so the only thing
    // separating it from `boardId` is which store answers for it.
    const bind = await local('/api/workspaces', { folderPath: folder, hubWorkspaceId: boardId });
    expect(bind.status).toBe(200);
    bindGroupingId = ((await bind.json()) as { workspaceId: string }).workspaceId;
    expect(bindGroupingId).toBeTruthy();
    expect(bindGroupingId).not.toBe(boardId);

    // A diff review — also a GROUPING, filed on the same board.
    const diff = await local('/api/diffs', { repo, base: 'main', hubWorkspaceId: boardId });
    expect(diff.status).toBe(200);
    const review = (await diff.json()) as {
      reviewId: string;
      hubWorkspaceId: string;
      files: Array<{ docId: string }>;
    };
    diffGroupingId = review.reviewId;
    diffMemberDocId = review.files[0]?.docId ?? '';
    expect(diffGroupingId).toBeTruthy();
    expect(diffMemberDocId).toBeTruthy();
    // The review was filed on the board we named — this is the prerequisite
    // the whole replacement flow rests on.
    expect(review.hubWorkspaceId).toBe(boardId);
  });

  afterEach(async () => {
    await handle.stop();
    for (const d of [dataDir, folder, repo]) rmSync(d, { recursive: true, force: true });
  });

  describe('an older bundle calling the shared routes', () => {
    it('refuses share_link for a folder bind, while the same call for a board mints', async () => {
      // Verbatim from the 0.1.80 bundle's `case "share_link"`, which
      // destructures `{ workspaceId, entryDocId, ttlSeconds, label }` and
      // forwards all four.
      const grouping = await local('/api/share/link', {
        workspaceId: bindGroupingId,
        entryDocId: undefined,
        ttlSeconds: undefined,
        label: 'folder review',
      });
      expect(grouping.status).toBe(410);
      const body = (await grouping.json()) as { error: string; hint: string };
      expect(body.error).toBe('grouping_sharing_removed');
      // A refusal that names nothing reads as a broken server. It has to say
      // what to do instead.
      expect(body.hint).toContain('board');
      expect(body.hint).toContain('create_workspace');

      // Positive control, same server, same pass, same payload shape: the
      // board id works. An older peer sharing a BOARD sends the identical
      // body with entryDocId undefined, which JSON.stringify drops.
      const board = await local('/api/share/link', {
        workspaceId: boardId,
        entryDocId: undefined,
        ttlSeconds: undefined,
        label: 'board review',
      });
      expect(board.status).toBe(200);
      const share = ((await board.json()) as { share: Share }).share;
      expect(share.workspaceId).toBe(boardId);
      expect(share.surface).toBe('workspace');
    });

    it('refuses share_link for a diff review, the most-used grouping', async () => {
      const res = await local('/api/share/link', {
        workspaceId: diffGroupingId,
        entryDocId: diffMemberDocId,
        ttlSeconds: 3600,
        label: 'diff review',
      });
      expect(res.status).toBe(410);
      expect(((await res.json()) as { error: string }).error).toBe('grouping_sharing_removed');

      // Positive control: the board the review is filed on shares fine.
      expect((await local('/api/share/link', { workspaceId: boardId })).status).toBe(200);
    });

    it('refuses share_workspace (Access mode) for a grouping, while a board mints', async () => {
      // Verbatim from the 0.1.80 bundle's `case "share_workspace"`, which
      // forwards `{ workspaceId, allowDomains, entryDocId, ttlSeconds, name }`.
      const grouping = await local('/api/share/workspace', {
        workspaceId: diffGroupingId,
        allowDomains: ['@partner.example'],
        entryDocId: diffMemberDocId,
        ttlSeconds: undefined,
        name: undefined,
      });
      expect(grouping.status).toBe(410);
      expect(((await grouping.json()) as { error: string }).error).toBe('grouping_sharing_removed');

      // Positive control: the board, through the same Cloudflare path.
      const board = await local('/api/share/workspace', {
        workspaceId: boardId,
        allowDomains: ['@partner.example'],
        entryDocId: undefined,
        ttlSeconds: undefined,
        name: undefined,
      });
      expect(board.status).toBe(200);
      expect(((await board.json()) as { share: Share }).share.workspaceId).toBe(boardId);
    });

    it('still says "not found" for an id that is neither, so the 410 stays informative', async () => {
      // The 410 must mean "this exists and is no longer shareable", not
      // "anything I do not recognise". Otherwise it is an existence oracle
      // AND a useless error at the same time.
      const unknown = await local('/api/share/link', { workspaceId: 'no-such-workspace' });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: string }).error).toBe('workspace not found');

      // Positive control: the id that DOES exist as a grouping gets the 410.
      const known = await local('/api/share/link', { workspaceId: bindGroupingId });
      expect(known.status).toBe(410);
    });

    it('refuses an entryDocId even on a board — a board share opens the board', async () => {
      const res = await local('/api/share/link', { workspaceId: boardId, entryDocId: 'anything' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('entryDocId');

      // Positive control: drop the field and the same call mints.
      expect((await local('/api/share/link', { workspaceId: boardId })).status).toBe(200);
    });
  });

  describe('a grouping share already on disk', () => {
    /**
     * Written by hand rather than minted, because minting one is exactly what
     * no longer exists. `workspaceId` is a real grouping on this server, so
     * this is the strongest possible version of the record: everything about
     * it resolves except the one thing that now has to.
     */
    const groupingShare = (workspaceId: string, slug: string, docId: string): Share => ({
      shareId: 'legacy02',
      surface: 'workspace',
      mode: 'link',
      docId,
      workspaceId,
      slug,
      hostname: PUBLIC_HOST,
      url: `https://${PUBLIC_HOST}/s/${slug}`,
      label: 'legacy grouping share',
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });

    /** Restart onto the same dataDir with `extra` prepended to the registry. */
    const restartWith = async (extra: Share[]): Promise<void> => {
      const listed = await fetch(`${base}/api/share`, {
        headers: { host: `localhost:${handle.port}` },
      });
      const existing = ((await listed.json()) as { shares: Share[] }).shares;
      await handle.stop();
      writeFileSync(join(dataDir, 'shares.json'), JSON.stringify([...extra, ...existing], null, 2));
      handle = createServer({
        port: 0,
        dataDir,
        share: {
          config: { publicHostname: PUBLIC_HOST, baseHostname: BASE_HOST, cfAccountId: 'acct' },
          cfApi: makeMockCfApi({ apps: [], policies: [] }),
          cfApiToken: 'tok',
        },
      });
      base = `http://localhost:${handle.port}`;
    };

    it('no longer redeems its slug, where a board share on the same server does', async () => {
      const board = await local('/api/share/link', { workspaceId: boardId });
      expect(board.status).toBe(200);
      const boardSlug = ((await board.json()) as { share: Share }).share.slug ?? '';
      expect(boardSlug).toBeTruthy();

      const legacySlug = 'e'.repeat(32);
      await restartWith([groupingShare(diffGroupingId, legacySlug, diffMemberDocId)]);

      const redeem = (slug: string) =>
        fetch(`${base}/s/${slug}`, { headers: { host: PUBLIC_HOST }, redirect: 'manual' });

      // Positive control FIRST: the registry survived the restart and the
      // redeem route works at all.
      const ok = await redeem(boardSlug);
      expect(ok.status).toBe(302);
      expect(ok.headers.get('location')).toBe(`/workspaces/${encodeURIComponent(boardId)}`);

      // The grouping slug is indistinguishable from one that never existed —
      // the same 404 an unknown or expired slug gets. A named 410 here would
      // tell a stranger holding a leaked link that it was once real.
      const gone = await redeem(legacySlug);
      expect(gone.status).toBe(404);

      // And the record is still on disk: this removes a capability, not user
      // content, so an operator can still see and revoke it.
      const listed = await fetch(`${base}/api/share`, {
        headers: { host: `localhost:${handle.port}` },
      });
      const ids = ((await listed.json()) as { shares: Share[] }).shares.map((s) => s.shareId);
      expect(ids).toContain('legacy02');
    });

    it('stops honouring a session cookie minted before the upgrade', async () => {
      // A visitor who redeemed a grouping link YESTERDAY still holds a valid
      // signed cookie today. Closing only the redeem route would leave them
      // inside — the cookie is re-resolved on every request, and that is the
      // resolution this change has to close.
      const legacySlug = 'f'.repeat(32);
      await restartWith([groupingShare(diffGroupingId, legacySlug, diffMemberDocId)]);

      const key = loadCookieKey(dataDir);
      const legacyCookie = signSession('legacy02', key);

      const asLegacy = (path: string) =>
        fetch(`${base}${path}`, {
          headers: { host: PUBLIC_HOST, cookie: `${SHARE_COOKIE}=${legacyCookie}` },
        });

      // A member of the grouping the cookie names — the exact doc it used to
      // open.
      expect((await asLegacy(`/api/docs/${encodeURIComponent(diffMemberDocId)}`)).status).toBe(401);
      expect((await asLegacy(`/api/workspaces/${encodeURIComponent(diffGroupingId)}/tree`)).status).toBe(
        401,
      );

      // Positive control, same server and same transport: a cookie for a
      // BOARD share reaches that member, so the 401s above are this change
      // and not a server that refuses every cookie.
      const board = await local('/api/share/link', { workspaceId: boardId });
      expect(board.status).toBe(200);
      const boardShareId = ((await board.json()) as { share: Share }).share.shareId;
      const boardCookie = signSession(boardShareId, key);
      const asBoard = await fetch(`${base}/api/docs/${encodeURIComponent(diffMemberDocId)}`, {
        headers: { host: PUBLIC_HOST, cookie: `${SHARE_COOKIE}=${boardCookie}` },
      });
      expect(asBoard.status).toBe(200);
    });
  });

  describe('what replaces it', () => {
    it('reaches the filed diff review through a share of the board', async () => {
      const mint = await local('/api/share/link', { workspaceId: boardId });
      expect(mint.status).toBe(200);
      const share = ((await mint.json()) as { share: Share }).share;

      const redeemed = await fetch(`${base}/s/${share.slug}`, {
        headers: { host: PUBLIC_HOST },
        redirect: 'manual',
      });
      expect(redeemed.status).toBe(302);
      expect(redeemed.headers.get('location')).toBe(`/workspaces/${encodeURIComponent(boardId)}`);
      const cookie = (redeemed.headers.get('set-cookie') ?? '').match(
        new RegExp(`${SHARE_COOKIE}=([^;]+)`),
      )?.[1];
      expect(cookie).toBeTruthy();

      const asVisitor = (path: string) =>
        fetch(`${base}${path}`, { headers: { host: PUBLIC_HOST, cookie: `${SHARE_COOKIE}=${cookie}` } });

      // The board page itself.
      expect((await asVisitor(`/workspaces/${encodeURIComponent(boardId)}`)).status).toBe(200);
      // A changed file of the diff review, reachable because the review is
      // FILED on the shared board — never because anything named the doc.
      expect((await asVisitor(`/api/docs/${encodeURIComponent(diffMemberDocId)}`)).status).toBe(200);
      // And the review's own tree, through the grouping→board hop.
      expect(
        (await asVisitor(`/api/workspaces/${encodeURIComponent(diffGroupingId)}/tree`)).status,
      ).toBe(200);
    });

    it('creates a review on a fresh board and shares it in one create + one share', async () => {
      // The cost this change lands on the most-used path, measured on the
      // actual flow rather than asserted. Bryan's ruling on t-o5gm3Hnvot2K:
      // "creating and sharing docs should both still take seconds … workspace
      // setup should normally have already happened … and that should also
      // take seconds to make a blank empty workspace if there isn't one yet."
      const other = mkdtempSync(join(tmpdir(), 'grouping-share-fresh-'));
      mkdirSync(join(other, 'sub'), { recursive: true });
      writeFileSync(join(other, 'sub', 'notes.md'), '# Notes\n\nFresh.\n');

      const started = Date.now();

      // 1. A blank board, if the agent has not already got one.
      const board = await local('/api/workspaces', { name: 'Fresh review' });
      expect(board.status).toBe(200);
      const freshBoard = ((await board.json()) as { workspace: { id: string } }).workspace.id;

      // 2. The review, filed on it in the SAME call — no extra step, which is
      //    what keeps the prerequisite cheap.
      const bound = await local('/api/workspaces', {
        folderPath: other,
        hubWorkspaceId: freshBoard,
      });
      expect(bound.status).toBe(200);
      expect(((await bound.json()) as { hubWorkspaceId: string }).hubWorkspaceId).toBe(freshBoard);

      // 3. The share.
      const mint = await local('/api/share/link', { workspaceId: freshBoard });
      expect(mint.status).toBe(200);

      const elapsed = Date.now() - started;
      // Generous on purpose: this is a regression guard against the flow
      // acquiring a slow prerequisite (a scan, a round trip per file), not a
      // benchmark. Locally it runs in well under a second.
      expect(elapsed).toBeLessThan(5000);

      rmSync(other, { recursive: true, force: true });
    });
  });
});
