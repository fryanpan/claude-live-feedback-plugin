import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@feedback/core';
import { DocStore } from '../src/doc-store.ts';
import { SseBus } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import { pastExternalRead, waitFor, waitForFile } from './wait-for.ts';

/**
 * Doc origin repos through the real binding machinery: a pinned doc's file is "the
 * declared relPath in whichever worktree has the declared branch checked
 * out", re-verified before every flush and every disk→doc apply. The
 * incident being pinned down: a checkout switching branches under a bound
 * path, which used to receive the doc's flushes (write half) and feed the
 * other branch's file content back into the live doc (read half).
 *
 * All fixtures are synthetic — invented repos, generic content. This suite
 * builds real git worktrees because the resolvers read git's plumbing.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

function makeDocStore(dataDir: string): DocStore {
  return new DocStore({
    dataDir,
    sse: new SseBus(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the file at `path` contains `needle`. */
const waitForFileText = (path: string, needle: string, timeout = 8000): Promise<string> =>
  waitForFile(path, (t) => t.includes(needle), { timeout });

/** Replace the doc's prose with `md`, as an agent edit would. */
function setProse(docStore: DocStore, docId: string, md: string): void {
  const room = docStore.get(docId);
  if (!room) throw new Error(`no room ${docId}`);
  const fragment = prose.getProseFragment(room.ydoc);
  room.ydoc.transact(() => {
    fragment.delete(0, fragment.length);
    fragment.push(prose.parseMarkdownBlocks(md));
  }, 'agent');
}

function docText(docStore: DocStore, docId: string): string {
  const room = docStore.get(docId);
  if (!room) throw new Error(`no room ${docId}`);
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
}

let mtimeBump = 0;
function writeExternal(path: string, content: string): void {
  writeFileSync(path, content);
  mtimeBump += 2;
  const t = new Date(Date.now() + mtimeBump * 1000);
  utimesSync(path, t, t);
}

const REL = 'docs/plans/triage.md';

