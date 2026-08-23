/**
 * Markdown tracker importer (plan §3.12 commit 10; §3.10
 * `import_tasks_markdown`; §1 goal 3b "adoption isn't re-keying").
 *
 * A hand-maintained tracker is **group headings + status tables**. This
 * module is the pure half: parse the tracker into an explicit MAPPING
 * (headings → board goals, table rows → tasks with normalized status), and
 * apply a mapping to a TaskStore. The route owns file I/O and stamping.
 *
 * The mapping IS the dry-run result — the §3.10 convention (dry-run on
 * anything destructive-ish) applied to import: the caller sees exactly what
 * would be created, including what was SKIPPED and which columns were
 * ignored, before anything happens.
 *
 * Deliberate scope (the plan names exactly this shape, twice): headings +
 * tables. Checkbox lists, nested outlines, and date columns are not
 * imported — and the mapping says so (`skipped`, `ignoredColumns`) rather
 * than silently dropping them.
 */
import { resolveAssignee } from './task-owner.ts';
import {
  CHORES_GOAL_ID,
  type Task,
  type TaskStatus,
  type TaskStore,
  type WorkspaceGoal,
  isGoalRow,
} from './tasks.ts';

// ── Banner + marker ────────────────────────────────────────────────────────

const MARKER_RE = /<!--\s*imported-to-workspace-hub:\s*([^\s>]+)/;

/** The workspaceId a previous import stamped into this file, or null.
 *  A stamped file refuses re-import — the banner is both the human notice
 *  and the machine-readable "this tracker already moved" marker. */
export function importMarkerFor(markdown: string): string | null {
  return markdown.match(MARKER_RE)?.[1] ?? null;
}

/**
 * The banner a successful import prepends to the source file (§3.10: "a
 * successful import stamps the source file with a banner + hub link, so the
 * old tracker can't quietly stay a second source of truth").
 */
export function importBanner(opts: {
  workspaceId: string;
  hubUrl: string;
  taskCount: number;
  ts: number;
}): string {
  const date = new Date(opts.ts).toISOString().slice(0, 10);
  return (
    `> **Imported into the Workspace Hub** on ${date} — ` +
    `${opts.taskCount} task${opts.taskCount === 1 ? '' : 's'} now live at ` +
    `${opts.hubUrl} — this file is no longer the source of truth; edits here are not tracked.\n` +
    `<!-- imported-to-workspace-hub: ${opts.workspaceId} ts=${opts.ts} -->\n\n`
  );
}

// ── Status vocabulary ──────────────────────────────────────────────────────

/**
 * Normalize a hand-written status cell to the three real statuses. Matching
 * is EXACT against small vocabularies (plus an `in progress` substring),
 * never contains — "Not started" contains "started" and must stay todo.
 * Anything unrecognized (including "blocked" — that's a dependency, not a
 * status, §3.3) lands as todo: the one-directional failure mode is a task
 * you re-mark, never a task imported as more finished than it is.
 */
export function normalizeTrackerStatus(raw: string | undefined): TaskStatus {
  if (!raw) return 'todo';
  const s = raw.trim().toLowerCase();
  if (/^(done|complete|completed|shipped|finished|closed|✅|✔️|✔|✓|x|\[x\])$/.test(s)) {
    return 'done';
  }
  if (/in.?progress/.test(s) || /^(wip|doing|started|active|underway|🔄|⏳)$/.test(s)) {
    return 'in-progress';
  }
  return 'todo';
}

// ── Mapping types ──────────────────────────────────────────────────────────

export interface ImportGoalMapping {
  /**
   * Existing board-goal id when the heading matched one (`existing: true`).
   * Otherwise a PARSE-LOCAL PLACEHOLDER — readable, and deliberately not the
   * id the goal will get: ids are minted by the store at apply time
   * (`newGoalId`), so a dry run cannot know one and must not pretend to.
   * `applyImport` maps each placeholder to the minted id before creating a
   * single task. Sending a placeholder to `set_goal_list` is refused as
   * `unknown-goal-id`, which is the right answer to "create this id for me".
   */
  id: string;
  /** The heading text, verbatim. */
  title: string;
  existing: boolean;
}

