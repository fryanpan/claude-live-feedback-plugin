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
 * ## What "already deployed" means
 *
 * Not "the checkout is at origin's tip". A deploy delivers a browser client,
 * and that client is rebuilt by the restart — so the question is whether the
 * SERVED release was built from what the checkout is on now, which is exactly
 * what `release.json`'s `sourceRef` records. A source somebody pulled by hand
 * and did not restart is current by git and stale by the only measure a
 * reader cares about. It gets a restart; a source whose served client matches
 * gets left alone.
 *
 * ## What it reports
 *
 * The ref before and after, both READ from the checkout with
 * `readDeploySource`, never parsed out of git's own chatter — the same
 * discipline `PluginRefresher` uses, and for the same reason: a command that
 * reports success while copying nothing is how a delivery gap hides.
 *
 * ## Dependencies are part of the delivery
 *
 * On 2026-08-30 a PR added a package; the deploy pulled, restarted, and the
 * server booted into a missing-import crash — while the deploy answered 200
 * and `release.json` advanced, because the bundles built fine before the
 * server process died. Two changes close that gap, and each one alone is not
 * enough:
 *
 * - `bun install --frozen-lockfile` runs before EVERY restart this module
 *   schedules, not only when the pull touched `bun.lock`. Gating on the
 *   lockfile misses the recovery case (a pull whose install failed leaves the
 *   next deploy seeing nothing to pull) and the hand-pulled case
 *   (restart-only over a checkout somebody updated without installing).
 *   Frozen, because a deploy installs exactly what was merged — an install
 *   that would rewrite `bun.lock` in the deploy source is a broken merge, not
 *   something to paper over. A failed install refuses the restart outright:
 *   `install-failed`, and the server keeps running on the code it has.
 *
 * - A restart is recorded as an INTENT, not a success. The result carries
 *   `verification: pending` with a deadline; the restarted server confirms
 *   its own boot (`confirmDeployBoot`, called from `bin.ts` once it is
 *   actually serving), and a detached watchdog (`deploy-verify.ts`, spawned
 *   alongside the restart precisely because the restart kills the process
 *   that could otherwise check) marks the record `boot-failed` if the
 *   deadline passes with no confirmation. `GET /api/deploy` reads the
 *   verdict; a pending record past its deadline reads as failed even if the
 *   watchdog never got to write.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientReleaseStatus } from './client-release.ts';
import {
  type DeploySource,
  type GitRunner,
  parseStatusPorcelainZ,
  readDeploySource,
} from './deploy-source.ts';

/** The launchd job this machine supervises the server with. Restarting it is
 *  what re-runs `scripts/serve.ts --no-watch`, which rebuilds the browser
 *  bundles and publishes them as the client release the fleet loads. */
export const LAUNCHD_LABEL = 'com.fryanpan.claude-workspaces';

/** How long the restart waits after `deploy()` returns, so the HTTP response
 *  that says "restarting" reaches the caller before the process it came
 *  from goes away. */
export const RESTART_DELAY_MS = 1500;

/** Ceiling on any single git invocation. A hung fetch must not hold the
 *  single-flight slot open forever. */
const GIT_TIMEOUT_MS = 120_000;

/** Ceiling on `bun install`. A cold cache pulling a new package over a slow
 *  link is minutes, not seconds; a hang past this is a failed install, and a
 *  failed install is a refused restart — never a restart into missing
 *  imports. */
export const INSTALL_TIMEOUT_MS = 300_000;

/** How long a restarted server gets to confirm its own boot before the
 *  deploy is recorded as `boot-failed`. Prod's restart re-runs
 *  `scripts/serve.ts`, which rebuilds both browser bundles and then hydrates
 *  every persisted document before the port answers — minutes on a bad day,
 *  so the deadline is generous. What it must never be is infinite: a
 *  `pending` that nothing expires is the 200-on-a-dead-server this exists to
 *  remove. */
export const VERIFY_BOOT_TIMEOUT_MS = 180_000;

/** How long a busy bound document is given to finish before the deploy
 *  refuses over it. The write-back debounce is ~800ms (`rooms.ts`), so this
 *  covers a flush that was already in flight when the deploy arrived,
 *  without covering someone who is still typing. */
