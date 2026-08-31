/**
 * Plan-doc linkage: tasks derived from a planning doc.
 *
 * Three promises under test, end to end over real HTTP:
 *
 *  1. A batch filed with `sourceDoc` stamps a structured doc origin on every
 *     row (no second link call), and a PLAN doc's rows are drafts — visible,
 *     in no dispatch read, and refused by the transition gate until
 *     `POST /api/docs/:id/plan` approves the plan, which releases them to
 *     todo attributed to the approver.
 *  2. A settled authoring edit on the doc bumps its durable content revision
 *     and flags open derived rows `possiblyStale`; a body rewrite reconciles
 *     the row and a still-later edit re-flags it.
 *  3. The doc's own payload surfaces the derived rows with the marks a
 *     member needs (workspaceId, planHeld, possiblyStale) while a bare chip
 *     stays the §3.3 visitor shape.
 *
 * Fixtures are synthetic (the jordan@partner.example register — the repo is
 * public), and every absence assertion keeps a positive control beside it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const AGENT = { id: 'agent-quill', name: 'Quill', kind: 'agent' };

describe('plan-doc linkage (routes)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;
  /** Minted id of the plan doc (created under the alias `sprint-plan`). */
  let planId: string;

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

  /** One settled authoring edit on a doc: any Yjs write under an
   *  `agent`-shaped origin, then the settle (which commits the debounce the
   *  way a create-from-doc or the timer would). Returns the new revision. */
  const editDoc = (docId: string): number => {
    const room = handle.rooms.get(docId);
    if (!room) throw new Error(`no room for ${docId}`);
    room.ydoc.transact(() => {
      room.ydoc.getText('content').insert(0, 'x');
    }, 'agent');
    return handle.rooms.settledContentRevision(docId) ?? -1;
  };

  const taskById = (id: string): Task => {
    const t = handle.tasks.getTask(id);
    if (!t) throw new Error(`no task ${id}`);
    return t;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'plan-links-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const r = await post('/api/workspaces', { name: 'plan-links-ws', goal: 'Ship the plan flow.' });
    wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    const mdPath = join(dataDir, 'sprint-plan.md');
    writeFileSync(mdPath, '# Sprint plan\n\nThe plan.\n');
    const doc = await post('/api/docs', {
      docId: 'sprint-plan',
      type: 'markdown',
      sourceUrl: mdPath,
    });
    planId = ((await doc.json()) as { docId: string }).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('sourceDoc on the batch route', () => {
    let heldId: string;
    let freeId: string;

    it('stamps a doc origin on every row, holds plan drafts in triage, and marks the doc pending', async () => {
      const r = await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        sourceDoc: { docId: 'sprint-plan' },
        tasks: [
          { title: 'Jordan can approve the plan so that work starts deliberately' },
          { title: 'Agent can build the first slice so that the plan lands' },
        ],
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        tasks: Task[];
        sourceDoc?: { docId: string; mode: string; held: boolean };
        visibility?: Array<{ taskId: string; note: string }>;
      };
      expect(body.tasks).toHaveLength(2);
      // Defaulted to plan mode (not a huddle), gate pending, rows held.
      expect(body.sourceDoc).toEqual({ docId: planId, mode: 'plan', held: true });
      for (const t of body.tasks) {
        expect(t.origin).toEqual({ kind: 'doc', docId: planId });
        expect(t.planHold).toEqual({ docId: planId });
        expect(t.status).toBe('triage');
        // Derived-at revision stamped from the live doc (no edits yet → 0).
        expect(t.originDocRevision).toBe(0);
      }
      // The caller is told, per row, that these are drafts.
      expect(body.visibility?.length).toBe(2);
      for (const v of body.visibility ?? []) {
        expect(v.note).toContain('plan');
      }
      heldId = body.tasks[0]?.id ?? '';
      const meta = (await (await local('/api/docs/sprint-plan')).json()) as {
        meta: { planState?: string };
      };
      expect(meta.meta.planState).toBe('pending');
    });

    it('held drafts are in no dispatch read — beside a positive control that is', async () => {
      const free = await post(`/api/workspaces/${wsId}/tasks`, {
        author: PERSON,
        assignee: 'human',
        title: 'Jordan can see an ordinary row so that this read is proven live',
        goal: 'chores',
      });
      freeId = ((await free.json()) as { task: Task }).task.id;
      const next = (await (await local(`/api/workspaces/${wsId}/next`)).json()) as {
        tasks: Array<{ id: string }>;
      };
      const ids = next.tasks.map((t) => t.id);
      expect(ids).toContain(freeId); // the control: the read can see rows
      expect(ids).not.toContain(heldId);
    });

    it('the transition gate refuses to move a held draft, as a 409 the caller can read', async () => {
      const r = await post(`/api/tasks/${heldId}/transition`, { author: PERSON, to: 'todo' });
      expect(r.status).toBe(409);
      const body = (await r.json()) as { error: string; message?: string };
      expect(body.error).toBe('plan-unapproved');
      expect(body.message).toContain(planId);
      // Control: the same call on an unheld row works.
      const ok = await post(`/api/tasks/${freeId}/transition`, {
        author: PERSON,
        to: 'in-progress',
      });
      expect(ok.status).toBe(200);
    });

    it('approving the plan releases the drafts to todo, attributed to the approver', async () => {
      const r = await post('/api/docs/sprint-plan/plan', { state: 'approved', author: PERSON });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { planState: string; released: string[] };
      expect(body.planState).toBe('approved');
      expect(body.released).toContain(heldId);
      const t = taskById(heldId);
      expect(t.status).toBe('todo');
      expect(t.planHold).toBeUndefined();
      const lastMove = t.transitions[t.transitions.length - 1];
      expect(lastMove?.by.name).toBe('Jordan');
      // The gate opens: the released row transitions normally now.
      const moved = await post(`/api/tasks/${heldId}/transition`, {
        author: PERSON,
        to: 'in-progress',
      });
      expect(moved.status).toBe(200);
      const meta = (await (await local('/api/docs/sprint-plan')).json()) as {
        meta: { planState?: string; planApprovedBy?: string };
      };
      expect(meta.meta.planState).toBe('approved');
      expect(meta.meta.planApprovedBy).toBe('Jordan');
    });

    it('an approved plan gates nothing: later rows ride in unheld, origin still stamped', async () => {
      const r = await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        sourceDoc: { docId: 'sprint-plan' },
        tasks: [{ title: 'Agent can add a follow-up so that approved plans stay usable' }],
      });
      const body = (await r.json()) as { tasks: Task[]; sourceDoc?: { held: boolean } };
      expect(body.sourceDoc?.held).toBe(false);
      expect(body.tasks[0]?.planHold).toBeUndefined();
      expect(body.tasks[0]?.origin).toEqual({ kind: 'doc', docId: planId });
    });

    it("discussion mode never holds, and a huddle doc defaults to it — a plain doc defaults to 'plan' (control above)", async () => {
      handle.rooms.getOrCreate('standup-notes', { type: 'markdown', huddle: true });
      const r = await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        sourceDoc: { docId: 'standup-notes' },
        tasks: [{ title: 'Agent can act on a standup note so that discussion tasks start free' }],
      });
      const body = (await r.json()) as {
        tasks: Task[];
        sourceDoc?: { docId: string; mode: string; held: boolean };
      };
      expect(body.sourceDoc).toEqual({ docId: 'standup-notes', mode: 'discussion', held: false });
      expect(body.tasks[0]?.planHold).toBeUndefined();
      expect(body.tasks[0]?.origin).toEqual({ kind: 'doc', docId: 'standup-notes' });
      // The huddle doc was NOT marked a pending plan by riding through here.
      expect(handle.rooms.get('standup-notes')?.meta.planState).toBeUndefined();
    });

    it('a sourceDoc that names no real doc is refused whole — its gate cannot be read', async () => {
      const r = await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        sourceDoc: { docId: 'no-such-doc' },
        tasks: [{ title: 'Agent can never see this row so that the refusal is whole' }],
      });
      expect(r.status).toBe(404);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe('source-doc-not-found');
    });
  });

  describe('possiblyStale on plan edits', () => {
    let derivedId: string;
    let doneId: string;
    let docId: string;

    beforeAll(async () => {
      handle.rooms.getOrCreate('drift-plan', { type: 'markdown' });
      docId = 'drift-plan';
      const r = await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        sourceDoc: { docId, mode: 'discussion' },
        tasks: [
          { title: 'Agent can chase the plan so that drift is visible', goal: 'chores' },
          { title: 'Agent can finish early so that done rows stay quiet', goal: 'chores' },
        ],
      });
      const body = (await r.json()) as { tasks: Task[] };
      derivedId = body.tasks[0]?.id ?? '';
      doneId = body.tasks[1]?.id ?? '';
      await post(`/api/tasks/${doneId}/transition`, { author: PERSON, to: 'todo' });
      await post(`/api/tasks/${doneId}/transition`, { author: PERSON, to: 'done' });
    });

    it('a settled authoring edit flags open derived rows and leaves done ones alone', () => {
      expect(taskById(derivedId).originDocRevision).toBe(0);
      const rev = editDoc(docId);
      expect(rev).toBe(1);
      expect(taskById(derivedId).possiblyStale).toEqual({
        docRevision: 1,
        ts: expect.any(Number),
      });
      // Controls, both directions: the done sibling derived from the same
      // doc is not flagged, and the flagged row proves the sweep ran.
      expect(taskById(doneId).possiblyStale).toBeUndefined();
    });

    it('a body rewrite reconciles the row; a still-later edit re-flags it', () => {
      expect(handle.tasks.updateBodySnapshot(derivedId, 'Reworked against the new plan.')).toBe(
        true,
      );
      const t = taskById(derivedId);
      expect(t.possiblyStale).toBeUndefined();
      expect(t.originDocRevision).toBe(1); // re-stamped at the flagged revision
      const rev = editDoc(docId);
      expect(rev).toBe(2);
      expect(taskById(derivedId).possiblyStale).toEqual({
        docRevision: 2,
        ts: expect.any(Number),
      });
    });

    it('a row created mid-burst stamps the settled (post-edit) revision, so its own source words never flag it', async () => {
      const room = handle.rooms.get(docId);
      if (!room) throw new Error('room gone');
      // An authoring burst that has NOT settled yet…
      room.ydoc.transact(() => {
        room.ydoc.getText('content').insert(0, 'y');
      }, 'agent');
      // …and a create from the doc before the debounce fires.
      const r = await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        sourceDoc: { docId, mode: 'discussion' },
        tasks: [{ title: 'Agent can derive mid-burst so that self-edits never flag' }],
      });
      const created = ((await r.json()) as { tasks: Task[] }).tasks[0];
      expect(created?.originDocRevision).toBe(3); // settled AT the create
      expect(taskById(created?.id ?? '').possiblyStale).toBeUndefined();
    });
  });

  describe('promote_to_task under a pending plan', () => {
    it('a thread promoted off a pending plan doc is held like a batch draft', async () => {
      handle.rooms.getOrCreate('promote-plan', { type: 'markdown' });
      // Declare it a plan by filing one draft from it.
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        sourceDoc: { docId: 'promote-plan' },
        tasks: [{ title: 'Agent can seed the plan so that the gate is pending' }],
      });
      const th = await post('/api/docs/promote-plan/threads', {
        author: PERSON,
        text: 'Split the migration into its own row.',
        anchor: { kind: 'subject' },
      });
      expect(th.status).toBe(200);
      const threadId = ((await th.json()) as { thread: { id: string } }).thread.id;
      const r = await post(`/api/docs/promote-plan/threads/${threadId}/promote`, {
        author: AGENT,
        workspaceId: wsId,
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { task: Task; visibility?: string };
      expect(body.task.planHold).toEqual({ docId: 'promote-plan' });
      expect(body.task.status).toBe('triage');
      expect(body.visibility).toContain('plan');
      // Control: promoting off a doc with NO plan gate carries no hold.
      handle.rooms.getOrCreate('free-doc', { type: 'markdown' });
      const th2 = await post('/api/docs/free-doc/threads', {
        author: PERSON,
        text: 'Just do it.',
        anchor: { kind: 'subject' },
      });
      const t2 = ((await th2.json()) as { thread: { id: string } }).thread.id;
      const r2 = await post(`/api/docs/free-doc/threads/${t2}/promote`, {
        author: AGENT,
        workspaceId: wsId,
      });
      const b2 = (await r2.json()) as { task: Task };
      expect(b2.task.planHold).toBeUndefined();
    });
  });

  describe('import_tasks_markdown from a bound plan doc', () => {
    it('imported rows cite the bound doc as origin and inherit a pending gate', async () => {
      const trackerPath = join(dataDir, 'tracker.md');
      writeFileSync(
        trackerPath,
        [
          '# Tracker',
          '',
          '## Rollout',
          '',
          '| Task | Status | Owner |',
          '| ---- | ------ | ----- |',
          '| Ship the importer | | jordan |',
          '',
        ].join('\n'),
      );
      const doc = await post('/api/docs', {
        docId: 'tracker-plan',
        type: 'markdown',
        sourceUrl: trackerPath,
      });
      const trackerDocId = ((await doc.json()) as { docId: string }).docId;
      const pend = await post('/api/docs/tracker-plan/plan', { state: 'pending', author: PERSON });
      expect(pend.status).toBe(200);
      const r = await post(`/api/workspaces/${wsId}/import-tasks`, {
        author: PERSON,
        path: trackerPath,
        apply: true,
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { tasksCreated: Array<{ id: string }> };
      expect(body.tasksCreated.length).toBeGreaterThan(0);
      for (const row of body.tasksCreated) {
        const t = taskById(row.id);
        expect(t.origin).toEqual({ kind: 'doc', docId: trackerDocId });
        expect(t.planHold).toEqual({ docId: trackerDocId });
        expect(t.status).toBe('triage');
      }
    });
  });

  describe('doc payload surfacing', () => {
    it('a member sees derived rows with workspaceId + plan marks; the chip base shape is intact', async () => {
      const body = (await (await local('/api/docs/sprint-plan')).json()) as {
        tasks?: Array<{
          id: string;
          title: string;
          status: string;
          assignee: string;
          workspaceId?: string;
          planHeld?: boolean;
        }>;
      };
      expect(body.tasks?.length).toBeGreaterThan(0);
      for (const chip of body.tasks ?? []) {
        expect(typeof chip.id).toBe('string');
        expect(typeof chip.title).toBe('string');
        expect(chip.workspaceId).toBe(wsId);
      }
      // Same entries from the dedicated subroute.
      const sub = (await (await local('/api/docs/sprint-plan/tasks')).json()) as {
        tasks: Array<{ workspaceId?: string }>;
      };
      expect(sub.tasks.length).toBe(body.tasks?.length ?? -1);
      expect(sub.tasks[0]?.workspaceId).toBe(wsId);
    });

    it('a held draft shows planHeld on the doc surface, and a released row does not', async () => {
      const sub = (await (await local('/api/docs/promote-plan/tasks')).json()) as {
        tasks: Array<{ id: string; planHeld?: boolean }>;
      };
      const held = sub.tasks.filter((t) => t.planHeld === true);
      expect(held.length).toBeGreaterThan(0); // control for the absence below
      const released = (await (await local('/api/docs/sprint-plan/tasks')).json()) as {
        tasks: Array<{ planHeld?: boolean }>;
      };
      expect(released.tasks.every((t) => t.planHeld === undefined)).toBe(true);
    });
  });
});
