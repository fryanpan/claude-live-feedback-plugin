/**
 * The Home page's "Recent activity" pane, as a pure view model: which tasks
 * moved lately, what their agents said, and the one flag a group may wear.
 * Computed from the board projection alone — no DOM, no fetch — so the
 * grouping, ordering, caps and flag rules are unit-testable without a
 * browser. Sits beside `hub-model.ts` rather than in it because that file is
 * already the size of a small country.
 *
 * Grouped BY TASK, never by agent (Bryan, 2026-08-29, on the mock): the
 * question the pane answers is "what is happening to the work", and an
 * agent's name is a detail on each line, not a heading.
 */
import {
  CHORES_ID,
  type HubGoal,
  type HubNote,
  type HubTask,
  type TaskStatus,
  goalRank,
  isTaskArchived,
  timeAgo,
} from './hub-model.ts';

/** Only movement inside this window is activity; a task quiet for longer
 *  than a day is not "recent" whatever it did before. */
export const ACTIVITY_WINDOW_MS = 24 * 60 * 60_000;
/** How many task groups the pane shows — the newest eight, never a scroll. */
export const ACTIVITY_GROUP_CAP = 8;
/** Lines shown per group before the muted "+N more". */
export const ACTIVITY_NOTE_CAP = 3;
/** An in-progress task nobody has said anything about for this long is
 *  `dark` — the keep-moving protocol's stall, keyed on the task's own
 *  evidence (notes and transitions), never on the wall clock alone. */
export const DARK_AFTER_MS = 45 * 60_000;
/** The newest note text repeated this many times in a row reads as `stale`:
 *  the agent is reporting the same wait turn after turn. */
export const STALE_REPEATS = 3;

/**
 * The one badge a group may wear. `dark` beats `stale` beats `off-band`
 * when more than one applies: a stalled in-progress task is the thing to
 * look at first, a repeating one second, and where a task sits is the least
 * urgent of the three.
 */
export type ActivityFlag = 'off-band' | 'stale' | 'dark';

/** `move` is a status transition rendered as a line, so a task with no turn
 *  notes still shows its movement. */
export type ActivityNoteKind = HubNote['kind'] | 'move';

export interface ActivityNote {
  at: number;
  /** Bare age — "4m", "2h" — the line's own clock, from `timeAgo`. */
  age: string;
  /** What the line says: the note verbatim, "blocked: <shape>" for a denial,
   *  "→ <status>" or "handed to <holder>" for a move. */
  text: string;
  /** Who — the note's agent, or the actor who made the move. */
  agent?: string;
  kind: ActivityNoteKind;
}

export interface ActivityGroup {
  taskId: string;
  title: string;
  status: TaskStatus;
  flag?: ActivityFlag;
  /** Newest first, at most `ACTIVITY_NOTE_CAP`. */
  notes: ActivityNote[];
  /** How many more lines fell inside the window but off the cap. */
  more: number;
}

export interface ActivityInput {
  tasks: HubTask[];
  goals: HubGoal[];
  /**
   * The review queue's rows, reduced to the task each is about and its ask
   * text. The queue above the pane already shows every open ask; a note that
   * repeats one verbatim is dropped here so the page never says the same
   * thing twice. The TASK stays — the queue shows asks, the pane shows work.
   */
  asks?: ReadonlyArray<{ taskId: string; text: string }>;
  now: number;
}

/** "4m" / "2h" — `timeAgo` without its " ago", so the line and the presence
 *  strip can never disagree about a unit boundary. */
export function ageShort(at: number, now: number): string {
  return timeAgo(at, now).replace(/ ago$/, '');
}

/** The comparison key for "the same text": trimmed, whitespace-collapsed,
 *  case-folded. An agent re-posting its wait with a stray space or a capital
 *  is still repeating itself. */
function sameText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Every line one task contributes, in no particular order: its notes as
 * they are, denials prefixed, and each transition rendered as a move. A
 * transition that put the task into progress under somebody other than the
 * actor who moved it reads as a hand-off — the projection records no
 * assignee history, so "the assignee changed" is approximated as "the mover
 * is not the holder", against the task's CURRENT holder.
 */
