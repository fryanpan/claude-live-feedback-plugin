/**
 * The `#save-state` chip: "All changes saved", "Unsaved changes",
 * "Reconnecting…".
 *
 * TWO facts drive it and they are deliberately not one. `wsOnline` is the raw
 * socket, updated the instant it changes, and it decides whether an edit may
 * be called saved. `reconnecting` is the graced VIEW, and it decides what the
 * chip says — so a blip never repaints, while nothing is ever reported as
 * saved to a server that isn't there. Keeping both in one module is what
 * stops a second writer appearing and reporting one from the other.
 *
 * The teardown is load-bearing: `#save-state` is shared chrome, so a pending
 * debounce from THIS mount would otherwise rewrite it over the next document
 * — one that may have no save state at all.
 */
import type { FeedbackClient } from '@feedback/core';
import type * as Y from 'yjs';
import { saveStateView, settlePending, watchConnection } from '../connection-state.ts';
import type { MountScope } from '../mount-scope.ts';
import { el } from './chrome-dom.ts';

export interface DocSaveStateOptions {
  client: FeedbackClient;
  ydoc: Y.Doc;
  /** Whether the server accepts writes at all. A locked surface says nothing
   *  rather than claiming a save that cannot happen. */
  canWrite: boolean;
  scope: MountScope;
}

export function mountDocSaveState(opts: DocSaveStateOptions): void {
  const { client, ydoc, canWrite, scope } = opts;

  // ---- Save state indicator ----
  //   dirty   = local change produced but not yet confirmed synced to server
  //   saved   = WS is up AND no pending local updates after a short idle window
  //   offline = WS connection closed or reconnecting
  // The widget's canonical "saved" signal is a server ack of the most
  // recent local update. y-websocket doesn't surface per-update acks,
  // so we use the next best thing: WS status + a short "typing stopped
  // and nothing went out for 500ms" debounce.
  const saveStateEl = el<HTMLElement>('save-state');
  let pendingLocalEdits = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let wsOnline = false;
  let reconnecting = false;
  function renderSaveState(): void {
    saveStateEl.classList.remove('save-state--saved', 'save-state--dirty', 'save-state--offline');
    // Nothing to report about saving on a surface that cannot save. "All
    // changes saved" beside a locked editor is a true sentence describing a
    // thing that is not happening, which is worse than silence.
    if (!canWrite) {
      saveStateEl.textContent = '';
      return;
    }
    switch (saveStateView({ reconnecting, pendingEdits: pendingLocalEdits })) {
      case 'reconnecting':
        // Not "Offline": a restart is the usual cause and it is coming back.
        saveStateEl.textContent = 'Reconnecting…';
        saveStateEl.classList.add('save-state--offline');
        return;
      case 'dirty':
        saveStateEl.textContent = 'Unsaved changes';
        saveStateEl.classList.add('save-state--dirty');
        return;
      default:
        saveStateEl.textContent = 'All changes saved';
        saveStateEl.classList.add('save-state--saved');
    }
  }
  // ydoc.on('update') is released when the client destroys the ydoc on close.
  ydoc.on('update', (_update, origin) => {
    // Remote updates come from the server with origin === client.ws.
    // Everything else — typing, formatting, agent edits merged in — counts as
    // a local change the server hasn't ack'd yet.
    if (origin === client.ws) return;
    pendingLocalEdits++;
    renderSaveState();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // "Typing stopped" only means "saved" if there was a server listening.
      pendingLocalEdits = settlePending(pendingLocalEdits, wsOnline);
      renderSaveState();
    }, 500);
  });
  // Raw status: the truth half. Nothing visible hangs off it directly, so it
  // can flip as often as the backoff does without any flicker.
  client.onStatus((s) => {
    if (scope.disposed) return;
    const was = wsOnline;
    wsOnline = s === 'open';
    // Coming back is what the debounce was waiting for. Edits it refused to
    // settle while offline settle now, without needing another keystroke.
    if (wsOnline && !was && pendingLocalEdits > 0) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        pendingLocalEdits = settlePending(pendingLocalEdits, wsOnline);
        renderSaveState();
      }, 500);
    }
    renderSaveState();
  });
  // One reading of the connection, shared with the board: a drop is only
  // worth SHOWING once it has outlasted the grace window, and it clears the
  // moment the socket returns — no reload. The disposed guard matters because
  // the grace timer can outlive the mount that armed it.
  watchConnection({
    onStatus: (cb) => client.onStatus(cb),
    onView: (view) => {
      if (scope.disposed) return;
      reconnecting = view === 'reconnecting';
      renderSaveState();
    },
  });
  renderSaveState();
  // On navigation, cancel the pending save-state debounce and blank the shared
  // #save-state indicator — otherwise a stale timer rewrites it with THIS
  // mount's closed-over wsOnline/pendingLocalEdits over the next document
  // (findings #3, #9), and code/diff surfaces have no save state to show.
  scope.onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer);
    saveStateEl.classList.remove('save-state--saved', 'save-state--dirty', 'save-state--offline');
    saveStateEl.textContent = '';
  });
}
