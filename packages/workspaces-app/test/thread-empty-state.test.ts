import type { Comment, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadPanel } from '../src/threads.ts';

/**
 * "No open comments" is an ABSENCE presented as a FACT, and the panel is
 * handed `[]` before the websocket has delivered anything — so an unsynced
 * doc and a genuinely empty one rendered the identical sentence. On a doc
 * somebody plans their week in, that sentence reads as data loss.
 *
 * The gate is deliberately ONE-DIRECTIONAL: `synced` starts false and only
 * ever moves to true, so its failure mode is a doc that keeps saying
 * "Loading comments…" a little too long, never one that claims emptiness it
 * cannot know. Every assertion below has its positive control in the same
 * file — an absence test that never showed the message CAN render would be
 * vacuous.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

let ts = 1_700_000_000_000;
function comment(text: string): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: alice, text, ts };
}

function makeThread(id: string): Thread {
  const comments = [comment('Is the retry count fixed?')];
  return {
    id,
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'the anchor' } },
    commentCount: comments.length,
    lastActivity: comments[0].ts,
    createdBy: alice,
    comments,
  } as Thread;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function mountPanel() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const panel = new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });
  return { panel, container };
}

const bodyText = (c: HTMLElement): string => (c.textContent ?? '').trim();

describe('thread panel empty state — an unsynced doc is not an empty doc', () => {
  it('does NOT claim there are no comments before the first sync', () => {
    const { panel, container } = mountPanel();
    panel.setThreads([]);

    expect(bodyText(container)).not.toContain('No open comments');
    // The panel must still say SOMETHING — a blank drawer is its own kind of
    // lie, and this is what distinguishes the fix from deleting the message.
    expect(container.querySelector('.threads-empty')).not.toBeNull();
    expect(bodyText(container)).toContain('Loading');
  });

  it('DOES claim there are no comments once synced (positive control)', () => {
    const { panel, container } = mountPanel();
    panel.setThreads([]);
    panel.markSynced();

    expect(bodyText(container)).toContain('No open comments');
    expect(bodyText(container)).not.toContain('Loading');
  });

  it('re-renders on markSynced even though the thread list did not change', () => {
    // The render is memoized on a key computed from the threads. If `synced`
    // is left out of that key, the panel keeps the pre-sync text forever and
    // the fix appears to work only in whatever order the caller happens to
    // use. This is the case that fails when `computeKey` forgets the flag.
    const { panel, container } = mountPanel();
    panel.setThreads([]);
    expect(bodyText(container)).toContain('Loading');

    panel.markSynced();
    expect(bodyText(container)).toContain('No open comments');
  });

  it('shows threads before sync when there already are some', () => {
    // The gate touches the EMPTY branch only; content that has arrived must
    // render whether or not the sync signal has been seen.
    const { panel, container } = mountPanel();
    panel.setThreads([makeThread('t1')]);

    expect(container.querySelector('.thread[data-thread-id="t1"]')).not.toBeNull();
    expect(bodyText(container)).not.toContain('Loading');
  });

  it('stays synced once synced, even when the list empties again', () => {
    // Resolving the last thread must give the real empty state, not send the
    // drawer back to a loading message it can never leave.
    const { panel, container } = mountPanel();
    panel.setThreads([makeThread('t1')]);
    panel.markSynced();
    panel.setThreads([]);

    expect(bodyText(container)).toContain('No open comments');
    expect(bodyText(container)).not.toContain('Loading');
  });
});
