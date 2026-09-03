/**
 * What runs around every `tools/call` answer.
 *
 * Four things happen either side of the domain handler and each has a reason
 * that only shows up when it is missing: the deferred emitter is released in
 * a `finally` so a throwing handler still lets held channel frames out; the
 * watch restore runs first because a respawned child's first tool call is the
 * moment its set has to be back; the heartbeat is fire-and-forget because
 * liveness is not worth failing a call over; and the auto-watch fires before
 * the handler so a doc named in a call is subscribed even when the caller
 * forgot to ask.
 *
 * None of it could be driven while it lived in `mcp.ts`, which starts an MCP
 * server on import. All fixtures synthetic.
 */
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  type CallToolDeps,
  type DomainHandler,
  NO_AUTO_WATCH_TOOLS,
  type ToolContext,
  createCallToolHandler,
  maybeAutoWatch,
} from '../src/call-tool.ts';

const CTX = {} as ToolContext;

function req(name: string, args: Record<string, unknown> = {}): CallToolRequest {
  return { method: 'tools/call', params: { name, arguments: args } } as CallToolRequest;
}

const answer = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });

function harness(over: Partial<CallToolDeps> = {}) {
  const order: string[] = [];
  const watched: string[] = [];
  let open = 0;
  const deps: CallToolDeps = {
    deferredEmits: {
      beginToolCall: () => {
        open += 1;
        order.push('begin');
        return () => {
          open -= 1;
          order.push('end');
        };
      },
    },
    ensureWatchesRestored: async () => {
      order.push('restore');
    },
    sendDueHeartbeats: async () => {
      order.push('heartbeat');
    },
    watchDoc: async (docId) => {
      order.push('watch');
      watched.push(docId);
      return true;
    },
    toolContext: () => CTX,
    handlers: [],
    err: (message) => ({ isError: true, content: [{ type: 'text', text: message }] }),
    ...over,
  };
  return { handle: createCallToolHandler(deps), order, watched, openCalls: () => open };
}

describe('a call reaches the handler that claims its name', () => {
  it('offers the name to each family and answers with the first that claims it', async () => {
    const asked: string[] = [];
    const docs: DomainHandler = async (name) => {
      asked.push('docs');
      return name === 'get_doc' ? answer('docs') : undefined;
    };
    const tasks: DomainHandler = async (name) => {
      asked.push('tasks');
      return name === 'next_tasks' ? answer('tasks') : undefined;
    };
    const h = harness({ handlers: [docs, tasks] });
    await expect(h.handle(req('next_tasks'))).resolves.toEqual(answer('tasks'));
    expect(asked).toEqual(['docs', 'tasks']);
  });

  it('stops at the first family rather than asking the rest', async () => {
    const asked: string[] = [];
    const first: DomainHandler = async () => {
      asked.push('first');
      return answer('mine');
    };
    const second: DomainHandler = async () => {
      asked.push('second');
      return answer('also mine');
    };
    const h = harness({ handlers: [first, second] });
    await expect(h.handle(req('get_doc'))).resolves.toEqual(answer('mine'));
    expect(asked).toEqual(['first']);
  });

  it('passes the arguments and the context through untouched', async () => {
    const seen: Array<{ name: string; args: unknown; ctx: unknown }> = [];
    const h = harness({
      handlers: [
        async (name, args, ctx) => {
          seen.push({ name, args, ctx });
          return answer('ok');
        },
      ],
    });
    await h.handle(req('get_doc', { docId: 'plan', deep: { nested: 1 } }));
    expect(seen).toEqual([
      { name: 'get_doc', args: { docId: 'plan', deep: { nested: 1 } }, ctx: CTX },
    ]);
  });

  it('errors on a name no family claims, naming the name', async () => {
    const h = harness({ handlers: [async () => undefined] });
    const res = await h.handle(req('no_such_tool'));
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe('unknown tool: no_such_tool');
  });

  it('turns a throwing handler into an error result rather than a rejection', async () => {
    const h = harness({
      handlers: [
        async () => {
          throw new Error('route exploded');
        },
      ],
    });
    const res = await h.handle(req('get_doc'));
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toBe('route exploded');
  });
});

describe('the work around the answer runs in the order it has to', () => {
  it('restores, heartbeats and auto-watches before the handler', async () => {
    const h = harness({
      handlers: [
        async () => {
          h.order.push('handler');
          return answer('ok');
        },
      ],
    });
    await h.handle(req('get_doc', { docId: 'plan' }));
    expect(h.order).toEqual(['begin', 'restore', 'heartbeat', 'watch', 'handler', 'end']);
  });

  it('releases the deferred emitter even when the handler throws', async () => {
    const h = harness({
      handlers: [
        async () => {
          throw new Error('boom');
        },
      ],
    });
    await h.handle(req('get_doc'));
    expect(h.openCalls()).toBe(0);
    expect(h.order.at(-1)).toBe('end');
  });

  it('releases it when the restore itself throws', async () => {
    const h = harness({
      ensureWatchesRestored: async () => {
        throw new Error('restore exploded');
      },
    });
    const res = await h.handle(req('get_doc'));
    expect(res.isError).toBe(true);
    expect(h.openCalls()).toBe(0);
  });
});

describe('naming a doc subscribes to it, once, unless the caller opted out', () => {
  it('watches the doc a call names', async () => {
    const h = harness();
    await h.handle(req('get_doc', { docId: 'plan' }));
    expect(h.watched).toEqual(['plan']);
  });

  it('watches once per call even when the same doc is named twice', async () => {
    const h = harness();
    await h.handle(req('get_doc', { docId: 'plan' }));
    await h.handle(req('find_and_replace', { docId: 'plan' }));
    // Two calls, two attempts — the registry's own idempotence is what makes
    // the second a no-op, and that is asserted in watch-registry.test.ts.
    expect(h.watched).toEqual(['plan', 'plan']);
  });

  it.each([...NO_AUTO_WATCH_TOOLS])('never auto-watches from %s', async (name) => {
    const h = harness();
    await h.handle(req(name, { docId: 'plan' }));
    expect(h.watched).toEqual([]);
  });

  it('respects an explicit opt-out', async () => {
    const h = harness();
    await h.handle(req('get_doc', { docId: 'plan', subscribe: false }));
    expect(h.watched).toEqual([]);
  });
});

describe('maybeAutoWatch answers on the argument shape alone', () => {
  const watchedBy = async (name: string, args: unknown) => {
    const seen: string[] = [];
    await maybeAutoWatch(async (docId) => seen.push(docId), name, args);
    return seen;
  };

  it('watches a non-empty string docId', async () => {
    expect(await watchedBy('get_doc', { docId: 'plan' })).toEqual(['plan']);
  });

  it.each([
    ['no arguments at all', undefined],
    ['a non-object', 'plan'],
    ['no docId', { taskId: 'k1' }],
    ['an empty docId', { docId: '' }],
    ['a non-string docId', { docId: 7 }],
  ])('watches nothing for %s', async (_name, args) => {
    expect(await watchedBy('get_doc', args)).toEqual([]);
  });

  it('names the four tools whose intent auto-watch must not reverse', () => {
    expect([...NO_AUTO_WATCH_TOOLS].sort()).toEqual([
      'attach_doc',
      'observe_url',
      'unwatch_doc',
      'watch_doc',
    ]);
  });
});
