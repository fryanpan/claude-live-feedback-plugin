/**
 * Body helpers that survived the format-check removal.
 *
 * This module used to derive "body gaps" — a code-written check that a
 * description opens with the user story. Bryan moved that judgment into an
 * LLM prompt on 2026-08-18 (the `claude-workspaces:leading-a-workspace`
 * skill), for the reason this file's own header recorded from the start:
 * the server *"can detect that the ticket titles are not good, but can't
 * necessarily fix them. And should not gate the capture of information."*
 * Routing every write to a reviewer with project context replaced the
 * persona allowlist. What stays is the one extractor that is not a
 * judgment.
 */

/**
 * The first PARAGRAPH of a body — not the first line.
 *
 * A markdown paragraph is hard-wrapped across several source lines, so a
 * line-based read would truncate almost every real body mid-clause.
 *
 * Exported and shared rather than re-implemented: `bodyHead` in
 * `task-title.ts` needs the same paragraph and normalises it further. Two
 * hand-written extractors that must agree will drift, and this repo has
 * already paid for that once with a question-detector and its extractor
 * disagreeing about newlines.
 */
export function firstParagraph(body: string | undefined): string {
  const lines = (body ?? '').split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => l.length > 0);
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l.length === 0);
  return lines.slice(start, end === -1 ? lines.length : end).join(' ');
}
