/**
 * ── Home pane: per-person read markers + the "What's New?" brief ────────────
 *
 * (Approved design: docs/product/mockups/home-pane. Summaries cover
 * everything since the reader last marked caught up; instructions are
 * workspace-wide and editable; generation is the summarizer seam or
 * nothing — a server with no summarizer serves the deterministic brief.)
 *
 * One module because this is one question asked twice: what one person sees
 * on one board's Home tab, and what the brief may CLAIM about it.
 * `reviewItemsFor` is what makes it a family rather than a pile — the queue
 * it builds is both the list `GET /review-items` renders and the denominator
 * `homeQueueTotal` prints, so the number the brief closes with cannot drift
 * from the list drawn under it. Splitting those two apart would be two
 * readings of "what is waiting on me" with nothing asserting they agree.
 *
 * The context is explicit, the same shape `board-membership.ts` and
 * `stall-wiring.ts` use, and every member of it is a VALUE: nothing here is
 * built later than the stores it reads, so `createServer` composes this
 * wherever the stores, the doc store and the summarizer seam are already in hand.
 *
 * `homeBriefInflight`, `homeBriefInput` and `generateHomeBriefFor` stay
 * internal: nothing outside this module reached them inside `createServer`
 * either, and the in-flight set is only correct if exactly one thing owns it.
 */
import { reviewItemState } from '@feedback/core';
import type { DocStore } from './doc-store.ts';
import {
  type BriefCoverage,
  type BriefInput,
  HomeBriefStore,
  acceptBrief,
  briefCoverage,
  briefEvents,
  briefIsFresh,
  buildBriefPrompt,
  deterministicBrief,
  effectiveSince,
  readEventRows,
  readerKey,
} from './home-brief.ts';
import { type ReviewItemRow, reviewItemRows } from './review-queue.ts';
import type { ThreadSummarizer } from './summarize.ts';
import { taskBodyDocId } from './task-projection.ts';
import {
  type BoardWorkspace,
  LEGACY_REVIEW_ITEM_ID,
  type TaskStore,
  legacyDecisionItem,
} from './tasks.ts';

/** What the Home pane reads. Every member is a value — see the note at the
 *  top of this file about why none of them needs to be a thunk. */
export interface HomePaneContext {
  /** Where the read markers, the stored briefs and the events log live. */
  dataDir: string;
  /** The board itself: tasks, goals, review items, decisions. */
  taskStore: TaskStore;
  /** Doc store: the meta a doc's label is read from, and its threads. */
  docStore: DocStore;
  /** The summarizer seam, or null on a server with generation off. A server
   *  with no summarizer serves the deterministic brief and never calls out. */
  summarizer: ThreadSummarizer | null;
}

/** The brief half of `GET /home` — one of two sources, never both. */
export interface HomeBriefView {
  markdown: string;
  generatedAt: number;
  coversFrom: number;
  source: 'generated' | 'deterministic';
}

/** Everything `GET /home` answers. */
export interface HomePayload {
  workspaceId: string;
  lastReadAt: number;
  since: number;
  instructions: string;
  brief: HomeBriefView;
  generating: boolean;
}

/** What `createServer` keeps a handle on. */
export interface HomePane {
  /** The read-marker + stored-brief store, also read by the Home routes. */
  homeBriefs: HomeBriefStore;
  /** The review items exactly as `GET /review-items` ships them. */
  reviewItemsFor: (workspace: BoardWorkspace) => ReviewItemRow[];
  /** How many items the Home queue holds right now, over those items. */
  homeQueueTotal: (workspace: BoardWorkspace, items: ReviewItemRow[]) => number;
  /** Everything `GET /home` answers, brief included. */
  homePayload: (workspace: BoardWorkspace, person: string, now: number) => HomePayload;
}

