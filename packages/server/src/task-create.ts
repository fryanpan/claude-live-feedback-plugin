/**
 * One reading of a task-create body, shared by every route that accepts one.
 *
 * There are now two: `POST /api/workspaces/<id>/tasks` (one task) and
 * `POST /api/workspaces/<id>/tasks/batch` (a burst). They must agree on every
 * field — validation, defaults, and above all who owns the result — and the
 * route layer is exactly the layer nothing type-checks, so two hand-copied
 * copies of this would drift the first time a field is added to one of them.
 * That has already happened twice in this repo (`groups` accepted and
 * discarded; `actor` never forwarded on import). So the copying happens here,
 * once, and both routes call it.
 *
 * Deliberately NOT the store's job: the store takes a `CreateTaskOpts` and is
 * the gate for what a task may BE. This is the gate for what a REQUEST may
 * say, which is a different question with different error shapes (a 400 the
 * caller can act on, per field).
 */
import {
  type ReviewPayload,
  checkReviewPayload,
  readReviewPayload,
  reviewGapAdvice,
  reviewPayloadMessage,
} from '@feedback/core';
import { BATCH_REF_SIGIL } from './task-batch-refs.ts';
import {
  ASSIGNEE_REQUIRED_ERROR,
  ASSIGNEE_REQUIRED_MESSAGE,
  BAD_ASSIGNEE_KIND_ERROR,
  BAD_ASSIGNEE_KIND_MESSAGE,
  parseAssigneeKind,
  resolveAssignee,
} from './task-owner.ts';
import {
  type CreateTaskOpts,
  REF_KINDS,
  type Ref,
  UNTITLED_TASK_TITLE,
  isValidRef,
} from './tasks.ts';

export const BAD_TITLE_ERROR = 'title required';
export const BATCH_REF_OUTSIDE_BATCH_ERROR = 'batch-ref-outside-batch';
export const BAD_NEEDS_ERROR = "needs must be 'action' | 'decision'";
export const BAD_OPTIONS_ERROR = 'options must be [{label, detail?}] with a non-empty label';

/** Same spelling the dedicated review-item route answers with, so a caller
 *  that learns the error on one door recognises it on the other. */
export const BAD_REVIEW_ERROR = 'bad-review';

/** The 400 body for a ref a route refuses. Naming the accepted kinds turns a
 *  source dive into a re-send — the first outside caller of these routes had
 *  to read tasks.ts to discover which spellings existed. */
export const BAD_REF_ERROR = `links must be an array of valid refs (kind: ${REF_KINDS.join(' | ')}); a url ref must be http(s)`;

/** Same rules, one ref, named for the field so the caller knows where to look. */
export const BAD_ORIGIN_ERROR = `origin must be a valid ref (kind: ${REF_KINDS.join(' | ')}); a url ref must be http(s)`;

/**
 * `needs` for the task-create routes. Validated HERE, the way `riskTier`
 * and `runtime` already are on neighbouring routes: a capitalized
 * `'Decision'` stored verbatim produces a task that is absent from the
 * decisions strip, absent from `list_tasks(needs:'decision')`, and refused
 * by `answer_decision` — while the create call answered 200.
 */
export function parseNeeds(
  raw: unknown,
): { ok: true; needs?: 'action' | 'decision' } | { ok: false } {
  if (raw === undefined) return { ok: true };
  if (raw === 'action' || raw === 'decision') return { ok: true, needs: raw };
  return { ok: false };
}

/**
 * `options` for the task-create routes — the candidate answers a decision
 * arrives with.
 *
 * Refused rather than partially accepted, unlike `links`: an option is not an
 * annotation, it is a control the person deciding will TAP, and a silently
 * dropped one is a choice they were never offered. The store re-checks the
 * same rules (it is the gate), so this exists to turn a shape error into a 400
 * instead of a cast that reaches the store as `undefined`.
 */
