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

/** The last-resort display name for a file-backed doc with no title and no
 *  `relPath`: its own file's basename, or `null` when there is no
 *  `sourceUrl` either (a doc that carries no file-shaped identity at all —
 *  the caller falls back to the raw id in that case, which stays honest
 *  rather than inventing a name). Mirrors `basenameOf` in server.ts; kept
 *  local rather than imported to avoid a cycle (server.ts imports this
 *  module). */
function basenameOfSourceUrl(sourceUrl: string | undefined): string | null {
  if (!sourceUrl) return null;
  const m = sourceUrl.match(/[^/\\]+$/);
  return m ? m[0] : sourceUrl;
}

export interface LinkTitleSources {
  /** A doc's display meta, or undefined for an unknown docId. `sourceUrl` is
   *  the file path a mockup/markdown doc is bound to when it has no
   *  `relPath` of its own (a bind outside a workspace's notes home) — the
   *  last fallback before a caller would otherwise see the raw doc id. */
  docMeta(docId: string): { title?: string; relPath?: string; sourceUrl?: string } | undefined;
  /** Whether the doc is filed on this board (directly or via its review). */
  docInWorkspace(docId: string, workspaceId: string): boolean;
  /** A task's — or a GOAL's, they share the id namespace and the status
   *  machine — title, home board, and status. The board check needs the
   *  workspaceId; the status becomes the chip. `planHeld` marks a draft row
   *  held behind an unapproved plan (goals never carry it), so the chip can
   *  say what the row IS rather than "triage". */
  task(
    taskId: string,
  ): { title: string; workspaceId: string; status: TaskStatus; planHeld?: boolean } | undefined;
  workspaceName(workspaceId: string): string | undefined;
}

/** What one URL resolves to. `status` only ever appears on task/goal-backed
 *  addresses — its absence is what tells the client "no chip here".
 *  `planHeld` only ever appears as `true`, and only beside a status. */
export interface ResolvedLink {
  title: string | null;
  status?: TaskStatus;
  planHeld?: boolean;
}

/** The task-source answer folded into a ResolvedLink — one spot so the three
 *  task-backed URL shapes cannot disagree on how `planHeld` rides along. */
function taskLink(t: { title: string; status: TaskStatus; planHeld?: boolean }): ResolvedLink {
  return { title: t.title, status: t.status, ...(t.planHeld === true ? { planHeld: true } : {}) };
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
      return taskLink(task);
    }
    // The goal panel's own address shape. Same lookup as a task on purpose:
    // goals and tasks share the id namespace and the status machine, and the
    // route's `task` source already reaches both.
    case 'goal': {
      const goal = sources.task(link.goalId);
      if (!goal || goal.workspaceId !== link.workspaceId) return { title: null };
      return taskLink(goal);
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
        return taskLink(task);
      }
      const meta = sources.docMeta(link.docId);
      if (!meta) return { title: null };
      // The legacy `/review/<id>` shape names no workspace — nothing to hold
      // it against. The board-scoped shape must be telling the truth.
      if (link.workspaceId !== null && !sources.docInWorkspace(link.docId, link.workspaceId))
        return { title: null };
      // A diff-review member has no stored title; its repo-relative path is
      // what every sidebar calls it, so it is the honest display name. A doc
      // bound by an absolute `sourceUrl` outside any notes home (no
      // `relPath`) falls back one step further, to its file's own basename —
      // same convention the doc-tree listing uses (`basenameOf` in
      // server.ts) — so a Related Links entry is NEVER the raw doc id.
      return { title: meta.title ?? meta.relPath ?? basenameOfSourceUrl(meta.sourceUrl) };
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
 * `statuses` holds an entry ONLY for task/goal-backed URLs, and `planHeld`
 * only for the subset of those that are drafts held behind an unapproved
 * plan (so the chip reads "Draft" rather than the hold's technical status).
 */
export function linkTitlesFor(
  urls: string[],
  sources: LinkTitleSources,
): {
  titles: Record<string, string | null>;
  statuses: Record<string, TaskStatus>;
  planHeld: Record<string, boolean>;
} {
  const titles: Record<string, string | null> = {};
  const statuses: Record<string, TaskStatus> = {};
  const planHeld: Record<string, boolean> = {};
  for (const url of urls.slice(0, LINK_TITLE_BATCH_LIMIT)) {
    if (typeof url !== 'string') continue;
    const info = linkInfoFor(url, sources);
    titles[url] = info.title;
    if (info.status !== undefined) statuses[url] = info.status;
    if (info.planHeld === true) planHeld[url] = true;
  }
  return { titles, statuses, planHeld };
}
