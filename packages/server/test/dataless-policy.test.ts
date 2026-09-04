/**
 * The boot-time I/O policy that lets this process download an online-only
 * cloud file.
 *
 * The assertion that matters is the one the kernel answers: after the call,
 * `getiopolicy_np` reports ON. Asserting our own return value would only
 * prove the function ran — `setiopolicy_np` can return zero and change
 * nothing, which is precisely the case a read-back catches.
 *
 * The policy is per-process and inherited, so setting it here sets it for the
 * whole test run. That is harmless: it changes what an evicted cloud file
 * does on open, and the suite reads none.
 */
import { describe, expect, it } from 'bun:test';
import {
  datalessMaterializationPolicy,
  enableDatalessMaterialization,
} from '../src/dataless-policy.ts';

const IOPOL_MATERIALIZE_DATALESS_FILES_ON = 2;
const darwin = process.platform === 'darwin';

describe('the dataless-materialize policy', () => {
  it.skipIf(!darwin)('turns materialization on for this process, and says so', async () => {
    const result = await enableDatalessMaterialization();
    expect(result).toMatchObject({ applied: true });
    expect(result.applied && result.after).toBe(IOPOL_MATERIALIZE_DATALESS_FILES_ON);

    // Read back through the other door, so the answer does not come from the
    // same call that set it.
    expect(await datalessMaterializationPolicy()).toBe(IOPOL_MATERIALIZE_DATALESS_FILES_ON);
  });

  it.skipIf(!darwin)('is idempotent, so a second boot path cannot undo it', async () => {
    await enableDatalessMaterialization();
    const again = await enableDatalessMaterialization();
    expect(again).toMatchObject({ applied: true, before: IOPOL_MATERIALIZE_DATALESS_FILES_ON });
    expect(await datalessMaterializationPolicy()).toBe(IOPOL_MATERIALIZE_DATALESS_FILES_ON);
  });

  it.skipIf(darwin)('does nothing at all off darwin', async () => {
    // No such policy exists, and reaching for libSystem would throw. Skipping
    // has to be silent: this runs on CI, which is Linux.
    expect(await enableDatalessMaterialization()).toEqual({
      applied: false,
      reason: 'not-darwin',
    });
    expect(await datalessMaterializationPolicy()).toBeUndefined();
  });
});
