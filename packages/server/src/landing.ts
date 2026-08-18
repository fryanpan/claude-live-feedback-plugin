/**
 * What the landing page is FOR, and why it is three bounded regions.
 *
 * `/` used to be every artifact on the server in one flat list — 322 rows
 * across 20 projects, 910 KB of HTML, rebuilt per request by walking the
 * threads of ~3,500 rooms and the file tree of every workspace. The owner's
 * report was not "this is slow", it was "it is a giant list that is of no
 * use": arriving at it told you a number and left you to find the thing
 * yourself.
 *
 * Ordering alone does not fix that, and the measurement is the reason this
 * module caps rather than sorts. Across all 3,500 docs: 436 open threads, and
 * **358 of them — 82% — have an agent as their newest speaker**, which is the
 * predicate for "waiting on a person". A page that ranks 358 items perfectly
 * is still a page you scroll. So the band is CAPPED, and because a capped
 * list that does not say what it is a slice of reads as a clearance (see "An
 * empty list is a clearance only if you also render the denominator" in
 * docs/process/learnings.md), the denominator ships beside it always —
 * including when it is zero.
 *
 * Three rules this file exists to hold, each of which has been got wrong
 * somewhere in this codebase before:
 *
 *  1. **One notion of "needs a person."** `awaitingPerson` / `unansweredRun`
 *     in `review-queue.ts` already answer it, per thread, with no workspace
 *     scoping — so they work unchanged on any thread from any doc. A second
 *     notion here would drift from the board's, and the two surfaces would
 *     disagree about the same thread.
 *  2. **The wait is the START of the unanswered run**, never the newest
 *     comment. An agent posting follow-ups on its own thread otherwise resets
 *     its own clock and sinks its own question in a band sorted oldest-first.
 *  3. **Recency is thread activity, never `meta.lastActivityAt`.** That field
 *     is derived from the `.ydoc` file's mtime (`rooms.ts` `withActivity`), so
 *     a server-side snapshot rewrite refreshes it: on the live server all
 *     3,741 docs report activity inside 7 days, in identical-millisecond
 *     clusters. It is a persistence clock wearing an activity label, and
 *     ranking by it is ranking by noise. This module's input type deliberately
 *     has no field to put it in.
 */
import type { Thread } from '@feedback/core';
import { awaitingPerson, unansweredRun } from './review-queue.ts';

/** How many "needs you" rows the page renders. The rest live behind the
 *  denominator — see the header note on why capping is the point. */
export const NEEDS_YOU_CAP = 20;

/** Excerpt budget for the ask. Long enough to recognise which conversation
 *  this is; the thread itself is one tap away. */
const ASK_MAX = 140;

/** Where a thread opens. A doc thread arrives AT the comment; a task
 *  discussion arrives at its task on the board, which is the container that
 *  holds it. Both shapes are the ones the hub's own review strip already
 *  navigates to — this is not a new URL vocabulary. */
export type LandingLink =
  | { kind: 'doc'; docId: string }
  | { kind: 'task'; workspaceId: string; taskId: string };

/**
 * One room, as the landing model needs to see it.
 *
 * Deliberately narrow. Everything here is either something a person reads or
 * something the ranking uses, and there is no field for the `.ydoc` mtime —
 * see rule 3 in the header.
 */
export interface LandingInputDoc {
  /** Stable key of the group this belongs to: a project cwd, or a hub
   *  workspace id. */
  groupKey: string;
  /** What the group is called on the page. */
  groupLabel: string;
  groupKind: 'project' | 'workspace';
  /** Where the group's own page lives — the "artifacts on demand" hop. */
  groupHref: string;
  /** What a thread here is ON: a file name, or a task title. */
  name: string;
  link: LandingLink;
  threads: Thread[];
  /**
   * Identity of the ARTIFACT this room belongs to, for counting. Every member
   * of a bound folder or diff review shares one, so a 60-file review counts as
   * the single thing a person put up for review. **Absent means this room is
   * not an artifact at all** — a task body room is a surface the server owns,
   * and counting it would inflate every board's row with phantom artifacts.
   */
  artifactId?: string;
  /**
   * This doc is bound to a source file that is no longer on disk.
   *
   * Surfaced, never acted on. Agents retire their own reviews via
   * `delete_workspace`; the landing page's job is to make forgetting VISIBLE,
   * not to auto-hide or auto-delete anything a person might still want.
   */
  sourceMissing?: boolean;
}

/** One row of the "Needs you" band. */
export interface NeedsYouRow {
  threadId: string;
  /** The group's display label — which project or board this is in. */
  group: string;
  /** The file or task the conversation is on. */
  name: string;
  href: string;
  /** Start of the unanswered run. See rule 2 in the header. */
  since: number;
  /** `now - since`, computed once so the renderer never re-reads the clock. */
  waitedMs: number;
  /** The newest thing said, clipped. */
  ask: string;
  askedBy: string;
}

