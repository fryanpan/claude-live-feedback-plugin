import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHORES_ID,
  type HubGoal,
  type HubTask,
  type ReviewThreadItem,
  type UptimeReport,
  goalLabel,
  humanBlockerRows,
  reviewQueue,
  unplacedNotice,
} from '../src/hub/hub-model.ts';
import {
  BODY_LIVE_CLASS,
  type QuickAddHandlers,
  type TaskThread,
  decisionBlurb,
  discussionIsBusy,
  flattenComments,
  panelReviewQueue,
  renderActivity,
  renderHomeBrief,
  renderLeadStrip,
  renderQuickAdd,
  renderReviewBanner,
  renderUnplacedStrip,
} from '../src/hub/hub-render.ts';
import {
  composerSelection,
  focusMarkdownComposer,
  isComposerFocused,
  refreshMarkdownComposer,
} from '../src/md-composer.ts';
import { caretAt, frame, renderedHtml, surfaceOf, typeInComposer } from './support/composer.ts';
import { renderTaskDetail } from './support/task-detail.ts';

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

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

describe('renderReviewBanner', () => {
  it('renders one line and a way to Home while items are open, nothing at all when none are', () => {
    const onGoHome = vi.fn();
    const d = task({ needs: 'decision', assignee: 'human' });
    renderReviewBanner(root, reviewQueue([d], [], NOW), { onGoHome });
    expect(root.querySelector('.hub-review-banner-text')?.textContent).toBe(
      'Something is waiting for your review',
    );
    (root.querySelector('.hub-review-banner-go') as HTMLElement).click();
    expect(onGoHome).toHaveBeenCalledTimes(1);
    // The banner exists only while items are open (approved design) — an
    // empty queue hides it entirely rather than announcing an all-clear.
    renderReviewBanner(root, reviewQueue([], [], NOW), { onGoHome });
    expect(root.classList.contains('hidden')).toBe(true);
    expect(root.children).toHaveLength(0);
  });

  it('still renders one countless line when several kinds are waiting', () => {
    const d = task({ needs: 'decision', assignee: 'human' });
    const thread = {
      kind: 'task-thread' as const,
      docId: 'task:t-b',
      threadId: 'th-b',
      title: 'Some task',
      ask: 'Green or blue?',
      askedBy: 'Helper',
      since: NOW - 60_000,
    };
    renderReviewBanner(root, reviewQueue([d], [thread], NOW), { onGoHome: vi.fn() });
    const text = root.querySelector('.hub-review-banner-text')?.textContent;
    expect(text).toBe('Something is waiting for your review');
    expect(text).not.toMatch(/\d/);
  });
});

describe('renderHomeBrief', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    workspaceId: 'w-1',
    lastReadAt: 0,
    since: NOW - 1000,
    instructions: 'Under 200 words.',
    brief: {
      markdown: '**Finished:** the retry rewrite landed.',
      generatedAt: NOW,
      source: 'deterministic' as const,
    },
    generating: false,
    ...over,
  });

  it('renders the brief as markdown under "What\'s New?", with the window in the head row', () => {
    renderHomeBrief(root, payload(), NOW, false, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions: vi.fn(),
      onEditRecipe: vi.fn(),
    });
    expect(root.querySelector('.hub-home-heading')?.textContent).toBe("What's New?");
    expect(root.querySelector('.hub-home-brief-body strong')?.textContent).toBe('Finished:');
    // The since-line is the window's real start, worded like the mockup —
    // "From <point> until now" — and it sits in the head row by the heading.
    const since = root.querySelector('.hub-home-review-head .hub-home-since');
    expect(since?.textContent).toMatch(/^From .+ until now$/);
    expect(since?.textContent).not.toContain('Updating');
  });

  it('generating appends Updating… to the window line', () => {
    renderHomeBrief(root, payload({ generating: true }), NOW, false, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions: vi.fn(),
      onEditRecipe: vi.fn(),
    });
    const since = root.querySelector('.hub-home-since')?.textContent ?? '';
    expect(since).toMatch(/^From .+ until now/);
    expect(since).toContain('Updating…');
  });

  it('Mark read is the dark button on the right; the edit link sits left and opens the editor', () => {
    const onMarkCaughtUp = vi.fn();
    const onEditRecipe = vi.fn();
    renderHomeBrief(root, payload(), NOW, false, {
      onMarkCaughtUp,
      onSaveInstructions: vi.fn(),
      onEditRecipe,
    });
    const mark = root.querySelector('.hub-home-mark-read') as HTMLElement;
    // Verbatim from the mockup: "Mark read", dark, bottom-right. ("Mark
    // caught up" was a judgment call and was rejected.)
    expect(mark.textContent).toBe('Mark read');
    expect(mark.className).toContain('hub-btn-ink');
    mark.click();
    expect(onMarkCaughtUp).toHaveBeenCalledTimes(1);
    const actions = root.querySelector('.hub-home-brief-actions') as HTMLElement;
    // DOM order: link first (left), Mark read last (right).
    expect(actions.firstElementChild?.classList.contains('hub-home-edit-recipe')).toBe(true);
    expect(actions.lastElementChild).toBe(mark);
    expect(root.querySelector('.hub-home-edit-recipe')?.textContent).toBe(
      'Edit how this gets generated',
    );
    (root.querySelector('.hub-home-edit-recipe') as HTMLElement).click();
    expect(onEditRecipe).toHaveBeenCalledWith(true);
    // Closed by default: the panel only exists when the app says it is open.
    expect(root.querySelector('.hub-home-recipe')).toBeNull();
  });

  it('the open recipe editor carries the exact approved copy and exactly two buttons', () => {
    const onSaveInstructions = vi.fn();
    const onEditRecipe = vi.fn();
    renderHomeBrief(root, payload(), NOW, true, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions,
      onEditRecipe,
    });
    expect(root.querySelector('.hub-home-recipe-hint')?.textContent).toBe(
      'Edit these instructions and they will be used on this summary and future summaries.',
    );
    const ta = root.querySelector('.hub-home-recipe-text') as HTMLTextAreaElement;
    expect(ta.value).toBe('Under 200 words.');
    const buttons = root.querySelectorAll('.hub-home-recipe button');
    expect([...buttons].map((b) => b.textContent)).toEqual(['Save & Update Summary', 'Cancel']);
    ta.value = 'Be terse.';
    (root.querySelector('.hub-home-recipe-save') as HTMLElement).click();
    expect(onSaveInstructions).toHaveBeenCalledWith('Be terse.');
    (root.querySelector('.hub-home-recipe-cancel') as HTMLElement).click();
    expect(onEditRecipe).toHaveBeenCalledWith(false);
  });

  it('a blank instructions box saves nothing — blanking the recipe is not expressible', () => {
    const onSaveInstructions = vi.fn();
    renderHomeBrief(root, payload(), NOW, true, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions,
      onEditRecipe: vi.fn(),
    });
    (root.querySelector('.hub-home-recipe-text') as HTMLTextAreaElement).value = '   ';
    (root.querySelector('.hub-home-recipe-save') as HTMLElement).click();
    expect(onSaveInstructions).not.toHaveBeenCalled();
  });

  it('no payload yet renders a loading line, not an empty card', () => {
    renderHomeBrief(root, null, NOW, false, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions: vi.fn(),
      onEditRecipe: vi.fn(),
    });
    expect(root.querySelector('.hub-home-quiet')?.textContent).toBe('Loading…');
  });
});

describe('renderLeadStrip', () => {
  it('names the lead and lists every known agent as a reassignment target', () => {
    const onLeadCommit = vi.fn();
    renderLeadStrip(root, 'agent-relay', ['agent-helper', 'agent-relay'], { onLeadCommit });
    expect(root.textContent).toContain('Lead agent');
    expect(root.classList.contains('hub-lead-empty')).toBe(false);
    const select = root.querySelector('select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['agent-helper', 'agent-relay']);
    expect(select.value).toBe('agent-relay');

    select.value = 'agent-helper';
    select.dispatchEvent(new Event('change'));
    expect(onLeadCommit).toHaveBeenCalledWith('agent-helper');
  });

  it('picking the agent that already leads commits nothing', () => {
    const onLeadCommit = vi.fn();
    renderLeadStrip(root, 'agent-relay', ['agent-helper'], { onLeadCommit });
    const select = root.querySelector('select') as HTMLSelectElement;
    // Positive control that this select can fire at all is the test above.
    select.value = 'agent-relay';
    select.dispatchEvent(new Event('change'));
    expect(onLeadCommit).not.toHaveBeenCalled();
  });

  it('an empty seat reads as a state to fix, and still offers the attached agents', () => {
    const onLeadCommit = vi.fn();
    renderLeadStrip(root, undefined, ['agent-helper'], { onLeadCommit });
    expect(root.textContent).toContain('No lead agent');
    expect(root.classList.contains('hub-lead-empty')).toBe(true);
    const select = root.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('');
    select.value = 'agent-helper';
    select.dispatchEvent(new Event('change'));
    expect(onLeadCommit).toHaveBeenCalledWith('agent-helper');
  });

  it('with nothing to pick from it says the seat is empty rather than showing a dead dropdown', () => {
    renderLeadStrip(root, undefined, [], { onLeadCommit: vi.fn() });
    expect(root.textContent).toContain('No lead agent');
    expect(root.querySelector('select')).toBeNull();
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

  // Design point 5's panel half: the blocked state lives HERE, on the task,
  // as the amber note under the key fields — not on Home, not in the
  // walkthrough, not as a row badge.
  it('shows the blocked note, with the count and the names, when the open task holds work up', () => {
    const gate = task({ assignee: 'human', title: 'Turn on the tunnel' });
    const tasks = [
      gate,
      task({ title: 'Ship the widget', after: [gate.id] }),
      task({ title: 'Wire the badge', after: [gate.id] }),
    ];
    // The row the app hands down — the same derivation the old Home band used.
    const row = humanBlockerRows(tasks).find((r) => r.task.id === gate.id);
    expect(row).toBeDefined(); // the fixture is not vacuous
    renderTaskDetail(root, gate, { ...detailHandlers(), blocked: row });
    const note = root.querySelector<HTMLElement>('.hub-blocked-note');
    expect(note).not.toBeNull();
    // The chip must agree with the sentence beside it: this task IS the
    // blocker ("Blocking 2 tasks: …"), so a chip reading "Blocked" would
    // assert the opposite dependency direction.
    expect(note?.querySelector('.hub-decide-k')?.textContent).toBe('Blocking');
    expect(note?.textContent).toContain('Blocking 2 tasks: Ship the widget, Wire the badge');
    // Under the key fields, above everything else — where the reader looks
    // for what state the task is in.
    expect(note?.previousElementSibling?.className).toContain('hub-detail-fields');
  });

  it('renders no blocked note on an agent task or a task nothing waits on', () => {
    const agentGate = task({ assignee: 'Helper', title: 'Land the schema change' });
    const idle = task({ assignee: 'human', title: 'Read the retro' });
    const tasks = [agentGate, idle, task({ after: [agentGate.id] })];
    for (const open of [agentGate, idle]) {
      // Asserted through the same derivation the app uses, not a bare absent
      // param: neither task earns a row, so the panel is handed nothing.
      const row = humanBlockerRows(tasks).find((r) => r.task.id === open.id);
      expect(row).toBeUndefined();
      renderTaskDetail(root, open, { ...detailHandlers(), blocked: row });
      expect(root.querySelector('.hub-blocked-note')).toBeNull();
    }
  });

  /**
   * The voice half of the redesign. Opening a task from the board is a CLICK
   * on a task row, so focus stayed on the row — and a row is not "the page",
   * which is what `spaceHoldTargetsPage` requires. Hold-to-talk was therefore
   * dead for as long as any task was open ("holding space does nothing").
   */
  it('takes focus on open and declares itself page-like for the Space hold', () => {
    const opener = document.createElement('div');
    opener.tabIndex = 0;
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    renderTaskDetail(root, task({ id: 't-focus' }), detailHandlers());
    const panel = root.querySelector<HTMLElement>('.hub-detail-panel');
    expect(panel).toBeTruthy();
    expect(panel?.getAttribute('data-space-hold')).toBe('page');
    expect(document.activeElement).toBe(panel);
  });

  /** A repaint must not re-take it: the panel repaints on every board change,
   *  and one that grabbed focus would pull the caret out of the composer
   *  every time a peer's comment landed. */
  it('does not re-take focus on a repaint of the same task', async () => {
    const t = task({ id: 't-repaint' });
    const withComposer = () => ({ ...detailHandlers(), onComment: vi.fn() });
    const discussion = { loading: false, threads: [] };
    renderTaskDetail(root, t, withComposer(), discussion);
    const ta = root.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    // Positive control: there IS something else focusable in the panel, so
    // "focus went back to the composer" below is a decision rather than an
    // empty panel with nowhere else for it to go.
    expect(ta).toBeTruthy();
    await typeInComposer(ta as HTMLTextAreaElement, 'half a sentence');

    renderTaskDetail(root, t, withComposer(), discussion);
    await frame();
    const panel = root.querySelector('.hub-detail-panel');
    const rebuilt = root.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    expect(document.activeElement).not.toBe(panel);
    expect(isComposerFocused(rebuilt as HTMLTextAreaElement)).toBe(true);
    expect(rebuilt?.value).toBe('half a sentence');
  });

  // Goal moved out of the reference list at the bottom and into the key-fields
  // row under the title, so this reads the row it now lives in.
  const metaValue = (key: string): string | null => {
    const dts = [...root.querySelectorAll('.hub-detail-fields dt')];
    const dds = [...root.querySelectorAll('.hub-detail-fields dd')];
    const i = dts.findIndex((dt) => dt.textContent === key);
    return i === -1 ? null : (dds[i]?.textContent ?? null);
  };

  // The board spends a whole section header naming the goal; the panel you
  // open to find out what a task is FOR printed `g1-loop`. An id is a fact
  // about the store, not an answer to "which goal does this serve".
  it('names the goal the way the board does', () => {
    renderTaskDetail(root, task({ goal: 'g-pr' }), {
      ...detailHandlers(),
      goalLabel: (id) => goalLabel(GOALS, id),
    });
    expect(metaValue('Goal')).toBe('1. Get the PR out');
  });

  // Backlog is a real section with a real header, and it is also where an
  // orphaned task lands — so both have to say Backlog here, not `chores`.
  it('says Backlog for a chore and for a goal that no longer exists', () => {
    for (const goal of [CHORES_ID, 'g-deleted']) {
      root.replaceChildren();
      renderTaskDetail(root, task({ goal }), {
        ...detailHandlers(),
        goalLabel: (id) => goalLabel(GOALS, id),
      });
      expect(metaValue('Goal')).toBe('Backlog');
    }
  });

  it('falls back to the id when no lookup is wired in', () => {
    renderTaskDetail(root, task({ goal: 'g-pr' }), detailHandlers());
    // Positive control for the tests above: the label comes from the lookup,
    // so without one the row still says something rather than going blank.
    expect(metaValue('Goal')).toBe('g-pr');
  });

  describe('the history rows say who moved the task and what they said', () => {
    const moved = (t: Partial<HubTask['transitions'][number]>) =>
      task({
        status: 'done',
        transitions: [
          {
            ts: NOW - 60_000,
            from: 'in-progress',
            to: 'done',
            by: { name: 'Search Revamp', kind: 'agent' },
            ...t,
          },
        ],
      });

    const rows = () => [...root.querySelectorAll('.hub-detail-transitions > li')];

    it('names the actor and the move', () => {
      renderTaskDetail(root, moved({}), detailHandlers());
      const row = rows()[0];
      expect(row?.textContent).toContain('Search Revamp');
      expect(row?.textContent).toContain('in-progress → done');
    });

    it('carries the note, which is the whole of what the trail keeps', () => {
      renderTaskDetail(root, moved({ note: 'merged as #402' }), detailHandlers());
      expect(rows()[0]?.textContent).toContain('merged as #402');
    });

    // Evidence support was removed on 2026-08-25. Rows recorded before that
    // still hold `evidence` and `amendments` in the store; the panel is built
    // from the projection, which no longer carries either, so nothing here can
    // print a commit at all.
    it('says nothing about proof, for or against', () => {
      renderTaskDetail(root, moved({}), detailHandlers());
      const row = rows()[0];
      expect(row?.classList.contains('unproven')).toBe(false);
      expect(row?.textContent?.toLowerCase()).not.toContain('evidence');
    });
  });

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
    // The third argument is the option id, absent for free text. One `answer`
    // path serves both the buttons and the box, which is why it is always
    // passed rather than only when there is one.
    expect(onAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ id: d.id }),
      'Go with option B, ship Thursday.',
      undefined,
    );
  });

  it("says Answered by you when the task's own answer is the reader's — same voice as a thread record", () => {
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
      selfName: 'Jordan',
    });
    expect(root.querySelector('.hub-detail-answer')?.textContent).toBe(
      'Answered by you: “Option B”',
    );
  });

  it("names who filed the ticket on the task's own decision card, as a thread card names its asker", () => {
    const d = task({
      needs: 'decision',
      assignee: 'human',
      body: 'Blue or green? Blocked until answered: the banner.',
      createdBy: 'UX Bot',
      createdAt: NOW - 3_600_000,
    });
    renderTaskDetail(root, d, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAssign: vi.fn(),
      now: NOW,
    });
    expect(root.querySelector('.hub-decide-meta')?.textContent).toBe('Asked by UX Bot 1 hour ago');
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

  // A shaped task carries the words it was shaped FROM, and an unlabelled
  // blockquote above a rewritten description cannot say which of the two
  // readings it is — "here is what you said" or "here is a source". Those want
  // opposite reactions from the reader, and every shaped row carries one.
  it('labels a preserved capture so it reads as provenance, not as a stray quote', () => {
    renderTaskDetail(
      root,
      task({
        quote: 'we should let people rename a goal without losing the tasks under it',
        body: 'Agent can rename a goal so that filed work survives the rename.',
      }),
      detailHandlers(),
    );
    const fig = root.querySelector('.hub-detail-quote-block');
    expect(fig).toBeTruthy();
    expect(fig?.querySelector('.hub-detail-quote-label')?.textContent).toBe('Original words');
    // The words themselves survive the wrapper — the label must not be the
    // only thing that made it into the DOM.
    expect(fig?.querySelector('.hub-detail-quote')?.textContent).toContain(
      'without losing the tasks under it',
    );
    // The label belongs to the quote, not to the panel: it is inside the
    // block, so nothing reads it as a heading over anything else.
    expect(root.querySelector('.hub-detail-quote-label')?.closest('.hub-detail-quote-block')).toBe(
      fig,
    );
  });

  // He sees his own superseded words above the description he maintains, every
  // time he opens the task. The ask was that they be MOVED and HIDDEN, never
  // dropped — so all three of these assert together, and the last one is what
  // stops "hidden" from being satisfied by deleting the preservation.
  it('keeps the preserved capture reachable but below the description, closed by default', () => {
    renderTaskDetail(
      root,
      task({
        quote: 'the original words, verbatim',
        body: 'Agent can rename a goal so that filed work survives the rename.',
      }),
      detailHandlers(),
    );
    const quote = root.querySelector('.hub-detail-quote-block') as HTMLDetailsElement;
    const desc = root.querySelector('.hub-detail-body');
    expect(quote).toBeTruthy();
    expect(desc).toBeTruthy();
    // Closed: `open` is absent, so the words are one tap away rather than in
    // the reader's face.
    expect(quote.hasAttribute('open')).toBe(false);
    // Below: DOCUMENT_POSITION_FOLLOWING from the description means the quote
    // comes after it. Asserted as a relationship rather than an index, so
    // inserting anything else between them cannot silently pass.
    expect(desc!.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Not dropped.
    expect(quote.textContent).toContain('the original words, verbatim');
  });

  // The same failure the walkthrough card had: `open` on a `<details>` lives
  // only in the DOM, and this panel repaints on every board event — so the
  // words the reader had just opened folded away a second later, with nothing
  // they did to cause it.
  it('keeps the capture open across a repaint once the reader opens it', () => {
    const t = task({ quote: 'the original words, verbatim' });
    renderTaskDetail(root, t, detailHandlers());
    const quote = root.querySelector('.hub-detail-quote-block') as HTMLDetailsElement;
    quote.open = true;
    // The board event lands: same task, a fresh panel.
    renderTaskDetail(root, t, detailHandlers());
    expect((root.querySelector('.hub-detail-quote-block') as HTMLDetailsElement).open).toBe(true);
    // …and opening a DIFFERENT task still starts closed — the reader chose to
    // read one task's capture, not every task's.
    renderTaskDetail(root, task({ quote: 'someone else’s words' }), detailHandlers());
    expect((root.querySelector('.hub-detail-quote-block') as HTMLDetailsElement).open).toBe(false);
  });

  it('shows no quote block at all on a task that never had one', () => {
    // Positive control first: the label renders when there IS a quote, so its
    // absence below means the branch was skipped rather than that this test
    // renders an empty panel.
    renderTaskDetail(root, task({ quote: 'the thing I actually said' }), detailHandlers());
    expect(root.querySelector('.hub-detail-quote-label')).toBeTruthy();

    renderTaskDetail(
      root,
      task({ body: 'A task filed with no captured words.' }),
      detailHandlers(),
    );
    expect(root.querySelector('.hub-detail-quote-block')).toBeNull();
    expect(root.querySelector('.hub-detail-quote-label')).toBeNull();
    // …on a panel that did render: the description is right there.
    expect(root.querySelector('.hub-detail-body')?.textContent).toContain('no captured words');
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

  it('the assignee row picks who takes it — the same choice the board row offers', () => {
    const onAssign = vi.fn();
    const t = task({ assignee: 'agent' });
    renderTaskDetail(root, t, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAssign,
      knownAgentIds: ['Index Rebuild'],
    });
    const pick = root.querySelector('.hub-assignee-btn') as HTMLSelectElement;
    // Nobody owns it yet — the generic word is not somebody.
    expect(pick.value).toBe('');
    expect([...pick.options].map((o) => o.value)).toEqual(
      expect.arrayContaining(['human', 'Index Rebuild']),
    );
    pick.value = 'Index Rebuild';
    pick.dispatchEvent(new Event('change'));
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'Index Rebuild');
  });
});