export function parseOptions(
  raw: unknown,
): { ok: true; options?: Array<{ label: string; detail?: string }> } | { ok: false } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return { ok: false };
  const options: Array<{ label: string; detail?: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return { ok: false };
    const o = entry as { label?: unknown; detail?: unknown };
    if (typeof o.label !== 'string' || o.label.trim().length === 0) return { ok: false };
    if (o.detail !== undefined && typeof o.detail !== 'string') return { ok: false };
    options.push({
      label: o.label,
      ...(typeof o.detail === 'string' ? { detail: o.detail } : {}),
    });
  }
  return { ok: true, options };
}

/**
 * `review` for the task-create routes — ONE review item filed with the ticket
 * that raises it.
 *
 * The whole point of the entity is that a ticket HAS review items rather than
 * IS one: the title is not the question, the question has its own blurb, and a
 * ticket can carry several at once. Without this field an agent files the
 * ticket, reads back its id, and posts the item in a second call — two round
 * trips to say one thing, and a window in which the ticket exists with the
 * question missing.
 *
 * Refused rather than partially accepted, for exactly the reason `parseOptions`
 * is: the options inside are controls a person will TAP, and a silently dropped
 * one is a choice they were never offered. Beyond that, a review item accepted
 * and discarded is a question nobody is ever asked — the ticket lands, the 200
 * says it worked, and the queue stays empty.
 *
 * Gated by `checkReviewPayload` — THE checker, the same one comment-borne
 * declarations and `addReviewItem` run. A second copy of a limit here is how a
 * card ends up rendering something the API swore it had refused.
 *
 * `advice` is the non-refusing half and rides back on the 200; see
 * `reviewGapAdvice`. An author who is never told writes the same thin item
 * again.
 */
export function parseReview(
  raw: unknown,
): { ok: true; review?: ReviewPayload; advice?: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true };
  const check = checkReviewPayload(raw);
  if (!check.ok) return { ok: false, message: reviewPayloadMessage(check) };
  const advice = reviewGapAdvice(check.gaps);
  // Same reader the store uses: the agent-facing spellings (`review_type`,
  // 'question') normalize to the stored vocabulary here, not downstream.
  const review = readReviewPayload(raw);
  if (!review) return { ok: false, message: reviewPayloadMessage(check) };
  return { ok: true, review, ...(advice !== undefined ? { advice } : {}) };
}

/**
 * `links` for the task-create routes: every element through the SAME
 * `isValidRef` the dedicated links route runs — a malformed ref matches no
 * backlink query, so the chip the link existed for never appears, and a
 * silent 200 hides that.
 *
 * But it is PARTIAL: bad refs are dropped and reported in `ignoredLinks`,
 * and the task is still created. Rejecting the whole call cost an outside
 * user a task's title, body, goal and assignee over one malformed field on
 * an *annotation* — and refs are explicitly never existence-checked, so a
 * well-formed ref pointing nowhere was already accepted. Refusing the
 * malformed one outright was the harsher answer to the lesser problem.
 * The precedent is the import path, which returns `ignoredColumns` rather
 * than refusing a tracker with one column it doesn't understand.
 *
 * The dedicated `POST /api/tasks/:id/links` route deliberately still 400s:
 * there the ref IS the request, so dropping it would mean answering 200 to
 * a call that did nothing. The distinction is annotation vs. payload, not
 * one route being stricter than another.
 *
 * `ok: false` now means only "this isn't an array at all".
 */
export function parseLinks(
  raw: unknown,
): { ok: true; links?: Ref[]; ignored: unknown[] } | { ok: false } {
  if (raw === undefined) return { ok: true, ignored: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const links: Ref[] = [];
  const ignored: unknown[] = [];
  for (const ref of raw) {
    if (isValidRef(ref)) links.push(ref);
    else ignored.push(ref);
  }
  return { ok: true, links, ignored };
}

/**
 * The promotion `origin`, validated rather than cast.
 *
 * It used to be `body?.origin as Ref | undefined` — a cast, which checks
 * nothing at runtime. Two holes, both reachable from one unauthenticated
 * POST: a `url` origin skipped the http(s) scheme check that the identical
 * ref in `links` gets (the whole reason that check exists is that a url ref
 * reaches the DOM as an href), and `origin: null` persisted to disk and then
 * threw in `refKey` on every backlink query — including the doc-open path,
 * for every workspace, until someone hand-edited the JSON.
 *
 * `null` is read as "no origin" because clients spell an absent field that
 * way and dropping it is harmless. A present-but-malformed origin 400s: it's
 * payload, not annotation — unlike `links`, there is no good half to keep.
 */
export function parseOrigin(raw: unknown): { ok: true; origin?: Ref } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!isValidRef(raw)) return { ok: false };
  return { ok: true, origin: raw };
}

