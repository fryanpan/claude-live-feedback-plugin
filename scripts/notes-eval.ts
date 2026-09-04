#!/usr/bin/env bun
/**
 * Does the note-taker actually behave? Run it over real meetings and check.
 *
 *   bun run notes:eval                 # every fixture, every judge
 *   bun run notes:eval --smoke         # the CI slice, a few cents
 *   bun run notes:eval --meeting ES2002a
 *   bun run notes:eval --judge off     # programmatic checks only, no Sonnet
 *
 * WHY THIS EXISTS. Everything the note-taking behaviour asks for — paraphrase,
 * short bullets, one heading per topic, a marked guess, a link on a row that
 * was named — is a property of what a MODEL wrote, and a unit test can only
 * prove that the instruction was sent. So the instructions are checked the
 * way a person would check them: run a real meeting through the real pipeline
 * and read the notes. This does the reading, on 273 ticks instead of three.
 *
 * A RATE HERE IS OVER TICKS, NOT OVER MODEL REPLIES. The decidable checks ask
 * what the NOTES say at each tick, so one over-long bullet that nobody
 * rewrites fails every tick it survives — twenty-eight failures in a run can
 * be four bullets. That is the honest reading of "are the notes good right
 * now", which is the question a reader of a live doc actually asks, but it is
 * not "how often did the model err". Read the failure lines, which name the
 * bullet, before concluding anything about frequency.
 *
 * ON DEMAND ONLY. It spends money and it talks to the network, so nothing
 * runs it on a push except the `--smoke` slice, which is sized to cost cents.
 * It is not a test and it does not live in the suites: a check whose verdict
 * depends on a model's mood must never be able to turn somebody else's CI red.
 *
 * TWO KINDS OF JUDGE, and the split is deliberate. Anything decidable is
 * decided in code (`notes-quality.ts`, unit-tested) — bullet length, a topic
 * opened twice, a decision with no voice on it, a named row left unlinked, a
 * bullet copied verbatim out of the transcript. Only the questions that need
 * reading comprehension go to a model: was this paraphrase faithful, does the
 * note say what was decided and by whom, was that new heading a new topic.
 * A model judging what a regex can settle is money spent on a worse answer.
 *
 * THE CORPUS is AMI (CC BY 4.0), excerpted into committed fixtures by
 * `notes-eval-fixtures.ts`. Speakers are letters; no fixture names a person.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHaikuNotesComposer } from '../packages/server/src/meeting-notes-composer.ts';
import type { NoteReference, NotesComposeInput } from '../packages/server/src/meeting-notes.ts';
import {
  allBullets,
  decisionsWithoutSpeaker,
  duplicateTopics,
  overlongBullets,
  parseNotesTopics,
  unconfirmedBullets,
  unlinkedReferences,
  verbatimBullets,
} from '../packages/server/src/notes-quality.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { resolveKeyFrom } from '../packages/server/src/summarize.ts';
import { createNotesTickHarness } from '../packages/server/test/notes-tick-harness.ts';
import { FIXTURE_DIR, type NotesEvalFixture } from './notes-eval-fixtures.ts';

const JUDGE_MODEL = 'claude-sonnet-5';
const NOTES_MODEL = 'claude-haiku-4-5-20251001';

/**
 * What a thousand tokens costs, per model, in dollars — input then output.
 * Used only to print what the run spent; a figure that drifts makes the
 * report wrong in a way nobody notices, so it is stated here rather than
 * buried in a multiplication.
 */
const PRICES: Record<string, { input: number; output: number }> = {
  [NOTES_MODEL]: { input: 1 / 1_000_000, output: 5 / 1_000_000 },
  [JUDGE_MODEL]: { input: 3 / 1_000_000, output: 15 / 1_000_000 },
};

