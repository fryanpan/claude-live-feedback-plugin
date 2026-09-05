/**
 * The chat-audit counters: the daily audit publishes per-agent unfiled-ask
 * numbers here, and any session reads its own back.
 *
 * The server stores the audit's number rather than measuring anything — it
 * cannot see chat — so the count a session queries and the count the audit
 * reports are the same row. See `chat-audit.ts` for the store and for the
 * honest limits of what it can know.
 *
 * Two routes, matched in the order they were written: the exact `/api/chat-audit`
 * pair (GET the whole table, POST a day's entries) above the per-agent read,
 * which is a regex the exact path cannot reach.
 *
 * Dependencies arrive in an explicit context rather than captured from the
 * `createServer` closure, following `task-routes-context.ts`.
 */
import type { ChatAudit } from '../chat-audit.ts';
import { isSharedAgentName, localDay } from '../chat-audit.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';

/** The long-lived collaborators these routes need, built once per server. */
export interface ChatAuditRoutesContext {
  /** The audit store — the only thing either route reads or writes. */
  chatAudit: ChatAudit;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
}

/** What only this request knows. */
export interface ChatAuditRouteRequest {
  req: Request;
  pathname: string;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
}

/**
 * The two chat-audit routes, tried in source order. `undefined` means neither
 * matched and the caller's chain continues.
 */
export async function handleChatAuditRoutes(
  ctx: ChatAuditRoutesContext,
  rq: ChatAuditRouteRequest,
): Promise<Response | undefined> {
  const { chatAudit, j, safeJson } = ctx;
  const { req, pathname, visitor } = rq;

  // --- REST: chat-audit counters ---
  // The daily chat audit publishes per-agent unfiled-ask counts here
  // (POST), and any session reads its own back (GET /:agent). The
  // server stores the audit's number rather than measuring anything —
  // it cannot see chat — so the count a session queries and the count
  // the audit reports are the same row. See chat-audit.ts.
  if (pathname === '/api/chat-audit') {
    // Same defense-in-depth posture as the agent-watches route: no
    // share host reaches here today, and this keeps a later
    // allowlisting from exposing fleet discipline numbers to an
    // external reviewer.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method === 'GET') {
      return j(200, { day: localDay(Date.now()), rows: chatAudit.latestPerAgent() });
    }
    if (req.method === 'POST') {
      const body = await safeJson(req);
      try {
        const res = chatAudit.publish({
          day: typeof body?.day === 'string' ? body.day : undefined,
          auditor: typeof body?.auditor === 'string' ? body.auditor : undefined,
          // The store re-validates every field before a byte lands, so
          // this cast narrows shape only, not trust.
          entries: Array.isArray(body?.entries)
            ? (body?.entries as Parameters<ChatAudit['publish']>[0]['entries'])
            : [],
        });
        return j(200, res);
      } catch (e) {
        return j(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return j(405, { error: 'method not allowed' });
  }
  const chatAuditMatch = pathname.match(/^\/api\/chat-audit\/([^/]+)$/);
  if (chatAuditMatch) {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
    const agent = decodeURIComponent(chatAuditMatch[1] ?? '').trim();
    if (!agent) return j(400, { error: 'bad agent name' });
    if (isSharedAgentName(agent)) {
      return j(400, {
        error: `"${agent}" is a shared identity — counts are kept per display name (CW_AGENT_NAME)`,
      });
    }
    const day = localDay(Date.now());
    return j(200, { agent, day, ...chatAudit.readFor(agent, day) });
  }

  return undefined;
}
