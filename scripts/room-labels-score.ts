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
  /** Monotonic, many-to-one: in order, and a turn may cover several lines. */
  alignment: 'monotonic-dp-span';
  /** Labels to people: the assignment maximising correct turns, exactly. */
  mapping: 'optimal-assignment';
  /** What an unattributed turn does to attribution accuracy. */
  unlabelled: 'excluded' | 'counted-wrong';
  /**
   * What a turn covering more than one person does. Always wrong: it is the
   * worst thing the transcript can say — two people's words under one name —
   * and there is no person it could be attributed to.
   */
  mixed: 'counted-wrong';
}

export const DEFAULT_SCORING: ScoringSettings = {
  similarity: 'jaccard-words',
  // Half the words shared. High enough that two different lines do not match,
  // low enough to survive the mishearings that are the point of a transcript.
  matchThreshold: 0.5,
  alignment: 'monotonic-dp-span',
  mapping: 'optimal-assignment',
  // A turn the engine declined to attribute is not a wrong attribution; it is
  // reported on its own line, because a run that labels nothing would
  // otherwise score 100%.
  unlabelled: 'excluded',
  mixed: 'counted-wrong',
};

export interface DiarizationScore {
  settings: ScoringSettings;
  /** People in the room, from the script. */
  speakersTruth: number;
  /** Distinct labels the engine handed out. */
  speakersPredicted: number;
  /** How many labels beyond the real number — the invention the cap stops. */
  speakersInvented: number;
  /** How many people the labels never distinguished — the opposite failure. */
  speakersMissed: number;
  turnsTotal: number;
  turnsAligned: number;
  turnsUnlabelled: number;
  /** Of the aligned ones, how many carried no label — the attribution base. */
  turnsAlignedUnlabelled: number;
  /** Aligned turns whose words came from more than one person. Never right. */
  turnsMixed: number;
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
 * Match turns to script lines, keeping order — and letting ONE turn cover
 * several lines.
 *
 * Speech happens in sequence, so an alignment that crosses itself is wrong
 * however well the words match. The many-to-one part is not a nicety: the
 * first live run of this harness came back as three turns covering six lines
 * of two-person dialogue, because the engine's turn detector never found a
 * boundary. A one-line-per-turn alignment silently threw four of those lines
 * away and scored the remainder at 100%. A turn that covers two people is the
 * WORST outcome the transcript can have — the words of two people under one
 * name — and it has to be visible, which means it has to be aligned first.
 *
 * Returns, per turn, the line indices it covers, in order. Empty means the
 * turn matched nothing.
 */
export function alignMonotonic(
  turns: readonly ScoredTurn[],
  truth: readonly TruthUtterance[],
  threshold: number,
  maxSpan = 24,
): number[][] {
  const n = turns.length;
  const m = truth.length;
  // best[i][j] — the most similarity obtainable from turns i.. and lines j..,
  // and the span that achieved it (0 = this turn took nothing here).
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const span: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = best[i];
      const spanRow = span[i];
      if (!row || !spanRow) continue;
      let bestScore = Math.max(best[i + 1]?.[j] ?? 0, best[i]?.[j + 1] ?? 0);
      let bestSpan = 0;
      let joined = '';
      for (let k = 1; k <= maxSpan && j + k <= m; k++) {
        joined = `${joined} ${truth[j + k - 1]?.text ?? ''}`;
        const sim = similarity(turns[i]?.text ?? '', joined);
        if (sim < threshold) continue;
        const total = sim + (best[i + 1]?.[j + k] ?? 0);
        if (total > bestScore) {
          bestScore = total;
          bestSpan = k;
        }
      }
      row[j] = bestScore;
      spanRow[j] = bestSpan;
    }
  }
  const out: number[][] = Array.from({ length: n }, () => []);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const k = span[i]?.[j] ?? 0;
    if (k > 0) {
      for (let d = 0; d < k; d++) out[i]?.push(j + d);
      i++;
      j += k;
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
  const pairs: Array<{
    label: string | undefined;
    /** The one person this turn is all of, or null when it covers several. */
    person: string | null;
    words: number;
  }> = [];
  turns.forEach((turn, i) => {
    const lines = (aligned[i] ?? []).map((at) => truth[at]).filter((l): l is TruthUtterance => !!l);
    if (lines.length === 0) return;
    const people = new Set(lines.map((l) => l.speaker));
    pairs.push({
      label: turn.speaker,
      person: people.size === 1 ? (lines[0]?.speaker ?? null) : null,
      words: words(turn.text).length,
    });
  });

  const scored =
    settings.unlabelled === 'excluded' ? pairs.filter((p) => p.label !== undefined) : pairs;
  const counts = new Map<string, Map<string, number>>();
  const wordCounts = new Map<string, Map<string, number>>();
  for (const p of scored) {
    // A mixed turn belongs to nobody, and an unattributed one is nobody's
    // label: both are counted under keys no assignment can ever claim, so
    // they stay in the denominator and can only ever score as wrong.
    if (p.person === null) continue;
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
    // ADJACENT turns only, both labelled, and neither of them mixed. Dropping
    // the others and walking the remainder would make the turns either side
    // of a gap look consecutive and score a boundary the engine never
    // expressed; a mixed turn has no single person to compare against at all.
    if (!prev || !cur) continue;
    if (prev.label === undefined || cur.label === undefined) continue;
    if (prev.person === null || cur.person === null) continue;
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
    speakersMissed: Math.max(0, truthSpeakers.size - predicted.size),
    turnsTotal: turns.length,
    turnsAligned: pairs.length,
    turnsUnlabelled: turns.filter((t) => t.speaker === undefined).length,
    turnsAlignedUnlabelled: pairs.filter((p) => p.label === undefined).length,
    turnsMixed: pairs.filter((p) => p.person === null).length,
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
  const counted =
    score.speakersInvented > 0
      ? `  (+${score.speakersInvented} INVENTED)`
      : score.speakersMissed > 0
        ? `  (${score.speakersMissed} NEVER DISTINGUISHED)`
        : '';
  return [
    `  ${title}`,
    `    speakers: ${score.speakersPredicted} labelled vs ${score.speakersTruth} in the room${counted}`,
    `    turns: ${score.turnsAligned}/${score.turnsTotal} aligned to the script, ` +
      `${score.turnsUnlabelled} unattributed, ${score.turnsMixed} covering more than one person`,
    `    boundary agreement: ${pct(score.boundaryAgreements, score.boundaryPairs)} ` +
      `(${score.boundaryAgreements}/${score.boundaryPairs} consecutive pairs)`,
    `    turn attribution: ${pct(score.turnsCorrect, scoredTurns)} ` +
      `(${score.turnsCorrect}/${scoredTurns})`,
    `    word attribution: ${pct(score.wordsCorrect, score.wordsScored)} ` +
      `(${score.wordsCorrect}/${score.wordsScored})`,
    `    labels mapped: ${mapped}`,
    `    SCORING: similarity=${s.similarity} threshold=${s.matchThreshold} ` +
      `alignment=${s.alignment} mapping=${s.mapping} unlabelled=${s.unlabelled} mixed=${s.mixed}`,
  ].join('\n');
}

/* ===== Several runs of the same audio ===== */

/**
 * The middle value, for an odd or even count.
 *
 * The median rather than the mean because these runs are a handful of samples
 * from a heavy-tailed thing: one run where the engine merged the whole excerpt
 * into two turns drags a mean somewhere no run actually was.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (sorted.length % 2 === 1) return high ?? Number.NaN;
  return low !== undefined && high !== undefined ? (low + high) / 2 : Number.NaN;
}

/**
 * Several runs of ONE recording, reported as a spread rather than a number.
 *
 * Measured on this engine, the same bytes give very nearly the same answer:
 * across 20 runs of two AMI excerpts under four settings, every setting's
 * runs agreed to within 0.1 points, and the single disagreement was one
 * transcribed word. That is worth being able to show rather than assume,
 * because the first reading of the microphone matrix explained a real
 * between-settings difference away as run-to-run noise, and only repeats
 * could tell those two stories apart.
 *
 * So the summary prints every run rather than a single number, and says out
 * loud when the spread WITHIN one setting is wide enough to swallow the gaps
 * BETWEEN settings — on a longer excerpt, a different engine, or a build with
 * a non-greedy decoder, that line is what stops the matrix being read as an
 * ordering it cannot support.
 */
export function summarizeRuns(scores: readonly DiarizationScore[]): string {
  if (scores.length === 0) return '  no runs';
  const turnPct = scores.map((s) => {
    const base =
      s.settings.unlabelled === 'excluded'
        ? s.turnsAligned - s.turnsAlignedUnlabelled
        : s.turnsAligned;
    return base === 0 ? 0 : (100 * s.turnsCorrect) / base;
  });
  const wordPct = scores.map((s) =>
    s.wordsScored === 0 ? 0 : (100 * s.wordsCorrect) / s.wordsScored,
  );
  const labelled = scores.map((s) => s.speakersPredicted);
  const show = (values: readonly number[]) =>
    `${values.map((v) => `${v.toFixed(1)}%`).join(' / ')}  (median ${median(values).toFixed(1)}%)`;
  const spread = Math.max(...wordPct) - Math.min(...wordPct);
  const lines = [
    `  ACROSS ${scores.length} RUN${scores.length === 1 ? '' : 'S'} of the same audio:`,
    `    speakers labelled: ${Math.min(...labelled)}–${Math.max(...labelled)} of ${scores[0]?.speakersTruth ?? 0}`,
    `    turn attribution: ${show(turnPct)}`,
    `    word attribution: ${show(wordPct)}`,
  ];
  if (scores.length > 1 && spread >= 10) {
    lines.push(
      `    SPREAD ${spread.toFixed(1)} POINTS WITHIN ONE SETTING — the engine is not`,
      '    deterministic, and this is wider than the gaps between settings. Do not',
      '    rank settings on these runs.',
    );
  }
  return lines.join('\n');
}
