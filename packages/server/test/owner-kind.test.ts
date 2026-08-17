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
import { declaredAssigneeKind, resolveOwnerKind } from '../src/task-owner.ts';
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

  it('does not let an attachment claim the unowned word', () => {
    // A roster that answered true for everything must still not turn "nobody
    // holds this" into "an agent holds this".
    expect(resolveOwnerKind('agent', undefined, ALWAYS_ATTACHED)).toBe('unknown');
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
        agentId: 'Cartographer',
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
        agentId: 'Surveyor',
        runtime: 'claude-code-local',
        capabilities: ['tasks.write'],
      }),
    );
    expect(projected(wsId, task.id)?.ownerKind).toBe('agent');

    // …and back, when the roster no longer vouches for it. Unknown, not
    // person: losing evidence is not gaining the opposite evidence.
    const del = await fetch(`${base}/api/workspaces/${wsId}/attachments/Surveyor`, {
      method: 'DELETE',
    });
    expect(del.ok).toBe(true);
    expect(projected(wsId, task.id)?.ownerKind).toBe('unknown');
  });
});
