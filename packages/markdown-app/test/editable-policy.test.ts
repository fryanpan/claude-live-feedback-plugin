import { describe, expect, it } from 'vitest';
import { isEditableFileMember, isEditableRedlineMember } from '../src/code/editable-policy.ts';

/**
 * Which docs get a WRITABLE File view. The editor must only unlock when the
 * server actually writes the doc back to disk — anything else is a surface
 * that silently drops keystrokes. The deleted case is the trap: bindDiff
 * skips the file attach entirely for status='deleted', so there is no
 * binding behind the member even though it is a live working-tree diff doc.
 */
describe('isEditableFileMember', () => {
  const live = { isDiff: true, diffTarget: '', relPath: 'app/src/Main.kt', canWrite: true };

  it('live working-tree source member: editable', () => {
    expect(isEditableFileMember({ ...live, diffStatus: 'modified' })).toBe(true);
    expect(isEditableFileMember({ ...live, diffStatus: 'added' })).toBe(true);
    expect(isEditableFileMember({ ...live })).toBe(true); // status unknown
  });

  it('deleted member: read-only (no file binding exists to write to)', () => {
    expect(isEditableFileMember({ ...live, diffStatus: 'deleted' })).toBe(false);
  });

  it('pinned review: read-only', () => {
    expect(isEditableFileMember({ ...live, diffTarget: 'abc123' })).toBe(false);
  });

  it('.md member: edits go through the markdown surface, not raw source', () => {
    expect(isEditableFileMember({ ...live, relPath: 'docs/README.MD' })).toBe(false);
  });

  it('non-diff docs: read-only', () => {
    expect(isEditableFileMember({ ...live, isDiff: false })).toBe(false);
  });

  // The same rule asked of the other end. The server drops every update
  // frame from a browser that has proven nobody (`WsCtx.readOnly`), which is
  // an unbound doc by another name and loses the typing just as silently —
  // and unlike a REST write there is no 401 for the UI to notice.
  it('a browser the server refuses: read-only, however live the member is', () => {
    expect(isEditableFileMember({ ...live, diffStatus: 'modified', canWrite: false })).toBe(false);
    expect(isEditableFileMember({ ...live, canWrite: false })).toBe(false);
  });
});

/**
 * The redline surface's mirror of the same rule: the redline mount may only
 * become the editable companion editor when the diff targets the LIVE working
 * tree (the companion write-back path exists), the member isn't deleted, and
 * there is a workspace to open the companion through.
 */
describe('isEditableRedlineMember', () => {
  const live = { diffTarget: '', workspaceId: 'ws1' };

  it('live working-tree .md member: editable', () => {
    expect(isEditableRedlineMember({ ...live, diffStatus: 'modified' })).toBe(true);
    expect(isEditableRedlineMember({ ...live, diffStatus: 'added' })).toBe(true);
    expect(isEditableRedlineMember({ ...live })).toBe(true); // status unknown
  });

  it('pinned review (diffTarget set): read-only', () => {
    expect(isEditableRedlineMember({ ...live, diffTarget: 'abc123' })).toBe(false);
  });

  it('deleted member: read-only (nothing on disk to write back to)', () => {
    expect(isEditableRedlineMember({ ...live, diffStatus: 'deleted' })).toBe(false);
  });

  it('no workspace: read-only (no companion doc to open)', () => {
    expect(isEditableRedlineMember({ ...live, workspaceId: '' })).toBe(false);
  });
});
