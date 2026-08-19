/**
 * Voice routing (§2.4 / §3.8): every utterance is classified — does this
 * change something, or just look something up? — and answered.
 *
 *  - Lookups take the Haiku FAST PATH, on the server: the classification call
 *    carries a compact workspace index (tasks, docs, goals) and the model
 *    names the target; the server validates the id and answers with a
 *    navigation. No full-agent round trip; works with no agent attached.
 *  - Changes belong to the ATTACHED WORKSPACE AGENT, carrying the transcript
 *    VERBATIM: the `voice.request` event rides the workspace channel the MCP
 *    watch already formats. With no live attachment the request is queued on
 *    disk and delivered in the next attach result.
 *
 * **Voice always answers.** Every path out of `handle()` produces an ack that
 * names what was heard and which route handles it — including "agent away —
 * queued" — and every utterance emits `voice.request` (§3.6), so the promise
 * has a checkable artifact.
 *
 * The network half follows the summarizer's rules exactly (summarize.ts):
 * the fast path is opt-in at the seam — `createServer` builds NO default
 * completer, so nothing that merely spins a server up can reach the network;
 * only bin.ts constructs the real one, and only the DEDICATED keychain entry
 * counts as consent for LF→Anthropic traffic.
 */
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';
import type { TaskStore } from './tasks.ts';

export type VoiceSurface = 'hub' | 'doc' | 'task';

/** The per-utterance anchor (§3.8): wherever the speaker is NOW. */
export interface VoiceContext {
  surface: VoiceSurface;
  docId?: string;
  taskId?: string;
  /** Topmost heading on screen — rough scroll awareness, no pixel tracking. */
  visibleHeading?: string;
}

/** Sanitize a client-supplied context object; anything malformed → none. */
export function parseVoiceContext(raw: unknown): VoiceContext | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.surface !== 'hub' && r.surface !== 'doc' && r.surface !== 'task') return undefined;
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
  const docId = str(r.docId, 300);
  const taskId = str(r.taskId, 300);
  const visibleHeading = str(r.visibleHeading, 200);
  return {
    surface: r.surface,
    ...(docId !== undefined ? { docId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(visibleHeading !== undefined ? { visibleHeading } : {}),
  };
}

/** One classification round trip: prompt in, raw reply text out. Injected in
 *  tests; the real one is `haikuVoiceComplete` below. */
export type VoiceComplete = (args: { system: string; user: string }) => Promise<string>;

export type VoiceClassification =
  | { kind: 'change' }
  | { kind: 'lookup'; target?: 'task' | 'doc'; id?: string };

export interface VoiceResult {
  route: 'fast-path' | 'agent' | 'agent-queued';
  /** The explicit reply: what was heard, and which route handles it. */
  ack: string;
  /** Where the client should take the speaker (fast-path lookup hits only). */
  navigate?: string;
}

export type VoiceHandleResult =
  | ({ ok: true } & VoiceResult)
  | { ok: false; error: 'workspace-not-found' };

const MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 120;
const TIMEOUT_MS = 10_000;
/** Keep acks readable when a hold rambles. */
const ACK_TRANSCRIPT_MAX = 90;

function heard(transcript: string): string {
  const t =
    transcript.length > ACK_TRANSCRIPT_MAX
      ? `${transcript.slice(0, ACK_TRANSCRIPT_MAX - 1)}…`
      : transcript;
  return `Heard: "${t}".`;
}

/**
 * The classification prompt. One call does both jobs — change-vs-lookup, and
 * (for lookups) naming the target from the index — because a second round
 * trip would double the fast path's latency for nothing.
 */
export function buildVoicePrompt(
  index: {
    goal: string;
    goals: Array<{ id: string; title: string }>;
    tasks: Array<{ id: string; title: string; status: string; needs?: string }>;
    docIds: string[];
  },
  transcript: string,
  context?: VoiceContext,
): { system: string; user: string } {
  const system = [
    'You route voice requests for a task workspace. Decide: does the utterance',
    'CHANGE something (create/edit/regroup/reprioritize/assign/answer), or is it',
    'a LOOKUP (navigate to / open / find an existing task or doc)?',
    'Reply with ONE JSON object and nothing else:',
    '  {"kind":"change"}',
    '  {"kind":"lookup","target":"task","id":"<task id from the index>"}',
    '  {"kind":"lookup","target":"doc","id":"<doc id from the index>"}',
    '  {"kind":"lookup"}   (a lookup, but nothing in the index matches)',
    'Only use ids that appear in the index. When unsure, answer {"kind":"change"}.',
  ].join('\n');
  const lines: string[] = [];
  lines.push(`Workspace goal: ${index.goal || '(none)'}`);
  if (index.goals.length > 0) {
    lines.push('Goals:');
    for (const g of index.goals) lines.push(`  - ${g.id}: ${g.title}`);
  }
  lines.push('Tasks:');
  for (const t of index.tasks) {
    lines.push(`  - ${t.id} [${t.status}${t.needs ? `, needs:${t.needs}` : ''}] ${t.title}`);
  }
  if (index.docIds.length > 0) {
    lines.push('Docs:');
    for (const d of index.docIds) lines.push(`  - ${d}`);
  }
  if (context) {
    lines.push(
      `Speaker location: surface=${context.surface}` +
        (context.docId ? ` doc=${context.docId}` : '') +
        (context.taskId ? ` task=${context.taskId}` : '') +
        (context.visibleHeading ? ` visibleHeading="${context.visibleHeading}"` : ''),
    );
  }
  lines.push(`Utterance: "${transcript}"`);
  return { system, user: lines.join('\n') };
}

/** Tolerant reply parser: the model may fence or preface the JSON. Anything
 *  that doesn't contain a well-shaped object is null (= fast-path failure). */
export function parseVoiceReply(raw: string): VoiceClassification | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.kind === 'change') return { kind: 'change' };
  if (p.kind === 'lookup') {
    const target = p.target === 'task' || p.target === 'doc' ? p.target : undefined;
    const id = typeof p.id === 'string' && p.id.length > 0 ? p.id : undefined;
    return {
      kind: 'lookup',
      ...(target !== undefined ? { target } : {}),
      ...(id !== undefined ? { id } : {}),
    };
  }
  return null;
}

