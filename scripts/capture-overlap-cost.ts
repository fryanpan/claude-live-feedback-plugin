import type { NotesTurn } from '../packages/server/src/meeting-notes.ts';
/**
 * What the tick-boundary overlap costs per capture pass.
 *
 * The task-capture prompt now also carries the tail of the previous tick,
 * marked as already read (`overlapWindow` in meeting-task-capture.ts). That
 * is speech the model reads a second time, on every tick, for the whole
 * meeting — so the size of it is a number worth having rather than
 * estimating. This prints it, measured by the token counter the capture call
 * itself is billed by, not by dividing characters by four.
 *
 *   bun run scripts/capture-overlap-cost.ts
 *
 * It needs the same dedicated key the capture pass uses (Keychain or
 * `--api-key`), and it is FREE: /v1/messages/count_tokens counts, it does not
 * generate. With no key it still prints the character delta and says that the
 * token figures are estimates.
 *
 * The transcript below is invented. The repo is public.
 */
import {
  OVERLAP_MAX_CHARS,
  OVERLAP_MAX_TURNS,
  OVERLAP_PROMPT_RULE,
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

/** A boundary tick: the ask, with its subject one tick back. */
const tick: NotesTurn[] = [
  {
    turn: 42,
    speaker: 'Priya',
    text: 'Can you file a ticket for that one? A small spike would do.',
  },
  {
    turn: 43,
    speaker: 'Marcus',
    text: 'Yes, and let us look at the export dialog while we are there.',
  },
];

/** A realistic previous tick — longer than the window, so this measures the
 *  window's ceiling rather than one lucky short sentence. */
const prior: NotesTurn[] = [
  {
    turn: 39,
    speaker: 'Marcus',
    text: 'We walked through the whole invite flow again this morning.',
  },
  { turn: 40, speaker: 'Priya', text: 'The badge is counting invites nobody ever accepted.' },
  {
    turn: 41,
    speaker: 'Priya',
    text: 'And the sync retries every ninety seconds on top of that, which is the real cost.',
  },
];

interface Counted {
  system: number;
  user: number;
  total: number;
}

async function countTokens(key: string, system: string, user: string): Promise<Counted> {
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
  const body = (await res.json()) as { input_tokens: number };
  // Split system vs user with a second count so the standing instruction and
  // the per-tick speech can be told apart.
  const sysOnly = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, system, messages: [{ role: 'user', content: '.' }] }),
  });
  const sysBody = (await sysOnly.json()) as { input_tokens: number };
  return {
    system: sysBody.input_tokens,
    user: body.input_tokens - sysBody.input_tokens,
    total: body.input_tokens,
  };
}

async function main(): Promise<void> {
  const flagKey = process.argv.includes('--api-key')
    ? process.argv[process.argv.indexOf('--api-key') + 1]
    : undefined;
  const key = resolveKeyFrom(flagKey, readKeychainPassword);

  // The baseline is the prompt as it was BEFORE the boundary window: no
  // earlier lines, and no standing rule about them either. Both halves are
  // paid on every tick, so both belong in the delta.
  const rule = `\n${OVERLAP_PROMPT_RULE.join('\n')}\n`;
  const built = buildTaskCapturePrompt({ turns: tick, candidates });
  const without = { system: built.system.replace(rule, '\n'), user: built.user };
  const with_ = buildTaskCapturePrompt({ turns: tick, priorTurns: prior, candidates });
  if (without.system === built.system) throw new Error('baseline strip found no rule to remove');
  const chars = (p: { system: string; user: string }): number => p.system.length + p.user.length;

  console.log(`window budget: ${OVERLAP_MAX_CHARS} chars / ${OVERLAP_MAX_TURNS} turns`);
  console.log(
    `characters: ${chars(without)} → ${chars(with_)}  (+${chars(with_) - chars(without)})`,
  );

  if (!key) {
    console.log('no dedicated key — token figures are chars/4 ESTIMATES, not measurements:');
    console.log(`  ~+${Math.round((chars(with_) - chars(without)) / 4)} tokens per tick`);
    return;
  }
  const a = await countTokens(key, without.system, without.user);
  const b = await countTokens(key, with_.system, with_.user);
  console.log(`measured on ${MODEL} (count_tokens):`);
  console.log(`  system: ${a.system} → ${b.system}  (+${b.system - a.system})`);
  console.log(`  user:   ${a.user} → ${b.user}  (+${b.user - a.user})`);
  console.log(`  total:  ${a.total} → ${b.total}  (+${b.total - a.total} tokens per tick)`);
}

await main();
