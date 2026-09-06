/**
 * What the Related Links add box does with each kind of address, and what it
 * says when the write is refused.
 *
 * The control takes any URL and the WRITE it makes depends on what the URL
 * names, so the interesting assertions are the request that went out and the
 * sentence that came back. Three of the four cases here are refusals, which is
 * where this control was weakest: a goal link could never succeed and reported
 * itself as a failed ticket-block, a signed-out session read as a bad link,
 * and a refused cycle arrived with the ring named and threw the name away
 * (found in review, 2026-09-03).
 *
 * Fixtures are synthetic.
 */
import { parseWorkspaceLink } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BoardActionDeps, createBoardActions } from '../src/board/board-actions.ts';
import type { BoardTask } from '../src/board/board-model.ts';

const NOW = 1_700_000_000_000;
const WS = 'w-test';

function task(over: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 't-me',
    title: 'Wire the task panel',
    status: 'todo',
    assignee: 'agent',
    goal: 'g-board',
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:t-me',
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as BoardTask;
}

type Sent = { path: string; body: Record<string, unknown> };
let sent: Sent[];
let reply: { status: number; body: Record<string, unknown> };

function actions() {
  const deps = {
    workspaceId: WS,
    author: { id: 'u-1', name: 'Wren', kind: 'known', color: '#68a' },
    state: {} as BoardActionDeps['state'],
    renderAll: vi.fn(),
    renderDetail: vi.fn(),
    renderLead: vi.fn(),
    focusTitle: vi.fn(),
    location: { assign: vi.fn() },
  } as BoardActionDeps;
  return createBoardActions(deps);
}

const toastText = () => document.getElementById('board-toast')?.textContent ?? '';

beforeEach(() => {
  history.replaceState(null, '', `/workspaces/${WS}/tasks/t-me`);
  sent = [];
  reply = { status: 200, body: { ok: true } };
  const toast = document.createElement('div');
  toast.id = 'board-toast';
  document.body.replaceChildren(toast);
  vi.stubGlobal('fetch', (path: string, init: { body?: string }) => {
    sent.push({ path, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    } as Response);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('what the add box writes', () => {
  it('makes a ticket link into a blocking edge', async () => {
    await actions().addRelatedLink(task(), `/workspaces/${WS}?task=t-gate`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe(`/workspaces/${WS}/tasks/t-me/park`);
    expect(sent[0]?.body.blockedBy).toEqual(['t-gate']);
  });

  it('keeps a GOAL link as a plain address — a ticket waits on tickets', async () => {
    await actions().addRelatedLink(task(), `/workspaces/${WS}?goal=g-board`);
    expect(sent).toHaveLength(1);
    // It used to go to /park with a goal id, which the store refuses because
    // goal rows are not in its task map: the paste could only ever fail, and
    // the reader was told the ticket-block had failed.
    expect(sent[0]?.path).toBe(`/workspaces/${WS}/tasks/t-me/links`);
    expect(sent[0]?.body.ref).toEqual({ kind: 'url', url: `/workspaces/${WS}?goal=g-board` });
    expect(toastText()).toBe('');
    // Control: this address IS recognised as a goal on this workspace, so the
    // plain-address arm above is a decision and not a parse that failed.
    expect(parseWorkspaceLink(`/workspaces/${WS}?goal=g-board`)).toEqual({
      kind: 'goal',
      workspaceId: WS,
      goalId: 'g-board',
    });
  });

  it('refuses a self-link before it reaches the server', async () => {
    await actions().addRelatedLink(task(), `/workspaces/${WS}?task=t-me`);
    expect(sent).toHaveLength(0);
    expect(toastText()).toContain('cannot wait on itself');
  });
});

describe('what it says when the write is refused', () => {
  it('names the ring a cycle refusal came back with', async () => {
    reply = {
      status: 400,
      body: {
        ok: false,
        error: 'cycle',
        message: "that edge would close a loop: 'A' waiting on 'B' waiting on 'A'",
      },
    };
    await actions().addRelatedLink(task(), `/workspaces/${WS}?task=t-gate`);
    expect(toastText()).toContain("'A' waiting on 'B'");
  });

  it('says the SESSION is the problem on a 401, not the link', async () => {
    reply = { status: 401, body: { error: 'sign_in_required', signInUrl: '/signin' } };
    await actions().addRelatedLink(task(), `/workspaces/${WS}?task=t-gate`);
    expect(toastText()).toContain('Sign in');
    // Positive control: the same route failing for a reason the server does
    // not explain still falls back to the plain report.
    reply = { status: 500, body: {} };
    await actions().addRelatedLink(task(), `/workspaces/${WS}?task=t-gate`);
    expect(toastText()).toBe('Adding the blocking ticket failed');
  });

  it('keeps the 400 reading for an address the server will not store', async () => {
    reply = { status: 400, body: { error: 'bad scheme' } };
    await actions().addRelatedLink(task(), 'javascript:alert(1)');
    expect(toastText()).toBe('That is not a link we can store');
  });
});
