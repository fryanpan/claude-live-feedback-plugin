/**
 * The document half of the dispatch: everything an agent calls to put a file
 * under review and work the comments on it.
 *
 * Docs and their threads, review docs and diff reviews, suggestions, the
 * anchor and block edits, the per-doc watches, and the share links that let
 * somebody outside the machine open one. What they have in common is a
 * `docId` — this is the family the implicit auto-watch in `mcp.ts` was
 * written for, and the reason `observe_url`, `watch_doc` and `unwatch_doc`
 * are exempted from it by name.
 *
 * Dependencies arrive in an explicit context rather than captured from
 * `mcp.ts`, following `routes/task-routes-context.ts` in the server: the
 * entry point owns the HTTP client, the identity and the watch registry, and
 * hands this file the narrow slice it reads. `mcp.ts` is a bundle entry point
 * with top-level side effects, so importing it back would be a cycle through
 * a module that connects a transport on load.
 *
 * The handler answers `undefined` for a name it does not know, and `mcp.ts`
 * chains the three domains with `??` the way the server chains its route
 * families. Every arm is the code that stood in the switch, moved with its
 * comments and dedented one level; nothing about a tool's arguments, its
 * behaviour or its reply changed here.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuthor } from '../author.ts';
import { inactiveWatches } from '../sse-loop.ts';
import { type ThreadCreateInput, threadCreateRequest } from '../thread-create.ts';
import type { RestoreState, WatchCoverage } from '../watch-coverage.ts';

/** What the document tools read out of `mcp.ts`. */
export interface DocsToolContext {
  /** The REST call to the feedback server; throws on a non-2xx. */
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
  /** This process's identity, sent on everything it authors. */
  AUTHOR: AgentAuthor;
  /** `post_status`'s ceiling — the server's own `NOTE_TEXT_MAX`. */
  STATUS_TEXT_MAX: number;
  /** The {id,name,color} subset a `suggest: true` route call wants. */
  suggestionAuthor: () => { id: string; name: string; color: string };
  /** Where the SSE stream lives, for `observe_url` to hand back. */
  resolveBaseUrl: () => string;
  /** The live watcher registry, read for its keys only. */
  watchers: ReadonlyMap<string, unknown>;
  watchDoc: (docId: string, persist?: boolean) => Promise<boolean>;
  watchWorkspace: (
    workspaceId: string,
    persist?: boolean,
  ) => Promise<{ open: boolean; persisted: boolean }>;
  unwatchDoc: (docId: string) => Promise<boolean>;
  refreshCoverage: () => Promise<WatchCoverage | undefined>;
  /**
   * The watch-restore state and the last persist failure, as of the start of
   * this tool call. Snapshots rather than live reads: `list_watched_docs` is
   * their only reader and the one call it awaits first, `refreshCoverage`,
   * touches neither.
   */
  restoreState: RestoreState;
  lastPersistError: string | undefined;
  watchPersistenceMode: () => 'server' | 'session-only';
  /** Which transport this session's watches ride — one multiplexed stream, or
   *  a socket per key. Reported so a silent session can be diagnosed without
   *  reading the child's stderr. */
  streamMode: () => 'multiplexed' | 'per-key';
  /** Whether every peer collapsed into one shared identity. */
  IDENTITY_IS_SHARED: boolean;
  SHARED_IDENTITY_REASON: string;
}

