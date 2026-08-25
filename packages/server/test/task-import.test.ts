/**
 * Markdown tracker importer (plan §3.12 commit 10; §3.10 import_tasks_markdown).
 *
 * A hand-maintained tracker is "group headings + status tables" (§1 goal
 * 3b: adoption isn't re-keying). The importer maps headings → board goals
 * and table rows → tasks, with a DRY-RUN that returns the mapping first; a
 * successful apply stamps the source file with a banner + hub link so the
 * old tracker can't quietly stay a second source of truth.
 *
 * Golden-file test uses SYNTHETIC content only (§6, ultrareview 2026-08-13):
 * an invented farmers-market project in the jordan@partner.example register.
 * Never derive a fixture from a real tracker, events log, or task titles —
 * the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';
import {
  type ImportMapping,
  importBanner,
  importMarkerFor,
  normalizeTrackerStatus,
  parseTrackerMarkdown,
} from '../src/task-import.ts';
import type { Task, TaskStoreEvent, WorkspaceGoal } from '../src/tasks.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'tracker-harborlight.md');
const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const PUBLIC_HOST = 'feedback.example.com';
/** `g-` plus 12 base64url chars — the id the SERVER mints for a new band. */
const GENERATED = /^g-[A-Za-z0-9_-]{12}$/;

const emptyWorkspace = { goals: [] as WorkspaceGoal[] };

// ── Parser: the golden-file mapping ────────────────────────────────────────

