#!/usr/bin/env bun
/**
 * `bun run meeting:replay <meeting folder | audio file> --engine <name>`
 *
 * Re-transcribe a meeting's retained audio through a chosen engine and write
 * `<docname>-raw-transcript-replay-<timestamp>.md` beside the original — the
 * one way to ask "would a different engine, or the same one today, have
 * heard that sentence differently?" without recording the meeting again.
 * Everything that matters is in `replay-meeting-lib.ts`, tested with the
 * mock engine; this file is the argv and the engine choice.
 *
 * A live engine (`soniox`, `assemblyai`, `assemblyai-pro`) reads its key the
 * way the server does — env, then Keychain — and BILLS for the audio's
 * length. `mock` is free and deterministic.
 */

import {
  createAssemblyAiEngine,
  createAssemblyAiProEngine,
} from '../packages/server/src/transcribe-assemblyai.ts';
import { createSonioxEngine } from '../packages/server/src/transcribe-soniox.ts';
import {
  type TranscriptionEngine,
  createMockTranscriptionEngine,
} from '../packages/server/src/transcribe.ts';
import {
  USAGE,
  UsageError,
  parseArgs,
  resolveReplayTarget,
  runReplay,
} from './replay-meeting-lib.ts';

function engineByName(name: string): TranscriptionEngine {
  let engine: TranscriptionEngine | null;
  switch (name) {
    case 'mock':
      engine = createMockTranscriptionEngine();
      break;
    case 'soniox':
      engine = createSonioxEngine();
      break;
    case 'assemblyai':
      engine = createAssemblyAiEngine();
      break;
    case 'assemblyai-pro':
      engine = createAssemblyAiProEngine();
      break;
    default:
      throw new UsageError(
        `unknown engine ${name}; one of mock, soniox, assemblyai, assemblyai-pro`,
      );
  }
  if (!engine) throw new UsageError(`the ${name} engine has no key on this machine`);
  return engine;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const target = resolveReplayTarget(args.target, args.segment);
  const engine = engineByName(args.engine);
  const result = await runReplay({
    target,
    engine,
    chunkMs: args.chunkMs,
    realtime: args.realtime,
    ...(args.mode ? { mode: args.mode } : {}),
    log: (line) => console.error(line),
  });
  console.log(result.outPath);
  console.error(`${result.segments} segment(s), ${result.turns} turn(s) → ${result.outPath}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UsageError) {
      console.error(err.message === USAGE ? USAGE : `${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
