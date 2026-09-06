/**
 * The background/foreground split, asserted against LIVE addresses.
 *
 * `harness/background-requests.ts` is a set of path patterns, and a pattern
 * is the one kind of test helper that can rot without anything going red: a
 * regex naming a route that no longer exists matches nothing, every caller
 * still compiles, and every suite that uses it still passes — right up until
 * the traffic it was supposed to hold back lands between a tool call and its
 * assertion. It fails OPEN, and it has already done so once: the agent roster
 * moved from `/workspaces/<id>/attachments` to `/workspaces/<id>/agents` in
 * PR 722 and the heartbeat pattern was left behind on the retired spelling.
 *
 * So each pattern is asserted three ways, and the middle one is the one that
 * catches the next move:
 *
 *   1. the LIVE path the MCP source builds is classed as background;
 *   2. the RETIRED spelling is NOT — a pattern loose enough to match both
 *      would pass (1) forever while the live route drifted away underneath;
 *   3. a real VERB on a neighbouring path is not swallowed, which is the
 *      control against a pattern that widened until it matched everything.
 *
 * Every live path below is written the way its caller writes it, with the
 * caller named, so a reader can check the pair rather than trust this file.
 *
 * All ids are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { isBackgroundRequest } from './harness/background-requests.ts';

const WS = 'w-bg1';
const AGENT = 'agent-bg1';

/** The heartbeat, exactly as `packages/mcp/src/attachments.ts` builds it. */
const HEARTBEAT_PATH = `/workspaces/${encodeURIComponent(WS)}/agents/${encodeURIComponent(AGENT)}/heartbeat`;
/** What that address was before PR 722 moved the roster off `attachments`. */
const RETIRED_HEARTBEAT_PATH = `/api/workspaces/${WS}/attachments/${AGENT}/heartbeat`;

describe('isBackgroundRequest classifies the child’s own traffic', () => {
  it('holds back the heartbeat at the address the MCP actually posts to', () => {
    // Not an empty-set property: this is the count going UP. If the pattern
    // drifts off the live route again, this line is what goes red.
    const traffic = [
      { method: 'POST', path: HEARTBEAT_PATH },
      { method: 'POST', path: `${HEARTBEAT_PATH}?trace=1` },
    ];
    expect(traffic.filter(isBackgroundRequest)).toHaveLength(2);
  });

  it('does NOT match the retired attachments spelling', () => {
    // The half that makes the assertion above mean something. A pattern that
    // matched both would satisfy the live case while telling you nothing
    // about which route the child calls.
    expect(isBackgroundRequest({ method: 'POST', path: RETIRED_HEARTBEAT_PATH })).toBe(false);
  });

  it('holds back the mux stream and the token minted for it', () => {
    const traffic = [
      { method: 'GET', path: `/events/agent/${AGENT}` },
      { method: 'GET', path: `/api/agents/${AGENT}/token` },
      { method: 'GET', path: `/api/agents/${AGENT}/watches` },
    ];
    expect(traffic.filter(isBackgroundRequest)).toHaveLength(3);
  });

  it('CONTROL: leaves the verbs alone, the roster POST included', () => {
    // `POST /workspaces/<id>/agents` is the attach — a verb tests assert on,
    // and one segment away from the heartbeat pattern. `POST .../watches` is
    // the durable watch write, called out by name in the harness header.
    const verbs = [
      { method: 'POST', path: `/workspaces/${WS}/agents` },
      { method: 'PUT', path: `/workspaces/${WS}/lead` },
      { method: 'POST', path: `/api/agents/${AGENT}/watches` },
      { method: 'POST', path: '/api/tasks/t-1/answer' },
      { method: 'GET', path: `/workspaces/${WS}/agents/${AGENT}/heartbeat` },
    ];
    expect(verbs.filter(isBackgroundRequest)).toEqual([]);
  });
});