/**
 * A line typed by a person, seeded into every fixture's doc before the
 * meeting starts.
 *
 * Criterion 1.2 — never edit a bullet a human edited — has no examples
 * without one: a meeting where nobody types is a meeting where the rule
 * cannot be broken, and a pass rate over it would be 100% and meaningless.
 * So every tick of every fixture is an example, and the check is exact: after
 * the tick, is this line still in the accepted notes, character for
 * character.
 */
const HUMAN_LINE = 'my own note: check this against the brief before we commit';

/* ===== The behaviours, and what counts as an example of each ===== */

interface Verdict {
  /** Did this tick satisfy the behaviour? */
  ok: boolean;
  /** Why not — printed for the failures, never for the passes. */
  detail?: string;
}

/** One behaviour's tally across the run. */
class Behaviour {
  examples = 0;
  passes = 0;
  readonly failures: string[] = [];
  constructor(
    readonly id: string,
    readonly what: string,
  ) {}
  see(verdict: Verdict | null, where: string): void {
    // Null means "this tick is not an example" — a tick that named no board
    // row says nothing about linking, and counting it as a pass would inflate
    // every rate with ticks that could not have failed.
    if (!verdict) return;
    this.examples++;
    if (verdict.ok) this.passes++;
    else this.failures.push(`${where}: ${verdict.detail ?? 'failed'}`);
  }
  get rate(): number {
    return this.examples === 0 ? 0 : this.passes / this.examples;
  }
}

/* ===== Usage accounting ===== */

interface Usage {
  input: number;
  output: number;
  calls: number;
}

const usage: Record<string, Usage> = {};

function recordUsage(model: string, input: number, output: number): void {
  const u = (usage[model] ??= { input: 0, output: 0, calls: 0 });
  u.input += input;
  u.output += output;
  u.calls++;
}

function totalCost(): number {
  let sum = 0;
  for (const [model, u] of Object.entries(usage)) {
    const price = PRICES[model];
    if (!price) continue;
    sum += u.input * price.input + u.output * price.output;
  }
  return sum;
}

/**
 * The composer's own fetch, wrapped so the run can price itself.
 *
 * Reading `usage` off the response rather than counting tokens separately:
 * the billed number is the one in the reply, and a second count_tokens call
 * would be both an estimate and an expense.
 */
function countingFetch(model: string): typeof fetch {
  const wrapped = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const res = await globalThis.fetch(input as string, init);
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    const u = (body as { usage?: { input_tokens?: number; output_tokens?: number } } | null)?.usage;
    if (u) recordUsage(model, u.input_tokens ?? 0, u.output_tokens ?? 0);
    return res;
  };
  // Bun's `fetch` type carries a `preconnect`; nothing here calls it, and the
  // composer only ever invokes the function itself.
  return Object.assign(wrapped, { preconnect: globalThis.fetch.preconnect }) as typeof fetch;
}

/* ===== The model judge ===== */

const JUDGE_SYSTEM = [
  'You are grading a live meeting note-taker, strictly and briefly.',
  '',
  'You get the speech from one moment of a meeting, the notes as they stood',
  'before it, and the notes after. Judge ONLY what the new writing does.',
  '',
  'Record every verdict with the record_verdict tool. Each behaviour carries',
  'its own verdict AND its own reason — a reason that explains a different',
  'behaviour is worse than none, because it is read as evidence about the one',
  'it is filed under. Each reason is AT MOST TWELVE WORDS naming what failed,',
  'or empty when the verdict holds.',
  '',
  "- paraphrased: the new notes say what the speech MEANT in the writer's own",
  '  short sentences. False if a note reads as a transcript line, quotes',
  "  filler, or keeps the speaker's syntax.",
  '- covers: what the speech actually settled is in the notes — the point',
  '  discussed, and where the speech had them, why it matters, what was',
  '  decided and by whom, what happens next. False if a decision or an owner',
  '  was said and is missing. True when the speech settled nothing and the',
  '  notes correctly say little.',
  '- topics: headings match the discussion. False if a new heading was opened',
  '  for a topic already present, or if the speech clearly changed subject and',
  '  everything was still filed under the old heading.',
  '- guesses: anything uncertain is marked "(unconfirmed)" rather than',
  '  asserted. False if the notes state as fact something the speech left',
  '  ambiguous or garbled. True if there was nothing uncertain.',
  '- together: related points sit together rather than being repeated or',
  '  scattered. False if the same point now appears twice in different places.',
].join('\n');

