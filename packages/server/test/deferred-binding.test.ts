import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rooms } from '../src/rooms.ts';
import { SseHub } from '../src/sse.ts';
import { createWebhookDispatcher } from '../src/webhooks.ts';

/**
 * A restart no longer binds every doc on disk — it registers each binding and
 * establishes it the first time anything reads or writes that doc (see
 * `deferredBinds` in rooms.ts). That is only safe if first access is
 * indistinguishable from the old eager boot, so this file pins the four
 * things a bound doc owes: it picks up edits made while the server was down,
 * its threads survive that apply, its own edits reach the file, and the mtime
 * poll is live from then on.
 *
 * The access paths are deliberately different in each test — a browser open
 * (`get`), an MCP read (`getDoc`), an MCP write (`findAndReplace`) — because
 * the hazard is a path that reaches a doc WITHOUT binding it, and one test
 * through one door would not find it.
 */

function makeRooms(dataDir: string): Rooms {
  return new Rooms({
    dataDir,
    sse: new SseHub(),
    webhooks: createWebhookDispatcher({ onLog: () => {} }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DOC = '# Title\n\nIntro paragraph.\n\nSecond paragraph.\n';

/** Write and push the mtime forward — the reconcile arbitrates on mtime, and
 *  a same-second write is indistinguishable from no write at all. */
let bump = 0;
function writeExternal(path: string, content: string): void {
  writeFileSync(path, content);
  bump += 2;
  const t = new Date(Date.now() + bump * 1000);
  utimesSync(path, t, t);
}

describe('deferred file bindings', () => {
  let dataDir: string;
  let path: string;
  let rooms: Rooms;
  let docId: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-defer-'));
    path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    rooms = makeRooms(dataDir);
    const created = rooms.createForCaller('my-review-doc', { type: 'markdown', sourceUrl: path });
    if (!created.ok) throw new Error('setup failed');
    docId = created.room.docId;
    rooms.attachFile(docId, path);
    rooms.flush();
    await sleep(250); // let the .ydoc land before the "restart"
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an edit made while the server was down reaches the doc on first access', async () => {
    // The contract deferral must not break: the re-apply is moved, not
    // dropped. (That boot itself no longer READS the file is measured in
    // boot-perf.test.ts — from this side of the seam there is no way to
    // observe the doc without binding it, which is the point.)
    writeExternal(path, DOC.replace('Intro paragraph.', 'Edited while down.'));
    const restarted = makeRooms(dataDir);

    expect(restarted.getDoc(docId)?.plainText).toContain('Edited while down.');
  });

  it('a thread anchored in the doc survives the first-access apply', async () => {
    const thread = await rooms.createThreadByFind(
      docId,
      { find: 'Second paragraph.' },
      { id: 'u1', name: 'Tester', kind: 'known', color: '#2e7dd7' },
      'does this survive?',
      { generate: false },
    );
    expect(thread.ok).toBe(true);
    rooms.flush();
    await sleep(250);

    // An external edit to a DIFFERENT block: the block diff must leave the
    // anchored one alone, which is exactly what the eager path guaranteed.
    writeExternal(path, DOC.replace('Intro paragraph.', 'Rewritten intro.'));
    const restarted = makeRooms(dataDir);

    const doc = restarted.getDoc(docId);
    expect(doc?.plainText).toContain('Rewritten intro.');
    expect(restarted.listThreads(docId).length).toBe(1);
    // Re-anchoring is the half of the contract the done-when names: after the
    // first-access apply, no thread is left pointing at text that moved.
    expect(restarted.autoReanchor(docId)?.stillOrphan).toBe(0);
  });

  it('an edit after first access writes back to the file', async () => {
    const restarted = makeRooms(dataDir);
    expect(
      restarted.findAndReplace(docId, { find: 'Second paragraph.', replace: 'Agent wrote this.' })
        .ok,
    ).toBe(true);
    await sleep(1100); // the ~800ms debounced write-back

    expect(readFileSync(path, 'utf8')).toContain('Agent wrote this.');
  });

  it('the mtime poll is live once the doc has been accessed', async () => {
    const restarted = makeRooms(dataDir);
    expect(restarted.get(docId)).toBeDefined(); // browser-open path

    writeExternal(path, DOC.replace('Second paragraph.', 'Landed via the poll.'));
    await sleep(1200); // 500ms poll + 150ms read debounce

    expect(restarted.getDoc(docId)?.plainText).toContain('Landed via the poll.');
  });

  it('a doc reached by its alias binds too, and keeps its alias across the restart', async () => {
    // Alias resolution is the constraint lazy loading would have broken: the
    // alias lives inside the doc's own DocMeta, so it only comes back because
    // the `.ydoc` is still loaded eagerly. Deferring the BINDING does not
    // touch it — and an alias must bind the same way a primary id does.
    writeExternal(path, DOC.replace('Intro paragraph.', 'Reached by name.'));
    const restarted = makeRooms(dataDir);

    // `get` is the alias-resolving door, and it must bind what it resolves —
    // the internal verbs below it take canonical ids only.
    const resolved = restarted.get('my-review-doc');
    expect(resolved?.docId).toBe(docId);
    expect(restarted.getDoc(resolved?.docId ?? '')?.plainText).toContain('Reached by name.');
  });

  it('the landing-page reads answer without binding', async () => {
    // The load-bearing exclusion: the landing page counts open threads for
    // every doc it shows. If that bound them, one page view would put every
    // poll back and the change would buy nothing.
    //
    // What is checked here is that those reads still ANSWER after a restart —
    // thread counts and titles come from the `.ydoc`, which is still loaded
    // eagerly. That they do not bind is measured in boot-perf.test.ts, where
    // the syscall counter can tell the difference; a behavioural test here
    // could not, because every way of observing the content binds it.
    const made = await rooms.createThreadByFind(
      docId,
      { find: 'Second paragraph.' },
      { id: 'u1', name: 'Tester', kind: 'known', color: '#2e7dd7' },
      'counted',
      { generate: false },
    );
    expect(made.ok).toBe(true);
    rooms.flush();
    await sleep(250);

    const restarted = makeRooms(dataDir);
    expect(restarted.list().some((m) => m.docId === docId)).toBe(true);
    expect(restarted.listThreads(docId).length).toBe(1);
    expect(restarted.metaOf(docId)?.docId).toBe(docId);
    expect(restarted.metaOf('my-review-doc')?.docId).toBe(docId);
  });
});
