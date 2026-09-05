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
 */
import { connect } from '@feedback/core';
import { browserStorage } from '../boot-env.ts';
import { bootBoard } from './board-app.ts';

void bootBoard({ document, location, history, localStorage: browserStorage, window, connect });
