/**
 * The title gate, through the REAL routes.
 *
 * `task.title` has three writers in the store and seven doors above them, and
 * this repo has twice shipped a guard that sat one layer away from where the
 * value was actually written. So every assertion here goes through HTTP and
 * reads the effect back, and the staleness cases deliberately drive the door
 * that does NOT go through `update_task_body` — `POST /api/docs/task:<id>/content`
 * — because that is the one a route-level guard would miss.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };

const GOOD_TITLE = 'Agents can rank a backlog by reading the goal order first';
const OBSERVATION_TITLE = 'A decision-answered event promises a link checklist';

/** Long enough to force a clip, and phrased the way a real capture is. */
const CAPTURE =
  'For tasks, I get dumped onto a board with no idea which row matters most to anybody';

const BODY_A = [
  'Agents can rank a backlog by reading the goal order first so that the top of',
  'the queue is the work that matters most.',
  '',
  'Done when: next_tasks returns rows in goal order and the first row is from',
  'the highest band that still has open work.',
].join('\n');

/** Shares not one content word with BODY_A — a total rewrite. */
const BODY_TOTALLY_DIFFERENT = [
  'Visitors watching a shared board must never receive host-machine paths.',
  '',
  'Done when: redaction strips every sidecar field before broadcast.',
].join('\n');

