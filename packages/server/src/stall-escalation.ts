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
 * (`anchorHolds`). Without that test the module reacts to the silence it
 * caused — file, watch the anchor leave the findings, withdraw, watch it come
 * back, file again — which is a review item blinking on and off the reader's
 * queue every quiet window. The re-file cooldown below is the second half of
 * the same guard.
 *
 * When the anchor stops holding, the item MOVES: it is withdrawn and re-filed
 * on the worst row that still qualifies, in the same tick and with no
 * cooldown. Two things make that the behaviour rather than revising in place.
 * A `done` ticket's review items are skipped by `taskReviewItems` in
 * `review-queue.ts`, so an item left on one is invisible to the reader while
 * `isReviewItemOpen` still says it is open — every other stuck row on the
 * board would then go unreported behind an ask nobody can see. And the
 * withdrawal is what UNMASKS the old anchor, so a row that was the anchor and
 * is still stuck comes back into a later item under its own name instead of
 * being hidden for as long as the item lives.
 *
 * The residual trade-off, stated because it is real: while an item is open,
 * its anchor is invisible to the stall wake. The lead is not woken about that
 * one row, and the reader's item is the only thing naming it. That is
 * acceptable because the item names it, sits on a queue somebody reads, and
 * the anchor moves the moment its ticket closes or anybody touches it. There
 * is no home for a board-level item that is not a ticket — the allow-rule
 * proposals hang on a ticket too — so the only alternative was to anchor on a
 * row that is NOT stuck, which would tell the reader something false about a
 * healthy row.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type TaskReviewItem, isReviewItemOpen, reviewWithdrawn } from '@feedback/core';
import { taskDeepLink } from './home-brief.ts';
import type { StallSnapshot, ToldTime } from './stall-nudge.ts';
import type { TaskStore } from './tasks.ts';

/**
 * How long a told row may stay a finding before the board goes over the
 * lead's head. One hour: long enough that a lead woken about a row has had
 * several turns to act on it, short enough that a morning's work is not lost
 * to a session nobody noticed had stopped. A decision, not a measurement, so
 * `CW_STALL_ESCALATE_MINUTES` overrides it.
 */
export const STALL_ESCALATE_DEFAULT_MS = 60 * 60_000;

/**
 * How long a filed item must STAND before the board may take it back because
 * its rows are moving again. Twenty minutes: the same span the gate uses to
 * decide a row has gone quiet, which is the board's own unit for "this is not
 * movement, it is a pause".
 *
 * It exists because the retraction test is far cheaper to trip than the
 * filing test. Filing needs an hour of silence past a told lead; retraction
 * needed one write — and the commonest write on any live board is the row's
 * own agent posting its end-of-turn note. Measured 2026-09-05 on the board
 * this shipped from: item filed 04:56:21, a `task.noted` by the row's own
 * lead at 04:58:19, item withdrawn 04:58:20. For those two minutes it was a
 * real ask: a watching session saw `review_item.added` and told the reader
 * something was waiting for them, and it was not. An ask that retracts itself
 * inside a pass costs more than filing nothing.
 *
 * Long enough that a row which wrote once and went quiet again keeps its ask;
 * short enough that a row genuinely being worked loses it inside the window
 * the board already calls "moving". It gates ONE door — movement — and none
 * of the others: a done, archived or deleted anchor still moves or withdraws
 * on the tick it is seen, because an item nobody can see is not an ask being
 * kept, and a retired board still withdraws unconditionally.
 */