describe('parseTrackerMarkdown (golden file)', () => {
  const markdown = readFileSync(FIXTURE, 'utf8');
  const mapping: ImportMapping = parseTrackerMarkdown(markdown, emptyWorkspace);

  it('maps group headings to new goals, in tracker order', () => {
    expect(mapping.goals).toEqual([
      {
        id: '1-launch-the-vendor-directory',
        title: '1. Launch the vendor directory',
        existing: false,
      },
      { id: '2-newsletter-signup', title: '2. Newsletter signup', existing: false },
    ]);
  });

  it('maps every titled row — the full golden mapping', () => {
    expect(mapping.tasks).toEqual([
      {
        title: 'Renew the harborlight.example domain',
        status: 'done',
        rawStatus: '✅',
        goalId: 'chores',
        line: 7,
      },
      {
        title: 'Draft the vendor listing page',
        status: 'done',
        rawStatus: 'Done',
        assignee: 'jordan',
        notes: 'Copy approved by the co-op board',
        goalId: '1-launch-the-vendor-directory',
        line: 13,
      },
      {
        title: 'Wire the map pins to stall numbers',
        status: 'in-progress',
        rawStatus: 'In progress',
        assignee: 'agent',
        goalId: '1-launch-the-vendor-directory',
        line: 14,
      },
      {
        title: 'Photograph the six anchor stalls',
        status: 'todo',
        assignee: 'jordan',
        notes: 'Waiting on a sunny Saturday',
        goalId: '1-launch-the-vendor-directory',
        line: 15,
      },
      {
        title: 'Pick an email provider',
        status: 'todo',
        rawStatus: 'Not started',
        goalId: '2-newsletter-signup',
        line: 22,
      },
      {
        title: 'Embed the signup form',
        status: 'in-progress',
        rawStatus: 'WIP',
        goalId: '2-newsletter-signup',
        line: 23,
      },
    ]);
  });

  it('reports what it did NOT import: empty-title rows, prose-only headings, unmapped columns', () => {
    expect(mapping.skipped).toEqual([
      { line: 16, reason: 'empty title' },
      { line: 25, reason: 'heading has no task table' },
    ]);
    expect(mapping.ignoredColumns).toEqual(['Due']);
  });

  it('a leading H1 is the document title, not a group — its table lands in Backlog', () => {
    // Covered by the golden mapping (line 7 → chores); this is the rule's
    // positive control from the other side: an H1 that is NOT leading IS a
    // group.
    const m = parseTrackerMarkdown(
      '# Setup\n\n| Task | Status |\n| --- | --- |\n| Order the stall banners | todo |\n',
      emptyWorkspace,
    );
    // First heading at the very top of the file: title. Its table → chores.
    expect(m.goals).toEqual([]);
    expect(m.tasks[0]?.goalId).toBe('chores');
    const m2 = parseTrackerMarkdown(
      'Intro line first.\n\n# Setup\n\n| Task | Status |\n| --- | --- |\n| Order the stall banners | todo |\n',
      emptyWorkspace,
    );
    expect(m2.goals).toEqual([{ id: 'setup', title: 'Setup', existing: false }]);
    expect(m2.tasks[0]?.goalId).toBe('setup');
  });

  it('matches an existing board goal by title, enumeration-insensitively', () => {
    const m = parseTrackerMarkdown(markdown, {
      goals: [{ id: 'g-vendor', title: 'Launch the vendor directory' }],
    });
    expect(m.goals[0]).toEqual({
      id: 'g-vendor',
      title: '1. Launch the vendor directory',
      existing: true,
    });
    // The other heading still maps to a NEW goal (positive control).
    expect(m.goals[1]?.existing).toBe(false);
  });

  // The collision is with the reserved ID, which is still `chores` — the band
  // is only LABELLED Backlog. So the heading that collides is still the word
  // "Chores", however the board spells the band today, and this test says so
  // in both directions.
  it("never mints the reserved 'chores' id for a heading named Chores", () => {
    const m = parseTrackerMarkdown(
      'Intro.\n\n# Chores\n\n| Task | Status |\n| --- | --- |\n| Sweep the stalls | todo |\n',
      emptyWorkspace,
    );
    expect(m.goals[0]?.id).not.toBe('chores');
    expect(m.goals[0]?.id).toBe('chores-2');
    expect(m.tasks[0]?.goalId).toBe('chores-2');
  });

  // …and the case the rename creates: now that the band READS "Backlog", a
  // hand-maintained tracker is likely to have a heading spelled that way. It
  // must become an ordinary band of its own, NOT be adopted into the reserved
  // bucket — a heading matching the current label is not a declaration that
  // the author meant the catch-all.
  it('a heading named Backlog becomes its own band, not the reserved bucket', () => {
    const m = parseTrackerMarkdown(
      'Intro.\n\n# Backlog\n\n| Task | Status |\n| --- | --- |\n| Sweep the stalls | todo |\n',
      emptyWorkspace,
    );
    expect(m.goals[0]?.id).toBe('backlog');
    expect(m.goals[0]?.id).not.toBe('chores');
    expect(m.tasks[0]?.goalId).toBe('backlog');
  });

  it('a table with no status column imports every row as todo', () => {
    const m = parseTrackerMarkdown(
      'Intro.\n\n## Errands\n\n| Task |\n| --- |\n| Print the vendor badges |\n',
      emptyWorkspace,
    );
    expect(m.tasks).toEqual([
      { title: 'Print the vendor badges', status: 'todo', goalId: 'errands', line: 7 },
    ]);
  });
});

// ── A layout table is not a task table ─────────────────────────────────────

/**
 * A prose tracker built out of BORDERLESS key/value tables imported silent
 * partial garbage: the key column ("State", "Size", "Blocking") became task
 * titles under a minted goal, so a reviewer skimming "1 goal, 3 tasks" read
 * a successful partial import. Importing nothing is legible as a failure;
 * importing three plausible rows is not.
 *
 * The tell was already in the response and thrown away — `ignoredColumns`
 * carried `[""]`, i.e. the parser noticed the header row was blank. A task
 * table names its first column; a table whose header cells are ALL empty is
 * being used for layout.
 *
 * Every assertion here that an import is EMPTY is paired with one that the
 * same parser still imports a real table, because a guard that swallows
 * everything would satisfy the empty half on its own.
 */
