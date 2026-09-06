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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declareWorkspaceLead } from '../src/declare-lead.ts';
import { type BundleHarness, startBundle } from './harness/mcp-bundle.ts';

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
      if (path.endsWith('/agents')) {
        return responses.attach ?? { attachment: { agentId: SELF.id }, lead: true };
      }
      if (path.endsWith('/lead')) {
        return responses.lead ?? { changed: true, workspace: { leadAgentId: SELF.id } };
      }
      throw new Error(`unexpected path ${path}`);
    },
    watchWorkspace: async (workspaceId: string): Promise<{ open: boolean; persisted: boolean }> => {
      calls.push({ kind: 'watch', path: workspaceId });
      return { open: true, persisted: true };
    },
    self: SELF,
    runtime: 'claude-code-local',
    pluginVersion: '0.1.65',
    processId: 'proc-test-1',
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
      `POST /workspaces/${WS}/agents`,
      `watch ${WS}`,
      `PUT /workspaces/${WS}/lead`,
    ]);
  });

  it('attaches as itself, reporting the bundle it is running', async () => {
    const { calls, deps } = harness();
    await declareWorkspaceLead({ workspaceId: WS }, deps);
    const attach = calls.find((c) => c.path?.endsWith('/agents'));
    expect(attach?.body).toMatchObject({
      agentId: SELF.id,
      runtime: 'claude-code-local',
      pluginVersion: '0.1.65',
      // The per-process nonce: what lets the server tell a live process
      // re-declaring from a fresh one, so this attach cannot re-hand rows
      // whose frames are already in flight to this same session.
      processId: 'proc-test-1',
    });
    const lead = calls.find((c) => c.path?.endsWith('/lead'));
    expect(lead?.body).toMatchObject({ leadAgentId: SELF.id, author: SELF });
  });

  it('hands back the drained backlog on the same response', async () => {
    const { deps } = harness({
      attach: {
        attachment: { agentId: SELF.id },
        lead: true,
        gating: { summary: 'no open gating decisions' },
        untriaged: ['t-7'],
        queuedVoice: [{ transcript: 'make the second goal the top one', ts: 11 }],
      },
    });
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);

    expect(res.workspaceId).toBe(WS);
    expect(res.leadAgentId).toBe(SELF.id);
    expect(res.lead).toBe(true);
    expect(res.untriaged).toEqual(['t-7']);
    expect(res.gating).toEqual({ summary: 'no open gating decisions' });
    // Same field names attach_agent hands over — an away lead that arrives
    // through this door must not be told half of what one arriving through
    // the other door is told.
    expect(res.queuedVoice).toEqual([{ transcript: 'make the second goal the top one', ts: 11 }]);
  });

  it('says it is subscribed, so the agent can tell from the inside', async () => {
    const { deps } = harness();
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);
    expect(res.subscribed).toBe(true);
    expect(res.subscriptionPersisted).toBe(true);
    expect(res.subscriptionWarning).toBeUndefined();
  });

  /**
   * `subscribed: true` used to be a LITERAL — `watchWorkspace`'s return value
   * was discarded. So a session with no stable identity (CW_AGENT_NAME unset,
   * every watch session-only) and a session whose watches POST 500'd both got
   * a durable-subscription receipt for something that vanishes at the next
   * respawn, under a tool description promising "nothing to redo after a
   * respawn". A receipt for work that did not happen is the same lie this
   * whole readout exists to stop telling.
   */
  it('reports a session-only subscription as exactly that', async () => {
    const { deps } = harness();
    deps.watchWorkspace = async () => ({ open: true, persisted: false });
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);
    // The stream IS open, so events reach this session right now…
    expect(res.subscribed).toBe(true);
    // …and it will NOT come back on its own after a respawn.
    expect(res.subscriptionPersisted).toBe(false);
    expect(String(res.subscriptionWarning)).toContain('respawn');
  });

  /**
   * `startSseLoop` resolves on the first attempt's OUTCOME — a throw or a
   * non-200 counts — and on a 3s cap. So `watchWorkspace` can return with the
   * loop still in backoff and nothing subscribed on `ws~<id>`, after which
   * the seat change makes the server consider a queued re-triage delivered
   * and clear it forever. The ordering cannot prevent that on its own; what
   * it can do is stop claiming otherwise.
   */
  it('does not claim to be subscribed when the stream never opened', async () => {
    const { deps } = harness();
    deps.watchWorkspace = async () => ({ open: false, persisted: true });
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);
    expect(res.subscribed).toBe(false);
    expect(String(res.subscriptionWarning)).toContain('stream');
  });

  /**
   * `lead` was read off the ATTACH response, which is computed before the
   * seat moves — and `attachAgent` claims an EMPTY seat only. So taking the
   * seat from a departed agent answered `leadAgentId: <me>` and `lead: false`
   * in the same payload, and `lead` is the field the skills teach an agent to
   * branch on for "is goal-edit re-triage addressed to me".
   */
  it('reads `lead` from the seat as the server settled it, not from the attach', async () => {
    const { deps } = harness({
      // The seat was held by someone else, so the attach could not claim it…
      attach: { attachment: { agentId: SELF.id }, lead: false },
      // …and the PUT then moved it here.
      lead: {
        changed: true,
        workspace: { leadAgentId: SELF.id },
        previousLeadAgentId: 'agent-departed',
      },
    });
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);
    expect(res.leadAgentId).toBe(SELF.id);
    expect(res.lead).toBe(true);
    // And it says whose seat it was, so a takeover is reportable rather than
    // silent.
    expect(res.previousLeadAgentId).toBe('agent-departed');
  });

  // POSITIVE CONTROL — `lead` still answers false when the seat genuinely
  // ends up elsewhere, so the fix above is "read the seat" and not "always
  // say true".
  it('POSITIVE CONTROL: lead is false when the seat did not come to this session', async () => {
    const { deps } = harness({
      attach: { attachment: { agentId: SELF.id }, lead: false },
      lead: {
        changed: false,
        declined: 'lead-held',
        workspace: { leadAgentId: 'agent-incumbent' },
      },
    });
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);
    expect(res.lead).toBe(false);
    expect(res.leadAgentId).toBe('agent-incumbent');
    // Refused rather than failed: this session is attached and subscribed and
    // is told why it is not the lead, instead of quietly evicting a peer.
    expect(res.declined).toBe('lead-held');
    expect(res.subscribed).toBe(true);
    expect(String(res.note)).toContain('agent-incumbent');
  });

  it('passes takeover through when the caller means it', async () => {
    const { calls, deps } = harness();
    await declareWorkspaceLead({ workspaceId: WS, takeover: true }, deps);
    const lead = calls.find((c) => c.path?.endsWith('/lead'));
    expect(lead?.body).toMatchObject({ takeover: true });
    // POSITIVE CONTROL: absent by default, so a plain declaration cannot
    // evict anyone by accident.
    const plain = harness();
    await declareWorkspaceLead({ workspaceId: WS }, plain.deps);
    expect(plain.calls.find((c) => c.path?.endsWith('/lead'))?.body).not.toMatchObject({
      takeover: true,
    });
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

    expect(shape(calls)).toEqual([`PUT /workspaces/${WS}/lead`]);
    expect(res).toEqual({ workspaceId: WS, changed: true, leadAgentId: 'agent-other' });
    // Nothing may claim this session subscribed on somebody else's behalf.
    expect(res.subscribed).toBeUndefined();
    expect(res.queuedVoice).toBeUndefined();
  });
});

