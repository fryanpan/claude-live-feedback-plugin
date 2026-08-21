/**
 * A review filed on a shared board is reachable from that board — and only
 * from that board.
 *
 * PR #131 files every group bind (diff review / folder bind) on a hub
 * workspace, so sharing a board makes the review row appear on it. Nothing
 * behind the row resolved: the share is scoped to the HUB id, while both the
 * grouping's own endpoints and every member doc answer with the GROUPING id.
 * Two exact-equality comparisons refused everything.
 *
 * This suite is deliberately written as presence-then-absence per surface (the
 * §6 rule: a negative test needs a positive control), and the ABSENCE half is
 * the important one — this change WIDENS a share scope, so the failure that
 * costs is a visitor reaching another board's review, not a visitor locked out.
 *
 * Link mode, through the real route table: link and Access shares run the same
 * scope engine, so what is proven here is what both modes get.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';
const MSG_SYNC = 0;

/** The repo's own Yjs client (ws.test.ts shape) — a RAW socket never
 *  completes the handshake, so every absence it reports is vacuous. */
function connectDoc(
  url: string,
  headers?: Record<string, string>,
): { ws: WebSocket; ydoc: Y.Doc; ready: Promise<void>; close: () => void } {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url, (headers ? { headers } : undefined) as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let synced = false;

  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const data = new Uint8Array(ev.data as ArrayBuffer);
    const dec = decoding.createDecoder(data);
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (
      !synced &&
      (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate)
    ) {
      synced = true;
      resolveReady?.();
    }
  });

  return { ws, ydoc, ready, close: () => ws.close() };
}

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

interface DiffResponse {
  reviewId: string;
  hubWorkspaceId?: string;
  files: Array<{ docId: string; relPath: string }>;
}

