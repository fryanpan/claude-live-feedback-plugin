/**
 * The board-and-machine half of the dispatch: everything addressed to a
 * WORKSPACE rather than to a document or a row in it.
 *
 * Minting, renaming and retiring a board; the lead seat; what a board looks
 * like from outside (`get_workspace`); the agent's own attachment, heartbeat
 * and dispatch registrations; and the operator verbs a session runs on the
 * machine rather than on the work — the parallelism cap, the chat audit, the
 * plugin-cache refresh.
 *
 * `setBoardRetired` came with the arms: `archive_workspace` and
 * `unretire_workspace` are one route call with the boolean flipped, and they
 * stay two `case` blocks rather than one fall-through because that is the
 * shape `tool-wiring.test.ts` reads to prove no advertised tool is unhandled.
 *
 * Dependencies arrive in an explicit context rather than captured from
 * `mcp.ts`, following `routes/task-routes-context.ts` in the server.
 * `PLUGIN_VERSION` is read from that context rather than re-spelled here:
 * it stays defined in `mcp.ts`, which is the handshake literal's one site and
 * one of the three the release checklist keeps in step.
 *
 * The handler answers `undefined` for a name it does not know. Every arm is
 * the code that stood in the switch, moved with its comments and dedented one
 * level; no tool's arguments, behaviour or reply changed here.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuthor } from '../author.ts';
import { declareWorkspaceLead } from '../declare-lead.ts';
import { parseCapArg } from '../parallelism-cap.ts';

/** What the workspace tools read out of `mcp.ts`. */
export interface WorkspaceToolContext {
  /** The REST call to the feedback server; throws on a non-2xx. */
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
  /** This process's identity, sent on everything it authors. */
  AUTHOR: AgentAuthor;
  /** The bundle version reported on attach, so the board can say which
   *  sessions are behind. Defined in `mcp.ts`; never re-spelled. */
  PLUGIN_VERSION: string;
  /** One nonce per process, minted at module load and sent on every attach. */
  PROCESS_ID: string;
  /** Whether every peer collapsed into one shared identity. */
  IDENTITY_IS_SHARED: boolean;
  /** Record that this session's attachment on a board is fresh. */
  markAttached: (workspaceId: string) => void;
  watchWorkspace: (
    workspaceId: string,
    persist?: boolean,
  ) => Promise<{ open: boolean; persisted: boolean }>;
}

/**
 * The body of archive_workspace and unretire_workspace, which are one route
 * call with the boolean flipped. Shared here rather than as a fall-through
 * case so each tool keeps its own `case` block — that is the shape
 * `tool-wiring.test.ts` reads to prove no advertised tool is unhandled.
 */
async function setBoardRetired(
  ctx: WorkspaceToolContext,
  workspaceId: string,
  retired: boolean,
  reason?: string,
): Promise<Record<string, unknown>> {
  const { http, AUTHOR } = ctx;
  const res = (await http('PUT', `/api/workspaces/${encodeURIComponent(workspaceId)}/retired`, {
    retired,
    ...(retired && reason !== undefined ? { reason } : {}),
    author: AUTHOR,
  })) as { changed: boolean; workspace: { name: string; retiredAt?: number } };
  return {
    workspaceId,
    name: res.workspace.name,
    retired,
    // False means it was ALREADY in this state — worth reporting rather than
    // flattening to success, because a caller re-running a cleanup wants to
    // know it changed nothing this time.
    changed: res.changed,
    ...(res.workspace.retiredAt !== undefined ? { retiredAt: res.workspace.retiredAt } : {}),
  };
}

