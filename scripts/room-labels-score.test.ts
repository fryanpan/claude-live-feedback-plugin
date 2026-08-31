import { describe, expect, it } from 'vitest';
import { SYNTHETIC_SCRIPT, parseArgs, parseTruth } from './room-labels-check.ts';
import {
  DEFAULT_SCORING,
  type ScoredTurn,
  type TruthUtterance,
  alignMonotonic,
  formatScore,
  median,
  optimalAssignment,
  scoreDiarization,
  summarizeRuns,
} from './room-labels-score.ts';

/**
 * The instrument, checked against known answers before any number it prints
 * is believed.
 *
 * The live half of this measurement — real audio through the real engine —
 * needs a key and a room, and neither is available to a test. What IS
 * checkable is that a perfect run scores 100%, that a run which labels every
 * turn the same scores like one voice, and that inventing a third speaker is
 * seen and named. A scorer nobody has driven backwards is a scorer that will
 * report whatever the run happened to do.
 *
 * All fixtures are fictional.
 */

const TRUTH: TruthUtterance[] = [
  { speaker: 'Rowan', text: 'The import is holding everything up, and I think it is the sync.' },
  { speaker: 'Devi', text: 'I am not sure it is the sync at all. Can we measure it first?' },
  { speaker: 'Rowan', text: 'We can measure it, but I would rather not spend another week.' },
  { speaker: 'Devi', text: 'A week is cheaper than rewriting the whole thing twice.' },
];

/** The same speech, labelled however the caller says. */
function turns(labels: ReadonlyArray<string | undefined>): ScoredTurn[] {
  return TRUTH.map((line, i) => ({
    turn: i,
    text: line.text,
    ...(labels[i] !== undefined ? { speaker: labels[i] } : {}),
  }));
}

describe('scoreDiarization — the controls', () => {
  it('scores a perfect run at 100%, which is the positive control', () => {
    // Without this, every other assertion here could pass against a scorer
    // that always says zero.
    const score = scoreDiarization(turns(['A', 'B', 'A', 'B']), TRUTH);
    expect(score.speakersPredicted).toBe(2);
    expect(score.speakersInvented).toBe(0);
    expect(score.turnsAligned).toBe(4);
    expect(score.turnsCorrect).toBe(4);
    expect(score.boundaryAgreements).toBe(score.boundaryPairs);
    expect(score.labelMap).toEqual({ A: 'Rowan', B: 'Devi' });
  });

  it('scores one label for everybody as half right and every boundary wrong', () => {
    const score = scoreDiarization(turns(['A', 'A', 'A', 'A']), TRUTH);
    expect(score.speakersPredicted).toBe(1);
    // The optimal assignment gives A to whoever it fits best: two of four.
    expect(score.turnsCorrect).toBe(2);
    // And it never changed label where the room changed person — this is the
    // metric that says "the voices did not separate", and it needs no map.
    expect(score.boundaryAgreements).toBe(0);
    expect(score.boundaryPairs).toBe(3);
  });

  it('names an invented speaker rather than absorbing it into the accuracy', () => {
    // Rowan's second turn comes back as a third voice: the failure the cap
    // exists to stop, and the one an accuracy number alone would hide.
    const score = scoreDiarization(turns(['A', 'B', 'C', 'B']), TRUTH);
    expect(score.speakersPredicted).toBe(3);
    expect(score.speakersInvented).toBe(1);
    expect(score.turnsCorrect).toBe(3);
  });

  it('excludes an unattributed turn from accuracy and counts it on its own line', () => {
    const score = scoreDiarization(turns(['A', undefined, 'A', 'B']), TRUTH);
    expect(score.turnsUnlabelled).toBe(1);
    expect(score.turnsAlignedUnlabelled).toBe(1);
    // Three labelled turns scored, of which A=Rowan gets two and B=Devi one.
    expect(score.turnsCorrect).toBe(3);
  });

  it('counts an unattributed turn wrong when the settings say to', () => {
    const score = scoreDiarization(turns(['A', undefined, 'A', 'B']), TRUTH, {
      ...DEFAULT_SCORING,
      unlabelled: 'counted-wrong',
    });
    // Same four turns, but the base is now four and the silent one can never
    // be right — the same run, a different number, which is the whole reason
    // the settings are printed.
    expect(score.turnsAligned).toBe(4);
    expect(score.turnsCorrect).toBe(3);
  });

  it('does not score a boundary across an unattributed turn', () => {
    // Rowan, then a turn the engine would not attribute, then Rowan again.
    // Bridging the gap would count "A then A" as an agreement between two
    // turns that were never next to each other — a boundary the engine never
    // expressed. Only the pairs that are genuinely adjacent are scored, and
    // here neither is: both touch the silent turn.
    const score = scoreDiarization(turns(['A', undefined, 'A', 'B']), TRUTH);
    expect(score.boundaryPairs).toBe(1);
    expect(score.boundaryAgreements).toBe(1);
  });

  it('swapping both labels is still a perfect run — the mapping is optimal', () => {
    const score = scoreDiarization(turns(['B', 'A', 'B', 'A']), TRUTH);
    expect(score.turnsCorrect).toBe(4);
    expect(score.labelMap).toEqual({ B: 'Rowan', A: 'Devi' });
  });
});

