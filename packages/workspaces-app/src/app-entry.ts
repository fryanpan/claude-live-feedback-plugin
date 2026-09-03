/**
 * The document editor's entry point: the page's `main`, and nothing else.
 *
 * `app.ts` holds the boot sequence as `bootApp(env)`; this file is the one
 * place that calls it with the real browser. They are separate files for one
 * reason: a module that boots the app at its top level cannot be IMPORTED by a
 * test — importing it would connect a socket, wire the shell and start the
 * router against whatever document the runner happens to have. Keeping the
 * call here is what lets `app-boot.test.ts` drive the real sequence.
 *
 * Nothing may be added below. A step that belongs to the boot belongs in
 * `bootApp`, where it can be tested.
 */
import { connect } from '@feedback/core';
import { bootApp } from './app.ts';
import { browserStorage } from './boot-env.ts';

void bootApp({ document, location, localStorage: browserStorage, window, connect });
