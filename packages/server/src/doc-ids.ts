import { randomBytes } from 'node:crypto';

/**
 * Who is allowed to bring a docId into existence, and where.
 *
 * The doc id space is shared: a caller-chosen attachment, a folder member, a
 * task's body room and a board room are all just strings in the same map, and
 * the same string reaches disk as a filename. That shared space is the reason
 * two holes existed at once — a folder bound as `setId: 'task'` minted real
 * `task:README.md` rooms, and `POST /api/docs` with `docId: 'task:<realId>'`
 * landed on a live task's body and file-bound it. Neither needed a bug in the
 * route it came through; both needed only that nothing asked whether the
 * CALLER was entitled to that part of the space.
 *
 * So entitlement is asked once, at the seam where a room is created, rather
 * than enumerated across the doors that reach it. An allowlist of entry points
 * already missed `POST /api/docs` once.
 */
export type DocIdAuthority =
  /** The server itself: the task projection's body and board rooms, and
   *  hydration, which is re-admitting ids that already exist on disk. */
  | 'server'
  /** Anything driven by a request. Default, because a missing opt-in must
   *  fail closed — the failure mode this guard exists for is a door nobody
   *  remembered to list. */
  | 'caller';

/** Prefixes whose rooms the server owns — never file-bound, content projected
 *  from the task store rather than typed into a doc. */
export const BOARD_DOC_PREFIXES = ['ws:', 'task:'] as const;

/**
 * Docs the BOARD owns rather than the filesystem: the `ws:<workspaceId>`
 * board room and every `task:<taskId>` body room (§3.3). They are never
 * bound to a file, so a `sourceUrl` on one is by construction not ours —
 * and unlike a bound doc they have no private-meta sidecar to outvote a
 * forged value.
 *
 * This answers "is this room's content server-owned". `isReservedDocId`
 * answers the different question "may a caller occupy this address", and is a
 * superset — both read the same prefix list, one line apart, so the two can
 * never disagree about `ws:` and `task:`. It lives here rather than in
 * `doc-store.ts` for that reason, and `doc-store.ts` re-exports the name it was
 * first published under.
 */
export function isBoardOwnedDoc(docId: string): boolean {
  return BOARD_DOC_PREFIXES.some((p) => docId.startsWith(p));
}

/**
 * Prefixes a CALLER may never create or name.
 *
 * A superset of the board room prefixes: `goal:` reserves the namespace for the
 * goal ids minted in `tasks.ts`, which are not rooms today. Reserving ahead of
 * the room is deliberate — a namespace is cheap to hold and expensive to
 * reclaim once callers have addresses inside it.
 */
export const RESERVED_DOC_PREFIXES = [...BOARD_DOC_PREFIXES, 'goal:'] as const;

/** Is this an address only the server may occupy? */
export function isReservedDocId(docId: string): boolean {
  return RESERVED_DOC_PREFIXES.some((p) => docId.startsWith(p));
}

/**
 * Thrown when caller authority meets a reserved id at the creation seam.
 *
 * Reaching it means a door got past its own check, so it is loud rather than
 * a silent skip: the routes that a caller can actually steer refuse with a
 * 400 `reserved-namespace` before they get here, and this is what makes the
 * refusal a property of the system instead of a property of those routes.
 */
export class ReservedDocIdError extends Error {
  readonly docId: string;
  constructor(docId: string) {
    super(`docId "${docId}" is in a namespace the server owns`);
    this.name = 'ReservedDocIdError';
    this.docId = docId;
  }
}

/**
 * A doc's permanent id.
 *
 * `d-` + 9 random bytes base64url, matching `newGoalId`. Random rather than
 * derived from the caller's name, the path, or the title, because every one
 * of those is a property a person later wants to CHANGE — and an id that
 * encodes a mutable property is an id whose only correction is a re-key.
 * Goals learned this the expensive way: `g1-loop` / `g2-reach` encoded
 * PRIORITY, so restating a band meant re-keying it, which read to the store
 * as one goal removed and another added.
 *
 * The readable name lives beside it as an alias, which is editable in the
 * only sense that matters — a new alias can be minted — while never moving
 * what it points at.
 */
export function newDocId(): string {
  return `d-${randomBytes(9).toString('base64url')}`;
}

/** Was this id minted by `newDocId`? Used to tell a grandfathered
 *  caller-chosen primary id from a minted one without a lookup. */
export function isMintedDocId(docId: string): boolean {
  return /^d-[A-Za-z0-9_-]{12}$/.test(docId);
}

/**
 * The one doc every board's feedback widget writes to.
 *
 * Deliberately NOT per-workspace: a comment on the board UI is about the
 * product, so it should reach the same agent from every board rather than
 * whoever happens to own the workspace you were standing in. The anchor's
 * url carries which board it came from.
 *
 * The value keeps the prefix of the old product name on purpose. It is not a
 * class name: it names a doc that already exists in the corpus, so changing
 * the string orphans every comment written on the board so far. Renaming it is
 * a migration, not a rename pass.
 */
export const BOARD_FEEDBACK_DOC_ID = 'lf-hub-feedback';
