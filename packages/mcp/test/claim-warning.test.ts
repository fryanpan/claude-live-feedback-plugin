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

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
/** Peers load the BUNDLE, not the source. A green build step is not evidence
 *  the artifact carries the change. */
const BUNDLE = readFileSync(join(HERE, '../../plugin/mcp/index.js'), 'utf8');

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

/** The `case 'x': {` block for one tool, up to the next case. */
function handlerFor(tool: string): string {
  const start = SRC.indexOf(`case '${tool}': {`);
  expect(start, `no handler for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  return rest.slice(0, rest.indexOf('case '));
}

/** The declaration block for one tool, up to the next tool entry. */
function declarationFor(tool: string): string {
  const start = SRC.indexOf(`name: '${tool}',\n      description:`);
  expect(start, `no declaration for ${tool}`).toBeGreaterThan(-1);
  const rest = SRC.slice(start);
  return rest.slice(0, rest.indexOf('},\n    {'));
}

/**
 * Source-read rather than behavioral, like tool-wiring.test.ts: mcp.ts is a
 * bundle entry point and exports nothing.
 */
describe('the queue tells an agent who is already on a row', () => {
  const decl = declarationFor('next_tasks');

  it('names both presence fields', () => {
    expect(decl).toContain('ownerSession');
    expect(decl).toContain('claimedBy');
  });

  // The fields without the instruction are two more keys to skim. What has to
  // reach the reader is what a live claim MEANS.
  it('says not to start a row a live session holds, and to use hive instead', () => {
    expect(decl).toContain('DO NOT START THAT ROW');
    expect(decl).toContain('claude-hive');
  });

  it('says the presence read refuses nobody, so it does not read as a gate', () => {
    expect(decl).toContain('Nothing refuses a second taker');
  });

  // `away` / `unresponsive` are not live claims, and a description that
  // treated any presence as a hold would stop pickups it should not.
  it('distinguishes an active session from an away or wedged one', () => {
    expect(decl).toContain('away');
    expect(decl).toContain('unresponsive');
  });
});

describe('claiming a row says who was already on it', () => {
  const handler = handlerFor('task_transition');

  it('reads presence before the move, and only on a pickup', () => {
    expect(handler).toContain("to === 'in-progress' ? await claimNoticeFor(taskId)");
    // BEFORE: after the transition the latest claim is this session's own.
    expect(handler.indexOf('claimNoticeFor')).toBeLessThan(handler.indexOf('/transition'));
  });

  it('adds the warning to the result without changing anything already there', () => {
    expect(handler).toContain('warning: claimNotice');
    for (const kept of [
      'status: res.task.status',
      'blockers: res.blockers',
      'unproven: res.unproven',
    ])
      expect(handler).toContain(kept);
  });

  // The whole compat argument: an old bundle calling this route from a
  // session that cannot restart must read what it always did. A refusal here
  // would be that narrowing.
  it('never refuses on presence', () => {
    expect(handler).not.toContain('claimNotice) return err');
    expect(handler).not.toContain('if (claimNotice) return');
  });
});

/**
 * Peers load `packages/plugin/mcp/index.js`. Comments are stripped and only
 * runtime strings survive, so these needles are whole literal spans that do
 * not cross a `${...}` boundary.
 */
describe('the built bundle carries it', () => {
  it('can see a literal that is really there (positive control)', () => {
    expect(BUNDLE.length).toBeGreaterThan(1000);
    expect(BUNDLE).toContain('claimedBy');
  });

  it('cannot see a literal that is not (negative control)', () => {
    expect(BUNDLE).not.toContain('DO NOT START THAT COLUMN');
  });

  it('ships the next_tasks guidance', () => {
    expect(BUNDLE).toContain('DO NOT START THAT ROW');
    expect(BUNDLE).toContain('Nothing refuses a second taker');
  });

  it('ships the claim-time warning', () => {
    expect(BUNDLE).toContain('[claim]');
    expect(BUNDLE).toContain('message that session over claude-hive');
    expect(BUNDLE).toContain('Nothing here refuses you');
  });
});
