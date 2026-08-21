import * as composerChunk from './packages/markdown-app/src/md-composer-chunk.ts';
import { setComposerEditorLoader } from './packages/markdown-app/src/md-composer.ts';

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
