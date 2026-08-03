import type { FeedbackClient, User } from '@feedback/core';
import type { MountScope } from './mount-scope.ts';

/**
 * Per-document metadata resolved from `/api/docs/<id>` before a surface mounts.
 * `docType` picks which surface renders (markdown → Tiptap; code/diff →
 * CodeMirror; a `.md` diff → the Word-style redline).
 */
export interface DocMeta {
  docType: 'markdown' | 'code' | 'diff';
  sourceUrl: string;
  workspaceId: string;
  relPath: string;
  /** The pinned target commit of a diff doc. Empty string = live
   *  working-tree mode, where the File view is an editor (the server binds
   *  those members with write-back); pinned content is immutable. */
  diffTarget: string;
}

/**
 * Everything a single document's mount receives. Assembled once per navigation
 * by the router: it owns the `scope` (dispose = tear the mount down) and the
 * `client` (the Yjs websocket for this doc), and registers `client.close()` on
 * the scope so a navigation releases the socket.
 */
export interface MountContext extends DocMeta {
  docId: string;
  scope: MountScope;
  client: FeedbackClient;
  user: User;
}

/** A per-doc mount. Registers its teardown on `ctx.scope` (listeners via
 *  `ctx.scope.listen`, imperative via `ctx.scope.onCleanup`) and returns. The
 *  router unwinds it with `ctx.scope.dispose()`. */
export type MountFn = (ctx: MountContext) => Promise<void> | void;