/**
 * A batch-local reference (`"#seed"`) that reached a body with no batch
 * around it.
 *
 * The batch route substitutes every one of these for a real id BEFORE this
 * parser sees the row, so by the time a `#` entry gets here it is on the
 * single-create route, where it can never resolve. Passing it through as a
 * task id earns `unknown-after` — which sends the caller hunting for a task
 * that was never the problem. Same class as the refusals in
 * task-batch-refs.ts: name the actual mistake, once, where it is made.
 */
function batchRefIn(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.find((e) => typeof e === 'string' && e.startsWith(BATCH_REF_SIGIL)) as
    | string
    | undefined;
}

/**
 * What the caller can actually SEE of the row it just created — stated
 * plainly, per row, on the create response.
 *
 * The defect this closes: an agent filed a row with `assignee: <person>` plus
 * a decision review item in one call, got back `placed: true`, and nothing
 * said the row itself would be returned by no dispatch read (`triage` status)
 * — a success-shaped response for work whose visibility the caller had no way
 * to know about. `placed` answers a different question (goal placement), so
 * this is its own sentence: a triage row names the transition that makes it
 * dispatchable, and a row that filed a review item states where the ask
 * already is — since 2026-08-24 a review item reaches the addressee's Home
 * queue whatever the carrying row's status, and saying so is what makes
 * "file the ask and keep working" trustworthy.
 *
 * Undefined when there is nothing to warn about (a person-filed row with no
 * review item is ordinarily visible): a note that is always there is a note
 * nobody reads.
 */
export function createdVisibility(
  status: string,
  hasReview: boolean,
  planHeld = false,
): string | undefined {
  const triage = status === 'triage';
  if (!triage && !hasReview) return undefined;
  const parts: string[] = [];
  if (planHeld) {
    // The stronger sentence REPLACES the triage one: a held draft cannot be
    // transitioned out, so naming task_transition as the way forward would
    // send the caller to a door that refuses.
    parts.push(
      'This row is a plan draft: visible on the board, in no dispatch read, and held in triage until the plan doc is approved — approval releases it to todo.',
    );
  } else if (triage) {
    parts.push(
      'This row is in triage: no dispatch read returns it until task_transition moves it to todo or in-progress.',
    );
  }
  if (hasReview) {
    parts.push(
      triage
        ? "Its review item IS on the addressee's Home review queue already — the ask is visible even while the row is unvetted."
        : "Its review item is on the addressee's Home review queue now.",
    );
  }
  return parts.join(' ');
}

export type TaskCreateParse =
  | {
      ok: true;
      opts: CreateTaskOpts;
      ignoredLinks: unknown[];
      /**
       * Beside `opts`, not inside it. `CreateTaskOpts` is what a task may BE;
       * a review item is a ROW that hangs on the task, written by
       * `addReviewItem` once the task has an id. Folding it into the create
       * options would give "attach a review item" a second implementation,
       * free to disagree with the first about ids, gaps and limits — which is
       * the two-spellings problem this whole entity removes.
       */
      review?: ReviewPayload;
      /** The gaps of that review, phrased as what to write. Advice on a
       *  successful create, never a refusal. */
      reviewAdvice?: string;
    }
  | { ok: false; error: string; message?: string };

/**
 * A whole task-create body → the `CreateTaskOpts` the store takes, or the 400
 * that body earns.
 *
 * `author` is the caller's already-resolved identity (the routes run it
 * through `authorFor` first, because a share visitor's claimed identity is
 * rewritten before anything trusts it). It serves two purposes and they are
 * not the same: it attributes the create, AND it is the fallback owner when
 * the body names none.
 */
