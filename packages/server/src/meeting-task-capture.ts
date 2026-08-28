/**
 * Tasks captured from meeting speech: hear "we should file a ticket for
 * that" and the board grows the ticket; hear "we already track that" and the
 * notes link the row that tracks it.
 *
 * WHY THE GUARDS OUTNUMBER THE FEATURE. Everything here feeds links into the
 * composed meeting notes, and a wrong link is worse than no link — it puts
 * the board's authority behind a connection nobody made. So the model's
 * answer is never trusted on its own: a reference must name a candidate the
 * transcript actually mentioned (`tickMentionsCandidate`), a request that
 * duplicates a tracked task becomes a reference to it instead of a twin row
 * (`requestMatchesCandidate`), and anything malformed is dropped in silence.
 * The transcript file remains the durable record either way; a capture pass
 * that misses is a missed convenience, not lost data.
 *
 * SAME CONSENT SEAM AS THE NOTES COMPOSER. The transcript text leaves the
 * machine on this call exactly as it does on the compose call, so the key is
 * the same dedicated one (`resolveKeyFrom`), a generic ANTHROPIC_API_KEY is
 * not honoured, and no key means capture stays off — a settled state the
 * caller logs, not an error.
 *
 * "GO DO IT" IS DELIBERATELY THE BOARD'S OWN PATH. An actionable request is
 * placed in the chores band, transitioned to `todo`, and the lead is woken
 * through the ready-nudge channel — this module never claims `in-progress`
 * itself. The chip in the notes shows live status, so it flips only when the
 * lead's dispatch actually happens, and it stays honest if that never does.
 */

import { readRenamedEnv } from '@feedback/core/env-names';
import type { NoteTaskLink, NotesTurn } from './meeting-notes.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';
import { clipToWordBoundary } from './task-title.ts';
import { CHORES_GOAL_ID, type CreateTaskOpts, type TaskStatus } from './tasks.ts';

/** One open (or recently closed) board row, as the extractor may see it. */
export interface TaskCaptureCandidate {
  id: string;
  title: string;
  status: TaskStatus;
}

/** A new task the speech explicitly asked for. */
export interface CapturedRequest {
  kind: 'request';
  title: string;
  /** Clear and doable as spoken — the store may set it moving. */
  actionable: boolean;
}

/** Speech that referred to work the board already tracks. */
export interface CapturedReference {
  kind: 'reference';
  taskId: string;
}

export type CapturedItem = CapturedRequest | CapturedReference;

export interface TaskCaptureInput {
  turns: readonly NotesTurn[];
  candidates: readonly TaskCaptureCandidate[];
  docTitle?: string;
}

export interface TaskCaptureExtractor {
  readonly name: string;
  /** Items already parsed and guard-checked; empty is the ordinary answer. */
  extract(input: TaskCaptureInput): Promise<CapturedItem[]>;
}

/**
 * Who the captured rows belong to. An agent identity on the
 * `PARK_MIGRATION_ACTOR` pattern: no human filed the row, and the owner gate
 * refuses the bare generic word — a named agent is what "the meeting
 * assistant filed this" looks like in the audit trail.
 */
export const MEETING_CAPTURE_ACTOR = {
  id: 'agent-meeting-assistant',
  name: 'Meeting Assistant',
  kind: 'agent',
} as const;

/** Longest title a captured request may carry — the board's own title cap. */
const TITLE_MAX = 80;

/** How many board rows the extractor prompt may carry, mirroring the notes
 *  context cap: enough to match against, few enough that a thousand-row
 *  board cannot flood the prompt. */
export const MAX_CAPTURE_CANDIDATES = 40;

/**
 * Words too common to prove two texts are about the same thing. Includes the
 * meta-vocabulary of asking for tickets — "file a ticket for that task"
 * shares those words with EVERY candidate row.
 */
