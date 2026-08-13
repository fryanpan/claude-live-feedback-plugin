import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  type UptimeReport,
  boardSections,
} from '../src/hub/hub-model.ts';
import {
  type BoardHandlers,
  renderActivity,
  renderBoard,
  renderDecisions,
  renderGoalStrip,
  renderTaskDetail,
} from '../src/hub/hub-render.ts';

/** All fixtures are synthetic — invented names, jordan@partner.example register. */

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
  };
}

const GOALS: HubGoal[] = [
  { id: 'g-pr', title: '1. Get the PR out', subgoals: [{ id: 'g-sub', title: '1.1 Tickets' }] },
];

const filters: BoardFilters = {
  tab: 'all',
  userName: 'Jordan',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};

function handlers(): BoardHandlers {
  return {
    onStatusTap: vi.fn(),
    onTitleCommit: vi.fn(),
    onGoalTitleCommit: vi.fn(),
    onOpenTask: vi.fn(),
  };
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

describe('renderBoard', () => {
  it('renders goal sections in order with Chores last, done rows styled done in place', () => {
    const done = task({
      goal: 'g-pr',
      order: 1,
      status: 'done',
      transitions: [{ ts: NOW, from: 'todo', to: 'done', by: { name: 'Agent', kind: 'agent' } }],
    });
    const open = task({ goal: 'g-pr', order: 2 });
    renderBoard(root, boardSections(GOALS, [done, open], filters), handlers());
    const sections = Array.from(root.querySelectorAll('.hub-section'));
    expect(sections.map((s) => (s as HTMLElement).dataset.goalId)).toEqual([
      'g-pr',
      'g-sub',
      CHORES_ID,
    ]);
    // Done is a status, not a group: the done row keeps its priority slot…
    const rows = Array.from(sections[0]?.querySelectorAll('.hub-task-row') ?? []);
    expect(rows.map((r) => (r as HTMLElement).dataset.taskId)).toEqual([done.id, open.id]);
    // …and is drawn in the done style.
    expect((rows[0] as HTMLElement).classList.contains('hub-done')).toBe(true);
    expect((rows[1] as HTMLElement).classList.contains('hub-done')).toBe(false);
  });

  it('tapping the status chip fires onStatusTap without opening the task', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const chip = root.querySelector('.hub-status-chip') as HTMLElement;
    chip.click();
    expect(h.onStatusTap).toHaveBeenCalledTimes(1);
    expect(h.onOpenTask).not.toHaveBeenCalled();
  });

  it('tapping the title edits in place; Enter commits the new value', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', title: 'Old title' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    title.click();
    const input = title.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = 'Sharper title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onTitleCommit).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
      'Sharper title',
    );
    expect(h.onOpenTask).not.toHaveBeenCalled();
  });

  it('Escape cancels the edit and restores the old title without committing', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', title: 'Keep me' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    title.click();
    const input = title.querySelector('input') as HTMLInputElement;
    input.value = 'Discarded';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.onTitleCommit).not.toHaveBeenCalled();
    expect(title.textContent).toBe('Keep me');
  });

  it('goal titles are editable in place too; Chores is not', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [], filters), h);
    const goalTitle = root.querySelector(
      '.hub-section[data-goal-id="g-pr"] .hub-section-title-text',
    ) as HTMLElement;
    goalTitle.click();
    const input = goalTitle.querySelector('input') as HTMLInputElement;
    input.value = '1. Ship the PR';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onGoalTitleCommit).toHaveBeenCalledWith('g-pr', '1. Ship the PR');
    const choresTitle = root.querySelector(
      `.hub-section[data-goal-id="${CHORES_ID}"] .hub-section-title-text`,
    ) as HTMLElement;
    choresTitle.click();
    expect(choresTitle.querySelector('input')).toBeNull();
  });
});

describe('renderDecisions', () => {
  it('shows a chip per open decision and opens it on tap', () => {
    const onOpen = vi.fn();
    const d = task({ needs: 'decision', assignee: 'human', title: 'Ship now or wait?' });
    renderDecisions(root, [d], onOpen);
    const chip = root.querySelector('.hub-decision-chip') as HTMLElement;
    expect(chip.textContent).toContain('Ship now or wait?');
    chip.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Empty → the strip hides instead of rendering an empty shell.
    renderDecisions(root, [], onOpen);
    expect(root.classList.contains('hidden')).toBe(true);
  });
});

describe('renderGoalStrip', () => {
  it('renders the goal as markdown and commits an edit through the handler', () => {
    const onGoalCommit = vi.fn();
    renderGoalStrip(root, 'Ship **search v2**.', { onGoalCommit });
    expect(root.querySelector('.hub-goal-body strong')?.textContent).toBe('search v2');
    (root.querySelector('.hub-goal-edit') as HTMLElement).click();
    const ta = root.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Ship search v3.';
    (root.querySelector('.hub-btn-primary') as HTMLElement).click();
    expect(onGoalCommit).toHaveBeenCalledWith('Ship search v3.');
  });

  it('leads with start-planning on an empty workspace instead of an empty strip', () => {
    renderGoalStrip(root, '', { onGoalCommit: vi.fn() });
    expect(root.textContent).toContain('start planning');
  });
});

