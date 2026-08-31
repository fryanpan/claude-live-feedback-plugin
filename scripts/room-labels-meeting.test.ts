import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeetingStore } from '../packages/server/src/meetings.ts';

/**
 * The path Bryan actually uses — score a meeting that already happened —
 * driven end to end through the real command.
 *
 * It is the path with the most ways to silently report nothing: a data dir
 * that is not the one the meeting was recorded into, a doc id that never had
 * a meeting, a transcript with no labels in it. Every one of those has to say
 * so rather than printing a clean zero, which is what the run's exit code and
 * the words below are for.
 *
 * Fictional names, throwaway data dir.
 */

const SCRIPT = join(dirname(new URL(import.meta.url).pathname), 'room-labels-check.ts');

let dataDir: string;
let truthFile: string;

/** A recorded meeting, written through the store the server writes through. */
function record(docId: string, turns: Array<[string, string | undefined]>): string {
  const store = new MeetingStore(dataDir);
  const meeting = store.start({ docId, engine: 'test', sampleRate: 16_000, mode: 'conversation' });
  if (!meeting) throw new Error('the store refused to start a meeting');
  turns.forEach(([text, speaker], i) => meeting.recordTurn(i, text, speaker));
  meeting.stop();
  return meeting.meetingId;
}

const LINES: Array<[string, string]> = [
  ['The import is holding everything up, and I think it is the sync step.', 'Rowan'],
  ['I am not sure it is the sync step at all. Can we measure it first?', 'Devi'],
  ['We can measure it, but I would rather not spend another week on this.', 'Rowan'],
];

function runCheck(args: string[]): { code: number; out: string } {
  const proc = spawnSync('bun', ['run', SCRIPT, ...args], { encoding: 'utf8' });
  return { code: proc.status ?? -1, out: `${proc.stdout ?? ''}${proc.stderr ?? ''}` };
}

describe('scoring a recorded meeting', () => {
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'room-labels-data-'));
    truthFile = join(dataDir, 'script.txt');
    writeFileSync(truthFile, `${LINES.map(([text, who]) => `${who}: ${text}`).join('\n')}\n`);
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it('reads the record and scores a clean two-voice meeting', () => {
    record(
      'room-clean',
      LINES.map(([text, who]) => [text, who === 'Rowan' ? 'A' : 'B']),
    );
    const { code, out } = runCheck([
      '--doc',
      'room-clean',
      '--truth',
      truthFile,
      '--data-dir',
      dataDir,
      '--setting',
      'ec1-ns0-agc0',
    ]);
    expect(code).toBe(0);
    expect(out).toContain('2 labelled vs 2 in the room');
    expect(out).toContain('turn attribution: 100.0%');
    // The setting is the whole reason for running this twice; it has to be on
    // the report or two runs are indistinguishable afterwards.
    expect(out).toContain('ec1-ns0-agc0');
    expect(out).toContain('SCORING:');
  });

  it('fails and names the invention when a third voice appears', () => {
    record('room-invented', [
      [LINES[0]?.[0] ?? '', 'A'],
      [LINES[1]?.[0] ?? '', 'B'],
      [LINES[2]?.[0] ?? '', 'C'],
    ]);
    const { code, out } = runCheck([
      '--doc',
      'room-invented',
      '--truth',
      truthFile,
      '--data-dir',
      dataDir,
    ]);
    expect(out).toContain('INVENTED');
    // A non-zero exit, so this can gate something later without anyone having
    // to read the words.
    expect(code).toBe(1);
  });

  it('says the data dir it looked in rather than reporting an empty room', () => {
    const { code, out } = runCheck([
      '--doc',
      'never-recorded',
      '--truth',
      truthFile,
      '--data-dir',
      dataDir,
    ]);
    expect(code).toBe(1);
    expect(out).toContain('No meetings for never-recorded');
    expect(out).toContain(dataDir);
  });
});
