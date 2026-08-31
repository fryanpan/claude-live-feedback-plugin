/**
 * Allow-rule review items: a denial the classifier repeats becomes ONE
 * question Bryan can answer from his phone, with a paste-ready rule — and
 * nothing here ever writes a settings file.
 *
 * Positive control first (three denials of one shape file exactly one
 * decision carrying `Bash(git push:*)`), then the negatives that keep the
 * queue quiet: under the threshold, mixed shapes, an item still open, a
 * `never` answer, a shape too old to count. The "no settings write" check
 * scans the data dir after the positive control, because a route that filed
 * the item AND pasted the rule would pass every other test here.
 *
 * All fixtures are synthetic — invented names. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALLOW_RULES_FILENAME,
  ALLOW_RULE_THRESHOLD,
  ALLOW_RULE_WINDOW_MS,
  allowRuleFor,
} from '../src/allow-rules.ts';
import { normalizeAgent } from '../src/chat-audit.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-sam', name: 'Sam Reviewer', kind: 'person' };
const LEAD = { id: 'agent-beacon-bot', name: 'Beacon Bot', kind: 'agent' };

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe('allow-rule review items', () => {
  let handle: ServerHandle;
  let base: string;
  let dataDir: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const deny = async (shape: string, agent = LEAD.name) => {
    const r = await post('/api/agent-notes', { agent, kind: 'denial', text: shape });
    expect(r.status).toBe(202);
    return r;
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'allow-rule-items-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boardWithLead(name = 'search-revamp'): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name, leadAgentId: LEAD.id }),
    );
    await jj(
      await post(`/api/workspaces/${workspace.id}/attachments`, {
        agentId: LEAD.id,
        runtime: 'claude-code-local',
      }),
    );
    return workspace.id;
  }

  async function inProgressRow(workspaceId: string, title: string): Promise<string> {
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title,
        body: `Agent can ${title.toLowerCase()} so that the queue keeps moving.`,
        assignee: LEAD.name,
        assigneeKind: 'agent',
        author: LEAD,
      }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/transition`, { to: 'todo', author: PERSON, workspaceId }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/transition`, {
        to: 'in-progress',
        author: LEAD,
        workspaceId,
      }),
    );
    return task.id;
  }

  const items = (taskId: string) => handle.tasks.listReviewItems(taskId);

  it('maps a shape to a rule: a Bash prefix, or the tool name', () => {
    expect(allowRuleFor('git push')).toBe('Bash(git push:*)');
    expect(allowRuleFor('rm -rf')).toBe('Bash(rm -rf:*)');
    expect(allowRuleFor('WebFetch')).toBe('WebFetch');
    expect(allowRuleFor('mcp__claude-hive__send_message')).toBe('mcp__claude-hive__send_message');
    // A command the hook could not shape posts the bare tool name; a rule
    // for that would allow EVERY command, so there is none to propose.
    expect(allowRuleFor('Bash')).toBeUndefined();
    expect(ALLOW_RULE_THRESHOLD).toBe(3);
    expect(ALLOW_RULE_WINDOW_MS).toBe(7 * 24 * 60 * 60_000);
  });

  it('positive control: three denials of one shape file ONE decision with the paste-ready rule', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');

    await deny('git push');
    await deny('git push');
    expect(items(taskId)).toHaveLength(0);
    await deny('git push');
    await settle();

    // The denials themselves still reach the pane — the item is in addition.
    const notes = handle.tasks.getTask(taskId)?.notes ?? [];
    expect(notes.filter((n) => n.kind === 'denial' && n.text === 'git push')).toHaveLength(3);

    const filed = items(taskId);
    expect(filed).toHaveLength(1);
    const item = filed[0];
    expect(item?.review.shape).toBe('decision');
    expect(item?.review.headline).toBe('Allow "git push" for Beacon Bot without asking?');
    expect(item?.createdBy).toBe(LEAD.name);
    expect(item?.review.options?.map((o) => o.id)).toEqual(['allow', 'keep-asking', 'never']);
    const detail = item?.review.detail ?? '';
    expect(detail).toContain('Bash(git push:*)');
    expect(detail).toContain('~/.claude/settings.json');
    expect(detail).toContain('.claude/settings.json` in the repo');
    expect(detail).toContain('3 times in the last 7 days');
    expect(detail).toContain('Wire the index');
    expect(detail).toContain('does not unlock');

    // Nothing here pastes the rule for him: no settings file appears anywhere
    // the server writes, and the data dir holds no `permissions` block.
    const written = filesUnder(dataDir);
    expect(written.some((p) => p.endsWith('settings.json'))).toBe(false);
    for (const p of written) {
      if (p.endsWith('.json')) expect(await Bun.file(p).text()).not.toContain('"permissions"');
    }
  });

  it('under the threshold, or spread over different shapes, files nothing', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');

    await deny('git push');
    await deny('git push');
    await deny('rm -rf');
    await deny('bun run');
    await deny('WebFetch');
    await settle();
    expect(items(taskId)).toHaveLength(0);
  });

  it('does not re-file while the item is open, and never again after a `never` answer', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');

    for (let i = 0; i < 4; i++) await deny('git push');
    await settle();
    expect(items(taskId)).toHaveLength(1);
    const itemId = items(taskId)[0]?.id ?? '';

    await jj(
      await post(`/api/tasks/${taskId}/review-items/${itemId}/answer`, {
        text: 'Never propose this shape again',
        answeredWith: 'never',
        author: PERSON,
      }),
    );
    for (let i = 0; i < 3; i++) await deny('git push');
    await settle();
    expect(items(taskId)).toHaveLength(1);
    // A different shape from the same agent is still proposed.
    for (let i = 0; i < 3; i++) await deny('gh pr');
    await settle();
    expect(items(taskId).map((i) => i.review.headline)).toEqual([
      'Allow "git push" for Beacon Bot without asking?',
      'Allow "gh pr" for Beacon Bot without asking?',
    ]);
  });

  it('after "keep blocking", the question comes back only after three FRESH denials', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');

    for (let i = 0; i < 3; i++) await deny('git push');
    await settle();
    const first = items(taskId)[0];
    await jj(
      await post(`/api/tasks/${taskId}/review-items/${first?.id}/answer`, {
        text: 'Keep blocking',
        answeredWith: 'keep-asking',
        author: PERSON,
      }),
    );
    await deny('git push');
    await deny('git push');
    await settle();
    expect(items(taskId)).toHaveLength(1);
    await deny('git push');
    await settle();
    expect(items(taskId)).toHaveLength(2);
  });

  it('a non-Bash tool shape proposes the tool name; an unshaped Bash denial proposes nothing', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');

    for (let i = 0; i < 3; i++) await deny('Bash');
    await settle();
    expect(items(taskId)).toHaveLength(0);

    for (let i = 0; i < 3; i++) await deny('WebFetch');
    await settle();
    const filed = items(taskId);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.review.headline).toBe('Allow "WebFetch" for Beacon Bot without asking?');
    expect(filed[0]?.review.detail).toContain('"WebFetch"');
    expect(filed[0]?.review.detail).not.toContain('Bash(');
  });

  it('counts across the agent’s tasks and only inside the window; the item lands where the third denial did', async () => {
    const wsId = await boardWithLead();
    const older = await inProgressRow(wsId, 'Older row');
    await deny('git push');
    await settle(5);
    // The older row closes before the newer opens: an agent holding two rows
    // at once would have its denial left unfiled rather than guessed onto
    // one of them (see agent-notes-routes.test.ts), and this test is about
    // the WINDOW and the cross-task tally, not about ambiguity.
    await jj(
      await post(`/api/tasks/${older}/transition`, {
        to: 'done',
        author: LEAD,
        workspaceId: wsId,
      }),
    );
    const newer = await inProgressRow(wsId, 'Newer row');
    // Two denials that fell out of the window are on the tally but must not
    // count — seeded into the sidecar the way a week-old server left them.
    await handle.stop();
    const stale = Date.now() - ALLOW_RULE_WINDOW_MS - 60_000;
    const sidecarPath = join(dataDir, ALLOW_RULES_FILENAME);
    const sidecar = JSON.parse(await Bun.file(sidecarPath).text()) as Record<
      string,
      Record<string, { denials: Array<{ ts: number; taskId: string }> }>
    >;
    const tally = sidecar[normalizeAgent(LEAD.name)]?.['git push'];
    expect(tally?.denials.map((d) => d.taskId)).toEqual([older]);
    tally?.denials.unshift({ ts: stale, taskId: newer }, { ts: stale, taskId: newer });
    await Bun.write(sidecarPath, JSON.stringify(sidecar));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    await deny('git push');
    await settle();
    expect(items(newer)).toHaveLength(0);
    await deny('git push');
    await settle();

    expect(items(older)).toHaveLength(0);
    const filed = items(newer);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.review.detail).toContain('on Older row and Newer row');
  });

  it('a denial while the item is open does not count toward the next ask', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    for (let i = 0; i < 5; i++) await deny('git push');
    await settle();
    expect(items(taskId)).toHaveLength(1);
    await jj(
      await post(`/api/tasks/${taskId}/review-items/${items(taskId)[0]?.id}/answer`, {
        text: 'Keep blocking',
        answeredWith: 'keep-asking',
        author: PERSON,
      }),
    );
    await deny('git push');
    await deny('git push');
    await settle();
    expect(items(taskId)).toHaveLength(1);
  });

  it('remembers what it filed across a restart', async () => {
    const wsId = await boardWithLead();
    const taskId = await inProgressRow(wsId, 'Wire the index');
    for (let i = 0; i < 3; i++) await deny('git push');
    await settle();
    expect(items(taskId)).toHaveLength(1);

    await handle.stop();
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    await deny('git push');
    await settle();
    expect(items(taskId)).toHaveLength(1);
  });
});