describe('the attach carries the agent NAME, not only its id', () => {
  it('sends agentName so the roster row is written under the display name', async () => {
    const { calls, deps } = harness();
    await declareWorkspaceLead({ workspaceId: WS }, deps);
    const attach = calls.find((c) => c.path?.endsWith('/agents'));
    expect((attach?.body as { agentName?: string }).agentName).toBe(SELF.name);
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
    expect(shape(calls)[0]).toBe(`POST /workspaces/${WS}/agents`);
  });
});

/**
 * The schema and the forward, read off the RUNNING bundle.
 *
 * These three claims used to be made by slicing `name: 'set_workspace_lead'`
 * and `case 'set_workspace_lead'` out of the concatenated source. Two of them
 * are about what a client receives and what the server is sent, and both of
 * those are observable: `tools/list` returns the schema, and the stub records
 * the seat request. The third — that `watchWorkspace` hands back
 * `{ open, persisted }` rather than one boolean — was a `toContain` over a
 * type annotation, and is enforced for real by `bun run typecheck`:
 * `declare-lead.ts` declares that dep signature and `tools/workspace.ts`
 * passes the registry's own function into it, so narrowing the return to a
 * bare boolean fails the typecheck gate rather than this file.
 */
describe('the tool schema widened rather than narrowed', () => {
  let h: BundleHarness;

  beforeAll(async () => {
    h = await startBundle();
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  const schema = () => {
    const decl = h.tool('set_workspace_lead');
    expect(
      decl,
      `set_workspace_lead is not in tools/list (${h.tools.length} listed)`,
    ).toBeDefined();
    return (
      (decl as { inputSchema?: { properties?: Record<string, unknown>; required?: string[] } })
        .inputSchema ?? {}
    );
  };

  it('set_workspace_lead no longer requires leadAgentId', () => {
    // Old bundles keep sending leadAgentId; the field stays, it just stops
    // being mandatory. A narrowing here would break callers that cannot be
    // restarted.
    expect(Object.keys(schema().properties ?? {})).toContain('leadAgentId');
    expect(schema().required).toEqual(['workspaceId']);
  });

  it('POSITIVE CONTROL: the legacy payload is still accepted on the wire', async () => {
    // A schema that merely lists the field proves nothing if the handler
    // refuses it. An old session sends exactly this.
    const res = await h.call('set_workspace_lead', {
      workspaceId: 'ws-1',
      leadAgentId: 'agent-somebody-else',
    });
    expect(res.isError, res.text).toBe(false);
    expect(res.sent.some((r) => r.path.endsWith('/lead'))).toBe(true);
  });

  it('exposes takeover as an OPTIONAL escape hatch, and the handler forwards it', async () => {
    // Refusing to displace a live lead is only safe if there IS a way to say
    // you mean it — otherwise the guard becomes a wall and callers route
    // around it by writing the seat some other way.
    expect(Object.keys(schema().properties ?? {})).toContain('takeover');
    expect(schema().required).toEqual(['workspaceId']);

    // The schema advertising a field the dispatcher drops is worse than no
    // field: the caller reads a documented override and gets a refusal it
    // cannot explain. So read what the server was actually sent.
    const res = await h.call('set_workspace_lead', {
      workspaceId: 'ws-1',
      leadAgentId: 'agent-somebody-else',
      takeover: true,
    });
    const seat = res.sent.find((r) => r.path.endsWith('/lead'));
    expect(seat, `no seat request; sent ${JSON.stringify(res.sent)}`).toBeDefined();
    expect((seat?.body as { takeover?: unknown }).takeover).toBe(true);
  });

  it('CONTROL: takeover is absent, not defaulted, when the caller omits it', async () => {
    // A handler that hard-coded it would pass the assertion above while
    // displacing a live lead on every call that never asked to.
    const res = await h.call('set_workspace_lead', {
      workspaceId: 'ws-1',
      leadAgentId: 'agent-somebody-else',
    });
    const seat = res.sent.find((r) => r.path.endsWith('/lead'));
    expect((seat?.body as { takeover?: unknown }).takeover).toBeUndefined();
  });
});

/**
 * Declaring without a name fails LOUD and before any seat change. The old
 * path took the seat, then reported `subscriptionPersisted: false` on a
 * success response — which is exactly how a live board ended up led by the
 * shared "agent" identity with its watches persisted nowhere.
 */
describe('declareWorkspaceLead — a shared identity is refused before the seat PUT', () => {
  it('issues no HTTP call at all and names CW_AGENT_NAME', async () => {
    const { calls, deps } = harness();
    const res = await declareWorkspaceLead(
      { workspaceId: WS },
      {
        ...deps,
        self: { id: 'known-agent', name: 'Agent', kind: 'agent' },
        identityIsShared: true,
      },
    );
    expect(res.isError).toBe(true);
    expect(String(res.message)).toContain('CW_AGENT_NAME');
    expect(calls).toEqual([]);
  });

  it('POSITIVE CONTROL: a named identity whose persist failed still takes the seat, warning first', async () => {
    const { calls, deps } = harness();
    deps.watchWorkspace = async (workspaceId: string) => {
      calls.push({ kind: 'watch', path: workspaceId });
      return { open: true, persisted: false };
    };
    const res = await declareWorkspaceLead({ workspaceId: WS }, deps);
    expect(res.isError).toBeUndefined();
    expect(shape(calls)).toContain(`PUT /workspaces/${WS}/lead`);
    // The failure is the FIRST thing in the payload, with the remedy beside it.
    expect(Object.keys(res)[0]).toBe('subscriptionPersisted');
    expect(res.subscriptionPersisted).toBe(false);
    expect(String(res.subscriptionWarning)).toMatch(/CW_AGENT_NAME|server/);
  });
});

// The handler side — that a session without CW_AGENT_NAME gets a TOOL ERROR
// from set_workspace_lead and no seat request leaves the process — is
// asserted behaviourally over stdio in declare-lead-handler.test.ts, not by
// grepping mcp.ts for the wiring.
