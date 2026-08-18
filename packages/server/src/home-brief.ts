/**
 * The Home pane's "What's New?" brief: what happened on a workspace since a
 * PERSON last marked themselves caught up, plus the read marker itself and
 * the editable instructions the generator writes under.
 *
 * Decisions this encodes (Bryan, 2026-08-18, on the approved home-pane
 * mockup — docs/product/mockups/home-pane, branch design/home-pane):
 *  - Summaries always cover everything since last marked read; there is no
 *    coverage-scope selector.
 *  - "Mark caught up" records a READ TIMESTAMP, per account, not per device.
 *    The next visit generates an updated summary from that point.
 *  - Regeneration is instruction-driven: edit the instructions and they are
 *    used on this summary and future summaries.
 *
 * The shape of the module follows the thread summarizer split: everything
 * pure (the deterministic brief, the prompt, staleness) is exported and
 * table-testable; the one thing that can reach the network lives on
 * `ThreadSummarizer.generateHomeBrief`, behind the same constructor seam —
 * no test run and no `bun run staging` can call the real API, because only
 * `bin.ts` ever constructs a summarizer with a key.
 *
 * "Per account" here means per NAME. Identity on these surfaces is the name
 * a person types at the who's-reviewing prompt; it is the one identifier
 * that is the same on their phone and their laptop, which is exactly the
 * case the per-account decision names (read on the phone, then the desktop).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── The sidecar ────────────────────────────────────────────────────────────

/** One person's generated brief, cached so a repeat visit does not re-spend
 *  a model call on an unchanged board. */
export interface StoredHomeBrief {
  markdown: string;
  /** The read marker this brief covers FROM. A moved marker is a stale brief. */
  since: number;
  /** How many brief-relevant events existed when generation started. A new
   *  event since then is a stale brief. */
  eventCount: number;
  generatedAt: number;
}

export interface HomeSidecar {
  /** Workspace-wide generation instructions. Absent → `DEFAULT_INSTRUCTIONS`. */
  instructions?: string;
  /** Previous instruction texts, newest last, capped — an edit overwrites
   *  user-authored words, and this project soft-deletes user content. */
  instructionsHistory?: string[];
  /** Read markers, keyed by normalized person name. */
  readers: Record<string, { lastReadAt: number }>;
  /** Generated briefs, keyed the same way. Deterministic briefs are never
   *  stored — they are recomputed per read, so absence means "nothing
   *  generated yet", not "nothing to show". */
  briefs: Record<string, StoredHomeBrief>;
}

/** Where a workspace's home state lives. Exported so tests assert the real
 *  contract path rather than a re-implementation of it. */
export function homeSidecarPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.home.json`);
}

/**
 * The marker key for a person. The NAME, normalized — not the browser-local
 * id, which is a fresh random per device and would silently turn the
 * per-account decision into per-device behaviour.
 */
export function readerKey(name: string): string {
  return name.trim().toLowerCase();
}

const HISTORY_CAP = 10;

export const DEFAULT_INSTRUCTIONS = `Write for someone who has been away a day or two and reads on a phone.

