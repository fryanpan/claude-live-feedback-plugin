import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHORES_ID,
  type HubTask,
  type ReviewThreadItem,
  decisionRows,
  reviewQueue,
} from '../src/hub/hub-model.ts';
import {
  type ReviewStripHandlers,
  type WalkthroughHandlers,
  renderReviewStrip,
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

describe('renderReviewStrip — the count and the urgency read', () => {
  it('leads with a number and splits blocking-now from can-wait', () => {
    const blocking = decision({ title: 'Ship in blue or green?' });
    const parked = decision({ title: 'Rename the tab?' });
    renderReviewStrip(root, q0([blocking, parked, task({ after: [blocking.id] })]), strip());
    const count = root.querySelector('.hub-decisions-count') as HTMLElement;
    expect(count.textContent).toContain('2');
    const urgency = root.querySelector('.hub-decisions-urgency') as HTMLElement;
    expect(urgency.textContent).toContain('1 blocking work now');
    expect(urgency.textContent).toContain('1 can wait');
  });

  it('says so plainly when nothing is blocked, rather than printing "0 blocking"', () => {
    renderReviewStrip(root, q0([decision(), decision()]), strip());
    const urgency = root.querySelector('.hub-decisions-urgency') as HTMLElement;
    expect(urgency.textContent).toContain('Nothing is blocked');
    expect(urgency.textContent).not.toContain('0 blocking');
  });

  it('tapping the count starts the walkthrough; a chip still opens one item', () => {
    const onWalkthrough = vi.fn();
    const onOpen = vi.fn();
    const d = decision({ title: 'Ship now or wait?' });
    renderReviewStrip(root, q0([d, task({ after: [d.id] })]), strip({ onWalkthrough, onOpen }));
    (root.querySelector('.hub-decisions-count') as HTMLElement).click();
    expect(onWalkthrough).toHaveBeenCalledTimes(1);
    const chip = root.querySelector('.hub-decision-chip') as HTMLElement;
    expect(chip.textContent).toContain('Ship now or wait?');
    // Derived urgency reaches the chip too — "blocks 1" is read off the edges.
    expect(chip.textContent).toContain('blocks 1');
    chip.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('hides the whole strip when there is nothing waiting', () => {
    // Presence first: the strip is visible with one decision.
    renderReviewStrip(root, q0([decision()]), strip());
    expect(root.classList.contains('hidden')).toBe(false);
    renderReviewStrip(root, q0([task()]), strip());
    expect(root.classList.contains('hidden')).toBe(true);
  });

  // The three kinds are why the strip exists at all: a comment waiting on an
  // answer was in the store and unreachable from the board. A chip that can't
  // say which surface it will take you to is a chip nobody taps.
  it('carries all three kinds, marked, with the ask on the thread chips', () => {
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
    renderReviewStrip(root, queue, strip());
    const chips = Array.from(root.querySelectorAll<HTMLElement>('.hub-decision-chip'));
    expect(chips.map((c) => c.className.match(/hub-review-[\w-]+/)?.[0])).toEqual([
      'hub-review-decision',
      'hub-review-task-thread',
      'hub-review-doc-thread',
    ]);
    expect(chips[1]?.textContent).toContain('Which repo does this land in?');
    expect(chips[2]?.textContent).toContain('Is this claim still true?');
    expect((root.querySelector('.hub-decisions-count') as HTMLElement).textContent).toContain('3');
  });

  // A thread blocks nothing structurally; counting it would inflate the one
  // number that is supposed to mean "act now".
  it('counts threads in the total but never in the blocking count', () => {
    const d = decision({ title: 'Blue or green?' });
    const queue = reviewQueue([d, task({ after: [d.id] })], [threadItem()], NOW);
    expect(queue.total).toBe(2);
    expect(queue.blocking).toBe(1);
    renderReviewStrip(root, queue, strip());
    const urgency = root.querySelector('.hub-decisions-urgency') as HTMLElement;
    expect(urgency.textContent).toContain('1 blocking work now');
    expect(urgency.textContent).toContain('1 can wait');
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
    const blocks = root.querySelector('.hub-walk-blocks') as HTMLElement;
    expect(blocks.textContent).toContain('Build the badge');
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
    renderReviewWalkthrough(root, queueOf(threadItem()), 0, walk());
    expect((root.querySelector('.hub-walk-title') as HTMLElement).textContent).toBe(
      'Ship the widget',
    );
    expect((root.querySelector('.hub-walk-ask') as HTMLElement).textContent).toBe('Green or blue?');
    const why = root.querySelector('.hub-walk-blocks') as HTMLElement;
    expect(why.textContent).toContain('Helper asked');
    // The decision-only furniture is absent: there is no options block and no
    // "not enough to decide" form on a comment.
    expect(root.querySelector('.hub-walk-info')).toBeNull();
    expect(root.querySelector('.hub-walk-options')).toBeNull();
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
    const open = root.querySelector('.hub-walk-open') as HTMLElement;
    expect(open.textContent).toContain('task');
    open.click();
    expect(onOpenItem).toHaveBeenCalledWith(queue.items[0]);

    renderReviewWalkthrough(
      root,
      queueOf(threadItem({ kind: 'doc-thread', docId: 'd-1', title: 'Launch plan' })),
      0,
      walk({ onOpenItem }),
    );
    expect((root.querySelector('.hub-walk-open') as HTMLElement).textContent).toContain('doc');
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
    expect(root.querySelector('.hub-walk-ask')).not.toBeNull();
    expect((root.querySelector('.hub-walk-back') as HTMLButtonElement).disabled).toBe(false);
    (root.querySelector('.hub-walk-skip') as HTMLElement).click();
    expect(onStep).toHaveBeenCalledWith(2);
    (root.querySelector('.hub-walk-back') as HTMLElement).click();
    expect(onStep).toHaveBeenLastCalledWith(0);
  });
});