export interface ImportTaskMapping {
  title: string;
  status: TaskStatus;
  /** The status cell verbatim — so the dry-run shows what was normalized. */
  rawStatus?: string;
  assignee?: string;
  /** The notes cell — becomes the task body. */
  notes?: string;
  /** Target goal id (`chores` for rows before any group heading). */
  goalId: string;
  /** 1-based source line, so a human can check the mapping against the file. */
  line: number;
}

export interface ImportSkip {
  line: number;
  reason: string;
}

export interface ImportMapping {
  goals: ImportGoalMapping[];
  tasks: ImportTaskMapping[];
  /** What the parser saw and did NOT import, with the line it saw it on. */
  skipped: ImportSkip[];
  /** Table column headers with no mapping (e.g. a Due column) — reported so
   *  dropped data is a visible decision, not a silent loss. */
  ignoredColumns: string[];
  /**
   * File-level things a reader must not miss, in plain sentences.
   *
   * `skipped` is per-line and reads as detail; a caller scanning a dry-run
   * for "did this work" looks at `tasks` and stops. When the answer is "this
   * file produced nothing", that has to be stated, not inferred from an empty
   * array — an empty list is exactly what a clean import of an empty file
   * looks like too.
   */
  warnings: string[];
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** Slug for a new goal id: lowercase, non-alphanumeric runs → '-'. */
export function goalSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'goal'
  );
}

/** Title comparison key: enumeration- and case-insensitive, so a tracker's
 *  "1. Launch the directory" matches a board goal "Launch the directory". */
function titleKey(title: string): string {
  return title
    .trim()
    .replace(/^\d+[.):]?\s*/, '')
    .toLowerCase();
}

function splitRow(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  // A markdown table row is `| a | b |` — the split yields empty first/last.
  if (cells[0] === '') cells.shift();
  if (cells[cells.length - 1] === '') cells.pop();
  return cells;
}