describe('parseTrackerMarkdown (layout tables)', () => {
  const LAYOUT = [
    '# Harborlight Market — build status',
    '',
    '## PR #48 — Vendor map',
    '',
    '|          |                                    |',
    '| -------- | ---------------------------------- |',
    '| State    | Merged 2026-05-02 (squash)         |',
    '| Size     | 9 commits, 22 files, +1,340 / -18  |',
    '| Blocking | Nothing — merged, not yet deployed |',
    '',
    'The map now renders every stall by aisle.',
    '',
  ].join('\n');

  it('imports nothing from a borderless key/value table', () => {
    const m = parseTrackerMarkdown(LAYOUT, emptyWorkspace);
    // The regression: these were tasks titled State / Size / Blocking.
    expect(m.tasks).toEqual([]);
    // And the heading above them minted a goal to hold them.
    expect(m.goals).toEqual([]);
  });

  it('says the table was layout, not merely that the heading had no table', () => {
    const m = parseTrackerMarkdown(LAYOUT, emptyWorkspace);
    const reasons = m.skipped.map((s) => s.reason);
    // Distinguishable from 'heading has no task table' — a dry-run has to say
    // WHICH of the two happened, or "no tasks" is unactionable.
    expect(reasons.some((r) => /layout/i.test(r))).toBe(true);
    // Anchored to the table itself, not to the heading four lines up.
    const layoutSkip = m.skipped.find((s) => /layout/i.test(s.reason));
    expect(layoutSkip?.line).toBe(5);
  });

  it('warns when a file with content yields no tasks at all', () => {
    const m = parseTrackerMarkdown(LAYOUT, emptyWorkspace);
    expect(m.warnings.length).toBeGreaterThan(0);
    expect(m.warnings.join(' ')).toMatch(/no tasks/i);
  });

  // ── Positive controls: the guard must not be a blanket refusal ──────────

  it('still imports a real task table (the guard is not over-broad)', () => {
    const ok = [
      '# Harborlight Market',
      '',
      '## Stall setup',
      '',
      '| Task              | Status | Owner  |',
      '| ----------------- | ------ | ------ |',
      '| Chalk the aisles  | done   | Jordan |',
      '| Hang the banner   | todo   | Sam    |',
      '',
    ].join('\n');
    const m = parseTrackerMarkdown(ok, emptyWorkspace);
    expect(m.tasks.map((t) => t.title)).toEqual(['Chalk the aisles', 'Hang the banner']);
    expect(m.warnings).toEqual([]);
  });

  it('a SOME-blank header is still a task table — only an all-blank one is layout', () => {
    // One unnamed column next to named ones is ordinary markdown, not layout.
    const partial = [
      '## Stall setup',
      '',
      '| Task             |   | Status |',
      '| ---------------- | - | ------ |',
      '| Chalk the aisles | ✳ | done   |',
      '',
    ].join('\n');
    const m = parseTrackerMarkdown(partial, emptyWorkspace);
    expect(m.tasks.map((t) => t.title)).toEqual(['Chalk the aisles']);
  });

  it('a layout table does not consume the real table that follows it', () => {
    const both = [
      '## PR #48 — Vendor map',
      '',
      '|       |                    |',
      '| ----- | ------------------ |',
      '| State | Merged 2026-05-02  |',
      '',
      '| Task            | Status |',
      '| --------------- | ------ |',
      '| Print the badges| todo   |',
      '',
    ].join('\n');
    const m = parseTrackerMarkdown(both, emptyWorkspace);
    expect(m.tasks.map((t) => t.title)).toEqual(['Print the badges']);
    expect(m.warnings).toEqual([]);
  });
});

describe('normalizeTrackerStatus', () => {
  it('normalizes the hand-maintained vocabulary', () => {
    expect(normalizeTrackerStatus('Done')).toBe('done');
    expect(normalizeTrackerStatus('✅')).toBe('done');
    expect(normalizeTrackerStatus('shipped')).toBe('done');
    expect(normalizeTrackerStatus('x')).toBe('done');
    expect(normalizeTrackerStatus('In progress')).toBe('in-progress');
    expect(normalizeTrackerStatus('in-progress')).toBe('in-progress');
    expect(normalizeTrackerStatus('WIP')).toBe('in-progress');
    expect(normalizeTrackerStatus('doing')).toBe('in-progress');
    // "not started" contains "started" — it must stay todo.
    expect(normalizeTrackerStatus('Not started')).toBe('todo');
    expect(normalizeTrackerStatus('todo')).toBe('todo');
    expect(normalizeTrackerStatus('blocked')).toBe('todo');
    expect(normalizeTrackerStatus('')).toBe('todo');
    expect(normalizeTrackerStatus(undefined)).toBe('todo');
  });
});

