/**
 * Logical grouping of a diff review's changed files — the sidebar's default
 * "Show Grouped Diffs" view. The creating agent can pass semantic groups
 * (`create_diff_review(groups: [{title, paths}])` — same skill as organizing
 * commits); when it doesn't, this heuristic buckets files so the list still
 * reads by intent rather than by directory nesting:
 *
 *   1. cross-cutting buckets first — Tests, Docs, Build & config
 *   2. remaining source grouped by its top path segment (the module)
 *   3. groups ordered by total churn (biggest change first), buckets last
 */

export interface GroupableFile {
  relPath: string;
  additions?: number;
  deletions?: number;
}

export interface FileGroupAssignment {
  group: string;
  rank: number;
  /** Per-group prose (agent-supplied), trimmed; undefined when the group
   *  carried none. Same value for every file in the group. Guaranteed
   *  <= MAX_GROUP_DETAILS by validation at bind time (over-long is rejected,
   *  never truncated). */
  details?: string;
}

/**
 * Max length of a group's `details` string. This is a DELIBERATE hard limit,
 * not a display convenience: an over-long `details` is REJECTED at bind time
 * (see {@link findOverlongGroupDetails}), forcing the caller to write a short,
 * curated one-or-two-sentence intro instead of dumping a commit body / diff
 * summary into the sidebar. We do not silently truncate — a mid-sentence cut
 * reads worse than a summary the author actually wrote.
 */
export const MAX_GROUP_DETAILS = 500;

/** Trim; empty/whitespace-only → undefined. Does NOT truncate — length is
 *  enforced by rejection at bind time, not by clamping here. */
function normalizeDetails(details: string | undefined): string | undefined {
  const trimmed = details?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Groups whose (trimmed) `details` exceed MAX_GROUP_DETAILS, so the bind can
 * reject with a caller-actionable message instead of truncating. Empty result
 * = all details are within the limit. Pure/testable.
 */
export function findOverlongGroupDetails(
  explicit?: Array<{ title: string; details?: string }>,
): Array<{ title: string; length: number }> {
  const over: Array<{ title: string; length: number }> = [];
  for (const g of explicit ?? []) {
    const len = g.details?.trim().length ?? 0;
    if (len > MAX_GROUP_DETAILS) over.push({ title: g.title, length: len });
  }
  return over;
}

/**
 * Structural validation of a caller-supplied group spec, returning a list of
 * human-readable problems (empty = fine).
 *
 * This runs BEFORE anything is persisted, and that ordering is the point: a
 * spec is stored on the workspace's members so a later refresh can re-apply
 * it, so a malformed one that got written before {@link assignGroups} threw
 * on it would poison the workspace — every subsequent refresh would read the
 * bad spec back and throw again, with no way to recover but deleting the
 * review. The route layer can't do this job: `groups` arrives as JSON and
 * `Array.isArray` says nothing about what is inside it.
 */
export function findMalformedGroups(groups: unknown): string[] {
  if (!Array.isArray(groups)) return ['groups must be an array'];
  const problems: string[] = [];
  groups.forEach((g, i) => {
    const where = `groups[${i}]`;
    if (typeof g !== 'object' || g === null || Array.isArray(g)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const { title, paths, details } = g as Record<string, unknown>;
    if (typeof title !== 'string' || title.trim() === '') {
      problems.push(`${where}.title must be a non-empty string`);
    }
    if (!Array.isArray(paths) || paths.length === 0) {
      problems.push(`${where}.paths must be a non-empty array of strings`);
    } else if (paths.some((p) => typeof p !== 'string' || p.trim() === '')) {
      problems.push(`${where}.paths must contain only non-empty strings`);
    }
    if (details !== undefined && typeof details !== 'string') {
      problems.push(`${where}.details must be a string when present`);
    }
  });
  return problems;
}

const TEST_RE = /(^|\/)(tests?|spec|__tests__|androidTest|testFixtures)(\/|$)|\.(test|spec)\.\w+$/i;
const DOC_RE = /(^|\/)docs?(\/|$)|\.(md|mdx|adoc|rst)$/i;
const CONFIG_RE =
  /(^|\/)(\.github|\.claude|gradle|\.idea)(\/|$)|(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|package\.json|tsconfig[^/]*\.json|.*\.(toml|ya?ml|properties|pro|cfg|ini)|\.\w[^/]*)$/i;

function churn(f: GroupableFile): number {
  return (f.additions ?? 0) + (f.deletions ?? 0);
}

function heuristicBucket(relPath: string): 'Tests' | 'Docs' | 'Build & config' | null {
  if (TEST_RE.test(relPath)) return 'Tests';
  if (DOC_RE.test(relPath)) return 'Docs';
  if (CONFIG_RE.test(relPath)) return 'Build & config';
  return null;
}

/**
 * Assign every file to a group. When `explicit` groups are provided they win
 * (first title claiming a path gets it; unmatched files fall into "Other",
 * ranked last). Otherwise the heuristic applies. Ranks are contiguous from 0
 * in display order.
 */
export function assignGroups(
  files: GroupableFile[],
  explicit?: Array<{ title: string; paths: string[]; details?: string }>,
): Map<string, FileGroupAssignment> {
  const out = new Map<string, FileGroupAssignment>();

  if (explicit && explicit.length > 0) {
    // A group path matches a file exactly OR as a directory prefix —
    // "maps/src/test" claims every file under it, so agents don't have to
    // enumerate 26 test files. First group (in order) to match wins.
    const norm = explicit.map((g) => ({
      title: g.title,
      paths: g.paths.map((p) => p.replace(/^\/+/, '').replace(/\/+$/, '')),
      details: normalizeDetails(g.details),
    }));
    for (const f of files) {
      let assigned = false;
      for (let rank = 0; rank < norm.length; rank++) {
        const g = norm[rank];
        if (!g) continue;
        if (g.paths.some((p) => f.relPath === p || f.relPath.startsWith(`${p}/`))) {
          out.set(f.relPath, { group: g.title, rank, details: g.details });
          assigned = true;
          break;
        }
      }
      if (!assigned) out.set(f.relPath, { group: 'Other', rank: norm.length });
    }
    return out;
  }

  // Heuristic: bucket or module (top path segment).
  const groups = new Map<string, { files: GroupableFile[]; bucket: boolean }>();
  for (const f of files) {
    const bucket = heuristicBucket(f.relPath);
    const name =
      bucket ?? (f.relPath.includes('/') ? (f.relPath.split('/')[0] as string) : '(root)');
    let g = groups.get(name);
    if (!g) {
      g = { files: [], bucket: bucket !== null };
      groups.set(name, g);
    }
    g.files.push(f);
  }

  // Order: source modules by churn desc, then buckets (Tests/Docs/config) by
  // churn desc — reviewers read the meat first, housekeeping last.
  const ordered = Array.from(groups.entries()).sort((a, b) => {
    if (a[1].bucket !== b[1].bucket) return a[1].bucket ? 1 : -1;
    const ca = a[1].files.reduce((s, f) => s + churn(f), 0);
    const cb = b[1].files.reduce((s, f) => s + churn(f), 0);
    return cb - ca;
  });
  ordered.forEach(([name, g], rank) => {
    for (const f of g.files) out.set(f.relPath, { group: name, rank });
  });
  return out;
}