- Under 200 words, as well-formatted markdown. Lead with what changed, not the process.
- One short section per goal that moved; name what did not move in one line, so silence is never ambiguous.
- End with how many items are queued for review below — never restate a decision that is already in the queue, say it is there.
- Only state facts that are in the digest. Never invent names, numbers, or outcomes.`;

// ── What counts as news ────────────────────────────────────────────────────

/**
 * The event types a brief is about — board changes a returning person would
 * want to hear. Deliberately an allowlist, and the exclusions are
 * load-bearing: `agent.heartbeat` lands in events.jsonl every few seconds
 * and `server.tick` every few minutes, so counting them would make every
 * brief permanently stale — each read would queue a fresh generation, which
 * on the real server is an unbounded stream of model calls for a board where
 * nothing happened.
 */
export const BRIEF_EVENT_TYPES: ReadonlySet<string> = new Set([
  'task.created',
  'task.transitioned',
  'task.assigned',
  'task.regrouped',
  'task.body_edited',
  'task.evidence_amended',
  'decision.answered',
  'decision.info_requested',
  'workspace.goal_updated',
  'workspace.goals_changed',
  'workspace.lead_changed',
  'workspace.retriaged',
]);

/** One events.jsonl row, as loosely as the log actually types it. */
export interface BriefEventRow {
  event?: unknown;
  ts?: unknown;
  taskId?: unknown;
  actor?: unknown;
  to?: unknown;
  from?: unknown;
  assignee?: unknown;
  [key: string]: unknown;
}

/** The rows a brief covers: relevant types only, strictly after `since`,
 *  oldest first. */
export function briefEvents(rows: BriefEventRow[], since: number): BriefEventRow[] {
  return rows
    .filter(
      (r) =>
        typeof r.event === 'string' &&
        BRIEF_EVENT_TYPES.has(r.event) &&
        typeof r.ts === 'number' &&
        r.ts > since,
    )
    .sort((a, b) => (a.ts as number) - (b.ts as number));
}

/**
 * Read a workspace's events.jsonl, tolerant of a torn tail line, same as the
 * activity route: a crash mid-append must not take the brief down with it.
 */
export function readEventRows(dataDir: string, workspaceId: string): BriefEventRow[] {
  const logPath = join(dataDir, 'workspaces', `${workspaceId}.events.jsonl`);
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as BriefEventRow];
      } catch {
        return [];
      }
    });
}

/**
 * A first visit has no marker, and "everything ever" is not a briefable
 * window — cover the last week instead, and say so. Exported so the route
 * and the tests agree on the number rather than each keeping a copy.
 */
export const FIRST_VISIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function effectiveSince(lastReadAt: number, now: number): number {
  return lastReadAt > 0 ? lastReadAt : now - FIRST_VISIT_WINDOW_MS;
}

// ── The deterministic brief ────────────────────────────────────────────────

export interface BriefQueueSummary {
  /** How many items are in For Your Review right now (decisions + threads). */
  total: number;
}

export interface BriefInput {
  events: BriefEventRow[];
  queue: BriefQueueSummary;
  /** taskId → current title, for events that carry only an id. */
  titleOf: (taskId: string) => string | undefined;
}

function actorName(actor: unknown): string | undefined {
  if (typeof actor === 'string') return actor;
  if (actor && typeof actor === 'object' && 'name' in actor) {
    const n = (actor as { name?: unknown }).name;
    if (typeof n === 'string' && n.trim() !== '') return n;
  }
  return undefined;
}

function titled(input: BriefInput, row: BriefEventRow): string {
  const id = typeof row.taskId === 'string' ? row.taskId : '';
  return (id && input.titleOf(id)) || id || 'a task';
}

function listOf(titles: string[], cap = 5): string {
  const seen = [...new Set(titles)];
  const shown = seen.slice(0, cap);
  const rest = seen.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The brief every server can write, model or no model. Honest, bounded, and
 * markdown — the generated one replaces it when a generator is wired and the
 * call succeeds, and this stands whenever it is not or does not.
 *
 * The closing queue line renders even when everything else is quiet: an
 * empty list with no denominator reads as an all-clear, and the queue below
 * is the part of the page the reader came for.
 */
export function deterministicBrief(input: BriefInput): string {
  const done: string[] = [];
  const started: string[] = [];
  const created: string[] = [];
  const answered: string[] = [];
  let goalEdits = 0;
  for (const row of input.events) {
    switch (row.event) {
      case 'task.created':
        created.push(titled(input, row));
        break;
      case 'task.transitioned':
        if (row.to === 'done') done.push(titled(input, row));
        else if (row.to === 'in-progress') started.push(titled(input, row));
        break;
      case 'decision.answered':
        answered.push(titled(input, row));
        break;
      case 'workspace.goal_updated':
      case 'workspace.goals_changed':
        goalEdits += 1;
        break;
      default:
        break;
    }
  }

  const lines: string[] = [];
  if (input.events.length === 0) {
    lines.push('Quiet since you last caught up — nothing moved on the board.');
  } else {
    if (done.length > 0)
      lines.push(
        `**Finished:** ${listOf(done)} (${done.length} ${plural(done.length, 'task', 'tasks')}).`,
      );
    if (started.length > 0) lines.push(`**Started:** ${listOf(started)}.`);
    if (created.length > 0)
      lines.push(
        `**Filed:** ${created.length} new ${plural(created.length, 'task', 'tasks')} — ${listOf(created)}.`,
      );
    if (answered.length > 0)
      lines.push(
        `**Decided:** ${answered.length} ${plural(answered.length, 'decision was', 'decisions were')} answered — ${listOf(answered)}.`,
      );
    if (goalEdits > 0)
      lines.push(`**Goals:** edited ${goalEdits === 1 ? 'once' : `${goalEdits} times`}.`);
    if (lines.length === 0) {
      // Events happened but none of the headline kinds — say that, not nothing.
      lines.push(
        `${input.events.length} small ${plural(input.events.length, 'change', 'changes')} landed (assignments, edits, regroupings) — the activity view has each one.`,
      );
    }
  }
  lines.push(
    input.queue.total === 0
      ? 'Nothing is queued for your review right now.'
      : `**${input.queue.total}** ${plural(input.queue.total, 'item is', 'items are')} queued for your review below.`,
  );
  return lines.join('\n\n');
}

// ── The generated brief's prompt ───────────────────────────────────────────

/** Bound the digest so a marker that has not moved for a month cannot ship an
 *  unbounded prompt. The newest rows are the ones a catch-up is about. */
const DIGEST_MAX_EVENTS = 120;

export function buildBriefPrompt(
  input: BriefInput,
  instructions: string,
  sinceLabel: string,
): { system: string; user: string } {
  const rows = input.events.slice(-DIGEST_MAX_EVENTS);
  const digest = rows
    .map((row) => {
      const when = typeof row.ts === 'number' ? new Date(row.ts).toISOString() : '';
      const who = actorName(row.actor);
      const what = String(row.event);
      const task = typeof row.taskId === 'string' ? titled(input, row) : '';
      const extra =
        row.event === 'task.transitioned'
          ? ` ${String(row.from ?? '')}→${String(row.to ?? '')}`
          : row.event === 'task.assigned'
            ? ` →${String(row.assignee ?? '')}`
            : '';
      return `- ${when} ${what}${extra}${task ? ` · ${task}` : ''}${who ? ` · by ${who}` : ''}`;
    })
    .join('\n');
  const system = [
    'You write the "What\'s New?" catch-up brief at the top of a project workspace\'s Home page.',
    'The reader has been away and reads on a phone. Write well-formatted markdown, inverted-pyramid,',
    'under 200 words. Use only facts present in the digest below — never invent names, numbers,',
    'links, or outcomes, and never claim something shipped unless a digest line says it finished.',
    'Do not address the reader with a preamble; start with the content. Output ONLY the brief markdown.',
    '',
    "The reader's standing instructions for this brief:",
    instructions,
  ].join('\n');
  const user = [
    `Covering: ${sinceLabel}.`,
    `Events, oldest first${input.events.length > rows.length ? ` (newest ${rows.length} of ${input.events.length})` : ''}:`,
    digest || '(none — the board did not move)',
    '',
    `Right now, ${input.queue.total} item(s) are queued for the reader's review below the brief.`,
    'Write the brief now.',
  ].join('\n');
  return { system, user };
}

