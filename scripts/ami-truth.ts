/**
 * Ground truth out of the AMI Meeting Corpus, so the room measurement has a
 * real room in it.
 *
 * WHY AMI. Bryan's own recording is one room, one pair of voices, one
 * microphone; it is the case we care about and it is a sample of one. AMI is
 * a hundred hours of real meetings with reference speaker segments, released
 * under CC BY 4.0 (https://groups.inf.ed.ac.uk/ami/corpus/: "All of the
 * signals and transcription, and some of the annotations, have been released
 * publicly under the Creative Commons Attribution 4.0 International Licence
 * (CC BY 4.0)", read 2026-08-31). Its `Array1-01` channel is a SINGLE element
 * of the far-field array on the table — one microphone, several people around
 * it, which is exactly the tablet-on-the-table case this subsystem is for.
 *
 * WHY THE WORDS AND NOT THE SEGMENTS. Our engine hands back turns with no
 * timestamps — `EngineTurn` carries text, a turn number and a label — so a
 * time-based DER is not computable from what the adapter keeps without
 * changing the wire contract for the sake of a measurement. The word-level
 * annotation gives both: the words to align our text against, and the speaker
 * of every one of them. Grouping consecutive words of one speaker into
 * utterances turns the reference into exactly the shape the scorer already
 * takes, and the number it produces is turn attribution rather than DER.
 * `scoreDiarization` prints which it is.
 */

/** One reference word: who said it, when, and what. */
export interface AmiWord {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

/**
 * Words out of one `<meeting>.<speaker>.words.xml`.
 *
 * The file is NXT XML: `<w>` elements carrying `starttime`/`endtime`, mixed
 * with `<vocalsound>`, `<gap>` and friends that are not speech. Punctuation
 * arrives as its own `<w punc="true">`, which would otherwise become a
 * "word" and drag every similarity score down. Parsed with a regex rather
 * than a DOM because this is a flat list of leaf elements and the repo has no
 * XML parser to add for one script.
 */
/**
 * XML entities back to the characters they stand for.
 *
 * The corpus is ISO-8859-1 and escapes apostrophes numerically, so `I'm`
 * arrives as `I&#39;m`. Left alone it would be compared against the engine's
 * `I'm` and score as a miss on some of the most common words in the
 * language — an entity bug reading as a transcription error.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseAmiWords(xml: string, speaker: string): AmiWord[] {
  const out: AmiWord[] = [];
  // The `[^/>]` before the close refuses a SELF-CLOSING `<w …/>`: matched
  // loosely, it would swallow everything up to the NEXT `</w>` and attribute
  // that word's text to the empty element.
  const element = /<w\b((?:[^>]*[^/>])?)>([\s\S]*?)<\/w>/g;
  let match: RegExpExecArray | null = element.exec(xml);
  while (match) {
    const attrs = match[1] ?? '';
    const text = decodeEntities((match[2] ?? '').trim());
    const start = Number(/\bstarttime="([\d.]+)"/.exec(attrs)?.[1] ?? Number.NaN);
    const end = Number(/\bendtime="([\d.]+)"/.exec(attrs)?.[1] ?? Number.NaN);
    const punctuation = /\bpunc="true"/.test(attrs);
    if (text && !punctuation && Number.isFinite(start) && Number.isFinite(end)) {
      out.push({ speaker, start, end, text });
    }
    match = element.exec(xml);
  }
  return out;
}

/** One reference utterance: consecutive words of one speaker. */
export interface AmiUtterance {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

/**
 * Every speaker's words, merged into one time-ordered stream of utterances.
 *
 * A new utterance starts when the speaker changes or when the same speaker
 * leaves a gap — `gapSeconds`, default 1.0s, roughly where a listener would
 * hear a new sentence rather than a pause. The grouping is the reference's
 * business, not the engine's: our turns are aligned to these by TEXT, so the
 * boundaries only have to be somewhere a person would agree with.
 *
 * OVERLAPPED SPEECH is why this sorts by start time and does not try to
 * interleave: in a real meeting two people talk at once, and the stream can
 * only be one order. Sorting by start puts the interrupting utterance after
 * the one it interrupts, which is the order a transcript would read in.
 */
export function amiUtterances(words: readonly AmiWord[], gapSeconds = 1.0): AmiUtterance[] {
  const sorted = [...words].sort((a, b) => a.start - b.start || a.speaker.localeCompare(b.speaker));
  const out: AmiUtterance[] = [];
  for (const word of sorted) {
    const last = out[out.length - 1];
    if (last && last.speaker === word.speaker && word.start - last.end <= gapSeconds) {
      last.text = `${last.text} ${word.text}`;
      last.end = Math.max(last.end, word.end);
      continue;
    }
    out.push({ speaker: word.speaker, start: word.start, end: word.end, text: word.text });
  }
  return out;
}

/**
 * The utterances inside an excerpt window, in the window's own time base.
 *
 * An utterance is kept when it lies WHOLLY inside the window. A half-spoken
 * sentence at either edge would be scored against words the engine never
 * heard, which reads as the engine mishearing rather than as the excerpt
 * cutting — and the alignment threshold would then drop the turn entirely,
 * quietly shrinking the sample.
 */
export function amiWindow(
  utterances: readonly AmiUtterance[],
  fromSeconds: number,
  seconds: number,
): AmiUtterance[] {
  const until = fromSeconds + seconds;
  return utterances
    .filter((u) => u.start >= fromSeconds && u.end <= until)
    .map((u) => ({ ...u, start: u.start - fromSeconds, end: u.end - fromSeconds }));
}

/**
 * A window with enough speech in it to measure — the busiest one on offer.
 *
 * Picked rather than fixed at zero because the first minutes of an AMI
 * meeting are people arriving and the recording equipment being explained: an
 * excerpt there is one voice reading instructions, which would measure
 * nothing about telling two people apart while looking like a real result.
 * Scores each candidate start on how many DISTINCT speakers it contains and
 * then on total words, so the window that wins is the one with a conversation
 * in it.
 */
export function busiestWindow(
  utterances: readonly AmiUtterance[],
  seconds: number,
  stepSeconds = 15,
): number | undefined {
  // Only windows that fit entirely inside the recording are candidates: a
  // window running off the end would be judged on a few seconds of audio and
  // could win on two speakers in two words.
  // The LAST moment anybody stopped talking, not the last utterance's end:
  // the stream is ordered by when speech started, so an utterance that began
  // earlier can finish later.
  const last = utterances.reduce((n, u) => Math.max(n, u.end), 0);
  let bestAt: number | undefined;
  let bestScore = -1;
  for (let at = 0; at + seconds <= last; at += stepSeconds) {
    const window = amiWindow(utterances, at, seconds);
    const speakers = new Set(window.map((u) => u.speaker)).size;
    const words = window.reduce((n, u) => n + u.text.split(/\s+/).length, 0);
    const score = speakers * 10_000 + words;
    if (score > bestScore) {
      bestScore = score;
      bestAt = at;
    }
  }
  // Undefined, not 0, when the recording is shorter than the window: `0` is a
  // real answer to a different question, and a caller that got it would
  // measure the first seconds of a meeting believing they had been chosen.
  return bestAt;
}
