/**
 * The host that puts a live editor over a task's body room.
 *
 * Everything below drives the real `createTaskBodyEditorHost` with a fake
 * websocket client and a fake editor module — the Tiptap half is behind a
 * dynamic import precisely so it never enters the board's bundle, and a test
 * that imported it would be measuring the thing the design avoids. What is
 * under test here is the LIFECYCLE: which room gets opened, when a mount is
 * kept, when it is torn down, and what a failed chunk fetch leaves behind.
 */
import type { FeedbackClient } from '@feedback/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BODY_LIVE_CLASS } from '../src/hub/hub-render.ts';
import {
  type EditorModule,
  LOAD_FAILED_TEXT,
  PLACEHOLDER_TEXT,
  type TaskBodyTarget,
  createTaskBodyEditorHost,
} from '../src/hub/task-body-editor.ts';

interface FakeClient extends FeedbackClient {
  docId: string;
  closed: boolean;
}

function fakeClient(docId: string): FakeClient {
  const ydoc = new Y.Doc();
  const c = {
    docId,
    closed: false,
    ydoc,
    awareness: { doc: ydoc } as unknown as FeedbackClient['awareness'],
    ws: {} as WebSocket,
    status: 'open' as const,
    close() {
      c.closed = true;
    },
    onReady: () => {},
    onStatus: () => {},
  };
  return c;
}

interface Harness {
  clients: FakeClient[];
  destroyed: number;
  created: Array<{ parent: HTMLElement; ydoc: Y.Doc; extensions: unknown[] }>;
  /** Resolve the pending chunk load. Nothing mounts until this is called —
   *  which is what makes the "a repaint arrives while the chunk is in
   *  flight" cases expressible at all. */
  land: () => Promise<void>;
  fail: () => Promise<void>;
  loads: number;
}

