/**
 * The vanilla `renderBoard(container, sections, handlers)` call shape, over
 * the Preact board island.
 *
 * The board's state reaches the island through the `boardData` signal and its
 * stable callbacks through `mountBoardIsland` — a one-directional bridge the
 * app drives, not a render call. That is the right shape for the app and the
 * wrong shape for the several suites that only want a board on screen to
 * assert against, so this puts the old call back: write the signal, mount, and
 * on a repeat call against the same container remount (which is exactly what
 * the renderer this replaces did on every call).
 *
 * Cases that are ABOUT a repaint — node identity, focus, a rename or a
 * half-typed goal surviving one — must drive `boardData` directly instead. A
 * remount rebuilds everything, which is the property they exist to disprove.
 */
import { type BoardHandlers, boardData, mountBoardIsland } from '../../src/hub/board-island.tsx';
import type { BoardSection, HubTask } from '../../src/hub/hub-board-model.ts';
import type { HubPane } from '../../src/hub/hub-presence-model.ts';

/** The two per-paint values that used to ride inside the handlers object and
 *  now ride the signal. Accepted here so ported cases read as they did. */
export type ShimHandlers = BoardHandlers & {
  knownAgentIds?: string[];
  archivedCount?: number;
  /** Every projected row, by id — what a live instance's recurrence mark and
   *  an after-completion cursor resolve through. Defaults to the rows in the
   *  sections passed, which is right for every case that does not deliberately
   *  filter one out. */
  tasksById?: ReadonlyMap<string, HubTask>;
};

const islands = new Map<HTMLElement, () => void>();

export function renderBoard(
  container: HTMLElement,
  sections: BoardSection[],
  handlers: ShimHandlers,
  pane: HubPane = 'board',
): void {
  boardData.value = {
    sections,
    pane,
    showArchived: false,
    knownAgentIds: handlers.knownAgentIds ?? [],
    tasksById:
      handlers.tasksById ?? new Map(sections.flatMap((s) => s.tasks).map((t) => [t.id, t])),
    archivedCount: handlers.archivedCount ?? 0,
  };
  islands.get(container)?.();
  islands.set(container, mountBoardIsland(container, handlers));
}

/** Tear every mounted island down and put the signal back to empty. An island
 *  left alive keeps a subscription to the module-level signal, so the next
 *  file's first write would repaint a board into a detached node. */
export function disposeBoards(): void {
  for (const dispose of islands.values()) dispose();
  islands.clear();
  boardData.value = {
    sections: [],
    pane: 'board',
    showArchived: false,
    knownAgentIds: [],
    tasksById: new Map(),
    archivedCount: 0,
  };
}
