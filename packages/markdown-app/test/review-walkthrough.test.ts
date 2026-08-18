import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  type ReviewStripHandlers,
  type WalkthroughHandlers,
  renderHomeReview,
  renderReviewWalkthrough,
  renderTaskDetail,
} from '../src/hub/hub-render.ts';

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

function threadItem(over: Partial<ReviewThreadItem> = {}): ReviewThreadItem {
  return {
    kind: 'task-thread',
    docId: 'task:t-1',
    threadId: 'th-1',
    taskId: 't-1',
    title: 'Ship the widget',
    ask: 'Green or blue?',
    askedBy: 'Helper',
    since: NOW - 60_000,
    ...over,
  };
}

/** The queue with no threads in it — most cases here are about decisions. */
const q0 = (tasks: HubTask[]) => reviewQueue(tasks, [], NOW);

function strip(over: Partial<ReviewStripHandlers> = {}): ReviewStripHandlers {
  return { onOpen: vi.fn(), onWalkthrough: vi.fn(), ...over };
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
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

describe('renderHomeReview — the ranked list (mockup anatomy)', () => {
  it('Review All starts the walkthrough; a row still opens one item', () => {
    const onWalkthrough = vi.fn();
    const onOpen = vi.fn();
    const d = decision({ title: 'Ship now or wait?' });
    renderHomeReview(root, q0([d, task({ after: [d.id] })]), strip({ onWalkthrough, onOpen }));
    (root.querySelector('.hub-review-go') as HTMLElement).click();
    expect(onWalkthrough).toHaveBeenCalledTimes(1);
    const row = root.querySelector('.hub-review-row') as HTMLElement;
    expect(row.textContent).toContain('Ship now or wait?');
    // Derived urgency still travels with the row — "blocks" reads off the
    // edges into the hover title, since the mockup row carries no third line.
    expect(row.title).toContain('Blocking 1 task');
    row.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
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
      rows.map(
        (c) => c.className.match(/hub-review-(?:decision|task-thread|doc-thread|blocker)/)?.[0],
      ),
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

describe('the blocker band — a person’s own task, holding agent work up', () => {
  /** A human task with `n` open tasks waiting on it. */
  function blocked(over: Partial<HubTask> = {}, n = 1): HubTask[] {
    const gate = task({ assignee: 'human', title: 'Turn on the tunnel', ...over });
    const waits = Array.from({ length: n }, (_, i) =>
      task({ title: `Waiting ${i + 1}`, after: [gate.id] }),
    );
    return [gate, ...waits];
  }

  it('marks the row as its own kind and says how much is waiting', () => {
    const onOpen = vi.fn();
    renderHomeReview(root, q0(blocked({}, 2)), strip({ onOpen }));
    const row = root.querySelector('.hub-review-row') as HTMLElement;
    expect(row.className).toContain('hub-review-blocker');
    expect(row.textContent).toContain('Turn on the tunnel');
    // The count is read off the edges, the same as a decision row's.
    expect(row.title).toContain('Blocking 2 tasks');
    row.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // Criterion 3 at the surface: widening the band to every human task is the
  // easy wrong fix, and it shows up here as a strip full of personal backlog.
  it('a human task nothing waits on never reaches the queue', () => {
    // Presence first: with an edge, the section carries a row.
    renderHomeReview(root, q0(blocked()), strip());
    expect(root.querySelectorAll('.hub-review-row').length).toBeGreaterThan(0);
    renderHomeReview(root, q0([task({ assignee: 'human', title: 'Read the retro' })]), strip());
    expect(root.querySelectorAll('.hub-review-row')).toHaveLength(0);
    expect(root.textContent).not.toContain('Read the retro');
  });

  it('counts as blocking work now, not as something that can wait', () => {
    const queue = q0(blocked());
    expect(queue.blocking).toBe(1);
    renderHomeReview(root, queue, strip());
    expect(root.querySelectorAll('.hub-review-row')).toHaveLength(1);
  });

  // There is no question on a task, so the decision furniture must not appear:
  // an answer box here would write an `answer` onto work that was never asked.
  it('walks a blocker without offering to answer it', () => {
    const onOpenItem = vi.fn();
    const onStep = vi.fn();
    const q = q0(blocked({}, 2));
    renderReviewWalkthrough(root, q, 0, walk({ onOpenItem, onStep }));
    // Presence first: it IS a card, with the blocks line and the kind on it.
    const card = root.querySelector('.hub-walk-card') as HTMLElement;
    expect(card.className).toContain('hub-walk-blocker');
    expect((root.querySelector('.hub-walk-title') as HTMLElement).textContent).toBe(
      'Turn on the tunnel',
    );
    const ctx = root.querySelector('.hub-walk-ctx') as HTMLElement;
    expect(ctx.textContent).toContain('blocks');
    expect(ctx.textContent).toContain('Waiting 1');
    expect(root.querySelector('.hub-walk-answer')).toBeNull();
    expect(root.querySelector('.hub-walk-info')).toBeNull();
    expect(root.querySelector('.hub-walk-options')).toBeNull();

    // The way out, and the nav — going through the list must not stop here.
    const open = root.querySelector('.hub-walk-open') as HTMLElement;
    expect(open.textContent).toContain('task');
    open.click();
    expect(onOpenItem).toHaveBeenCalledWith(q.items[0]);
    (root.querySelector('.hub-walk-skip') as HTMLElement).click();
    expect(onStep).toHaveBeenCalledWith(1);
  });

  it('shows the task’s own description, and says so when there is none', () => {
    const q = q0(blocked({ body: 'Needs a **cert** first.' }));
    renderReviewWalkthrough(root, q, 0, walk());
    expect((root.querySelector('.hub-walk-body') as HTMLElement).innerHTML).toContain(
      '<strong>cert</strong>',
    );
    renderReviewWalkthrough(root, q0(blocked()), 0, walk());
    expect(root.querySelector('.hub-walk-body-empty')).not.toBeNull();
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
    const opt = root.querySelector('.hub-detail-option') as HTMLElement;
    expect(opt.textContent).toContain('Ship it blue');
    opt.click();
    expect(onAnswer).toHaveBeenCalledWith(d, 'Ship it blue', 'o-1');

    // A decision with no options renders none — the block is conditional, not
    // an empty shell.
    renderTaskDetail(root, decision({ title: 'Rename the tab?' }), handlers);
    expect(root.querySelector('.hub-detail-option')).toBeNull();
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
  const withBlocker = () => {
    const d = decision({ title: 'Blue or green?' });
    return q0([d, task({ after: [d.id], title: 'Build the badge' })]);
  };

  it('is a page with a way back, not a dialog over the board', () => {
    const onClose = vi.fn();
    renderReviewWalkthrough(root, withBlocker(), 0, walk({ onClose }));
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

  it('badges the kind, chips the context, and states the wait as a bare duration', () => {
    renderReviewWalkthrough(root, withBlocker(), 0, walk({ contextLabel: () => 'Home pane' }));
    const badge = root.querySelector('.hub-walk-k-decision') as HTMLElement;
    expect(badge.textContent).toBe('Decision');
    expect((root.querySelector('.hub-walk-k-count') as HTMLElement).textContent).toBe('Home pane');
    // "2 days", not "waiting 2 days" — the mockup's wait sits as a bare
    // duration at the end of the head, where the word would be noise.
    const wait = root.querySelector('.hub-walk-wait') as HTMLElement;
    expect(wait.textContent).not.toContain('waiting');

    renderReviewWalkthrough(root, reviewQueue([], [threadItem({ direct: true })], NOW), 0, walk());
    expect((root.querySelector('.hub-walk-k-reply') as HTMLElement).textContent).toBe(
      'Needs your reply',
    );
    // The chip is left out rather than filled with a placeholder when there
    // is no body of work to name.
    expect(root.querySelector('.hub-walk-k-count')).toBeNull();
  });

  it('says Send and Skip for now, on both card kinds', () => {
    for (const queue of [withBlocker(), reviewQueue([], [threadItem()], NOW)]) {
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
    renderReviewWalkthrough(root, withBlocker(), 0, walk({ onStep }));
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

  it('shows where you are, what it blocks, and the body', () => {
    const { q } = queueOfThree();
    renderReviewWalkthrough(root, q, 0, walk());
    expect((root.querySelector('.hub-walk-pos') as HTMLElement).textContent).toBe('1 of 3');
    const ctx = root.querySelector('.hub-walk-ctx') as HTMLElement;
    expect(ctx.textContent).toContain('Build the badge');
    expect((root.querySelector('.hub-walk-body') as HTMLElement).innerHTML).toContain(
      '<strong>colour</strong>',
    );
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

  it('the walkthrough queue is the same derived order the strip counts', () => {
    // Not a tautology: it pins the walkthrough to decisionQueue's ordering, so
    // "6 things need you" and the 6 cards you get can't drift apart.
    const { a, b, c } = queueOfThree();
    const q = q0([a, b, c, task({ after: [c.id] })]);
    expect(decisionRows([a, b, c]).map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    renderReviewWalkthrough(root, q, 0, walk());
    expect((root.querySelector('.hub-walk-title') as HTMLElement).textContent).toBe(
      'Drop the old export?',
    );
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
    const why = root.querySelector('.hub-walk-ctx') as HTMLElement;
    expect(why.textContent).toContain('Asked by Helper');
    // The decision-only furniture is absent: there is no options block and no
    // "not enough to decide" form on a comment.
    expect(root.querySelector('.hub-walk-info')).toBeNull();
    expect(root.querySelector('.hub-walk-options')).toBeNull();
  });

  // A typed question is regularly a paragraph. The mockup's card is a SHORT
  // title plus the ask in full, and we have no short title to read — so the
  // heading is derived and the quote carries the words.
  it('headlines a long question and keeps the whole of it in the quote', () => {
    const ask =
      'The card head puts the wait at the end of the line, which wraps onto its own row at 430px. ' +
      'Do you want it kept there, or moved under the title where it has the width?';
    renderReviewWalkthrough(root, queueOf(threadItem({ ask, direct: true })), 0, walk());
    const title = (root.querySelector('.hub-walk-title') as HTMLElement).textContent ?? '';
    expect(title.length).toBeLessThan(ask.length);
    expect(title.startsWith('The card head puts the wait')).toBe(true);
    // Nothing is lost: the quote is verbatim, and the two really do differ, so
    // this is not the same string rendered twice.
    expect((root.querySelector('.hub-walk-ask') as HTMLElement).textContent).toBe(ask);
    expect(title).not.toBe(ask);
  });

  // An agent's closing note reaches this card too — deliberately, since
  // over-including is the safe direction — but it must not be announced as a
  // question. "Helper asked you" over a deploy note is the card promising
  // something answerable and delivering something that is not.
  it('does not call a status note a question', () => {
    renderReviewWalkthrough(root, queueOf(threadItem({ ask: 'Merged and deployed.' })), 0, walk());
    const why = root.querySelector('.hub-walk-ctx') as HTMLElement;
    expect(why.textContent).toContain('Posted by Helper');
    expect(why.textContent).not.toMatch(/asked/i);
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
    const open = root.querySelector('.hub-walk-open') as HTMLElement;
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
    expect((root.querySelector('.hub-walk-open') as HTMLElement).textContent).toContain(
      'Launch plan',
    );
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
