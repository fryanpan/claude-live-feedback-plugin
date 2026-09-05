/**
 * Minimal-share slice for the workspace board (§3.12 commit 8), driven through
 * the real route table in link mode — link and Access shares run the same
 * scope engine, so the guard proven here is the guard both modes get.
 *
 * Three NEW guard allowances, each tested presence-then-absence per
 * transport (the §6 rule: a negative test needs a positive control):
 *
 *   1. the board page (GET /workspaces/<id>)
 *   2. the ws:<id> board room socket (/y/ws:<id>) — a REAL Yjs sync, not a
 *      raw socket (a raw socket never completes the handshake and every
 *      absence it reports is vacuous; see learnings.md)
 *   3. the workspace SSE feed (/workspaces/<id>)/events:stream
 *
 * Plus the two boundaries the plan states: visitors are READ-ONLY on the
 * gate (every task/goal/decision mutation route refuses visitor auth) and
 * may post comments only; and a visitor scoped to a DIFFERENT workspace gets
 * none of the three.
 *
 * That last one used to be a DOC-scoped invite. A workspace is now the unit
 * of sharing (2026-08-17) and there is no per-doc share to hold, so the
 * out-of-scope visitor is a share on a second workspace — which is the same
 * assertion (a share that is not THIS workspace's reaches none of these
 * transports) proven with a grant that still exists. The removal itself is
 * asserted rather than dropped: `share_link` with a `docId` answers 410.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailDisplayName } from '@feedback/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { BOARD_FEEDBACK_DOC_ID, type ServerHandle, createServer } from '../src/server.ts';
import {
  ACCESS_BASE_HOSTNAME,
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

/** The address the Access harness signs every visitor token as. */
const VISITOR_EMAIL = 'reviewer@partner.example';

const MSG_SYNC = 0;

/** The repo's own Yjs client (ws.test.ts shape), plus headers so a share
 *  visitor's cookie can ride the upgrade. */
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
  let gotSyncStep2 = false;

  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const data = new Uint8Array(ev.data as ArrayBuffer);
    const dec = decoding.createDecoder(data);
    const kind = decoding.readVarUint(dec);
    if (kind === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (
        !gotSyncStep2 &&
        (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate)
      ) {
        gotSyncStep2 = true;
        resolveReady?.();
      }
    }
  });

  return { ws, ydoc, ready, close: () => ws.close() };
}

/** Read an SSE body until `predicate` matches the accumulated text. */
async function readSseUntil(
  res: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 4000,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !predicate(text)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((r) =>
          setTimeout(() => r({ done: true }), Math.max(1, deadline - Date.now())),
        ),
      ]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/** Pull the first `data:` JSON payload for a given event name out of an SSE
 *  transcript. */
function sseData(text: string, event: string): Record<string, unknown> | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === `event: ${event}` && lines[i + 1]?.startsWith('data: ')) {
      return JSON.parse(lines[i + 1]!.slice('data: '.length));
    }
  }
  return null;
}

