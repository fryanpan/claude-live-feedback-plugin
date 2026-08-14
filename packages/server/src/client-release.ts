/**
 * Where the browser client prod serves actually lives.
 *
 * It used to be `packages/markdown-app/dist` inside the primary checkout,
 * read per request. Two things followed from that, both bad:
 *
 *   1. Building the bundles anywhere in that checkout WAS a deploy to every
 *      browser on the fleet — so nobody could build there to test, and the
 *      "don't build in the primary checkout" rule had to live in people's
 *      heads (and in scripts/staging.ts).
 *   2. The served client silently tracked whatever commit that working tree
 *      happened to be sitting on. A checkout parked on a pre-merge commit
 *      served a pre-merge client, with nothing anywhere saying so.
 *
 * So prod copies the built bundles OUT of the checkout into an immutable,
 * numbered release directory under a state root that is not a git working
 * tree, and serves that. The switchover has to be tear-free — there must be
 * no instant where the served directory is half-populated — which is why the
 * publish is two renames and never a copy over live files:
 *
 *   releases/.staging-<id>/   ← the copy lands here, under a dot-name that
 *                               `releases` scanning ignores
 *   rename → releases/<id>/   ← atomic; the release appears complete or not
 *                               at all, and is never written to again
 *   symlink .current-<id> → releases/<id>
 *   rename → current         ← atomic replace of the pointer
 *
 * `current` exists for operators (what is live? roll back to what?). The
 * server is handed the RESOLVED release path, so no in-flight request can
 * resolve half of a path before a swap and half after.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Built bundle directories, as they come out of the package build scripts. */
export interface ClientSources {
  widget: string;
  markdownApp: string;
}

export interface ClientRelease {
  /** Absolute path of the immutable release directory. */
  releaseDir: string;
  /** `<releaseDir>/widget` */
  widgetDir: string;
  /** `<releaseDir>/markdown-app` */
  markdownAppDir: string;
  /** The release's directory name (a sortable timestamp + suffix). */
  id: string;
}

/**
 * Files that must exist for a bundle dir to count as built. A publish that
 * skips this check is how a failed build becomes a blank page for everyone —
 * `Bun.build` writing nothing is indistinguishable from success at the
 * filesystem level.
 */
const REQUIRED: Record<keyof ClientSources, string[]> = {
  widget: ['widget.iife.js', 'widget.esm.js'],
  markdownApp: ['app.js', 'index.html'],
};

/** Where releases live. Not inside any checkout, so a `git checkout` in the
 *  repo can never change what prod is serving. */
export function clientReleaseRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const explicit = env.LF_CLIENT_ROOT?.trim();
  if (explicit) return explicit;
  const state = env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state');
  return join(state, 'live-feedback', 'client');
}

/** Breaks ties between publishes that land in the same millisecond. Ids must
 *  sort lexicographically in publish order — pruning keeps "the newest N", and
 *  a random suffix makes that ordering a coin flip. */
let seq = 0;

function releaseId(now: Date): string {
  // Fixed width, so lexicographic order IS chronological order:
  // 20260813T014455123Z-000003
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  seq = (seq + 1) % 1_000_000;
  return `${stamp}-${String(seq).padStart(6, '0')}`;
}

/**
 * Copy `sources` into a fresh release and make it current. Throws — without
 * touching `current` — if either source is missing a file it must have, so a
 * broken build leaves the previous release serving (stale beats down).
 */
