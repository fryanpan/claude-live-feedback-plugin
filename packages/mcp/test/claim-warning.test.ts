/**
 * The queue names who is already on a row (#329) — this is the half that
 * says it AT THE MOMENT OF THE CLAIM.
 *
 * On 2026-08-17 two sessions each built a complete answer to one task and
 * neither could detect the other. The server now returns `ownerSession` and
 * `claimedBy` on every queue row, but a dispatcher only reads the queue once
 * and then transitions rows for the rest of the session — so the presence
 * read and the pickup decision are separated by however long the session
 * runs. `task_transition` to in-progress is where the collision actually
 * happens, and it said nothing.
 *
 * INFORMATIONAL, ALWAYS. Nothing here refuses a second taker: two agents on
 * one row is sometimes right, and that collision is what produced two designs
 * whose disagreement made the choice legible. What it must not be is
 * invisible.
 *
 * All fixtures are synthetic.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type PresenceRow, claimWarning } from '../src/claim-warning.ts';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const NOW = 1_700_000_000_000;
const ME = 'claim-surfacing';

/** Another session, heartbeat fresh and observed working 40s ago. */
const PEER = {
  agentId: 'row-presence',
  lastHeartbeat: NOW - 20_000,
  lastToolCallAt: NOW - 40_000,
  state: 'active' as const,
  stateLabel: 'active',
};

const ROW: PresenceRow = { id: 't-K69wx', title: 'Ship the search revamp' };

describe('claimWarning', () => {
  // Positive control: everything below that asserts undefined is vacuous
  // unless this module can produce a warning at all.
  it('warns when another live session already claimed the row', () => {
    const line = claimWarning({ ...ROW, claimedBy: { ...PEER, at: NOW - 12 * 60_000 } }, ME, NOW);
    expect(line).toBeDefined();
    expect(line).toContain('row-presence');
    expect(line).toContain('t-K69wx');
  });

  it('warns when the row is owned by another live session', () => {
    const line = claimWarning({ ...ROW, ownerSession: PEER }, ME, NOW);
    expect(line).toBeDefined();
    expect(line).toContain('row-presence');
  });

  // The whole instruction. A warning that names a session and does not say
  // what to do with it is a fact the reader steps over.
  it('tells the taker to coordinate over hive rather than start the row', () => {
    const line = claimWarning({ ...ROW, ownerSession: PEER }, ME, NOW) ?? '';
    expect(line.toLowerCase()).toContain('hive');
    expect(line.toLowerCase()).toContain('do not start');
  });

  // It is a warning, never a gate — and it has to SAY so, or the next agent
  // reads it as a refusal and drops work it was allowed to do.
  it('says out loud that nothing is being refused', () => {
    const line = claimWarning({ ...ROW, ownerSession: PEER }, ME, NOW) ?? '';
    expect(line.toLowerCase()).toContain('refus');
  });

  it('says how long ago the claim was made and when that session was last seen', () => {
    const line =
      claimWarning({ ...ROW, claimedBy: { ...PEER, at: NOW - 12 * 60_000 } }, ME, NOW) ?? '';
    expect(line).toContain('12m');
    expect(line).toContain('40s');
  });

  // `claimedBy` is the actor on the row; `ownerSession` is whoever the ticket
  // is filed under. When they disagree the actor is the one to talk to.
  it('names the claimant, not the owner, when both are present', () => {
    const line =
      claimWarning(
        {
          ...ROW,
          ownerSession: { ...PEER, agentId: 'filed-the-ticket' },
          claimedBy: { ...PEER, agentId: 'working-it', at: NOW - 60_000 },
        },
        ME,
        NOW,
      ) ?? '';
    expect(line).toContain('working-it');
    expect(line).not.toContain('filed-the-ticket');
  });

  // CONTROL: a free row's result must be unchanged. This is the assertion
  // that keeps the warning from becoming noise on every pickup.
  it('is silent on a row nobody is on', () => {
    expect(claimWarning(ROW, ME, NOW)).toBeUndefined();
  });

  it('is silent when the session on the row is this one', () => {
    expect(
      claimWarning({ ...ROW, claimedBy: { ...PEER, agentId: ME, at: NOW - 60_000 } }, ME, NOW),
    ).toBeUndefined();
    expect(
      claimWarning({ ...ROW, ownerSession: { ...PEER, agentId: ME } }, ME, NOW),
    ).toBeUndefined();
  });

  // A heartbeat is the whole signal. An owner the server has not heard from
  // is an owner in name only, and warning about it would fire on every stale
  // row on the board — which is how a warning gets skimmed.
  it('is silent when the session on the row has gone away', () => {
    expect(
      claimWarning({ ...ROW, ownerSession: { ...PEER, state: 'away' } }, ME, NOW),
    ).toBeUndefined();
  });

  // Deliberate: `unresponsive` is process-up-agent-wedged, which is exactly
  // the row somebody SHOULD take over. Warning there fires on the case where
  // picking it up is the right move.
  it('is silent when the session on the row is unresponsive', () => {
    expect(
      claimWarning({ ...ROW, claimedBy: { ...PEER, state: 'unresponsive', at: NOW } }, ME, NOW),
    ).toBeUndefined();
  });

  it('reads as a sentence when the row carries no title', () => {
    const line = claimWarning({ id: 't-K69wx', ownerSession: PEER }, ME, NOW) ?? '';
    expect(line).toContain('t-K69wx');
    expect(line).not.toContain('undefined');
    expect(line).not.toContain('NaN');
  });

  it('truncates a very long title instead of flooding the result', () => {
    const line =
      claimWarning({ ...ROW, title: 'x'.repeat(200), ownerSession: PEER }, ME, NOW) ?? '';
    expect(line).not.toContain('x'.repeat(200));
    // The instruction is the half a reader acts on — truncation must never
    // eat it.
    expect(line.toLowerCase()).toContain('hive');
  });
});

