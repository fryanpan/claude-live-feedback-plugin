/**
 * One review-item vocabulary in the MCP surface.
 *
 * A ticket used to BE a decision — one `needs` flag and one embedded
 * `options` array — so its title had to double as the question and a second
 * open question had nowhere to go. The entity underneath now says a ticket
 * HAS review items (0..n, several possibly open at once), each carrying its
 * own blurb above its own options. These are the tools that reach it.
 *
 * Driven through the COMMITTED BUNDLE rather than the source, because that is
 * the artifact `.mcp.json` loads and a peer runs: a tool wired in `mcp.ts` and
 * never rebuilt reaches nobody. The bundle is spawned against a stub HTTP
 * server, so what these assert is the thing nothing else checks — which route
 * a tool call actually lands on, and what it carries.
 *
 * The two POSITIVE CONTROLS are the point of the file as much as the new
 * cases are. `answer_decision` sent the exact shape an old caller sends, and
 * `create_tasks` sent a row of `{title, needs, options}` alone, must keep
 * landing on the doors they have always landed on. They pass before this
 * commit's implementation exists — that is what makes them controls: their
 * job is to go red the day the old vocabulary is quietly narrowed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../src/mcp.ts'), 'utf8');
const BUNDLE = join(HERE, '../../plugin/mcp/index.js');

type Recorded = { method: string; path: string; body: Record<string, unknown> };

const seen: Recorded[] = [];
let stub: Server;
let child: ChildProcess;
let nextId = 100;
let pending = '';
const waiters = new Map<number, (value: unknown) => void>();

/** What the stub answers, by path suffix. Enough shape for the handler to
 *  pick fields out of — never a real server. */
function replyFor(path: string): unknown {
  if (path.endsWith('/tasks/batch')) {
    return {
      tasks: [
        {
          id: 't-9001',
          title: 'Pick the cache eviction policy',
          goal: 'chores',
          order: 1,
          status: 'todo',
          assignee: 'human',
        },
      ],
      failures: [],
      reviewAdvice: [{ taskId: 't-9001', advice: 'add a lookFor' }],
    };
  }
  if (/\/review-items$/.test(path)) {
    return {
      task: { id: 't-1', links: [] },
      item: { id: 'r-4b2e', createdAt: 1, createdBy: 'Index Keeper' },
      reviewAdvice: 'add a lookFor',
    };
  }
  return { ok: true, task: { id: 't-1', links: [{ kind: 'task', taskId: 't-2' }] } };
}

function send(msg: unknown) {
  child.stdin?.write(`${JSON.stringify(msg)}\n`);
}

function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiters.set(id, (v) => resolve(v as Record<string, unknown>));
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  });
}

/** The last request the stub saw — the assertion target for every case. */
function last(): Recorded {
  const r = seen.at(-1);
  expect(r, 'the stub server received no request at all').toBeTruthy();
  return r as Recorded;
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', () => {
      const path = req.url ?? '';
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      seen.push({ method: req.method ?? '', path, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(replyFor(path)));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const port = (stub.address() as AddressInfo).port;

  child = spawn(process.execPath, [BUNDLE], {
    env: {
      ...process.env,
      CW_BASE_URL: `http://127.0.0.1:${port}`,
      FEEDBACK_BASE_URL: `http://127.0.0.1:${port}`,
      CW_AGENT_NAME: 'Index Keeper',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => {
    pending += d.toString();
    let nl = pending.indexOf('\n');
    while (nl !== -1) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line.startsWith('{')) {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') waiters.get(msg.id)?.(msg);
        waiters.delete(msg.id as number);
      }
      nl = pending.indexOf('\n');
    }
  });

  await new Promise<void>((resolve) => {
    waiters.set(1, () => resolve());
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'review-item-tools-test', version: '0' },
      },
    });
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 30_000);

afterAll(() => {
  child?.kill();
  stub?.close();
});

