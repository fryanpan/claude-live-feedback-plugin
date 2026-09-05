/**
 * The write guardrail: may this utterance change anything, and if so, what
 * exactly does it touch?
 *
 * Split out of `voice.ts` (A6). `resolveVoiceAction` is the only thing that
 * may build a `VoiceActionPlan`, and it refuses far more than it allows —
 * five conditions, checked for every verb including the read-only one. It
 * ships in its own file so the whole safety argument can be read without
 * scrolling past a router: nothing here reaches a store, a clock or the
 * network, so the file is the argument.
 *
 * The classification it consumes — `VoiceClassification`, `VOICE_ACTIONS`
 * and the vocabulary the plan names — is `voice-prompt.ts`. This file
 * imports from there and nothing imports back, which is what keeps the model
 * side and the authority side from becoming one thing again.
 */
import { taskBodyDocId } from './task-projection.ts';
import type { Ref, TaskStatus } from './tasks.ts';
import {
  type VoiceAction,
  type VoiceClassification,
  type VoiceContext,
  type VoicePick,
  type VoiceResource,
  type VoiceReviewItem,
  reviewItemKey,
} from './voice-prompt.ts';

/** Who is speaking. `kind` is optional on the wire and load-bearing here —
 *  see `resolveVoiceAction`, which refuses to act without it. */
