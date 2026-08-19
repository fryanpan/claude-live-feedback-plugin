/**
 * Joining a task's OWNER to the session that did the work.
 *
 * A task records its owner as a display name (`Search Revamp`); an attachment
 * records an identity id (`agent-search-revamp`, or whatever the attaching
 * session passed). `attachedAgentTest` already reconciles the two — but it
 * answers only yes/no, so the board can say what an owner IS and still not
 * say when that session was last seen. This is the reader that returns the
 * MATCHING attachment rather than a boolean.
 *
 * Two things under test that are easy to get wrong and expensive to get
 * wrong:
 *
 *  - The reserved owners (`agent`, `human`) must resolve to NO session. They
 *    are shared or unnamed by construction — measured on the live board, one
 *    generic identity carried 858 activity events across multiple distinct
 *    sessions — so a join on them attributes one session's work to another.
 *    Silence is the correct answer; a confident wrong name is not.
 *  - `endpoint` is a host-machine field and must never ride along. The
 *    session payload names its fields one at a time instead of spreading the
 *    attachment, and the route test asserts the endpoint's absence on the RAW
 *    body. That assertion is not decorative: swapping the allow-list for a
 *    spread was measured putting the endpoint on every agent-owned row of the
 *    board read, and this is the test that caught it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { attachedAgentResolver, attachedAgentTest } from '../src/task-owner.ts';

/** A synthetic host-machine endpoint. Must never reach a session payload. */
const ENDPOINT = 'http://127.0.0.1:9099/hooks/agent-relay';

function att(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    agentId,
    workspaceId: 'ws-atlas',
    lastHeartbeat: 1_000,
    lastToolCallAt: 2_000,
    ...extra,
  };
}

describe('attachedAgentResolver', () => {
  it('returns the attachment for a display name whose id form is on the roster', () => {
    const resolve = attachedAgentResolver([att('agent-search-revamp')]);
    expect(resolve('Search Revamp')?.agentId).toBe('agent-search-revamp');
  });

  it('matches the other spellings a roster holds in the field', () => {
    // A hand-supplied slug, and the display name stored verbatim. Both occur
    // on real boards; matching only the derived id matches almost none.
    expect(attachedAgentResolver([att('quick-build')])('Quick Build')?.agentId).toBe('quick-build');
    expect(attachedAgentResolver([att('Surveyor')])('  surveyor ')?.agentId).toBe('Surveyor');
  });

  it('POSITIVE CONTROL: picks the right attachment out of several, not just any', () => {
    // Without this, a resolver that returned the first entry regardless would
    // pass every test above.
    const resolve = attachedAgentResolver([
      att('agent-cartographer', { lastToolCallAt: 11 }),
      att('agent-search-revamp', { lastToolCallAt: 22 }),
      att('agent-surveyor', { lastToolCallAt: 33 }),
    ]);
    expect(resolve('Search Revamp')?.agentId).toBe('agent-search-revamp');
    expect(resolve('Search Revamp')?.lastToolCallAt).toBe(22);
    expect(resolve('Cartographer')?.lastToolCallAt).toBe(11);
    expect(resolve('Surveyor')?.lastToolCallAt).toBe(33);
  });

  it('returns nothing for an owner no attachment vouches for', () => {
    expect(attachedAgentResolver([att('agent-cartographer')])('Search Revamp')).toBeUndefined();
    expect(attachedAgentResolver([])('Search Revamp')).toBeUndefined();
    expect(attachedAgentResolver([att('agent-cartographer')])('   ')).toBeUndefined();
  });

  it('refuses the RESERVED owners even when the roster holds their id form', () => {
    // This is the case that makes a "last seen" line lie. `agentIdCandidates`
    // maps the bare word `agent` onto `known-agent`, which is the identity
    // every session with no configured name collapses into — so a roster
    // holding it would match a task owned by any of them.
    expect(attachedAgentResolver([att('known-agent')])('agent')).toBeUndefined();
    expect(attachedAgentResolver([att('agent')])('agent')).toBeUndefined();
    expect(attachedAgentResolver([att('known-agent')])('AGENT')).toBeUndefined();
    // `human` means "a person, unnamed" — never a session, whatever a roster says.
    expect(attachedAgentResolver([att('human')])('human')).toBeUndefined();
  });

  it('hands back the attachment itself, redaction left to the layer that serves it', () => {
    // Deliberately NOT stripping `endpoint` here. This resolver answers
    // "which attachment", and a matcher that also redacted would be two jobs
    // in one and a second place for the redaction rule to live. The stripping
    // is `publicAttachment`'s, and the assertion that it happened belongs
    // with the payload that goes over the wire — see `ownerSessionReader`.
    const hit = attachedAgentResolver([att('agent-search-revamp', { endpoint: ENDPOINT })])(
      'Search Revamp',
    );
    expect(hit?.agentId).toBe('agent-search-revamp');
  });
});

