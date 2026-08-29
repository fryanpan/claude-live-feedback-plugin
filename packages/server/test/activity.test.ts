import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DocMeta,
  type ElementAnchor,
  type User,
  createThread,
  initDocMeta,
} from '@feedback/core';
import * as Y from 'yjs';
import { eventsForDoc, runBackfill } from '../src/activity-backfill.ts';
import { activityLogPath } from '../src/activity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const agent: User = { id: 'known-agent', name: 'Agent', kind: 'known', color: '#e36f1e' };

const fakeAnchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Go',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Go' },
};

interface ActivityEvent {
  eventId: string;
  ts: string;
  type: string;
  actor: string;
  actorId: string;
  actorName: string;
  isOwner: boolean;
  threadId?: string;
  doc: {
    docId: string;
    kind: string;
    repo: { owner: string; name: string };
    producedBy: { agentId: string | null; sessionId: string | null; cwd: string | null };
  };
  payload: {
    text?: string;
    wordCount?: number;
    durationMs?: number;
    interactionBounded?: boolean;
    sessionId?: string;
    maxScrollDepthPct?: number;
  };
}

function readEvents(dataDir: string): ActivityEvent[] {
  const path = activityLogPath(dataDir);
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as ActivityEvent);
}

describe('hands-on activity stream', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  /**
   * The MINTED id of the doc created as `act-doc`. Activity rows record the
   * doc's address, not the readable name the caller asked for — `act-doc`
   * still routes to it, which is why every fetch below keeps using it.
   */
  let actDocId: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-activity-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  it('appends a comment activity event when a PERSON comments via REST', async () => {
    const file = join(dataDir, 'act-doc.md');
    writeFileSync(file, '# Heading\n\nSome prose to comment on.\n');
    actDocId = (
      await j<{ docId: string }>(
        await fetch(`${base}/api/docs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ docId: 'act-doc', type: 'markdown', sourceUrl: file }),
        }),
      )
    ).docId;

    await j(
      await fetch(`${base}/api/docs/act-doc/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          author: bryan,
          text: 'this needs more detail',
          anchor: fakeAnchor,
        }),
      }),
    );

    const events = readEvents(dataDir);
    const comment = events.find((e) => e.type === 'comment' && e.doc.docId === actDocId);
    expect(comment).toBeDefined();
    expect(comment!.actor).toBe('person');
    expect(comment!.actorId).toBe('known-bryan');
    expect(comment!.isOwner).toBe(true);
    // UTC-Z, millisecond precision.
    expect(comment!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Stable, non-empty eventId.
    expect(comment!.eventId).toMatch(/^[0-9a-f]{24}$/);
    // doc.repo derived.
    expect(comment!.doc.repo).toBeDefined();
    expect(typeof comment!.doc.repo.owner).toBe('string');
    expect(typeof comment!.doc.repo.name).toBe('string');
    // wordCount = whitespace split of "this needs more detail" = 4.
    expect(comment!.payload.wordCount).toBe(4);
    expect(comment!.threadId).toBeDefined();
  });

  it('classifies an agent comment as actor:agent', async () => {
    const file = join(dataDir, 'act-agent.md');
    writeFileSync(file, 'Agent target text.\n');
    const { docId: agentDocId } = await j<{ docId: string }>(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'act-agent', type: 'markdown', sourceUrl: file }),
      }),
    );
    await j(
      await fetch(`${base}/api/docs/act-agent/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: agent, text: 'agent note', anchor: fakeAnchor }),
      }),
    );
    const events = readEvents(dataDir);
    const ev = events.find((e) => e.doc.docId === agentDocId && e.type === 'comment');
    expect(ev?.actor).toBe('agent');
    expect(ev?.isOwner).toBe(false);
  });

  it('records a read_session via the activity endpoint with interactionBounded', async () => {
    const startTs = new Date(Date.now() - 60_000).toISOString();
    const endTs = new Date().toISOString();
    const r = await fetch(`${base}/api/docs/act-doc/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'read_session',
        author: bryan,
        payload: {
          sessionId: 'sess-123',
          startTs,
          endTs,
          durationMs: 18_000,
          maxScrollDepthPct: 72,
          interactionBounded: true,
        },
      }),
    });
    expect(r.status).toBe(200);

    const events = readEvents(dataDir);
    const read = events.find((e) => e.type === 'read_session' && e.doc.docId === actDocId);
    expect(read).toBeDefined();
    expect(read!.actor).toBe('person');
    expect(read!.payload.interactionBounded).toBe(true);
    expect(read!.payload.durationMs).toBe(18_000);
    expect(read!.ts).toMatch(/Z$/);
  });

  it('emits a doc_open event and rejects unknown activity types', async () => {
    const ok = await fetch(`${base}/api/docs/act-doc/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'doc_open', payload: { sessionId: 'open-1' } }),
    });
    expect(ok.status).toBe(200);
    expect(readEvents(dataDir).some((e) => e.type === 'doc_open')).toBe(true);

    const bad = await fetch(`${base}/api/docs/act-doc/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'bogus', payload: {} }),
    });
    expect(bad.status).toBe(400);
  });

  it('live comment eventId matches the backfill eventId for the same thread (dedup contract)', async () => {
    const file = join(dataDir, 'act-dedup.md');
    writeFileSync(file, '# Dedup\n\nText to comment on.\n');
    const docRes = await j<{ docId: string; meta: DocMeta }>(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'act-dedup', type: 'markdown', sourceUrl: file }),
      }),
    );
    await j(
      await fetch(`${base}/api/docs/act-dedup/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: bryan, text: 'dedup me', anchor: fakeAnchor }),
      }),
    );

    // The live event the REST comment just appended, under the id the server
    // minted for `act-dedup`.
    const dedupId = docRes.docId;
    const live = readEvents(dataDir).find((e) => e.type === 'comment' && e.doc.docId === dedupId);
    expect(live).toBeDefined();

    // Reconstruct the SAME comment via the backfill path (eventsForDoc) over
    // the full thread, and confirm the deterministic id + ts line up. This is
    // the contract that lets a backfill re-run dedupe against live capture —
    // it only holds because the live event hashes the comment's PERSISTED ts,
    // not a fresh Date.now().
    const summary = handle.rooms.listThreads(dedupId)[0];
    const full = handle.rooms.getThread(dedupId, summary!.id);
    expect(full).not.toBeNull();
    const backfill = eventsForDoc(docRes.meta, [full!]).find((e) => e.type === 'comment');
    expect(backfill).toBeDefined();
    expect(live!.ts).toBe(backfill!.ts);
    expect(live!.eventId).toBe(backfill!.eventId);
  });

  it('server re-clamps an over-cap read_session durationMs', async () => {
    const r = await fetch(`${base}/api/docs/act-doc/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'read_session',
        author: bryan,
        payload: {
          sessionId: 'sess-inflated',
          // 10 hours — a spoofed/buggy client value that must NOT land verbatim.
          durationMs: 36_000_000,
          maxScrollDepthPct: 999,
          interactionBounded: true,
        },
      }),
    });
    expect(r.status).toBe(200);
    const read = readEvents(dataDir).find(
      (e) => e.type === 'read_session' && e.payload.sessionId === 'sess-inflated',
    );
    expect(read).toBeDefined();
    // Clamped to the 20-min cap and 0..100 scroll range.
    expect(read!.payload.durationMs).toBe(20 * 60_000);
    expect(read!.payload.maxScrollDepthPct).toBe(100);
  });
});

