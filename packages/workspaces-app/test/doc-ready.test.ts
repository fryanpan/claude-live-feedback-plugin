import type { FeedbackClient } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { wireDocReady } from '../src/doc/doc-ready.ts';
import type { EditorHandle } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';
import type { ReviewChrome } from '../src/review-chrome.ts';

/**
 * The sync phase of a document's boot (doc/doc-ready.ts).
 *
 * Every metadata tick redraws the doc label and the set navigation; the first
 * sync is simply the first of those ticks, plus the two things that may only
 * happen once — the mount's own reveal (the `?thread=` deep link) and the
 * task-link chip watch. Re-running the reveal on a later sync would yank a
 * reader back mid-read, which is what these tests pin.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
});

function fakeClient() {
  const readyCbs: Array<() => void> = [];
  const client = {
    onReady: (cb: () => void) => readyCbs.push(cb),
    onStatus: () => {},
  } as unknown as FeedbackClient;
  return { client, sync: () => [...readyCbs].forEach((cb) => cb()) };
}

function wire(opts: { workspaceId?: string } = {}) {
  const { client, sync } = fakeClient();
  const ydoc = new Y.Doc();
  const scope = new MountScope();
  const renderDocLabel = vi.fn();
  const redrawThreads = vi.fn();
  const renderSetNav = vi.fn(async () => {});
  const onFirstSync = vi.fn();
  const chrome = { renderDocLabel, redrawThreads } as unknown as ReviewChrome;
  // The chips watch reaches through to a live ProseMirror view; nothing here
  // gives it a board to watch, so it is never asked for one.
  const editor = { editor: { view: {} } } as unknown as EditorHandle;
  wireDocReady({
    client,
    ydoc,
    scope,
    chrome,
    editor,
    workspaceId: opts.workspaceId,
    renderSetNav,
    onFirstSync,
  });
  open.push(() => {
    scope.dispose();
    ydoc.destroy();
  });
  return { ydoc, scope, sync, renderDocLabel, redrawThreads, renderSetNav, onFirstSync };
}

describe('a metadata change', () => {
  it('redraws the doc label and the set navigation', () => {
    const { ydoc, renderDocLabel, renderSetNav } = wire();
    expect(renderDocLabel).not.toHaveBeenCalled();
    ydoc.getMap('meta').set('title', 'Renamed');
    expect(renderDocLabel).toHaveBeenCalledTimes(1);
    expect(renderSetNav).toHaveBeenCalledTimes(1);
  });

  it('stops redrawing once the mount is torn down', () => {
    const { ydoc, scope, renderDocLabel } = wire();
    scope.dispose();
    ydoc.getMap('meta').set('title', 'Renamed after navigation');
    expect(renderDocLabel).not.toHaveBeenCalled();
  });
});

describe('the first sync', () => {
  it('draws the label, the nav and the threads, and runs the mount reveal', () => {
    const { sync, renderDocLabel, renderSetNav, redrawThreads, onFirstSync } = wire();
    sync();
    expect(renderDocLabel).toHaveBeenCalledTimes(1);
    expect(renderSetNav).toHaveBeenCalledTimes(1);
    expect(redrawThreads).toHaveBeenCalledTimes(1);
    expect(onFirstSync).toHaveBeenCalledTimes(1);
  });

  it('keeps redrawing on later syncs but never reveals twice', () => {
    const { sync, redrawThreads, onFirstSync } = wire();
    sync();
    sync();
    sync();
    // A reconnect redraws — threads may have changed while the socket was
    // down. It must not jump the reader back to the deep-linked comment.
    expect(redrawThreads).toHaveBeenCalledTimes(3);
    expect(onFirstSync).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when the mount has already been torn down', () => {
    const { scope, sync, redrawThreads, onFirstSync } = wire();
    scope.dispose();
    sync();
    expect(redrawThreads).not.toHaveBeenCalled();
    expect(onFirstSync).not.toHaveBeenCalled();
  });
});