export function parseTaskCreate(
  raw: unknown,
  author: { id: string; name: string; kind?: string } | undefined,
): TaskCreateParse {
  const body = (raw ?? {}) as Record<string, unknown>;
  // The ONE way past the blank-title refusal: the caller SAYS the row has no
  // name yet (the Board's "New task", which opens the panel to type into).
  // A blank title without the flag is still the 400 it always was — the flag
  // is a declaration, not a default.
  const untitled = body.untitled === true;
  const rawTitle = body.title;
  const title =
    untitled && (rawTitle === undefined || (typeof rawTitle === 'string' && !rawTitle.trim()))
      ? UNTITLED_TASK_TITLE
      : rawTitle;
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { ok: false, error: BAD_TITLE_ERROR };
  }
  const needs = parseNeeds(body.needs);
  if (!needs.ok) return { ok: false, error: BAD_NEEDS_ERROR };
  const kind = parseAssigneeKind(body.assigneeKind);
  if (!kind.ok) {
    return { ok: false, error: BAD_ASSIGNEE_KIND_ERROR, message: BAD_ASSIGNEE_KIND_MESSAGE };
  }
  const options = parseOptions(body.options);
  if (!options.ok) return { ok: false, error: BAD_OPTIONS_ERROR };
  const review = parseReview(body.review);
  if (!review.ok) return { ok: false, error: BAD_REVIEW_ERROR, message: review.message };
  const links = parseLinks(body.links);
  if (!links.ok) return { ok: false, error: BAD_REF_ERROR };
  const origin = parseOrigin(body.origin);
  if (!origin.ok) return { ok: false, error: BAD_ORIGIN_ERROR };
  const strayRef = batchRefIn(body.after) ?? batchRefIn(body.afterEnforce);
  if (strayRef !== undefined) {
    return {
      ok: false,
      error: BATCH_REF_OUTSIDE_BATCH_ERROR,
      message: `"${strayRef}" is a batch-local reference and there is no batch here — it can only name another row of the same create_tasks call. Name a task id you already hold, or send both tasks in one create_tasks call.`,
    };
  }
  // Nothing enters the board belonging to nobody: an unnamed assignee falls
  // back to the caller's own identity, and a create that still resolves to
  // the generic word is refused rather than filed under it.
  const owner = resolveAssignee(body.assignee, author);
  if (!owner) {
    return { ok: false, error: ASSIGNEE_REQUIRED_ERROR, message: ASSIGNEE_REQUIRED_MESSAGE };
  }
  return {
    ok: true,
    ignoredLinks: links.ignored,
    ...(review.review !== undefined ? { review: review.review } : {}),
    ...(review.advice !== undefined ? { reviewAdvice: review.advice } : {}),
    opts: {
      title: title.trim(),
      // Only when the placeholder is what got stored: `untitled: true` beside
      // a real title is a caller contradicting itself, and the title wins.
      ...(untitled && title === UNTITLED_TASK_TITLE ? { untitled: true } : {}),
      body: body.body as string | undefined,
      assignee: owner,
      // Left undefined when the caller said nothing — the store then derives
      // it from the author, and derives NOTHING when the owner is somebody
      // else. Guessing from the name here is exactly what this field exists
      // to avoid.
      assigneeKind: kind.assigneeKind,
      needs: needs.needs,
      options: options.options,
      // Forward undefined untouched: an omitted goal is what routes the task
      // through triage (an explicit 'chores' would skip it).
      goal: body.goal as string | undefined,
      order: typeof body.order === 'number' ? Number(body.order) : undefined,
      after: Array.isArray(body.after) ? (body.after as string[]) : undefined,
      afterEnforce: Array.isArray(body.afterEnforce) ? (body.afterEnforce as string[]) : undefined,
      dueAt: typeof body.dueAt === 'number' ? Number(body.dueAt) : undefined,
      links: links.links,
      origin: origin.origin,
      quote: body.quote as string | undefined,
      // Optional: a task can be created by a UI with no session yet. When it
      // IS supplied, the created row is attributed (§3.6) — "who put this
      // here" is the first question of every triage.
      ...(author !== undefined ? { actor: author } : {}),
    },
  };
}