describe('attachedAgentTest still answers the question it always did', () => {
  // It is now expressed in terms of the resolver, so these are the guard
  // against that refactor changing an answer.
  it('keeps its existing yes/no behaviour', () => {
    expect(attachedAgentTest(['agent-cartographer'])('Cartographer')).toBe(true);
    expect(attachedAgentTest(['quick-build'])('Quick Build')).toBe(true);
    expect(attachedAgentTest(['Surveyor'])('  surveyor ')).toBe(true);
    expect(attachedAgentTest([])('Cartographer')).toBe(false);
    expect(attachedAgentTest(['agent-cartographer'])('   ')).toBe(false);
    expect(attachedAgentTest(['agent-cartographer'])('Search Revamp')).toBe(false);
  });
});

describe('the owning session over the real routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const AUTHOR = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-owner-session-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('names the session behind an agent-owned row, and nobody behind the others', async () => {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'atlas', goal: 'Ship the atlas.' }),
    );
    const wsId = workspace.id;

    // The shape the DEFAULT attach path produces: a session sends its
    // identity id, never its display name. The task below is owned by the
    // DISPLAY NAME, so this pair is the whole join under test.
    await jj(
      await post(`/api/workspaces/${wsId}/attachments`, {
        agentId: 'agent-cartographer',
        runtime: 'claude-code-local',
        capabilities: ['tasks.write'],
        endpoint: ENDPOINT,
        pluginVersion: '0.1.67',
      }),
    );

    const mk = async (assignee: string) =>
      jj<{ task: { id: string } }>(
        await post(`/api/workspaces/${wsId}/tasks`, {
          title: `owned by ${assignee}`,
          assignee,
          author: AUTHOR,
        }),
      );

    const owned = await mk('Cartographer');
    const person = await mk('human');
    const stranger = await mk('Ada Fenwick');

    const res = await fetch(`${base}/api/workspaces/${wsId}/tasks`);
    const raw = await res.clone().text();
    const { tasks } = await jj<{ tasks: Array<Record<string, unknown>> }>(res);
    const byId = new Map(tasks.map((t) => [t.id as string, t]));

    // The join lands: a display-name owner reaches its id-keyed attachment.
    const session = byId.get(owned.task.id)?.ownerSession as Record<string, unknown>;
    expect(session).toBeDefined();
    expect(session.agentId).toBe('agent-cartographer');
    expect(typeof session.lastHeartbeat).toBe('number');
    expect(typeof session.lastToolCallAt).toBe('number');
    expect(session.state).toBe('active');
    expect(session.pluginVersion).toBe('0.1.67');

    // ...and does not land where no session can honestly be named. These are
    // the assertions the positive control above makes meaningful — on a
    // response carrying no sessions at all they would pass for free.
    expect(byId.get(person.task.id)?.ownerSession).toBeUndefined();
    expect(byId.get(stranger.task.id)?.ownerSession).toBeUndefined();

    // The host-machine endpoint never rides along, on any row. Asserted on
    // the raw body rather than the parsed object so a nested copy anywhere
    // in the payload still trips it.
    expect(raw).toContain('agent-cartographer');
    expect(raw).not.toContain('9099');
    expect(raw).not.toContain('hooks/agent-relay');
  });
});
