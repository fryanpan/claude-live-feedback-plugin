/**
 * Loaded by every `bun test` run (bunfig.toml [test].preload): after each
 * test, one probe — can the process still open a file descriptor? When it
 * cannot, the test is failed with a message naming descriptor contention,
 * because at that point every other failure in the run is fallout. See
 * fd-contention.ts for the why.
 */
import { afterEach } from 'bun:test';
import { fdContentionError } from './fd-contention.ts';

afterEach(() => {
  const err = fdContentionError();
  if (err) throw err;
});
