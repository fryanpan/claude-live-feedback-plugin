import { describe, expect, it } from 'vitest';
import {
  type MigrationIo,
  type MigrationProbe,
  type Step,
  applyMigration,
  planMigration,
} from './migrate-rename.ts';

/**
 * An in-memory stand-in for the machine.
 *
 * The point of building one rather than using temp dirs: the plan reads
 * `~/.local/state`, `~/.claude`, `~/Library/LaunchAgents` and `~/.cloudflared`
 * by absolute path, and a fixture that touched any of those for real would be
 * migrating THIS machine from a test run. Same seam the deployer and the
 * plugin refresher use — the real io is constructed once, in the CLI block.
 */
function fakeMachine(present: string[], loaded: string[] = []) {
  const paths = new Set(present);
  const jobs = new Set(loaded);
  const moves: Array<[string, string]> = [];
  const booted: string[] = [];
  let reinstalls = 0;

  const probe: MigrationProbe = {
    exists: (p) => paths.has(p),
    launchdLoaded: (label) => jobs.has(label),
  };
  const io: MigrationIo = {
    rename(from, to) {
      if (!paths.has(from)) throw new Error(`rename of a path that is not there: ${from}`);
      if (paths.has(to)) throw new Error(`rename onto an existing path: ${to}`);
      paths.delete(from);
      paths.add(to);
      moves.push([from, to]);
    },
    bootout(label) {
      jobs.delete(label);
      booted.push(label);
    },
    reinstallLaunchd() {
      // What install.sh actually does: write the new plist and bootstrap it.
      // Simulating both is what makes the idempotency assertion mean anything
      // — a no-op fake would leave the machine looking un-installed forever,
      // and the second plan would ask to install again for the wrong reason.
      reinstalls += 1;
      paths.add(NEW_PLIST);
      jobs.add(NEW_LABEL);
    },
    log() {},
  };
  return {
    probe,
    io,
    moves,
    booted,
    reinstalls: () => reinstalls,
    has: (p: string) => paths.has(p),
  };
}

const HOME = '/Users/tester';
const OLD_STATE = `${HOME}/.local/state/live-feedback`;
const NEW_STATE = `${HOME}/.local/state/claude-workspaces`;
const OLD_DISCOVERY = `${HOME}/.claude/live-feedback`;
const NEW_DISCOVERY = `${HOME}/.claude/claude-workspaces`;
const OLD_PLIST = `${HOME}/Library/LaunchAgents/com.fryanpan.live-feedback.plist`;
const NEW_PLIST = `${HOME}/Library/LaunchAgents/com.fryanpan.claude-workspaces.plist`;
const OLD_TUNNEL = `${HOME}/.cloudflared/live-feedback.yml`;
const NEW_TUNNEL = `${HOME}/.cloudflared/claude-workspaces.yml`;

const OLD_LABEL = 'com.fryanpan.live-feedback';
const NEW_LABEL = 'com.fryanpan.claude-workspaces';

/** A machine that has never been migrated: everything under the old names. */
function unmigrated() {
  return fakeMachine([OLD_STATE, OLD_DISCOVERY, OLD_PLIST, OLD_TUNNEL], [OLD_LABEL]);
}

function idsOf(steps: readonly Step[]): string[] {
  return steps.map((s) => s.id);
}

