/**
 * Scoring for "did two voices actually separate?" — the arithmetic half,
 * pure and testable, with no engine, no files and no clock.
 *
 * WHY THE SETTINGS ARE PART OF THE RESULT. A diarization accuracy number
 * means nothing on its own: it moves by tens of points depending on whether
 * an unlabelled turn counts as wrong, whether a turn or a word is the unit,
 * how a transcript turn is matched to the line somebody actually read, and
 * how predicted labels are mapped onto real people. So `scoreDiarization`
 * takes a `ScoringSettings`, carries it into the result, and the report
 * prints it beside every figure. A number here without its settings should be
 * read as no number.
 *
 * WHAT IT SCORES. Three things, in increasing order of how much they can be
 * argued with:
 *
 *  1. SPEAKER COUNT. How many distinct labels came back against how many
 *     people were in the room. This is the failure the cap exists to stop —
 *     a model inventing people — and it needs no alignment and no mapping to
 *     see, which is why it is first.
 *  2. TURN-BOUNDARY AGREEMENT. Over consecutive turns: did the engine change
 *     label exactly where the room changed speaker? Needs no mapping between
 *     its labels and real names, so it cannot be flattered by a lucky
 *     assignment, and it is the metric that answers "do the voices separate".
 *  3. ATTRIBUTION ACCURACY. Labels mapped onto people optimally, then the
 *     share of turns (and of words) attributed to the right one.
 */

/** One settled turn as the engine and the record both hold it. */
export interface ScoredTurn {
  turn: number;
  text: string;
  /** Absent for a turn the engine would not attribute. */
  speaker?: string;
}

/** One line of the script that was actually read, in the order it was read. */
export interface TruthUtterance {
  /** Who read it — a name or a letter; only its identity is used. */
  speaker: string;
  text: string;
}

/** Every knob that can move a number, stated so a number can be compared. */
export interface ScoringSettings {
  /** How a transcript turn is matched to a script line. */
  similarity: 'jaccard-words';
  /** Below this, a turn is UNALIGNED and scores nothing either way. */
  matchThreshold: number;
  /** Monotonic: speech happens in order, so alignments cannot cross. */
  alignment: 'monotonic-dp';
  /** Labels to people: the assignment maximising correct turns, exactly. */
  mapping: 'optimal-assignment';
  /** What an unattributed turn does to attribution accuracy. */
  unlabelled: 'excluded' | 'counted-wrong';
}

export const DEFAULT_SCORING: ScoringSettings = {
  similarity: 'jaccard-words',
  // Half the words shared. High enough that two different lines do not match,
  // low enough to survive the mishearings that are the point of a transcript.
  matchThreshold: 0.5,
  alignment: 'monotonic-dp',
  mapping: 'optimal-assignment',
  // A turn the engine declined to attribute is not a wrong attribution; it is
  // reported on its own line, because a run that labels nothing would
  // otherwise score 100%.
  unlabelled: 'excluded',
};

export interface DiarizationScore {
  settings: ScoringSettings;
  /** People in the room, from the script. */
  speakersTruth: number;
  /** Distinct labels the engine handed out. */
  speakersPredicted: number;
  /** How many labels beyond the real number — the invention the cap stops. */
  speakersInvented: number;
  turnsTotal: number;
  turnsAligned: number;
  turnsUnlabelled: number;
  /** Of the aligned ones, how many carried no label — the attribution base. */
  turnsAlignedUnlabelled: number;
  /** Consecutive aligned pairs where change-of-label matched change-of-person. */
  boundaryPairs: number;
  boundaryAgreements: number;
  /** Aligned, labelled turns attributed to the right person, and their words. */
  turnsCorrect: number;
  wordsScored: number;
  wordsCorrect: number;
  /** The label-to-person assignment the score was computed under. */
  labelMap: Record<string, string>;
}

