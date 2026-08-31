/**
 * The task panel's Source-doc field: a doc-derived row names the doc it came
 * from as a first-class field near the top, with the plan-gate and staleness
 * marks on the same cell. Until this, the origin ref was stored and keyed
 * and never drawn.
 *
 * Fixtures are synthetic (jordan@partner.example register).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHORES_ID, type HubTask } from '../src/hub/hub-model.ts';
import { type DetailHandlers, sourceDocOf } from '../src/hub/hub-render.ts';
import { primeLinkTitle } from '../src/link-titles.ts';
import { disposeTaskDetail, renderTaskDetail } from './support/task-detail.ts';

const NOW = 1_700_000_000_000;
let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as HubTask;
}

const handlers = (over: Partial<DetailHandlers> = {}): DetailHandlers => ({
  onClose: vi.fn(),
  onStatusSet: vi.fn(),
  onTitleCommit: vi.fn(),
  onAnswer: vi.fn(),
  onAssign: vi.fn(),
  ...over,
});

let root: HTMLElement;
beforeEach(() => {
  disposeTaskDetail();
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

describe('sourceDocOf', () => {
  it('reads a doc or thread origin and refuses everything else', () => {
    expect(sourceDocOf(task({ origin: { kind: 'doc', docId: 'd-plan' } }))).toBe('d-plan');
    expect(
      sourceDocOf(task({ origin: { kind: 'thread', docId: 'd-plan', threadId: 'th-1' } })),
    ).toBe('d-plan');
    expect(sourceDocOf(task())).toBeNull();
    expect(sourceDocOf(task({ origin: { kind: 'task', taskId: 't-9' } }))).toBeNull();
    expect(sourceDocOf(task({ origin: { kind: 'doc', docId: '' } }))).toBeNull();
    expect(sourceDocOf(task({ origin: 'd-plan' }))).toBeNull();
  });
});

describe('the Source-doc field on the panel', () => {
  it('renders near the top with a canonical workspace link, and not at all without an origin', () => {
    renderTaskDetail(
      root,
      task({ origin: { kind: 'doc', docId: 'd-plan' } }),
      handlers({ workspaceId: 'w-test' }),
    );
    const keys = [...root.querySelectorAll('.hub-detail-field-k')].map((k) => k.textContent);
    expect(keys[0]).toBe('Status');
    expect(keys[1]).toBe('Source doc');
    const link = root.querySelector<HTMLAnchorElement>('.hub-sourcedoc-link');
    expect(link?.getAttribute('href')).toBe('/workspaces/w-test/docs/d-plan');
    expect(link?.textContent).toBe('d-plan');

    // The absence half, with the render above as its positive control.
    renderTaskDetail(root, task(), handlers({ workspaceId: 'w-test' }));
    expect(
      [...root.querySelectorAll('.hub-detail-field-k')].map((k) => k.textContent),
    ).not.toContain('Source doc');
  });

  it('shows the doc TITLE when the shared link-title cache knows it', () => {
    primeLinkTitle('/workspaces/w-test/docs/d-named', 'Sprint plan', null);
    renderTaskDetail(
      root,
      task({ origin: { kind: 'doc', docId: 'd-named' } }),
      handlers({ workspaceId: 'w-test' }),
    );
    expect(root.querySelector('.hub-sourcedoc-link')?.textContent).toBe('Sprint plan');
  });

  it('carries the plan-hold and staleness marks, and omits them on a plain row', () => {
    renderTaskDetail(
      root,
      task({
        origin: { kind: 'doc', docId: 'd-plan' },
        planHold: { docId: 'd-plan' },
        possiblyStale: { docRevision: 3, ts: NOW },
      }),
      handlers({ workspaceId: 'w-test' }),
    );
    expect(root.querySelector('.hub-sourcedoc-held')?.textContent).toContain('held until');
    expect(root.querySelector('.hub-sourcedoc-stale')?.textContent).toBe('plan edited since filed');

    renderTaskDetail(
      root,
      task({ origin: { kind: 'doc', docId: 'd-plan' } }),
      handlers({ workspaceId: 'w-test' }),
    );
    expect(root.querySelector('.hub-sourcedoc-link')).not.toBeNull(); // control
    expect(root.querySelector('.hub-sourcedoc-held')).toBeNull();
    expect(root.querySelector('.hub-sourcedoc-stale')).toBeNull();
  });
});