/**
 * The task detail panel is where a person pushes back on a task. Before this,
 * the only comment affordance on the board was a LINK to the task doc — so
 * disagreeing with a task meant leaving the board, and in practice it meant
 * saying it in chat instead, where it reaches nobody the task reaches.
 */
describe('renderTaskDetail — discussion', () => {
  const detailHandlers = (over: Record<string, unknown> = {}) => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
    onComment: vi.fn(),
    ...over,
  });

  const thread = (over: Partial<TaskThread> = {}): TaskThread => ({
    id: 'th-1',
    comments: [{ author: 'Jordan', text: 'Is the index really first?', ts: NOW }],
    ...over,
  });

  const askItem = (over: Record<string, unknown> = {}) => ({
    kind: 'task-thread' as const,
    docId: 'task:t-1',
    threadId: 'th-1',
    taskId: 't-1',
    title: 'Some task',
    ask: 'Bryan: should we drop threading, or keep it for the 3 orphans?',
    askedBy: 'Live Feedback',
    since: NOW - 3_600_000,
    direct: true,
    ...over,
  });

  /**
   * The measured break in the review loop: the strip said something needed
   * him, and opening it showed a task rather than the request. The ask was
   * computed server-side and rendered on the strip the whole time — the panel
   * simply never received it.
   */
  /**
   * Found in a real browser at 430px, not in a unit test: opening a review
   * item left the panel at `scrollTop: 112` with the ask panel's heading cut
   * off above the fold. The deep link centres the focused thread, and the ask
   * panel had just hoisted that same thread's question to the top — so the
   * reader landed mid-page on a second copy of what they came for.
   *
   * happy-dom implements no `scrollIntoView`, so the element gets a stub and
   * the render's own `typeof === 'function'` guard does the rest.
   */
  const withScrollSpy = (fn: () => void): string[] => {
    const scrolled: string[] = [];
    const proto = (root.ownerDocument.defaultView as unknown as { Element: typeof Element }).Element
      .prototype as Element & { scrollIntoView?: unknown };
    const had = 'scrollIntoView' in proto;
    (proto as { scrollIntoView?: unknown }).scrollIntoView = function scrollIntoView(
      this: HTMLElement,
    ) {
      scrolled.push(this.dataset?.threadId ?? this.className);
    };
    try {
      fn();
    } finally {
      if (!had) {
        (proto as { scrollIntoView?: unknown }).scrollIntoView = undefined;
      }
    }
    return scrolled;
  };

  it('does not scroll past the review queue to the thread it already quotes', () => {
    const scrolled = withScrollSpy(() => {
      renderTaskDetail(
        root,
        task({ id: 't-1' }),
        detailHandlers({ asks: [askItem({ threadId: 'th-1' })], now: NOW, focusThreadId: 'th-1' }),
        { loading: false, threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })] },
      );
    });
    // The panel is still aimed at that thread — this is about where the
    // viewport lands, not about losing the deep link.
    expect(root.querySelector('.hub-comment-focus')).toBeTruthy();
    expect(root.querySelector('.hub-decide-card[data-review-thread-id="th-1"]')).toBeTruthy();
    expect(scrolled).toEqual([]);
  });

  /** Positive control: the spy CAN see a scroll, and centring is still right
   *  when the focused thread is not the one the queue is carrying. */
  it('still centres a focused thread the review queue is not about', () => {
    const scrolled = withScrollSpy(() => {
      renderTaskDetail(
        root,
        task({ id: 't-1' }),
        detailHandlers({ asks: [askItem({ threadId: 'th-1' })], now: NOW, focusThreadId: 'th-2' }),
        { loading: false, threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })] },
      );
    });
    expect(scrolled).toEqual(['th-2']);
  });

  it('states the ask at the top of the panel, above the description', () => {
    const t = task({ id: 't-1', body: 'The description, which is not the ask.' });
    renderTaskDetail(root, t, detailHandlers({ asks: [askItem()], now: NOW }), {
      loading: false,
      threads: [thread()],
    });
    const ask = root.querySelector('.hub-decide');
    expect(ask).toBeTruthy();
    expect(ask?.querySelector('.hub-decide-headline')?.textContent).toContain(
      'should we drop threading',
    );
    // Above the description — the requirement is "without scrolling on a
    // 430px phone", and a panel that opens on nine rows of identical metadata
    // spends the first screen on facts that are the same for every task.
    const desc = root.querySelector('.hub-detail-body');
    expect(desc).toBeTruthy();
    expect(ask!.compareDocumentPosition(desc!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and it says who is waiting, and how long they have been — the same
    // asked-by spelling every card head carries.
    expect(root.querySelector('.hub-decide-meta')?.textContent).toBe(
      'Asked by Live Feedback 1 hour ago',
    );
  });

  /** "Answer without leaving the screen you landed on." A button that scrolls
   *  to a composer further down the page satisfies that on a desktop only. */
  it('replies to the asking thread from the review card itself', async () => {
    const onAnswerThread = vi.fn().mockResolvedValue(true);
    const t = task({ id: 't-1' });
    renderTaskDetail(
      root,
      t,
      detailHandlers({ asks: [askItem({ threadId: 'th-9' })], now: NOW, onAnswerThread }),
      { loading: false, threads: [thread({ id: 'th-9' })] },
    );
    const form = root.querySelector('.hub-decide-form') as HTMLFormElement;
    expect(form).toBeTruthy();
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Drop it, and prefix the 3 orphans.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // Posts onto the thread that asked, not into a new one — a reply that
    // opens a fresh thread is how an answer stops being an answer.
    expect(onAnswerThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      expect.objectContaining({ threadId: 'th-9' }),
      'Drop it, and prefix the 3 orphans.',
      undefined,
    );
    // The box is cleared as the answer goes, not after it lands: the write
    // repaints the panel from inside its own await, and a clear that runs
    // afterwards lands on a textarea that is no longer in the document.
    expect(ta.value).toBe('');
  });

  /**
   * The card sits directly under the panel's own `.hub-detail-title`, so a
   * headline that came out as the ticket title prints the same words twice in
   * a row — which is the whole of what the reader sees before the body. It is
   * a real shape and not a contrived one: `panelReviewQueue` falls back to
   * `task.title` for a decision whose body yields no blurb.
   */
  it('drops a headline that only repeats the ticket title the panel already shows', () => {
    const t = task({ id: 't-1', title: 'Rename the catch-all band' });
    renderTaskDetail(
      root,
      t,
      detailHandlers({
        asks: [
          askItem({
            review: {
              shape: 'review' as const,
              headline: 'Rename the catch-all band',
              detail: 'Two bands answer to the same word and the picker shows both.',
            },
          }),
        ],
        now: NOW,
      }),
      { loading: false, threads: [thread()] },
    );
    expect(root.querySelector('.hub-detail-title')?.textContent).toBe('Rename the catch-all band');
    expect(root.querySelector('.hub-decide-headline')).toBeNull();
    // Nothing was swallowed with it: the card still carries the body, which
    // is the condition the drop is gated on.
    expect(root.querySelector('.hub-decide-body')?.textContent).toContain('Two bands answer');
  });

  /** The control: a headline that says something the title does not is the
   *  ordinary case and still renders, so the absence above is a comparison
   *  rather than a card that stopped drawing its heading. */
  it('keeps a headline that says more than the ticket title', () => {
    const t = task({ id: 't-1', title: 'Rename the catch-all band' });
    renderTaskDetail(
      root,
      t,
      detailHandlers({
        asks: [
          askItem({
            review: {
              shape: 'review' as const,
              headline: 'Call it Backlog, or something narrower?',
            },
          }),
        ],
        now: NOW,
      }),
      { loading: false, threads: [thread()] },
    );
    expect(root.querySelector('.hub-decide-headline')?.textContent).toBe(
      'Call it Backlog, or something narrower?',
    );
  });

  /**
   * The "Flagged for you — not addressed to you by name" heading is gone (mock
   * direction). It hedged because an item whose `direct` came back false might
   * not be a question at all — measured on the live board 2026-08-17: 23
   * review items, **0** of them `direct`. The server decides membership now, so
   * the row it hedged about does not arrive, and the apology was sitting in the
   * reader's most prominent line.
   */
  it('heads an item nobody was named on with the plain review heading', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1' }),
      detailHandlers({
        asks: [askItem({ direct: false, ask: 'Done in PR #154 — CI green, not merged.' })],
        now: NOW,
      }),
      { loading: false, threads: [thread()] },
    );
    const kicker = root.querySelector('.hub-decide-kicker')?.textContent ?? '';
    expect(kicker).toBe('Waiting on your review');
    expect(kicker).not.toContain('not addressed to you by name');
    // The words are still shown — the heading changed, nothing was withheld.
    expect(root.querySelector('.hub-decide-headline')?.textContent).toContain('PR #154');
  });

  /** The pair to the case above: a direct question reads identically, which is
   *  the point of dropping the third heading rather than an accident of it. */
  it('calls a direct question a question', () => {
    renderTaskDetail(root, task({ id: 't-1' }), detailHandlers({ asks: [askItem()], now: NOW }), {
      loading: false,
      threads: [thread()],
    });
    expect(root.querySelector('.hub-decide-kicker')?.textContent).toContain(
      'Waiting on your review',
    );
  });

  /**
   * Reported with a screenshot 2026-08-19: *"the review request up top is
   * missing all of the necessary details -- please fix. I see they're in the
   * review request at the bottom."*
   *
   * A declared item arrives with a `review` payload the agent WROTE for this
   * card — why it matters, what to review for, and the detail that carries the
   * links to the thing under review. The panel rendered the headline alone, so
   * everything that made the headline actionable was reachable only by
   * scrolling to the comment at the bottom. The card that fix landed on has
   * since become the panel's review QUEUE; these assert the same payload
   * survives the move, markdown detail included.
   */
  const declared = (over: Record<string, unknown> = {}) => ({
    shape: 'review' as const,
    headline: 'The rollup query is ready to look at',
    detail:
      'It blocks the nightly job, which is paused until someone signs off.\n\nWhether the join drops rows when a session has no events.\n\nThe change is in [the rollup PR](https://example.test/pr/12) — two files.',
    ...over,
  });

  it('renders the declared review payload as one markdown body, links and all', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1' }),
      detailHandlers({
        asks: [askItem({ review: declared(), ask: declared().headline })],
        now: NOW,
      }),
      { loading: false, threads: [thread()] },
    );
    const card = root.querySelector('.hub-decide-card');
    expect(card).toBeTruthy();
    expect(card?.querySelector('.hub-decide-headline')?.textContent).toContain('rollup query');
    // ONE body (approved design): the payload's `detail`, markdown-rendered,
    // no labelled sub-sections and none of the old paragraphs.
    expect(card?.querySelector('.hub-decide-why')).toBeNull();
    expect(card?.querySelector('.hub-decide-lookfor')).toBeNull();
    expect(card?.querySelector('.hub-decide-detail')).toBeNull();
    const body = card?.querySelector('.hub-decide-body') as HTMLElement;
    const text = body.textContent ?? '';
    const first = text.indexOf('blocks the nightly job');
    const second = text.indexOf('drops rows when a session has no events');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    // The detail is markdown, so the link to the thing under review is a real
    // link rather than bracket soup — the reason the detail exists at all.
    const link = body.querySelector('a') as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('https://example.test/pr/12');
    expect(link?.textContent).toBe('the rollup PR');
    // The head badge is the item's kind, in the new UI vocabulary: a declared
    // `review` shape reads Question (the class token stays `review`).
    expect(card?.querySelector('.hub-decide-k')?.textContent).toBe('Question');
    expect(card?.querySelector('.hub-decide-k')?.className).toContain('hub-decide-k-review');
  });

  it('offers a declared item’s options as one-tap answers on its own thread', () => {
    const onAnswerThread = vi.fn().mockResolvedValue(true);
    const t = task({ id: 't-1' });
    renderTaskDetail(
      root,
      t,
      detailHandlers({
        asks: [
          askItem({
            threadId: 'th-9',
            review: declared({
              shape: 'decision',
              options: [
                { id: 'keep', label: 'Keep threading', detail: 'Costs a migration.' },
                { id: 'drop', label: 'Drop threading' },
              ],
            }),
          }),
        ],
        now: NOW,
        onAnswerThread,
      }),
      { loading: false, threads: [thread({ id: 'th-9' })] },
    );
    const opts = root.querySelectorAll('.hub-decide-card .hub-decide-option');
    expect(opts).toHaveLength(2);
    expect(opts[0]?.querySelector('.hub-decide-option-label')?.textContent).toBe('Keep threading');
    expect(opts[0]?.querySelector('.hub-decide-option-detail')?.textContent).toBe(
      'Costs a migration.',
    );
    // The second has no detail, so no detail element — not an empty one.
    expect(opts[1]?.querySelector('.hub-decide-option-detail')).toBeNull();
    // The LABEL is the verbatim answer, and it lands on the thread that ASKED
    // rather than opening a new one.
    (opts[1] as HTMLButtonElement).click();
    expect(onAnswerThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      expect.objectContaining({ threadId: 'th-9' }),
      'Drop threading',
      'drop',
    );
    // Tapping is a shortcut, never a closed set — the free-text box stays.
    const form = root.querySelector('.hub-decide-form') as HTMLFormElement;
    expect(form).toBeTruthy();
    expect(form.querySelector('.hub-decide-form-hint')?.textContent).toContain('your own words');
  });

  /** Positive control: the declared payload is ADDITIVE. An item with no
   *  declaration is the card as it was — the comment itself as the headline,
   *  and nothing invented under it. */
  it('leaves an undeclared ask exactly as it was', () => {
    renderTaskDetail(root, task({ id: 't-1' }), detailHandlers({ asks: [askItem()], now: NOW }), {
      loading: false,
      threads: [thread()],
    });
    const card = root.querySelector('.hub-decide-card');
    expect(card?.querySelector('.hub-decide-headline')?.textContent).toContain(
      'should we drop threading',
    );
    // Nothing declared means nothing composed: no body at all, not an empty one.
    expect(card?.querySelector('.hub-decide-body')).toBeNull();
    expect(card?.querySelectorAll('.hub-decide-option')).toHaveLength(0);
    const form = root.querySelector('.hub-decide-form') as HTMLFormElement;
    expect(form.querySelector('.hub-decide-form-hint')?.textContent).toBe(
      'Answer in your own words',
    );
  });

  it('shows no review queue on a task nothing is waiting on', () => {
    renderTaskDetail(root, task({ id: 't-1' }), detailHandlers({ asks: [], now: NOW }), {
      loading: false,
      threads: [thread()],
    });
    expect(root.querySelector('.hub-decide')).toBeNull();
    // Positive control: the panel rendered at all, so the null above is about
    // the queue and not about an empty container.
    expect(root.querySelector('.hub-comment')).toBeTruthy();
  });

  /** Reported as "comments do not say who they are from, or whether they are a
   *  request for my input". The author was already there; the TIME was in a
   *  `title` attribute, which is a hover tooltip on a surface read on a
   *  phone, and the request marking did not exist at all. */
  it('shows each comment author and time as text, and leaves waiting to the queue', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1' }),
      detailHandlers({ asks: [askItem({ threadId: 'th-w' })], now: NOW }),
      {
        loading: false,
        threads: [
          thread({
            id: 'th-w',
            comments: [{ author: 'Live Feedback', text: 'Which way?', ts: NOW - 7_200_000 }],
          }),
          thread({ id: 'th-quiet' }),
        ],
      },
    );
    const waiting = root.querySelector('.hub-comment[data-thread-id="th-w"]');
    expect(waiting?.querySelector('.hub-comment-author')?.textContent).toBe('Live Feedback');
    // Text, not a tooltip.
    expect(waiting?.querySelector('.hub-comment-when')?.textContent).toBe('2h ago');
    // "Needs your reply" was a THREAD badge, and threading left the surface with
    // it. The signal did NOT leave: it renders once, in the queue at the top of
    // the panel, naming that same thread and nothing else — which is above the
    // fold rather than two hundred pixels down a comment stream.
    expect(root.querySelectorAll('.hub-comment [class*="needs"]')).toHaveLength(0);
    const carded = [...root.querySelectorAll<HTMLElement>('.hub-decide-card')].map(
      (c) => c.dataset.reviewThreadId,
    );
    expect(carded).toEqual(['th-w']);
  });

  /** A declared comment is a request, and the thread it lives in is usually
   *  fourteen status notes with one of these somewhere in the middle. Without
   *  its own chrome the request is the same grey block as the notes. */
  it('sets a declared comment apart, with its header above the words', () => {
    renderTaskDetail(root, task({ id: 't-1' }), detailHandlers({ now: NOW }), {
      loading: false,
      threads: [
        thread({
          id: 'th-d',
          comments: [
            { author: 'Onboarding Rework', text: 'Pushed the first pass.', ts: NOW - 7_200_000 },
            {
              author: 'Onboarding Rework',
              text: 'Both screens are built; details in the PR.',
              ts: NOW - 3_600_000,
              review: {
                shape: 'decision',
                headline: 'Where should the trial banner live?',
              },
            },
          ],
        }),
      ],
    });
    const comments = [...root.querySelectorAll('.hub-comment')];
    // The declaration rides the comment that made it, so the status note
    // above it stays a status note.
    expect(comments.map((c) => c.className.includes('hub-comment-review'))).toEqual([false, true]);
    const declared = comments[1] as HTMLElement;
    expect(declared.querySelector('.hub-comment-review-k')?.textContent).toBe('Decision');
    expect(declared.querySelector('.hub-comment-review-headline')?.textContent).toBe(
      'Where should the trial banner live?',
    );
    // The why paragraph is gone from the comment stream — it lives in the
    // review card at the top of the panel now, and a second copy here was the
    // duplication the one-card anatomy removes.
    expect(declared.querySelector('.hub-comment-review-why')).toBeNull();
    // Above the words, not instead of them — the text is what the agent said.
    expect(declared.querySelector('.hub-comment-body')?.textContent).toContain(
      'Both screens are built',
    );
  });

  /**
   * "Each item goes exactly to the place where I need to review" is the
   * strip's whole claim. On a task with several discussions, opening the task
   * is not that — the reviewer still has to find the one they were sent for.
   */
  it('marks the thread the queue aimed at, and only that one', () => {
    renderTaskDetail(root, task(), detailHandlers({ focusThreadId: 'th-2' }), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' }), thread({ id: 'th-3' })],
    });
    const marked = [...root.querySelectorAll('.hub-comment-focus')];
    // Positive control: all three rendered, so "only one marked" means
    // something. Then: it is the RIGHT one.
    expect(root.querySelectorAll('.hub-comment')).toHaveLength(3);
    expect(marked).toHaveLength(1);
    expect((marked[0] as HTMLElement).dataset.threadId).toBe('th-2');
  });

  it('marks nothing when the panel was opened any other way', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })],
    });
    expect(root.querySelectorAll('.hub-comment')).toHaveLength(2);
    expect(root.querySelectorAll('.hub-comment-focus')).toHaveLength(0);
  });

  it('shows each comment with who said it', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [
        thread({
          comments: [
            { author: 'Jordan', text: 'Is the index really first?', ts: NOW },
            { author: 'Search Revamp', text: 'It unblocks two others.', ts: NOW + 1000 },
          ],
        }),
      ],
    });
    const comments = root.querySelectorAll('.hub-comment');
    expect(comments).toHaveLength(2);
    expect(comments[0]?.textContent).toContain('Jordan');
    expect(comments[0]?.textContent).toContain('Is the index really first?');
    expect(comments[1]?.textContent).toContain('Search Revamp');
  });

  // The acceptance: an empty description is the NORMAL state of a task worth
  // arguing about, so the composer cannot be gated on there being something
  // to reply to.
  it('offers a composer on a task with no description and no comments', () => {
    const onComment = vi.fn();
    const t = task({ body: undefined });
    renderTaskDetail(root, t, detailHandlers({ onComment }), { loading: false, threads: [] });

    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    expect(form).toBeTruthy();
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'This assumes the index ships first.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // No threadId — a new thread about the task itself.
    expect(onComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
      'This assumes the index ships first.',
      undefined,
    );
  });

  /** Design point 4: every composer is a live markdown editor. */
  it('the discussion composer is a markdown editor', () => {
    renderTaskDetail(root, task(), detailHandlers(), { loading: false, threads: [] });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    expect(surfaceOf(ta)?.querySelector('.ProseMirror')).not.toBeNull();
    ta.value = '**two hops**';
    refreshMarkdownComposer(ta);
    expect(renderedHtml(ta)).toContain('<strong>two hops</strong>');
  });

  it('the review card answer box is a markdown editor too', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1' }),
      detailHandlers({ asks: [askItem({ threadId: 'th-1' })], now: NOW }),
      { loading: false, threads: [thread({ id: 'th-1' })] },
    );
    const form = root.querySelector('.hub-decide-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    expect(surfaceOf(ta)?.querySelector('.ProseMirror')).not.toBeNull();
  });

  /**
   * The acceptance line for the two-composers report: "a task with one thread
   * presents exactly one obvious way to reply". It used to present two — a
   * reply box inside the thread and a new-thread box under it, distinguishable
   * only by placeholder text.
   */
  it('offers exactly one composer, whatever the thread count', () => {
    for (const threads of [
      [],
      [thread({ id: 'th-1' })],
      [thread({ id: 'th-1' }), thread({ id: 'th-2' }), thread({ id: 'th-3' })],
    ]) {
      renderTaskDetail(root, task(), detailHandlers(), { loading: false, threads });
      expect(root.querySelectorAll('.hub-discussion textarea')).toHaveLength(1);
    }
    // Positive control: the last pass really did render three threads, so the
    // count above is one composer over three conversations, not an empty panel.
    expect(root.querySelectorAll('.hub-comment')).toHaveLength(3);
  });

  /**
   * The destination is DERIVED and never announced. Bryan, 2026-08-18: *"Stop
   * supporting threaded comments and clean up all code related to this! Clean
   * up the UX too."* So there is no Reply button, no "Replying to …" bar and no
   * "New thread" control — but a comment still has to REACH the agent watching
   * the conversation, which is what this asserts.
   */
  it('sends a comment to the newest conversation, with nothing on screen saying so', () => {
    const onComment = vi.fn();
    const t = task();
    renderTaskDetail(root, t, detailHandlers({ onComment }), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-77' })],
    });
    // Not merely "no reply buttons": no control anywhere names a thread.
    expect(root.querySelector('.hub-comment-reply')).toBeNull();
    expect(root.querySelector('.hub-composer-target')).toBeNull();
    expect(root.querySelector('.hub-composer-switch')).toBeNull();
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Because it unblocks two others.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
      'Because it unblocks two others.',
      'th-77',
    );
  });

  it('the queue’s aim wins over the default, so you answer what you were sent for', () => {
    const onComment = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onComment, focusThreadId: 'th-1' }), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })],
    });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Yes, ship it.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenLastCalledWith(expect.anything(), 'Yes, ship it.', 'th-1');
  });

  /** A deep link can outlive the thread it names. Falling back to the newest
   *  live conversation keeps the comment reaching somebody; the alternative the
   *  title warns about is a `threadId` the server cannot resolve. */
  it('an aim that no longer resolves falls back to a live thread, not into nowhere', () => {
    const onComment = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onComment, focusThreadId: 'th-deleted' }), {
      loading: false,
      threads: [thread({ id: 'th-1' })],
    });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Still worth saying.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenLastCalledWith(expect.anything(), 'Still worth saying.', 'th-1');
  });

  /** …and with nothing to fall back to it opens one, rather than sending an id
   *  it made up. The pair is the point: neither answer is "no destination". */
  it('opens a conversation when the task has none', () => {
    const onComment = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onComment }), { loading: false, threads: [] });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'First word on this.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenLastCalledWith(expect.anything(), 'First word on this.', undefined);
  });

  /**
   * Nothing an agent posts may stop arriving. An agent's comment lands as a
   * thread on `task:<id>` — anchored or not, open or resolved — and every one
   * of them has to appear in the one stream, in time order, with no per-thread
   * chrome telling them apart. The discussion model now guarantees the last
   * half structurally: `TaskThread` carries only id + comments, so there is
   * no status or anchor left for a render to distinguish rows by.
   */
  it('puts every thread’s comments in one stream, with nothing telling them apart', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [thread({ id: 'th-open' }), thread({ id: 'th-subject' }), thread({ id: 'th-done' })],
    });
    const rows = [...root.querySelectorAll<HTMLElement>('.hub-comment')];
    expect(rows.map((r) => r.dataset.threadId)).toEqual(['th-open', 'th-subject', 'th-done']);
    // The anchor quote was the last place a thread showed through in the UX.
    expect(root.querySelector('.hub-comment-anchor')).toBeNull();
    // One box for all three, at the end of the stream.
    const boxes = [...root.querySelectorAll('.hub-discussion textarea')];
    expect(boxes).toHaveLength(1);
    const form = root.querySelector('.hub-comment-form') as HTMLElement;
    expect(rows[2]!.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * A comment lost to a dropped connection is worse than one that never
   * sent: the box is empty, the toast is gone in three seconds, and the
   * person believes they said it. The text stays put until the post is
   * acknowledged.
   */
  it('keeps the text in the box when the post fails', async () => {
    const onComment = vi.fn(() => Promise.resolve(false));
    renderTaskDetail(root, task(), detailHandlers({ onComment }), {
      loading: false,
      threads: [],
    });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'This is below the API work.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.value).toBe('This is below the API work.');
    expect(ta.disabled).toBe(false);
  });

  // Positive control: the box does empty on the ordinary path, so the test
  // above is about the failure and not about a box that never clears.
  it('empties the box once the post is acknowledged', async () => {
    const onComment = vi.fn(() => Promise.resolve(true));
    renderTaskDetail(root, task(), detailHandlers({ onComment }), {
      loading: false,
      threads: [],
    });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Agreed, it goes first.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.value).toBe('');
  });

  it('an empty box posts nothing', () => {
    const onComment = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onComment }), { loading: false, threads: [] });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = '   ';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).not.toHaveBeenCalled();
  });

  // A resolved thread is still part of the argument. Hiding it here would
  // repeat the drawer bug where a reply existed in the store and no surface
  // could reach it. What went away with threading is the STATUS chrome — and
  // now the status itself never crosses the fetch boundary (`TaskThread`
  // carries only id + comments), so a comment reads as a comment whatever
  // the thread around it is marked. `status` is untouched in storage.
  it('keeps a resolved thread’s words in the stream, with no status chrome', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [thread({ id: 'th-r' })],
    });
    const el = root.querySelector('.hub-comment') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('Is the index really first?');
    expect(el.classList.contains('hub-comment-resolved')).toBe(false);
    expect(el.querySelector('.hub-comment-status')).toBeNull();
  });

  // Grounded in the fetch, not inferred from anything: the panel says
  // "loading" only while a load is actually in flight.
  it('distinguishes "still loading" from "nothing to say yet"', () => {
    renderTaskDetail(root, task(), detailHandlers(), { loading: true, threads: [] });
    expect(root.querySelector('.hub-discussion-loading')).toBeTruthy();
    expect(root.querySelector('.hub-discussion-empty')).toBeNull();

    renderTaskDetail(root, task(), detailHandlers(), { loading: false, threads: [] });
    expect(root.querySelector('.hub-discussion-loading')).toBeNull();
    expect(root.querySelector('.hub-discussion-empty')).toBeTruthy();
  });

  it('renders comment text as inert markup', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [
        thread({
          comments: [{ author: 'Jordan', text: '<img src=x onerror="boom()"> **real**', ts: NOW }],
        }),
      ],
    });
    const body = root.querySelector('.hub-comment-body') as HTMLElement;
    expect(body.querySelector('img')).toBeNull();
    expect(body.innerHTML).toContain('<strong>real</strong>');
  });

  // Without a discussion argument at all the panel is exactly what it was —
  // the hub renders detail before the threads have been fetched.
  it('renders with no discussion supplied', () => {
    renderTaskDetail(root, task({ title: 'Wire the index' }), detailHandlers());
    expect(root.querySelector('.hub-detail-title')?.textContent).toBe('Wire the index');
    expect(root.querySelector('.hub-comment-form')).toBeNull();
  });
});

