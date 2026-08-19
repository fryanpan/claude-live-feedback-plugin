#!/usr/bin/env bun
/**
 * Move this machine's live-feedback state onto the claude-workspaces names.
 *
 * WHAT THIS IS FOR. The rename changed the plugin's identity, and a name that
 * identifies a live resource on the box does not travel in a git diff: the
 * launchd label, the client-release state root, the discovery file every MCP
 * child reads to find the server, the cloudflared config. Renaming those in
 * code without moving them on disk produces a server that starts, answers, and
 * publishes a release nobody is reading — the failure this repo already has an
 * entry for under "A restart deploys the deploy SOURCE".
 *
 * WHY IT IS A SCRIPT AND NOT A FALLBACK CHAIN. The rollout is a coordinated
 * flag day: this runs once on the box, and every agent session is respawned
 * afterwards. Long-lived dual reads are kept only where they cost nothing (the
 * discovery path, the keychain service, the env names) — they exist to keep a
 * straggler working, not to make the migration optional.
 *
 * SAFETY. Every step is a rename or a no-op. Nothing here deletes anything,
 * including the old launchd plist, which is archived rather than removed —
 * the project rule ("never hard delete, soft delete") is about user content
 * and history, and machine state a person cannot rebuild is squarely inside
 * it. Where both the old and the new name exist, the step REFUSES: there is no
 * automatic resolution that does not shadow or destroy one of the two.
 *
 * The real filesystem and `launchctl` are reachable only from the CLI block at
 * the bottom. Everything above it takes its io as a parameter, so no test run
 * and no accidental import can migrate the machine it is running on.
 *
 *   bun scripts/migrate-rename.ts            # dry run: prints the plan
 *   bun scripts/migrate-rename.ts --apply    # performs it
 */

import { execFileSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_SLUG, PRODUCT_SLUG_LEGACY } from '../packages/core/src/machine-paths.ts';

// Imported rather than spelled again: the discovery dir, the state root and
// the cloudflared config are all built from this one slug, and a script that
// moves them while holding its own copy of the name is how a later rename
// half-lands.
export const OLD_SLUG = PRODUCT_SLUG_LEGACY;
export const NEW_SLUG = PRODUCT_SLUG;
export const OLD_LAUNCHD_LABEL = 'com.fryanpan.live-feedback';
export const NEW_LAUNCHD_LABEL = 'com.fryanpan.claude-workspaces';

/**
 * Suffix for the archived plist. It must not end in `.plist`: launchd loads
 * `~/Library/LaunchAgents/*.plist` and two plists claiming the same program
 * is a worse outcome than the rename this script exists to perform.
 */
const PLIST_ARCHIVE_SUFFIX = '.pre-claude-workspaces-rename.bak';

export type StepId =
  | 'launchd-stop'
  | 'state-root'
  | 'discovery-dir'
  | 'launchd-plist'
  | 'cloudflared-config'
  | 'launchd-install';

export type MoveAction = 'move' | 'already-migrated' | 'absent' | 'conflict';
export type JobAction = 'run' | 'already-migrated' | 'absent';

export interface MoveStep {
  kind: 'move';
  id: StepId;
  what: string;
  from: string;
  to: string;
  action: MoveAction;
  note?: string;
}

export interface JobStep {
  kind: 'job';
  id: StepId;
  what: string;
  action: JobAction;
  label?: string;
  note?: string;
}

export type Step = MoveStep | JobStep;

/** Reads the machine. Nothing here writes, so it is safe to call anywhere. */
export interface MigrationProbe {
  exists(path: string): boolean;
  launchdLoaded(label: string): boolean;
}

/** Writes the machine. Injected so only the CLI block can supply a real one. */
export interface MigrationIo {
  rename(from: string, to: string): void;
  bootout(label: string): void;
  reinstallLaunchd(): void;
  log(line: string): void;
}

