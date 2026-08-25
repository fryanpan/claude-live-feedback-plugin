/**
 * Hub workspace + task routes, driven through the real route table.
 *
 * The route layer hand-copies body fields and nothing type-checks it — a
 * field that isn't forwarded is silently discarded while the request still
 * returns 200 (the `groups` lesson). So every parameter these routes accept
 * is asserted end-to-end here: send it over HTTP, read the stored effect
 * back over HTTP.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';
import { type GoalIds, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };
/** Clears the decision-shape gate, so a fixture about dependency edges is not
 *  accidentally a test of the gate. */
const DECISION_BODY =
  'Which of these two? Both land this week; the second costs a migration. Blocked until answered: the PR.';

describe('hub workspace + task routes', () => {
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

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'taskr-data-'));
    folder = mkdtempSync(join(tmpdir(), 'taskr-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nRead me.\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    for (const d of [dataDir, folder]) rmSync(d, { recursive: true, force: true });
  });

  describe('POST /api/workspaces (hub create)', () => {
    it('creates a hub workspace from a name and GET reads it back', async () => {
      const r = await post('/api/workspaces', { name: 'search-revamp' });
      expect(r.status).toBe(200);
      const { workspace } = (await r.json()) as {
        workspace: { id: string; name: string };
      };
      expect(workspace.name).toBe('search-revamp');
      expect(workspace.id.length).toBeGreaterThanOrEqual(10);

      const got = await local(`/api/workspaces/${workspace.id}`);
      expect(got.status).toBe(200);
      const body = (await got.json()) as { workspace: { name: string } };
      expect(body.workspace.name).toBe('search-revamp');
    });

    it('still binds a folder when folderPath is given (the legacy shape is untouched)', async () => {
      const r = await post('/api/workspaces', { folderPath: folder });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { workspaceId: string };
      expect(body.workspaceId.length).toBeGreaterThan(0);
    });

    it('400s when neither name nor folderPath is present', async () => {
      const r = await post('/api/workspaces', {});
      expect(r.status).toBe(400);
    });

    it('404s a GET for an unknown workspace id', async () => {
      const r = await local('/api/workspaces/w-nope');
      expect(r.status).toBe(404);
    });
  });

  describe('POST /api/workspaces/:id/docs (attach_doc)', () => {
    it('attaches an existing doc; the workspace lists it; nothing is migrated', async () => {
      const mdPath = join(dataDir, 'plan.md');
      writeFileSync(mdPath, '# Plan\n\nBody.\n');
      const planDocId = (
        (await (
          await post('/api/docs', { docId: 'hub-plan-doc', type: 'markdown', sourceUrl: mdPath })
        ).json()) as { docId: string }
      ).docId;

      const ws = (await (await post('/api/workspaces', { name: 'attach-ws' })).json()) as {
        workspace: { id: string };
      };
      // Attached by the readable name…
      const r = await post(`/api/workspaces/${ws.workspace.id}/docs`, { docId: 'hub-plan-doc' });
      expect(r.status).toBe(200);

      const got = (await (await local(`/api/workspaces/${ws.workspace.id}`)).json()) as {
        workspace: { docIds: string[] };
      };
      // …and recorded under the doc's own id, so two spellings of one doc
      // cannot become two rows on the board.
      expect(got.workspace.docIds).toEqual([planDocId]);
      // The doc itself keeps working at its current URL — no migration.
      const doc = await local('/api/docs/hub-plan-doc');
      expect(doc.status).toBe(200);
      const meta = (await doc.json()) as { meta: { workspaceId?: string } };
      expect(meta.meta.workspaceId).toBeUndefined();
    });

    it('attaches an existing review (legacy grouping workspace) by its id', async () => {
      const bind = await post('/api/workspaces', { folderPath: folder });
      const reviewId = ((await bind.json()) as { workspaceId: string }).workspaceId;
      const ws = (await (await post('/api/workspaces', { name: 'attach-review-ws' })).json()) as {
        workspace: { id: string };
      };
      const r = await post(`/api/workspaces/${ws.workspace.id}/docs`, { docId: reviewId });
      expect(r.status).toBe(200);
    });

    it('404s an unknown doc and an unknown workspace', async () => {
      const ws = (await (await post('/api/workspaces', { name: 'attach-404-ws' })).json()) as {
        workspace: { id: string };
      };
      const noDoc = await post(`/api/workspaces/${ws.workspace.id}/docs`, { docId: 'no-such' });
      expect(noDoc.status).toBe(404);
      const noWs = await post('/api/workspaces/w-nope/docs', { docId: 'hub-plan-doc' });
      expect(noWs.status).toBe(404);
    });

    it('400s a missing docId', async () => {
      const ws = (await (await post('/api/workspaces', { name: 'attach-400-ws' })).json()) as {
        workspace: { id: string };
      };
      const r = await post(`/api/workspaces/${ws.workspace.id}/docs`, {});
      expect(r.status).toBe(400);
    });
  });

  describe('task create + list routes', () => {
    let wsId: string;

    beforeAll(async () => {
      const r = await post('/api/workspaces', { name: 'task-ws', goal: 'Ship.' });
      wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    });

    /**
     * Removing the `create_task` MCP tool (0.1.41) does NOT remove this route,
     * and that distinction is the whole safety argument for the removal. A
     * peer sitting on an older bundle keeps its own copy of that tool and its
     * own handler, and that handler keeps POSTing here — so the hazard is not
     * the vanished tool, it is a route that quietly stops honouring the shape
     * the old handler sends. A test written against what the CURRENT code
     * sends cannot detect a narrowed contract; this one is written against
     * what the OLD bundle sends.
     *
     * Request and response shapes below are transcribed from the committed
     * `packages/plugin/mcp/index.js` at 0.1.20 (the oldest release still
     * plausibly in the field) and verified byte-identical at 0.1.25, 0.1.30,
     * 0.1.34 and 0.1.36 — the payload never moved across those releases.
     */
    it('still honours the payload an OLDER bundle sends, and returns what it reads', async () => {
      const gate = (await (
        await post(`/api/workspaces/${wsId}/tasks`, {
          author: AGENT,
          title: 'gate for the legacy-shape check',
        })
      ).json()) as { task: Task };

      // Exactly the 13 keys the 0.1.20 handler puts on the wire, no more.
      const legacyPayload = {
        title: 'Legacy-shape create',
        body: 'Which of the two? The second costs a migration. Blocked until answered: the rollout.',
        assignee: 'human',
        needs: 'decision',
        options: [{ label: 'the first one' }, { label: 'the second one', detail: 'a migration' }],
        goal: 'chores',
        order: 3,
        after: [gate.task.id],
        afterEnforce: [gate.task.id],
        dueAt: 1770000000000,
        links: [{ kind: 'doc', docId: 'hub-plan-doc' }],
        quote: 'pick one of these for me',
        author: AGENT,
      };

      const r = await post(`/api/workspaces/${wsId}/tasks`, legacyPayload);
      expect(r.status).toBe(200);

      const payload = (await r.json()) as { task: Task };
      // The old handler dereferences res.task.<field> with no guard, so a
      // route that stopped returning `task` would throw inside a peer we
      // cannot fix. Assert each field it reads, by name.
      expect(payload.task).toBeDefined();
      expect(typeof payload.task.id).toBe('string');
      expect(payload.task.goal).toBe('chores');
      expect(payload.task.order).toBe(3);
      // `triage`, not `todo`: this payload is signed by an AGENT, and an
      // agent's own create is a proposal. The compatibility promise here is
      // about SHAPE, and it holds — the key is present and is still a
      // non-empty string, which is all the 0.1.20 handler does with it (it
      // renders the value; it does not switch on it). A peer that never
      // restarts therefore shows the word "triage" in a status cell rather
      // than failing, which is the degradation this route owes it.
      expect(typeof payload.task.status).toBe('string');
      expect(payload.task.status).toBe('triage');
      expect(payload.task.assignee).toBe('human');
      // `unplacedSince` is read as a presence test, so undefined is a valid
      // answer — what must hold is that the KEY is not repurposed into
      // something truthy for a row that was explicitly placed.
      expect(payload.task.unplacedSince).toBeUndefined();

      // And every param it sent actually landed — read back through the list
      // route rather than trusting the create response.
      const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      const stored = listed.tasks.find((t) => t.id === payload.task.id);
      expect(stored?.title).toBe('Legacy-shape create');
      expect(stored?.needs).toBe('decision');
      expect(stored?.quote).toBe('pick one of these for me');
      expect(stored?.dueAt).toBe(1770000000000);
      expect(stored?.links).toEqual([{ kind: 'doc', docId: 'hub-plan-doc' }]);
      expect(stored?.after).toEqual([gate.task.id]);
      expect(stored?.afterEnforce).toEqual([gate.task.id]);
      expect(stored?.options?.length).toBe(2);
      expect(stored?.body).toContain('Which of the two?');
    });

    it('forwards EVERY create param through the route (the groups lesson)', async () => {
      const r = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'Pick the palette',
        assignee: 'human',
        needs: 'decision',
        quote: 'which of these two?',
        links: [{ kind: 'doc', docId: 'hub-plan-doc' }],
        origin: { kind: 'thread', docId: 'hub-plan-doc', threadId: 'th-1' },
        dueAt: 1770000000000,
        body: 'Which of the two attached candidates? The warmer one costs a contrast pass. Blocked until answered: the mockup.',
        order: 7,
      });
      expect(r.status).toBe(200);
      const { task } = (await r.json()) as { task: Task };
      expect(task.title).toBe('Pick the palette');
      expect(task.assignee).toBe('human');
      expect(task.needs).toBe('decision');
      expect(task.quote).toBe('which of these two?');
      expect(task.links).toEqual([{ kind: 'doc', docId: 'hub-plan-doc' }]);
      expect(task.origin).toEqual({ kind: 'thread', docId: 'hub-plan-doc', threadId: 'th-1' });
      expect(task.dueAt).toBe(1770000000000);
      expect(task.body).toContain('Which of the two attached candidates?');
      expect(task.order).toBe(7);

      // Read the stored effect back through the OTHER route, not the response.
      const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      const stored = listed.tasks.find((t) => t.id === task.id);
      expect(stored?.quote).toBe('which of these two?');
      expect(stored?.needs).toBe('decision');
      expect(stored?.dueAt).toBe(1770000000000);
    });

    it('forwards after + afterEnforce (proved by the transition refusing)', async () => {
      const gate = (await (
        await post(`/api/workspaces/${wsId}/tasks`, {
          author: AGENT,
          title: 'your go',
          needs: 'decision',
          body: DECISION_BODY,
        })
      ).json()) as { task: Task };
      const work = (await (
        await post(`/api/workspaces/${wsId}/tasks`, {
          author: AGENT,
          title: 'Open the PR',
          after: [gate.task.id],
          afterEnforce: [gate.task.id],
        })
      ).json()) as { task: Task };

      const refused = await post(`/api/tasks/${work.task.id}/transition`, {
        to: 'in-progress',
        author: AGENT,
      });
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as {
        error: string;
        blockers: Array<{ taskId: string; enforce: boolean; message: string }>;
      };
      expect(body.error).toBe('blocked');
      expect(body.blockers[0]?.taskId).toBe(gate.task.id);
      expect(body.blockers[0]?.enforce).toBe(true);

      // Positive control: complete the gate and the same call succeeds.
      await post(`/api/tasks/${gate.task.id}/transition`, { to: 'done', author: PERSON });
      const allowed = await post(`/api/tasks/${work.task.id}/transition`, {
        to: 'in-progress',
        author: AGENT,
      });
      expect(allowed.status).toBe(200);
    });

    it('filters the list by status via query params', async () => {
      const r = await local(`/api/workspaces/${wsId}/tasks?status=done`);
      expect(r.status).toBe(200);
      const { tasks } = (await r.json()) as { tasks: Task[] };
      expect(tasks.length).toBeGreaterThan(0);
      for (const t of tasks) expect(t.status).toBe('done');
    });

    it('400s a missing title and 404s an unknown workspace', async () => {
      const noTitle = await post(`/api/workspaces/${wsId}/tasks`, {});
      expect(noTitle.status).toBe(400);
      const noWs = await post('/api/workspaces/w-nope/tasks', { title: 'x' });
      expect(noWs.status).toBe(404);
    });

    // Dedupe belongs to creation, not to the batch resolver that surfaced the
    // gap: the same duplicate is writable straight down this route, and a fix
    // that lived only in the batch layer would leave the two spelling the same
    // stored state differently.
    it('stores one edge when the caller names the same dependency twice', async () => {
      const gate = (await (
        await post(`/api/workspaces/${wsId}/tasks`, {
          author: AGENT,
          title: 'your go',
          needs: 'decision',
          body: DECISION_BODY,
        })
      ).json()) as { task: Task };

      const dup = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'Open the PR',
        after: [gate.task.id, gate.task.id],
        afterEnforce: [gate.task.id, gate.task.id],
      });
      expect(dup.status).toBe(200);
      const { task } = (await dup.json()) as { task: Task };
      expect(task.after).toEqual([gate.task.id]);
      expect(task.afterEnforce).toEqual([gate.task.id]);
    });

    // `afterEnforce` is a SUBSET of `after` — openBlockers walks `after` and
    // uses afterEnforce only as a lookup set, so an id in one array and not
    // the other is never visited and hard-blocks nothing. Accepting it
    // silently disables the strongest of the three anti-rollover guards, in
    // the direction of letting work through.
    it('refuses afterEnforce ids that are not also in after', async () => {
      const gate = (await (
        await post(`/api/workspaces/${wsId}/tasks`, {
          author: AGENT,
          title: 'your go',
          needs: 'decision',
          body: DECISION_BODY,
        })
      ).json()) as { task: Task };

      const lopsided = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'Open the PR',
        afterEnforce: [gate.task.id],
      });
      expect(lopsided.status).toBe(400);
      expect(((await lopsided.json()) as { error: string }).error).toBe('unknown-after-enforce');

      // Positive control: the same pair in BOTH arrays is accepted and gates.
      const both = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'Open the PR',
        after: [gate.task.id],
        afterEnforce: [gate.task.id],
      });
      expect(both.status).toBe(200);
      const work = ((await both.json()) as { task: Task }).task;
      const refused = await post(`/api/tasks/${work.id}/transition`, {
        to: 'in-progress',
        author: AGENT,
      });
      expect(refused.status).toBe(409);
    });

    // `needs` still 400s on create: it changes what the task IS. `links` no
    // longer does — see the partial-accept test below for why the two fields
    // are now allowed to give different answers.
    it('still refuses a malformed `needs` on create', async () => {
      const badNeeds = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'Approve the spend',
        assignee: 'human',
        needs: 'Decision', // capitalized — silently not a decision task
      });
      expect(badNeeds.status).toBe(400);

      // Positive control: the well-formed forms are accepted and stored.
      const good = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'Approve the spend',
        assignee: 'human',
        needs: 'decision',
        body: DECISION_BODY,
        links: [{ kind: 'thread', docId: 'plan-doc', threadId: 'th-1' }],
      });
      expect(good.status).toBe(200);
      const task = ((await good.json()) as { task: Task }).task;
      expect(task.needs).toBe('decision');
      expect(task.links).toHaveLength(1);
    });

    // `origin` was a cast, not a check — so it skipped every rule `links`
    // enforces one field away. Both halves of that are tested here because
    // both were reachable from one unauthenticated POST.
    it('refuses an unsafe scheme in `origin`, the same as in `links`', async () => {
      const hostile = { kind: 'url', url: 'javascript:alert(1)' };

      // Positive control FIRST: the identical ref in `links` is already
      // rejected, so this asserts the two fields agree rather than asserting
      // that nothing anywhere accepts it.
      const viaLinks = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'via links',
        links: [hostile],
      });
      expect(viaLinks.status).toBe(200);
      const kept = ((await viaLinks.json()) as { task: Task }).task;
      expect(kept.links).toHaveLength(0);

      const viaOrigin = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'via origin',
        origin: hostile,
      });
      expect(viaOrigin.status).toBe(400);

      // A well-formed url origin still goes through — the check is on the
      // scheme, not on the kind.
      const good = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'good origin',
        origin: { kind: 'url', url: 'https://example.com/pr/1' },
      });
      expect(good.status).toBe(200);
      expect(((await good.json()) as { task: Task }).task.origin).toEqual({
        kind: 'url',
        url: 'https://example.com/pr/1',
      });
    });

    // The nastiest shape: it persists, so it outlives the request that
    // created it and breaks readers on every subsequent boot.
    it('a null `origin` cannot poison backlink queries', async () => {
      const created = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'null origin',
        origin: null,
      });
      // Read as "no origin" rather than refused — clients spell an absent
      // field this way, and dropping it costs nothing.
      expect(created.status).toBe(200);
      expect(((await created.json()) as { task: Task }).task.origin).toBeUndefined();

      // The route that used to 500: `refKey` reads `ref.kind` and threw on
      // null, across EVERY workspace, on the doc-open path.
      const listed = await local(`/api/workspaces/${wsId}/tasks`);
      expect(listed.status).toBe(200);
      const tasks = ((await listed.json()) as { tasks: Task[] }).tasks;
      expect(tasks.some((t) => t.title === 'null origin')).toBe(true);
    });

    // A weekly plan points OUTWARD — at a pull request, a decision page, a
    // dashboard. Refs were closed to this server's own objects, so the links
    // that mattered most to the first real port couldn't be links at all, and
    // went into task bodies where nothing can render or count them.
    it('accepts an external URL as a link and keys it for backlinks', async () => {
      const pr = 'https://github.com/example-org/example-repo/pull/1669';
      const r = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'Land the watcher fix',
        links: [{ kind: 'url', url: pr }],
      });
      expect(r.status).toBe(200);
      const { task } = (await r.json()) as { task: Task };
      expect(task.links).toEqual([{ kind: 'url', url: pr }]);

      // Read the stored effect back through the OTHER route — the response
      // body alone would pass even if the route dropped the field.
      const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      expect(listed.tasks.find((t) => t.id === task.id)?.links).toEqual([{ kind: 'url', url: pr }]);
    });

    // The hub renders links as clickable chips, so a ref is an href. Every
    // other kind is an internal id and can't carry a scheme; `url` is the
    // first that can, which makes it the first that can carry `javascript:`.
    it('refuses a URL ref whose scheme is not http(s)', async () => {
      for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'not a url']) {
        const r = await post(`/api/workspaces/${wsId}/tasks`, {
          author: AGENT,
          title: 'Hostile link',
          links: [{ kind: 'url', url }],
        });
        // Not a 400 — see partial-accept below. The task is created and the
        // ref is dropped, which is what makes this safe rather than merely
        // inconvenient: nothing downstream ever sees the scheme.
        expect(r.status).toBe(200);
        const { task, ignoredLinks } = (await r.json()) as {
          task: Task;
          ignoredLinks?: unknown[];
        };
        expect(task.links ?? []).toEqual([]);
        expect(ignoredLinks).toEqual([{ kind: 'url', url }]);
      }
    });

    // Refs are annotations, and existence is deliberately never checked —
    // so a bad one already can't be trusted to point anywhere. Losing the
    // title, body, goal and assignee over one is out of proportion to that.
    it('drops a bad ref and creates the task, reporting it in ignoredLinks', async () => {
      const r = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'Cancel the trial',
        body: 'Before the renewal date.',
        assignee: 'human',
        links: [
          { kind: 'doc', docId: 'plan-doc' },
          { kind: 'thread', docId: 'plan-doc' }, // threadId missing
        ],
      });
      expect(r.status).toBe(200);
      const { task, ignoredLinks } = (await r.json()) as { task: Task; ignoredLinks?: unknown[] };
      // The rest of the task survived — that's the whole point of the change.
      expect(task.title).toBe('Cancel the trial');
      expect(task.body).toBe('Before the renewal date.');
      expect(task.assignee).toBe('human');
      expect(task.links).toEqual([{ kind: 'doc', docId: 'plan-doc' }]);
      // Dropped, but never silently: the caller is told exactly what was lost.
      expect(ignoredLinks).toEqual([{ kind: 'thread', docId: 'plan-doc' }]);

      // Read back through the OTHER route — a response-only assertion would
      // pass even if the good ref was never stored.
      const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      const stored = listed.tasks.find((t) => t.id === task.id);
      expect(stored?.links).toEqual([{ kind: 'doc', docId: 'plan-doc' }]);
    });

    // The dedicated links route is the opposite case: the ref IS the request,
    // so dropping it would mean answering 200 to a call that did nothing.
    it('still 400s on the dedicated links route, and names the accepted kinds', async () => {
      const created = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'Has links',
      });
      const { task } = (await created.json()) as { task: Task };

      const r = await post(`/api/tasks/${task.id}/links`, {
        author: AGENT,
        add: [{ kind: 'thread', docId: 'plan-doc' }],
      });
      expect(r.status).toBe(400);
      const { error } = (await r.json()) as { error: string };
      // The error a first-time caller is most likely to hit should not
      // require reading the source to find out what `url` is spelled like.
      for (const kind of ['doc', 'thread', 'task', 'diff', 'url']) {
        expect(error).toContain(kind);
      }
    });
  });

  // The risk gate was REMOVED on 2026-08-18 (Bryan). What replaces its tests
  // is not "assert nothing happens" — it is the compatibility question, which
  // is the one that can actually break somebody: peers keep running older
  // bundles until each restarts, and those bundles send `riskTier` on every
  // placement and `confirmed` on transitions they believe are gated. The
  // hazard at a removal is never the deleted verb, it is narrowing what old
  // callers still send (learnings.md, "Removing an MCP tool cannot break a
  // peer — the shared server is where a removal bites").
  //
  // So these send the OLD payload shape verbatim rather than today's, since a
  // test written against what the current code emits passes by construction
  // and detects nothing.
  describe('the removed risk gate still accepts what older peers send', () => {
    let wsId: string;

    beforeAll(async () => {
      const r = await post('/api/workspaces', { name: 'risk-ws' });
      wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    });

    const mkTask = async (title: string, riskTier?: string): Promise<Task> => {
      const r = await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title });
      const task = ((await r.json()) as { task: Task }).task;
      if (riskTier) {
        // The 0.1.54-and-earlier set_task_goal payload, `riskTier` included.
        const g = await post(`/api/tasks/${task.id}/goal`, {
          goal: 'chores',
          author: AGENT,
          riskTier,
        });
        expect(g.status).toBe(200);
      }
      return task;
    };

    it('a placement carrying riskTier still succeeds, and still places the task', async () => {
      const t = await mkTask('Flip the repo public', 'red');
      // Not merely a 200: the REST of the payload must still take effect, or
      // "it accepted the field" would also be true of a route that did nothing.
      const after = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      const stored = after.tasks.find((x) => x.id === t.id);
      expect(stored?.goal).toBe('chores');
      expect(stored?.triagedAgainst).toBeDefined();
    });

    it('an unrecognised riskTier value is ignored rather than refused', async () => {
      // This route used to answer 400 here. It must not any more: a value the
      // server has stopped caring about cannot be a reason to fail a caller.
      const t = await mkTask('Nonsense tier');
      const g = await post(`/api/tasks/${t.id}/goal`, {
        goal: 'chores',
        author: AGENT,
        riskTier: 'purple',
      });
      expect(g.status).toBe(200);
    });

    it('an agent forward move on a formerly-red task is no longer refused', async () => {
      const red = await mkTask('Flip the repo public', 'red');
      const moved = await post(`/api/tasks/${red.id}/transition`, {
        to: 'in-progress',
        author: AGENT,
      });
      expect(moved.status).toBe(200);
      const after = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      expect(after.tasks.find((t) => t.id === red.id)?.status).toBe('in-progress');
    });

    it('a transition still carrying confirmed:true succeeds, and records no flag', async () => {
      const yellow = await mkTask('Send the partner update', 'yellow');
      // Exactly what a 0.1.54 bundle sends after asking its human.
      const r = await post(`/api/tasks/${yellow.id}/transition`, {
        to: 'in-progress',
        author: AGENT,
        confirmed: true,
      });
      expect(r.status).toBe(200);
      const { task } = (await r.json()) as { task: Task };
      // The move landed (control) …
      expect(task.status).toBe('in-progress');
      // … and the now-meaningless flag was not written onto the audit row.
      expect(task.transitions.at(-1)?.confirmed).toBeUndefined();
    });

    it('an enforce blocker still refuses — the OTHER arm of the gate is untouched', async () => {
      // Positive control for this whole block. Without it, every "it
      // succeeded" above is equally consistent with a gate that stopped
      // working altogether rather than with one arm being removed.
      const blocker = await mkTask('Unblock me first');
      const dependent = (await (
        await post(`/api/workspaces/${wsId}/tasks`, {
          author: AGENT,
          title: 'Depends on the above',
          after: [blocker.id],
          afterEnforce: [blocker.id],
        })
      ).json()) as { task: Task };
      const refused = await post(`/api/tasks/${dependent.task.id}/transition`, {
        to: 'done',
        author: AGENT,
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toBe('blocked');
    });
  });

  describe('POST /api/tasks/:id/transition', () => {
    let wsId: string;

    beforeAll(async () => {
      const r = await post('/api/workspaces', { name: 'transition-ws' });
      wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    });

    const mkTask = async (title: string): Promise<Task> => {
      const r = await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title });
      return ((await r.json()) as { task: Task }).task;
    };

    it('attributes the actor through the route: person vs agent', async () => {
      const t = await mkTask('attributed');
      const r = await post(`/api/tasks/${t.id}/transition`, {
        to: 'in-progress',
        author: PERSON,
        note: 'kicking off',
      });
      expect(r.status).toBe(200);
      const { task } = (await r.json()) as { task: Task };
      expect(task.transitions[0]?.by).toEqual({
        id: 'known-bryan',
        name: 'Bryan',
        kind: 'person',
      });
      expect(task.transitions[0]?.note).toBe('kicking off');

      const r2 = await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });
      const done = ((await r2.json()) as { task: Task }).task;
      expect(done.transitions[1]?.by.kind).toBe('agent');
    });

    it('stamps evidence + usage through the route and reads back via list', async () => {
      const t = await mkTask('evidenced');
      const r = await post(`/api/tasks/${t.id}/transition`, {
        to: 'done',
        author: AGENT,
        evidence: {
          commit: 'abc1234',
          threadRef: { kind: 'thread', docId: 'hub-plan-doc', threadId: 'th-2' },
        },
        usage: { inputTokens: 900, outputTokens: 120 },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { task: Task; unproven: boolean };
      expect(body.unproven).toBe(false);

      const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      const stored = listed.tasks.find((x) => x.id === t.id);
      expect(stored?.transitions[0]?.evidence?.commit).toBe('abc1234');
      expect(stored?.transitions[0]?.evidence?.threadRef).toEqual({
        kind: 'thread',
        docId: 'hub-plan-doc',
        threadId: 'th-2',
      });
      expect(stored?.transitions[0]?.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
    });

    it('flags an evidence-less done as unproven but still applies it', async () => {
      const t = await mkTask('unproven');
      const r = await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { task: Task; unproven: boolean };
      expect(body.unproven).toBe(true);
      expect(body.task.status).toBe('done');
    });

    it('400s a bad target status, 400s a missing author, 404s an unknown task', async () => {
      const t = await mkTask('errors');
      const bad = await post(`/api/tasks/${t.id}/transition`, { to: 'held', author: AGENT });
      expect(bad.status).toBe(400);
      const noAuthor = await post(`/api/tasks/${t.id}/transition`, { to: 'done' });
      expect(noAuthor.status).toBe(400);
      const missing = await post('/api/tasks/t-ghost/transition', { to: 'done', author: AGENT });
      expect(missing.status).toBe(404);
    });
  });

  describe('POST /api/tasks/:id/evidence', () => {
    let wsId: string;

    beforeAll(async () => {
      const r = await post('/api/workspaces', { name: 'evidence-ws' });
      wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    });

    const mkTask = async (title: string): Promise<Task> => {
      const r = await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title });
      return ((await r.json()) as { task: Task }).task;
    };

    /** Read the task back through the API, never off the in-process store —
     *  this whole file exists because the route is the layer that silently
     *  drops fields. */
    const readBack = async (taskId: string): Promise<Task | undefined> => {
      const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      return listed.tasks.find((x) => x.id === taskId);
    };

    it('forwards evidence + note through the route onto a move that had none', async () => {
      const t = await mkTask('dropped evidence');
      const moved = await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });
      expect(((await moved.json()) as { unproven: boolean }).unproven).toBe(true);

      const r = await post(`/api/tasks/${t.id}/evidence`, {
        author: AGENT,
        evidence: { commit: '621f371' },
        note: 'the field was dropped on my side',
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean; unproven: boolean };
      expect(body.unproven).toBe(false);

      const stored = await readBack(t.id);
      const row = stored?.transitions.at(-1);
      expect(row?.evidence).toBeUndefined(); // appended, not rewritten
      expect(row?.amendments?.[0]?.evidence).toEqual({ commit: '621f371' });
      expect(row?.amendments?.[0]?.note).toBe('the field was dropped on my side');
      expect(row?.amendments?.[0]?.by).toEqual({
        id: 'agent-search-revamp',
        name: 'Search Revamp',
        kind: 'agent',
      });
    });

    it('forwards a threadRef, which a commit-only route would silently drop', async () => {
      const t = await mkTask('thread evidence');
      await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });
      const r = await post(`/api/tasks/${t.id}/evidence`, {
        author: PERSON,
        evidence: { threadRef: { kind: 'thread', docId: 'hub-plan-doc', threadId: 'th-9' } },
      });
      expect(r.status).toBe(200);
      const row = (await readBack(t.id))?.transitions.at(-1);
      expect(row?.amendments?.[0]?.evidence?.threadRef).toEqual({
        kind: 'thread',
        docId: 'hub-plan-doc',
        threadId: 'th-9',
      });
    });

    it('corrects evidence that was present and wrong, keeping the false claim on the record', async () => {
      const t = await mkTask('wrong sha');
      await post(`/api/tasks/${t.id}/transition`, {
        to: 'done',
        author: AGENT,
        evidence: { commit: 'b2ba21e' },
      });
      const r = await post(`/api/tasks/${t.id}/evidence`, {
        author: AGENT,
        evidence: { commit: '621f371' },
        note: 'wrote it from memory; it resolves to nothing',
      });
      expect(r.status).toBe(200);
      const row = (await readBack(t.id))?.transitions.at(-1);
      expect(row?.evidence).toEqual({ commit: 'b2ba21e' });
      expect(row?.amendments?.[0]?.supersedes).toEqual({ commit: 'b2ba21e' });
      expect(row?.amendments?.[0]?.evidence).toEqual({ commit: '621f371' });
    });

    it('forwards transitionTs, so an earlier move can be the one corrected', async () => {
      const t = await mkTask('two moves');
      await post(`/api/tasks/${t.id}/transition`, { to: 'in-progress', author: AGENT });
      await new Promise((r) => setTimeout(r, 2)); // distinct ts — ts is the address
      await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });
      const before = await readBack(t.id);
      const first = before?.transitions[0];
      expect(first?.ts).not.toBe(before?.transitions[1]?.ts);

      const r = await post(`/api/tasks/${t.id}/evidence`, {
        author: AGENT,
        evidence: { commit: 'aaa1111' },
        transitionTs: first?.ts,
      });
      expect(r.status).toBe(200);
      const after = await readBack(t.id);
      // Without the route forwarding transitionTs this lands on the LAST row
      // and both assertions flip — which is exactly the silent-drop shape.
      expect(after?.transitions[0]?.amendments?.length).toBe(1);
      expect(after?.transitions[1]?.amendments).toBeUndefined();
    });

    it('400s empty evidence, 400s a missing author, 404s an unknown task', async () => {
      const t = await mkTask('evidence errors');
      await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });
      const empty = await post(`/api/tasks/${t.id}/evidence`, { author: AGENT, evidence: {} });
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as { error: string }).error).toBe('empty-evidence');
      const noAuthor = await post(`/api/tasks/${t.id}/evidence`, { evidence: { commit: 'abc' } });
      expect(noAuthor.status).toBe(400);
      const ghost = await post('/api/tasks/t-ghost/evidence', {
        author: AGENT,
        evidence: { commit: 'abc' },
      });
      expect(ghost.status).toBe(404);
      // The refusals left nothing behind.
      expect((await readBack(t.id))?.transitions.at(-1)?.amendments).toBeUndefined();
    });

    it('tells a same-status caller where to take the evidence instead', async () => {
      const t = await mkTask('same status');
      await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });
      const retry = await post(`/api/tasks/${t.id}/transition`, {
        to: 'done',
        author: AGENT,
        evidence: { commit: '621f371' },
      });
      expect(retry.status).toBe(400);
      const body = (await retry.json()) as { error: string; message?: string };
      expect(body.error).toBe('same-status');
      expect(body.message ?? '').toContain('/evidence');
    });
  });

  describe('GET /api/workspaces/:id/next (the work queue)', () => {
    /** Goals a, b + a chores task, so priority order is observable. */
    async function seed(): Promise<{ wsId: string; ids: Record<string, string>; G: GoalIds }> {
      const r = await post('/api/workspaces', { name: 'queue-ws', goal: 'Ship it.' });
      const wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
      const G = await seedGoalsOverHttp(
        base,
        wsId,
        [
          {
            key: 'ship',
            title: '1. Ship',
            subgoals: [
              { key: 'blockers', title: '1.1 Blockers' },
              { key: 'loop', title: '1.2 Loop' },
            ],
          },
        ],
        PERSON,
      );
      // PERSON, not AGENT: these cases are about the queue's ORDER and its
      // filters, and an agent's own create lands in `triage`, which the queue
      // never returns. Filing as a person is the shortest way to put real
      // queueable work on the board without a vetting round-trip per row.
      const mk = async (opts: Record<string, unknown>): Promise<string> => {
        const res = await post(`/api/workspaces/${wsId}/tasks`, { author: PERSON, ...opts });
        expect(res.status).toBe(200);
        return ((await res.json()) as { task: { id: string } }).task.id;
      };
      const ids: Record<string, string> = {};
      ids.chore = await mk({ title: 'A chore', goal: 'chores' });
      ids.loop = await mk({ title: 'Loop work', goal: G.loop });
      ids.blocker = await mk({
        title: 'Delivery blocker',
        goal: G.blockers,
        body: 'Agent can ship so that peers get the fix.\n\nDone when: merged.',
      });
      return { wsId, ids, G };
    }

    it('answers in priority order, with the goal title and the description line', async () => {
      const { wsId, ids } = await seed();
      const res = await local(`/api/workspaces/${wsId}/next`);
      expect(res.status).toBe(200);
      const { tasks } = (await res.json()) as {
        tasks: Array<{ id: string; goalTitle: string; body: string }>;
      };
      expect(tasks.map((t) => t.id)).toEqual([ids.blocker, ids.loop, ids.chore]);
      expect(tasks[0]?.goalTitle).toBe('1.1 Blockers');
      // The WHOLE description, not a first line — the row has to be
      // pickup-able without a second call.
      expect(tasks[0]?.body).toBe(
        'Agent can ship so that peers get the fix.\n\nDone when: merged.',
      );
    });

    it('forwards assignee, limit and includeBlocked', async () => {
      const r = await post('/api/workspaces', { name: 'filter-ws', goal: 'Ship it.' });
      const wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
      // PERSON for the same reason as `seed` above: queueable work, no triage.
      const mk = async (opts: Record<string, unknown>): Promise<string> => {
        const res = await post(`/api/workspaces/${wsId}/tasks`, { author: PERSON, ...opts });
        return ((await res.json()) as { task: { id: string } }).task.id;
      };
      const dep = await mk({ title: 'dep', assignee: 'human' });
      const held = await mk({ title: 'held', after: [dep], afterEnforce: [dep] });

      const mine = await local(`/api/workspaces/${wsId}/next?assignee=human`);
      const mineRows = (await mine.json()) as { tasks: Array<{ id: string }> };
      expect(mineRows.tasks.map((t) => t.id)).toEqual([dep]);

      const capped = await local(`/api/workspaces/${wsId}/next?limit=1`);
      expect(((await capped.json()) as { tasks: unknown[] }).tasks).toHaveLength(1);

      // Default hides the hard-blocked row; includeBlocked brings it back.
      const plain = await local(`/api/workspaces/${wsId}/next`);
      expect(
        ((await plain.json()) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id),
      ).not.toContain(held);
      const all = await local(`/api/workspaces/${wsId}/next?includeBlocked=true`);
      const allRows = (await all.json()) as {
        tasks: Array<{ id: string; ready: boolean; blockedBy: unknown[] }>;
      };
      const heldRow = allRows.tasks.find((t) => t.id === held);
      expect(heldRow?.ready).toBe(false);
      expect(heldRow?.blockedBy).toHaveLength(1);
    });

    it('404s for an unknown workspace', async () => {
      const res = await local('/api/workspaces/w-nope/next');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/workspaces/:id (goal summary)', () => {
    it('returns the ordered goals with counts, parent then subgoals, Backlog last', async () => {
      const { wsId, G } = await (async () => {
        const r = await post('/api/workspaces', { name: 'summary-ws', goal: 'Ship it.' });
        const id = ((await r.json()) as { workspace: { id: string } }).workspace.id;
        const goals = await seedGoalsOverHttp(
          base,
          id,
          [{ key: 'one', title: '1. One', subgoals: [{ key: 'oneA', title: '1.1 One A' }] }],
          PERSON,
        );
        // PERSON, so these land in `todo` and the assertion below is about
        // the counts' PLACEMENT rather than about triage. The triage count is
        // covered on its own in task-triage-status.test.ts.
        await post(`/api/workspaces/${id}/tasks`, {
          author: PERSON,
          title: 'in a subgoal',
          goal: goals.oneA,
        });
        await post(`/api/workspaces/${id}/tasks`, {
          author: PERSON,
          title: 'a chore',
          goal: 'chores',
        });
        return { wsId: id, G: goals };
      })();

      const res = await local(`/api/workspaces/${wsId}`);
      expect(res.status).toBe(200);
      const { goalSummary } = (await res.json()) as {
        goalSummary: Array<{ id: string; title: string; depth: number; todo: number }>;
      };
      expect(goalSummary.map((g) => g.id)).toEqual([G.one, G.oneA, 'chores']);
      expect(goalSummary.map((g) => g.depth)).toEqual([0, 1, 0]);
      expect(goalSummary.find((g) => g.id === G.oneA)?.todo).toBe(1);
      expect(goalSummary.find((g) => g.id === 'chores')?.todo).toBe(1);
    });
  });

  /**
   * The board's "what needs you" strip. Driven end-to-end because the unit
   * tests in review-queue.test.ts call the module directly, and every one of
   * them would still pass if the route forwarded nothing at all.
   */
  describe('GET /api/workspaces/:id/review-items', () => {
    it('lists an agent question on a task discussion, and drops it once a person answers', async () => {
      const r = await post('/api/workspaces', { name: 'review-ws', goal: 'Answer things.' });
      const wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
      const t = await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'Pick a colour',
      });
      const taskId = ((await t.json()) as { task: { id: string } }).task.id;
      const bodyDoc = `task:${taskId}`;

      // A person opens the thread (which is also what puts them on the
      // roster of addressable names), then the agent asks them by name. A
      // thread on the task's own body room is the same surface
      // `create_thread` writes to — and since 2026-08-21 only a DIRECT ask
      // reaches the queue, not every agent comment.
      const made = await post(`/api/docs/${encodeURIComponent(bodyDoc)}/threads`, {
        author: PERSON,
        text: 'Banner colour needs a call.',
        anchor: { kind: 'subject' },
      });
      expect(made.status).toBe(200);
      const threadId = ((await made.json()) as { thread: { id: string } }).thread.id;
      const askedText = 'Bryan — green or blue for the banner?';
      const askRes = await post(
        `/api/docs/${encodeURIComponent(bodyDoc)}/threads/${encodeURIComponent(threadId)}/comments`,
        { author: AGENT, text: askedText },
      );
      expect(askRes.status).toBe(200);

      const listed = await local(`/api/workspaces/${wsId}/review-items`);
      expect(listed.status).toBe(200);
      const { items } = (await listed.json()) as {
        items: Array<{ kind: string; taskId?: string; threadId: string; ask: string }>;
      };
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'task-thread',
        taskId,
        threadId,
        ask: askedText,
      });

      // …and a person's reply is the only thing that clears it.
      const replied = await post(
        `/api/docs/${encodeURIComponent(bodyDoc)}/threads/${encodeURIComponent(threadId)}/comments`,
        { author: PERSON, text: 'blue' },
      );
      expect(replied.status).toBe(200);
      const after = await local(`/api/workspaces/${wsId}/review-items`);
      expect(((await after.json()) as { items: unknown[] }).items).toEqual([]);
    });

    /**
     * A DECLARED item is not cleared that way, and this is the route-level
     * proof of it.
     *
     * Reproduced in the browser before it was fixed: on a task with a pending
     * ask, one line typed into "Add a comment…" made the whole card —
     * question, why and every option button — disappear, and it stayed gone
     * across a reload with the decision never answered. The composer has no
     * target picker (by design), it derives one as the newest comment's
     * thread, and that is the ask's own thread on exactly the tasks where an
     * agent has just asked something.
     *
     * Driven over HTTP rather than through `reviewThreadItems` because the
     * mechanism spans two routes the unit test cannot see: the comment lands
     * through `/comments`, the answer through `/answer`, and it is the second
     * one that has to leave a record the first one does not.
     */
    it('keeps a declared review item through an ordinary comment, and drops it on an answer', async () => {
      const r = await post('/api/workspaces', { name: 'declared-ws', goal: 'Answer things.' });
      const wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
      const t = await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'Ship it' });
      const taskId = ((await t.json()) as { task: { id: string } }).task.id;
      const bodyDoc = encodeURIComponent(`task:${taskId}`);

      const made = await post(`/api/docs/${bodyDoc}/threads`, {
        author: AGENT,
        text: 'Two ways to go, both fine.',
        anchor: { kind: 'subject' },
        review: {
          shape: 'decision',
          headline: 'Dim resolved threads or hide them?',
          detail: 'Hiding is tidier; dimming keeps the history one tap away.',
          options: [
            { id: 'hide', label: 'Hide them' },
            { id: 'dim', label: 'Keep dimmed' },
          ],
        },
      });
      expect(made.status, await made.clone().text()).toBe(200);
      const thread = ((await made.json()) as { thread: { id: string; comments: { id: string }[] } })
        .thread;
      const threadId = encodeURIComponent(thread.id);
      const commentId = thread.comments[0]?.id;

      // The reader says something that is not an answer — the exact act that
      // used to delete the card.
      const chat = await post(`/api/docs/${bodyDoc}/threads/${threadId}/comments`, {
        author: PERSON,
        text: 'Reading this now, one sec.',
      });
      expect(chat.status).toBe(200);

      const still = (await (await local(`/api/workspaces/${wsId}/review-items`)).json()) as {
        items: Array<{ band: string; review?: { options?: unknown[] } }>;
      };
      expect(still.items).toHaveLength(1);
      expect(still.items[0]?.band).toBe('declared');
      // The options are what vanished on the screen, so they are what is
      // asserted: a row with no payload would not re-render the card.
      expect(still.items[0]?.review?.options).toHaveLength(2);

      // Answering does clear it — the positive control, without which a route
      // that had simply stopped dropping anything would pass the assertion
      // above.
      const answered = await post(`/api/docs/${bodyDoc}/threads/${threadId}/answer`, {
        author: PERSON,
        text: 'Neither — dim them on mobile only.',
        commentId,
      });
      expect(answered.status, await answered.clone().text()).toBe(200);
      const gone = await local(`/api/workspaces/${wsId}/review-items`);
      expect(((await gone.json()) as { items: unknown[] }).items).toEqual([]);
    });

    /**
     * `direct` and the roster it depends on, end-to-end.
     *
     * The unit tests hand `reviewThreadItems` a source they build themselves,
     * so they cannot see WHICH threads the route feeds it — and the route
     * filters to open threads, which is right for "what is waiting" and wrong
     * for "who is a person here". Resolving an unrelated thread on a different
     * task used to empty the roster and silently downgrade a live question.
     */
    it('marks a question addressed to a person, and keeps it marked when an unrelated thread resolves', async () => {
      const r = await post('/api/workspaces', { name: 'direct-ws', goal: 'Answer things.' });
      const wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
      const mkTask = async (title: string) => {
        const t = await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title });
        return `task:${((await t.json()) as { task: { id: string } }).task.id}`;
      };
      const seedDoc = await mkTask('Somewhere a person spoke');
      const askDoc = await mkTask('Pick a colour');
      const mkThread = async (docId: string, body: Record<string, unknown>) => {
        const made = await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
          anchor: { kind: 'subject' },
          ...body,
        });
        expect(made.status).toBe(200);
        return ((await made.json()) as { thread: { id: string } }).thread.id;
      };

      const seedThread = await mkThread(seedDoc, { author: PERSON, text: 'have a look' });
      await mkThread(askDoc, {
        author: AGENT,
        text: `**${PERSON.name} — this one is yours:** should the banner be (a) green or (b) blue?`,
      });

      const askItem = async () => {
        const res = await local(`/api/workspaces/${wsId}/review-items`);
        expect(res.status).toBe(200);
        const { items } = (await res.json()) as {
          items: Array<{ docId: string; direct?: boolean; askedAt?: number; ask: string }>;
        };
        return items.find((i) => i.docId === askDoc);
      };

      // Positive control: the field arrives through the route at all, and the
      // extracted ask is the question rather than a clip from character zero.
      const before = await askItem();
      expect(before?.direct).toBe(true);
      expect(before?.ask).toContain('(a) green or (b) blue?');
      expect(typeof before?.askedAt).toBe('number');

      // Resolving the person's own thread on ANOTHER task must not change who
      // counts as a person.
      const closed = await local(
        `/api/docs/${encodeURIComponent(seedDoc)}/threads/${encodeURIComponent(seedThread)}/resolve`,
        { method: 'POST' },
      );
      expect(closed.status).toBe(200);

      const after = await askItem();
      expect(after?.direct).toBe(true);
      expect(after?.ask).toContain('(a) green or (b) blue?');
    });

    it('404s an unknown workspace rather than answering with an empty queue', async () => {
      const res = await local('/api/workspaces/w-absent/review-items');
      expect(res.status).toBe(404);
    });
  });

  describe('persistence through the server handle', () => {
    it('a created workspace survives into a fresh server on the same dataDir', async () => {
      const r = await post('/api/workspaces', { name: 'durable-ws', goal: 'Persist.' });
      const wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
      await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'survives' });
      handle.tasks.flush();

      const second = createServer({ port: 0, dataDir });
      try {
        const got = await fetch(`http://localhost:${second.port}/api/workspaces/${wsId}/tasks`, {
          headers: { host: `localhost:${second.port}` },
        });
        expect(got.status).toBe(200);
        const { tasks } = (await got.json()) as { tasks: Task[] };
        expect(tasks.map((t) => t.title)).toEqual(['survives']);
      } finally {
        await second.stop();
      }
    });
  });
});
