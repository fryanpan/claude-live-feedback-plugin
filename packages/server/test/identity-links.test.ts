/**
 * Anonymous browser sessions self-name. Measured on the live stream: six
 * `anon-*` ids typed the owner's FULL name into the name box across 1,120
 * events, and every one was recorded `isOwner: false` — because
 * `isOwnerActor` matches the id `known-bryan` or the short name, exactly, and
 * the full name is neither.
 *
 * The fix is deliberately NOT a second name literal. A name is a claim the
 * browser makes about itself, so matching a looser one would start marking
 * SOMEBODY ELSE's rows as the owner's — a wrong attribution is worse than the
 * missing one it replaces. What counts as evidence here is an explicit
 * id -> identity link, kept as data in the data dir, so a new anon id is a
 * one-line edit rather than a code change.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  identityLinks,
  isOwnerActor,
  linkIdentity,
  resetOwnerIdentities,
  resolveIdentityId,
} from '../src/activity';
import { eventsForDoc, runBackfill } from '../src/activity-backfill';
import { identityLinksPath, loadIdentityLinks } from '../src/identity-links';

const tmpDirs: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'identity-links-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetOwnerIdentities();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a linked id is the owner; an unlinked name is not', () => {
  test('positive control: the two built-in spellings still match', () => {
    expect(isOwnerActor({ id: 'known-bryan', name: 'whoever' })).toBe(true);
    expect(isOwnerActor({ id: 'anon-1', name: 'Bryan' })).toBe(true);
    expect(isOwnerActor('Bryan')).toBe(true);
  });

  test('a linked anon id counts as the owner', () => {
    // The exact shape the stream records for an anonymous browser session:
    // the id is anonymous and the name is the one the check does not match.
    const author = { id: 'anon-fixture1', name: 'Owner Fullname' };
    expect(isOwnerActor(author)).toBe(false);
    linkIdentity('anon-fixture1', 'known-bryan');
    expect(isOwnerActor(author)).toBe(true);
  });

  test('an UNLINKED session claiming the owner-ish name is still not the owner', () => {
    linkIdentity('anon-fixture1', 'known-bryan');
    // Same self-reported name, different session: the link is the evidence,
    // never the name. This is the case a name literal would have got wrong.
    expect(isOwnerActor({ id: 'anon-fixture2', name: 'Owner Fullname' })).toBe(false);
  });

  test('negative control: a linked id does not make every actor the owner', () => {
    linkIdentity('anon-fixture1', 'known-bryan');
    expect(isOwnerActor({ id: 'agent-somebody', name: 'Somebody' })).toBe(false);
    expect(isOwnerActor({ id: 'anon-fixture3', name: 'Someone Else' })).toBe(false);
    expect(isOwnerActor('claude')).toBe(false);
  });

  test('a link to a non-owner identity does not confer ownership', () => {
    linkIdentity('anon-fixture1', 'user-not-the-owner');
    expect(isOwnerActor({ id: 'anon-fixture1', name: 'Whoever' })).toBe(false);
  });

  test('resolveIdentityId follows a chain and survives a cycle', () => {
    linkIdentity('anon-a', 'anon-b');
    linkIdentity('anon-b', 'known-bryan');
    expect(resolveIdentityId('anon-a')).toBe('known-bryan');
    expect(isOwnerActor({ id: 'anon-a', name: 'Whoever' })).toBe(true);
    linkIdentity('loop-1', 'loop-2');
    linkIdentity('loop-2', 'loop-1');
    // Terminates rather than hanging; which end it stops on is unspecified.
    expect(['loop-1', 'loop-2']).toContain(resolveIdentityId('loop-1'));
  });

  test('blank or self-referential links are ignored', () => {
    linkIdentity('   ', 'known-bryan');
    linkIdentity('anon-fixture1', '  ');
    linkIdentity('anon-fixture1', 'anon-fixture1');
    expect(identityLinks()).toEqual({});
    expect(isOwnerActor({ id: 'anon-fixture1', name: 'Whoever' })).toBe(false);
  });
});

describe('the link file in the data dir', () => {
  test('a missing file loads nothing and reports no error', () => {
    const dir = scratchDir();
    expect(loadIdentityLinks(dir)).toEqual({ loaded: 0 });
    expect(identityLinks()).toEqual({});
  });

  test('an object map links every entry', () => {
    const dir = scratchDir();
    writeFileSync(
      identityLinksPath(dir),
      JSON.stringify({ links: { 'anon-fixture1': 'known-bryan', 'anon-fixture2': 'known-bryan' } }),
    );
    expect(loadIdentityLinks(dir)).toEqual({ loaded: 2 });
    expect(isOwnerActor({ id: 'anon-fixture1', name: 'Owner Fullname' })).toBe(true);
    expect(isOwnerActor({ id: 'anon-fixture2', name: 'Owner Fullname' })).toBe(true);
    expect(isOwnerActor({ id: 'anon-fixture3', name: 'Owner Fullname' })).toBe(false);
  });

  test('an array of records links every entry and tolerates a note', () => {
    const dir = scratchDir();
    writeFileSync(
      identityLinksPath(dir),
      JSON.stringify({
        links: [{ from: 'anon-fixture1', to: 'known-bryan', note: 'iPad session, Aug 2026' }],
      }),
    );
    expect(loadIdentityLinks(dir)).toEqual({ loaded: 1 });
    expect(isOwnerActor({ id: 'anon-fixture1', name: 'Owner Fullname' })).toBe(true);
  });

  test('a malformed file loads nothing and NAMES the problem', () => {
    const dir = scratchDir();
    writeFileSync(identityLinksPath(dir), '{ this is not json');
    const result = loadIdentityLinks(dir);
    expect(result.loaded).toBe(0);
    // Silence here is the failure mode: an unreadable file that reads as an
    // empty one is indistinguishable from a correct one with no links.
    expect(result.error).toBeTruthy();
    expect(result.error).toContain(identityLinksPath(dir));
  });

  test('a file of the wrong shape reports rather than throwing', () => {
    const dir = scratchDir();
    writeFileSync(identityLinksPath(dir), JSON.stringify({ links: 'known-bryan' }));
    const result = loadIdentityLinks(dir);
    expect(result.loaded).toBe(0);
    expect(result.error).toBeTruthy();
  });

  test('unusable entries are skipped and the usable ones still load', () => {
    const dir = scratchDir();
    writeFileSync(
      identityLinksPath(dir),
      JSON.stringify({
        links: { 'anon-fixture1': 'known-bryan', 'anon-fixture2': 7, '': 'known-bryan' },
      }),
    );
    expect(loadIdentityLinks(dir).loaded).toBe(1);
    expect(isOwnerActor({ id: 'anon-fixture1', name: 'Owner Fullname' })).toBe(true);
    expect(isOwnerActor({ id: 'anon-fixture2', name: 'Owner Fullname' })).toBe(false);
  });
});

/**
 * The unit tests above prove the predicate and prove nothing about the
 * callers — a link map nobody consults would pass every one of them. These
 * drive the two emitters that actually write `isOwner` into the stream.
 */
