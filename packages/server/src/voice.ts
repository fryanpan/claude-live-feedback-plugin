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
import type { Ref, Task, TaskStatus, TaskStore } from './tasks.ts';

export type VoiceSurface = 'hub' | 'doc' | 'task';

/** Who is speaking. `kind` is optional on the wire and load-bearing here —
 *  see `resolveVoiceAction`, which refuses to act without it. */
export interface VoiceActor {
  id: string;
  name: string;
  kind?: string;
}

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

/**
 * The thing the speaker is looking at, once it has been proved to belong to
 * this workspace. Only ever built from a VALIDATED context — see
 * `VoiceRouter.validateContext`.
 */
export type VoiceResource =
  | {
      kind: 'task';
      id: string;
      title: string;
      status: string;
      assignee: string;
      needs?: string;
      links: Ref[];
    }
  | { kind: 'doc'; id: string; title?: string; reviewItems: VoiceReviewItem[] };

/** One open review item on a doc, flattened to what a prompt can use. Kept to
 *  three fields on purpose: the review-item SHAPE is owned elsewhere and is
 *  being reworked, so voice reads a projection of it rather than its type. */
export interface VoiceReviewItem {
  threadId: string;
  ask: string;
  askedBy: string;
}

/** How the router learns what a doc holds. Injected, because the answer needs
 *  the room store and the review-item builder — neither of which voice owns,
 *  and neither of which it should grow a second copy of. */
export type VoiceDocResourceReader = (
  workspaceId: string,
  docId: string,
) => { title?: string; reviewItems: VoiceReviewItem[] } | undefined;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

/** Longest prefix of `text` that fits in `max` bytes, never splitting a
 *  character. Binary search over code-unit offsets, then one step back off a
 *  dangling high surrogate. */
function truncateToBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(text.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  const code = text.charCodeAt(lo - 1);
  if (lo > 0 && code >= 0xd800 && code <= 0xdbff) lo -= 1;
  return text.slice(0, lo);
}

/** A ref as one readable clause. Never an href: this text goes to a model, and
 *  the only ids it may act on are the ones it can read back here. */
function describeRef(ref: Ref): string {
  switch (ref.kind) {
    case 'doc':
      return `doc ${ref.docId}`;
    case 'thread':
      return `thread ${ref.threadId} on doc ${ref.docId}`;
    case 'task':
      return `task ${ref.taskId}`;
    case 'diff':
      return `diff ${ref.workspaceId}`;
    case 'url':
      return `url ${ref.url}`;
  }
}

/** Render the `Resource in view:` block, clamped to `RESOURCE_MAX` bytes. */
export function renderResourceBlock(resource: VoiceResource): string {
  const lines: string[] = [];
  if (resource.kind === 'task') {
    lines.push(`Resource in view: task ${resource.id}`);
    lines.push(`  title: ${resource.title}`);
    lines.push(`  status: ${resource.status}`);
    lines.push(`  assignee: ${resource.assignee}`);
    if (resource.needs) lines.push(`  needs: ${resource.needs}`);
    if (resource.links.length > 0) {
      lines.push('  links:');
      for (const ref of resource.links) lines.push(`    - ${describeRef(ref)}`);
    }
  } else {
    lines.push(`Resource in view: doc ${resource.id}`);
    if (resource.title) lines.push(`  title: ${resource.title}`);
    if (resource.reviewItems.length > 0) {
      lines.push('  open review items:');
      for (const item of resource.reviewItems) {
        lines.push(`    - ${item.threadId} (${item.askedBy}): ${item.ask}`);
      }
    }
  }
  const full = lines.join('\n');
  if (byteLength(full) <= RESOURCE_MAX) return full;
  return `${truncateToBytes(full, RESOURCE_MAX)}\n  … (truncated at ${RESOURCE_MAX} bytes — this resource has more content than is shown)`;
}

/** One classification round trip: prompt in, raw reply text out. Injected in
 *  tests; the real one is `haikuVoiceComplete` below. */
export type VoiceComplete = (args: { system: string; user: string }) => Promise<string>;

/**
 * The scoped verb set. Deliberately closed: everything NOT on this list is a
 * `change` and belongs to the agent, so widening what voice may do by itself
 * is an edit to this union rather than a prompt the model reinterprets.
 */
export const VOICE_ACTIONS = [
  'set-status',
  'set-assignee',
  'comment',
  'answer-review',
  'open-link',
] as const;
export type VoiceAction = (typeof VOICE_ACTIONS)[number];

