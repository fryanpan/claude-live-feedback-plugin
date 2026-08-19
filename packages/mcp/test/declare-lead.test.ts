/**
 * Declaring yourself lead is ONE call.
 *
 * The failure this closes: an agent held the lead seat, watched six docs by
 * hand, and believed it was listening. It had never attached. A voice note
 * and a re-triage request queued SILENTLY — no error, no dropped-event
 * warning — because "am I subscribed?" is not a question an agent can answer
 * from the inside. Silence from a subscription you never made looks exactly
 * like nobody having commented.
 *
 * So `set_workspace_lead` with no `leadAgentId` (or with your own) now means
 * DECLARE: attach, subscribe, take the seat, and hand back whatever was
 * waiting — in one round trip, with no second call owed.
 *
 * The asymmetry below is the correctness rule, not a style choice: naming
 * SOMEBODY ELSE must not forge an attachment for them. A forged attachment
 * makes `hasLiveLeadAttachment` true for a session that is not there, and the
 * voice notes it "delivers" go to nobody — the exact bug this ticket exists
 * to end, reintroduced one layer down where it is harder to see.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import { declareWorkspaceLead } from '../src/declare-lead.ts';
import { RETRIAGE_SKILL, TASK_REVIEW_SKILL } from '../src/triage-line.ts';

const SELF = { id: 'agent-self', name: 'Self Agent', kind: 'agent' };
const WS = 'ws-1';

type Call = { kind: 'http' | 'watch'; method?: string; path?: string; body?: unknown };

/** A stub HTTP layer that records every call in order, so the ORDER of the
 *  three steps is testable and not merely their presence. */
function harness(responses: { attach?: unknown; lead?: unknown } = {}) {
  const calls: Call[] = [];
  const deps = {
    http: async (method: string, path: string, body?: unknown): Promise<unknown> => {
      calls.push({ kind: 'http', method, path, body });
      if (path.endsWith('/attachments')) {
        return responses.attach ?? { attachment: { agentId: SELF.id }, lead: true };
      }
      if (path.endsWith('/lead')) {
        return responses.lead ?? { changed: true, workspace: { leadAgentId: SELF.id } };
      }
      throw new Error(`unexpected path ${path}`);
    },
    watchWorkspace: async (workspaceId: string): Promise<boolean> => {
      calls.push({ kind: 'watch', path: workspaceId });
      return true;
    },
    self: SELF,
    runtime: 'claude-code-local',
    pluginVersion: '0.1.65',
  };
  return { calls, deps };
}

/** The recorded sequence, compact enough to assert whole. */
const shape = (calls: Call[]) =>
  calls.map((c) => (c.kind === 'watch' ? `watch ${c.path}` : `${c.method} ${c.path}`));

