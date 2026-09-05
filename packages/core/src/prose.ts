/**
 * Helpers for reading and editing the prosemirror content stored as a
 * `Y.XmlFragment` under the `prose` key in every markdown doc. Kept in
 * @feedback/core so the server, the MCP, and future headless tooling
 * can share one implementation.
 *
 * The implementation is four files and this is the surface over them, in
 * dependency order — each one may import the ones above it and none may
 * import one below:
 *
 *   `prose-fragment.ts`  reach the fragment, walk it, resolve an anchor to
 *                        a place inside it.
 *   `prose-markdown.ts`  markdown in, markdown out, and the LCS reparse.
 *   `prose-edit.ts`      find-and-replace and anchored range rewrites.
 *   `prose-blocks.ts`    whole-block inserts and deletes, and the agent
 *                        anchors that name where.
 *   `prose-integrity.ts` the post-write read that asks whether a doc now
 *                        holds markdown syntax as literal characters.
 *
 * This file exports exactly what it exported when it was one 2,847-line
 * module, which is why the re-exports below are written out by name rather
 * than as `export *`: the private helpers the four files now share across
 * their boundaries — `preview`, `textContent`, `insertDeltaInto`,
 * `splitTableRow` — are exported from their own modules and stay out of the
 * `prose` namespace, where they have never been. Import a symbol from the
 * file that defines it when you are inside `core`; everywhere else,
 * `prose.<name>` is the address.
 */

export {
  locateMatches,
  coveringInlineMarks,
  insertTextWithMarks,
  findAndReplace,
  rewriteRange,
  insertAfterRange,
} from './prose-edit.ts';
export type {
  LocatedMatch,
  ReplaceResult,
  NoMatchHint,
  TextSlice,
  AnchoredEditResult,
} from './prose-edit.ts';
export {
  PROSE_FRAGMENT_KEY,
  getProseFragment,
  walkProse,
  resolveRelativePosition,
  resolveRelativePositionRaw,
  headingLevelOf,
} from './prose-fragment.ts';
export type { TextSegment } from './prose-fragment.ts';
export { detectLiteralMarkdown, literalMarkdownMessage } from './prose-integrity.ts';
export type { LiteralMarkdownFinding, LiteralMarkdownKind } from './prose-integrity.ts';
export {
  inlineMarksToDelta,
  normalizeHeadingLevels,
  applyMarkdownToFragment,
  parseMarkdownBlocks,
  normalizeMarkdown,
  serializeFragmentToMarkdown,
  serializeBlockToMarkdown,
} from './prose-markdown.ts';
export {
  insertBlocksAfterAnchor,
  autoReanchorDoc,
  autoReanchorCodeDoc,
  AGENT_ANCHORS_KEY,
  getAgentAnchorsMap,
  resolveTextRangeFromFind,
  createAgentAnchor,
  readAgentAnchor,
  deleteAgentAnchor,
  deleteBlockAtAnchor,
  deleteBlocksInRange,
  deleteSection,
  resolveSingleFind,
} from './prose-blocks.ts';
export type {
  BlockPlacement,
  CreateAnchorResult,
  ResolveTextRangeResult,
  DeleteBlockResult,
  DeleteBlocksInRangeResult,
  DeleteSectionResult,
} from './prose-blocks.ts';
