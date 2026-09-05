/**
 * Who is here, what has happened, and where the board is standing: the presence
 * strip, the plugin and client release drift notices, the activity trail's
 * wording, and the Home pane's own nav and clock (plan §3.9). Computed from
 * the ws:<workspaceId> ydoc projection + REST payloads — no DOM, no fetch — so
 * every sentence the trail prints is unit-testable without a browser.
 *
 * The three are one file because they are one strip of chrome fed by one
 * clock: `timeAgo` dates a presence chip, a release, and a trail row alike,
 * and splitting them would put that clock behind an import in three places.
 */
import { tabTitle } from '../tab-title.ts';
import { type BoardTab, fmtDuration } from './board-model.ts';

// ── Activity view (exactly two filters — §3.9) ─────────────────────────────

export interface ActivityEvent {
  event: string;
  ts: number;
  [k: string]: unknown;
}

export type ActivityFilter = 'all' | 'decisions';

/** The rows where an agent (or person) exercised placement judgment:
 *  placements, moves, re-triages, goal-list reprioritizations. Plain status
 *  transitions appear under All only (§3.9 — a five-way taxonomy was mocked
 *  and cut). */
const DECISION_EVENTS: ReadonlySet<string> = new Set([
  'task.created',
  'task.regrouped',
  'task.gate_refused',
  'workspace.goals_changed',
]);

/**
 * Events the trail never shows. agent.heartbeat is a liveness signal, one
 * row per beat — pure noise in a review view whose job is to make the 80/95
 * read effortless. server.tick is the same class (the server strips it
 * before it ever reaches us; the guard here keeps that a server-side
 * courtesy, not a load-bearing assumption). task.noted is one row per agent
 * TURN — and it STAYS noise here even now that notes are the task's own
 * Activity feed: the notes render from `task.notes` on that task's tab (and
 * as first lines on the Home pane), never from the board-wide trail, which
 * would bury the rows that move under one row per turn of every agent.
 */
const TRAIL_NOISE: ReadonlySet<string> = new Set(['agent.heartbeat', 'server.tick', 'task.noted']);

export function activityRows(events: ActivityEvent[], filter: ActivityFilter): ActivityEvent[] {
  const kept = events.filter((e) =>
    filter === 'decisions' ? DECISION_EVENTS.has(e.event) : !TRAIL_NOISE.has(e.event),
  );
  return kept.sort((a, b) => b.ts - a.ts);
}

/**
 * One task's audit rows, newest first — what the panel's Activity tab shows
 * beside the stored transition list.
 *
 * `task.transitioned` is dropped because the panel renders those from
 * `task.transitions` — the stored trail, which is on the row itself rather
 * than in a log that has to be fetched. Everything else a task can have done
 * TO it —
 * renamed, rewritten, reassigned, re-dated, answered, taken back — reached
 * the workspace feed and no surface on the ticket. Measured 2026-08-18: the
 * tab logged status changes and nothing else, so a rename left no trace on
 * the ticket it renamed.
 */
export function taskActivity(events: ActivityEvent[] | undefined, taskId: string): ActivityEvent[] {
  return (events ?? [])
    .filter(
      (e) => e.taskId === taskId && e.event !== 'task.transitioned' && !TRAIL_NOISE.has(e.event),
    )
    .sort((a, b) => b.ts - a.ts);
}

// ── Uptime (deploy readiness — §3.12 commit 11) ────────────────────────────

/** Mirror of the server's UptimeReport (packages/server/src/uptime.ts) —
 *  the client can't import server code, same as ActivityEvent. */
export interface UptimeReport {
  target: number;
  windowMs: number;
  measuredMs: number;
  downMs: number;
  uptimeRatio: number;
  meetsTarget: boolean;
  gaps: Array<{ from: number; to: number; downMs: number }>;
  tickMs: number;
}

export interface UptimeSummary {
  label: string;
  detail: string;
  ok: boolean;
}

/** One banner line for the activity view. The percentage is TRUNCATED to
 *  one decimal, never rounded — display must not overstate uptime (98.99%
 *  rounding up to "99.0%" would read as the target met while `ok` says
 *  otherwise). */
export function uptimeSummary(report: UptimeReport | null): UptimeSummary | null {
  if (!report) return null;
  const pct = Math.floor(report.uptimeRatio * 1000) / 10;
  const pctStr = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  const down = report.downMs > 0 ? ` · down ${fmtDuration(report.downMs)}` : '';
  return {
    label: `Uptime ${pctStr}%`,
    detail: `target ${report.target * 100}% over ${fmtDuration(report.measuredMs)}${down}`,
    ok: report.meetsTarget,
  };
}

interface EventActor {
  name?: string;
}

function actorName(ev: ActivityEvent): string {
  const actor = ev.actor as EventActor | undefined;
  return actor?.name ?? 'someone';
}

/**
 * How an assignee id reads to a person.
 *
 * `human` is a reserved id meaning "a person, unspecified" — every other value
 * is an agent's own name and reads fine as it is. Rendering the reserved word
 * raw put the literal `human` in the dropdown and in its accessible name,
 * which is an implementation detail presented as user-facing copy.
 *
 * "A person" rather than "Me" or a name: the id says a person owns this and
 * says nothing about WHICH, and inventing the reader is how a shared board
 * starts telling two people different things about the same row.
 *
 * It lives in the MODEL rather than beside the picker because the picker is
 * not the only surface that renders an assignee: `task.assigned` in
 * `describeEvent` renders the same id into the activity trail, and it read
 * `Panel Reviewer → human` while the dropdown two inches above it said "A
 * person". Two copies of "how does this id read" drift, and the drift lands in
 * the feature's own subject.
 */
