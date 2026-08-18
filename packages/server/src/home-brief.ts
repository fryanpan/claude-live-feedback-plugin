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
  /**
   * Where this brief's CONTENT starts — `briefCoverage(...).from` at
   * generation time, which is the window start unless the digest cap dropped
   * older events. Distinct from `since`, which is the marker (0 for a reader
   * who has never marked read) and says nothing about what the model saw.
   * Optional because sidecars written before it exists have no answer; the
   * route falls back to the window start there.
   */
  coversFrom?: number;
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

/**
 * The default standing instructions, in Bryan's own words.
 *
 * The 110 is his (2026-08-18, answering t-vrwyE8YcVD-J: *"cut the default
 * prompt to 110 words"*), and it is a measurement rather than a round number.
 * The card is capped at `44vh`; at a true 430x932 viewport that ceiling is
 * 410px and a 146-word brief in six paragraphs renders 536px, so 410/536 of
 * 146 is ~112 words — 110 is the budget at which the normal brief stops being
 * clipped. It overrides the standing lean on that question, which was to keep
 * the formatting and let the tail clip.
 *
 * The budget belongs HERE and nowhere else: `buildBriefPrompt` deliberately
 * states no competing number, because a second one would contradict a reader
 * who edits these instructions. A workspace that has saved its own
 * instructions keeps them — this default only reaches a workspace that has
 * never edited them.
 */
export const DEFAULT_INSTRUCTIONS = `Write for someone who has been away a few days and reads on a phone.

- Under 110 words, as well-formatted markdown.
- Prioritize the most significant changes and keep grouping together changes until you're under word count. And ideally everything important is covered
- Lead with what changed, what outcomes were delivered.
- Only state facts that are in the event digest.
- Include inline links (not counted against word count) as much as possible to tie to source tasks, docs, mockups. Show the evidence.`;

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
  /** The workspace the events belong to — every task mention in the brief
   *  deep-links back into it, so a brief cannot be built without one. */
  workspaceId: string;
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

/**
 * The relative URL that opens a task's detail on the board — the same shape
 * the voice route navigates to and `hub-app.ts` reads off `?task=` on load.
 * Relative on purpose: the brief renders on the page it points at, and the
 * client resolves it against its own origin, so it is right on the tailnet
 * hostname, on localhost, and behind a share host alike.
 */
