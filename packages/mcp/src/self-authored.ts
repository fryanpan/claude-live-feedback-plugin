/**
 * Never deliver an event back to the session that caused it.
 *
 * THE DEFECT. A session posts a comment (`create_thread` / `post_reply`); the
 * server fires `thread.created` / `thread.replied`; the fan-out reaches every
 * stream on the doc's channel and on every board channel holding that doc —
 * including the author's own `watch_doc` stream. The MCP child then rendered
 * it into the session as a `<channel source="claude-workspaces" …>` block
 * carrying the full comment body. Measured 2026-08-24 by four sessions, on
 * every comment, across workspaces and docs. The wake carries zero
 * information — the session wrote the words — and its cost is the payload, so
 * a long review comment is thousands of tokens re-injected into the context
 * that produced it.
 *
 * WHY HERE AND NOT IN THE SERVER. Three reasons, in order of weight:
 *
 *  1. The same frame rides several transports — the doc's own channel, each
 *     board's `ws~<id>` channel, and the REPLAY buffer a reconnecting stream
 *     drains. One gate at the render point covers all of them; a per-sink
 *     filter in `SseHub.broadcast` would cover the live sends and leak the
 *     replay straight back, because a broadcast frame is buffered once with
 *     no addressee and replayed to everyone.
 *  2. `/events/<docId>` carries no `agentId` at all — only the workspace
 *     stream names its agent — so a server-side gate could not even see the
 *     author's stream on the doc channel without an MCP change here anyway.
 *  3. It narrows nothing on the shared server. Per CLAUDE.md the real
 *     compatibility hazard is a peer on an older bundle calling a route it
 *     cannot be restarted away from; a server-side suppression would change
 *     what those sessions RECEIVE, while this changes only what a bundle does
 *     with what it already received. Old bundles keep today's behaviour until
 *     they restart.
 *
 * A browser is untouched by construction: it never runs this code, and a
 * reviewer must still watch their own comment appear.
 *
 * WHY IT FAILS OPEN — the whole design. A duplicated wake is a visible
 * annoyance. A dropped one is silence, and an agent cannot tell silence from
 * "nobody commented", which is the failure class watches exist to close. So
 * this answers `true` only when the author is POSITIVELY identified and is
 * unambiguously this session; every gap — no comment on the payload, no
 * author id, a non-string id, an event with no attribution rule, a shared
 * identity — resolves to delivering.
 *
 * The hub half of this rule already existed (`emitHubChannelMessage` drops a
 * frame whose `actor.id` is this agent). This is its doc-shaped companion.
 */

/**
 * Comment events. The author of one of these is the person who spoke, and it
 * is the only attribution that may suppress a comment body.
 */
const COMMENT_EVENTS = new Set(['thread.created', 'thread.replied']);

/**
 * Status changes. `rooms.ts` stamps `actor` on these precisely because there
 * is no comment to read an author off — see the `fireEvent` signature.
 */
const STATUS_EVENTS = new Set(['thread.resolved', 'thread.reopened']);

/**
 * An id that names a CATEGORY or a PERSON rather than this session.
 *
 * `CW_AGENT_NAME` unset resolves every anonymous session to `known-agent`;
 * a session launched as "Bryan" resolves to `known-bryan`, which is the very
 * id Bryan's browser comments carry. Suppressing on either would let one
 * session swallow a sibling's comments, or an agent swallow the human's.
 * `agent-<slug>` ids are synthesized per name and are the only ones that
 * identify a single session, so only those may suppress.
 *
 * Same rule `agent-watches.ts` applies to a shared watch set, for the same
 * reason: a category is not somebody.
 */
function identifiesOneSession(selfId: string): boolean {
  const id = selfId.trim();
  return id.length > 0 && !id.startsWith('known-');
}

function idOf(who: unknown): string | undefined {
  if (!who || typeof who !== 'object') return undefined;
  const id = (who as { id?: unknown }).id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

/**
 * The author this frame can be attributed to, or `undefined` when it cannot
 * be — which is a real outcome, not a defect, and the caller must deliver.
 *
 * `thread.created` fires with `comment: undefined` and the opening comment
 * inside the thread (rooms.ts:829), so it reads the thread's newest comment —
 * the same fallback `queueCommentRows` in server.ts uses, deliberately spelled
 * to match rather than invented a second time.
 *
 * `thread.replied` gets NO such fallback. It also fires with no comment on the
 * undo-answer path (rooms.ts:1023), where nothing was said and a stamp was
 * removed; the thread's newest comment is somebody's words, not the actor, and
 * reading it there would suppress on a stranger's identity.
 */
function frameAuthorId(event: string, payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as {
    comment?: unknown;
    thread?: { comments?: unknown };
    actor?: unknown;
  };
  if (STATUS_EVENTS.has(event)) return idOf(p.actor);
  if (!COMMENT_EVENTS.has(event)) return undefined;
  const direct = idOf((p.comment as { author?: unknown } | undefined)?.author);
  if (direct) return direct;
  if (event !== 'thread.created') return undefined;
  const comments = p.thread?.comments;
  if (!Array.isArray(comments) || comments.length === 0) return undefined;
  return idOf((comments[comments.length - 1] as { author?: unknown } | undefined)?.author);
}

/**
 * Whether this frame is the session's own act coming back to it.
 *
 * `true` means "suppress"; anything uncertain answers `false`. Suggestion
 * verdicts are deliberately absent from every rule above: `suggestion.accepted`
 * and `suggestion.rejected` carry the SUGGESTER as author, so matching on it
 * would swallow exactly the outcome the suggesting agent is waiting on.
 */
export function isSelfAuthoredEvent(event: string, payload: unknown, selfId: string): boolean {
  if (!identifiesOneSession(selfId)) return false;
  const author = frameAuthorId(event, payload);
  return author !== undefined && author.toLowerCase() === selfId.trim().toLowerCase();
}