export function assigneeLabel(id: string): string {
  return id === 'human' ? 'A person' : id;
}

/** A commit as a human reads it. Undefined stays undefined — a blank sha is
 *  not a short sha, and printing `commit ` with nothing after it is worse
 *  than saying "evidence". */
export function shortCommit(commit: string | undefined): string | undefined {
  const trimmed = commit?.trim() ?? '';
  return trimmed.length > 0 ? trimmed.slice(0, 10) : undefined;
}

function taskTitle(ev: ActivityEvent, titleOf: (taskId: string) => string): string {
  const task = ev.task as { id?: string; title?: string } | undefined;
  if (task?.title) return task.title;
  const id = (ev.taskId as string | undefined) ?? task?.id;
  return id ? titleOf(id) : 'a task';
}

/**
 * The store events whose arrival stales the REST-fed activity trail — the SSE
 * wiring in board-app subscribes to exactly this list and calls `loadEvents` on
 * each. It lives here, next to `describeEvent`, because the two must move
 * together: an event the trail can RENDER but the list omits never refreshes
 * the trail, for the writer's own tab as much as for a peer's (the server
 * echoes local writes back over SSE, so this list is also how a due date you
 * just set gets its Activity row). That was the measured failure for
 * `task.due_set` and `decision.answer_withdrawn` — emitted, logged, rendered
 * on the next full load, and invisible on the tab the reader was looking at.
 *
 * Deliberately NOT every `describeEvent` case: `agent.*` refreshes the
 * presence strip through its own listeners, `server.started` and the retired
 * `task.gate_refused` / `task.evidence_amended` have no live emitter to hear,
 * and `task.body_edited` predates this list and is out of its scope.
 */
export const ACTIVITY_REFRESH_EVENTS = [
  'task.created',
  'task.transitioned',
  'task.assigned',
  'task.retitled',
  'task.due_set',
  'task.archived',
  'task.restored',
  'task.regrouped',
  'task.unblocked',
  'review_item.added',
  'decision.answered',
  'decision.answer_withdrawn',
  'decision.info_requested',
  'workspace.goals_changed',
] as const;

/**
 * ", with its 14 tasks" — the half of a band's archive that is not visible
 * from the band.
 *
 * Read off `cascadeTasks`, which only a GOAL's own archive or restore carries.
 * A member of the cascade gets its own ordinary line, so the trail reads as a
 * decision followed by its consequences rather than as fifteen unexplained
 * removals — and a reader scanning for one ticket still finds the ticket.
 */
function cascadeClause(ev: ActivityEvent): string {
  const n = typeof ev.cascadeTasks === 'number' ? ev.cascadeTasks : 0;
  if (n <= 0) return '';
  return `, with its ${n === 1 ? '1 task' : `${n} tasks`}`;
}

/** One human-readable line per audit row. Unknown event kinds fall back to
 *  the raw name — an exhaustive-table miss should be visible, not blank. */