function harness(over: { withPlaceholder?: boolean } = {}) {
  const h: Harness = { clients: [], destroyed: 0, created: [], land: async () => {}, loads: 0 };
  let settle: ((mod: EditorModule) => void) | null = null;
  let reject: ((err: Error) => void) | null = null;

  const mod: EditorModule = {
    createEditor: (opts) => {
      h.created.push({
        parent: opts.parent,
        ydoc: opts.ydoc,
        extensions: opts.extraExtensions ?? [],
      });
      return {
        destroy: () => {
          h.destroyed += 1;
        },
      } as unknown as ReturnType<EditorModule['createEditor']>;
    },
    ...(over.withPlaceholder
      ? { placeholder: (text: string) => ({ name: 'placeholder', text }) as never }
      : {}),
  };

  const host = createTaskBodyEditorHost({
    connect: (docId) => {
      const c = fakeClient(docId);
      h.clients.push(c);
      return c;
    },
    loadEditor: () => {
      h.loads += 1;
      return new Promise<EditorModule>((res, rej) => {
        settle = res;
        reject = rej;
      });
    },
    user: { name: 'Jordan', color: '#2e7dd7' },
  });

  h.land = async () => {
    settle?.(mod);
    await Promise.resolve();
    await Promise.resolve();
  };
  h.fail = async () => {
    reject?.(new Error('chunk 404'));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { host, h };
}

const target = (id: string): TaskBodyTarget => ({ id, bodyDocId: `task:${id}` });

let slot: HTMLElement;
beforeEach(() => {
  slot = document.createElement('div');
  slot.className = 'hub-detail-body-slot';
  document.body.replaceChildren(slot);
});

describe('createTaskBodyEditorHost', () => {
  it('opens the task’s own body room and mounts the editor over it', async () => {
    const { host, h } = harness();
    host.sync(target('t-1'), slot);
    await h.land();

    // The room is the one an agent writes through `set_doc_content`, not a
    // second store — that identity is the whole reason the panel can be
    // edited while an agent is rewriting the same description.
    expect(h.clients.map((c) => c.docId)).toEqual(['task:t-1']);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.parent).toBe(slot);
    expect(h.created[0]?.ydoc).toBe(h.clients[0]?.ydoc);
    expect(host.isLive('t-1')).toBe(true);
  });

  // The property the panel depends on: a repaint hands the same pair back,
  // and a second mount would mean a second websocket and a lost caret.
  it('is a no-op when the same task and the same slot come back', async () => {
    const { host, h } = harness();
    host.sync(target('t-1'), slot);
    await h.land();
    host.sync(target('t-1'), slot);
    host.sync(target('t-1'), slot);

    expect(h.clients).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    expect(h.destroyed).toBe(0);
  });

  // The anti-churn property, and the reason the class is added before the
  // chunk is asked for rather than when it lands. Opening a task repaints the
  // panel several times within a moment; if the slot only went live at mount
  // time, every one of those repaints would rebuild it, tear the pending
  // mount down and open another socket.
  it('claims the slot before the chunk lands, so a repaint in that window keeps it', async () => {
    const { host, h } = harness();
    host.sync(target('t-1'), slot);

    expect(slot.classList.contains(BODY_LIVE_CLASS)).toBe(true);
    expect(h.created).toHaveLength(0); // positive control: nothing mounted yet

    // What a repaint does with a live slot: hands the very same node back.
    host.sync(target('t-1'), slot);
    await h.land();

    expect(h.clients).toHaveLength(1);
    expect(h.loads).toBe(1);
    expect(h.created).toHaveLength(1);
  });

  it('moves to the other room when the reader opens another task', async () => {
    const { host, h } = harness();
    host.sync(target('t-1'), slot);
    await h.land();

    const next = document.createElement('div');
    document.body.append(next);
    host.sync(target('t-2'), next);
    await h.land();

    expect(h.clients.map((c) => c.docId)).toEqual(['task:t-1', 'task:t-2']);
    expect(h.clients[0]?.closed).toBe(true);
    expect(h.clients[1]?.closed).toBe(false);
    expect(h.destroyed).toBe(1);
    expect(slot.classList.contains(BODY_LIVE_CLASS)).toBe(false);
    expect(next.classList.contains(BODY_LIVE_CLASS)).toBe(true);
  });

  it('lets go of the room when the panel closes', async () => {
    const { host, h } = harness();
    host.sync(target('t-1'), slot);
    await h.land();
    host.sync(null, null);

    expect(h.clients[0]?.closed).toBe(true);
    expect(h.destroyed).toBe(1);
    expect(host.isLive('t-1')).toBe(false);
    expect(slot.classList.contains(BODY_LIVE_CLASS)).toBe(false);
  });

  // A late mount would put an editor for a task the reader has left into a
  // slot that no longer shows it.
  it('does not mount when the reader left while the chunk was in flight', async () => {
    const { host, h } = harness();
    host.sync(target('t-1'), slot);
    host.sync(null, null);
    await h.land();

    expect(h.created).toHaveLength(0);
    expect(h.clients[0]?.closed).toBe(true);
  });

  it('gives the empty description something to say', async () => {
    const { host, h } = harness({ withPlaceholder: true });
    host.sync(target('t-1'), slot);
    await h.land();

    expect(h.created[0]?.extensions).toEqual([{ name: 'placeholder', text: PLACEHOLDER_TEXT }]);
  });

  it('mounts without a placeholder rather than not at all', async () => {
    // Positive control for the case above: the extension is optional, so a
    // module without one still produces an editor.
    const { host, h } = harness({ withPlaceholder: false });
    host.sync(target('t-1'), slot);
    await h.land();

    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.extensions).toEqual([]);
  });

  describe('when the editor chunk cannot be fetched', () => {
    it('hands the slot back and says why, instead of leaving dead text', async () => {
      const { host, h } = harness();
      host.sync(target('t-1'), slot);
      await h.fail();

      expect(h.clients[0]?.closed).toBe(true);
      expect(host.isLive('t-1')).toBe(false);
      // Live class dropped, so the next repaint rebuilds the slot and the
      // description goes back to tracking the projection.
      expect(slot.classList.contains(BODY_LIVE_CLASS)).toBe(false);
      expect(slot.textContent).toContain(LOAD_FAILED_TEXT);
    });

    it('does not try again on every repaint', async () => {
      const { host, h } = harness();
      host.sync(target('t-1'), slot);
      await h.fail();

      // A rebuilt slot for the same task, and then another task: neither may
      // re-enter the import. Without the retirement each repaint would open
      // a fresh websocket and ask for the chunk again, forever.
      const rebuilt = document.createElement('div');
      host.sync(target('t-1'), rebuilt);
      host.sync(target('t-2'), rebuilt);

      expect(h.loads).toBe(1);
      expect(h.clients).toHaveLength(1);
      expect(rebuilt.classList.contains(BODY_LIVE_CLASS)).toBe(false);
    });
  });

  it('destroy() releases whatever is mounted', async () => {
    const { host, h } = harness();
    host.sync(target('t-1'), slot);
    await h.land();
    host.destroy();

    expect(h.destroyed).toBe(1);
    expect(h.clients[0]?.closed).toBe(true);
    expect(vi.isMockFunction(host.sync)).toBe(false); // the real host, not a double
  });
});
