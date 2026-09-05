/**
 * The doc↔board membership map: which boards hold this doc, who may reach it
 * through one, and does an agent's watch set actually cover them.
 *
 * One question, asked from four directions, which is why these moved out of
 * `createServer` together:
 *
 *  - **Which boards hold an id** — `boardWorkspacesHolding` and the per-listing
 *    index twins built over the same `taskStore` state.
 *  - **Which boards a DOC reaches**, set→board hop included —
 *    `boardsForDoc`, `backTargetFor`, `homeForDocIndexed`.
 *  - **Who may reach it through one** — the share-scope resolver
 *    `shareWorkspacesOf` and the two membership predicates over it, plus the
 *    redemption that writes a membership row.
 *  - **Whether an agent is covered for them** — `watchCoverageFor`, which
 *    reports gaps against exactly the set `boardsForDoc` fans events over.
 *
 * That last pairing is the reason the coverage readout is here rather than
 * beside the watches route: two readings of "which boards" would agree today
 * and drift later, and the drift is invisible in the worst direction — a probe
 * that says "covered" about a board the events never reach.
 *
 * The filing verbs are here for the same reason. `fileUnderBoardWorkspace`,
 * `unfileFromDefault` and `unlinkFromEveryBoardWorkspace` are what WRITE the
 * links every function above reads, and the 403-on-your-own-share bug this
 * file's comments record was a disagreement between the write side and the
 * read side.
 *
 * The context is explicit, the same shape `stall-wiring.ts` and
 * `routes/task-routes-context.ts` use, and every member of it is a VALUE:
 * nothing here is built later than the stores it reads, so `createServer`
 * composes this above the stall wiring and hands that wiring
 * `boardsForDoc` and `backTargetFor` directly rather than as thunks.
 *
 * `boardWorkspacesHolding`, `heldByIndexed`, `queuedForLead` and
 * `defaultBoardWorkspaceId` stay internal: nothing outside this module reached
 * them before the move, and a wider surface is a wider thing to keep true.
 */
import { type DocMeta, attachmentIdOf, normalizeEmail } from '@feedback/core';
import type { DocStore } from './doc-store.ts';
import type { ShareTarget } from './middleware/host-guard.ts';
import { renderShareLinkUnavailable } from './share/share-link-page.ts';
import type { ShareLinks } from './share/share-links.ts';
import { type Shares, audienceEntryAdmits } from './share/shares.ts';
import type { Share } from './share/types.ts';
import type { TaskProjection } from './task-projection.ts';
import type { TaskStore } from './tasks.ts';

/**
 * ── Watch coverage: the answer to "what am I MISSING?" ──────────────────────
 *
 * `list_watched_docs` answers "what am I watching", and the measured incident
 * is that the true answer to that question — six docs, all live — reads as an
 * all-clear while a voice note queues silently for a board the agent never
 * attached to. An agent cannot tell deafness from
 * silence, so it never thinks to ask.
 *
 * These types are what the watches route reports back so it can. Additive:
 * every field is new, so a bundle that predates them ignores an unknown key
 * and keeps working exactly as before.
 */
export interface CoverageQueue {
  queuedVoice: number;
}

/** One `ws:<id>` key in the agent's watch set, resolved. */
export interface CoverageWorkspaceRow {
  key: string;
  workspaceId: string;
  /** `board` — a workspace: tasks, a lead seat, attachments.
   *  `review` — a diff review / folder bind, which has none of those. The
   *  wire value keeps its old spelling. */
  kind: 'board' | 'review';
  /** Board only. Attachment / lead / heartbeat are board facts; printing
   *  `attached: false` for a set would read as a gap that cannot exist. */
  name?: string;
  attached?: boolean;
  /** The displayed active/away label: a heartbeat inside the heartbeat
   *  window. NOT the delivery gate — see `live`. */
  heartbeatFresh?: boolean;
  /** Whether work actually reaches this agent here: recent observed work
   *  (heartbeat or tool call, whichever is later) plus an open channel. This
   *  is the one that answers "am I covered". */
  live?: boolean;
  lead?: boolean;
  queued?: CoverageQueue;
  queuedTotal?: number;
}

/**
 * A board this agent covers on paper but not in fact — the incident,
 * rendered as a row.
 *
 * "Not in fact" is deliberately wider than "has no attachment record". Every
 * delivery gate asks `hasLiveAttachment` / `hasLiveLeadAttachment`, i.e. is
 * there a heartbeat inside the freshness window — so an hour-old attachment
 * satisfies "attached" while the board's whole queue routes to nobody. The
 * first version of this readout tested for the record and was therefore
 * confidently wrong in the one state that matters: a declared lead whose
 * session went quiet, with work visibly piling up.
 */