export type VoiceClassification =
  | { kind: 'change' }
  | { kind: 'lookup'; target?: 'task' | 'doc'; id?: string }
  | {
      kind: 'action';
      action: VoiceAction;
      status?: TaskStatus;
      assignee?: string;
      /**
       * An id the model named even though the prompt forbids it. Captured
       * rather than dropped ON PURPOSE: `resolveVoiceAction` can only refuse a
       * target the speaker never had in view if it can SEE the model reaching
       * for one. Silently ignoring this field would turn a hallucinated target
       * into a write against the resource that happened to be in view.
       */
      id?: string;
    };

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
/**
 * 120 was sized for a 30-byte classification, and an action reply is longer.
 * Raised deliberately rather than left to fit "most" of them: a truncated
 * reply parses to null, which is SAFE — it takes the agent route — but it is
 * safe in the way a permanently disabled feature is safe, and nothing would
 * have reported it. Still far under a runaway.
 */
const MAX_TOKENS = 200;
const TIMEOUT_MS = 10_000;
/** Keep acks readable when a hold rambles. */
const ACK_TRANSCRIPT_MAX = 90;
/**
 * How many BYTES of the `Resource in view:` block may ride into the prompt.
 *
 * Explicit because nothing upstream of here is bounded: the transcript is
 * clamped by the route, but the prompt already grows with the task list, and
 * this server has no rate limit anywhere. A task title, a link list, or a
 * doc's open review items are all caller-authored and all unbounded, so
 * without a budget one long-winded doc silently becomes the cost of every
 * utterance spoken over it. Over budget the block is cut and SAYS it was cut —
 * a model told nothing about the truncation will answer as if it saw the rest.
 */
