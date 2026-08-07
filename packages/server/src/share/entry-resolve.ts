/**
 * Which doc a workspace share should OPEN, resolved at redemption time.
 *
 * A workspace share used to bake its entry docId into the redirect at
 * creation time. Member docIds are derived from the file's relPath
 * (`<workspaceId>:<relPath>`), so renaming or deleting the entry file left
 * the share pointing at a docId that no longer exists — the link 404'd, and
 * the only fix was minting a new one. Resolving on every redemption means
 * the URL outlives any amount of churn inside the workspace.
 *
 * Order of preference:
 *   1. the doc the sharer picked, if it is still a member
 *   2. a root README (the conventional landing page)
 *   3. any README, deepest-path last
 *   4. the first markdown file
 *   5. the first member of any kind
 *
 * Stale members (file gone — see Rooms.refreshWorkspace) still hold their
 * threads and stay reachable, but they lose every tiebreak: landing a
 * visitor on a tombstone is a worse first impression than any live file.
 * That outranks the sharer's own choice — a preferred doc whose file has
 * been deleted or renamed away is exactly the case this function exists to
 * rescue. It only wins back when every member is stale and there is no
 * better answer to give.
 */

export interface EntryCandidate {
  docId: string;
  relPath?: string;
  stale?: boolean;
}

export function resolveShareEntry(
  preferredDocId: string | undefined,
  members: EntryCandidate[],
): string | null {
  if (members.length === 0) return null;
  const preferred = members.find((m) => m.docId === preferredDocId);
  if (preferred && (!preferred.stale || members.every((m) => m.stale))) return preferred.docId;

  // Sort once into "best landing page first" order, then take the head.
  // Ranking beats a chain of finds: every tier shares the same live-first
  // and shallowest-path tiebreaks.
  const ranked = members.slice().sort((a, b) => {
    const staleDelta = Number(a.stale ?? false) - Number(b.stale ?? false);
    if (staleDelta !== 0) return staleDelta;
    const kindDelta = kindRank(a) - kindRank(b);
    if (kindDelta !== 0) return kindDelta;
    const depthDelta = depth(a) - depth(b);
    if (depthDelta !== 0) return depthDelta;
    return key(a).localeCompare(key(b));
  });
  return ranked[0]?.docId ?? null;
}

function key(m: EntryCandidate): string {
  return m.relPath ?? m.docId;
}

function depth(m: EntryCandidate): number {
  return key(m).split('/').length;
}

function kindRank(m: EntryCandidate): number {
  const path = m.relPath?.toLowerCase();
  if (!path) return 2;
  const base = path.split('/').pop() ?? path;
  if (base === 'readme.md') return 0;
  if (base.endsWith('.md')) return 1;
  return 2;
}
