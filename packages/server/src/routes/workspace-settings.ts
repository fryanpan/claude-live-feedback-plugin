import { DEFAULT_EFFORT_ESTIMATE_PROMPT } from '@feedback/core/effort-estimate-prompt';
import { DEFAULT_REVIEW_ITEM_CRITERIA } from '@feedback/core/review-judge-prompt';
/**
 * The board's own fields: its goal, its retirement, its parallelism cap, its settings, its name, its lead and its voice.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `WorkspaceRoutesContext` instead of the scope.
 */
import { canonicalRepoRoot, normalizeDocOriginRepo } from '../doc-origin-repo.ts';
import { redactCapChangeForVisitor } from '../share/redact-workspace.ts';
import { PARALLELISM_CAP_MAX, PARALLELISM_CAP_MIN, type WorkspaceNotesHome } from '../tasks.ts';
import { parseVoiceContext } from '../voice.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

// Moved down from server.ts with the settings route below, their only caller.
/** The longest criteria prompt a board may hold. A page of instructions is
 *  fine; a pasted document is not what the field is for, and every filing
 *  sends the whole thing to the judge. */
const REVIEW_ITEM_CRITERIA_MAX_CHARS = 4_000;
/** Same ceiling and the same reason as the review criteria above — a page
 *  of instructions is fine, and every scoring run sends the whole thing. */
