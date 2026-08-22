/**
 * What the landing page is FOR: a list of active workspaces to open up.
 *
 * That sentence is Bryan's, verbatim (task `t-UZMXu32nt4wN`, 2026-08-18):
 * "please don't build the overengineered version. Let's just have a simple
 * workspace list and not overlap with the purpose of each workspace home
 * page which is also being built." The previous `/` — a cross-workspace
 * "Needs you" band over every thread on the server plus a grouped index of
 * every review artifact — was that overlap. Anything about ONE workspace's
 * state (its queue, its decisions, its catch-up) belongs to the workspace's
 * own page at `/workspaces/<id>`; `/` only has to get you there.
 *
 * Two rules survive from the previous model, because they were measured the
 * hard way (see the git history of this file and docs/process/learnings.md):
 *
 *  1. **Recency is real events, never `meta.lastActivityAt`.** That field is
 *     derived from the `.ydoc` file's mtime (`rooms.ts` `withActivity`), so a
 *     server-side snapshot rewrite refreshes it: on the live server all 3,741
 *     docs reported activity inside 7 days, in identical-millisecond
 *     clusters. `lastActivity` here is computed by the collector from task
 *     mutations (`task.updatedAt`), task-thread comments
 *     (`thread.lastActivity`), goal edits and board creation — timestamps
 *     that only move when someone does something. This module's input type
 *     deliberately has no field to put an mtime in.
 *  2. **A cut list states what it cut.** Inactive workspaces are not hidden —
 *     they are behind a labelled, counted fold, because a filtered list that
 *     does not say what it filtered reads as the whole truth ("An empty list
 *     is a clearance only if you also render the denominator").
 *
 * The review-doc index (the "hundreds of bound review items" the old page
 * drowned in) stays reachable through one small fold of per-project links to
 * `/projects/<owner>` — a link, not a browser.
 */

/** A workspace is ACTIVE when its newest real event is at most this old.
 *  14 days ≈ "current work": long enough that a board Bryan touched this
 *  sprint stays on the page, short enough that the graveyard folds away. */
export const ACTIVE_WINDOW_MS = 14 * 86_400_000;

/** One hub workspace, as the collector hands it over. */
export interface LandingWorkspaceInput {
  id: string;
  name: string;
  /**
   * Newest real event anywhere on the board — task mutation, task-thread
   * comment, goal edit, or the board's creation. Never a `.ydoc` mtime (rule
   * 1 in the header).
   */
  lastActivity: number;
  /**
   * The board has been RETIRED — stood down deliberately, rather than merely
   * gone quiet. It leaves the recency split entirely and folds into its own
   * counted section, because "nobody has touched this in three weeks" and
   * "somebody decided this board is over" are different facts and a reader
   * acts differently on each.
   */
  retired?: boolean;
}

/** One row of the page: a place to go, not its contents. */
export interface LandingWorkspaceRow extends LandingWorkspaceInput {
  href: string;
}

/** One per-project link in the review-docs fold. */
export interface LandingProjectLink {
  owner: string;
  label: string;
  href: string;
}

export interface LandingModel {
  /** Workspaces with an event inside the window, newest first. */
  active: LandingWorkspaceRow[];
  /** Everything else, same order — rendered folded, with its count. */
  inactive: LandingWorkspaceRow[];
  /**
   * Boards somebody stood down, same order, in their own labelled fold.
   *
   * They are FOLDED and not hidden, for rule 2 in the header: a cut list
   * states what it cut. A retired board is still readable — that is the whole
   * point of retiring instead of deleting — so the page has to keep a way in.
   */
  retired: LandingWorkspaceRow[];
  /** The review-doc index, one link per project owner, label order. */
  projects: LandingProjectLink[];
  /** The window the split used, so the renderer states the criterion. */
  windowMs: number;
}

/**
 * A row opens the workspace's **Home** pane, not its board.
 *
 * The list's whole job is "get me into the right workspace", and the first
 * question on arrival is *what needs me here* — which is the question Home
 * answers and the board does not. The board is a task list: correct once you
 * already know what you came for, and a wall of rows when you don't. Home has
 * a nav link back to it, so nothing is further away than one tap.
 *
 * `/workspaces/<id>` is deliberately left alone as the board (see
 * `paneFromPath` in the hub client): every link already in the field points
 * there, so this changes where the LIST sends you, not what any existing URL
 * means.
 */
function toRow(w: LandingWorkspaceInput): LandingWorkspaceRow {
  return { ...w, href: `/workspaces/${encodeURIComponent(w.id)}/home` };
}

/** Newest first; name then id break ties so the page is deterministic across
 *  requests rather than reordering under the reader. */
function byRecency(a: LandingWorkspaceRow, b: LandingWorkspaceRow): number {
  return (
    b.lastActivity - a.lastActivity || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

export function buildLandingModel(
  workspaces: Iterable<LandingWorkspaceInput>,
  projects: Iterable<{ owner: string; label: string }>,
  now: number,
): LandingModel {
  const active: LandingWorkspaceRow[] = [];
  const inactive: LandingWorkspaceRow[] = [];
  const retired: LandingWorkspaceRow[] = [];
  for (const w of workspaces) {
    // Retirement wins over recency: a board somebody retired an hour ago is
    // the most recently-touched board on the server, and putting it at the
    // top of "active" is the exact confusion the retire verb exists to end.
    if (w.retired) {
      retired.push(toRow(w));
      continue;
    }
    // `>=` on the boundary: activity exactly window-old still counts. The
    // failure mode of counting too much is one extra row; of counting too
    // little, a board Bryan is working vanishing from the page.
    (w.lastActivity >= now - ACTIVE_WINDOW_MS ? active : inactive).push(toRow(w));
  }
  active.sort(byRecency);
  inactive.sort(byRecency);
  retired.sort(byRecency);

  const projectLinks: LandingProjectLink[] = Array.from(projects, (p) => ({
    owner: p.owner,
    label: p.label,
    href: `/projects/${encodeURIComponent(p.owner)}`,
  }));
  projectLinks.sort((a, b) => a.label.localeCompare(b.label) || a.owner.localeCompare(b.owner));

  return { active, inactive, retired, projects: projectLinks, windowMs: ACTIVE_WINDOW_MS };
}
