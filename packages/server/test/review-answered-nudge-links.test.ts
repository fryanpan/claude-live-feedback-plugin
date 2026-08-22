/**
 * The `workspace.review_answered` wake, rendered from the frames the SERVER
 * really sends rather than from hand-written fixtures.
 *
 * Same lesson as `decision-answered-line.test.ts` next door, one hop further
 * out. That suite could read its rows back from `events.jsonl`; this one
 * cannot, because a nudge is a DELIVERY rather than a change and deliberately
 * never reaches the audit log (see ready-nudge.ts). So the read-back surface
 * here is the wire itself: an attached lead holding its SSE stream, and the
 * addressed frame that arrives on it.
 *
 * That distinction is the whole reason this test exists. The clause under
 * test is about a field — `links` — that the frame did not carry at all until
 * now, and a fixture asserting `links: []` would have proved the renderer
 * guards a key nobody sends. Only the real frame can tell those apart.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NudgePayload, reviewAnsweredLine } from '../../mcp/src/nudge-line.ts';
import { REVIEW_ANSWERED_EVENT } from '../src/ready-nudge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

const CLAUSE = 'walk its links as the propagation checklist';

type Frame = { event: string; data?: Record<string, unknown> };

/** Read a workspace stream, keeping every frame's event name and payload.
 *  Same reader as `ready-nudge-routes.test.ts` — a nudge is addressed, so
 *  nothing short of a real stream can observe one. */
function listenFrames(res: Response): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe('the review_answered wake only sends its reader to links that exist', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;
  let lead: ReturnType<typeof listenFrames>;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** Fail with the server's own words rather than with `undefined` three
   *  lines later — a setup that quietly 400s is how a wake test passes by
   *  never having a board to wake. */
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-answered-links-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const { workspace } = await jj<{ workspace: { id: string; leadAgentId?: string } }>(
      await post('/api/workspaces', { name: 'index-rebuild', leadAgentId: LEAD.id }),
    );
    workspaceId = workspace.id;
    expect(workspace.leadAgentId).toBe(LEAD.id);
    await jj(
      await post(`/api/workspaces/${workspaceId}/attachments`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    const leadRes = await fetch(
      `${base}/events/workspace/${workspaceId}?agentId=${encodeURIComponent(LEAD.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    lead = listenFrames(leadRes);
    await settle();
  });

  afterEach(async () => {
    await lead.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** File a decision row carrying `links`, have a person answer it, and hand
   *  back the frame the lead's stream actually received. */
  async function answeredFrame(links: unknown[]): Promise<Frame> {
    const before = lead.frames.filter((f) => f.event === REVIEW_ANSWERED_EVENT).length;
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title: 'Rebuild the index now or after the freeze?',
        assignee: 'human',
        needs: 'decision',
        body: 'Now or after the freeze? Now costs a night of downtime; after the freeze slips the search work a week. Blocked until answered: the query-latency fix.',
        links,
        author: LEAD,
      }),
    );
    // Jordan answers, so the lead is a different party and does get woken.
    await jj(
      await post(`/api/tasks/${task.id}/answer`, { text: 'After the freeze.', author: PERSON }),
    );
    await settle();
    const got = lead.frames.filter((f) => f.event === REVIEW_ANSWERED_EVENT);
    // A wake that never arrived would render nothing, which makes every
    // assertion below vacuous.
    expect(got.length, 'no review_answered frame reached the lead').toBe(before + 1);
    const frame = got[before] as Frame;
    expect(frame.data?.taskId).toBe(task.id);
    return frame;
  }

  it('carries the answered row links and offers the checklist when it has them', async () => {
    const frame = await answeredFrame([{ kind: 'doc', docId: 'search-plan' }]);
    expect(frame.data?.links).toEqual([{ kind: 'doc', docId: 'search-plan' }]);

    const line = reviewAnsweredLine(frame.data as NudgePayload);
    // Positive control: the line renders at all, naming the row it is about.
    expect(line).toContain('[workspace.review_answered]');
    expect(line).toContain('Rebuild the index now or after the freeze?');
    expect(line).toContain('read it and act on it now');
    expect(line).toContain(CLAUSE);
  });

  it('carries an empty list and says nothing about links when the row has none', async () => {
    const frame = await answeredFrame([]);
    // The field is present and empty — which is what makes this the real
    // case rather than a server that simply never sent the key.
    expect(frame.data?.links).toEqual([]);

    const line = reviewAnsweredLine(frame.data as NudgePayload);
    // Same positive control, so "no clause" cannot be "no line".
    expect(line).toContain('[workspace.review_answered]');
    expect(line).toContain('Rebuild the index now or after the freeze?');
    expect(line).toContain('read it and act on it now');
    expect(line).not.toContain(CLAUSE);
    // …and nothing is left dangling where the clause used to sit.
    expect(line.trimEnd()).toBe(line);
    expect(line).not.toMatch(/[;—]\s*\.?$/);
  });
});