describe('a shared board reaches the reviews filed on it — and no others', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let repo: string;
  let repoBase: string;

  /** Board A: shared. Board B: a different board, never shared. */
  let boardA: string;
  let boardB: string;
  let groupingA: string;
  let groupingB: string;
  let memberA: string;
  let memberB: string;
  let folderGroupingA: string;
  let folderEntryA: string;
  let cookieA: string;

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

  const pub = (path: string, cookie?: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: PUBLIC_HOST,
        ...(cookie ? { cookie: `${SHARE_COOKIE}=${cookie}` } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const redeem = async (slug: string): Promise<string> => {
    const r = await pub(`/s/${slug}`);
    expect(r.status).toBe(302);
    const m = (r.headers.get('set-cookie') ?? '').match(new RegExp(`${SHARE_COOKIE}=([^;]+)`));
    expect(m).not.toBeNull();
    return m?.[1] ?? '';
  };

  /**
   * The visitor gets exactly what the OWNER gets on this path.
   *
   * `/review/<id>` is served only when the markdown-app bundle has been
   * built, which a test worktree has not, so a bare `toBe(200)` would assert
   * the bundler rather than the guard. Comparing to the owner's own status
   * keeps the assertion on the one thing under test — the gate — and still
   * fails loudly if the gate refuses (403 never matches the owner's status).
   */
  const sameAsOwner = async (path: string, cookie: string) => {
    const owner = await local(path);
    const seen = await pub(path, cookie);
    expect(owner.status, `owner ${path}`).not.toBe(403);
    expect(seen.status, `visitor ${path}`).toBe(owner.status);
  };

  const newBoard = async (name: string): Promise<string> => {
    const r = await post('/api/workspaces', { name, goal: 'Ship.' });
    expect(r.status).toBe(200);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };

  const newDiffOn = async (board: string, reviewId: string): Promise<DiffResponse> => {
    const r = await post('/api/diffs', { repo, base: repoBase, reviewId, hubWorkspaceId: board });
    expect(r.status).toBe(200);
    const body = (await r.json()) as DiffResponse;
    expect(body.hubWorkspaceId).toBe(board);
    return body;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sgs-data-'));
    repo = mkdtempSync(join(tmpdir(), 'sgs-repo-'));
    git(repo, 'init', '-q');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 1;\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    repoBase = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'a.ts'), 'const a = 2;\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'const b = 2;\n');

    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    boardA = await newBoard('board-alpha');
    boardB = await newBoard('board-beta');

    const a = await newDiffOn(boardA, 'rev-alpha');
    groupingA = a.reviewId;
    memberA = a.files[0]?.docId ?? '';
    expect(memberA).not.toBe('');

    const b = await newDiffOn(boardB, 'rev-beta');
    groupingB = b.reviewId;
    memberB = b.files[0]?.docId ?? '';
    expect(memberB).not.toBe('');

    // A folder bind on board A too — the other half of "group bind". Its
    // members bind LAZILY, so only the entry doc has a room; that entry doc is
    // the one a visitor clicks first.
    const folder = mkdtempSync(join(tmpdir(), 'sgs-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nRead me.\n');
    writeFileSync(join(folder, 'notes.md'), '# Notes\n\nThoughts.\n');
    const fr = await post('/api/workspaces', { folderPath: folder, hubWorkspaceId: boardA });
    expect(fr.status).toBe(200);
    const fb = (await fr.json()) as {
      workspaceId: string;
      hubWorkspaceId?: string;
      files: Array<{ docId: string }>;
    };
    expect(fb.hubWorkspaceId).toBe(boardA);
    folderGroupingA = fb.workspaceId;
    folderEntryA = fb.files[0]?.docId ?? '';
    expect(folderEntryA).not.toBe('');

    const hs = await post('/api/share/link', { workspaceId: boardA, label: 'board alpha share' });
    expect(hs.status).toBe(200);
    cookieA = await redeem(((await hs.json()) as { share: { slug: string } }).share.slug);
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  describe('positive control: the visitor is a real visitor on board A', () => {
    it('reaches the board page and the board record', async () => {
      expect((await pub(`/workspaces/${boardA}`, cookieA)).status).toBe(200);
      const r = await pub(`/api/workspaces/${boardA}`, cookieA);
      expect(r.status).toBe(200);
      const { workspace } = (await r.json()) as { workspace: { name: string } };
      expect(workspace.name).toBe('board-alpha');
    });

    it('the review really is filed on the board it can see', async () => {
      expect(handle.tasks.getWorkspace(boardA)?.docIds).toContain(groupingA);
      expect(handle.tasks.getWorkspace(boardB)?.docIds).toContain(groupingB);
    });
  });

  describe('the review row on the shared board opens', () => {
    it('serves the grouping’s navigation endpoints', async () => {
      for (const sub of ['tree', 'grouped', 'threads', 'files']) {
        const r = await pub(`/api/workspaces/${groupingA}/${sub}`, cookieA);
        expect(r.status, `GET ${sub}`).toBe(200);
      }
    });

    it('serves a member file: review page, doc REST, and the Yjs socket', async () => {
      await sameAsOwner(`/review/${memberA}`, cookieA);
      expect((await pub(`/api/docs/${memberA}`, cookieA)).status).toBe(200);
      expect((await pub(`/api/docs/${memberA}/threads`, cookieA)).status).toBe(200);
      // 426 = past the guard, upgrade-required on a plain fetch.
      expect((await pub(`/y/${memberA}`, cookieA)).status).toBe(426);
    });

    it('lets a visitor open a lazily-bound member of a folder bind', async () => {
      expect((await pub(`/api/workspaces/${folderGroupingA}/tree`, cookieA)).status).toBe(200);
      await sameAsOwner(`/review/${folderEntryA}`, cookieA);
      expect((await pub(`/api/docs/${folderEntryA}`, cookieA)).status).toBe(200);
      const r = await pub(`/api/workspaces/${folderGroupingA}/context-file`, cookieA, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: 'notes.md' }),
      });
      expect(r.status).toBe(200);
    });
  });

  /**
   * THE HALF THAT MATTERS. Each row below has its board-A twin asserted above,
   * so a refusal here is a refusal about the BOUNDARY and not about a
   * misconfigured probe.
   */
  describe('a review filed on a DIFFERENT board stays shut', () => {
    it('refuses the other grouping’s navigation endpoints', async () => {
      for (const sub of ['tree', 'grouped', 'threads', 'files']) {
        const r = await pub(`/api/workspaces/${groupingB}/${sub}`, cookieA);
        expect(r.status, `GET ${sub}`).toBe(403);
      }
    });

    it('refuses the other grouping’s lazy-open verbs', async () => {
      for (const sub of ['context-file', 'editable-file']) {
        const r = await pub(`/api/workspaces/${groupingB}/${sub}`, cookieA, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: 'src/a.ts' }),
        });
        expect(r.status, `POST ${sub}`).toBe(403);
      }
    });

    it('refuses the other board’s member docs on every transport', async () => {
      expect((await pub(`/review/${memberB}`, cookieA)).status).toBe(403);
      expect((await pub(`/api/docs/${memberB}`, cookieA)).status).toBe(403);
      expect((await pub(`/api/docs/${memberB}/threads`, cookieA)).status).toBe(403);
      expect((await pub(`/y/${memberB}`, cookieA)).status).toBe(403);
      expect((await pub(`/events/${memberB}`, cookieA)).status).toBe(403);
    });

    it('refuses the other board itself', async () => {
      expect((await pub(`/workspaces/${boardB}`, cookieA)).status).toBe(403);
      expect((await pub(`/api/workspaces/${boardB}`, cookieA)).status).toBe(403);
      expect((await pub(`/y/ws%3A${boardB}`, cookieA)).status).toBe(403);
      expect((await pub(`/events/workspace/${boardB}`, cookieA)).status).toBe(403);
    });

    it('still refuses the operator surfaces on its OWN grouping', async () => {
      // Widening reachability must not widen the verb set: DELETE of the
      // review, and the doc-enumeration list, stay shut.
      expect(
        (await pub(`/api/workspaces/${groupingA}`, cookieA, { method: 'DELETE' })).status,
      ).toBe(403);
      expect((await pub('/api/workspaces', cookieA)).status).toBe(403);
      expect((await pub('/api/docs', cookieA)).status).toBe(403);
      expect(
        (
          await pub(`/api/docs/${memberA}/content`, cookieA, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ markdown: '# overwritten' }),
          })
        ).status,
      ).toBe(403);
    });
  });

  /**
   * A long-lived grant needs a revocation path PER TRANSPORT. The websocket
   * and the SSE stream are authorized ONCE at open, so a surface this change
   * newly makes reachable has to be reachable by the sweep too — otherwise a
   * visitor keeps syncing a member doc after the board share is revoked.
   *
   * It is: both sweeps iterate every room / every stream and match on the
   * shareId stamped at open, so nothing had to be extended. This test is what
   * makes that a fact rather than a reading.
   */
  describe('revoking the board share hangs up the member doc it opened', () => {
    it('closes a member-doc socket and stream the board share authorized', async () => {
      const mint = await post('/api/share/link', { workspaceId: boardA });
      const share = ((await mint.json()) as { share: { shareId: string; slug: string } }).share;
      const cookie = await redeem(share.slug);

      const client = connectDoc(`ws://localhost:${handle.port}/y/${encodeURIComponent(memberA)}`, {
        host: PUBLIC_HOST,
        cookie: `${SHARE_COOKIE}=${cookie}`,
      });
      // Positive control: a REAL Yjs sync completed on a doc reachable only
      // through the grouping-on-board hop this PR adds.
      await client.ready;
      const closedCode = new Promise<number>((resolve) => {
        client.ws.addEventListener('close', (e) => resolve((e as CloseEvent).code));
        setTimeout(() => resolve(-1), 5000);
      });
      const stream = await pub(`/events/${encodeURIComponent(memberA)}`, cookie);
      expect(stream.status).toBe(200);

      const del = await local(`/api/share/${share.shareId}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      const body = (await del.json()) as { closedSockets?: number; closedStreams?: number };
      expect(body.closedSockets ?? 0).toBeGreaterThanOrEqual(1);
      expect(body.closedStreams ?? 0).toBeGreaterThanOrEqual(1);
      expect(await closedCode).toBe(1008); // policy violation
      // …and the door is shut for new requests too.
      expect((await pub(`/api/docs/${memberA}`, cookie)).status).toBe(401);
      await stream.body?.cancel().catch(() => {});
    });
  });

  /**
   * This suite used to mint a DOC-scoped share (`share_link {docId}`) and
   * prove it was not widened by the board its doc sat on. Two removals have
   * passed over it since, and the facts it holds have to be kept apart:
   *
   *   1. the doc-scoped share cannot be MINTED at all,
   *   2. the GROUPING-scoped share that briefly became "the narrowest
   *      surviving unit" cannot be minted either — a folder bind and a diff
   *      review are not boards, and each is refused BY NAME so a peer whose
   *      review stopped sharing does not read it as "your review vanished",
   *   3. and the narrowest unit that survives — the BOARD — still stops at its
   *      own edge.
   *
   * (3) is the property this suite exists for and the one that costs: the
   * file's whole subject is a change that WIDENS reach, and (3) is where the
   * widening is bounded. It used to be measured on a grouping share; with that
   * gone it is measured on a board that holds exactly one review, which is the
   * tight scope an agent is now told to create for a single review.
   */
  describe('the narrow shares are gone, and the narrowest surviving one still bounds', () => {
    it('refuses to mint a doc-scoped share on either route', async () => {
      const link = await post('/api/share/link', { docId: memberA });
      expect(link.status).toBe(410);
      expect((await link.json()) as { error: string }).toMatchObject({
        error: 'per_doc_sharing_removed',
      });
      const doc = await post('/api/share/doc', {
        docId: memberA,
        allowDomains: ['partner.example'],
      });
      expect(doc.status).toBe(410);
      expect((await doc.json()) as { error: string }).toMatchObject({
        error: 'per_doc_sharing_removed',
      });
      // POSITIVE CONTROL: minting is not broken in general — a share on the
      // BOARD that grouping is filed on succeeds on the same route.
      const ok = await post('/api/share/link', { workspaceId: boardA });
      expect(ok.status).toBe(200);
      const { share } = (await ok.json()) as { share: { shareId: string; workspaceId: string } };
      expect(share.workspaceId).toBe(boardA);
      expect((await local(`/api/share/${share.shareId}`, { method: 'DELETE' })).status).toBe(200);
    });

    it('refuses to mint a grouping-scoped share, on both kinds of grouping', async () => {
      // The inversion of what used to be "a share on ONE grouping reaches its
      // members": both a diff review and a folder bind are groupings, both are
      // real ids, and neither can be shared on its own any more.
      for (const grouping of [groupingA, folderGroupingA]) {
        const r = await post('/api/share/link', { workspaceId: grouping });
        expect(r.status, grouping).toBe(410);
        const body = (await r.json()) as { error: string; hint: string };
        expect(body.error).toBe('grouping_sharing_removed');
        // A refusal that names nothing reads as a broken server.
        expect(body.hint).toContain('board');
      }
      // POSITIVE CONTROL on the same route in the same pass: the board those
      // two groupings are filed on mints.
      const ok = await post('/api/share/link', { workspaceId: boardA });
      expect(ok.status).toBe(200);
      const { share } = (await ok.json()) as { share: { shareId: string } };
      expect((await local(`/api/share/${share.shareId}`, { method: 'DELETE' })).status).toBe(200);
    });

    it('a board holding ONE review reaches that review and nothing around it', async () => {
      // The surviving form of "being ON a board is not being INVITED to it".
      // A visitor invited to a board that holds one review gets that review —
      // not the reviews on board A, and not board A itself.
      const narrowBoard = await newBoard('board-narrow');
      const narrow = await newDiffOn(narrowBoard, 'rev-narrow');
      const narrowMember = narrow.files[0]?.docId ?? '';
      expect(narrowMember).not.toBe('');

      const gs = await post('/api/share/link', { workspaceId: narrowBoard });
      expect(gs.status).toBe(200);
      const narrowCookie = await redeem(
        ((await gs.json()) as { share: { slug: string } }).share.slug,
      );
      // Positive control: its own board, its own review's tree, its own member.
      expect((await pub(`/api/workspaces/${narrowBoard}`, narrowCookie)).status).toBe(200);
      expect((await pub(`/api/workspaces/${narrow.reviewId}/tree`, narrowCookie)).status).toBe(200);
      expect((await pub(`/api/docs/${narrowMember}`, narrowCookie)).status).toBe(200);
      // …and board A does not open — neither page nor record.
      expect((await pub(`/workspaces/${boardA}`, narrowCookie)).status).toBe(403);
      expect((await pub(`/api/workspaces/${boardA}`, narrowCookie)).status).toBe(403);
      // …nor either review filed on it, which is the widening a narrow invite
      // must never pick up from a board it is not on.
      expect((await pub(`/api/workspaces/${groupingA}/tree`, narrowCookie)).status).toBe(403);
      expect((await pub(`/api/docs/${memberA}`, narrowCookie)).status).toBe(403);
      expect((await pub(`/api/workspaces/${folderGroupingA}/tree`, narrowCookie)).status).toBe(403);
      expect((await pub(`/api/docs/${folderEntryA}`, narrowCookie)).status).toBe(403);
      // …nor anything on the other board at all.
      expect((await pub(`/api/docs/${memberB}`, narrowCookie)).status).toBe(403);
    });
  });

  /**
   * A review can sit on TWO boards at once — `attach_doc` links, it does not
   * move, and only the default holding pen is unfiled on the way. So "which
   * board is this on" has no single answer, and a resolver that returns the
   * first match refuses the visitors of every board after it.
   *
   * This is the same failure the `unfileFromDefault` comment records — a
   * workspace visitor 403'd on the very doc their share was created for —
   * surviving in the case that comment could not fix, because two REAL boards
   * are both legitimate homes and neither may be dropped.
   */
  describe('a review on two boards opens from BOTH of them', () => {
    it('serves the shared review to a visitor of either board', async () => {
      const secondBoard = await newBoard('board-gamma');
      const shared = await newDiffOn(boardA, 'rev-shared');
      const sharedMember = shared.files[0]?.docId ?? '';
      expect(sharedMember).not.toBe('');
      // Link the SAME review to a second real board. Both keep it.
      expect(
        (await post(`/api/workspaces/${secondBoard}/docs`, { docId: 'rev-shared' })).status,
      ).toBe(200);
      expect(handle.tasks.getWorkspace(boardA)?.docIds).toContain('rev-shared');
      expect(handle.tasks.getWorkspace(secondBoard)?.docIds).toContain('rev-shared');

      const gs = await post('/api/share/link', { workspaceId: secondBoard });
      const gammaCookie = await redeem(
        ((await gs.json()) as { share: { slug: string } }).share.slug,
      );

      // Positive control: the gamma visitor is a real visitor on its board.
      expect((await pub(`/api/workspaces/${secondBoard}`, gammaCookie)).status).toBe(200);

      // Both boards reach it — neither link is the "first" one.
      for (const cookie of [cookieA, gammaCookie]) {
        expect((await pub('/api/workspaces/rev-shared/tree', cookie)).status).toBe(200);
        expect((await pub(`/api/docs/${sharedMember}`, cookie)).status).toBe(200);
      }

      // …and a third board that was never linked still gets nothing.
      const bs = await post('/api/share/link', { workspaceId: boardB });
      const betaCookie = await redeem(
        ((await bs.json()) as { share: { slug: string } }).share.slug,
      );
      expect((await pub(`/api/workspaces/${boardB}`, betaCookie)).status).toBe(200); // control
      expect((await pub('/api/workspaces/rev-shared/tree', betaCookie)).status).toBe(403);
      expect((await pub(`/api/docs/${sharedMember}`, betaCookie)).status).toBe(403);
    });
  });
});