export const BUSY_SETTLE_MS = 1500;

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
  /**
   * What the SERVED client release was built from — the `sourceRef` in its
   * `release.json`. Three states, and they are three different questions:
   *
   * - a string: compare it with `currentRef`.
   * - `null`: this deployment publishes a client, but what it published
   *   cannot be read (nothing published yet, or a release with no
   *   provenance). Not a match — claiming the browser is current would be
   *   claiming something nobody checked.
   * - absent: this deployment publishes no client at all (dev, staging, a
   *   bare `bin.ts`). There is no served bundle to be stale, so the git
   *   answer is the whole answer.
   */
  servedRef?: string | null;
}

export type DeployDecision =
  | { kind: 'up-to-date'; reason: string }
  | { kind: 'restart-only'; reason: string }
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
 * Is the client this server is SERVING older than the checkout it would build
 * from?
 *
 * The two refs are stamped by the same `describeDeploySource`, so they are
 * comparable as written — including the `-dirty` suffix, which is a real
 * content difference and not noise: a release built from an uncommitted tree
 * is not the same bundle as one built after the commit landed.
 *
 * Two deliberate silences, both of which would otherwise restart a server to
 * rebuild something nobody can name: a deployment that publishes no release
 * (`servedRef` absent) has no served bundle to be stale, and a checkout git
 * cannot describe (`currentRef` null) gives nothing to compare against.
 */
function servedClientIsOlder(f: DeployFacts): { stale: false } | { stale: true; ref: string } {
  if (f.servedRef === undefined || f.currentRef === null) return { stale: false };
  if (f.servedRef === f.currentRef) return { stale: false };
  return { stale: true, ref: f.servedRef ?? 'an unrecorded ref' };
}

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
 *
 * ## "Up-to-date" is served-vs-HEAD, not git-vs-origin
 *
 * `behind === 0` answers "is the CHECKOUT current", and that was never the
 * question. A deploy delivers a browser client, and the client is rebuilt by
 * the restart — so a checkout somebody pulled by hand and did not restart is
 * at origin's tip while the fleet is still loading the bundle built from the
 * older commit. Answering `up-to-date` there both refuses to restart and
 * reports the gap as absent, which is the same shape as the ten-hour stale
 * prod this module was written for: a successful-looking answer with the
 * delivery still undone.
 *
 * So `up-to-date` requires BOTH — nothing to pull and a served client built
 * from what the checkout is on. Nothing to pull with an older client is
 * `restart-only`: no merge, no files touched, just the restart that rebuilds
 * and republishes.
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
    const served = servedClientIsOlder(facts);
    if (served.stale) {
      return {
        kind: 'restart-only',
        reason:
          `the deploy source is at ${at}, but the client this server is serving was built ` +
          `from ${served.ref} — restarting rebuilds and republishes it`,
      };
    }
    return {
      kind: 'up-to-date',
      reason:
        `the deploy source is already at ${at}` +
        (facts.servedRef ? ', and the served client was built from it' : ''),
    };
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
  /** Nothing to pull, but the served client was built from an older ref, so
   *  the server was restarted to rebuild and republish it. */
  | 'restarted'
  | 'up-to-date'
  | 'refuse-diverged'
  | 'refuse-dirty'
  | 'refuse-busy'
  /** `bun install` failed after the pull (or before a restart-only), so the
   *  restart was refused — the running server keeps its working
   *  dependencies rather than booting into a missing import. */
  | 'install-failed'
  /** The restart was scheduled and the server never confirmed a healthy
   *  boot before the verification deadline. Written by the watchdog, or
   *  derived at read time from a `pending` past its deadline. */
  | 'boot-failed'
  | 'error';

/**
 * Whether the restart a deploy scheduled actually produced a serving
 * process. Three states, written by three different actors:
 *
 * - `pending` — stamped by the deploy itself, with the deadline, before the
 *   restart kills the process that stamped it.
 * - `healthy` — stamped by the RESTARTED server once it is serving
 *   (`confirmDeployBoot`). Nothing else may claim health: the deploy cannot
 *   know it, and the watchdog knowing the port answered is weaker than the
 *   server knowing it finished coming up.
 * - `failed` — stamped by the detached watchdog when the deadline passes
 *   with the record still pending, or derived at read time when even the
 *   watchdog did not survive to write it.
 */