describe('workspace-board minimal share (§3.12 commit 8)', () => {
  let handle: ServerHandle;
  let access: AccessHarness;
  let dataDir: string;
  let base: string;
  let wsBase: string;

  let boardId: string;
  let taskId: string;
  let decisionId: string;
  let boardShare: MintedShare;
  let boardCookie: Record<string, string>;
  /** A second, unrelated board workspace and a live share on it. This is the
   *  "authorized visitor who is not in THIS workspace" — the shape that
   *  replaces the doc-scoped invite. */
  let otherId: string;
  let otherCookie: Record<string, string>;

  const ATTACHED = 'plan-doc';
  const PRIVATE = 'private-doc';
  /**
   * The id the server MINTED for `plan-doc`. The board's membership — and so
   * every share-scope answer about it — is keyed by this; `plan-doc` stays
   * the readable alias the attach below is written with.
   */
  let attachedId: string;
  /** …and for `private-doc`, so the refusals below are refusals of a doc that
   *  really exists rather than of a name that resolves to nothing. */
  let privateId: string;

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

  /** A request as a share visitor: their own hostname and their own token.
   *  With no visitor it is the un-signed-in caller Access has not vouched
   *  for, which is what every 403 below is about. */
  const pub = (path: string, visitor?: Record<string, string>, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: ACCESS_BASE_HOSTNAME,
        ...(visitor ?? {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'board-share-'));
    access = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
    });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;

    // Two markdown docs: one attached to the board workspace, one private.
    for (const id of [ATTACHED, PRIVATE]) {
      const path = join(dataDir, `${id}.md`);
      writeFileSync(path, `# ${id}\n\nBody text to comment on.\n`);
      const r = await post('/api/docs', { docId: id, type: 'markdown', sourceUrl: path });
      expect(r.status).toBe(200);
      const minted = ((await r.json()) as { docId: string }).docId;
      if (id === ATTACHED) attachedId = minted;
      else privateId = minted;
    }
    expect(attachedId).toBeTruthy();
    expect(privateId).toBeTruthy();

    // The board workspace, one attached doc, one task, one open decision.
    const ws = await post('/api/workspaces', { name: 'search-revamp' });
    expect(ws.status).toBe(200);
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    expect((await post(`/api/workspaces/${boardId}/docs`, { docId: ATTACHED })).status).toBe(200);

    const t = await post(`/api/workspaces/${boardId}/tasks`, {
      author: PERSON,
      title: 'Wire the store',
    });
    expect(t.status).toBe(200);
    taskId = ((await t.json()) as { task: { id: string } }).task.id;

    const d = await post(`/api/workspaces/${boardId}/tasks`, {
      title: 'Ship search now, or wait for reindex?',
      assignee: 'human',
      needs: 'decision',
      body: 'Ship now or wait for the reindex? Waiting costs a week and removes the stale-results risk. Blocked until answered: the launch note.',
    });
    decisionId = ((await d.json()) as { task: { id: string } }).task.id;

    // Cross-reference so the chip endpoint has something to resolve.
    expect(
      (await post(`/api/tasks/${taskId}/links`, { ref: { kind: 'doc', docId: attachedId } }))
        .status,
    ).toBe(200);

    // A transition so the projected task carries an attributed history.
    expect(
      (
        await post(`/api/tasks/${taskId}/transition`, {
          to: 'in-progress',
          author: PERSON,
        })
      ).status,
    ).toBe(200);

    // A second workspace nobody here belongs to. It needs no docs of its own:
    // a board workspace is shareable with zero bound members, and its only job
    // is to authorize a visitor who is legitimately in SOME workspace.
    const other = await post('/api/workspaces', { name: 'billing-cleanup' });
    expect(other.status).toBe(200);
    otherId = ((await other.json()) as { workspace: { id: string } }).workspace.id;

    // Shares: the whole board workspace, and the unrelated workspace.
    boardShare = await mintAccessShare(base, access, boardId, { label: 'board share' });
    boardCookie = boardShare.headers;
    otherCookie = (await mintAccessShare(base, access, otherId, { label: 'other share' })).headers;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('minting + landing', () => {
    it('mints a share against a board workspace (no bound member docs required)', () => {
      // The capability is the HOSTNAME now, not a signature in the query: the
      // share gets its own Access application, and there is nothing in the URL
      // a person could hold without signing in.
      const u = new URL(boardShare.url);
      expect(u.hostname).toBe(boardShare.host);
      expect(u.hostname.endsWith(`.${ACCESS_BASE_HOSTNAME}`)).toBe(true);
      expect(u.search).toBe('');
    });

    it('the share URL lands IN the board — never a review URL, never a lobby', async () => {
      expect(new URL(boardShare.url).pathname).toBe(`/workspaces/${boardId}`);
      const r = await pub(`/workspaces/${boardId}`, boardShare.headers);
      expect(r.status).toBe(200);
    });

    /**
     * The doc-scoped invite this file used to mint for ATTACHED is gone —
     * a workspace is the unit of sharing, and a doc filed on one is reached
     * because it is a member. The refusal names the replacement rather than
     * 404ing, because an older plugin bundle's `share_link` keeps sending
     * `docId` to this same server long after this one stopped.
     */
    it('refuses to mint a share scoped to one doc, and names the replacement', async () => {
      const r = await post('/api/share/link', {
        allowDomains: ['@partner.example'],
        docId: ATTACHED,
        label: 'doc share',
      });
      expect(r.status).toBe(410);
      const body = (await r.json()) as { error: string; hint?: string };
      expect(body.error).toBe('per_doc_sharing_removed');
      expect(body.hint).toContain('workspaceId');
      // Positive control: the workspace ATTACHED is filed on shares fine, and
      // that share is what reaches the doc (see the doc block further down).
      const ok = await post('/api/share/link', {
        allowDomains: ['@partner.example'],
        workspaceId: boardId,
      });
      expect(ok.status).toBe(200);
      await local(
        `/api/share/${((await ok.json()) as { share: { shareId: string } }).share.shareId}`,
        { method: 'DELETE' },
      );
    });
  });

  describe('transport 1: the board page', () => {
    it('serves the board page to a workspace visitor (presence)', async () => {
      const r = await pub(`/workspaces/${boardId}`, boardCookie);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('search-revamp'); // the real shell, not a stub
    });

    it('refuses it without a session, and to another workspace’s visitor (absence)', async () => {
      // 403, not 401: with Access in front of every browser-facing host a
      // request that proves nothing is refused outright, not invited to sign
      // in at a surface this server serves.
      expect((await pub(`/workspaces/${boardId}`)).status).toBe(403);
      // Positive control: the same cookie serves its OWN board page, so the
      // 403 is the scope check rather than a dead session.
      expect((await pub(`/workspaces/${otherId}`, otherCookie)).status).toBe(200);
      expect((await pub(`/workspaces/${boardId}`, otherCookie)).status).toBe(403);
    });

    // The board-feedback doc is SHARED BY EVERY WORKSPACE, and Yjs sync is a
    // state exchange rather than a per-connection projection — so a visitor
    // handed the widget would sync every other workspace's feedback threads,
    // including the board paths and quoted UI text they were anchored to. The
    // widget is therefore owner-only, and the absence is asserted next to the
    // owner's presence so it can't pass by the page simply being empty.
    it('does not hand the shared feedback widget to a share visitor', async () => {
      const visitorHtml = await (await pub(`/workspaces/${boardId}`, boardCookie)).text();
      expect(visitorHtml).toContain('search-revamp'); // the real shell
      expect(visitorHtml).not.toContain('claude-feedback-widget');
      expect(visitorHtml).not.toContain(BOARD_FEEDBACK_DOC_ID);

      // Positive control: the SAME page, fetched as the owner, does carry it.
      const ownerHtml = await (await local(`/workspaces/${boardId}`)).text();
      expect(ownerHtml).toContain('claude-feedback-widget');
      expect(ownerHtml).toContain(BOARD_FEEDBACK_DOC_ID);
    });
  });

  describe('transport 2: the ws:<id> board room socket', () => {
    it('a workspace visitor completes a REAL Yjs sync and sees the board (presence)', async () => {
      const client = connectDoc(`${wsBase}/y/ws%3A${boardId}`, { ...boardCookie });
      try {
        await client.ready;
        // Positive control FIRST: the doc's own state arrived. Without this
        // every absence below is vacuous (the raw-WebSocket lesson).
        const tasks = client.ydoc.getMap('tasks');
        const projected = tasks.get(taskId) as Record<string, unknown> | undefined;
        expect(projected).toBeDefined();
        expect(projected?.title).toBe('Wire the store');

        // What synced is EXACTLY the §3.3 visitor contract: no body
        // snapshot, transition actors as display names without ids.
        expect(projected?.body).toBeUndefined();
        const transitions = (projected?.transitions ?? []) as Array<{
          by: Record<string, unknown>;
        }>;
        expect(transitions.length).toBeGreaterThan(0);
        expect(transitions[0]?.by.name).toBe('Jordan');
        expect(transitions[0]?.by.id).toBeUndefined();
      } finally {
        client.close();
      }
    });

    it('refuses the socket to another workspace’s visitor whose socket auth otherwise works (absence)', async () => {
      // Positive control: the SAME cookie passes the guard for its own board
      // room (426 = past the guard, upgrade-required on a plain fetch).
      expect((await pub(`/y/ws%3A${otherId}`, otherCookie)).status).toBe(426);
      expect((await pub(`/y/ws%3A${boardId}`, otherCookie)).status).toBe(403);
      expect((await pub(`/y/ws%3A${boardId}`)).status).toBe(403);
    });
  });

  describe('transport 3: the workspace SSE feed', () => {
    it('delivers live task events to a workspace visitor, redacted to display names (presence)', async () => {
      const stream = await pub(`/workspaces/${boardId}/events:stream`, boardCookie);
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');

      const trigger = post(`/api/tasks/${taskId}/transition`, {
        to: 'done',
        author: PERSON,
        note: 'shipped',
      });
      const text = await readSseUntil(stream, (t) => t.includes('task.transitioned'));
      expect((await trigger).status).toBe(200);

      const payload = sseData(text, 'task.transitioned');
      expect(payload).not.toBeNull();
      // Positive control: the event arrived with its display identity…
      const actor = payload?.actor as Record<string, unknown>;
      expect(actor.name).toBe('Jordan');
      // …and the absence: no actor id on a visitor stream.
      expect(actor.id).toBeUndefined();
    });

    it('the OWNER stream still carries actor ids (positive control for the redaction)', async () => {
      const stream = await local(`/workspaces/${boardId}/events:stream`);
      expect(stream.status).toBe(200);
      const trigger = post(`/api/tasks/${taskId}/transition`, {
        to: 'in-progress',
        author: PERSON,
      });
      const text = await readSseUntil(stream, (t) => t.includes('task.transitioned'));
      expect((await trigger).status).toBe(200);
      const payload = sseData(text, 'task.transitioned');
      expect((payload?.actor as Record<string, unknown>).id).toBe(PERSON.id);
    });

    it('refuses the feed to another workspace’s visitor (absence)', async () => {
      // Positive control: that cookie opens its OWN workspace feed.
      const own = await pub(`/workspaces/${otherId}/events:stream`, otherCookie);
      expect(own.status).toBe(200);
      await own.body?.cancel().catch(() => {});
      expect((await pub(`/workspaces/${boardId}/events:stream`, otherCookie)).status).toBe(403);
      expect((await pub(`/workspaces/${boardId}/events:stream`)).status).toBe(403);
    });

    // Voice landed AFTER the commit-8 share slice, and §3.3's enumeration of
    // what a visitor may see is exhaustive by construction — it lists goal
    // titles and verbatim quote/answer fields, never the transcript of
    // whatever Bryan happens to say into his own board. The utterance is
    // unbounded free text about anything he is thinking; it does not get to
    // extend the contract by arriving later.
    it('never puts a voice transcript on a visitor stream (absence)', async () => {
      const stream = await pub(`/workspaces/${boardId}/events:stream`, boardCookie);
      expect(stream.status).toBe(200);
      const trigger = post(`/api/workspaces/${boardId}/voice`, {
        transcript: 'hold the release until legal clears the acquisition question',
        author: PERSON,
      });
      const text = await readSseUntil(stream, (t) => t.includes('voice.request'));
      expect((await trigger).status).toBe(200);
      const payload = sseData(text, 'voice.request');
      // Positive control: the event itself DOES reach the visitor — someone
      // spoke, and the route is visible…
      expect(payload).not.toBeNull();
      expect(payload?.route).toBeDefined();
      expect((payload?.actor as Record<string, unknown>).name).toBe('Jordan');
      // …but the words are not.
      expect(payload?.transcript).toBeUndefined();
      expect(payload?.ack).toBeUndefined();
      expect(payload?.context).toBeUndefined();
    });

    it('the OWNER stream still carries the transcript (positive control)', async () => {
      const stream = await local(`/workspaces/${boardId}/events:stream`);
      expect(stream.status).toBe(200);
      const trigger = post(`/api/workspaces/${boardId}/voice`, {
        transcript: 'open the task about the device re-run',
        author: PERSON,
      });
      const text = await readSseUntil(stream, (t) => t.includes('voice.request'));
      expect((await trigger).status).toBe(200);
      const payload = sseData(text, 'voice.request');
      expect(payload?.transcript).toBe('open the task about the device re-run');
    });
  });

  // §2.7's ambient-awareness strip and the page title are the two REST reads
  // the board client makes on load. Both were outside share scope, so a
  // visitor's page titled itself with the raw workspace id and showed no
  // agents at all — while the same records rode their SSE feed. The two
  // doors have to agree; `fetchJson` swallows a non-ok, so the disagreement
  // was silent.
  describe('the board page’s own REST reads are in scope', () => {
    it('serves the workspace record to its own visitor, refuses another workspace’s', async () => {
      const r = await pub(`/api/workspaces/${boardId}`, boardCookie);
      expect(r.status).toBe(200);
      const { workspace } = (await r.json()) as { workspace: { name: string } };
      expect(workspace.name).toBe('search-revamp'); // the page title, not the id
      // Positive control for the refusal: the other cookie reads ITS record.
      expect((await pub(`/api/workspaces/${otherId}`, otherCookie)).status).toBe(200);
      expect((await pub(`/api/workspaces/${boardId}`, otherCookie)).status).toBe(403);
      expect((await pub(`/api/workspaces/${boardId}`)).status).toBe(403);
    });

    /**
     * The strip's decision half arrives over the board room and its thread
     * half over this route, so a gate that allows one and refuses the other
     * leaves a visitor a strip that silently drops every question — the same
     * split-transport failure as the two reads above.
     */
    it('serves the review queue to its own visitor, refuses another workspace’s', async () => {
      const r = await pub(`/api/workspaces/${boardId}/review-items`, boardCookie);
      expect(r.status).toBe(200);
      const seen = (await r.json()) as { items: unknown[] };
      expect(Array.isArray(seen.items)).toBe(true);
      expect((await pub(`/api/workspaces/${otherId}/review-items`, otherCookie)).status).toBe(200);
      expect((await pub(`/api/workspaces/${boardId}/review-items`, otherCookie)).status).toBe(403);
      expect((await pub(`/api/workspaces/${boardId}/review-items`)).status).toBe(403);
      // The board's rows are a member's too now (2026-09-03), so what a
      // stranger is refused is the board, not the verb: an un-vouched-for
      // caller and a member of the OTHER board both get nothing here.
      expect((await pub(`/api/workspaces/${boardId}/tasks`, boardCookie)).status).toBe(200);
      expect((await pub(`/api/workspaces/${boardId}/tasks`, otherCookie)).status).toBe(403);
      expect((await pub(`/api/workspaces/${boardId}/tasks`)).status).toBe(403);
    });

    it('serves agent presence redacted — no endpoint — with the owner’s copy as the control', async () => {
      const att = await post(`/workspaces/${boardId}/agents`, {
        agentId: 'agent-search-revamp',
        runtime: 'webhook',
        endpoint: 'https://agents.internal.example/hooks/search-revamp',
        capabilities: ['tasks.write'],
      });
      expect(att.status).toBe(200);

      const owner = (await (await local(`/workspaces/${boardId}/agents`)).json()) as {
        attachments: Array<Record<string, unknown>>;
      };
      expect(owner.attachments[0]?.endpoint).toBe(
        'https://agents.internal.example/hooks/search-revamp',
      );

      const r = await pub(`/workspaces/${boardId}/agents`, boardCookie);
      expect(r.status).toBe(200);
      const seen = (await r.json()) as { attachments: Array<Record<string, unknown>> };
      // Positive control: the visitor really sees the agent…
      expect(seen.attachments[0]?.agentId).toBe('agent-search-revamp');
      expect(seen.attachments[0]?.state).toBeDefined();
      // …and never where it lives.
      expect(seen.attachments[0]?.endpoint).toBeUndefined();
      expect((await pub(`/workspaces/${otherId}/agents`, otherCookie)).status).toBe(200);
      expect((await pub(`/workspaces/${boardId}/agents`, otherCookie)).status).toBe(403);
    });
  });

  describe('the board page a member is served', () => {
    it('tells the member who they are, so the board paints instead of prompting', async () => {
      // Without this the bundle read "nobody is signed in", opened the
      // "Who's reviewing?" prompt that `main()` awaits, and never built the
      // topbar at all.
      const r = await pub('/api/auth/session', boardCookie);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { authenticated: boolean; user?: { name: string } };
      expect(body.authenticated).toBe(true);
      expect(body.user?.name).toBe(emailDisplayName(VISITOR_EMAIL));
    });

    it('leaves out the all-workspaces arrow — `/` is not a page on this host', async () => {
      const seen = await (await pub(`/workspaces/${boardId}`, boardCookie)).text();
      expect(seen).toContain('id="board-root"');
      expect(seen).toContain('data-visitor="1"');
      // POSITIVE CONTROL: the owner's own copy of the same page does not
      // carry the flag, so the assertion above is about the visitor and not
      // about a shell that stamps it on everything.
      const owner = await (await local(`/workspaces/${boardId}`)).text();
      expect(owner).toContain('id="board-root"');
      expect(owner).not.toContain('data-visitor');
      // And `/` really is refused here, which is what the arrow would hit.
      expect((await pub('/', boardCookie)).status).toBe(403);
    });
  });

  describe('a member is a participant on the board they were admitted to', () => {
    /**
     * Bryan, 2026-09-03: "Let's allow everything for now." Each admitted
     * route gets a request that SUCCEEDS on the share host for the shared
     * board — a positive control per route, so a refusal on the next block
     * cannot be the fixture failing to reach anything.
     */
    it('files, edits, moves and answers work on the shared board', async () => {
      const author = PERSON;
      const filed = await pub(`/api/workspaces/${boardId}/tasks`, boardCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Filed by a member', assignee: 'human', author }),
      });
      expect(filed.status, await filed.clone().text()).toBe(200);
      const filedId = ((await filed.json()) as { task: { id: string } }).task.id;

      const cases: Array<[string, RequestInit]> = [
        [`/api/workspaces/${boardId}/tasks`, { method: 'GET' }],
        [
          `/api/workspaces/${boardId}/home?user=${encodeURIComponent(PERSON.id)}`,
          { method: 'GET' },
        ],
        [
          `/api/workspaces/${boardId}/home/read`,
          { method: 'POST', body: JSON.stringify({ author }) },
        ],
        [
          `/api/workspaces/${boardId}/goals/add`,
          { method: 'POST', body: JSON.stringify({ title: 'A member’s goal', author }) },
        ],
        [
          `/api/tasks/${filedId}/title`,
          { method: 'POST', body: JSON.stringify({ title: 'Retitled by a member', author }) },
        ],
        [
          `/api/tasks/${filedId}/body`,
          { method: 'POST', body: JSON.stringify({ markdown: 'Rewritten.', author }) },
        ],
        [
          `/api/tasks/${filedId}/assignee`,
          { method: 'POST', body: JSON.stringify({ assignee: 'human', author }) },
        ],
        [
          `/api/tasks/${filedId}/goal`,
          { method: 'POST', body: JSON.stringify({ goal: 'chores', author }) },
        ],
        [
          `/api/tasks/${filedId}/links`,
          {
            method: 'POST',
            body: JSON.stringify({ ref: { kind: 'doc', docId: ATTACHED }, author }),
          },
        ],
        [`/api/tasks/${filedId}/links`, { method: 'GET' }],
        [
          `/api/tasks/${filedId}/transition`,
          { method: 'POST', body: JSON.stringify({ to: 'in-progress', author }) },
        ],
        [
          `/api/tasks/${decisionId}/answer`,
          { method: 'POST', body: JSON.stringify({ text: 'Ship now.', author }) },
        ],
      ];
      for (const [path, init] of cases) {
        const r = await pub(path, boardCookie, {
          ...init,
          headers: { 'content-type': 'application/json' },
        });
        expect(r.status, `${init.method} ${path}: ${await r.clone().text()}`).toBe(200);
      }

      // …and the board really changed: the owner surface reads the member's
      // work back. A 200 from a route that dropped the write would pass the
      // loop above and fail here.
      const listed = (await (await local(`/api/workspaces/${boardId}/tasks`)).json()) as {
        tasks: Array<{ id: string; title: string; status: string }>;
      };
      const row = listed.tasks.find((t) => t.id === filedId);
      expect(row?.title).toBe('Retitled by a member');
      expect(row?.status).toBe('in-progress');
    });

    it('attributes the member’s writes to the email Cloudflare Access verified', async () => {
      // The body claims a fleet identity; the trail must name the verified
      // address instead. Same rule the comment routes already follow — this
      // change added no second identity source, it reused `authorFor`.
      const filed = await pub(`/api/workspaces/${boardId}/tasks`, boardCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Whose task is this',
          assignee: 'human',
          author: { id: 'known-bryan', name: 'Mallory', kind: 'known' },
        }),
      });
      expect(filed.status).toBe(200);
      const { task } = (await filed.json()) as { task: { id: string; createdBy?: string } };
      expect(task.createdBy).toBe(emailDisplayName(VISITOR_EMAIL));
      expect(task.createdBy).not.toBe('Mallory');

      // …and on the task trail, which is what the owner actually reads back.
      const moved = await pub(`/api/tasks/${task.id}/transition`, boardCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          to: 'in-progress',
          author: { id: 'known-bryan', name: 'Mallory', kind: 'known' },
        }),
      });
      expect(moved.status).toBe(200);
      const log = await local(`/api/workspaces/${boardId}/events`);
      expect(log.status).toBe(200);
      const { events } = (await log.json()) as {
        events: Array<{ taskId?: string; actor?: { id: string; name: string } }>;
      };
      const mine = events.filter((e) => e.taskId === task.id && e.actor);
      expect(mine.length).toBeGreaterThan(0);
      for (const e of mine) {
        expect(e.actor?.name).toBe(emailDisplayName(VISITOR_EMAIL));
        expect(e.actor?.id).not.toBe('known-bryan');
      }
    });

    it('refuses every row on a board this member was NOT given', async () => {
      // `otherCookie` holds the OTHER board; `taskId` is on the board.
      // The same verbs the test above ran green.
      for (const [path, init] of [
        [
          `/api/tasks/${taskId}/transition`,
          { method: 'POST', body: JSON.stringify({ to: 'done' }) },
        ],
        [`/api/tasks/${taskId}/title`, { method: 'POST', body: JSON.stringify({ title: 'X' }) }],
        [
          `/api/workspaces/${boardId}/tasks`,
          { method: 'POST', body: JSON.stringify({ title: 'X' }) },
        ],
        [`/api/workspaces/${boardId}/tasks`, { method: 'GET' }],
      ] as Array<[string, RequestInit]>) {
        const r = await pub(path, otherCookie, {
          ...init,
          headers: { 'content-type': 'application/json' },
        });
        expect(r.status, `${init.method} ${path}`).toBe(403);
      }
    });

    it('works this board’s own surfaces — settings, activity and a meeting', async () => {
      // Bryan, 2026-09-03: a share link means full access to the board. Each
      // of these was refused while a member was a reader, and each is the
      // positive control for the same path on a board they were not given
      // (the describe above) — one route, two members, two answers.
      const readSettings = await pub(`/api/workspaces/${boardId}/settings`, boardCookie, {
        method: 'GET',
      });
      expect(readSettings.status, await readSettings.clone().text()).toBe(200);
      const wrote = await pub(`/api/workspaces/${boardId}/settings`, boardCookie, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewItemCriteria: 'Written by a member.' }),
      });
      expect(wrote.status, await wrote.clone().text()).toBe(200);
      const activity = await pub(`/api/workspaces/${boardId}/events`, boardCookie, {
        method: 'GET',
      });
      expect(activity.status).toBe(200);
      const meeting = await pub(`/api/workspaces/${boardId}/huddles`, boardCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'discussion' }),
      });
      expect(meeting.status, await meeting.clone().text()).toBe(200);
      // Filing a doc this member can already open onto the same board.
      const filed = await pub(`/api/workspaces/${boardId}/docs`, boardCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: ATTACHED }),
      });
      expect(filed.status, await filed.clone().text()).toBe(200);

      // …and every one of them is refused on the board this member was NOT
      // given, which is what makes the four answers above a grant on ONE
      // board rather than on the server.
      for (const [path, init] of [
        [`/api/workspaces/${boardId}/settings`, { method: 'GET' }],
        [
          `/api/workspaces/${boardId}/settings`,
          { method: 'PUT', body: JSON.stringify({ reviewItemCriteria: 'X' }) },
        ],
        [`/api/workspaces/${boardId}/events`, { method: 'GET' }],
        [`/api/workspaces/${boardId}/huddles`, { method: 'POST', body: '{}' }],
      ] as Array<[string, RequestInit]>) {
        const r = await pub(path, otherCookie, {
          ...init,
          headers: { 'content-type': 'application/json' },
        });
        expect(r.status, `${init.method} ${path}`).toBe(403);
      }
    });

    it('refuses everything that is not work on this board', async () => {
      const author = PERSON;
      const cases: Array<[string, RequestInit]> = [
        // Filing a doc this member cannot already open would be a read of
        // somebody else's board wearing a write's clothes. `PRIVATE` is on no
        // board this share covers; filing `ATTACHED`, which is on this one,
        // is allowed and asserted in the test above — so this row is the
        // TARGET rule and not the verb.
        [
          `/api/workspaces/${boardId}/docs`,
          { method: 'POST', body: JSON.stringify({ docId: PRIVATE }) },
        ],
        // Reads a file off the owner's disk by the path in the body.
        [
          `/api/workspaces/${boardId}/import-tasks`,
          { method: 'POST', body: JSON.stringify({ path: '/etc/hosts', author }) },
        ],
        // The agent roster's own verbs.
        [
          `/workspaces/${boardId}/agents`,
          {
            method: 'POST',
            body: JSON.stringify({ agentId: 'agent-x', runtime: 'claude-code-local' }),
          },
        ],
        // Board lifecycle.
        [`/api/workspaces/${boardId}`, { method: 'DELETE' }],
        [
          `/api/workspaces/${boardId}/lead`,
          { method: 'PUT', body: JSON.stringify({ agentId: 'agent-x' }) },
        ],
        [
          `/api/workspaces/${boardId}/goals`,
          { method: 'PUT', body: JSON.stringify({ goals: [], author }) },
        ],
        [
          `/api/workspaces/${boardId}/voice`,
          { method: 'POST', body: JSON.stringify({ transcript: 'delete everything', author }) },
        ],
        // The whole-server lists and the global review-item resolver.
        ['/api/workspaces', { method: 'GET' }],
        ['/api/docs', { method: 'GET' }],
        ['/api/review-items/r-anything', { method: 'GET' }],
        // Share administration — minting, revoking, and the master switch.
        [
          '/api/share/workspace',
          { method: 'POST', body: JSON.stringify({ workspaceId: boardId }) },
        ],
        ['/api/share', { method: 'GET' }],
        ['/api/share/some-link-id', { method: 'DELETE' }],
        ['/api/share/enabled', { method: 'POST', body: JSON.stringify({ enabled: false }) }],
        // Not workspace-scoped, and the only routes here that reach OUTSIDE
        // this process — the plugin cache, and a restart that would drop
        // every live editor socket. Refused by `shareScopeAllows` before any
        // route runs; the layer-level assertions live in host-guard.test.ts
        // and deploy-reachability.test.ts. These rows confirm the gate is
        // wired in front of them.
        ['/api/plugin/refresh', { method: 'POST' }],
        ['/api/deploy', { method: 'POST' }],
        ['/api/deploy', { method: 'GET' }],
      ];
      for (const [path, init] of cases) {
        const r = await pub(path, boardCookie, {
          ...init,
          headers: { 'content-type': 'application/json' },
        });
        expect(r.status, `${init.method} ${path}`).toBe(403);
      }
    });

    it('the master switch still closes the door on a member', async () => {
      expect((await post('/api/share/enabled', { enabled: false })).status).toBe(200);
      try {
        const r = await pub(`/api/workspaces/${boardId}/tasks`, boardCookie, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'While the door is shut', assignee: 'human' }),
        });
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ error: 'sharing_disabled' });
      } finally {
        expect((await post('/api/share/enabled', { enabled: true })).status).toBe(200);
      }
      // Positive control: the same call lands again once it is back on.
      const again = await pub(`/api/workspaces/${boardId}/tasks`, boardCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'After the door reopened', assignee: 'human' }),
      });
      expect(again.status).toBe(200);
    });

    it('promotes a thread to a task, and edits the region it is anchored to', async () => {
      const mk = await post(`/api/docs/${attachedId}/threads/by_find`, {
        author: PERSON,
        text: 'This paragraph needs a task.',
        find: 'Body text',
      });
      expect(mk.status).toBe(200);
      const threadId = ((await mk.json()) as { thread: { id: string } }).thread.id;
      const r = await pub(`/api/docs/${attachedId}/threads/${threadId}/promote`, boardCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: boardId, author: PERSON }),
      });
      expect(r.status, await r.clone().text()).toBe(200);
      const surgery = await pub(
        `/api/docs/${attachedId}/threads/${threadId}/rewrite_region`,
        boardCookie,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ replacement: 'Replaced by a member.', author: PERSON }),
        },
      );
      // A member holds this doc's own editing socket, which is unrestricted
      // text editing on the same document — so the REST spelling of an edit
      // they can make by typing is no longer refused.
      expect(surgery.status, await surgery.clone().text()).toBe(200);
      // …and the same verb on a doc THIS member cannot open stays refused,
      // which is the boundary that was ever doing the work.
      const elsewhere = await pub(
        `/api/docs/${privateId}/threads/${threadId}/rewrite_region`,
        boardCookie,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ replacement: 'Replaced.', author: PERSON }),
        },
      );
      expect(elsewhere.status).toBe(403);
      // And the member can reply on the same thread.
      const reply = await pub(`/api/docs/${attachedId}/threads/${threadId}/comments`, boardCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: PERSON, text: 'Agreed — but from a member.' }),
      });
      expect(reply.status).toBe(200);
    });

    it('naming a meeting speaker is refused — it rewrites the record and the notes', async () => {
      const rename = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ speaker: 'A', name: 'Priya' }),
      };
      const r = await pub(`/api/docs/${attachedId}/meetings/m-none/speakers`, boardCookie, rename);
      // 403 BEFORE the meeting lookup: the guard, not a missing meeting.
      expect(r.status).toBe(403);
      // Positive control: the owner's same probe gets PAST the guard and is
      // refused by the lookup instead — the route was really reached.
      expect((await local(`/api/docs/${attachedId}/meetings/m-none/speakers`, rename)).status).toBe(
        404,
      );
    });
  });

  describe('a workspace visitor reaches the workspace’s own docs, comments only', () => {
    it('reads the attached doc and the task body room', async () => {
      expect((await pub(`/api/docs/${attachedId}`, boardCookie)).status).toBe(200);
      expect((await pub(`/api/docs/task%3A${taskId}`, boardCookie)).status).toBe(200);
    });

    it('the doc payload never hands a visitor the board workspace id', async () => {
      // Positive control: the owner's copy of the same payload carries it —
      // the doc-surface voice dock resolves its workspace from this field.
      const owner = (await (await local(`/api/docs/${attachedId}`)).json()) as {
        hubWorkspaceId?: string;
      };
      expect(owner.hubWorkspaceId).toBe(boardId);
      const seen = (await (await pub(`/api/docs/${attachedId}`, boardCookie)).json()) as {
        hubWorkspaceId?: string;
      };
      expect(seen.hubWorkspaceId).toBeUndefined();
    });

    it('posts a comment under the proven email, never a claimed fleet identity', async () => {
      const r = await pub(`/api/docs/${attachedId}/threads/by_find`, boardCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: { id: 'known-bryan', name: 'Mallory', kind: 'known', color: '#123456' },
          text: 'A visitor comment.',
          find: 'comment on',
        }),
      });
      expect(r.status).toBe(200);
      const { thread } = (await r.json()) as {
        thread: { comments: Array<{ author: { id: string; name: string } }> };
      };
      // Access proved who this is, so the comment carries that identity —
      // and the fleet id the body claimed is not it. The old assertion here
      // was `guest-`, which is what a visitor got when nothing was proven.
      const author = thread.comments[0]?.author;
      expect(author?.id).not.toBe('known-bryan');
      // The display name is derived from the proven address, not typed.
      expect(author?.name).toBe('Reviewer');
    });

    it('still cannot reach a doc outside the workspace (absence)', async () => {
      expect((await pub(`/api/docs/${privateId}`, boardCookie)).status).toBe(403);
      expect((await pub(`/review/${privateId}`, boardCookie)).status).toBe(403);
    });
  });

  /**
   * The chip endpoint used to be justified by the doc-scoped invite: a
   * visitor who could see a doc but not the board still had to resolve the
   * task chips inside it. That visitor no longer exists — everyone who can
   * read a doc is in its workspace, and can sync the board room. What did
   * NOT change is the contract: the endpoint answers the §3.3 rule-2 shape
   * and stays scoped, so it is still not a task enumeration oracle for a
   * visitor holding some other workspace's link.
   */
  describe('task chips resolve via REST, in the §3.3 rule-2 shape', () => {
    it('GET /api/docs/<id>/tasks returns the chip shape, nothing more', async () => {
      const r = await pub(`/api/docs/${attachedId}/tasks`, boardCookie);
      expect(r.status).toBe(200);
      const { tasks } = (await r.json()) as { tasks: Array<Record<string, unknown>> };
      const chip = tasks.find((t) => t.id === taskId);
      expect(chip).toBeDefined(); // positive control: the chip resolves
      expect(chip?.title).toBe('Wire the store');
      // The SHAPE is the contract: adding a key here is a sharing decision.
      expect(Object.keys(chip ?? {}).sort()).toEqual(['assignee', 'id', 'status', 'title']);
    });

    it('the chip endpoint stays scoped — not a task enumeration oracle', async () => {
      // A doc in no shared workspace, and a doc in someone else's — both
      // refused, next to the 200 the in-scope read gets above.
      expect((await pub(`/api/docs/${privateId}/tasks`, boardCookie)).status).toBe(403);
      expect((await pub(`/api/docs/${attachedId}/tasks`, otherCookie)).status).toBe(403);
    });
  });

  describe('revocation hangs up the board, it does not just refuse', () => {
    it('closes the board room socket and the workspace stream a share had open', async () => {
      const share = await mintAccessShare(base, access, boardId);
      const cookie = share.headers;

      const client = connectDoc(`${wsBase}/y/ws%3A${boardId}`, { ...share.headers });
      await client.ready; // positive control: the socket really synced
      const closedCode = new Promise<number>((resolve) => {
        client.ws.addEventListener('close', (e) => resolve((e as CloseEvent).code));
        setTimeout(() => resolve(-1), 5000);
      });
      const stream = await pub(`/workspaces/${boardId}/events:stream`, cookie);
      expect(stream.status).toBe(200);

      const del = await local(`/api/share/${share.shareId}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      const body = (await del.json()) as { closedSockets?: number; closedStreams?: number };
      expect(body.closedSockets ?? 0).toBeGreaterThanOrEqual(1);
      expect(body.closedStreams ?? 0).toBeGreaterThanOrEqual(1);
      expect(await closedCode).toBe(1008);
      await stream.body?.cancel().catch(() => {});
    });
  });
});
