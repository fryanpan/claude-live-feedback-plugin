import { describe, expect, it } from 'vitest';
import { isEditableFileMember } from '../src/code/editable-policy.ts';

/**
 * Which docs get a WRITABLE File view. The editor must only unlock when the
 * server actually writes the doc back to disk — anything else is a surface
 * that silently drops keystrokes. The deleted case is the trap: bindDiff
 * skips the file attach entirely for status='deleted', so there is no
 * binding behind the member even though it is a live working-tree diff doc.
 */
describe('isEditableFileMember', () => {
  const live = { isDiff: true, diffTarget: '', relPath: 'app/src/Main.kt' };

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
});
