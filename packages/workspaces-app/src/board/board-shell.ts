/**
 * The board page's static shell: the markup `bootBoard` paints once into
 * `#board-root`, and the nav glyphs it is drawn with.
 *
 * One responsibility — the DOM that exists before any region renders. It is
 * the one piece of `board-app.ts` that never sees `main()`'s closure: it takes
 * a document, a root, a name and a workspace id, and returns nothing but the
 * containers every `render*` writes into. That is why it can live here while
 * the render layer cannot — nothing in this file can reach `state`, so a
 * change to the shell cannot quietly become a change to the board.
 *
 * `wireNavCollapse` sits here rather than in the boot for the same reason
 * the markup does: it is entirely about the rail — the class the rail wears,
 * the glyph and label the button swaps to, and the one stored preference
 * that makes the choice survive a reload. Nothing in it reads board state
 * either.
 */
import { escapeHtml } from '@feedback/core';
import { MIC_ICON, SVG, SVG_ENDS } from '../icons.ts';
// Defines <meeting-banner>, rendered by buildShell at the top of the board
// column. Import for the side effect; the element manages itself.
import '../meeting-banner.ts';
import { DEFAULT_DONE_WINDOW, DONE_WINDOWS } from './board-model.ts';
import type { BoardNav } from './board-presence-model.ts';

/** Where the collapse choice is remembered — `bootBoard`'s injected
 *  `localStorage`, so a test can hand it a plain map. */
export interface NavCollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Icons. The four nav glyphs are the approved mockup's (home-pane-mockup-v1);
 *  share and settings are new, for the top-right cluster. The shared
 *  attributes and the mic come from `../icons.ts`, because the mic is mounted
 *  by three surfaces and only one of them is a board module. */
