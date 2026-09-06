/**
 * `/settings/prompts` — the seven prompts this server runs on, and the words
 * of each.
 *
 * A page OUTSIDE the board. Every prompt here except two belongs to the
 * server rather than to any one board, and the reader who tunes them is
 * tuning the machine — so the address is top-level and the board is where the
 * back arrow goes, not where the page lives.
 *
 * Two addresses, both deep-linkable and both server-rendered onto the same
 * shell:
 *
 *   /settings/prompts        the list
 *   /settings/prompts/<id>   one prompt, open
 *
 * `?ws=<workspaceId>` rides along. It is CONTEXT, not authorization: it says
 * which board the reader came from, which is what the rail's links and the
 * two board-scoped prompts need. Absent, the rail is not painted and those
 * two rows are not listed (`prompts-api.ts`).
 *
 * What is deliberately NOT on the page, and why, is the mock's ranking: no
 * model name, no character or token counts, no "last edited by", no chip
 * saying which prompts are per board — all real, none of them something the
 * reader can act on. The one thing a row carries is whether he changed it,
 * because that is how he finds what he broke last week.
 */

import { escapeHtml } from '@feedback/core';
import { mountPromptEditor } from './prompt-editor.ts';
import { type PromptRow, type PromptsApi } from './prompts-api.ts';

/** The page's own address space, so the router is one function. */
export interface PromptsRoute {
  /** The prompt being edited, or null for the list. */
  promptId: string | null;
  /** The board the page was opened from, or null. */
  workspaceId: string | null;
}

/** Read the address. Unknown suffixes fall back to the list rather than 404:
 *  the shell already answered 200, and a blank page is the worse answer. */
export function parsePromptsRoute(pathname: string, search: string): PromptsRoute {
  const match = pathname.match(/^\/settings\/prompts(?:\/([^/]+))?\/?$/);
  const ws = new URLSearchParams(search).get('ws');
  return {
    promptId: match?.[1] ? decodeURIComponent(match[1]) : null,
    workspaceId: ws && ws.trim() !== '' ? ws : null,
  };
}

/** The address for one row, keeping the board context. */
export function promptHref(route: PromptsRoute, id: string): string {
  const q = route.workspaceId ? `?ws=${encodeURIComponent(route.workspaceId)}` : '';
  return `/settings/prompts/${encodeURIComponent(id)}${q}`;
}

/** The address of the list, keeping the board context. */
export function listHref(route: PromptsRoute): string {
  return `/settings/prompts${route.workspaceId ? `?ws=${encodeURIComponent(route.workspaceId)}` : ''}`;
}

const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  tasks: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  mine: '<path d="M20 6L9 17l-5-5"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chev: '<path d="M9 18l6-6-6-6"/>',
} as const;

