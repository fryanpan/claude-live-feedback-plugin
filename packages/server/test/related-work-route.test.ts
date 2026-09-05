/**
 * `GET /api/workspaces/:id/related-work` — the matching step over a real board.
 *
 * The scorer itself is unit-tested in `packages/core/src/related-work.test.ts`;
 * what this suite is for is everything the route decides and the scorer cannot
 * see: which goals and which docs become candidates, that the request's own
 * doc never matches itself, and that a link a goal already carries surfaces
 * work whose words share nothing with the ask.
 *
 * The board is built the way the incident's board was: two goals, one plan doc
 * that covers the first goal, and the huddle notes the request came out of.
 *
 * Every negative assertion here is paired with `considered`, which is how many
 * rows the route weighed. An empty `matches` beside a zero `considered` would
 * mean the board was empty and the route proved nothing — the positive control
 * that keeps "returns nothing" from passing vacuously.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ServerHandle, createServer } from '../src/server.ts';
import { type SeedGoalSpec, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };

const GOAL_SPEC: SeedGoalSpec[] = [
  { key: 'notes', title: 'Bryan can read meeting notes that are worth keeping' },
  { key: 'widget', title: 'A host site can embed the widget without a bundle regression' },
];

interface RelatedMatch {
  kind: 'goal' | 'doc';
  id: string;
  title: string;
  score: number;
  reason: string;
  matchedTerms: string[];
  linked: boolean;
  url?: string;
}
interface RelatedBody {
  workspaceId: string;
  query: string;
  considered: number;
  matches: RelatedMatch[];
}

describe('GET /api/workspaces/:id/related-work', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let wsId: string;
  let notesGoal: string;
  let widgetGoal: string;
  let planDocId: string;
  let huddleDocId: string;
  let strategyDocId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'related-work-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    const wsRes = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'meeting-notes', goal: 'Notes worth keeping.' }),
    });
    wsId = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id;

    const goals = await seedGoalsOverHttp(base, wsId, GOAL_SPEC, PERSON);
    notesGoal = goals.notes ?? '';
    widgetGoal = goals.widget ?? '';

    // Goal prose: the body half of the match, and the field the incident's
    // duplicate goal was missing entirely.
    handle.tasks.updateGoalBodySnapshot(
      notesGoal,
      'The notes a live huddle produces should stand on their own the next morning. Capture, correction and the notes doc are all in scope.',
    );
    handle.tasks.updateGoalBodySnapshot(
      widgetGoal,
      'Keep the injectable widget under its size budget on every release.',
    );

    planDocId = await makeDoc(
      'meeting-notes-ux-plan',
      'Meeting notes UX plan',
      join(dataDir, 'meeting-notes-ux-plan.md'),
      '# Meeting notes UX plan\n\nHow the notes strip behaves during a huddle.\n',
    );
    huddleDocId = await makeDoc(
      'huddle-0902',
      'Huddle notes',
      join(dataDir, 'huddle-0902.md'),
      '# Huddle notes\n\nBryan asked why planning ignored the board.\n',
    );
    // A plan-shaped doc about work nobody asked about, so a match is a match
    // and not "every plan doc on the board comes back".
    strategyDocId = await makeDoc(
      'billing-strategy',
      'Billing strategy',
      join(dataDir, 'billing-strategy.md'),
      '# Billing strategy\n\nInvoices, dunning and refunds.\n',
    );

    // The link the incident's goal never got. Written through the store: the
    // link WRITE path is not what this suite is about, only the read of it.
    const linked = handle.tasks.linkGoalRef(notesGoal, { kind: 'doc', docId: huddleDocId });
    if (!linked.ok || !linked.changed) {
      throw new Error('fixture: could not link the huddle notes to the notes goal');
    }
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Bind a markdown file as a doc filed under this board. */
  async function makeDoc(
    alias: string,
    title: string,
    path: string,
    markdown: string,
    board: string = wsId,
  ): Promise<string> {
    writeFileSync(path, markdown);
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: alias,
        type: 'markdown',
        title,
        sourceUrl: path,
        hubWorkspaceId: board,
      }),
    });
    expect(res.status, `creating ${alias}: ${await res.clone().text()}`).toBe(200);
    return ((await res.json()) as { docId: string }).docId;
  }

  async function relatedOn(board: string, params: Record<string, string>): Promise<RelatedBody> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${base}/api/workspaces/${board}/related-work?${qs}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as RelatedBody;
  }

  async function related(params: Record<string, string>): Promise<RelatedBody> {
    return relatedOn(wsId, params);
  }

  it('puts the goal the request lines up with first, and its plan doc beside it', async () => {
    const body = await related({
      q: 'Plan how Bryan reads meeting notes that are worth keeping',
    });
    const ids = body.matches.map((m) => m.id);
    expect(ids[0]).toBe(notesGoal);
    expect(ids).toContain(planDocId);
    expect(body.matches[0]?.kind).toBe('goal');
    // The reason names evidence a reader can check against the row.
    expect(body.matches[0]?.reason).toContain('meeting');
    expect(body.matches[0]?.url).toBe(`/workspaces/${wsId}?goal=${notesGoal}`);
  });

  it('leads with the existing plan when the request is worded like that plan', async () => {
    // Not a contradiction of the test above but the same rule seen from the
    // other side: the row whose TITLE the request most resembles leads, and
    // for "write a plan for the meeting notes UX" that is the doc already
    // called "Meeting notes UX plan". Both still come back, which is what the
    // caller needs — the question it asks a person is extend, replace, or new.
    const body = await related({ q: 'Write a plan for the meeting notes UX' });
    const ids = body.matches.map((m) => m.id);
    expect(ids[0]).toBe(planDocId);
    expect(ids).toContain(notesGoal);
    expect(body.matches[0]?.url).toBe(`/review/${planDocId}`);
  });

  it('leaves out the goal and the plan doc that are about other work', async () => {
    const body = await related({
      q: 'Plan how Bryan reads meeting notes that are worth keeping',
    });
    const ids = body.matches.map((m) => m.id);
    expect(ids).not.toContain(widgetGoal);
    expect(ids).not.toContain(strategyDocId);
    // Both WERE weighed — the route considers every live goal plus the
    // plan-shaped and linked docs, so their absence is a scoring verdict.
    expect(body.considered).toBeGreaterThanOrEqual(5);
  });

  it('answers no matches for a request this board holds nothing about', async () => {
    const body = await related({ q: 'Rotate the Postmark sending credentials' });
    expect(body.matches).toEqual([]);
    // The control: the board was NOT empty when it answered nothing.
    expect(body.considered).toBeGreaterThanOrEqual(5);
  });

  it('surfaces a goal by the doc it links, with no word in common', async () => {
    // "dunning" and "refunds" share nothing with the notes goal's title or
    // prose. Only the link the goal carries to this doc can return it.
    const body = await related({ q: 'invoices dunning refunds', docId: huddleDocId });
    const hit = body.matches.find((m) => m.id === notesGoal);
    expect(hit).toBeDefined();
    expect(hit?.linked).toBe(true);
    expect(hit?.matchedTerms).toEqual([]);
    expect(hit?.reason).toContain('already links the doc');
  });

  it('never returns the doc the request came from as a match for itself', async () => {
    const body = await related({ q: 'huddle notes', docId: huddleDocId });
    expect(body.matches.map((m) => m.id)).not.toContain(huddleDocId);
    // Without the docId it is a candidate again — so the exclusion above is
    // the `docId` rule and not the doc failing to qualify at all.
    const withoutContext = await related({ q: 'huddle notes' });
    expect(withoutContext.matches.map((m) => m.id)).toContain(huddleDocId);
  });

  it('refuses a request with no query, naming what to pass', async () => {
    const res = await fetch(`${base}/api/workspaces/${wsId}/related-work?q=%20%20`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe('q required');
    expect(body.hint).toContain('?q=');
  });

  it('404s on a board that does not exist', async () => {
    const res = await fetch(`${base}/api/workspaces/w-nope/related-work?q=meeting%20notes`);
    expect(res.status).toBe(404);
  });

  it('honours a caller-supplied limit', async () => {
    const body = await related({ q: 'meeting notes plan huddle', limit: '1' });
    expect(body.matches.length).toBe(1);
  });

  it('never reaches another board, even for a request that board is exactly about', async () => {
    // Scoping, asserted from both sides. The route reads goals and docs; a
    // filter that missed either one would leak a neighbouring board's work
    // into this board's answer, and the caller would file a clarifying
    // question about a goal nobody here can see.
    const otherRes = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'billing', goal: 'Invoices that reconcile.' }),
    });
    const otherWs = ((await otherRes.json()) as { workspace: { id: string } }).workspace.id;

    const otherGoals = await seedGoalsOverHttp(
      base,
      otherWs,
      [{ key: 'refund', title: 'Bryan can refund a duplicate invoice without a support ticket' }],
      PERSON,
    );
    const refundGoal = otherGoals.refund ?? '';
    handle.tasks.updateGoalBodySnapshot(
      refundGoal,
      'A duplicate invoice should be refundable from the billing page, with the reason recorded.',
    );
    const refundDoc = await makeDoc(
      'duplicate-invoice-refund-plan',
      'Duplicate invoice refund plan',
      join(dataDir, 'duplicate-invoice-refund-plan.md'),
      '# Duplicate invoice refund plan\n\nHow a duplicate invoice is refunded.\n',
      otherWs,
    );

    const q = 'Plan how Bryan refunds a duplicate invoice without a support ticket';

    // The positive control, and the reason the negative below means anything:
    // asked of the board that owns them, both rows come back. So they are
    // matchable text, and their absence next door is scoping rather than a
    // scoring miss.
    const owning = await relatedOn(otherWs, { q });
    expect(owning.matches.map((m) => m.id)).toContain(refundGoal);
    expect(owning.matches.map((m) => m.id)).toContain(refundDoc);

    const neighbour = await related({ q });
    expect(neighbour.matches.map((m) => m.id)).not.toContain(refundGoal);
    expect(neighbour.matches.map((m) => m.id)).not.toContain(refundDoc);
    // ...and this board did weigh its own rows, so the answer is not empty
    // because the route gave up before looking.
    expect(neighbour.considered).toBeGreaterThan(0);
  });
});