export const NAV_ICONS = {
  home: `<svg ${SVG} ${SVG_ENDS}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></svg>`,
  tasks: `<svg ${SVG} ${SVG_ENDS}><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
  mine: `<svg ${SVG} ${SVG_ENDS}><circle cx="12" cy="8" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>`,
  activity: `<svg ${SVG} ${SVG_ENDS}><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>`,
  collapse: `<svg ${SVG} ${SVG_ENDS}><polyline points="14 6 8 12 14 18"/></svg>`,
  expand: `<svg ${SVG} ${SVG_ENDS}><polyline points="10 6 16 12 10 18"/></svg>`,
  share: `<svg ${SVG} ${SVG_ENDS}><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/></svg>`,
  settings: `<svg ${SVG} ${SVG_ENDS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
};

/** The nav, in the order it renders. `mine` sits beside `tasks` rather than
 *  inside it: "what is mine" is a place a person navigates to, and as a
 *  segmented filter on somebody else's list it had no URL and did not
 *  survive a reload. */
const NAV_ITEMS: ReadonlyArray<{ nav: BoardNav; label: string; icon: string }> = [
  { nav: 'home', label: 'Home', icon: NAV_ICONS.home },
  { nav: 'tasks', label: 'Tasks', icon: NAV_ICONS.tasks },
  { nav: 'mine', label: 'My Tasks', icon: NAV_ICONS.mine },
  { nav: 'activity', label: 'Activity', icon: NAV_ICONS.activity },
];

/**
 * The back arrow, or nothing.
 *
 * `/` is the all-workspaces page, and on a share or collaboration hostname it
 * is not a page at all: the host guard refuses every path that names no
 * workspace, so the arrow landed a visitor on a raw JSON refusal. A member was
 * given one board; there is nowhere above it for them to go, so the arrow is
 * left out rather than pointed somewhere it does not belong.
 *
 * The server sets `data-visitor` on `#board-root` — it is the only side that
 * knows which hostname class served the page.
 */
function backLink(root: HTMLElement): string {
  if (root.dataset.visitor === '1') return '';
  return '<a href="/" class="back-link" title="All workspaces" aria-label="Back">←</a>';
}

/** Static shell — built once; regions re-render into their containers. */
export function buildShell(
  document: Document,
  root: HTMLElement,
  name: string,
  workspaceId: string,
): void {
  root.innerHTML = `
    <header class="board-topbar">
      ${backLink(root)}
      <span class="board-ws-name"><span class="board-ws-name-text" id="board-ws-name-text">${escapeHtml(name)}</span><span id="board-retired-badge" class="board-retired-badge hidden">Retired</span></span>
      <div class="board-cluster">
        <div id="board-people" class="board-presence board-people hidden"></div>
        <button type="button" id="board-share" class="board-icon-btn" title="Share workspace" aria-label="Share workspace">${NAV_ICONS.share}</button>
        <button type="button" id="board-settings" class="board-icon-btn" title="Workspace settings" aria-label="Workspace settings" aria-expanded="false">${NAV_ICONS.settings}<span id="board-settings-alarm" class="board-alarm-dot hidden" aria-hidden="true"></span></button>
        <button type="button" id="board-me" class="board-me" title="Signed in" aria-haspopup="true" aria-expanded="false"></button>
      </div>
      <div id="board-me-menu" class="board-me-menu hidden" role="region" aria-label="Your identity"></div>
      <div id="board-settings-panel" class="board-settings-panel hidden" role="region" aria-label="Workspace settings">
        <div id="board-drift" class="board-presence hidden"></div>
        <div id="board-lead" class="board-lead"></div>
        <label class="board-settings-row" for="board-done-filter">Show done tasks from
          <select id="board-done-filter" class="board-select" aria-label="Done task visibility"></select>
        </label>
        <!-- Per DEVICE, not per account — a push subscription belongs to this
             browser on this machine, so the row says so rather than reading
             like a workspace-wide preference somebody set once. -->
        <label class="board-settings-row board-settings-row--push" for="board-push-toggle">
          <span class="board-settings-label">Notify me on this device
            <small id="board-push-note" class="board-settings-note"></small>
          </span>
          <input type="checkbox" id="board-push-toggle" class="board-check" aria-describedby="board-push-note" />
        </label>
        <!-- What the quality gate judges an agent's ask against, in the
             owner's own words (Bryan, 2026-08-29: "Something we can change in
             the settings. It's a natural language prompt."). A textarea and
             not a rule table for that reason. It shows the DEFAULT when this
             board has never written one, so the words are always readable
             even when nobody has edited them — a criterion you cannot read is
             one your agents are judged against in secret. -->
        <div class="board-settings-row board-settings-row--criteria">
          <label class="board-settings-label" for="board-review-criteria">What makes a good review item
            <small id="board-review-criteria-note" class="board-settings-note"></small>
          </label>
          <textarea id="board-review-criteria" class="board-criteria" rows="5" aria-describedby="board-review-criteria-note" placeholder="Plain English: what an agent’s ask has to do before it reaches you."></textarea>
          <div class="board-criteria-actions">
            <button type="button" id="board-review-criteria-save" class="board-btn board-btn-primary">Save</button>
            <button type="button" id="board-review-criteria-default" class="board-btn">Use the default</button>
          </div>
        </div>
        <!-- How many builders this board's lead may dispatch at once
             (Bryan, by voice: "add support for limiting parallelism in the
             workspace"). register_dispatch enforces the number server-side;
             this is where it's read, changed, and shown alongside how many
             slots are already spent. -->
        <div class="board-settings-row board-settings-row--cap">
          <label class="board-settings-label" for="board-parallelism-cap">Parallelism cap
            <small id="board-parallelism-cap-note" class="board-settings-note"></small>
          </label>
          <input type="number" id="board-parallelism-cap" class="board-cap-input" min="1" step="1" aria-describedby="board-parallelism-cap-note" />
          <div class="board-criteria-actions">
            <button type="button" id="board-parallelism-cap-save" class="board-btn board-btn-primary">Save</button>
            <button type="button" id="board-parallelism-cap-default" class="board-btn">Use the default</button>
          </div>
        </div>
      </div>
    </header>
    <div id="board-connection" class="conn-banner hidden" role="status" aria-live="polite"></div>
    <div class="board-main" id="board-main">
      <nav id="board-nav" class="board-nav" aria-label="Workspace pages">
        ${NAV_ITEMS.map(
          (
            n,
          ) => `<button type="button" class="board-nav-item" data-nav="${n.nav}" title="${escapeHtml(n.label)}">
          <span class="board-nav-icon" aria-hidden="true">${n.icon}</span><span class="board-nav-label">${escapeHtml(n.label)}</span>
        </button>`,
        ).join('')}
        <button type="button" id="board-nav-collapse" class="board-nav-item board-nav-collapse" title="Collapse">
          <span class="board-nav-icon" aria-hidden="true">${NAV_ICONS.collapse}</span><span class="board-nav-label">Collapse</span>
        </button>
        <div class="board-nav-dock" role="group" aria-label="Voice">
          <button type="button" id="board-mic" class="voice-mic" title="Hold to talk (or hold Space)" aria-label="Hold to talk">${MIC_ICON}</button>
          <div id="board-voice" class="voice-indicator hidden" aria-live="polite"></div>
        </div>
      </nav>
      <section id="board-home" class="board-home hidden">
        <!-- The banner again, for the pane landing links open on: the board
             column's copy is display:none here, and a live "Bot in call" —
             the only pull-out surface — must not be. Its own instance with
             its own poll; the two panes never show at once. -->
        <meeting-banner workspace-id="${escapeHtml(workspaceId)}"></meeting-banner>
        <div id="board-home-page">
          <div id="board-home-review"></div>
          <div id="board-home-activity"></div>
          <div id="board-home-brief"></div>
        </div>
        <div id="board-walkthrough" class="board-walkthrough hidden"></div>
      </section>
      <section class="board-col">
        <!-- The calendar meeting offer, IN FLOW at the top of the content
             (approved mockup, round 4): header bar, then this, then the New
             task row — pushed-down content, never an overlay. Hidden with the
             whole column on the Home pane. -->
        <meeting-banner workspace-id="${escapeHtml(workspaceId)}"></meeting-banner>
        <div id="board-decisions" class="board-decisions hidden"></div>
        <div id="board-quick" class="board-quick"></div>
        <div id="board" class="board"></div>
        <div id="board-archived" class="board hidden"></div>
        <div id="board-activity" class="board-activity hidden"></div>
      </section>
    </div>
    <div id="board-detail" class="board-detail hidden"></div>
    <!-- The GOAL panel's own container. It used to share #board-detail with the
         task panel and rebuild it with replaceChildren, which no vanilla code
         may do to a node holding a live island — same resolution the archived
         list got when the board became one. -->
    <div id="board-goal-detail" class="board-detail hidden"></div>
    <div id="board-help" class="board-help hidden">
      <div class="board-help-card">
        <h2>Keyboard shortcuts</h2>
        <dl>
          <dt>j / k</dt><dd>next / previous task</dd>
          <dt>o or Enter</dt><dd>open the focused task</dd>
          <dt>s</dt><dd>open the focused task's status dropdown</dd>
          <dt>a</dt><dd>open the focused task's assignee picker</dd>
          <dt>e</dt><dd>archive the focused task — it leaves the board, and a 10-second Undo offers it back. Nothing is destroyed; the archived list restores it later</dd>
          <dt>r or F2</dt><dd>rename the focused task in place — clicking its title does the same, with the cursor where you clicked</dd>
          <dt>alt + ↑ / ↓</dt><dd>move the focused task up / down — past the ends of its goal it moves into the next one</dd>
          <dt>tab to ⠿, then ↑ / ↓</dt><dd>the same move from the drag handle</dd>
          <dt>c</dt><dd>new task — an empty row opens in the panel with the title ready to type</dd>
          <dt>?</dt><dd>toggle this help</dd>
        </dl>
      </div>
    </div>
    <div id="board-toast" class="board-toast hidden"></div>`;
  const doneSelect = document.getElementById('board-done-filter') as HTMLSelectElement;
  for (const w of DONE_WINDOWS) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.label;
    doneSelect.append(opt);
  }
  doneSelect.value = DEFAULT_DONE_WINDOW;
}