describe('activity backfill', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-backfill-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Build a .ydoc snapshot on disk with two comments in the clean-data
   *  window so the backfill emits exactly two comment-family events. */
  function writeYdocWithTwoComments(docId: string): void {
    const ydoc = new Y.Doc();
    const meta: DocMeta = {
      docId,
      type: 'markdown',
      sourceUrl: join(dataDir, `${docId}.md`),
      createdAt: Date.parse('2026-05-01T00:00:00Z'),
      owner: dataDir,
    };
    initDocMeta(ydoc, meta);
    // First comment (-> comment event).
    const t = createThread(ydoc, {
      threadId: 'thread-a',
      anchor: { kind: 'element', fingerprint: fakeAnchor.fingerprint, snippet: { text: 'x' } },
      createdBy: bryan,
      firstComment: { id: 'c1', text: 'first point here' },
    });
    // Stamp the first comment ts into the clean window (createThread used now()).
    const threads = ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>;
    const tm = threads.get(t.id)!;
    const comments = tm.get('comments') as Y.Array<Y.Map<unknown>>;
    ydoc.transact(() => {
      (comments.get(0) as Y.Map<unknown>).set('ts', Date.parse('2026-05-02T10:00:00Z'));
    });
    // Second comment is a separate thread so it's also a `comment` (not reply).
    const t2 = createThread(ydoc, {
      threadId: 'thread-b',
      anchor: { kind: 'element', fingerprint: fakeAnchor.fingerprint, snippet: { text: 'y' } },
      createdBy: bryan,
      firstComment: { id: 'c2', text: 'second separate point' },
    });
    const tm2 = (ydoc.getMap('threads') as Y.Map<Y.Map<unknown>>).get(t2.id)!;
    const comments2 = tm2.get('comments') as Y.Array<Y.Map<unknown>>;
    ydoc.transact(() => {
      (comments2.get(0) as Y.Map<unknown>).set('ts', Date.parse('2026-05-03T10:00:00Z'));
    });
    const update = Y.encodeStateAsUpdate(ydoc);
    writeFileSync(join(dataDir, `${docId}.ydoc`), update);
    ydoc.destroy();
  }

  it('emits 2 comment events from a temp .ydoc with 2 comments, deterministic + dedupes on re-run', () => {
    writeYdocWithTwoComments('bf-doc');

    const first = runBackfill({ dataDir });
    expect(first.byType.comment).toBe(2);

    const events1 = readEvents(dataDir).filter((e) => e.doc.docId === 'bf-doc');
    expect(events1).toHaveLength(2);
    expect(events1.every((e) => e.type === 'comment')).toBe(true);
    const ids1 = events1.map((e) => e.eventId).sort();

    // Second run: same deterministic eventIds (so WR can dedupe). The file is
    // append-only, so the lines re-appear — but the ids are IDENTICAL.
    runBackfill({ dataDir });
    const events2 = readEvents(dataDir).filter((e) => e.doc.docId === 'bf-doc');
    const ids2 = [...new Set(events2.map((e) => e.eventId))].sort();
    expect(ids2).toEqual(ids1);
  });
});

