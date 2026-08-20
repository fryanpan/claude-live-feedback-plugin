/**
 * Hold the workspace event stream the way a real attached agent holds it.
 *
 * Attaching is not the same act as being reachable. The MCP does both — it
 * POSTs the attach and then opens `/events/workspace/<id>` (mcp.ts, the
 * `subscribe !== false` line in `attach_agent`) — but a test that only does
 * the first half describes an agent that registered and then never connected.
 * The server delivers a request by BROADCASTING on `ws~<id>`, so for that
 * half-agent every delivery goes to nobody.
 *
 * That gap used to be invisible: liveness was a timestamp, and a timestamp is
 * happy to call an unreachable session live. Now the gate also asks whether
 * anyone is on the channel, so a test that wants delivery has to be reachable
 * — which is the same thing production requires.
 *
 * Registration is synchronous: `openSseStream` calls `hub.add` inside the
 * stream's `start()`, before the Response is returned. So an awaited fetch is
 * an established subscriber, and there is nothing to poll for.
 */
export interface AgentStream {
  /** Hang up, the way a session ending does. */
  close(): Promise<void>;
}

/** `agentId` names the agent whose own MCP child holds this stream — what a
 *  real session sends, and what lets the server report it reachable while it
 *  works off-server. Omit it to model a browser tab. */
export async function openWorkspaceStream(
  base: string,
  workspaceId: string,
  init: RequestInit = {},
  agentId?: string,
): Promise<AgentStream> {
  const controller = new AbortController();
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
  const res = await fetch(`${base}/events/workspace/${encodeURIComponent(workspaceId)}${query}`, {
    ...init,
    signal: controller.signal,
    headers: { accept: 'text/event-stream', ...((init.headers as Record<string, string>) ?? {}) },
  });
  if (!res.ok) {
    controller.abort();
    throw new Error(`workspace stream ${workspaceId}: HTTP ${res.status}`);
  }
  // Drain in the background. Without a reader the stream applies backpressure
  // after a few frames and the connection stops behaving like a live client.
  const reader = res.body?.getReader();
  void (async () => {
    if (!reader) return;
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      // Aborted by close() — the expected way this ends.
    }
  })();
  return {
    async close() {
      controller.abort();
      // Let the server's cancel() run before the next assertion reads the
      // subscriber count.
      await new Promise((r) => setTimeout(r, 10));
    },
  };
}