export function describeEvent(ev: ActivityEvent, titleOf: (taskId: string) => string): string {
  const title = () => `“${taskTitle(ev, titleOf)}”`;
  switch (ev.event) {
    case 'task.created': {
      const goal = (ev.goal as string | undefined) ?? '';
      const who = ev.actor !== undefined ? `${actorName(ev)} ` : '';
      return `${who}created ${title()}${goal ? ` in ${goal}` : ''}`;
    }
    case 'task.transitioned':
      return `${actorName(ev)} moved ${title()}: ${String(ev.from)} → ${String(ev.to)}`;
    case 'task.assigned':
      return `${actorName(ev)} assigned ${title()}: ${assigneeLabel(String(ev.from))} → ${assigneeLabel(String(ev.to))}`;
    case 'task.regrouped':
      return `${actorName(ev)} regrouped ${title()}: ${String(ev.fromGoal)} → ${String(ev.toGoal)}`;
    // The row came free. Blocked is derived, so nothing about the row changed
    // and there is no transition to read this off — this line IS the record.
    // The blocker's title comes off the EVENT: it may be renamed or archived
    // later, and this is what was cleared on that day.
    case 'task.unblocked': {
      const by =
        typeof ev.clearedByTitle === 'string' && ev.clearedByTitle ? ev.clearedByTitle : '';
      return `${title()} is no longer blocked${by ? ` — “${by}” closed` : ''}`;
    }
    case 'task.due_set': {
      // Three sentences, because clearing a date and setting one read
      // differently to whoever is scanning the trail for what slipped.
      const when = (v: unknown): string =>
        typeof v === 'number' ? new Date(v).toLocaleDateString() : '';
      const to = when(ev.to);
      const from = when(ev.from);
      if (!to) return `${actorName(ev)} cleared the due date on ${title()}`;
      if (from) return `${actorName(ev)} moved ${title()} from ${from} to ${to}`;
      return `${actorName(ev)} set ${title()} due ${to}`;
    }
    // Retired 2026-08-27 — parking is a move to triage plus a comment now, so
    // nothing emits this any more. The line stays because the ACTIVITY LOG
    // does: months of real deferrals are in it, and a removed case renders
    // them as a raw event name.
    case 'task.parked': {
      const when = (v: unknown): string =>
        typeof v === 'number' ? new Date(v).toLocaleDateString() : '';
      const to = when(ev.to);
      const from = when(ev.from);
      const why = typeof ev.reason === 'string' && ev.reason ? ` — ${ev.reason}` : '';
      if (!to) return `${actorName(ev)} un-parked ${title()}`;
      if (from) return `${actorName(ev)} moved the park on ${title()} to ${to}${why}`;
      return `${actorName(ev)} parked ${title()} until ${to}${why}`;
    }
    case 'task.archived': {
      // The title comes off the EVENT, not from `titleOf`: an archived row is
      // one somebody may rename or restore later, and this line is the record
      // of what left the board on that day.
      const name = typeof ev.title === 'string' && ev.title ? `“${ev.title}”` : title();
      const why = typeof ev.reason === 'string' && ev.reason ? ` — ${ev.reason}` : '';
      return `${actorName(ev)} archived ${name}${cascadeClause(ev)}${why}`;
    }
    case 'task.restored': {
      const name = typeof ev.title === 'string' && ev.title ? `“${ev.title}”` : title();
      return `${actorName(ev)} restored ${name}${cascadeClause(ev)}`;
    }
    case 'task.body_edited': {
      // Typing in a task body is deliberately NOT activity (the snapshot
      // fires no event at all). This row is the other thing: a wholesale
      // rewrite through the body route, which is how a thin task gets its
      // acceptance criteria — worth a line, because the reader who filed it
      // is looking at different words than the ones they wrote.
      //
      // When the same act retitled the row (triage shaping a raw capture),
      // the old title has to be in the line: it is the ONLY name the person
      // who filed it would recognise, and after the rewrite it survives
      // nowhere else on the board.
      const from = ev.titleFrom as string | undefined;
      const to = ev.titleTo as string | undefined;
      const why = typeof ev.reason === 'string' && ev.reason ? ` — ${ev.reason}` : '';
      if (from && to) return `${actorName(ev)} reshaped “${from}” into “${to}”${why}`;
      return `${actorName(ev)} rewrote the description of ${title()}${why}`;
    }
    case 'task.retitled': {
      // A title-only fix. Same rule as the reshape line above: the OLD name
      // is the only one the person who filed the row would recognise, so it
      // leads the sentence.
      const from = ev.titleFrom as string | undefined;
      const to = ev.titleTo as string | undefined;
      const why = typeof ev.reason === 'string' && ev.reason ? ` — ${ev.reason}` : '';
      if (from && to) return `${actorName(ev)} renamed “${from}” to “${to}”${why}`;
      return `${actorName(ev)} renamed ${title()}${why}`;
    }
    // Evidence support was removed on 2026-08-25, so nothing emits this
    // again. The case STAYS for the same reason `task.gate_refused` below
    // does: rows are already in `events.jsonl`, and a type this switch has no
    // case for renders as the bare slug in a feed written for people. What
    // was retired is the ability to WRITE evidence, not the history of when
    // somebody did.
    case 'task.evidence_amended': {
      const commit = shortCommit((ev.evidence as { commit?: string } | undefined)?.commit);
      const old = shortCommit((ev.supersedes as { commit?: string } | undefined)?.commit);
      const what = commit ? `commit ${commit}` : 'evidence';
      return old
        ? `${actorName(ev)} corrected the evidence on ${title()}: ${what} replaces ${old}`
        : `${actorName(ev)} attached ${what} to an earlier move on ${title()}`;
    }
    // The risk gate was removed on 2026-08-18, so nothing emits this again.
    // The case STAYS: rows are already in `events.jsonl`, and a type this
    // switch has no case for falls through to the bare slug
    // `task.gate_refused` — a log line in a feed written for people. Same trap
    // as "A new emitted event reaches the surface as a bare slug" in
    // learnings.md, running backwards. `ev.riskTier` is read off the stored
    // row, not off the task.
    case 'task.gate_refused':
      return `the gate refused ${actorName(ev)} on ${title()}: ${String(ev.riskTier)}-tier, → ${String(ev.to)}`;
    case 'review_item.added': {
      // The ask itself, so the trail reads question-then-answer rather than
      // an answer to nothing. The verb follows the shape, as the card's kind
      // chip does: a decision is raised, a question is asked.
      const headline = typeof ev.headline === 'string' ? ev.headline : '';
      const verb = ev.shape === 'decision' ? 'raised a decision on' : 'asked a question on';
      return `${actorName(ev)} ${verb} ${title()}${headline ? `: “${headline}”` : ''}`;
    }
    case 'decision.answered': {
      // The emitted row carries the answer as a plain STRING (the store's
      // `answer: text`), not the `{text, by, ts}` object the task field
      // holds. Reading `.text` off the string silently dropped every
      // verbatim answer — the words are the whole point of the row.
      const answer =
        typeof ev.answer === 'string'
          ? ev.answer
          : (ev.answer as { text?: string } | undefined)?.text;
      return `${actorName(ev)} answered ${title()}${answer ? `: “${answer}”` : ''}`;
    }
    case 'decision.answer_withdrawn': {
      // The withdrawn words are IN the line, not implied by it. Whoever reads
      // this trail is usually reading it because an agent acted on an answer
      // that has since been taken back, and "which answer" is the question.
      const answer = typeof ev.answer === 'string' ? ev.answer : '';
      return `${actorName(ev)} took back the answer on ${title()}${answer ? `: “${answer}”` : ''} — it is open again`;
    }
    case 'workspace.goals_changed':
      return ev.kind === 'reorder'
        ? `${actorName(ev)} reordered the goals`
        : `${actorName(ev)} edited the goal list`;
    case 'agent.attached':
      return `${String(ev.agentId)} attached`;
    case 'agent.detached':
      return `${String(ev.agentId)} detached`;
    case 'server.started':
      // The marker the uptime monitor stamps at boot (§3.12 commit 11) — a
      // restart is honest activity, and it bounds the outage it just ended.
      return 'server restarted';
    default:
      return `${ev.event}`;
  }
}

