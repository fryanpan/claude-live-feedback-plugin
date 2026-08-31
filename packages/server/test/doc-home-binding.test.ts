import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@feedback/core';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * Doc homes through the real binding machinery: a pinned doc's file is "the
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

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
    decorateDocMeta: (m) => ({ ...m, reviewUrl: `http://test/review/${m.docId}` }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replace the doc's prose with `md`, as an agent edit would. */
function setProse(rooms: Rooms, docId: string, md: string): void {
  const room = rooms.get(docId);
  if (!room) throw new Error(`no room ${docId}`);
  const fragment = prose.getProseFragment(room.ydoc);
  room.ydoc.transact(() => {
    fragment.delete(0, fragment.length);
    fragment.push(prose.parseMarkdownBlocks(md));
  }, 'agent');
}

function docText(rooms: Rooms, docId: string): string {
  const room = rooms.get(docId);
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

describe('doc homes through the binding', () => {
  let tmp: string;
  let dataDir: string;
  let main: string;
  let wt: string;
  let rooms: Rooms;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lf-homebind-')));
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
    rooms = makeRooms(dataDir);
    rooms.getOrCreate('d1', { type: 'markdown' });
    setProse(rooms, 'd1', '# Triage\n\nfirst pass\n');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('pinning exports the doc into the branch worktree and flushes land there', async () => {
    const res = rooms.setDocHome('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    if (!res.ok) throw new Error(JSON.stringify(res));
    expect(res.placement).toEqual({ placed: true, path: join(wt, REL) });
    expect(readFileSync(join(wt, REL), 'utf8')).toContain('first pass');

    setProse(rooms, 'd1', '# Triage\n\nsecond pass\n');
    await sleep(1100);
    expect(readFileSync(join(wt, REL), 'utf8')).toContain('second pass');
    // Nothing landed in the OTHER checkout of the repo.
    expect(existsSync(join(main, REL))).toBe(false);
  });

  it('refuses homes that are not homes', () => {
    expect(
      rooms.setDocHome('d1', { repoRoot: join(tmp, 'nope'), branch: 'x', relPath: 'a.md' }),
    ).toMatchObject({ ok: false, error: 'invalid-home' });
    expect(
      rooms.setDocHome('d1', { repoRoot: main, branch: 'main', relPath: '../escape.md' }),
    ).toMatchObject({ ok: false, error: 'invalid-home' });
    expect(
      rooms.setDocHome('ghost', { repoRoot: main, branch: 'main', relPath: 'a.md' }),
    ).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('a checkout that switches branches is never written again; the flush follows the branch', async () => {
    rooms.setDocHome('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    await sleep(1100);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    // The worktree moves OFF the home branch (someone reuses it for feature
    // work), and the branch gets checked out elsewhere.
    git(wt, 'checkout', '-b', 'feature-detour');
    const wt2 = join(tmp, 'wt-plans-2');
    git(main, 'worktree', 'add', wt2, 'plans');

    const before = readFileSync(join(wt, REL), 'utf8');
    setProse(rooms, 'd1', '# Triage\n\nthird pass\n');
    // Two debounce rounds: the first flush attempt retargets the binding,
    // the flush it re-arms on the new binding carries the edit out.
    await sleep(2400);

    // The old checkout — now on somebody's feature branch — is untouched.
    expect(readFileSync(join(wt, REL), 'utf8')).toBe(before);
    // The flush followed the branch to its new worktree.
    expect(readFileSync(join(wt2, REL), 'utf8')).toContain('third pass');
    expect(rooms.docHomeStatus('d1')?.boundPath).toBe(join(wt2, REL));
  });

  it('no checkout on the branch parks writes, says why, and resumes when one appears', async () => {
    rooms.setDocHome('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    await sleep(1100);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    git(wt, 'checkout', '--detach');

    const before = readFileSync(join(wt, REL), 'utf8');
    setProse(rooms, 'd1', '# Triage\n\nparked pass\n');
    await sleep(1400);
    expect(readFileSync(join(wt, REL), 'utf8')).toBe(before);
    // The live doc kept the edit and the park is named.
    expect(docText(rooms, 'd1')).toContain('parked pass');
    const bindings = (
      rooms as unknown as { fileBindings: Map<string, { lastSyncError?: { message: string } }> }
    ).fileBindings;
    expect(bindings.get('d1')?.lastSyncError?.message ?? '').toContain('unplaced');
    expect(rooms.docHomeStatus('d1')?.placement).toEqual({
      placed: false,
      reason: 'no-checkout-on-branch',
    });

    // The branch comes back — the next flush lands home.
    git(wt, 'checkout', 'plans');
    setProse(rooms, 'd1', '# Triage\n\nresumed pass\n');
    await sleep(1400);
    expect(readFileSync(join(wt, REL), 'utf8')).toContain('resumed pass');
  });

  it('a branch switch rewriting the bound file must not leak foreign content into the live doc', async () => {
    rooms.setDocHome('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    await sleep(1100);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    // The checkout switches branches AND the file at the old path changes
    // (what a real `git checkout` does to tracked files).
    git(wt, 'checkout', '-b', 'feature-detour');
    writeExternal(join(wt, REL), '# Somebody else\n\nfeature-branch copy\n');
    await sleep(1600);
    expect(docText(rooms, 'd1')).not.toContain('feature-branch copy');
    expect(docText(rooms, 'd1')).toContain('first pass');
  });

  it('a direct write at the home colliding with un-flushed live edits loses to the live copy', async () => {
    rooms.setDocHome('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    await sleep(1100);
    // Un-flushed live edit + immediate external write to the same file.
    setProse(rooms, 'd1', '# Triage\n\nlive edit wins\n');
    writeExternal(join(wt, REL), '# Clobber\n\ndirect write\n');
    await sleep(1800);
    expect(docText(rooms, 'd1')).toContain('live edit wins');
    expect(docText(rooms, 'd1')).not.toContain('direct write');
    expect(readFileSync(join(wt, REL), 'utf8')).toContain('live edit wins');
  });

  it('a doc parked AT HYDRATE resumes on the next edit once the branch has a checkout', async () => {
    rooms.setDocHome('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    await sleep(1100);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    await rooms.flush();

    // While "down": the branch loses its only checkout entirely.
    git(main, 'worktree', 'remove', '--force', wt);

    // Hydration parks — no checkout on the branch, so no binding at all.
    const rooms2 = makeRooms(dataDir);
    expect(docText(rooms2, 'd1')).toContain('first pass');
    expect(rooms2.docHomeStatus('d1')?.placement).toEqual({
      placed: false,
      reason: 'no-checkout-on-branch',
    });

    // The branch gets a checkout again; the next EDIT must re-place the
    // home — the recovery homeGuard provides for live parks hangs off a
    // binding this doc doesn't have.
    const wt2 = join(tmp, 'wt-plans-back');
    git(main, 'worktree', 'add', wt2, 'plans');
    setProse(rooms2, 'd1', '# Triage\n\nback from the dead\n');
    await sleep(1400);
    expect(readFileSync(join(wt2, REL), 'utf8')).toContain('back from the dead');
    expect(rooms2.docHomeStatus('d1')?.boundPath).toBe(join(wt2, REL));
    await rooms2.flush();
  });

  it('a forced reparse must not pull a switched checkout’s branch copy into the doc', async () => {
    rooms.setDocHome('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    await sleep(1100);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    // The checkout moves off the home branch and its copy of the file now
    // belongs to somebody else's feature work; the home branch has no
    // checkout anywhere.
    git(wt, 'checkout', '-b', 'feature-detour');
    writeExternal(join(wt, REL), '# Somebody else\n\nfeature-branch copy\n');

    const res = rooms.reparseFromDisk('d1');
    expect(res.ok).toBe(false);
    expect(docText(rooms, 'd1')).toContain('first pass');
    expect(docText(rooms, 'd1')).not.toContain('feature-branch copy');

    // With the branch checked out again, reparse recovers instead of
    // parking — it follows the home, not the stale path.
    const wt2 = join(tmp, 'wt-plans-again');
    git(main, 'worktree', 'add', wt2, 'plans');
    expect(rooms.reparseFromDisk('d1').ok).toBe(true);
    expect(rooms.docHomeStatus('d1')?.boundPath).toBe(join(wt2, REL));
    expect(docText(rooms, 'd1')).toContain('first pass');
  });

  it('a home declared from a linked worktree survives that worktree’s removal', async () => {
    // Declared via the LINKED checkout's path — the stored root must be the
    // repo's durable identity, not the spelling the caller happened to use.
    const res = rooms.setDocHome('d1', { repoRoot: wt, branch: 'plans', relPath: REL });
    if (!res.ok) throw new Error(JSON.stringify(res));
    expect(rooms.docHomeStatus('d1')?.home.repoRoot).toBe(main);
    await sleep(1100);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');

    // The declaring worktree dies; the branch moves to a fresh one.
    git(main, 'worktree', 'remove', '--force', wt);
    const wt2 = join(tmp, 'wt-plans-relocated');
    git(main, 'worktree', 'add', wt2, 'plans');

    setProse(rooms, 'd1', '# Triage\n\noutlived the checkout\n');
    await sleep(2400);
    expect(readFileSync(join(wt2, REL), 'utf8')).toContain('outlived the checkout');
    expect(rooms.docHomeStatus('d1')?.placement).toEqual({
      placed: true,
      path: join(wt2, REL),
    });
  });

  it('a restart re-resolves the home, including a worktree that moved while the server was down', async () => {
    rooms.setDocHome('d1', { repoRoot: main, branch: 'plans', relPath: REL });
    await sleep(1100);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-m', 'plan v1');
    await rooms.flush();

    // While "down": the plans worktree is torn down and recreated elsewhere.
    git(main, 'worktree', 'remove', '--force', wt);
    const wt2 = join(tmp, 'wt-plans-next');
    git(main, 'worktree', 'add', wt2, 'plans');

    const rooms2 = makeRooms(dataDir);
    expect(docText(rooms2, 'd1')).toContain('first pass');
    setProse(rooms2, 'd1', '# Triage\n\nafter restart\n');
    await sleep(1100);
    expect(readFileSync(join(wt2, REL), 'utf8')).toContain('after restart');
    await rooms2.flush();
  });
});
