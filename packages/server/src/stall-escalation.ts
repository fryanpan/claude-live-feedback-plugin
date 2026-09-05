/**
 * What happens when the lead is told and nothing moves.
 *
 * `stall-nudge.ts` ends at the lead: it names the stuck rows, wakes the
 * session responsible for the board, and stops. That was the documented
 * open gap — nothing escalates past the lead — and it is the gap a board
 * falls into when the lead itself is the thing that has stopped. A session
 * that has died, run out of quota, or is sitting on a question it never
 * filed cannot act on a wake, and every later wake is addressed to the same
 * silence. Measured on the boards this shipped against: rows that sat for
 * hours with their lead woken repeatedly and no human ever told.
 *
 * So this module is the second addressee. When a row the lead was ALREADY
 * TOLD ABOUT is still a finding an hour later, the server files ONE review
 * item, on the board, naming every such row with a link to it. It is written
 * as the server, not as any agent — no session decided this, the board did —
 * and it goes on the reader's Home queue through the same door the allow-rule
 * proposals use (`allow-rules.ts`): `addReviewItem` on the store, which is
 * what puts it in `task-review` without passing the quality judge that guards
 * the ROUTE. Exempt on purpose: the judge exists to make an agent's ask
 * readable, and an item whose words are generated from board state has no
 * author to send it back to.
 *
 * ── One item, updated, never a second one ───────────────────────────────
 *
 * The item is per BOARD, not per row. A queue that grows an entry per stuck
 * row is the wake's own failure mode wearing a different hat: five entries
 * saying the same thing train the reader to skim all five. So the set of
 * rows lives in one item's body, revised in place as rows join and leave,
 * withdrawn when none is left, and filed afresh only when the board stalls
 * again after that.
 *
 * ── Why the anchor row is chosen the way it is ──────────────────────────
 *
 * A review item has to hang on a ticket — that is the only surface the Home
 * queue reads — and hanging it on a row CHANGES that row: `keep-moving.ts`
 * reads an open review item as `blocked-on-owner`, which is a row waiting on
 * a person with the ask filed, and such a row is not a stall finding. The
 * anchor therefore goes quiet in the stall pass for as long as this item is
 * open.
 *
 * That is correct for the row this prefers — the worst `unfiled` row, whose
 * whole finding was that nobody had filed the ask. This IS the filed ask; the
 * loop closing is what the bucket change records. It is a real loss of
 * visibility for a stalled row, so a stalled row is only ever the anchor when
 * no unfiled row qualifies, and the item names it either way.
 *
 * It also means the anchor cannot be re-judged by the gate while the item
 * lives, so this module tracks it directly instead: the anchor stops counting
 * when its ticket closes or when anything touches it after our own last write
 * (`anchorStillStuck`). Without that test the module reacts to the silence it
 * caused — file, watch the anchor leave the findings, withdraw, watch it come
 * back, file again — which is a review item blinking on and off the reader's
 * queue every quiet window. The re-file cooldown below is the second half of
 * the same guard.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isReviewItemOpen, reviewWithdrawn } from '@feedback/core';
import type { StallSnapshot } from './stall-nudge.ts';
import type { TaskStore } from './tasks.ts';

/**
 * How long a told row may stay a finding before the board goes over the
 * lead's head. One hour: long enough that a lead woken about a row has had
 * several turns to act on it, short enough that a morning's work is not lost
 * to a session nobody noticed had stopped. A decision, not a measurement, so
 * `CW_STALL_ESCALATE_MINUTES` overrides it.
 */
export const STALL_ESCALATE_DEFAULT_MS = 60 * 60_000;

/** `<dataDir>/stall-escalations.json` — beside `workspaces/`, like the
 *  allow-rule sidecar and the nudger's stamps. Exported so a test asserts the
 *  file the server actually writes rather than a copy of its name. */
export const STALL_ESCALATION_FILENAME = 'stall-escalations.json';

/**
 * Who files it. The server identity `park-migration.ts` and
 * `artifact-check.ts` already write as: no session decided this and no person
 * did, so neither a session's name nor a person's goes on the item.
 */
export const STALL_ESCALATION_ACTOR = {
  id: 'agent-workspaces-server',
  name: 'Claude Workspaces',
  kind: 'agent',
} as const;

/** What one named row contributes to the item's body. */
export interface EscalatedRow {
  id: string;
  title: string;
  bucket: string;
  /** How long the row has been quiet, as the gate measured it. */
  quietMs: number;
  /** How long ago the lead was told about it. */
  toldMs: number;
}

