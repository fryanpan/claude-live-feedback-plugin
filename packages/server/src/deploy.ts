/**
 * Deploying this server — pull the deploy source, then restart it.
 *
 * ## Why it is one operation and not two
 *
 * On 2026-08-17 prod ran 24 commits behind for about ten hours and nothing
 * said so. Two reports that read as bugs in `main` were the stale server:
 * `set_goal_list` rejecting a payload the merged code accepts, and
 * `update_task_body` taking a `title`, answering 200, and keeping the old
 * one. Both returned success, which is what made them expensive.
 *
 * Deploying required a person with a shell in the primary checkout. This is
 * that person's two commands, minus the person.
 *
 * **The ordering is structural rather than documented.** `Deployer` exposes
 * exactly one verb, and it always fetches first. There is deliberately no way
 * to ask for a restart on its own, because a restart re-runs
 * `scripts/serve.ts --no-watch` out of the deploy source's WorkingDirectory —
 * so a restart over an unpulled checkout rebuilds the *same* bundles,
 * republishes the *same* client, prints a successful deploy line, and changes
 * nothing. That is the failure this module exists to remove, and a comment
 * saying "always pull first" is exactly the kind of instruction that gets
 * skipped at 2am. So it is not expressible.
 *
 * ## What it will not do
 *
 * Only a fast-forward. Never a rebase, never a reset, never a force. `ahead >
 * 0` on the deploy source means somebody committed there and has not pushed;
 * the honest answer is to name it and stop, because every mechanism that
 * would "fix" it destroys their commit. The pull is `fetch` + `merge
 * --ff-only` rather than `git pull`, which does whatever `pull.rebase`
 * happens to say on this machine.
 *
 * ## What it reports
 *
 * The ref before and after, both READ from the checkout with
 * `readDeploySource`, never parsed out of git's own chatter — the same
 * discipline `PluginRefresher` uses, and for the same reason: a command that
 * reports success while copying nothing is how a delivery gap hides.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type DeploySource,
  type GitRunner,
  parseStatusPorcelainZ,
  readDeploySource,
} from './deploy-source.ts';

/** The launchd job this machine supervises the server with. Restarting it is
 *  what re-runs `scripts/serve.ts --no-watch`, which rebuilds the browser
 *  bundles and publishes them as the client release the fleet loads. */
export const LAUNCHD_LABEL = 'com.fryanpan.live-feedback';

/** How long the restart waits after `deploy()` returns, so the HTTP response
 *  that says "restarting" reaches the caller before the process it came
 *  from goes away. */
export const RESTART_DELAY_MS = 1500;

/** Ceiling on any single git invocation. A hung fetch must not hold the
 *  single-flight slot open forever. */
const GIT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface DeployFacts {
  /** Commits the upstream has that the deploy source does not. */
  behind: number;
  /** Commits the deploy source has that the upstream does not. */
  ahead: number;
  /** Tracked paths with uncommitted modifications, repo-relative. */
  dirtyPaths: readonly string[];
  /** Paths the fast-forward would rewrite. */
  incomingPaths: readonly string[];
  /** What the checkout is parked on now, for the message. */
  currentRef: string | null;
}

export type DeployDecision =
  | { kind: 'up-to-date'; reason: string }
  | { kind: 'fast-forward'; reason: string }
  | { kind: 'refuse-diverged'; reason: string }
  | { kind: 'refuse-dirty'; reason: string; blockingPaths: string[] };

/**
 * `git rev-list --left-right --count HEAD...@{u}` → `{ahead, behind}`.
 *
 * Left is HEAD. Reading the two columns the other way round turns "somebody
 * committed here" into "we are behind" and fast-forwards over their work, so
 * anything unrecognised answers null and the caller must treat that as an
 * error — never as 0/0, which reads as up-to-date and skips the deploy in
 * silence.
 */
