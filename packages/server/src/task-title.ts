/**
 * Title helpers that survived the format-check removal.
 *
 * This module used to derive "title gaps" — a code-written check of the
 * title standard (now `<persona> can <do x> so that <goal y>`).
 * Bryan moved that judgment into an LLM prompt on 2026-08-18 (the
 * `claude-workspaces:leading-a-workspace` skill): the server now ROUTES every
 * attributed create/rename/body edit to the workspace lead as a
 * `task-review` ask, and the reviewer — who has the project context a
 * regex never had — decides fine / rewrite / ask the filer. See
 * `requestTaskReview` in tasks.ts for the wire.
 *
 * What stays here is the part that is not a judgment: a word-boundary clip
 * for generated titles, and the normalized body-head `applyTitle` stamps so
 * "what did the description say when this row was last named" stays
 * answerable — that stamp is part of the capture record, not the check.
 */

import { firstParagraph } from './task-body.ts';

/**
 * Shorten to `limit` characters WITHOUT cutting a word in half.
 *
 * `promote_to_task` used to build a title with `slice(0, 79) + '…'`, which is
 * where *"For tasks, I get dumped o…"* came from — the generator, not the
 * author. Clipping at a word boundary cannot make a title worse: the result
 * is a prefix of the same prefix.
 */
export function clipToWordBoundary(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  // Room for the ellipsis itself.
  const room = Math.max(1, limit - 1);
  const cut = trimmed.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  // A single word longer than the limit has no boundary to fall back to, and
  // returning it whole would defeat the cap — so the hard cut stands there.
  const kept = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${kept.replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/**
 * The user story a title compresses: the body's first PARAGRAPH — everything
 * up to the first blank line — normalized so that re-emphasising a word is
 * not a rewrite.
 *
 * A paragraph rather than a line, and that is a correctness requirement
 * rather than a preference. A task body is written as hard-wrapped markdown
 * and stored that way at creation, but every later read of it comes back
 * through the prosemirror serializer, which emits each paragraph as ONE line.
 * So a first-LINE head recorded at creation stops matching the moment
 * anything touches the body, and every hard-wrapped task in the workspace
 * would report a moved head after its first trivial edit.
 *
 * Capped, because this is stored per task and a first paragraph can run long.
 */
export function bodyHead(body: string | undefined): string {
  // Shares `firstParagraph` with `task-body.ts` rather than re-implementing
  // it. Two hand-written extractors that must agree WILL drift, and the drift
  // lands in the feature's own subject — this repo has already paid for that
  // once, with a question-detector and its extractor disagreeing about
  // newlines and clipping away the question the feature existed to surface.
  return firstParagraph(body)
    .replace(/^#{1,6}\s*/, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 200);
}
