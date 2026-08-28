/**
 * Resolve a pasted workspace URL to what a reader should see — the server
 * half of "a raw link renders as its title" (`POST /api/links/titles`).
 * Task and goal addresses additionally carry the row's STATUS, so the client
 * can hang a status chip beside the title (and beside an author-chosen label).
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
import type { TaskStatus } from './tasks.ts';

export interface LinkTitleSources {
  /** A doc's display meta, or undefined for an unknown docId. */
  docMeta(docId: string): { title?: string; relPath?: string } | undefined;
  /** Whether the doc is filed on this board (directly or via its review). */
  docInWorkspace(docId: string, workspaceId: string): boolean;
  /** A task's — or a GOAL's, they share the id namespace and the status
   *  machine — title, home board, and status. The board check needs the
   *  workspaceId; the status becomes the chip. */
  task(taskId: string): { title: string; workspaceId: string; status: TaskStatus } | undefined;
  workspaceName(workspaceId: string): string | undefined;
}

/** What one URL resolves to. `status` only ever appears on task/goal-backed
 *  addresses — its absence is what tells the client "no chip here". */
export interface ResolvedLink {
  title: string | null;
  status?: TaskStatus;
}

export function linkInfoFor(url: string, sources: LinkTitleSources): ResolvedLink {
  const link = parseWorkspaceLink(url);
  if (!link) return { title: null };
  switch (link.kind) {
    case 'workspace':
      return { title: sources.workspaceName(link.workspaceId) ?? null };
    case 'task': {
      const task = sources.task(link.taskId);
      if (!task || task.workspaceId !== link.workspaceId) return { title: null };
      return { title: task.title, status: task.status };
    }
    // The goal panel's own address shape. Same lookup as a task on purpose:
    // goals and tasks share the id namespace and the status machine, and the
    // route's `task` source already reaches both.
    case 'goal': {
      const goal = sources.task(link.goalId);
      if (!goal || goal.workspaceId !== link.workspaceId) return { title: null };
      return { title: goal.title, status: goal.status };
    }
    case 'doc':
    case 'mockup': {
      // A task's body room is addressed as `task:<id>` — its title is the
      // task's, which is also the only title it has.
      const taskId = taskIdOfBodyDoc(link.docId);
      if (taskId) {
        const task = sources.task(taskId);
        if (!task) return { title: null };
        if (link.workspaceId !== null && task.workspaceId !== link.workspaceId)
          return { title: null };
        return { title: task.title, status: task.status };
      }
      const meta = sources.docMeta(link.docId);
      if (!meta) return { title: null };
      // The legacy `/review/<id>` shape names no workspace — nothing to hold
      // it against. The board-scoped shape must be telling the truth.
      if (link.workspaceId !== null && !sources.docInWorkspace(link.docId, link.workspaceId))
        return { title: null };
      // A diff-review member has no stored title; its repo-relative path is
      // what every sidebar calls it, so it is the honest display name.
      return { title: meta.title ?? meta.relPath ?? null };
    }
    // A review's landing URL redirects to its entry doc; the set itself
    // stores no display title today, so the raw URL stands.
    case 'review':
      return { title: null };
  }
}

/** One lookup's batch cap — a comment cannot hold more distinct links than
 *  this, and an unbounded body must not become an unbounded scan. The client
 *  keeps batching, so links past the cap resolve on its next request. */
export const LINK_TITLE_BATCH_LIMIT = 100;

/**
 * Resolve a batch, capped at the batch limit. `titles` keeps its original
 * shape (`url → title|null`) so a client on an older bundle keeps working;
 * `statuses` holds an entry ONLY for task/goal-backed URLs.
 */
export function linkTitlesFor(
  urls: string[],
  sources: LinkTitleSources,
): { titles: Record<string, string | null>; statuses: Record<string, TaskStatus> } {
  const titles: Record<string, string | null> = {};
  const statuses: Record<string, TaskStatus> = {};
  for (const url of urls.slice(0, LINK_TITLE_BATCH_LIMIT)) {
    if (typeof url !== 'string') continue;
    const info = linkInfoFor(url, sources);
    titles[url] = info.title;
    if (info.status !== undefined) statuses[url] = info.status;
  }
  return { titles, statuses };
}
