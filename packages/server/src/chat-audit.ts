import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chat-audit counters: the per-agent "unfiled asks" numbers the daily chat
 * audit publishes, stored so a session can read its own back.
 *
 * WHAT THIS IS NOT: a live measurement. Chat happens in each session's
 * terminal, which this server never sees — the only thing that can judge
 * "an ask appeared in chat without a matching filed review item" is the
 * daily audit, an agent that mines the transcripts. So the audit is the
 * single writer here, and the number a session queries is exactly the
 * number the audit published — one heuristic, one implementation, no
 * second counter that could drift from the audit's. The cost, stated
 * plainly: freshness is audit cadence, not real time. A read that returns
 * `today: null` means "no audit has published for today", which is a real
 * answer and not a failure.
 *
 * Storage is append-only JSONL at `<dataDir>/chat-audit.jsonl`, one row per
 * (publish, agent). Corrections are new rows and the latest row per agent
 * wins on read — nothing is ever rewritten or pruned, per the project-wide
 * soft-delete rule (the log is a durable record, like activity.jsonl).
 *
 * Agents are keyed by their display name (CW_AGENT_NAME — e.g. "Live
 * Feedback"), normalized case/whitespace-insensitively, because that is the
 * one identity the audit (reading transcripts) and the MCP session (reading
 * its own env) both hold.
 */

export interface ChatAuditEntryInput {
  /** Display name the audit knows the session by (CW_AGENT_NAME). */
  agent: string;
  /** Asks that appeared in chat without a matching filed review item. */
  unfiledAsks: number;
  /** Total asks the audit saw in chat, filed or not (optional context). */
  totalAsks?: number;
  /** Claude Code session uuid, when the audit attributes to one session. */
  sessionId?: string;
  /** Evidence pointer in the auditor's words (thread URL, timestamps). */
  note?: string;
}

export interface ChatAuditRow extends ChatAuditEntryInput {
  /** ISO-8601 UTC with trailing Z — when the audit published this row. */
  ts: string;
  /** The day the audit is reporting on, YYYY-MM-DD. */
  day: string;
  /** Who published (the auditing agent's display name). */
  auditor?: string;
}

export interface ChatAuditPublishInput {
  day?: string;
  auditor?: string;
  entries: ChatAuditEntryInput[];
}

/** Case/whitespace-insensitive agent-name key. */
export function normalizeAgent(name: string): string {
  return name.trim().toLowerCase();
}

/** Shared identities no per-agent count can be filed under — a count for the
 *  bare category "agent" answers nothing about anybody. */
const SHARED_NAMES = new Set(['agent', 'known-agent']);

export function isSharedAgentName(name: string): boolean {
  return SHARED_NAMES.has(normalizeAgent(name));
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 2000;

/** Absolute path of the chat-audit log inside a data dir. */
export function chatAuditLogPath(dataDir: string): string {
  return join(dataDir, 'chat-audit.jsonl');
}

/** The server's current day as YYYY-MM-DD in ITS OWN local timezone — the
 *  audit, the sessions, and this server all run on the same machine, and the
 *  audit's "day" is that machine's calendar day, not UTC's. */
export function localDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class ChatAudit {
  private readonly path: string;
  private readonly now: () => number;
  private rows: ChatAuditRow[] = [];
  /** Non-null when loading found lines it could not parse. The good lines
   *  still loaded — a corrupt tail must not blank the whole history. */
  loadError: string | null = null;

  constructor(opts: { dataDir: string; now?: () => number }) {
    this.path = chatAuditLogPath(opts.dataDir);
    this.now = opts.now ?? Date.now;
    this.load(opts.dataDir);
  }

  private load(dataDir: string): void {
    if (!existsSync(this.path)) return;
    let skipped = 0;
    try {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as ChatAuditRow;
          if (typeof row.agent === 'string' && typeof row.unfiledAsks === 'number') {
            this.rows.push(row);
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }
    } catch (err) {
      this.loadError = `failed to read ${this.path}: ${String(err)}`;
      return;
    }
    if (skipped > 0) {
      this.loadError = `skipped ${skipped} unparseable line(s) in ${chatAuditLogPath(dataDir)}`;
    }
  }

  /**
   * Validate and append one publish (throws on invalid input, writing
   * nothing — a partial publish would leave the audit half-recorded).
   */
  publish(input: ChatAuditPublishInput): { rows: ChatAuditRow[] } {
    const entries = Array.isArray(input.entries) ? input.entries : [];
    if (entries.length === 0) throw new Error('entries must be a non-empty array');
    if (input.day !== undefined && !DAY_RE.test(input.day)) {
      throw new Error('day must be YYYY-MM-DD');
    }
    const nowMs = this.now();
    const ts = new Date(nowMs).toISOString();
    const day = input.day ?? localDay(nowMs);
    const auditor = typeof input.auditor === 'string' ? input.auditor.trim() : undefined;

    const stamped: ChatAuditRow[] = entries.map((e) => {
      const agent = typeof e.agent === 'string' ? e.agent.trim() : '';
      if (!agent) throw new Error('entry.agent must be a non-empty string');
      if (isSharedAgentName(agent)) {
        throw new Error(
          `"${agent}" is a shared identity, not somebody — publish counts under the agent's display name (CW_AGENT_NAME)`,
        );
      }
      if (!Number.isInteger(e.unfiledAsks) || e.unfiledAsks < 0) {
        throw new Error('entry.unfiledAsks must be a non-negative integer');
      }
      if (e.totalAsks !== undefined && (!Number.isInteger(e.totalAsks) || e.totalAsks < 0)) {
        throw new Error('entry.totalAsks must be a non-negative integer');
      }
      return {
        ts,
        day,
        ...(auditor ? { auditor } : {}),
        agent,
        unfiledAsks: e.unfiledAsks,
        ...(e.totalAsks !== undefined ? { totalAsks: e.totalAsks } : {}),
        ...(typeof e.sessionId === 'string' && e.sessionId ? { sessionId: e.sessionId } : {}),
        ...(typeof e.note === 'string' && e.note ? { note: e.note.slice(0, NOTE_MAX) } : {}),
      };
    });

    // All rows validated before any byte lands — append is all-or-nothing.
    const dir = join(this.path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.path, `${stamped.map((r) => JSON.stringify(r)).join('\n')}\n`);
    this.rows.push(...stamped);
    return { rows: stamped };
  }

  /** Latest row per agent (file order breaks ts ties — later line wins). */
  latestPerAgent(): ChatAuditRow[] {
    const byAgent = new Map<string, ChatAuditRow>();
    for (const row of this.rows) {
      const key = normalizeAgent(row.agent);
      const prev = byAgent.get(key);
      if (!prev || row.ts >= prev.ts) byAgent.set(key, row);
    }
    return [...byAgent.values()];
  }

  /**
   * What one agent reads about itself: its latest published row, and the
   * latest row whose audited day is `today` (null when no audit has covered
   * today yet — a real answer, not a failure).
   */
  readFor(
    agent: string,
    today: string,
  ): { today: ChatAuditRow | null; latest: ChatAuditRow | null } {
    const key = normalizeAgent(agent);
    let latest: ChatAuditRow | null = null;
    let todayRow: ChatAuditRow | null = null;
    for (const row of this.rows) {
      if (normalizeAgent(row.agent) !== key) continue;
      if (!latest || row.ts >= latest.ts) latest = row;
      if (row.day === today && (!todayRow || row.ts >= todayRow.ts)) todayRow = row;
    }
    return { today: todayRow, latest };
  }
}