/**
 * A reply that carried out the call. An unknown tool comes back as a normal
 * JSON-RPC RESULT with `isError: true` — not as `error` — so checking only
 * `reply.error` reads a missing tool as a success and leaves the path
 * assertion to explain it.
 */
function okReply(reply: Record<string, unknown>) {
  expect(reply.error, JSON.stringify(reply)).toBeUndefined();
  const result = reply.result as { isError?: boolean; content?: Array<{ text?: string }> };
  expect(result?.isError, result?.content?.[0]?.text ?? '(no content)').toBeFalsy();
  return reply;
}

/** The tool result payload, which the handlers return as JSON in a text block. */
function payload(reply: Record<string, unknown>): Record<string, unknown> {
  const result = reply.result as { content?: Array<{ text?: string }>; isError?: boolean };
  const text = result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { unparsed: text };
  }
}

describe('the harness itself', () => {
  // Everything below reads `last()`. If the bundle never reached the stub,
  // every assertion would be about a stale or missing record — so prove the
  // round trip on a tool that has shipped for months before trusting it.
  it('drives the bundle and records what it asked the server for', async () => {
    const reply = await call('list_docs', {});
    okReply(reply);
    expect(last().path).toContain('/api/docs');
  });
});

describe('the old vocabulary still lands on the old doors (positive controls)', () => {
  it('answer_decision with only {taskId, text, optionId} POSTs /api/tasks/:id/answer', async () => {
    const reply = await call('answer_decision', {
      taskId: 't-legacy',
      text: 'Evict by LRU',
      optionId: 'o-7f3a',
    });
    okReply(reply);
    expect(last().method).toBe('POST');
    expect(last().path).toBe('/api/tasks/t-legacy/answer');
    // The legacy key, not this entity's spelling. An old caller passing
    // `optionId` and getting `answeredWith` sent on is a silent loss of which
    // candidate the words came from.
    expect(last().body.optionId).toBe('o-7f3a');
    expect(last().body.text).toBe('Evict by LRU');
    expect(last().body.reviewItemId).toBeUndefined();
    expect(last().body.answeredWith).toBeUndefined();
    expect(payload(reply).recorded).toBe(true);
  });

  it('create_tasks with a row of only {title, needs, options} forwards it unchanged', async () => {
    const row = {
      title: 'Bryan can pick the cache eviction policy so latency work unblocks',
      needs: 'decision',
      assignee: 'human',
      options: [{ label: 'LRU', detail: '8MB steady' }, { label: 'One per index' }],
    };
    const reply = await call('create_tasks', { workspaceId: 'w-1', tasks: [row] });
    okReply(reply);
    expect(last().path).toBe('/api/workspaces/w-1/tasks/batch');
    expect((last().body.tasks as unknown[])[0]).toEqual(row);
    const created = payload(reply).created as Array<Record<string, unknown>>;
    expect(created[0]?.taskId).toBe('t-9001');
  });
});