export class VoiceRouter {
  private tasks: TaskStore;
  private complete: VoiceComplete | undefined;

  constructor(opts: { tasks: TaskStore; complete?: VoiceComplete }) {
    this.tasks = opts.tasks;
    this.complete = opts.complete;
  }

  /**
   * Route one utterance. Never throws for a live workspace: every failure
   * mode degrades to the agent route with an honest ack, because the one
   * unacceptable outcome is an utterance that gets no answer (§2.4).
   */
  async handle(
    workspaceId: string,
    req: {
      transcript: string;
      context?: VoiceContext;
      actor: { id: string; name: string; kind?: string };
    },
  ): Promise<VoiceHandleResult> {
    const workspace = this.tasks.getWorkspace(workspaceId);
    if (!workspace) return { ok: false, error: 'workspace-not-found' };
    const { transcript, context, actor } = req;

    let classification: VoiceClassification | null = null;
    let fastPathDown = false;
    if (this.complete) {
      const index = {
        goal: workspace.goal,
        goals: workspace.goals.flatMap((g) => [
          { id: g.id, title: g.title },
          ...(g.subgoals ?? []).map((sg) => ({ id: sg.id, title: sg.title })),
        ]),
        tasks: this.tasks.listTasks(workspaceId).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          ...(t.needs !== undefined ? { needs: t.needs } : {}),
        })),
        docIds: workspace.docIds,
      };
      try {
        const reply = await this.complete(buildVoicePrompt(index, transcript, context));
        classification = parseVoiceReply(reply);
        if (!classification) fastPathDown = true;
      } catch (err) {
        console.error('[voice] fast path failed:', err instanceof Error ? err.message : err);
        fastPathDown = true;
      }
    } else {
      fastPathDown = true;
    }

    let result: VoiceResult;
    if (classification?.kind === 'lookup') {
      result = this.lookupResult(workspaceId, transcript, classification);
    } else {
      // A change — or an unclassifiable utterance, which only the agent's
      // judgment can handle. Both take the agent route.
      const note = fastPathDown ? ' (Fast path unavailable.)' : '';
      if (this.tasks.hasLiveAttachment(workspaceId)) {
        result = {
          route: 'agent',
          ack: `${heard(transcript)} Sent to the workspace agent.${note}`,
        };
      } else {
        this.tasks.queueVoiceRequest(workspaceId, {
          transcript,
          ...(context !== undefined ? { context } : {}),
          actor,
        });
        result = {
          route: 'agent-queued',
          ack: `${heard(transcript)} Agent away — queued for its next attach.${note}`,
        };
      }
    }

    // Every utterance is audited, whatever happened to it (§3.6). For the
    // 'agent' route this emit IS the delivery: the event rides the workspace
    // channel the attached agent's MCP watch formats.
    this.tasks.recordVoiceRequest(workspaceId, {
      transcript,
      route: result.route,
      ack: result.ack,
      ...(context !== undefined ? { context } : {}),
      actor,
    });
    return { ok: true, ...result };
  }

  /** Validate the model's named target against the store — never navigate on
   *  an id the model may have invented. */
  private lookupResult(
    workspaceId: string,
    transcript: string,
    c: { target?: 'task' | 'doc'; id?: string },
  ): VoiceResult {
    if (c.target === 'task' && c.id) {
      const task = this.tasks.getTask(c.id);
      if (task && task.workspaceId === workspaceId) {
        return {
          route: 'fast-path',
          ack: `${heard(transcript)} Lookup — opening task "${task.title}".`,
          navigate: `/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(task.id)}`,
        };
      }
    }
    if (c.target === 'doc' && c.id) {
      const workspace = this.tasks.getWorkspace(workspaceId);
      if (workspace?.docIds.includes(c.id)) {
        return {
          route: 'fast-path',
          ack: `${heard(transcript)} Lookup — opening ${c.id}.`,
          navigate: `/review/${encodeURIComponent(c.id)}`,
        };
      }
    }
    return {
      route: 'fast-path',
      ack: `${heard(transcript)} Lookup — nothing in this workspace matched.`,
    };
  }
}

/**
 * The real Haiku completer, or null when the operator hasn't opted in.
 *
 * Consent is the SAME dedicated keychain entry the summarizer uses
 * (`claude-workspaces-summary-api-key` / CW_SUMMARY_API_KEY): adding
 * it is the act of consenting to LF→api.anthropic.com traffic, and voice
 * transcripts are the speaker's own words sent by their own explicit action.
 * A generic ANTHROPIC_API_KEY in the environment is deliberately not
 * honoured (see summarize.ts for the incident that rule comes from).
 */
export function haikuVoiceComplete(opts?: {
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  readKey?: (service: string) => string | null;
}): VoiceComplete | null {
  // Same two-name resolution as the summarizer: a machine set up before the
  // rename holds only the legacy entry, and reading just the new name left
  // the fast path silently off while summaries kept working.
  const key = resolveKeyFrom(opts?.apiKey, opts?.readKey ?? readKeychainPassword);
  if (!key) return null;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const resolvedKey = key;
  return async ({ system, user }) => {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': resolvedKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      return body.content?.map((b) => b.text ?? '').join('') ?? '';
    } finally {
      clearTimeout(timeout);
    }
  };
}