describe('declareWorkspaceLead — declaring yourself', () => {
  it('attaches, subscribes, then takes the seat, in that order', async () => {
    const { calls, deps } = harness();
    await declareWorkspaceLead({ workspaceId: WS }, deps);

    // Attach FIRST: the attachment record is what hasLiveLeadAttachment
    // reads, and setLeadAgent only re-delivers a waiting ask to a lead that
    // is already live.
    //
    // Watch BEFORE the seat change, not after: setLeadAgent CLEARS a pending
    // re-triage the moment it hands it to a live lead, and it hands it over
    // the workspace channel. Subscribing afterwards would drop that first
    // delivery on the floor and clear it at the same time — the very
    // silent-loss shape this whole tool change is closing.
    expect(shape(calls)).toEqual([
      `POST /api/workspaces/${WS}/attachments`,
      `watch ${WS}`,
      `PUT /api/workspaces/${WS}/lead`,
    ]);
  });

  it('attaches as itself, reporting the bundle it is running', async () => {
    const { calls, deps } = harness();
    await declareWorkspaceLead({ workspaceId: WS }, deps);
    const attach = calls.find((c) => c.path?.endsWith('/attachments'));
    expect(attach?.body).toMatchObject({
      agentId: SELF.id,
      runtime: 'claude-code-local',
      pluginVersion: '0.1.65',
    });
    const lead = calls.find((c) => c.path?.endsWith('/lead'));
    expect(lead?.body).toMatchObject({ leadAgentId: SELF.id, author: SELF });
  });

  it('hands back the drained backlog on the same response, with the skill contracts', async () => {
    const { deps } = harness({
      attach: {
        attachment: { agentId: SELF.id },
        lead: true,
        gating: { summary: 'no open gating decisions' },
        untriaged: ['t-7'],
        queuedVoice: [{ transcript: 'make the second goal the top one', ts: 11 }],
        pendingRetriage: {
          batchId: 'b-1',
          oldGoal: 'old',
          newGoal: 'new',
          taskIds: ['t-1', 't-2'],
        },
        pendingBucketReview: {
          batchId: 'b-2',
          newBands: [{ id: 'g-9', title: 'Reliability' }],
          taskIds: ['t-3'],
        },
        taskReviews: [{ taskId: 't-4', trigger: 'created', ts: 12 }],
      },
    });
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);

    expect(res.workspaceId).toBe(WS);
    expect(res.leadAgentId).toBe(SELF.id);
    expect(res.lead).toBe(true);
    expect(res.untriaged).toEqual(['t-7']);
    expect(res.gating).toEqual({ summary: 'no open gating decisions' });
    expect(res.queuedVoice).toEqual([{ transcript: 'make the second goal the top one', ts: 11 }]);
    // Same field names AND the same contracts attach_agent hands over — an
    // away lead that arrives through this door must not be told half of what
    // one arriving through the other door is told.
    expect(res.pendingRetriage).toMatchObject({ batchId: 'b-1', contract: RETRIAGE_SKILL });
    expect(res.pendingBucketReview).toMatchObject({ batchId: 'b-2' });
    expect(res.taskReviews).toEqual([{ taskId: 't-4', trigger: 'created', ts: 12 }]);
    expect(res.taskReviewContract).toBe(TASK_REVIEW_SKILL);
  });

  it('says it is subscribed, so the agent can tell from the inside', async () => {
    const { deps } = harness();
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);
    expect(res.subscribed).toBe(true);
  });

  it('reports the seat as the server settled it', async () => {
    const { deps } = harness({ lead: { changed: false, workspace: { leadAgentId: SELF.id } } });
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);
    expect(res.changed).toBe(false);
    expect(res.leadAgentId).toBe(SELF.id);
  });
});

describe('POSITIVE CONTROL — handing the seat to somebody else is unchanged', () => {
  it('issues only the PUT: no attachment forged, no watch opened', async () => {
    const { calls, deps } = harness({
      lead: { changed: true, workspace: { leadAgentId: 'agent-other' } },
    });
    const res = await declareWorkspaceLead({ workspaceId: WS, leadAgentId: 'agent-other' }, deps);

    expect(shape(calls)).toEqual([`PUT /api/workspaces/${WS}/lead`]);
    expect(res).toEqual({ workspaceId: WS, changed: true, leadAgentId: 'agent-other' });
    // Nothing may claim this session subscribed on somebody else's behalf.
    expect(res.subscribed).toBeUndefined();
    expect(res.queuedVoice).toBeUndefined();
  });
});

describe('POSITIVE CONTROL — the legacy payload keeps its meaning', () => {
  it('an explicit self id behaves identically to the omitted form', async () => {
    const omitted = harness();
    const omittedRes = await declareWorkspaceLead({ workspaceId: WS }, omitted.deps);

    const explicit = harness();
    const explicitRes = await declareWorkspaceLead(
      { workspaceId: WS, leadAgentId: SELF.id },
      explicit.deps,
    );

    expect(shape(explicit.calls)).toEqual(shape(omitted.calls));
    expect(explicit.calls).toEqual(omitted.calls);
    expect(explicitRes).toEqual(omittedRes);
  });

  it('surrounding whitespace on a self id is still self', async () => {
    const { calls, deps } = harness();
    await declareWorkspaceLead({ workspaceId: WS, leadAgentId: `  ${SELF.id}  ` }, deps);
    expect(shape(calls)[0]).toBe(`POST /api/workspaces/${WS}/attachments`);
  });
});

describe('the tool schema widened rather than narrowed', () => {
  it('set_workspace_lead no longer requires leadAgentId', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/mcp.ts'),
      'utf8',
    );
    const decl = src.slice(src.indexOf("name: 'set_workspace_lead'"));
    const schema = decl.slice(0, decl.indexOf('\n    },'));
    // Old bundles keep sending leadAgentId; the field stays, it just stops
    // being mandatory. A narrowing here would break callers that cannot be
    // restarted.
    expect(schema).toContain('leadAgentId');
    expect(schema).toContain("required: ['workspaceId']");
    expect(schema).not.toContain("required: ['workspaceId', 'leadAgentId']");
  });
});
