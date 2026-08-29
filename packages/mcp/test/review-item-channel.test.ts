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
 * Source-reading, like sync-error-channel.test.ts: mcp.ts is a bundle entry
 * point and exports nothing, and the committed bundle is covered by CI's
 * build:mcp drift gate.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');

/** emitChannelMessage's body, start to the next top-level function. */
function channelRenderer(): string {
  const start = SRC.indexOf('async function emitChannelMessage(');
  expect(start, 'emitChannelMessage not found').toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf('\nfunction ', start));
}

/** The thread.* branch: everything after the suggestion branch returns. */
function threadBranch(): string {
  const renderer = channelRenderer();
  const start = renderer.indexOf("const threadId = p.threadId ?? ''");
  expect(start, 'thread branch not found').toBeGreaterThan(-1);
  return renderer.slice(start);
}

describe('a review-item comment names the item on the channel', () => {
  it('reads the frame-level reviewItemId, falling back to the anchor', () => {
    const branch = threadBranch();
    expect(branch).toContain('p.reviewItemId');
    expect(branch).toContain("anchor?.kind === 'review-item'");
  });

  it('carries the id in the structured meta as review_item_id', () => {
    const branch = threadBranch();
    const meta = branch.slice(branch.indexOf('meta: {'));
    expect(meta).toContain('review_item_id');
  });

  it('says so in the readable line, where the agent actually reads it', () => {
    // The meta is for tooling; the agent reads `content`. A line that names
    // the item is what turns "somebody commented on the task" into "revise
    // this item".
    const branch = threadBranch();
    const body = branch.slice(0, branch.indexOf('meta: {'));
    expect(body).toMatch(/review item/);
  });

  // POSITIVE CONTROL for the probes above: the slices land on the renderer
  // and the branch, not on an empty string that would contain nothing.
  it('the probe finds the thread branch it reads', () => {
    expect(threadBranch()).toContain('anchor_text: snippet');
  });
});
