/**
 * The member-boundary rule for ids that arrive in a request BODY, tested
 * where it is decided rather than through a route.
 *
 * Most of `share/ref-scope.ts` is covered over HTTP in
 * `member-boundary-lows.test.ts`, which is the right place for it: a rule
 * about members needs a real member. `blockersInVisitorScope` is the
 * exception. It guards the transition gate's report against a cross-board
 * `after` edge, and no route can build one — the store's two write paths
 * both check the dependency against the board's own task map. So the state
 * it defends cannot be reached over HTTP, and a route test of it would be a
 * test that passes for the wrong reason. Driven directly instead.
 */
import { describe, expect, it } from 'bun:test';
import {
  blockersInVisitorScope,
  firstTaskIdOutOfScope,
  refInVisitorScope,
} from '../src/share/ref-scope.ts';

/** `shareWorkspacesOf`, stubbed: two rows on one board, one on another. */
const workspacesOf = (id: string): string[] =>
  ({
    'task:mine': ['w-shared'],
    'task:sibling': ['w-shared'],
    'task:theirs': ['w-private'],
  })[id] ?? [];

const member = { workspaceId: 'w-shared' };

const blocker = (taskId: string) => ({
  taskId,
  title: `the title of ${taskId}`,
  status: 'in-progress' as const,
  enforce: true,
  message: `blocked by open task ${taskId}`,
});

describe('blockersInVisitorScope', () => {
  it('keeps a blocker on the caller’s own board', () => {
    const kept = blockersInVisitorScope([blocker('sibling')], member, workspacesOf);
    expect(kept).toHaveLength(1);
    expect(kept?.[0]?.taskId).toBe('sibling');
  });

  it('drops one on a board they were never given, title and status with it', () => {
    const kept = blockersInVisitorScope([blocker('theirs')], member, workspacesOf);
    expect(kept).toEqual([]);
  });

  it('drops one whose id resolves to no board at all', () => {
    expect(blockersInVisitorScope([blocker('never-existed')], member, workspacesOf)).toEqual([]);
  });

  it('cuts a mixed list down to the caller’s own', () => {
    const kept = blockersInVisitorScope(
      [blocker('sibling'), blocker('theirs')],
      member,
      workspacesOf,
    );
    expect(kept?.map((b) => b.taskId)).toEqual(['sibling']);
  });

  it('leaves the owner’s report whole — a null visitor is the box itself', () => {
    const kept = blockersInVisitorScope(
      [blocker('sibling'), blocker('theirs')],
      null,
      workspacesOf,
    );
    expect(kept?.map((b) => b.taskId)).toEqual(['sibling', 'theirs']);
  });

  it('answers undefined for a refusal that carried no blockers', () => {
    expect(blockersInVisitorScope(undefined, member, workspacesOf)).toBeUndefined();
  });

  it('holds nothing for a visitor scoped to no board', () => {
    expect(blockersInVisitorScope([blocker('sibling')], {}, workspacesOf)).toEqual([]);
  });
});

describe('firstTaskIdOutOfScope', () => {
  it('answers undefined when every id is on the caller’s board', () => {
    expect(firstTaskIdOutOfScope(['mine', 'sibling'], member, workspacesOf)).toBeUndefined();
  });

  it('names the first stray, so a refusal can say which', () => {
    expect(firstTaskIdOutOfScope(['mine', 'theirs', 'sibling'], member, workspacesOf)).toBe(
      'theirs',
    );
  });

  it('treats an id that resolves nowhere exactly as a foreign one', () => {
    expect(firstTaskIdOutOfScope(['never-existed'], member, workspacesOf)).toBe('never-existed');
  });

  it('asks nothing of the owner', () => {
    expect(firstTaskIdOutOfScope(['theirs'], null, workspacesOf)).toBeUndefined();
  });

  it('is the same predicate a task ref goes through', () => {
    expect(refInVisitorScope({ kind: 'task', taskId: 'theirs' }, member, workspacesOf)).toBe(false);
    expect(refInVisitorScope({ kind: 'task', taskId: 'sibling' }, member, workspacesOf)).toBe(true);
  });
});