describe('the emitters honour the links', () => {
  const TS = Date.parse('2026-06-01T12:00:00Z');
  const meta = { docId: 'd1', title: 'README', kind: 'markdown' } as never;
  const thread = {
    id: 't1',
    status: 'open',
    lastActivity: TS,
    createdBy: { id: 'anon-fixture1', name: 'Owner Fullname', kind: 'anon' },
    comments: [
      {
        id: 'c1',
        author: { id: 'anon-fixture1', name: 'Owner Fullname', kind: 'anon' },
        text: 'a',
        ts: TS,
      },
      {
        id: 'c2',
        author: { id: 'anon-fixture2', name: 'Owner Fullname', kind: 'anon' },
        text: 'b',
        ts: TS + 1,
      },
    ],
  } as never;

  test('eventsForDoc marks a linked anon comment as the owner, and only it', () => {
    linkIdentity('anon-fixture1', 'known-bryan');
    const events = eventsForDoc(meta, [thread]);
    expect(events.find((e) => e.type === 'comment')?.isOwner).toBe(true);
    expect(events.find((e) => e.type === 'reply')?.isOwner).toBe(false);
  });

  test('runBackfill loads the link file before it emits anything', () => {
    const dir = scratchDir();
    writeFileSync(
      identityLinksPath(dir),
      JSON.stringify({ links: { 'anon-fixture1': 'known-bryan' } }),
    );
    // No .ydoc files: what is under test is that a standalone run picks the
    // links up at all. Without this the rebuilt rows come out unlinked and
    // look exactly like a correct rebuild.
    expect(runBackfill({ dataDir: dir, write: false }).identityLinksLoaded).toBe(1);
    expect(isOwnerActor({ id: 'anon-fixture1', name: 'Owner Fullname' })).toBe(true);
  });
});

