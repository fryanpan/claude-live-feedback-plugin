/**
 * The one reading of a task-create body, tested directly.
 *
 * `parseTaskCreate` sits between two routes (`POST .../tasks` and
 * `.../tasks/batch`) and the store, and it is the layer nothing type-checks:
 * every field arrives as `unknown` off the wire. Until now it was exercised
 * only THROUGH those routes, which means a field the routes never send was
 * covered by nothing — and the module's own doc comment names two fields that
 * already drifted that way (`groups` accepted and discarded, `actor` never
 * forwarded).
 *
 * These drive the parsers with the bodies a caller can actually send, and
 * assert what comes out: the refusal a bad field earns, the value a good one
 * produces, and — for the two fields that are deliberately forgiving — what
 * survives a partially-bad input.
 */
import { describe, expect, it } from 'bun:test';
import {
  BAD_NEEDS_ERROR,
  BAD_OPTIONS_ERROR,
  BAD_ORIGIN_ERROR,
  BAD_REF_ERROR,
  BAD_REVIEW_ERROR,
  BAD_TITLE_ERROR,
  BATCH_REF_OUTSIDE_BATCH_ERROR,
  createdVisibility,
  parseLinks,
  parseNeeds,
  parseOptions,
  parseOrigin,
  parseReview,
  parseTaskCreate,
} from '../src/task-create.ts';
import { ASSIGNEE_REQUIRED_ERROR, GENERIC_ASSIGNEE } from '../src/task-owner.ts';
import { type Ref, UNTITLED_TASK_TITLE } from '../src/tasks.ts';

const alice = { id: 'u-alice', name: 'Alice', kind: 'human' };

/** A body that parses, so each test can vary exactly one field. */
const ok = (extra: Record<string, unknown> = {}) => ({ title: 'Ship the thing', ...extra });

/** The parse result, or a failure loud enough to read in the runner. */
function opts(
  raw: unknown,
  author: typeof alice | undefined = alice,
  board?: { leadAgentId?: string },
) {
  const res = parseTaskCreate(raw, author, board);
  if (!res.ok) throw new Error(`expected a parse, got ${res.error}: ${res.message ?? ''}`);
  return res;
}

describe('parseNeeds', () => {
  it('passes the two spellings the decisions strip keys on', () => {
    expect(parseNeeds('action')).toEqual({ ok: true, needs: 'action' });
    expect(parseNeeds('decision')).toEqual({ ok: true, needs: 'decision' });
  });

  it('says nothing when the caller said nothing', () => {
    expect(parseNeeds(undefined)).toEqual({ ok: true });
  });

  it('refuses a capitalized spelling rather than storing it verbatim', () => {
    // The exact defect the validation exists for: `'Decision'` stored as-is
    // produces a task absent from the strip, absent from
    // list_tasks(needs:'decision'), and refused by answer_decision — on a 200.
    expect(parseNeeds('Decision').ok).toBe(false);
    expect(parseNeeds('decisions').ok).toBe(false);
    expect(parseNeeds(null).ok).toBe(false);
    expect(parseNeeds(7).ok).toBe(false);
  });
});