/**
 * The rail's collapse toggle, persisted so the choice survives reloads.
 *
 * Call once, from boot. The button only renders on wide screens (CSS hides
 * it in the strip and bottom-bar bands), so on a phone this wires nothing
 * and the stored preference is simply not consulted.
 */
export function wireNavCollapse(document: Document, storage: NavCollapseStorage): void {
  const NAV_COLLAPSED_KEY = 'cw-board-nav-collapsed';
  const nav = document.getElementById('board-nav');
  const collapseBtn = document.getElementById('board-nav-collapse');
  const apply = (collapsed: boolean) => {
    nav?.classList.toggle('board-nav--collapsed', collapsed);
    if (collapseBtn) {
      const icon = collapseBtn.querySelector('.board-nav-icon');
      if (icon) icon.innerHTML = collapsed ? NAV_ICONS.expand : NAV_ICONS.collapse;
      const label = collapseBtn.querySelector('.board-nav-label');
      if (label) label.textContent = collapsed ? 'Expand' : 'Collapse';
      collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    }
  };
  apply(storage.getItem(NAV_COLLAPSED_KEY) === '1');
  collapseBtn?.addEventListener('click', () => {
    const next = !nav?.classList.contains('board-nav--collapsed');
    storage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
    apply(next);
  });
}
