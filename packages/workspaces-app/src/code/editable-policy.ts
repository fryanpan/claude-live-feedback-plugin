/**
 * Whether a doc's File view is a live EDITOR. The editor may only unlock
 * when the server actually writes the doc back to disk — an editable surface
 * over an unbound doc silently drops everything typed. That means live
 * working-tree diff members only: pinned reviews (diffTarget set) are
 * immutable, `.md` members edit through the markdown surface instead of raw
 * source, and a DELETED member has no file binding at all (bindDiff skips
 * the attach for status='deleted' — there is no file to write to).
 *
 * `canWrite` is the same question asked of the other end: the server drops
 * every update frame from an unsigned browser (`WsCtx.readOnly`), which is
 * "an unbound doc" by another name and loses the typing exactly as silently.
 * It is a required field so that a caller cannot answer this question without
 * having asked the server first.
 */
export function isEditableFileMember(opts: {
  isDiff: boolean;
  diffTarget: string;
  relPath: string;
  diffStatus?: string;
  /** Whether the server accepts writes from this browser. */
  canWrite: boolean;
}): boolean {
  return (
    opts.canWrite &&
    opts.isDiff &&
    !opts.diffTarget &&
    !opts.relPath.toLowerCase().endsWith('.md') &&
    opts.diffStatus !== 'deleted'
  );
}

/**
 * Mirror of the rule above for the REDLINE surface of a `.md` diff member:
 * the redline mount may only become the editable companion editor when the
 * diff targets the live working tree (empty diffTarget — that's when the
 * server binds the companion doc with write-back), the member isn't deleted
 * (nothing on disk to write to), and there is a workspace to open the
 * companion through. Pinned reviews keep the read-only derived redline.
 */
export function isEditableRedlineMember(opts: {
  diffTarget: string;
  workspaceId: string;
  diffStatus?: string;
}): boolean {
  return !opts.diffTarget && opts.workspaceId !== '' && opts.diffStatus !== 'deleted';
}