function byId(steps: readonly Step[], id: string): Step {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id} in [${idsOf(steps).join(', ')}]`);
  return s;
}

describe('planMigration — what it decides to do', () => {
  it('moves every old machine path to its new name', () => {
    const m = unmigrated();
    const steps = planMigration({ home: HOME }, m.probe);

    expect(byId(steps, 'state-root')).toMatchObject({
      action: 'move',
      from: OLD_STATE,
      to: NEW_STATE,
    });
    expect(byId(steps, 'discovery-dir')).toMatchObject({
      action: 'move',
      from: OLD_DISCOVERY,
      to: NEW_DISCOVERY,
    });
    expect(byId(steps, 'cloudflared-config')).toMatchObject({
      action: 'move',
      from: OLD_TUNNEL,
      to: NEW_TUNNEL,
    });
  });

  it('honours XDG_STATE_HOME, the same way clientReleaseRoot does', () => {
    const m = fakeMachine(['/var/state/live-feedback']);
    const steps = planMigration({ home: HOME, xdgStateHome: '/var/state' }, m.probe);
    expect(byId(steps, 'state-root')).toMatchObject({
      action: 'move',
      from: '/var/state/live-feedback',
      to: '/var/state/claude-workspaces',
    });
  });

  /**
   * The running server holds the state root and republishes the discovery
   * file, so moving either out from under it produces a live server pointing
   * at paths that no longer resolve. Stop first, move, then install the new
   * job — and the ORDER is the correctness property, not a tidiness one.
   */
  it('stops the old job first and installs the new one last', () => {
    const steps = planMigration({ home: HOME }, unmigrated().probe);
    const ids = idsOf(steps);
    expect(ids[0]).toBe('launchd-stop');
    expect(ids[ids.length - 1]).toBe('launchd-install');
    for (const moved of ['state-root', 'discovery-dir', 'cloudflared-config']) {
      expect(ids.indexOf(moved)).toBeGreaterThan(ids.indexOf('launchd-stop'));
      expect(ids.indexOf(moved)).toBeLessThan(ids.indexOf('launchd-install'));
    }
  });

  it('archives the old plist rather than leaving two jobs installed', () => {
    const steps = planMigration({ home: HOME }, unmigrated().probe);
    const plist = byId(steps, 'launchd-plist');
    expect(plist.action).toBe('move');
    if (plist.kind !== 'move') throw new Error('expected a move step');
    expect(plist.from).toBe(OLD_PLIST);
    // Archived under a name launchd will not load, NOT deleted.
    expect(plist.to.startsWith(OLD_PLIST)).toBe(true);
    expect(plist.to.endsWith('.plist')).toBe(false);
  });
});

describe('planMigration — re-running it', () => {
  it('calls an already-moved path already-migrated, not a move', () => {
    const m = fakeMachine([NEW_STATE, NEW_DISCOVERY]);
    const steps = planMigration({ home: HOME }, m.probe);
    expect(byId(steps, 'state-root').action).toBe('already-migrated');
    expect(byId(steps, 'discovery-dir').action).toBe('already-migrated');
  });

  it('calls a path that exists under neither name absent', () => {
    const steps = planMigration({ home: HOME }, fakeMachine([]).probe);
    expect(byId(steps, 'cloudflared-config').action).toBe('absent');
    expect(byId(steps, 'state-root').action).toBe('absent');
  });

  /**
   * Both names present is the one case with no safe automatic answer: the old
   * path holds real state and so does the new one, and any resolution destroys
   * or shadows somebody's data. Refuse and name both — the soft-delete rule
   * reaches machine state too.
   */
  it('refuses when both names exist, and says so', () => {
    const m = fakeMachine([OLD_STATE, NEW_STATE]);
    const step = byId(planMigration({ home: HOME }, m.probe), 'state-root');
    expect(step.action).toBe('conflict');
    expect(step.note).toBeDefined();
    expect(step.note).toContain(OLD_STATE);
    expect(step.note).toContain(NEW_STATE);
  });

  it('skips the launchd install once the new job is installed and loaded', () => {
    const m = fakeMachine([NEW_STATE, NEW_DISCOVERY, NEW_PLIST], [NEW_LABEL]);
    const steps = planMigration({ home: HOME }, m.probe);
    expect(byId(steps, 'launchd-stop').action).toBe('already-migrated');
    expect(byId(steps, 'launchd-install').action).toBe('already-migrated');
  });

  it('still installs when the new plist is there but nothing is running it', () => {
    const m = fakeMachine([NEW_PLIST], []);
    expect(byId(planMigration({ home: HOME }, m.probe), 'launchd-install').action).toBe('run');
  });

  it('drops the steps named in skip', () => {
    const steps = planMigration({ home: HOME }, unmigrated().probe, {
      skip: ['cloudflared-config', 'launchd-install'],
    });
    expect(idsOf(steps)).not.toContain('cloudflared-config');
    expect(idsOf(steps)).not.toContain('launchd-install');
    // Positive control: the un-skipped ones survive, so the assertion above
    // is measuring the skip list rather than an empty plan.
    expect(idsOf(steps)).toContain('state-root');
  });
});

describe('applyMigration', () => {
  it('performs exactly the moves the plan named', () => {
    const m = unmigrated();
    applyMigration(planMigration({ home: HOME }, m.probe), m.io);

    expect(m.moves).toContainEqual([OLD_STATE, NEW_STATE]);
    expect(m.moves).toContainEqual([OLD_DISCOVERY, NEW_DISCOVERY]);
    expect(m.moves).toContainEqual([OLD_TUNNEL, NEW_TUNNEL]);
    expect(m.booted).toEqual([OLD_LABEL]);
    expect(m.reinstalls()).toBe(1);
  });

  /**
   * The whole contract in one assertion: plan, apply, then plan again against
   * the machine the first pass produced. The second plan must ask for nothing.
   * The first-pass count is the positive control — without it a planner that
   * returned an empty plan every time would pass this.
   */
  it('is idempotent — a second run over its own result moves nothing', () => {
    const m = unmigrated();
    const first = planMigration({ home: HOME }, m.probe);
    applyMigration(first, m.io);
    // state root, discovery dir, plist archive, cloudflared config.
    expect(m.moves.length).toBe(4);

    const second = planMigration({ home: HOME }, m.probe);
    expect(second.filter((s) => s.action === 'move' || s.action === 'run')).toEqual([]);
    applyMigration(second, m.io);
    expect(m.moves.length).toBe(4);
    expect(m.reinstalls()).toBe(1);
  });

  it('leaves the old path alone on a conflict', () => {
    const m = fakeMachine([OLD_STATE, NEW_STATE]);
    const res = applyMigration(planMigration({ home: HOME }, m.probe), m.io);
    expect(m.moves).toEqual([]);
    expect(m.has(OLD_STATE)).toBe(true);
    expect(m.has(NEW_STATE)).toBe(true);
    expect(res.conflicts.map((s) => s.id)).toContain('state-root');
  });

  it('reports a conflict as unfinished so the exit code can say so', () => {
    const clean = applyMigration(
      planMigration({ home: HOME }, unmigrated().probe),
      unmigrated().io,
    );
    expect(clean.conflicts).toEqual([]);

    const m = fakeMachine([OLD_DISCOVERY, NEW_DISCOVERY]);
    expect(applyMigration(planMigration({ home: HOME }, m.probe), m.io).conflicts.length).toBe(1);
  });
});