/**
 * The judge's answer as a TOOL rather than as prose to be parsed.
 *
 * Two runs were lost to the judge writing its way past a token budget and
 * truncating the JSON mid-object. The obvious fix — prefill the opening
 * brace — this model refuses outright ("does not support assistant message
 * prefill"). A forced tool call is the shape the API itself enforces, so
 * there is no reply to parse and no way to half-answer.
 */
const VERDICT_TOOL = {
  name: 'record_verdict',
  description: 'Record one verdict, with its reason, for each behaviour graded.',
  input_schema: {
    type: 'object' as const,
    properties: Object.fromEntries(
      ['paraphrased', 'covers', 'topics', 'guesses', 'together'].map((field) => [
        field,
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            why: { type: 'string', description: 'At most twelve words, or empty when ok.' },
          },
          required: ['ok', 'why'],
        },
      ]),
    ),
    required: ['paraphrased', 'covers', 'topics', 'guesses', 'together'],
  },
};

/**
 * Why judge replies could not be read, this run.
 *
 * A judge that answers unusably is not evidence about the note-taker, so its
 * tick is dropped — and a drop that says nothing is how five behaviours
 * quietly fell to twelve examples each. Collected here and printed with the
 * report, so a sample that shrank says why.
 */
const judgeUnread = new Set<string>();

/** One judged behaviour: did it hold, and why not. */
interface JudgedField {
  ok: boolean;
  why: string;
}

async function judge(
  key: string,
  before: string,
  after: string,
  transcript: string,
): Promise<Record<string, JudgedField> | null> {
  const user = [
    `Speech in this moment:\n${transcript}`,
    `Notes before:\n${before || '(none yet)'}`,
    `Notes after:\n${after}`,
    // Without this the judge marks the note-taker down for the seeded human
    // line — it reads as an off-topic bullet, which is exactly what it is,
    // and the note-taker is forbidden from touching it. Grading it would
    // score the fixture rather than the behaviour.
    `One bullet was typed by a person and the note-taker may not change it. It is not its work and is not to be graded:\n- ${HUMAN_LINE}`,
  ].join('\n\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      // Five verdicts each carrying their own sentence. 300 was the budget
      // for ONE reason and it silently truncated the JSON of the five-reason
      // reply, which failed to parse, which returned null, which dropped the
      // tick — taking the judged behaviours from 32 examples to 12 with
      // nothing in the output saying so. Sized for the reply that is now
      // asked for, and a truncation is reported rather than dropped.
      max_tokens: 900,
      system: JUDGE_SYSTEM,
      tools: [VERDICT_TOOL],
      tool_choice: { type: 'tool', name: VERDICT_TOOL.name },
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    // The status only. A body can echo the prompt, and the prompt carries
    // meeting speech. This line used to be a bare `return null`, which is how
    // a run once reported no judged examples and no reason for it.
    judgeUnread.add(`the judge call returned HTTP ${res.status}`);
    return null;
  }
  const body = (await res.json()) as {
    content?: Array<{ type?: string; name?: string; input?: unknown }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  recordUsage(JUDGE_MODEL, body.usage?.input_tokens ?? 0, body.usage?.output_tokens ?? 0);
  const call = body.content?.find((b) => b.type === 'tool_use' && b.name === VERDICT_TOOL.name);
  if (!call?.input || typeof call.input !== 'object') {
    judgeUnread.add(
      body.stop_reason === 'max_tokens'
        ? 'the judge ran out of output tokens before recording a verdict'
        : 'the judge answered without calling record_verdict',
    );
    return null;
  }
  const out: Record<string, JudgedField> = {};
  for (const [field, value] of Object.entries(call.input as Record<string, unknown>)) {
    // The schema requires the object form, but a schema is a request and this
    // reads whatever actually arrived: a bare boolean is still an answer, and
    // dropping the tick over the wrapper would shrink the sample silently.
    if (typeof value === 'boolean') out[field] = { ok: value, why: '' };
    else if (value && typeof value === 'object') {
      const o = value as { ok?: unknown; why?: unknown };
      out[field] = { ok: o.ok === true, why: typeof o.why === 'string' ? o.why : '' };
    }
  }
  return out;
}

/* ===== The run ===== */

interface Options {
  smoke: boolean;
  meetings: string[];
  judgePerMeeting: number;
  key: string;
}

function loadFixtures(only: readonly string[]): NotesEvalFixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as NotesEvalFixture)
    .filter((f) => only.length === 0 || only.includes(f.meeting))
    .sort((a, b) => a.meeting.localeCompare(b.meeting));
}

