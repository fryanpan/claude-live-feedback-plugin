/**
 * Person or agent, for an owner that has a NAME.
 *
 * Two layers, because either alone is the "true but proves nothing about the
 * caller" shape this repo has shipped before:
 *
 *  - the pure decision (`resolveOwnerKind` / `declaredAssigneeKind`), table
 *    tested including the contradiction cases, which is where the ordering
 *    rule actually lives;
 *  - the same decision driven over real HTTP and read back out of the ydoc
 *    projection the board renders from — the layer that catches a param the
 *    tool declares and the route silently drops.
 *
 * Every absence assertion sits next to a positive control on the same read:
 * "this task is not a person's" is worthless on a projection that carries no
 * tasks at all.
 *
 * All fixtures are synthetic — invented names, invented agent ids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { attachedAgentTest, declaredAssigneeKind, resolveOwnerKind } from '../src/task-owner.ts';
import { workspaceRoomId } from '../src/task-projection.ts';
import type { Task } from '../src/tasks.ts';

const NOBODY_ATTACHED = () => false;
const ALWAYS_ATTACHED = () => true;

describe('resolveOwnerKind', () => {
  it('reads the reserved literal as a person and a bare category as unknown', () => {
    expect(resolveOwnerKind('human', undefined, NOBODY_ATTACHED)).toBe('person');
    expect(resolveOwnerKind('HUMAN', undefined, NOBODY_ATTACHED)).toBe('person');
    // Not "person by default": nobody holds a task owned by a word.
    expect(resolveOwnerKind('agent', undefined, NOBODY_ATTACHED)).toBe('unknown');
    expect(resolveOwnerKind('   ', undefined, NOBODY_ATTACHED)).toBe('unknown');
  });

  it('answers unknown for a named owner nobody has declared', () => {
    // The whole point of the third state. A guess here would be silently
    // wrong for somebody, and the board would keep drawing a plausible mark.
    expect(resolveOwnerKind('Ada Fenwick', undefined, NOBODY_ATTACHED)).toBe('unknown');
  });

  it('honours a stored declaration in both directions', () => {
    expect(resolveOwnerKind('Ada Fenwick', 'person', NOBODY_ATTACHED)).toBe('person');
    expect(resolveOwnerKind('Ada Fenwick', 'agent', NOBODY_ATTACHED)).toBe('agent');
  });

  it('lets an attachment outrank a person declaration on the same name', () => {
    // The collision case, and the direction is deliberate: an agent filed as
    // a person inflates the one strip built to stay short, where a person
    // filed as an agent only drops a row out of a view.
    expect(resolveOwnerKind('Cartographer', 'person', ALWAYS_ATTACHED)).toBe('agent');
    // Case- and space-insensitive, because the roster and the assignee are
    // both hand-typed display names.
    const attached = (n: string) => n.trim().toLowerCase() === 'cartographer';
    expect(resolveOwnerKind('  CARTOGRAPHER ', 'person', attached)).toBe('agent');
  });

  it('keeps the reserved human owner a person against contradictory input', () => {
    // `human` MEANS "a person, unnamed" — it is not a display name an agent
    // could also hold, so the agent-signals-first rule does not reach it.
    // Below the roster check this resolved to `agent`, which dropped the row
    // out of every person-owned surface and disagreed with the client's own
    // reading of the same literal.
    expect(resolveOwnerKind('human', 'agent', NOBODY_ATTACHED)).toBe('person');
    expect(resolveOwnerKind('human', 'agent', ALWAYS_ATTACHED)).toBe('person');
    // Positive control: agent-first still holds for an actual NAME.
    expect(resolveOwnerKind('Cartographer', 'agent', NOBODY_ATTACHED)).toBe('agent');
  });

  it('does not let an attachment claim the unowned word', () => {
    // A roster that answered true for everything must still not turn "nobody
    // holds this" into "an agent holds this".
    expect(resolveOwnerKind('agent', undefined, ALWAYS_ATTACHED)).toBe('unknown');
  });
});

describe('attachedAgentTest', () => {
  // A task records a DISPLAY NAME; an attachment records an identity id.
  // Comparing the two directly is what made the roster half of this feature
  // dead in production while every test that attached under the display name
  // passed — so each spelling the field actually produces gets a row.
  it('matches the id the default attach path sends', () => {
    const roster = attachedAgentTest(['agent-cartographer']);
    expect(roster('Cartographer')).toBe(true);
    // Positive control for the negative below: this roster matches something.
    expect(roster('Ada Fenwick')).toBe(false);
  });

  it('matches a hand-supplied slug and a display-name id too', () => {
    expect(attachedAgentTest(['lighthouse'])('Lighthouse')).toBe(true);
    expect(attachedAgentTest(['Surveyor'])('  surveyor ')).toBe(true);
  });

  it('never matches on an empty roster, or on an empty name', () => {
    expect(attachedAgentTest([])('Cartographer')).toBe(false);
    expect(attachedAgentTest(['agent-cartographer'])('   ')).toBe(false);
  });
});

describe('declaredAssigneeKind', () => {
  const agentAuthor = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
  const personAuthor = { id: 'known-ada', name: 'Ada Fenwick', kind: 'known' };

  it('takes an explicit declaration over everything else', () => {
    expect(declaredAssigneeKind('Ada Fenwick', 'person', agentAuthor)).toBe('person');
    expect(declaredAssigneeKind('Ada Fenwick', 'PERSON', agentAuthor)).toBe('person');
    expect(declaredAssigneeKind('Ada Fenwick', 'nonsense', undefined)).toBeUndefined();
  });

  it('classifies an author assigning to ITSELF, and nobody else', () => {
    expect(declaredAssigneeKind('Cartographer', undefined, agentAuthor)).toBe('agent');
    expect(declaredAssigneeKind('Ada Fenwick', undefined, personAuthor)).toBe('person');
    // A hand-over to somebody else declares NOTHING — which is what makes a
    // re-assign clear the previous owner's kind instead of inheriting it.
    expect(declaredAssigneeKind('Ada Fenwick', undefined, agentAuthor)).toBeUndefined();
  });
});

describe('owner kind over the real routes', () => {
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

  const AGENT = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

  async function seedWorkspace(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'atlas', goal: 'Ship the atlas.' }),
    );
    return workspace.id;
  }

  /** What the BOARD sees — the ydoc projection, not the REST payload. The
   *  browser renders from this map and from nothing else, so a field that is
   *  correct in the store and absent here is invisible on the surface. */
  function projected(wsId: string, taskId: string): Record<string, unknown> | undefined {
    const room = handle.rooms.get(workspaceRoomId(wsId));
    return room?.ydoc.getMap('tasks').get(taskId) as Record<string, unknown> | undefined;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-owner-kind-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('projects person / agent / unknown, and tells a named person from a named agent', async () => {
    const wsId = await seedWorkspace();
    await jj(
      await post(`/api/workspaces/${wsId}/attachments`, {
        // The shape the DEFAULT attach path produces: `attach_agent` sends
        // the session's identity id, never its display name. Attaching as
        // 'Cartographer' here is what let the roster half of this feature
        // pass every test while matching nothing in production.
        agentId: 'agent-cartographer',
        runtime: 'claude-code-local',
        capabilities: ['tasks.write'],
      }),
    );

    const mk = async (assignee: string, assigneeKind?: string): Promise<Task> => {
      const { task } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${wsId}/tasks`, {
          title: `owned by ${assignee}`,
          assignee,
          ...(assigneeKind !== undefined ? { assigneeKind } : {}),
          author: AGENT,
        }),
      );
      return task;
    };

    const unnamed = await mk('human');
    const namedAgent = await mk('Cartographer');
    const undeclared = await mk('Ada Fenwick');
    const declared = await mk('Ada Fenwick', 'person');

    // Positive control: the projection carries these rows at all.
    expect(projected(wsId, unnamed.id)?.title).toBe('owned by human');
    expect(projected(wsId, declared.id)?.title).toBe('owned by Ada Fenwick');

    expect(projected(wsId, unnamed.id)?.ownerKind).toBe('person');
    // The attachment vouches for it; nobody had to declare anything.
    expect(projected(wsId, namedAgent.id)?.ownerKind).toBe('agent');
    // The bug this task is about: a named person used to be indistinguishable
    // from a named agent. Assert BOTH sides of the pair on one read.
    expect(projected(wsId, declared.id)?.ownerKind).toBe('person');
    expect(projected(wsId, declared.id)?.ownerKind).not.toBe(
      projected(wsId, namedAgent.id)?.ownerKind,
    );
    // …and an undeclared name is neither, rather than quietly benign.
    expect(projected(wsId, undeclared.id)?.ownerKind).toBe('unknown');
  });

  it('forwards assigneeKind through POST /api/tasks/:id/assignee', async () => {
    // The route layer is the one nothing type-checks. A param the tool
    // declares and the route drops returns 200 and changes nothing.
    const wsId = await seedWorkspace();
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'turn the tunnel on',
        assignee: 'Cartographer',
        author: AGENT,
      }),
    );
    expect(projected(wsId, task.id)?.ownerKind).toBe('agent');

    const handed = await jj<{ changed: boolean }>(
      await post(`/api/tasks/${task.id}/assignee`, {
        assignee: 'Ada Fenwick',
        assigneeKind: 'person',
        author: AGENT,
      }),
    );
    expect(handed.changed).toBe(true);
    expect(projected(wsId, task.id)?.ownerKind).toBe('person');
  });

  it('clears the previous owner’s kind on an undeclared hand-over', async () => {
    const wsId = await seedWorkspace();
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'merge the branch',
        assignee: 'Ada Fenwick',
        assigneeKind: 'person',
        author: AGENT,
      }),
    );
    expect(projected(wsId, task.id)?.ownerKind).toBe('person');

    await jj(
      await post(`/api/tasks/${task.id}/assignee`, { assignee: 'Rowan Iles', author: AGENT }),
    );
    // Inheriting would label Rowan a person on nobody's authority.
    expect(projected(wsId, task.id)?.ownerKind).toBe('unknown');
  });

  it('accepts a kind-only declaration on a task whose owner is not changing', async () => {
    // Without this, the one call that fixes an existing row is swallowed as a
    // no-op while answering ok:true — the shape of failure this codebase
    // calls "the call didn't error".
    const wsId = await seedWorkspace();
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'write the migration note',
        assignee: 'Ada Fenwick',
        author: AGENT,
      }),
    );
    expect(projected(wsId, task.id)?.ownerKind).toBe('unknown');

    const res = await jj<{ changed: boolean }>(
      await post(`/api/tasks/${task.id}/assignee`, {
        assignee: 'Ada Fenwick',
        assigneeKind: 'person',
        author: AGENT,
      }),
    );
    expect(res.changed).toBe(true);
    expect(projected(wsId, task.id)?.ownerKind).toBe('person');
  });

  it('keeps a declared kind when a caller re-states the same owner without one', async () => {
    // Every caller written before this field existed sends no `assigneeKind`.
    // If a re-assign to the SAME name cleared the declaration, an ordinary
    // hand-back would silently downgrade a known person to "not recorded" —
    // a write that changes something nobody asked to change.
    const wsId = await seedWorkspace();
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'read the survey notes',
        assignee: 'Ada Fenwick',
        assigneeKind: 'person',
        author: AGENT,
      }),
    );
    expect(projected(wsId, task.id)?.ownerKind).toBe('person');

    const res = await jj<{ changed: boolean }>(
      await post(`/api/tasks/${task.id}/assignee`, {
        assignee: 'Ada Fenwick',
        author: AGENT,
      }),
    );
    // Nothing changed, and specifically the kind did not.
    expect(res.changed).toBe(false);
    expect(projected(wsId, task.id)?.ownerKind).toBe('person');

    // The positive control that keeps this from being vacuous: the same
    // undeclared call to a DIFFERENT name still clears, so "kept" above is a
    // decision about sameness rather than the writer having stopped working.
    await jj(
      await post(`/api/tasks/${task.id}/assignee`, { assignee: 'Wren Halloway', author: AGENT }),
    );
    expect(projected(wsId, task.id)?.ownerKind).toBe('unknown');
  });

  it('refuses a malformed assigneeKind on every write path that takes one', async () => {
    // 'human' is the plausible mistake, because `assignee: 'human'` is the
    // canonical spelling of the field directly above it. Dropped silently it
    // answers 200, the row lands undeclared, and the board draws "not
    // recorded" with nothing anywhere saying why.
    const wsId = await seedWorkspace();
    const create = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'plot the shoreline',
      assignee: 'Ada Fenwick',
      assigneeKind: 'human',
      author: AGENT,
    });
    expect(create.status).toBe(400);
    expect(((await create.json()) as { error: string }).error).toBe('bad-assignee-kind');

    // Positive control on the same route: the valid spelling still lands.
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'plot the shoreline',
        assignee: 'Ada Fenwick',
        assigneeKind: 'person',
        author: AGENT,
      }),
    );
    expect(projected(wsId, task.id)?.ownerKind).toBe('person');

    const handOver = await post(`/api/tasks/${task.id}/assignee`, {
      assignee: 'Rowan Iles',
      assigneeKind: 'human',
      author: AGENT,
    });
    expect(handOver.status).toBe(400);
    // …and the refusal did not half-apply: the owner is untouched.
    expect(projected(wsId, task.id)?.assignee).toBe('Ada Fenwick');
  });

  it('tells the caller what the board resolved, on the write and on the read', async () => {
    // An agent cannot read the ydoc, so without an echo "my declaration
    // landed" and "the call didn't error" are the same observation.
    const wsId = await seedWorkspace();
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'name the ridge',
        assignee: 'Ada Fenwick',
        author: AGENT,
      }),
    );

    const listed = await jj<{ tasks: Array<{ id: string; ownerKind: string }> }>(
      await fetch(`${base}/api/workspaces/${wsId}/tasks`),
    );
    expect(listed.tasks.find((t) => t.id === task.id)?.ownerKind).toBe('unknown');

    const handed = await jj<{ ownerKind: string }>(
      await post(`/api/tasks/${task.id}/assignee`, {
        assignee: 'Ada Fenwick',
        assigneeKind: 'person',
        author: AGENT,
      }),
    );
    expect(handed.ownerKind).toBe('person');

    // The sweep query the echo exists for: "which rows read not-recorded"
    // now has a different answer than it did one call ago.
    const after = await jj<{ tasks: Array<{ id: string; ownerKind: string }> }>(
      await fetch(`${base}/api/workspaces/${wsId}/tasks`),
    );
    expect(after.tasks.find((t) => t.id === task.id)?.ownerKind).toBe('person');
  });

  it('re-projects when the agent roster moves, with no task write in between', async () => {
    // The migration half: tasks created long before this field existed carry
    // no declaration, and must still resolve the moment their owner attaches.
    const wsId = await seedWorkspace();
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'rebuild the tile cache',
        assignee: 'Surveyor',
        // Assigned by somebody else, so nothing is declared about Surveyor.
        author: AGENT,
      }),
    );
    expect(projected(wsId, task.id)?.ownerKind).toBe('unknown');

    await jj(
      await post(`/api/workspaces/${wsId}/attachments`, {
        // Production shape again: the owner is `Surveyor`, the attachment is
        // `agent-surveyor`. The migration claim is only true if THOSE match.
        agentId: 'agent-surveyor',
        runtime: 'claude-code-local',
        capabilities: ['tasks.write'],
      }),
    );
    expect(projected(wsId, task.id)?.ownerKind).toBe('agent');

    // …and back, when the roster no longer vouches for it. Unknown, not
    // person: losing evidence is not gaining the opposite evidence.
    const del = await fetch(`${base}/api/workspaces/${wsId}/attachments/agent-surveyor`, {
      method: 'DELETE',
    });
    expect(del.ok).toBe(true);
    expect(projected(wsId, task.id)?.ownerKind).toBe('unknown');
  });
});

/**
 * `assigneeId` beside `assignee`.
 *
 * A task records its owner as whatever the caller typed, and the field
 * measured eight spellings of one agent — `Live Feedback`, `live-feedback`,
 * `agent-live-feedback`… — none of which matched `next_tasks?assignee=<me>`
 * unless the spelling happened to be the caller's own. The roster now
 * resolves the owner to ONE canonical id, stored beside the name on every
 * write and derived at read time for every row written before the field
 * existed. The name stays verbatim: old bundles keep sending it, and it is
 * still what the board draws.
 */
describe('owner id beside the owner name', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const PERSON = { id: 'known-ada', name: 'Ada Fenwick', kind: 'known' };
  const LF = 'agent-live-feedback';

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
  const get = (path: string) => fetch(`${base}${path}`);

  function projected(wsId: string, taskId: string): Record<string, unknown> | undefined {
    const room = handle.rooms.get(workspaceRoomId(wsId));
    return room?.ydoc.getMap('tasks').get(taskId) as Record<string, unknown> | undefined;
  }

  async function seedWorkspace(name: string): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name, goal: 'Ship the atlas.' }),
    );
    return workspace.id;
  }
  const attach = async (wsId: string, agentId: string, agentName: string) =>
    jj(
      await post(`/api/workspaces/${wsId}/attachments`, {
        agentId,
        agentName,
        runtime: 'claude-code-local',
        capabilities: ['tasks.write'],
      }),
    );
  // PERSON author: queueable work (todo), not triage — `/next` skips triage.
  const mk = async (wsId: string, assignee: string): Promise<Task> => {
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        title: `owned by ${assignee}`,
        assignee,
        author: PERSON,
      }),
    );
    return task;
  };
  const ids = async (path: string): Promise<string[]> => {
    const { tasks } = await jj<{ tasks: Array<{ id: string }> }>(await get(path));
    return tasks.map((t) => t.id).sort();
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-owner-id-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('three spellings of one agent store one id, and a stranger stores none', async () => {
    const wsId = await seedWorkspace('spellings');
    await attach(wsId, LF, 'Live Feedback');
    const byName = await mk(wsId, 'Live Feedback');
    const bySlug = await mk(wsId, 'live-feedback');
    const byId = await mk(wsId, LF);
    // Control: a name the roster does not know resolves to nothing, and the
    // row is still filed — the id is beside the name, never instead of it.
    // (Not the author's own name: assigning to yourself declares your kind.)
    const stranger = await mk(wsId, 'Grace Hopper');

    for (const t of [byName, bySlug, byId]) expect(t.assigneeId).toBe(LF);
    expect(byName.assignee).toBe('Live Feedback');
    expect(bySlug.assignee).toBe('live-feedback');
    expect(stranger.assigneeId).toBeUndefined();
    expect(stranger.assignee).toBe('Grace Hopper');

    // The board sees the same id on every spelling…
    for (const t of [byName, bySlug, byId]) expect(projected(wsId, t.id)?.assigneeId).toBe(LF);
    expect(projected(wsId, stranger.id)?.assigneeId).toBeUndefined();
    // …and the resolved owner is an agent even where the attachment id
    // and the typed name share nothing but the roster's word for it.
    expect(projected(wsId, bySlug.id)?.ownerKind).toBe('agent');
    expect(projected(wsId, stranger.id)?.ownerKind).toBe('unknown');

    // `next_tasks` by id — or by any spelling — finds all three and only them.
    const three = [byName.id, bySlug.id, byId.id].sort();
    expect(await ids(`/api/workspaces/${wsId}/next?assignee=${LF}`)).toEqual(three);
    expect(await ids(`/api/workspaces/${wsId}/next?assignee=Live%20Feedback`)).toEqual(three);
    expect(await ids(`/api/workspaces/${wsId}/tasks?assignee=live-feedback`)).toEqual(three);
    // The verbatim filter still works for a name the roster cannot place.
    expect(await ids(`/api/workspaces/${wsId}/tasks?assignee=Grace%20Hopper`)).toEqual([
      stranger.id,
    ]);
    // …and a spelling nobody used and nobody is finds nothing (negative control).
    expect(await ids(`/api/workspaces/${wsId}/next?assignee=agent-nobody`)).toEqual([]);
  });

  it('a row written before the roster knew the agent resolves at read time', async () => {
    const wsId = await seedWorkspace('backfill');
    const old = await mk(wsId, 'Cartographer');
    expect(old.assigneeId).toBeUndefined();
    expect(projected(wsId, old.id)?.assigneeId).toBeUndefined();
    expect(await ids(`/api/workspaces/${wsId}/next?assignee=agent-cartographer`)).toEqual([]);

    await attach(wsId, 'agent-cartographer', 'Cartographer');

    // No task write happened. The stored row is untouched — the projection
    // and the queue derive the id from the roster the moment it can.
    const stored = handle.tasks.getTask(old.id) as Task;
    expect(stored.assigneeId).toBeUndefined();
    expect(projected(wsId, old.id)?.assigneeId).toBe('agent-cartographer');
    expect(projected(wsId, old.id)?.ownerKind).toBe('agent');
    expect(await ids(`/api/workspaces/${wsId}/next?assignee=agent-cartographer`)).toEqual([old.id]);
  });

  it('a merged agent’s rows follow the merge without a rewrite', async () => {
    const wsId = await seedWorkspace('merge');
    await attach(wsId, LF, 'Live Feedback');
    await attach(wsId, 'lighthouse', 'Lighthouse');
    const theirs = await mk(wsId, 'Lighthouse');
    expect(theirs.assigneeId).toBe('lighthouse');
    expect(await ids(`/api/workspaces/${wsId}/next?assignee=${LF}`)).toEqual([]);

    await jj(await post('/api/agents/lighthouse/merge', { into: LF, author: PERSON }));

    const stored = handle.tasks.getTask(theirs.id) as Task;
    // Still the id it was written with — history is never rewritten…
    expect(stored.assigneeId).toBe('lighthouse');
    expect(stored.assignee).toBe('Lighthouse');
    // …and every read resolves it through the merge.
    expect(projected(wsId, theirs.id)?.assigneeId).toBe(LF);
    expect(await ids(`/api/workspaces/${wsId}/next?assignee=${LF}`)).toEqual([theirs.id]);
    expect(await ids(`/api/workspaces/${wsId}/next?assignee=Lighthouse`)).toEqual([theirs.id]);
  });

  it('a hand-over re-resolves the id, and clears it for a name nobody knows', async () => {
    const wsId = await seedWorkspace('handover');
    await attach(wsId, LF, 'Live Feedback');
    const task = await mk(wsId, 'Live Feedback');
    expect(task.assigneeId).toBe(LF);

    await jj(
      await post(`/api/tasks/${task.id}/assignee`, { assignee: 'Ada Fenwick', author: PERSON }),
    );
    const handed = handle.tasks.getTask(task.id) as Task;
    expect(handed.assignee).toBe('Ada Fenwick');
    expect(handed.assigneeId).toBeUndefined();

    await jj(
      await post(`/api/tasks/${task.id}/assignee`, { assignee: 'live-feedback', author: PERSON }),
    );
    const back = handle.tasks.getTask(task.id) as Task;
    expect(back.assignee).toBe('live-feedback');
    expect(back.assigneeId).toBe(LF);
  });
});
