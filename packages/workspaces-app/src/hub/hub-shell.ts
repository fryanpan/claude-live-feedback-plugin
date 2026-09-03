/**
 * The hub page's static shell: the markup `bootHub` paints once into
 * `#hub-root`, and the nav glyphs it is drawn with.
 *
 * One responsibility — the DOM that exists before any region renders. It is
 * the one piece of `hub-app.ts` that never sees `main()`'s closure: it takes
 * a document, a root, a name and a workspace id, and returns nothing but the
 * containers every `render*` writes into. That is why it can live here while
 * the render layer cannot — nothing in this file can reach `state`, so a
 * change to the shell cannot quietly become a change to the board.
 *
 * `NAV_ICONS` is exported for one reader outside the shell: the rail's
 * collapse button swaps its glyph at runtime, which is a behaviour of the
 * boot wiring rather than of the markup.
 */
import { escapeHtml } from '@feedback/core';
import { MIC_ICON, SVG, SVG_ENDS } from '../icons.ts';
// Defines <meeting-banner>, rendered by buildShell at the top of the board
// column. Import for the side effect; the element manages itself.
import '../meeting-banner.ts';
import { DEFAULT_DONE_WINDOW, DONE_WINDOWS } from './hub-board-model.ts';
import type { HubNav } from './hub-presence-model.ts';

/** Icons. The four nav glyphs are the approved mockup's (home-pane-mockup-v1);
 *  share and settings are new, for the top-right cluster. The shared
 *  attributes and the mic come from `../icons.ts`, because the mic is mounted
 *  by three surfaces and only one of them is a hub module. */
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
const NAV_ITEMS: ReadonlyArray<{ nav: HubNav; label: string; icon: string }> = [
  { nav: 'home', label: 'Home', icon: NAV_ICONS.home },
  { nav: 'tasks', label: 'Tasks', icon: NAV_ICONS.tasks },
  { nav: 'mine', label: 'My Tasks', icon: NAV_ICONS.mine },
  { nav: 'activity', label: 'Activity', icon: NAV_ICONS.activity },
];