/** Plain words for each bucket — the reader is a person on a phone who was
 *  not there, and `ready-unpicked` is vocabulary from a different audience. */
const BUCKET_WORDS: Record<string, string> = {
  'blocked-on-owner-unfiled': 'waiting on a person, with no question filed anywhere they read',
  'blocked-on-owner': 'waiting on a person',
  'blocked-on-dependency': 'waiting on another row',
  'in-progress': 'claimed by somebody who has gone quiet',
  'ready-unpicked': 'nothing blocking it and nobody on it',
  'builder-silent': 'its builder stopped reporting',
  'backlog-unranked': 'ranked under no goal',
};

/** "3h", "45m", "2d" — a SPAN, not a moment, so it never reads as a clock
 *  time. Coarse on purpose: the reader acts on hours, not minutes. */
export function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * The item's words. Exported so a test reads what a person would see rather
 * than asserting on the call that wrote it.
 *
 * Links are RELATIVE and inline (`/workspaces/<id>?task=<taskId>`): the board
 * is served from several hostnames and an absolute one would be right on
 * whichever it was generated from.
 */
export function buildStallEscalationReview(input: {
  workspaceId: string;
  rows: readonly EscalatedRow[];
  escalateMs: number;
}): Record<string, unknown> {
  const { workspaceId, rows, escalateMs } = input;
  const n = rows.length;
  const headline =
    n === 1
      ? `Nothing has moved on “${clip(rows[0]?.title ?? '', 40)}” since the lead was told`
      : `${n} rows have not moved since the lead was told`;
  const lines = rows.map((row) => {
    const why = BUCKET_WORDS[row.bucket] ?? row.bucket;
    return `- [${row.title}](/workspaces/${workspaceId}?task=${row.id}) — ${why}. Quiet ${span(
      row.quietMs,
    )}; the lead was told ${span(row.toldMs)} ago.`;
  });
  const detail = [
    n === 1
      ? `This row was named to the board's lead over ${span(escalateMs)} ago and has not moved since.`
      : `These rows were named to the board's lead over ${span(escalateMs)} ago and have not moved since.`,
    '',
    ...lines,
    '',
    'The board filed this itself because the lead is the only addressee the stall wake has, and a lead that has stopped cannot act on being woken. Answering this item closes it; it comes back if rows are still stuck later.',
  ].join('\n');
  return { review_type: 'question', headline, detail };
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** One board's live item, as the sidecar remembers it. */
interface Filed {
  /** The ticket it hangs on — see the header on why it is chosen. */
  taskId: string;
  itemId: string;
  /**
   * The anchor ticket's `updatedAt` as our own last write left it.
   *
   * Taken from the write's own result rather than from the tick's `now`, and
   * that is not a detail: the two clocks are different, the store's write
   * lands a moment after the tick started, and a `now` that reads as EARLIER
   * than the bump we just caused makes the very next tick call the row moved.
   */
  wroteAt: number;
  /** Every row the item currently names, anchor included. */
  rowIds: string[];
}

/** A board with no live item, and when its last one ended — the re-file
 *  cooldown's clock. */
interface Cleared {
  clearedAt: number;
}

type BoardRecord = { filed: Filed } | { cleared: Cleared };
type Sidecar = Record<string, BoardRecord>;

export interface StallEscalationOptions {
  store: TaskStore;
  /** Where the sidecar lives. Omitted → memory only, which is what every
   *  test that is not about persistence wants. */
  dataDir?: string;
  escalateMs?: number;
  /** Where a filing or a withdrawal is announced. Defaults to
   *  `console.error`, like the nudger's — this is the only record that the
   *  server wrote to somebody's queue on its own. */
  report?: (message: string) => void;
}

export class StallEscalations {
  private readonly store: TaskStore;
  private readonly path: string | null;
  private readonly escalateMs: number;
  private readonly report: (message: string) => void;
  private sidecar: Sidecar = {};
  /** What the file already holds, so an unchanged sidecar costs no write —
   *  this runs once a minute per board forever. */
  private lastPersisted = '';

  constructor(opts: StallEscalationOptions) {
    this.store = opts.store;
    this.path = opts.dataDir === undefined ? null : join(opts.dataDir, STALL_ESCALATION_FILENAME);
    this.escalateMs = opts.escalateMs ?? STALL_ESCALATE_DEFAULT_MS;
    this.report = opts.report ?? ((message) => console.error(message));
    this.load();
  }

  /**
   * One board, once per tick. Called from the stall loop with the rows the
   * gate named and when each was told; never throws — a filer that failed
   * must not stop the boards behind it (the caller isolates it too).
   */
  onBoard(board: StallSnapshot, toldAt: ReadonlyMap<string, number>, now: number): void {
    const key = board.workspaceId;
    const record = this.sidecar[key];
    const prior = record && 'filed' in record ? record.filed : undefined;
    const item = this.liveItem(prior);

    // Rows the gate names NOW that the lead was told about long enough ago.
    // A retired board qualifies nothing: it is not being worked, and the
    // nudger does not wake its lead either.
    const fresh = board.retired ? [] : this.qualifying(board, toldAt, now);

    if (prior && item) {
      if (isReviewItemOpen(item) && !reviewWithdrawn(item.review)) {
        this.updateLive(key, prior, fresh, now);
        return;
      }
      // Answered, or withdrawn by a person. They have seen this set; only a
      // row they were NOT shown is worth asking about again.
      const unseen = fresh.filter((row) => !prior.rowIds.includes(row.id));
      if (unseen.length > 0) this.file(key, fresh);
      else if (fresh.length === 0) this.clear(key, now);
      else this.save();
      return;
    }

    // No record, or one whose ticket or item has since gone.
    if (fresh.length === 0) {
      if (prior) this.clear(key, now);
      else this.save();
      return;
    }
    const cleared = record && 'cleared' in record ? record.cleared.clearedAt : undefined;
    // The cooldown. Without it a row whose agent keeps restating its ask
    // moves in and out of the findings every quiet window, and the item
    // blinks on and off the reader's queue with it.
    if (cleared !== undefined && now - cleared < this.escalateMs) {
      this.save();
      return;
    }
    this.file(key, fresh);
  }

  /** How many boards hold a live item. Test surface for the pruning that
   *  `clear` does — a sidecar that only grows is invisible otherwise. */
  filedCount(): number {
    return Object.values(this.sidecar).filter((r) => 'filed' in r).length;
  }

  /** The item this board's record points at, when both the ticket and the
   *  item are still there. */
  private liveItem(prior: Filed | undefined) {
    if (!prior) return undefined;
    try {
      return this.store.listReviewItems(prior.taskId).find((i) => i.id === prior.itemId);
    } catch {
      return undefined;
    }
  }

  /**
   * Rows the lead was told about that are STILL findings a full escalation
   * window later, worst first.
   *
   * Told, not merely stuck: a row nobody has been woken about has not been
   * escalated past anybody yet, and filing over the lead's head before the
   * lead has been told is the same mistake as a wake that fires while the
   * turn that would have acted on it is still running.
   */
  private qualifying(
    board: StallSnapshot,
    toldAt: ReadonlyMap<string, number>,
    now: number,
  ): EscalatedRow[] {
    const rows: EscalatedRow[] = [];
    for (const row of [...board.unfiled, ...board.stalled]) {
      const told = toldAt.get(row.id);
      if (told === undefined || now - told < this.escalateMs) continue;
      rows.push({
        id: row.id,
        title: row.title,
        bucket: row.bucket,
        quietMs: row.quietMs,
        toldMs: now - told,
      });
    }
    // Unfiled rows first, then longest-told. The order is not cosmetic: the
    // FIRST row becomes the anchor, and an unfiled row is the one where
    // hanging the item costs no visibility — see the header.
    return rows.sort((a, b) => {
      const au = a.bucket === 'blocked-on-owner-unfiled' ? 0 : 1;
      const bu = b.bucket === 'blocked-on-owner-unfiled' ? 0 : 1;
      return au !== bu ? au - bu : b.toldMs - a.toldMs;
    });
  }

  /**
   * Is the anchor still stuck, given that our own item is what stops the
   * gate from saying so?
   *
   * Two facts, both readable while the row is masked: the ticket is still
   * open, and nothing has touched it since we last wrote to it. Our own
   * write set `updatedAt` to `wroteAt`, so a later bump is somebody else's.
   */
  private anchorStillStuck(prior: Filed): boolean {
    const task = this.store.getTask(prior.taskId);
    if (!task) return false;
    if (task.status === 'done' || task.archivedAt !== undefined) return false;
    return task.updatedAt <= prior.wroteAt;
  }

  /** Revise the open item to the rows that still qualify, or withdraw it
   *  when none does. */
  private updateLive(key: string, prior: Filed, fresh: EscalatedRow[], now: number): void {
    const named = fresh.filter((row) => row.id !== prior.taskId);
    if (this.anchorStillStuck(prior)) {
      const anchor = fresh.find((row) => row.id === prior.taskId) ?? this.anchorRow(prior, now);
      if (anchor) named.unshift(anchor);
    }
    if (named.length === 0) {
      this.withdraw(key, prior, now);
      return;
    }
    const ids = named.map((row) => row.id);
    if (sameIds(ids, prior.rowIds)) {
      this.save();
      return;
    }
    const res = this.store.reviseReviewItem(
      prior.taskId,
      prior.itemId,
      buildStallEscalationReview({ workspaceId: key, rows: named, escalateMs: this.escalateMs }),
      { actor: { ...STALL_ESCALATION_ACTOR } },
    );
    if (!res.ok) {
      // A refusal is not a reason to file a second item — that is the one
      // outcome this module must never produce. The record stands and the
      // next tick tries again.
      this.say(`[stall] escalation revise refused ws=${key} item=${prior.itemId}: ${res.error}`);
      this.save();
      return;
    }
    this.sidecar[key] = { filed: { ...prior, rowIds: ids, wroteAt: res.task.updatedAt } };
    this.save();
  }

  /** The anchor as the item names it while the gate cannot see it — its own
   *  ticket is the only source left. */
  private anchorRow(prior: Filed, now: number): EscalatedRow | undefined {
    const task = this.store.getTask(prior.taskId);
    if (!task) return undefined;
    return {
      id: task.id,
      title: task.title,
      bucket: 'blocked-on-owner',
      quietMs: Math.max(0, now - task.updatedAt),
      toldMs: Math.max(0, now - prior.wroteAt),
    };
  }

  private file(key: string, rows: EscalatedRow[]): void {
    const anchor = rows[0];
    if (!anchor) return;
    const res = this.store.addReviewItem(
      anchor.id,
      buildStallEscalationReview({ workspaceId: key, rows, escalateMs: this.escalateMs }),
      { actor: { ...STALL_ESCALATION_ACTOR } },
    );
    if (!res.ok) {
      this.say(`[stall] escalation refused ws=${key} task=${anchor.id}: ${res.error}`);
      this.save();
      return;
    }
    this.sidecar[key] = {
      filed: {
        taskId: anchor.id,
        itemId: res.item.id,
        wroteAt: res.task.updatedAt,
        rowIds: rows.map((r) => r.id),
      },
    };
    this.save();
    this.say(`[stall] escalated ws=${key} rows=${rows.length} item=${res.item.id}`);
  }

  private withdraw(key: string, prior: Filed, now: number): void {
    const res = this.store.withdrawReviewItem(prior.taskId, prior.itemId, {
      actor: { ...STALL_ESCALATION_ACTOR },
      reason: 'the rows it named are moving again',
    });
    if (!res.ok)
      this.say(`[stall] escalation withdraw refused ws=${key} item=${prior.itemId}: ${res.error}`);
    else this.say(`[stall] escalation cleared ws=${key} item=${prior.itemId}`);
    // Cleared either way. An item that refuses withdrawal (answered between
    // the read and the write) is closed for the reader already, and keeping
    // the record would leave this board unable to escalate again.
    this.clear(key, now);
  }

  private clear(key: string, now: number): void {
    this.sidecar[key] = { cleared: { clearedAt: now } };
    this.save();
  }

  private say(message: string): void {
    try {
      this.report(message);
    } catch {
      // A reporter that throws must not undo a filing that already landed.
    }
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.sidecar = parsed as Sidecar;
        this.lastPersisted = this.serialize();
      }
    } catch {
      // A corrupt sidecar costs at most one duplicate item, never a crash;
      // the review items themselves are the record and are untouched.
      this.sidecar = {};
    }
  }

  private serialize(): string {
    const out: Sidecar = {};
    for (const key of Object.keys(this.sidecar).sort()) {
      const record = this.sidecar[key];
      if (record) out[key] = record;
    }
    return `${JSON.stringify(out, null, 2)}\n`;
  }

  /** Write the sidecar back, when it has actually moved. Never throws: this
   *  runs inside a timer tick, and a full disk must not stop the loop. */
  private save(): void {
    if (!this.path) return;
    const next = this.serialize();
    if (next === this.lastPersisted) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, next);
      renameSync(tmp, this.path);
      this.lastPersisted = next;
    } catch (err) {
      console.error('[stall] could not persist escalations:', err);
    }
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, i) => id === right[i]);
}
