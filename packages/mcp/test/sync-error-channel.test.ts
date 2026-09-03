/**
 * The channel renderer turns a `doc.sync_error` frame into a readable
 * sentence, not the bare-slug fallback.
 *
 * The server broadcasts `doc.sync_error` when a write into a bound doc is
 * lost (conflict reassert, parse failure) — see
 * `packages/server/test/sync-error-event.test.ts` for the end-to-end half.
 * This layer is the last hop: `emitChannelMessage` rebuilds each event's line
 * by hand, so an event it has no case for renders as `[doc.sync_error] thread `
 * — a slug that buries exactly the event whose whole point is being noticed.
 *
 * This file used to read `mcp.ts` as text and grep the renderer's body for
 * `p.path` / `p.message` / `backup_path`. Two things were wrong with that. It
 * asserts the strings exist, not that a frame comes out carrying them, so it
 * would pass on a handler whose `notify` call had been deleted. And its bound
 * was `SRC.indexOf('\nfunction ', start)`, which returns -1 once the renderer
 * is the last declaration in its file — `slice(start, -1)` is then the whole
 * tail rather than one function, so the "renderer body" it grepped had no
 * boundary at all. `createChannelMessages` takes its notification sink as an
 * argument, so the frame itself is now the subject.
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

/** The one frame a call produced — fails loudly on zero or two. */
function only(frames: ChannelNotification['params'][]) {
  expect(frames).toHaveLength(1);
  return frames[0] as ChannelNotification['params'];
}

describe('doc.sync_error renders as a sentence on the channel', () => {
  it('leads with the bound file and carries the server’s own message', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('doc.sync_error', {
      docId: 'plan',
      path: '/repo/docs/plan.md',
      message: 'external write lost — the doc reasserted and your edit was backed up',
      backupPath: '/tmp/plan.md.bak',
    });
    expect(only(frames).content).toBe(
      '[sync error] /repo/docs/plan.md: external write lost — the doc reasserted and your edit was backed up',
    );
  });

  /**
   * THE FAILURE THIS FILE EXISTS FOR. Without a dedicated arm the frame falls
   * through to the thread-shaped renderer and comes out as
   * `[doc.sync_error] thread ` — an event about lost bytes, rendered as an
   * empty thread notification.
   */
  it('never renders as the bare-slug thread fallback', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('doc.sync_error', {
      docId: 'plan',
      path: '/repo/docs/plan.md',
      message: 'parse failed',
    });
    const f = only(frames);
    expect(f.content).not.toContain('thread');
    expect(f.content).not.toContain('doc.sync_error');
    expect(f.content.startsWith('[sync error]')).toBe(true);
  });

  it('puts the backup path in the structured meta, not only in the prose', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('doc.sync_error', {
      docId: 'plan',
      path: '/repo/docs/plan.md',
      message: 'external write lost',
      backupPath: '/tmp/plan.md.bak',
    });
    // An agent reads the overwritten bytes back from this without parsing the
    // sentence, which is why the path rides the meta as well.
    expect(only(frames).meta).toMatchObject({
      doc_id: 'plan',
      event: 'doc.sync_error',
      path: '/repo/docs/plan.md',
      backup_path: '/tmp/plan.md.bak',
    });
  });

  it('omits the backup key entirely when no backup was written', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('doc.sync_error', {
      docId: 'plan',
      path: '/repo/docs/plan.md',
      message: 'parse failed',
    });
    // Absent, not `undefined`: an agent branching on the key must not see one
    // that is present and empty.
    expect('backup_path' in only(frames).meta).toBe(false);
  });

  it('falls back to the doc id when the frame carries no path', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('doc.sync_error', {
      docId: 'plan',
      message: 'external write lost',
    });
    const f = only(frames);
    expect(f.content).toBe('[sync error] plan: external write lost');
    expect('path' in f.meta).toBe(false);
  });

  it('says what to do when an older server sends no message at all', async () => {
    const { frames, messages } = harness();
    await messages.emitChannelMessage('doc.sync_error', { docId: 'plan' });
    // Silence here would be a sync failure rendered as an empty sentence.
    expect(only(frames).content).toBe(
      '[sync error] plan: disk↔doc sync failed — call get_doc for details',
    );
  });
});