describe('a ticket carries review items, and the tools reach them', () => {
  const review = {
    shape: 'decision',
    headline: 'Pick the cache eviction policy',
    why: 'The latency work is blocked until this is answered',
    lookFor: 'Whether a 300ms cold-start stall is acceptable',
    options: [
      { id: 'o-7f3a', label: 'LRU', detail: '8MB steady, up to 300ms on a cold query' },
      { id: 'o-4b2e', label: 'One per index', detail: '40MB steady, no stall' },
    ],
  };

  it('add_review_item POSTs the review to /api/tasks/:id/review-items', async () => {
    const reply = await call('add_review_item', { taskId: 't-1', review });
    okReply(reply);
    expect(last().method).toBe('POST');
    expect(last().path).toBe('/api/tasks/t-1/review-items');
    expect(last().body.review).toEqual(review);
    expect(last().body.author).toBeTruthy();
  });

  it('add_review_item surfaces reviewAdvice and the new row id', async () => {
    const reply = await call('add_review_item', { taskId: 't-1', review });
    // Advice the server computed and returned is invisible to every agent if
    // this switch forgets to copy it out — the "one layer away" failure.
    expect(payload(reply).reviewAdvice).toBe('add a lookFor');
    expect(payload(reply).reviewItemId).toBe('r-4b2e');
  });

  it('answer_review_item WITH a reviewItemId lands on that row', async () => {
    const reply = await call('answer_review_item', {
      taskId: 't-1',
      reviewItemId: 'r-4b2e',
      text: 'One per index',
      answeredWith: 'o-4b2e',
    });
    okReply(reply);
    expect(last().path).toBe('/api/tasks/t-1/review-items/r-4b2e/answer');
    expect(last().body.answeredWith).toBe('o-4b2e');
    expect(last().body.text).toBe('One per index');
  });

  it('answer_review_item WITHOUT a reviewItemId falls to the legacy answer route', async () => {
    // A ticket whose only question is its own legacy decision reads as one
    // derived row, and the store answers that row by delegating into
    // `answerDecision`. Sending the caller to /answer keeps that ONE
    // implementation of "record a decision's answer" underneath both verbs.
    const reply = await call('answer_review_item', {
      taskId: 't-legacy',
      text: 'Evict by LRU',
      answeredWith: 'o-7f3a',
    });
    okReply(reply);
    expect(last().path).toBe('/api/tasks/t-legacy/answer');
    // The legacy route knows `optionId` and nothing else.
    expect(last().body.optionId).toBe('o-7f3a');
    expect(last().body.answeredWith).toBeUndefined();
  });

  it('answer_decision WITH a reviewItemId reaches the addressed row', async () => {
    const reply = await call('answer_decision', {
      taskId: 't-1',
      reviewItemId: 'r-4b2e',
      text: 'One per index',
      optionId: 'o-4b2e',
    });
    okReply(reply);
    expect(last().path).toBe('/api/tasks/t-1/review-items/r-4b2e/answer');
    expect(last().body.answeredWith).toBe('o-4b2e');
  });

  it('request_more_info addresses a row, and falls to the legacy door without one', async () => {
    const withRow = await call('request_more_info', {
      taskId: 't-1',
      reviewItemId: 'r-4b2e',
      question: 'How often is a cold query actually hit?',
    });
    okReply(withRow);
    expect(last().path).toBe('/api/tasks/t-1/review-items/r-4b2e/more-info');
    expect(last().body.question).toBe('How often is a cold query actually hit?');

    const withoutRow = await call('request_more_info', {
      taskId: 't-legacy',
      question: 'How often is a cold query actually hit?',
    });
    okReply(withoutRow);
    expect(last().path).toBe('/api/tasks/t-legacy/more-info');
  });

  it('create_tasks carries a `review` row through and reports its advice', async () => {
    const reply = await call('create_tasks', {
      workspaceId: 'w-1',
      tasks: [{ title: 'Bryan can pick the eviction policy', assignee: 'human', review }],
    });
    okReply(reply);
    const sent = (last().body.tasks as Array<Record<string, unknown>>)[0];
    expect(sent?.review).toEqual(review);
    const created = payload(reply).created as Array<Record<string, unknown>>;
    expect(created[0]?.reviewAdvice).toBe('add a lookFor');
  });
});