/** Static shell — built once; regions re-render into their containers. */
export function buildShell(
  document: Document,
  root: HTMLElement,
  name: string,
  workspaceId: string,
): void {
  root.innerHTML = `
    <header class="hub-topbar">
      <a href="/" class="back-link" title="All workspaces" aria-label="Back">←</a>
      <span class="hub-ws-name"><span class="hub-ws-name-text" id="hub-ws-name-text">${escapeHtml(name)}</span><span id="hub-retired-badge" class="hub-retired-badge hidden">Retired</span></span>
      <div class="hub-cluster">
        <div id="hub-people" class="hub-presence hub-people hidden"></div>
        <button type="button" id="hub-share" class="hub-icon-btn" title="Share workspace" aria-label="Share workspace">${NAV_ICONS.share}</button>
        <button type="button" id="hub-settings" class="hub-icon-btn" title="Workspace settings" aria-label="Workspace settings" aria-expanded="false">${NAV_ICONS.settings}<span id="hub-settings-alarm" class="hub-alarm-dot hidden" aria-hidden="true"></span></button>
        <button type="button" id="hub-me" class="hub-me" title="Signed in" aria-haspopup="true" aria-expanded="false"></button>
      </div>
      <div id="hub-me-menu" class="hub-me-menu hidden" role="region" aria-label="Your identity"></div>
      <div id="hub-settings-panel" class="hub-settings-panel hidden" role="region" aria-label="Workspace settings">
        <div id="hub-drift" class="hub-presence hidden"></div>
        <div id="hub-lead" class="hub-lead"></div>
        <label class="hub-settings-row" for="hub-done-filter">Show done tasks from
          <select id="hub-done-filter" class="hub-select" aria-label="Done task visibility"></select>
        </label>
        <!-- Per DEVICE, not per account — a push subscription belongs to this
             browser on this machine, so the row says so rather than reading
             like a workspace-wide preference somebody set once. -->
        <label class="hub-settings-row hub-settings-row--push" for="hub-push-toggle">
          <span class="hub-settings-label">Notify me on this device
            <small id="hub-push-note" class="hub-settings-note"></small>
          </span>
          <input type="checkbox" id="hub-push-toggle" class="hub-check" aria-describedby="hub-push-note" />
        </label>
        <!-- What the quality gate judges an agent's ask against, in the
             owner's own words (Bryan, 2026-08-29: "Something we can change in
             the settings. It's a natural language prompt."). A textarea and
             not a rule table for that reason. It shows the DEFAULT when this
             board has never written one, so the words are always readable
             even when nobody has edited them — a criterion you cannot read is
             one your agents are judged against in secret. -->
        <div class="hub-settings-row hub-settings-row--criteria">
          <label class="hub-settings-label" for="hub-review-criteria">What makes a good review item
            <small id="hub-review-criteria-note" class="hub-settings-note"></small>
          </label>
          <textarea id="hub-review-criteria" class="hub-criteria" rows="5" aria-describedby="hub-review-criteria-note" placeholder="Plain English: what an agent’s ask has to do before it reaches you."></textarea>
          <div class="hub-criteria-actions">
            <button type="button" id="hub-review-criteria-save" class="hub-btn hub-btn-primary">Save</button>
            <button type="button" id="hub-review-criteria-default" class="hub-btn">Use the default</button>
          </div>
        </div>
        <!-- How many builders this board's lead may dispatch at once
             (Bryan, by voice: "add support for limiting parallelism in the
             workspace"). register_dispatch enforces the number server-side;
             this is where it's read, changed, and shown alongside how many
             slots are already spent. -->
        <div class="hub-settings-row hub-settings-row--cap">
          <label class="hub-settings-label" for="hub-parallelism-cap">Parallelism cap
            <small id="hub-parallelism-cap-note" class="hub-settings-note"></small>
          </label>
          <input type="number" id="hub-parallelism-cap" class="hub-cap-input" min="1" step="1" aria-describedby="hub-parallelism-cap-note" />
          <div class="hub-criteria-actions">
            <button type="button" id="hub-parallelism-cap-save" class="hub-btn hub-btn-primary">Save</button>
            <button type="button" id="hub-parallelism-cap-default" class="hub-btn">Use the default</button>
          </div>
        </div>
      </div>
    </header>
    <div id="hub-connection" class="conn-banner hidden" role="status" aria-live="polite"></div>
    <div class="hub-main" id="hub-main">
      <nav id="hub-nav" class="hub-nav" aria-label="Workspace pages">
        ${NAV_ITEMS.map(
          (
            n,
          ) => `<button type="button" class="hub-nav-item" data-nav="${n.nav}" title="${escapeHtml(n.label)}">
          <span class="hub-nav-icon" aria-hidden="true">${n.icon}</span><span class="hub-nav-label">${escapeHtml(n.label)}</span>
        </button>`,
        ).join('')}
        <button type="button" id="hub-nav-collapse" class="hub-nav-item hub-nav-collapse" title="Collapse">
          <span class="hub-nav-icon" aria-hidden="true">${NAV_ICONS.collapse}</span><span class="hub-nav-label">Collapse</span>
        </button>
        <div class="hub-nav-dock" role="group" aria-label="Voice">
          <button type="button" id="hub-mic" class="voice-mic" title="Hold to talk (or hold Space)" aria-label="Hold to talk">${MIC_ICON}</button>
          <div id="hub-voice" class="voice-indicator hidden" aria-live="polite"></div>
        </div>
      </nav>
      <section id="hub-home" class="hub-home hidden">
        <!-- The banner again, for the pane landing links open on: the board
             column's copy is display:none here, and a live "Bot in call" —
             the only pull-out surface — must not be. Its own instance with
             its own poll; the two panes never show at once. -->
        <meeting-banner workspace-id="${escapeHtml(workspaceId)}"></meeting-banner>
        <div id="hub-home-page">
          <div id="hub-home-review"></div>
          <div id="hub-home-activity"></div>
          <div id="hub-home-brief"></div>
        </div>
        <div id="hub-walkthrough" class="hub-walkthrough hidden"></div>
      </section>
      <section class="hub-board-col">
        <!-- The calendar meeting offer, IN FLOW at the top of the content
             (approved mockup, round 4): header bar, then this, then the New
             task row — pushed-down content, never an overlay. Hidden with the
             whole column on the Home pane. -->
        <meeting-banner workspace-id="${escapeHtml(workspaceId)}"></meeting-banner>
        <div id="hub-decisions" class="hub-decisions hidden"></div>
        <div id="hub-quick" class="hub-quick"></div>
        <div id="hub-board" class="hub-board"></div>
        <div id="hub-archived" class="hub-board hidden"></div>
        <div id="hub-activity" class="hub-activity hidden"></div>
      </section>
    </div>
    <div id="hub-detail" class="hub-detail hidden"></div>
    <!-- The GOAL panel's own container. It used to share #hub-detail with the
         task panel and rebuild it with replaceChildren, which no vanilla code
         may do to a node holding a live island — same resolution the archived
         list got when the board became one. -->
    <div id="hub-goal-detail" class="hub-detail hidden"></div>
    <div id="hub-help" class="hub-help hidden">
      <div class="hub-help-card">
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
    <div id="hub-toast" class="hub-toast hidden"></div>`;
  const doneSelect = document.getElementById('hub-done-filter') as HTMLSelectElement;
  for (const w of DONE_WINDOWS) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.label;
    doneSelect.append(opt);
  }
  doneSelect.value = DEFAULT_DONE_WINDOW;
}