/** Answers the document tools; `undefined` means "not one of mine". */
export async function handleDocsTool(
  name: string,
  a: Record<string, unknown>,
  ctx: DocsToolContext,
): Promise<CallToolResult | undefined> {
  const {
    http,
    ok,
    err,
    AUTHOR,
    STATUS_TEXT_MAX,
    suggestionAuthor,
    resolveBaseUrl,
    watchers,
    watchDoc,
    watchWorkspace,
    unwatchDoc,
    refreshCoverage,
    watchPersistenceMode,
    streamMode,
    restoreState,
    lastPersistError,
    IDENTITY_IS_SHARED,
    SHARED_IDENTITY_REASON,
  } = ctx;
  switch (name) {
    case 'list_docs': {
      // Every param has to reach the wire: this handler used to issue a
      // bare GET, so a caller's workspaceId was accepted and silently
      // dropped — a board-scoped question answered with the whole server.
      //
      // `limit` is ALWAYS sent. Its presence is what puts the route into
      // paged mode (compact rows, a cursor); without it the route answers
      // the legacy whole-server dump for REST callers, and that dump —
      // 7.4 MB on 2026-09-01, pretty-printed here on the way through — is
      // exactly what a fresh session's first tool call must never be.
      const { workspaceId, kind, query, sourcePrefix, limit, cursor, full } = a as {
        workspaceId?: string;
        kind?: string;
        query?: string;
        sourcePrefix?: string;
        limit?: number;
        cursor?: string;
        full?: boolean;
      };
      const params = new URLSearchParams();
      if (workspaceId) params.set('workspaceId', workspaceId);
      if (kind) params.set('kind', kind);
      if (query) params.set('query', query);
      if (sourcePrefix) params.set('sourcePrefix', sourcePrefix);
      params.set(
        'limit',
        String(typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), 500) : 50),
      );
      if (cursor) params.set('cursor', cursor);
      if (full) params.set('full', '1');
      const res = await http('GET', `/api/docs?${params.toString()}`);
      return ok(res);
    }
    case 'list_threads': {
      const { docId, status } = a as { docId: string; status?: string };
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      const res = await http('GET', `/api/docs/${encodeURIComponent(docId)}/threads${qs}`);
      return ok(res);
    }
    case 'get_thread': {
      const { docId, threadId } = a as { docId: string; threadId: string };
      const res = await http(
        'GET',
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}`,
      );
      return ok(res);
    }
    case 'post_reply': {
      const { docId, threadId, text, review } = a as {
        docId: string;
        threadId: string;
        text: string;
        review?: unknown;
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/comments`,
        { author: AUTHOR, text, ...(review !== undefined ? { review } : {}) },
      );
      return ok(res);
    }
    case 'post_status': {
      // A status is a NOTE on the row (kind `status`, beside the hooks'
      // `turn` and `denial`), never a comment: the same body the Stop hook
      // posts, under the same agent name, to the row the caller names —
      // or, with no taskId, to the hook route, which pins it to this
      // agent's current claim. Empty and over-cap text are refused here,
      // where the message can say why; the server would 400 either.
      const { text, taskId } = a as { text?: unknown; taskId?: string };
      const body = typeof text === 'string' ? text.trim() : '';
      if (body === '') return err('text is empty — say where the work stands');
      if (body.length > STATUS_TEXT_MAX) {
        return err(
          `text is over ${STATUS_TEXT_MAX} chars — a status is a line to a few sentences; the full report is already on the Activity tab from your end-of-turn message`,
        );
      }
      const path =
        taskId !== undefined && taskId !== ''
          ? `/api/tasks/${encodeURIComponent(taskId)}/notes`
          : '/api/agent-notes';
      const res = (await http('POST', path, {
        agent: AUTHOR.name,
        kind: 'status',
        text: body,
        at: Date.now(),
      })) as { taskId?: string; workspaceId?: string };
      return ok({
        posted: true,
        ...(res.taskId !== undefined ? { taskId: res.taskId } : {}),
        ...(res.workspaceId !== undefined ? { workspaceId: res.workspaceId } : {}),
        ...(res.taskId === undefined
          ? {
              note: 'no in-progress task of yours to pin this to — kept on your own recent-activity list; pass taskId to put it on a row',
            }
          : {}),
      });
    }
    case 'create_thread': {
      // Two endpoints; omitting `find` opens the thread on the subject.
      // See thread-create.ts.
      const { path, body } = threadCreateRequest(a as unknown as ThreadCreateInput, AUTHOR);
      const res = await http('POST', path, body);
      return ok(res);
    }
    case 'resolve_thread': {
      const { docId, threadId } = a as { docId: string; threadId: string };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/resolve`,
      );
      return ok(res);
    }
    case 'summarize_thread': {
      const { docId, threadId, force } = a as {
        docId: string;
        threadId: string;
        force?: boolean;
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/summary`,
        force ? { force: true } : undefined,
      );
      return ok(res);
    }
    case 'reopen_thread': {
      const { docId, threadId } = a as { docId: string; threadId: string };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/reopen`,
      );
      return ok(res);
    }
    case 'get_doc': {
      const { docId } = a as { docId: string };
      // `reader` records that THIS session's copy of the doc is current as
      // of now — the marker the stale-write guard compares against the last
      // human edit before allowing a set_doc_content from this author.
      const res = await http(
        'GET',
        `/api/docs/${encodeURIComponent(docId)}/content?reader=${encodeURIComponent(AUTHOR.id)}`,
      );
      return ok(res);
    }
    case 'doc_status': {
      const { docId } = a as { docId: string };
      const res = await http('GET', `/api/docs/${encodeURIComponent(docId)}/status`);
      return ok(res);
    }
    case 'create_review_doc': {
      const {
        docId,
        path,
        title,
        setId,
        hubWorkspaceId: boardWorkspaceId,
        producedBy,
      } = a as {
        docId: string;
        path: string;
        title?: string;
        setId?: string;
        hubWorkspaceId?: string;
        producedBy?: { agentId?: string; sessionId?: string };
      };
      const res = await http('POST', '/api/docs', {
        docId,
        type: 'markdown',
        sourceUrl: path,
        owner: process.cwd(),
        ...(title ? { title } : {}),
        ...(setId ? { setId } : {}),
        ...(boardWorkspaceId ? { hubWorkspaceId: boardWorkspaceId } : {}),
        ...(producedBy ? { producedBy } : {}),
      });
      return ok(res);
    }
    case 'set_doc_content': {
      const { docId, markdown, confirmOverwriteHumanEdits } = a as {
        docId: string;
        markdown: string;
        confirmOverwriteHumanEdits?: boolean;
      };
      // Author: sent so a rewrite of a `task:<id>` body doc can be
      // attributed the way `rewrite_task` is — and so the stale-write guard
      // can judge this caller by its own get_doc reads instead of the blunt
      // 10-minute window. The confirm flag is forwarded only when true:
      // the default path stays the protected one.
      const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/content`, {
        markdown,
        author: AUTHOR,
        ...(confirmOverwriteHumanEdits === true ? { confirmOverwriteHumanEdits: true } : {}),
      });
      return ok(res);
    }
    case 'reparse_from_disk': {
      const { docId } = a as { docId: string };
      const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/reparse_from_disk`);
      return ok(res);
    }
    case 'delete_doc': {
      const { docId, force } = a as { docId: string; force?: boolean };
      const qs = force ? '?force=true' : '';
      const res = await http('DELETE', `/api/docs/${encodeURIComponent(docId)}${qs}`);
      return ok(res);
    }
    // COMPAT: `bind_mock` and `bind_folder` are the names these two had
    // before Attachment became the product's word for what they do. A peer
    // still running last week's bundle, or an agent working from a stale
    // skill, calls the old name; it lands on the same arm and the log says so
    // once (deprecated-aliases.ts). The tool LIST advertises the new names
    // only — one name for one thing in the table an agent reads.
    case 'bind_mock':
    case 'attach_mockup': {
      const {
        docId,
        sourceHtmlPath,
        title,
        hubWorkspaceId: boardWorkspaceId,
      } = a as {
        docId: string;
        sourceHtmlPath?: string;
        title?: string;
        hubWorkspaceId?: string;
      };
      // Same POST /api/docs route as create_review_doc, with type='mockup'.
      // The server's getOrCreate accepts both shapes; `sourceUrl` is optional
      // for mockups (mockups are served via /demos/ rather than file-watched).
      const res = await http('POST', '/api/docs', {
        docId,
        type: 'mockup',
        owner: process.cwd(),
        ...(sourceHtmlPath ? { sourceUrl: sourceHtmlPath } : {}),
        ...(title ? { title } : {}),
        ...(boardWorkspaceId ? { hubWorkspaceId: boardWorkspaceId } : {}),
      });
      return ok(res);
    }
    case 'bind_folder':
    case 'attach_folder': {
      const {
        folderPath,
        workspaceId,
        hubWorkspaceId: boardWorkspaceId,
        title,
        include,
        exclude,
        maxFiles,
        subscribe,
        producedBy,
      } = a as {
        folderPath: string;
        workspaceId?: string;
        hubWorkspaceId?: string;
        title?: string;
        include?: string[];
        exclude?: string[];
        maxFiles?: number;
        subscribe?: boolean;
        producedBy?: { agentId?: string; sessionId?: string };
      };
      const res = (await http('POST', '/workspaces', {
        folderPath,
        owner: process.cwd(),
        ...(workspaceId ? { workspaceId } : {}),
        // The BOARD, next to the review id above. Two ids, two meanings,
        // one payload — which is why they are spelled apart.
        ...(boardWorkspaceId ? { hubWorkspaceId: boardWorkspaceId } : {}),
        ...(title ? { title } : {}),
        ...(include ? { include } : {}),
        ...(exclude ? { exclude } : {}),
        ...(maxFiles !== undefined ? { maxFiles } : {}),
        ...(producedBy ? { producedBy } : {}),
      })) as { ok?: boolean; files?: Array<{ docId: string }> };
      // One workspace-level stream covers every member doc (including
      // files the reviewer opens lazily later). Opt out with subscribe:false.
      if (subscribe !== false && (res as { ok?: boolean; workspaceId?: string })?.workspaceId) {
        await watchWorkspace((res as { workspaceId: string }).workspaceId);
      }
      return ok(res);
    }
    case 'create_diff_review': {
      const {
        repo,
        base,
        target,
        reviewId,
        hubWorkspaceId: boardWorkspaceId,
        title,
        exclude,
        groups,
        maxFiles,
        subscribe,
        producedBy,
      } = a as {
        repo: string;
        base: string;
        target?: string;
        reviewId?: string;
        hubWorkspaceId?: string;
        title?: string;
        exclude?: string[];
        groups?: Array<{ title: string; paths: string[]; details?: string }>;
        maxFiles?: number;
        subscribe?: boolean;
        producedBy?: { agentId?: string; sessionId?: string };
      };
      const res = (await http('POST', '/api/diffs', {
        repo,
        base,
        ...(target ? { target } : {}),
        owner: process.cwd(),
        ...(reviewId ? { reviewId } : {}),
        // The BOARD, next to the review id above. Two ids, two meanings,
        // one payload — which is why they are spelled apart.
        ...(boardWorkspaceId ? { hubWorkspaceId: boardWorkspaceId } : {}),
        ...(title ? { title } : {}),
        ...(exclude ? { exclude } : {}),
        ...(groups ? { groups } : {}),
        ...(maxFiles !== undefined ? { maxFiles } : {}),
        ...(producedBy ? { producedBy } : {}),
      })) as { ok?: boolean; files?: Array<{ docId: string }> };
      // One workspace-level stream covers every member doc (including
      // files opened lazily from the all-files sidebar later). Opt out
      // with subscribe:false.
      if (subscribe !== false && (res as { reviewId?: string })?.reviewId) {
        await watchWorkspace((res as { reviewId: string }).reviewId);
      }
      return ok(res);
    }
    case 'delete_review': {
      const { setId, force, purge } = a as { setId: string; force?: boolean; purge?: boolean };
      const params = [force ? 'force=true' : '', purge ? 'purge=true' : ''].filter(Boolean);
      const qs = params.length > 0 ? `?${params.join('&')}` : '';
      const res = await http('DELETE', `/api/reviews/${encodeURIComponent(setId)}${qs}`);
      return ok(res);
    }
    case 'archive_review': {
      const { setId, reason } = a as { setId: string; reason?: string };
      const res = await http('POST', `/api/reviews/${encodeURIComponent(setId)}/archive`, {
        author: AUTHOR,
        ...(reason !== undefined ? { reason } : {}),
      });
      return ok(res);
    }
    case 'unarchive_review': {
      const { setId } = a as { setId: string };
      const res = await http('POST', `/api/reviews/${encodeURIComponent(setId)}/unarchive`, {
        author: AUTHOR,
      });
      return ok(res);
    }
    case 'archive_doc': {
      const { docId, reason } = a as { docId: string; reason?: string };
      const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/archive`, {
        author: AUTHOR,
        ...(reason !== undefined ? { reason } : {}),
      });
      return ok(res);
    }
    case 'unarchive_doc': {
      const { docId } = a as { docId: string };
      const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/unarchive`, {
        author: AUTHOR,
      });
      return ok(res);
    }
    case 'list_archived_reviews': {
      const res = await http('GET', '/api/reviews/archived');
      return ok(res);
    }
    case 'delete_workspace': {
      const { workspaceId, force, purge } = a as {
        workspaceId: string;
        force?: boolean;
        purge?: boolean;
      };
      const params = [force ? 'force=true' : '', purge ? 'purge=true' : ''].filter(Boolean);
      const qs = params.length > 0 ? `?${params.join('&')}` : '';
      // The one route that still fronts both stores, dispatching by id — a
      // board here, a review if that is what the id turns out to be. See
      // the compat note on it in the server's route table. `purge` only
      // reaches the review branch; a board's delete is unchanged.
      const res = await http('DELETE', `/workspaces/${encodeURIComponent(workspaceId)}${qs}`);
      return ok(res);
    }
    // COMPAT: `refresh_workspace` and `set_workspace_groups` are the names
    // these two had before a review stopped being called a workspace. An
    // agent working from a stale skill or from memory reaches for the old
    // name, and either key for the id; both are accepted here so it lands
    // instead of erroring. The tool LIST advertises the new names only.
    case 'refresh_workspace':
    case 'refresh_review': {
      const { setId, workspaceId } = a as { setId?: string; workspaceId?: string };
      const id = setId ?? workspaceId ?? '';
      const res = await http('POST', `/api/reviews/${encodeURIComponent(id)}/refresh`, {});
      return ok(res);
    }
    case 'set_workspace_groups':
    case 'set_review_groups': {
      const { setId, workspaceId, groups } = a as {
        setId?: string;
        workspaceId?: string;
        groups: Array<{ title: string; paths: string[]; details?: string }>;
      };
      const id = setId ?? workspaceId ?? '';
      const res = await http('POST', `/api/reviews/${encodeURIComponent(id)}/groups`, {
        groups,
      });
      return ok(res);
    }
    case 'find_and_replace': {
      const {
        docId,
        find,
        replace,
        contextBefore,
        contextAfter,
        occurrence,
        replaceAll,
        parseInlineMarks,
        suggest,
      } = a as {
        docId: string;
        find: string;
        replace: string;
        contextBefore?: string;
        contextAfter?: string;
        occurrence?: number;
        replaceAll?: boolean;
        parseInlineMarks?: boolean;
        suggest?: boolean;
      };
      const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/find_and_replace`, {
        find,
        replace,
        ...(contextBefore !== undefined ? { contextBefore } : {}),
        ...(contextAfter !== undefined ? { contextAfter } : {}),
        ...(occurrence !== undefined ? { occurrence } : {}),
        ...(replaceAll === true ? { replaceAll: true } : {}),
        ...(parseInlineMarks === true ? { parseInlineMarks: true } : {}),
        ...(suggest === true ? { suggest: true, author: suggestionAuthor() } : {}),
      });
      return ok(res);
    }
    case 'rewrite_thread_region': {
      const { docId, threadId, replacement, parseInlineMarks, suggest } = a as {
        docId: string;
        threadId: string;
        replacement: string;
        parseInlineMarks?: boolean;
        suggest?: boolean;
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/rewrite_region`,
        {
          replacement,
          ...(parseInlineMarks === true ? { parseInlineMarks: true } : {}),
          ...(suggest === true ? { suggest: true, author: suggestionAuthor() } : {}),
        },
      );
      return ok(res);
    }
    case 'list_suggestions': {
      const { docId } = a as { docId: string };
      const res = await http('GET', `/api/docs/${encodeURIComponent(docId)}/suggestions`);
      return ok(res);
    }
    case 'accept_suggestion': {
      const { docId, sid } = a as { docId: string; sid: string };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(sid)}/accept`,
      );
      return ok(res);
    }
    case 'reject_suggestion': {
      const { docId, sid } = a as { docId: string; sid: string };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(sid)}/reject`,
      );
      return ok(res);
    }
    case 'resolve_all_suggestions': {
      const { docId, action, authorId } = a as {
        docId: string;
        action: 'accept' | 'reject';
        authorId?: string;
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/suggestions/resolve_all`,
        { action, ...(authorId !== undefined ? { authorId } : {}) },
      );
      return ok(res);
    }
    case 'insert_after_thread': {
      const { docId, threadId, text } = a as {
        docId: string;
        threadId: string;
        text: string;
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/insert_after`,
        { text },
      );
      return ok(res);
    }
    case 'insert_blocks_after_thread': {
      const { docId, threadId, markdown, placement } = a as {
        docId: string;
        threadId: string;
        markdown: string;
        placement?: 'after-block' | 'top-level';
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/insert_blocks_after`,
        { markdown, ...(placement !== undefined ? { placement } : {}) },
      );
      return ok(res);
    }
    case 'create_anchor': {
      const { docId, find, contextBefore, contextAfter, occurrence, label } = a as {
        docId: string;
        find: string;
        contextBefore?: string;
        contextAfter?: string;
        occurrence?: number;
        label?: string;
      };
      const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/agent_anchors`, {
        find,
        ...(contextBefore !== undefined ? { contextBefore } : {}),
        ...(contextAfter !== undefined ? { contextAfter } : {}),
        ...(occurrence !== undefined ? { occurrence } : {}),
        ...(label !== undefined ? { label } : {}),
      });
      return ok(res);
    }
    case 'edit_at_anchor': {
      const { docId, anchorId, op } = a as {
        docId: string;
        anchorId: string;
        op: { kind: 'replace' | 'insert_after'; text: string };
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/agent_anchors/${encodeURIComponent(anchorId)}/edit`,
        op,
      );
      return ok(res);
    }
    case 'insert_blocks_at_anchor': {
      const { docId, anchorId, markdown, placement } = a as {
        docId: string;
        anchorId: string;
        markdown: string;
        placement?: 'after-block' | 'top-level';
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/agent_anchors/${encodeURIComponent(anchorId)}/insert_blocks`,
        { markdown, ...(placement !== undefined ? { placement } : {}) },
      );
      return ok(res);
    }
    case 'delete_anchor': {
      const { docId, anchorId } = a as { docId: string; anchorId: string };
      const res = await http(
        'DELETE',
        `/api/docs/${encodeURIComponent(docId)}/agent_anchors/${encodeURIComponent(anchorId)}`,
      );
      return ok(res);
    }
    case 'delete_block_at_anchor': {
      const { docId, threadId, anchorId } = a as {
        docId: string;
        threadId?: string;
        anchorId?: string;
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/delete_block_at_anchor`,
        {
          ...(threadId !== undefined ? { threadId } : {}),
          ...(anchorId !== undefined ? { anchorId } : {}),
        },
      );
      return ok(res);
    }
    case 'delete_blocks_in_range': {
      const {
        docId,
        startFind,
        endFind,
        contextBefore,
        contextAfter,
        startOccurrence,
        endOccurrence,
      } = a as {
        docId: string;
        startFind: string;
        endFind: string;
        contextBefore?: string;
        contextAfter?: string;
        startOccurrence?: number;
        endOccurrence?: number;
      };
      const res = await http(
        'POST',
        `/api/docs/${encodeURIComponent(docId)}/delete_blocks_in_range`,
        {
          startFind,
          endFind,
          ...(contextBefore !== undefined ? { contextBefore } : {}),
          ...(contextAfter !== undefined ? { contextAfter } : {}),
          ...(startOccurrence !== undefined ? { startOccurrence } : {}),
          ...(endOccurrence !== undefined ? { endOccurrence } : {}),
        },
      );
      return ok(res);
    }
    case 'delete_section': {
      const { docId, heading, level, occurrence } = a as {
        docId: string;
        heading: string;
        level?: number;
        occurrence?: number;
      };
      const res = await http('POST', `/api/docs/${encodeURIComponent(docId)}/delete_section`, {
        heading,
        ...(level !== undefined ? { level } : {}),
        ...(occurrence !== undefined ? { occurrence } : {}),
      });
      return ok(res);
    }
    case 'observe_url': {
      const { docId } = a as { docId: string };
      return ok({ sseUrl: `${resolveBaseUrl()}/events/${encodeURIComponent(docId)}` });
    }
    case 'watch_doc': {
      const { docId } = a as { docId: string };
      const persisted = await watchDoc(docId);
      return ok({
        docId,
        watching: Array.from(watchers.keys()),
        persisted,
        persistence: watchPersistenceMode(),
      });
    }
    case 'unwatch_doc': {
      const { docId } = a as { docId: string };
      const persisted = await unwatchDoc(docId);
      return ok({
        docId,
        watching: Array.from(watchers.keys()),
        persisted,
        persistence: watchPersistenceMode(),
      });
    }
    case 'list_watched_docs': {
      // `watching` answers "what am I subscribed to". `coverage` answers
      // the question that actually goes wrong: what am I MISSING. Six live
      // watches is a true answer to the first and an all-clear to nobody —
      // the peer that measured this held exactly that while a voice note
      // queued for a board it had never attached to. Absent rather than
      // empty when the server did not say.
      const coverage = await refreshCoverage();
      // A key whose loop GAVE UP, with the reason. `open: false` alone cannot
      // tell "reconnecting" from "stopped trying", and a doc deleted out from
      // under a watch is the case where the difference matters: the key stays
      // in `watching` and nothing will ever arrive on it. Absent when every
      // watch is still being retried.
      const inactive = inactiveWatches(watchers);
      return ok({
        watching: Array.from(watchers.keys()),
        ...(inactive.length > 0 ? { inactive } : {}),
        persistence: {
          mode: watchPersistenceMode(),
          agentId: AUTHOR.id,
          ...(IDENTITY_IS_SHARED ? { reason: SHARED_IDENTITY_REASON } : {}),
        },
        // `multiplexed` is one socket for the whole set; `per-key` is the old
        // one-socket-per-watch transport, which now happens only for a shared
        // identity or against a server older than the mux route. A session
        // that is unexpectedly on `per-key` is a session whose host is one
        // deploy behind, and that is worth being able to read.
        streamMode: streamMode(),
        restore: restoreState,
        ...(coverage ? { coverage } : {}),
        ...(lastPersistError ? { lastPersistError } : {}),
      });
    }
    case 'share_workspace': {
      // Forwarded AS SENT, plus this session's name. `allowDomains` and
      // `name` no longer mean anything — one Access application covers the
      // whole share hostname and the link has no subdomain of its own — but
      // an older bundle still sends them, so the server accepts and ignores
      // them and says `allowDomainsIgnored` when one arrived. Destructuring
      // named keys here is what once turned an argument nobody honoured into
      // a share wider than the caller asked for; the server refuses or
      // honours each key by name instead.
      const res = await http('POST', '/api/share/workspace', {
        ...(a as Record<string, unknown>),
        createdBy: AUTHOR.name,
      });
      return ok(res);
    }
    case 'remove_share_member': {
      const { workspaceId, email } = a as { workspaceId: string; email: string };
      const res = await http('POST', '/api/share/member/remove', { workspaceId, email });
      return ok(res);
    }
    case 'set_share_ttl': {
      const { shareId, ttlSeconds } = a as { shareId: string; ttlSeconds: number };
      const res = await http('POST', `/api/share/${encodeURIComponent(shareId)}/ttl`, {
        ttlSeconds,
      });
      return ok(res);
    }
    case 'list_shares': {
      const res = await http('GET', '/api/share');
      return ok(res);
    }
    case 'unshare': {
      const { shareId } = a as { shareId: string };
      const res = await http('DELETE', `/api/share/${encodeURIComponent(shareId)}`);
      return ok(res);
    }
    case 'set_sharing_enabled': {
      const { enabled } = a as { enabled?: boolean };
      // No argument = read-only. GET /api/share carries the same `sharing`
      // object the POST returns, so a status check costs nothing and can't
      // change anything by accident.
      if (typeof enabled !== 'boolean') {
        const res = await http('GET', '/api/share');
        return ok(res);
      }
      const res = await http('POST', '/api/share/enabled', { enabled });
      return ok(res);
    }
  }
  return undefined;
}