describe('what the tool schemas tell an agent', () => {
  // Read from `tools/list` on the running bundle rather than from the source
  // text: that is the JSON an agent's client is handed, and it is what a
  // schema reused by spread actually resolves to. A source-slice assertion
  // would pass on a `review: SOME_SCHEMA` line whose description said
  // something else entirely, one file away.
  type ToolDecl = {
    name: string;
    description: string;
    inputSchema: { properties?: Record<string, Record<string, unknown>> };
  };
  let tools: ToolDecl[] = [];

  beforeAll(async () => {
    const id = nextId++;
    const reply = await new Promise<unknown>((resolve) => {
      waiters.set(id, resolve);
      send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
    });
    tools = (reply as { result?: { tools?: ToolDecl[] } }).result?.tools ?? [];
  });

  const byName = (n: string): ToolDecl => {
    const t = tools.find((x) => x.name === n);
    expect(t, `${n} is not in tools/list (${tools.length} tools listed)`).toBeTruthy();
    return t as ToolDecl;
  };

  it('found the advertised tools (the assertions below are otherwise vacuous)', () => {
    expect(tools.length).toBeGreaterThan(20);
    expect(byName('create_tasks').description).toContain('LIST');
  });

  it("the create_tasks row's `review` field says the blurb is not the ticket title", () => {
    const rows = byName('create_tasks').inputSchema.properties?.tasks as {
      items?: { properties?: Record<string, { description?: string }> };
    };
    const review = rows?.items?.properties?.review;
    expect(review, 'no `review` on a create_tasks row').toBeTruthy();
    expect(review?.description?.toLowerCase()).toContain('not the ticket title');
    expect(review?.description?.toLowerCase()).toContain('several');
    // Same payload, not a second one: the shape came from the shared schema.
    const shared = byName('create_thread').inputSchema.properties?.review as {
      properties?: Record<string, unknown>;
    };
    expect(
      Object.keys((review as { properties?: Record<string, unknown> }).properties ?? {}),
    ).toEqual(Object.keys(shared?.properties ?? {}));
  });

  it('add_review_item says a ticket can hold several, and where the blurb goes', () => {
    const decl = byName('add_review_item').description.toLowerCase();
    expect(decl).toContain('several');
    expect(decl).toContain('title');
  });

  it('answer_review_item explains what an omitted reviewItemId does', () => {
    const rid = byName('answer_review_item').inputSchema.properties?.reviewItemId as {
      description?: string;
    };
    expect(rid?.description?.toLowerCase()).toContain('omit');
  });

  it('answer_decision still requires exactly what it always required', () => {
    // POSITIVE CONTROL on the schema, not just on the dispatch: widening a
    // tool is compatible, but making `reviewItemId` required — or dropping
    // `optionId` — breaks every caller that learned this tool months ago.
    const decl = byName('answer_decision');
    const props = decl.inputSchema.properties ?? {};
    expect(Object.keys(props)).toContain('optionId');
    expect((decl.inputSchema as { required?: string[] }).required).toEqual(['taskId', 'text']);
  });

  it('reuses ONE review-item schema in the source rather than declaring a second', () => {
    expect(SRC).toContain('...REVIEW_ITEM_SCHEMA');
    expect(SRC.match(/required: \['headline', 'why'\]/g)?.length).toBe(1);
  });
});

describe('the agent-facing skills describe the entity, not the old model', () => {
  // The review-item CALL SHAPES moved out of the hub's SKILL.md and into its
  // sibling `tool-reference.md` when the hub was split (the skill file keeps
  // the judgment, the reference keeps the argument lists). The pin follows the
  // content: it reads the file that now has to carry these literals.
  const hub = readFileSync(
    join(HERE, '../../plugin/skills/running-a-workspace-hub/tool-reference.md'),
    'utf8',
  );
  const board = readFileSync(
    join(HERE, '../../plugin/skills/working-in-a-workspace/SKILL.md'),
    'utf8',
  );

  it('the hub skill teaches add_review_item and the 0..n cardinality', () => {
    expect(hub).toContain('add_review_item');
    expect(hub).toContain('answer_review_item');
    expect(hub.toLowerCase()).toContain('more than one');
  });

  it('the general skill says a TICKET takes review items too, not only a thread', () => {
    expect(board).toContain('add_review_item(taskId, review)');
    // And it teaches the current payload vocabulary, not the old field names.
    expect(board).toContain('review_type: "decision"');
    expect(board).toContain('review_type: "question"');
  });
});