describe('parseOptions', () => {
  it('keeps the labels and the optional detail', () => {
    expect(parseOptions([{ label: 'Ship it' }, { label: 'Hold', detail: 'until Friday' }])).toEqual(
      {
        ok: true,
        options: [{ label: 'Ship it' }, { label: 'Hold', detail: 'until Friday' }],
      },
    );
  });

  it('omits detail entirely rather than storing an undefined key', () => {
    const res = parseOptions([{ label: 'A' }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(Object.keys(res.options?.[0] ?? {})).toEqual(['label']);
  });

  it('refuses the WHOLE list when one option is bad — a dropped option is a choice never offered', () => {
    expect(parseOptions([{ label: 'Ship it' }, { label: '   ' }]).ok).toBe(false);
    expect(parseOptions([{ label: 'Ship it' }, { label: 5 }]).ok).toBe(false);
    expect(parseOptions([{ label: 'Ship it' }, { label: 'Hold', detail: 9 }]).ok).toBe(false);
    expect(parseOptions([{ label: 'Ship it' }, null]).ok).toBe(false);
    expect(parseOptions('Ship it').ok).toBe(false);
  });

  it('accepts an empty list and an absent field', () => {
    expect(parseOptions([])).toEqual({ ok: true, options: [] });
    expect(parseOptions(undefined)).toEqual({ ok: true });
  });
});

describe('parseReview', () => {
  it('normalizes the agent-facing spellings into the stored vocabulary', () => {
    const res = parseReview({
      review_type: 'question',
      headline: 'Does the pacing shape read right?',
      detail: 'The drain now asserts an event sequence instead of elapsed time.',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.review?.shape).toBe('review');
  });

  it('treats an absent or null review as no review, not as a bad one', () => {
    expect(parseReview(undefined)).toEqual({ ok: true });
    expect(parseReview(null)).toEqual({ ok: true });
  });

  it('refuses a payload the checker refuses, and says why', () => {
    const res = parseReview({ headline: 'No type given' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message.length).toBeGreaterThan(0);
  });

  it('advises without refusing when the payload is thin', () => {
    // The non-refusing half: gaps ride back on the 200. An author who is
    // never told writes the same thin item again.
    const res = parseReview({ review_type: 'question', headline: 'Look at this' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.advice === undefined || res.advice.length > 0).toBe(true);
  });
});

describe('parseLinks', () => {
  it('keeps the good refs and reports the bad ones instead of refusing', () => {
    const good = { kind: 'task', taskId: 't-1' } satisfies Ref;
    const res = parseLinks([good, { kind: 'task' }, { kind: 'url', url: 'javascript:alert(1)' }]);
    expect(res).toEqual({
      ok: true,
      links: [good],
      ignored: [{ kind: 'task' }, { kind: 'url', url: 'javascript:alert(1)' }],
    });
  });

  it('refuses only when links is not an array at all', () => {
    expect(parseLinks({ kind: 'task', taskId: 't-1' }).ok).toBe(false);
    expect(parseLinks(undefined)).toEqual({ ok: true, ignored: [] });
  });

  it('a url ref must be http(s) — the ref reaches the DOM as an href', () => {
    const res = parseLinks([{ kind: 'url', url: 'https://example.com/x' }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.links).toHaveLength(1);
  });
});

describe('parseOrigin', () => {
  it('reads an absent or null origin as no origin', () => {
    expect(parseOrigin(undefined)).toEqual({ ok: true });
    expect(parseOrigin(null)).toEqual({ ok: true });
  });

  it('refuses a malformed origin — it is payload, and there is no good half to keep', () => {
    expect(parseOrigin({ kind: 'url', url: 'javascript:alert(1)' }).ok).toBe(false);
    expect(parseOrigin({ kind: 'nope' }).ok).toBe(false);
    expect(parseOrigin('t-1').ok).toBe(false);
  });

  it('keeps a well-formed one', () => {
    const origin = { kind: 'thread', docId: 'd-1', threadId: 'th-1' } satisfies Ref;
    expect(parseOrigin(origin)).toEqual({ ok: true, origin });
  });
});

describe('createdVisibility', () => {
  it('says nothing when there is nothing to warn about', () => {
    // A note that is always there is a note nobody reads.
    expect(createdVisibility('todo', false)).toBeUndefined();
  });

  it('names the transition that makes a triage row dispatchable', () => {
    expect(createdVisibility('triage', false)).toContain('task_transition');
  });

  it('states that a review item is already queued even on an unvetted row', () => {
    const note = createdVisibility('triage', true);
    expect(note).toContain('task_transition');
    expect(note).toContain('already');
  });

  it('a held plan draft replaces the triage sentence, not adds to it', () => {
    // A held draft cannot be transitioned out, so pointing at task_transition
    // would send the caller to a door that refuses.
    const note = createdVisibility('triage', false, true);
    expect(note).toContain('plan doc is approved');
    expect(note).not.toContain('task_transition');
  });
});

describe('parseTaskCreate — refusals', () => {
  it('refuses a blank title unless the caller declares the row untitled', () => {
    expect(parseTaskCreate({ title: '   ' }, alice)).toMatchObject({
      ok: false,
      error: BAD_TITLE_ERROR,
    });
    expect(parseTaskCreate({}, alice)).toMatchObject({ ok: false, error: BAD_TITLE_ERROR });
    expect(opts({ untitled: true }).opts.title).toBe(UNTITLED_TASK_TITLE);
  });

  it('a real title beside untitled:true wins, and the row is not marked untitled', () => {
    const res = opts(ok({ untitled: true }));
    expect(res.opts.title).toBe('Ship the thing');
    expect(res.opts.untitled).toBeUndefined();
  });

  it('reports the first bad field with the error that field earns', () => {
    expect(parseTaskCreate(ok({ needs: 'Decision' }), alice)).toMatchObject({
      error: BAD_NEEDS_ERROR,
    });
    expect(parseTaskCreate(ok({ options: [{ label: '' }] }), alice)).toMatchObject({
      error: BAD_OPTIONS_ERROR,
    });
    expect(parseTaskCreate(ok({ review: { headline: 'x' } }), alice)).toMatchObject({
      error: BAD_REVIEW_ERROR,
    });
    expect(parseTaskCreate(ok({ links: 'nope' }), alice)).toMatchObject({ error: BAD_REF_ERROR });
    expect(parseTaskCreate(ok({ origin: 'nope' }), alice)).toMatchObject({
      error: BAD_ORIGIN_ERROR,
    });
  });

  it('names a batch-local reference that reached a body with no batch around it', () => {
    // Passing "#seed" through as a task id earns `unknown-after`, which sends
    // the caller hunting for a task that was never the problem.
    const res = parseTaskCreate(ok({ after: ['#seed'] }), alice);
    expect(res).toMatchObject({ ok: false, error: BATCH_REF_OUTSIDE_BATCH_ERROR });
    if (!res.ok) expect(res.message).toContain('#seed');
    expect(parseTaskCreate(ok({ afterEnforce: ['#seed'] }), alice)).toMatchObject({
      error: BATCH_REF_OUTSIDE_BATCH_ERROR,
    });
  });

  it('refuses a create that would belong to nobody', () => {
    expect(parseTaskCreate(ok(), undefined)).toMatchObject({
      ok: false,
      error: ASSIGNEE_REQUIRED_ERROR,
    });
    expect(parseTaskCreate(ok({ assignee: GENERIC_ASSIGNEE }), undefined)).toMatchObject({
      ok: false,
      error: ASSIGNEE_REQUIRED_ERROR,
    });
  });
});

describe('parseTaskCreate — who ends up owning the row', () => {
  it('falls back to the caller when no assignee is named', () => {
    expect(opts(ok()).opts.assignee).toBe('Alice');
  });

  it('an explicit assignee wins over the caller', () => {
    expect(opts(ok({ assignee: 'Bo' })).opts.assignee).toBe('Bo');
  });

  it("assignToLead hands the errand to the board's lead, as an agent", () => {
    const res = opts(ok({ assignToLead: true }), alice, { leadAgentId: 'Conductor' });
    expect(res.opts.assignee).toBe('Conductor');
    // The one case the kind is known without being said: the lead seat is an agent's.
    expect(res.opts.assigneeKind).toBe('agent');
  });

  it('an explicit assignee beside assignToLead still wins — naming somebody says more', () => {
    const res = opts(ok({ assignToLead: true, assignee: 'Bo' }), alice, {
      leadAgentId: 'Conductor',
    });
    expect(res.opts.assignee).toBe('Bo');
  });

  it('assignToLead with no lead files at triage owned by nobody, not by the asker', () => {
    // The author fallback would hand the errand back to the person who asked,
    // which is the exact outcome the flag exists to prevent.
    const res = opts(ok({ assignToLead: true }), alice);
    expect(res.opts.assignee).toBe(GENERIC_ASSIGNEE);
    expect(res.opts.fileToTriage).toBe(true);
  });

  it('leaves assigneeKind unset when the caller said nothing, rather than guessing from the name', () => {
    expect(opts(ok({ assignee: 'Bo' })).opts.assigneeKind).toBeUndefined();
  });

  it('carries a declared assigneeKind through, and refuses one it does not know', () => {
    expect(opts(ok({ assignee: 'Bo', assigneeKind: 'agent' })).opts.assigneeKind).toBe('agent');
    expect(parseTaskCreate(ok({ assigneeKind: 'robot' }), alice).ok).toBe(false);
  });
});

describe('parseTaskCreate — what reaches the store', () => {
  it('trims the title and forwards the caller as the actor', () => {
    const res = opts({ title: '  Ship the thing  ' });
    expect(res.opts.title).toBe('Ship the thing');
    expect(res.opts.actor).toEqual(alice);
  });

  it('omits actor entirely when there is no author — a UI with no session yet', () => {
    // Called directly, not through `opts`: a default parameter treats an
    // explicit `undefined` as "not passed", which would quietly restore Alice
    // and make this assertion pass against the wrong input.
    const res = parseTaskCreate(ok({ assignee: 'Bo' }), undefined);
    expect(res.ok).toBe(true);
    if (res.ok) expect('actor' in res.opts).toBe(false);
  });

  it('leaves an omitted goal undefined, which is what routes the row through triage', () => {
    expect(opts(ok()).opts.goal).toBeUndefined();
    expect(opts(ok({ goal: 'chores' })).opts.goal).toBe('chores');
  });

  it('only triage:true means anything — false is not an assertion that the row is ready', () => {
    expect(opts(ok({ triage: true })).opts.fileToTriage).toBe(true);
    expect(opts(ok({ triage: false })).opts.fileToTriage).toBeUndefined();
  });

  it('takes numbers only for the numeric fields', () => {
    expect(opts(ok({ order: 3, dueAt: 1_700_000_000_000 })).opts).toMatchObject({
      order: 3,
      dueAt: 1_700_000_000_000,
    });
    const junk = opts(ok({ order: '3', dueAt: 'tomorrow' })).opts;
    expect(junk.order).toBeUndefined();
    expect(junk.dueAt).toBeUndefined();
  });

  it('takes arrays only for the dependency fields', () => {
    expect(opts(ok({ after: ['t-1'], afterEnforce: ['t-2'] })).opts).toMatchObject({
      after: ['t-1'],
      afterEnforce: ['t-2'],
    });
    expect(opts(ok({ after: 't-1' })).opts.after).toBeUndefined();
  });

  it('reports dropped links beside a task that was still created', () => {
    const res = opts(ok({ links: [{ kind: 'task', taskId: 't-1' }, { kind: 'task' }] }));
    expect(res.opts.links).toEqual([{ kind: 'task', taskId: 't-1' }]);
    expect(res.ignoredLinks).toEqual([{ kind: 'task' }]);
  });

  it('hands the review back BESIDE the store options, never inside them', () => {
    // A review item is a row that hangs on the task once it has an id.
    // Folding it into CreateTaskOpts would give "attach a review item" a
    // second implementation, free to disagree with the first.
    const res = opts(
      ok({ review: { review_type: 'question', headline: 'Does this read right?' } }),
    );
    expect(res.review).toBeDefined();
    expect('review' in res.opts).toBe(false);
  });
});