/**
 * The presence guidance now lives in the `working-in-a-workspace` SKILL rather
 * than in the `next_tasks` description. It is the same knowledge, moved to the
 * surface that loads on demand instead of the one every session pays for on
 * every turn — so this suite reads the skill, and `next_tasks` only has to
 * point at the field. The `next_tasks` half is read off the running bundle's
 * `tools/list` in the describe below, which is the text an agent is actually
 * handed.
 */
describe('the queue tells an agent who is already on a row', () => {
  const SKILL = readFileSync(
    join(HERE, '../../plugin/skills/working-in-a-workspace/SKILL.md'),
    'utf8',
  );

  it('names both presence fields', () => {
    expect(SKILL).toContain('ownerSession');
    expect(SKILL).toContain('claimedBy');
  });

  // The fields without the instruction are two more keys to skim. What has to
  // reach the reader is what a live claim MEANS.
  it('says not to start a row a live session holds, and to use hive instead', () => {
    expect(SKILL).toContain('DO NOT START THAT ROW');
    expect(SKILL).toContain('claude-hive');
  });

  it('says the presence read refuses nobody, so it does not read as a gate', () => {
    expect(SKILL).toContain('Nothing refuses a second taker');
  });

  // `away` / `unresponsive` are not live claims, and guidance that treated any
  // presence as a hold would stop pickups it should not.
  it('distinguishes an active session from an away or wedged one', () => {
    expect(SKILL).toContain('away');
    expect(SKILL).toContain('unresponsive');
  });
});

/**
 * Peers load `packages/plugin/mcp/index.js`, so a source-only change reaches
 * nobody — and this is the half that says the shipped artifact does the work.
 *
 * It is also, since the source-shape sweep, the ONLY half. The wiring claims
 * that used to be made by slicing `case 'task_transition': {` out of the
 * concatenated source — that presence is read before the move and only on a
 * pickup, that the warning is additive, that nothing refuses on presence —
 * are all observable from outside: the order of the requests the bundle
 * makes, and the payload it answers with. A `toContain` over the handler text
 * could not tell a computed warning from a discarded one, could not see a
 * source edit that was never rebuilt, and went red on a rename that changed
 * nothing.
 *
 * It used to be four `BUNDLE.toContain(...)` assertions. Every one of them
 * would have passed on a bundle whose `claimNoticeFor` call was deleted, on a
 * warning built and then dropped on the floor, and on a description string no
 * client is ever handed — the literals survive all three. So it now runs the
 * bundle over stdio: the guidance is what `tools/list` returns, and the
 * warning is what a real `task_transition` answers with.
 *
 * The board must be one this session has attached to: `claimNoticeFor` reads
 * presence per attached board and answers silence otherwise (attachments.ts),
 * so `attach_agent` first is the flow, not ceremony.
 */
