/**
 * The harness the review-item hold-loop suites share: a board with one
 * ticket, a swappable judge stub, and the two judges the loop is measured
 * against.
 *
 * Extracted because two suites drive the same server — the loop itself and
 * what happens when the judge cannot answer — and a fixture copied into both
 * is a fixture that drifts in one.
 *
 * The judge is a STUB throughout; the real API is never called. All fixtures
 * are invented, because the repo is public.
 */
import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewJudgePrompt } from '@feedback/core/review-judge-prompt';
import type { ReviewJudge, ReviewJudgeInput } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

export const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
export const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
export const FILER = { id: 'agent-index-keeper', name: 'Index Keeper', kind: 'agent' };

/** A decision whose costs live ONLY in the option details — the shape the
 *  peer filed, and the one the gate kept asking for costs on. */
export const COSTS_IN_OPTIONS = {
  shape: 'decision' as const,
  headline: 'Which cache size for the nightly rebuild',
  detail: 'The rebuild runs at 02:00 and has to finish before the morning sync.',
  options: [
    { id: 'o-1', label: 'Keep it', detail: 'costs 2GB of disk and no extra time' },
    { id: 'o-2', label: 'Halve it', detail: 'frees 1GB but adds an hour to every night' },
  ],
};

/**
 * A judge that holds for missing costs EXACTLY when the costs are missing
 * from the words it was given.
 *
 * It reads the user turn the real builder produces, not the input object, so
 * anything between the filing route and the model that drops an option detail
 * turns this into a hold. That is what makes it a control rather than a
 * restatement of the code under test.
 */
export const costReadingJudge: ReviewJudge = async (input: ReviewJudgeInput) => {
  const { user } = buildReviewJudgePrompt(input.criteria, input.item);
  const stated = (input.item.options ?? [])
    .map((o) => o.detail?.trim())
    .filter((d): d is string => !!d);
  const unread = stated.filter((cost) => !user.includes(cost));
  return unread.length > 0 || stated.length === 0
    ? { ok: false, reason: 'No option says what choosing it costs.' }
    : { ok: true, reason: 'Every option names what choosing it costs.' };
};

/** The four reasons `contradictoryJudge` cycles through, in order. */
export const CONTRADICTORY_REASONS = [
  'The detail does not say what waits on this.',
  'The headline is not in the reader\u2019s own words.',
  'No option says what choosing it costs.',
  'The links are not inline on the words they explain.',
];

/** A judge that never passes anything and never repeats itself — the
 *  behaviour the peer met eight times over. */
export function contradictoryJudge(): ReviewJudge {
  let n = 0;
  return async () => ({ ok: false, reason: CONTRADICTORY_REASONS[n++ % 4] as string });
}

export interface Held {
  held?: boolean;
  heldReason?: string;
  message?: string;
  item?: {
    id: string;
    judge?: { verdict: string; reason: string; heldFor?: string[]; add?: string; at?: number };
  };
}

/** One server on its own data dir, with a judge the test swaps at will. */
export interface JudgeHarness {
  /** Swap this to change what the judge answers next. */
  judge: ReviewJudge;
  /** Every input the judge has been handed, in order. */
  readonly calls: ReviewJudgeInput[];
  base: string;
  readonly dataDir: string;
  /** The live server. Reassignable, so a test can boot a second one on the
   *  same data dir and still have it torn down. */
  handle: ServerHandle;
  jj<T>(res: Response | Promise<Response>): Promise<T>;
  post(path: string, body?: unknown): Promise<Response>;
  board(): Promise<{ workspaceId: string; taskId: string }>;
  stop(): Promise<void>;
}

export function startJudgeHarness(): JudgeHarness {
  const dataDir = mkdtempSync(join(tmpdir(), 'judge-loop-'));
  const calls: ReviewJudgeInput[] = [];
  const h: JudgeHarness = {
    judge: costReadingJudge,
    calls,
    dataDir,
    base: '',
    handle: undefined as unknown as ServerHandle,
    async jj<T>(res: Response | Promise<Response>): Promise<T> {
      const r = await res;
      expect(r.ok, `${r.status} ${await r.clone().text()}`).toBe(true);
      return r.json() as Promise<T>;
    },
    post: (path, body) =>
      fetch(`${h.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    async board() {
      const { workspace } = await h.jj<{ workspace: { id: string } }>(
        h.post('/api/workspaces', { name: 'index-rebuild', leadAgentId: LEAD.id }),
      );
      const { task } = await h.jj<{ task: { id: string } }>(
        h.post(`/api/workspaces/${workspace.id}/tasks`, {
          title: 'Rebuild the index nightly',
          body: 'Agent can rebuild the index so that search stays fresh.',
          assignee: FILER.name,
          assigneeKind: 'agent',
          author: FILER,
        }),
      );
      await h.jj(
        h.post(`/api/tasks/${task.id}/transition`, {
          to: 'todo',
          author: PERSON,
          workspaceId: workspace.id,
        }),
      );
      return { workspaceId: workspace.id, taskId: task.id };
    },
    async stop() {
      await h.handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  h.handle = createServer({
    port: 0,
    dataDir,
    reviewJudge: async (input) => {
      calls.push(input);
      return h.judge(input);
    },
    heldReviewItemMs: 0,
    stallNudgeQuietMs: 60 * 60_000,
  });
  h.base = `http://localhost:${h.handle.port}`;
  return h;
}