export const RESOURCE_MAX = 1200;

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
  resource?: VoiceResource,
): { system: string; user: string } {
  const system = [
    'You route voice requests for a task workspace. Decide: does the utterance',
    'CHANGE something (create/edit/regroup/reprioritize/assign/answer), or is it',
    'a LOOKUP (navigate to / open / find an existing task or doc)?',
    'A change that is one of the ACTIONS below, applied to the resource in',
    'view, is an ACTION; every other change is {"kind":"change"}.',
    'Reply with ONE JSON object and nothing else:',
    '  {"kind":"change"}',
    '  {"kind":"lookup","target":"task","id":"<task id from the index>"}',
    '  {"kind":"lookup","target":"doc","id":"<doc id from the index>"}',
    '  {"kind":"lookup"}   (a lookup, but nothing in the index matches)',
    '  {"kind":"action","action":"set-status","status":"todo|in-progress|done"}',
    '  {"kind":"action","action":"set-assignee","assignee":"<name, or \'me\' for the speaker>"}',
    '  {"kind":"action","action":"comment"}        (say this on the resource in view)',
    '  {"kind":"action","action":"answer-review"}  (answer its open review item)',
    '  {"kind":"action","action":"open-link"}      (open the resource\'s linked doc/mockup)',
    'An ACTION applies to the resource in view and to nothing else.',
    'NEVER name an id in an action — the target is the resource in view, and',
    'an action over anything else is {"kind":"change"}.',
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
  // What the speaker is actually looking at. Present only for a context id
  // the router has proved is a member of THIS workspace, so a model reading
  // this block cannot be shown another board's content by a crafted request.
  if (resource) lines.push(renderResourceBlock(resource));
  lines.push(`Utterance: "${transcript}"`);
  return { system, user: lines.join('\n') };
}

/** Longest assignee name the fast path will carry. */
const ASSIGNEE_MAX = 100;

/** The three words the store knows, and nothing else. Spoken status names
 *  arrive spelled however the model felt like spelling them, so "In Progress"
 *  and "in_progress" normalize — but an invented status is undefined, and an
 *  undefined status is what makes `set-status` fail to resolve. */
function parseTaskStatus(raw: unknown): TaskStatus | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return v === 'todo' || v === 'in-progress' || v === 'done' ? v : undefined;
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
  if (p.kind === 'action') {
    const action = VOICE_ACTIONS.find((a) => a === p.action);
    // A verb outside the scoped set is not a narrower action — it is an
    // utterance this classifier has no answer for, which is the same state as
    // unparseable, and takes the agent route.
    if (!action) return null;
    const status = parseTaskStatus(p.status);
    const assignee =
      typeof p.assignee === 'string' && p.assignee.trim().length > 0
        ? p.assignee.trim().slice(0, ASSIGNEE_MAX)
        : undefined;
    const id = typeof p.id === 'string' && p.id.length > 0 ? p.id : undefined;
    return {
      kind: 'action',
      action,
      ...(status !== undefined ? { status } : {}),
      ...(assignee !== undefined ? { assignee } : {}),
      ...(id !== undefined ? { id } : {}),
    };
  }
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

/**
 * A spoken action, resolved down to exactly which record it touches. Built
 * only by `resolveVoiceAction`; nothing else may construct one, because the
 * whole safety argument is that a plan cannot name a target the speaker did
 * not have in view.
 */
export type VoiceActionPlan =
  | { action: 'set-status'; taskId: string; status: TaskStatus; actor: VoiceActor }
  | { action: 'set-assignee'; taskId: string; assignee: string; actor: VoiceActor }
  | {
      action: 'comment';
      target: { kind: 'task'; taskId: string } | { kind: 'doc'; docId: string };
      text: string;
      actor: VoiceActor;
    }
  | { action: 'answer-review'; docId: string; threadId: string; text: string; actor: VoiceActor }
  | { action: 'open-link'; taskId: string; ref: Ref };

/** "assign this to me" — the speaker, not a person literally named "me". */
const SELF_WORDS = new Set(['me', 'myself', 'i', 'mine']);

/**
 * Turn a classification into a plan, or into NOTHING.
 *
 * This is the whole guardrail, and it ships before any writer does so it can
 * be read on its own. Four conditions, all required:
 *
 *  1. the reply parses as a well-formed action (`parseVoiceReply` above);
 *  2. the id the action needs is present in the VALIDATED context — the
 *     `resource` is the thing that context named, and both must agree, so a
 *     deictic "mark this done" spoken from the hub with no detail panel open
 *     resolves to nothing rather than to whatever was nearby;
 *  3. the model named NO id, or named one identical to the context's. The
 *     prompt forbids naming ids; this is the half that does not depend on the
 *     model having obeyed;
 *  4. `actor.kind` is present. `classifyActor` (activity.ts) maps a kind-less
 *     author to `agent` — so without this, Bryan's own board move is attributed
 *     to an agent, and his reply cannot reopen a resolved thread. A missing
 *     `kind` is not a cosmetic gap; it silently rewrites who did it.
 *
 * All four are checked for EVERY verb, including the read-only `open-link`.
 * Gating a navigation on `actor.kind` is stricter than that one verb needs;
 * the uniformity is the point, because the alternative is a per-verb table of
 * which guards apply, and the verb that gets added without its row is the one
 * that writes.
 *
 * Any failure returns null and the utterance takes the agent route exactly as
 * it does today. Deliberately NOT wired into `handle()` yet — the executors
 * land next, and separating them keeps the rule reviewable without a writer
 * behind it.
 */
export function resolveVoiceAction(args: {
  classification: VoiceClassification | null;
  actor: VoiceActor;
  transcript: string;
  context?: VoiceContext;
  resource?: VoiceResource;
}): VoiceActionPlan | null {
  const { classification: c, actor, transcript, context, resource } = args;
  // (1) a well-formed action, and nothing else.
  if (!c || c.kind !== 'action') return null;
  // (4) an actor who says what they are.
  if (typeof actor.kind !== 'string' || actor.kind.trim().length === 0) return null;
  // (2) the resource must be the one the validated context named. Checking
  // both sides rather than trusting the caller to have paired them: the
  // resource is a projection, and a projection with no context behind it is
  // exactly the "acted on something nobody was looking at" failure.
  if (!resource || !context) return null;
  const contextId = resource.kind === 'task' ? context.taskId : context.docId;
  if (contextId === undefined || contextId !== resource.id) return null;
  // (3) the model may not reach past what is in view.
  if (c.id !== undefined && c.id !== resource.id) return null;

  switch (c.action) {
    case 'set-status':
      if (resource.kind !== 'task' || c.status === undefined) return null;
      return { action: 'set-status', taskId: resource.id, status: c.status, actor };
    case 'set-assignee': {
      if (resource.kind !== 'task' || c.assignee === undefined) return null;
      const assignee = SELF_WORDS.has(c.assignee.toLowerCase()) ? actor.name : c.assignee;
      if (assignee.trim().length === 0) return null;
      return { action: 'set-assignee', taskId: resource.id, assignee, actor };
    }
    case 'comment':
      return {
        action: 'comment',
        target:
          resource.kind === 'task'
            ? { kind: 'task', taskId: resource.id }
            : { kind: 'doc', docId: resource.id },
        text: transcript,
        actor,
      };
    case 'answer-review': {
      if (resource.kind !== 'doc') return null;
      // Which item "that comment" means is only knowable when there is one.
      // With none open there is nothing to answer; with several, picking would
      // mean the model naming a thread id — the thing condition (3) forbids.
      // Both cases are the agent's call, which is a narrowing a later commit
      // can widen by putting the choice in the speaker's hands, never the
      // model's.
      const [only, ...rest] = resource.reviewItems;
      if (!only || rest.length > 0) return null;
      return {
        action: 'answer-review',
        docId: resource.id,
        threadId: only.threadId,
        text: transcript,
        actor,
      };
    }
    case 'open-link': {
      if (resource.kind !== 'task') return null;
      const [only, ...rest] = resource.links;
      if (!only || rest.length > 0) return null;
      return { action: 'open-link', taskId: resource.id, ref: only };
    }
  }
}

export class VoiceRouter {
  private tasks: TaskStore;
  private complete: VoiceComplete | undefined;
  private docResource: VoiceDocResourceReader | undefined;

  constructor(opts: {
    tasks: TaskStore;
    complete?: VoiceComplete;
    docResource?: VoiceDocResourceReader;
  }) {
    this.tasks = opts.tasks;
    this.complete = opts.complete;
    this.docResource = opts.docResource;
  }

  /**
   * THE membership predicate for a task id — one rule, used by the context
   * check and by the lookup validation below.
   *
   * They agree today, which is exactly when two copies are cheapest to write
   * and most expensive later: one gets a fix and the other keeps the hole.
   * `getTask` is a GLOBAL index, so without this an id from any board on this
   * server resolves.
   */
  private taskInWorkspace(workspaceId: string, taskId: string): Task | undefined {
    const task = this.tasks.getTask(taskId);
    return task && task.workspaceId === workspaceId ? task : undefined;
  }

  /** The same rule for a doc: attached to THIS workspace, or not present. */
  private docInWorkspace(workspaceId: string, docId: string): boolean {
    return this.tasks.getWorkspace(workspaceId)?.docIds.includes(docId) ?? false;
  }

  /**
   * The client's context, with any id that is not a member of this workspace
   * DROPPED — never trusted, never quietly passed along.
   *
   * `parseVoiceContext` only clamps lengths, so up to here a `taskId` is an
   * arbitrary client string. Dropping happens before the context is used for
   * ANYTHING — prompt, queue, audit record — rather than only at the point of
   * a write: a foreign id in the queue is a foreign id the next reader has to
   * re-check, and one of them eventually won't.
   */
  private validateContext(workspaceId: string, context?: VoiceContext): VoiceContext | undefined {
    if (!context) return undefined;
    const taskId =
      context.taskId !== undefined && this.taskInWorkspace(workspaceId, context.taskId)
        ? context.taskId
        : undefined;
    const docId =
      context.docId !== undefined && this.docInWorkspace(workspaceId, context.docId)
        ? context.docId
        : undefined;
    return {
      surface: context.surface,
      ...(docId !== undefined ? { docId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(context.visibleHeading !== undefined ? { visibleHeading: context.visibleHeading } : {}),
    };
  }

  /**
   * The resource the speaker is looking at, for the prompt. Takes an ALREADY
   * VALIDATED context — the ids here are members by construction.
   *
   * A task wins over a doc when both are set: the task is the narrower thing
   * in view (a task opened over a doc surface), and "this" means the narrower
   * one to whoever said it.
   */
  private resourceInView(workspaceId: string, context?: VoiceContext): VoiceResource | undefined {
    if (!context) return undefined;
    if (context.taskId !== undefined) {
      const task = this.taskInWorkspace(workspaceId, context.taskId);
      if (task) {
        return {
          kind: 'task',
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: task.assignee,
          ...(task.needs !== undefined ? { needs: task.needs } : {}),
          links: task.links,
        };
      }
    }
    if (context.docId !== undefined) {
      const doc = this.docResource?.(workspaceId, context.docId);
      return {
        kind: 'doc',
        id: context.docId,
        ...(doc?.title ? { title: doc.title } : {}),
        reviewItems: doc?.reviewItems ?? [],
      };
    }
    return undefined;
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
      actor: VoiceActor;
    },
  ): Promise<VoiceHandleResult> {
    const workspace = this.tasks.getWorkspace(workspaceId);
    if (!workspace) return { ok: false, error: 'workspace-not-found' };
    const { transcript, actor } = req;
    // Everything below reads `context`, and nothing below re-checks it.
    const context = this.validateContext(workspaceId, req.context);

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
      const resource = this.resourceInView(workspaceId, context);
      try {
        const reply = await this.complete(buildVoicePrompt(index, transcript, context, resource));
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
      // judgment can handle. Both take the agent route, and so does an
      // ACTION for now: `resolveVoiceAction` exists and is tested, but the
      // executors behind it land in the next commits, so classifying an
      // utterance as an action changes nothing a speaker can observe yet.
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
      const task = this.taskInWorkspace(workspaceId, c.id);
      if (task) {
        return {
          route: 'fast-path',
          ack: `${heard(transcript)} Lookup — opening task "${task.title}".`,
          navigate: `/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(task.id)}`,
        };
      }
    }
    if (c.target === 'doc' && c.id) {
      if (this.docInWorkspace(workspaceId, c.id)) {
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
