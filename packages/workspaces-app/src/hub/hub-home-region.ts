/**
 * The Home pane: the "What's New?" brief, the review queue and the recent
 * activity feed, plus the three REST calls that feed them.
 *
 * One responsibility, and the seam is the payload rather than the widgets: all
 * four things here are functions of ONE `HomePayload` and the queue derived
 * from the live projection. `loadHome` is the only thing that fetches it,
 * `markCaughtUp` and `saveInstructions` are the two writes that invalidate it
 * (both end by re-loading), and `renderHomeRegion` is the only reader. Split
 * across `bootHub` that was invisible — the poll that waits for a generated
 * brief sat sixty lines from the render whose emptiness it exists to fill.
 *
 * The generating-brief poll is the invariant worth reading twice. It re-runs
 * `loadHome` every 1.5s while the SERVER says a generation is queued, capped
 * by `shouldPollHome`, and each pass repaints through the guard rather than
 * directly: Home is the surface whose option buttons a mid-press repaint was
 * measured eating (see `createRepaintGuard`).
 *
 * `HubHomeDeps` is the whole list of what this pane may reach. `send`,
 * `fetchJson` and `showToast` are not on it: they are the module-level
 * primitives every board write ends in, as `hub-actions.ts` exports them.
 */
import type { User } from '@feedback/core';
import { asksOf } from './activity-model.ts';
import { homeActivityData } from './home-activity-island.tsx';
import { homeReviewData } from './home-review-island.tsx';
import { type HubState, fetchJson, send, showToast } from './hub-actions.ts';
import type { HubTask } from './hub-board-model.ts';
import { type HomePayload, shouldPollHome } from './hub-presence-model.ts';
import { renderHomeBrief } from './hub-render.ts';
import type { ReviewQueue } from './hub-review-model.ts';

/** Everything the Home pane needs from `bootHub`, and nothing else. */
export interface HubHomeDeps {
  /** The board's one projection. Home reads `pane`, `home`, `homeEditingRecipe`,
   *  `homeSettled` and `homePollStarted`, and writes the last three. LIVE. */
  state: HubState;
  /** The board this pane is Home for. */
  workspaceId: string;
  /** Who a write is attributed to. */
  author: Pick<User, 'id' | 'name' | 'kind' | 'color'>;
  /** Whose Home this is — the brief is keyed on the reader's display name. */
  user: Pick<User, 'name'>;
  /** The page's document, for the nav-item active states. */
  document: Document;
  /** `getElementById`, already narrowed — `bootHub`'s own `el`. */
  el(id: string): HTMLElement;
  /** The review queue as it stands right now, re-derived per render. */
  currentQueue(): ReviewQueue;
  /** The projection's rows, for the activity pane's grouping. */
  taskList(): HubTask[];
  /** Repaint behind the reader's finger — `repaintGuard.schedule`. A thunk
   *  because the guard is built after this region, and because the reference
   *  it is handed must stay stable for the guard to coalesce. */
  schedule(paint: () => void): void;
}

/** What `bootHub` keeps. The two writes that invalidate the brief —
 *  "Caught up" and the recipe box — stay inside: nothing outside Home calls
 *  them, and the render already carries them to the pane as handlers. */
export interface HubHomeRegion {
  renderHomeRegion(): void;
  loadHome(): Promise<void>;
}

export function createHubHomeRegion(deps: HubHomeDeps): HubHomeRegion {
  const { state, workspaceId, author, user, document, el, currentQueue, taskList, schedule } = deps;

  function renderHomeRegion(): void {
    // Nav active state, all four destinations.
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.hub-nav-item')) {
      const active = btn.dataset.nav === state.nav;
      btn.classList.toggle('hub-nav-item-active', active);
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    }
    const main = el('hub-main');
    // Home is a clean frame: content only, none of the board's side columns.
    // The pane-scoped `hub-root--home` class went with the board chrome it
    // used to suppress — presence, lead and the goal banner live in the
    // settings panel now, which is not a pane's to hide.
    main.classList.toggle('hub-main--home', state.pane === 'home');
    el('hub-home').classList.toggle('hidden', state.pane !== 'home');
    if (state.pane !== 'home') return;
    renderHomeBrief(el('hub-home-brief'), state.home, Date.now(), state.homeEditingRecipe, {
      onMarkCaughtUp: () => void markCaughtUp(),
      onSaveInstructions: (text) => void saveInstructions(text),
      onEditRecipe: (open) => {
        state.homeEditingRecipe = open;
        renderHomeRegion();
      },
    });
    // The island's one input. A plain signal write, not a render call: the
    // pane re-renders itself, keyed on `ReviewItem.key`, so unchanged rows
    // keep their DOM nodes. Background events still reach this line through
    // `repaintGuard.schedule(...)` exactly as they reached the old renderer —
    // the guard's parked/flush path is upstream of the write, not bypassed.
    const queue = currentQueue();
    const now = Date.now();
    homeReviewData.value = {
      queue,
      settled: [...state.homeSettled.values()],
      now,
    };
    // The activity pane's one input: the projection as it stands, plus what
    // the queue above is already asking so the pane never says it twice. The
    // island groups and flags; this line only hands over the facts.
    homeActivityData.value = {
      tasks: taskList(),
      goals: state.info?.goals ?? [],
      asks: asksOf(queue.items),
      now,
    };
  }

  let homePollTimer: ReturnType<typeof setTimeout> | null = null;
  async function loadHome(): Promise<void> {
    const res = await fetchJson<HomePayload>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/home?user=${encodeURIComponent(user.name)}`,
    );
    // A failed fetch keeps the previous payload — same rule as every other
    // REST-fed region: "the request did not complete" is not "there is
    // nothing here".
    if (res) state.home = res;
    // Through the guard: the generating-brief poll below re-runs this every
    // 1.5s, and Home is exactly the surface whose option buttons a mid-press
    // repaint was eating.
    schedule(renderHomeRegion);
    // Poll while the server says a generation is actually queued, so the
    // generated brief lands without a manual reload. The flag is grounded in
    // a queued call; the cap stops a wedged payload from polling forever.
    if (homePollTimer) {
      clearTimeout(homePollTimer);
      homePollTimer = null;
    }
    if (res?.generating) {
      if (state.homePollStarted === 0) state.homePollStarted = Date.now();
      if (shouldPollHome(res, state.homePollStarted, Date.now())) {
        homePollTimer = setTimeout(() => void loadHome(), 1500);
      }
    } else {
      state.homePollStarted = 0;
    }
  }

  async function markCaughtUp(): Promise<void> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/home/read`, 'POST', {
      author,
    });
    if (!res.ok) {
      showToast('Could not mark caught up — try again.');
      return;
    }
    showToast('Caught up — the brief starts here now.');
    await loadHome();
  }

  async function saveInstructions(text: string): Promise<void> {
    const res = await send(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/home/instructions`,
      'PUT',
      { instructions: text, author },
    );
    if (!res.ok) {
      showToast('Could not save the instructions — try again.');
      return;
    }
    state.homeEditingRecipe = false;
    if (res.data) state.home = res.data as unknown as HomePayload;
    renderHomeRegion();
    // The save dropped every cached brief; pick up the regeneration.
    state.homePollStarted = 0;
    await loadHome();
  }

  return { renderHomeRegion, loadHome };
}
