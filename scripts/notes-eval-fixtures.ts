#!/usr/bin/env bun
/**
 * Turn real meetings into scripted ticks the note-taker can be run against.
 *
 * WHY REAL MEETINGS. Every fixture elsewhere in this repo is invented, and
 * invented speech is the one thing a note-taking eval cannot use: a
 * transcript somebody wrote to be summarised is already half a summary. It
 * has no false starts, nobody talks over anybody, nothing is said twice, and
 * a model scores well on it while failing on the meeting it was built for.
 * So the corpus is AMI — a hundred hours of recorded working meetings,
 * released under CC BY 4.0, already used by `room-labels-check.ts` for the
 * same reason. Its speakers are LETTERS, so nothing here names a person.
 *
 * WHY THE FIXTURES ARE COMMITTED. The corpus is a 23 MB download and the
 * annotations are somebody else's data; CI cannot fetch them and should not
 * try. The excerpts this writes are small, attributed, and checked in, so
 * `bun run notes:eval` runs from a fresh clone with nothing but an API key.
 *
 *   bun run scripts/notes-eval-fixtures.ts            # rebuild every fixture
 *   bun run scripts/notes-eval-fixtures.ts ES2002a    # just one meeting
 *
 * The annotations must be in the cache first (once, CC BY 4.0):
 *   curl -o ~/Library/Caches/claude-workspaces/ami/ami_public_manual_1.6.2.zip \
 *     https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip
 *
 * THE TICKS ARE CUT THE WAY THE SERVER CUTS THEM. Utterances are grouped by
 * the same two clocks the live pipeline runs on — a pause of
 * `DEFAULT_NOTES_QUIET_MS`, and a ceiling of `DEFAULT_NOTES_CADENCE_MS` that
 * speech does not reset — so a fixture tick holds what a real tick would have
 * held. Cutting on a round number of sentences instead would hand the model
 * tidier units than it ever gets.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_NOTES_CADENCE_MS,
  DEFAULT_NOTES_QUIET_MS,
} from '../packages/server/src/meeting-notes.ts';
import { type AmiUtterance, amiUtterances, parseAmiWords } from './ami-truth.ts';
import { amiWordFiles } from './room-labels-check.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = join(
  REPO_ROOT,
  'packages',
  'server',
  'test',
  'fixtures',
  'ami-notes-eval',
);

/**
 * The meetings, and where in each to cut.
 *
 * Eight, two projects of four: ES2002 and ES2003 are separate teams running
 * the SAME design brief, which is what makes one board fit both — and what
 * makes the sample two rooms rather than one. All are from the AMI scenario
 * set: the same four people designing a
 * remote control across a series of meetings, which is as close to this
 * product's own case — a small team working a problem over weeks — as a
 * public corpus gets. The offsets skip the openings, where somebody is
 * explaining the recording equipment and one voice reads instructions: an
 * excerpt there measures nothing about note-taking while looking like a
 * result.
 *
 * THE TWO KICKOFF MEETINGS START MUCH LATER THAN THE REST. ES2002a and
 * ES2003a open with the AMI icebreaker — each person draws their favourite
 * animal on the whiteboard and talks about it for several minutes. A
 * note-taker that writes nothing there is behaving CORRECTLY, which is real
 * behaviour and useless to measure: run from 300s, those two meetings
 * produced ticks that were all correct silence, and the eval reported almost
 * no examples of anything. 900s is past the drawing and into the brief.
 */
const MEETINGS: ReadonlyArray<{ meeting: string; fromSeconds: number; seconds: number }> = [
  { meeting: 'ES2002a', fromSeconds: 900, seconds: 900 },
  { meeting: 'ES2002b', fromSeconds: 420, seconds: 900 },
  { meeting: 'ES2002c', fromSeconds: 420, seconds: 900 },
  { meeting: 'ES2002d', fromSeconds: 300, seconds: 900 },
  { meeting: 'ES2003a', fromSeconds: 900, seconds: 900 },
  { meeting: 'ES2003b', fromSeconds: 420, seconds: 900 },
  { meeting: 'ES2003c', fromSeconds: 420, seconds: 900 },
  { meeting: 'ES2003d', fromSeconds: 300, seconds: 900 },
];

/** One turn as the fixture stores it: a letter and what was said. */
export interface FixtureTurn {
  speaker: string;
  text: string;
}

/** One tick: what a pause or the cadence ceiling would have handed a compose. */
export interface FixtureTick {
  turns: FixtureTurn[];
}

export interface NotesEvalFixture {
  meeting: string;
  corpus: string;
  licence: string;
  source: string;
  window: { fromSeconds: number; seconds: number };
  /**
   * A board for this meeting, built from phrases the meeting itself uses.
   *
   * Reference hygiene cannot be measured against an invented board: a title
   * nobody says is never linked, and the check passes vacuously. So the rows
   * are the meeting's own recurring phrases, which means a tick that names
   * one really did name it — and a note-taker that fails to link it really
   * did fail.
   */
  board: Array<{ kind: 'task'; title: string; url: string }>;
  ticks: FixtureTick[];
}

