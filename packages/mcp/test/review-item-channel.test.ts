/**
 * A comment on one of this agent's review items arrives naming the item.
 *
 * The server frame for a thread anchored to a review item carries
 * `reviewItemId` (top level, and on `thread.anchor`). The channel renderer
 * rebuilds each line by hand, so unless it reads that field the agent gets
 * `[created] Jordan: Twice per what?` with a doc id and a thread id — and has
 * to call list_threads to learn which of its items the question is about,
 * which is the lookup `revise_review_item` should not need.
 *
 * This file used to read `mcp.ts` as text and grep the thread branch for
 * `p.reviewItemId` and `review_item_id`. That asserts the identifiers appear
 * somewhere, not that a frame comes out naming the item — and its slice was
 * bounded by `SRC.indexOf('\nfunction ', start)`, which returns -1 once the
 * renderer is the last declaration in its file, making the "branch" it
 * grepped the whole tail. `createChannelMessages` takes its notification sink
 * as an argument, so the rendered line is now the subject.
 */
import { describe, expect, it } from 'vitest';
import { type ChannelNotification, createChannelMessages } from '../src/channel-messages.ts';

const FIXED_MS = Date.UTC(2026, 8, 3, 12, 0, 0);

function harness() {
  const frames: ChannelNotification['params'][] = [];
  const messages = createChannelMessages({
    notify: async (n) => {
      frames.push(n.params);
    },
    http: async () => ({}),
    authorId: 'agent-workspaces',
    now: () => FIXED_MS,
  });
  return { frames, messages };
}

function only(frames: ChannelNotification['params'][]) {
  expect(frames).toHaveLength(1);
  return frames[0] as ChannelNotification['params'];
}

describe('a review-item comment names the item on the channel', () => {
  it('names the item in the readable line, where the agent actually reads', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.created', {
      docId: 'task:t-4',
      threadId: 'th-1',
      reviewItemId: 'ri-9',
      comment: { author: { name: 'Jordan' }, text: 'Twice per what?', ts: FIXED_MS },
    });
    // The meta is for tooling; `content` is what turns "somebody commented on
    // the task" into "revise this item".
    expect(only(frames).content).toBe('[created] on review item ri-9 — Jordan: Twice per what?');
  });

  it('carries the id in the structured meta as well', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.created', {
      docId: 'task:t-4',
      threadId: 'th-1',
      reviewItemId: 'ri-9',
      comment: { author: { name: 'Jordan' }, text: 'Twice per what?' },
    });
    expect(only(frames).meta).toMatchObject({
      doc_id: 'task:t-4',
      thread_id: 'th-1',
      review_item_id: 'ri-9',
      event: 'thread.created',
      author: 'Jordan',
    });
  });

  it('falls back to the anchor when an older server stamps no top-level id', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      docId: 'task:t-4',
      threadId: 'th-2',
      comment: { author: { name: 'Jordan' }, text: 'ok' },
      thread: { anchor: { kind: 'review-item', reviewItemId: 'ri-7' } },
    });
    const f = only(frames);
    expect(f.content).toContain('on review item ri-7');
    expect(f.meta.review_item_id).toBe('ri-7');
  });

  it('ignores an anchor that is not a review item', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      docId: 'plan',
      threadId: 'th-3',
      comment: { author: { name: 'Jordan' }, text: 'ok' },
      // A prose anchor that happens to carry the field must not be read as an
      // item, or every doc comment claims to be one.
      thread: { anchor: { kind: 'text', reviewItemId: 'ri-7' } },
    });
    const f = only(frames);
    expect(f.content).not.toContain('review item');
    expect('review_item_id' in f.meta).toBe(false);
  });

  /**
   * POSITIVE CONTROL. Every assertion above is that a phrase appears. This is
   * the one that proves the phrase is conditional: an ordinary doc comment
   * must render exactly as it did before the item id existed.
   */
  it('leaves an ordinary comment untouched — no phrase, no key', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.replied', {
      docId: 'plan',
      threadId: 'th-4',
      comment: { author: { name: 'Bryan' }, text: 'tighten this', ts: FIXED_MS },
    });
    const f = only(frames);
    expect(f.content).toBe('[replied] Bryan: tighten this');
    expect('review_item_id' in f.meta).toBe(false);
  });

  it('names the item on a status change too, which carries no comment text', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('thread.resolved', {
      docId: 'task:t-4',
      threadId: 'th-5',
      reviewItemId: 'ri-9',
      actor: { name: 'Bryan' },
    });
    // The text-less branch builds a different sentence; the item has to
    // survive that one as well, since a resolved item is what closes the loop.
    expect(only(frames).content).toContain('on review item ri-9');
  });

  it('truncates the anchor beside the item id rather than pasting the paragraph', async () => {
    const { frames, messages } = harness();
    const long = 'x'.repeat(200);
    await messages.emitChannelMessage('thread.created', {
      docId: 'task:t-4',
      threadId: 'th-6',
      reviewItemId: 'ri-9',
      thread: { anchor: { snippet: { text: long } }, comments: [] },
    });
    const f = only(frames);
    expect(f.content).toContain('on review item ri-9');
    expect(f.content).toContain('…');
    expect(f.content).not.toContain(long);
    // The meta keeps the whole anchor — the truncation is for the reader.
    expect(f.meta.anchor_text).toBe(long);
  });
});
