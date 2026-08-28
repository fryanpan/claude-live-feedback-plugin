/**
 * The done-artifact check: when a task moves to done, verify that what its
 * links promise actually exists.
 *
 * Why: a builder's final report is the board's least reliable artifact — it
 * gets dropped often enough that "done" has arrived claiming a PR that was
 * never opened. The links on the row are the claim in checkable form, so the
 * board checks them instead of taking the word for it.
 *
 * The whole design is ADVISORY, and every choice below follows from that:
 *
 *  - The transition has already committed before this runs. The checker
 *    subscribes to `task.transitioned` and does its network work off the
 *    transition path, so marking done costs what it always cost.
 *  - Nothing here can refuse, throw at, or slow a transition. A lookup that
 *    fails is `unverified` — absence of evidence — and stays quiet; only
 *    `missing` (positive evidence the artifact is not there) makes noise,
 *    as a system comment on the task's discussion, the same pattern a park
 *    note uses.
 *  - GitHub is asked unauthenticated. That is enough for this board's public
 *    repos; a private repo answers 404 to an anonymous ask, so the missing
 *    note says so rather than letting the verdict overclaim.
 *
 * The verdict lands on the row (`recordArtifactCheck`, tasks.ts) — see
 * `ArtifactVerdict` there for what the four verdicts mean and why only one
 * of them is loud.
 */

import type { ArtifactCheck, ArtifactLinkCheck, Ref, Task, TaskStoreEvent } from './tasks.ts';

/** Whether a doc currently exists on this server. `archived` counts as
 *  existing — an archive is the board's reversible removal, not a deletion,
 *  and a task whose doc was retired did deliver it. */
export type DocPresence = 'live' | 'archived' | 'missing';

export type ClassifiedLink =
  | { kind: 'github-pr'; owner: string; repo: string; number: number; url: string }
  | { kind: 'doc'; docId: string }
  | { kind: 'not-checkable' };