/**
 * P2: the registry is process-wide and `loadIdentityLinks` used only to ADD.
 * Two consequences, both silent — a second load for a different data dir kept
 * the first dir's links, so an actor could be treated as the owner while
 * processing a directory that never named them; and a file that went missing
 * or malformed kept every link from the load before it, which is the opposite
 * of what an unreadable config should mean.
 */
describe('each load REPLACES the registry rather than accumulating', () => {
  test('links from a previous data dir do not survive the next load', () => {
    const a = scratchDir();
    const b = scratchDir();
    writeFileSync(
      identityLinksPath(a),
      JSON.stringify({ links: { 'anon-fixture1': 'known-bryan' } }),
    );
    writeFileSync(
      identityLinksPath(b),
      JSON.stringify({ links: { 'anon-fixture2': 'known-bryan' } }),
    );
    loadIdentityLinks(a);
    expect(isOwnerActor({ id: 'anon-fixture1', name: 'Owner Fullname' })).toBe(true);
    loadIdentityLinks(b);
    expect(isOwnerActor({ id: 'anon-fixture1', name: 'Owner Fullname' })).toBe(false);
    expect(isOwnerActor({ id: 'anon-fixture2', name: 'Owner Fullname' })).toBe(true);
  });

  test('a data dir with no link file clears what the previous one loaded', () => {
    const a = scratchDir();
    const bare = scratchDir();
    writeFileSync(
      identityLinksPath(a),
      JSON.stringify({ links: { 'anon-fixture1': 'known-bryan' } }),
    );
    loadIdentityLinks(a);
    expect(loadIdentityLinks(bare)).toEqual({ loaded: 0 });
    expect(identityLinks()).toEqual({});
    expect(isOwnerActor({ id: 'anon-fixture1', name: 'Owner Fullname' })).toBe(false);
  });

  test('a malformed file clears rather than silently keeping the old links', () => {
    const a = scratchDir();
    const broken = scratchDir();
    writeFileSync(
      identityLinksPath(a),
      JSON.stringify({ links: { 'anon-fixture1': 'known-bryan' } }),
    );
    loadIdentityLinks(a);
    writeFileSync(identityLinksPath(broken), '{ not json');
    expect(loadIdentityLinks(broken).error).toBeTruthy();
    expect(identityLinks()).toEqual({});
  });

  test('reloading the SAME dir twice is stable, not cumulative', () => {
    const a = scratchDir();
    writeFileSync(
      identityLinksPath(a),
      JSON.stringify({ links: { 'anon-fixture1': 'known-bryan' } }),
    );
    loadIdentityLinks(a);
    expect(loadIdentityLinks(a)).toEqual({ loaded: 1 });
    expect(identityLinks()).toEqual({ 'anon-fixture1': 'known-bryan' });
  });
});