export type DeployVerification =
  | { state: 'pending'; deadlineAt: number }
  | { state: 'healthy'; confirmedAt: number; detail: string }
  | { state: 'failed'; failedAt: number; detail: string };

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
  /** Whether `bun install` ran (it runs before every restart). Absent on
   *  paths that never reached one. */
  installed?: boolean;
  /** Whether the restarted server actually came back. Present exactly when
   *  a restart was requested — see `DeployVerification`. */
  verification?: DeployVerification;
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
  /**
   * What the served client release was built from. Absent when this
   * deployment publishes no release — see `DeployFacts.servedRef`.
   */
  readServed?: () => string | null;
  /**
   * `bun install --frozen-lockfile` in the deploy source. Runs before EVERY
   * restart this module schedules (see the module header for why it is not
   * gated on `bun.lock` moving). REQUIRED rather than defaulted, same rule
   * as `wait`: a wiring that forgets it is a compile error, not a deploy
   * that restarts into missing imports.
   */
  install: () => { ok: boolean; detail?: string };
  /**
   * Sleep. REQUIRED rather than defaulted, so a caller that forgets it is a
   * compile error instead of a test suite that sleeps for real.
   */
  wait: (ms: number) => Promise<void>;
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

  // `undefined` when this deployment publishes no client release at all —
  // the optional call and the optional field carry the same three states.
  const decision = decideDeploy({
    behind: ab.behind,
    ahead: ab.ahead,
    dirtyPaths,
    incomingPaths,
    currentRef: before,
    servedRef: deps.readServed?.(),
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
  if (decision.kind === 'restart-only') {
    // Nothing to pull; the served client is just older than the checkout.
    // No merge, so nothing on disk is rewritten — which is also why the
    // busy-document refusal below does not apply here. That refusal exists
    // because a PULL overwrites files under a live editor; a restart writes
    // nothing, and `handle.stop()` flushes every pending write-back on the
    // way down (`Rooms.flush`).
    //
    // The install DOES apply: the checkout somebody pulled by hand may hold
    // a lockfile nobody installed, and this path is also how a deploy whose
    // install failed gets retried once the cause is fixed.
    const installed = deps.install();
    if (!installed.ok) {
      return {
        ...common,
        ok: false,
        status: 'install-failed',
        message:
          'bun install failed, so the restart was refused — restarting over missing ' +
          `dependencies is how a dead server reports a successful deploy: ${
            installed.detail ?? 'no detail'
          }`,
      };
    }
    deps.restart();
    return {
      ...common,
      ok: true,
      status: 'restarted',
      restartRequested: true,
      installed: true,
      verification: { state: 'pending', deadlineAt: deps.now() + VERIFY_BOOT_TIMEOUT_MS },
      message: `${decision.reason}; boot verification pending — read it back with GET /api/deploy`,
    };
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
  // POLICY — refuse, with `force` to override. Bryan, 2026-08-18, asked and
  // answered: keep refuse by default. The alternative ("report who is busy
  // but deploy anyway") loses someone's sentence silently, and this one at
  // worst asks them to stop typing for a moment.
  //
  // But "busy" is a ~800ms write-back debounce, not a person. Asking once
  // catches every edit that finished a heartbeat before the deploy arrived
  // and refuses over a flush that was already on its way to disk — a refusal
  // the caller can only answer by trying again, which is what a wait is. So
  // the window is given time to close and the question is asked again: a doc
  // that settled proceeds, one still being typed in still refuses.
  const busyRefuses = !req.force;
  if (busyRefuses) {
    let busy = deps.busyDocs();
    if (busy.length > 0) {
      await deps.wait(BUSY_SETTLE_MS);
      busy = deps.busyDocs();
    }
    if (busy.length > 0) {
      return {
        ...common,
        ok: false,
        status: 'refuse-busy',
        busyDocs: busy,
        message:
          `${plural(busy.length, 'bound document')} in the deploy source ${
            busy.length === 1 ? 'has' : 'have'
          } un-flushed edits after waiting for ${BUSY_SETTLE_MS}ms: ` +
          `${busy.map((d) => d.path).join(', ')} — the pull would be silently ` +
          'undone by the next write-back. Stop editing, or deploy with force ' +
          'to accept the loss.',
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

  // The pull may have moved `bun.lock`; the running process was booted
  // against the OLD dependency set and the restarted one needs the new set
  // on disk before it starts. Reported honestly on failure: the checkout DID
  // move (`after`/`changed` say so), and the restart was refused.
  const installed = deps.install();
  if (!installed.ok) {
    return {
      ...common,
      ok: false,
      status: 'install-failed',
      after,
      changed,
      message:
        `deploy source moved ${before ?? 'unknown'} → ${after ?? 'unknown'}, but bun ` +
        'install failed and the restart was refused — the server keeps running on the ' +
        `previous code rather than booting into missing dependencies: ${
          installed.detail ?? 'no detail'
        }`,
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
    installed: true,
    verification: { state: 'pending', deadlineAt: deps.now() + VERIFY_BOOT_TIMEOUT_MS },
    ...(req.force ? { forced: true } : {}),
    message:
      `deploy source ${before ?? 'unknown'} → ${after ?? 'unknown'} ` +
      `(${plural(ab.behind, 'commit')}); restarting the server, which rebuilds and ` +
      'republishes the browser client; boot verification pending — read it back with ' +
      'GET /api/deploy',
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
// Boot verification — who gets to say the restart worked
// ---------------------------------------------------------------------------

/**
 * The RESTARTED server confirms the deploy that restarted it. Called from
 * `bin.ts` once the server is actually serving (port bound, documents
 * hydrated) — which is the only vantage point that can claim health, because
 * the deploy's own process is dead by then and the watchdog can only see
 * that something answered.
 *
 * Touches nothing unless the last record is a restart still pending: an
 * ordinary boot with no deploy in flight, or one whose verdict is already
 * written, is left alone.
 */
export function confirmDeployBoot(file: string, now: () => number = Date.now): DeployResult | null {
  const last = readDeployLog(file);
  if (!last || !last.restartRequested || last.verification?.state !== 'pending') return null;
  const updated: DeployResult = {
    ...last,
    verification: {
      state: 'healthy',
      confirmedAt: now(),
      detail: 'the restarted server came up and confirmed its own boot',
    },
  };
  writeDeployLog(file, updated);
  return updated;
}

/** The failed-boot verdict, shared by the watchdog's durable write and the
 *  read-time derivation so the two can never tell different stories. */
function bootFailedResult(last: DeployResult, now: number): DeployResult {
  return {
    ...last,
    ok: false,
    status: 'boot-failed',
    verification: {
      state: 'failed',
      failedAt: now,
      detail:
        `the restarted server never confirmed a healthy boot within ${
          VERIFY_BOOT_TIMEOUT_MS / 1000
        }s — it may be crash-looping (a missing dependency, a startup throw); ` +
        'check the launchd error log',
    },
  };
}

/**
 * The watchdog's one write: a record still `pending` past its own deadline
 * becomes a durable `boot-failed`. Deliberately keyed on the RECORD's
 * deadline rather than on who spawned the watchdog — a newer deploy's record
 * carries a future deadline, so a stale watchdog reads it and stands down
 * instead of failing somebody else's restart.
 */
export function expireDeployVerification(
  file: string,
  now: () => number = Date.now,
): DeployResult | null {
  const last = readDeployLog(file);
  if (!last || last.verification?.state !== 'pending') return null;
  if (now() < last.verification.deadlineAt) return null;
  const updated = bootFailedResult(last, now());
  writeDeployLog(file, updated);
  return updated;
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
    if (!this.loaded && this.loadLast) {
      this.loaded = true;
      this.lastResult = this.loadLast();
    }
    // A pending verification is the one state another process may settle
    // behind our back — the restarted server writes `healthy`, the watchdog
    // writes `boot-failed` — so it is re-read rather than served from the
    // cache. Rare (deploys, not requests) and a single small file.
    if (this.lastResult?.verification?.state === 'pending' && this.loadLast) {
      this.lastResult = this.loadLast() ?? this.lastResult;
    }
    const r = this.lastResult;
    // Still pending past its deadline means nobody survived to write the
    // verdict; the reader gets the verdict anyway rather than a stale
    // "restarting" that reads as in-progress forever.
    if (r?.verification?.state === 'pending' && this.now() >= r.verification.deadlineAt) {
      return bootFailedResult(r, this.now());
    }
    return r;
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
 * `bun install --frozen-lockfile` in the deploy source. Frozen because a
 * deploy installs exactly what the merge delivered — an install that wants to
 * rewrite `bun.lock` is a broken merge to refuse loudly, and a write to the
 * lockfile would also dirty the deploy source, which the NEXT deploy then
 * refuses over. Only `node_modules` moves.
 */
function spawnBunInstall(cwd: string): () => { ok: boolean; detail?: string } {
  return () => {
    try {
      const r = spawnSync('bun', ['install', '--frozen-lockfile'], {
        cwd,
        encoding: 'utf8',
        timeout: INSTALL_TIMEOUT_MS,
      });
      if (r.status === 0) return { ok: true };
      // The tail, not the head: bun prints its resolution log first and the
      // reason it stopped last.
      const tail = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.trim().slice(-500);
      return { ok: false, detail: tail || `bun install exited with ${r.status ?? 'a signal'}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * The boot watchdog, as a DETACHED process — its own process group, stdio
 * closed, unref'd — because `launchctl kickstart -k` is about to kill this
 * process and everything that dies with it. All it can do is expire a still
 * `pending` record into `boot-failed` (see `deploy-verify.ts`); the healthy
 * verdict belongs to the restarted server alone.
 */
export function spawnDeployVerifier(logFile: string): () => void {
  return () => {
    try {
      const script = fileURLToPath(new URL('./deploy-verify.ts', import.meta.url));
      // No shell, fixed argv — same rule as the restart below.
      const child = spawn(process.execPath, [script, logFile], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (err) {
      // Losing the watchdog does not lose the verdict: a `pending` past its
      // deadline reads as failed at read time (`Deployer.last`). It only
      // loses the durable write.
      console.error('[deploy] could not spawn the boot verifier:', err);
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
 * A reader for what the SERVED client was built from, or null when this
 * deployment does not publish one.
 *
 * The root is only ever the one this server was EXPLICITLY given. Reaching
 * for the machine default would make dev and staging read PROD's releases and
 * report prod's deploy state as their own — the same seam `bin.ts` keeps for
 * `--client-release-root`, and here it would decide whether to restart.
 */
export function servedRefReader(
  clientReleaseRoot: string | null | undefined,
): (() => string | null) | null {
  const root = clientReleaseRoot?.trim();
  if (!root) return null;
  // Uncached on purpose: the question is what this machine is serving now,
  // and a deploy is rare enough that two small file reads are free.
  return () => clientReleaseStatus(root).sourceRef;
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
  /** Where this deployment publishes client releases, when it publishes any.
   *  Only what `bin.ts` was explicitly given — see `servedRefReader`. */
  clientReleaseRoot?: string | null;
  restart?: () => void;
}): Deployer {
  const git = spawnGit(opts.repoRoot);
  const logFile = deployLogPath(opts.dataDir);
  const realRestart = opts.restart ?? launchctlRestart();
  // The watchdog rides the restart: they are scheduled together because the
  // restart is the event whose outcome needs watching, and the process
  // requesting it will not survive to ask.
  const verify = spawnDeployVerifier(logFile);
  const restart = () => {
    verify();
    realRestart();
  };
  const readServed = servedRefReader(opts.clientReleaseRoot);
  return new Deployer({
    run: (req) =>
      runDeploy(
        {
          git,
          readSource: () => readDeploySource(opts.repoRoot, git),
          busyDocs: opts.busyDocs,
          ...(readServed ? { readServed } : {}),
          install: spawnBunInstall(opts.repoRoot),
          wait: (ms) => new Promise((r) => setTimeout(r, ms)),
          restart,
          now: Date.now,
        },
        req,
      ),
    persist: (r) => writeDeployLog(logFile, r),
    loadLast: () => readDeployLog(logFile),
  });
}