// Owner and repo take GitHub's own charset; the tail after the number is
// ignored so the URL a person actually pasted — /files, ?diff=, #discussion —
// still names the PR. Anything github.com that is not /pull/<n> (issues,
// the repo itself) is deliberately not-checkable rather than guessed at.
const GITHUB_PR_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:$|[/?#])/;

export function classifyArtifactLink(ref: Ref): ClassifiedLink {
  if (ref.kind === 'doc') return { kind: 'doc', docId: ref.docId };
  if (ref.kind === 'url') {
    const m = ref.url.match(GITHUB_PR_URL);
    if (m?.[1] && m[2] && m[3]) {
      return { kind: 'github-pr', owner: m[1], repo: m[2], number: Number(m[3]), url: ref.url };
    }
  }
  return { kind: 'not-checkable' };
}

export interface ArtifactCheckDeps {
  /** Is this docId a doc this server holds? Wired to the live rooms plus the
   *  archive manifests; tests stub it. */
  docStatus: (docId: string) => DocPresence;
  fetchImpl?: typeof fetch;
  /** Per-link budget. A check that outlives anyone's attention is a check
   *  that never lands, so a hung lookup is cut off and reads `unverified`. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

async function checkGitHubPr(
  pr: Extract<ClassifiedLink, { kind: 'github-pr' }>,
  deps: ArtifactCheckDeps,
): Promise<{ verdict: ArtifactLinkCheck['verdict']; detail?: string }> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          // GitHub refuses anonymous requests without one.
          'user-agent': 'claude-workspaces-artifact-check',
        },
        signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );
    if (res.status === 200) {
      const body = (await res.json()) as { state?: unknown; merged_at?: unknown } | null;
      // GitHub keeps merged PRs in `state: closed`; `merged_at` is what
      // tells a landed PR from an abandoned one, and that difference is the
      // one a done-claim reader cares about.
      const state = body?.merged_at
        ? 'merged'
        : typeof body?.state === 'string'
          ? body.state
          : 'unknown';
      return { verdict: 'verified', detail: state };
    }
    if (res.status === 404 || res.status === 410) {
      return { verdict: 'missing', detail: `GitHub answered ${res.status}` };
    }
    // 403/429 rate limits and every other surprise: no evidence either way.
    return { verdict: 'unverified', detail: `GitHub answered ${res.status}` };
  } catch (err) {
    return { verdict: 'unverified', detail: err instanceof Error ? err.message : String(err) };
  }
}

function checkDoc(
  docId: string,
  deps: ArtifactCheckDeps,
): { verdict: ArtifactLinkCheck['verdict']; detail?: string } {
  try {
    const presence = deps.docStatus(docId);
    if (presence === 'missing') return { verdict: 'missing', detail: 'no doc with this id' };
    return presence === 'archived'
      ? { verdict: 'verified', detail: 'archived' }
      : { verdict: 'verified' };
  } catch (err) {
    return { verdict: 'unverified', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** One verdict per link, in link order. Pure of the store — the caller hands
 *  in the links and records the result. */
export async function runArtifactCheck(
  links: Ref[],
  deps: ArtifactCheckDeps,
): Promise<ArtifactCheck> {
  const checks = links.map(async (ref): Promise<ArtifactLinkCheck> => {
    const cls = classifyArtifactLink(ref);
    if (cls.kind === 'github-pr') return { ref, ...(await checkGitHubPr(cls, deps)) };
    if (cls.kind === 'doc') return { ref, ...checkDoc(cls.docId, deps) };
    return { ref, verdict: 'not-checkable' };
  });
  return { ts: Date.now(), links: await Promise.all(checks) };
}

/** What a missing artifact is called in the note — terse, and the PR spelling
 *  is the one a reader can paste into a browser bar. */
function linkLabel(check: ArtifactLinkCheck): string {
  const cls = classifyArtifactLink(check.ref);
  if (cls.kind === 'github-pr') return `${cls.owner}/${cls.repo}#${cls.number}`;
  if (cls.kind === 'doc') return `doc ${cls.docId}`;
  return check.ref.kind === 'url' ? check.ref.url : check.ref.kind;
}

/**
 * The system comment a bad check leaves on the task, or null when there is
 * nothing to say. Only `missing` earns one — see `ArtifactVerdict` in
 * tasks.ts for why the degraded verdicts stay quiet.
 */
export function missingNoteText(result: ArtifactCheck): string | null {
  const missing = result.links.filter((l) => l.verdict === 'missing');
  if (missing.length === 0) return null;
  const lines = missing.map((l) => {
    const why = l.detail !== undefined ? ` (${l.detail})` : '';
    return `- ${linkLabel(l)}${why}`;
  });
  const verified = result.links.filter((l) => l.verdict === 'verified').length;
  const unverified = result.links.filter((l) => l.verdict === 'unverified').length;
  const rest = [
    verified > 0 ? `${verified} verified` : null,
    unverified > 0 ? `${unverified} unverified` : null,
  ].filter((s) => s !== null);
  const tail = rest.length > 0 ? ` Other links: ${rest.join(', ')}.` : '';
  return (
    `**Marked done, but a promised artifact can't be found:**\n\n${lines.join('\n')}\n\n` +
    'Checked automatically at done — advisory, the status stands. A PR in a ' +
    `private repo also reads as missing to this unauthenticated check.${tail}`
  );
}

/** The server identity a missing note is written as — same register as the
 *  park migration's actor: no person made this claim, so no person's name
 *  goes on the comment. */
export const ARTIFACT_CHECK_ACTOR = {
  id: 'agent-workspaces-server',
  name: 'Claude Workspaces',
  kind: 'agent',
} as const;

export interface ArtifactCheckerDeps extends ArtifactCheckDeps {
  getTask: (taskId: string) => Task | undefined;
  record: (taskId: string, result: ArtifactCheck) => void;
  /** Post the missing note on the task's discussion. Failures are logged,
   *  never rethrown at the board. */
  postMissingNote: (task: Task, text: string) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * The subscriber. `install` hooks the store's event stream and reacts to
 * moves to done; everything after that is fire-and-forget with its own
 * catch, because no outcome of an advisory check may become the board's
 * problem. `settle()` exists for tests and shutdown — production never
 * awaits it.
 */
export class ArtifactChecker {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: ArtifactCheckerDeps) {}

  install(store: { onEvent(listener: (ev: TaskStoreEvent) => void): () => void }): () => void {
    return store.onEvent((ev) => {
      // Goal rows ride the same gate and the same event; `getTask` inside
      // `run` resolves tasks only, so a goal's done never reaches a check.
      if (ev.type === 'task.transitioned' && ev.to === 'done') this.schedule(ev.taskId);
    });
  }

  schedule(taskId: string): void {
    const p = this.run(taskId).catch((err) => {
      this.deps.log?.(`[artifact-check] ${taskId}: ${err instanceof Error ? err.message : err}`);
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async run(taskId: string): Promise<void> {
    const task = this.deps.getTask(taskId);
    // No links, no record: a row that promised nothing has nothing to verify,
    // and stamping an empty check on it would be noise dressed as diligence.
    if (!task || task.links.length === 0) return;
    const result = await runArtifactCheck(task.links, this.deps);
    this.deps.record(taskId, result);
    const note = missingNoteText(result);
    if (note !== null) await this.deps.postMissingNote(task, note);
  }
}
