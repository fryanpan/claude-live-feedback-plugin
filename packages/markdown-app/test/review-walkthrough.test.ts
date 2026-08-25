import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReviewStripHandlers,
  homeReviewData,
  mountHomeReviewIsland,
} from '../src/hub/home-review-island.tsx';
import {
  CHORES_ID,
  type HubTask,
  type ReviewItem,
  type ReviewThreadItem,
  advanceWalk,
  decisionRows,
  reviewQueue,
  walkPosition,
} from '../src/hub/hub-model.ts';
import {
  type WalkthroughHandlers,
  renderReviewWalkthrough,
  renderTaskDetail,
} from '../src/hub/hub-render.ts';
import { refreshMarkdownComposer } from '../src/md-composer.ts';
import { renderedHtml, surfaceOf } from './support/composer.ts';

/** All fixtures are synthetic — invented names and ids throughout. */

const NOW = 1_700_000_000_000;

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function decision(overrides: Partial<HubTask> = {}): HubTask {
  return task({ assignee: 'human', needs: 'decision', ...overrides });
}

/**
 * A thread an agent DECLARED as a review item.
 *
 * Declaring is one of the two ways a thread reaches the queue (the other is a
 * surviving direct ask — the server ships nothing else since 2026-08-21, and
 * the client places every row it ships); `note()` below is the undeclared
 * twin. The headline repeats the `ask` because `ask` IS the headline for a
 * declared item — the queue reads the author's words rather than deriving a
 * title from the comment.
 */
function threadItem(over: Partial<ReviewThreadItem> = {}): ReviewThreadItem {
  const base: ReviewThreadItem = {
    kind: 'task-thread',
    docId: 'task:t-1',
    threadId: 'th-1',
    taskId: 't-1',
    title: 'Ship the widget',
    ask: 'Green or blue?',
    askedBy: 'Helper',
    since: NOW - 60_000,
    band: 'declared',
    commentId: 'c-1',
    review: {
      shape: 'review',
      headline: 'Green or blue?',
      detail: 'The mockup shows one and the build ships the other.',
    },
    ...over,
  };
  // Keep the declaration and the derived title in step when a case overrides
  // the ask, so no fixture can quietly test a card whose head disagrees with
  // its own row.
  if (over.ask !== undefined && over.review === undefined && base.review) {
    base.review = { ...base.review, headline: over.ask };
  }
  return base;
}

/** An ordinary agent comment nobody declared anything on. */
function note(over: Partial<ReviewThreadItem> = {}): ReviewThreadItem {
  const { band, commentId, review, ...rest } = threadItem(over);
  return rest;
}

/** The queue with no threads in it — most cases here are about decisions. */
const q0 = (tasks: HubTask[]) => reviewQueue(tasks, [], NOW);

function strip(over: Partial<ReviewStripHandlers> = {}): ReviewStripHandlers {
  return { onReview: vi.fn(), onOpen: vi.fn(), onWalkthrough: vi.fn(), ...over };
}

/**
 * The pane is a Preact island now. Same call shape the vanilla renderer had,
 * for these cases: write the signal, mount fresh (disposing any previous
 * mount so a case may render twice into the same root).
 */
let disposeIsland: (() => void) | null = null;
function renderHomeReview(
  container: HTMLElement,
  queue: ReturnType<typeof reviewQueue>,
  handlers: ReviewStripHandlers,
  settled: ReviewItem[] = [],
  now: number = NOW,
): void {
  disposeIsland?.();
  homeReviewData.value = { queue, settled, now };
  disposeIsland = mountHomeReviewIsland(container, handlers);
}

