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
 * grouping is what only `docStore` knows about. Every assertion below therefore
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
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE, loadCookieKey, signSession } from '../src/share/link-session.ts';
import type { ListedShare, Share } from '../src/share/types.ts';
import { ACCESS_BASE_HOSTNAME, type AccessHarness, accessHarness } from './access-share.ts';

/** The hostname the retired link mode served every share from. */
const PUBLIC_HOST = 'feedback.example.test';
const BASE_HOST = ACCESS_BASE_HOSTNAME;

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
  /** A real board — the only shareable thing. */
  let boardId: string;
  /** A doc that is a member of the diff review filed on `boardId`. */
  let diffMemberDocId: string;
  let access: AccessHarness;

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

    access = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      // A share hostname, so `share_workspace` can mint a share link — the
      // positive controls below need the mint to succeed.
      shareLinkHosts: ['share.example.test'],
      ...access.serverOptions,
    });
    base = `http://localhost:${handle.port}`;

    // A real board. This is what `create_workspace` makes, and it is the
    // only id the share routes will accept after this change.
    const board = await local('/workspaces', { name: 'Partner review' });
    expect(board.status).toBe(200);
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    expect(boardId).toBeTruthy();

    // A folder bind — a GROUPING. Filed onto the board, so the only thing
    // separating it from `boardId` is which store answers for it.
    const bind = await local('/workspaces', { folderPath: folder, hubWorkspaceId: boardId });
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

  /**
   * A LIVE per-share Access record for the BOARD, written by hand for the
   * same reason the grouping one above is: `/api/share/link` mints nothing
   * on a deployment that has a share hostname, and every test here is about
   * records that already exist. Hand-writing it also makes the control
   * independent of the mint — a positive control that goes through the
   * route under test proves less than one that does not.
   */
  const boardShare = (workspaceId: string, n: string): Share => ({
    shareId: `legacyboard${n}`,
    surface: 'workspace',
    docId: '',
    workspaceId,
    hostname: `share-legacy-board-${n}.${BASE_HOST}`,
    url: `https://share-legacy-board-${n}.${BASE_HOST}/workspaces/${encodeURIComponent(workspaceId)}?format=json`,
    label: 'board share already on disk',
    createdAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
    audience: `aud-legacy-board-${n}`,
    appId: `app-legacy-board-${n}`,
    policyId: `policy-legacy-board-${n}`,
    allowDomains: ['@partner.example'],
  });

  /** What a visitor holding one of those records sends: its own hostname
   *  and a token minted for its own audience. */
  const visitorFor = async (rec: Share) => ({
    shareId: rec.shareId,
    host: rec.hostname,
    headers: {
      host: rec.hostname,
      'cf-access-jwt-assertion': await access.signJwt(rec.audience ?? ''),
    },
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
      ...access.serverOptions,
    });
    base = `http://localhost:${handle.port}`;
  };

  describe('an older bundle calling the shared routes', () => {
    it('refuses share_link for a folder bind, while the same call for a board mints', async () => {
      // Verbatim from the 0.1.80 bundle's `case "share_link"`, which
      // destructures `{ workspaceId, entryDocId, ttlSeconds, label }` and
      // forwards all four.
      const grouping = await local('/api/share/link', {
        allowDomains: ['@partner.example'],
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
      // BOARD id gets past the grouping check and lands on the retirement
      // refusal below it. Two different 410s, and that is what makes this a
      // control — the grouping's answer came from the grouping check, not
      // from a route that has one reply for everything. An older peer
      // sharing a BOARD sends the identical body with entryDocId undefined,
      // which JSON.stringify drops.
      const board = await local('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: boardId,
        entryDocId: undefined,
        ttlSeconds: undefined,
        label: 'board review',
      });
      expect(board.status).toBe(410);
      expect(((await board.json()) as { error: string }).error).toBe('link_share_mint_retired');
    });

    it('refuses share_link for a diff review, the most-used grouping', async () => {
      const res = await local('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: diffGroupingId,
        entryDocId: diffMemberDocId,
        ttlSeconds: 3600,
        label: 'diff review',
      });
      expect(res.status).toBe(410);
      expect(((await res.json()) as { error: string }).error).toBe('grouping_sharing_removed');

      // Positive control: the board the review is filed on gets PAST the
      // grouping check, to the retirement refusal under it. A different error
      // from the same status, so the 410 above is the grouping's.
      const control = await local('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: boardId,
      });
      expect(control.status).toBe(410);
      expect(((await control.json()) as { error: string }).error).toBe('link_share_mint_retired');
    });

    it('refuses share_workspace for a grouping, while a board mints', async () => {
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

      // Positive control: the board, through the same route. It mints a SHARE
      // LINK now, so the reply names `link` — the refusal above is what is
      // under test, and it is unchanged.
      const board = await local('/api/share/workspace', {
        workspaceId: boardId,
        allowDomains: ['@partner.example'],
        entryDocId: undefined,
        ttlSeconds: undefined,
        name: undefined,
      });
      expect(board.status).toBe(200);
      expect(((await board.json()) as { link: { workspaceId: string } }).link.workspaceId).toBe(
        boardId,
      );
    });

    it('still says "not found" for an id that is neither, so the 410 stays informative', async () => {
      // The 410 must mean "this exists and is no longer shareable", not
      // "anything I do not recognise". Otherwise it is an existence oracle
      // AND a useless error at the same time.
      const unknown = await local('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: 'no-such-workspace',
      });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: string }).error).toBe('workspace not found');

      // Positive control: the id that DOES exist as a grouping gets the 410.
      const known = await local('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: bindGroupingId,
      });
      expect(known.status).toBe(410);
    });

    it('refuses an entryDocId even on a board — a board share opens the board', async () => {
      const res = await local('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: boardId,
        entryDocId: 'anything',
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('entryDocId');

      // Positive control: drop the field and the same call gets past this
      // check to the retirement refusal under it, so the 400 above is the
      // entryDocId's own answer.
      const control = await local('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: boardId,
      });
      expect(control.status).toBe(410);
      expect(((await control.json()) as { error: string }).error).toBe('link_share_mint_retired');
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

    it('is listed as retired and redeems nowhere, where a board share still works', async () => {
      const legacySlug = 'e'.repeat(32);
      const boardRec = boardShare(boardId, 'a');
      await restartWith([groupingShare(diffGroupingId, legacySlug, diffMemberDocId), boardRec]);
      const board = await visitorFor(boardRec);

      // The record is still on disk (this removes a capability, not user
      // content, so an operator can still see and revoke it) and the list
      // says plainly that it buys nothing.
      const listed = await fetch(`${base}/api/share`, {
        headers: { host: `localhost:${handle.port}` },
      });
      const shares = ((await listed.json()) as { shares: ListedShare[] }).shares;
      const legacy = shares.find((sh) => sh.shareId === 'legacy02');
      expect(legacy).toBeDefined();
      expect(legacy?.redeemable).toBe(false);
      expect(legacy?.retired).toBe('link_mode');

      // Positive control on the same list: the board's ACCESS share is
      // redeemable, so `redeemable:false` above is this record's verdict and
      // not a field the route hard-codes.
      const alive = shares.find((sh) => sh.shareId === board.shareId);
      expect(alive?.redeemable).toBe(true);
      expect(alive?.retired).toBeUndefined();

      // Both redeem forms are dead outright — for the grouping record and for
      // every other one alike. A named 410 would tell a stranger holding a
      // leaked link that it was once real, so it is a plain 404.
      const u = new URL(legacy?.url ?? '');
      expect((await fetch(`${base}${u.pathname}${u.search}`, { redirect: 'manual' })).status).toBe(
        404,
      );
      expect((await fetch(`${base}/s/${legacySlug}`, { redirect: 'manual' })).status).toBe(404);
    });

    it('stops honouring a session cookie minted before the upgrade', async () => {
      // A visitor who redeemed a grouping link YESTERDAY still holds a valid
      // signed cookie today. Closing only the redeem route would leave them
      // inside — the cookie was re-resolved on every request, and that is the
      // resolution this change has to close. It now closes for BOTH records:
      // link mode is retired, so a signed cookie is no longer a credential at
      // all, whichever share minted it.
      const legacySlug = 'f'.repeat(32);
      const boardRec = boardShare(boardId, 'b');
      await restartWith([groupingShare(diffGroupingId, legacySlug, diffMemberDocId), boardRec]);
      const board = await visitorFor(boardRec);

      const key = loadCookieKey(dataDir);
      const withCookie = (shareId: string, path: string) =>
        fetch(`${base}${path}`, {
          headers: {
            host: board.host,
            cookie: `${SHARE_COOKIE}=${signSession(shareId, key)}`,
          },
        });

      // A member of the grouping the cookie names — the exact doc it used to
      // open — and the grouping's own tree.
      // 401 is Access saying "you presented no token" — the cookie is not
      // read at all any more, which is the whole point.
      expect(
        (await withCookie('legacy02', `/api/docs/${encodeURIComponent(diffMemberDocId)}`)).status,
      ).toBe(401);
      expect(
        (await withCookie('legacy02', `/api/reviews/${encodeURIComponent(diffGroupingId)}/tree`))
          .status,
      ).toBe(401);
      // …and a cookie for the LIVE board share is no better: the credential
      // itself is retired, not just this record.
      expect(
        (await withCookie(board.shareId, `/api/docs/${encodeURIComponent(diffMemberDocId)}`))
          .status,
      ).toBe(401);

      // Positive control, same server and same transport: that board share's
      // own Access token reaches the member, so the refusals above are the
      // retirement rather than a server refusing everything.
      const asVisitor = await fetch(`${base}/api/docs/${encodeURIComponent(diffMemberDocId)}`, {
        headers: board.headers,
      });
      expect(asVisitor.status).toBe(200);
    });

    it('stops resolving a legacy Access-mode grouping HOSTNAME', async () => {
      /**
       * The third serving seam, and the one nothing covered until a mutation
       * run found it silent: Access mode does not use the slug or the session
       * cookie at all — it resolves the share from the per-share HOSTNAME.
       * Closing the link seams alone would have left an emailed Access URL for
       * a grouping still granting.
       *
       * Asserted without a Cloudflare JWT, and it does not need one: an
       * unresolvable host never reaches authentication. `classifyHost` asks
       * `lookupShare` first, and a null answer falls through to `deny`, so the
       * two cases separate one layer ABOVE the JWT — 403 unknown_host for a
       * host that resolves to nothing, versus 401 for one that resolves and
       * then finds no token on the request. Different codes from different
       * layers, which is what makes this a control rather than two flavours
       * of the same failure.
       */
      // A per-share record for the BOARD, written by hand: this seam is about
      // a per-share HOSTNAME, and no route mints one on a deployment with a
      // share hostname any more.
      const boardRec = boardShare(boardId, 'c');
      const boardHost = boardRec.hostname;
      expect(boardHost).toContain(BASE_HOST);

      const legacyHost = `share-legacy-grouping.${BASE_HOST}`;
      await restartWith([
        boardRec,
        {
          shareId: 'legacy03',
          surface: 'workspace',
          // No `mode` — that is what a pre-link-mode Access record looks like.
          docId: diffMemberDocId,
          workspaceId: diffGroupingId,
          hostname: legacyHost,
          url: `https://${legacyHost}/review/${encodeURIComponent(diffMemberDocId)}`,
          audience: 'aud-legacy',
          appId: 'app-legacy',
          policyId: 'policy-legacy',
          allowDomains: ['@partner.example'],
          createdAt: Date.now(),
          expiresAt: Date.now() + 86_400_000,
        },
      ]);

      const onHost = (host: string) =>
        fetch(`${base}/api/docs/${encodeURIComponent(diffMemberDocId)}`, { headers: { host } });

      // Positive control FIRST: the BOARD's share hostname still resolves, so
      // the registry survived the restart and hostname lookup works at all.
      const board = await onHost(boardHost);
      expect(board.status).toBe(401);

      // The grouping's hostname now resolves to nothing — indistinguishable
      // from a hostname this server has never heard of.
      const legacy = await onHost(legacyHost);
      expect(legacy.status).toBe(403);
      expect(((await legacy.json()) as { error: string }).error).toBe('unknown_host');
      const never = await onHost(`share-never-existed.${BASE_HOST}`);
      expect(never.status).toBe(403);
      expect(((await never.json()) as { error: string }).error).toBe('unknown_host');
    });
  });

  describe('what replaces it', () => {
    /** Files in the fresh folder. Enough that a per-file round trip would be
     *  unmistakable against the ceiling in the cold-start test, small enough
     *  to stay quick. */
    const FRESH_FILE_COUNT = 25;

    it('reaches the filed diff review through a share of the board', async () => {
      const boardRec = boardShare(boardId, 'd');
      await restartWith([boardRec]);
      const share = await visitorFor(boardRec);
      expect(new URL(boardRec.url).pathname).toBe(`/workspaces/${encodeURIComponent(boardId)}`);

      const asVisitor = (path: string) => fetch(`${base}${path}`, { headers: share.headers });

      // The board page itself.
      expect(
        (await asVisitor(`/workspaces/${encodeURIComponent(boardId)}?format=json`)).status,
      ).toBe(200);
      // A changed file of the diff review, reachable because the review is
      // FILED on the shared board — never because anything named the doc.
      expect((await asVisitor(`/api/docs/${encodeURIComponent(diffMemberDocId)}`)).status).toBe(
        200,
      );
      // And the review's own tree, through the grouping→board hop.
      expect(
        (await asVisitor(`/api/reviews/${encodeURIComponent(diffGroupingId)}/tree`)).status,
      ).toBe(200);
    });

    it('creates a review on a fresh board and shares it in one create + one share', async () => {
      // The cost this change lands on the most-used path. Bryan's ruling on
      // the board ticket: "creating and sharing docs should both still take
      // seconds … workspace setup should normally have already happened … and
      // that should also take seconds to make a blank empty workspace if there
      // isn't one yet."
      //
      // Asserted by COUNTING the round trips rather than by timing them, the
      // house style of `list-docs-linear.test.ts`. What "still fast" means
      // here is what this file's header claims — one create call plus one
      // share call — and what would break it is the flow acquiring a per-file
      // step (a scan, a round trip per file). A five-second stopwatch measured
      // neither: it encoded how fast this machine is, and would have gone red
      // on a loaded CI box while the flow was still exactly three calls. The
      // folder below is deliberately not one file, so a cost that TRACKED the
      // folder would be unmistakable against the ceiling.
      const other = mkdtempSync(join(tmpdir(), 'grouping-share-fresh-'));
      mkdirSync(join(other, 'sub'), { recursive: true });
      for (let i = 0; i < FRESH_FILE_COUNT; i += 1) {
        writeFileSync(join(other, 'sub', `notes-${i}.md`), `# Notes ${i}\n\nFresh.\n`);
      }

      let calls = 0;
      const counted = (path: string, body: unknown): Promise<Response> => {
        calls += 1;
        return local(path, body);
      };

      // 1. A blank board, if the agent has not already got one.
      const board = await counted('/workspaces', { name: 'Fresh review' });
      expect(board.status).toBe(200);
      const freshBoard = ((await board.json()) as { workspace: { id: string } }).workspace.id;

      // 2. The review, filed on it in the SAME call — no extra step, which is
      //    what keeps the prerequisite cheap.
      const bound = await counted('/workspaces', {
        folderPath: other,
        hubWorkspaceId: freshBoard,
      });
      expect(bound.status).toBe(200);
      const boundJson = (await bound.json()) as {
        hubWorkspaceId: string;
        fileCount: number;
        files: Array<{ docId: string }>;
      };
      expect(boundJson.hubWorkspaceId).toBe(freshBoard);
      // Positive control: the ONE bind call really did carry the whole folder,
      // so the counts here are claims about the flow and not about an answer
      // that skipped the files.
      expect(boundJson.fileCount).toBeGreaterThanOrEqual(FRESH_FILE_COUNT);
      // The per-file cost, made countable. A browse bind opens ONE entry doc
      // and leaves the rest to open lazily; the eager-bind-everything path it
      // replaced (and its per-file pollers) is exactly the "round trip per
      // file" the old stopwatch was standing in for, and this number is what
      // would move if it came back.
      expect(boundJson.files).toHaveLength(1);

      // 3. The share — `share_workspace`, which is what replaces every mint
      //    this file is about.
      const mint = await counted('/api/share/workspace', { workspaceId: freshBoard });
      expect(mint.status, await mint.clone().text()).toBe(200);

      // Three round trips for a cold start, and the number does not track the
      // folder: a round trip per file would put this at 3 + FRESH_FILE_COUNT.
      expect(calls).toBe(3);

      rmSync(other, { recursive: true, force: true });
    });
  });
});
