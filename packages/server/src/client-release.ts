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
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readRenamedEnv } from '@feedback/core/env-names';
import { STATE_ROOT_DIR } from '@feedback/core/machine-paths';

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
  // `sw.js` and the manifest are listed because their absence is silent:
  // notifications simply never arrive and the page looks entirely healthy.
  markdownApp: ['app.js', 'index.html', 'sw.js', 'manifest.webmanifest'],
};

/** Where releases live. Not inside any checkout, so a `git checkout` in the
 *  repo can never change what prod is serving. */
export function clientReleaseRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const explicit = readRenamedEnv(env, 'CW_CLIENT_ROOT')?.trim();
  if (explicit) return explicit;
  const state = env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state');
  return join(state, STATE_ROOT_DIR, 'client');
}

/**
 * What a release says about itself, written into the release directory at
 * publish time and never changed afterwards.
 *
 * The point is that "what the browser is running" must be answerable without
 * asking the process that published it — the publishing process is long gone
 * by the time anyone wonders, and until this existed the only record of a
 * publish decision was a line on stderr.
 */
export interface ReleaseProvenance {
  id: string;
  /** Epoch ms. How old the served client is, which is the whole question. */
  publishedAt: number;
  /** What the deploy source was on when this was built, if the caller knew.
   *  Freshness of the artifact is not freshness of the source: a stale
   *  checkout builds successfully and stamps a current timestamp on old code,
   *  so the timestamp alone cannot answer "is this the code I merged".
   *
   *  A `-dirty` suffix means the deploy source had uncommitted changes to
   *  something this deploy BUILDS OR SERVES. Uncommitted documentation does
   *  not earn it — see `deploy-source.ts` for the rule and why the list of
   *  exemptions is closed by default. */
  sourceRef?: string;
  /** Every modified tracked path in the deploy source at publish time, capped
   *  (see `MAX_DIRTY_PATHS`) — including the ones that did NOT set `-dirty`,
   *  so a clean-looking `sourceRef` beside a modified doc is legible rather
   *  than suspicious. */
  dirtyPaths?: string[];
  /** How many modified paths there were in total, listed or not. */
  dirtyPathCount?: number;
}

const PROVENANCE_FILE = 'release.json';

/**
 * The record of publish ATTEMPTS, beside the releases rather than inside one —
 * a failed attempt produces no release to write into, and that is precisely
 * the case worth remembering.
 */
export interface PublishLedger {
  /** Epoch ms of the most recent attempt, successful or not. */
  lastAttemptAt: number;
  /** How many attempts in a row have failed. Zero after any success. */
  consecutiveFailures: number;
  /** When the current streak began. Absent when there is no streak. */
  firstFailureAt?: number;
  /** Why the most recent attempt failed. Absent when it succeeded. */
  lastError?: string;
}

const LEDGER_FILE = 'publish-log.json';

/** Distinguishes two ledger writes from the same process, as the pid
 *  distinguishes two processes. See `ledgerTmpPath`. */
let ledgerSeq = 0;

/**
 * Where one ledger write stages its bytes before the rename that commits it.
 *
 * Per-attempt, never a fixed name: two supervisors starting against the same
 * release root (a launchd respawn overlapping a manual start) would otherwise
 * write the SAME temp path, and one rename would commit the other's outcome —
 * losing a failure, or clearing a streak that is still live. Same reason
 * `current` is staged as `.current-<id>` rather than `.current`.
 */
export function ledgerTmpPath(root: string): string {
  ledgerSeq = (ledgerSeq + 1) % 1_000_000;
  return join(root, `.${LEDGER_FILE}.${process.pid}.${ledgerSeq}.tmp`);
}

/** A client older than this is worth shouting about even on a single failure —
 *  see `decideClientReleaseStale`. */