/** Words, lowercased, punctuation gone — the unit both halves are compared in. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Jaccard over word SETS: order-free, and length-fair in both directions. */
export function similarity(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Match turns to script lines, keeping order.
 *
 * Speech happens in sequence, so an alignment that crosses itself is wrong
 * however well the words match — an engine that merged two turns should lose
 * one of them, not steal a line from further down the script. Returns, per
 * turn, the index of the line it belongs to, or -1.
 */
export function alignMonotonic(
  turns: readonly ScoredTurn[],
  truth: readonly TruthUtterance[],
  threshold: number,
): number[] {
  const n = turns.length;
  const m = truth.length;
  // best[i][j] — the most similarity obtainable from turns i.. and lines j..
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const take: boolean[][] = Array.from({ length: n + 1 }, () =>
    new Array<boolean>(m + 1).fill(false),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = similarity(turns[i]?.text ?? '', truth[j]?.text ?? '');
      const paired = s >= threshold ? s + (best[i + 1]?.[j + 1] ?? 0) : Number.NEGATIVE_INFINITY;
      const bestSkip = Math.max(best[i + 1]?.[j] ?? 0, best[i]?.[j + 1] ?? 0);
      const row = best[i];
      const takeRow = take[i];
      if (!row || !takeRow) continue;
      if (paired >= bestSkip) {
        row[j] = paired;
        takeRow[j] = true;
      } else {
        row[j] = bestSkip;
        takeRow[j] = false;
      }
    }
  }
  const out = new Array<number>(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (take[i]?.[j]) {
      out[i] = j;
      i++;
      j++;
    } else if ((best[i + 1]?.[j] ?? 0) >= (best[i]?.[j + 1] ?? 0)) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

/**
 * The label-to-person assignment that gets the most turns right.
 *
 * Exact rather than greedy, by bitmask over the people: labels are capped at
 * ten by the engine and people by the room, so the search is small, and a
 * greedy assignment loses on the one case that matters — two labels whose
 * best person is the same one.
 */
export function optimalAssignment(counts: Map<string, Map<string, number>>): {
  map: Record<string, string>;
  correct: number;
} {
  const labels = [...counts.keys()];
  const people = [...new Set([...counts.values()].flatMap((row) => [...row.keys()]))];
  const memo = new Map<string, { score: number; map: Record<string, string> }>();
  const solve = (idx: number, used: number): { score: number; map: Record<string, string> } => {
    if (idx >= labels.length) return { score: 0, map: {} };
    const key = `${idx}:${used}`;
    const hit = memo.get(key);
    if (hit) return hit;
    // A label may also go unassigned — with more labels than people (the
    // invented-speaker case) some of them must.
    let best = solve(idx + 1, used);
    const label = labels[idx] ?? '';
    for (let p = 0; p < people.length; p++) {
      if (used & (1 << p)) continue;
      const person = people[p] ?? '';
      const gain = counts.get(label)?.get(person) ?? 0;
      const rest = solve(idx + 1, used | (1 << p));
      if (gain + rest.score > best.score) {
        best = { score: gain + rest.score, map: { ...rest.map, [label]: person } };
      }
    }
    memo.set(key, best);
    return best;
  };
  const solved = solve(0, 0);
  return { map: solved.map, correct: solved.score };
}

/** The label an unattributed turn is counted under; no person maps to it. */
const UNLABELLED = ' unattributed';

/** Score one run: turns as the engine gave them, against the script as read. */
export function scoreDiarization(
  turns: readonly ScoredTurn[],
  truth: readonly TruthUtterance[],
  settings: ScoringSettings = DEFAULT_SCORING,
): DiarizationScore {
  const aligned = alignMonotonic(turns, truth, settings.matchThreshold);
  const pairs: Array<{ label: string | undefined; person: string; words: number }> = [];
  turns.forEach((turn, i) => {
    const at = aligned[i] ?? -1;
    const line = at >= 0 ? truth[at] : undefined;
    if (!line) return;
    pairs.push({ label: turn.speaker, person: line.speaker, words: words(turn.text).length });
  });

  const scored =
    settings.unlabelled === 'excluded' ? pairs.filter((p) => p.label !== undefined) : pairs;
  const counts = new Map<string, Map<string, number>>();
  const wordCounts = new Map<string, Map<string, number>>();
  for (const p of scored) {
    // Under `counted-wrong` an unattributed turn is counted under a label no
    // person can be assigned to, so it can only ever score as wrong.
    const label = p.label ?? UNLABELLED;
    const row = counts.get(label) ?? new Map<string, number>();
    row.set(p.person, (row.get(p.person) ?? 0) + 1);
    counts.set(label, row);
    const wrow = wordCounts.get(label) ?? new Map<string, number>();
    wrow.set(p.person, (wrow.get(p.person) ?? 0) + p.words);
    wordCounts.set(label, wrow);
  }
  const assignable = new Map([...counts].filter(([label]) => label !== UNLABELLED));
  const assignment = optimalAssignment(assignable);
  const wordsCorrect = Object.entries(assignment.map).reduce(
    (n, [label, person]) => n + (wordCounts.get(label)?.get(person) ?? 0),
    0,
  );

  let boundaryPairs = 0;
  let boundaryAgreements = 0;
  for (let i = 1; i < pairs.length; i++) {
    const prev = pairs[i - 1];
    const cur = pairs[i];
    // ADJACENT turns only, and both must carry a label. Dropping the
    // unattributed ones and then walking the remainder would make the turns
    // either side of a silent one look consecutive, and score a boundary the
    // engine never expressed: A / unattributed / A would count as an
    // agreement between two turns that were never next to each other.
    if (!prev || !cur || prev.label === undefined || cur.label === undefined) continue;
    boundaryPairs++;
    if ((prev.label === cur.label) === (prev.person === cur.person)) boundaryAgreements++;
  }

  const predicted = new Set(turns.map((t) => t.speaker).filter((s): s is string => Boolean(s)));
  const truthSpeakers = new Set(truth.map((t) => t.speaker));
  return {
    settings,
    speakersTruth: truthSpeakers.size,
    speakersPredicted: predicted.size,
    speakersInvented: Math.max(0, predicted.size - truthSpeakers.size),
    turnsTotal: turns.length,
    turnsAligned: pairs.length,
    turnsUnlabelled: turns.filter((t) => t.speaker === undefined).length,
    turnsAlignedUnlabelled: pairs.filter((p) => p.label === undefined).length,
    boundaryPairs,
    boundaryAgreements,
    turnsCorrect: assignment.correct,
    wordsScored: scored.reduce((n, p) => n + p.words, 0),
    wordsCorrect,
    labelMap: assignment.map,
  };
}

/** A percentage, or "n/a" when nothing was measured — never a silent zero. */
export function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`;
}

/** The scorecard, settings included, as one block of text. */
export function formatScore(title: string, score: DiarizationScore): string {
  const s = score.settings;
  const scoredTurns =
    s.unlabelled === 'excluded'
      ? score.turnsAligned - score.turnsAlignedUnlabelled
      : score.turnsAligned;
  const mapped =
    Object.entries(score.labelMap)
      .map(([label, person]) => `${label}=${person}`)
      .join(', ') || 'none';
  return [
    `  ${title}`,
    `    speakers: ${score.speakersPredicted} labelled vs ${score.speakersTruth} in the room` +
      (score.speakersInvented > 0 ? `  (+${score.speakersInvented} INVENTED)` : ''),
    `    turns: ${score.turnsAligned}/${score.turnsTotal} aligned to the script, ` +
      `${score.turnsUnlabelled} unattributed`,
    `    boundary agreement: ${pct(score.boundaryAgreements, score.boundaryPairs)} ` +
      `(${score.boundaryAgreements}/${score.boundaryPairs} consecutive pairs)`,
    `    turn attribution: ${pct(score.turnsCorrect, scoredTurns)} ` +
      `(${score.turnsCorrect}/${scoredTurns})`,
    `    word attribution: ${pct(score.wordsCorrect, score.wordsScored)} ` +
      `(${score.wordsCorrect}/${score.wordsScored})`,
    `    labels mapped: ${mapped}`,
    `    SCORING: similarity=${s.similarity} threshold=${s.matchThreshold} ` +
      `alignment=${s.alignment} mapping=${s.mapping} unlabelled=${s.unlabelled}`,
  ].join('\n');
}
