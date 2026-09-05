import { afterAll } from 'vitest';
import * as composerChunk from './packages/workspaces-app/src/md-composer-chunk.ts';
import {
  destroyLiveComposers,
  setComposerEditorLoader,
} from './packages/workspaces-app/src/md-composer.ts';

/**
 * Composers reach their markdown editor through a dynamic `import()` — the
 * chunk is the whole Tiptap stack, and the board's bundle must not carry it.
 * A promise is the wrong shape for a test, though: a form built in one line
 * and asserted on the next would be asserted on before its editor existed,
 * and every test that touches a composer would have to know that.
 *
 * So the suite hands the composer the REAL module, synchronously. Not a
 * stand-in: a stand-in is a second implementation to keep honest, and these
 * tests are about what a person types into the box.
 */
setComposerEditorLoader(() => composerChunk);

/**
 * End every composer a file left running, before vitest takes the environment
 * away.
 *
 * A composer is a ProseMirror view, and a live view keeps a `DOMObserver` that
 * arms a 20ms flush on any mutation and cancels it on none. When that flush
 * lands after teardown it reads `document` and fails the whole run with an
 * unhandled `ReferenceError`, blamed on whichever file the worker happened to
 * be running — which is why the symptom kept naming files that mount nothing.
 * Destroying the view is what makes the pending timer harmless: `flush` returns
 * at once once `docView` is null.
 *
 * Files that own a composer should still end it themselves, per test. This is
 * the floor under the ones that don't: 441 of the 451 views the suite leaked
 * when this was written were composers, spread over thirty-odd files.
 */
afterAll(() => {
  destroyLiveComposers();
});
