/**
 * Where the keep-moving classification USED to live.
 *
 * It moved into `packages/server/src/keep-moving.ts` when the server grew a
 * loop that finds stalled rows itself (`stall-nudge.ts`). Both readers now ask
 * the same function what "stalled" means, which is the whole point of the
 * move: a copy in the server would have started answering differently from the
 * report the moment either was tuned, and the report is the instrument this
 * project uses to decide whether the wake is working.
 *
 * This file stays as a re-export because the CLI and its test suite import
 * from it by path, and a rename that also rewrote those was two changes
 * arriving as one.
 */
export * from '../packages/server/src/keep-moving.ts';
