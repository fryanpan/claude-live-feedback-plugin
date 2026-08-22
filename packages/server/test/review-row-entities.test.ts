/**
 * A review row's title is plain text, whichever door it came out of.
 *
 * Titles are caller-supplied, and some callers store a string they already
 * HTML-escaped ("Decisions &amp; open questions"). Every surface renders a
 * title through `textContent` — correct, and exactly why a baked entity
 * reaches the screen as literal text.
 *
 * There are TWO doors, which is the thing this file exists to hold. The REST
 * queue (`review-queue.ts`) normalizes the titles IT assembles, and has its own
 * tests. But the Home queue's DECISION rows are assembled in the browser, off
 * the board projection — `projectTask` → the `ws:<id>` room → `reviewQueue` —
 * so a title left raw in the projection is a review row with a raw entity in
 * it however carefully the REST side behaves. The chain is asserted end to end
 * here rather than at either half, because either half alone passes while the
 * row on screen is still wrong.
 *
 * All fixtures are synthetic.
 */
import { describe, expect, it } from 'bun:test';
import type { HubTask } from '../../markdown-app/src/hub/hub-model.ts';
import { reviewQueue, reviewRowTitle } from '../../markdown-app/src/hub/hub-model.ts';
import { projectTask } from '../src/task-projection.ts';
import type { Task } from '../src/tasks.ts';

const NOW = 1_760_000_000_000;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    workspaceId: 'w-1',
    title: 'Ship the widget',
    assignee: 'human',
    goal: 'chores',
    order: 1,
    status: 'todo',
    after: [],
    links: [],
    transitions: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** What a board reader gets: the projection, read as the browser's row type. */
const projected = (t: Task): HubTask => projectTask(t) as unknown as HubTask;

describe('projectTask decodes titles', () => {
  it("renders '&' where a caller baked in '&amp;'", () => {
    expect(projected(task({ title: 'Decisions &amp; open questions' })).title).toBe(
      'Decisions & open questions',
    );
  });

  it('decodes a numeric entity', () => {
    expect(projected(task({ title: 'Rank &#38; place' })).title).toBe('Rank & place');
    expect(projected(task({ title: 'Rank &#x26; place' })).title).toBe('Rank & place');
  });

  it("one pass only — a caller's '&amp;amp;' still shows the '&amp;' they wrote", () => {
    expect(projected(task({ title: 'Twice: &amp;amp;' })).title).toBe('Twice: &amp;');
  });

  it('leaves a bare & and an unknown entity name alone', () => {
    expect(projected(task({ title: 'Tom & Jerry &nope; &' })).title).toBe('Tom & Jerry &nope; &');
  });

  /** The positive control: an ordinary title is not being quietly rewritten by
   *  the same code path that clears the entity ones. */
  it('passes an entity-free title through untouched', () => {
    expect(projected(task({ title: 'Ship the widget' })).title).toBe('Ship the widget');
  });
});

describe('the Home queue row a decision task produces', () => {
  const decision = (title: string): HubTask =>
    projected(task({ title, needs: 'decision', assignee: 'human' }));

  /** The bug as reported: a decision row's title IS the task title (its `ask`
   *  is empty, because the subject is the question), so it is the one review
   *  row the REST queue never gets to normalize. */
  it('shows the ampersand, not the entity', () => {
    const q = reviewQueue([decision('Decisions &amp; open questions')], [], NOW);
    expect(q.items).toHaveLength(1);
    expect(reviewRowTitle(q.items[0])).toBe('Decisions & open questions');
  });

  it('still shows an ordinary decision title verbatim', () => {
    const q = reviewQueue([decision('Which repo does this land in?')], [], NOW);
    expect(reviewRowTitle(q.items[0])).toBe('Which repo does this land in?');
  });
});