export function publishClientRelease(opts: {
  root: string;
  sources: ClientSources;
  /** How many releases to retain, newest first. The live one is always kept. */
  keep?: number;
  now?: Date;
}): ClientRelease {
  const { root, sources, keep = 3, now = new Date() } = opts;

  for (const key of ['widget', 'markdownApp'] as const) {
    const dir = sources[key];
    for (const file of REQUIRED[key]) {
      if (!existsSync(join(dir, file))) {
        throw new Error(`client release: ${key} bundle is incomplete — ${join(dir, file)} missing`);
      }
    }
  }

  const releases = join(root, 'releases');
  mkdirSync(releases, { recursive: true });

  const id = releaseId(now);
  // Dot-prefixed so a partially-copied tree can never be read as a release,
  // and so pruning ignores it if we die mid-copy.
  const staging = join(releases, `.staging-${id}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  let releaseDir: string;
  try {
    cpSync(sources.widget, join(staging, 'widget'), { recursive: true, dereference: true });
    cpSync(sources.markdownApp, join(staging, 'markdown-app'), {
      recursive: true,
      dereference: true,
    });
    releaseDir = join(releases, id);
    // Atomic: the release directory springs into existence complete.
    renameSync(staging, releaseDir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }

  // Atomic pointer swap. `symlink` cannot replace an existing name, so build
  // the new link beside it and rename over — rename(2) replaces atomically,
  // so a reader sees the old target or the new one, never neither.
  const linkTmp = join(root, `.current-${id}`);
  rmSync(linkTmp, { force: true });
  symlinkSync(releaseDir, linkTmp);
  renameSync(linkTmp, join(root, 'current'));

  pruneReleases(root, keep);

  return {
    releaseDir,
    widgetDir: join(releaseDir, 'widget'),
    markdownAppDir: join(releaseDir, 'markdown-app'),
    id,
  };
}

/** Keep the newest `keep` releases plus whatever `current` points at. */
function pruneReleases(root: string, keep: number): void {
  const releases = join(root, 'releases');
  let live: string | null = null;
  try {
    live = realpathSync(join(root, 'current'));
  } catch {}
  const ids = readdirSync(releases)
    .filter((n) => !n.startsWith('.'))
    .sort()
    .reverse();
  for (const id of ids.slice(Math.max(keep, 1))) {
    const dir = join(releases, id);
    let real: string | null = null;
    try {
      real = realpathSync(dir);
    } catch {}
    if (real && live && real === live) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The release `current` points at, resolved through the symlink, or null. */
export function currentClientRelease(root: string): ClientRelease | null {
  const link = join(root, 'current');
  let releaseDir: string;
  try {
    releaseDir = realpathSync(link);
  } catch {
    return null;
  }
  if (!existsSync(join(releaseDir, 'markdown-app')) && !existsSync(join(releaseDir, 'widget'))) {
    return null;
  }
  return {
    releaseDir,
    widgetDir: join(releaseDir, 'widget'),
    markdownAppDir: join(releaseDir, 'markdown-app'),
    id: releaseDir.split('/').pop() ?? '',
  };
}

export interface PreparedClient {
  /** The release to serve, or null when nothing has ever been published. */
  releaseDir: string | null;
  widget: string | null;
  markdownApp: string | null;
  /** True when this start could NOT publish and is reusing the last release. */
  stale: boolean;
  /** Why the publish was skipped, when it was. */
  error?: string;
}

/**
 * The whole prod decision, in one place: publish the freshly-built bundles if
 * they are complete, otherwise keep serving the release that is already live.
 * Stale beats down — a failed build must not take the review server's client
 * offline — but it is never silent: `stale` and `error` are for the caller to
 * shout about.
 */
export function prepareClientRelease(opts: {
  root: string;
  sources: ClientSources;
  keep?: number;
}): PreparedClient {
  try {
    const rel = publishClientRelease(opts);
    return {
      releaseDir: rel.releaseDir,
      widget: rel.widgetDir,
      markdownApp: rel.markdownAppDir,
      stale: false,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const cur = currentClientRelease(opts.root);
    if (!cur) return { releaseDir: null, widget: null, markdownApp: null, stale: true, error };
    return {
      releaseDir: cur.releaseDir,
      widget: cur.widgetDir,
      markdownApp: cur.markdownAppDir,
      stale: true,
      error,
    };
  }
}

/**
 * What the server should actually serve. An explicit dist (a published
 * release, passed by the supervisor) wins; otherwise the repo's own build
 * output, which is what `bun run dev` and a bare `bin.ts` want. Either way a
 * path that isn't there resolves to null rather than a 404 factory.
 */
export function resolveClientDists(opts: {
  widgetDist?: string | null;
  markdownAppDist?: string | null;
  repoRoot: string;
}): { widget: string | null; markdownApp: string | null } {
  const pick = (explicit: string | null | undefined, fallback: string): string | null => {
    const p = explicit?.trim() || fallback;
    try {
      return statSync(p).isDirectory() ? p : null;
    } catch {
      return null;
    }
  };
  return {
    widget: pick(opts.widgetDist, join(opts.repoRoot, 'packages', 'widget', 'dist')),
    markdownApp: pick(
      opts.markdownAppDist,
      join(opts.repoRoot, 'packages', 'markdown-app', 'dist'),
    ),
  };
}
