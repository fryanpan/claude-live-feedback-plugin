import type { FeedbackClient, User } from '@feedback/core';
import type { BackTarget } from './back-link.ts';
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
  /** The workspace board this doc was reached from, when the server can name
   *  one — where the shell's back arrow should return to instead of the
   *  machine-wide index. Absent for a doc on no board, and for a share
   *  visitor (a board id is an unguessable URL capability). */
  backTo?: BackTarget;
  /** A huddle doc — a live conversation over a doc, started from the Board
   *  before there is a task. The crumb names it; nothing else about the
   *  surface changes. */
  huddle?: boolean;
}

/**
 * Everything a single document's mount receives. Assembled once per navigation
 * by the router: it owns the `scope` (dispose = tear the mount down) and the
 * `client` (the Yjs websocket for this doc), and registers `client.close()` on
 * the scope so a navigation releases the socket.
 */
export interface MountContext extends DocMeta {
  docId: string;
  /** docId the SIDEBAR should mark active when it differs from `docId`.
   *  The editable File view of a `.md` diff member mounts the markdown
   *  editor over a companion doc (docId = companion), but the diff-nav and
   *  workspace tree only list the diff member — highlighting by the
   *  companion id would leave no file marked active. Defaults to `docId`. */
  navDocId?: string;
  scope: MountScope;
  client: FeedbackClient;
  user: User;
  /**
   * Whether the SERVER will accept writes from this browser — the answer to
   * `/api/auth/session`, awaited once by `main()` before the router starts and
   * handed to every mount, exactly like `user`.
   *
   * Required, not optional, and that is the whole point. A surface used to
   * decide it was an editor from a stored preference and ask the server
   * afterwards, which left the document live and typeable for one round trip
   * and then silently threw the typing away (see `edit-mode.ts`). A required
   * field means a surface cannot mount without having been told, and the
   * compiler is what checks it rather than a reviewer.
   */
  canWrite: boolean;
}

/** A per-doc mount. Registers its teardown on `ctx.scope` (listeners via
 *  `ctx.scope.listen`, imperative via `ctx.scope.onCleanup`) and returns. The
 *  router unwinds it with `ctx.scope.dispose()`. */
export type MountFn = (ctx: MountContext) => Promise<void> | void;
