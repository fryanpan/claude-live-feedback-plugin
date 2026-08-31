import {
  isDeleted,
  listStoredTranscripts,
  sweepStoredTranscripts,
} from '../packages/server/src/assemblyai-retention.ts';
/**
 * Delete every transcript AssemblyAI is still holding content for.
 *
 *   bun run scripts/assemblyai-retention-sweep.ts          # report only
 *   bun run scripts/assemblyai-retention-sweep.ts --delete # actually delete
 *
 * WHY THIS IS A SCRIPT AND NOT A BACKGROUND JOB. The meeting assistant
 * transcribes over Universal Streaming, which stores nothing on the vendor's
 * side when the account is opted out of model training — so there is no
 * pipeline here that creates async transcripts and therefore nothing for a
 * per-meeting cleanup step to clean up. Wiring a network call into the
 * meeting teardown to delete rows that are never created would be cost and
 * risk for no coverage. What is worth having is a way to CHECK, and a
 * deletion path that already works the day someone does add async
 * transcription. Same category as `scripts/diarize-check.ts`: needs a key,
 * touches the vendor, deliberately not part of any suite.
 *
 * DELETION IS IRREVERSIBLE ON THE VENDOR'S SIDE — the words do not come
 * back — which is why `--delete` is opt-in and the default run only reports.
 * It removes the vendor's copy, never ours: our durable record is the
 * append-only JSONL under `<dataDir>/meetings/` and this script does not
 * touch it.
 *
 * Key resolution is the server's own order — `ASSEMBLYAI_API_KEY`, then the
 * `assemblyai-api-key` Keychain entry. The key is never printed. On this
 * machine there is no Keychain entry: the key lives in a gitignored `.env`
 * in the primary checkout, which Bun loads from the CURRENT WORKING
 * DIRECTORY. So run this with the primary checkout as cwd
 * (`bun run .claude/worktrees/<tree>/scripts/assemblyai-retention-sweep.ts`)
 * or the key resolves to nothing and the script correctly refuses.
 */
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import {
  KEYCHAIN_SERVICE,
  resolveAssemblyAiKey,
} from '../packages/server/src/transcribe-assemblyai.ts';

const apply = process.argv.includes('--delete');

const key = resolveAssemblyAiKey(undefined, process.env, (service) => {
  try {
    return readKeychainPassword(service);
  } catch {
    return null;
  }
});

if (!key) {
  console.error(
    'No AssemblyAI key. Set ASSEMBLYAI_API_KEY, or add the Keychain entry:\n' +
      `  security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
  );
  process.exit(1);
}

if (!apply) {
  const rows = await listStoredTranscripts(key, fetch);
  const live = rows.filter((r) => !isDeleted(r));
  console.log(`transcripts the account can see: ${rows.length}`);
  console.log(`still holding content:           ${live.length}`);
  for (const row of live) console.log(`  ${row.id}  ${row.status}  created ${row.created ?? '?'}`);
  console.log(
    live.length === 0
      ? '\nNothing to delete.'
      : '\nRe-run with --delete to remove the vendor’s copy of these.',
  );
  process.exit(0);
}

const counts = await sweepStoredTranscripts(key, fetch, (line) => console.error(line));
console.log(
  `found ${counts.found}, already deleted ${counts.alreadyDeleted}, ` +
    `deleted now ${counts.deleted}, not confirmed ${counts.failed}`,
);
process.exit(counts.failed > 0 ? 1 : 0);
