/**
 * Visitor redaction for board events on the workspace SSE feed.
 *
 * The §3.3 visitor contract says a workspace-scope visitor sees transitions
 * with actor DISPLAY NAMES only — no actor ids. The ws:<id> room enforces
 * that via projectTask; the SSE feed is the second door (the private-meta
 * lesson: redacting one transport and forgetting the long-lived other is how
 * leaks ship), so the same shape is asserted here on the payloads the stream
 * writes. It follows projectTask exactly, which is why the description now
 * rides along: it is in the synced ydoc, and a redaction that withholds
 * nothing is worse than none, because it reads as a guarantee.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { redactBoardEventForVisitor } from '../src/share/redact-board-events.ts';
import type { Task } from '../src/tasks.ts';

const TASK: Task = {
  id: 't-1',
  workspaceId: 'w-1',
  title: 'Wire the store',
  body: '# Private draft body\n',
  assignee: 'agent',
  goal: 'chores',
  order: 1,
  status: 'in-progress',
  after: [],
  links: [],
  transitions: [
    {
      ts: 5,
      from: 'todo',
      to: 'in-progress',
      by: { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'agent' },
    },
  ],
  createdAt: 1,
  updatedAt: 5,
};

describe('redactBoardEventForVisitor', () => {
  it('strips actor ids down to display name + kind', () => {
    const out = redactBoardEventForVisitor({
      event: 'task.transitioned',
      workspaceId: 'w-1',
      taskId: 't-1',
      from: 'todo',
      to: 'in-progress',
      actor: { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'agent' },
      ts: 5,
    });
    // Positive control first: the redacted payload still carries the event
    // and the display identity — an empty object would "pass" a bare
    // no-id assertion.
    expect(out.event).toBe('task.transitioned');
    const actor = out.actor as unknown as Record<string, unknown>;
    expect(actor).toEqual({ name: 'Search Revamp', kind: 'agent' });
    expect(actor.id).toBeUndefined();
  });

  // The description became a projected field when the board started
  // rendering it in place, which widened what a workspace-share visitor can
  // read. This stream must follow the projection rather than fight it: the
  // same visitor already syncs the ws:<id> ydoc, and Yjs has no
  // per-connection projection, so stripping the body HERE would withhold
  // nothing while reading as a guarantee. One door, not one of two.
  it('projects a full task to the visitor-contract shape — display actors, and the same body the board syncs', () => {
    const out = redactBoardEventForVisitor({
      event: 'task.created',
      workspaceId: 'w-1',
      taskId: 't-1',
      task: TASK,
      goal: 'chores',
      assignee: 'agent',
      ts: 1,
    });
    const task = out.task as unknown as Record<string, unknown>;
    expect(task.title).toBe('Wire the store'); // positive control
    expect(task.body).toBe(TASK.body?.trim());
    const transitions = task.transitions as Array<{ by: Record<string, unknown> }>;
    expect(transitions[0]?.by).toEqual({ name: 'Search Revamp', kind: 'agent' });
    // Ids are still the thing this drops.
    expect(transitions[0]?.by.id).toBeUndefined();
  });

  it('leaves non-board events untouched — thread events already have their own rules', () => {
    const payload = {
      event: 'thread.replied',
      docId: 'd-1',
      author: { id: 'known-bryan', name: 'Bryan' },
    };
    expect(redactBoardEventForVisitor(payload)).toBe(payload);
  });

  it('drops the voice transcript, ack and context — §3.3 never enumerated them', () => {
    const out = redactBoardEventForVisitor({
      event: 'voice.request',
      workspaceId: 'w-1',
      transcript: 'hold the release until legal clears the acquisition question',
      route: 'agent',
      ack: 'Heard: "hold the release…". Sent to the workspace agent.',
      context: { surface: 'board' },
      actor: { id: 'known-jordan', name: 'Jordan', kind: 'person' },
      ts: 11,
    });
    // Positive control: a visitor still sees that someone spoke and which
    // route took it, with a display-only actor like every other board event.
    expect(out.event).toBe('voice.request');
    expect(out.route).toBe('agent');
    expect(out.actor as unknown as Record<string, unknown>).toEqual({
      name: 'Jordan',
      kind: 'person',
    });
    // The words themselves are not in the contract.
    expect(out.transcript).toBeUndefined();
    expect(out.ack).toBeUndefined();
    expect(out.context).toBeUndefined();
  });

  it('redacts the actor on every review_item event — the Activity tab reads these', () => {
    // `review_item.added/revised/withdrawn` were outside the BOARD_EVENT
    // prefix set, so they crossed to a visitor with `actor.id` on them —
    // which is a hash of the asker's email, and the one field every
    // neighbouring visitor surface strips. They reach a member by two doors:
    // the board's SSE feed, and `GET …/events`, the Activity tab admitted by
    // the member-rights change.
    for (const event of ['review_item.added', 'review_item.revised', 'review_item.withdrawn']) {
      const out = redactBoardEventForVisitor({
        event,
        workspaceId: 'w-1',
        taskId: 't-1',
        reviewItemId: 'r-1',
        headline: 'Which of the two goal orders do you want?',
        actor: { id: 'known-jordan', name: 'Jordan', kind: 'person' },
        ts: 12,
      });
      // Positive control: the ask itself is board content and stays, or
      // "no id" would be satisfied by an empty payload.
      expect(out.event, event).toBe(event);
      expect((out as unknown as Record<string, unknown>).headline, event).toBe(
        'Which of the two goal orders do you want?',
      );
      const actor = out.actor as unknown as Record<string, unknown>;
      expect(actor, event).toEqual({ name: 'Jordan', kind: 'person' });
      expect(actor.id, event).toBeUndefined();
    }
  });

  it('redacts the bucket-review actor on triage.requested', () => {
    const out = redactBoardEventForVisitor({
      event: 'triage.requested',
      kind: 'bucket-review',
      workspaceId: 'w-1',
      newBands: [{ id: 'g-1', title: 'Ship it' }],
      taskIds: ['t-1'],
      actor: { id: 'known-bryan', name: 'Bryan', kind: 'person' },
      ts: 9,
    });
    expect(out.actor as unknown as Record<string, unknown>).toEqual({
      name: 'Bryan',
      kind: 'person',
    });
  });
});
