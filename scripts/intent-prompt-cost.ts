/**
 * What the research and lookup intents cost the capture prompt, per tick.
 *
 * The 2026-08-30 decision ("One call per tick carries every intent") priced a
 * new intent at ~58 input and ~21 output tokens when it rides the existing
 * call, against seven to twenty-seven times that as its own always-on pass.
 * The two intents added here are the first to be added under that decision,
 * so the number is worth measuring rather than inheriting: this prints the
 * input side, measured by the same token counter the call is billed by.
 *
 *   bun run scripts/intent-prompt-cost.ts
 *
 * Same key and same cost as `capture-overlap-cost.ts`: the dedicated capture
 * key (Keychain or `--api-key`), and /v1/messages/count_tokens counts rather
 * than generates, so running it is free. With no key it prints the character
 * delta and says the token figures are estimates.
 *
 * The output side is NOT measured here. An intent's output tokens are what
 * the model chooses to say, so they are a property of real meetings, not of
 * a prompt — the empty answer this pass gives on most ticks costs nothing at
 * all, and the tick that carries a research ask is the one worth pricing.
 *
 * The transcript below is invented. The repo is public.
 */
import type { NotesTurn } from '../packages/server/src/meeting-notes.ts';
import {
  LOOKUP_PROMPT_RULE,
  RESEARCH_PROMPT_RULE,
  buildTaskCapturePrompt,
} from '../packages/server/src/meeting-task-capture.ts';
import { readKeychainPassword } from '../packages/server/src/share/keychain.ts';
import { resolveKeyFrom } from '../packages/server/src/summarize.ts';

const MODEL = 'claude-haiku-4-5-20251001';

const candidates = [
  { id: 't-1', title: 'Lantern badge counts stale invites', status: 'todo' as const },
  { id: 't-2', title: 'Export dialog forgets the chosen range', status: 'in-progress' as const },
  { id: 't-3', title: 'Retry loop wakes the sync every ninety seconds', status: 'todo' as const },
];

/** A tick carrying both new intents, which is the tick worth pricing. */
const tick: NotesTurn[] = [
  { turn: 51, speaker: 'Priya', text: 'Can somebody go look into why the retry loop wakes it?' },
  { turn: 52, speaker: 'Marcus', text: "And pull in last week's notes while you are at it." },
];

async function countTokens(key: string, system: string, user: string): Promise<number> {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`count_tokens HTTP ${res.status}`);
  return ((await res.json()) as { input_tokens: number }).input_tokens;
}

/**
 * The prompt as it read BEFORE an intent existed: its rule block removed,
 * and its line struck from the JSON shape. Both are standing text paid on
 * every tick, so both belong in the delta.
 */
function without(system: string, rule: readonly string[], shapeLines: readonly string[]): string {
  let out = system.replace(`\n${rule.join('\n')}\n`, '\n');
  if (out === system) throw new Error('baseline strip found no rule to remove');
  for (const line of shapeLines) {
    const next = out.replace(`${line}\n`, '');
    if (next === out) throw new Error(`baseline strip found no shape line: ${line}`);
    out = next;
  }
  return out;
}

const RESEARCH_SHAPE = [
  '         |{"kind":"research","topic":"...","question":"...",',
  '           "requester":"who asked, omitted if unclear"}',
];
const LOOKUP_SHAPE = ['         |{"kind":"lookup","query":"..."}]}'];

async function main(): Promise<void> {
  const flagKey = process.argv.includes('--api-key')
    ? process.argv[process.argv.indexOf('--api-key') + 1]
    : undefined;
  const key = resolveKeyFrom(flagKey, readKeychainPassword);

  const built = buildTaskCapturePrompt({ turns: tick, candidates });
  const noLookup = without(built.system, LOOKUP_PROMPT_RULE, LOOKUP_SHAPE);
  const neither = without(noLookup, RESEARCH_PROMPT_RULE, RESEARCH_SHAPE);

  const stages: Array<[string, string]> = [
    ['requests + references only', neither],
    ['+ research', noLookup],
    ['+ lookup (shipped)', built.system],
  ];

  console.log('system prompt, characters:');
  let prevChars = 0;
  for (const [label, system] of stages) {
    const n = system.length;
    console.log(`  ${label}: ${n}${prevChars ? `  (+${n - prevChars})` : ''}`);
    prevChars = n;
  }

  if (!key) {
    console.log('\nno dedicated key — token figures would be chars/4 ESTIMATES, so:');
    console.log(`  ~+${Math.round((built.system.length - neither.length) / 4)} tokens per tick`);
    console.log('  run with the capture key for the measured number.');
    return;
  }

  console.log(`\nmeasured on ${MODEL} (count_tokens), whole prompt:`);
  let prev = 0;
  for (const [label, system] of stages) {
    const n = await countTokens(key, system, built.user);
    console.log(`  ${label}: ${n}${prev ? `  (+${n - prev})` : ''}`);
    prev = n;
  }
}

await main();
