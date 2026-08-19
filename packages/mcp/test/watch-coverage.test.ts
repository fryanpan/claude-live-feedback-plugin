/**
 * The inside view: can this session tell whether it is actually covered?
 *
 * The server now answers that on the watches route. This is the half that
 * makes the answer reach somebody — a report nobody reads is the same failure
 * as no report. Two surfaces:
 *
 *  - `list_watched_docs` carries the server's `coverage` block through
 *    verbatim, beside the watching / persistence / restore fields it already
 *    reports, so the probe an agent already runs stops answering only the
 *    easy question.
 *  - the restore notice — the one line a respawned session gets unprompted —
 *    names any unattached board with something WAITING on it. Unprompted is
 *    the point: an agent that does not know to ask never runs the probe.
 *
 * The silence rules are as load-bearing as the alarms and are pinned as
 * positive controls: nothing is ever fabricated when the server did not send
 * a coverage block, and a board with nothing queued raises nothing. An alarm
 * that fires on the innocent case is how a real one stops being read.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CoverageQueue,
  type CoverageUnattachedBoard,
  type WatchCoverage,
  coverageAlertLine,
  parseCoverage,
  restoreNoticeContent,
} from '../src/watch-coverage.ts';

const EMPTY: CoverageQueue = {
  queuedVoice: 0,
  pendingRetriage: 0,
  pendingBucketReview: 0,
  taskReviews: 0,
};

const board = (over: Partial<CoverageUnattachedBoard> = {}): CoverageUnattachedBoard => {
  const queued = over.queued ?? EMPTY;
  return {
    workspaceId: 'ws-1',
    name: 'coverage-board',
    watchedDocs: ['doc-one', 'doc-two'],
    queued,
    queuedTotal:
      over.queuedTotal ??
      queued.queuedVoice + queued.pendingRetriage + queued.pendingBucketReview + queued.taskReviews,
    ...over,
  };
};

const coverage = (over: Partial<WatchCoverage> = {}): WatchCoverage => ({
  agentId: 'agent-self',
  workspaces: [],
  unattachedBoards: [],
  ...over,
});

describe('parseCoverage — never fabricate an all-clear', () => {
  it('reads the block the server sent', () => {
    const c = coverage({ unattachedBoards: [board()] });
    expect(parseCoverage({ watches: [], coverage: c })).toEqual(c);
  });

  it('answers undefined — not an empty block — when the server sent none', () => {
    // The old server, the shared-identity 400, an unreachable box. An empty
    // coverage block would render as "nothing is missing", which is the
    // reassuring lie this whole readout exists to stop telling; undefined
    // renders as "unknown", which is the truth.
    for (const res of [{}, { watches: [] }, { coverage: null }, { coverage: 'yes' }, null, 42]) {
      expect(parseCoverage(res)).toBeUndefined();
    }
    // Positive control in the same pass: a well-formed block still parses, so
    // the undefineds above are answers rather than a parser that gave up.
    expect(parseCoverage({ coverage: coverage() })).toBeDefined();
  });
});

describe('coverageAlertLine — say what is waiting, and only when something is', () => {
  it('names the board, the docs, the count and the fix', () => {
    const line = coverageAlertLine(
      coverage({
        unattachedBoards: [
          board({
            queued: {
              queuedVoice: 1,
              pendingRetriage: 1,
              pendingBucketReview: 0,
              taskReviews: 2,
            },
          }),
        ],
      }),
    );
    expect(line).not.toBeNull();
    const text = line as string;
    expect(text).toContain('coverage-board');
    expect(text).toContain('ws-1');
    // The count is the actionable part — it is the "four items drained at
    // once" from the incident, said before the drain rather than after.
    expect(text).toContain('4');
    expect(text).toContain('2 docs');
    expect(text).toContain('voice');
    expect(text).toContain('re-triage');
    expect(text).toContain('task review');
    // And it names the one call that fixes it, so the reader is not left to
    // work out which of attach_agent / watch_doc / set_workspace_lead it was.
    expect(text).toContain('set_workspace_lead');
  });

  it('POSITIVE CONTROL: silent when the coverage block is absent or clean', () => {
    expect(coverageAlertLine(undefined)).toBeNull();
    expect(coverageAlertLine(coverage())).toBeNull();
  });

  it('POSITIVE CONTROL: an unattached board with NOTHING queued raises nothing', () => {
    // Every doc bound without a board lands on a default holding pen, so
    // "unattached board" on its own is the common case, not an incident.
    // Shouting about it is how the real alarm stops being read.
    const clean = coverage({ unattachedBoards: [board({ name: 'Unfiled', queued: EMPTY })] });
    expect(coverageAlertLine(clean)).toBeNull();
    // …and the same shape with one item waiting DOES speak, so the silence
    // above is a judgement rather than a dead code path.
    const waiting = coverage({
      unattachedBoards: [board({ name: 'Unfiled', queued: { ...EMPTY, queuedVoice: 1 } })],
    });
    expect(coverageAlertLine(waiting)).toContain('Unfiled');
  });

  it('names every waiting board, and skips the clean one beside it', () => {
    const line = coverageAlertLine(
      coverage({
        unattachedBoards: [
          board({
            workspaceId: 'ws-loud',
            name: 'loud-board',
            queued: { ...EMPTY, taskReviews: 3 },
          }),
          board({ workspaceId: 'ws-quiet', name: 'quiet-board', queued: EMPTY }),
        ],
      }),
    ) as string;
    expect(line).toContain('loud-board');
    expect(line).not.toContain('quiet-board');
  });
});

describe('restoreNoticeContent — the unprompted line a respawn gets', () => {
  const agentName = 'Self Agent';

  it('appends the alert to a normal restore', () => {
    const content = restoreNoticeContent({
      restored: ['ws:ws-1', 'doc-one'],
      pruned: [],
      agentName,
      coverage: coverage({
        unattachedBoards: [board({ queued: { ...EMPTY, queuedVoice: 1 } })],
      }),
    }) as string;
    expect(content).toContain('2 watches re-wired');
    expect(content).toContain('coverage-board');
  });

  it('speaks even when NOTHING was restored, if something is waiting', () => {
    // The incident's exact shape: the session had wired its watches by hand
    // this run, so there was nothing to restore and the old notice said
    // nothing at all — while four items sat queued for a seat nobody held.
    const content = restoreNoticeContent({
      restored: [],
      pruned: [],
      agentName,
      coverage: coverage({
        unattachedBoards: [board({ queued: { ...EMPTY, pendingRetriage: 1 } })],
      }),
    });
    expect(content).not.toBeNull();
    expect(content as string).toContain('coverage-board');
  });

  it('POSITIVE CONTROL: a clean restore stays silent', () => {
    // Nothing restored, nothing pruned, nothing waiting — no line. A notice
    // on every respawn is noise, and noise is what gets filtered out right
    // before the one that mattered.
    expect(
      restoreNoticeContent({ restored: [], pruned: [], agentName, coverage: coverage() }),
    ).toBeNull();
    expect(restoreNoticeContent({ restored: [], pruned: [], agentName })).toBeNull();
    // And the ordinary restore still speaks, so the nulls are a rule and not
    // a function that returns null.
    expect(restoreNoticeContent({ restored: ['doc-one'], pruned: [], agentName })).toContain(
      '1 watch re-wired',
    );
  });

  it('still reports pruned keys', () => {
    const content = restoreNoticeContent({
      restored: ['doc-one'],
      pruned: ['doc-gone'],
      agentName,
    }) as string;
    expect(content).toContain('1 dropped');
  });
});

describe('mcp.ts wires the readout in', () => {
  // mcp.ts ends in a top-level `await server.connect(transport)` and exports
  // nothing, so a test cannot import it. Source assertions are the only
  // available proof that the helpers above are reached at all — without them
  // every test here could pass against a module nothing calls.
  const src = readFileSync(join(import.meta.dirname, '../src/mcp.ts'), 'utf8');

  it('list_watched_docs carries `coverage` through', () => {
    const tool = src.slice(src.indexOf("case 'list_watched_docs'"));
    const body = tool.slice(0, tool.indexOf("case '", 10));
    expect(body).toContain('coverage');
    expect(body).toContain('watching');
    expect(body).toContain('restore');
  });

  it('the restore path builds its notice from restoreNoticeContent', () => {
    expect(src).toContain("from './watch-coverage.ts'");
    expect(src).toContain('restoreNoticeContent(');
    expect(src).toContain('parseCoverage(');
  });
});