/** One row of the workspaces section: a place to go, not its contents. */
export interface LandingGroupRow {
  key: string;
  label: string;
  kind: 'project' | 'workspace';
  href: string;
  needsYou: number;
  openThreads: number;
  /** Distinct artifacts, folder members rolled up. Zero for a hub board. */
  artifacts: number;
  /** Newest thread activity anywhere in the group; 0 when nothing has any. */
  lastActivity: number;
  /** Artifacts bound to a source file that has since been deleted. */
  missingSources: number;
}

export interface LandingModel {
  /** At most `cap` rows, longest wait first. */
  needsYou: NeedsYouRow[];
  /** How many there are IN TOTAL — the denominator, always rendered. */
  needsYouTotal: number;
  cap: number;
  groups: LandingGroupRow[];
  totalArtifacts: number;
  totalOpen: number;
}

/** The URL a thread opens at, for each link shape. */
export function threadHref(link: LandingLink, threadId: string): string {
  if (link.kind === 'task') {
    return `/workspaces/${encodeURIComponent(link.workspaceId)}?task=${encodeURIComponent(link.taskId)}`;
  }
  return `/review/${encodeURIComponent(link.docId)}?thread=${encodeURIComponent(threadId)}`;
}

/**
 * Flatten and clip a comment for the band.
 *
 * Local rather than reused from `review-queue.ts`: that module's clipping is
 * tuned to the board strip's two budgets and its direct-ask extraction, which
 * needs a per-workspace roster of who counts as a person. The landing band is
 * cross-workspace and has no roster, so it shows the newest thing said and
 * says so. Presentation, not a second notion of what is waiting.
 */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').replace(/\*\*/g, '').replace(/`/g, '').trim();
  return flat.length > ASK_MAX ? `${flat.slice(0, ASK_MAX - 1)}…` : flat;
}

export function buildLandingModel(docs: Iterable<LandingInputDoc>, now: number): LandingModel {
  const rows: NeedsYouRow[] = [];
  const groups = new Map<string, LandingGroupRow & { artifactIds: Set<string> }>();
  /** Artifact ids whose source file is gone, per group — counted by ARTIFACT
   *  so a 60-file review with a deleted root is one missing thing, not sixty. */
  const missing = new Map<string, Set<string>>();

  for (const d of docs) {
    let group = groups.get(d.groupKey);
    if (!group) {
      group = {
        key: d.groupKey,
        label: d.groupLabel,
        kind: d.groupKind,
        href: d.groupHref,
        needsYou: 0,
        openThreads: 0,
        artifacts: 0,
        lastActivity: 0,
        missingSources: 0,
        artifactIds: new Set(),
      };
      groups.set(d.groupKey, group);
      missing.set(d.groupKey, new Set());
    }
    if (d.artifactId !== undefined) group.artifactIds.add(d.artifactId);
    if (d.sourceMissing && d.artifactId !== undefined) {
      missing.get(d.groupKey)?.add(d.artifactId);
    }

    for (const thread of d.threads) {
      if (thread.lastActivity > group.lastActivity) group.lastActivity = thread.lastActivity;
      if (thread.status !== 'open') continue;
      group.openThreads += 1;
      // The one notion of "waiting on a person" — see rule 1 in the header.
      const newest = awaitingPerson(thread);
      if (!newest) continue;
      // …and its run, whose FIRST comment is when the waiting started. Cheap:
      // `unansweredRun` returns immediately for anything not open, so this
      // second call only ever walks a thread that already qualified.
      const run = unansweredRun(thread);
      const since = run[0]?.ts ?? newest.ts;
      group.needsYou += 1;
      rows.push({
        threadId: thread.id,
        group: d.groupLabel,
        name: d.name,
        href: threadHref(d.link, thread.id),
        since,
        waitedMs: Math.max(0, now - since),
        ask: clip(newest.text),
        askedBy: newest.author.name,
      });
    }
  }

  // Oldest first: the thing at most risk of never being answered is the thing
  // the cap must not cut. `threadId` breaks ties so the page is deterministic
  // across requests rather than reordering under the reader.
  rows.sort((a, b) => a.since - b.since || a.threadId.localeCompare(b.threadId));

  const groupRows: LandingGroupRow[] = Array.from(groups.values()).map((g) => ({
    key: g.key,
    label: g.label,
    kind: g.kind,
    href: g.href,
    needsYou: g.needsYou,
    openThreads: g.openThreads,
    artifacts: g.artifactIds.size,
    lastActivity: g.lastActivity,
    missingSources: missing.get(g.key)?.size ?? 0,
  }));
  groupRows.sort(
    (a, b) =>
      b.needsYou - a.needsYou || b.lastActivity - a.lastActivity || a.label.localeCompare(b.label),
  );

  return {
    needsYou: rows.slice(0, NEEDS_YOU_CAP),
    needsYouTotal: rows.length,
    cap: NEEDS_YOU_CAP,
    groups: groupRows,
    totalArtifacts: groupRows.reduce((sum, g) => sum + g.artifacts, 0),
    totalOpen: groupRows.reduce((sum, g) => sum + g.openThreads, 0),
  };
}