const isTableLine = (line: string) => /^\s*\|/.test(line);
const isSeparatorLine = (line: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-');

const TITLE_HEADER = /^(task|title|item|work)$/i;
const STATUS_HEADER = /^(status|state|progress)$/i;
const ASSIGNEE_HEADER = /^(assignee|owner|who)$/i;
const NOTES_HEADER = /^(notes?|details?|comments?)$/i;

/**
 * Parse a hand-maintained tracker into an import mapping against the given
 * workspace's current board goals. Pure — reads nothing, writes nothing.
 *
 * Rules, stated so the dry-run is predictable:
 *  - A level-1 heading at the very top of the file is the document TITLE,
 *    not a group (the near-universal tracker convention); every other
 *    heading (levels 1–4) starts a group.
 *  - Rows before any group heading land in Backlog.
 *  - A heading whose section contains no table rows is reported in
 *    `skipped`, never turned into an empty goal.
 *  - Headings match existing board goals by title (enumeration- and
 *    case-insensitive); otherwise a new goal is minted with a slug id that
 *    never collides with existing ids or the reserved `chores`.
 */
export function parseTrackerMarkdown(
  markdown: string,
  workspace: Pick<{ goals: WorkspaceGoal[] }, 'goals'>,
): ImportMapping {
  const lines = markdown.split('\n');

  const existingByTitle = new Map<string, string>();
  const takenIds = new Set<string>([CHORES_GOAL_ID]);
  for (const g of workspace.goals) {
    existingByTitle.set(titleKey(g.title), g.id);
    takenIds.add(g.id);
    for (const s of g.subgoals ?? []) {
      existingByTitle.set(titleKey(s.title), s.id);
      takenIds.add(s.id);
    }
  }

  const goals: ImportGoalMapping[] = [];
  const tasks: ImportTaskMapping[] = [];
  const skipped: ImportSkip[] = [];
  const ignoredColumns: string[] = [];

  /** The group the parser is inside, or null (→ chores). Created lazily on
   *  the first task row so prose-only headings never become goals. */
  let pending: { title: string; line: number } | null = null;
  let currentGoalId: string = CHORES_GOAL_ID;
  let sawContent = false; // anything (even prose) before a heading?

  const freshId = (title: string): string => {
    const base = goalSlug(title);
    let id = base;
    for (let n = 2; takenIds.has(id); n++) id = `${base}-${n}`;
    takenIds.add(id);
    return id;
  };

  const enterGoal = (): string => {
    if (pending === null) return currentGoalId;
    const existing = existingByTitle.get(titleKey(pending.title));
    if (existing !== undefined) {
      goals.push({ id: existing, title: pending.title, existing: true });
      currentGoalId = existing;
    } else {
      const id = freshId(pending.title);
      goals.push({ id, title: pending.title, existing: false });
      currentGoalId = id;
    }
    pending = null;
    return currentGoalId;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const heading = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      // Close out a group that never produced a task row.
      if (pending !== null)
        skipped.push({ line: pending.line, reason: 'heading has no task table' });
      const title = (heading[2] ?? '').trim();
      if (!sawContent && heading[1] === '#') {
        // Leading H1 = the document's own title; what follows is ungrouped.
        pending = null;
        currentGoalId = CHORES_GOAL_ID;
      } else {
        pending = { title, line: i + 1 };
      }
      sawContent = true;
      i++;
      continue;
    }
    if (
      isTableLine(line) &&
      isTableLine(lines[i + 1] ?? '') &&
      isSeparatorLine(lines[i + 1] ?? '')
    ) {
      sawContent = true;
      const header = splitRow(line);
      /**
       * A table whose header cells are ALL blank is being used for LAYOUT —
       * the borderless key/value block people write to lay out a summary:
       *
       *   |          |                            |
       *   | -------- | -------------------------- |
       *   | State    | Merged 2026-05-02          |
       *
       * Parsed as a task table it yields tasks called "State"/"Size"/
       * "Blocking" under a minted goal, which reads as a successful partial
       * import rather than as a failure. A task table names its first
       * column; ALL-blank is the signal, never SOME-blank — one unnamed
       * column beside named ones is ordinary markdown and still imports.
       */
      if (header.every((h) => h === '')) {
        skipped.push({
          line: i + 1,
          reason: 'table has a blank header row — read as layout, not tasks',
        });
        i += 2; // past header + separator
        while (i < lines.length && isTableLine(lines[i] ?? '')) i++;
        continue;
      }
      const findCol = (re: RegExp) => {
        const idx = header.findIndex((h) => re.test(h));
        return idx === -1 ? undefined : idx;
      };
      const statusCol = findCol(STATUS_HEADER);
      const assigneeCol = findCol(ASSIGNEE_HEADER);
      const notesCol = findCol(NOTES_HEADER);
      const special = new Set([statusCol, assigneeCol, notesCol]);
      let titleCol = findCol(TITLE_HEADER);
      if (titleCol === undefined) titleCol = header.findIndex((_, idx) => !special.has(idx));
      if (titleCol === -1) titleCol = 0;
      for (const [idx, name] of header.entries()) {
        if (idx !== titleCol && !special.has(idx) && !ignoredColumns.includes(name)) {
          ignoredColumns.push(name);
        }
      }
      i += 2; // past header + separator
      while (i < lines.length && isTableLine(lines[i] ?? '')) {
        const rowLine = i + 1;
        const cells = splitRow(lines[i] ?? '');
        const title = cells[titleCol] ?? '';
        if (title === '') {
          skipped.push({ line: rowLine, reason: 'empty title' });
          i++;
          continue;
        }
        const goalId = enterGoal();
        const rawStatus = statusCol !== undefined ? cells[statusCol] : undefined;
        const assignee = assigneeCol !== undefined ? cells[assigneeCol] : undefined;
        const notes = notesCol !== undefined ? cells[notesCol] : undefined;
        tasks.push({
          title,
          status: normalizeTrackerStatus(rawStatus),
          ...(rawStatus ? { rawStatus } : {}),
          ...(assignee ? { assignee } : {}),
          ...(notes ? { notes } : {}),
          goalId,
          line: rowLine,
        });
        i++;
      }
      continue;
    }
    if (line.trim() !== '') sawContent = true;
    i++;
  }
  if (pending !== null) skipped.push({ line: pending.line, reason: 'heading has no task table' });

  // "Nothing was imported" has to be said out loud. An empty `tasks` is also
  // what a clean run over an empty file returns, so the caller cannot tell
  // the two apart — and the expensive mistake is reading a failed import as
  // a successful one. Only fires when the file HAD content to work with.
  const warnings: string[] = [];
  if (tasks.length === 0 && sawContent) {
    const layoutTables = skipped.filter((s) => s.reason.includes('layout')).length;
    const bareHeadings = skipped.filter((s) => s.reason === 'heading has no task table').length;
    const because = [
      bareHeadings > 0 ? `${bareHeadings} heading(s) had no task table` : '',
      layoutTables > 0 ? `${layoutTables} table(s) were layout, not tasks` : '',
    ].filter(Boolean);
    warnings.push(
      `No tasks were imported from this file${because.length ? `: ${because.join('; ')}` : ''}.`,
    );
  }

  return { goals, tasks, skipped, ignoredColumns, warnings };
}