export interface VoiceActor {
  id: string;
  name: string;
  kind?: string;
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
  | {
      action: 'answer-review';
      text: string;
      actor: VoiceActor;
      /** The item's headline, for the ack: "Answered … on <headline>". */
      headline: string;
      /** Set when the speaker picked an OPTION; `text` is then its label. */
      optionId?: string;
      target:
        | {
            kind: 'thread';
            docId: string;
            threadId: string;
            commentId: string;
            /**
             * `answer` stamps the reply onto a DECLARED Review Item; `reply`
             * is a plain threaded reply, for an open question that never
             * declared one. Chosen from the projection rather than from an
             * error string — see `VoiceThreadReviewItem.answerable`. Both are
             * existing public room writes.
             */
            mode: 'answer' | 'reply';
          }
        | { kind: 'ticket'; taskId: string; reviewItemId: string };
    }
  | { action: 'open-link'; taskId: string; ref: Ref };

/** "assign this to me" — the speaker, not a person literally named "me". */
const SELF_WORDS = new Set(['me', 'myself', 'i', 'mine']);

/**
 * Openers that make an utterance a QUESTION rather than an instruction.
 *
 * This list, plus a trailing '?', is the whole test — deliberately blunt.
 * A false positive costs one deferral to the agent, which is the route the
 * utterance took before any of this existed; a false negative is a write
 * nobody asked for, attributed to the speaker.
 */
const INTERROGATIVE_OPENERS = new Set([
  'what',
  'why',
  'how',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'which',
  'is',
  'are',
  'was',
  'were',
  'am',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
  'shall',
  'may',
  'might',
  'has',
  'have',
  'had',
]);

function isQuestion(transcript: string): boolean {
  const s = transcript.trim();
  if (s.length === 0) return true;
  if (s.endsWith('?')) return true;
  const first = s.toLowerCase().match(/^[a-z']+/)?.[0];
  return first !== undefined && INTERROGATIVE_OPENERS.has(first);
}

/** How each status may be SAID. The model normalizes to the store's three
 *  words; this is the other direction — what the speaker has to have uttered
 *  for the store's word to be traceable to them. */
const STATUS_WORDS: Record<TaskStatus, readonly string[]> = {
  // Deliberately narrow. Every other status here collects the synonyms a
  // person actually says; this one takes only the word itself, because the
  // near-misses ("park it", "not yet", "hold off") mean defer or reject and
  // routing any of them to a status that removes the row from every dispatch
  // read is a write the speaker did not ask for.
  triage: ['triage'],
  todo: ['todo', 'to do', 'to-do', 'backlog', 'not started', 'unstarted', 'undo', 'reopen'],
  'in-progress': [
    'in progress',
    'in-progress',
    'inprogress',
    'start',
    'started',
    'starting',
    'doing',
    'working',
    'work on',
    'wip',
    'underway',
    'picking',
  ],
  done: ['done', 'complete', 'completed', 'finish', 'finished', 'shipped', 'closed'],
};

/**
 * Did the SPEAKER ask for this write?
 *
 * The four original conditions constrained only WHICH resource an action
 * touched. Nothing constrained WHETHER a write was asked for at all — so any
 * text that could steer the classifier could steer a write under the
 * speaker's name, and a share visitor can author text that reaches the
 * prompt (a review headline of their choosing). This is the half that holds
 * whatever the model was told:
 *
 *  - a question is never an action. "what changed here?" is the exact
 *    utterance the demonstrated injection turned into a comment;
 *  - an action's ARGUMENTS must be traceable to the speaker's own words. A
 *    status the speaker never named, or an assignee they never said, did not
 *    come from them. Vacuous for the argument-less verbs, which is why it is
 *    stated as one rule rather than a per-verb table.
 */
function speakerLicensesAction(
  transcript: string,
  c: { action: VoiceAction; status?: TaskStatus; assignee?: string },
  actor: VoiceActor,
): boolean {
  if (isQuestion(transcript)) return false;
  const said = transcript.toLowerCase();
  if (c.action === 'set-status') {
    if (c.status === undefined) return false;
    return STATUS_WORDS[c.status].some((w) => said.includes(w));
  }
  if (c.action === 'set-assignee') {
    if (c.assignee === undefined) return false;
    const wanted = c.assignee.trim().toLowerCase();
    if (SELF_WORDS.has(wanted)) {
      // "assign this to me" — a self word has to actually be in the sentence.
      return /\b(me|myself|i|mine|my)\b/.test(said) || said.includes(actor.name.toLowerCase());
    }
    // Else the name, or at least the part of it a person would say out loud.
    const first = wanted.split(/\s+/)[0] ?? wanted;
    return said.includes(wanted) || (first.length > 1 && said.includes(first));
  }
  return true;
}

/**
 * Turn a classification into a plan, or into NOTHING.
 *
 * This is the whole guardrail, and it ships before any writer does so it can
 * be read on its own. Four conditions, all required:
 *
 *  1. the reply parses as a well-formed action (`parseVoiceReply` above);
 *  2. the id the action needs is present in the VALIDATED context — the
 *     `resource` is the thing that context named, and both must agree, so a
 *     deictic "mark this done" spoken from the board with no detail panel open
 *     resolves to nothing rather than to whatever was nearby;
 *  3. the model NAMED an id, and it is the context's. The prompt now REQUIRES
 *     the id, which is what makes this check able to fire: while the prompt
 *     forbade ids, an id-less action was both the compliant shape and the
 *     mis-targeted shape, so the two were indistinguishable here and "mark the
 *     deploy task as done" moved whatever ticket happened to be open;
 *  4. `actor.kind` is present. `classifyActor` (activity.ts) maps a kind-less
 *     author to `agent` — so without this, Bryan's own board move is attributed
 *     to an agent, and his reply cannot reopen a resolved thread. A missing
 *     `kind` is not a cosmetic gap; it silently rewrites who did it.
 *  5. the SPEAKER's own words license the write — see
 *     `speakerLicensesAction`. This is the only condition that does not
 *     assume the model ignored whatever a share visitor wrote into the
 *     workspace text the prompt carries.
 *
 * All five are checked for EVERY verb, including the read-only `open-link`.
 * Gating a navigation on `actor.kind` is stricter than that one verb needs;
 * the uniformity is the point, because the alternative is a per-verb table of
 * which guards apply, and the verb that gets added without its row is the one
 * that writes.
 *
 * Any failure returns null and the utterance takes the agent route exactly as
 * it does today.
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
  // (3) the model must NAME the target, and it must be the one in view.
  if (c.id === undefined || c.id !== resource.id) return null;
  // (5) and the speaker must have asked for a write, in their own words.
  if (!speakerLicensesAction(transcript, c, actor)) return null;

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
      const items = resource.kind === 'doc' ? resource.reviewItems : (resource.reviewItems ?? []);
      // Which item "that comment" means comes from the SPEAKER, never the
      // model: the thread they have open (context), a pick the deterministic
      // parser resolved from their own words, or the one item there is. With
      // several open and none of those, the choice would be the model naming
      // a thread id — the thing condition (3) forbids — so it is the agent's.
      const item = pickReviewItem(items, context, c.pick);
      if (!item) return null;
      const text = c.pick?.text ?? c.pick?.optionLabel ?? transcript;
      const optionId = c.pick?.optionId;
      // The option must be one the ITEM offers, by the store's own id.
      if (optionId !== undefined && !item.options?.some((o) => o.id === optionId)) return null;
      const target =
        'reviewItemId' in item
          ? { kind: 'ticket' as const, taskId: resource.id, reviewItemId: item.reviewItemId }
          : {
              kind: 'thread' as const,
              // A task's discussion lives in its body room.
              docId: resource.kind === 'doc' ? resource.id : taskBodyDocId(resource.id),
              threadId: item.threadId,
              commentId: item.commentId,
              // A declared Review Item gets its answer STAMPED; a plain open
              // question gets a plain reply. Both are what "reply to that
              // review comment" means, and the first cut could only do the
              // former.
              mode: item.answerable ? ('answer' as const) : ('reply' as const),
            };
      if (target.kind === 'ticket' && resource.kind !== 'task') return null;
      return {
        action: 'answer-review',
        text,
        actor,
        headline: item.ask,
        ...(optionId !== undefined ? { optionId } : {}),
        target,
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

/**
 * The review item an utterance is about, or nothing.
 *
 * In order: the item the deterministic parser resolved (its key must still
 * be one of the items in view — the parser read the same projection, but
 * the guardrail re-checks rather than trusts); the thread / row the speaker
 * has OPEN; the only item there is. Several items and no pin is nothing.
 */
export function pickReviewItem(
  items: VoiceReviewItem[],
  context: VoiceContext,
  pick?: VoicePick,
): VoiceReviewItem | undefined {
  if (pick) return items.find((i) => reviewItemKey(i) === pick.itemKey);
  if (context.threadId !== undefined) {
    const pinned = items.find((i) => !('reviewItemId' in i) && i.threadId === context.threadId);
    if (pinned) return pinned;
  }
  if (context.reviewItemId !== undefined) {
    const pinned = items.find(
      (i) => 'reviewItemId' in i && i.reviewItemId === context.reviewItemId,
    );
    if (pinned) return pinned;
  }
  // The one item there is — but only on the DOC surface, where the speaker
  // is looking at the item itself. On the task surface `taskId` may be a
  // keyboard-highlighted ROW, not an open panel, and "answer: yes" would
  // land on whatever the cursor rested on. There, the board sends a pin
  // (`threadId` / `reviewItemId`) only with the panel open, and no pin means
  // no item.
  if (context.surface !== 'doc') return undefined;
  const [only, ...rest] = items;
  return only && rest.length === 0 ? only : undefined;
}