/**
 * A comment can land while the panel is open — an agent replying to the
 * question you just asked is the case the whole surface is for. Repainting
 * the panel is how that reply appears, and repainting rebuilds the composer,
 * so the refresh has to know when someone's hands are on it.
 */
describe('discussionIsBusy', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });

  const open = () =>
    renderTaskDetail(
      root,
      task(),
      {
        onClose: vi.fn(),
        onStatusSet: vi.fn(),
        onTitleCommit: vi.fn(),
        onAnswer: vi.fn(),
        onAssign: vi.fn(),
        onComment: vi.fn(),
      },
      { loading: false, threads: [] },
    );

  // Positive control for the two below: an untouched composer is refreshable,
  // so "busy" is a statement about the typing and not about the panel.
  it('is quiet when the composer is empty and unfocused', () => {
    open();
    expect(root.querySelector('.hub-discussion textarea')).toBeTruthy();
    expect(discussionIsBusy(root)).toBe(false);
  });

  it('is busy while a draft is sitting in the composer', () => {
    open();
    const ta = root.querySelector('.hub-discussion textarea') as HTMLTextAreaElement;
    ta.value = 'I think this is below the API work because';
    expect(discussionIsBusy(root)).toBe(true);
  });

  // Focus alone counts: someone who has tapped in has not typed a character
  // yet, and yanking the field out from under them is the same rudeness.
  it('is busy while the composer has focus', () => {
    open();
    const ta = root.querySelector('.hub-discussion textarea') as HTMLTextAreaElement;
    ta.focus();
    expect(discussionIsBusy(root)).toBe(true);
  });
});