/**
 * Utterances grouped into ticks by the live pipeline's own two clocks.
 *
 * A tick ends when the room falls quiet for the pause threshold, or when the
 * oldest unwritten utterance in it has been waiting for the cadence ceiling —
 * whichever comes first, exactly as `pause-ticker.ts` decides it.
 */
export function ticksOf(
  utterances: readonly AmiUtterance[],
  quietMs: number = DEFAULT_NOTES_QUIET_MS,
  cadenceMs: number = DEFAULT_NOTES_CADENCE_MS,
): FixtureTick[] {
  const ticks: FixtureTick[] = [];
  let turns: FixtureTurn[] = [];
  let openedAt = 0;
  const flush = (): void => {
    if (turns.length > 0) ticks.push({ turns });
    turns = [];
  };
  let previousEnd: number | null = null;
  for (const u of utterances) {
    const text = u.text.trim();
    if (!text) continue;
    if (turns.length === 0) openedAt = u.start;
    else if (previousEnd !== null && (u.start - previousEnd) * 1000 >= quietMs) flush();
    if (turns.length === 0) openedAt = u.start;
    turns.push({ speaker: u.speaker, text });
    previousEnd = u.end;
    if ((u.end - openedAt) * 1000 >= cadenceMs) flush();
  }
  flush();
  return ticks;
}

/**
 * The board these four meetings would have had.
 *
 * Every AMI scenario meeting runs the same brief: four people designing a
 * television remote control across four sessions. The rows below are that
 * brief's actual subjects, written the way a board writes them, and the same
 * board is offered to every meeting — which is how a real board behaves.
 *
 * WHY NOT MINE THEM OUT OF THE TRANSCRIPT. A first version did, ranking
 * recurring phrases, and produced rows called "Point three rid" and
 * "Something which": real speech's commonest word runs are not topics, and a
 * board of nonsense titles measures nothing except the matcher's tolerance
 * for nonsense.
 *
 * WHY THIS IS NOT A THUMB ON THE SCALE. Nothing here decides whether a tick
 * counts as a reference example — `matchReferences` does, from the tick's own
 * words, by the rule the unit tests pin. These rows only make the question
 * askable: without a board, "did it link the row that was named" has no
 * examples and passes vacuously.
 */
export const SCENARIO_BOARD: ReadonlyArray<{ kind: 'task'; title: string; url: string }> = [
  { kind: 'task', title: 'Remote control design', url: '/workspaces/w-eval?task=t-1' },
  { kind: 'task', title: 'Corporate colour scheme', url: '/workspaces/w-eval?task=t-2' },
  { kind: 'task', title: 'Volume buttons', url: '/workspaces/w-eval?task=t-3' },
  { kind: 'task', title: 'Channel buttons', url: '/workspaces/w-eval?task=t-4' },
  { kind: 'task', title: 'Speech recognition', url: '/workspaces/w-eval?task=t-5' },
  { kind: 'task', title: 'Production cost target', url: '/workspaces/w-eval?task=t-6' },
  { kind: 'task', title: 'Target age group', url: '/workspaces/w-eval?task=t-7' },
  { kind: 'task', title: 'LCD screen', url: '/workspaces/w-eval?task=t-8' },
];

function amiCacheDir(): string {
  return join(homedir(), 'Library', 'Caches', 'claude-workspaces', 'ami');
}

function buildOne(spec: (typeof MEETINGS)[number]): NotesEvalFixture {
  const files = amiWordFiles(spec.meeting, amiCacheDir());
  const words = files.flatMap((file) => {
    const speaker = file.split('/').pop()?.split('.')[1] ?? '?';
    return parseAmiWords(readFileSync(file, 'utf8'), speaker);
  });
  const until = spec.fromSeconds + spec.seconds;
  const window = amiUtterances(words).filter((u) => u.start >= spec.fromSeconds && u.end <= until);
  if (window.length === 0) throw new Error(`${spec.meeting}: no speech in the chosen window`);
  return {
    meeting: spec.meeting,
    corpus: 'AMI Meeting Corpus',
    licence: 'CC BY 4.0',
    source: 'https://groups.inf.ed.ac.uk/ami/corpus/',
    window: { fromSeconds: spec.fromSeconds, seconds: spec.seconds },
    board: [...SCENARIO_BOARD],
    ticks: ticksOf(window),
  };
}

if (import.meta.main) {
  const only = process.argv.slice(2);
  const specs = only.length > 0 ? MEETINGS.filter((m) => only.includes(m.meeting)) : MEETINGS;
  if (specs.length === 0) throw new Error(`No such meeting: ${only.join(', ')}`);
  mkdirSync(FIXTURE_DIR, { recursive: true });
  let ticks = 0;
  for (const spec of specs) {
    const fixture = buildOne(spec);
    const path = join(FIXTURE_DIR, `${spec.meeting}.json`);
    writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
    ticks += fixture.ticks.length;
    const turns = fixture.ticks.reduce((n, t) => n + t.turns.length, 0);
    console.log(
      `${spec.meeting}: ${fixture.ticks.length} ticks, ${turns} turns, ` +
        `${fixture.board.length} board rows -> ${path}`,
    );
  }
  console.log(`\n${ticks} ticks total.`);
}
