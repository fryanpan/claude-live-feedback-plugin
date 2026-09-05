import type { DocMeta } from './types.ts';

/**
 * ── One noun. A WORKSPACE is a board: a goal list, tasks, members, docs, and
 * a URL at `/workspaces/<id>`. Nothing else is called a workspace. ──
 *
 * What `attach_folder` / `create_diff_review` produce is an ATTACHMENT SET: a
 * set of docs over the files of one folder or one diff range, filed on a
 * workspace as a single row. It used to be called a "grouping workspace" and
 * then a "review", and neither is what it is — "review" now means only the
 * person-facing queue of review items (glossary Decision 2).
 *
 * The id field is `setId`. It is not a new key — every bind has written it,
 * alongside the old `workspaceId`, for as long as binds have existed
 * (`binds.ts` sets both to the same string on every member). Measured across
 * the 4039 docs in the live data dir on 2026-08-21: 3243 carry both fields
 * with identical values, 0 carry `workspaceId` without `setId`, and 0
 * disagree. So reading `setId` first loses nothing and needs no migration —
 * the bytes on disk already say what the new code wants to read.
 */

/**
 * The attachment set this doc belongs to, or undefined for a standalone doc.
 *
 * The `workspaceId` fallback is for a doc written before `setId` was, which
 * the measurement above says does not exist — it is kept for one release
 * because a doc could be restored from an archive taken before it, and
 * because a fallback that never fires costs one `??`.
 */
export const attachmentIdOf = (meta: Pick<DocMeta, 'setId' | 'workspaceId'>): string | undefined =>
  meta.setId ?? meta.workspaceId;

/**
 * Whether this doc is a member of an ATTACHMENT SET, as opposed to a doc that
 * merely shares a `setId` with others.
 *
 * `relPath` is the discriminator, and it has to be: `setId` predates binds as
 * a batch-registration tag on `create_review_doc`, so 129 docs in the live
 * data dir share a set without belonging to any folder or diff. They get a
 * sibling sidebar and nothing else — no tree, no refresh, no diff groups —
 * and surfacing them as attachment sets would invent 40-odd sets nobody made.
 *
 * Deliberately `relPath` rather than `workspaceRoot`, which would also
 * separate the two sets: `workspaceRoot` is private-meta (it names a path on
 * the host machine) and is redacted for share visitors, so a predicate built
 * on it answers differently depending on who is asking.
 */
export const isAttachmentMember = (
  meta: Pick<DocMeta, 'setId' | 'workspaceId' | 'relPath'>,
): boolean => attachmentIdOf(meta) !== undefined && typeof meta.relPath === 'string';