export const CLIENT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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
  /** The deploy source this build came from (a commit sha, typically). */
  sourceRef?: string;
  /** Modified tracked paths in that deploy source, for the record. */
  dirtyPaths?: string[];
  dirtyPathCount?: number;
}): ClientRelease {
  const { root, sources, keep = 3, now = new Date(), sourceRef } = opts;

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
    // Written into the STAGING tree, so it lands with the rename: a release
    // can never exist without saying what it is.
    const provenance: ReleaseProvenance = {
      id,
      publishedAt: now.getTime(),
      ...(sourceRef ? { sourceRef } : {}),
      ...(opts.dirtyPaths && opts.dirtyPaths.length > 0
        ? {
            dirtyPaths: opts.dirtyPaths,
            dirtyPathCount: opts.dirtyPathCount ?? opts.dirtyPaths.length,
          }
        : {}),
    };
    writeFileSync(join(staging, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
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

/**
 * The publish time encoded in a release id (`20260813T014455123Z-000003`).
 *
 * Every release that exists on the day provenance ships was published without
 * it, and "age unknown" is the one answer that makes a fresh client look
 * alarming. The id has always carried the timestamp, so read it back rather
 * than inventing a gap.
 */
export function publishedAtFromId(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m as unknown as string[];
  return Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms),
  );
}

/** What a release says about itself, or the best reconstruction available. */
export function readReleaseProvenance(releaseDir: string): ReleaseProvenance | null {
  const id = releaseDir.split('/').pop() ?? '';
  try {
    const raw = JSON.parse(readFileSync(join(releaseDir, PROVENANCE_FILE), 'utf8')) as {
      id?: unknown;
      publishedAt?: unknown;
      sourceRef?: unknown;
      dirtyPaths?: unknown;
      dirtyPathCount?: unknown;
    };
    if (typeof raw.publishedAt === 'number' && Number.isFinite(raw.publishedAt)) {
      const dirtyPaths =
        Array.isArray(raw.dirtyPaths) && raw.dirtyPaths.every((p) => typeof p === 'string')
          ? (raw.dirtyPaths as string[])
          : null;
      return {
        id: typeof raw.id === 'string' ? raw.id : id,
        publishedAt: raw.publishedAt,
        ...(typeof raw.sourceRef === 'string' && raw.sourceRef.length > 0
          ? { sourceRef: raw.sourceRef }
          : {}),
        ...(dirtyPaths && dirtyPaths.length > 0
          ? {
              dirtyPaths,
              dirtyPathCount:
                typeof raw.dirtyPathCount === 'number' && Number.isFinite(raw.dirtyPathCount)
                  ? raw.dirtyPathCount
                  : dirtyPaths.length,
            }
          : {}),
      };
    }
  } catch {
    // Falls through to the id, below — a release predating provenance, or a
    // file someone truncated. Either way the id is still authoritative.
  }
  const publishedAt = publishedAtFromId(id);
  return publishedAt === null ? null : { id, publishedAt };
}

/** The publish ledger, or null when nothing has ever been attempted here. */
export function readPublishLedger(root: string): PublishLedger | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, LEDGER_FILE), 'utf8')) as Partial<PublishLedger>;
    if (typeof raw.consecutiveFailures !== 'number') return null;
    return {
      lastAttemptAt: typeof raw.lastAttemptAt === 'number' ? raw.lastAttemptAt : 0,
      consecutiveFailures: raw.consecutiveFailures,
      ...(typeof raw.firstFailureAt === 'number' ? { firstFailureAt: raw.firstFailureAt } : {}),
      ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Record one publish attempt. A success clears the streak outright — the
 * question the ledger answers is "is the build failing NOW", and a count that
 * survived a good publish would keep answering yes forever.
 */
export function recordPublishAttempt(
  root: string,
  outcome: { ok: true } | { ok: false; error: string },
  now: number = Date.now(),
): PublishLedger {
  const prev = readPublishLedger(root);
  const next: PublishLedger = outcome.ok
    ? { lastAttemptAt: now, consecutiveFailures: 0 }
    : {
        lastAttemptAt: now,
        consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        firstFailureAt: prev?.firstFailureAt ?? now,
        lastError: outcome.error,
      };
  // Write beside, then rename: a reader never sees half a ledger, and a crash
  // mid-write leaves the previous answer rather than none.
  const tmp = ledgerTmpPath(root);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, join(root, LEDGER_FILE));
  } catch {
    // The ledger is a signal, not the deploy. Failing to write it must never
    // take down a server that has a perfectly good client to serve.
    rmSync(tmp, { force: true });
  }
  return next;
}

/** Everything a surface needs to say what the browser is running and whether
 *  that is a problem. */
export interface ClientReleaseStatus {
  /** The release being served, or null when nothing has ever published. */
  releaseId: string | null;
  publishedAt: number | null;
  /** How old the served client is, right now. */
  ageMs: number | null;
  sourceRef: string | null;
  consecutiveFailures: number;
  failingSince: number | null;
  lastError: string | null;
  /** The alarm: this deployment is serving a client its own build could not
   *  replace, and it is no longer plausibly a blip. */
  stale: boolean;
}

