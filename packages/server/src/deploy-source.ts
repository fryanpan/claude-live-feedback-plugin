/**
 * What the deploy source was parked on when a client release was built — the
 * `sourceRef` stamped into `releases/<id>/release.json`.
 *
 * ## Why the marker is not simply `git describe --always --dirty`
 *
 * It was, and the suffix stopped meaning anything. Prod's deploy source is the
 * primary checkout, and that checkout also hosts **bound review documents**:
 * markdown files under `docs/` that are attached to a live doc, so every agent
 * edit flushes back to the file ~1s later. Once such a file is also *tracked*
 * (which is a thing this repo deliberately does more of), the checkout has a
 * modified tracked file for as long as the review is open, and every release
 * published in that window is stamped `-dirty` for a reason that has nothing to
 * do with the build. Observed, both directions, on 2026-08-17: `0ef5d92-dirty`
 * while a bound plan was mid-edit, `a822618` three minutes later once the same
 * checkout went clean, same server and same build path.
 *
 * `-dirty` exists to answer one question — *was what this box is serving built
 * from committed code?* A marker that also fires on ordinary document editing
 * is a marker people learn to skip, which is the failure the client-drift alarm
 * already has an arming rule to avoid.
 *
 * ## The rule
 *
 * A modified tracked path sets `-dirty` **unless it is documentation that this
 * deploy neither builds nor serves.** That is an explicit, short IGNORE list —
 * `docs/**` and top-level `*.md` — and everything not on it counts.
 *
 * The direction matters more than the contents. Enumerating "paths that can
 * affect the build" and missing one reports a release built from uncommitted
 * code as clean, which is the failure the marker exists to prevent. Enumerating
 * "paths that provably cannot" and missing one reports `-dirty` on a release
 * that was fine — noise. So the list is an ignore list, defaults are to mark,
 * and adding an entry is a deliberate act with this paragraph attached.
 *
 * Two facts fix the current entries, and both should be re-checked before the
 * list grows:
 *
 * - Nothing builds or serves `docs/`. It is not read by either bundle build
 *   (`packages/{widget,markdown-app}/scripts/build.ts`) and no route reads it.
 * - `demos/` **is** served, live, out of the deploy source — `bin.ts` resolves
 *   `join(repoRoot, 'demos')` and `server.ts` serves `/demos/*` per request. So
 *   an uncommitted demo genuinely changes what a browser gets, and `demos/`
 *   stays on the marking side even though it holds bound review documents too.
 *   "It is a bound doc" is therefore NOT the criterion; "this deploy does not
 *   build or serve it" is.
 *
 * ## And it says WHICH paths
 *
 * A bare suffix cannot be judged by the person reading it later. The provenance
 * also carries `dirtyPaths` — every modified tracked path, not only the ones
 * that set the suffix — so `sourceRef: "a822618"` next to
 * `dirtyPaths: ["docs/product/plans/x.md"]` reads as "the tree was not pristine
 * and here is why that did not count", and a `-dirty` release names the file
 * that earned it.
 */
import { spawnSync } from 'node:child_process';

/** How many paths a release records before it truncates. `dirtyPathCount`
 *  always carries the full total, so a truncated list never reads as complete. */
export const MAX_DIRTY_PATHS = 20;

/**
 * Does a modification to this repo-relative path change anything this deploy
 * builds or serves?
 *
 * Closed by default: only the documentation paths named above answer false.
 * Read the module header before adding to that list — the whole safety of the
 * marker is that a miss here can only produce noise.
 */
export function affectsDeployedArtifacts(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  if (p.length === 0) return false;
  // Documentation. Not bundled, not served, not read at runtime.
  if (p.startsWith('docs/')) return false;
  // Top-level prose (README.md, CLAUDE.md, …). A markdown file DEEPER in the
  // tree is deliberately not covered: `packages/plugin/skills/**/SKILL.md`
  // ships to peers, and this list only holds things nothing consumes.
  if (!p.includes('/') && /\.md$/i.test(p)) return false;
  return true;
}

