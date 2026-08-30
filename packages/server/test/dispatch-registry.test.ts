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
  it.skipIf(process.platform !== 'darwin')(
    'the real fs.watch factory sees a file landing in the worktree',
    async () => {
      const dataDir = tempDir();
      const worktree = tempDir();
      mkdirSync(join(worktree, 'src'));
      const reg = new DispatchRegistry({ dataDir });
      try {
        reg.register('t-alpha', worktree);
        writeFileSync(join(worktree, 'src', 'index.ts'), 'export {};\n');
        // FSEvents is a shared system service with no latency guarantee, and
        // its delivery degrades with the number of live watchers and the
        // amount of churn on the machine — under the full suite that is
        // thousands of temp files across 252 files. The old 3s bound was
        // tight enough that adding four tests to an unrelated file tipped it
        // twice in a row, while this test passed 10/10 in isolation on the
        // same commit. What is asserted here is that the real factory
        // DELIVERS the event, never that it delivers inside a particular
        // window, so the bound is generous and the failure says how long it
        // actually waited — a factory that has stopped seeing files still
        // fails, which is the regression this guards.
        const startedAt = Date.now();
        const deadline = startedAt + 20_000;
        while (reg.activityFor('t-alpha') === undefined && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(
          reg.activityFor('t-alpha'),
          `no watch event after ${Date.now() - startedAt}ms`,
        ).toBeGreaterThan(0);
      } finally {
        reg.stop();
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(worktree, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
