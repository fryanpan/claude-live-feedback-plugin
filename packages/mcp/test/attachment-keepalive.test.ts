/**
 * An attachment that nobody refreshes is a claim with a five-minute fuse.
 *
 * The gap this closes: `set_workspace_lead` now says "one call at session
 * start and you are done", and that reads as "and nothing after". But every
 * lead-addressed delivery is gated on `Date.now() - lastHeartbeat <
 * HEARTBEAT_FRESH_MS`, and nothing in the MCP ever refreshed that — only an
 * agent remembering the `heartbeat` tool. Six quiet minutes of implementing
 * and the board reads the lead as away, so a goal edit is stored as
 * `pendingRetriage` with no channel emit at all. Subscribed, and hearing
 * silence.
 *
 * The decision is clocked rather than timed on purpose: liveness is claimed
 * off REAL tool calls, so a wedged session stops claiming it instead of
 * asserting it forever. Fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { createAttachmentKeepalive } from '../src/attachment-keepalive.ts';

describe('createAttachmentKeepalive', () => {
  it('holds nothing back until the interval has passed, then names the board once', () => {
    let now = 1_000;
    const k = createAttachmentKeepalive({ intervalMs: 100, now: () => now });
    k.mark('ws-1');
    // An attach is itself a heartbeat server-side, so nothing is due yet.
    expect(k.due()).toEqual([]);
    now += 99;
    expect(k.due()).toEqual([]);
    now += 2;
    expect(k.due()).toEqual(['ws-1']);
    // …and it does not keep firing on every call after that.
    expect(k.due()).toEqual([]);
    now += 101;
    expect(k.due()).toEqual(['ws-1']);
  });

  it('tracks each board separately', () => {
    let now = 1_000;
    const k = createAttachmentKeepalive({ intervalMs: 100, now: () => now });
    k.mark('ws-old');
    now += 80;
    k.mark('ws-new');
    now += 30; // ws-old is 110 old, ws-new is 30
    expect(k.due()).toEqual(['ws-old']);
    expect(k.boards().sort()).toEqual(['ws-new', 'ws-old']);
  });

  // POSITIVE CONTROL — a session that never attached to anything sends
  // nothing, ever. A keepalive that POSTed against boards it merely watches
  // would forge liveness on somebody else's seat.
  it('POSITIVE CONTROL: an unattached session has nothing due', () => {
    let now = 1_000;
    const k = createAttachmentKeepalive({ intervalMs: 100, now: () => now });
    now += 10_000;
    expect(k.due()).toEqual([]);
    expect(k.boards()).toEqual([]);
    // …and one mark is enough to start it, so the empty answers above are a
    // state and not a broken constructor.
    k.mark('ws-1');
    now += 101;
    expect(k.due()).toEqual(['ws-1']);
  });

  it('re-marking resets the clock', () => {
    let now = 1_000;
    const k = createAttachmentKeepalive({ intervalMs: 100, now: () => now });
    k.mark('ws-1');
    now += 90;
    k.mark('ws-1'); // a re-attach, or an explicit heartbeat tool call
    now += 90;
    expect(k.due()).toEqual([]);
    now += 11;
    expect(k.due()).toEqual(['ws-1']);
  });

  it('defaults to an interval well inside the server five-minute window', () => {
    let now = 0;
    const k = createAttachmentKeepalive({ now: () => now });
    k.mark('ws-1');
    now += 5 * 60_000 - 1; // one tick short of the server's freshness window
    // Due strictly before the window closes — a keepalive that fired only at
    // the boundary would be a race with the thing it exists to prevent.
    expect(k.due()).toEqual(['ws-1']);
    // Concretely: due at two minutes.
    let t = 0;
    const k2 = createAttachmentKeepalive({ now: () => t });
    k2.mark('ws-1');
    t += 120_000;
    expect(k2.due()).toEqual(['ws-1']);
  });
});
