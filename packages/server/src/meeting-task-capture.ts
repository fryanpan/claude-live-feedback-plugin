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
 *
 * THE FILE IS NAMED FOR ITS FIRST TWO INTENTS AND NOW CARRIES SIX. Requests
 * and references were the whole of it; research, lookup and review asks
 * arrived in the same reply rather than in calls of their own, because a
 * tick's prompt is ~95% shared context and what scales with intents is how
 * many times that context is re-sent (decisions.md, 2026-08-30: "One call
 * per tick carries every intent"). An intent added here costs ~58 input
 * tokens; the same intent as its own always-on pass costs seven to
 * twenty-seven times that. So: one call, one items array, a `kind` per
 * intent, and rows that parse independently so one malformed intent never
 * costs the others.
 *
 * A SPOKEN ASK FILES WHAT THE SAME ASK TAPPED WOULD FILE. The pointer pill's
 * Create Task and Research, and the Review float, are the one-or-two-tap
 * forms of three of these intents; the capture pass is the no-tap form, and
 * it goes through the same doors: `parseTaskCreate` with the pill's own body
 * (`spinoffBody`, core) and readiness rule (`readyToWork`, core) for a task;
 * a lead-addressed row plus a placeholder section for research; the Review
 * press's thread for a review ask. What is asked out loud must not land
 * somewhere different from what is asked with a finger — the first version
 * had its own create options and its own gates, and a spoken task that "did
 * nothing" was this path silently scoped to a board a huddle doc never has.
 *
 * A LOOKUP is still the odd one: it only reads, so a wrong one is a link
 * nobody wanted, dropped by the same guards the reference path uses.
 *
 * AND SINCE 2026-09-02, THE SPEAKER SAYS WHICH KIND OF ASK IT IS. "Claude,
 * can you …" is an ask for now — research, lookup, review, acted on while
 * the meeting runs. "create a task …" is an ask for later — a request,
 * captured and not started. Speech using neither phrasing is a note: it
 * reaches the composer like any other words and files nothing. The prompt
 * teaches the convention and `parseTaskCaptureReply` enforces it, so an ask
 * the model finds without a cue is downgraded rather than acted on
 * (`meeting-ask-cues.ts`, Bryan's huddle that day).
 *
 * THE FIFTH INTENT DOES NOT BELONG TO THIS FILE'S SUBJECT AT ALL, AND RIDES
 * HERE ANYWAY. A CORRECTION — "no, I said Thursday" — touches no board row;
 * it fixes a note. It is extracted here for the one reason the decision gives:
 * what a tick pays for is re-sending its context, so an intent that shares the
 * transcript already in the prompt is nearly free, and the same intent as its
 * own pass would pay for the whole prompt again to answer "nothing" on most
 * ticks. So the pass extracts it, checks the half a transcript can vouch for,
 * and hands it on untouched (`CaptureLinks.corrections`) to the module that
 * can finish the job: the notes are in the doc, not here.
 */

import { readyToWork, spinoffBody, spinoffDocHref } from '@feedback/core';
import { readRenamedEnv } from '@feedback/core/env-names';
import {
  type SpentCues,
  captureWindow,
  requestMatchesCandidate,
  spokenLineFor,
} from './meeting-capture-guards.ts';
import {
  TITLE_MAX,
  buildTaskCapturePrompt,
  parseTaskCaptureReply,
} from './meeting-capture-prompt.ts';
import {
  type LookupDoc,
  docLookupUrl,
  lookupWhen,
  parseRecency,
  resolveLookup,
} from './meeting-lookup.ts';
import type { NoteDocLink, NoteTaskLink, NotesTurn, SpokenCorrection } from './meeting-notes.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';
import { parseTaskCreate } from './task-create.ts';
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
  /**
   * The voice that asked, as the transcript spells it — a name the person
   * gave that label, or the bare "Speaker B" of one nobody has named. Absent
   * when the speech carried no labels, or when the model named a voice this
   * tick never heard (see {@link speakerOnTick}).
   */
  requester?: string;
}

/** Speech that referred to work the board already tracks. */
export interface CapturedReference {
  kind: 'reference';
  taskId: string;
}

/**
 * Speech that asked for something to be FOUND OUT rather than built — "go
 * look into that", "dig into why it does that", "can you research what it
 * would take".
 *
 * Acted on the way the pointer pill's Research is: a row addressed to the
 * board's lead, and a placeholder section in the doc for the findings to
 * land in. It used to file a decision item asking whether to spend the pass;
 * the owner's plan (workstream B, 2026-09-01) asks for the placeholder
 * immediately, and a gate nobody could see was what made a spoken research
 * ask feel like it "did nothing".
 */
export interface CapturedResearch {
  kind: 'research';
  /** What to look into, in the words spoken. */
  topic: string;
  /** What the research should answer, when the speech said. */
  question?: string;
  /** The voice that asked — same law as {@link CapturedRequest.requester}. */
  requester?: string;
}

/**
 * Speech that asked the doc's agent to REVIEW — to look at the notes and put
 * questions on them, or to take one question to the team: "ask the team
 * whether we still need the tunnel", "can somebody check these notes",
 * "get the lead to look at this". The Review float's press, heard instead
 * of tapped, and it files exactly what the press files: a subject thread on
 * the doc, which every watching agent already receives.
 */
export interface CapturedReview {
  kind: 'review';
  /** What to ask, in the words spoken. */
  question: string;
  /** The voice that asked — same law as {@link CapturedRequest.requester}. */
  requester?: string;
}

/**
 * Speech that asked for existing material to be brought in — "pull up last
 * week's notes", "link the design doc for that". What it points at is
 * resolved in `meeting-lookup.ts`; all this carries is what was asked for.
 */
export interface CapturedLookup {
  kind: 'lookup';
  /** What was asked for, in the words spoken, INCLUDING any "when" — the
   *  time phrase is often the only part that identifies a past meeting. */
  query: string;
}

/**
 * Speech that FIXES a note already written — "no, I said Thursday", "that
 * was sixty, not sixteen".
 *
 * The odd one out among the intents: every other one adds something to the
 * board or the notes, and this one changes something that is already there.
 * So it is the only intent whose guard cannot be finished here — the mistaken
 * words are vouched by the DOC, not by the transcript, and that resolution
 * happens in `meeting-notes-correction.ts` where the notes actually are. What
 * this module owes it is the other half: the corrected words must have been
 * SAID (`correctionSpokenOnTick`), so a model that invents a correction
 * nobody spoke never reaches the doc at all.
 */
export interface CapturedCorrection {
  kind: 'correction';
  /** The mistaken words, as the notes would spell them. */
  wrong: string;
  /** What they should say instead, in the words just spoken. */
  right: string;
}

export type CapturedItem =
  | CapturedRequest
  | CapturedReference
  | CapturedResearch
  | CapturedLookup
  | CapturedCorrection
  | CapturedReview;

export interface TaskCaptureInput {
  turns: readonly NotesTurn[];
  /**
   * The previous tick's speech, already read on that pass. Only its tail is
   * used, and it is marked in the prompt as already read — see
   * {@link overlapWindow} for why an ask straddling a tick boundary needs it.
   */
  priorTurns?: readonly NotesTurn[];
  candidates: readonly TaskCaptureCandidate[];
  docTitle?: string;
  /**
   * The cue lines this meeting has already spent. Handed down so the guard
   * can refuse to spend one twice — the marked overlap shows the previous
   * tick's last lines again, and a cue that already acted must not act again
   * on a new subject. Absent, each reply is guarded on its own.
   */
  spentCues?: SpentCues;
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

/** How many board rows the extractor prompt may carry, mirroring the notes
 *  context cap: enough to match against, few enough that a thousand-row
 *  board cannot flood the prompt. */
export const MAX_CAPTURE_CANDIDATES = 40;

/**
 * The guards moved to `meeting-capture-guards.ts`; they are still part of
 * this module's surface, so nothing that reads them had to move with them.
 */
export {
  captureWindow,
  cueLineFor,
  normalizedTitle,
  OVERLAP_MAX_CHARS,
  OVERLAP_MAX_TURNS,
  overlapWindow,
  phraseSpokenOnTick,
  requestMatchesCandidate,
  speakerOnTick,
  type SpentCues,
  spokenLineFor,
  tickMentionsCandidate,
} from './meeting-capture-guards.ts';

/**
 * The prompt and its reader moved to `meeting-capture-prompt.ts`; the intent
 * rules are read by the cost scripts under their old names, so the surface
 * stays here.
 */
export {
  ASK_CUE_PROMPT_RULE,
  buildTaskCapturePrompt,
  CORRECTION_PROMPT_RULE,
  LOOKUP_PROMPT_RULE,
  OVERLAP_PROMPT_RULE,
  parseTaskCaptureReply,
  RESEARCH_PROMPT_RULE,
  REVIEW_PROMPT_RULE,
} from './meeting-capture-prompt.ts';

/** The board deep link `parseWorkspaceLink` reads back as `kind: 'task'` —
 *  root-relative, so it survives being read under any host the server has. */
export function taskCaptureUrl(workspaceId: string, taskId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(taskId)}`;
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
  ): { ok: true; task: { id: string; status?: string } } | { ok: false; error: string };
  transition(
    taskId: string,
    to: TaskStatus,
    opts: { actor: { id: string; name: string; kind?: string }; note?: string },
  ): { ok: boolean };
  /**
   * Who leads the board — what a research row is addressed to. Optional
   * because the recorder in the tests has no seat; a board that cannot say
   * files the row unowned at triage, exactly as the pill's Research does
   * when the create route finds no lead.
   */
  getWorkspace?(workspaceId: string): { leadAgentId?: string } | undefined;
  /**
   * Where a spun-off row is PLACED — the top active goal and the lead —
   * see `TaskStore.placeSpinoff`. Optional for the same reason as above;
   * without it an actionable request files to chores, owned by the
   * assistant, which is on the board but not in any goal.
   */
  placeSpinoff?(
    workspaceId: string,
    opts?: { docId?: string },
  ): { goal: string; leadAgentId?: string } | undefined;
}

/**
 * Where a lookup ask looks, beyond the board rows this pass has already
 * read. Docs and their past meetings live behind `rooms` and the meeting
 * store, which this module has no business knowing about.
 */
export interface TaskCaptureLookup {
  /**
   * The board's docs and when each last carried a meeting. The meeting's own
   * doc is excluded by the implementation — "pull up the last meeting" means
   * the one before this one, and the notes being written are already here.
   */
  docs(workspaceId: string, exceptDocId: string): LookupDoc[];
}

/** What one tick's pass hands back: rows it touched, material it was asked to
 *  bring in, and fixes to notes already written. All three empty is the
 *  ordinary answer. The first two are links the composer may weave in; the
 *  third goes to the doc directly, because the note it changes is there and
 *  not in anything the composer is about to write. */
export interface CaptureLinks {
  tasks: NoteTaskLink[];
  docs: NoteDocLink[];
  corrections: SpokenCorrection[];
}

/** A research row filed from speech, for the doc to grow its placeholder. */
export interface ResearchFiled {
  workspaceId: string;
  docId: string;
  taskId: string;
  /** The row's title — "Research: <topic>". */
  title: string;
  topic: string;
  question?: string;
  /** The board deep link, the same one the notes carry. */
  url: string;
}

/** A review ask heard in the meeting, for the doc to file as a thread. */
export interface ReviewAsk {
  workspaceId: string;
  docId: string;
  question: string;
  requester?: string;
}

export interface RunTaskCaptureDeps {
  board: TaskCaptureBoard;
  extractor: TaskCaptureExtractor;
  /** Where a lookup ask resolves. Absent, lookups are extracted and dropped
   *  — the same shape as capture being off: a missed convenience. */
  lookup?: TaskCaptureLookup;
  /** The lead wake — the ready-nudge channel. Fired only for a request the
   *  extractor judged actionable, after its row is `todo`. */
  onTaskReady?: (wake: { workspaceId: string; taskId: string; title: string }) => void;
  /**
   * A research row landed: the doc owes it a placeholder section for the
   * findings, which only the caller holding the doc can write. Absent, the
   * row still files — the placeholder is the pill's second half, not a
   * condition of the first.
   */
  onResearchFiled?: (filed: ResearchFiled) => void;
  /**
   * A review ask heard: the caller files it the way the Review float's press
   * is filed (a subject thread on the doc plus the stamp). Absent, the ask is
   * extracted and dropped — a session with no doc has nothing to review.
   */
  onReviewAsk?: (ask: ReviewAsk) => void;
  /** Tests: the clock a recency phrase is read against. */
  now?: () => number;
  onError?: (message: string) => void;
}

export interface RunTaskCaptureInput {
  workspaceId: string;
  docId: string;
  docTitle?: string;
  turns: readonly NotesTurn[];
  /** The previous tick's speech, for the boundary — see {@link overlapWindow}. */
  priorTurns?: readonly NotesTurn[];
  /** This meeting's spent cue lines — see {@link TaskCaptureInput.spentCues}. */
  spentCues?: SpentCues;
}

/**
 * One pause's capture pass: extract, find-or-create, optionally set moving,
 * and return the links the notes composer may weave in. Never throws — a
 * capture pass that fails costs its links, not the meeting's notes.
 */
export async function runTaskCapture(
  deps: RunTaskCaptureDeps,
  input: RunTaskCaptureInput,
): Promise<CaptureLinks> {
  const none: CaptureLinks = { tasks: [], docs: [], corrections: [] };
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
    return none;
  }

  let items: CapturedItem[];
  try {
    items = await deps.extractor.extract({
      turns: input.turns,
      candidates,
      ...(input.priorTurns !== undefined ? { priorTurns: input.priorTurns } : {}),
      ...(input.docTitle !== undefined ? { docTitle: input.docTitle } : {}),
      ...(input.spentCues !== undefined ? { spentCues: input.spentCues } : {}),
    });
  } catch (err) {
    deps.onError?.(err instanceof Error ? err.message : 'task capture failed');
    return none;
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const links: NoteTaskLink[] = [];
  const docLinks: NoteDocLink[] = [];
  const corrections: SpokenCorrection[] = [];
  const linked = new Set<string>();
  const linkedDocs = new Set<string>();
  const pushCandidate = (c: TaskCaptureCandidate): void => {
    if (linked.has(c.id)) return;
    linked.add(c.id);
    links.push({ title: c.title, url: taskCaptureUrl(input.workspaceId, c.id), status: c.status });
  };
  /** A row this pass just made, which the candidate list predates. */
  const pushMade = (id: string, title: string, status: TaskStatus): void => {
    if (linked.has(id)) return;
    linked.add(id);
    links.push({ title, url: taskCaptureUrl(input.workspaceId, id), status });
    candidates.push({ id, title, status });
  };

  for (const item of items) {
    if (item.kind === 'reference') {
      const candidate = byId.get(item.taskId);
      if (candidate) pushCandidate(candidate);
      continue;
    }
    if (item.kind === 'correction') {
      // Nothing to find or create: a correction touches no board row. It is
      // carried out of here untouched, and resolves against the notes doc —
      // the only place that can say which note it is about, or whether it is
      // about anybody's note at all.
      corrections.push({ wrong: item.wrong, right: item.right });
      continue;
    }
    if (item.kind === 'lookup') {
      handleLookup(deps, input, item, candidates, pushCandidate, docLinks, linkedDocs);
      continue;
    }
    if (item.kind === 'review') {
      // No row: the Review press files a thread, and so does its spoken
      // twin. Dedupe across ticks is the caller's (it holds the meeting);
      // within a tick the parser already folded repeats.
      deps.onReviewAsk?.({
        workspaceId: input.workspaceId,
        docId: input.docId,
        question: item.question,
        ...(item.requester !== undefined ? { requester: item.requester } : {}),
      });
      continue;
    }
    if (item.kind === 'research') {
      // Asked for twice, or already tracked: link the row rather than file a
      // second one. Same threshold and the same reasoning as a duplicated
      // request.
      const tracked = candidates.find(
        (c) => c.status !== 'done' && requestMatchesCandidate(item.topic, c.title),
      );
      if (tracked) {
        pushCandidate(tracked);
        continue;
      }
      const filed = fileResearchAsk(deps, input, item);
      if (filed) pushMade(filed.taskId, filed.title, filed.status);
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
    const filed = fileSpokenTask(deps, input, item);
    if (filed) pushMade(filed.taskId, item.title, filed.status);
  }
  return { tasks: links, docs: docLinks, corrections };
}

/**
 * A spoken request becomes a row THE WAY A TAPPED ONE DOES: the same body
 * the pointer pill posts, read by the same `parseTaskCreate` every create
 * route runs, filed under the same readiness rule. The pill's author is the
 * person who tapped; here it is the meeting assistant, so the row says who
 * filed it and (when the tick carried a voice) who asked.
 *
 * Where it lands is decided twice over, and both have to agree for To do:
 * the model's "actionable" (clear enough to start, nobody said to wait) AND
 * the pill's `readyToWork` (enough words to be a title). A row that fails
 * either goes to triage — visible on the board, in no dispatch read — which
 * is the pill's own rule for a thin selection.
 */
function fileSpokenTask(
  deps: RunTaskCaptureDeps,
  input: RunTaskCaptureInput,
  item: CapturedRequest,
): { taskId: string; status: TaskStatus } | null {
  const actionable = item.actionable && readyToWork(item.title);
  // Quoted from the whole capture window, preferring the line that carried
  // the cue — the transcript's words, chosen here rather than by the model,
  // so the row's body quotes the sentence somebody actually asked in. Reading
  // the new turns alone quoted "Alice: sure" when the subject had been said
  // one line before the tick boundary.
  const quote = spokenLineFor(captureWindow(input.turns, input.priorTurns), item.title, 'later');
  // The pill's placement, by the board's own rule: the top active goal and
  // the lead as owner, so the row is dispatched rather than sitting in
  // chores under the assistant's name (Bryan, 2026-09-01: "created in
  // Backlog and not automatically started").
  const placed = actionable
    ? deps.board.placeSpinoff?.(input.workspaceId, { docId: input.docId })
    : undefined;
  const parsed = parseTaskCreate(
    {
      title: item.title,
      body: spinoffBody(quote ?? '', input.docTitle, {
        heard: true,
        // Who asked is the half of "who said what" a task can still answer
        // a week later, once the strip is gone. Only ever a voice the tick
        // carried, so this names a real speaker or nothing at all.
        extra: item.requester ? [`Asked for by ${item.requester}.`] : [],
        // The way back to the words, the same link the pill's row carries.
        docHref: spinoffDocHref(input.workspaceId, input.docId),
      }),
      author: MEETING_CAPTURE_ACTOR,
      // The doc is where the words live; the origin ref is what lets the
      // task answer "where did this come from". One origin kind for "a doc
      // line became this", shared with the pill.
      origin: { kind: 'doc', docId: input.docId },
      ...(quote !== undefined ? { quote } : {}),
      // Actionable work gets a real (re-rankable) band so dispatch can reach
      // it — the placed one, else chores; anything else goes through triage
      // like other agent-filed rows. Addressed to the lead when the seat is
      // held; with no lead the assistant keeps it, on the board.
      ...(actionable ? { goal: placed?.goal ?? CHORES_GOAL_ID } : { triage: true }),
      ...(placed?.leadAgentId !== undefined ? { assignToLead: true } : {}),
    },
    MEETING_CAPTURE_ACTOR,
    placed?.leadAgentId !== undefined ? { leadAgentId: placed.leadAgentId } : {},
  );
  if (!parsed.ok) {
    deps.onError?.(`task capture: create refused (${parsed.error})`);
    return null;
  }
  const created = deps.board.createTask(input.workspaceId, parsed.opts);
  if (!created.ok) {
    deps.onError?.(`task capture: create refused (${created.error})`);
    return null;
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
  return { taskId: created.task.id, status };
}

/** The pill's own research title, and its cap — `Research: ` plus what was
 *  said, inside the board's title limit. */
export function researchTitle(topic: string): string {
  return clipToWordBoundary(`Research: ${topic}`, TITLE_MAX);
}

/**
 * A research ask becomes the pill's Research: a row ADDRESSED TO THE BOARD
 * (`assignToLead`), so it goes to the lead when there is one and to nobody —
 * unowned, at triage — when there is not, and never to the person who asked;
 * plus, through `onResearchFiled`, a placeholder section in the doc that the
 * findings land in.
 *
 * It used to file a decision item first, so nothing was spent on a
 * mishearing. That gate is gone (owner's plan, 2026-09-01: "the agent writes
 * a placeholder section immediately, then fills it"): a research row is a
 * `todo` for the lead like any other, and the row's body names the doc
 * section it is expected to fill, so the lead can find where to write.
 */
function fileResearchAsk(
  deps: RunTaskCaptureDeps,
  input: RunTaskCaptureInput,
  item: CapturedResearch,
): { taskId: string; title: string; status: TaskStatus } | null {
  const title = researchTitle(item.topic);
  const board = deps.board.getWorkspace?.(input.workspaceId);
  const quote = spokenLineFor(captureWindow(input.turns, input.priorTurns), item.topic, 'now');
  // Placed like every other spin-off (the board's top active band), not
  // left to the store's chores default — which the board draws as Backlog,
  // the very column Bryan found his rows in.
  const placed = readyToWork(title)
    ? deps.board.placeSpinoff?.(input.workspaceId, { docId: input.docId })
    : undefined;
  const parsed = parseTaskCreate(
    {
      title,
      body: spinoffBody(quote ?? '', input.docTitle, {
        heard: true,
        extra: [
          ...(item.question ? [`The question asked: ${item.question}`] : []),
          ...(item.requester ? [`Asked for by ${item.requester}.`] : []),
          `Write what you find under the "${title}" section of the doc; a placeholder is there.`,
        ],
        docHref: spinoffDocHref(input.workspaceId, input.docId),
      }),
      author: MEETING_CAPTURE_ACTOR,
      origin: { kind: 'doc', docId: input.docId },
      ...(quote !== undefined ? { quote } : {}),
      assignToLead: true,
      // The pill's own readiness read, on the same title it reads it on —
      // "Research: <topic>", prefix included.
      ...(readyToWork(title) ? {} : { triage: true }),
      ...(placed !== undefined ? { goal: placed.goal } : {}),
    },
    MEETING_CAPTURE_ACTOR,
    board ? { ...(board.leadAgentId !== undefined ? { leadAgentId: board.leadAgentId } : {}) } : {},
  );
  if (!parsed.ok) {
    deps.onError?.(`research capture: create refused (${parsed.error})`);
    return null;
  }
  const created = deps.board.createTask(input.workspaceId, parsed.opts);
  if (!created.ok) {
    deps.onError?.(`research capture: create refused (${created.error})`);
    return null;
  }
  const taskId = created.task.id;
  // A row for the lead is a todo like the pill's; one nobody owns stays at
  // triage, where a person places it. The store files an AGENT's create at
  // triage regardless (the pill's author is a person, so its row is placed
  // by the person rule), so a lead-addressed row is moved to todo here and
  // the lead woken — the same step an actionable request takes.
  let status: TaskStatus = parsed.opts.fileToTriage ? 'triage' : 'todo';
  if (!parsed.opts.fileToTriage && created.task.status !== 'todo') {
    const moved = deps.board.transition(taskId, 'todo', {
      actor: MEETING_CAPTURE_ACTOR,
      note: "Research asked for in the meeting — the lead's errand, ready to pick up.",
    });
    if (!moved.ok) {
      deps.onError?.(`research capture: could not set ${taskId} todo`);
      status = 'triage';
    }
  }
  if (status === 'todo') deps.onTaskReady?.({ workspaceId: input.workspaceId, taskId, title });
  deps.onResearchFiled?.({
    workspaceId: input.workspaceId,
    docId: input.docId,
    taskId,
    title,
    topic: item.topic,
    ...(item.question !== undefined ? { question: item.question } : {}),
    url: taskCaptureUrl(input.workspaceId, taskId),
  });
  return { taskId, title, status };
}

/**
 * A lookup ask becomes a link, or nothing. The resolution is
 * `meeting-lookup.ts`'s; what happens here is only the routing: a doc
 * becomes a doc link the composer may cite, and a board row goes down the
 * path board rows already take, so a lookup and a reference to the same row
 * cannot produce two links to it.
 */
function handleLookup(
  deps: RunTaskCaptureDeps,
  input: RunTaskCaptureInput,
  item: CapturedLookup,
  candidates: readonly TaskCaptureCandidate[],
  pushCandidate: (c: TaskCaptureCandidate) => void,
  docLinks: NoteDocLink[],
  linkedDocs: Set<string>,
): void {
  if (!deps.lookup) return;
  const now = deps.now?.() ?? Date.now();
  let docs: LookupDoc[];
  try {
    docs = deps.lookup.docs(input.workspaceId, input.docId);
  } catch (err) {
    deps.onError?.(err instanceof Error ? err.message : 'lookup: doc read failed');
    return;
  }
  const hit = resolveLookup(item.query, { docs, tasks: candidates }, now);
  if (!hit) return;
  if (hit.kind === 'task') {
    const candidate = candidates.find((c) => c.id === hit.taskId);
    if (candidate) pushCandidate(candidate);
    return;
  }
  if (linkedDocs.has(hit.docId)) return;
  linkedDocs.add(hit.docId);
  const when = lookupWhen(hit, parseRecency(item.query, now));
  docLinks.push({
    title: hit.title,
    url: docLookupUrl(input.workspaceId, hit.docId),
    ...(when !== undefined ? { when } : {}),
  });
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
        return parseTaskCaptureReply(
          text,
          input.candidates,
          input.turns,
          input.priorTurns,
          input.spentCues,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