/**
 * Whether a stale client is worth a person's attention.
 *
 * Two arming conditions, because either alone misses a real case:
 *
 * - **Two failures in a row.** Each prod start is one attempt, so a second
 *   failure means the server has moved forward twice while the browser has
 *   not. That is the widening split, measured rather than guessed.
 * - **One failure over a client that is already old.** A single failure with
 *   no further restarts never reaches two, so a count-only rule would stay
 *   silent forever while the gap grows.
 *
 * And one deliberate silence: a single failed attempt over a client published
 * minutes ago is a blip. The browser is running essentially the code the build
 * was trying to replace, and a warning there teaches people to ignore the
 * warning.
 */
export function decideClientReleaseStale(input: {
  publishedAt: number | null;
  consecutiveFailures: number;
  now: number;
  staleAfterMs?: number;
}): boolean {
  const { publishedAt, consecutiveFailures, now, staleAfterMs = CLIENT_STALE_AFTER_MS } = input;
  if (consecutiveFailures <= 0) return false;
  if (consecutiveFailures >= 2) return true;
  // Nothing published at all: a failed build with no fallback is the worst
  // case there is, never a blip.
  if (publishedAt === null) return true;
  return now - publishedAt >= staleAfterMs;
}

/** Read both traces off disk and decide. Two small file reads — deliberately
 *  uncached, so what a surface reports is the state of this machine now. */
export function clientReleaseStatus(
  root: string,
  now: number = Date.now(),
  staleAfterMs: number = CLIENT_STALE_AFTER_MS,
): ClientReleaseStatus {
  const current = currentClientRelease(root);
  const provenance = current ? readReleaseProvenance(current.releaseDir) : null;
  const ledger = readPublishLedger(root);
  const publishedAt = provenance?.publishedAt ?? null;
  const consecutiveFailures = ledger?.consecutiveFailures ?? 0;
  return {
    releaseId: current?.id ?? null,
    publishedAt,
    ageMs: publishedAt === null ? null : Math.max(0, now - publishedAt),
    sourceRef: provenance?.sourceRef ?? null,
    consecutiveFailures,
    failingSince: consecutiveFailures > 0 ? (ledger?.firstFailureAt ?? null) : null,
    lastError: consecutiveFailures > 0 ? (ledger?.lastError ?? null) : null,
    stale: decideClientReleaseStale({ publishedAt, consecutiveFailures, now, staleAfterMs }),
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
  /** How many starts in a row have now failed to publish, this one included. */
  consecutiveFailures: number;
}

/**
 * The whole prod decision, in one place: publish the freshly-built bundles if
 * they are complete, otherwise keep serving the release that is already live.
 * Stale beats down — a failed build must not take the review server's client
 * offline.
 *
 * Every attempt goes in the ledger, success or failure. That is what turns
 * "this start could not publish" from a line on stderr into a fact the running
 * server can read back and put on a surface: the process that made the
 * decision exits, and the question gets asked days later.
 */
export function prepareClientRelease(opts: {
  root: string;
  sources: ClientSources;
  keep?: number;
  /** The deploy source this build came from (a commit sha, typically). */
  sourceRef?: string;
  /** Modified tracked paths in that deploy source, for the record. */
  dirtyPaths?: string[];
  dirtyPathCount?: number;
  /**
   * The bundler already failed, so do not even look at `sources`. A failed
   * build can leave a dist that passes a file-existence check — the
   * markdown-app build writes app.js before its second entrypoint — so
   * "publish if the files are there" would ship half a build.
   */
  buildError?: string | null;
  /** Epoch ms; injectable so the ledger is testable without waiting. */
  now?: number;
}): PreparedClient {
  const now = opts.now ?? Date.now();
  const fallback = (error: string): PreparedClient => {
    const { consecutiveFailures } = recordPublishAttempt(opts.root, { ok: false, error }, now);
    const cur = currentClientRelease(opts.root);
    return {
      releaseDir: cur?.releaseDir ?? null,
      widget: cur?.widgetDir ?? null,
      markdownApp: cur?.markdownAppDir ?? null,
      stale: true,
      error,
      consecutiveFailures,
    };
  };

  if (opts.buildError) return fallback(opts.buildError);

  try {
    const rel = publishClientRelease({ ...opts, now: new Date(now) });
    recordPublishAttempt(opts.root, { ok: true }, now);
    return {
      releaseDir: rel.releaseDir,
      widget: rel.widgetDir,
      markdownApp: rel.markdownAppDir,
      stale: false,
      consecutiveFailures: 0,
    };
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
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
