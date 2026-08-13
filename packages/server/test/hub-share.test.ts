/**
 * Minimal-share slice for the workspace hub (§3.12 commit 8), driven through
 * the real route table in link mode — link and Access shares run the same
 * scope engine, so the guard proven here is the guard both modes get.
 *
 * Three NEW guard allowances, each tested presence-then-absence per
 * transport (the §6 rule: a negative test needs a positive control):
 *
 *   1. the hub page (GET /workspaces/<id>)
 *   2. the ws:<id> board room socket (/y/ws:<id>) — a REAL Yjs sync, not a
 *      raw socket (a raw socket never completes the handshake and every
 *      absence it reports is vacuous; see learnings.md)
 *   3. the workspace SSE feed (/events/workspace/<id>)
 *
 * Plus the two boundaries the plan states: visitors are READ-ONLY on the
 * gate (every task/goal/decision mutation route refuses visitor auth) and
 * may post comments only; and a DOC-scoped invite gets none of the three —
 * task chips inside a doc resolve via GET /api/docs/<id>/tasks instead.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';
const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

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

describe('workspace-hub minimal share (§3.12 commit 8)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;

  let hubId: string;
  let taskId: string;
  let decisionId: string;
  let hubShare: { shareId: string; slug: string };
  let hubCookie: string;
  let docCookie: string;

  const ATTACHED = 'plan-doc';
  const PRIVATE = 'private-doc';

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

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'hub-share-'));
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;
    wsBase = `ws://localhost:${handle.port}`;

    // Two markdown docs: one attached to the hub workspace, one private.
    for (const id of [ATTACHED, PRIVATE]) {
      const path = join(dataDir, `${id}.md`);
      writeFileSync(path, `# ${id}\n\nBody text to comment on.\n`);
      const r = await post('/api/docs', { docId: id, type: 'markdown', sourceUrl: path });
      expect(r.status).toBe(200);
    }

    // The hub workspace, one attached doc, one task, one open decision.
    const ws = await post('/api/workspaces', {
      name: 'search-revamp',
      goal: 'Ship the new search.',
    });
    expect(ws.status).toBe(200);
    hubId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;

    expect((await post(`/api/workspaces/${hubId}/docs`, { docId: ATTACHED })).status).toBe(200);

    const t = await post(`/api/workspaces/${hubId}/tasks`, { title: 'Wire the store' });
    expect(t.status).toBe(200);
    taskId = ((await t.json()) as { task: { id: string } }).task.id;

    const d = await post(`/api/workspaces/${hubId}/tasks`, {
      title: 'Ship search now, or wait for reindex?',
      assignee: 'human',
      needs: 'decision',
    });
    decisionId = ((await d.json()) as { task: { id: string } }).task.id;

    // Cross-reference so the chip endpoint has something to resolve.
    expect(
      (await post(`/api/tasks/${taskId}/links`, { ref: { kind: 'doc', docId: ATTACHED } })).status,
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

    // Shares: the whole hub workspace, and the attached doc ALONE.
    const hs = await post('/api/share/link', { workspaceId: hubId, label: 'hub share' });
    expect(hs.status).toBe(200);
    hubShare = ((await hs.json()) as { share: typeof hubShare }).share;
    hubCookie = await redeem(hubShare.slug);

    const ds = await post('/api/share/link', { docId: ATTACHED, label: 'doc share' });
    expect(ds.status).toBe(200);
    docCookie = await redeem(((await ds.json()) as { share: { slug: string } }).share.slug);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('minting + landing', () => {
    it('mints a link share against a hub workspace (no bound member docs required)', () => {
      expect(hubShare.slug).toMatch(/^[0-9a-f]{32}$/);
    });

    it('redeeming lands IN the hub — never a review URL, never a lobby', async () => {
      const r = await pub(`/s/${hubShare.slug}`);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/workspaces/${hubId}`);
    });
  });

  describe('transport 1: the hub page', () => {
    it('serves the hub page to a workspace visitor (presence)', async () => {
      const r = await pub(`/workspaces/${hubId}`, hubCookie);
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain('search-revamp'); // the real shell, not a stub
    });

    it('refuses it without a session, and to a DOC-scoped visitor (absence)', async () => {
      expect((await pub(`/workspaces/${hubId}`)).status).toBe(401);
      expect((await pub(`/workspaces/${hubId}`, docCookie)).status).toBe(403);
    });
  });

  describe('transport 2: the ws:<id> board room socket', () => {
    it('a workspace visitor completes a REAL Yjs sync and sees the board (presence)', async () => {
      const client = connectDoc(`${wsBase}/y/ws%3A${hubId}`, {
        host: PUBLIC_HOST,
        cookie: `${SHARE_COOKIE}=${hubCookie}`,
      });
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

    it('refuses the socket to a DOC-scoped visitor whose socket auth otherwise works (absence)', async () => {
      // Positive control: the SAME doc cookie passes the guard for its own
      // doc (426 = past the guard, upgrade-required on a plain fetch).
      expect(
        (await pub(`/y/${ATTACHED}`, docCookie, { headers: { host: PUBLIC_HOST } })).status,
      ).toBe(426);
      expect((await pub(`/y/ws%3A${hubId}`, docCookie)).status).toBe(403);
      expect((await pub(`/y/ws%3A${hubId}`)).status).toBe(401);
    });
  });

  describe('transport 3: the workspace SSE feed', () => {
    it('delivers live task events to a workspace visitor, redacted to display names (presence)', async () => {
      const stream = await pub(`/events/workspace/${hubId}`, hubCookie);
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
      const stream = await local(`/events/workspace/${hubId}`);
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

    it('refuses the feed to a DOC-scoped visitor (absence)', async () => {
      expect((await pub(`/events/workspace/${hubId}`, docCookie)).status).toBe(403);
      expect((await pub(`/events/workspace/${hubId}`)).status).toBe(401);
    });

    // Voice landed AFTER the commit-8 share slice, and §3.3's enumeration of
    // what a visitor may see is exhaustive by construction — it lists goal
    // text and verbatim quote/answer fields, never the transcript of
    // whatever Bryan happens to say into his own board. The utterance is
    // unbounded free text about anything he is thinking; it does not get to
    // extend the contract by arriving later.
    it('never puts a voice transcript on a visitor stream (absence)', async () => {
      const stream = await pub(`/events/workspace/${hubId}`, hubCookie);
      expect(stream.status).toBe(200);
      const trigger = post(`/api/workspaces/${hubId}/voice`, {
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
      const stream = await local(`/events/workspace/${hubId}`);
      expect(stream.status).toBe(200);
      const trigger = post(`/api/workspaces/${hubId}/voice`, {
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
  // the hub client makes on load. Both were outside share scope, so a
  // visitor's page titled itself with the raw workspace id and showed no
  // agents at all — while the same records rode their SSE feed. The two
  // doors have to agree; `fetchJson` swallows a non-ok, so the disagreement
  // was silent.
  describe('the hub page’s own REST reads are in scope', () => {
    it('serves the workspace record to a workspace visitor, refuses a doc visitor', async () => {
      const r = await pub(`/api/workspaces/${hubId}`, hubCookie);
      expect(r.status).toBe(200);
      const { workspace } = (await r.json()) as { workspace: { name: string; goal: string } };
      expect(workspace.name).toBe('search-revamp'); // the page title, not the id
      expect(workspace.goal).toBe('Ship the new search.'); // goal text is in-contract
      expect((await pub(`/api/workspaces/${hubId}`, docCookie)).status).toBe(403);
      expect((await pub(`/api/workspaces/${hubId}`)).status).toBe(401);
    });

    it('serves agent presence redacted — no endpoint — with the owner’s copy as the control', async () => {
      const att = await post(`/api/workspaces/${hubId}/attachments`, {
        agentId: 'agent-search-revamp',
        runtime: 'webhook',
        endpoint: 'https://agents.internal.example/hooks/search-revamp',
        capabilities: ['tasks.write'],
      });
      expect(att.status).toBe(200);

      const owner = (await (await local(`/api/workspaces/${hubId}/attachments`)).json()) as {
        attachments: Array<Record<string, unknown>>;
      };
      expect(owner.attachments[0]?.endpoint).toBe(
        'https://agents.internal.example/hooks/search-revamp',
      );

      const r = await pub(`/api/workspaces/${hubId}/attachments`, hubCookie);
      expect(r.status).toBe(200);
      const seen = (await r.json()) as { attachments: Array<Record<string, unknown>> };
      // Positive control: the visitor really sees the agent…
      expect(seen.attachments[0]?.agentId).toBe('agent-search-revamp');
      expect(seen.attachments[0]?.state).toBeDefined();
      // …and never where it lives.
      expect(seen.attachments[0]?.endpoint).toBeUndefined();
      expect((await pub(`/api/workspaces/${hubId}/attachments`, docCookie)).status).toBe(403);
    });
  });

  describe('visitors are READ-ONLY on the gate', () => {
    it('every task/goal/decision mutation route refuses visitor auth', async () => {
      const author = PERSON;
      const cases: Array<[string, RequestInit]> = [
        [
          `/api/tasks/${taskId}/transition`,
          { method: 'POST', body: JSON.stringify({ to: 'done', author }) },
        ],
        [
          `/api/tasks/${decisionId}/answer`,
          { method: 'POST', body: JSON.stringify({ text: 'Ship now.', author }) },
        ],
        [
          `/api/tasks/${taskId}/goal`,
          { method: 'POST', body: JSON.stringify({ goal: 'chores', author }) },
        ],
        [
          `/api/tasks/${taskId}/title`,
          { method: 'POST', body: JSON.stringify({ title: 'Renamed', author }) },
        ],
        [
          `/api/tasks/${taskId}/links`,
          { method: 'POST', body: JSON.stringify({ ref: { kind: 'doc', docId: ATTACHED } }) },
        ],
        [
          `/api/workspaces/${hubId}/goal`,
          { method: 'PUT', body: JSON.stringify({ goal: 'New goal.', author }) },
        ],
        [
          `/api/workspaces/${hubId}/goals`,
          { method: 'PUT', body: JSON.stringify({ goals: [], author }) },
        ],
        [
          `/api/workspaces/${hubId}/tasks`,
          { method: 'POST', body: JSON.stringify({ title: 'Injected task' }) },
        ],
        [
          `/api/workspaces/${hubId}/docs`,
          { method: 'POST', body: JSON.stringify({ docId: ATTACHED }) },
        ],
        [
          `/api/workspaces/${hubId}/attachments`,
          {
            method: 'POST',
            body: JSON.stringify({ agentId: 'agent-x', runtime: 'claude-code-local' }),
          },
        ],
        [
          `/api/workspaces/${hubId}/voice`,
          { method: 'POST', body: JSON.stringify({ transcript: 'delete everything', author }) },
        ],
      ];
      for (const [path, init] of cases) {
        const r = await pub(path, hubCookie, {
          ...init,
          headers: { 'content-type': 'application/json' },
        });
        expect(r.status, `${init.method} ${path}`).toBe(403);
      }
    });

    it('the same transition succeeds from the owner surface (positive control)', async () => {
      const r = await post(`/api/tasks/${taskId}/transition`, { to: 'done', author: PERSON });
      expect(r.status).toBe(200);
    });

    it('the decision stayed unanswered — the refusals were refusals, not silent drops', async () => {
      const r = await local(`/api/workspaces/${hubId}/tasks?needs=decision`);
      const { tasks } = (await r.json()) as { tasks: Array<{ id: string; answer?: unknown }> };
      const decision = tasks.find((t) => t.id === decisionId);
      expect(decision).toBeDefined();
      expect(decision?.answer).toBeUndefined();
    });

    it('the events audit log is owner-only — it carries actor ids', async () => {
      expect((await local(`/api/workspaces/${hubId}/events`)).status).toBe(200); // positive control
      expect((await pub(`/api/workspaces/${hubId}/events`, hubCookie)).status).toBe(403);
    });

    it('promoting a thread to a task is refused even on an in-scope doc', async () => {
      // The thread exists and the visitor can SEE it (positive control below
      // proves comment access) — but promote CREATES a task.
      const mk = await post(`/api/docs/${ATTACHED}/threads/by_find`, {
        author: PERSON,
        text: 'This paragraph needs a task.',
        find: 'Body text',
      });
      expect(mk.status).toBe(200);
      const threadId = ((await mk.json()) as { thread: { id: string } }).thread.id;
      const r = await pub(`/api/docs/${ATTACHED}/threads/${threadId}/promote`, hubCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: hubId }),
      });
      expect(r.status).toBe(403);
      // And the visitor CAN reply on the same thread — comments are the one
      // write they keep.
      const reply = await pub(`/api/docs/${ATTACHED}/threads/${threadId}/comments`, hubCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: PERSON, text: 'Agreed — but from a visitor.' }),
      });
      expect(reply.status).toBe(200);
    });
  });

  describe('a workspace visitor reaches the workspace’s own docs, comments only', () => {
    it('reads the attached doc and the task body room', async () => {
      expect((await pub(`/api/docs/${ATTACHED}`, hubCookie)).status).toBe(200);
      expect((await pub(`/api/docs/task%3A${taskId}`, hubCookie)).status).toBe(200);
    });

    it('the doc payload never hands a visitor the hub workspace id', async () => {
      // Positive control: the owner's copy of the same payload carries it —
      // the doc-surface voice dock resolves its workspace from this field.
      const owner = (await (await local(`/api/docs/${ATTACHED}`)).json()) as {
        hubWorkspaceId?: string;
      };
      expect(owner.hubWorkspaceId).toBe(hubId);
      const seen = (await (await pub(`/api/docs/${ATTACHED}`, hubCookie)).json()) as {
        hubWorkspaceId?: string;
      };
      expect(seen.hubWorkspaceId).toBeUndefined();
    });

    it('posts a comment attributed as a guest, never as a fleet identity', async () => {
      const r = await pub(`/api/docs/${ATTACHED}/threads/by_find`, hubCookie, {
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
        thread: { comments: Array<{ author: { id: string } }> };
      };
      expect(thread.comments[0]?.author.id).toStartWith('guest-');
    });

    it('still cannot reach a doc outside the workspace (absence)', async () => {
      expect((await pub(`/api/docs/${PRIVATE}`, hubCookie)).status).toBe(403);
      expect((await pub(`/review/${PRIVATE}`, hubCookie)).status).toBe(403);
    });
  });

  describe('task chips resolve via REST — a doc invite never syncs the board', () => {
    it('GET /api/docs/<id>/tasks returns the §3.3 rule-2 chip shape, nothing more', async () => {
      const r = await pub(`/api/docs/${ATTACHED}/tasks`, docCookie);
      expect(r.status).toBe(200);
      const { tasks } = (await r.json()) as { tasks: Array<Record<string, unknown>> };
      const chip = tasks.find((t) => t.id === taskId);
      expect(chip).toBeDefined(); // positive control: the chip resolves
      expect(chip?.title).toBe('Wire the store');
      // The SHAPE is the contract: adding a key here is a sharing decision.
      expect(Object.keys(chip ?? {}).sort()).toEqual(['assignee', 'id', 'status', 'title']);
    });

    it('the chip endpoint stays scoped — not a task enumeration oracle', async () => {
      expect((await pub(`/api/docs/${PRIVATE}/tasks`, docCookie)).status).toBe(403);
    });
  });

  describe('revocation hangs up the hub, it does not just refuse', () => {
    it('closes the board room socket and the workspace stream a share had open', async () => {
      const mint = await post('/api/share/link', { workspaceId: hubId });
      const share = ((await mint.json()) as { share: { shareId: string; slug: string } }).share;
      const cookie = await redeem(share.slug);

      const client = connectDoc(`${wsBase}/y/ws%3A${hubId}`, {
        host: PUBLIC_HOST,
        cookie: `${SHARE_COOKIE}=${cookie}`,
      });
      await client.ready; // positive control: the socket really synced
      const closedCode = new Promise<number>((resolve) => {
        client.ws.addEventListener('close', (e) => resolve((e as CloseEvent).code));
        setTimeout(() => resolve(-1), 5000);
      });
      const stream = await pub(`/events/workspace/${hubId}`, cookie);
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
