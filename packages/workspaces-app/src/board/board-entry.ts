/**
 * The board's entry point: the page's `main`, and nothing else.
 *
 * `board-app.ts` holds the boot sequence as `bootBoard(env)`; this file is the one
 * place that calls it with the real browser. They are separate files so the
 * board's boot can be IMPORTED by a test — a module that boots at its top level
 * cannot be, because importing it would build the shell, open the board room
 * and start polling against whatever document the runner happens to have. See
 * `board-boot.test.ts`.
 *
 * Nothing may be added below. A step that belongs to the boot belongs in
 * `bootBoard`, where it can be tested.
 *
 * This is also the ONE file under `src/board/` allowed to name the ambient
 * `location`. `biome.json` denies that global everywhere else in the directory
 * and exempts this file by name, so a module inside the boot cannot navigate
 * past the injection the way `startHuddle` used to: in a browser the ambient
 * object and the injected one are the same, so the board worked and only the
 * test could not see where the press had sent the reader. If lint stops you on
 * a `location` here, take it from your deps object — every region already
 * threads one. The rule reads bare identifiers only, so `window.location` and
 * `globalThis.location` are spellings it cannot see; neither appears under
 * `src/board/` today, and both would be the same bug.
 */
import { connect } from '@feedback/core';
import { browserStorage } from '../boot-env.ts';
import { bootBoard } from './board-app.ts';

void bootBoard({ document, location, history, localStorage: browserStorage, window, connect });
