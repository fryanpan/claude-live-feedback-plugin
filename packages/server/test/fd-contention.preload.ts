/**
 * Loaded by every `bun test` run (bunfig.toml [test].preload): after each
 * test, two probes — can the process still open a file descriptor, and can
 * the machine still allocate a socket? When either says no, the test is
 * failed with a message naming the exhaustion, because at that point every
 * other failure in the run is fallout. See fd-contention.ts for the why,
 * including the morning the socket half of this was missing.
 */
import { afterEach } from 'bun:test';
import { fdContentionError, socketContentionError } from './fd-contention.ts';

afterEach(() => {
  // Descriptors first: a process with no descriptors left cannot open a
  // socket either, and the per-process cause is the more actionable of the
  // two — it is usually this run's own leak.
  const fdErr = fdContentionError();
  if (fdErr) throw fdErr;
  const socketErr = socketContentionError();
  if (socketErr) throw socketErr;
});