/**
 * The half `discussionIsBusy` cannot cover. That guard holds back a discussion
 * RELOAD while someone is typing, but a task transition arriving over SSE
 * repaints the whole panel through a different door (the tasks map observer),
 * and the repaint rebuilds the composer — typed-but-unsent text and focus were
 * gone and the caret dropped to body. Found while verifying the voice fix in
 * PR #222: the voice symptom went away, the text loss stayed.
 *
 * So the fix is at the choke point every repaint funnels through:
 * `renderTaskDetail` snapshots what each text control holds the instant
 * before it throws the old DOM away, and puts it back into the new one —
 * value, focus, and caret.
 */
describe('a repaint of the detail panel keeps what was typed', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });

  const handlers = () => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
    onComment: vi.fn(),
  });

  const thread = (id: string): TaskThread => ({
    id,
    comments: [{ author: 'Jordan', text: `Question in ${id}?`, ts: NOW }],
  });

  const ask = (taskId: string, threadId: string) => ({
    kind: 'task-thread' as const,
    docId: `task:${taskId}`,
    threadId,
    taskId,
    title: 'Some task',
    ask: 'Bryan: which one?',
    askedBy: 'Live Feedback',
    since: NOW - 3_600_000,
    direct: true,
  });

  const paint = (t: HubTask, extra: Record<string, unknown> = {}) =>
    renderTaskDetail(
      root,
      t,
      { ...handlers(), ...extra },
      { loading: false, threads: [thread('th-1'), thread('th-2')] },
    );

  const composer = () => root.querySelector('.hub-discussion textarea') as HTMLTextAreaElement;

  /** Type into a plain control the way a person does: value, focus, caret.
   *  The composers go through `typeInComposer` — their words live in an
   *  editor, and their caret is a ProseMirror position rather than an
   *  offset. */
  const typeInto = (el: HTMLInputElement, text: string, caret: number) => {
    el.value = text;
    el.focus();
    el.setSelectionRange(caret, caret);
  };

  it('the discussion composer survives a task transition — text, focus AND caret', async () => {
    const t = task({ status: 'todo' });
    paint(t);
    const before = composer();
    await typeInComposer(before, 'I think this is below the API work because', 12);
    expect(isComposerFocused(before)).toBe(true);

    // The SSE-driven repaint: same task, new status.
    paint({ ...t, status: 'in-progress' });
    await frame();

    // Positive control: the panel really did repaint (the status control
    // moved), so a pass below is a repaint the composer SURVIVED rather than
    // a repaint that never happened.
    expect((root.querySelector('.hub-detail-status') as HTMLSelectElement).value).toBe(
      'in-progress',
    );
    // The inversion that IS the fix. This read `not.toBe(before)` while the
    // panel was rebuilt wholesale and the words were snapshotted back into a
    // fresh box; under the island the box is the SAME node, so its words, its
    // focus and its caret were never anywhere to be restored from.
    const after = composer();
    expect(after).toBe(before);

    expect(after.value).toBe('I think this is below the API work because');
    expect(isComposerFocused(after)).toBe(true);
    expect(composerSelection(after)).toEqual(caretAt(12));
  });

  // The caret is restored where it was, not at the end — someone editing the
  // middle of a sentence keeps their place.
  it('keeps a mid-text selection', async () => {
    const t = task();
    paint(t);
    const ta = composer();
    ta.value = 'drop the second half';
    refreshMarkdownComposer(ta);
    focusMarkdownComposer(ta, { from: 10, to: 21 });
    await frame();
    paint({ ...t, updatedAt: NOW + 1 });
    await frame();
    expect(composerSelection(composer())).toEqual({ from: 10, to: 21 });
  });

  // Text without focus is still a draft — the reader tapped away to read a
  // thread and is coming back to it. Restored, but the caret is left alone:
  // focusing a field the person left would steal it from wherever they went.
  it('keeps unfocused draft text without stealing focus', async () => {
    const t = task();
    paint(t);
    composer().value = 'half a thought';
    refreshMarkdownComposer(composer());
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
    paint({ ...t, updatedAt: NOW + 1 });
    await frame();
    expect(composer().value).toBe('half a thought');
    expect(isComposerFocused(composer())).toBe(false);
  });

  // The other text controls on the panel go through the same repaint and lose
  // the same way, so they ride the same fix.
  it('the review card’s answer box survives too', async () => {
    const t = task();
    paint(t, { asks: [ask(t.id, 'th-1')] });
    const box = root.querySelector('.hub-decide-form textarea') as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    await typeInComposer(box, 'Keep threading.', 4);
    paint({ ...t, status: 'in-progress' }, { asks: [ask(t.id, 'th-1')] });
    await frame();
    const after = root.querySelector('.hub-decide-form textarea') as HTMLTextAreaElement;
    // Kept, not restored — see the discussion composer above.
    expect(after).toBe(box);
    expect(after.value).toBe('Keep threading.');
    expect(isComposerFocused(after)).toBe(true);
    expect(composerSelection(after)).toEqual(caretAt(4));
  });

  it('a decision answer being recorded survives too', async () => {
    const t = task({ needs: 'decision' });
    paint(t);
    const box = root.querySelector('.hub-answer-form textarea') as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    await typeInComposer(box, 'Option B, because', 8);
    paint({ ...t, updatedAt: NOW + 1 });
    await frame();
    const after = root.querySelector('.hub-answer-form textarea') as HTMLTextAreaElement;
    // Kept, not restored — see the discussion composer above.
    expect(after).toBe(box);
    expect(after.value).toBe('Option B, because');
    expect(isComposerFocused(after)).toBe(true);
    expect(composerSelection(after)).toEqual(caretAt(8));
  });

  // The title editor is a control that only exists mid-edit, so a repaint used
  // to close it outright — the rescue was to reopen it and refill it from the
  // snapshot. The heading is the island's element with no vnode children now,
  // which is an element Preact never reaches into, so a rename in flight is
  // simply never interrupted.
  it('a title being renamed survives a repaint, still open and still typed in', () => {
    const t = task({ title: 'Old name' });
    paint(t);
    (root.querySelector('.hub-detail-title') as HTMLElement).click();
    const input = root.querySelector('.hub-title-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    typeInto(input, 'Old name, sharper', 3);
    paint({ ...t, updatedAt: NOW + 1 });
    const after = root.querySelector('.hub-title-input') as HTMLInputElement;
    expect(after).toBeTruthy();
    expect(after).toBe(input);
    expect(after.value).toBe('Old name, sharper');
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(3);
  });

  // The boundary of the guarantee: a draft belongs to the task it was typed
  // on. Opening a DIFFERENT task in the same panel starts clean — carrying a
  // half-typed comment from one task onto another would post it in the wrong
  // place, which is worse than losing it.
  it('does not carry a draft from one task onto another', async () => {
    const a = task();
    const b = task();
    paint(a);
    await typeInComposer(composer(), 'about task A', 5);
    paint(b);
    await frame();
    expect(composer().value).toBe('');
    expect(isComposerFocused(composer())).toBe(false);
  });

  // A control that starts empty stays empty: the snapshot is not inventing
  // values, and a repaint of an untouched panel is a no-op for the fields.
  it('an untouched panel repaints untouched', async () => {
    const t = task();
    paint(t);
    paint({ ...t, updatedAt: NOW + 1 });
    await frame();
    expect(composer().value).toBe('');
    expect(isComposerFocused(composer())).toBe(false);
  });

  // The two guarantees in one pass. They are implemented by opposite
  // mechanisms — a draft is snapshot and restored around the rebuild, the
  // description slot is the node the rebuild goes AROUND — so a change that
  // reintroduced a blanket `replaceChildren` would satisfy neither, and one
  // that stopped rebuilding at all would silently freeze the panel.
  it('keeps a live description AND a half-typed comment across the same repaint', async () => {
    const t = task({ status: 'todo', body: 'The description as the store has it.' });
    paint(t);
    const slot = root.querySelector('.hub-detail-body-slot') as HTMLElement;
    slot.classList.add(BODY_LIVE_CLASS);
    slot.replaceChildren(document.createTextNode('what the editor is showing'));
    await typeInComposer(composer(), 'and a comment mid-sentence', 9);

    paint({ ...t, status: 'in-progress' });
    await frame();

    // Positive control: the panel really was repainted around the slot.
    expect((root.querySelector('.hub-detail-status') as HTMLSelectElement).value).toBe(
      'in-progress',
    );
    expect(root.querySelector('.hub-detail-body-slot')).toBe(slot);
    expect(slot.textContent).toBe('what the editor is showing');
    expect(composer().value).toBe('and a comment mid-sentence');
    expect(isComposerFocused(composer())).toBe(true);
    expect(composerSelection(composer())).toEqual(caretAt(9));
  });
});

/**
 * The reorganisation Bryan asked for: *"title prominent; key fields up top;
 * review item / decision visible next so I can act above the fold; then
 * description; then comments; Activity behind a second tab."*
 */