/**
 * Accept a model reply as a brief, or refuse it. Refusal keeps the
 * deterministic brief — so every guard here is one-directional: it can cost
 * us a generated brief, it can never blank the card. An empty or absurdly
 * long reply is a failure, not a brief (same family as "a corrective retry
 * can DELETE the thing it was asked to fix": any validation phrased purely
 * as an upper bound is satisfied by emptiness, so the lower bound is stated
 * too).
 */
export function acceptBrief(reply: string | null): string | null {
  if (reply === null) return null;
  const text = reply.trim();
  if (text.length < 20) return null;
  if (text.length > 4000) return null;
  return text;
}

// ── Staleness ──────────────────────────────────────────────────────────────

/**
 * Is this stored brief still the one to show? Fresh means: covers the same
 * marker, and nothing brief-relevant has happened since it was generated.
 */
export function briefIsFresh(
  stored: StoredHomeBrief | undefined,
  since: number,
  eventCount: number,
): stored is StoredHomeBrief {
  return stored !== undefined && stored.since === since && stored.eventCount === eventCount;
}

// ── The store ──────────────────────────────────────────────────────────────

function emptySidecar(): HomeSidecar {
  return { readers: {}, briefs: {} };
}

/**
 * Per-workspace home state, persisted synchronously (writes are rare: a
 * mark-read, an instructions save, a finished generation) and atomically
 * (write-temp-then-rename, so a crash can tear nothing).
 */