const STOPWORDS = new Set([
  'about',
  'actually',
  'after',
  'again',
  'also',
  'been',
  'before',
  'board',
  'could',
  'demo',
  'does',
  'doing',
  'file',
  'fixed',
  'from',
  'going',
  'gonna',
  'have',
  'into',
  'just',
  'know',
  'like',
  'last',
  'made',
  'make',
  'makes',
  'more',
  'need',
  'needs',
  'next',
  'okay',
  'only',
  'other',
  'over',
  'pretty',
  'really',
  'right',
  'should',
  'small',
  'some',
  'still',
  'sure',
  'task',
  'that',
  'them',
  'then',
  'there',
  'they',
  'thing',
  'things',
  'think',
  'this',
  'ticket',
  'under',
  'very',
  'want',
  'wants',
  'week',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'would',
  'yeah',
  'your',
]);

function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

function sharedWordCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * Did this pause's speech mention the candidate at all? One significant word
 * in common is the floor a model-claimed reference must clear — the model
 * matches, this proves the match came from the words rather than from the
 * candidate list itself.
 */
export function tickMentionsCandidate(turns: readonly NotesTurn[], title: string): boolean {
  const spoken = significantWords(turns.map((t) => t.text).join(' '));
  return sharedWordCount(spoken, significantWords(title)) >= 1;
}

/**
 * Is a requested task the same work as a tracked row? Two significant words,
 * not one: one shared word is a mention ("popover styling" vs the popover
 * anchor bug), two is the same subject twice. Errs toward creating a
 * near-duplicate over silently folding distinct work into the wrong row —
 * a duplicate is visible and mergeable, a mislink is neither.
 */
export function requestMatchesCandidate(title: string, candidateTitle: string): boolean {
  return sharedWordCount(significantWords(title), significantWords(candidateTitle)) >= 2;
}

/** The board deep link `parseWorkspaceLink` reads back as `kind: 'task'` —
 *  root-relative, so it survives being read under any host the server has. */