export interface CoverageUnattachedBoard {
  workspaceId: string;
  name: string;
  /** The watched docs that put this board on the list. Empty when the agent
   *  reached it by holding the board's own `ws:<id>` key — which is what a
   *  declared lead holds, and holds instead of any doc key. */
  watchedDocs: string[];
  queued: CoverageQueue;
  queuedTotal: number;
  /** An attachment RECORD exists for this agent. Not the same as covered. */
  attached: boolean;
  /** …and its heartbeat is inside the heartbeat window, i.e. the board does
   *  not show it as away. Reported because it names which of the two things
   *  lapsed; it is NOT what admitted this row — rows are selected on the
   *  delivery gate, so `attached: true, heartbeatFresh: false` here means
   *  BOTH clocks ran out, not merely the heartbeat one. */
  heartbeatFresh: boolean;
  /** Who holds the lead seat, when anyone does. */
  leadAgentId?: string;
  /** Whether THAT agent is live by the same predicate `setLeadAgent`'s guard
   *  uses. False means the queue has no live addressee; true means somebody
   *  else is already draining it and taking the seat would evict a working
   *  peer — and would be refused. */
  leadLive: boolean;
}

export interface WatchCoverage {
  agentId: string;
  workspaces: CoverageWorkspaceRow[];
  unattachedBoards: CoverageUnattachedBoard[];
}

/**
 * ── A WORKSPACE is a board. Everything else in it is content. ──
 *
 * A workspace (`taskStore`) has goals, tasks, a name, and a list of
 * ATTACHMENT ids in `docIds`. An attachment is a doc room id or an
 * ATTACHMENT SET id — `POST /api/workspaces/:id/docs` has accepted both since
 * it was written. So a set goes on its workspace as ONE row and its members
 * stay off, because a hundred-file set is one unit of work, not a hundred.
 *
 * An ATTACHMENT SET (`meta.setId`, returned as `reviewId` by `bindDiff` —
 * the wire keeps its old spelling) is the tag binding the member docs of one
 * folder bind or diff review together. It is content, not a container of
 * tasks: it has no doc room of its own, and it is read through
 * `/api/reviews/<setId>/tree|threads`. `attachmentIdOf` in `@feedback/core`
 * is the one place a member's set id is derived.
 *
 * Note the board page no longer LISTS attachments: the Docs and
 * Open-threads rails came out (Bryan, 2026-08-18, "remove docs and live
 * threads from the task list"), so `docIds` now feeds the review queue and
 * voice lookup rather than a sidebar.
 *
 * Every doc and every attachment set belongs to a workspace (Bryan,
 * 2026-08-13) —
 * and requiring one must not add a step. "Bind it, send Bryan the URL" is
 * ONE agent call, so a caller with no board in hand does not get an error
 * telling them to go create one first: what arrives unfiled lands on the
 * default board, and the id comes back in the same response so the caller
 * learns where it went.
 */
export const DEFAULT_BOARD_WORKSPACE_NAME = 'Unfiled';

/** What the membership map reads. Every member is a value — see the note at
 *  the top of this file about why none of them needs to be a thunk. */
export interface BoardMembershipContext {
  /** Doc store: id canonicalization and the meta a set id is read from. */
  docStore: DocStore;
  /** The boards themselves: `docIds`, attach/detach, the lead seat, the voice
   *  queue and the attachment records coverage is measured against. */
  taskStore: TaskStore;
  /** The ydoc projection. Attaching and detaching emit no store event, so
   *  every write here refreshes the board room by hand. */
  taskProjection: TaskProjection;
  /** The sharing registry, or null on a server with sharing off. */
  shares: Shares | null;
  /** The share-link store: who redeemed which link. */
  shareLinks: ShareLinks;
  /** A share's target, or null when its workspace is not a board. One rule
   *  for what a share is worth, applied by both membership predicates. */
  boardShareTarget: (share: Share | null | undefined) => ShareTarget | null;
  /** The operator allowlist — this deployment's own people. */
  proxiedTrustedEmails: Set<string>;
}

