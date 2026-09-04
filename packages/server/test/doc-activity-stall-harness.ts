/**
 * The board-and-stream fixtures the two doc-activity stall suites share.
 *
 * `doc-activity-stall.test.ts` asks whether editing a row's linked doc counts
 * as the row moving; `doc-thread-activity-stall.test.ts` asks the same of the
 * doc's DISCUSSION. Both stand up a real server on an ephemeral port, hold the
 * workspace stream open as an attached lead, and read the stall wake off it,
 * so the frame reader and the quiet window belong to neither file alone.
 *
 * `listenFrames` collects frames rather than draining them, which is what
 * separates it from `agent-stream.ts`: these suites assert on what the wake
 * SAID, not merely that a subscriber existed.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */

export const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
export const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
export const BUILDER = { id: 'agent-millwright', name: 'Millwright', kind: 'agent' };

/** Rows must out-quiet this window before a doc edit can matter. */
export const QUIET_MS = 250;

export type Frame = { event: string; data?: Record<string, unknown> };

export function listenFrames(res: Response): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

export const settle = (ms = 60): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

export async function waitForFrames(
  frames: Frame[],
  event: string,
  n: number,
  timeoutMs = 15_000,
): Promise<Frame[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = frames.filter((f) => f.event === event);
    if (got.length >= n || Date.now() > deadline) return got;
    await settle(20);
  }
}