export class HomeBriefStore {
  private cache = new Map<string, HomeSidecar>();
  constructor(private dataDir: string) {}

  read(workspaceId: string): HomeSidecar {
    const cached = this.cache.get(workspaceId);
    if (cached) return cached;
    let state = emptySidecar();
    const path = homeSidecarPath(this.dataDir, workspaceId);
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HomeSidecar>;
        state = {
          ...(typeof parsed.instructions === 'string' ? { instructions: parsed.instructions } : {}),
          ...(Array.isArray(parsed.instructionsHistory)
            ? {
                instructionsHistory: parsed.instructionsHistory.filter(
                  (s) => typeof s === 'string',
                ),
              }
            : {}),
          readers: parsed.readers && typeof parsed.readers === 'object' ? parsed.readers : {},
          briefs: parsed.briefs && typeof parsed.briefs === 'object' ? parsed.briefs : {},
        };
      } catch {
        // An unreadable sidecar is a fresh one — markers are re-creatable
        // with one tap, and refusing to load would take the whole pane down.
      }
    }
    this.cache.set(workspaceId, state);
    return state;
  }

  instructions(workspaceId: string): string {
    return this.read(workspaceId).instructions ?? DEFAULT_INSTRUCTIONS;
  }

  lastReadAt(workspaceId: string, person: string): number {
    return this.read(workspaceId).readers[readerKey(person)]?.lastReadAt ?? 0;
  }

  /** Move a person's read marker. `at` supports undo (posting the previous
   *  value back); the return carries what it replaced so the caller can. */
  markRead(
    workspaceId: string,
    person: string,
    at: number,
  ): { lastReadAt: number; previous: number } {
    const state = this.read(workspaceId);
    const key = readerKey(person);
    const previous = state.readers[key]?.lastReadAt ?? 0;
    state.readers[key] = { lastReadAt: at };
    this.save(workspaceId, state);
    return { lastReadAt: at, previous };
  }

  /**
   * Replace the instructions. Every cached brief is dropped — they were
   * written under the old ones — and the old text is kept in a capped
   * history, because it is user-authored content and this project does not
   * hard-delete user content.
   */
  setInstructions(workspaceId: string, text: string): void {
    const state = this.read(workspaceId);
    const previous = state.instructions;
    if (previous !== undefined && previous !== text) {
      state.instructionsHistory = [...(state.instructionsHistory ?? []), previous].slice(
        -HISTORY_CAP,
      );
    }
    state.instructions = text;
    state.briefs = {};
    this.save(workspaceId, state);
  }

  brief(workspaceId: string, person: string): StoredHomeBrief | undefined {
    return this.read(workspaceId).briefs[readerKey(person)];
  }

  storeBrief(workspaceId: string, person: string, brief: StoredHomeBrief): void {
    const state = this.read(workspaceId);
    state.briefs[readerKey(person)] = brief;
    this.save(workspaceId, state);
  }

  private save(workspaceId: string, state: HomeSidecar): void {
    this.cache.set(workspaceId, state);
    const dir = join(this.dataDir, 'workspaces');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = homeSidecarPath(this.dataDir, workspaceId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  }
}
