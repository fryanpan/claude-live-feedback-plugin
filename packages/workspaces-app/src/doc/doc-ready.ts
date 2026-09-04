/**
 * What happens when the document's Yjs state actually arrives, and what
 * happens every time its metadata changes afterwards.
 *
 * The two belong together because they render the same two things — the doc
 * label and the set navigation — and the first sync is simply the first of
 * those ticks. What only the FIRST sync may do is here too: start the
 * task-link chips (the board is not known until meta has synced), and run the
 * mount's own `onFirstSync`, which is where a reveal read off the address
 * lands. Re-running either on every later sync would re-fetch a board that
 * has not changed and yank a reader back mid-read.
 */
import type { FeedbackClient } from '@feedback/core';
import { readDocMeta } from '@feedback/core';
import type * as Y from 'yjs';
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import type { ReviewChrome } from '../review-chrome.ts';
import { watchTaskLinkStatuses } from '../task-link-chips.ts';

export interface DocReadyOptions {
  client: FeedbackClient;
  ydoc: Y.Doc;
  scope: MountScope;
  chrome: ReviewChrome;
  editor: EditorHandle;
  /** The workspace the MountContext already named, if any. Falls back to the
   *  doc's own meta once that has synced. */
  workspaceId: string | undefined;
  /** Re-render the sidebar / dropdown for this doc's set. */
  renderSetNav: () => Promise<void>;
  /** Run once, the first time the document's state arrives — the mount's own
   *  `?thread=` reveal. Later syncs do not repeat it. */
  onFirstSync?: () => void;
}

export function wireDocReady(opts: DocReadyOptions): void {
  const { client, ydoc, scope, chrome, editor, workspaceId, renderSetNav, onFirstSync } = opts;

  const meta = ydoc.getMap('meta');
  const onMeta = () => {
    chrome.renderDocLabel();
    void renderSetNav();
  };
  meta.observe(onMeta);
  scope.onCleanup(() => meta.unobserve(onMeta));

  // Live task-link status chips: once the doc's meta has synced (onReady) we
  // know its board, and the board's `task.transitioned` push keeps every chip
  // honest — the "filed in the meeting, flips when dispatched" surface.
  let chipsWatched = false;
  function watchChips(): void {
    if (chipsWatched || scope.disposed) return;
    const chipWorkspaceId = workspaceId ?? readDocMeta(ydoc).workspaceId;
    if (!chipWorkspaceId) return;
    chipsWatched = true;
    scope.onCleanup(watchTaskLinkStatuses(chipWorkspaceId, editor.editor.view));
  }

  let firstSyncDone = false;
  client.onReady(() => {
    if (scope.disposed) return;
    chrome.renderDocLabel();
    void renderSetNav();
    chrome.redrawThreads();
    if (!firstSyncDone) {
      firstSyncDone = true;
      onFirstSync?.();
    }
    watchChips();
  });
}