// ── Presence strip (§2.7) ──────────────────────────────────────────────────

export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export interface PresencePerson {
  clientId: number;
  /** WHO this is — `User.id`, which is stable per browser (localStorage) or
   *  is the known user's own id. Optional because a tab running a bundle that
   *  predates it sends no id; `presenceIdentity` falls back to the CONNECTION
   *  there, never to the name — see the reasoning on that function. */
  userId?: string;
  name: string;
  surface: string;
  docId?: string;
  lastActive: number;
  self?: boolean;
}

/**
 * Whether the lead seat has anybody in it, as the attachments read reports it.
 *
 * Three states, not two. The board has always drawn an EMPTY seat loudly and
 * a HELD seat silently, and a held seat whose holder has stopped answering
 * therefore rendered exactly like a healthy board — which is how a lead that
 * respawned under a new name left its board apparently owned and actually
 * unread for hours. `stale` is that third state.
 *
 * Absent from a server older than the field, and every reader treats absence
 * as "no claim made" rather than as healthy.
 */
export interface LeadSeatView {
  leadAgentId?: string;
  live: boolean;
  stale: boolean;
  /** The seat names an id with no attachment record — set ahead of the
   *  session arriving, or detached since. Reported, never treated as gone. */
  unattached?: boolean;
  staleForMs?: number;
}

/**
 * What the strip says above the picker.
 *
 * The wording lives here rather than in the renderer because it is the whole
 * signal: the strip's job is to say whether this board's asks are reaching
 * anybody, and a label that only ever names the seat's OCCUPANT answers a
 * question nobody was asking.
 */
/** A silence as a person reads one — coarse, because the reader is deciding
 *  whether it is unusual, not measuring it. */