describe('renderTaskDetail — the reorganised panel', () => {
  const handlers = (over: Record<string, unknown> = {}) => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
    ...over,
  });

  const keys = (): string[] =>
    [...root.querySelectorAll('.hub-detail-fields dt')].map((dt) => dt.textContent ?? '');
  /** The VALUE cell of a field. All four are controls now, so a caller reads
   *  the control rather than the cell's text — `textContent` on a `<select>` is
   *  every option concatenated, which reads as a pass while measuring nothing
   *  about what is selected. */
  const cell = (key: string): HTMLElement | null => {
    const dts = [...root.querySelectorAll('.hub-detail-fields dt')];
    const dds = [...root.querySelectorAll<HTMLElement>('.hub-detail-fields dd')];
    const i = dts.findIndex((dt) => dt.textContent === key);
    return i === -1 ? null : (dds[i] ?? null);
  };
  const value = (key: string): string | null => {
    const el = cell(key)?.querySelector<HTMLSelectElement | HTMLInputElement>('select, input');
    return el?.value ?? null;
  };
  /** Where a node sits in the panel, so ORDER can be asserted rather than
   *  presence — the complaint was about arrangement, not about absence. */
  const at = (sel: string): number => {
    const panel = root.querySelector('.hub-detail-panel');
    const all = panel ? [...panel.querySelectorAll('*')] : [];
    const el = panel?.querySelector(sel);
    return el ? all.indexOf(el) : -1;
  };

  it('puts the four key facts in one row under the title, all four editable', () => {
    renderTaskDetail(root, task({ assignee: 'Jordan', goal: 'g-pr' }), {
      ...handlers(),
      goalLabel: (id) => goalLabel(GOALS, id),
    });
    expect(keys()).toEqual(['Status', 'Assignee', 'Due', 'Goal']);
    expect(value('Goal')).toBe('g-pr');
    expect(cell('Goal')?.querySelector('option[value="g-pr"]')?.textContent).toBe(
      '1. Get the PR out',
    );
  });

  /**
   * *"Status should only show current status with a dropdown to change the
   * status"* — one value and one control, not a row of chips with the current
   * one rendered as a disabled unbordered word beside its pill siblings.
   */
  it('shows the current status once, as a dropdown beside the board’s own mark', () => {
    const h = handlers();
    renderTaskDetail(root, task({ status: 'in-progress' }), h);
    const status = cell('Status') as HTMLElement;
    // The chip row is gone — not hidden, not disabled, absent.
    expect(status.querySelectorAll('.hub-chip')).toHaveLength(0);
    expect(status.querySelectorAll('select')).toHaveLength(1);
    const sel = status.querySelector('select') as HTMLSelectElement;
    expect(sel.value).toBe('in-progress');
    // The same round mark the board rows use, so the two surfaces cannot
    // disagree about what "in progress" looks like.
    expect(status.querySelector('.hub-status-mark-in-progress')).toBeTruthy();

    sel.value = 'done';
    sel.dispatchEvent(new Event('change'));
    expect(h.onStatusSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in-progress' }),
      'done',
    );
  });

  /** `dueAt` had no route after creation until this branch added
   *  `POST /api/tasks/:id/due`, so the cell was prose. It is a date control
   *  now, and the value is a LOCAL calendar day both ways — `toISOString`
   *  shows yesterday to anyone west of UTC for an evening deadline. */
  it('leaves the due control empty when nothing is due, and round-trips a local day', () => {
    const onDueSet = vi.fn();
    renderTaskDetail(root, task(), handlers({ onDueSet }));
    expect(value('Due')).toBe('');

    root.replaceChildren();
    // Noon local on the 20th, built the way the reader's own calendar would.
    const due = new Date(2026, 7, 20, 12).getTime();
    renderTaskDetail(root, task({ dueAt: due }), handlers({ onDueSet }));
    expect(value('Due')).toBe('2026-08-20');

    const input = cell('Due')?.querySelector('input') as HTMLInputElement;
    input.value = '2026-09-02';
    input.dispatchEvent(new Event('change'));
    const [, ts] = onDueSet.mock.calls[0] ?? [];
    const back = new Date(ts as number);
    expect([back.getFullYear(), back.getMonth(), back.getDate()]).toEqual([2026, 8, 2]);

    // Clearing it is expressible, and is not the same as sending a bad date.
    input.value = '';
    input.dispatchEvent(new Event('change'));
    expect(onDueSet).toHaveBeenLastCalledWith(expect.anything(), null);
  });

  /**
   * The park block came out on 2026-08-27 with the state behind it. Parking a
   * task moves it to `triage` and posts a comment, so the panel has nothing
   * to draw and no control to offer — the status field and the discussion the
   * panel already has are the whole of it.
   *
   * Pinned as an absence with a positive control, because a panel that failed
   * to render at all would satisfy the absence on its own.
   */
  it('has no park block and no park control', () => {
    renderTaskDetail(root, task(), handlers({ now: new Date(2026, 7, 1, 12).getTime() }));
    expect(root.querySelector('.hub-detail-fields')).not.toBeNull(); // control
    expect(root.querySelector('.hub-parked-note')).toBeNull();
    expect(keys()).not.toContain('Parked');
  });

  /**
   * The whole ticket in one assertion. Every one of these existed before; the
   * complaint was the ORDER, so presence assertions alone would have passed
   * against the panel being complained about.
   */
  it('orders the panel title → fields → what is waiting → description → tabs', () => {
    const t = task({ needs: 'decision', options: [{ id: 'o-1', label: 'Ship it' }] });
    renderTaskDetail(root, t, handlers(), { loading: false, threads: [] });
    const order = [
      at('.hub-detail-title'),
      at('.hub-detail-fields'),
      at('.hub-decide'),
      at('.hub-detail-body-slot'),
      at('.hub-detail-tabs'),
    ];
    expect(order).not.toContain(-1); // control: every region rendered
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  /**
   * The decision card's layout, which is the piece reported as janky on the
   * Home queue: *"options crammed against their details, no spacing between
   * the answer buttons, no spacing between buttons and comment text, nothing
   * aligned."* The structure is what the stylesheet hangs off, so the grouping
   * is asserted here and the gaps in `hub-decide-css.test.ts`.
   */
  it('groups a decision’s options, and separates them from the free-text box', () => {
    const t = task({
      needs: 'decision',
      options: [
        { id: 'o-1', label: 'Ship it blue', detail: 'Matches the rest of the nav' },
        { id: 'o-2', label: 'Ship it green' },
      ],
    });
    const h = handlers();
    renderTaskDetail(root, t, h);
    const card = root.querySelector('.hub-decide') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.querySelector('.hub-decide-kicker')?.textContent).toBe('Waiting on your decision');

    // Every option is a child of ONE group — the gap between buttons is a
    // property of that group, so options scattered among siblings cannot be
    // spaced consistently however the stylesheet is written.
    const group = card.querySelector('.hub-decide-options') as HTMLElement;
    const opts = [...group.querySelectorAll('.hub-decide-option')];
    expect(opts).toHaveLength(2);
    expect(opts.every((o) => o.parentElement === group)).toBe(true);
    // Label and detail are separate elements rather than one run of text, which
    // is what "crammed against their details" describes.
    expect(opts[0]?.querySelector('.hub-decide-option-label')?.textContent).toBe('Ship it blue');
    expect(opts[0]?.querySelector('.hub-decide-option-detail')?.textContent).toBe(
      'Matches the rest of the nav',
    );
    expect(opts[1]?.querySelector('.hub-decide-option-detail')).toBeNull();

    // The box is an ALTERNATIVE to the options, and says so.
    const form = card.querySelector('.hub-decide-form') as HTMLElement;
    expect(form.querySelector('.hub-decide-form-hint')?.textContent).toBe(
      'Or answer in your own words',
    );
    expect(group.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    (opts[0] as HTMLElement).click();
    expect(h.onAnswer).toHaveBeenCalledWith(t, 'Ship it blue', 'o-1');
  });

  it('drops the "or" from the hint when there is nothing to choose between', () => {
    renderTaskDetail(root, task({ needs: 'decision' }), handlers());
    expect(root.querySelector('.hub-decide-options')).toBeNull();
    expect(root.querySelector('.hub-decide-form-hint')?.textContent).toBe(
      'Answer in your own words',
    );
  });

  it('shows no decision card on a task nothing is waiting on', () => {
    renderTaskDetail(root, task(), handlers());
    expect(root.querySelector('.hub-decide')).toBeNull();
    // Control: the panel rendered, so the null is about the card.
    expect(root.querySelector('.hub-detail-fields')).toBeTruthy();
  });

  it('opens on Comments, with Activity present but hidden', () => {
    renderTaskDetail(root, task({ transitions: [] }), handlers(), {
      loading: false,
      threads: [],
    });
    const comments = root.querySelector('.hub-detail-tabpanel-comments') as HTMLElement;
    const activity = root.querySelector('.hub-detail-tabpanel-activity') as HTMLElement;
    expect(comments.classList.contains('hidden')).toBe(false);
    expect(activity.classList.contains('hidden')).toBe(true);
    expect(root.querySelector('.hub-detail-tab-comments')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    // The record really is over there rather than nowhere.
    expect(activity.querySelector('.hub-detail-body-link')).toBeTruthy();
  });

  /**
   * The panel repaints on every ydoc change — a peer's comment, a status flip,
   * the reader's own typing — so a tab choice that reset on the next repaint
   * would be a tab nobody could use. Same mechanism as `priorTaskId`: read the
   * state off the panel before the swap throws it away.
   */
  it('keeps the chosen tab across a repaint, and resets it on another task', () => {
    const t = task();
    renderTaskDetail(root, t, handlers(), { loading: false, threads: [] });
    (root.querySelector('.hub-detail-tab-activity') as HTMLElement).click();
    const activity = () => root.querySelector('.hub-detail-tabpanel-activity') as HTMLElement;
    expect(activity().classList.contains('hidden')).toBe(false);

    renderTaskDetail(root, { ...t, status: 'in-progress' }, handlers(), {
      loading: false,
      threads: [],
    });
    // Control: this really was a repaint, not a no-op.
    expect(value('Status')).toBe('in-progress');
    expect(activity().classList.contains('hidden')).toBe(false);

    // A different task is a fresh read, and it starts on the conversation.
    renderTaskDetail(root, task(), handlers(), { loading: false, threads: [] });
    expect(activity().classList.contains('hidden')).toBe(true);
  });

  /**
   * Switching a tab has to LAND somewhere the reader can see it happened.
   *
   * Reported as a dead control that had in fact worked: hiding the taller
   * panel shortens the content under the scroll position, the browser clamps
   * it to 0, and the reader is returned to the top of the ticket with the tab
   * row a screenful below and the panel they chose off the bottom of the
   * screen. Nothing on screen changes, so the click reads as nothing.
   *
   * happy-dom resolves no layout and has no `scrollIntoView`, so what is
   * assertable here is that the switch asks for the tab row to be put at the
   * top; the offset that keeps it clear of the sticky head is CSS, and is
   * asserted in hub-detail-css.test.ts.
   */
  it('parks the tab row at the top when a tab is switched', () => {
    renderTaskDetail(root, task(), handlers(), { loading: false, threads: [] });
    const tabs = root.querySelector('.hub-detail-tabs') as HTMLElement;
    const calls: unknown[] = [];
    (tabs as unknown as { scrollIntoView: unknown }).scrollIntoView = (arg: unknown) =>
      calls.push(arg);
    (root.querySelector('.hub-detail-tab-activity') as HTMLElement).click();
    expect(calls).toEqual([{ block: 'start' }]);
    // Control: the switch itself still happened, so the assertion above is
    // about where the reader lands rather than about the click working.
    expect(root.querySelector('.hub-detail-tab-activity')?.getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('offers a share link only when the board wired one up', () => {
    renderTaskDetail(root, task(), handlers());
    expect(root.querySelector('.hub-detail-share')).toBeNull();

    root.replaceChildren();
    const onCopyLink = vi.fn();
    const t = task();
    renderTaskDetail(root, t, handlers({ onCopyLink }));
    const share = root.querySelector('.hub-detail-share') as HTMLElement;
    expect(share).toBeTruthy();
    share.click();
    expect(onCopyLink).toHaveBeenCalledWith(t);
  });

  /**
   * *"Copy link and Full screen should be icons instead of text buttons,
   * Asana-style."* An icon-only control that carries neither an `aria-label`
   * nor a `title` is a control nobody can identify — a screen reader announces
   * the glyph and a desktop hover says nothing — so the names are asserted here
   * rather than left to the glyphs.
   */
  it('names every head action, because each one is a glyph and nothing else', () => {
    renderTaskDetail(root, task(), handlers({ onCopyLink: vi.fn() }));
    const named = [...root.querySelectorAll<HTMLElement>('.hub-detail-head-actions .hub-btn')].map(
      (b) => [b.textContent ?? '', b.getAttribute('aria-label'), b.title],
    );
    expect(named).toEqual([
      ['🔗', 'Copy a link to this task', 'Copy a link to this task'],
      ['⤢', 'Full screen', 'Full screen'],
      ['✕', 'Close task detail', 'Close task detail'],
    ]);
    // Positive control on the assertion above: every one of them is an icon
    // button, so "the label is the only name" is a fact rather than an
    // assumption about which of these carry words.
    expect(named.every(([glyph]) => (glyph as string).length <= 2)).toBe(true);
  });

  /**
   * Full screen is a preference of the READER, so it lives on the container:
   * the panel is rebuilt on every repaint, and a class held there would be
   * dropped by the next comment that landed.
   */
  it('toggles full screen on the container, and keeps it across a repaint', () => {
    const t = task();
    renderTaskDetail(root, t, handlers());
    const btn = () => root.querySelector('.hub-detail-expand') as HTMLElement;
    expect(btn().getAttribute('aria-label')).toBe('Full screen');
    expect(btn().getAttribute('aria-pressed')).toBe('false');

    btn().click();
    expect(root.classList.contains('hub-detail--full')).toBe(true);
    expect(btn().getAttribute('aria-label')).toBe('Exit full screen');
    // The board stops reserving room once the panel covers it.
    expect(document.body.classList.contains('hub-detail-full')).toBe(true);

    renderTaskDetail(root, { ...t, status: 'done' }, handlers());
    expect(value('Status')).toBe('done'); // control
    expect(root.classList.contains('hub-detail--full')).toBe(true);
    expect(btn().getAttribute('aria-pressed')).toBe('true');

    btn().click();
    expect(root.classList.contains('hub-detail--full')).toBe(false);
  });
});

/**
 * The review region inside a ticket is a QUEUE.
 *
 * Bryan, 2026-08-18: *"For decisions, the ticket title is not the decision. A
 * decision is a part of a ticket, and there should be a decision blurb above
 * the options. And over time, there may be more than one decision associated
 * with a ticket. In fact, at any point in time there might be multiple open
 * decisions for a ticket. Please accommodate and have a similar review queue
 * within a ticket details interface."*
 *
 * What that replaced: two independent regions, a decision card and an "ask"
 * panel, each rendering one item and each blind to the other — so a task with
 * both showed two competing headers, and a task with three thread items showed
 * one and silently dropped two.
 */
describe('the panel’s review queue', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });

  const handlers = (over: Record<string, unknown> = {}) => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
    onComment: vi.fn(),
    now: NOW,
    ...over,
  });

  const ask = (over: Partial<ReviewThreadItem> = {}): ReviewThreadItem => ({
    kind: 'task-thread',
    docId: 'task:t-1',
    threadId: 'th-1',
    taskId: 't-1',
    title: 'Some task',
    ask: 'Which way on the index?',
    askedBy: 'Index Rebuild',
    since: NOW - 3_600_000,
    ...over,
  });

  const cards = (): string[] =>
    [...root.querySelectorAll<HTMLElement>('.hub-decide-card')].map(
      (c) => c.dataset.reviewItemId ?? '',
    );
  const shown = (): HTMLElement | null =>
    root.querySelector<HTMLElement>('.hub-decide-card:not(.hidden)');

  describe('decisionBlurb', () => {
    it('takes the question as the headline and the rest as the stakes', () => {
      expect(
        decisionBlurb('## Ship it Thursday?\n\nThe rework is blocked either way.\n\n- Yes\n- No'),
      ).toEqual({
        headline: 'Ship it Thursday?',
        body: 'The rework is blocked either way.',
      });
    });

    it('drops the option list rather than repeating it as prose', () => {
      // The card renders the options as buttons; a copy of them in the blurb
      // is the "crammed" complaint one layer up.
      expect(decisionBlurb('Which one?\n1. Blue\n2. Green').body).toBe('');
    });

    it('drops the label that introduced the dropped list, and keeps other colons', () => {
      // Found in the browser, not in a fixture: with `Options:` kept, the
      // orphaned label welds onto the sentence AFTER the list. The positive
      // control is in the same assertion — a colon that introduces prose
      // rather than a list survives, so this is a narrowing and not a rule
      // against colons.
      const body = [
        'Where should it live?',
        '',
        'Both screens are built.',
        '',
        'Options:',
        '',
        '- Top of the screen',
        '- In the settings row',
        '',
        'Blocked until answered: the rework cannot merge.',
      ].join('\n');
      expect(decisionBlurb(body).body).toBe(
        'Both screens are built. Blocked until answered: the rework cannot merge.',
      );
    });

    it('says nothing rather than inventing a question from a body with none', () => {
      expect(decisionBlurb('Just a note about the index.')).toEqual({
        headline: '',
        body: 'Just a note about the index.',
      });
      expect(decisionBlurb(undefined)).toEqual({ headline: '', body: '' });
    });
  });

  describe('panelReviewQueue', () => {
    it('merges the task’s own decision with every thread item, decision first', () => {
      const t = task({ id: 't-1', needs: 'decision', body: 'Ship it Thursday?' });
      const q = panelReviewQueue(t, [ask({ threadId: 'th-a' }), ask({ threadId: 'th-b' })]);
      expect(q.map((i) => i.id)).toEqual(['task:t-1', 'thread:th-a', 'thread:th-b']);
      // The blurb, not the ticket title: *"the ticket title is not the
      // decision"*.
      expect(q[0]?.headline).toBe('Ship it Thursday?');
    });

    it('falls back to the title only when the body says nothing', () => {
      const t = task({ id: 't-1', title: 'Decide the index order', needs: 'decision', body: '' });
      expect(panelReviewQueue(t, [])[0]?.headline).toBe('Decide the index order');
    });

    /**
     * The keys DISAGREE here on purpose. `th-old` is the oldest and would win
     * on age alone; `th-declared` carries a declaration and `th-direct` names a
     * person, so a recency-only ranking — or a declaration-only one — produces
     * a different order. A fixture where the keys agree proves only that the
     * first key exists.
     */
    it('ranks declared over direct over merely old, when the three disagree', () => {
      const t = task({ id: 't-1' });
      const q = panelReviewQueue(t, [
        ask({ threadId: 'th-old', since: NOW - 90_000_000 }),
        ask({
          threadId: 'th-direct',
          direct: true,
          since: NOW - 60_000_000,
        }),
        ask({
          threadId: 'th-declared',
          since: NOW - 10_000,
          review: { shape: 'review', headline: 'Read the redline' },
        }),
      ]);
      expect(q.map((i) => i.id)).toEqual([
        'thread:th-declared',
        'thread:th-direct',
        'thread:th-old',
      ]);
    });

    it('is empty on an answered decision, and on a task with nothing waiting', () => {
      expect(panelReviewQueue(task({ needs: 'decision' }), [])).toHaveLength(1); // control
      expect(
        panelReviewQueue(
          task({ needs: 'decision', answer: { by: 'Jordan', text: 'Thursday.', ts: NOW } }),
          [],
        ),
      ).toHaveLength(0);
      expect(panelReviewQueue(task(), undefined)).toHaveLength(0);
    });

    /**
     * The answered record stays IN the panel (approved design): a declared
     * item somebody answered renders below the open ones as the record —
     * "Answered by …" with a persistent Undo — read off the declaring
     * comment's own stamps, which is the only place they survive a reload.
     */
    it('admits an answered declared item from the discussion, ranked after the open ones', () => {
      const t = task({ id: 't-1' });
      const q = panelReviewQueue(t, [ask({ threadId: 'th-open' })], {
        loading: false,
        threads: [
          {
            id: 'th-done',
            comments: [
              {
                id: 'c-9',
                author: 'Harbor agent',
                text: 'Both screens are built.',
                ts: NOW - 7_200_000,
                review: {
                  shape: 'decision',
                  headline: 'Where should the banner live?',
                  answeredAt: NOW - 3_600_000,
                  answeredBy: 'Jordan',
                  answerText: 'Keep it above the fold',
                },
              },
            ],
          },
        ],
      });
      expect(q.map((i) => i.id)).toEqual(['thread:th-open', 'answered:th-done:c-9']);
      const done = q[1];
      expect(done?.answered).toEqual({
        by: 'Jordan',
        text: 'Keep it above the fold',
        at: NOW - 3_600_000,
      });
      expect(done?.commentId).toBe('c-9');
      expect(done?.threadId).toBe('th-done');
    });

    it('does not admit an unanswered declared comment twice, nor a plain comment at all', () => {
      const t = task({ id: 't-1' });
      const q = panelReviewQueue(t, [ask({ threadId: 'th-open' })], {
        loading: false,
        threads: [
          {
            id: 'th-open',
            comments: [
              {
                id: 'c-1',
                author: 'Harbor agent',
                text: 'Asked here.',
                ts: NOW - 7_200_000,
                // Unanswered declaration: the asks row already carries it.
                review: { shape: 'review', headline: 'Read this', detail: 'Ships Friday.' },
              },
              { id: 'c-2', author: 'Jordan', text: 'Reading now.', ts: NOW - 3_600_000 },
            ],
          },
        ],
      });
      expect(q.map((i) => i.id)).toEqual(['thread:th-open']);
    });
  });

  describe('the answered record in place, with its persistent Undo', () => {
    const answeredThread = (over: Record<string, unknown> = {}) => ({
      id: 'th-done',
      comments: [
        {
          id: 'c-9',
          author: 'Harbor agent',
          text: 'Both screens are built.',
          ts: NOW - 7_200_000,
          review: {
            shape: 'decision' as const,
            headline: 'Where should the banner live?',
            detail: 'Blocks the rework.',
            answeredAt: NOW - 3_600_000,
            answeredBy: 'Jordan',
            answerText: 'Keep it **above** the fold',
            ...over,
          },
        },
      ],
    });

    it('renders the record under the item card it answers, marked Answered', () => {
      renderTaskDetail(
        root,
        task({ id: 't-1' }),
        handlers({ selfName: 'Jordan', onUndoThreadAnswer: vi.fn() }),
        { loading: false, threads: [answeredThread()] },
      );
      const card = shown();
      expect(card?.dataset.reviewItemId).toBe('answered:th-done:c-9');
      // The item interface first: head row and body, same anatomy as an open one.
      expect(card?.querySelector('.hub-decide-headline')?.textContent).toContain(
        'Where should the banner live?',
      );
      expect(card?.querySelector('.hub-decide-body')?.textContent).toContain('Blocks the rework.');
      // The record, in place: "Answered by you" for the reader's own answer,
      // rendered markdown-inline.
      const rec = card?.querySelector('.hub-detail-answered') as HTMLElement;
      expect(rec.textContent).toContain('Answered by you');
      expect(rec.textContent).toContain('Keep it above the fold');
      expect(rec.querySelector('strong')?.textContent).toBe('above');
      // No composer and no options on a settled item — the record replaces them.
      expect(card?.querySelector('.hub-decide-form')).toBeNull();
      expect(card?.querySelectorAll('.hub-decide-option')).toHaveLength(0);
      // The kicker says what this card is.
      expect(root.querySelector('.hub-decide-kicker')?.textContent).toBe('Answered');
    });

    it("names the answerer when it wasn't you", () => {
      renderTaskDetail(
        root,
        task({ id: 't-1' }),
        handlers({ selfName: 'Sam', onUndoThreadAnswer: vi.fn() }),
        { loading: false, threads: [answeredThread()] },
      );
      expect(shown()?.querySelector('.hub-detail-answered')?.textContent).toContain(
        'Answered by Jordan',
      );
    });

    it('wires the persistent Undo to the thread-answer undo handler', () => {
      const onUndoThreadAnswer = vi.fn().mockResolvedValue(true);
      const t = task({ id: 't-1' });
      renderTaskDetail(root, t, handlers({ selfName: 'Jordan', onUndoThreadAnswer }), {
        loading: false,
        threads: [answeredThread()],
      });
      const undo = shown()?.querySelector('.hub-detail-undo-answer') as HTMLButtonElement;
      expect(undo).toBeTruthy();
      undo.click();
      expect(onUndoThreadAnswer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't-1' }),
        expect.objectContaining({ commentId: 'c-9', threadId: 'th-done' }),
      );
    });

    it('falls back to the tapped option label when a legacy answer has no text', () => {
      renderTaskDetail(
        root,
        task({ id: 't-1' }),
        handlers({ selfName: 'Jordan', onUndoThreadAnswer: vi.fn() }),
        {
          loading: false,
          threads: [
            answeredThread({
              answeredBy: undefined,
              answerText: undefined,
              answeredAt: undefined,
              answeredWith: 'above',
              options: [
                { id: 'above', label: 'Keep above' },
                { id: 'below', label: 'Move below' },
              ],
            }),
          ],
        },
      );
      const rec = shown()?.querySelector('.hub-detail-answered') as HTMLElement;
      expect(rec.textContent).toContain('Answered');
      expect(rec.textContent).toContain('Keep above');
    });
  });

  it('walks several items one at a time, saying which one you are on', () => {
    const t = task({ id: 't-1', needs: 'decision', body: 'Ship it Thursday?' });
    renderTaskDetail(root, t, handlers({ asks: [ask({ threadId: 'th-a' })] }), {
      loading: false,
      threads: [],
    });
    expect(cards()).toEqual(['task:t-1', 'thread:th-a']);
    // Built, not unbuilt: stepping must not tear down an answer box somebody is
    // typing into, which is why the others are hidden rather than absent.
    expect(shown()?.dataset.reviewItemId).toBe('task:t-1');
    expect(root.querySelector('.hub-decide-count')?.textContent).toBe('1 of 2');

    const [prev, next] = [...root.querySelectorAll<HTMLButtonElement>('.hub-decide-step')];
    expect(prev?.disabled).toBe(true);
    next?.click();
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-a');
    expect(root.querySelector('.hub-decide-count')?.textContent).toBe('2 of 2');
    expect(next?.disabled).toBe(true);
    prev?.click();
    expect(shown()?.dataset.reviewItemId).toBe('task:t-1');
  });

  /** *"With exactly one item it must look like today's single card."* A "1 of
   *  1" counter and two dead arrows are furniture that says nothing. */
  it('shows no walkthrough chrome at all when there is only one item', () => {
    renderTaskDetail(root, task({ id: 't-1', needs: 'decision' }), handlers(), {
      loading: false,
      threads: [],
    });
    expect(root.querySelector('.hub-decide-card')).toBeTruthy(); // control
    expect(root.querySelector('.hub-decide-walk')).toBeNull();
    expect(root.querySelector('.hub-decide-step')).toBeNull();
    expect(root.querySelector('.hub-decide-count')?.textContent ?? '').toBe('');
  });

  /** The panel repaints on every board change. A position that reset would
   *  walk the reader back to the first question while they answered the third
   *  — the same failure the tab and the description slot are guarded against. */
  it('keeps the walkthrough position across a repaint, and resets it on another task', () => {
    const t = task({ id: 't-1', needs: 'decision' });
    const paint = (x = t) =>
      renderTaskDetail(root, x, handlers({ asks: [ask({ threadId: 'th-a' })] }), {
        loading: false,
        threads: [],
      });
    paint();
    [...root.querySelectorAll<HTMLButtonElement>('.hub-decide-step')][1]?.click();
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-a');

    paint({ ...t, status: 'in-progress' });
    expect(
      (root.querySelector('.hub-detail-status') as HTMLSelectElement).value, // control
    ).toBe('in-progress');
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-a');

    renderTaskDetail(root, task({ id: 't-2', needs: 'decision' }), handlers({ asks: [] }), {
      loading: false,
      threads: [],
    });
    expect(shown()?.dataset.reviewItemId).toBe('task:t-2');
  });

  /** Position is the ITEM, not its number. A peer's undo re-enters the task's
   *  own decision at rank 0 of this queue, and a kept numeric index would
   *  silently swap which question the reader is on — the draft they were
   *  typing stays keyed to a card that is no longer the visible one. */
  it('keeps the SAME item shown when a repaint inserts one ahead of it', () => {
    const asks = [
      ask({ threadId: 'th-a', since: NOW - 7_200_000 }),
      ask({ threadId: 'th-b', since: NOW - 3_600_000 }),
    ];
    renderTaskDetail(root, task({ id: 't-1' }), handlers({ asks }), {
      loading: false,
      threads: [],
    });
    expect(cards()).toEqual(['thread:th-a', 'thread:th-b']); // control
    [...root.querySelectorAll<HTMLButtonElement>('.hub-decide-step')][1]?.click();
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-b');

    // A peer undoes the task's answer: the task's own decision re-enters the
    // queue AT THE FRONT, and the board change repaints the panel.
    renderTaskDetail(root, task({ id: 't-1', needs: 'decision' }), handlers({ asks }), {
      loading: false,
      threads: [],
    });
    expect(cards()).toEqual(['task:t-1', 'thread:th-a', 'thread:th-b']);
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-b');
    expect(root.querySelector('.hub-decide-count')?.textContent).toBe('3 of 3');
  });

  /** And when the kept item is GONE and the kept index runs past the shrunken
   *  queue, the fallback clamps to the last item rather than blanking. */
  it('clamps to the last item when a repaint shrinks the queue under the kept position', () => {
    const t = task({ id: 't-1', needs: 'decision' });
    const asks = [
      ask({ threadId: 'th-a', since: NOW - 7_200_000 }),
      ask({ threadId: 'th-b', since: NOW - 3_600_000 }),
    ];
    renderTaskDetail(root, t, handlers({ asks }), { loading: false, threads: [] });
    const step = () => [...root.querySelectorAll<HTMLButtonElement>('.hub-decide-step')][1];
    step()?.click();
    step()?.click();
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-b'); // control: at index 2

    // th-b's thread is resolved by its agent; the repaint has only two items.
    renderTaskDetail(root, t, handlers({ asks: asks.slice(0, 1) }), {
      loading: false,
      threads: [],
    });
    expect(cards()).toEqual(['task:t-1', 'thread:th-a']);
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-a');
  });

  /** A deep link names a thread. Opening the queue at whatever happened to be
   *  first would answer a different question than the one that summoned them. */
  it('opens at the item a deep link named, not at the top of the queue', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1', needs: 'decision' }),
      handlers({
        asks: [ask({ threadId: 'th-a' }), ask({ threadId: 'th-b' })],
        focusThreadId: 'th-b',
      }),
      { loading: false, threads: [] },
    );
    expect(cards()).toEqual(['task:t-1', 'thread:th-a', 'thread:th-b']);
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-b');
    expect(root.querySelector('.hub-decide-count')?.textContent).toBe('3 of 3');
  });

  /** Two destinations, one card: a thread item is answered by REPLYING there,
   *  so the agent watching hears it; the task's own decision goes through
   *  `answer_decision`. Both in one pass, because a card that sent everything
   *  one way would pass either half alone. */
  it('answers a thread item as a reply and the task’s decision as a decision', () => {
    const onAnswer = vi.fn();
    const onAnswerThread = vi.fn().mockResolvedValue(true);
    const t = task({ id: 't-1', needs: 'decision' });
    renderTaskDetail(
      root,
      t,
      handlers({ onAnswer, onAnswerThread, asks: [ask({ threadId: 'th-a' })] }),
      { loading: false, threads: [] },
    );
    const answerIn = (card: HTMLElement, text: string) => {
      const form = card.querySelector('.hub-decide-form') as HTMLFormElement;
      (form.querySelector('textarea') as HTMLTextAreaElement).value = text;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    const [taskCard, threadCard] = [...root.querySelectorAll<HTMLElement>('.hub-decide-card')];
    answerIn(taskCard!, 'Thursday.');
    expect(onAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      'Thursday.',
      undefined,
    );
    expect(onAnswerThread).not.toHaveBeenCalled();

    answerIn(threadCard!, 'Rebuild it nightly.');
    expect(onAnswerThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      expect.objectContaining({ threadId: 'th-a' }),
      'Rebuild it nightly.',
      undefined,
    );
  });

  /**
   * Critical, measured in the browser 2026-08-18: answering the task's own
   * decision retired the ENTIRE region, including two thread items the server
   * still reported as open. The reader was left with no queue and nothing
   * saying two questions were still waiting on them.
   */
  it('keeps the queue for the items still open after one is answered', () => {
    const answered = task({
      id: 't-1',
      needs: 'decision',
      answer: { by: 'Jordan', text: 'Thursday.', ts: NOW },
    });
    renderTaskDetail(
      root,
      answered,
      handlers({ asks: [ask({ threadId: 'th-a' }), ask({ threadId: 'th-b' })] }),
      { loading: false, threads: [] },
    );
    // What was decided is still said…
    expect(root.querySelector('.hub-detail-answer')?.textContent).toContain('Thursday.');
    // …and the two items that are still open are still reachable, with the
    // walkthrough chrome that says how many there are.
    expect(cards()).toEqual(['thread:th-a', 'thread:th-b']);
    expect(root.querySelector('.hub-decide-count')?.textContent).toBe('1 of 2');
  });

  it('renders the answer alone when nothing else is waiting', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1', needs: 'decision', answer: { by: 'Jordan', text: 'Thursday.', ts: NOW } }),
      handlers({ asks: [] }),
      { loading: false, threads: [] },
    );
    expect(root.querySelector('.hub-detail-answer')?.textContent).toContain('Thursday.');
    expect(cards()).toEqual([]);
  });

  /** A single unconfirmed click committed an answer with no way back. The
   *  recovery is a persistent undo rather than a confirm step or a timed
   *  toast: it costs the deliberate 99% nothing and is still there when the
   *  mistake is noticed a minute later. */
  it('offers an undo beside the recorded answer, and calls it once', () => {
    const onUndoAnswer = vi.fn().mockResolvedValue(true);
    const t = task({
      id: 't-1',
      needs: 'decision',
      answer: { by: 'Jordan', text: 'Thursday.', ts: NOW },
    });
    renderTaskDetail(root, t, handlers({ onUndoAnswer, asks: [] }), {
      loading: false,
      threads: [],
    });
    const undo = root.querySelector<HTMLButtonElement>('.hub-detail-undo-answer');
    expect(undo).toBeTruthy();
    undo?.click();
    expect(onUndoAnswer).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1' }));
    // Disabled for the round trip, so a double tap cannot withdraw twice.
    expect(undo?.disabled).toBe(true);
  });

  /** The app's undo handler REPORTS failure by resolving `false` — its own
   *  `send()` never rejects, so a `.catch`-only re-enable can never fire. On a
   *  quiet board nothing else repaints the panel, so a button left disabled
   *  after a failed POST is a retry the reader simply cannot make. */
  it('re-enables the undo when the withdrawal reports failure, so the reader can retry', async () => {
    const onUndoAnswer = vi.fn().mockResolvedValue(false);
    renderTaskDetail(
      root,
      task({ id: 't-1', needs: 'decision', answer: { by: 'Jordan', text: 'Thursday.', ts: NOW } }),
      handlers({ onUndoAnswer, asks: [] }),
      { loading: false, threads: [] },
    );
    const undo = root.querySelector<HTMLButtonElement>('.hub-detail-undo-answer');
    undo?.click();
    expect(undo?.disabled).toBe(true); // control: the round trip does disable
    await Promise.resolve();
    await Promise.resolve();
    expect(undo?.disabled).toBe(false);
  });

  it('renders no undo when the app offers none, rather than a dead button', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1', needs: 'decision', answer: { by: 'Jordan', text: 'Thursday.', ts: NOW } }),
      // The helper's spread does not remove a key, so this is how "no handler"
      // is expressed — and the control above proves the button appears when
      // there IS one.
      { ...handlers({ asks: [] }), onUndoAnswer: undefined },
      { loading: false, threads: [] },
    );
    expect(root.querySelector('.hub-detail-undo-answer')).toBeNull();
    expect(root.querySelector('.hub-detail-answer')?.textContent).toContain('Thursday.');
  });

  it('says why an empty answer did nothing, instead of doing nothing silently', () => {
    const onAnswer = vi.fn();
    renderTaskDetail(root, task({ id: 't-1', needs: 'decision' }), handlers({ onAnswer }), {
      loading: false,
      threads: [],
    });
    const form = root.querySelector('.hub-decide-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onAnswer).not.toHaveBeenCalled();
    const note = form.querySelector('.hub-form-error');
    expect(note?.textContent).toContain('Write an answer');
    // …and it goes away the moment the reason does.
    (form.querySelector('textarea') as HTMLTextAreaElement).dispatchEvent(
      new Event('input', { bubbles: true }),
    );
    expect(form.querySelector('.hub-form-error')).toBeNull();
  });

  it('puts a refused answer back in the box', async () => {
    const onAnswerThread = vi.fn().mockResolvedValue(false);
    renderTaskDetail(
      root,
      task({ id: 't-1' }),
      handlers({ onAnswerThread, asks: [ask({ threadId: 'th-a' })] }),
      { loading: false, threads: [] },
    );
    const form = root.querySelector('.hub-decide-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Rebuild it nightly.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(ta.value).toBe('');
    await Promise.resolve();
    await Promise.resolve();
    expect(ta.value).toBe('Rebuild it nightly.');
  });

  it('makes the panel title reachable from the keyboard, like the board row', () => {
    // The board's title carries `tabIndex 0` + a tooltip; the panel's carried
    // neither, so renaming there was pointer-only and nothing said the title
    // was editable at all.
    renderTaskDetail(root, task({ id: 't-1', title: 'Old title' }), handlers(), {
      loading: false,
      threads: [],
    });
    const title = root.querySelector('.hub-detail-title') as HTMLElement;
    expect(title.tabIndex).toBe(0);
    expect(title.title).toMatch(/rename/i);
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(title.querySelector('input')).not.toBeNull();
  });

  it('shows a rename, a rewrite and a reassignment in the ticket’s own history', () => {
    // Measured 2026-08-18: the Activity tab rendered `task.transitions` and
    // nothing else, so every one of these was in the workspace log and on no
    // surface of the ticket it changed.
    const t = task({ id: 't-1', title: 'Ship the index' });
    renderTaskDetail(
      root,
      t,
      handlers({
        activity: [
          {
            event: 'task.retitled',
            ts: NOW - 3000,
            taskId: 't-1',
            actor: { name: 'Jordan' },
            titleFrom: 'Index',
            titleTo: 'Ship the index',
          },
          {
            event: 'task.assigned',
            ts: NOW - 2000,
            taskId: 't-1',
            actor: { name: 'Jordan' },
            from: 'human',
            to: 'agent-index',
          },
          { event: 'task.body_edited', ts: NOW - 1000, taskId: 't-1', actor: { name: 'Jordan' } },
          // Another task's row, in the same feed the panel is handed.
          {
            event: 'task.retitled',
            ts: NOW,
            taskId: 't-2',
            actor: { name: 'Jordan' },
            titleFrom: 'A',
            titleTo: 'B',
          },
        ],
      }),
      { loading: false, threads: [] },
    );
    const rows = [...root.querySelectorAll('.hub-detail-transitions li')].map(
      (li) => li.textContent ?? '',
    );
    expect(rows.some((r) => r.includes('renamed'))).toBe(true);
    expect(rows.some((r) => r.includes('assigned'))).toBe(true);
    expect(rows.some((r) => r.includes('rewrote the description'))).toBe(true);
    // Only this ticket's rows: the feed is the whole workspace's.
    expect(rows.some((r) => r.includes('“B”'))).toBe(false);
    // Newest first, and the stored transitions are still in the same list.
    expect(rows[0]).toContain('rewrote the description');
    expect(rows.some((r) => r.includes('→'))).toBe(true);
    // The reserved id reads the same way here as it does in the picker two
    // inches above it. Found in a browser once the tab HAD rows to read:
    // the dropdown said "A person" while this line said `→ human`, because
    // `assigneeLabel` lived beside the picker and `describeEvent` never saw
    // it. The positive control is the other half of the same row — an agent
    // id is not a reserved word and must still render verbatim.
    const assigned = rows.find((r) => r.includes('assigned')) ?? '';
    expect(assigned).toContain('A person');
    expect(assigned).toContain('agent-index');
    expect(assigned).not.toMatch(/\bhuman\b/);
  });

  it('names the description, and separates it from the fields and the queue', () => {
    // *"Add a Description heading with proper spacing separating it from the
    // fields/decision area above."* The spacing is CSS (asserted in
    // `hub-detail-css.test.ts`); what belongs here is that the heading exists,
    // says the word, and sits between the queue and the prose rather than
    // anywhere else in the panel.
    renderTaskDetail(root, task({ id: 't-1', needs: 'decision' }), handlers(), {
      loading: false,
      threads: [],
    });
    const head = root.querySelector('.hub-detail-body-head') as HTMLElement;
    expect(head.textContent).toBe('Description');
    const decide = root.querySelector('.hub-decide') as HTMLElement;
    const slot = root.querySelector(`.${BODY_LIVE_CLASS}, .hub-detail-body-slot`) as HTMLElement;
    const precedes = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(precedes(decide, head)).toBe(true);
    expect(precedes(head, slot)).toBe(true);
  });

  /** The board reflows out from under the split pane, and the marker is a body
   *  class rather than a `:has()` inference — the two live under different
   *  subtrees, and a class is what a stylesheet and a test can both read. */
  it('marks the body while the panel is open, and unmarks it on close', () => {
    renderTaskDetail(root, task({ id: 't-1' }), handlers());
    expect(document.body.classList.contains('hub-detail-open')).toBe(true);
    renderTaskDetail(root, null, handlers());
    expect(document.body.classList.contains('hub-detail-open')).toBe(false);
    expect(root.querySelector('.hub-detail-panel')).toBeNull(); // control
  });

  it('offers the board’s goals, keeps the task’s own, and commits a move', () => {
    const onGoalSet = vi.fn();
    // The task sits on a goal the list does NOT carry — a stale or deleted
    // band must not silently re-place the task on the next change event.
    renderTaskDetail(
      root,
      task({ id: 't-1', goal: 'g-gone' }),
      handlers({ goals: GOALS, onGoalSet, goalLabel: (id: string) => `Goal ${id}` }),
    );
    const sel = root.querySelector('.hub-detail-goal') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['g-pr', 'g-sub', 'g-gone']);
    expect(sel.value).toBe('g-gone');
    expect([...sel.options].map((o) => o.textContent)).toEqual([
      '1. Get the PR out',
      '— 1.1 Tickets',
      'Goal g-gone',
    ]);
    sel.value = 'g-sub';
    sel.dispatchEvent(new Event('change'));
    expect(onGoalSet).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1' }), 'g-sub');
    // Re-picking the goal it is already on is not a move.
    onGoalSet.mockClear();
    sel.value = 'g-gone';
    sel.dispatchEvent(new Event('change'));
    expect(onGoalSet).not.toHaveBeenCalled();
  });

  /** Each card keeps its OWN draft, keyed by item — walking to the next
   *  question and back must not hand the reader words they wrote for another. */
  it('keeps a separate answer draft per item', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1', needs: 'decision' }),
      handlers({ asks: [ask({ threadId: 'th-a' })] }),
      { loading: false, threads: [] },
    );
    const keys = [...root.querySelectorAll<HTMLTextAreaElement>('.hub-decide-form textarea')].map(
      (ta) => ta.dataset.keep,
    );
    expect(keys).toEqual(['answer:t-1:task:t-1', 'answer:t-1:thread:th-a']);
  });
});