export function taskDeepLink(workspaceId: string, taskId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(taskId)}`;
}

function titled(input: BriefInput, row: BriefEventRow): string {
  const id = typeof row.taskId === 'string' ? row.taskId : '';
  return (id && input.titleOf(id)) || id || 'a task';
}

/**
 * The task as a markdown link — `[title](deep link)` — or the bare title
 * when the row carries no task id (a goal edit, a lead change). This is what
 * makes links POSSIBLE in the generated brief: the model may only reuse
 * links present in the digest, so the digest has to carry them. Square
 * brackets are dropped from the label because they would break the link
 * syntax on the way back out; the visible title loses only the brackets.
 */
function linked(input: BriefInput, row: BriefEventRow): string {
  const title = titled(input, row);
  if (typeof row.taskId !== 'string' || row.taskId === '') return title;
  const label = title.replace(/[[\]]/g, '');
  return `[${label}](${taskDeepLink(input.workspaceId, row.taskId)})`;
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
        created.push(linked(input, row));
        break;
      case 'task.transitioned':
        if (row.to === 'done') done.push(linked(input, row));
        else if (row.to === 'in-progress') started.push(linked(input, row));
        break;
      case 'decision.answered':
        answered.push(linked(input, row));
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
  // No count in the closing line (Bryan, 2026-08-18, t-0iestDQdJTOZ:
  // "Remove the count. Don't think I need it.") — the queue below IS the
  // list; the brief only says whether it is empty.
  lines.push(
    input.queue.total === 0
      ? 'Nothing is queued for your review right now.'
      : 'What needs your review is queued below.',
  );
  return lines.join('\n\n');
}

// ── The generated brief's prompt ───────────────────────────────────────────

/** Bound the digest so a marker that has not moved for a month cannot ship an
 *  unbounded prompt. The newest rows are the ones a catch-up is about. */
export const DIGEST_MAX_EVENTS = 120;

/**
 * What a GENERATED brief can actually see, which is not the same as the
 * window the reader is told about.
 *
 * The cap above is deliberate and stays. What was wrong is that nothing
 * downstream knew it had bitten: the prompt said "the last 7 days" and the
 * card said "From <a week ago> until now" while the model had been handed
 * the newest 120 rows. Measured on the live board 2026-08-18 — 553
 * brief-relevant events in the 7-day window, of which the digest held 120,
 * spanning **6.7 hours**. So a brief written from a third of a day was
 * presented as a week of news, which is exactly the "claims to include all
 * work ... seems to be only summarizing the last few days" report.
 *
 * `from` is therefore the first moment the brief's content really starts at:
 * the window start when every event fits, the oldest SURVIVING row when it
 * does not. The deterministic brief is not capped — it counts every event in
 * the window — so it keeps `since`, and the two briefs legitimately state
 * different windows.
 */
export interface BriefCoverage {
  /** Where the brief's content really begins. */
  from: number;
  /** True when the digest cap dropped older events inside the window. */
  capped: boolean;
  /** Rows the model sees, and rows there were. */
  shown: number;
  total: number;
}

export function briefCoverage(events: BriefEventRow[], since: number): BriefCoverage {
  const total = events.length;
  if (total <= DIGEST_MAX_EVENTS) return { from: since, capped: false, shown: total, total };
  const kept = events.slice(-DIGEST_MAX_EVENTS);
  const oldest = kept[0]?.ts;
  return {
    // A row that reached `briefEvents` has a numeric ts by construction; the
    // fallback keeps the honest direction if that ever stops being true —
    // claiming a WIDER window is the failure being fixed, so an unreadable
    // stamp falls back to the window start rather than to "now".
    from: typeof oldest === 'number' ? oldest : since,
    capped: true,
    shown: kept.length,
    total,
  };
}

export function buildBriefPrompt(
  input: BriefInput,
  instructions: string,
  coverage: BriefCoverage,
): { system: string; user: string } {
  const rows = input.events.slice(-DIGEST_MAX_EVENTS);
  const digest = rows
    .map((row) => {
      const when = typeof row.ts === 'number' ? new Date(row.ts).toISOString() : '';
      const who = actorName(row.actor);
      const what = String(row.event);
      const task = typeof row.taskId === 'string' ? linked(input, row) : '';
      const extra =
        row.event === 'task.transitioned'
          ? ` ${String(row.from ?? '')}→${String(row.to ?? '')}`
          : row.event === 'task.assigned'
            ? ` →${String(row.assignee ?? '')}`
            : '';
      return `- ${when} ${what}${extra}${task ? ` · ${task}` : ''}${who ? ` · by ${who}` : ''}`;
    })
    .join('\n');
  // The guardrail is deliberately two-sided. "Never invent links" alone made
  // links impossible — nothing linkable was in the digest, and a compliant
  // model produced none. Now the digest carries each task as a markdown link,
  // and the model is told to reuse those and only those. The word budget is
  // the instructions' to set, so no competing number lives here.
  const system = [
    'You write the "What\'s New?" catch-up brief at the top of a project workspace\'s Home page.',
    'The reader has been away and reads on a phone. Write well-formatted markdown, inverted-pyramid,',
    "and respect the word limit in the reader's instructions. Use only facts present in the digest",
    'below — never invent names, numbers, or outcomes, and never claim something shipped unless a',
    'digest line says it finished. Link to tasks using ONLY the markdown links present in the digest,',
    'each URL copied exactly; never fabricate a URL. Do not address the reader with a preamble;',
    'start with the content. Output ONLY the brief markdown.',
    '',
    "The reader's standing instructions for this brief:",
    instructions,
  ].join('\n');
  // What the model is told it covers must be what it was GIVEN. When the cap
  // bites, saying "everything since <the reader's marker>" invites exactly
  // the brief that shipped — one headed "Completed This Week", written from
  // six hours of board activity.
  const covering = coverage.capped
    ? [
        `Covering: the ${coverage.shown} most recent changes, starting ${new Date(coverage.from).toUTCString()}.`,
        `Older changes in the reader's window are NOT in this digest (${coverage.total} in total).`,
        'Describe only what is listed below, and never say the brief covers a week, a month, or',
        'everything since the reader was last here.',
      ].join('\n')
    : `Covering: everything since ${new Date(coverage.from).toUTCString()}.`;
  const user = [
    covering,
    `Events, oldest first${input.events.length > rows.length ? ` (newest ${rows.length} of ${input.events.length})` : ''}:`,
    digest || '(none — the board did not move)',
    '',
    input.queue.total === 0
      ? "Nothing is queued for the reader's review below the brief."
      : "Items needing the reader's review are queued below the brief — never state how many.",
    'Write the brief now.',
  ].join('\n');
  return { system, user };
}

