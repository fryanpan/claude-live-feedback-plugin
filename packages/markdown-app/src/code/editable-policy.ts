/**
 * Whether a doc's File view is a live EDITOR. The editor may only unlock
 * when the server actually writes the doc back to disk — an editable surface
 * over an unbound doc silently drops everything typed. That means live
 * working-tree diff members only: pinned reviews (diffTarget set) are
 * immutable, `.md` members edit through the markdown surface instead of raw
 * source, and a DELETED member has no file binding at all (bindDiff skips
 * the attach for status='deleted' — there is no file to write to).
 */
export function isEditableFileMember(opts: {
  isDiff: boolean;
  diffTarget: string;
  relPath: string;
  diffStatus?: string;
}): boolean {
  return (
    opts.isDiff &&
    !opts.diffTarget &&
    !opts.relPath.toLowerCase().endsWith('.md') &&
    opts.diffStatus !== 'deleted'
  );
}