export interface MigrationPaths {
  home: string;
  /** `$XDG_STATE_HOME`, matching what `clientReleaseRoot` honours. */
  xdgStateHome?: string;
}

export interface PlanOptions {
  skip?: readonly StepId[];
}

function stateDir(paths: MigrationPaths): string {
  const xdg = paths.xdgStateHome?.trim();
  return xdg ? xdg : join(paths.home, '.local', 'state');
}

/**
 * Classify one rename. The four cells are the whole idempotency story, and the
 * only one with any judgement in it is both-present — where refusing is the
 * answer, because merging two state roots is not something a script can decide.
 */
function moveStep(
  id: StepId,
  what: string,
  from: string,
  to: string,
  probe: MigrationProbe,
): MoveStep {
  const hasOld = probe.exists(from);
  const hasNew = probe.exists(to);
  if (hasOld && hasNew) {
    return {
      kind: 'move',
      id,
      what,
      from,
      to,
      action: 'conflict',
      note:
        `both ${from} and ${to} exist — refusing to move, since either ` +
        'outcome shadows or destroys one of them. Merge or move one aside by hand.',
    };
  }
  if (hasOld) return { kind: 'move', id, what, from, to, action: 'move' };
  if (hasNew) {
    return { kind: 'move', id, what, from, to, action: 'already-migrated' };
  }
  return {
    kind: 'move',
    id,
    what,
    from,
    to,
    action: 'absent',
    note: `neither ${from} nor ${to} exists; nothing to do`,
  };
}

/**
 * Build the ordered plan.
 *
 * ORDER IS A CORRECTNESS PROPERTY, not presentation. The running server holds
 * the state root open and rewrites the discovery file on a timer, so moving
 * either underneath it leaves a live process writing to paths that no longer
 * resolve — and the discovery file it republishes would point the whole fleet
 * back at the old name. Stop the job, move everything, install the new job.
 */
export function planMigration(
  paths: MigrationPaths,
  probe: MigrationProbe,
  opts: PlanOptions = {},
): Step[] {
  const home = paths.home;
  const state = stateDir(paths);
  const launchAgents = join(home, 'Library', 'LaunchAgents');
  const oldPlist = join(launchAgents, `${OLD_LAUNCHD_LABEL}.plist`);

  const steps: Step[] = [
    {
      kind: 'job',
      id: 'launchd-stop',
      what: 'stop the old launchd job so nothing writes the paths being moved',
      label: OLD_LAUNCHD_LABEL,
      action: probe.launchdLoaded(OLD_LAUNCHD_LABEL)
        ? 'run'
        : probe.launchdLoaded(NEW_LAUNCHD_LABEL)
          ? 'already-migrated'
          : 'absent',
    },
    moveStep(
      'state-root',
      'client releases and server state',
      join(state, OLD_SLUG),
      join(state, NEW_SLUG),
      probe,
    ),
    moveStep(
      'discovery-dir',
      'server.json, which is how every MCP child finds the port',
      join(home, '.claude', OLD_SLUG),
      join(home, '.claude', NEW_SLUG),
      probe,
    ),
    moveStep(
      'launchd-plist',
      'archive the old plist (kept, not deleted)',
      oldPlist,
      `${oldPlist}${PLIST_ARCHIVE_SUFFIX}`,
      probe,
    ),
    moveStep(
      'cloudflared-config',
      'cloudflared tunnel config',
      join(home, '.cloudflared', `${OLD_SLUG}.yml`),
      join(home, '.cloudflared', `${NEW_SLUG}.yml`),
      probe,
    ),
    {
      kind: 'job',
      id: 'launchd-install',
      what: 'install and start the job under the new label',
      label: NEW_LAUNCHD_LABEL,
      // Installed AND running is the only state that needs nothing. A plist
      // sitting there unloaded is a half-finished previous attempt, and
      // install.sh is itself idempotent, so re-running it is the repair.
      action:
        probe.exists(join(launchAgents, `${NEW_LAUNCHD_LABEL}.plist`)) &&
        probe.launchdLoaded(NEW_LAUNCHD_LABEL)
          ? 'already-migrated'
          : 'run',
    },
  ];

  const skip = new Set(opts.skip ?? []);
  return steps.filter((s) => !skip.has(s.id));
}