describe('alignment', () => {
  it('matches a misheard turn to the line it came from', () => {
    const heard: ScoredTurn[] = [
      {
        turn: 0,
        text: 'the import is holding everything up and i think it is the sink',
        speaker: 'A',
      },
    ];
    expect(alignMonotonic(heard, TRUTH, DEFAULT_SCORING.matchThreshold)).toEqual([[0]]);
  });

  it('leaves a turn that matches nothing unaligned rather than forcing it', () => {
    const heard: ScoredTurn[] = [
      { turn: 0, text: 'completely unrelated words here', speaker: 'A' },
    ];
    expect(alignMonotonic(heard, TRUTH, DEFAULT_SCORING.matchThreshold)).toEqual([[]]);
    const score = scoreDiarization(heard, TRUTH);
    expect(score.turnsAligned).toBe(0);
    // Nothing measured is reported as nothing measured, never as zero.
    expect(formatScore('x', score)).toContain('n/a');
  });

  it('keeps order — a later turn cannot take an earlier line', () => {
    const heard: ScoredTurn[] = [
      { turn: 0, text: TRUTH[2]?.text ?? '', speaker: 'A' },
      { turn: 1, text: TRUTH[1]?.text ?? '', speaker: 'B' },
    ];
    const aligned = alignMonotonic(heard, TRUTH, DEFAULT_SCORING.matchThreshold);
    expect(aligned[0]?.[0] ?? -1).toBeLessThan(aligned[1]?.[0] ?? -1);
  });
});

describe('optimalAssignment', () => {
  it('beats greedy when two labels want the same person', () => {
    // Greedy takes A=Rowan (5) and is then stuck with B=Devi (1) for 6; the
    // optimum is A=Devi (4) and B=Rowan (4) for 8.
    const counts = new Map([
      [
        'A',
        new Map([
          ['Rowan', 5],
          ['Devi', 4],
        ]),
      ],
      [
        'B',
        new Map([
          ['Rowan', 4],
          ['Devi', 1],
        ]),
      ],
    ]);
    const solved = optimalAssignment(counts);
    expect(solved.correct).toBe(8);
    expect(solved.map).toEqual({ A: 'Devi', B: 'Rowan' });
  });
});

describe('the report', () => {
  it('prints every scoring setting beside the numbers', () => {
    const text = formatScore('run', scoreDiarization(turns(['A', 'B', 'A', 'B']), TRUTH));
    for (const setting of [
      'similarity=jaccard-words',
      'threshold=0.5',
      'alignment=monotonic-dp-span',
      'mapping=optimal-assignment',
      'unlabelled=excluded',
    ]) {
      expect(text).toContain(setting);
    }
  });

  it('says INVENTED where a speaker was invented', () => {
    const text = formatScore('run', scoreDiarization(turns(['A', 'B', 'C', 'B']), TRUTH));
    expect(text).toContain('INVENTED');
  });
});

describe('inputs', () => {
  it('reads a script file, skipping comments and blanks', () => {
    expect(parseTruth('# who said what\n\nRowan: One.\nDevi: Two.\n')).toEqual([
      { speaker: 'Rowan', text: 'One.' },
      { speaker: 'Devi', text: 'Two.' },
    ]);
  });

  it('collects repeated flags and bare flags', () => {
    const args = parseArgs(['--synthetic', '--emulate', 'ns', 'agc', '--setting', 'ec1-ns0-agc0']);
    expect(args.get('synthetic')).toEqual([]);
    expect(args.get('emulate')).toEqual(['ns', 'agc']);
    expect(args.get('setting')).toEqual(['ec1-ns0-agc0']);
  });

  it('keeps the synthetic script two-voiced and long enough to be attributed', () => {
    // A turn under about a second of audio comes back as a placeholder label,
    // so a fixture of short lines would measure the placeholder rule instead
    // of diarization.
    expect(new Set(SYNTHETIC_SCRIPT.map((l) => l.speaker)).size).toBe(2);
    for (const line of SYNTHETIC_SCRIPT) expect(line.line.split(' ').length).toBeGreaterThan(8);
  });
});