export function taskCaptureUrl(workspaceId: string, taskId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(taskId)}`;
}

/**
 * Prompt building is pure and exported, same reason as the notes composer's:
 * what the transcript is asked to become is behaviour worth pinning without
 * a network in the test.
 */
export function buildTaskCapturePrompt(input: TaskCaptureInput): { system: string; user: string } {
  const system = [
    'You listen to a live working meeting and extract exactly two things:',
    'task REQUESTS and task REFERENCES. Answer with JSON only, this shape:',
    '{"items":[{"kind":"request","title":"...","actionable":true|false}',
    '         |{"kind":"reference","match":<candidate number>}]}',
    '',
    'A REQUEST only when a speaker explicitly asks for work to be tracked or',
    'filed — "file a ticket", "let\'s track that", "add it to the board",',
    '"can you create a task". Discussing a problem, complaining about a bug,',
    'or agreeing something is broken is NOT a request. Title: short,',
    'specific, in the words spoken.',
    'Mark a request "actionable": true only when it is clear enough to start',
    'without asking anything back — what to do and where — and nobody said',
    'to wait. When in doubt, false.',
    '',
    'A REFERENCE only when the speech clearly refers to work in the numbered',
    'candidate list; "match" is that number. Never guess: no confident match',
    'means no item.',
    '',
    'An empty items array is the normal answer for most speech.',
  ].join('\n');

  const parts: string[] = [];
  if (input.docTitle) parts.push(`Meeting doc: ${input.docTitle}`);
  if (input.candidates.length > 0) {
    parts.push(
      `Board tasks (candidates for "reference"):\n${input.candidates
        .map((c, i) => `${i}. ${c.title}`)
        .join('\n')}`,
    );
  }
  parts.push(`Speech since the last update:\n${input.turns.map((t) => `- ${t.text}`).join('\n')}`);
  return { system, user: parts.join('\n\n') };
}

/**
 * A model reply → guarded items. Strict by construction: malformed rows,
 * out-of-range matches, and references the transcript cannot vouch for are
 * dropped row by row, never letting one bad row cost the good ones.
 */
export function parseTaskCaptureReply(
  raw: string,
  candidates: readonly TaskCaptureCandidate[],
  turns: readonly NotesTurn[],
): CapturedItem[] {
  let text = raw.trim();
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const out: CapturedItem[] = [];
  const seenTasks = new Set<string>();
  const seenTitles = new Set<string>();
  for (const entry of items) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (row.kind === 'reference') {
      if (typeof row.match !== 'number' || !Number.isInteger(row.match)) continue;
      const candidate = row.match >= 0 ? candidates[row.match] : undefined;
      if (!candidate) continue;
      // The transcript must vouch for the match — see tickMentionsCandidate.
      if (!tickMentionsCandidate(turns, candidate.title)) continue;
      if (seenTasks.has(candidate.id)) continue;
      seenTasks.add(candidate.id);
      out.push({ kind: 'reference', taskId: candidate.id });
    } else if (row.kind === 'request') {
      if (typeof row.title !== 'string' || row.title.trim().length === 0) continue;
      const title = clipToWordBoundary(row.title.trim(), TITLE_MAX);
      const key = title.toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      out.push({ kind: 'request', title, actionable: row.actionable === true });
    }
  }
  return out;
}

/** The slice of the task store the capture pipeline writes through. The real
 *  `TaskStore` satisfies it structurally; the tests hand in a recorder. */
export interface TaskCaptureBoard {
  listTasks(workspaceId: string): Array<{
    id: string;
    title: string;
    status: TaskStatus;
    kind?: 'task' | 'goal';
  }>;
  createTask(
    workspaceId: string,
    opts: CreateTaskOpts,
  ): { ok: true; task: { id: string } } | { ok: false; error: string };
  transition(
    taskId: string,
    to: TaskStatus,
    opts: { actor: { id: string; name: string; kind?: string }; note?: string },
  ): { ok: boolean };
}

export interface RunTaskCaptureDeps {
  board: TaskCaptureBoard;
  extractor: TaskCaptureExtractor;
  /** The lead wake — the ready-nudge channel. Fired only for a request the
   *  extractor judged actionable, after its row is `todo`. */
  onTaskReady?: (wake: { workspaceId: string; taskId: string; title: string }) => void;
  onError?: (message: string) => void;
}

export interface RunTaskCaptureInput {
  workspaceId: string;
  docId: string;
  docTitle?: string;
  turns: readonly NotesTurn[];
}

/**
 * One pause's capture pass: extract, find-or-create, optionally set moving,
 * and return the links the notes composer may weave in. Never throws — a
 * capture pass that fails costs its links, not the meeting's notes.
 */
export async function runTaskCapture(
  deps: RunTaskCaptureDeps,
  input: RunTaskCaptureInput,
): Promise<NoteTaskLink[]> {
  let candidates: TaskCaptureCandidate[];
  try {
    // Done rows stay in: "the tunnel fix from last week is done" is a
    // reference, and its chip honestly says so.
    candidates = deps.board
      .listTasks(input.workspaceId)
      .filter((t) => t.kind !== 'goal')
      .slice(0, MAX_CAPTURE_CANDIDATES)
      .map((t) => ({ id: t.id, title: t.title, status: t.status }));
  } catch (err) {
    deps.onError?.(err instanceof Error ? err.message : 'task capture: board read failed');
    return [];
  }

  let items: CapturedItem[];
  try {
    items = await deps.extractor.extract({
      turns: input.turns,
      candidates,
      ...(input.docTitle !== undefined ? { docTitle: input.docTitle } : {}),
    });
  } catch (err) {
    deps.onError?.(err instanceof Error ? err.message : 'task capture failed');
    return [];
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const links: NoteTaskLink[] = [];
  const linked = new Set<string>();
  const pushCandidate = (c: TaskCaptureCandidate): void => {
    if (linked.has(c.id)) return;
    linked.add(c.id);
    links.push({ title: c.title, url: taskCaptureUrl(input.workspaceId, c.id), status: c.status });
  };

  for (const item of items) {
    if (item.kind === 'reference') {
      const candidate = byId.get(item.taskId);
      if (candidate) pushCandidate(candidate);
      continue;
    }
    // Find before create: a request that names tracked OPEN work links the
    // existing row. Done rows are exempt — asking again for finished work is
    // a new task (a regression), not a reference.
    const existing = candidates.find(
      (c) => c.status !== 'done' && requestMatchesCandidate(item.title, c.title),
    );
    if (existing) {
      pushCandidate(existing);
      continue;
    }
    const actionable = item.actionable;
    const created = deps.board.createTask(input.workspaceId, {
      title: item.title,
      body: [
        `Filed live from the meeting${input.docTitle ? ` "${input.docTitle}"` : ''} by the`,
        "meeting assistant — the doc's transcript is the source record.",
      ].join(' '),
      assignee: MEETING_CAPTURE_ACTOR.name,
      assigneeKind: 'agent',
      // The doc is where the words live; the origin ref is what lets the
      // task answer "where did this come from".
      origin: { kind: 'doc', docId: input.docId },
      // Actionable work gets a real (re-rankable) band so dispatch can reach
      // it; anything else goes through triage like other agent-filed rows.
      ...(actionable ? { goal: CHORES_GOAL_ID } : {}),
      actor: MEETING_CAPTURE_ACTOR,
    });
    if (!created.ok) {
      deps.onError?.(`task capture: create refused (${created.error})`);
      continue;
    }
    let status: TaskStatus = 'triage';
    if (actionable) {
      const moved = deps.board.transition(created.task.id, 'todo', {
        actor: MEETING_CAPTURE_ACTOR,
        note: 'Asked for in the meeting and clear enough to start; queued for dispatch.',
      });
      if (moved.ok) {
        status = 'todo';
        deps.onTaskReady?.({
          workspaceId: input.workspaceId,
          taskId: created.task.id,
          title: item.title,
        });
      }
    }
    links.push({
      title: item.title,
      url: taskCaptureUrl(input.workspaceId, created.task.id),
      status,
    });
  }
  return links;
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const CAPTURE_MODEL = 'claude-haiku-4-5-20251001';
/** The reply is a short JSON list, never notes-sized. */
const MAX_TOKENS = 1_000;
const TIMEOUT_MS = 30_000;

export interface HaikuTaskCaptureOpts {
  /** Tests: a key (or `null` for the explicit no-key state) without Keychain. */
  apiKey?: string | null;
  /** Tests: the HTTP seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Printed once per process — the transcript leaving the machine is never
 *  the silent case, same rule as the notes composer. */
let announcedOn = false;

/**
 * The real extractor, or `null` when the operator has not opted in (no
 * dedicated key) or has opted out (`CW_MEETING_TASKS=0`). Failure throws and
 * never logs the key; `runTaskCapture` turns the throw into a skipped pass.
 */
export function createHaikuTaskCaptureExtractor(
  opts: HaikuTaskCaptureOpts = {},
): TaskCaptureExtractor | null {
  if (readRenamedEnv(process.env, 'CW_MEETING_TASKS') === '0') return null;
  const key = resolveKeyFrom(opts.apiKey, readKeychainPassword);
  if (!key) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    name: 'haiku',
    async extract(input: TaskCaptureInput): Promise<CapturedItem[]> {
      if (!announcedOn) {
        announcedOn = true;
        console.log(
          '[meeting-tasks] live task capture ON: meeting transcript text is ' +
            'sent to api.anthropic.com. Turn off with CW_MEETING_TASKS=0.',
        );
      }
      const { system, user } = buildTaskCapturePrompt(input);
      const ctl = new AbortController();
      const timeout = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: CAPTURE_MODEL,
            max_tokens: MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
          }),
          signal: ctl.signal,
        });
        // The status is safe to surface; the key never is.
        if (!res.ok) throw new Error(`task capture HTTP ${res.status}`);
        const body = (await res.json()) as { content?: Array<{ text?: string }> };
        const text = body.content?.map((b) => b.text ?? '').join('') ?? '';
        return parseTaskCaptureReply(text, input.candidates, input.turns);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