describe('doc origin repos through the binding', () => {
  let tmp: string;
  let dataDir: string;
  let main: string;
  let wt: string;
  let docStore: DocStore;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cw-homebind-')));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir);
    main = join(tmp, 'repo');
    mkdirSync(main);
    git(main, 'init', '-b', 'main');
    writeFileSync(join(main, 'README.md'), '# repo\n');
    git(main, 'add', '.');
    git(main, 'commit', '-m', 'init');
    wt = join(tmp, 'wt-plans');
    git(main, 'worktree', 'add', wt, '-b', 'plans');
    docStore = makeDocStore(dataDir);
    docStore.getOrCreate('d1', { type: 'markdown' });
    setProse(docStore, 'd1', '# Triage\n\nfirst pass\n');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pinning exports the doc into the branch worktree and flushes land there', async () => {
    const res = docStore.setDocOriginRepo('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    if (!res.ok) throw new Error(JSON.stringify(res));
    expect(res.placement).toEqual({ placed: true, path: join(wt, REL) });
    expect(readFileSync(join(wt, REL), 'utf8')).toContain('first pass');

    setProse(docStore, 'd1', '# Triage\n\nsecond pass\n');
    await waitForFileText(join(wt, REL), 'second pass');
    // Nothing landed in the OTHER checkout of the repo.
    expect(existsSync(join(main, REL))).toBe(false);
  });

  it('refuses homes that are not homes', () => {
    expect(
      docStore.setDocOriginRepo('d1', {
        repoRoot: join(tmp, 'nope'),
        branch: 'x',
        relPath: 'a.md',
      }),
    ).toMatchObject({ ok: false, error: 'invalid-home' });
    expect(
      docStore.setDocOriginRepo('d1', { repoRoot: main, branch: 'main', relPath: '../escape.md' }),
    ).toMatchObject({ ok: false, error: 'invalid-home' });
    expect(
      docStore.setDocOriginRepo('ghost', { repoRoot: main, branch: 'main', relPath: 'a.md' }),
    ).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('a checkout that switches branches is never written again; the flush follows the branch', async () => {
    docStore.setDocOriginRepo('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    // Drain the export's own write-back instead of outwaiting it: flush() is
    // the shutdown path, so the file is on disk before git looks at it.
    docStore.flush();
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    // The worktree moves OFF the home branch (someone reuses it for feature
    // work), and the branch gets checked out elsewhere.
    git(wt, 'checkout', '-b', 'feature-detour');
    const wt2 = join(tmp, 'wt-plans-2');
    git(main, 'worktree', 'add', wt2, 'plans');

    const before = readFileSync(join(wt, REL), 'utf8');
    setProse(docStore, 'd1', '# Triage\n\nthird pass\n');
    // Two debounce rounds have to happen on their own timers: the first flush
    // attempt retargets the binding, the flush it re-arms carries the edit
    // out. Wait for the edit to arrive at the new worktree, not for a clock.
    await waitForFileText(join(wt2, REL), 'third pass');

    // The old checkout — now on somebody's feature branch — is untouched.
    expect(readFileSync(join(wt, REL), 'utf8')).toBe(before);
    expect(docStore.docOriginRepoStatus('d1')?.boundPath).toBe(join(wt2, REL));
  });

  it('no checkout on the branch parks writes, says why, and resumes when one appears', async () => {
    docStore.setDocOriginRepo('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    // Drain the export's own write-back instead of outwaiting it: flush() is
    // the shutdown path, so the file is on disk before git looks at it.
    docStore.flush();
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    git(wt, 'checkout', '--detach');

    const before = readFileSync(join(wt, REL), 'utf8');
    setProse(docStore, 'd1', '# Triage\n\nparked pass\n');
    // The park announces itself — wait for the reason, then check that the
    // detoured checkout really was left alone. Through `getSyncError`, the
    // published verb for exactly this question: the binding map itself now
    // lives in `file-binding.ts` and is nobody's field to reach into.
    await waitFor(() => (docStore.getSyncError('d1')?.message ?? '').includes('unplaced'), {
      describe: 'the write-back to park itself as unplaced',
    });
    expect(readFileSync(join(wt, REL), 'utf8')).toBe(before);
    // The live doc kept the edit and the park is named.
    expect(docText(docStore, 'd1')).toContain('parked pass');
    expect(docStore.docOriginRepoStatus('d1')?.placement).toEqual({
      placed: false,
      reason: 'no-checkout-on-branch',
    });

    // The branch comes back — the next flush lands home.
    git(wt, 'checkout', 'plans');
    setProse(docStore, 'd1', '# Triage\n\nresumed pass\n');
    await waitForFileText(join(wt, REL), 'resumed pass');
  });

  it('a branch switch rewriting the bound file must not leak foreign content into the live doc', async () => {
    docStore.setDocOriginRepo('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    // Drain the export's own write-back instead of outwaiting it: flush() is
    // the shutdown path, so the file is on disk before git looks at it.
    docStore.flush();
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    // The checkout switches branches AND the file at the old path changes
    // (what a real `git checkout` does to tracked files).
    git(wt, 'checkout', '-b', 'feature-detour');
    writeExternal(join(wt, REL), '# Somebody else\n\nfeature-branch copy\n');
    // timed: the assertion is that the poll (500ms) plus read debounce never
    // pulls those bytes in, so the whole read window has to elapse first.
    await sleep(pastExternalRead());
    expect(docText(docStore, 'd1')).not.toContain('feature-branch copy');
    expect(docText(docStore, 'd1')).toContain('first pass');
  });

  it('a direct write at the home colliding with un-flushed live edits loses to the live copy', async () => {
    docStore.setDocOriginRepo('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    // Settle the export's write-back so the edit below is the only un-flushed
    // one when the external write collides with it.
    docStore.flush();
    // Un-flushed live edit + immediate external write to the same file.
    setProse(docStore, 'd1', '# Triage\n\nlive edit wins\n');
    writeExternal(join(wt, REL), '# Clobber\n\ndirect write\n');
    await waitForFileText(join(wt, REL), 'live edit wins');
    expect(docText(docStore, 'd1')).toContain('live edit wins');
    expect(docText(docStore, 'd1')).not.toContain('direct write');
  });

  /**
   * Commit the pinned doc on its branch, take the server "down", remove the
   * branch's only checkout, and bring a fresh DocStore up: hydration parks the
   * doc (no checkout on the branch, so no binding at all). Returns the
   * parked instance and the path a re-checkout will get.
   */
  async function parkAtHydrate(): Promise<{ docStore2: DocStore; wt2: string }> {
    docStore.setDocOriginRepo('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    // Drain the export's own write-back instead of outwaiting it: flush() is
    // the shutdown path, so the file is on disk before git looks at it.
    docStore.flush();
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    await docStore.flush();

    // While "down": the branch loses its only checkout entirely.
    git(main, 'worktree', 'remove', '--force', wt);

    const docStore2 = makeDocStore(dataDir);
    expect(docText(docStore2, 'd1')).toContain('first pass');
    expect(docStore2.docOriginRepoStatus('d1')?.placement).toEqual({
      placed: false,
      reason: 'no-checkout-on-branch',
    });
    return { docStore2, wt2: join(tmp, 'wt-plans-back') };
  }

  it('a doc parked AT HYDRATE resumes on the next edit once the branch has a checkout', async () => {
    const { docStore2, wt2 } = await parkAtHydrate();

    // The branch gets a checkout again; the next EDIT must re-place the
    // home — the recovery originRepoGuard provides for live parks hangs off a
    // binding this doc doesn't have.
    git(main, 'worktree', 'add', wt2, 'plans');
    setProse(docStore2, 'd1', '# Triage\n\nback from the dead\n');
    // The rebind runs inside the edit's update hook. If it let the
    // checkout's stale copy win, the doc is already reverted HERE — assert
    // it now so a failure names the revert, not a write that never came.
    expect(docText(docStore2, 'd1')).toContain('back from the dead');
    expect(docStore2.docOriginRepoStatus('d1')?.boundPath).toBe(join(wt2, REL));
    await waitForFileText(join(wt2, REL), 'back from the dead');
    expect(readFileSync(join(wt2, REL), 'utf8')).toContain('back from the dead');
    await docStore2.flush();
  }, 15_000);

  it('the edit that resumes a hydrate-parked doc wins over the checkout copy even when the clock ties', async () => {
    // The 2026-09-01 CI flake: the rebind persisted the .ydoc and then let
    // attach arbitrate by mtime. A fresh `git worktree add` and that
    // persist land ~3ms apart, inside one Linux file-timestamp tick, and a
    // tie went to disk — the checkout's committed copy replaced the edit
    // that had just resumed syncing. Stamping the checkout's copy AHEAD
    // reproduces the tie deterministically on every platform.
    const { docStore2, wt2 } = await parkAtHydrate();
    git(main, 'worktree', 'add', wt2, 'plans');
    const ahead = new Date(Date.now() + 60_000);
    utimesSync(join(wt2, REL), ahead, ahead);

    setProse(docStore2, 'd1', '# Triage\n\nback from the dead\n');
    expect(docText(docStore2, 'd1')).toContain('back from the dead');
    expect(docText(docStore2, 'd1')).not.toContain('first pass');
    expect(docStore2.docOriginRepoStatus('d1')?.boundPath).toBe(join(wt2, REL));
    await waitForFileText(join(wt2, REL), 'back from the dead');
    // The losing side is backed up, never silently discarded.
    const backups = readdirSync(join(dataDir, 'clobber-backups')).map((f) =>
      readFileSync(join(dataDir, 'clobber-backups', f), 'utf8'),
    );
    expect(backups.some((b) => b.includes('first pass'))).toBe(true);
    await docStore2.flush();
  }, 15_000);

  it('a forced reparse must not pull a switched checkout’s branch copy into the doc', async () => {
    docStore.setDocOriginRepo('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    // Drain the export's own write-back instead of outwaiting it: flush() is
    // the shutdown path, so the file is on disk before git looks at it.
    docStore.flush();
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    // The checkout moves off the home branch and its copy of the file now
    // belongs to somebody else's feature work; the home branch has no
    // checkout anywhere.
    git(wt, 'checkout', '-b', 'feature-detour');
    writeExternal(join(wt, REL), '# Somebody else\n\nfeature-branch copy\n');

    const res = docStore.reparseFromDisk('d1');
    expect(res.ok).toBe(false);
    expect(docText(docStore, 'd1')).toContain('first pass');
    expect(docText(docStore, 'd1')).not.toContain('feature-branch copy');

    // With the branch checked out again, reparse recovers instead of
    // parking — it follows the home, not the stale path.
    const wt2 = join(tmp, 'wt-plans-again');
    git(main, 'worktree', 'add', wt2, 'plans');
    expect(docStore.reparseFromDisk('d1').ok).toBe(true);
    expect(docStore.docOriginRepoStatus('d1')?.boundPath).toBe(join(wt2, REL));
    expect(docText(docStore, 'd1')).toContain('first pass');
  });

  it('a home declared from a linked worktree survives that worktree’s removal', async () => {
    // Declared via the LINKED checkout's path — the stored root must be the
    // repo's durable identity, not the spelling the caller happened to use.
    const res = docStore.setDocOriginRepo('d1', { repoRoot: wt, branch: 'plans', relPath: REL });
    if (!res.ok) throw new Error(JSON.stringify(res));
    expect(docStore.docOriginRepoStatus('d1')?.home.repoRoot).toBe(main);
    docStore.flush();
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');

    // The declaring worktree dies; the branch moves to a fresh one.
    git(main, 'worktree', 'remove', '--force', wt);
    const wt2 = join(tmp, 'wt-plans-relocated');
    git(main, 'worktree', 'add', wt2, 'plans');

    setProse(docStore, 'd1', '# Triage\n\noutlived the checkout\n');
    await waitForFileText(join(wt2, REL), 'outlived the checkout');
    expect(docStore.docOriginRepoStatus('d1')?.placement).toEqual({
      placed: true,
      path: join(wt2, REL),
    });
  });

  it('a restart re-resolves the home, including a worktree that moved while the server was down', async () => {
    docStore.setDocOriginRepo('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    // Drain the export's own write-back instead of outwaiting it: flush() is
    // the shutdown path, so the file is on disk before git looks at it.
    docStore.flush();
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    await docStore.flush();

    // While "down": the plans worktree is torn down and recreated elsewhere.
    git(main, 'worktree', 'remove', '--force', wt);
    const wt2 = join(tmp, 'wt-plans-next');
    git(main, 'worktree', 'add', wt2, 'plans');

    const docStore2 = makeDocStore(dataDir);
    expect(docText(docStore2, 'd1')).toContain('first pass');
    setProse(docStore2, 'd1', '# Triage\n\nafter restart\n');
    await waitForFileText(join(wt2, REL), 'after restart');
    await docStore2.flush();
  });
});