/** What `createServer` keeps a handle on. */
export interface BoardMembership {
  /** Every workspace an id belongs to, for share scoping. */
  shareWorkspacesOf: (rawId: string) => string[];
  /** Is this Access-verified email a member, on the collaboration hostname. */
  collabMemberOf: (workspaceId: string, email: string | null) => boolean;
  /** …and the same question on the share hostname, against the other record. */
  shareLinkMemberOf: (workspaceId: string, email: string | null) => boolean;
  /** `GET /s/<id>`: turn a verified email into a member. */
  redeemShareLink: (linkId: string, email: string | null) => Response;
  /** Every board a doc's discussion actually reaches. */
  boardsForDoc: (docId: string) => Set<string>;
  /** One pass over the workspaces, for a whole listing. */
  boardIndexForListing: () => Map<string, string[]>;
  /** `boardsForDoc` against that index. */
  boardsForDocIndexed: (index: Map<string, string[]>, meta: DocMeta) => Set<string>;
  /** `resolveWorkspaceForDoc` against that index. */
  homeForDocIndexed: (index: Map<string, string[]>, meta: DocMeta) => string | null;
  /** The coverage readout for one agent's watch set. */
  watchCoverageFor: (agentId: string, keys: string[]) => WatchCoverage;
  /** The board a doc's "back" affordance should return to, or null. */
  backTargetFor: (docId: string, attachmentId?: string) => { id: string; name: string } | null;
  /** Put an attachment on a board workspace and answer which one. */
  fileUnderBoardWorkspace: (attachmentId: string, requested?: string) => string;
  /** Filing onto a real board takes it out of the default holding pen. */
  unfileFromDefault: (attachmentId: string, keptBoardWorkspaceId: string) => void;
  /** A deleted doc or attachment set leaves no link behind. */
  unlinkFromEveryBoardWorkspace: (attachmentId: string) => void;
}

