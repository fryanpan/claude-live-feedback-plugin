/**
 * Every prompt this server sends to a model, in one list.
 *
 * Seven call sites, found by grepping `packages/**` for the messages endpoint
 * and confirmed one by one. The list exists so the settings page can be a
 * list rather than seven hand-written rows, and so a new prompt is one entry
 * here instead of a page edit plus a route edit plus a store edit.
 *
 * The PURPOSE line is what the reader sees under the name, and it is written
 * for the person tuning the words rather than for the person maintaining the
 * module: what it does for them, and — folded into the same sentence rather
 * than carried by a second field — roughly when it fires. "While the room
 * talks" is when; it is not a separate column, because a column of timing
 * chrome is chrome the reader cannot act on.
 *
 * SCOPE is where the words are stored, not a label anybody sees. `server`
 * prompts live in `<dataDir>/prompts.json` (`prompt-store.ts`); `board`
 * prompts are fields on a board's own record and are written through
 * `PUT /workspaces/<id>/settings`, which is where they already lived.
 * The page deliberately does not say which is which — one owner, one machine,
 * and a label he cannot act on is a label that costs a line and buys nothing.
 *
 * It follows that EVERY EDITABLE ROW IS EDITED ON THIS PAGE, including the
 * two board-scoped ones. The review criteria also have a field in the board's
 * own settings panel and keep it; both are editors over the same server-side
 * field, each reading it fresh when it opens. Sending that one row off to a
 * popover instead would have made a row that looks exactly like its six
 * siblings behave unlike any of them, which is the wrong-target surprise the
 * page is shaped to avoid.
 */

import { DEFAULT_EFFORT_ESTIMATE_PROMPT } from '@feedback/core/effort-estimate-prompt';
import { DEFAULT_REVIEW_ITEM_CRITERIA } from '@feedback/core/review-judge-prompt';
import { DEFAULT_THREAD_SUMMARY_SYSTEM } from '@feedback/core/summary-prompt';
import { DEFAULT_TASK_CAPTURE_SYSTEM } from './meeting-capture-prompt.ts';
import { NOTE_ASK_SYSTEM } from './note-ask-judge.ts';
import { DEFAULT_NOTES_INSTRUCTIONS } from './notes-prompt-store.ts';
import { DEFAULT_VOICE_SYSTEM } from './voice-prompt.ts';

/** Where a prompt's words are kept. Not shown to the reader. */
export type PromptScope = 'server' | 'board';

export interface PromptDefinition {
  id: string;
  /** The row's name. */
  name: string;
  /** One line: what it does for the reader, and when. */
  purpose: string;
  scope: PromptScope;
  /**
   * May the reader change these words here?
   *
   * False for the thread summary, and the reason is arithmetic rather than
   * caution: the summaries are stored and versioned, so an edit marks every
   * one of them stale and the next backfill re-generates and re-pays for the
   * lot. Bryan's call on the mock, 2026-09-04 — read-only for now.
   */
  editable: boolean;
  /** The shipped words. */
  default: string;
}

export const PROMPT_CATALOG: readonly PromptDefinition[] = [
  {
    id: 'meeting-notes',
    name: 'Notetaking instructions',
    purpose: 'How the live note-taker writes the notes while the room talks.',
    scope: 'server',
    editable: true,
    default: DEFAULT_NOTES_INSTRUCTIONS,
  },
  {
    id: 'meeting-capture',
    name: 'Meeting capture',
    purpose: 'What counts as asking for a ticket, a lookup, or a correction in a meeting.',
    scope: 'server',
    editable: true,
    default: DEFAULT_TASK_CAPTURE_SYSTEM,
  },
  {
    id: 'thread-summary',
    name: 'Thread summary',
    purpose: 'The two lines that summarise a comment thread on its card.',
    scope: 'server',
    editable: false,
    default: DEFAULT_THREAD_SUMMARY_SYSTEM,
  },
  {
    id: 'review-item-criteria',
    name: 'Review item criteria',
    purpose: "What an agent's ask has to do before it reaches your queue.",
    scope: 'board',
    editable: true,
    default: DEFAULT_REVIEW_ITEM_CRITERIA,
  },
  {
    id: 'effort-estimate',
    name: 'Effort estimate',
    purpose: 'How long a ticket on this board is judged to take.',
    scope: 'board',
    editable: true,
    default: DEFAULT_EFFORT_ESTIMATE_PROMPT,
  },
  {
    id: 'waiting-on-you',
    name: 'Waiting on you',
    purpose: 'Whether a note an agent left means it is waiting on a person.',
    scope: 'server',
    editable: true,
    default: NOTE_ASK_SYSTEM,
  },
  {
    id: 'voice-router',
    name: 'Voice router',
    purpose: 'What happens when you speak to the board.',
    scope: 'server',
    editable: true,
    default: DEFAULT_VOICE_SYSTEM,
  },
];

/** The id of any prompt in the catalog. A plain string: the ids cross the
 *  wire, so a route validates against the list rather than against a type. */
export type PromptId = string;

export function promptDefinition(id: PromptId): PromptDefinition | undefined {
  return PROMPT_CATALOG.find((p) => p.id === id);
}