const EFFORT_ESTIMATE_PROMPT_MAX_CHARS = 4_000;

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceSettings(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, voiceRouter, j, safeJson, parallelismCapView } = ctx;
  const { req, pathname, authorFor, visitor } = rq;
  // The workspace-level TEXT goal is GONE — the ordered goal LIST is
  // the one goal system now. This route stays because it is on the
  // SHARED server: plugin bundles built before the removal still call
  // it from sessions nobody can restart, and a 404 here is
  // indistinguishable from a bad workspace id while a 500 reads as an
  // outage. So it answers deliberately, and it answers 410 rather than
  // a 200 no-op: the caller is an agent that would otherwise record
  // "goal set" for a write that never happened, and the MCP client
  // surfaces a non-2xx body verbatim, which is how the sentence below
  // reaches whoever needs to read it.
  const wsGoalMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/goal$/);
  if (wsGoalMatch && req.method === 'PUT') {
    return j(410, {
      deprecated: true,
      error:
        "the workspace-level text goal was removed — a workspace's goals are the ordered " +
        'goal LIST now. Use set_goal_list to write the bands, rename_goal to retitle one, ' +
        'reorder_goals to rank them, and set_task_goal to place work under one. Nothing ' +
        'was written by this call.',
    });
  }
  // retire_workspace / unretire_workspace: stand a board down, or bring
  // it back. Deliberately NOT a flag on DELETE — that route rmSyncs the
  // tasks sidecar and the events log, and this one writes a single
  // field on a record that is already serialized wholesale, so nothing
  // it does needs undoing beyond writing the field again.
  const wsRetiredMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/retired$/);
  if (wsRetiredMatch && req.method === 'PUT') {
    const workspaceId = decodeURIComponent(wsRetiredMatch[1] ?? '');
    const body = await safeJson(req);
    const retired = body?.retired;
    // Explicit both ways. A missing field defaulting to `true` would
    // make an empty body retire a board, which is the one direction
    // that must never happen by accident.
    if (typeof retired !== 'boolean') {
      return j(400, { error: 'retired must be true or false' });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    const res = taskStore.setWorkspaceRetired(workspaceId, retired, {
      actor: author,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (!res.ok) return j(404, res);
    // The store emits, but the projection reads the workspace record
    // rather than the event payload, so the board room needs telling
    // that the record moved — otherwise the badge appears only when
    // some unrelated mutation next touches this workspace, which on a
    // board somebody just retired is never.
    taskProjection.ensureWorkspace(workspaceId);
    return j(200, res);
  }
  // The board's parallelism cap on its own address (Bryan, 2026-08-31:
  // "Bryan and Team Lead can set a parallelism limit on the workspace").
  // GET reads it; PUT `{cap}` sets it, `{cap: null}` restores the
  // default. Both answer with the full view — cap, default, slots in
  // use, who holds them, how many are free — so the caller that just
  // lowered the cap sees in the same response whether the board is
  // already over it. It takes effect on the NEXT dispatch: nothing
  // running is touched, and the stall check and both nudges read the
  // new number on their next pass. Own route rather than only a field
  // on `/settings` because Team Lead's session calls REST directly to
  // manage cross-project capacity, and a one-field verb is the shape
  // that call wants; `/settings` still carries the field for the panel.
  const wsCapMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/parallelism-cap$/);
  if (wsCapMatch && (req.method === 'GET' || req.method === 'PUT')) {
    const workspaceId = decodeURIComponent(wsCapMatch[1] ?? '');
    if (!taskStore.getWorkspace(workspaceId)) {
      return j(404, { error: 'workspace not found' });
    }
    if (req.method === 'PUT') {
      const body = await safeJson(req);
      if (!body || !Object.hasOwn(body, 'cap')) {
        return j(400, { error: 'cap required: an integer, or null to restore the default' });
      }
      const raw = body.cap;
      if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw))) {
        return j(400, { error: 'cap must be an integer, or null to restore the default' });
      }
      // Zero is refused outright rather than stored: it would turn every
      // dispatch away with nothing to wait for. "Lower it" bottoms out
      // at one (PARALLELISM_CAP_MIN) — pausing a board is a different
      // verb (retire_workspace), not a cap.
      if (typeof raw === 'number' && (raw < PARALLELISM_CAP_MIN || raw > PARALLELISM_CAP_MAX)) {
        return j(400, {
          error: `cap must be between ${PARALLELISM_CAP_MIN} and ${PARALLELISM_CAP_MAX}`,
        });
      }
      const actor = authorFor(body.author) ?? {
        id: 'agent-unknown',
        name: 'unknown',
        kind: 'agent',
      };
      const res = taskStore.setParallelismCap(
        workspaceId,
        typeof raw === 'number' ? raw : undefined,
        { actor },
      );
      if (!res.ok) return j(404, res);
    }
    const view = parallelismCapView(workspaceId);
    if (!view) return j(404, { error: 'workspace not found' });
    return j(200, { workspaceId, ...view });
  }
  // Workspace settings — two tunable prompts today: what the quality
  // gate judges a review item against, and what the effort scorer
  // weighs. GET reads both effective values and says which are on the
  // default; PUT MERGES — it writes only the field(s) the caller's
  // body actually names, and `null` (or blank) on a named field
  // restores that field's default. A caller changing one prompt must
  // never silently clear the other back to its default, so absence of
  // a key is "leave it", not "clear it" (`Object.hasOwn`, not `!==
  // undefined` — a body that included the key as `undefined` would
  // parse to the same JSON as one that omitted it entirely, so the two
  // cannot be told apart and are treated alike). String fields rather
  // than a rule table because the owner edits both in their own words.
  const wsSettingsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/settings$/);
  if (wsSettingsMatch && (req.method === 'GET' || req.method === 'PUT')) {
    const workspaceId = decodeURIComponent(wsSettingsMatch[1] ?? '');
    if (req.method === 'PUT') {
      const body = await safeJson(req);
      const author = authorFor(body?.author);
      if (!author) return j(400, { error: 'author required' });
      // Validate EVERY supplied field before applying ANY of them. A
      // caller sending both fields where only the second is malformed
      // must get back a 400 that changed nothing — not a 400 that
      // already wrote the first field to disk.
      let hasReviewCriteria = false;
      let reviewCriteriaValue: string | undefined;
      if (body && Object.hasOwn(body, 'reviewItemCriteria')) {
        const raw = body.reviewItemCriteria;
        if (raw !== null && typeof raw !== 'string') {
          return j(400, {
            error: 'reviewItemCriteria must be a string, or null to restore the default',
          });
        }
        if (typeof raw === 'string' && raw.length > REVIEW_ITEM_CRITERIA_MAX_CHARS) {
          return j(400, {
            error: `reviewItemCriteria is over ${REVIEW_ITEM_CRITERIA_MAX_CHARS} characters`,
          });
        }
        hasReviewCriteria = true;
        reviewCriteriaValue = typeof raw === 'string' ? raw : undefined;
      }
      // Same merge contract as the prompt fields: named-and-null
      // clears, absent leaves it. The shape borrows a doc origin repo's
      // validation (`dir` is a relPath with the same traversal rules)
      // and additionally insists repoRoot is a checkout NOW — a typo'd
      // path stored here would park every note the board ever derives.
      let hasNotesHome = false;
      let notesHomeValue: WorkspaceNotesHome | undefined;
      /**
       * `notesHome` is the one field on this route that is about the OWNER'S
       * MACHINE rather than about the board: a checkout path, a branch and a
       * directory under it. A member of a shared board has the rest of this
       * panel; this field is not theirs, in either direction.
       *
       * Refused BEFORE it is validated, and that order is the point. The
       * validation asks whether the path is a git checkout right now, so
       * running it first would answer "does this path exist on your machine"
       * one 400 at a time, to anybody holding a share link.
       *
       * Named-and-refused rather than silently dropped: a caller who sent it
       * would otherwise be told the write succeeded when the field it cared
       * about never landed.
       */
      if (visitor && body && Object.hasOwn(body, 'notesHome')) {
        return j(403, {
          error: 'not available to share visitors',
          message: 'notesHome names a path on the owner’s machine.',
        });
      }
      if (body && Object.hasOwn(body, 'notesHome')) {
        const raw = body.notesHome as {
          repoRoot?: unknown;
          branch?: unknown;
          dir?: unknown;
        } | null;
        if (raw !== null) {
          const norm = normalizeDocOriginRepo({
            repoRoot: raw?.repoRoot,
            branch: raw?.branch,
            relPath: raw?.dir,
          });
          if (!norm.ok) {
            return j(400, {
              error: `notesHome must be { repoRoot, branch, dir } or null to clear: ${norm.error.replace('relPath', 'dir')}`,
            });
          }
          // Store the MAIN checkout's root, not the caller's spelling:
          // a notes home declared from a linked worktree must survive
          // that worktree's removal (canonicalRepoRoot in doc-origin-repo.ts).
          const canonRoot = canonicalRepoRoot(norm.home.repoRoot);
          if (canonRoot === null) {
            return j(400, {
              error: `notesHome.repoRoot ${norm.home.repoRoot} is not a git checkout`,
            });
          }
          notesHomeValue = {
            repoRoot: canonRoot,
            branch: norm.home.branch,
            dir: norm.home.relPath,
          };
        }
        hasNotesHome = true;
      }
      let hasEffortPrompt = false;
      let effortPromptValue: string | undefined;
      if (body && Object.hasOwn(body, 'effortEstimatePrompt')) {
        const raw = body.effortEstimatePrompt;
        if (raw !== null && typeof raw !== 'string') {
          return j(400, {
            error: 'effortEstimatePrompt must be a string, or null to restore the default',
          });
        }
        if (typeof raw === 'string' && raw.length > EFFORT_ESTIMATE_PROMPT_MAX_CHARS) {
          return j(400, {
            error: `effortEstimatePrompt is over ${EFFORT_ESTIMATE_PROMPT_MAX_CHARS} characters`,
          });
        }
        hasEffortPrompt = true;
        effortPromptValue = typeof raw === 'string' ? raw : undefined;
      }
      // How many builders this board's lead may dispatch at once
      // (Bryan, 2026-08-31: "add support for limiting parallelism in the
      // workspace"). Same merge contract as the two prompt fields —
      // named-and-null clears to `DEFAULT_PARALLELISM_CAP` — but the
      // value is a bounded integer rather than free text, so it is
      // validated against the range register_dispatch itself enforces.
      let hasParallelismCap = false;
      let parallelismCapValue: number | undefined;
      if (body && Object.hasOwn(body, 'parallelismCap')) {
        const raw = body.parallelismCap;
        if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw))) {
          return j(400, {
            error: 'parallelismCap must be an integer, or null to restore the default',
          });
        }
        if (typeof raw === 'number' && (raw < PARALLELISM_CAP_MIN || raw > PARALLELISM_CAP_MAX)) {
          return j(400, {
            error: `parallelismCap must be between ${PARALLELISM_CAP_MIN} and ${PARALLELISM_CAP_MAX}`,
          });
        }
        hasParallelismCap = true;
        parallelismCapValue = typeof raw === 'number' ? raw : undefined;
      }
      if (hasReviewCriteria) {
        const res = taskStore.setReviewItemCriteria(workspaceId, reviewCriteriaValue, {
          actor: author,
        });
        if (!res.ok) return j(404, res);
      }
      if (hasEffortPrompt) {
        const res = taskStore.setEffortEstimatePrompt(workspaceId, effortPromptValue, {
          actor: author,
        });
        if (!res.ok) return j(404, res);
      }
      if (hasParallelismCap) {
        const res = taskStore.setParallelismCap(workspaceId, parallelismCapValue, {
          actor: author,
        });
        if (!res.ok) return j(404, res);
      }
      if (hasNotesHome) {
        const res = taskStore.setNotesHome(workspaceId, notesHomeValue, { actor: author });
        if (!res.ok) return j(404, res);
      }
    }
    const criteria = taskStore.reviewItemCriteria(workspaceId);
    const effortPrompt = taskStore.effortEstimatePrompt(workspaceId);
    const capView = parallelismCapView(workspaceId);
    if (!criteria || !effortPrompt || !capView) {
      return j(404, { error: 'workspace not found' });
    }
    const notesHome = taskStore.notesHome(workspaceId);
    return j(200, {
      workspaceId,
      reviewItemCriteria: { ...criteria, default: DEFAULT_REVIEW_ITEM_CRITERIA },
      effortEstimatePrompt: { ...effortPrompt, default: DEFAULT_EFFORT_ESTIMATE_PROMPT },
      // The same view `/parallelism-cap` serves, in this route's own
      // `{value, isDefault, default}` shape so the panel reads all three
      // settings alike; the slot count rides beside it.
      parallelismCap: {
        value: capView.cap,
        isDefault: capView.isDefault,
        default: capView.default,
        // Who moved it, given to a member the way every other visitor
        // surface gives an actor: name and kind, no id. This route used to
        // pass the record through verbatim, and it carries a full
        // `TaskActor` whose id is derived from an email — the same field the
        // board record beside it (`GET /api/workspaces/<id>`) has been
        // reducing since the cap shipped. The local surface keeps it whole.
        ...(capView.lastChange !== undefined
          ? {
              lastChange: visitor
                ? redactCapChangeForVisitor(capView.lastChange)
                : capView.lastChange,
            }
          : {}),
      },
      dispatchesInUse: capView.inUse,
      // Withheld from a member, for the reason the refusal above gives: it is
      // `repoRoot` on the owner's machine. Everything else on this route
      // describes the board, so a member reads all of it.
      ...(notesHome && !visitor ? { notesHome } : {}),
    });
  }
  // rename_workspace. The name was set once at creation and nothing
  // changed it, which is how two live boards ended up sharing one — and
  // a name is how an agent picks which to work.
  const wsBoardRenameMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/rename$/);
  if (wsBoardRenameMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsBoardRenameMatch[1] ?? '');
    const body = await safeJson(req);
    const name = body?.name;
    if (typeof name !== 'string') return j(400, { error: 'name required' });
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const res = taskStore.renameWorkspace(workspaceId, name, { actor: author });
    if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
    taskProjection.ensureWorkspace(workspaceId);
    return j(200, res);
  }
  // set_workspace_lead: hand the board's lead-agent seat to someone
  // else. A standing assignment, not a session fact — the lead may be
  // away, and a goal edit still has an addressee to queue for.
  const wsLeadMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/lead$/);
  if (wsLeadMatch && req.method === 'PUT') {
    const workspaceId = decodeURIComponent(wsLeadMatch[1] ?? '');
    const body = await safeJson(req);
    const leadAgentId = body?.leadAgentId;
    if (typeof leadAgentId !== 'string' || leadAgentId.trim().length === 0) {
      return j(400, { error: 'leadAgentId required' });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // `takeover` is how a caller says it MEANS to displace a live lead.
    // Absent it, claiming a seat a live agent already holds is refused
    // (`declined: 'lead-held'`) rather than silently granted — an
    // eviction nobody was told about routes every lead-addressed
    // delivery to a session that has stopped expecting it. Old bundles
    // never send the field, and they get the refusal, which is the safe
    // side of the change.
    const takeover = body?.takeover === true;
    const res = taskStore.setLeadAgent(workspaceId, leadAgentId, {
      actor: author,
      // An id the workspace has NO attachment record of is refused with
      // `unknown-lead-agent` (400): a seat routed to nobody silently
      // stops every lead-addressed delivery. Self-declaration is exempt
      // in the store — the caller is by definition real.
      ...(takeover ? { takeover: true } : {}),
    });
    if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
    return j(200, res);
  }
  // Voice (§3.8): transcript + per-surface context in, route decision +
  // ack out. EVERY utterance gets an explicit ack naming what was heard
  // and which route handles it — the router owns that invariant; this
  // handler only validates and forwards (transcript VERBATIM).
  const wsVoiceMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/voice$/);
  if (wsVoiceMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsVoiceMatch[1] ?? '');
    const body = await safeJson(req);
    const transcript = typeof body?.transcript === 'string' ? body.transcript.trim() : '';
    if (transcript.length === 0) return j(400, { error: 'transcript required' });
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const context = parseVoiceContext(body?.context);
    const res = await voiceRouter.handle(workspaceId, {
      transcript,
      ...(context !== undefined ? { context } : {}),
      actor: author,
    });
    if (!res.ok) return j(404, res);
    return j(200, res);
  }
  return undefined;
}
