/**
 * The spoken status brief: what a person hears when they ask "where are we".
 *
 * Split out of `voice-resolve.ts` (A6), which resolves WHICH thing an
 * utterance means. Composing an answer is the opposite direction and shares
 * nothing with it — no tokens, no similarity, no candidates — so the two
 * only ever sat together because both are things the server can do without
 * a model.
 *
 * Composed from the store, never from a model. Segments in priority order,
 * each dropped whole from the tail until the total fits, then a hard word cap
 * as the last resort — because a sentence cut in half is worse than a
 * sentence left out. `countWords` and `capWords` are ONE predicate for
 * counting and for cutting: they once disagreed, and a brief that counted as
 * 100 words could still end in an ellipsis.
 */
import type { TaskStatus } from './tasks.ts';

/** The one number Bryan named: *"that should be able to show me a 100 word
 *  message."* The composer stays under it; the client's strip holds it. */
export const VOICE_STATUS_MAX_WORDS = 100;

/** A token that counts as a word: has a letter or digit in it. "—" and "→"
 *  are punctuation the composer puts between words, not words. ONE predicate
 *  for counting and for cutting — they once disagreed, and a brief that
 *  counted as 100 words could still be cut mid-sentence. */
const isWord = (token: string): boolean => /[a-z0-9]/i.test(token);

export function countWords(text: string): number {
  return text.split(/\s+/).filter(isWord).length;
}

/** Cut `text` to `max` words on a word boundary, marking the cut. Counted
 *  the way `countWords` counts, so a text it calls `max` words is not cut. */
export function capWords(text: string, max: number): string {
  const tokens = text.trim().split(/\s+/);
  let seen = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i] ?? '')) continue;
    seen++;
    if (seen === max && tokens.slice(i + 1).some(isWord)) {
      return `${tokens.slice(0, i + 1).join(' ')}…`;
    }
  }
  return text.trim();
}

export interface StatusTask {
  id: string;
  title: string;
  status: TaskStatus | string;
  assignee: string;
  needs?: string;
  doneAt?: number;
  lastMove?: { from: string; to: string; by: string; ts: number };
  links?: number;
}

export interface StatusQueueRow {
  title: string;
  ask: string;
  askedBy: string;
}

export interface StatusInput {
  workspaceName: string;
  tasks: StatusTask[];
  /** What is waiting on a person, board-wide. */
  queue: StatusQueueRow[];
  now: number;
  /** The task in view, when there is one — the summary is about IT first. */
  task?: StatusTask;
  /** The doc in view, when there is one. */
  doc?: { title: string; asks: StatusQueueRow[] };
}

/** "3h ago" — coarse on purpose; a status read aloud has no use for seconds. */
export function ago(ts: number, now: number): string {
  const min = Math.max(0, Math.round((now - ts) / 60_000));
  if (min < 2) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const STATUS_LABEL: Record<string, string> = {
  'in-progress': 'in progress',
  todo: 'to do',
  done: 'done',
  triage: 'in triage',
};

function quote(text: string, maxWords: number): string {
  return `“${capWords(text, maxWords)}”`;
}

function listTitles(items: Array<{ title: string }>, max: number): string {
  const shown = items.slice(0, max).map((t) => quote(t.title, 8));
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * The brief, composed from the store — never from a model.
 *
 * Segments in priority order, each dropped whole from the tail until the
 * total fits; then a hard word cap as the last resort. The order is what a
 * person asking "where are we" wants first: the thing in view, what is in
 * progress, what is waiting on THEM, what just shipped.
 */
export function composeStatus(input: StatusInput): string {
  const { tasks, queue, now } = input;
  const segments: string[] = [];

  if (input.task) {
    const t = input.task;
    const parts = [`${quote(t.title, 12)} is ${STATUS_LABEL[t.status] ?? t.status}`];
    parts.push(t.assignee ? `with ${t.assignee}` : 'unassigned');
    if (t.needs) parts.push(`needs ${t.needs}`);
    segments.push(`${parts.join(', ')}.`);
    if (t.lastMove) {
      segments.push(
        `Last move: ${STATUS_LABEL[t.lastMove.from] ?? t.lastMove.from} → ${STATUS_LABEL[t.lastMove.to] ?? t.lastMove.to} by ${t.lastMove.by}, ${ago(t.lastMove.ts, now)}.`,
      );
    }
    const asks = queue.filter((q) => q.title === t.title);
    segments.push(
      asks.length > 0
        ? `Waiting on you: ${asks
            .slice(0, 2)
            .map((a) => quote(a.ask, 12))
            .join('; ')}.`
        : 'Nothing waiting on you here.',
    );
    if (t.links) segments.push(`${t.links} linked ${t.links === 1 ? 'doc' : 'docs'}.`);
  } else if (input.doc) {
    const d = input.doc;
    segments.push(
      d.asks.length > 0
        ? `${quote(d.title, 10)}: ${d.asks.length} waiting on you — ${d.asks
            .slice(0, 2)
            .map((a) => `${quote(a.ask, 12)} (${a.askedBy})`)
            .join('; ')}.`
        : `${quote(d.title, 10)}: nothing waiting on you.`,
    );
  }

  const open = tasks.filter((t) => t.status !== 'done');
  const inProgress = open.filter((t) => t.status === 'in-progress');
  const todo = open.filter((t) => t.status !== 'in-progress');
  const done = tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));

  if (!input.task) {
    segments.push(
      `${input.workspaceName}: ${open.length} open — ${inProgress.length} in progress, ${todo.length} to do, ${done.length} done.`,
    );
  }
  if (inProgress.length > 0 && (!input.task || inProgress.some((t) => t.id !== input.task?.id))) {
    segments.push(`In progress: ${listTitles(inProgress, 3)}.`);
  }
  if (!input.task && !input.doc) {
    segments.push(
      queue.length > 0
        ? `Waiting on you: ${queue.length} — ${queue
            .slice(0, 2)
            .map((q) => `${quote(q.ask, 10)} on ${quote(q.title, 6)}`)
            .join('; ')}.`
        : 'Nothing waiting on you.',
    );
  }
  if (done.length > 0) {
    const newest = done[0];
    segments.push(
      `Done recently: ${listTitles(done, 3)}${newest?.doneAt ? ` (latest ${ago(newest.doneAt, now)})` : ''}.`,
    );
  }

  // Drop whole trailing segments until the cap holds — a sentence cut in half
  // is worse than a sentence left out. Always keep the first.
  let kept = segments.slice();
  while (kept.length > 1 && countWords(kept.join(' ')) > VOICE_STATUS_MAX_WORDS)
    kept = kept.slice(0, -1);
  return capWords(kept.join(' '), VOICE_STATUS_MAX_WORDS);
}