export const STALL_ESCALATION_SETTLE_DEFAULT_MS = 20 * 60_000;

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
  /**
   * How long the row has been STUCK, on the clock its own bucket is judged by
   * (`StalledRow.stuckMs`, falling back to `quietMs`). For every bucket but
   * one those are the same number. The exception is an unfiled ask that lives
   * in a row's notes: the agent restating it touches the row every turn, so
   * its silence is seconds while the ask nobody filed is hours old, and the
   * hours are what this item is about.
   */
  quietMs: number;
  /** How long ago the lead was told about it — or, when nobody could be
   *  reached, how long the board has been unable to tell anybody
   *  (`ToldTime`). */
  toldMs: number;
  /** Was anyone actually reached? False is the dead-lead case, and it changes
   *  the sentence the reader gets. */
  delivered: boolean;
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
  // Nobody reached about ANY of them: the board is not reporting a lead that
  // ignored it, it is reporting that it has nobody to report to.
  const dark = rows.every((row) => !row.delivered);
  const headline = dark
    ? n === 1
      ? `Nobody could be reached about “${clip(rows[0]?.title ?? '', 40)}”`
      : `Nobody could be reached about ${n} stuck rows`
    : n === 1
      ? `Nothing has moved on “${clip(rows[0]?.title ?? '', 40)}” since the lead was told`
      : `${n} rows have not moved since the lead was told`;
  const lines = rows.map((row) => {
    const why = BUCKET_WORDS[row.bucket] ?? row.bucket;
    const heard = row.delivered
      ? `the lead was told ${span(row.toldMs)} ago`
      : `nobody could be reached on this board for ${span(row.toldMs)}`;
    return `- [${label(row.title)}](${taskDeepLink(workspaceId, row.id)}) — ${why}. Quiet ${span(
      row.quietMs,
    )}; ${heard}.`;
  });
  const opening = dark
    ? `Nothing on this board could be told to anybody for over ${span(escalateMs)} — its lead seat is held by a session that is not answering, and no other session is attached.`
    : n === 1
      ? `This row was named to the board's lead over ${span(escalateMs)} ago and has not moved since.`
      : `These rows were named to the board's lead over ${span(escalateMs)} ago and have not moved since.`;
  const detail = [
    opening,
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

/** A title as a markdown LINK LABEL. Square brackets are dropped rather than
 *  escaped, the same call `home-brief.ts` makes: a bracket in a title breaks
 *  the link syntax, and the visible title loses only the brackets. */
function label(title: string): string {
  return title.replace(/[[\]]/g, '');
}

/**
 * The newest moment OUR OWN item was written — its filing, its revisions, the
 * questions asked back on it, the judge's verdict.
 *
 * `anchorHolds` reads the anchor ticket's `updatedAt` to ask whether anybody
 * else has touched the row, and every write to an item on that ticket bumps
 * it — including the reader's. So a person asking a question back on this
 * very item read as the row moving, and the module answered by withdrawing
 * the item and re-anchoring it somewhere else, which drops the thread the
 * reader had just started. It only ever passed because the question and the
 * filing landed in the same millisecond; one millisecond apart, it moved.
 *
 * Comparing against this instead asks the question the header always meant:
 * is the ticket's newest write one of OURS. A stranger's write in the same
 * millisecond as our own still reads as ours, which is the same tie the
 * clock could never break anyway and strictly narrower than the old test.
 */
function ownActivityAt(item: TaskReviewItem): number {
  let at = item.createdAt;
  for (const revision of item.revisions ?? []) if (revision.at > at) at = revision.at;
  for (const question of item.infoRequests ?? []) if (question.ts > at) at = question.ts;
  if (item.judge !== undefined && item.judge.at > at) at = item.judge.at;
  return at;
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
  /** Minimum life of a filed item before movement may retract it
   *  (`STALL_ESCALATION_SETTLE_DEFAULT_MS`). Never longer than `escalateMs`:
   *  an ask may not be un-retractable for longer than the silence that filed
   *  it. */
  settleMs?: number;
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
  private readonly settleMs: number;

  constructor(opts: StallEscalationOptions) {
    this.store = opts.store;
    this.path = opts.dataDir === undefined ? null : join(opts.dataDir, STALL_ESCALATION_FILENAME);
    this.escalateMs = opts.escalateMs ?? STALL_ESCALATE_DEFAULT_MS;
    this.settleMs = Math.min(opts.settleMs ?? STALL_ESCALATION_SETTLE_DEFAULT_MS, this.escalateMs);
    this.report = opts.report ?? ((message) => console.error(message));
    this.load();
  }

  /**
   * One board, once per tick. Called from the stall loop with the rows the
   * gate named and when each was told; never throws — a filer that failed
   * must not stop the boards behind it (the caller isolates it too).
   */
  onBoard(board: StallSnapshot, told: ReadonlyMap<string, ToldTime>, now: number): void {
    const key = board.workspaceId;
    const record = this.sidecar[key];
    const prior = record && 'filed' in record ? record.filed : undefined;
    const item = this.liveItem(prior);

    // A RETIRED board withdraws unconditionally, and it is checked before
    // anything else. Standing a board down is the owner saying nobody is
    // working it; an ask about its rows outlives the reason it was filed, and
    // the anchor's own ticket would otherwise keep the item alive forever —
    // the qualifying set goes empty, and `updateLive` re-adds the anchor from
    // the ticket because the gate can no longer see it.
    if (board.retired) {
      if (prior) {
        if (item && isReviewItemOpen(item) && !reviewWithdrawn(item.review))
          this.withdrawItem(key, prior, 'the board was retired');
        this.clear(key, now);
      } else this.save();
      return;
    }

    // Rows the gate names NOW that somebody was told about long enough ago —
    // or that the board has been unable to tell anybody about for that long.
    const fresh = this.qualifying(board, told, now);

    if (prior && item) {
      if (isReviewItemOpen(item) && !reviewWithdrawn(item.review)) {
        this.updateLive(key, prior, item, fresh, now);
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
    told: ReadonlyMap<string, ToldTime>,
    now: number,
  ): EscalatedRow[] {
    const rows: EscalatedRow[] = [];
    for (const row of [...board.unfiled, ...board.stalled]) {
      const stamp = told.get(row.id);
      if (stamp === undefined || now - stamp.at < this.escalateMs) continue;
      // …and STUCK for that long as well. The told clock alone was the whole
      // test, and it is only half the sentence the item goes on to write.
      // `ToldRow.toldAt` is stamped once and never refreshed while the row is
      // remembered, so a row the lead was told about yesterday, and has
      // commented on and moved through statuses all day since, qualified
      // again the moment it went quiet for the GATE's twenty minutes. The
      // premise "the lead was told and nothing moved" was never checked
      // against the row.
      //
      // Measured 2026-09-06: an item whose own body read "Quiet 1h; the lead
      // was told 33h ago" — thirty-two of those hours are the lead answering.
      // A row whose newest write is its own lead's comment or transition is
      // the lead being reachable on that row, which is the one thing this
      // module escalates for the absence of.
      const stuckMs = row.stuckMs ?? row.quietMs;
      if (stuckMs < this.escalateMs) continue;
      rows.push({
        id: row.id,
        title: row.title,
        bucket: row.bucket,
        quietMs: stuckMs,
        toldMs: now - stamp.at,
        delivered: stamp.delivered,
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
   * Can the item still be SEEN where it hangs — a ticket that exists, is not
   * archived, and is not `done`?
   *
   * `done` is not a detail. `taskReviewItems` in `review-queue.ts` skips a
   * done ticket's items outright, so an item left on one is gone from the
   * reader's queue while `isReviewItemOpen` still answers true — the ask
   * becomes invisible, and every other stuck row on the board goes unreported
   * behind an item nobody can see (found in review, reproduced against a real
   * store). When this returns false the item MOVES rather than being revised
   * in place, and it does so on the tick it is seen: an ask nobody can read
   * is not an ask being kept.
   */
  private anchorReachable(prior: Filed): boolean {
    const task = this.store.getTask(prior.taskId);
    if (!task) return false;
    return task.status !== 'done' && task.archivedAt === undefined;
  }

  /**
   * Has anybody ELSE written to the anchor since we last did?
   *
   * Our write set `updatedAt` to `wroteAt`, so a later bump is somebody
   * else's — unless our own item explains it (`ownActivityAt`, which is what
   * keeps a reader's question back on the item from reading as the row
   * moving).
   *
   * This used to be half of `anchorHolds`, and `updateLive` acted on the two
   * halves identically. They are not the same question. An unreachable
   * anchor is a PLACEMENT fact and has to be acted on now; a write to the
   * anchor is a claim that the row is moving again, and one write is a far
   * weaker claim than the hour of silence that filed the item. Answering both
   * with "withdraw immediately" is what produced asks that lived a single
   * pass — see `STALL_ESCALATION_SETTLE_DEFAULT_MS`, which is now the gate on
   * this one.
   *
   * Known limit, stated because the field cannot answer it: `updatedAt`
   * carries no actor, so a note posted by the row's own agent and a takeover
   * by a stranger are the same bump here. The settle window is what makes
   * that tolerable rather than an actor test we have no way to run.
   */
  private anchorUntouched(prior: Filed, item: TaskReviewItem): boolean {
    const task = this.store.getTask(prior.taskId);
    if (!task) return false;
    return task.updatedAt <= Math.max(prior.wroteAt, ownActivityAt(item));
  }

  /** Has this item stood long enough that movement may take it back? See
   *  `STALL_ESCALATION_SETTLE_DEFAULT_MS` for why an ask gets a minimum life
   *  at all. */
  private settled(item: TaskReviewItem, now: number): boolean {
    return now - item.createdAt >= this.settleMs;
  }

  /** Revise the open item to the rows that still qualify, move it when its
   *  anchor no longer holds, or withdraw it when nothing qualifies. */
  private updateLive(
    key: string,
    prior: Filed,
    item: TaskReviewItem,
    fresh: EscalatedRow[],
    now: number,
  ): void {
    // An anchor the reader cannot see is acted on at once, whatever the item's
    // age: keeping an invisible ask is not keeping an ask.
    //
    // A written-to anchor is the other case, and it waits for the item to
    // settle. Re-anchoring or withdrawing on the first write after ours is
    // how a filed ask came back off the queue sixty seconds later. Until the
    // window is out the item is left where it is and revised like any other —
    // and if the row goes quiet again in the meantime, nothing ever retracts
    // it, which is the right answer for a row that posted one note and
    // stopped.
    const unreachable = !this.anchorReachable(prior);
    if (unreachable || (!this.anchorUntouched(prior, item) && this.settled(item, now))) {
      // Re-anchored in the SAME tick and with no cooldown: the cooldown is
      // there to stop a board asking twice about a board-state that keeps
      // flickering, and this is one ask being moved to somewhere the reader
      // can see it. Withdrawing also unmasks the old anchor, which is what
      // lets it come back into a later item under its own name.
      if (fresh.length === 0) {
        this.withdraw(key, prior, now);
        return;
      }
      this.withdrawItem(key, prior, 'moved to a row that is still stuck');
      this.file(key, fresh);
      return;
    }
    const named = fresh.filter((row) => row.id !== prior.taskId);
    const anchor = fresh.find((row) => row.id === prior.taskId) ?? this.anchorRow(prior, now);
    if (anchor) named.unshift(anchor);
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
      // Somebody is looking at it: this item is the ask, and it is on their
      // queue. Whatever the row's history, it is not unreachable now.
      delivered: true,
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
    this.withdrawItem(key, prior, 'the rows it named are moving again');
    // Cleared either way. An item that refuses withdrawal (answered between
    // the read and the write) is closed for the reader already, and keeping
    // the record would leave this board unable to escalate again.
    this.clear(key, now);
  }

  /** Take the item back, without deciding what happens to the record —
   *  a withdrawal precedes both a clear and a re-anchor. */
  private withdrawItem(key: string, prior: Filed, reason: string): void {
    const res = this.store.withdrawReviewItem(prior.taskId, prior.itemId, {
      actor: { ...STALL_ESCALATION_ACTOR },
      reason,
    });
    if (!res.ok)
      this.say(`[stall] escalation withdraw refused ws=${key} item=${prior.itemId}: ${res.error}`);
    else this.say(`[stall] escalation cleared ws=${key} item=${prior.itemId}: ${reason}`);
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