function walk(over: Partial<WalkthroughHandlers> = {}): WalkthroughHandlers {
  return {
    onAnswer: vi.fn(),
    onMoreInfo: vi.fn(),
    onReply: vi.fn(),
    onOpenItem: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

let root: HTMLElement;
beforeEach(() => {
  disposeIsland = null;
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

describe('renderHomeReview — the ranked list (mockup anatomy)', () => {
  it('Review All starts the walkthrough; a row opens that one item', () => {
    const onWalkthrough = vi.fn();
    const onReview = vi.fn();
    const d = decision({ title: 'Ship now or wait?' });
    renderHomeReview(root, q0([d, task({ after: [d.id] })]), strip({ onWalkthrough, onReview }));
    (root.querySelector('.hub-review-go') as HTMLElement).click();
    expect(onWalkthrough).toHaveBeenCalledTimes(1);
    const row = root.querySelector('.hub-review-row') as HTMLElement;
    expect(row.textContent).toContain('Ship now or wait?');
    // Derived urgency still travels with the row — "blocks" reads off the
    // edges into the hover title, since the mockup row carries no third line.
    expect(row.title).toContain('Blocking 1 task');
    row.click();
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug this fixes, in one line: tapping a row on Home left Home. Bryan,
   * 2026-08-21 — "tapping on review item in home goes to the resource rather
   * than home review queue for that item." The row is the queue's own handle
   * on an item; going to the underlying task or doc is a second, deliberate
   * tap from inside the card that opens.
   */
  it('a row tap opens the item IN the queue and never navigates to its resource', () => {
    const onReview = vi.fn();
    const onOpen = vi.fn();
    const queue = reviewQueue(
      [decision({ title: 'Ship now or wait?' })],
      [threadItem({ ask: 'Which repo does this land in?' })],
      NOW,
    );
    renderHomeReview(root, queue, strip({ onReview, onOpen }));
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.hub-review-row'));
    expect(rows).toHaveLength(2);
    rows[1]?.click();
    // The item AND where it stands, so the card opens on the row that was
    // tapped rather than at the top of the list.
    expect(onReview).toHaveBeenCalledWith(queue.items[1], 1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  // A settled row has LEFT the queue, so there is no card to open it in —
  // the resource is the only place left to go, and the row stays the way back.
  it('a settled row still goes to the resource', () => {
    const onReview = vi.fn();
    const onOpen = vi.fn();
    const answered: ReviewItem = {
      key: 'decision:t-gone',
      kind: 'decision',
      title: 'Already answered',
      ask: '',
      why: '',
      since: NOW - 3_600_000,
    };
    renderHomeReview(root, q0([]), strip({ onReview, onOpen }), [answered], NOW);
    (root.querySelector('.hub-review-row-done') as HTMLElement).click();
    expect(onOpen).toHaveBeenCalledWith(answered);
    expect(onReview).not.toHaveBeenCalled();
  });

  it('an empty queue renders no rows and says so plainly (Home is a page, not a strip)', () => {
    // Presence first: the section carries rows with one decision.
    renderHomeReview(root, q0([decision()]), strip());
    expect(root.querySelectorAll('.hub-review-row').length).toBeGreaterThan(0);
    renderHomeReview(root, q0([task()]), strip());
    expect(root.querySelectorAll('.hub-review-row')).toHaveLength(0);
    expect(root.querySelector('.hub-home-quiet')?.textContent).toContain(
      'Nothing is waiting for your review',
    );
  });

  // The three kinds are why the queue exists at all: a comment waiting on an
  // answer was in the store and unreachable from the board. Each row keeps
  // its kind class, and a thread row's title is its ASK — the question, not
  // the container (mockup: the row title is the question itself).
  it('carries all three kinds, marked, with the question as the row title', () => {
    const d = decision({ title: 'Blue or green?' });
    const queue = reviewQueue(
      [d],
      [
        threadItem({ ask: 'Which repo does this land in?' }),
        threadItem({
          kind: 'doc-thread',
          docId: 'd-1',
          threadId: 'th-2',
          title: 'Launch plan',
          ask: 'Is this claim still true?',
          since: NOW - 5_000,
        }),
      ],
      NOW,
    );
    renderHomeReview(root, queue, strip());
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.hub-review-row'));
    expect(
      rows.map((c) => c.className.match(/hub-review-(?:decision|task-thread|doc-thread)/)?.[0]),
    ).toEqual(['hub-review-decision', 'hub-review-task-thread', 'hub-review-doc-thread']);
    expect(rows[1]?.querySelector('.hub-review-row-title')?.textContent).toBe(
      'Which repo does this land in?',
    );
    expect(rows[2]?.querySelector('.hub-review-row-title')?.textContent).toBe(
      'Is this claim still true?',
    );
  });

  // A thread blocks nothing structurally; counting it would inflate the one
  // number that is supposed to mean "act now".
  it('counts threads in the total but never in the blocking count', () => {
    const d = decision({ title: 'Blue or green?' });
    const queue = reviewQueue([d, task({ after: [d.id] })], [threadItem()], NOW);
    expect(queue.total).toBe(2);
    expect(queue.blocking).toBe(1);
    renderHomeReview(root, queue, strip());
    expect(root.querySelectorAll('.hub-review-row')).toHaveLength(2);
  });
});

describe('a blocker is task state — off Home, out of the walkthrough (design point 5)', () => {
  /** A human task with `n` open tasks waiting on it. */
  function blocked(over: Partial<HubTask> = {}, n = 1): HubTask[] {
    const gate = task({ assignee: 'human', title: 'Turn on the tunnel', ...over });
    const waits = Array.from({ length: n }, (_, i) =>
      task({ title: `Waiting ${i + 1}`, after: [gate.id] }),
    );
    return [gate, ...waits];
  }

  // A blocker was never a question. Its place is on the TASK — the panel's
  // amber note — not in a queue whose promise is "things you can clear from
  // here".
  it('renders no Home row for a human task other work waits on', () => {
    // Positive control in the same render: a decision row still appears.
    const d = decision({ title: 'Blue or green?' });
    renderHomeReview(root, q0([...blocked({}, 2), d]), strip());
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.hub-review-row'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Blue or green?');
    expect(root.textContent).not.toContain('Turn on the tunnel');
    expect(root.querySelector('.hub-review-blocker')).toBeNull();
  });

  it('does not count a blocker in the blocking number or the total', () => {
    const alone = q0(blocked({}, 2));
    expect(alone.total).toBe(0);
    expect(alone.blocking).toBe(0);
    // Positive control: a decision with a dependent still counts.
    const d = decision({ title: 'Blue or green?' });
    const q = reviewQueue([...blocked({}, 2), d, task({ after: [d.id] })], [], NOW);
    expect(q.total).toBe(1);
    expect(q.blocking).toBe(1);
  });

  it('never renders a blocker card in the walkthrough', () => {
    const d = decision({ title: 'Blue or green?' });
    const q = reviewQueue([...blocked({}, 2), d], [], NOW);
    expect(q.items).toHaveLength(1);
    renderReviewWalkthrough(root, q, 0, walk());
    // The one card is the decision — there is no blocker card to step onto.
    expect(root.querySelector('.hub-walk-card')?.className).toContain('hub-walk-decision');
    expect(root.querySelector('.hub-walk-blocker')).toBeNull();
    expect(root.querySelector('.hub-walk-open')).toBeNull();
    // A board holding ONLY a blocker walks straight to the done state.
    renderReviewWalkthrough(root, q0(blocked({}, 2)), 0, walk());
    expect(root.querySelector('.hub-walk-card')).toBeNull();
    expect(root.querySelector('.hub-walk-done')).not.toBeNull();
  });
});

describe('renderTaskDetail — the same options, from the other entrance', () => {
  it('offers the asker’s options in the detail panel, not only in the walkthrough', () => {
    const onAnswer = vi.fn();
    const d = decision({
      title: 'Blue or green?',
      options: [{ id: 'o-1', label: 'Ship it blue' }],
    });
    const handlers = {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer,
      onAssign: vi.fn(),
    };
    renderTaskDetail(root, d, handlers);
    // Presence first: the free-text form is there either way.
    expect(root.querySelector('.hub-answer-form')).not.toBeNull();
    const opt = root.querySelector('.hub-decide-option') as HTMLElement;
    expect(opt.textContent).toContain('Ship it blue');
    opt.click();
    expect(onAnswer).toHaveBeenCalledWith(d, 'Ship it blue', 'o-1');

    // A decision with no options renders none — the block is conditional, not
    // an empty shell.
    renderTaskDetail(root, decision({ title: 'Rename the tab?' }), handlers);
    expect(root.querySelector('.hub-decide-option')).toBeNull();
  });
});

/**
 * The approved mockup (home-pane-mockup-v1) is the acceptance bar here, and
 * the build before this one missed it in the two ways Bryan named: "The
 * button text doesn't match the last mockup. The layout is weird too."
 *
 * So both halves are pinned: the verbatim copy, and the fact that this is a
 * PAGE inside the Home column rather than a dialog over the board. Paraphrase
 * is the failure mode — every string below is quoted from the mockup, and a
 * rewording is a regression even when it reads better.
 */
describe('the walkthrough matches the approved mockup', () => {
  const blockingDecision = () => {
    const d = decision({ title: 'Blue or green?' });
    return q0([d, task({ after: [d.id], title: 'Build the badge' })]);
  };

  it('is a page with a way back, not a dialog over the board', () => {
    const onClose = vi.fn();
    renderReviewWalkthrough(root, blockingDecision(), 0, walk({ onClose }));
    // A dialog is what got rejected. Nothing here may claim that role, and
    // the way out is a link rather than a dismiss.
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(root.querySelector('[aria-modal]')).toBeNull();
    const home = root.querySelector('.hub-walk-home') as HTMLElement;
    expect(home.textContent).toBe('‹ Back to Home');
    home.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    // "Review", with the ‹ N of M › stepper beside it.
    expect((root.querySelector('.hub-walk-heading') as HTMLElement).textContent).toBe('Review');
    expect((root.querySelector('.hub-walk-back') as HTMLElement).textContent).toBe('‹');
    expect((root.querySelector('.hub-walk-pos') as HTMLElement).textContent).toBe('1 of 1');
    expect((root.querySelector('.hub-walk-skip') as HTMLElement).textContent).toBe('›');
  });

  it('badges the kind, chips the context, and puts the asked-by meta in the head', () => {
    renderReviewWalkthrough(
      root,
      blockingDecision(),
      0,
      walk({ contextLabel: () => 'Home pane' }),
      { cleared: 0, last: null },
      NOW,
    );
    const badge = root.querySelector('.hub-walk-k-decision') as HTMLElement;
    expect(badge.textContent).toBe('Decision');
    expect((root.querySelector('.hub-walk-k-count') as HTMLElement).textContent).toBe('Home pane');
    // The head's top-right meta is the one provenance line the card carries:
    // "Asked by <who> N days ago" — never the bare "waiting" wording.
    const wait = root.querySelector('.hub-walk-wait') as HTMLElement;
    expect(wait.textContent).not.toContain('waiting');
    // The fixture's decision has no recorded actor, so the meta states the
    // clock without inventing a name.
    expect(wait.textContent).toBe('Asked moments ago');

    renderReviewWalkthrough(root, reviewQueue([], [threadItem({ direct: true })], NOW), 0, walk());
    // A declared item reads as what it declared, not as the surface it arrived
    // on — the same words a declared decision on a task would carry. The label
    // is 'Question' since Bryan's 2026-08-21 rename; the tone token (and so
    // the class name) deliberately stays 'review'.
    expect((root.querySelector('.hub-walk-k-review') as HTMLElement).textContent).toBe('Question');
    // The chip is left out rather than filled with a placeholder when there
    // is no body of work to name.
    expect(root.querySelector('.hub-walk-k-count')).toBeNull();
  });

  it('says Send and Skip for now, on both card kinds', () => {
    for (const queue of [blockingDecision(), reviewQueue([], [threadItem()], NOW)]) {
      renderReviewWalkthrough(root, queue, 0, walk());
      const send = root.querySelector('.hub-walk-answer .hub-btn') as HTMLElement;
      expect(send.textContent).toBe('Send');
      // Ink-dark like the mockup's `.btn.primary`, not the accent blue the
      // rejected build used.
      expect(send.className).toContain('hub-btn-ink');
      expect((root.querySelector('.hub-walk-skip-link') as HTMLElement).textContent).toBe(
        'Skip for now',
      );
    }
  });

  it('Skip for now steps to the next item', () => {
    const onStep = vi.fn();
    renderReviewWalkthrough(root, blockingDecision(), 0, walk({ onStep }));
    (root.querySelector('.hub-walk-skip-link') as HTMLElement).click();
    expect(onStep).toHaveBeenCalledWith(1);
  });
});

describe('renderReviewWalkthrough — decisions', () => {
  const OPTIONS = [
    { id: 'o-1', label: 'Ship it blue', detail: 'Matches the rest of the board' },
    { id: 'o-2', label: 'Ship it green' },
  ];

  function queueOfThree() {
    const a = decision({ title: 'Blue or green?', options: OPTIONS, body: 'Which **colour**?' });
    const b = decision({ title: 'Rename the tab?' });
    const c = decision({ title: 'Drop the old export?' });
    return {
      a,
      b,
      c,
      q: q0([a, b, c, task({ after: [a.id], title: 'Build the badge' })]),
    };
  }

  /** The task on the card at `index` — the queue orders, the test reads. */
  const taskAt = (q: ReturnType<typeof q0>, i: number) => q.items[i]?.decision?.task;

  it('shows where you are and the body, with no provenance block in between', () => {
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 0, walk());
    expect((root.querySelector('.hub-walk-pos') as HTMLElement).textContent).toBe('1 of 3');
    // The left-bordered ctx block is gone — one head row, one body (approved
    // design). What the decision blocks still reads off the Home row's title.
    expect(root.querySelector('.hub-walk-ctx')).toBeNull();
    expect((root.querySelector('.hub-walk-body') as HTMLElement).innerHTML).toContain(
      '<strong>colour</strong>',
    );
  });

  // The card is where a row tap lands now, so it owes the reader a way on to
  // the task. A decision card had none at all: the Home row was the only route
  // from the queue to the task, and the row no longer navigates.
  it('carries a pointer out to its task', () => {
    const onOpenItem = vi.fn();
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 0, walk({ onOpenItem }));
    const where = root.querySelector('.hub-walk-where') as HTMLElement;
    expect(where.textContent).toContain('Task:');
    const open = root.querySelector('.hub-walk-where-link') as HTMLElement;
    // The subject IS the question on a decision, so naming it would print the
    // same words the headline already carries — the link says what it does.
    expect(open.textContent).toContain('Open the task');
    open.click();
    expect(onOpenItem).toHaveBeenCalledWith(q.items[0]);
  });

  it('offers the options as taps AND keeps a free-text answer — options are a shortcut, not a closed set', () => {
    const onAnswer = vi.fn();
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 0, walk({ onAnswer }));
    const opts = root.querySelectorAll<HTMLElement>('.hub-walk-option');
    expect(opts).toHaveLength(2);
    expect(opts[0]?.textContent).toContain('Ship it blue');
    expect(opts[0]?.textContent).toContain('Matches the rest of the board');
    opts[1]?.click();
    // The verbatim answer is still recorded — the option id rides along with it.
    expect(onAnswer).toHaveBeenCalledWith(taskAt(q, 0), 'Ship it green', 'o-2');

    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Neither — use the accent colour';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onAnswer).toHaveBeenLastCalledWith(taskAt(q, 0), 'Neither — use the accent colour');
  });

  it('a decision with no options still takes an answer', () => {
    const onAnswer = vi.fn();
    const { q } = queueOfThree();
    const i = q.items.findIndex((r) => r.title === 'Rename the tab?');
    renderReviewWalkthrough(root, q, i, walk({ onAnswer }));
    expect(root.querySelectorAll('.hub-walk-option')).toHaveLength(0);
    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Yes, rename it';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onAnswer).toHaveBeenCalledWith(taskAt(q, i), 'Yes, rename it');
  });

  it('asking for more information is not an answer', () => {
    const onMoreInfo = vi.fn();
    const onAnswer = vi.fn();
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 0, walk({ onMoreInfo, onAnswer }));
    const form = root.querySelector('.hub-walk-info') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'What does green cost us?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onMoreInfo).toHaveBeenCalledWith(taskAt(q, 0), 'What does green cost us?');
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('an empty answer or question submits nothing', () => {
    const h = walk();
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 0, h);
    for (const sel of ['.hub-walk-answer', '.hub-walk-info']) {
      const form = root.querySelector(sel) as HTMLFormElement;
      (form.querySelector('textarea') as HTMLTextAreaElement).value = '   ';
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
    expect(h.onAnswer).not.toHaveBeenCalled();
    expect(h.onMoreInfo).not.toHaveBeenCalled();
  });

  // The board repaints the walkthrough on every SSE event — a task moving, a
  // presence change — and each repaint rebuilds the card from scratch. The
  // reader in the middle of a sentence must not lose it (measured: Bryan lost
  // a decision answer repeatedly, 2026-08-24).
  describe('a repaint under the typist keeps the draft', () => {
    it('a decision answer survives a re-render', () => {
      const { q } = queueOfThree();
      renderReviewWalkthrough(root, q, 0, walk());
      const ta = root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement;
      ta.value = 'Neither — half-typed thought';
      renderReviewWalkthrough(root, q, 0, walk());
      const after = root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement;
      expect(after).not.toBe(ta);
      expect(after.value).toBe('Neither — half-typed thought');
    });

    it('a thread reply survives a re-render', () => {
      const q = reviewQueue([], [threadItem()], NOW);
      renderReviewWalkthrough(root, q, 0, walk());
      const ta = root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement;
      ta.value = 'Green, because';
      renderReviewWalkthrough(root, q, 0, walk());
      expect((root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement).value).toBe(
        'Green, because',
      );
    });

    it('the more-info box keeps its draft AND stays open', () => {
      const { q } = queueOfThree();
      renderReviewWalkthrough(root, q, 0, walk());
      (root.querySelector('.hub-walk-more') as HTMLElement).click();
      const info = root.querySelector('.hub-walk-info') as HTMLFormElement;
      expect(info.classList.contains('hidden')).toBe(false);
      (info.querySelector('textarea') as HTMLTextAreaElement).value = 'What does green cost';
      renderReviewWalkthrough(root, q, 0, walk());
      const rebuilt = root.querySelector('.hub-walk-info') as HTMLFormElement;
      expect((rebuilt.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
        'What does green cost',
      );
      // A restored draft inside a re-hidden panel is still a lost draft.
      expect(rebuilt.classList.contains('hidden')).toBe(false);
      expect(
        (root.querySelector('.hub-walk-more') as HTMLElement).getAttribute('aria-expanded'),
      ).toBe('true');
    });

    it('a draft never follows the reader onto a different card', () => {
      const { q } = queueOfThree();
      renderReviewWalkthrough(root, q, 0, walk());
      (root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement).value = 'For card A';
      renderReviewWalkthrough(root, q, 1, walk());
      expect((root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement).value).toBe(
        '',
      );
    });
  });

  it('steps forward and back, and cannot step before the first', () => {
    const onStep = vi.fn();
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 0, walk({ onStep }));
    expect((root.querySelector('.hub-walk-back') as HTMLButtonElement).disabled).toBe(true);
    (root.querySelector('.hub-walk-skip') as HTMLElement).click();
    expect(onStep).toHaveBeenCalledWith(1);

    renderReviewWalkthrough(root, q, 1, walk({ onStep }));
    const back = root.querySelector('.hub-walk-back') as HTMLButtonElement;
    expect(back.disabled).toBe(false);
  });

  it('reports the info already asked for, so the same question is not sent twice', () => {
    const { a, b, c } = queueOfThree();
    a.infoRequests = [{ text: 'What does green cost us?', by: 'Bryan', ts: NOW }];
    renderReviewWalkthrough(root, q0([a, b, c]), 0, walk());
    expect((root.querySelector('.hub-walk-asked') as HTMLElement).textContent).toContain(
      'What does green cost us?',
    );
  });

  it('lands on a done state once the queue empties, and closes from it', () => {
    const onClose = vi.fn();
    // Presence first: with items left, the done panel is absent and a card shows.
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 0, walk({ onClose }));
    expect(root.querySelector('.hub-walk-done')).toBeNull();
    expect(root.querySelector('.hub-walk-card')).not.toBeNull();

    renderReviewWalkthrough(root, q0([task()]), 0, walk({ onClose }));
    expect(root.querySelector('.hub-walk-done')).not.toBeNull();
    expect(root.querySelector('.hub-walk-card')).toBeNull();
    (root.querySelector('.hub-walk-done button') as HTMLElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('walking past the end lands on the done state rather than rendering nothing', () => {
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 3, walk());
    expect(root.querySelector('.hub-walk-done')).not.toBeNull();
  });

  it('a negative index means closed — the container hides', () => {
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 0, walk());
    expect(root.classList.contains('hidden')).toBe(false);
    renderReviewWalkthrough(root, q, -1, walk());
    expect(root.classList.contains('hidden')).toBe(true);
    expect(root.children).toHaveLength(0);
  });

  it('the walkthrough opens on the highest-priority ask, not the most-blocked one', () => {
    // Bryan, 2026-08-18: "Always order asks by task priority." The fixture
    // makes the two candidate rules disagree — `c` is the only decision
    // anything is waiting on, and `a` is the one highest on the board — so
    // the card that opens says which rule ran. Under the previous rule
    // (most-blocked first) this card is "Drop the old export?".
    const { a, b, c } = queueOfThree();
    const q = q0([a, b, c, task({ after: [c.id] })]);
    expect(decisionRows([a, b, c]).map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(a.order).toBeLessThan(c.order);
    renderReviewWalkthrough(root, q, 0, walk());
    expect((root.querySelector('.hub-walk-title') as HTMLElement).textContent).toBe(
      'Blue or green?',
    );
    // The whole queue is still the strip's, so the count and the cards cannot
    // drift apart — that half of the original assertion is unchanged.
    expect(q.items.map((i) => i.decision?.task.id)).toEqual([a.id, b.id, c.id]);
  });
});

describe('renderReviewWalkthrough — comments', () => {
  const queueOf = (...items: ReviewThreadItem[]) => reviewQueue([], items, NOW);

  it('shows the question, who asked, and how long it has waited', () => {
    // `direct` is what makes this a question rather than a status note, which
    // is what the card claims by saying "asked". The companion below pins the
    // other wording, so the two cannot quietly converge.
    renderReviewWalkthrough(root, queueOf(threadItem({ direct: true })), 0, walk());
    // The card's heading is the QUESTION (mockup: the card title is the ask);
    // the thing it was asked ON is the Task link below it.
    expect((root.querySelector('.hub-walk-title') as HTMLElement).textContent).toBe(
      'Green or blue?',
    );
    expect((root.querySelector('.hub-walk-where') as HTMLElement).textContent).toContain(
      'Ship the widget',
    );
    // A one-line question fits in the heading, so the card does not also quote
    // it underneath — that is the same words twice on a small screen.
    expect(root.querySelector('.hub-walk-ask')).toBeNull();
    const meta = root.querySelector('.hub-walk-wait') as HTMLElement;
    expect(meta.textContent).toContain('Asked by Helper');
    // The decision-only furniture is absent: there is no options block and no
    // "not enough to decide" form on a comment.
    expect(root.querySelector('.hub-walk-info')).toBeNull();
    expect(root.querySelector('.hub-walk-options')).toBeNull();
  });

  // A typed question is regularly a paragraph. The mockup's card is a SHORT
  // title plus the ask in full, and we have no short title to read — so the
  // heading is derived and the quote carries the words.
  // This is also the MEMBERSHIP pin: a direct ask that nobody declared is a
  // real queue row now (the server only ships surviving asks, and the client
  // places every row it ships), so Review All reaches this card through
  // `reviewQueue` itself — no forced queue, no shelf it could hide on.
  it('walks an undeclared direct ask, headlined short with the whole question quoted', () => {
    const ask =
      'The card head puts the wait at the end of the line, which wraps onto its own row at 430px. ' +
      'Do you want it kept there, or moved under the title where it has the width?';
    const queue = reviewQueue([], [note({ ask, direct: true })], NOW);
    expect(queue.items).toHaveLength(1);
    expect(queue.total).toBe(1);
    renderReviewWalkthrough(root, queue, 0, walk());
    const title = (root.querySelector('.hub-walk-title') as HTMLElement).textContent ?? '';
    expect(title.length).toBeLessThan(ask.length);
    expect(title.startsWith('The card head puts the wait')).toBe(true);
    // Nothing is lost: the quote is verbatim, and the two really do differ, so
    // this is not the same string rendered twice.
    expect((root.querySelector('.hub-walk-ask') as HTMLElement).textContent).toBe(ask);
    expect(title).not.toBe(ask);
  });

  // An INFERRED note must not be announced as a question — "Helper asked you"
  // over a deploy note is the card promising something answerable and
  // delivering something that is not. A DECLARED item is the opposite case:
  // a declaration IS an ask, in so many words, whatever `direct` measured.
  it('does not call an inferred status note a question, but a declaration is always an ask', () => {
    // Through `reviewQueue` itself: the demoted shelf this used to force a row
    // out of is gone since 2026-08-21 — the client places every row the server
    // ships — so the inferred card is reached the way a reader reaches it.
    const undeclared = reviewQueue([], [note({ ask: 'Merged and deployed.' })], NOW);
    expect(undeclared.items).toHaveLength(1);
    renderReviewWalkthrough(root, undeclared, 0, walk());
    const meta = root.querySelector('.hub-walk-wait') as HTMLElement;
    expect(meta.textContent).toContain('Posted by Helper');
    expect(meta.textContent).not.toMatch(/asked/i);

    // The declared twin of the same words says Asked — declaring is asking.
    renderReviewWalkthrough(root, queueOf(threadItem({ ask: 'Merged and deployed.' })), 0, walk());
    expect((root.querySelector('.hub-walk-wait') as HTMLElement).textContent).toContain(
      'Asked by Helper',
    );
  });

  // Going through the queue must not mean leaving the queue on every item —
  // that is the scrolling-back-through-history problem this replaced.
  it('answers in place, and an empty reply posts nothing', () => {
    const onReply = vi.fn();
    const item = threadItem();
    const queue = queueOf(item);
    renderReviewWalkthrough(root, queue, 0, walk({ onReply }));
    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = '   ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onReply).not.toHaveBeenCalled();
    ta.value = 'Blue, to match the board';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onReply).toHaveBeenCalledWith(queue.items[0], 'Blue, to match the board');
  });

  it('offers the way out to where the comment lives, named for that surface', () => {
    const onOpenItem = vi.fn();
    const queue = queueOf(threadItem());
    renderReviewWalkthrough(root, queue, 0, walk({ onOpenItem }));
    // Mockup: the link is the thing itself — `Task: <title> ↗` — so the
    // surface is named by the label and the destination by the link.
    expect((root.querySelector('.hub-walk-where') as HTMLElement).textContent).toContain('Task:');
    const open = root.querySelector('.hub-walk-where-link') as HTMLElement;
    expect(open.textContent).toContain('Ship the widget');
    open.click();
    expect(onOpenItem).toHaveBeenCalledWith(queue.items[0]);

    renderReviewWalkthrough(
      root,
      queueOf(threadItem({ kind: 'doc-thread', docId: 'd-1', title: 'Launch plan' })),
      0,
      walk({ onOpenItem }),
    );
    expect((root.querySelector('.hub-walk-where') as HTMLElement).textContent).toContain('Doc:');
    expect((root.querySelector('.hub-walk-where-link') as HTMLElement).textContent).toContain(
      'Launch plan',
    );
    // Not `.hub-walk-open` — that class left with the blocker card, and this
    // link keeps its own class so a shared selector cannot come back and turn
    // the button into bare text again (measured on staging at 430px).
    expect(root.querySelector('.hub-walk-open')).toBeNull();
  });

  // This card used to render no way out at all, on the grounds that naming the
  // subject repeats the question. True of the words — and it made the card a
  // dead end the moment the queue row stopped navigating.
  it('still offers the way out when the subject IS the question', () => {
    const onOpenItem = vi.fn();
    const queue = queueOf(threadItem({ title: 'Green or blue?', ask: 'Green or blue?' }));
    renderReviewWalkthrough(root, queue, 0, walk({ onOpenItem }));
    const open = root.querySelector('.hub-walk-where-link') as HTMLElement;
    expect(open.textContent).toContain('Open the task');
    open.click();
    expect(onOpenItem).toHaveBeenCalledWith(queue.items[0]);
  });

  // The nav is the feature: "there's a way for me to go through that list".
  // It must keep working when the next item is a comment rather than a
  // decision, which is exactly what a per-kind early return can break.
  it('keeps back / skip on a comment card', () => {
    const onStep = vi.fn();
    const queue = reviewQueue(
      [decision({ title: 'Blue or green?' })],
      [threadItem(), threadItem({ threadId: 'th-3', since: NOW - 10 })],
      NOW,
    );
    renderReviewWalkthrough(root, queue, 1, walk({ onStep }));
    // Presence first: the card under the nav really is the comment one.
    expect(root.querySelector('.hub-walk-card')?.className).toContain('hub-walk-task-thread');
    expect((root.querySelector('.hub-walk-back') as HTMLButtonElement).disabled).toBe(false);
    (root.querySelector('.hub-walk-skip') as HTMLElement).click();
    expect(onStep).toHaveBeenCalledWith(2);
    (root.querySelector('.hub-walk-back') as HTMLElement).click();
    expect(onStep).toHaveBeenLastCalledWith(0);
  });
});

/**
 * Advancing is only half of it. "The UX should make it clear that I'm doing
 * that" is the other half, and it is the one that gets dropped — if the next
 * item simply appears where the last one was, the surface reads as "my answer
 * did nothing" or "the page reset", which is worse than not advancing because
 * the reader cannot tell whether their answer landed.
 */
describe('renderReviewWalkthrough — saying that the advance happened', () => {
  const twoDecisions = () =>
    reviewQueue(
      [decision({ title: 'Blue or green?' }), decision({ title: 'Ship Friday?' })],
      [],
      NOW,
    );

  it('says nothing about progress before anything has been cleared', () => {
    renderReviewWalkthrough(root, twoDecisions(), 0, walk());
    expect(root.querySelector('.hub-walk-advanced')).toBeNull();
    expect(root.querySelector('.hub-walk-cleared')).toBeNull();
    // Positive control: the card IS rendered, so the two absences above are
    // about progress rather than about an empty panel.
    expect(root.querySelector('.hub-walk-title')?.textContent).toBe('Blue or green?');
  });

  it('names what was just finished, above the item that replaced it', () => {
    const queue = twoDecisions();
    const done = reviewQueue([decision({ title: 'Ship Friday?' })], [], NOW);
    renderReviewWalkthrough(root, done, 0, walk(), {
      cleared: 1,
      last: queue.items[0] as ReviewItem,
    });
    const banner = root.querySelector('.hub-walk-advanced') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Answered');
    expect(banner.textContent).toContain('Blue or green?');
    // And the new card is underneath it, not replaced by it.
    expect(root.querySelector('.hub-walk-title')?.textContent).toBe('Ship Friday?');
  });

  it('counts up as the queue counts down, so one number says you moved', () => {
    const done = reviewQueue([decision({ title: 'Ship Friday?' })], [], NOW);
    renderReviewWalkthrough(root, done, 0, walk(), { cleared: 3, last: null });
    const pos = root.querySelector('.hub-walk-pos') as HTMLElement;
    expect(pos.textContent).toContain('1 of 1');
    expect((root.querySelector('.hub-walk-cleared') as HTMLElement).textContent).toContain('3');
  });

  it('reads a reply differently from an answer — it was not a decision', () => {
    const queue = reviewQueue([], [threadItem({ title: 'Ship the widget' })], NOW);
    renderReviewWalkthrough(root, reviewQueue([], [], NOW), 0, walk(), {
      cleared: 1,
      last: queue.items[0] as ReviewItem,
    });
    expect((root.querySelector('.hub-walk-advanced') as HTMLElement).textContent).toContain(
      'Replied on',
    );
  });

  /**
   * The acceptance line "going back to the item just answered is possible".
   * Back cannot do it: answering took the item OUT of the queue, so stepping
   * back lands on whatever preceded it.
   */
  it('offers a way back to the item just answered, which Back can no longer reach', () => {
    const onOpenItem = vi.fn();
    const onStep = vi.fn();
    const queue = twoDecisions();
    const answered = queue.items[0] as ReviewItem;
    const done = reviewQueue([decision({ title: 'Ship Friday?' })], [], NOW);
    renderReviewWalkthrough(root, done, 0, walk({ onOpenItem, onStep }), {
      cleared: 1,
      last: answered,
    });
    (root.querySelector('.hub-walk-advanced-back') as HTMLElement).click();
    expect(onOpenItem).toHaveBeenCalledWith(answered);
    // Not a step: the answered item is not at index -1 or anywhere else in
    // this queue, so a positional move could not have reached it.
    expect(onStep).not.toHaveBeenCalled();
  });

  it('finishes with a count, so the end of a sitting is an ending', () => {
    renderReviewWalkthrough(root, reviewQueue([], [], NOW), 0, walk(), { cleared: 4, last: null });
    const done = root.querySelector('.hub-walk-done') as HTMLElement;
    expect(done.textContent).toContain('All caught up');
    expect((root.querySelector('.hub-walk-done-tally') as HTMLElement).textContent).toContain('4');
  });

  /**
   * Answering the LAST one lands on the finished screen, which makes it the
   * likeliest moment to want the item back — and the one place a card-only
   * banner would silently not appear.
   */
  it('names the last one on the finished screen too, with the way back to it', () => {
    const onOpenItem = vi.fn();
    const answered = reviewQueue([decision({ title: 'Blue or green?' })], [], NOW)
      .items[0] as ReviewItem;
    renderReviewWalkthrough(root, reviewQueue([], [], NOW), 0, walk({ onOpenItem }), {
      cleared: 1,
      last: answered,
    });
    expect(root.querySelector('.hub-walk-done')).toBeTruthy();
    const banner = root.querySelector('.hub-walk-advanced') as HTMLElement;
    expect(banner.textContent).toContain('Blue or green?');
    (root.querySelector('.hub-walk-advanced-back') as HTMLElement).click();
    expect(onOpenItem).toHaveBeenCalledWith(answered);
  });

  it('a sitting that cleared nothing does not claim a tally', () => {
    renderReviewWalkthrough(root, reviewQueue([], [], NOW), 0, walk());
    expect(root.querySelector('.hub-walk-done')).toBeTruthy();
    expect(root.querySelector('.hub-walk-done-tally')).toBeNull();
  });
});

/**
 * The advance must FOLLOW the write, never race it — an advance is the
 * confirmation that the answer landed. These cover the composer's half of that
 * contract; the advance itself is `advanceWalk`, below.
 */
describe('the walkthrough composer — one answer per tap, and no lost words', () => {
  it('locks while the write is in flight, so a second tap is not a second answer', async () => {
    let release: (ok: boolean) => void = () => {};
    const onAnswer = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    renderReviewWalkthrough(root, reviewQueue([decision()], [], NOW), 0, walk({ onAnswer }));
    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Blue.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(ta.disabled).toBe(true);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    release(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.disabled).toBe(false);
    expect(ta.value).toBe('');
  });

  it('a repaint during the write does not resurrect the submitted text as a draft', async () => {
    let release: (ok: boolean) => void = () => {};
    const onAnswer = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    const q = reviewQueue([decision()], [], NOW);
    renderReviewWalkthrough(root, q, 0, walk({ onAnswer }));
    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Blue.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // The board repaints while the write is in flight. The rebuilt form's
    // in-flight lock is gone with the old DOM, so restoring the submitted
    // text here would hand the reader an enabled duplicate-submit path — and
    // the eventual success would clear only the detached old box.
    renderReviewWalkthrough(root, q, 0, walk({ onAnswer }));
    const rebuilt = root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement;
    expect(rebuilt.value).toBe('');
    release(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(rebuilt.value).toBe('');
  });

  it('a refusal that lands after a repaint puts the words back in the LIVE box', async () => {
    let release: (ok: boolean) => void = () => {};
    const onAnswer = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    const q = reviewQueue([decision()], [], NOW);
    renderReviewWalkthrough(root, q, 0, walk({ onAnswer }));
    const ta = root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement;
    ta.value = 'Blue.';
    (root.querySelector('.hub-walk-answer') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    renderReviewWalkthrough(root, q, 0, walk({ onAnswer }));
    release(false);
    await new Promise((r) => setTimeout(r, 0));
    // Restoring only the detached old textarea leaves the reader looking at
    // an empty card with their refused answer nowhere.
    const rebuilt = root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement;
    expect(rebuilt).not.toBe(ta);
    expect(rebuilt.value).toBe('Blue.');
  });

  it('a refusal never clobbers words typed after the repaint', async () => {
    let release: (ok: boolean) => void = () => {};
    const onAnswer = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    const q = reviewQueue([decision()], [], NOW);
    renderReviewWalkthrough(root, q, 0, walk({ onAnswer }));
    (root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement).value = 'Blue.';
    (root.querySelector('.hub-walk-answer') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    renderReviewWalkthrough(root, q, 0, walk({ onAnswer }));
    const rebuilt = root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement;
    rebuilt.value = 'Actually, green';
    release(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(rebuilt.value).toBe('Actually, green');
  });

  it('keeps the words when the write REJECTS, not only when it is refused', async () => {
    const onAnswer = vi.fn(() => Promise.reject(new Error('network')));
    renderReviewWalkthrough(root, reviewQueue([decision()], [], NOW), 0, walk({ onAnswer }));
    const ta = root.querySelector('.hub-walk-answer textarea') as HTMLTextAreaElement;
    ta.value = 'Green, because the tunnel is up.';
    (root.querySelector('.hub-walk-answer') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.value).toBe('Green, because the tunnel is up.');
    expect(ta.disabled).toBe(false);
  });

  it('keeps the words when the write is refused', async () => {
    const onAnswer = vi.fn(() => Promise.resolve(false));
    renderReviewWalkthrough(root, reviewQueue([decision()], [], NOW), 0, walk({ onAnswer }));
    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Green, because the tunnel is up.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.value).toBe('Green, because the tunnel is up.');
    expect(ta.disabled).toBe(false);
  });
});

/**
 * Design point 4 (approved design, review-flow-mock-v1): every composer is a
 * live markdown editor. The walkthrough has two — the answer box and the
 * "Tell me more" ask box — and both go through the same
 * `attachMarkdownComposer`, so they cannot drift apart.
 */
describe('the walkthrough composers are markdown editors', () => {
  it('the answer box edits what you type as markdown', () => {
    renderReviewWalkthrough(root, reviewQueue([decision()], [], NOW), 0, walk());
    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    expect(surfaceOf(ta)?.querySelector('.ProseMirror')).not.toBeNull();
    ta.value = '**two hops**';
    refreshMarkdownComposer(ta);
    expect(renderedHtml(ta)).toContain('<strong>two hops</strong>');
  });

  it('a successful send empties the editor along with the box', async () => {
    const onAnswer = vi.fn(() => Promise.resolve(true));
    renderReviewWalkthrough(root, reviewQueue([decision()], [], NOW), 0, walk({ onAnswer }));
    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Blue, **final**.';
    refreshMarkdownComposer(ta);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.value).toBe('');
    expect(renderedHtml(ta)).not.toContain('final');
  });

  it('the Tell me more box is the same editor', () => {
    renderReviewWalkthrough(root, reviewQueue([decision()], [], NOW), 0, walk());
    const info = root.querySelector('.hub-walk-info') as HTMLFormElement;
    const ta = info.querySelector('textarea') as HTMLTextAreaElement;
    expect(surfaceOf(ta)?.querySelector('.ProseMirror')).not.toBeNull();
  });

  it('a declared item card gets the same composer', () => {
    const q = reviewQueue([task({ id: 't-1' })], [threadItem()], NOW);
    renderReviewWalkthrough(root, q, 0, walk());
    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    expect(surfaceOf(ta)?.querySelector('.ProseMirror')).not.toBeNull();
  });
});

/**
 * The advance is the feature — "when I submit an answer to a request I should
 * go to the next request in priority order" — and the whole difficulty is that
 * the list edits itself underneath the reader. These are pure so the off-by-one
 * is settled by a test rather than by watching a card swap in a browser.
 */
describe('walkPosition — an index is not a position on a list that shrinks', () => {
  const q = (n: number) =>
    reviewQueue(
      Array.from({ length: n }, (_, i) => decision({ title: `D${i}` })),
      [],
      NOW,
    );

  it('follows the aimed item when something before it drops out', () => {
    const before = q(3);
    const aim = before.items[2]?.key ?? null;
    expect(walkPosition(before, 2, aim)).toBe(2);
    // A peer answers the FIRST one. The same index would now show a different
    // card, and the reader would never learn that the one they were reading
    // moved rather than vanished.
    const after = reviewQueue(
      [before.items[1]?.decision?.task as HubTask, before.items[2]?.decision?.task as HubTask],
      [],
      NOW,
    );
    expect(after.items[1]?.key).toBe(aim);
    expect(walkPosition(after, 2, aim)).toBe(1);
  });

  it('falls back to the index when the aimed item is gone', () => {
    expect(walkPosition(q(3), 1, 'decision:t-nope')).toBe(1);
  });

  it('clamps past the end to the done state rather than to the last card', () => {
    expect(walkPosition(q(2), 9, null)).toBe(2);
  });

  it('stays closed on a repaint — a negative index is not a position to resolve', () => {
    const queue = q(2);
    expect(walkPosition(queue, -1, null)).toBe(-1);
    expect(walkPosition(queue, -1, queue.items[0]?.key ?? null)).toBe(-1);
  });
});

describe('advanceWalk — landing on the NEXT request, not the one after it', () => {
  /** Three decisions AND the queue's own view of them. Built together because
   *  the queue's ordering is its own (enforced edges, dependents, age, id) and
   *  a test that assumed creation order would pass or fail on how the ids sort.
   */
  function three() {
    const tasks = [decision(), decision(), decision()];
    const queue = reviewQueue(tasks, [], NOW);
    /** The queue without its item at `i` — what answering that one leaves. */
    const without = (i: number) =>
      reviewQueue(
        queue.items.filter((_, n) => n !== i).map((it) => it.decision?.task as HubTask),
        [],
        NOW,
      );
    return { queue, without, keyAt: (i: number) => queue.items[i]?.key as string };
  }

  it('aims at what was next, so the item that slid into place is not skipped', () => {
    const { queue, without, keyAt } = three();
    expect(queue.items).toHaveLength(3);
    // The answered decision leaves the queue, so `index + 1` would land on the
    // THIRD and step over the second entirely.
    const after = without(0);
    expect(after.items[0]?.key).toBe(keyAt(1));
    expect(advanceWalk(after, 0, keyAt(0), keyAt(1))).toBe(0);
  });

  it('steps past the answered item while it is still in the queue', () => {
    // A decision's answer comes back through the ydoc projection rather than in
    // the POST's reply, so the queue can still hold it when the write resolves.
    const { queue, keyAt } = three();
    expect(advanceWalk(queue, 0, keyAt(0), null)).toBe(1);
  });

  it('lands on the done state when the last one is answered', () => {
    const { without, keyAt } = three();
    const after = without(2);
    expect(after.items[2]).toBeUndefined();
    expect(advanceWalk(after, 2, keyAt(2), null)).toBe(2);
  });

  it('holds the gap when a peer takes the next one too', () => {
    const { queue, keyAt } = three();
    const after = reviewQueue([queue.items[2]?.decision?.task as HubTask], [], NOW);
    expect(advanceWalk(after, 0, keyAt(0), keyAt(1))).toBe(0);
  });
});

describe('renderReviewWalkthrough — a declared review item', () => {
  const queueOf = (...items: ReviewThreadItem[]) => reviewQueue([], items, NOW);

  /** The full shape: a headline, a body of several paragraphs, two options. */
  const declared = (over: Partial<ReviewThreadItem> = {}) =>
    threadItem({
      ask: 'Where should the trial banner live?',
      review: {
        shape: 'decision',
        headline: 'Where should the trial banner live?',
        detail:
          'Blocks the onboarding rework; both screens are built either way.\n\nWhether moving it below the fold hides the price.\n\nAbove the fold it competes with the **sign-up** button.',
        options: [
          { id: 'above', label: 'Keep above', detail: 'Seen by everyone.' },
          { id: 'below', label: 'Move below', detail: 'Cleaner header.' },
        ],
      },
      ...over,
    });

  // ONE anatomy (approved design, review-flow-mock-v1): head row, then one
  // markdown body — no labelled sub-sections, no separate why line, no
  // provenance block. Since 2026-08-25 the payload carries one body field
  // rather than three, so the card renders what the author wrote, in the
  // order they wrote it, and nothing reorders or labels it.
  it('renders head row plus one markdown body — no labelled sub-blocks', () => {
    renderReviewWalkthrough(root, queueOf(declared()), 0, walk());
    expect((root.querySelector('.hub-walk-title') as HTMLElement).textContent).toBe(
      'Where should the trial banner live?',
    );
    // The old furniture is gone outright.
    expect(root.querySelector('.hub-walk-why')).toBeNull();
    expect(root.querySelector('.hub-walk-ctx')).toBeNull();
    expect(root.querySelector('.hub-walk-lookfor')).toBeNull();
    expect(root.querySelector('.hub-walk-review-detail')).toBeNull();
    // One body, markdown-rendered, in the author's own order.
    const body = root.querySelector('.hub-walk-body') as HTMLElement;
    const text = body.textContent ?? '';
    const first = text.indexOf('Blocks the onboarding rework');
    const second = text.indexOf('Whether moving it below the fold hides the price.');
    const third = text.indexOf('it competes with the sign-up button');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    // Markdown, not glued text — the detail's bold survives.
    expect(body.querySelector('strong')?.textContent).toBe('sign-up');
    // The rest of the walkthrough pattern is untouched: options, composer,
    // stepper, skip.
    expect(root.querySelectorAll('.hub-walk-option')).toHaveLength(2);
    expect(root.querySelector('.hub-walk-answer')).not.toBeNull();
    expect(root.querySelector('.hub-walk-skip')).not.toBeNull();
    expect(root.querySelector('.hub-walk-skip-link')).not.toBeNull();
  });

  it("the head's meta reads Asked by <who> N days ago, singular and plural", () => {
    renderReviewWalkthrough(
      root,
      queueOf(declared({ askedBy: 'Harbor agent', since: NOW - 2 * 86_400_000 })),
      0,
      walk(),
      { cleared: 0, last: null },
      NOW,
    );
    expect((root.querySelector('.hub-walk-wait') as HTMLElement).textContent).toBe(
      'Asked by Harbor agent 2 days ago',
    );
    renderReviewWalkthrough(
      root,
      queueOf(declared({ askedBy: 'Harbor agent', since: NOW - 86_400_000 })),
      0,
      walk(),
      { cleared: 0, last: null },
      NOW,
    );
    expect((root.querySelector('.hub-walk-wait') as HTMLElement).textContent).toBe(
      'Asked by Harbor agent 1 day ago',
    );
  });

  // The body is optional and nothing is invented in its place: a headline
  // with no detail leaves no gap and no placeholder.
  it('renders only what the author actually wrote', () => {
    const bare = threadItem({
      review: { shape: 'review', headline: 'Read the copy', detail: 'It ships Tuesday.' },
    });
    renderReviewWalkthrough(root, queueOf(bare), 0, walk());
    expect((root.querySelector('.hub-walk-body') as HTMLElement).textContent).toBe(
      'It ships Tuesday.',
    );

    const nothing = threadItem({ review: { shape: 'review', headline: 'Read the copy' } });
    renderReviewWalkthrough(root, queueOf(nothing), 0, walk());
    expect(root.querySelector('.hub-walk-body')).toBeNull();
  });

  // One reply path. A tap and typed words must reach the thread the same way,
  // or the two drift and only one of them records the choice.
  it('sends an option tap and typed words through the same handler', () => {
    const onReply = vi.fn();
    const queue = queueOf(declared());
    renderReviewWalkthrough(root, queue, 0, walk({ onReply }));
    const opts = [...root.querySelectorAll<HTMLElement>('.hub-walk-option')];
    expect(opts.map((o) => o.querySelector('.hub-walk-option-label')?.textContent)).toEqual([
      'Keep above',
      'Move below',
    ]);
    opts[1]?.click();
    // The LABEL is the verbatim reply; the id says which candidate it was.
    expect(onReply).toHaveBeenCalledWith(queue.items[0], 'Move below', 'below');

    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Neither — put it in the sign-up flow.';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    // Two arguments, not three-with-undefined: typed words came from no
    // candidate, and saying `optionId: undefined` at the route would be the
    // client asserting a choice it does not have.
    expect(onReply).toHaveBeenLastCalledWith(
      queue.items[0],
      'Neither — put it in the sign-up flow.',
    );
  });

  // The candidates are a shortcut, never a closed set — so an item with none
  // is not a lesser card, it is the same card with one way to answer.
  it('keeps the free-text answer when the author offered no options', () => {
    const onReply = vi.fn();
    const queue = queueOf(threadItem({ review: { shape: 'review', headline: 'Read the copy' } }));
    renderReviewWalkthrough(root, queue, 0, walk({ onReply }));
    expect(root.querySelectorAll('.hub-walk-option')).toHaveLength(0);
    const form = root.querySelector('.hub-walk-answer') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Reads fine.';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onReply).toHaveBeenCalledWith(queue.items[0], 'Reads fine.');
  });

  // A declared headline is authored, so it goes through untouched. The derived
  // path clips at the first sentence terminator, which would throw the
  // question away here.
  it('does not clip an authored headline at its first full stop', () => {
    const item = threadItem({
      review: { shape: 'decision', headline: 'Ship v2 now. Or wait for the rebuild?' },
    });
    renderReviewWalkthrough(root, queueOf(item), 0, walk());
    expect((root.querySelector('.hub-walk-title') as HTMLElement).textContent).toBe(
      'Ship v2 now. Or wait for the rebuild?',
    );
  });
});

/**
 * A long detail no longer bounces at the API (the 150-word refusal pushed the
 * real context into the thread and a compressed copy onto the card — two
 * versions of one ask), so the card must carry all of it while staying
 * scannable: the FULL words are always in the DOM, and past the review target
 * the body is clamped with an explicit expand affordance. The clamp itself is
 * CSS scoped to the phone tier (walk-body-clamp-css.test.ts pins that); this
 * suite pins the DOM contract — classes, the button, and the words.
 */
describe('renderReviewWalkthrough — a long detail clamps with an explicit expand', () => {
  const queueOf = (...items: ReviewThreadItem[]) => reviewQueue([], items, NOW);
  const longDetail = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
  const longItem = () =>
    threadItem({
      review: {
        shape: 'review',
        headline: 'Read the migration write-up',
        detail: longDetail,
      },
    });

  it('puts the FULL detail in the body — the card and the thread say the same words', () => {
    renderReviewWalkthrough(root, queueOf(longItem()), 0, walk());
    const body = root.querySelector('.hub-walk-body') as HTMLElement;
    expect(body.textContent).toContain('word0');
    expect(body.textContent).toContain('word299');
  });

  it('clamps a long body and expands it on the affordance, which then leaves', () => {
    renderReviewWalkthrough(root, queueOf(longItem()), 0, walk());
    const body = root.querySelector('.hub-walk-body') as HTMLElement;
    expect(body.classList.contains('hub-walk-body-clamp')).toBe(true);
    const expand = root.querySelector('.hub-walk-body-expand') as HTMLButtonElement;
    expect(expand).not.toBeNull();
    expand.click();
    expect(body.classList.contains('hub-walk-body-clamp')).toBe(false);
    expect(root.querySelector('.hub-walk-body-expand')).toBeNull();
  });

  it('a body within the target gets no clamp and no affordance', () => {
    renderReviewWalkthrough(root, queueOf(threadItem()), 0, walk());
    const body = root.querySelector('.hub-walk-body') as HTMLElement;
    expect(body.classList.contains('hub-walk-body-clamp')).toBe(false);
    expect(root.querySelector('.hub-walk-body-expand')).toBeNull();
  });
});