/** What a release records about the source it was built from. */
export interface DeploySource {
  /** `git describe --always`, plus `-dirty` when a build-affecting path is
   *  modified. */
  sourceRef: string;
  /** Every modified tracked path, capped at `MAX_DIRTY_PATHS`. Absent when the
   *  tree was clean, and also when git could not be asked. */
  dirtyPaths?: string[];
  /** How many modified paths there were in total, listed or not. */
  dirtyPathCount?: number;
}

/**
 * Turn a description of the deploy source into the marker a release carries.
 *
 * `modifiedPaths: null` means "could not be determined" — git refused, timed
 * out, or this is not a repo. That resolves to `-dirty` with no path list: an
 * unknown tree is treated as a modified one, because the alternative is
 * claiming committed provenance we did not check.
 */
export function describeDeploySource(input: {
  /** Output of `git describe --always`, already trimmed and non-empty. */
  describe: string;
  /** Tracked paths with uncommitted modifications, repo-relative. */
  modifiedPaths: readonly string[] | null;
  maxDirtyPaths?: number;
}): DeploySource {
  const { describe, modifiedPaths, maxDirtyPaths = MAX_DIRTY_PATHS } = input;
  if (modifiedPaths === null) return { sourceRef: `${describe}-dirty` };

  const paths = [...new Set(modifiedPaths.filter((p) => p.length > 0))].sort();
  if (paths.length === 0) return { sourceRef: describe };

  const dirty = paths.some(affectsDeployedArtifacts);
  return {
    sourceRef: dirty ? `${describe}-dirty` : describe,
    dirtyPaths: paths.slice(0, Math.max(1, maxDirtyPaths)),
    dirtyPathCount: paths.length,
  };
}

/**
 * Parse `git status --porcelain -z --untracked-files=no` into repo-relative
 * paths.
 *
 * `-z` rather than the default: porcelain v1 C-quotes any path with a space or
 * a non-ASCII byte, and a parser that forgets to unquote reports a path that
 * matches no prefix — which, in an ignore list, silently flips to "counts", so
 * the mistake is invisible. NUL-separation has no quoting at all.
 *
 * A rename or copy emits the destination in the status entry and the ORIGIN as
 * the next NUL-separated field. Both are recorded: a doc renamed into `docs/`
 * from `packages/` moved a file the build reads.
 */
export function parseStatusPorcelainZ(out: string): string[] {
  const fields = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    // `XY <path>` — three characters of header, so anything shorter is the
    // trailing empty field, not an entry.
    if (!entry || entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    paths.push(entry.slice(3));
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const from = fields[++i];
      if (from) paths.push(from);
    }
  }
  return paths;
}

/** One git invocation. Injectable so the decision can be tested without a
 *  repo, and so a test can make git fail on demand. */
export type GitRunner = (args: string[]) => { ok: boolean; stdout: string };

function spawnGit(cwd: string): GitRunner {
  return (args) => {
    try {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
      return { ok: r.status === 0, stdout: r.stdout ?? '' };
    } catch {
      return { ok: false, stdout: '' };
    }
  };
}

/**
 * Ask a checkout what it is parked on. Returns null when even `git describe`
 * fails — no git, no repo, a slow filesystem — because a publish carries on
 * with a timestamp alone rather than failing a deploy over a label.
 */
export function readDeploySource(
  repoRoot: string,
  run: GitRunner = spawnGit(repoRoot),
): DeploySource | null {
  const described = run(['describe', '--always']);
  const describe = described.ok ? described.stdout.trim() : '';
  if (describe.length === 0) return null;

  // Untracked files are deliberately out: `git describe --dirty` never counted
  // them either, and an untracked scratch file is not provenance.
  const status = run(['status', '--porcelain', '-z', '--untracked-files=no']);
  return describeDeploySource({
    describe,
    modifiedPaths: status.ok ? parseStatusPorcelainZ(status.stdout) : null,
  });
}
