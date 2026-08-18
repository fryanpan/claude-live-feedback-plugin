/**
 * Running the plugin update — the deliverable half of shipping that a
 * session can perform for itself.
 *
 * `plugin-release.ts` answers "who is behind". This answers "fix it", and the
 * two belong together: a drift signal nobody can act on from where they read
 * it is a nicer way of being stuck.
 *
 * Three things make this safe to expose to every peer on the board, which was
 * the condition for opening it up at all (Bryan, 2026-08-14):
 *
 *   - **It cannot interrupt anyone.** The update rewrites a version-keyed
 *     cache directory and the `installed_plugins.json` pointer. No running
 *     session is touched: a session resolved `CLAUDE_PLUGIN_ROOT` at launch
 *     and keeps loading the bundle it already points at. Peers take the new
 *     version at their next restart — their own next safe point, not the
 *     instant somebody else asks. So "request a refresh, don't force one" is
 *     a property of the mechanism here rather than a promise in a doc.
 *   - **It takes no arguments.** The argv is fixed. Nothing a caller sends
 *     reaches a process.
 *   - **There is no shell.** The resolved binary is spawned directly with an
 *     argv array. That matters more than it looks: on this machine `claude`
 *     is a shell FUNCTION that injects flags ahead of the subcommand, so a
 *     shelled-out `claude plugin update …` is parsed as a prompt and dies
 *     with "Input must be provided … when using --print" — an error a
 *     previous session read as a permission refusal and wrote up as an agent
 *     being unable to deploy at all.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compareSemver } from './plugin-release.ts';

/** The one plugin this server knows the released version of. */
export const PLUGIN_REF = 'claude-workspaces@claude-workspaces';

/** How long a spawned update gets before it is killed. A hung fetch must not
 *  hold the single-flight slot open forever. */
const RUN_TIMEOUT_MS = 120_000;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RefreshResult {
  /** The update ran and exited cleanly. NOT a claim that anything moved. */
  ok: boolean;
  /** Version in the plugin cache before the update. */
  before: string | null;
  /** After — read back from disk, never taken from the CLI's own report. */
  after: string | null;
  /** Whether the cache actually moved. This is the answer people want. */
  changed: boolean;
  /** What happened, in a sentence, or why it didn't. */
  message: string;
  ranAt: number;
}

interface InstalledRecord {
  scope?: unknown;
  version?: unknown;
}

/** Where Claude Code records what is installed and at which version. */
export function installedPluginsFile(home: string = homedir()): string {
  return join(home, '.claude', 'plugins', 'installed_plugins.json');
}

/**
 * The version of `ref` currently in the plugin cache, or null.
 *
 * User scope wins, because that is the install a peer in any directory
 * resolves; a project-scoped copy is one repo's business. With no user-scope
 * record we take the newest, which is the version most likely to be what
 * someone means by "installed".
 */
export function readInstalledPluginVersion(
  file: string = installedPluginsFile(),
  ref: string = PLUGIN_REF,
): string | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      plugins?: Record<string, unknown>;
    };
    const records = raw.plugins?.[ref];
    if (!Array.isArray(records)) return null;
    const versions = (records as InstalledRecord[]).filter(
      (r): r is InstalledRecord & { version: string } =>
        typeof r.version === 'string' && r.version.trim().length > 0,
    );
    if (versions.length === 0) return null;
    const user = versions.find((r) => r.scope === 'user');
    if (user) return user.version.trim();
    const newest = versions
      .map((r) => r.version.trim())
      .sort(compareSemver)
      .at(-1);
    return newest ?? null;
  } catch {
    return null;
  }
}