/**
 * *"Multi-threaded comments are too complicated — just a single sequence of
 * comments with clearer separation, authorship and timing."*
 *
 * A change to the RENDERING and to nothing else: the threads this reads are
 * the threads `create_thread` writes, and every row keeps the `threadId` a
 * reply has to land in.
 */
describe('flattenComments', () => {
  const c = (author: string, ts: number) => ({ author, text: `${author} at ${ts}`, ts });

  /**
   * Two conversations that INTERLEAVE. A fixture where each thread's comments
   * are contiguous in time cannot tell "one sequence, oldest first" apart from
   * "the old per-thread grouping, concatenated" — the two produce an identical
   * order, so it would pass against the code being replaced.
   */
  it('reads every comment oldest first, across threads', () => {
    const rows = flattenComments([
      { id: 'th-a', comments: [c('Jordan', 10), c('Jordan', 40)] },
      { id: 'th-b', comments: [c('Sam', 20), c('Sam', 30)] },
    ]);
    expect(rows.map((r) => r.comment.ts)).toEqual([10, 20, 30, 40]);
    expect(rows.map((r) => r.threadId)).toEqual(['th-a', 'th-b', 'th-b', 'th-a']);
  });

  // (The opensThread/closesThread/status/anchorText assertions that sat here
  // are gone WITH the fields: they marked the rows that carried the thread
  // badge, the Reply button and the anchor quote, and this branch removed
  // that chrome. A row's only thread fact now is its routing `threadId`,
  // asserted above.)

  /** Two comments written in the same millisecond are a fixture, not a race —
   *  an unstable sort would repaint the panel into a different order for no
   *  reason a reader could see. */
  it('breaks a timestamp tie by declaration order, every time', () => {
    const threads: TaskThread[] = [
      { id: 'th-a', comments: [c('Jordan', 5)] },
      { id: 'th-b', comments: [c('Sam', 5), c('Sam', 5)] },
    ];
    for (let i = 0; i < 5; i += 1) {
      expect(flattenComments(threads).map((r) => r.comment.author)).toEqual([
        'Jordan',
        'Sam',
        'Sam',
      ]);
    }
  });

  it('has nothing to say about a task with no threads', () => {
    expect(flattenComments([])).toEqual([]);
    // Control: the same call over one thread is not empty, so the line above
    // is about the input rather than about a function that returns nothing.
    expect(flattenComments([{ id: 'th', comments: [c('Jo', 1)] }])).toHaveLength(1);
  });
});