describe('the built bundle carries it', () => {
  const NOW_ROW = {
    id: 't-K69wx',
    title: 'Ship the search revamp',
    claimedBy: {
      agentId: 'row-presence',
      at: Date.now() - 12 * 60_000,
      lastHeartbeat: Date.now() - 20_000,
      lastToolCallAt: Date.now() - 40_000,
      state: 'active',
      stateLabel: 'active',
    },
  };

  it('declares the queue guidance and warns at the moment of the claim', async () => {
    let h: BundleHarness | undefined;
    try {
      h = await startBundle((req) => {
        if (req.method === 'GET' && req.path.endsWith('/next')) return { tasks: [NOW_ROW] };
        if (req.path.endsWith('/transition'))
          return { task: { id: 't-K69wx', status: 'in-progress' }, blockers: [] };
        return {};
      });

      // The declaration a real MCP client receives, not a string in a file.
      const decl = h.tool('next_tasks');
      expect(decl, 'the bundle declares no next_tasks tool').toBeDefined();
      expect(JSON.stringify(decl)).toContain('claimedBy is an active session that is not you');
      // Negative control for the probe: a phrase that is not there must not
      // be found, or the assertion above proves nothing about this bundle.
      expect(JSON.stringify(decl)).not.toContain('DO NOT START THAT COLUMN');

      await h.call('attach_agent', { workspaceId: 'w-stub' });
      const claim = await h.call('task_transition', { taskId: 't-K69wx', to: 'in-progress' });

      // The status the caller always got is untouched — the warning is
      // additive, which is the whole compat argument above.
      expect(claim.isError).toBe(false);
      expect((claim.json as { status?: string }).status).toBe('in-progress');

      const warning = (claim.json as { warning?: string }).warning ?? '';
      expect(warning).toContain('[claim]');
      expect(warning).toContain('row-presence');
      expect(warning).toContain('message that session over claude-hive');
      expect(warning).toContain('Nothing here refuses you');

      // Nothing the caller already got is disturbed: the warning is ADDITIVE,
      // which is the whole compat argument for an old session that cannot
      // restart. `blockers` is the field beside it that a caller reads.
      expect((claim.json as { blockers?: unknown }).blockers).toEqual([]);

      // Presence is read BEFORE the move — after it, the latest claim is this
      // session's own.
      const queueRead = claim.sent.findIndex((r) => r.method === 'GET' && r.path.endsWith('/next'));
      const transition = claim.sent.findIndex((r) => r.path.endsWith('/transition'));
      expect(queueRead, `no presence read; sent ${JSON.stringify(claim.sent)}`).toBeGreaterThan(-1);
      expect(queueRead).toBeLessThan(transition);
    } finally {
      await h?.stop();
    }
  }, 60_000);

  it('CONTROL: says nothing on a row nobody is on', async () => {
    // Without this, the assertions above could be satisfied by a bundle that
    // warns on every pickup — which is how a warning stops being read.
    let h: BundleHarness | undefined;
    try {
      h = await startBundle((req) => {
        if (req.method === 'GET' && req.path.endsWith('/next'))
          return { tasks: [{ id: 't-K69wx', title: 'Ship the search revamp' }] };
        if (req.path.endsWith('/transition'))
          return { task: { id: 't-K69wx', status: 'in-progress' }, blockers: [] };
        return {};
      });
      await h.call('attach_agent', { workspaceId: 'w-stub' });
      const claim = await h.call('task_transition', { taskId: 't-K69wx', to: 'in-progress' });
      expect((claim.json as { warning?: string }).warning).toBeUndefined();
    } finally {
      await h?.stop();
    }
  }, 60_000);

  it('CONTROL: reads presence only on a pickup, not on every transition', async () => {
    // A presence read on `done` is a round trip nobody needs, and it would
    // also mean the "before the move" ordering above proved nothing about
    // pickups in particular.
    let h: BundleHarness | undefined;
    try {
      h = await startBundle((req) => {
        if (req.method === 'GET' && req.path.endsWith('/next')) return { tasks: [NOW_ROW] };
        if (req.path.endsWith('/transition'))
          return { task: { id: 't-K69wx', status: 'done' }, blockers: [] };
        return {};
      });
      await h.call('attach_agent', { workspaceId: 'w-stub' });
      const done = await h.call('task_transition', { taskId: 't-K69wx', to: 'done' });
      expect(done.sent.filter((r) => r.method === 'GET' && r.path.endsWith('/next'))).toEqual([]);
      expect((done.json as { warning?: string }).warning).toBeUndefined();
    } finally {
      await h?.stop();
    }
  }, 60_000);
});