/** `/workspaces/w-eval?task=t-3` → `t-3`, so the harness rebuilds the row's
 *  URL exactly as the fixture's board states it. */
function taskIdOf(url: string): string {
  return new URL(url, 'http://x').searchParams.get('task') ?? url;
}

async function runMeeting(
  fixture: NotesEvalFixture,
  opts: Options,
  behaviours: Record<string, Behaviour>,
  ticksWanted: number,
): Promise<void> {
  const composer = createHaikuNotesComposer({
    apiKey: opts.key,
    fetchImpl: countingFetch(NOTES_MODEL),
  });
  if (!composer) throw new Error('no composer: the dedicated key did not resolve');

  const ticks = fixture.ticks.slice(0, ticksWanted);
  // Which ticks the model judge reads. Spread across the meeting rather than
  // taken from the front: the first ticks of a meeting are its easiest, and a
  // judge that only ever saw them would report on a meeting that had not
  // started.
  const step = Math.max(1, Math.floor(ticks.length / Math.max(1, opts.judgePerMeeting)));
  const judged = new Set(
    Array.from({ length: opts.judgePerMeeting }, (_, i) => i * step).filter(
      (i) => i < ticks.length,
    ),
  );

  const harness = createNotesTickHarness({
    doc: `## Meeting notes\n\n- ${HUMAN_LINE}\n`,
    docTitle: `${fixture.meeting} (AMI)`,
    workspaceId: 'w-eval',
    tasks: fixture.board.map((b) => ({ id: taskIdOf(b.url), title: b.title, status: 'todo' })),
    // A real compose, and its reply grows with the notes: by the twentieth
    // tick of a meeting the model is rewriting two pages. The composer's own
    // timeout is 30s and this has to sit above it, or a tick that WOULD have
    // landed is recorded as a failure and every tick behind it fails too —
    // the composes are serialized on one chain.
    tickTimeoutMs: 60_000,
    compose: (input: NotesComposeInput) => composer.compose(input),
  });

  let before = '';
  // Ticks whose compose never ran. Counted and reported rather than assumed
  // away: a run that quietly measured 250 of 273 ticks would still print a
  // pass rate, and the rate would be over a sample nobody could see.
  //
  // These are composes that FAILED — a timeout, or the API refusing. The
  // words are not lost: a failed compose carries its turns into the next
  // tick, which is what the live pipeline does too. What is lost is the tick
  // as an EXAMPLE, which is why the count is printed next to the totals and
  // the reasons are printed under them.
  let uncomposed = 0;
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    const transcript = tick.turns.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    let shot: Awaited<ReturnType<typeof harness.tick>>;
    try {
      shot = await harness.speak(...tick.turns.map((t) => ({ speaker: t.speaker, text: t.text })));
    } catch (err) {
      // A refused or timed-out compose is a fact about the run, not about the
      // behaviour: it is reported and the tick is not counted as an example.
      console.error(`  ${fixture.meeting} tick ${i + 1}: compose failed — ${String(err)}`);
      continue;
    }
    const notes = shot.notes;
    const where = `${fixture.meeting} tick ${i + 1}`;
    if (!shot.input) uncomposed++;
    const references = (shot.input?.references ?? []) as readonly NoteReference[];

    /* --- 1.1 readability, the decidable half --- */
    const over = overlongBullets(notes);
    behaviours.length!.see(
      {
        ok: over.length === 0,
        detail: over.map((o) => `${o.words}w: ${o.bullet.slice(0, 60)}`).join(' | '),
      },
      where,
    );
    const copied = verbatimBullets(notes, transcript);
    behaviours.verbatim!.see({ ok: copied.length === 0, detail: copied[0]?.slice(0, 80) }, where);

    /* --- 1.2 a person's bullet is untouched --- */
    behaviours.human!.see(
      {
        ok: notes.includes(HUMAN_LINE),
        detail: 'the seeded human bullet is no longer in the accepted notes',
      },
      where,
    );

    /* --- 1.3 one heading per topic --- */
    const dupes = duplicateTopics(notes);
    behaviours.oneHeading!.see({ ok: dupes.length === 0, detail: dupes.join(', ') }, where);
    // A tick with enough notes to organise but no heading at all is a flat
    // list, which is the shape this behaviour replaced. Fewer than four
    // bullets is not yet a document with topics in it.
    const bullets = allBullets(notes).length;
    behaviours.organised!.see(
      bullets < 4
        ? null
        : {
            ok: parseNotesTopics(notes).some((t) => t.heading.length > 0),
            detail: `${bullets} bullets and no topic heading`,
          },
      where,
    );

    /* --- 1.4 reference hygiene --- */
    behaviours.links!.see(
      references.length === 0
        ? null
        : (() => {
            const missed = unlinkedReferences(notes, references);
            return { ok: missed.length === 0, detail: `not linked: ${missed.join(', ')}` };
          })(),
      where,
    );
    const unattributed = decisionsWithoutSpeaker(notes);
    behaviours.speakers!.see(
      { ok: unattributed.length === 0, detail: unattributed[0]?.slice(0, 80) },
      where,
    );

    /* --- the model's half --- */
    if (judged.has(i) && opts.judgePerMeeting > 0) {
      const verdict = await judge(opts.key, before, notes, transcript);
      if (verdict) {
        for (const [key, id] of [
          ['paraphrased', 'paraphrase'],
          ['covers', 'covers'],
          ['topics', 'topicChange'],
          ['guesses', 'unconfirmed'],
          ['together', 'together'],
        ] as const) {
          // A field the judge did not answer is not an example of anything.
          // Scoring it as a failure would grade the judge's JSON, not the
          // note-taker.
          const field = verdict[key];
          if (!field) continue;
          behaviours[id]!.see({ ok: field.ok, detail: field.why }, where);
        }
      }
    }
    before = notes;
  }
  await harness.end();

  const marked = unconfirmedBullets(harness.notes()).length;
  console.log(
    `  ${fixture.meeting}: ${ticks.length} ticks, ${allBullets(harness.notes()).length} bullets, ` +
      `${parseNotesTopics(harness.notes()).filter((t) => t.heading).length} topics, ` +
      `${marked} marked unconfirmed` +
      (uncomposed > 0 ? `, ${uncomposed} never composed` : ''),
  );
  // Distinct reasons, not one line per failure: twenty timeouts are one fact
  // about the run, and printing them twenty times buries the meeting totals.
  for (const reason of new Set(harness.errors)) {
    console.log(`    ${fixture.meeting}: ${reason}`);
  }
}

