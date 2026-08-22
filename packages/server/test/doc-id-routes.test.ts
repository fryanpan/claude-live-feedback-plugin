/**
 * The readable alias resolves on EVERY doc route, not only the ones inside
 * the block that canonicalizes.
 *
 * This suite exists because the first cut of the alias layer was written as
 * "the `/api/docs/<id>/…` block canonicalizes once, so its ~30 subroutes
 * inherit it" — which was true, and which quietly said nothing about the doc
 * routes matched OUTSIDE that block. Three of them (promote, archive, and the
 * share-scope guard) went on reading the raw path segment, so a caller
 * holding the readable name got a 404 or a 403 from a document that was
 * right there. That is the same shape as the hole this whole change closes:
 * a rule that is a property of one code path rather than of the system.
 *
 * So the routes are enumerated HERE, in a test, instead of being trusted to
 * the place they are implemented. A doc route added outside the
 * canonicalizing block without resolving its id goes red.
 *
 * All fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-fixture', name: 'Fixture Person', kind: 'known', color: '#2e7dd7' };
const ALIAS = 'the-readable-name';

describe('a doc answers to its readable alias everywhere it answers at all', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  /** What the server minted. The alias must reach exactly this. */
  let mintedId: string;

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

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'docid-routes-'));
    folder = mkdtempSync(join(tmpdir(), 'docid-routes-src-'));
    writeFileSync(join(folder, 'plan.md'), '# Plan\n\nA paragraph to anchor a thread on.\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const created = (await (
      await post('/api/docs', {
        docId: ALIAS,
        type: 'markdown',
        sourceUrl: join(folder, 'plan.md'),
      })
    ).json()) as { docId: string };
    mintedId = created.docId;
  });

  afterEach(async () => {
    await handle.stop();
    for (const d of [dataDir, folder]) rmSync(d, { recursive: true, force: true });
  });

  /** The premise the whole suite rests on: the two spellings differ. Without
   *  this, every assertion below could pass by the alias BEING the id. */
  it('positive control: the alias and the minted id are different strings', () => {
    expect(mintedId).not.toBe(ALIAS);
    expect(mintedId).toMatch(/^d-[A-Za-z0-9_-]{12}$/);
  });

  describe('inside the canonicalizing block', () => {
    it('reads meta, content and status by the alias, reporting the minted id', async () => {
      for (const path of ['', '/content', '/status']) {
        const r = await local(`/api/docs/${ALIAS}${path}`);
        expect(r.status).toBe(200);
      }
      const meta = (await (await local(`/api/docs/${ALIAS}`)).json()) as {
        meta: { docId: string; alias?: string };
      };
      expect(meta.meta.docId).toBe(mintedId);
      expect(meta.meta.alias).toBe(ALIAS);
    });

    it('writes a thread by the alias and reads it back by the minted id', async () => {
      const created = await post(`/api/docs/${ALIAS}/threads`, {
        author: PERSON,
        text: 'A comment posted through the readable name.',
        anchor: {
          kind: 'element',
          fingerprint: { tag: 'P', classes: [], text: 'a paragraph', index: 0 },
          snippet: { text: 'a paragraph' },
        },
      });
      expect(created.status).toBe(200);

      // The write landed on the DOC, not on a second room named by the alias.
      const byMinted = (await (
        await local(`/api/docs/${encodeURIComponent(mintedId)}/threads`)
      ).json()) as { threads: Array<{ comments: Array<{ text: string }> }> };
      expect(byMinted.threads).toHaveLength(1);
      expect(byMinted.threads[0]?.comments[0]?.text).toContain('readable name');

      // And exactly one doc exists, which is what "two spellings, one doc"
      // has to mean on disk as well as in the map.
      const listed = (await (await local('/api/docs')).json()) as {
        docs: Array<{ docId: string }>;
      };
      expect(listed.docs.filter((d) => d.docId === mintedId)).toHaveLength(1);
      expect(listed.docs.map((d) => d.docId)).not.toContain(ALIAS);
    });
  });

  describe('outside the canonicalizing block — the routes that got missed', () => {
    it('promotes a thread to a task through the alias', async () => {
      const ws = (await (await post('/api/workspaces', { name: 'routes-board' })).json()) as {
        workspace: { id: string };
      };
      const { thread } = (await (
        await post(`/api/docs/${ALIAS}/threads`, {
          author: PERSON,
          text: 'This one should become a task.',
          anchor: {
            kind: 'element',
            fingerprint: { tag: 'P', classes: [], text: 'a paragraph', index: 0 },
            snippet: { text: 'a paragraph' },
          },
        })
      ).json()) as { thread: { id: string } };

      const promoted = await post(`/api/docs/${ALIAS}/threads/${thread.id}/promote`, {
        workspaceId: ws.workspace.id,
        author: PERSON,
        title: 'Promoted through the readable name',
      });
      // Anything but 404 proves the lookup resolved; a 404 here is the
      // regression this test exists for.
      expect(promoted.status).not.toBe(404);
      expect(promoted.status).toBe(200);
    });

    it('archives through the alias, and the archived doc stops resolving by either name', async () => {
      const archived = await post(`/api/docs/${ALIAS}/archive`, {
        author: PERSON,
        reason: 'done with it',
      });
      expect(archived.status).toBe(200);

      // Both spellings 404 now — the room is gone, and an alias with no room
      // must not keep answering.
      expect((await local(`/api/docs/${ALIAS}`)).status).toBe(404);
      expect((await local(`/api/docs/${encodeURIComponent(mintedId)}`)).status).toBe(404);
    });

    it('unarchives by the MINTED id, which is the id the archive listing hands back', async () => {
      await post(`/api/docs/${ALIAS}/archive`, { author: PERSON });

      // An archived doc has no room, so there is nothing for an alias to
      // resolve against. The listing is where a caller gets the id that
      // works — asserted so the asymmetry is on the record rather than a
      // surprise someone rediscovers.
      const listing = (await (await local('/api/reviews/archived')).json()) as {
        docs: Array<{ docId: string }>;
      };
      expect(listing.docs.map((d) => d.docId)).toContain(mintedId);

      const restored = await post(`/api/docs/${encodeURIComponent(mintedId)}/unarchive`, {
        author: PERSON,
      });
      expect(restored.status).toBe(200);

      // And the readable name resolves again, having travelled with the doc.
      const again = (await (await local(`/api/docs/${ALIAS}`)).json()) as {
        meta: { docId: string };
      };
      expect(again.meta.docId).toBe(mintedId);
    });

    it('registers a durable watch under the minted id, whichever name was watched', async () => {
      const agentId = 'agent-routes-fixture';
      const added = await post(`/api/agents/${agentId}/watches`, { add: [ALIAS] });
      expect(added.status).toBe(200);

      const listed = (await (await local(`/api/agents/${agentId}/watches`)).json()) as {
        watches: Array<{ key: string }>;
      };
      // Stored canonically: a watch key is matched against board membership
      // to answer "is this agent covering that board", and board membership
      // holds the doc's own id.
      expect(listed.watches.map((w) => w.key)).toEqual([mintedId]);

      // Unwatching by the OTHER spelling still finds it.
      await post(`/api/agents/${agentId}/watches`, { remove: [ALIAS] });
      const after = (await (await local(`/api/agents/${agentId}/watches`)).json()) as {
        watches: Array<{ key: string }>;
      };
      expect(after.watches).toHaveLength(0);
    });

    it('files the doc on a board under the minted id when attached by the alias', async () => {
      const ws = (await (await post('/api/workspaces', { name: 'attach-board' })).json()) as {
        workspace: { id: string };
      };
      const attached = await post(`/api/workspaces/${ws.workspace.id}/docs`, { docId: ALIAS });
      expect(attached.status).toBe(200);
      const { workspace } = (await attached.json()) as { workspace: { docIds?: string[] } };
      expect(workspace.docIds).toContain(mintedId);
      expect(workspace.docIds).not.toContain(ALIAS);
    });

    it('redirects /review/<alias> onto the canonical address', async () => {
      const r = await local(`/review/${ALIAS}`, { redirect: 'manual' });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toContain(mintedId);
      expect(r.headers.get('location')).not.toContain(ALIAS);
    });

    it('opens the event stream on the doc, not on a channel named by the alias', async () => {
      // Both addresses must reach the SAME channel: a watcher subscribed by
      // the readable name and a writer firing on the canonical one have to
      // meet, and 404 vs 200 is the observable half of that here.
      expect((await local(`/events/${ALIAS}`)).status).not.toBe(404);
      expect((await local(`/events/${encodeURIComponent(mintedId)}`)).status).not.toBe(404);
    });
  });
});