export function createBoardMembership(ctx: BoardMembershipContext): BoardMembership {
  const {
    docStore,
    taskStore,
    taskProjection,
    shares,
    shareLinks,
    boardShareTarget,
    proxiedTrustedEmails,
  } = ctx;

  /**
   * Which workspaces an id belongs to, for SHARE SCOPING (§3.12 commit 8).
   * The id may be a doc room OR an attachment set (folder bind / diff
   * review), and the answer is a SET because those two senses of
   * "workspace" nest:
   *
   *   1. a member doc's own GROUPING     (`meta.workspaceId`)
   *   2. the board the id is filed on directly — docs linked via
   *      attachDoc, each task's `task:<id>` body room, and a set id,
   *      which is how an attachment set goes on a board as one row
   *   3. the board that member's GROUPING is filed on — the hop that
   *      makes a set's row on a shared board actually open. Without it a
   *      board-scoped share saw the row and 403'd on everything behind it,
   *      because every member answers with the set id and the share
   *      carries the board id.
   *
   * ONE rule for both halves of the guard, on purpose: the same function
   * tells the allowlist that a set belongs to a board and tells it that
   * the set's members do. Two rules would agree today and diverge
   * later, and the one that diverges open is the breach.
   *
   * Exactly one hop from set to board — not a transitive closure.
   * Deliberately NOT the ws:<id> board room: its share allowance is spelled
   * out in host-guard, never a resolver side effect.
   */
  const shareWorkspacesOf = (rawId: string): string[] => {
    // Canonicalize FIRST. Boards hold a doc's own id, so an alias asked here
    // resolved to nothing and the share refused a document it covers — a
    // readable URL handed to an outside reviewer would simply not open. This
    // is the one resolver every share-scope predicate reads, which is why the
    // fix belongs here and not in each of them.
    const id = docStore.resolveDocId(rawId);
    const out = new Set<string>();
    const attachmentId = attachmentIdOf(docStore.peekMeta(id) ?? {});
    if (attachmentId) out.add(attachmentId);
    for (const board of boardWorkspacesHolding(id)) out.add(board);
    if (attachmentId) for (const board of boardWorkspacesHolding(attachmentId)) out.add(board);
    return Array.from(out);
  };

  /**
   * EVERY board an attachment is linked to — not the first one.
   *
   * `attachDoc` links, it does not move: only the default holding pen is
   * unfiled on the way (see `unfileFromDefault`), so a set deliberately
   * put on two real boards is on both. `taskStore.workspaceOfDoc` answers
   * with whichever the store iterates first, which for share scoping means
   * the visitors of every OTHER board holding it are refused the row their
   * own board shows them — the exact 403-on-your-own-share failure
   * `unfileFromDefault` records, surviving in the case it cannot fix,
   * because there both links are legitimate and neither may be dropped.
   *
   * `task:<id>` keeps the store's own resolution: a task body belongs to its
   * task's workspace, which is a field rather than a link, so it has one
   * answer by construction.
   */
  function boardWorkspacesHolding(attachmentId: string): string[] {
    if (attachmentId.startsWith('task:')) {
      const w = taskStore.workspaceOfDoc(attachmentId);
      return w ? [w] : [];
    }
    return taskStore
      .listWorkspaces()
      .filter((w) => w.docIds.includes(attachmentId))
      .map((w) => w.id);
  }

  /**
   * Is this Access-verified email a MEMBER of this workspace — the question
   * the collaboration hostname asks after Cloudflare Access has answered
   * "is this someone Bryan admitted to the hostname at all?".
   *
   * The two are not the same question, and treating them as one was the
   * weakness this closes: every email the Access application admitted could
   * open every workspace on the server by id, because the only thing checked
   * after the token was whether the PATH was in scope for the workspace it
   * named. A share hostname never had that problem — it is minted for one
   * workspace with one allow list — so the fix is to give the collaboration
   * hostname the same record rather than a new one.
   *
   * THE MEMBERSHIP SET, exactly: the allow lists of the workspace's LIVE
   * shares, plus the owner allowlist. A share is the only place an email is
   * ever written down against a workspace, so a workspace with no live share
   * admits nobody here — which is the correct answer, not a gap: nobody has
   * been given it.
   *
   * Three details, each of which would otherwise be a hole:
   *
   *   - The candidate set is the workspace itself PLUS every workspace that
   *     covers it (`shareWorkspacesOf`). A doc's path resolves to its SET,
   *     while the share that admits people is minted on the BOARD the set
   *     is filed on, so checking the path's workspace alone would refuse
   *     every legitimately shared diff review and folder bind. This is the
   *     same set `shareScopeAllows` reaches through, so it grants exactly
   *     what a share on one of those boards already grants — no wider.
   *   - `boardShareTarget` is applied to each share, so a record whose
   *     workspace no longer EXISTS as a board is as dead here as it is on
   *     its own hostname. One rule for what a share is worth. Note what that
   *     is not: a board that still exists and has merely been RETIRED is
   *     still a board (`isBoard` asks `getWorkspace`, and `retiredAt` is a
   *     field on a row that stays), so retiring admits and revokes nobody.
   *     Ending one person's access is `remove_share_member`, which is
   *     immediate and hangs up their live connections; revoking the link
   *     stops new redemptions and leaves the people who already used it.
   *   - A token with NO email claim is nobody, and nobody is a member. It
   *     reaches the app shell and nothing else.
   */
  const collabMemberOf = (workspaceId: string, email: string | null): boolean => {
    const who = email ? normalizeEmail(email) : '';
    if (who === '' || !workspaceId) return false;
    // The owner half. Same list the operator hostname checks and the same
    // list a `share_link` with no audience falls back to, so "who is this
    // deployment's own people" has one answer.
    if (proxiedTrustedEmails.has(who)) return true;
    if (!shares) return false;
    const candidates = new Set<string>([workspaceId, ...shareWorkspacesOf(workspaceId)]);
    for (const wsId of candidates) {
      for (const share of shares.liveForWorkspace(wsId)) {
        if (!boardShareTarget(share)) continue;
        if ((share.allowDomains ?? []).some((entry) => audienceEntryAdmits(entry, who))) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * Is this Access-verified email a member of this workspace, on the SHARE
   * hostname — the question asked after Cloudflare has confirmed an address
   * that its "everyone" policy admitted without knowing anything about them.
   *
   * Deliberately NOT `collabMemberOf`, and the separation is the whole
   * security property of the share hostname. That function's membership set
   * is the allow lists of a workspace's live shares plus the owner allowlist
   * — records that say "the operator named this person". The share hostname's
   * application names nobody, so reusing it would answer the question with a
   * record that was written about a different door: every address the
   * operator ever allow-listed anywhere would reach the share host, and every
   * redeemed reviewer would reach the collaboration host. Two doors, two
   * records, and a redemption grants exactly one of them.
   *
   * The candidate set is the workspace itself PLUS every workspace that
   * covers it, for the reason `collabMemberOf` gives at the same line: a
   * doc's path resolves to its SET, while the link that admitted people
   * was minted on the BOARD the set is filed on. Same set
   * `shareScopeAllows` reaches through, so it grants exactly what the board's
   * own link already grants — no wider.
   *
   * `boardShareTarget`'s rule applies here too, spelled as the lookup it is:
   * a workspace that is not a board grants nothing.
   *
   * This used to end "so a link minted before a board was retired stops
   * admitting people the moment it stops being a board", and that was simply
   * false — `getWorkspace` answers for a retired board exactly as it does for
   * a live one, because retirement is a field on a row that stays and is
   * reversible (`unretire_workspace`). Retiring a board is not a revocation
   * and must not be relied on as one; see `collabMemberOf` above and the
   * "Two verbs end access" paragraph in `docs/architecture/security.md` for
   * the two that are. Left as a comment fix rather than a behaviour change
   * on purpose: hanging a person's access on a reversible lifecycle flag
   * would revoke and restore it silently, and the deliberate verb already
   * exists.
   *
   * A token with NO email claim is nobody, and nobody is a member.
   */
  const shareLinkMemberOf = (workspaceId: string, email: string | null): boolean => {
    if (!email || !workspaceId) return false;
    const candidates = new Set<string>([workspaceId, ...shareWorkspacesOf(workspaceId)]);
    for (const wsId of candidates) {
      if (!taskStore.getWorkspace(wsId)) continue;
      if (shareLinks.isMember(wsId, email)) return true;
    }
    return false;
  };

  /**
   * `GET /s/<id>` on the share hostname: turn a verified email into a member.
   *
   * The ONLY write a non-member can make here, and its whole content is the
   * caller's own Access-verified address against the workspace the link
   * already names. Nothing in the request body or the path can change WHICH
   * workspace — that came from the record.
   *
   * Everything that is not a live link on a live board renders the one
   * unavailable page and records nothing: revoked, expired, unknown,
   * malformed, and a workspace that is no longer a board. Four answers would
   * let anyone with the route learn which ids exist by the difference between
   * them, so there is one.
   *
   * The board check runs BEFORE the redeem, so a link whose board was retired
   * writes no membership row on its way to being refused.
   *
   * Success is a redirect to the board on this same hostname, which is where
   * a returning member's next visit goes directly.
   */
  const redeemShareLink = (linkId: string, email: string | null): Response => {
    const unavailable = () =>
      new Response(renderShareLinkUnavailable(), {
        status: 404,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Keeps the link id out of any downstream Referer, the same reason
          // the retired link routes set it.
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
        },
      });
    const link = shareLinks.get(linkId);
    if (!link || !taskStore.getWorkspace(link.workspaceId)) return unavailable();
    const outcome = shareLinks.redeem(linkId, email ?? '');
    if (!outcome.ok) return unavailable();
    return new Response(null, {
      status: 302,
      headers: {
        location: `/workspaces/${encodeURIComponent(outcome.workspaceId)}`,
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      },
    });
  };

  /**
   * Every board a DOC's discussion actually reaches — the boards holding
   * the doc itself, plus the one set→board hop a diff review / folder
   * bind needs (its members carry the set tag, and the set is what
   * sits on the board as one row).
   *
   * Written once and used twice on purpose: `onDocRoomEvent` fans events out
   * over exactly this set, and the coverage readout reports gaps against
   * exactly this set. Two copies would agree today and drift later, and the
   * drift would be invisible in the worst direction — a probe that says
   * "covered" about a board the events never reach is the failure this
   * ticket exists to end, restated as a reassuring answer.
   */
  function boardsForDoc(docId: string): Set<string> {
    const boards = new Set(boardWorkspacesHolding(docId));
    const attachmentId = attachmentIdOf(docStore.peekMeta(docId) ?? {});
    if (attachmentId) for (const board of boardWorkspacesHolding(attachmentId)) boards.add(board);
    return boards;
  }

  /**
   * The same three questions as `boardWorkspacesHolding` / `boardsForDoc` /
   * `resolveWorkspaceForDoc`, answered for a WHOLE LISTING from one pass over
   * the workspaces instead of one pass per row.
   *
   * The per-id versions above allocate a fresh array of every board and scan
   * each one's `docIds`. That is the right shape for a single lookup and the
   * wrong shape for a listing. `GET /api/docs` asked twice per row — once for
   * the doc, once for the set-id fallback — so the work grew with the
   * SQUARE of the doc count, and docs no board holds paid for both halves —
   * which, once a server accumulates diff-review members, is most of them.
   *
   * That matters more than a slow response suggests, because Bun runs JS on
   * one thread: a listing that takes tens of seconds is tens of seconds in
   * which the server answers nothing else — no page, no board, no MCP call.
   * Nor does anything report it, since the process stays alive and stays
   * BOUND the whole time. A supervisor that asks whether the port is
   * listening, as the bind-health watchdog in `scripts/serve.ts` does, sees
   * a healthy server; it never asks whether the server answers.
   *
   * These read the same `taskStore` state the per-id versions read and are
   * kept beside them deliberately — two answers to one question drift, and
   * the drift here would be a wrong URL rather than a slow one.
   */
  function boardIndexForListing(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const w of taskStore.listWorkspaces()) {
      for (const id of w.docIds) {
        const boards = index.get(id);
        if (boards) boards.push(w.id);
        else index.set(id, [w.id]);
      }
    }
    return index;
  }

  /**
   * `boardWorkspacesHolding` against a prebuilt index.
   *
   * `task:` ids are deliberately absent from the index and fall through to
   * `workspaceOfDoc`, exactly as the per-id version routes them: a task room
   * is looked up by id rather than scanned for, and is never in any board's
   * `docIds` to begin with.
   */
  function heldByIndexed(index: Map<string, string[]>, attachmentId: string): string[] {
    if (attachmentId.startsWith('task:')) {
      const w = taskStore.workspaceOfDoc(attachmentId);
      return w ? [w] : [];
    }
    return index.get(attachmentId) ?? [];
  }

  /** `boardsForDoc` against a prebuilt index. The caller already holds the
   *  row's meta, so the set id is read from it rather than re-fetched. */
  function boardsForDocIndexed(index: Map<string, string[]>, meta: DocMeta): Set<string> {
    const boards = new Set(heldByIndexed(index, meta.docId));
    const attachmentId = attachmentIdOf(meta);
    if (attachmentId) for (const board of heldByIndexed(index, attachmentId)) boards.add(board);
    return boards;
  }

  /**
   * `resolveWorkspaceForDoc` against a prebuilt index.
   *
   * Mirrors `backTargetFor`'s `pick(a) ?? pick(b)` exactly, including that a
   * first board which fails the `getWorkspace` check does NOT fall through to
   * a second board holding the same id — it falls through to the set-id
   * lookup. (In practice the check cannot fail: `getWorkspace` reads the very
   * map `listWorkspaces` was built from. It is kept so this stays a
   * transcription of the original rather than a judgement about it.)
   */
  function homeForDocIndexed(index: Map<string, string[]>, meta: DocMeta): string | null {
    const pick = (id: string | undefined): string | null =>
      id && taskStore.getWorkspace(id) ? id : null;
    return (
      pick(heldByIndexed(index, meta.docId)[0]) ??
      pick(heldByIndexed(index, attachmentIdOf(meta) ?? '')[0])
    );
  }

  /**
   * What is waiting for this board's lead, COUNTED WITHOUT DRAINING.
   *
   * The reader here is the non-destructive one: `listQueuedVoice`, not
   * `drainVoiceQueue`. That is not incidental. A probe that delivered while
   * reporting would be right exactly once and would then have consumed the
   * items the attach it was warning about was supposed to receive — this
   * ticket's own silent-loss bug, wearing the costume of the fix.
   */
  const queuedForLead = (workspaceId: string): CoverageQueue => ({
    queuedVoice: taskStore.listQueuedVoice(workspaceId).length,
  });
  const queueTotal = (q: CoverageQueue): number => q.queuedVoice;

  /**
   * The coverage readout for one agent's watch set.
   *
   * Two halves, answering two different questions:
   *
   *  - `workspaces` resolves each `ws:<id>` key the agent holds. A key can
   *    name a BOARD or an attachment SET, and today nothing tells the
   *    agent which — so nothing tells it that a board key without an
   *    attachment hears the events but is invisible to every delivery gate.
   *  - `unattachedBoards` is the measured incident: boards this agent covers
   *    on paper but not in fact, each with the count of items queued for that
   *    board's lead. Six docs watched, zero attachments, four items waiting.
   *
   * TWO THINGS PUT A BOARD ON THAT LIST, and the second was missing while
   * this feature's whole point was to create agents of exactly that shape:
   *
   *  - a DOC key the agent holds that resolves to the board, and
   *  - the board's OWN `ws:<id>` key — which is all a declared lead holds. It
   *    holds no doc keys at all, so building the list from doc keys alone
   *    made the one agent this branch teaches the fleet to be the one agent
   *    the probe could not see.
   *
   * A `ws:<setId>` key still raises nothing. It resolves to the board the
   * set sits on, but the agent asked about the set, not about somebody
   * else's seat — and an alarm that fires on the innocent case is how a real
   * one stops being read.
   *
   * "Not in fact" means no LIVE attachment: no record, or a record whose
   * heartbeat has aged out. The gates ask the second question, so this must
   * too, or it reports covered about a board whose every gate answers away.
   */
  const watchCoverageFor = (agentId: string, keys: string[]): WatchCoverage => {
    /**
     * Attachment facts for one agent on one board.
     *
     * Two DIFFERENT questions, deliberately kept apart. `heartbeatFresh` is
     * the displayed active/away label: did this agent SAY it was alive inside
     * the heartbeat window. `live` is the delivery gate: has the server SEEN
     * it recently — heartbeat or tool call, whichever is later — and is the
     * channel open to carry anything.
     *
     * They were one field, and it read the label. The label's window is a
     * third of the delivery one, so an agent that had simply not called
     * `heartbeat` for a few minutes was reported as uncovered while every
     * request was reaching it perfectly — and the remedy it was then handed
     * is seat-claiming, whose entire hazard is evicting a working peer.
     */
    const liveness = (workspaceId: string, who: string) => {
      const att = taskStore.listAttachments(workspaceId).find((a) => a.agentId === who);
      return {
        attached: att !== undefined,
        heartbeatFresh: att !== undefined && att.state !== 'away',
        live: taskStore.hasLiveAttachmentFor(workspaceId, who),
      };
    };

    const workspaces: CoverageWorkspaceRow[] = [];
    /** boardId → the watched doc keys that put it there (empty for a board
     *  reached through its own `ws:` key). */
    const boardsInScope = new Map<string, string[]>();
    for (const key of keys) {
      if (!key.startsWith('ws:')) continue;
      const workspaceId = key.slice('ws:'.length);
      const board = taskStore.getWorkspace(workspaceId);
      if (!board) {
        // Not a board. The key survived the liveness prune, so some doc room
        // still carries this set id.
        workspaces.push({ key, workspaceId, kind: 'review' });
        continue;
      }
      const { attached, heartbeatFresh, live } = liveness(workspaceId, agentId);
      const queued = queuedForLead(workspaceId);
      workspaces.push({
        key,
        workspaceId,
        kind: 'board',
        name: board.name,
        attached,
        heartbeatFresh,
        live,
        lead: board.leadAgentId === agentId,
        queued,
        queuedTotal: queueTotal(queued),
      });
      if (!boardsInScope.has(workspaceId)) boardsInScope.set(workspaceId, []);
    }

    for (const key of keys) {
      if (key.startsWith('ws:')) continue;
      for (const boardId of boardsForDoc(key)) {
        boardsInScope.set(boardId, [...(boardsInScope.get(boardId) ?? []), key]);
      }
    }
    const unattachedBoards: CoverageUnattachedBoard[] = [];
    for (const [workspaceId, watchedDocs] of boardsInScope) {
      const board = taskStore.getWorkspace(workspaceId);
      if (!board) continue;
      const mine = liveness(workspaceId, agentId);
      // A LIVE attachment is coverage; a record alone is not. Read the
      // DELIVERY predicate, not the displayed label — this row's whole claim
      // is "work is queuing that will not reach you", and an agent inside the
      // observed window is being reached.
      if (mine.live) continue;
      const queued = queuedForLead(workspaceId);
      const lead = board.leadAgentId;
      unattachedBoards.push({
        workspaceId,
        name: board.name,
        watchedDocs: [...watchedDocs].sort(),
        queued,
        queuedTotal: queueTotal(queued),
        attached: mine.attached,
        heartbeatFresh: mine.heartbeatFresh,
        ...(lead !== undefined ? { leadAgentId: lead } : {}),
        // Naming the incumbent is what stops the remedy being "take the
        // seat" on a board somebody else is actively working. This asks the
        // same predicate `setLeadAgent`'s own lead-held guard asks, which is
        // the point: read the heartbeat LABEL here and a working lead reports
        // as gone, so the advice says "take the seat" while the server's
        // guard refuses it — the reader is told to do a thing that then
        // silently does not happen.
        leadLive:
          lead !== undefined && lead !== agentId && taskStore.hasLiveLeadAttachment(workspaceId),
      });
    }
    // Loudest first: a board with items actually waiting is the one a reader
    // must not scroll past.
    unattachedBoards.sort((a, b) => b.queuedTotal - a.queuedTotal || a.name.localeCompare(b.name));
    return { agentId, workspaces, unattachedBoards };
  };

  /**
   * The default board workspace, created on first need.
   *
   * Found by LOOKUP, never remembered in a variable: the store hydrates from
   * disk on boot, so a cached id would fragment into one "Unfiled" per restart
   * — which is the same as no workspace at all, one board per doc.
   */
  const defaultBoardWorkspaceId = (): string => {
    const existing = taskStore
      .listWorkspaces()
      .find((w) => w.name === DEFAULT_BOARD_WORKSPACE_NAME);
    if (existing) return existing.id;
    const created = taskStore.createWorkspace(DEFAULT_BOARD_WORKSPACE_NAME);
    // createWorkspace emits no event (nothing subscribes to a workspace that
    // doesn't exist yet), so bring the board room up by hand — same as the
    // POST /api/workspaces route.
    taskProjection.ensureWorkspace(created.id);
    return created.id;
  };

  /**
   * The board a doc's "back" affordance should return to, or null.
   *
   * Deliberately NOT `taskStore.workspaceOfDoc`, and the difference is the
   * whole reason this exists. That resolver answers a SHARE-SCOPE question and
   * is documented as non-transitive: a diff review / folder browse is filed on
   * a board as ONE row under its GROUPING id, so every member doc of every
   * set answers null there. Reusing it would fix back for plain docs and
   * leave it broken for exactly the surface Bryan reads most.
   *
   * Widening `workspaceOfDoc` itself would have widened share scoping with it,
   * which is a security decision and not this one — so the fallback lives here
   * and reaches only this field.
   *
   * A doc genuinely on two boards has two answers; the first is taken rather
   * than none, because "back to one of this doc's boards" beats "back to the
   * index of everything on the machine", which is what the arrow does today.
   */
  const backTargetFor = (
    docId: string,
    attachmentId?: string,
  ): { id: string; name: string } | null => {
    const pick = (id: string | undefined): { id: string; name: string } | null => {
      if (!id) return null;
      const ws = taskStore.getWorkspace(id);
      return ws ? { id: ws.id, name: ws.name } : null;
    };
    return (
      pick(boardWorkspacesHolding(docId)[0]) ?? pick(boardWorkspacesHolding(attachmentId ?? '')[0])
    );
  };

  /**
   * Put an attachment — a doc room id OR a set id — on a board workspace and
   * answer which one. Idempotent: something already attached keeps the board it
   * has (moving it is `attach_doc`'s job, not a side effect of re-binding, and
   * re-running `create_diff_review` on a live set is documented as safe). A
   * `requested` id that names no real board falls back to the default rather
   * than failing the bind — the whole point is that it always lands somewhere.
   */
  const fileUnderBoardWorkspace = (attachmentId: string, requested?: string): string => {
    const existing = taskStore.workspaceOfDoc(attachmentId);
    if (existing) return existing;
    const target =
      requested && taskStore.getWorkspace(requested) ? requested : defaultBoardWorkspaceId();
    taskStore.attachDoc(target, attachmentId);
    // attachDoc emits no store event; refresh the projection's docIds.
    taskProjection.ensureWorkspace(target);
    return target;
  };

  /**
   * Filing an attachment onto a real board takes it OUT of the default one.
   *
   * Without this, the usual agent flow — create it, then attach it — leaves it
   * linked to two board workspaces, and `workspaceOfDoc` answers with whichever
   * the store iterates first. That is not cosmetic: it is what SHARE SCOPING
   * resolves against, so a workspace visitor was refused (403) on the very doc
   * the share was created for. The default board is a holding pen, not a second
   * home.
   */
  const unfileFromDefault = (attachmentId: string, keptBoardWorkspaceId: string): void => {
    // `find`, never `defaultBoardWorkspaceId()` — filing something must not
    // conjure a holding pen on a server that has never needed one.
    const holding = taskStore.listWorkspaces().find((w) => w.name === DEFAULT_BOARD_WORKSPACE_NAME);
    if (!holding || holding.id === keptBoardWorkspaceId) return;
    const res = taskStore.detachDoc(holding.id, attachmentId);
    if (res.ok && res.removed) taskProjection.ensureWorkspace(holding.id);
  };

  /**
   * A deleted doc — or a deleted SET, which is deleted as one unit and is
   * one row on the board — leaves no link behind. This mattered little while
   * attaching was a deliberate act on a handful of docs; now that everything is
   * filed, a board would otherwise silently accumulate one tombstone per
   * deletion, invisible in the UI because a dangling id renders as nothing.
   */
  const unlinkFromEveryBoardWorkspace = (attachmentId: string): void => {
    for (const w of taskStore.listWorkspaces()) {
      const res = taskStore.detachDoc(w.id, attachmentId);
      if (res.ok && res.removed) taskProjection.ensureWorkspace(w.id);
    }
  };

  return {
    shareWorkspacesOf,
    collabMemberOf,
    shareLinkMemberOf,
    redeemShareLink,
    boardsForDoc,
    boardIndexForListing,
    boardsForDocIndexed,
    homeForDocIndexed,
    watchCoverageFor,
    backTargetFor,
    fileUnderBoardWorkspace,
    unfileFromDefault,
    unlinkFromEveryBoardWorkspace,
  };
}