function report(behaviours: Record<string, Behaviour>): number {
  console.log('\nBehaviour                                  examples   pass rate');
  console.log('-'.repeat(66));
  let thin = 0;
  for (const b of Object.values(behaviours)) {
    const rate = b.examples === 0 ? '     —' : `${(b.rate * 100).toFixed(0).padStart(5)}%`;
    console.log(`${b.what.padEnd(42)} ${String(b.examples).padStart(8)}   ${rate}`);
    if (b.examples < 25) thin++;
  }
  console.log('-'.repeat(66));
  for (const b of Object.values(behaviours)) {
    if (b.failures.length === 0) continue;
    console.log(`\n${b.what} — ${b.failures.length} failures, first five:`);
    for (const f of b.failures.slice(0, 5)) console.log(`  ${f}`);
  }
  if (judgeUnread.size > 0) {
    console.log('\nJudge replies that could not be read (their ticks are not examples):');
    for (const reason of judgeUnread) console.log(`  ${reason}`);
  }
  console.log('\nSpend:');
  for (const [model, u] of Object.entries(usage)) {
    const price = PRICES[model];
    const cost = price ? u.input * price.input + u.output * price.output : 0;
    console.log(
      `  ${model}: ${u.calls} calls, ${u.input} in / ${u.output} out, $${cost.toFixed(4)}`,
    );
  }
  console.log(`  total: $${totalCost().toFixed(4)}`);
  if (thin > 0) console.log(`\n${thin} behaviour(s) saw fewer than 25 examples.`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const smoke = argv.includes('--smoke');
  const at = argv.indexOf('--meeting');
  const meetings = at >= 0 && argv[at + 1] ? [argv[at + 1]!] : [];
  const keyAt = argv.indexOf('--api-key');
  const judgeAt = argv.indexOf('--judge');
  const judgeOff = judgeAt >= 0 && argv[judgeAt + 1] === 'off';
  const key = resolveKeyFrom(keyAt >= 0 ? argv[keyAt + 1] : undefined, readKeychainPassword);
  if (!key) {
    console.error(
      'No dedicated key. Set CW_SUMMARY_API_KEY, put one in the Keychain as\n' +
        'claude-workspaces-summary-api-key, or pass --api-key. Nothing was run.',
    );
    return 2;
  }

  const behaviours: Record<string, Behaviour> = {
    length: new Behaviour('1.1', 'Bullets: 20 words or fewer'),
    verbatim: new Behaviour('1.1', 'Bullets: not copied from the transcript'),
    paraphrase: new Behaviour('1.1', 'Paraphrased into written sentences'),
    covers: new Behaviour('1.1', 'Covers discussed / decided / next'),
    together: new Behaviour('1.1', 'Related points kept together'),
    human: new Behaviour('1.2', "A person's bullet is never edited"),
    oneHeading: new Behaviour('1.3', 'One heading per topic'),
    organised: new Behaviour('1.3', 'Notes are organised under topics'),
    topicChange: new Behaviour('1.3', 'A new heading means a new topic'),
    links: new Behaviour('1.4', 'A named board row is linked'),
    speakers: new Behaviour('1.4', 'Decisions and questions keep a speaker'),
    unconfirmed: new Behaviour('1.4', 'Uncertain points marked unconfirmed'),
  };

  const fixtures = loadFixtures(smoke ? ['ES2002a'] : meetings);
  if (fixtures.length === 0) throw new Error('No fixtures matched. Run notes-eval-fixtures.ts?');
  const opts: Options = {
    smoke,
    meetings,
    // The smoke slice judges ONE tick: the CI job is there to prove the
    // harness still runs end to end, not to measure anything.
    judgePerMeeting: judgeOff ? 0 : smoke ? 1 : 6,
    key,
  };
  const ticksWanted = smoke ? 3 : Number.POSITIVE_INFINITY;

  console.log(
    `${smoke ? 'Smoke slice' : 'Full run'}: ${fixtures.length} meeting(s), ` +
      `notes on ${NOTES_MODEL}, judge ${opts.judgePerMeeting > 0 ? JUDGE_MODEL : 'off'}`,
  );
  for (const fixture of fixtures) await runMeeting(fixture, opts, behaviours, ticksWanted);
  return report(behaviours);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