export function parseAheadBehind(out: string): { ahead: number; behind: number } | null {
  const m = out.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return null;
  return { ahead: Number(m[1]), behind: Number(m[2]) };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What this deploy is allowed to do to the deploy source.
 *
 * Order matters: divergence is checked before dirt, because a checkout that
 * is both diverged and dirty has the worse problem, and reporting the dirt
 * would send someone off to stash files when the real issue is an unpushed
 * commit.
 *
 * A modified path blocks only when the pull would rewrite that same path.
 * A blanket "refuse while dirty" was the first shape and it is unusable
 * here: the deploy source hosts bound review documents, so tracked files
 * under `docs/` are modified for hours during ordinary editing (see
 * `deploy-source.ts` for the measurement). It is also the rule git itself
 * applies — `merge --ff-only` refuses exactly when an incoming change
 * touches a locally-modified file — so refusing on the intersection means we
 * refuse where git would, with a message that names the file.
 */
export function decideDeploy(facts: DeployFacts): DeployDecision {
  const at = facts.currentRef ?? 'an unknown ref';
  if (facts.ahead > 0) {
    return {
      kind: 'refuse-diverged',
      reason:
        `the deploy source has ${plural(facts.ahead, 'commit')} the upstream does not` +
        (facts.behind > 0 ? ` and is ${plural(facts.behind, 'commit')} behind it` : '') +
        ' — push or drop them first; this never rebases, resets or forces',
    };
  }
  if (facts.behind === 0) {
    return { kind: 'up-to-date', reason: `the deploy source is already at ${at}` };
  }
  const incoming = new Set(facts.incomingPaths);
  const blockingPaths = [...new Set(facts.dirtyPaths.filter((p) => incoming.has(p)))].sort();
  if (blockingPaths.length > 0) {
    return {
      kind: 'refuse-dirty',
      blockingPaths,
      reason: `${plural(blockingPaths.length, 'file')} the pull would rewrite ${
        blockingPaths.length === 1 ? 'is' : 'are'
      } modified in the deploy source: ${blockingPaths.join(', ')}`,
    };
  }
  return {
    kind: 'fast-forward',
    reason: `${plural(facts.behind, 'commit')} to fast-forward from ${at}`,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** A bound document whose write-back flush has not fired yet. */
export interface BusyDoc {
  docId: string;
  path: string;
}

export type DeployStatus =
  | 'deployed'
  | 'up-to-date'
  | 'refuse-diverged'
  | 'refuse-dirty'
  | 'refuse-busy'
  | 'error';

export interface DeployResult {
  /** The deploy did what it set out to do. A refusal is `ok: false` with a
   *  status that says which refusal — never a thrown error, because the
   *  caller asked "can you deploy" and the answer is information. */
  ok: boolean;
  status: DeployStatus;
  /** What the deploy source was parked on before, read from the checkout. */
  before: string | null;
  /** And after. Read the same way — never parsed out of git's output, which
   *  reports success for a pull that moved nothing. */
  after: string | null;
  /** Whether the checkout actually moved. This is the answer people want. */
  changed: boolean;
  behind: number;
  ahead: number;
  /** Every modified tracked path, including the ones that did not block —
   *  so a deploy that proceeded over a modified doc reads as a decision
   *  rather than an oversight. */
  dirtyPaths?: string[];
  /** The subset that refused the deploy. */
  blockingPaths?: string[];
  /** Bound docs still holding un-flushed edits, when that is what refused. */
  busyDocs?: BusyDoc[];
  /** A restart was scheduled. It is fire-and-forget by necessity: the
   *  restart kills the process that would have reported on it. */
  restartRequested: boolean;
  /** Whether the caller overrode the busy-document refusal. */
  forced?: boolean;
  requestedBy?: string;
  message: string;
  ranAt: number;
}

export interface DeployDeps {
  /** One git invocation in the deploy source. Injected so no test can reach
   *  a real checkout. */
  git: GitRunner;
  /** Read the checkout's provenance. Injected for the same reason, and
   *  separately from `git` so a test can make the READ and the COMMANDS
   *  disagree — which is the mutation that catches a `changed` computed
   *  from git's chatter instead of from disk. */
  readSource: () => DeploySource | null;
  /** Bound documents inside the deploy source with a pending flush. */
  busyDocs: () => BusyDoc[];
  /** Schedule the service restart. Never awaited — it ends this process. */
  restart: () => void;
  now: () => number;
}

export interface DeployRequest {
  /** Deploy even though bound documents hold un-flushed edits. */
  force?: boolean;
  requestedBy?: string;
}

const refFrom = (s: DeploySource | null): string | null => s?.sourceRef ?? null;

function fail(
  deps: DeployDeps,
  before: string | null,
  message: string,
  extra: Partial<DeployResult> = {},
): DeployResult {
  return {
    ok: false,
    status: 'error',
    before,
    after: before,
    changed: false,
    behind: 0,
    ahead: 0,
    restartRequested: false,
    message,
    ranAt: deps.now(),
    ...extra,
  };
}

/**
 * Fetch, decide, fast-forward, restart. In that order, with no way in at any
 * later point.
 */
export async function runDeploy(deps: DeployDeps, req: DeployRequest = {}): Promise<DeployResult> {
  const beforeSource = deps.readSource();
  const before = refFrom(beforeSource);
  const requested = req.requestedBy?.trim();
  const attrib = requested ? { requestedBy: requested } : {};

  const fetched = deps.git(['fetch', '--quiet', 'origin']);
  if (!fetched.ok) {
    return fail(
      deps,
      before,
      'git fetch failed — the deploy source could not reach origin',
      attrib,
    );
  }

  const counts = deps.git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  const ab = counts.ok ? parseAheadBehind(counts.stdout) : null;
  if (!ab) {
    return fail(
      deps,
      before,
      'could not compare the deploy source with its upstream (no tracking branch?)',
      attrib,
    );
  }

  const status = deps.git(['status', '--porcelain', '-z', '--untracked-files=no']);
  if (!status.ok) {
    // An unknowable tree is not a clean one. The same call answers the
    // blocking check, so guessing here would guess about someone's edits.
    return fail(deps, before, 'could not read the deploy source working tree', {
      ...attrib,
      behind: ab.behind,
      ahead: ab.ahead,
    });
  }
  const dirtyPaths = [...new Set(parseStatusPorcelainZ(status.stdout))].sort();

  // Only asked for when there is something to pull; on an up-to-date source
  // the answer is empty by construction and the spawn is waste.
  let incomingPaths: string[] = [];
  if (ab.behind > 0 && ab.ahead === 0) {
    const names = deps.git(['diff', '--name-only', '-z', 'HEAD', '@{u}']);
    if (!names.ok) {
      return fail(deps, before, 'could not list the files the pull would change', {
        ...attrib,
        behind: ab.behind,
        ahead: ab.ahead,
        dirtyPaths,
      });
    }
    incomingPaths = names.stdout.split('\0').filter((p) => p.length > 0);
  }

  const decision = decideDeploy({
    behind: ab.behind,
    ahead: ab.ahead,
    dirtyPaths,
    incomingPaths,
    currentRef: before,
  });

  const common = {
    before,
    after: before,
    changed: false,
    behind: ab.behind,
    ahead: ab.ahead,
    ...(dirtyPaths.length > 0 ? { dirtyPaths } : {}),
    restartRequested: false,
    ranAt: deps.now(),
    ...attrib,
  };

  if (decision.kind === 'up-to-date') {
    // Deliberately does NOT restart. A restart here would republish the same
    // client and bounce every live editor for nothing.
    return { ...common, ok: true, status: 'up-to-date', message: decision.reason };
  }
  if (decision.kind === 'refuse-diverged') {
    return { ...common, ok: false, status: 'refuse-diverged', message: decision.reason };
  }
  if (decision.kind === 'refuse-dirty') {
    return {
      ...common,
      ok: false,
      status: 'refuse-dirty',
      blockingPaths: decision.blockingPaths,
      message: decision.reason,
    };
  }

  // The pull is about to rewrite files on disk, and a bound document with an
  // un-flushed edit LOSES that write silently — the live doc reasserts itself
  // over the git content ~800ms later and git's own exit code says nothing.
  // So the check goes here, after the git decision and before anything
  // touches the tree.
  //
  // POLICY — refuse, with `force` to override — and it is deliberately one
  // predicate. The other candidate policy ("report who is busy but deploy
  // anyway", so a busy board cannot block its own deploy) is this same block
  // with `busyRefuses` flipped to false: the list is still gathered and still
  // reported, only the refusal goes. Awaiting a ruling; see the PR.
  const busyRefuses = !req.force;
  if (busyRefuses) {
    const busy = deps.busyDocs();
    if (busy.length > 0) {
      return {
        ...common,
        ok: false,
        status: 'refuse-busy',
        busyDocs: busy,
        message:
          `${plural(busy.length, 'bound document')} in the deploy source ${
            busy.length === 1 ? 'has' : 'have'
          } un-flushed edits: ${busy.map((d) => d.path).join(', ')} — ` +
          'the pull would be silently undone by the next write-back. Wait ~1s ' +
          'for them to settle, or deploy with force to accept the loss.',
      };
    }
  }

  const merged = deps.git(['merge', '--ff-only', '@{u}']);
  const afterSource = deps.readSource();
  const after = refFrom(afterSource);
  // Read, not parsed. `git merge` prints "Fast-forward" for a merge that
  // moved the ref and "Already up to date." for one that did not, and
  // trusting either is how a deploy reports a delivery it never made.
  const changed = before !== after;

  if (!merged.ok) {
    return {
      ...common,
      ok: false,
      status: 'error',
      after,
      changed,
      message: 'git merge --ff-only refused — the deploy source was not fast-forwarded',
    };
  }

  deps.restart();
  return {
    ...common,
    ok: true,
    status: 'deployed',
    after,
    changed,
    restartRequested: true,
    ...(req.force ? { forced: true } : {}),
    message:
      `deploy source ${before ?? 'unknown'} → ${after ?? 'unknown'} ` +
      `(${plural(ab.behind, 'commit')}); restarting the server, which rebuilds and ` +
      'republishes the browser client',
  };
}

// ---------------------------------------------------------------------------
// The durable trace
// ---------------------------------------------------------------------------

/** Where the last deploy result is kept. */
export function deployLogPath(dataDir: string): string {
  return join(dataDir, 'deploy-log.json');
}

/**
 * A deploy ends by killing the process that performed it, so an in-memory
 * `last()` is empty in exactly the situation someone asks the question. The
 * write happens as soon as `runDeploy` resolves, which is inside the restart
 * delay — the restart is scheduled, not immediate, precisely so the result
 * and the response both get out first.
 */
export function writeDeployLog(file: string, result: DeployResult): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp~`;
    writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    console.error('[deploy] could not record the deploy result:', err);
  }
}

export function readDeployLog(file: string): DeployResult | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as DeployResult;
    return typeof parsed?.status === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The single-flight wrapper
// ---------------------------------------------------------------------------

/**
 * One deploy at a time, and a last result that survives the restart.
 *
 * Modelled on `PluginRefresher`, with one deliberate difference: there is no
 * minimum interval. A cached refusal would answer "still dirty" to the person
 * who just cleaned the tree, and the operation is naturally idempotent —
 * a second deploy against a source that just fast-forwarded answers
 * `up-to-date` and restarts nothing.
 */
export class Deployer {
  private readonly runFn: (req: DeployRequest) => Promise<DeployResult>;
  private readonly now: () => number;
  private readonly persist: ((r: DeployResult) => void) | null;
  private readonly loadLast: (() => DeployResult | null) | null;
  private inFlight: Promise<DeployResult> | null = null;
  private lastResult: DeployResult | null = null;
  private loaded = false;

  constructor(opts: {
    run: (req: DeployRequest) => Promise<DeployResult>;
    now?: () => number;
    persist?: (r: DeployResult) => void;
    loadLast?: () => DeployResult | null;
  }) {
    this.runFn = opts.run;
    this.now = opts.now ?? Date.now;
    this.persist = opts.persist ?? null;
    this.loadLast = opts.loadLast ?? null;
  }

  last(): DeployResult | null {
    if (this.lastResult) return this.lastResult;
    if (!this.loaded && this.loadLast) {
      this.loaded = true;
      this.lastResult = this.loadLast();
    }
    return this.lastResult;
  }

  deploy(req: DeployRequest = {}): Promise<DeployResult> {
    if (this.inFlight) return this.inFlight;
    const p = this.runFn(req)
      .catch((e: unknown) => {
        // A throw escaping here would take the review server down over a
        // deploy attempt, which is a strictly worse outcome than the stale
        // build the deploy was meant to fix.
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          status: 'error' as const,
          before: this.lastResult?.after ?? null,
          after: this.lastResult?.after ?? null,
          changed: false,
          behind: 0,
          ahead: 0,
          restartRequested: false,
          message: `deploy failed: ${message}`,
          ranAt: this.now(),
        };
      })
      .then((r) => {
        this.lastResult = r;
        this.loaded = true;
        this.inFlight = null;
        this.persist?.(r);
        return r;
      });
    this.inFlight = p;
    return p;
  }
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

function spawnGit(cwd: string): GitRunner {
  return (args) => {
    try {
      const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      return { ok: r.exitCode === 0, stdout: r.stdout.toString() };
    } catch {
      return { ok: false, stdout: '' };
    }
  };
}

/**
 * Restart the launchd job, a moment from now.
 *
 * `kickstart -k` is the supported way to force-restart a supervised service
 * (`load`/`unload` are deprecated on macOS 11+). No shell: a fixed argv
 * array, for the same reason the plugin refresher uses one — on this machine
 * a shell would resolve `claude` to a function, and the general rule is that
 * nothing a caller sends should ever reach a process.
 *
 * The delay exists so the HTTP response announcing the restart is flushed
 * before the process serving it is killed. Nothing awaits this: the restart
 * ends the reporter.
 */
export function launchctlRestart(label: string = LAUNCHD_LABEL, delayMs = RESTART_DELAY_MS) {
  return () => {
    const target = `gui/${userInfo().uid}/${label}`;
    const timer = setTimeout(() => {
      if (process.platform !== 'darwin') {
        console.error(`[deploy] no launchd on ${process.platform}; restart ${target} skipped`);
        return;
      }
      console.log(`[deploy] restarting ${target}`);
      execFile(
        '/bin/launchctl',
        ['kickstart', '-k', target],
        { timeout: GIT_TIMEOUT_MS },
        (err) => {
          if (err) console.error(`[deploy] launchctl kickstart failed: ${err.message}`);
        },
      );
    }, delayMs);
    timer.unref?.();
  };
}

/**
 * The production deployer. Constructed in ONE place (`bin.ts`, behind a flag
 * only `scripts/serve.ts --no-watch` passes) so that no test run, no embedded
 * server and no `bun run staging` can pull or restart the fleet's server.
 * Same seam rule as the plugin refresher and the summarizer, and here it is
 * load-bearing twice over: this one writes to a git checkout.
 */
export function createDeployer(opts: {
  repoRoot: string;
  dataDir: string;
  busyDocs: () => BusyDoc[];
  restart?: () => void;
}): Deployer {
  const git = spawnGit(opts.repoRoot);
  const logFile = deployLogPath(opts.dataDir);
  const restart = opts.restart ?? launchctlRestart();
  return new Deployer({
    run: (req) =>
      runDeploy(
        {
          git,
          readSource: () => readDeploySource(opts.repoRoot, git),
          busyDocs: opts.busyDocs,
          restart,
          now: Date.now,
        },
        req,
      ),
    persist: (r) => writeDeployLog(logFile, r),
    loadLast: () => readDeployLog(logFile),
  });
}