/** Where the CLI usually lives, in the order we try. */
export const CLAUDE_BIN_CANDIDATES: readonly string[] = [
  join(homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
];

/**
 * The `claude` binary to spawn, or null if we cannot find one.
 *
 * `override` (LF_CLAUDE_BIN) is **authoritative**: if it is set and does not
 * exist, the answer is null rather than "something else that happens to be
 * on this box". An override at the head of a fallback chain lets an operator
 * believe they pointed this somewhere they didn't — the same failure that
 * once let a leak scanner pass by scanning the wrong file.
 */
export function resolveClaudeBin(opts: {
  override?: string | undefined;
  candidates?: readonly string[];
  exists?: (p: string) => boolean;
}): string | null {
  const exists = opts.exists ?? existsSync;
  const override = opts.override?.trim();
  if (override) return exists(override) ? override : null;
  for (const c of opts.candidates ?? CLAUDE_BIN_CANDIDATES) {
    if (exists(c)) return c;
  }
  return null;
}

export interface RefreshDeps {
  bin: string | null;
  run: (bin: string, args: string[]) => Promise<RunResult>;
  installedVersion: () => string | null;
  now: () => number;
}

/** Spawn the update, then ask the DISK what changed. */
export async function runPluginRefresh(deps: RefreshDeps): Promise<RefreshResult> {
  const ranAt = deps.now();
  const before = deps.installedVersion();
  if (!deps.bin) {
    return {
      ok: false,
      before,
      after: before,
      changed: false,
      message:
        'no claude binary found — set LF_CLAUDE_BIN to its path, or install the CLI on this machine',
      ranAt,
    };
  }

  const res = await deps.run(deps.bin, ['plugin', 'update', PLUGIN_REF]);
  const after = deps.installedVersion();
  const changed = before !== after;
  const tail = (res.stderr.trim() || res.stdout.trim()).split('\n').slice(-3).join(' ').trim();

  if (res.status !== 0) {
    return {
      ok: false,
      before,
      after,
      changed,
      message: `plugin update exited ${res.status ?? 'null'}: ${tail || 'no output'}`,
      ranAt,
    };
  }
  return {
    ok: true,
    before,
    after,
    changed,
    // Deliberately reports the DISK state either way. "Updated" from a
    // command that copied nothing is the exact lie that hid 25 commits.
    message: changed
      ? `plugin cache ${before ?? 'none'} → ${after ?? 'none'} — sessions pick it up when they restart`
      : `plugin cache already at ${after ?? 'none'}`,
    ranAt,
  };
}

/**
 * One refresh at a time, and not more often than the window.
 *
 * Every peer on a board can call this, so a burst of asks must collapse into
 * one `git fetch` against the marketplace rather than N. The window is short
 * (a minute by default) because a transient failure being cached for long
 * would block a real refresh — the point of collapsing a burst is the burst,
 * not rate-limiting the feature.
 */
export class PluginRefresher {
  private readonly runFn: () => Promise<RefreshResult>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private inFlight: Promise<RefreshResult> | null = null;
  private lastResult: RefreshResult | null = null;

  constructor(opts: {
    run: () => Promise<RefreshResult>;
    now?: () => number;
    minIntervalMs?: number;
  }) {
    this.runFn = opts.run;
    this.now = opts.now ?? Date.now;
    this.minIntervalMs = opts.minIntervalMs ?? 60_000;
  }

  last(): RefreshResult | null {
    return this.lastResult;
  }

  refresh(): Promise<RefreshResult> {
    if (this.inFlight) return this.inFlight;
    const prev = this.lastResult;
    if (prev && this.now() - prev.ranAt < this.minIntervalMs) {
      return Promise.resolve(prev);
    }
    const p = this.runFn()
      .catch((e: unknown) => ({
        // This is armed on a timer in prod. A throw that escapes would take
        // the server down over a cache update.
        ok: false,
        before: prev?.after ?? null,
        after: prev?.after ?? null,
        changed: false,
        message: `plugin refresh failed: ${e instanceof Error ? e.message : String(e)}`,
        ranAt: this.now(),
      }))
      .then((r) => {
        this.lastResult = r;
        this.inFlight = null;
        return r;
      });
    this.inFlight = p;
    return p;
  }
}

/** The real spawn: no shell, argv array, hard timeout. */
export function execRun(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: RUN_TIMEOUT_MS }, (err, stdout, stderr) => {
      // `code` is the exit status for a process that ran, and a string errno
      // ('ENOENT', 'ETIMEDOUT') for one that never did. Either way it is not
      // success, so anything non-numeric becomes 1.
      const code = (err as (NodeJS.ErrnoException & { code?: number | string }) | null)?.code;
      resolve({
        status: err ? (typeof code === 'number' ? code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr || (err ? err.message : '')),
      });
    });
  });
}

/**
 * The production refresher. Constructed in ONE place (bin.ts) so nothing that
 * merely spins a server up — every test, every embedded use — can spawn a
 * process, the same seam rule the summarizer follows.
 */
export function createPluginRefresher(opts: { minIntervalMs?: number } = {}): PluginRefresher {
  return new PluginRefresher({
    run: () =>
      runPluginRefresh({
        bin: resolveClaudeBin({ override: process.env.LF_CLAUDE_BIN }),
        run: execRun,
        installedVersion: () => readInstalledPluginVersion(),
        now: Date.now,
      }),
    ...(opts.minIntervalMs !== undefined ? { minIntervalMs: opts.minIntervalMs } : {}),
  });
}