function icon(kind: keyof typeof ICONS, cls: string): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[kind]}</svg>`;
}

/**
 * The board's own rail, so this page sits where the board's Settings button
 * sat rather than looking like a different product. Painted only with a board
 * in context: four links to a board that is not named would be four dead
 * ends.
 */
function rail(route: PromptsRoute): string {
  if (!route.workspaceId) return '';
  const ws = encodeURIComponent(route.workspaceId);
  const item = (href: string, kind: keyof typeof ICONS, label: string): string =>
    `<a class="settings-rail-item" href="${href}">${icon(kind, 'settings-rail-icon')}${label}</a>`;
  return (
    `<nav class="settings-rail" aria-label="Workspace">` +
    item(`/workspaces/${ws}/home`, 'home', 'Home') +
    item(`/workspaces/${ws}/tasks`, 'tasks', 'Tasks') +
    item(`/workspaces/${ws}/mine`, 'mine', 'My Tasks') +
    item(`/workspaces/${ws}/activity`, 'activity', 'Activity') +
    `<div class="settings-rail-spacer"></div>` +
    `<a class="settings-rail-item" href="${listHref(route)}" aria-current="page">` +
    `${icon('settings', 'settings-rail-icon')}Settings</a>` +
    '</nav>'
  );
}

function chrome(route: PromptsRoute): string {
  const back = route.promptId
    ? `<a class="settings-back settings-back--up" id="settings-back" href="${listHref(route)}">` +
      `${icon('back', 'settings-rail-icon')}Prompts</a>`
    : route.workspaceId
      ? `<a class="settings-back" href="/workspaces/${encodeURIComponent(route.workspaceId)}">` +
        `${icon('back', 'settings-rail-icon')}Board</a>`
      : `<a class="settings-back" href="/">${icon('back', 'settings-rail-icon')}Workspaces</a>`;
  const title = route.promptId
    ? `<h1 class="settings-title--editing">Prompts</h1>`
    : '<h1>Settings</h1>';
  return (
    `<div class="settings-shell">` +
    rail(route) +
    `<div class="settings-page">` +
    `<header class="settings-topbar">${back}${title}</header>` +
    `<div class="settings-body-row">` +
    // One section, because one section exists. The mock drew Board /
    // Notifications / Sharing beside it; they are not built, and a link to a
    // page that 404s is worse than a nav that is honestly short.
    `<nav class="settings-subnav" aria-label="Settings sections">` +
    `<a href="${listHref(route)}" aria-current="page">Prompts</a>` +
    '</nav>' +
    `<div class="settings-main"><div class="settings-main-inner" id="settings-main"></div></div>` +
    '</div></div></div>' +
    `<div class="settings-toast" id="settings-toast" role="status" aria-live="polite" hidden></div>`
  );
}

/** One row. The whole row is the target — a name and a purpose are not two
 *  places to aim at. */
function listRow(route: PromptsRoute, row: PromptRow): string {
  // EVERY row goes to the same place. Two of the seven keep their words on
  // the board rather than on the server, and one of them also has a field in
  // the board's own settings panel — but a row that looks like its siblings
  // and lands somewhere else is the wrong-target surprise, so which request
  // carries the words is `prompts-api.ts`'s business and not the row's.
  return (
    `<a class="prompt-row" href="${promptHref(route, row.id)}" data-prompt-id="${escapeHtml(row.id)}">` +
    `<span class="prompt-text">` +
    `<span class="prompt-name">${escapeHtml(row.name)}</span>` +
    `<span class="prompt-purpose">${escapeHtml(row.purpose)}</span>` +
    '</span>' +
    (row.edited ? '<span class="prompt-edited">Edited</span>' : '') +
    icon('chev', 'prompt-chev') +
    '</a>'
  );
}

export interface PromptsPageEnv {
  document: Document;
  /** The address bar. `pathname` and `search` are read; `assign` is how a row
   *  that leaves this page navigates. */
  location: { pathname: string; search: string; assign(url: string): void };
  /** Soft navigation between the list and a prompt. */
  history: { pushState(data: unknown, unused: string, url: string): void };
  api: PromptsApi;
}

export interface PromptsPageHandle {
  /** Re-read the address and paint what it names. Awaited by tests. */
  render(): Promise<void>;
  /** Follow a link inside the page, as a click would. Tests drive it. */
  go(href: string): void;
  /** The route the page last painted. */
  route(): PromptsRoute;
}

export function mountPromptsPage(root: HTMLElement, env: PromptsPageEnv): PromptsPageHandle {
  const { document, location, history, api } = env;
  let route = parsePromptsRoute(location.pathname, location.search);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function toast(message: string): void {
    const el = document.getElementById('settings-toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 4000);
  }

  async function renderList(main: HTMLElement): Promise<void> {
    const rows = await api.list();
    if (!rows) {
      main.innerHTML = '<div class="prompt-list"><p>Could not read the prompts.</p></div>';
      return;
    }
    main.innerHTML = `<div class="prompt-list">${rows.map((r) => listRow(route, r)).join('')}</div>`;
  }

  async function paint(): Promise<void> {
    root.innerHTML = chrome(route);
    const main = document.getElementById('settings-main');
    if (!main) return;
    if (route.promptId) {
      await mountPromptEditor({ host: main, api, id: route.promptId, toast }).refresh();
    } else {
      await renderList(main);
    }
  }

  /**
   * Paint what the ADDRESS names, re-read rather than remembered.
   *
   * That is what makes Back work: `popstate` fires after the browser has
   * already put the previous address in the bar, and a page that painted its
   * own remembered route would answer Back by re-painting where it already
   * was.
   */
  async function render(): Promise<void> {
    route = parsePromptsRoute(location.pathname, location.search);
    await paint();
  }

  /** Soft-navigate within the page; anything else is left to the browser. */
  function go(href: string): void {
    history.pushState(null, '', href);
    const url = new URL(href, 'http://x');
    route = parsePromptsRoute(url.pathname, url.search);
    void paint();
  }

  root.addEventListener('click', (ev) => {
    const target = ev.target as Element | null;
    const link = target?.closest?.('a');
    if (!link) return;
    const href = link.getAttribute('href') ?? '';
    // A row that leaves this page (the board, the criteria field) is a plain
    // link and the browser takes it.
    if (!href.startsWith('/settings/prompts')) return;
    ev.preventDefault();
    go(href);
  });

  return { render, go, route: () => route };
}