/**
 * Does this text stop in the middle of a markdown token?
 *
 * The signature of a cut reply, and the one a reader sees: a link whose URL
 * never closes renders its `](/workspaces/…?task=t-` as visible text at the
 * end of the card. Each rule asks only whether an OPENER has no closer AFTER
 * it, so ordinary prose using brackets or parentheses later in the same line
 * is untouched — a false positive here costs a generated brief on this read,
 * never a blank card, but it costs it on EVERY read (nothing is stored, so
 * the next visit regenerates), which is why the rules are the unambiguous
 * ones and not a general markdown parser.
 *
 * Returns the name of the unterminated token, or null when the text is whole.
 */
export function unterminatedMarkdownToken(text: string): string | null {
  const openUrl = text.lastIndexOf('](');
  if (openUrl !== -1 && text.indexOf(')', openUrl) === -1) return 'link url';
  const openLabel = text.lastIndexOf('[');
  if (openLabel !== -1 && text.indexOf(']', openLabel) === -1) return 'link label';
  if ((text.match(/\*\*/g) ?? []).length % 2 !== 0) return 'bold';
  if ((text.match(/`/g) ?? []).length % 2 !== 0) return 'code span';
  return null;
}

/**
 * Accept a model reply as a brief, or refuse it. Refusal keeps the
 * deterministic brief — so every guard here is one-directional: it can cost
 * us a generated brief, it can never blank the card. An empty or absurdly
 * long reply is a failure, not a brief (same family as "a corrective retry
 * can DELETE the thing it was asked to fix": any validation phrased purely
 * as an upper bound is satisfied by emptiness, so the lower bound is stated
 * too).
 *
 * The mid-token check is the backstop for the same failure the summarizer
 * now catches at its source by reading `stop_reason`. Both exist because
 * they fail differently: `stop_reason` is exact but speaks only for the
 * token ceiling, while this one catches any reply that arrives broken. It is
 * also what `briefIsFresh` reuses, so a brief PERSISTED broken before either
 * guard existed stops being served — a validation-only fix leaves the
 * already-broken ones on screen, and those are the ones somebody is looking
 * at.
 */
export function acceptBrief(reply: string | null): string | null {
  if (reply === null) return null;
  const text = reply.trim();
  if (text.length < 20) return null;
  if (text.length > 4000) return null;
  if (unterminatedMarkdownToken(text) !== null) return null;
  return text;
}

// ── Staleness ──────────────────────────────────────────────────────────────

/**
 * Is this stored brief still the one to show? Fresh means: covers the same
 * marker, nothing brief-relevant has happened since it was generated, and the
 * text is whole.
 *
 * That last clause is what reaches the briefs already on disk. Guarding only
 * the WRITE would leave a brief persisted mid-link rendering forever — it is
 * fresh by every other measure, so nothing would ever replace it — and the
 * reader whose card ends in a broken URL is the reason this exists. Refusing
 * it here costs one model call and puts the deterministic brief up meanwhile.
 */
export function briefIsFresh(
  stored: StoredHomeBrief | undefined,
  since: number,
  eventCount: number,
): stored is StoredHomeBrief {
  return (
    stored !== undefined &&
    stored.since === since &&
    stored.eventCount === eventCount &&
    unterminatedMarkdownToken(stored.markdown) === null
  );
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
