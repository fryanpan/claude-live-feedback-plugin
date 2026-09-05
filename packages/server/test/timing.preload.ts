/**
 * Loaded by every `bun test` run (bunfig.toml [test].preload), BEFORE any test
 * file imports the server, which is the only moment this can be set: the room
 * cadences are resolved once at `doc-store-timings.ts` module load.
 *
 * Why it lives in the preload rather than in `bun run test:server`: the
 * documented gate is `bun test packages/server/test`, run directly. An
 * override that only existed in an npm script would leave the command in
 * CLAUDE.md running the slow suite, which is the version people actually type.
 *
 * The scale is uniform, so every ratio between the cadences is preserved —
 * the `.ydoc` still persists before the `.md` write-back, which is what makes
 * "a crash inside the flush window" a state the tests can still build.
 */
if (!process.env.CW_TEST_TIMING_SCALE) process.env.CW_TEST_TIMING_SCALE = '0.1';