function silenceWords(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function leadSeatLabel(leadAgentId: string | undefined, seat?: LeadSeatView): string {
  if (!leadAgentId) return 'No lead agent — nobody owns this board’s asks';
  if (!seat || seat.leadAgentId !== leadAgentId) return 'Lead agent';
  if (seat.stale) {
    const since = seat.staleForMs === undefined ? '' : ` for ${silenceWords(seat.staleForMs)}`;
    return `Lead agent has not answered${since} — its asks are reaching nobody`;
  }
  if (seat.unattached) return 'Lead agent has not attached — its asks are reaching nobody';
  return 'Lead agent';
}

export interface PresenceAgent {
  agentId: string;
  state: 'active' | 'unresponsive' | 'away';
  stateLabel: string;
  lastToolCallAt: number;
}

export interface PresenceChip {
  /** The PARTICIPANT: `p-<name>` or `a-<agentId>`. Stable across reconnects
   *  and across the several tabs one person may have open — it is the row key
   *  the presence island renders on, and what `followedKey` names. */
  key: string;
  label: string;
  kind: 'person' | 'agent';
  /** Short "where they are" line rendered inside the chip. */
  where: string;
  /** Full detail for the tooltip. */
  title: string;
  docId?: string;
  /** The connection this chip's reading came from — the most recently active
   *  of the person's tabs. Only ever a way to tell tabs apart, never the
   *  identity: it is minted fresh on every connect. */
  clientId?: number;
  state?: PresenceAgent['state'];
}

/** What the attachments read says about plugin versions. */
export interface PluginRelease {
  /** The version this server's deploy source would install; null if its
   *  manifest could not be read. */
  version: string | null;
  behind: Array<{ agentId: string; pluginVersion?: string }>;
  /** How many sessions `behind` was computed over — the DOMAIN of the check.
   *  Optional because a client can outlive the server release that added it;
   *  when it is missing the notice states the domain without a count rather
   *  than guessing one. */
  checked?: number;
}

export interface DriftNotice {
  headline: string;
  detail: string;
  fix: string;
  /**
   * `alert` — something is wrong and there is a fix to run.
   * `coverage` — nothing is wrong *within what was checked*, and this says
   * what that was. Rendered quietly: a line that is always there must not
   * look like an alarm, or it trains people to stop reading the alarms.
   */
  kind?: 'alert' | 'coverage';
}

/**
 * What this reading can see. Said in the surface, every time, because the
 * alternative was measured: the strip rendered NOTHING over one attachment
 * while the wider fleet was several releases back, and nothing reads exactly
 * like all-clear.
 */
const PLUGIN_DOMAIN =
  'Only sessions that attach to this board are checked — a peer that never attached is absent here, not current.';

/** Two steps, and the ORDER is load-bearing.
 *
 * `command` — because `claude` is a shell FUNCTION on this machine that
 * injects flags ahead of the subcommand, so the bare form is parsed as a
 * prompt and dies with a message that reads like a permission refusal. An
 * agent already filed that as "deploying is not mine to run". Printing a
 * remediation known to fail is worse than printing none; `command` is inert
 * wherever no such wrapper exists.
 *
 * Restarting FIRST re-resolves the cache as it stands, which has moved a
 * session BACKWARDS a version in exactly this situation.
 */
const PLUGIN_FIX =
  'Run: command claude plugin update claude-workspaces@claude-workspaces — then restart that session.';

/** `(2 checked)`, or nothing at all when the server did not send a count. */
function checkedClause(checked: number | undefined): string {
  return checked === undefined ? '' : ` (${checked} checked)`;
}

/**
 * "Some of your agents can't do what you just merged" — and, when none of
 * them are, what "none of them" was counted over.
 *
 * A merge does not deliver: the plugin resolves from a version-keyed cache,
 * so somebody has to run the update and the session then has to restart. That
 * went unnoticed for eleven releases because the only way to find out was to
 * go and look. This is the looking, done by the board.
 *
 * It used to return null whenever nobody was behind, which is the same defect
 * one level up. The strip's domain is "sessions that called `attach_agent` on
 * THIS board" and there is no server-wide session registry to widen it with —
 * so silence means "nothing I can see is behind", and it was read as "no
 * session is behind". Measured 2026-08-17: `behind: []` over a single
 * attachment, while sessions elsewhere in the fleet sat releases back. Fixing
 * that one session took the reading from naming one to naming nobody without
 * touching the drift. So a clear result now SAYS it is clear-within-a-domain
 * and how big that domain was; only the alarm is silent when there is nothing
 * to raise.
 *
 * Three things it still deliberately will not do: invent a claim when the
 * released version is unknown (it says it cannot check instead of saying
 * nothing), print a blank where a session is too old to report its version
 * ("too old to name" is the true statement there), and imply that an empty
 * `behind` list clears anything outside the count beside it.
 */
export function pluginDriftNotice(release: PluginRelease | null | undefined): DriftNotice | null {
  // No attachments read at all — not even the domain is known yet, so there
  // is genuinely nothing to say. This is the ONLY silent branch.
  if (!release) return null;
  const { version, checked } = release;
  const behind = release.behind ?? [];

  if (!version) {
    // The manifest was unreadable. Claiming drift would be inventing it —
    // but so would saying nothing, which reads as "checked, all fine".
    return {
      kind: 'coverage',
      headline: "Plugin versions can't be checked here",
      detail: `This server could not read its deploy source's plugin manifest, so no session's bundle has been compared${checkedClause(checked)}.`,
      fix: 'Nothing on this strip is a clearance until that manifest reads.',
    };
  }

  if (behind.length === 0) {
    return {
      kind: 'coverage',
      headline:
        checked === 0
          ? `Nothing has been checked against ${version} — no session has attached to this board`
          : `No attached session is behind ${version}${checkedClause(checked)}`,
      detail: PLUGIN_DOMAIN,
      fix: 'Not a fleet-wide clearance: a session that has not attached here is unchecked, not current.',
    };
  }

  return {
    kind: 'alert',
    headline: `${behind.length} ${behind.length === 1 ? 'agent is' : 'agents are'} running an older plugin than ${version}`,
    // The domain rides the alarm too. "1 agent is behind" is also a statement
    // about attached sessions only, and a count of 1-out-of-1 is a different
    // thing to act on than 1-out-of-9.
    detail: `${behind
      .map((b) => `${b.agentId} ${b.pluginVersion ?? '(too old to report)'}`.trim())
      .join(', ')}${checked === undefined ? '' : ` — of ${checked} checked`}. ${PLUGIN_DOMAIN}`,
    fix: PLUGIN_FIX,
  };
}

/** What the attachments read says about the client this server publishes.
 *  Owner-only, and absent entirely on a server that publishes nothing. */
export interface ClientRelease {
  releaseId: string | null;
  publishedAt: number | null;
  ageMs: number | null;
  sourceRef: string | null;
  consecutiveFailures: number;
  failingSince: number | null;
  lastError: string | null;
  /** The server's call, not this module's: the arming rule (and its "one
   *  transient failure is not news" silence) lives next to the ledger it
   *  reads, so there is exactly one place that decides. */
  stale: boolean;
}

/** A build error can be long; the strip is not a log viewer. */
const MAX_ERROR_CHARS = 200;

/**
 * "Every browser here is running an old client."
 *
 * A failed client build keeps the previous release live — the right call,
 * stale beats down — but it used to say so ONLY on stderr in a supervisor log,
 * which is not a surface. A build that keeps failing then means an ever-older
 * client against an ever-newer server: the exact server-new/client-old split
 * the release mechanism exists to prevent, reintroduced through the failure
 * path.
 *
 * So the age is the headline. "Stale" alone does not say whether the split is
 * minutes or a week, and the gap is the whole reason to care.
 */
export function clientDriftNotice(
  release: ClientRelease | null | undefined,
  now: number,
): DriftNotice | null {
  if (!release?.stale) return null;
  const headline =
    release.publishedAt === null
      ? 'No client has ever been published here — the build has never succeeded'
      : `Every browser here is running a client published ${timeAgo(release.publishedAt, now)}`;

  const parts: string[] = [];
  const n = release.consecutiveFailures;
  parts.push(
    n === 1
      ? 'The last build failed'
      : `${n} builds in a row have failed${
          release.failingSince === null ? '' : ` since ${timeAgo(release.failingSince, now)}`
        }`,
  );
  if (release.sourceRef) parts.push(`the live release was built from ${release.sourceRef}`);
  if (release.lastError) {
    const err =
      release.lastError.length > MAX_ERROR_CHARS
        ? `${release.lastError.slice(0, MAX_ERROR_CHARS)}…`
        : release.lastError;
    parts.push(err);
  }
  return {
    headline,
    detail: `${parts.join(' · ')}.`,
    // The restart is the deploy for the browser client: a fixed build changes
    // nothing for anybody until this server starts again and publishes it.
    fix: 'Fix the build in the deploy source, then restart the review server — the restart is the client deploy.',
  };
}

/** Two letters a small circle can carry: first letters of the first two
 *  words. Splits on `-`/`_`/`.`/`/` as well as spaces so a multi-segment
 *  agent id ("task-list-ux") reads as "TL" rather than "T", and drops
 *  parenthesised tokens so "Ana (you)" is "A", not "A(". */
export function initialsOf(name: string): string {
  return (
    name
      .split(/[\s\-_./]+/)
      .filter((w) => w.length > 0 && !w.startsWith('('))
      .slice(0, 2)
      .map((w) => [...w][0] ?? '')
      .join('')
      .toUpperCase() || '?'
  );
}

/** Deterministic hue from a label, so the same person wears the same colour
 *  on every paint and every viewer's screen without a stored palette. The
 *  "(you)" suffix is stripped first — you and the person watching you must
 *  agree on your colour. */
export function presenceHue(label: string): number {
  const base = label.replace(/\s*\(you\)$/, '');
  let h = 0;
  for (const ch of base) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

/**
 * WHO a presence entry is, as opposed to which connection it arrived over.
 *
 * `userId` is `User.id` — stable per browser (localStorage) or the known
 * user's own — so it is the same across every tab that person has open and
 * different for anybody else. Those are the two things the strip's row key
 * has to get right, and a display name gets both wrong: two people called
 * Alex share one, and it tells tabs apart only by accident.
 *
 * With no id, the fallback is the CONNECTION, not the name. A board tab running
 * a bundle that predates the id in awareness therefore behaves exactly as
 * every tab did before this change — its own row, rebuilt on reconnect — and
 * critically it does NOT fold with anyone. Falling back to the name instead
 * would merge two strangers who share one (codex review, and it is the right
 * call): the chip would show whichever of them moved last, and following one
 * could land on the other's document. An unstable key for an old tab is a
 * lost DOM node; a wrong identity is a wrong person.
 */
export function presenceIdentity(p: Pick<PresencePerson, 'userId' | 'clientId'>): string {
  return p.userId ?? `c${p.clientId}`;
}

/**
 * Fold every tab one person has open into the ONE person they are.
 *
 * Awareness is per-connection, so a second tab is a second entry with a
 * different Yjs `clientId` and the same human behind it. Left alone that
 * drew the same person twice in the strip and burned two of the four circle
 * slots on one body — and, because a `clientId` is minted fresh on every
 * connect, it also meant a reload rebuilt the row under a new identity.
 *
 * The surviving tab is the most recently active one, because that is where
 * the person actually IS; `self` is sticky across the merge (one of your own
 * tabs being idle must not stop the strip from marking you as you).
 */
function foldTabs(people: PresencePerson[]): PresencePerson[] {
  const byIdentity = new Map<string, PresencePerson>();
  for (const p of people) {
    const id = presenceIdentity(p);
    const prev = byIdentity.get(id);
    if (!prev) {
      byIdentity.set(id, p);
      continue;
    }
    const live = p.lastActive >= prev.lastActive ? p : prev;
    byIdentity.set(id, { ...live, self: Boolean(prev.self || p.self) });
  }
  return [...byIdentity.values()];
}

/** One chip per person and agent (§2.7), people first. Person chips carry the
 *  surface they're on; agent chips carry the derived liveness state — real
 *  signals (heartbeat, last tool call), never guesses.
 *
 *  `key` is the participant, not the connection: `p-<identity>` for a person
 *  (see `presenceIdentity`), `a-<agentId>` for an agent. It is what the
 *  presence island keys its rows on, so it has to survive a reconnect — a key
 *  that changed whenever a browser reconnected would rebuild the row (and
 *  drop an in-flight press) for a person who never moved. */
export function presenceChips(
  people: PresencePerson[],
  agents: PresenceAgent[],
  now: number,
): PresenceChip[] {
  const chips: PresenceChip[] = [];
  const sortedPeople = foldTabs(people).sort((a, b) => a.name.localeCompare(b.name));
  for (const p of sortedPeople) {
    const where = p.surface === 'board' ? 'board' : (p.docId ?? p.surface);
    chips.push({
      key: `p-${presenceIdentity(p)}`,
      label: p.self ? `${p.name} (you)` : p.name,
      kind: 'person',
      where,
      title: `${p.name} · in ${where} · ${timeAgo(p.lastActive, now)}`,
      docId: p.docId,
      clientId: p.clientId,
    });
  }
  const sortedAgents = [...agents].sort((a, b) => a.agentId.localeCompare(b.agentId));
  for (const a of sortedAgents) {
    chips.push({
      key: `a-${a.agentId}`,
      label: a.agentId,
      kind: 'agent',
      where: a.state,
      title: `${a.agentId} · ${a.stateLabel} · last tool call ${timeAgo(a.lastToolCallAt, now)}`,
      state: a.state,
    });
  }
  return chips;
}

// ── The Home pane (per-workspace) ──────────────────────────────────────────

/** Which page of the workspace shell is showing. Two panes, one shell: the
 *  shell mounts once and the panes swap, so the board's live projection
 *  survives a visit to Home. */
export type BoardPane = 'home' | 'board';

/**
 * `/workspaces/<id>` stays the BOARD — every link already in the field points
 * there, and a landing page that moved under those links would read as the
 * board having vanished. Home is the explicit `/home` suffix, deep-linkable.
 */
export function paneFromPath(pathname: string): BoardPane {
  return /^\/workspaces\/[^/?#]+\/home\/?$/.test(pathname) ? 'home' : 'board';
}

export function panePath(workspaceId: string, pane: BoardPane): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  return pane === 'home' ? `${base}/home` : base;
}

/**
 * What the top-level nav offers. Four destinations, not two panes and a
 * filter: "My Tasks" and the activity feed were both reachable only from
 * controls INSIDE the board — a segmented tab and a button that swapped the
 * board out — so neither had a URL, neither survived a reload, and the one
 * that answers "what is mine" read as a filter on somebody else's list.
 *
 * `pane` and `tab` remain the state the render path is written against; this
 * is the single thing the URL and the nav agree on, and both of those are
 * derived from it. One source, so a deep link and a click cannot disagree.
 */
export type BoardNav = 'home' | 'tasks' | 'mine' | 'activity';

/** `/workspaces/<id>` stays Tasks, for the reason `paneFromPath` gives: every
 *  link already in the field points there. The other three are suffixes. */
export function navFromPath(pathname: string): BoardNav {
  const m = pathname.match(/^\/workspaces\/[^/?#]+\/([^/?#]+)\/?$/);
  const suffix = m?.[1];
  if (suffix === 'home') return 'home';
  if (suffix === 'mine') return 'mine';
  if (suffix === 'activity') return 'activity';
  return 'tasks';
}

export function navPath(workspaceId: string, nav: BoardNav): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  return nav === 'tasks' ? base : `${base}/${nav}`;
}

export function paneForNav(nav: BoardNav): BoardPane {
  return nav === 'home' ? 'home' : 'board';
}

/** Activity keeps whichever task filter was showing; it renders no rows of
 *  its own, so answering `'all'` there would silently reset the filter on the
 *  way back. */
export function tabForNav(nav: BoardNav): BoardTab | undefined {
  return nav === 'mine' ? 'mine' : nav === 'tasks' ? 'all' : undefined;
}

/** What each destination adds to the browser tab. Tasks adds nothing: it is
 *  the board itself, so its title is just the workspace's name. */
const NAV_TAB_LABEL: Record<BoardNav, string> = {
  home: 'Home',
  tasks: '',
  mine: 'My Tasks',
  activity: 'Activity',
};

/**
 * The browser tab's title for a board. The workspace name leads, because that
 * is what tells two open boards apart; the pane follows, so that moving between
 * Home, Tasks and Activity is visible in the tab strip rather than only in
 * the URL.
 */
export function boardTabTitle(workspaceName: string, nav: BoardNav): string {
  return tabTitle(workspaceName, NAV_TAB_LABEL[nav]);
}

/** The brief as `GET /workspaces/:id/home` ships it. */
export interface HomeBriefView {
  markdown: string;
  generatedAt: number;
  /**
   * Where THIS brief's content actually starts. Not the same as the
   * payload's `since`: a generated brief is written from a capped digest, so
   * when the board has been busy it covers less of the window than the
   * window is. The card states this rather than `since`, because the window
   * is what the reader was promised and this is what they got.
   */
  coversFrom?: number;
  source: 'generated' | 'deterministic';
}

export interface HomePayload {
  workspaceId: string;
  /** 0 = this person has never marked caught up here. */
  lastReadAt: number;
  /** Where the brief's coverage actually starts (bounded on a first visit). */
  since: number;
  instructions: string;
  brief: HomeBriefView;
  /** True only when the server actually queued a model call for this reader. */
  generating: boolean;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "6:12 pm" — hand-rolled so the copy is locale-stable across browsers. */
function clockLabel(d: Date): string {
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m} ${h24 < 12 ? 'am' : 'pm'}`;
}

/** "Friday, 6:12 pm" — a point in time the way a person names one. Today and
 *  yesterday by name; within a week by weekday; beyond that a bare weekday
 *  would be ambiguous, so the date takes over. */
export function sincePointLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const day = (t: number) => {
    const x = new Date(t);
    return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  };
  const clock = clockLabel(d);
  if (day(ts) === day(now)) return `today, ${clock}`;
  if (day(ts) === day(now - 86_400_000)) return `yesterday, ${clock}`;
  if (now - ts < 7 * 86_400_000) return `${WEEKDAYS[d.getDay()]}, ${clock}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock}`;
}

/**
 * What the brief covers, as the mockup words it: "From Friday, 6:12 pm until
 * now".
 *
 * The point named is the BRIEF's own coverage start, not the window's. Those
 * differ whenever the board has been busy enough for the digest cap to bite:
 * on the live board 2026-08-18 the window held 553 changes over 7 days and
 * the generated brief was written from the newest 120 of them, 6.7 hours'
 * worth — and the card said "From Aug 11" over it. Reported as "claims to
 * include all work ... seems to be only summarizing the last few days", and
 * the reader was right. `since` remains the fallback for a payload that
 * predates the field.
 */
export function homeSinceLabel(payload: Pick<HomePayload, 'since' | 'brief'>, now: number): string {
  return `From ${sincePointLabel(payload.brief?.coversFrom ?? payload.since, now)} until now`;
}

/** "2 days" — how long something has waited, bare. The walkthrough card's
 *  wait chip (mockup: `2 days` beside the project chip). Same unit boundaries
 *  as timeAgo; under a minute says "under a minute" rather than a zero.
 *
 *  It returns a DURATION, never an adverbial: every caller composes it into
 *  its own sentence — "waiting …", "… ago", "held …" — and a helper that
 *  returned "moments" read correctly only in the one that appends "ago".
 *  The held note said "held moments" (UX review round two, 2026-08-29). One
 *  contract, so a new caller cannot pick the broken half. */
export function waitShort(since: number, now: number): string {
  const m = Math.round(Math.max(0, now - since) / 60_000);
  if (m < 1) return 'under a minute';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (m < 60) return unit(m, 'minute');
  const h = Math.round(m / 60);
  if (h < 24) return unit(h, 'hour');
  return unit(Math.round(h / 24), 'day');
}

/** "waiting 2 days" — the queue row's subline. One clock with `waitShort`,
 *  so the row and the card it opens can never disagree about the wait. */
export function waitingLabel(since: number, now: number): string {
  return `waiting ${waitShort(since, now)}`;
}

/** How long the Home pane keeps asking after a `generating: true` payload.
 *  The server's own pending window is the real bound; this cap only stops a
 *  client from polling a wedged server forever. */
export const HOME_POLL_CAP_MS = 30_000;

/**
 * Poll only while the server says a generation is actually queued — the
 * grounded flag, never an inference — and give up after the cap so a payload
 * that never settles cannot pin a phone's radio open.
 */
export function shouldPollHome(
  payload: Pick<HomePayload, 'generating'> | null,
  startedAt: number,
  now: number,
): boolean {
  if (!payload?.generating) return false;
  return now - startedAt < HOME_POLL_CAP_MS;
}

/** The anchor sent with each spoken utterance (§3.8). */
export interface VoiceBoardContext {
  surface: 'board' | 'task';
  taskId?: string;
  /** The thread the detail panel is aimed at — the review item the speaker
   *  is IN. Only with the panel open: a highlighted row has no open thread. */
  threadId?: string;
  /** The ticket-borne review item the open panel shows, when the ticket has
   *  exactly one. Same rule: never for a highlighted row. */
  reviewItemId?: string;
}

/** The little of a review-queue row `voiceBoardContext` reads. */
export interface VoiceBoardItem {
  kind: string;
  taskId?: string;
  reviewItemId?: string;
}

/**
 * Which resource the board is showing the speaker.
 *
 * Two affordances mean "this ticket", not one: the open detail panel, and the
 * keyboard row cursor (`j`/`k` focus a `.board-task-row`). Keying on the panel
 * alone made the ticket's own flow — highlight a row, hold the mic, "mark this
 * done" — send `{surface:'board'}`, and with no resource in view the server's
 * guardrail correctly refused to act on anything.
 *
 * The panel wins when both are set, for the same reason the server prefers a
 * task over a doc: it is the narrower thing in view, and "this" means the
 * narrower one to whoever said it.
 */
export function voiceBoardContext(
  detailTaskId: string | null | undefined,
  focusedRowTaskId: string | null | undefined,
  detailThreadId?: string | null,
  items: readonly VoiceBoardItem[] = [],
): VoiceBoardContext {
  const taskId = detailTaskId || focusedRowTaskId;
  if (!taskId) return { surface: 'board' };
  // The thread rides only with the PANEL's task: `detailThreadId` is the
  // panel's state, and pairing it with a row cursor would pin a reply to a
  // thread on a different ticket.
  const threadId = detailTaskId && detailThreadId ? detailThreadId : undefined;
  if (threadId) return { surface: 'task', taskId, threadId };
  // A ticket-borne row, likewise only with the panel OPEN on that ticket, and
  // only when it is the one: the server answers a pick on the task surface
  // only against a pin, so a highlighted row — `taskId` alone — can take no
  // answer. "answer: yes" used to land on whatever the cursor rested on.
  if (!detailTaskId) return { surface: 'task', taskId };
  const ticketItems = items.filter(
    (i) => i.kind === 'task-review' && i.taskId === detailTaskId && i.reviewItemId,
  );
  const [only, ...rest] = ticketItems;
  return only?.reviewItemId && rest.length === 0
    ? { surface: 'task', taskId, reviewItemId: only.reviewItemId }
    : { surface: 'task', taskId };
}
