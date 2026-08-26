/**
 * Resolve a pasted workspace URL to the title a reader should see — the
 * server half of "a raw link renders as its title" (`POST /api/links/titles`).
 *
 * Pure given its sources, so it is testable without a server: the route hands
 * it the lookups (doc meta, board membership, task, workspace) and this
 * module owns which URL shape asks which one. Unresolvable is ALWAYS `null`,
 * never a throw — the client's contract is "null means show the raw URL".
 *
 * A board-scoped address must be TRUTHFUL to resolve: a URL that names a
 * workspace only yields a title when the resource actually belongs to that
 * workspace. Otherwise a valid id pasted under the wrong board would leak the
 * title of a resource the address lies about.
 */
import { parseWorkspaceLink } from '@feedback/core';
import { taskIdOfBodyDoc } from './task-projection.ts';

export interface LinkTitleSources {
  /** A doc's display meta, or undefined for an unknown docId. */
  docMeta(docId: string): { title?: string; relPath?: string } | undefined;
  /** Whether the doc is filed on this board (directly or via its review). */
  docInWorkspace(docId: string, workspaceId: string): boolean;
  /** A task's title AND home board — the board check needs both. */
  task(taskId: string): { title: string; workspaceId: string } | undefined;
  workspaceName(workspaceId: string): string | undefined;
}

export function linkTitleFor(url: string, sources: LinkTitleSources): string | null {
  const link = parseWorkspaceLink(url);
  if (!link) return null;
  switch (link.kind) {
    case 'workspace':
      return sources.workspaceName(link.workspaceId) ?? null;
    case 'task': {
      const task = sources.task(link.taskId);
      if (!task || task.workspaceId !== link.workspaceId) return null;
      return task.title;
    }
    case 'doc':
    case 'mockup': {
      // A task's body room is addressed as `task:<id>` — its title is the
      // task's, which is also the only title it has.
      const taskId = taskIdOfBodyDoc(link.docId);
      if (taskId) {
        const task = sources.task(taskId);
        if (!task) return null;
        if (link.workspaceId !== null && task.workspaceId !== link.workspaceId) return null;
        return task.title;
      }
      const meta = sources.docMeta(link.docId);
      if (!meta) return null;
      // The legacy `/review/<id>` shape names no workspace — nothing to hold
      // it against. The board-scoped shape must be telling the truth.
      if (link.workspaceId !== null && !sources.docInWorkspace(link.docId, link.workspaceId))
        return null;
      // A diff-review member has no stored title; its repo-relative path is
      // what every sidebar calls it, so it is the honest display name.
      return meta.title ?? meta.relPath ?? null;
    }
    // A review's landing URL redirects to its entry doc; the set itself
    // stores no display title today, so the raw URL stands.
    case 'review':
      return null;
  }
}

/** One lookup's batch cap — a comment cannot hold more distinct links than
 *  this, and an unbounded body must not become an unbounded scan. The client
 *  keeps batching, so links past the cap resolve on its next request. */
export const LINK_TITLE_BATCH_LIMIT = 100;

/** Resolve a batch: `{ url → title|null }`, capped at the batch limit. */
export function linkTitlesFor(
  urls: string[],
  sources: LinkTitleSources,
): Record<string, string | null> {
  const titles: Record<string, string | null> = {};
  for (const url of urls.slice(0, LINK_TITLE_BATCH_LIMIT)) {
    if (typeof url !== 'string') continue;
    titles[url] = linkTitleFor(url, sources);
  }
  return titles;
}