describe('renderActivity', () => {
  const events = [
    { event: 'task.created', ts: NOW - 60_000, task: { id: 't-1', title: 'A' }, goal: 'chores' },
    {
      event: 'task.transitioned',
      ts: NOW - 30_000,
      taskId: 't-1',
      from: 'todo',
      to: 'done',
      actor: { name: 'Jordan', kind: 'person' },
    },
  ];

  it('has exactly two filters and swaps rows between them', () => {
    const onFilter = vi.fn();
    renderActivity(root, events, 'all', () => 'A', onFilter);
    const tabs = Array.from(root.querySelectorAll('.hub-activity-filters .hub-tab'));
    expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Decisions']);
    expect(root.querySelectorAll('.hub-activity-row')).toHaveLength(2);
    (tabs[1] as HTMLElement).click();
    expect(onFilter).toHaveBeenCalledWith('decisions');
    renderActivity(root, events, 'decisions', () => 'A', onFilter);
    // Positive control above proved rows render at all; Decisions drops the
    // plain transition.
    const rows = Array.from(root.querySelectorAll('.hub-activity-row'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('created');
  });

  const uptime = (over: Partial<UptimeReport> = {}): UptimeReport => ({
    target: 0.99,
    windowMs: 7 * 24 * 60 * 60_000,
    measuredMs: 7 * 24 * 60 * 60_000,
    downMs: 0,
    uptimeRatio: 1,
    meetsTarget: true,
    gaps: [],
    tickMs: 5 * 60_000,
    ...over,
  });

  it('renders the uptime banner — ok styling when the 99% target is met', () => {
    renderActivity(root, events, 'all', () => 'A', vi.fn(), uptime());
    const banner = root.querySelector('.hub-uptime');
    expect(banner).not.toBeNull();
    expect(banner?.classList.contains('hub-uptime-ok')).toBe(true);
    expect(banner?.textContent).toContain('Uptime 100%');
    expect(banner?.textContent).toContain('target 99%');
  });

  it('a missed target gets the miss styling and shows the downtime', () => {
    renderActivity(
      root,
      events,
      'all',
      () => 'A',
      vi.fn(),
      uptime({ uptimeRatio: 0.97, meetsTarget: false, downMs: 5 * 60 * 60_000 }),
    );
    const banner = root.querySelector('.hub-uptime');
    expect(banner?.classList.contains('hub-uptime-miss')).toBe(true);
    expect(banner?.textContent).toContain('down 5h');
  });

  it('no report, no banner (the two tests above are the presence control)', () => {
    renderActivity(root, events, 'all', () => 'A', vi.fn(), null);
    expect(root.querySelector('.hub-uptime')).toBeNull();
  });
});

describe('renderTaskDetail', () => {
  it('shows the answer form for an unanswered decision and records verbatim text', () => {
    const onAnswer = vi.fn();
    const d = task({ needs: 'decision', assignee: 'human' });
    renderTaskDetail(root, d, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer,
      onAssign: vi.fn(),
    });
    const ta = root.querySelector('.hub-answer-form textarea') as HTMLTextAreaElement;
    ta.value = 'Go with option B, ship Thursday.';
    (root.querySelector('.hub-answer-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(onAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ id: d.id }),
      'Go with option B, ship Thursday.',
    );
  });

  it('renders the recorded answer instead of the form once answered', () => {
    const d = task({
      needs: 'decision',
      assignee: 'human',
      answer: { text: 'Option B', by: 'Jordan', ts: NOW },
    });
    renderTaskDetail(root, d, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAssign: vi.fn(),
    });
    expect(root.querySelector('.hub-answer-form')).toBeNull();
    expect(root.querySelector('.hub-detail-answer')?.textContent).toContain('Option B');
  });

  it('links to the live task body doc', () => {
    const t = task();
    renderTaskDetail(root, t, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAssign: vi.fn(),
    });
    const a = root.querySelector('.hub-detail-body-link a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(`/review/${encodeURIComponent(t.bodyDocId)}`);
  });

  it('the assignee row hands the task the OTHER way — a one-tap hand-off', () => {
    const onAssign = vi.fn();
    const t = task({ assignee: 'agent' });
    renderTaskDetail(root, t, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAssign,
    });
    const btn = root.querySelector('.hub-assignee-btn') as HTMLButtonElement;
    expect(btn.textContent).toBe('agent'); // it still READS as the current value
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'human');
  });
});