describe('task title gate', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function seedWorkspace(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'titles', goal: 'Make the board scannable.' }),
    );
    return workspace.id;
  }
  async function createTask(
    workspaceId: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ task: Task; titleGaps?: string[]; titleMessage?: string }> {
    return jj(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title: GOOD_TITLE,
        assignee: 'Jordan',
        author: PERSON,
        goal: 'chores',
        body: BODY_A,
        ...extra,
      }),
    );
  }
  async function readTask(
    workspaceId: string,
    taskId: string,
  ): Promise<Task & { titleGaps?: string[] }> {
    const { tasks } = await jj<{ tasks: Array<Task & { titleGaps?: string[] }> }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    const row = tasks.find((t) => t.id === taskId);
    expect(row, `task ${taskId} missing from the list route`).toBeDefined();
    return row as Task & { titleGaps?: string[] };
  }
  /** The door that skips `update_task_body` entirely. */
  const rewriteViaDocRoute = (taskId: string, markdown: string) =>
    post(`/api/docs/task:${taskId}/content`, { markdown, author: PERSON });

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-title-gate-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── The advisory is returned, and NOTHING is refused for it ──────────────

  describe('create is advised, never refused', () => {
    it('creates the task anyway and names the gaps', async () => {
      const wsId = await seedWorkspace();
      const res = await createTask(wsId, { title: OBSERVATION_TITLE });
      // The teeth are in the response, not in a 400: a raw capture must still
      // land, or capture becomes impossible.
      expect(res.task.id.length).toBeGreaterThan(0);
      expect(res.titleGaps).toContain('no-persona');
      expect(res.titleMessage).toBeTruthy();
      // And it really is stored, not just echoed.
      expect((await readTask(wsId, res.task.id)).title).toBe(OBSERVATION_TITLE);
    });

    it('a title that meets the standard carries no advisory at all', async () => {
      // Positive control for every absence below: the same route, same shape,
      // must be capable of returning a clean answer.
      const wsId = await seedWorkspace();
      const res = await createTask(wsId);
      expect(res.titleGaps).toBeUndefined();
      expect(res.titleMessage).toBeUndefined();
    });

    it('the batch route reports gaps per row', async () => {
      const wsId = await seedWorkspace();
      const out = await jj<{
        tasks: Task[];
        titleGaps?: Array<{ taskId: string; gaps: string[] }>;
      }>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: PERSON,
          tasks: [
            { title: GOOD_TITLE, assignee: 'Jordan', goal: 'chores', body: BODY_A },
            { title: OBSERVATION_TITLE, assignee: 'Jordan', goal: 'chores', body: BODY_A },
          ],
        }),
      );
      expect(out.tasks).toHaveLength(2);
      const good = out.tasks.find((t) => t.title === GOOD_TITLE);
      const bad = out.tasks.find((t) => t.title === OBSERVATION_TITLE);
      const flagged = out.titleGaps ?? [];
      // By id, so the row that needs naming is identifiable without a diff —
      // and the clean row is absent from the list rather than present-and-empty.
      expect(bad).toBeDefined();
      expect(good).toBeDefined();
      expect(flagged.map((r) => r.taskId)).toEqual([bad?.id as string]);
      expect(flagged.find((r) => r.taskId === bad?.id)?.gaps).toContain('no-persona');
      expect(flagged.some((r) => r.taskId === good?.id)).toBe(false);
    });
  });

  // ── Every door reports ───────────────────────────────────────────────────

  describe('every writer of a title reports on it', () => {
    it('the board inline rename reports gaps on the new title', async () => {
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      const res = await jj<{ titleGaps?: string[] }>(
        await post(`/api/tasks/${task.id}/title`, {
          title: 'For tasks, I get dumped o…',
          author: PERSON,
        }),
      );
      expect(res.titleGaps).toContain('clipped');
      expect(res.titleGaps).toContain('no-persona');
    });

    it('update_task_body reports gaps on the title it sets in the same act', async () => {
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      const res = await jj<{ titleGaps?: string[] }>(
        await post(`/api/tasks/${task.id}/body`, {
          markdown: BODY_A,
          title: OBSERVATION_TITLE,
          author: PERSON,
        }),
      );
      expect(res.titleGaps).toContain('no-persona');
    });

    it('promote_to_task clips a long capture at a word boundary, not mid-word', async () => {
      const wsId = await seedWorkspace();
      const docId = 'title-promote';
      const file = join(dataDir, `${docId}.md`);
      writeFileSync(file, '# Doc\n\nthe ranking clause\n');
      await jj(await post('/api/docs', { docId, type: 'markdown', sourceUrl: file }));
      const { thread } = await jj<{ thread: { id: string } }>(
        await post(`/api/docs/${docId}/threads`, {
          author: PERSON,
          text: CAPTURE,
          anchor: {
            kind: 'element',
            fingerprint: { tag: 'P', classes: [], text: 'the ranking clause', index: 0 },
            snippet: { text: 'the ranking clause' },
          },
        }),
      );
      const { task } = await jj<{ task: Task }>(
        await post(`/api/docs/${docId}/threads/${thread.id}/promote`, {
          workspaceId: wsId,
          assignee: 'Jordan',
          author: PERSON,
          goal: 'chores',
        }),
      );
      // The generator, not the author, produced "…dumped o…" on the real
      // board. A word-boundary clip is a prefix of the same prefix, so it can
      // only ever read better.
      expect(task.title.endsWith('…')).toBe(true);
      expect(task.title.length).toBeLessThanOrEqual(80);
      // The real assertion: what survives is a WHOLE-WORD prefix of the
      // capture. Checking "the char before the ellipsis is not a space" would
      // pass for any clip at all, mid-word ones included.
      const kept = task.title.slice(0, -1);
      expect(CAPTURE.startsWith(kept)).toBe(true);
      expect(CAPTURE[kept.length]).toBe(' ');
    });
  });

  // ── The "significant change" trigger ─────────────────────────────────────

  describe('a body that moves substantially makes the title stale', () => {
    it('a total rewrite through the DOC route (which skips update_task_body) trips it', async () => {
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      expect((await readTask(wsId, task.id)).titleGaps).toBeUndefined();

      expect((await rewriteViaDocRoute(task.id, BODY_TOTALLY_DIFFERENT)).ok).toBe(true);
      const after = await readTask(wsId, task.id);
      expect(after.titleGaps).toContain('stale-body');
      // The title itself is untouched — this is an advisory, not a rewrite.
      expect(after.title).toBe(GOOD_TITLE);
    });

    it('a trivial body edit does NOT trip it', async () => {
      // The positive control's mirror: without this, a trigger that fires on
      // every edit would pass the test above and be useless.
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      expect((await rewriteViaDocRoute(task.id, `${BODY_A}\n\nOne more note.`)).ok).toBe(true);
      expect((await readTask(wsId, task.id)).titleGaps).toBeUndefined();
    });

    it('changing the story line alone trips it, even when most words survive', async () => {
      // The clause word-drift cannot see: one line of five is replaced, so
      // total drift stays under the threshold — but the line replaced is the
      // user story, which is precisely what the title compresses.
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      const restated = BODY_A.replace(
        'Agents can rank a backlog by reading the goal order first so that the top of',
        'Reviewers can audit a backlog by opening one row so that the top of',
      );
      expect((await rewriteViaDocRoute(task.id, restated)).ok).toBe(true);
      expect((await readTask(wsId, task.id)).titleGaps).toContain('stale-body');
    });

    it('drift alone trips it — same story line, a rewritten remainder', async () => {
      // The clause the head check cannot see, and the one three surviving
      // mutations proved was untested: paragraph one is byte-identical, so
      // `titleHead` still matches and ONLY accumulated word drift can fire.
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      const sameHead = [
        'Agents can rank a backlog by reading the goal order first so that the top of',
        'the queue is the work that matters most.',
        '',
        'Visitors watching a shared board must never receive host-machine paths,',
        'and redaction strips every sidecar field before broadcast.',
      ].join('\n');
      expect((await rewriteViaDocRoute(task.id, sameHead)).ok).toBe(true);
      const after = await readTask(wsId, task.id);
      expect(after.titleGaps).toContain('stale-body');
      // Non-vacuity: the head really did NOT move, so this is drift talking.
      expect(
        after.body?.startsWith('Agents can rank a backlog by reading the goal order first'),
      ).toBe(true);
    });

    it('a substantial but unrelated body edit does NOT trip the drift clause', async () => {
      // The twin of the test above, and the specific misfire worth guarding:
      // an agent appends a whole implementation note for reasons that have
      // nothing to do with what the task IS. The title still describes it, so
      // the badge must stay off. Measured at 0.217 against a 0.3 threshold —
      // a real edit at ~72% of the budget, not a token one (that case is
      // covered separately by 'a trivial body edit does NOT trip it').
      //
      // Note this asserts about ONE such edit. Repeating it is supposed to
      // trip eventually — that is the accumulation the next test pins — so
      // this is a claim about proportion, not a promise of permanent silence.
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      const withNote = [
        BODY_A,
        '',
        'Note: the ordering already exists in the projection; this is a read path.',
      ].join('\n');
      expect((await rewriteViaDocRoute(task.id, withNote)).ok).toBe(true);
      const after = await readTask(wsId, task.id);
      expect(after.titleGaps).toBeUndefined();
      // Non-vacuity: the edit really did land, so the silence above is the
      // clause declining to fire rather than the rewrite never happening.
      expect(after.body).toContain('this is a read path');
    });

    it('drift accumulates across several small rewrites, none of which trips alone', async () => {
      // Why the number is accumulated rather than compared against a stored
      // copy of the body: no single one of these edits is significant, and
      // the row still ends up describing something else.
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      const tail = [
        'Done when: redaction strips every sidecar field before broadcast.',
        'Done when: a visitor never receives a host path in any payload.',
        'Done when: the audit log records who asked for the redaction.',
      ];
      let stale = false;
      for (const line of tail) {
        const next = [
          'Agents can rank a backlog by reading the goal order first so that the top of',
          'the queue is the work that matters most.',
          '',
          line,
        ].join('\n');
        expect((await rewriteViaDocRoute(task.id, next)).ok).toBe(true);
        stale = ((await readTask(wsId, task.id)).titleGaps ?? []).includes('stale-body');
      }
      expect(stale).toBe(true);
    });

    it('a rewrite through update_task_body that ALSO renames clears the staleness', async () => {
      // The `/body` door, which reaches the title through `noteBodyEdited`
      // rather than `renameTask` — a separate writer, and one a test aimed
      // only at `/title` leaves entirely uncovered.
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      await rewriteViaDocRoute(task.id, BODY_TOTALLY_DIFFERENT);
      expect((await readTask(wsId, task.id)).titleGaps).toContain('stale-body');

      const res = await jj<{ titleGaps?: string[] }>(
        await post(`/api/tasks/${task.id}/body`, {
          markdown: BODY_TOTALLY_DIFFERENT,
          title: 'Visitors can browse a shared board by loading only redacted rows',
          author: PERSON,
        }),
      );
      expect(res.titleGaps).toBeUndefined();
      expect((await readTask(wsId, task.id)).titleGaps).toBeUndefined();
    });

    it('a rewrite through update_task_body with NO new title stays stale', async () => {
      // The positive control for the case above — and the gate itself: this
      // is what tells a caller that shaping the body left the name behind.
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      const res = await jj<{ titleGaps?: string[] }>(
        await post(`/api/tasks/${task.id}/body`, {
          markdown: BODY_TOTALLY_DIFFERENT,
          author: PERSON,
        }),
      );
      expect(res.titleGaps).toContain('stale-body');
    });

    it('re-authoring the title clears the staleness', async () => {
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId);
      await rewriteViaDocRoute(task.id, BODY_TOTALLY_DIFFERENT);
      expect((await readTask(wsId, task.id)).titleGaps).toContain('stale-body');

      await post(`/api/tasks/${task.id}/title`, {
        title: 'Visitors can browse a shared board by loading only redacted rows',
        author: PERSON,
      });
      const after = await readTask(wsId, task.id);
      expect(after.titleGaps).toBeUndefined();
    });
  });

  // ── The board can see it ─────────────────────────────────────────────────

  describe('the advisory reaches the surface, not just the store', () => {
    it('the projected task row carries titleGaps so the board can render it', async () => {
      const wsId = await seedWorkspace();
      const { task } = await createTask(wsId, { title: OBSERVATION_TITLE });
      const row = await readTask(wsId, task.id);
      expect(row.titleGaps).toContain('no-persona');
    });
  });
});