/** Answers the workspace tools; `undefined` means "not one of mine". */
export async function handleWorkspaceTool(
  name: string,
  a: Record<string, unknown>,
  ctx: WorkspaceToolContext,
): Promise<CallToolResult | undefined> {
  const {
    http,
    ok,
    err,
    AUTHOR,
    PLUGIN_VERSION,
    PROCESS_ID,
    IDENTITY_IS_SHARED,
    markAttached,
    watchWorkspace,
  } = ctx;
  switch (name) {
    // ── Workspace hub tools (plan §3.10). Results are TRIMMED per the
    // edit-interface conventions: an edit returns ids + status, not the
    // full object the caller just wrote. Mutations that carry authorship
    // send AUTHOR — the same identity every other MCP call uses.
    case 'create_workspace': {
      const {
        name: wsName,
        leadAgentId,
        subscribe,
      } = a as {
        name: string;
        leadAgentId?: string;
        subscribe?: boolean;
      };
      const res = (await http('POST', '/api/workspaces', {
        name: wsName,
        // The creating agent leads the board unless it says otherwise. A
        // board with no lead has nobody to address its asks to.
        leadAgentId: leadAgentId ?? AUTHOR.id,
      })) as {
        workspace: { id: string; name: string; leadAgentId?: string };
      };
      if (subscribe !== false && res.workspace?.id) {
        await watchWorkspace(res.workspace.id);
      }
      return ok({
        workspaceId: res.workspace.id,
        name: res.workspace.name,
        leadAgentId: res.workspace.leadAgentId,
      });
    }
    case 'rename_workspace': {
      const { workspaceId, name: nextName } = a as { workspaceId: string; name: string };
      const res = (await http('POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/rename`, {
        name: nextName,
        author: AUTHOR,
      })) as {
        changed: boolean;
        workspace: { name: string };
        sameName?: Array<{ workspaceId: string; name: string }>;
      };
      return ok({
        workspaceId,
        name: res.workspace.name,
        changed: res.changed,
        // Only present when the rename LANDED on a name another live board
        // already had. Passed through rather than swallowed: a duplicate
        // name is the failure this verb exists to prevent, and the caller
        // is the only party still in a position to fix it cheaply.
        ...(res.sameName ? { sameName: res.sameName } : {}),
      });
    }
    // Archive and un-archive stay two `case` blocks rather than one
    // fall-through, because `tool-wiring.test.ts` reads this switch as
    // SOURCE — `case 'x': {` is how it proves every advertised tool has a
    // handler, and a shared block would hide one of these two from it.
    //
    // COMPAT: `retire_workspace` is the name this had before archiving became
    // the product's word for a reversible stand-down. It is a bare label with
    // no block, so it is not a second advertised tool; it lands here and the
    // log says so once. See deprecated-aliases.ts.
    case 'retire_workspace':
    case 'archive_workspace': {
      const { workspaceId, reason } = a as { workspaceId: string; reason?: string };
      return ok(await setBoardRetired(ctx, workspaceId, true, reason));
    }
    case 'unretire_workspace': {
      const { workspaceId } = a as { workspaceId: string };
      return ok(await setBoardRetired(ctx, workspaceId, false));
    }
    case 'set_workspace_lead': {
      const { workspaceId, leadAgentId, takeover } = a as {
        workspaceId: string;
        leadAgentId?: string;
        takeover?: boolean;
      };
      // Declaring yourself is attach → subscribe → seat, and hands back the
      // backlog the attach drained. Naming somebody else is the seat alone.
      // See declare-lead.ts for why the order is load-bearing.
      const declared = await declareWorkspaceLead(
        {
          workspaceId,
          ...(leadAgentId !== undefined ? { leadAgentId } : {}),
          ...(takeover === true ? { takeover: true } : {}),
        },
        {
          http,
          watchWorkspace,
          self: AUTHOR,
          // A session without CW_AGENT_NAME is refused before any seat
          // change — as a tool error, not a warning on a success.
          identityIsShared: IDENTITY_IS_SHARED,
          runtime: 'claude-code-local',
          pluginVersion: PLUGIN_VERSION,
          processId: PROCESS_ID,
        },
      );
      return declared.isError === true ? err(String(declared.message)) : ok(declared);
    }
    case 'set_review_item_criteria': {
      const { workspaceId, criteria, reviewItemId } = a as {
        workspaceId?: string;
        criteria?: string;
        reviewItemId?: string;
      };
      let effectiveWorkspaceId = workspaceId;
      if (effectiveWorkspaceId === undefined) {
        if (reviewItemId === undefined) {
          return err(
            'which board? Pass workspaceId, or a reviewItemId — the criteria then land on the board that judges that item',
          );
        }
        // Deliberately the server resolve for BOTH id families: unlike the
        // item-addressed tools, this one needs the containing workspace,
        // which a locally-decoded rt-… triple does not name.
        const res = (await http(
          'GET',
          `/api/review-items/${encodeURIComponent(reviewItemId)}`,
        )) as { workspaceId?: string };
        if (res.workspaceId === undefined) {
          return err(
            "that item's doc is not attached to any workspace, so it names no board — pass workspaceId",
          );
        }
        effectiveWorkspaceId = res.workspaceId;
      }
      const res = (await http(
        'PUT',
        `/api/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/settings`,
        {
          // `null` is the route's spelling of "back to the default"; an
          // omitted or blank string means the same thing to the caller.
          reviewItemCriteria: criteria !== undefined && criteria.trim() !== '' ? criteria : null,
          author: AUTHOR,
        },
      )) as { reviewItemCriteria: { value: string; isDefault: boolean } };
      return ok({
        workspaceId: effectiveWorkspaceId,
        criteria: res.reviewItemCriteria.value,
        isDefault: res.reviewItemCriteria.isDefault,
      });
    }
    case 'attach_doc': {
      const { workspaceId, docId } = a as { workspaceId: string; docId: string };
      const res = (await http('POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/docs`, {
        docId,
      })) as { workspace?: { docIds?: string[] } };
      return ok({ ok: true, workspaceId, docIds: res.workspace?.docIds ?? [] });
    }
    case 'get_workspace': {
      const { workspaceId } = a as { workspaceId: string };
      const res = (await http('GET', `/api/workspaces/${encodeURIComponent(workspaceId)}`)) as {
        workspace: {
          id: string;
          name: string;
          leadAgentId?: string;
          reviewItemCriteria?: string;
        };
        goalSummary: unknown[];
        parallelismCap?: {
          value: number;
          isDefault: boolean;
          inUse: number;
          free: number;
          lastChange?: {
            actor: { id: string; name: string; kind?: string };
            ts: number;
            from: number;
            to: number;
          };
        };
        retired?: { since: number; reason?: string; notice: string };
      };
      return ok({
        workspaceId: res.workspace.id,
        name: res.workspace.name,
        // How many builders this board may run, how many it is running —
        // and, once somebody has moved the cap, who, when, from what. A
        // lowered cap with no author is a mystery the lead goes looking
        // for; here it is a fact with a name on it.
        ...(res.parallelismCap !== undefined ? { parallelismCap: res.parallelismCap } : {}),
        // Absent means nobody is responsible for this board — its asks
        // have no addressee until someone attaches or takes the seat.
        leadAgentId: res.workspace.leadAgentId,
        // The board's OWN criteria for the review-item quality gate, when
        // somebody has written some; absent means the default applies.
        ...(res.workspace.reviewItemCriteria !== undefined
          ? { reviewItemCriteria: res.workspace.reviewItemCriteria }
          : {}),
        // Present only when this board has been stood down. Carried FIRST
        // in spirit even though it reads last: an agent that got this far
        // is about to decide what to work on, and a retired board's goal
        // list looks exactly like a live one's.
        ...(res.retired ? { retired: res.retired } : {}),
        goals: res.goalSummary,
      });
    }
    // The look-before-you-plan step. A READ, so no AUTHOR and no body: the
    // whole call is a query string, and the server answers with the goals
    // and plan docs that line up plus how many rows it weighed.
    //
    // `considered` is forwarded rather than dropped because it is what makes
    // an empty answer readable. `matches: []` alone cannot tell "this board
    // holds nothing like your request" from "this board holds nothing" — and
    // only the first of those means plan from scratch.
    case 'find_related_work': {
      const { workspaceId, text, docId, limit } = a as {
        workspaceId: string;
        text: string;
        docId?: string;
        limit?: number;
      };
      if (typeof text !== 'string' || text.trim().length === 0) {
        return err('text is required: the plan request in the words it was asked in.');
      }
      const params = new URLSearchParams({ q: text });
      if (typeof docId === 'string' && docId.length > 0) params.set('docId', docId);
      if (typeof limit === 'number' && Number.isFinite(limit)) params.set('limit', String(limit));
      const res = (await http(
        'GET',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/related-work?${params.toString()}`,
      )) as { considered: number; matches: unknown[] };
      return ok({
        workspaceId,
        considered: res.considered,
        matches: res.matches,
        // Said in the reply rather than left to the caller's memory of a tool
        // description read once at session start: this verb's whole value is
        // the branch it feeds, and the branch is easy to skip.
        next:
          res.matches.length > 0
            ? 'Something already covers this. File ONE decision review item on the task — options along the lines of "Extend that plan" / "Replace it" / "New plan", each with a cost line, and the matches named as inline relative links in the detail — then WAIT for the answer.'
            : 'Nothing on this board lines up. Plan from scratch, and give the goal you create a description and a link to the doc the request came from.',
      });
    }
    case 'attach_agent': {
      const { workspaceId, agentId, runtime, capabilities, subscribe } = a as {
        workspaceId: string;
        agentId?: string;
        runtime?: string;
        capabilities?: string[];
        subscribe?: boolean;
      };
      const res = (await http(
        'POST',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`,
        {
          agentId: agentId ?? AUTHOR.id,
          // Only when attaching as ITSELF: the roster row for somebody
          // else's id must not be named after this session.
          ...(agentId === undefined || agentId === AUTHOR.id ? { agentName: AUTHOR.name } : {}),
          runtime: runtime ?? 'claude-code-local',
          ...(capabilities !== undefined ? { capabilities } : {}),
          // What this session can actually DO is decided by the bundle it
          // loaded at launch, not by what its machine's cache holds now.
          // Reporting it is what lets the board say a merge never arrived.
          pluginVersion: PLUGIN_VERSION,
          // Same-process re-attaches must not re-hand rows still in
          // flight to this very process — see PROCESS_ID.
          processId: PROCESS_ID,
        },
      )) as {
        attachment?: { agentId?: string };
        gating?: unknown;
        untriaged?: string[];
        queuedVoice?: Array<{ transcript: string; ts: number; applied?: string }>;
        queuedComments?: Array<{
          id: string;
          docId: string;
          threadId?: string;
          event: string;
          author?: { id?: string; name?: string };
          text: string;
          ts: number;
        }>;
        lead?: boolean;
        retired?: { since: number; reason?: string; notice: string };
        leadNameConflicts?: {
          boards: Array<{ workspaceId: string; name: string }>;
          notice: string;
        };
        seat?: {
          leadAgentId?: string;
          live: boolean;
          stale: boolean;
          unattached?: boolean;
          notice?: string;
        };
        seatTakenFrom?: string;
        watching?: number;
        notes?: string[];
      };
      // Only when this session attached as ITSELF: the keepalive proves
      // THIS process is alive, and refreshing somebody else's attachment
      // from here would assert liveness for an agent that may be gone.
      if (agentId === undefined || agentId === AUTHOR.id) markAttached(workspaceId);
      if (subscribe !== false) await watchWorkspace(workspaceId);
      // These rows are now in this process's hands — this response is their
      // delivery — so send each receipt. Unlike queuedVoice the server did
      // NOT drain them: a row it holds until this ack is a row a crash
      // between the attach and here re-offers after the grace window,
      // instead of losing with the response body.
      for (const q of res.queuedComments ?? []) {
        if (typeof q?.id !== 'string') continue;
        try {
          await http(
            'POST',
            `/api/workspaces/${encodeURIComponent(workspaceId)}/comment-queue/${encodeURIComponent(q.id)}/ack`,
            {},
          );
        } catch {
          // Left on the queue on purpose — redelivered after the grace.
        }
      }
      return ok({
        workspaceId,
        agentId: res.attachment?.agentId ?? agentId ?? AUTHOR.id,
        // THE BOARD YOU JUST ATTACHED TO HAS BEEN STOOD DOWN. It takes no
        // new work and is not ranked; read the notice before you plan
        // anything here. First in the payload because a retired board's
        // gating, queues and untriaged list all read exactly like a live
        // board's, and by the time you reach them you have already decided
        // to work here.
        ...(res.retired ? { retired: res.retired } : {}),
        // YOU LEAD ANOTHER LIVE BOARD WITH THE SAME NAME. Two boards, one
        // name, one lead is how a session works the stale one for a night
        // and misses the goals on the live one — it happened, which is why
        // this field exists. Read both goal lists, then rename or retire
        // whichever is not the live board before doing anything else.
        ...(res.leadNameConflicts ? { leadNameConflicts: res.leadNameConflicts } : {}),
        gating: res.gating,
        // Are you the board's LEAD agent? True if you already held the seat
        // or just claimed an empty one. The lead is the addressee for
        // anything this board needs a responsible party for.
        lead: res.lead ?? false,
        untriaged: res.untriaged ?? [],
        // Voice change-requests that arrived while no agent was live
        // ("agent away — queued"): this attach is their delivery. Act on
        // each transcript, verbatim — EXCEPT for the part named by
        // `applied`, which the voice fast path already did to the board on
        // the speaker's behalf. Pick up only what the utterance asked for
        // beyond it; redoing it posts the same words twice.
        queuedVoice: res.queuedVoice ?? [],
        // Comments addressed to YOU that arrived while your stream was
        // down — a person (or peer) commented on a task or doc you watch or
        // lead, and nobody was listening. Read each and act on it where it
        // lives (post_reply on the thread / resolve when addressed). This
        // response is their delivery; the receipts are already sent.
        queuedComments: (res.queuedComments ?? []).map((q) => ({
          docId: q.docId,
          ...(q.threadId !== undefined ? { threadId: q.threadId } : {}),
          event: q.event,
          ...(q.author !== undefined ? { author: q.author } : {}),
          text: q.text,
          ts: q.ts,
        })),
        // WHAT THIS ATTACH DID NOT GIVE YOU. A session that respawns under
        // a new name attaches successfully and comes up with no watches and
        // no seat, and the success is all it was ever told — which is how a
        // board went four and a half hours with its asks reaching nobody.
        // These three fields are that silence made readable, and `notes`
        // says in words what to do about it. Absent from an older server.
        ...(res.notes !== undefined && res.notes.length > 0 ? { notes: res.notes } : {}),
        ...(res.watching !== undefined ? { watching: res.watching } : {}),
        // The board's lead seat as it stands now, INCLUDING when somebody
        // else holds it: `stale` means its holder has stopped answering, so
        // nothing addressed to the lead is arriving.
        ...(res.seat !== undefined ? { seat: res.seat } : {}),
        // This attach TOOK the seat from a holder that was gone. Say so
        // wherever you report in — a handover is not a detail.
        ...(res.seatTakenFrom !== undefined ? { seatTakenFrom: res.seatTakenFrom } : {}),
      });
    }
    case 'heartbeat': {
      const { workspaceId, agentId, toolCallAt } = a as {
        workspaceId: string;
        agentId?: string;
        toolCallAt?: number;
      };
      const res = (await http(
        'POST',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(agentId ?? AUTHOR.id)}/heartbeat`,
        // The heartbeat call is itself a tool call — stamp the work clock
        // too unless the caller reports an explicit (earlier) time.
        { toolCallAt: toolCallAt ?? Date.now() },
      )) as { attachment?: { state?: string } };
      if (agentId === undefined || agentId === AUTHOR.id) markAttached(workspaceId);
      return ok({ workspaceId, agentId: agentId ?? AUTHOR.id, state: res.attachment?.state });
    }
    case 'get_unfiled_ask_count': {
      const { agent } = a as { agent?: string };
      const who = agent?.trim() || AUTHOR.name;
      return ok(await http('GET', `/api/chat-audit/${encodeURIComponent(who)}`));
    }
    case 'publish_chat_audit': {
      const { day, entries } = a as {
        day?: string;
        entries: Array<{
          agent: string;
          unfiledAsks: number;
          totalAsks?: number;
          sessionId?: string;
          note?: string;
        }>;
      };
      return ok(
        await http('POST', '/api/chat-audit', {
          ...(day !== undefined ? { day } : {}),
          auditor: AUTHOR.name,
          entries,
        }),
      );
    }
    case 'register_dispatch': {
      const { taskId, worktreePath } = a as { taskId: string; worktreePath: string };
      return ok(await http('POST', '/api/dispatches', { taskId, worktreePath }));
    }
    case 'close_dispatch': {
      const { taskId } = a as { taskId: string };
      return ok(await http('DELETE', `/api/dispatches/${encodeURIComponent(taskId)}`));
    }
    case 'set_parallelism_cap': {
      const { workspaceId, cap: rawCap } = a as { workspaceId: string; cap: unknown };
      // Refuse a bad cap here, with a sentence, rather than relaying the
      // route's 400 as a thrown status. Nothing is sent for a value that
      // could never land.
      const parsed = parseCapArg(rawCap);
      if (!parsed.ok) return err(parsed.error);
      // The same PUT the board's panel and Team Lead's REST calls use, so
      // the change is recorded through the one store method with THIS
      // agent as the actor — `author: AUTHOR`, as every write tool sends.
      const res = (await http(
        'PUT',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/parallelism-cap`,
        { cap: parsed.cap, author: AUTHOR },
      )) as {
        cap: number;
        isDefault: boolean;
        default: number;
        inUse: number;
        free: number;
        holders: Array<{ taskId: string; title?: string; agentName?: string }>;
        lastChange?: { actor: unknown; ts: number; from: number; to: number };
      };
      return ok({
        workspaceId,
        cap: res.cap,
        isDefault: res.isDefault,
        default: res.default,
        inUse: res.inUse,
        free: res.free,
        holders: res.holders,
        lastChange: res.lastChange,
      });
    }
    case 'request_plugin_refresh': {
      // No arguments reach the process this runs — the server's argv is
      // fixed. Nothing a caller can send gets spawned.
      return ok(await http('POST', '/api/plugin/refresh'));
    }
    case 'list_attachments': {
      const { workspaceId } = a as { workspaceId: string };
      const res = await http(
        'GET',
        `/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`,
      );
      return ok(res);
    }
  }
  return undefined;
}
