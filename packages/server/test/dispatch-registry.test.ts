/**
 * The dispatch registry against a fake watcher, plus one real-fs.watch smoke
 * test gated to darwin.
 *
 * The fake is the deterministic seam: CI runs Bun on Linux, where a recursive
 * directory watch has measurably dropped events (see rooms.ts,
 * "deliberately do NOT use fs.watch"), so a test that waits for a real event
 * would fail on exactly the platform where the design says the right outcome
 * is silent degradation. The rules under test — registration, replacement,
 * close, prune-on-read, persistence, degrade-to-no-signal — do not depend on
 * which factory fires the callback.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DispatchRegistry, type WatchFactory } from '../src/dispatch-registry.ts';
import { fdContentionError, otherTestRunnerCount } from './fd-contention.ts';

const tempDir = () => mkdtempSync(join(tmpdir(), 'dispatch-registry-'));

/** A watch factory the test drives by hand. */
function fakeWatch() {
  const handles = new Map<string, { fire: () => void; fail: (err: unknown) => void }>();
  const closed: string[] = [];
  const factory: WatchFactory = (path, onEvent, onError) => {
    handles.set(path, { fire: onEvent, fail: onError });
    return { close: () => closed.push(path) };
  };
  return { factory, handles, closed };
}

describe('dispatch registry', () => {
  it('registers a dispatch and reports watcher-driven activity', () => {
    const dataDir = tempDir();
    const worktree = tempDir();
    const { factory, handles } = fakeWatch();
    let clock = 1_000;
    const reg = new DispatchRegistry({ dataDir, watchFactory: factory, now: () => clock });
    try {
      const res = reg.register('t-alpha', worktree);
      expect(res.ok).toBe(true);
      // No event yet: no signal, not "registered counts as activity".
      expect(reg.activityFor('t-alpha')).toBeUndefined();
      clock = 5_000;
      handles.get(worktree)?.fire();
      expect(reg.activityFor('t-alpha')).toBe(5_000);
    } finally {
      reg.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('carries the agentName through the record and survives a restart', () => {
    const dataDir = tempDir();
    const worktree = tempDir();
    const first = fakeWatch();
    const reg = new DispatchRegistry({ dataDir, watchFactory: first.factory });
    try {
      const res = reg.register('t-alpha', worktree, 'Builder A');
      expect(res.ok && res.dispatch.agentName).toBe('Builder A');
      expect(reg.list()[0]?.agentName).toBe('Builder A');
      reg.stop();

      const second = fakeWatch();
      const revived = new DispatchRegistry({ dataDir, watchFactory: second.factory });
      try {
        expect(revived.list()[0]?.agentName).toBe('Builder A');
      } finally {
        revived.stop();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('an omitted agentName leaves the record without one', () => {
    const dataDir = tempDir();
    const worktree = tempDir();
    const { factory } = fakeWatch();
    const reg = new DispatchRegistry({ dataDir, watchFactory: factory });
    try {
      const res = reg.register('t-alpha', worktree);
      expect(res.ok && res.dispatch.agentName).toBeUndefined();
    } finally {
      reg.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('refuses a relative path, a missing path, and a bad task id', () => {
    const dataDir = tempDir();
    const worktree = tempDir();
    const { factory } = fakeWatch();
    const reg = new DispatchRegistry({ dataDir, watchFactory: factory });
    try {
      expect(reg.register('t-a', 'relative/path')).toEqual({
        ok: false,
        error: 'path-not-absolute',
      });
      expect(reg.register('t-a', join(worktree, 'gone'))).toEqual({
        ok: false,
        error: 'no-such-path',
      });
      expect(reg.register('bad id with spaces', worktree)).toEqual({
        ok: false,
        error: 'bad-task-id',
      });
      expect(reg.list()).toEqual([]);
    } finally {
      reg.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('close stops the watcher and forgets the dispatch', () => {
    const dataDir = tempDir();
    const worktree = tempDir();
    const { factory, handles, closed } = fakeWatch();
    const reg = new DispatchRegistry({ dataDir, watchFactory: factory });
    try {
      reg.register('t-alpha', worktree);
      expect(reg.close('t-alpha')).toEqual({ closed: true });
      expect(closed).toEqual([worktree]);
      expect(reg.list()).toEqual([]);
      // A late event from a handle the caller kept must not resurrect it.
      handles.get(worktree)?.fire();
      expect(reg.activityFor('t-alpha')).toBeUndefined();
      expect(reg.close('t-alpha')).toEqual({ closed: false });
    } finally {
      reg.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('re-registering the same task replaces the worktree and its watcher', () => {
    const dataDir = tempDir();
    const oldTree = tempDir();
    const newTree = tempDir();
    const { factory, handles, closed } = fakeWatch();
    let clock = 1_000;
    const reg = new DispatchRegistry({ dataDir, watchFactory: factory, now: () => clock });
    try {
      reg.register('t-alpha', oldTree);
      clock = 2_000;
      handles.get(oldTree)?.fire();
      reg.register('t-alpha', newTree);
      expect(closed).toEqual([oldTree]);
      // Activity from the replaced worktree does not carry over.
      expect(reg.activityFor('t-alpha')).toBeUndefined();
      clock = 3_000;
      handles.get(newTree)?.fire();
      expect(reg.activityFor('t-alpha')).toBe(3_000);
      expect(reg.list().map((d) => d.worktreePath)).toEqual([newTree]);
    } finally {
      reg.stop();
      for (const d of [dataDir, oldTree, newTree]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('a dispatch whose worktree vanished is closed on read', () => {
    const dataDir = tempDir();
    const worktree = tempDir();
    const { factory, handles, closed } = fakeWatch();
    let clock = 1_000;
    const reg = new DispatchRegistry({ dataDir, watchFactory: factory, now: () => clock });
    try {
      reg.register('t-alpha', worktree);
      clock = 2_000;
      handles.get(worktree)?.fire();
      rmSync(worktree, { recursive: true, force: true });
      // The recorded activity must not exonerate a deleted worktree.
      expect(reg.activityFor('t-alpha')).toBeUndefined();
      expect(reg.list()).toEqual([]);
      expect(closed).toEqual([worktree]);
    } finally {
      reg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('a failed watcher degrades to no-signal without dropping the dispatch', () => {
    const dataDir = tempDir();
    const worktree = tempDir();
    const { factory, handles, closed } = fakeWatch();
    const reg = new DispatchRegistry({ dataDir, watchFactory: factory });
    try {
      reg.register('t-alpha', worktree);
      handles.get(worktree)?.fail(new Error('EMFILE'));
      expect(closed).toEqual([worktree]);
      // Still open — the row can stall normally — but reads as unwatched.
      const [d] = reg.list();
      expect(d?.taskId).toBe('t-alpha');
      expect(d?.watching).toBe(false);
      expect(reg.activityFor('t-alpha')).toBeUndefined();
    } finally {
      reg.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('a factory that throws at arm time degrades the same way', () => {
    const dataDir = tempDir();
    const worktree = tempDir();
    const throwing: WatchFactory = () => {
      throw new Error('recursive watch unsupported');
    };
    const reg = new DispatchRegistry({ dataDir, watchFactory: throwing });
    try {
      const res = reg.register('t-alpha', worktree);
      expect(res.ok).toBe(true);
      const [d] = reg.list();
      expect(d?.watching).toBe(false);
      expect(reg.activityFor('t-alpha')).toBeUndefined();
    } finally {
      reg.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('open dispatches survive a restart and re-arm their watchers', () => {
    const dataDir = tempDir();
    const worktree = tempDir();
    const first = fakeWatch();
    let clock = 1_000;
    const reg = new DispatchRegistry({ dataDir, watchFactory: first.factory, now: () => clock });
    reg.register('t-alpha', worktree);
    clock = 2_000;
    first.handles.get(worktree)?.fire();
    reg.stop();

    const second = fakeWatch();
    const revived = new DispatchRegistry({
      dataDir,
      watchFactory: second.factory,
      now: () => clock,
    });
    try {
      const [d] = revived.list();
      expect(d?.taskId).toBe('t-alpha');
      expect(d?.worktreePath).toBe(worktree);
      // In-memory activity died with the process; only new events speak.
      expect(revived.activityFor('t-alpha')).toBeUndefined();
      clock = 9_000;
      second.handles.get(worktree)?.fire();
      expect(revived.activityFor('t-alpha')).toBe(9_000);
    } finally {
      revived.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('a corrupt store file is moved aside, not overwritten', () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, 'dispatches.json'), 'not json {');
    const { factory } = fakeWatch();
    const reg = new DispatchRegistry({ dataDir, watchFactory: factory });
    try {
      expect(reg.loadError).toContain('moved to');
      expect(reg.list()).toEqual([]);
    } finally {
      reg.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // The one test on the real default factory. Gated to darwin: the prod
  // server runs on macOS, while CI's Bun-on-Linux has measurably dropped
  // recursive-watch events — there the design degrades to no-signal, which
  // is exactly what makes an event-arrival assertion unrunnable on Linux.
  //
  // It is NOT replaced by a fake-watcher case, and it is NOT moved behind a
  // CI-only gate. A fake factory replaces the only thing this test exercises
  // — the default `fs.watch(path, {recursive: true})` wiring — so a fake
  // version of it would assert the fake. And "CI only" would mean never:
  // CI is Bun-on-Linux, which this test skips. Either choice deletes the
  // coverage rather than stabilising it.
  //
  // What was actually wrong was the trigger, not the bound. The old shape
  // wrote ONE file and then waited up to 20s for FSEvents to deliver that one
  // event — and FSEvents is a shared system service that drops events under
  // churn, so a single dropped notification meant a 20s stall and a red test
  // on a healthy watcher (it failed exactly this way during a `--coverage`
  // run of the full suite on 2026-09-02, while passing without coverage).
  // Re-touching the file on every poll turns "this one event must survive a
  // starved queue" into "any one of ~40 must", which no longer flakes and
  // still fails hard for the regression it guards: a factory that has stopped
  // watching delivers nothing however many times the file is written.
  it.skipIf(process.platform !== 'darwin')(
    'the real fs.watch factory sees a file landing in the worktree',
    async () => {
      const dataDir = tempDir();
      const worktree = tempDir();
      mkdirSync(join(worktree, 'src'));
      const reg = new DispatchRegistry({ dataDir });
      try {
        const res = reg.register('t-alpha', worktree);
        expect(res.ok).toBe(true);
        if (res.ok && !res.dispatch.watching) {
          // The factory could not even arm. Out of descriptors is suite
          // contention; anything else is a genuinely broken factory.
          const fdErr = fdContentionError();
          throw new Error(
            fdErr
              ? `real fs.watch factory failed to arm — ${fdErr.message}`
              : 'real fs.watch factory failed to arm on a fresh worktree with fd headroom to ' +
                  'spare — the watcher is broken; this is not suite contention',
          );
        }
        // What is asserted is that the real factory DELIVERS, never that it
        // delivers inside a particular window — so every poll writes the file
        // again rather than waiting on the first notification to survive.
        const startedAt = Date.now();
        const deadline = startedAt + 8_000;
        let writes = 0;
        while (reg.activityFor('t-alpha') === undefined && Date.now() < deadline) {
          writeFileSync(join(worktree, 'src', 'index.ts'), `export const n = ${writes++};\n`);
          await new Promise((r) => setTimeout(r, 200));
        }
        const activity = reg.activityFor('t-alpha');
        if (activity === undefined) {
          // Still red on every branch — the factory delivered nothing, and
          // that must never pass. What differs is the diagnosis: parallel
          // worktrees run this suite concurrently by design, and both fd
          // exhaustion and FSEvents starvation from a rival run land here
          // looking exactly like a broken watcher (reproduced 2026-08-31:
          // three concurrent runs, one hit this timeout with zero events).
          const waited = Date.now() - startedAt;
          const seen = `no watch event after ${waited}ms and ${writes} writes`;
          const fdErr = fdContentionError();
          if (fdErr) throw new Error(`${seen} — ${fdErr.message}`);
          const rivals = otherTestRunnerCount();
          if (rivals > 0) {
            throw new Error(
              `${seen}. ${rivals} other test-runner process(es) share this machine, and ` +
                'FSEvents starves under concurrent suite churn — but every one of those ' +
                'writes was a fresh chance to deliver, so starvation would have to have ' +
                'swallowed all of them. Read this as a broken watcher first; re-run ' +
                '`bun test packages/server/test` alone to rule the machine out.',
            );
          }
          throw new Error(
            `${seen}, with no rival test runs and fd headroom to spare — the real ` +
              'factory has stopped seeing files; investigate the watcher, not the machine',
          );
        }
        expect(activity).toBeGreaterThan(0);
      } finally {
        reg.stop();
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