describe('classifyActor', () => {
  it('classifies named per-agent identities (agent-<slug> ids) as agent, not person', async () => {
    const { classifyActor } = await import('../src/activity.ts');
    expect(classifyActor({ id: 'agent-quick-build', name: 'Quick Build', kind: 'known' })).toBe(
      'agent',
    );
  });

  it('keeps the legacy agent signals and person classification', async () => {
    const { classifyActor } = await import('../src/activity.ts');
    expect(classifyActor({ id: 'known-agent', name: 'Agent', kind: 'known' })).toBe('agent');
    expect(classifyActor({ id: 'anon-abc123', name: 'Casey', kind: 'known' })).toBe('person');
    expect(classifyActor({ id: 'known-bryan', name: 'Bryan', kind: 'known' })).toBe('person');
  });

  // Both directions, deliberately. The bug this replaced passed in one
  // direction — an author with no `kind` classified as 'agent' — which is
  // exactly why it read as working. Asserting only the omitted-kind case
  // would let the inverted case back in unnoticed.
  it('honours an explicit actor-axis kind in BOTH directions', async () => {
    const { classifyActor } = await import('../src/activity.ts');
    // A caller that declares itself an agent must not be recorded as a human.
    expect(classifyActor({ id: 'team-lead', name: 'Team Lead', kind: 'agent' })).toBe('agent');
    // ...and a caller that declares itself a person keeps that.
    expect(classifyActor({ id: 'team-lead', name: 'Team Lead', kind: 'person' })).toBe('person');
  });

  // The field is hand-populated by outside callers, so its casing is not ours
  // to assume. An unrecognized `kind` falls through to the 'person' default —
  // so `'Agent'` matching nothing would misfile a caller that DID declare
  // itself, which is the original bug wearing a capital letter.
  it('reads a declared agent kind regardless of case', async () => {
    const { classifyActor } = await import('../src/activity.ts');
    for (const kind of ['Agent', 'AGENT', 'aGeNt']) {
      expect(classifyActor({ id: 'team-lead', name: 'Team Lead', kind })).toBe('agent');
    }
    // Positive control: a genuinely unknown kind is still a person, so the
    // case-folding above isn't just a blanket "everything is an agent".
    expect(classifyActor({ id: 'team-lead', name: 'Team Lead', kind: 'known' })).toBe('person');
  });

  it('classifies a caller with no kind at all as an agent', async () => {
    const { classifyActor } = await import('../src/activity.ts');
    // Browser users always carry 'known' | 'anon'; a missing `kind` means the
    // call came from somewhere that isn't a browser session.
    expect(classifyActor({ id: 'team-lead', name: 'Team Lead' })).toBe('agent');
  });

  it('resolves a contradictory author to agent, never to person', async () => {
    const { classifyActor } = await import('../src/activity.ts');
    // `kind` is overloaded: on a browser User it means known-vs-anon, and a
    // caller may also use it to declare the actor axis. When the two signals
    // disagree, the tie goes to 'agent' on purpose — an agent misfiled as a
    // person launders the audit log AND reopens threads it closes
    // (rooms.ts reply-reopen rule), while the reverse only over-filters.
    expect(classifyActor({ id: 'agent-quick-build', name: 'Quick Build', kind: 'person' })).toBe(
      'agent',
    );
  });
});

/**
 * History is never rewritten: a row stamped with an old agent id keeps that
 * id on disk forever. What changes is the READ — the roster says which
 * identity the id belongs to now, and what that identity is called.
 */
describe('an old-id activity row resolves to the merged identity at read', () => {
  it('resolveActor answers the canonical id and the roster name', async () => {
    const { Identities } = await import('../src/identities.ts');
    const { resolveActor, setIdentityRoster } = await import('../src/activity.ts');
    const dataDir = mkdtempSync(join(tmpdir(), 'activity-merge-'));
    try {
      const roster = new Identities({ dataDir });
      roster.upsertAgent('agent-quick-build', 'Quick Build');
      roster.mergeAgent('qb-agent', 'agent-quick-build');
      setIdentityRoster(roster);
      expect(resolveActor({ actorId: 'qb-agent', actorName: 'qb-agent' })).toEqual({
        id: 'agent-quick-build',
        name: 'Quick Build',
      });
      // POSITIVE CONTROL: an id the roster does not know reads as stored.
      expect(resolveActor({ actorId: 'anon-zz9', actorName: 'Someone' })).toEqual({
        id: 'anon-zz9',
        name: 'Someone',
      });
    } finally {
      const { setIdentityRoster: reset } = await import('../src/activity.ts');
      reset(undefined);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