export interface MigrationResult {
  applied: Step[];
  skipped: Step[];
  conflicts: MoveStep[];
}

/** Execute a plan. Anything not `move`/`run` is reported and left alone. */
export function applyMigration(steps: readonly Step[], io: MigrationIo): MigrationResult {
  const applied: Step[] = [];
  const skipped: Step[] = [];
  const conflicts: MoveStep[] = [];

  for (const step of steps) {
    if (step.kind === 'move') {
      if (step.action === 'move') {
        io.log(`  moving ${step.from} -> ${step.to}`);
        io.rename(step.from, step.to);
        applied.push(step);
        continue;
      }
      if (step.action === 'conflict') {
        io.log(`  CONFLICT ${step.id}: ${step.note}`);
        conflicts.push(step);
        skipped.push(step);
        continue;
      }
      io.log(`  ${step.action} ${step.id}`);
      skipped.push(step);
      continue;
    }

    if (step.action === 'run') {
      if (step.id === 'launchd-stop') {
        io.log(`  stopping ${step.label}`);
        io.bootout(step.label ?? OLD_LAUNCHD_LABEL);
      } else {
        io.log('  installing the launchd job under the new label');
        io.reinstallLaunchd();
      }
      applied.push(step);
      continue;
    }
    io.log(`  ${step.action} ${step.id}`);
    skipped.push(step);
  }

  return { applied, skipped, conflicts };
}

export function describePlan(steps: readonly Step[]): string {
  const lines: string[] = [];
  for (const s of steps) {
    const detail = s.kind === 'move' ? `${s.from} -> ${s.to}` : (s.label ?? '');
    lines.push(`  [${s.action}] ${s.id} — ${s.what}`);
    if (detail) lines.push(`      ${detail}`);
    if (s.note) lines.push(`      note: ${s.note}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI. The only place a real filesystem or a real launchctl is constructed.
// ---------------------------------------------------------------------------

function realProbe(): MigrationProbe {
  return {
    exists: (p) => existsSync(p),
    launchdLoaded: (label) => {
      try {
        execFileSync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`], {
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function realIo(repoRoot: string): MigrationIo {
  return {
    rename: (from, to) => renameSync(from, to),
    bootout: (label) => {
      try {
        execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${label}`], {
          stdio: 'inherit',
        });
      } catch {
        // bootout exits non-zero when the job is already gone, which is the
        // state we were asking for. Anything else surfaces at the next step.
      }
    },
    reinstallLaunchd: () => {
      execFileSync(join(repoRoot, 'scripts', 'launchd', 'install.sh'), [], { stdio: 'inherit' });
    },
    log: (line) => console.log(line),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const skip = argv
    .filter((a) => a.startsWith('--skip='))
    .flatMap((a) => a.slice('--skip='.length).split(',')) as StepId[];

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const paths: MigrationPaths = {
    home: homedir(),
    xdgStateHome: process.env.XDG_STATE_HOME,
  };

  const plan = planMigration(paths, realProbe(), { skip });
  console.log(`${OLD_SLUG} -> ${NEW_SLUG} migration plan:\n${describePlan(plan)}\n`);

  if (!apply) {
    console.log('Dry run. Re-run with --apply to perform it.');
    process.exit(0);
  }

  const result = applyMigration(plan, realIo(repoRoot));
  console.log(`\napplied ${result.applied.length}, skipped ${result.skipped.length}`);
  if (result.conflicts.length > 0) {
    console.error(
      `\n${result.conflicts.length} step(s) refused because both names exist. ` +
        'Nothing was destroyed; resolve them by hand and re-run.',
    );
    process.exit(1);
  }
}