export function createHomePane(ctx: HomePaneContext): HomePane {
  const { dataDir, taskStore, docStore, summarizer } = ctx;

  const homeBriefs = new HomeBriefStore(dataDir);
  /** One generation in flight per workspace+reader: the client polls while
   *  `generating`, and N polls must cost one call, not N. */
  const homeBriefInflight = new Set<string>();

  /** The review items exactly as GET /review-items ships them.
   *  ONE builder for that route and for the brief's queue count, so the
   *  number the brief prints cannot drift from the queue rendered under it. */
  const reviewItemsFor = (workspace: BoardWorkspace): ReviewItemRow[] =>
    reviewItemRows({
      tasks: taskStore.listTasks(workspace.id).map((t) => ({
        id: t.id,
        title: t.title,
        bodyDocId: taskBodyDocId(t.id),
        done: t.status === 'done',
        // The ticket's OWN review items — 0..n, and for a legacy decision task
        // the one row `listReviewItems` derives from `needs`/`options`/`answer`
        // without writing anything back. This is what lets a decision reach the
        // one route that answers "what is waiting on me"; before it, a board of
        // nothing but open decisions answered with an empty list.
        reviews: taskStore.listReviewItems(t.id),
      })),
      // Goals queue their discussions the same way. Without this a review
      // item declared on a goal — "does 'ten teams' mean ten that renew?" —
      // sits in a thread nothing tells the reader about, which is the whole
      // failure the queue exists to prevent, on the row that matters most.
      // No `reviews`: that array is a task field and a goal row has none.
      goals: taskStore.listGoalRows(workspace.id).map((g) => ({
        id: g.id,
        title: g.title,
        bodyDocId: taskBodyDocId(g.id),
        done: g.status === 'done',
      })),
      docs: workspace.docIds.map((docId) => {
        const meta = docStore.peekMeta(docId);
        // Title, else the file's BASENAME — never `relPath` whole and
        // never `sourceUrl`. Those describe the host machine, and a
        // share visitor reads this route (§3.3): a label is workspace
        // content, a path is not.
        const base = meta?.relPath?.split('/').pop();
        return { docId, title: meta?.title || base || docId };
      }),
      source: {
        threadsOf: (docId) => docStore.listThreads(docId, { status: 'open' }),
        // Unfiltered, and only for the roster: who counts as a person
        // here must not depend on whether their thread is still open.
        allThreadsOf: (docId) => docStore.listThreads(docId),
      },
    });

  /**
   * How many items the Home queue holds right now. Feeds only the brief's
   * closing "is anything waiting" line.
   *
   * The number is a promise about the LIST rendered under it, so it counts
   * exactly what the browser's `reviewQueue` places and nothing else:
   *
   *  - comment-borne review rows (`task-thread` / `doc-thread`) — ALL of
   *    them, which is true again since 2026-08-21: membership moved into
   *    `reviewThreadItems` (a row is a declared item or a surviving direct
   *    ask), and the browser retired its undeclared shelf and places every
   *    row this route ships. Between those two changes this count briefly
   *    included inferred rows Home never drew — "something needs you" over a
   *    list that showed nothing,
   *  - open decisions, which Home draws from the board projection as its own
   *    `decision` rows.
   *
   * Person-owned blockers are deliberately NOT a term. A blocker is task
   * state, not a review item — the browser's `reviewQueue` stopped placing
   * blocker rows when the task panel's blocked note took them over, so a
   * count that still included them pointed the brief ("queued below") at a
   * queue that renders nothing.
   *
   * TICKET-borne rows (`kind: 'task-review'`) count too — Home places them
   * now (`reviewQueue` in board-review-model.ts), which closed the measured gap where
   * a review item filed with `create_tasks` / `add_review_item` was shipped
   * by the route and rendered by nothing. The one exception is the DERIVED
   * `r-legacy` row: its legacy decision is already counted from the tasks
   * below, and the browser skips that row for the same reason, so counting
   * it here would say one question twice.
   *
   * The open-decision term is counted from the TASKS rather than from `items`,
   * even though `items` also carries a derived `r-legacy` row per open
   * decision. Same reason: `decisionQueue` in the browser is what draws those
   * rows, and it reads `needs`/`answer` off the projection. Counting the
   * derived rows instead would tie this number to a row Home does not read.
   * A decision is therefore counted once, never twice.
   */
  const homeQueueTotal = (workspace: BoardWorkspace, items: ReviewItemRow[]): number => {
    const open = taskStore.listTasks(workspace.id).filter((t) => t.status !== 'done');
    // A decision the reader has asked on is the OWNER's turn and off the
    // browser's queue (`decisionRows` reads `decisionState`), so it is not
    // counted here either — the same derivation, on the same row.
    const decisions = open.filter((t) => {
      if (t.needs !== 'decision' || t.answer) return false;
      const item = legacyDecisionItem(t);
      return item === undefined || reviewItemState(item) !== 'waiting';
    });
    const rendered = items.filter(
      (i) => i.kind !== 'task-review' || i.reviewItemId !== LEGACY_REVIEW_ITEM_ID,
    );
    return rendered.length + decisions.length;
  };

  const homeBriefInput = (workspace: BoardWorkspace, since: number): BriefInput => {
    const events = briefEvents(readEventRows(dataDir, workspace.id), since);
    const items = reviewItemsFor(workspace);
    return {
      workspaceId: workspace.id,
      events,
      queue: { total: homeQueueTotal(workspace, items) },
      titleOf: (taskId) => taskStore.getTask(taskId)?.title,
    };
  };

  /** Fire-and-forget one generation; the client re-reads when it lands. */
  const generateHomeBriefFor = (
    workspace: BoardWorkspace,
    person: string,
    marker: number,
    input: BriefInput,
    coverage: BriefCoverage,
  ): void => {
    const key = `${workspace.id}\u0000${readerKey(person)}`;
    if (homeBriefInflight.has(key)) return;
    homeBriefInflight.add(key);
    // The window the model is told about, the window the reader is shown, and
    // the rows the model is handed all come from ONE coverage value. They used
    // to be derived separately and disagreed: this said "the last 7 days"
    // while the digest cap had already cut what the model could see to hours.
    const prompt = buildBriefPrompt(input, homeBriefs.instructions(workspace.id), coverage);
    void (async () => {
      try {
        const accepted = acceptBrief((await summarizer?.generateHomeBrief(prompt)) ?? null);
        // A refused reply stores nothing: the deterministic brief stands, and
        // the next read simply tries again. Never store an empty brief over
        // a rendered one.
        if (accepted !== null) {
          homeBriefs.storeBrief(workspace.id, person, {
            markdown: accepted,
            since: marker,
            coversFrom: coverage.from,
            eventCount: input.events.length,
            generatedAt: Date.now(),
          });
        }
      } finally {
        homeBriefInflight.delete(key);
      }
    })();
  };

  /**
   * Everything GET /home answers, also returned by the instructions PUT so
   * the client repaints from one shape. Freshness keys on the MARKER (not
   * the derived window start, which for a never-read reader slides with the
   * clock and would re-queue a generation on every read) plus the count of
   * brief-relevant events — see BRIEF_EVENT_TYPES for why heartbeats are
   * excluded from that count.
   */
  const homePayload = (workspace: BoardWorkspace, person: string, now: number): HomePayload => {
    const marker = homeBriefs.lastReadAt(workspace.id, person);
    const since = effectiveSince(marker, now);
    const input = homeBriefInput(workspace, since);
    const stored = homeBriefs.brief(workspace.id, person);
    const coverage = briefCoverage(input.events, since);
    const fresh = briefIsFresh(stored, marker, input.events.length);
    // `generating` is grounded in work actually queued — it is true exactly
    // when a call is (or is being put) in flight, never inferred.
    let generating = false;
    if (!fresh && summarizer?.enabled) {
      generating = true;
      generateHomeBriefFor(workspace, person, marker, input, coverage);
    }
    // `coversFrom` is per BRIEF, not per payload, because the two briefs
    // genuinely cover different windows: the deterministic one counts every
    // event in the window, the generated one only the rows that survived the
    // digest cap. A stored brief carries the coverage it was written under —
    // one written before the field existed has no answer, and the window
    // start is the closest honest thing to say.
    const brief = fresh
      ? {
          markdown: stored.markdown,
          generatedAt: stored.generatedAt,
          coversFrom: stored.coversFrom ?? since,
          source: 'generated' as const,
        }
      : {
          markdown: deterministicBrief(input),
          generatedAt: now,
          coversFrom: since,
          source: 'deterministic' as const,
        };
    return {
      workspaceId: workspace.id,
      lastReadAt: marker,
      since,
      instructions: homeBriefs.instructions(workspace.id),
      brief,
      generating,
    };
  };

  return {
    homeBriefs,
    reviewItemsFor,
    homeQueueTotal,
    homePayload,
  };
}