describe('import banner + marker', () => {
  it('the banner round-trips through the marker detector', () => {
    const banner = importBanner({
      workspaceId: 'w-abc123',
      hubUrl: 'http://mac.example:8787/workspaces/w-abc123',
      taskCount: 6,
      ts: Date.parse('2026-08-13T12:00:00Z'),
    });
    expect(importMarkerFor(banner)).toBe('w-abc123');
    expect(banner).toContain('http://mac.example:8787/workspaces/w-abc123');
    // Prepending to a tracker keeps the marker detectable (positive control
    // for every "unstamped file has no marker" check below).
    expect(importMarkerFor(`${banner}# Tracker\n`)).toBe('w-abc123');
    expect(importMarkerFor('# Tracker\n')).toBeNull();
  });
});

// ── The real route: POST /api/workspaces/:id/import-tasks ──────────────────

describe('import route (dry-run first, apply stamps the file)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let seq = 0;

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
      await post('/api/workspaces', { name: 'harborlight', goal: 'Refresh the market site.' }),
    );
    return workspace.id;
  }

  /** A private copy of the fixture — apply stamps the file it imports. */
  function trackerCopy(): string {
    const path = join(dataDir, `tracker-${seq++}.md`);
    writeFileSync(path, readFileSync(FIXTURE, 'utf8'));
    return path;
  }

  async function getTasks(workspaceId: string): Promise<Task[]> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    return tasks;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-import-'));
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('dry-run (the default) returns the mapping and creates NOTHING', async () => {
    const workspaceId = await seedWorkspace();
    const path = trackerCopy();
    const res = await jj<{ dryRun: boolean; mapping: ImportMapping }>(
      await post(`/api/workspaces/${workspaceId}/import-tasks`, { path, author: PERSON }),
    );
    expect(res.dryRun).toBe(true);
    expect(res.mapping.tasks).toHaveLength(6);
    expect(res.mapping.goals).toHaveLength(2);
    // Every mapped goal here is NEW, so its id is a parse-local placeholder
    // that keys rows to their heading — not a board id, and not the id the
    // apply will mint. Nothing that reads a board may be pointed at it.
    expect(res.mapping.goals.every((g) => !g.existing)).toBe(true);
    expect(res.mapping.goals.some((g) => GENERATED.test(g.id))).toBe(false);
    // Nothing created, file untouched (the absence half — apply below is the
    // positive control that this route CAN create and stamp).
    expect(await getTasks(workspaceId)).toHaveLength(0);
    expect(importMarkerFor(readFileSync(path, 'utf8'))).toBeNull();
  });

  it('apply creates goals + tasks with statuses, attributed to the author', async () => {
    const workspaceId = await seedWorkspace();
    const path = trackerCopy();
    const events: TaskStoreEvent[] = [];
    const unsubscribe = handle.tasks.onEvent((e) => {
      if (e.workspaceId === workspaceId) events.push(e);
    });
    const res = await jj<{
      ok: boolean;
      hubUrl: string;
      goalsCreated: Array<{ id: string; title: string }>;
      tasksCreated: Array<{ id: string; title: string; goal: string; status: string }>;
    }>(
      await post(`/api/workspaces/${workspaceId}/import-tasks`, {
        path,
        apply: true,
        author: PERSON,
      }),
    );
    unsubscribe();
    expect(res.ok).toBe(true);
    // The ids are the server's to mint, so what the import owes the caller is
    // the band it CREATED for each heading, in tracker order — an opaque id,
    // never a slug derived from the heading.
    expect(res.goalsCreated.map((g) => g.title)).toEqual([
      '1. Launch the vendor directory',
      '2. Newsletter signup',
    ]);
    for (const g of res.goalsCreated) expect(g.id).toMatch(GENERATED);
    expect(res.tasksCreated).toHaveLength(6);
    expect(res.hubUrl).toContain(`/workspaces/${workspaceId}`);

    // The board goals actually exist on the workspace — the reported ids are
    // the board's ids, which is the whole claim `goalsCreated` makes.
    const { workspace } = await jj<{ workspace: { goals: WorkspaceGoal[] } }>(
      await fetch(`${base}/api/workspaces/${workspaceId}`),
    );
    expect(workspace.goals.map((g) => g.id)).toEqual(res.goalsCreated.map((g) => g.id));
    expect(workspace.goals.map((g) => g.title)).toEqual([
      '1. Launch the vendor directory',
      '2. Newsletter signup',
    ]);

    // Tasks landed with normalized statuses; imported statuses went through
    // the one transition gate, attributed to the importing author.
    const tasks = await getTasks(workspaceId);
    expect(tasks).toHaveLength(6);
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    const done = byTitle.get('Draft the vendor listing page');
    expect(done?.status).toBe('done');
    // The row landed in the band its heading created — asserted as the
    // relationship, since neither side's id is knowable in advance.
    expect(done?.goal).toBe(res.goalsCreated[0]?.id);
    expect(byTitle.get('Pick an email provider')?.goal).toBe(res.goalsCreated[1]?.id);
    expect(done?.assignee).toBe('jordan');
    expect(done?.body).toBe('Copy approved by the co-op board');
    expect(done?.transitions).toHaveLength(1);
    expect(done?.transitions[0]?.by).toEqual({ id: PERSON.id, name: PERSON.name, kind: 'person' });
    expect(byTitle.get('Renew the harborlight.example domain')?.goal).toBe('chores');
    expect(byTitle.get('Wire the map pins to stall numbers')?.status).toBe('in-progress');
    expect(byTitle.get('Photograph the six anchor stalls')?.status).toBe('todo');
    expect(byTitle.get('Photograph the six anchor stalls')?.transitions).toHaveLength(0);

    // Explicit placement: imported rows are placements by the tracker, so no
    // task comes back marked unplaced.
    expect(tasks.every((t) => t.unplacedSince === undefined)).toBe(true);

    // Events fired for everything: 6 created, 4 imported statuses, 1 goal-list
    // change — the audit trail shows the import as it happened.
    expect(events.filter((e) => e.type === 'task.created')).toHaveLength(6);
    expect(events.filter((e) => e.type === 'task.transitioned')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'workspace.goals_changed')).toHaveLength(1);

    // The source file is stamped: banner + hub link + marker, original below.
    const stamped = readFileSync(path, 'utf8');
    expect(importMarkerFor(stamped)).toBe(workspaceId);
    expect(stamped).toContain(`/workspaces/${workspaceId}`);
    expect(stamped).toContain('# Harborlight Market — site tracker');
  });

  it('a stamped file refuses re-import (409) and dry-run says why', async () => {
    const workspaceId = await seedWorkspace();
    const path = trackerCopy();
    await jj(
      await post(`/api/workspaces/${workspaceId}/import-tasks`, {
        path,
        apply: true,
        author: PERSON,
      }),
    );
    const again = await post(`/api/workspaces/${workspaceId}/import-tasks`, {
      path,
      apply: true,
      author: PERSON,
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('already-imported');
    // Still 6 tasks — the refusal actually protected the board.
    expect(await getTasks(workspaceId)).toHaveLength(6);

    const dry = await jj<{ dryRun: boolean; alreadyImported?: string }>(
      await post(`/api/workspaces/${workspaceId}/import-tasks`, { path, author: PERSON }),
    );
    expect(dry.alreadyImported).toBe(workspaceId);
  });

  it('importing into a workspace with existing goals appends, never clobbers', async () => {
    const workspaceId = await seedWorkspace();
    const G = await seedGoalsOverHttp(
      base,
      workspaceId,
      [{ key: 'vendor', title: 'Launch the vendor directory' }],
      PERSON,
    );
    const path = trackerCopy();
    const res = await jj<{
      goalsCreated: Array<{ id: string; title: string }>;
      tasksCreated: Array<{ id: string; goal: string; title: string }>;
    }>(
      await post(`/api/workspaces/${workspaceId}/import-tasks`, {
        path,
        apply: true,
        author: PERSON,
      }),
    );
    // The matched heading reuses the existing goal; only the other is created.
    expect(res.goalsCreated.map((g) => g.title)).toEqual(['2. Newsletter signup']);
    expect(res.goalsCreated[0]?.id).toMatch(GENERATED);
    const { workspace } = await jj<{ workspace: { goals: WorkspaceGoal[] } }>(
      await fetch(`${base}/api/workspaces/${workspaceId}`),
    );
    expect(workspace.goals.map((g) => g.id)).toEqual([G.vendor, res.goalsCreated[0]?.id]);
    // The matched heading's rows went to the goal that was already there —
    // untouched by the mint, which is the "appends, never clobbers" half.
    expect(res.tasksCreated.find((t) => t.title === 'Draft the vendor listing page')?.goal).toBe(
      G.vendor,
    );
    expect(res.tasksCreated.find((t) => t.title === 'Pick an email provider')?.goal).toBe(
      res.goalsCreated[0]?.id,
    );
  });

  it('stamping a tracker that is bound as a live doc reaches the live doc too', async () => {
    const workspaceId = await seedWorkspace();
    const path = trackerCopy();
    const docId = `tracker-doc-${seq}`;
    await jj(await post('/api/docs', { docId, type: 'markdown', sourceUrl: path }));
    // Positive control: the live doc has the tracker but no banner yet.
    const before = await jj<{ plainText: string }>(
      await fetch(`${base}/api/docs/${docId}/content`),
    );
    expect(before.plainText).toContain('Harborlight Market');
    expect(before.plainText).not.toContain('Imported into');

    await jj(
      await post(`/api/workspaces/${workspaceId}/import-tasks`, {
        path,
        apply: true,
        author: PERSON,
      }),
    );
    const after = await jj<{ plainText: string }>(await fetch(`${base}/api/docs/${docId}/content`));
    expect(after.plainText).toContain('Imported into');
  });

  it('validates: missing path, missing author, unknown workspace, missing file', async () => {
    const workspaceId = await seedWorkspace();
    const path = trackerCopy();
    expect(
      (await post(`/api/workspaces/${workspaceId}/import-tasks`, { author: PERSON })).status,
    ).toBe(400);
    expect((await post(`/api/workspaces/${workspaceId}/import-tasks`, { path })).status).toBe(400);
    expect((await post('/api/workspaces/nope/import-tasks', { path, author: PERSON })).status).toBe(
      404,
    );
    expect(
      (
        await post(`/api/workspaces/${workspaceId}/import-tasks`, {
          path: join(dataDir, 'no-such-tracker.md'),
          author: PERSON,
        })
      ).status,
    ).toBe(404);
  });

  it('a hub-share visitor cannot import (403), though the hub page serves them (presence)', async () => {
    const workspaceId = await seedWorkspace();
    const path = trackerCopy();
    const { share } = await jj<{ share: { slug: string } }>(
      await post('/api/share/link', { workspaceId, label: 'hub share' }),
    );
    const redeem = await fetch(`${base}/s/${share.slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    expect(redeem.status).toBe(302);
    const cookie = (redeem.headers.get('set-cookie') ?? '').match(
      new RegExp(`${SHARE_COOKIE}=([^;]+)`),
    )?.[1];
    expect(cookie).toBeTruthy();
    const visitorHeaders = {
      host: PUBLIC_HOST,
      cookie: `${SHARE_COOKIE}=${cookie}`,
      'content-type': 'application/json',
    };
    // Presence: the visitor's cookie DOES reach the hub page.
    const page = await fetch(`${base}/workspaces/${workspaceId}`, { headers: visitorHeaders });
    expect(page.status).toBe(200);
    // Absence: the same credentials cannot import.
    const denied = await fetch(`${base}/api/workspaces/${workspaceId}/import-tasks`, {
      method: 'POST',
      headers: visitorHeaders,
      body: JSON.stringify({ path, apply: true, author: PERSON }),
    });
    expect(denied.status).toBe(403);
    expect(await getTasks(workspaceId)).toHaveLength(0);
  });
});