describe('a turn that covers two people', () => {
  it('is counted wrong and named, never attributed to whoever dominated it', () => {
    // The first live run of this harness looked like this: the engine's turn
    // detector never found a boundary, so one turn carried both voices. A
    // scorer that aligned one line per turn dropped the rest and reported
    // 100%.
    const runOn: ScoredTurn[] = [
      {
        turn: 0,
        text: `${TRUTH[0]?.text} ${TRUTH[1]?.text}`,
        speaker: 'A',
      },
      { turn: 1, text: TRUTH[2]?.text ?? '', speaker: 'A' },
    ];
    const score = scoreDiarization(runOn, TRUTH);
    expect(score.turnsAligned).toBe(2);
    expect(score.turnsMixed).toBe(1);
    // Two turns scored, and the mixed one can never be right.
    expect(score.turnsCorrect).toBe(1);
    expect(formatScore('x', score)).toContain('1 covering more than one person');
  });

  it('names a room whose voices were never distinguished', () => {
    const score = scoreDiarization(turns(['A', 'A', 'A', 'A']), TRUTH);
    expect(score.speakersMissed).toBe(1);
    expect(formatScore('x', score)).toContain('NEVER DISTINGUISHED');
  });
});

/* ===== Several runs of the same audio ===== */

/**
 * Runs are built through `scoreDiarization` rather than as literals, so the
 * spread these tests describe is a spread the scorer can actually produce.
 */
function runScoring(labels: readonly string[]): ReturnType<typeof scoreDiarization> {
  const truth: TruthUtterance[] = [
    { speaker: 'Rowan', text: 'the kettle is on the left of the sink' },
    { speaker: 'Devi', text: 'and the mugs are in the cupboard above' },
    { speaker: 'Rowan', text: 'I will put the tray down by the door' },
    { speaker: 'Devi', text: 'that works for the morning as well' },
  ];
  const turns: ScoredTurn[] = truth.map((t, i) => ({
    turn: i + 1,
    text: t.text,
    speaker: labels[i] ?? 'A',
  }));
  return scoreDiarization(turns, truth, DEFAULT_SCORING);
}

describe('median', () => {
  it('is the middle of an odd count and the mean of the middle two of an even one', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('is not a number when there is nothing to take the middle of', () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe('summarizeRuns', () => {
  const perfect = runScoring(['A', 'B', 'A', 'B']);
  const halfWrong = runScoring(['A', 'B', 'B', 'B']);
  const allOne = runScoring(['A', 'A', 'A', 'A']);

  it('prints every run and their median rather than one number', () => {
    const text = summarizeRuns([perfect, halfWrong]);
    expect(text).toContain('ACROSS 2 RUNS');
    expect(text).toContain('median');
    // Both runs are visible: a reader can see the disagreement, not just its
    // average.
    expect(text.match(/%/g)?.length).toBeGreaterThan(4);
  });

  it('says the runs cannot rank settings when one setting spreads by 10 points', () => {
    // This is the finding the AMI matrix ran into: the same audio under the
    // same settings scored 35.1% and 50.2%, which is wider than any gap
    // between settings. Without this line the matrix reads as a result.
    const text = summarizeRuns([perfect, allOne]);
    expect(text).toContain('SPREAD');
    expect(text).toContain('Do not');
  });

  it('stays quiet when the runs agree, so the warning means something', () => {
    // The positive control for the warning: it must not fire on every
    // multi-run summary, or it carries no information when it does.
    const text = summarizeRuns([perfect, perfect]);
    expect(text).not.toContain('SPREAD');
  });

  it('reports the range of speaker counts, because that varies run to run too', () => {
    const text = summarizeRuns([perfect, allOne]);
    expect(text).toContain('speakers labelled: 1-2 of 2'.replace('-', '\u2013'));
  });

  it('has something to say about a single run', () => {
    expect(summarizeRuns([perfect])).toContain('ACROSS 1 RUN of the same audio');
  });

  it('does not divide by a zero when there were no runs', () => {
    expect(summarizeRuns([])).toBe('  no runs');
  });
});
