/**
 * The heartbeat that keeps an attachment live, and the presence read a claim
 * carries.
 *
 * Both were unreachable while they lived in `mcp.ts`. The decision half of
 * the keepalive — which boards are due — is already covered by
 * `attachment-keepalive.test.ts`; what could not be driven was the SENDING:
 * that a due board gets one POST and an undue one gets none, that a failure
 * is swallowed rather than allowed to fail a tool call, and that the claim
 * read stops at the first board holding the row.
 *
 * `createAttachments` takes the HTTP client, this session's identity, the
 * keepalive and the clock as arguments. All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { createAttachmentKeepalive } from '../src/attachment-keepalive.ts';
import { type AttachmentDeps, createAttachments } from '../src/attachments.ts';
import type { PresenceRow } from '../src/claim-warning.ts';

const SELF = 'agent-workspaces';
const INTERVAL = 120_000;

type Sent = { method: string; path: string; body: unknown };

function harness(
  opts: { respond?: (method: string, path: string) => unknown; start?: number } = {},
) {
  let clock = opts.start ?? 1_000_000;
  const sent: Sent[] = [];
  const keepalive = createAttachmentKeepalive({ intervalMs: INTERVAL, now: () => clock });
  const deps: AttachmentDeps = {
    http: async (method, path, body) => {
      sent.push({ method, path, body });
      const answer = opts.respond?.(method, path);
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
    author: { id: SELF },
    keepalive,
    now: () => clock,
  };
  return {
    attachments: createAttachments(deps),
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
    at: () => clock,
  };
}

/** A queue row held live by another session. */
function heldRow(id: string, agentId: string, lastToolCallAt: number): PresenceRow {
  return {
    id,
    title: 'Test the entry file',
    claimedBy: {
      agentId,
      lastHeartbeat: lastToolCallAt,
      lastToolCallAt,
      state: 'active',
      stateLabel: 'active',
      at: lastToolCallAt,
    },
  };
}

describe('a heartbeat goes out only when a board is due', () => {
  it('sends nothing on a board attached a moment ago', async () => {
    const h = harness();
    h.attachments.markAttached('w1');
    await h.attachments.sendDueHeartbeats();
    expect(h.sent).toEqual([]);
  });

  it('sends nothing at all when no board is attached', async () => {
    const h = harness();
    h.advance(INTERVAL * 10);
    await h.attachments.sendDueHeartbeats();
    expect(h.sent).toEqual([]);
  });

  it('sends one POST per due board, stamped with the tool-call time', async () => {
    const h = harness();
    h.attachments.markAttached('w1');
    h.attachments.markAttached('w 2');
    h.advance(INTERVAL);
    await h.attachments.sendDueHeartbeats();
    expect(h.sent).toEqual([
      {
        method: 'POST',
        path: `/workspaces/w1/agents/${SELF}/heartbeat`,
        body: { toolCallAt: h.at() },
      },
      {
        method: 'POST',
        path: `/workspaces/w%202/agents/${SELF}/heartbeat`,
        body: { toolCallAt: h.at() },
      },
    ]);
  });

  it('does not send again until the interval has lapsed once more', async () => {
    const h = harness();
    h.attachments.markAttached('w1');
    h.advance(INTERVAL);
    await h.attachments.sendDueHeartbeats();
    await h.attachments.sendDueHeartbeats();
    expect(h.sent).toHaveLength(1);
    h.advance(INTERVAL);
    await h.attachments.sendDueHeartbeats();
    expect(h.sent).toHaveLength(2);
  });

  it('swallows a failure rather than failing the tool call that carried it', async () => {
    const h = harness({ respond: () => new Error('server down') });
    h.attachments.markAttached('w1');
    h.attachments.markAttached('w2');
    h.advance(INTERVAL);
    await expect(h.attachments.sendDueHeartbeats()).resolves.toBeUndefined();
    // And a board that failed does not stop the next one being tried.
    expect(h.sent).toHaveLength(2);
  });
});

describe('a claim says who is already on the row, or says nothing', () => {
  it('reads the queue of each attached board and renders the holder', async () => {
    const h = harness();
    h.attachments.markAttached('w1');
    const notice = await h.attachments.claimNoticeFor('k1');
    expect(h.sent).toEqual([
      { method: 'GET', path: '/api/workspaces/w1/next?includeBlocked=true', body: undefined },
    ]);
    expect(notice).toBeUndefined();
  });

  it('names the live session holding the row', async () => {
    const h = harness({
      respond: () => ({ tasks: [heldRow('k1', 'agent-peer', 1_000_000 - 60_000)] }),
    });
    h.attachments.markAttached('w1');
    const notice = await h.attachments.claimNoticeFor('k1');
    expect(notice).toContain('agent-peer');
    expect(notice).toContain('IN PROGRESS');
  });

  it('stays silent when the holder is this session', async () => {
    const h = harness({ respond: () => ({ tasks: [heldRow('k1', SELF, 1_000_000)] }) });
    h.attachments.markAttached('w1');
    await expect(h.attachments.claimNoticeFor('k1')).resolves.toBeUndefined();
  });

  it('stops at the first board holding the row', async () => {
    const h = harness({
      respond: (_method, path) =>
        path.startsWith('/api/workspaces/w1/')
          ? { tasks: [heldRow('k1', 'agent-peer', 1_000_000)] }
          : { tasks: [] },
    });
    h.attachments.markAttached('w1');
    h.attachments.markAttached('w2');
    await h.attachments.claimNoticeFor('k1');
    expect(h.sent.map((s) => s.path)).toEqual(['/api/workspaces/w1/next?includeBlocked=true']);
  });

  it('carries on to the next board when one read fails, then answers nothing', async () => {
    const h = harness({
      respond: (_method, path) =>
        path.startsWith('/api/workspaces/w1/') ? new Error('board gone') : { tasks: [] },
    });
    h.attachments.markAttached('w1');
    h.attachments.markAttached('w2');
    await expect(h.attachments.claimNoticeFor('k1')).resolves.toBeUndefined();
    expect(h.sent).toHaveLength(2);
  });

  it('answers nothing when this session is attached to no board', async () => {
    const h = harness();
    await expect(h.attachments.claimNoticeFor('k1')).resolves.toBeUndefined();
    expect(h.sent).toEqual([]);
  });
});