// ── Applying a mapping ─────────────────────────────────────────────────────

export interface ApplyImportResult {
  ok: true;
  goalsCreated: Array<{ id: string; title: string }>;
  tasksCreated: Array<{ id: string; title: string; goal: string; status: TaskStatus }>;
  /** Rows the store refused — should be empty (the parser validates), but a
   *  refusal is reported, never swallowed. */
  failures: Array<{ title: string; error: string }>;
}

/**
 * Apply a parsed mapping to the store: append the new goals to the board
 * (existing goals are matched, NEVER replaced or reordered), create every
 * task with an EXPLICIT goal (an import is a placement by the tracker's
 * author, not a triage candidate — no triage request fires, §3.4), and walk
 * imported statuses through the one transition gate so the audit trail
 * shows the import as attributed transitions.
 */
export function applyImport(
  store: TaskStore,
  workspaceId: string,
  mapping: ImportMapping,
  opts: { actor: { id: string; name: string; kind?: string } },
): ApplyImportResult | { ok: false; error: 'workspace-not-found' | 'goal-list-rejected' } {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return { ok: false, error: 'workspace-not-found' };

  const newGoals = mapping.goals.filter((g) => !g.existing);
  // A new goal's id is the SERVER's to mint, so the entries go in without one
  // and the real ids come back in `created`, in submission order. The
  // parser's ids for new goals are parse-local placeholders that key task
  // rows to their heading and never reach the board — which is why every row
  // below is re-pointed through `mintedId` before a task is created.
  const mintedId = new Map<string, string>();
  if (newGoals.length > 0) {
    const res = store.setGoalList(
      workspaceId,
      [...workspace.goals, ...newGoals.map((g) => ({ title: g.title }))],
      { actor: opts.actor },
    );
    if (!res.ok) return { ok: false, error: 'goal-list-rejected' };
    if (res.created.length !== newGoals.length) return { ok: false, error: 'goal-list-rejected' };
    newGoals.forEach((g, i) => {
      const row = res.created[i];
      if (row) mintedId.set(g.id, row.id);
    });
  }

  const goalsCreated = newGoals.map((g) => ({
    id: mintedId.get(g.id) ?? g.id,
    title: g.title,
  }));
  const tasksCreated: ApplyImportResult['tasksCreated'] = [];
  const failures: ApplyImportResult['failures'] = [];
  for (const row of mapping.tasks) {
    const created = store.createTask(workspaceId, {
      title: row.title,
      goal: mintedId.get(row.goalId) ?? row.goalId,
      // A row that names nobody belongs to whoever ran the import — the
      // tracker's owner column is often blank, and "agent" is not an owner.
      assignee: resolveAssignee(row.assignee, opts.actor) ?? opts.actor.name,
      ...(row.notes !== undefined ? { body: row.notes } : {}),
      actor: opts.actor,
    });
    if (!created.ok) {
      failures.push({ title: row.title, error: created.error });
      continue;
    }
    let task: Task = created.task;
    if (row.status !== 'todo') {
      const moved = store.transition(task.id, row.status, {
        actor: opts.actor,
        note: `status imported from markdown tracker (${row.rawStatus ?? row.status})`,
      });
      // The gate can move a goal row too, so its result is a BoardRow. The id
      // here came from a task this loop just created, so the guard states that
      // to the type system rather than asserting it with a cast.
      if (moved.ok && !isGoalRow(moved.task)) task = moved.task;
      else if (!moved.ok) failures.push({ title: row.title, error: `transition: ${moved.error}` });
    }
    tasksCreated.push({ id: task.id, title: task.title, goal: task.goal, status: task.status });
  }
  return { ok: true, goalsCreated, tasksCreated, failures };
}