/**
 * The description is edited where it is read, so the panel's repaint has to
 * leave one node alone.
 *
 * Every ydoc change repaints this panel — a peer's status flip, a comment
 * landing, and the reader's OWN typing, since the body snapshot lands in the
 * projection a few hundred ms after a pause. A repaint that rebuilt the
 * description would tear the editor out from under whoever is typing in it:
 * even MOVING the node removes it from the document first, which blurs it and
 * drops the caret. So the slot is kept, and only when it is live.
 */
describe('the description slot the editor mounts into', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });

  const detailHandlers = () => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
  });

  const slot = () => root.querySelector('.hub-detail-body-slot') as HTMLElement | null;
  /** What the mount does to a slot, without dragging Tiptap into a DOM test:
   *  claim the node, then put something in it that is not the projection. */
  const goLive = (el: HTMLElement, text = 'the editor’s own content') => {
    el.classList.add(BODY_LIVE_CLASS);
    el.replaceChildren(document.createTextNode(text));
  };

  it('holds the description, and says which task it belongs to', () => {
    const t = task({ body: 'Agent can **read** it here so that it can start cold.' });
    renderTaskDetail(root, t, detailHandlers());
    const s = slot();
    expect(s?.dataset.taskId).toBe(t.id);
    // Still rendered markdown, not asterisks — the pre-mount fallback is the
    // description, not a placeholder for one.
    expect(s?.querySelector('.hub-detail-body strong')?.textContent).toBe('read');
  });

  it('keeps the very same node across a repaint once the editor owns it', () => {
    const t = task({ body: 'First.' });
    renderTaskDetail(root, t, detailHandlers());
    const s = slot() as HTMLElement;
    goLive(s);

    renderTaskDetail(root, { ...t, title: 'Renamed', body: 'Second.' }, detailHandlers());

    expect(slot()).toBe(s);
    // Untouched by the repaint — including by the newer projection body,
    // which the editor is ahead of rather than behind.
    expect(s.textContent).toBe('the editor’s own content');
    // …while everything around it followed the change.
    expect(root.querySelector('.hub-detail-title')?.textContent).toBe('Renamed');
  });

  // The other half, and the reason the class exists at all: before the mount
  // the slot is showing the PROJECTION, and a projection that stopped
  // updating would leave a description the store no longer has.
  it('refills a slot no editor has claimed, so the text follows the store', () => {
    const t = task({ body: 'First.' });
    renderTaskDetail(root, t, detailHandlers());
    const s = slot();
    renderTaskDetail(root, { ...t, body: 'Second.' }, detailHandlers());

    // The slot ELEMENT is the island's and outlives the repaint either way —
    // this used to assert it was replaced, which was true only because the
    // whole panel was. What matters is the second half: an un-mounted slot
    // still follows the projection.
    expect(slot()).toBe(s);
    expect(slot()?.textContent).toContain('Second.');
  });

  // A live editor is bound to ONE room. Carrying its node onto another task
  // would show task A's description on task B and write B's typing into A.
  it('replaces the slot when the panel moves to another task', () => {
    const a = task({ body: 'A.' });
    renderTaskDetail(root, a, detailHandlers());
    const s = slot() as HTMLElement;
    goLive(s);

    renderTaskDetail(root, task({ body: 'B.' }), detailHandlers());

    expect(slot()).not.toBe(s);
    expect(slot()?.textContent).toContain('B.');
    expect(slot()?.classList.contains(BODY_LIVE_CLASS)).toBe(false);
  });

  it('drops the slot with the panel when the reader closes it', () => {
    const t = task({ body: 'A.' });
    renderTaskDetail(root, t, detailHandlers());
    goLive(slot() as HTMLElement);
    renderTaskDetail(root, null, detailHandlers());

    expect(slot()).toBeNull();
    // Reopening the same task builds a fresh one rather than resurrecting a
    // node whose editor and websocket the host has already torn down.
    renderTaskDetail(root, t, detailHandlers());
    expect(slot()?.classList.contains(BODY_LIVE_CLASS)).toBe(false);
  });

  // The description and the place to change it used to be on two pages. The
  // link stays, because the full surface has anchored comments and a wider
  // page — but it is no longer the way to edit, and the copy has to say so.
  it('the link out is a second way in, not the way to edit', () => {
    const t = task({ body: 'Something.' });
    renderTaskDetail(root, t, detailHandlers());
    const a = root.querySelector('.hub-detail-body-link a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(`/review/${encodeURIComponent(t.bodyDocId)}`);
    expect(a.textContent).toBe('Open in the full editor');

    // Same copy with no description: the old wording branched on the body
    // ("Write the description in the task doc"), which sent the one reader
    // most likely to type something to another page to do it.
    renderTaskDetail(root, task(), detailHandlers());
    expect(root.querySelector('.hub-detail-body-link a')?.textContent).toBe(
      'Open in the full editor',
    );
  });

  it('the panel still closes on a tap outside it after a repaint that kept the slot', () => {
    const onClose = vi.fn();
    const t = task({ body: 'A.' });
    renderTaskDetail(root, t, { ...detailHandlers(), onClose });
    goLive(slot() as HTMLElement);
    renderTaskDetail(root, { ...t, title: 'Renamed' }, { ...detailHandlers(), onClose });

    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Exactly once: the backdrop handler is wired when the panel is built and
    // the kept path must not stack a second copy on the same container.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('renderQuickAdd', () => {
  it('captures on Enter and clears, and Shift+Enter does not file a half-typed idea', async () => {
    const onCapture = vi.fn(() => Promise.resolve(true));
    renderQuickAdd(root, { onCapture });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'Rework the strip';
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    expect(onCapture).not.toHaveBeenCalled();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('Rework the strip', undefined);
    // Cleared, so the next idea starts empty rather than appended to the last.
    await Promise.resolve();
    expect(box.value).toBe('');
  });

  it('files nothing for whitespace, from either the key or the button', () => {
    const onCapture = vi.fn(() => Promise.resolve(true));
    renderQuickAdd(root, { onCapture });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = '   ';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    (root.querySelector('.hub-quick-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    expect(onCapture).not.toHaveBeenCalled();
  });

  /**
   * Clearing on dispatch rather than on success means an offline phone eats
   * the idea and shows a toast — the one failure this box exists to prevent,
   * at the exact moment (no signal, thought half-formed) it matters most.
   */
  it('keeps the text when the capture fails, and clears it when it lands', async () => {
    let outcome = Promise.resolve(false);
    renderQuickAdd(root, { onCapture: () => outcome });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'Rework the strip';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await outcome;
    expect(box.value).toBe('Rework the strip');

    outcome = Promise.resolve(true);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await outcome;
    // Positive control: the same box does clear once the task really lands.
    expect(box.value).toBe('');
  });

  it('does not file the same idea twice while the first one is in flight', async () => {
    let release = (_ok: boolean) => {};
    const onCapture = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    renderQuickAdd(root, { onCapture });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'Rework the strip';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledTimes(1);
    release(true);
    await Promise.resolve();
  });

  // The board repaints on every ydoc change. A composer that re-rendered with
  // it would take the caret out of a half-typed idea — which is the exact
  // friction this box exists to remove, reintroduced by the region pattern
  // every other renderer here follows.
  it('mounts once and leaves a half-typed idea alone on a repaint', () => {
    const stub = () => Promise.resolve(true);
    renderQuickAdd(root, { onCapture: stub });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'half an idea';
    renderQuickAdd(root, { onCapture: stub });
    expect(root.querySelectorAll('.hub-quick-input')).toHaveLength(1);
    expect((root.querySelector('.hub-quick-input') as HTMLTextAreaElement).value).toBe(
      'half an idea',
    );
  });
});

/**
 * A percentage max-width on a grid item resolves against its own grid AREA.
 * `.hub-task-badges` sits in an `auto` track — a track sized FROM the item —
 * so `max-width: 30%` meant "30% of yourself", and with `overflow: hidden`
 * the `decision` pill rendered as the two letters "de" on a phone. Nothing
 * else in this suite can see it: happy-dom has no layout, the DOM is
 * identical either way, and the row's grid template is already asserted
 * above and was correct the whole time. Found by looking at a staging board
 * at 430px, which is the only way this class of defect is ever found.
 */
describe('the row badges are capped against the viewport, not against themselves', () => {
  it('never uses a percentage max-width on .hub-task-badges', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // vitest runs from the repo root (vitest.config.ts lives there).
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const rules = [...css.matchAll(/\.hub-task-badges\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    // Positive control: the rules this asserts about really were found, and
    // one of them really does cap the width.
    expect(rules.length).toBeGreaterThan(1);
    expect(rules.some((r) => /max-width/.test(r))).toBe(true);
    for (const r of rules) expect(r).not.toMatch(/max-width:\s*[\d.]+%/);
  });
});

/**
 * happy-dom does no layout, so nothing else in this suite can see a fixed
 * launcher painting over a button. What it CAN see is the invariant: the
 * phone media block that restyles the walkthrough must also reserve bottom
 * clearance in the card, or its last control ("Tell me more" on a decision
 * card) ends up under the bottom-docked mic/pencil launchers.
 *
 * The anchor for "the phone block" has moved twice, each time because the
 * surface changed shape: first a sticky .hub-walk-nav, then a panel taken to
 * max-height: 100vh. It is now the stacked reply form, because the
 * walkthrough is a PAGE in the Home column (approved mockup) and no longer
 * goes full-screen at all — which is also why this file asserts, below, that
 * nothing puts it back on `position: fixed`.
 */
describe('the walkthrough page reserves launcher clearance on a phone', () => {
  it('gives the card bottom clearance wherever the phone block restyles it', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    // The media blocks are the unit: sticky nav and card clearance have to
    // travel together, so find the block and assert about that one text.
    // Brace-scanned rather than regexed — a media block holds nested rules,
    // and a pattern that assumes otherwise matches nothing and proves nothing.
    const blocks: string[] = [];
    for (const m of css.matchAll(/@media[^{]*\{/g)) {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') depth -= 1;
        i += 1;
      }
      blocks.push(css.slice(start, i - 1));
    }
    const phone = blocks.filter((b) => /\.hub-walk-answer[^{]*\{/.test(b));
    // Positive control: the block this asserts about exists and was matched.
    expect(phone.length).toBeGreaterThan(0);
    for (const b of phone) {
      expect(b).toMatch(/\.hub-walk-card\s*\{[^}]*padding-bottom:\s*calc\([\d.]+px/);
    }
    // The stepper lives in the head now — nothing may make it sticky again
    // without restoring the reserve that travelled with the old bar.
    expect(css).not.toMatch(/\.hub-walk-nav\s*\{[^}]*position:\s*sticky/);
    // And the page must stay a page: a fixed overlay over the board is the
    // layout that got rejected, and it takes the Back-to-Home link's meaning
    // with it.
    expect(css).not.toMatch(/\.hub-walk(through|-panel)[^{]*\{[^}]*position:\s*fixed/);
  });
});

/**
 * happy-dom does no layout, so what is checkable here is the rule that makes
 * the phone layout work. Measured in a real 430px frame: the kind badge takes
 * ~180px of the line, and a title free to shrink to zero comes out about
 * 110px wide — a one-line question stacked seven words tall. The floor is
 * what makes the head WRAP instead, which is what the mockup draws.
 */
describe('the walkthrough card head keeps a readable title on a phone', () => {
  it('gives the title a width floor rather than letting it shrink to nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const rule = css.match(/\.hub-walk-title\s*\{([^}]*)\}/)?.[1] ?? '';
    // Positive control: the rule this asserts about was found and is the one
    // that lays the title out.
    expect(rule).toMatch(/flex:\s*1/);
    const floor = rule.match(/min-width:\s*(\d+)px/)?.[1];
    expect(Number(floor ?? 0)).toBeGreaterThanOrEqual(120);
    // The floor only works because a long unbroken token has its own escape.
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

/**
 * happy-dom does no layout, so the popover and the 430px fit are pinned at
 * the rule level, the same way the walkthrough title floor is above: assert
 * the declarations that make the behaviour, with a presence check first so
 * a renamed selector fails loudly rather than passing vacuously.
 */
describe('settings popover + presence visibility (CSS contract)', () => {
  const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

  it('the settings panel floats instead of shifting the page', () => {
    const rule = css.match(/\.hub-settings-panel\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('background'); // positive control: found the rule
    expect(rule).toMatch(/position:\s*absolute/);
    // Anchored to the header, which must therefore be a positioned ancestor.
    const topbar = css.match(/\.hub-topbar\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(topbar).toMatch(/position:\s*relative/);
  });

  it('no width band hides the circle presence strip any more', () => {
    // The old ≤560px rule was `.hub-presence.hub-people { display: none }`.
    // The circles fit, so nothing may hide the strip at any width.
    const peopleRules = [...css.matchAll(/\.hub-presence\.hub-people\s*\{([^}]*)\}/g)];
    expect(peopleRules.length).toBeGreaterThan(0); // positive control
    for (const [, body] of peopleRules) {
      expect(body).not.toMatch(/display:\s*none/);
    }
  });
});

describe('renderQuickAdd — dictating into the box', () => {
  /** The parts `mountVoice` is handed, captured at mount. */
  type VoiceParts = Parameters<NonNullable<QuickAddHandlers['mountVoice']>>[0];
  function mount(onCapture = vi.fn(() => Promise.resolve(true))) {
    const sink: VoiceParts[] = [];
    renderQuickAdd(root, { onCapture, mountVoice: (p) => void sink.push(p) });
    const parts = sink[0];
    if (!parts) throw new Error('mountVoice was never called');
    return {
      onCapture,
      parts,
      box: root.querySelector('.hub-quick-input') as HTMLTextAreaElement,
    };
  }

  it('hands the voice layer a button that lives inside the form', () => {
    // Inside the form, not floating next to it: the mic has to be reachable
    // with the thumb that is already on the box, on a phone.
    const { parts } = mount();
    expect(parts.button.closest('.hub-quick-form')).not.toBeNull();
    expect(parts.button.type).toBe('button'); // never submits the form
  });

  it('appends what was said to what was typed, and files both with the quote', async () => {
    const { onCapture, parts, box } = mount();
    box.value = 'Fix the goal card';
    parts.deliver('it is too tall on a phone');
    expect(box.value).toBe('Fix the goal card it is too tall on a phone');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith(
      'Fix the goal card it is too tall on a phone',
      'it is too tall on a phone',
    );
    await Promise.resolve();
  });

  it('does not file the previous utterance as the next task’s quote', async () => {
    // The failure this guards: dictate one task, file it, TYPE the next one,
    // and the second task carries words its author never said about it.
    const { onCapture, parts, box } = mount();
    parts.deliver('add a mic to the board');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(box.value).toBe('');

    box.value = 'ship the release notes';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenLastCalledWith('ship the release notes', undefined);
  });

  it('forgets the utterance when the person clears the box themselves', () => {
    const { onCapture, parts, box } = mount();
    parts.deliver('add a mic to the board');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.value = 'something else entirely';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('something else entirely', undefined);
  });

  it('keeps the quote when a misheard word is corrected before filing', () => {
    // Editing the text must NOT drop the quote — the agent seeing both the
    // corrected task and the raw utterance is the reason to keep one.
    const { onCapture, parts, box } = mount();
    parts.deliver('add a mike to the board');
    box.value = 'add a mic to the board';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('add a mic to the board', 'add a mike to the board');
  });

  it('keeps an utterance dictated while the previous capture was in flight', async () => {
    // The box deliberately stays live during the POST. `deliver` appends, so
    // the accumulated quote is now BOTH utterances — clearing it wholesale on
    // the resolve files the second idea with no record of what was said.
    let settle: ((ok: boolean) => void) | undefined;
    const onCapture = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          settle = r;
        }),
    );
    const { parts, box } = mount(onCapture);
    parts.deliver('fix the login bug');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('fix the login bug', 'fix the login bug');

    parts.deliver('also update the docs');
    settle?.(true);
    await Promise.resolve();
    await Promise.resolve();

    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenLastCalledWith(
      'fix the login bug also update the docs',
      'also update the docs',
    );
  });

  it('drops the quote when the box is retyped from scratch', () => {
    // Select-all-and-retype is ONE input event with a non-empty value, so the
    // "emptied by hand" reset never fires and the new task would be filed
    // quoting an utterance about entirely different work.
    const { onCapture, parts, box } = mount();
    parts.deliver('buy milk');
    box.value = 'review the deploy script';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('review the deploy script', undefined);
  });

  it('mounts the dictation indicator hidden', () => {
    // `flex-basis: 100%` in a wrapping row: visible from first paint it claims
    // its own flex line, so the form sheds a row-gap the first time anything
    // is dictated and never gets it back.
    const { parts } = mount();
    expect(parts.indicator.className).toContain('hub-quick-mic-state');
    expect(parts.indicator.classList.contains('hidden')).toBe(true);
  });

  it('still mounts, and still captures, with no voice layer at all', () => {
    // Positive control for the whole describe: every assertion above depends
    // on mountVoice being called, so a build where speech is unavailable must
    // be shown to leave the typed path exactly as it was.
    const onCapture = vi.fn(() => Promise.resolve(true));
    renderQuickAdd(root, { onCapture });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'typed only';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('typed only', undefined);
  });
});

/**
 * Wiring, asserted against the source, because the failure is silent.
 *
 * `hub-app.ts` mounts two voice captures on one page. Space is a singleton
 * gesture: if both bind it, one press starts both recognizers and each
 * finalizes its own transcript — the utterance goes to the agent AND into the
 * capture box, and nothing errors. Only one of the two may own Space, and no
 * unit test on `createVoiceCapture` can see which mounts opted out.
 */
describe('hub-app voice wiring', () => {
  /** Comment lines stripped — prose ABOUT `spaceHotkey: false` must not count
   *  as a call site that sets it. (It did, on the first run of this test.) */
  function code(): string {
    const src = readFileSync(resolve('packages/markdown-app/src/hub/hub-app.ts'), 'utf8');
    return src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  it('mounts exactly one capture that owns the Space hotkey', () => {
    const src = code();
    const mounts = src.split('createVoiceCapture({').length - 1;
    // Positive control: this counts real call sites, not zero of them.
    expect(mounts).toBe(2);
    expect(src.split('spaceHotkey: false').length - 1).toBe(mounts - 1);
  });

  it('the dictation ack does not claim the task was filed', () => {
    // The whole design point is that dictation does NOT file — it fills the
    // box and waits for a tap. "Added" is the one word that says it did.
    const src = code();
    const mountVoice = src.slice(src.indexOf('mountVoice:'));
    const body = mountVoice.slice(0, mountVoice.indexOf('\n    });'));
    const ack = /ack:\s*'([^']*)'/.exec(body)?.[1];
    // Positive control: the assertions below are about a string we found, not
    // about `undefined` quietly satisfying every `not.toMatch`.
    expect(ack).toBeTruthy();
    expect(ack).not.toMatch(/\b(added|created|filed|captured|saved)\b/i);
    // And it still names the tap that would file it.
    expect(ack).toMatch(/\bAdd\b/);
  });

  it('never files a dictated task without a human tap', () => {
    // The quick-add mic delivers into the box; only Add / Enter files. A
    // `send` that POSTed would file whatever the recognizer heard.
    const src = code();
    const mountVoice = src.slice(src.indexOf('mountVoice:'));
    const body = mountVoice.slice(0, mountVoice.indexOf('\n    });'));
    expect(body).toContain('deliver(transcript)');
    expect(body).not.toContain('captureTask');
  });
});

describe('renderUnplacedStrip', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  function host(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'hub-unplaced hidden';
    document.body.append(el);
    return el;
  }

  it('renders nothing and stays hidden on an empty bucket', () => {
    const el = host();
    // Positive control: the same container DOES fill when there is something
    // to say, so an empty one is the renderer's decision, not a dead call.
    renderUnplacedStrip(el, unplacedNotice([task({ unplacedSince: NOW - DAY })], NOW), {
      onOpenOldest: () => {},
    });
    expect(el.textContent).toContain('1 task has no goal yet');
    expect(el.classList.contains('hidden')).toBe(false);

    renderUnplacedStrip(el, unplacedNotice([task({ goal: 'g-pr' })], NOW), {
      onOpenOldest: () => {},
    });
    expect(el.childElementCount).toBe(0);
    expect(el.textContent).toBe('');
    expect(el.classList.contains('hidden')).toBe(true);
  });

  it('says how many and how old, and opens the longest-waiting task', () => {
    const el = host();
    const old = task({ id: 't-waited', unplacedSince: NOW - 6 * DAY });
    const opened: string[] = [];
    renderUnplacedStrip(el, unplacedNotice([task({ unplacedSince: NOW - HOUR }), old], NOW), {
      onOpenOldest: (id) => opened.push(id),
    });
    expect(el.textContent).toContain('2 tasks have no goal yet');
    expect(el.textContent).toContain('oldest waiting 6d');

    const btn = el.querySelector<HTMLButtonElement>('.hub-unplaced-open');
    expect(btn).not.toBeNull();
    btn?.click();
    expect(opened).toEqual(['t-waited']);
  });

  it('informs rather than scolds', () => {
    // A strip that reads as an accusation gets ignored, and an ignored strip
    // is the same as the silence it was built to break.
    const el = host();
    renderUnplacedStrip(el, unplacedNotice([task({ unplacedSince: NOW - 9 * DAY })], NOW), {
      onOpenOldest: () => {},
    });
    expect(el.textContent).not.toMatch(/\b(overdue|neglect\w*|ignored|stale|forgotten|should)\b/i);
    expect(el.textContent).not.toMatch(/[!⚠]/);
  });

  it('is drawn quieter than the decisions alarm above it', () => {
    // Same reason the coverage line is quieter than the drift alarm: if the
    // standing reading looks like the alarm, people learn to skim the alarm.
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');
    // Collect the strip's OWN rules rather than slicing to whatever selector
    // happens to follow it. The slice form read to `.hub-walkthrough {`, and
    // when that rule went away (the walkthrough stopped being a fixed overlay)
    // `indexOf` returned -1 and the "block" became the rest of the file — a
    // test that then fails on somebody else's colour.
    const rules = [...css.matchAll(/\.hub-unplaced[\w-]*(?:\.[\w-]+)?\s*\{([^}]*)\}/g)].map(
      (m) => m[1] ?? '',
    );
    // Positive control: the rules this asserts about really were found.
    expect(rules.length).toBeGreaterThan(1);
    expect(rules.some((r) => r.includes('--fg-muted'))).toBe(true);
    for (const r of rules) expect(r).not.toContain('--yellow');
    // The tap target still has to be reachable on a phone.
    expect(rules.some((r) => /min-height:\s*36px/.test(r))).toBe(true);
  });
});