function linesOf(task: HubTask, dropped: ReadonlySet<string>): ActivityNote[] {
  const lines: ActivityNote[] = [];
  for (const n of task.notes ?? []) {
    if (dropped.has(sameText(n.text))) continue;
    lines.push({
      at: n.at,
      age: '',
      text: n.kind === 'denial' ? `blocked: ${n.text}` : n.text,
      agent: n.agent,
      kind: n.kind,
    });
  }
  const holder = task.assignee.trim();
  for (const tr of task.transitions) {
    const handed = tr.to === 'in-progress' && holder !== '' && tr.by.name.trim() !== holder;
    lines.push({
      at: tr.ts,
      age: '',
      text: handed ? `handed to ${holder}` : `→ ${tr.to}`,
      agent: tr.by.name,
      kind: 'move',
    });
  }
  return lines;
}

/** Off the active bands: Backlog, a goal the board no longer lists, or a goal
 *  already declared done. `goalRank` is the board's own answer to "which
 *  band", so the pane and the board can never disagree about the fallback. */
function offBand(task: HubTask, goals: HubGoal[], rank: (goalId: string) => number): boolean {
  if (task.goal === CHORES_ID) return true;
  const last = rank(CHORES_ID);
  if (rank(task.goal) === last) return true;
  for (const g of goals) {
    if (g.id === task.goal) return g.status === 'done';
    for (const sg of g.subgoals ?? []) if (sg.id === task.goal) return sg.status === 'done';
  }
  return false;
}

/** The newest note's text, repeated `STALE_REPEATS` times in a row. Reads
 *  the task's notes only — a status move between two repeats is not the
 *  agent saying something new. */
function stale(notes: HubNote[]): boolean {
  if (notes.length < STALE_REPEATS) return false;
  const sorted = [...notes].sort((a, b) => b.at - a.at);
  const head = sameText(sorted[0]?.text ?? '');
  if (head === '') return false;
  for (let i = 1; i < STALE_REPEATS; i += 1) {
    if (sameText(sorted[i]?.text ?? '') !== head) return false;
  }
  return true;
}

function flagOf(
  task: HubTask,
  newestAt: number,
  goals: HubGoal[],
  rank: (goalId: string) => number,
  now: number,
): ActivityFlag | undefined {
  if (task.status === 'in-progress' && now - newestAt >= DARK_AFTER_MS) return 'dark';
  if (stale(task.notes ?? [])) return 'stale';
  if (offBand(task, goals, rank)) return 'off-band';
  return undefined;
}

/**
 * The pane's groups: every unarchived task with a note or transition inside
 * the window, newest activity first, at most `ACTIVITY_GROUP_CAP` of them,
 * each with its newest `ACTIVITY_NOTE_CAP` lines and a count of the rest.
 */
export function homeActivity(input: ActivityInput): ActivityGroup[] {
  const { tasks, goals, now } = input;
  const since = now - ACTIVITY_WINDOW_MS;
  const rank = goalRank(goals);
  const askedOn = new Map<string, Set<string>>();
  for (const a of input.asks ?? []) {
    let set = askedOn.get(a.taskId);
    if (!set) {
      set = new Set();
      askedOn.set(a.taskId, set);
    }
    set.add(sameText(a.text));
  }
  const none: ReadonlySet<string> = new Set();

  const groups: { newestAt: number; group: ActivityGroup }[] = [];
  for (const task of tasks) {
    if (isTaskArchived(task)) continue;
    const lines = linesOf(task, askedOn.get(task.id) ?? none)
      .filter((l) => l.at >= since && l.at <= now)
      .sort((a, b) => b.at - a.at);
    if (lines.length === 0) continue;
    const newestAt = lines[0]?.at ?? since;
    const flag = flagOf(task, newestAt, goals, rank, now);
    groups.push({
      newestAt,
      group: {
        taskId: task.id,
        title: task.title,
        status: task.status,
        ...(flag ? { flag } : {}),
        notes: lines.slice(0, ACTIVITY_NOTE_CAP).map((l) => ({ ...l, age: ageShort(l.at, now) })),
        more: Math.max(0, lines.length - ACTIVITY_NOTE_CAP),
      },
    });
  }
  groups.sort((a, b) => b.newestAt - a.newestAt || a.group.taskId.localeCompare(b.group.taskId));
  return groups.slice(0, ACTIVITY_GROUP_CAP).map((g) => g.group);
}
