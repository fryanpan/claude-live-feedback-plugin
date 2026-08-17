/**
 * The policy behind the task-body guard, as a table.
 *
 * `task-body-guard.test.ts` proves the route enforces it; this proves the
 * policy itself says what we meant, without a server in the way. Both halves
 * are asserted — the refusals AND the allowances — because a function that
 * returned `false` for everything would satisfy a refusal-only table, and a
 * function that returned `true` for everything would satisfy an allow-only
 * one.
 */
import { describe, expect, it } from 'bun:test';
import { taskBodyOpAllowed } from '../src/task-projection.ts';

describe('taskBodyOpAllowed', () => {
  /** Content rewrites and deletions: the acts that can destroy a capture
   *  with no `quote` preserved and no `task.body_edited` recorded. */
  const REFUSED: Array<[string, string]> = [
    ['content', 'POST'],
    ['find_and_replace', 'POST'],
    ['delete_block_at_anchor', 'POST'],
    ['delete_blocks_in_range', 'POST'],
    ['delete_section', 'POST'],
    ['agent_anchors/a-123/edit', 'POST'],
    ['agent_anchors/a-123/insert_blocks', 'POST'],
    ['threads/t-123/insert_after', 'POST'],
    ['threads/t-123/insert_blocks_after', 'POST'],
    ['threads/t-123/rewrite_region', 'POST'],
    ['suggestions/s-123/accept', 'POST'],
    ['reparse_from_disk', 'POST'],
    // The bulk form picks accept-vs-reject from the request BODY, which this
    // guard runs before anything reads — so its destructive half cannot be
    // told apart here and the whole route is refused. `suggestions/<sid>/reject`
    // below is the per-suggestion way through.
    ['suggestions/resolve_all', 'POST'],
  ];

  /** Discussing and annotating a task, which is what its body room is for. */
  const ALLOWED: Array<[string, string]> = [
    // Deleting the ROOM costs its threads, not the captured words — the
    // description lives in the task store and a missing room is reseeded.
    ['', 'DELETE'],
    ['threads', 'POST'],
    ['threads/by_find', 'POST'],
    ['threads/t-123', 'DELETE'],
    ['threads/t-123/comments', 'POST'],
    ['threads/t-123/resolve', 'POST'],
    ['threads/t-123/reopen', 'POST'],
    ['threads/t-123/promote', 'POST'],
    ['threads/t-123/summary', 'POST'],
    // Repairing a broken anchor rewrites thread metadata, never the doc — and
    // a guard that promised comments were unaffected while making an orphaned
    // one unfixable would be lying about its own scope.
    ['threads/t-123/reanchor', 'POST'],
    ['agent_anchors', 'POST'],
    ['agent_anchors/a-123', 'DELETE'],
    ['suggestions/s-123/reject', 'POST'],
    ['activity', 'POST'],
    ['hooks/fire', 'POST'],
  ];

  for (const [rest, method] of REFUSED) {
    it(`refuses ${method} ${rest || '(the doc itself)'}`, () => {
      expect(taskBodyOpAllowed(rest, method)).toBe(false);
    });
  }

  for (const [rest, method] of ALLOWED) {
    it(`allows ${method} ${rest}`, () => {
      expect(taskBodyOpAllowed(rest, method)).toBe(true);
    });
  }

  it('never blocks a read — get_doc on a task body is the documented way to read it', () => {
    for (const [rest] of [...REFUSED, ...ALLOWED]) {
      expect(taskBodyOpAllowed(rest, 'GET')).toBe(true);
    }
  });

  it('refuses an unknown mutating route, so a new one is closed by default', () => {
    // The direction that matters: the cost of this mistake is an agent
    // reading an error that names update_task_body, against the cost of the
    // other one, which is a capture destroyed with no record it existed.
    expect(taskBodyOpAllowed('some_route_invented_later', 'POST')).toBe(false);
  });
});
