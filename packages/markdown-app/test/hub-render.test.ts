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
    onStatusSet: vi.fn(),
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

  // Every status is one gesture away — the point of replacing the cycle. A
  // done → todo pick is the case the cycle got wrong: it cost two moves and
  // wrote two audit events for something that happened once.
  it('the status dropdown offers every status and reports the one picked', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', status: 'done' });
    renderBoard(root, boardSections(GOALS, [t], { ...filters, doneWindow: 'all' }), h);
    const select = root.querySelector('.hub-status-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value).sort()).toEqual(['done', 'in-progress', 'todo']);
    expect(select.value).toBe('done');
    select.value = 'todo';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onStatusSet).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'todo');
    expect(h.onOpenTask).not.toHaveBeenCalled();
  });

  it('a change event that re-picks the current status writes nothing', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), h);
    const select = root.querySelector('.hub-status-select') as HTMLSelectElement;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onStatusSet).not.toHaveBeenCalled();
  });

  // The status name isn't drawn as body text in the row, so the accessible
  // name is what carries it. A row control labelled '' reads as "combo box"
  // and nothing else.
  it('the status dropdown still names its status for assistive tech', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), h);
    const mark = root.querySelector('.hub-status-select') as HTMLElement;
    expect(mark.getAttribute('aria-label') ?? '').toContain('To do');
    expect(mark.title).toContain('To do');
  });

  // Every row is one grid line: the layout property the whole change is for.
  it('keeps the title on one line so the status marks stay in a column', () => {
    const h = handlers();
    const long = task({
      goal: 'g-pr',
      title: 'B16: drop the 10s age bound; suppress the installer auto-launch on cold start',
    });
    renderBoard(root, boardSections(GOALS, [long], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    // Not `white-space: normal` — that (plus flex-wrap) is what wrapped a
    // long title under its own status control and misaligned the column.
    expect(title.className).toContain('hub-task-title');
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    // Order is the contract the grid tracks are written against.
    expect([...row.children].map((c) => (c as HTMLElement).className.split(' ')[0])).toEqual([
      'hub-status-select',
      'hub-risk-slot',
      'hub-task-title',
      'hub-task-badges',
    ]);
  });

  // The bug this pins: `grid-template-columns` names four tracks, and grid
  // auto-placement fills them CONSECUTIVELY. A row that omitted the risk dot
  // put its title in the dot's track — which a `:not(:has(.hub-risk))` rule
  // had collapsed to `0` — so every title on a row without a risk tier
  // rendered at zero width. happy-dom does no layout, so the assertion that
  // catches it is the child SHAPE, identical either way. An earlier version
  // of this test asserted the three-child order and therefore pinned the bug
  // in place instead of catching it.
  it('a row without a risk tier has the same grid children as one with', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(
        GOALS,
        [
          task({ goal: 'g-pr', id: 't-plain', title: 'no tier' }),
          task({ goal: 'g-pr', id: 't-risky', title: 'has tier', riskTier: 'red' }),
        ],
        filters,
      ),
      h,
    );
    const rows = [...root.querySelectorAll('.hub-task-row')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    const shape = (r: HTMLElement) =>
      [...r.children].map((c) => (c as HTMLElement).className.split(' ')[0]);
    expect(shape(rows[0])).toEqual(shape(rows[1]));
    expect(shape(rows[0])).toHaveLength(4);
    // Positive control: the tiers really do differ, so the shapes matching
    // above is not two identically-empty rows agreeing about nothing.
    expect(rows[0].querySelector('.hub-risk')).toBeNull();
    expect(rows[1].querySelector('.hub-risk')).not.toBeNull();
  });

  // Reported as "I can't open a task to see what's inside". The title spans
  // most of the row, and it used to stop propagation and swap itself for an
  // input — so on a phone, where the title is nearly the whole row, tapping a
  // task could only ever rename it. Renaming moved to the detail panel; the
  // row's one gesture is open.
  it('tapping the title opens the task rather than renaming it', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', title: 'Old title' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    title.click();
    expect(title.querySelector('input')).toBeNull();
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
  });

  // The rest of the row was never the problem, but it is the positive control
  // for the assertion above: if opening broke everywhere, the test above
  // would pass for the wrong reason.
  it('tapping the row anywhere else opens the task too', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    (root.querySelector('.hub-task-row') as HTMLElement).click();
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
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
  const detailHandlers = () => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
  });

  // The server accepted, keyed and backlinked `url` refs before anything
  // drew them — stored and unreachable, which is the same failure this
  // codebase already hit with resolved threads. So this asserts the SURFACE,
  // not the model: a stored ref nothing renders is not a feature.
  it('renders a url ref as a real anchor', () => {
    const pr = 'https://github.com/example-org/example-repo/pull/1669';
    renderTaskDetail(root, task({ links: [{ kind: 'url', url: pr }] }), detailHandlers());
    const chip = root.querySelector('.hub-detail-links a') as HTMLAnchorElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute('href')).toBe(pr);
    // Opening someone else's link must not hand them this window.
    expect(chip.rel).toContain('noopener');
    // The host is the legible part; the full URL stays in the tooltip so a
    // query string can't stretch the chip.
    expect(chip.textContent).toBe('github.com');
    expect(chip.title).toBe(pr);
  });

  it('never emits a non-http(s) href, even for a ref stored before the check existed', () => {
    // The server refuses these on the way in now, but the panel is built
    // from whatever the doc currently holds — including refs persisted
    // earlier. Positive control first: the good one DOES render, so "no
    // anchor" below means refused rather than "this test renders nothing".
    renderTaskDetail(
      root,
      task({ links: [{ kind: 'url', url: 'https://example.com/ok' }] }),
      detailHandlers(),
    );
    expect(root.querySelectorAll('.hub-detail-links a').length).toBe(1);

    for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>']) {
      renderTaskDetail(root, task({ links: [{ kind: 'url', url }] }), detailHandlers());
      expect(root.querySelectorAll('.hub-detail-links a').length).toBe(0);
    }
  });

  it('survives a ref kind it has never heard of', () => {
    // An older client must not break when a newer server adds a kind: a
    // task that won't open is worse than a chip that isn't drawn.
    expect(() =>
      renderTaskDetail(
        root,
        task({
          links: [
            { kind: 'quasar', quasarId: 'q-1' },
            { kind: 'doc', docId: 'd-1' },
          ],
        }),
        detailHandlers(),
      ),
    ).not.toThrow();
    // …and the ref it DOES understand still made it through.
    expect(root.querySelector('.hub-detail-links')?.textContent).toContain('d-1');
  });

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

  // The description was stored on every task and the panel rendered only a
  // link to another page — so "what is this task for" cost a navigation, and
  // the board read as a list of bare titles. Same shape as the resolved-thread
  // report: the store had it, no surface could show it.
  it('renders the description on the task itself, as markdown', () => {
    const t = task({
      body: 'Agent can **read** the description here so that it can pick a task up cold.',
    });
    renderTaskDetail(root, t, detailHandlers());
    const desc = root.querySelector('.hub-detail-body');
    expect(desc?.textContent).toContain('pick a task up cold');
    // Rendered, not dumped: the marks became elements rather than asterisks.
    expect(desc?.querySelector('strong')?.textContent).toBe('read');
    expect(desc?.textContent).not.toContain('**');
  });

  it('escapes markup in a description rather than executing it', () => {
    renderTaskDetail(root, task({ body: '<img src=x onerror=alert(1)>' }), detailHandlers());
    expect(root.querySelector('.hub-detail-body img')).toBeNull();
    expect(root.querySelector('.hub-detail-body')?.textContent).toContain('<img');
  });

  it('says a task has no description rather than showing nothing', () => {
    // Positive control: with a body there is no empty note, so its presence
    // below means the branch ran rather than "this test renders nothing".
    renderTaskDetail(root, task({ body: 'Something specific.' }), detailHandlers());
    expect(root.querySelector('.hub-detail-body-empty')).toBeNull();

    renderTaskDetail(root, task(), detailHandlers());
    expect(root.querySelector('.hub-detail-body-empty')).toBeTruthy();
    // The link out stays either way — the doc is where you edit and comment.
    expect(root.querySelector('.hub-detail-body-link a')).toBeTruthy();
  });

  it('says so when the projected description is only the head of a longer one', () => {
    renderTaskDetail(root, task({ body: 'The first part.' }), detailHandlers());
    expect(root.querySelector('.hub-detail-body-more')).toBeNull();

    renderTaskDetail(
      root,
      task({ body: 'The first part.', bodyTruncated: true }),
      detailHandlers(),
    );
    expect(root.querySelector('.hub-detail-body-more')).toBeTruthy();
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
