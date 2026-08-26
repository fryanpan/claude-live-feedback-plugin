/**
 * The parts both detail panels are made of.
 *
 * These moved out of `task-detail-island.tsx` when the GOAL panel became an
 * island too. A goal's panel is not a smaller task panel — no tabs, no review
 * queue, no transitions — but the three pieces below are the same problem in
 * both, and they are the pieces where getting it wrong loses somebody's words:
 *
 *   - `useFill`, for content that holds no state and is cheapest rebuilt;
 *   - the composer, which must stay imperative because
 *     `attachMarkdownComposer` re-parents the textarea Preact thinks it owns;
 *   - `Discussion`, which is one stream and one box in both panels.
 *
 * `Discussion` takes a ROW ID rather than a task. A goal's comments live in
 * `task:<goalId>` and travel the same route, so the only thing the component
 * ever needed off the task was its id — the draft's identity and the post's
 * destination. Taking the id makes that literal instead of implied.
 */
import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { attachMarkdownComposer } from '../md-composer.ts';
import {
  type TaskDiscussion,
  commentRow,
  composerTarget,
  flattenComments,
  requireText,
} from './hub-render.ts';

/**
 * Fill a Preact-owned element with nodes some imperative builder made, on
 * every render.
 *
 * Only ever used on elements whose vnode has NO children, so Preact has
 * nothing of its own in there to lose — and only for content that holds no
 * state of its own (comment rows, history rows, the fields row's controls).
 * Anything a reader can be mid-way through — a composer, the live description
 * editor, an open `<details>` — is kept by node identity instead, which is the
 * whole point of the island.
 */
export function useFill(ref: RefObject<HTMLElement>, build: () => Node[]): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren(...build());
  });
}

// ── The composers, which stay imperative on purpose ────────────────────────

export interface ComposerSpec {
  placeholder: string;
  submitLabel: string;
  submitClass: string;
  rows: number;
  /** What to say beside the button when the box is empty. A disabled button
   *  would be the tidier affordance and it is the wrong one: nothing fires an
   *  `input` event for a value set programmatically, so a button driven by
   *  typing would sit disabled over a full box. */
  emptyMessage: string;
  /** The box's identity, stamped on the control. Nothing snapshots it any
   *  more — the node survives — but it is still what says which item's answer
   *  this box holds, which is what a test reads and what a person debugging
   *  two boxes on one card needs. */
  keepKey: string;
  onSubmit: (text: string) => Promise<boolean> | undefined;
  /** Which resolutions mean the write was REFUSED and the words go back in the
   *  box. The two callers disagree on purpose: an answer handler that returns
   *  nothing has said nothing about success, while the comment route always
   *  reports a boolean and a falsy one is a failure. */
  refused: (ok: unknown) => boolean;
  /** Told when a write is in flight, so the card can grey its option buttons
   *  alongside the box. */
  onBusy?: (busy: boolean) => void;
}

/**
 * Fill a Preact-owned `<form>` with an optional hint, a textarea and a submit,
 * and return the teardown.
 *
 * Built imperatively rather than as JSX, and that is load-bearing:
 * `attachMarkdownComposer` REPLACES the textarea with a wrapper and re-parents
 * it, so Preact would find its own child somewhere it did not put it and move
 * it back out of the editor on the next diff — silently turning the composer
 * into a bare textarea.
 *
 * The submit is locked while the write is in flight, because the answer does
 * not come back through the POST: between the tap and the panel changing there
 * is a window in which nothing on screen has moved and the button still works,
 * and every extra tap in it is another recorded answer.
 */
function fillComposerForm(form: HTMLFormElement, latest: () => ComposerSpec): () => void {
  const spec = latest();
  const ta = document.createElement('textarea');
  ta.placeholder = spec.placeholder;
  ta.rows = spec.rows;
  ta.dataset.keep = spec.keepKey;
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = spec.submitClass;
  submit.textContent = spec.submitLabel;
  form.append(ta, submit);
  const refreshComposer = attachMarkdownComposer(ta);
  // A flag, not just the disabled attributes: disabling the CONTROLS stops a
  // second tap, and a form can still be submitted around them (Enter in the
  // field, a programmatic submit). The guard has to be on the handler.
  let busy = false;
  const onSubmit = (ev: Event): void => {
    ev.preventDefault();
    const cur = latest();
    const text = ta.value.trim();
    if (!text) {
      // Not a silent no-op. An empty submit used to do literally nothing —
      // enabled button, no message — which reads as a broken control rather
      // than as a refusal.
      requireText(ta, submit, cur.emptyMessage);
      return;
    }
    if (busy) return;
    busy = true;
    ta.disabled = true;
    submit.disabled = true;
    cur.onBusy?.(true);
    // Cleared HERE rather than on the acknowledgement: posting repaints the
    // panel from inside its own await, and a clear that ran afterwards would
    // land while the reader had already started the next sentence. Put back
    // verbatim if the write is refused — but never over something typed
    // since, which is why the guard is about what is IN the box rather than
    // about which node it is. Under the island this box KEEPS ITS NODE across
    // a repaint, so "the live box" and "this box" are the same element.
    ta.value = '';
    refreshComposer();
    const putBack = (): void => {
      if (ta.value.trim() !== '') return;
      ta.value = text;
      refreshComposer();
    };
    void Promise.resolve(cur.onSubmit(text))
      .then((ok) => {
        if (cur.refused(ok)) putBack();
      })
      .catch(() => {
        putBack();
      })
      .finally(() => {
        busy = false;
        ta.disabled = false;
        submit.disabled = false;
        latest().onBusy?.(false);
      });
  };
  form.addEventListener('submit', onSubmit);
  return () => {
    form.removeEventListener('submit', onSubmit);
    form.replaceChildren();
  };
}

/**
 * The form shell Preact owns, with imperative innards.
 *
 * `keepKey` is the IDENTITY of the box: change it and the box is rebuilt,
 * which is what stops a draft following the reader onto another item. Nothing
 * else is a dependency — a repaint that changed only the clock must not
 * rebuild the box somebody is typing in, which is the whole defect this island
 * exists to remove.
 */
export function ComposerForm(props: ComposerSpec & { className: string; hint?: string }) {
  const form = useRef<HTMLFormElement | null>(null);
  const hintEl = useRef<HTMLParagraphElement | null>(null);
  // Everything the builder needs is read through a ref at SUBMIT time, so that
  // none of it can become a reason to rebuild. `onSubmit` in particular closes
  // over the item this paint drew, and the box outlives the paint.
  const latest = useRef(props);
  latest.current = props;
  const keepKey = props.keepKey;
  useLayoutEffect(() => {
    const node = form.current;
    if (!node) return;
    return fillComposerForm(node, () => latest.current);
  }, [keepKey]);
  // The hint is the one part of the form that can change under an unchanged
  // box — a decision that gains an option gains the word "Or" — so it is
  // written on every render rather than at build time.
  useLayoutEffect(() => {
    if (hintEl.current && props.hint !== undefined) hintEl.current.textContent = props.hint;
  });
  return (
    <form ref={form} class={props.className}>
      {props.hint !== undefined && <p ref={hintEl} class="hub-decide-form-hint" />}
    </form>
  );
}

/** The task's Discussion: ONE chronological sequence of comments, and ONE
 *  composer at the bottom. The rows hold no state, so they are rebuilt on
 *  every paint into an `<ol>` Preact owns and never reaches into; the
 *  composer beneath them keeps its node, which is what keeps the draft. */
export function Discussion(props: {
  /** The row the comments belong to — a task id or a goal id. */
  rowId: string;
  discussion: TaskDiscussion;
  /** Resolves to whether the comment LANDED; anything short of a `true` puts
   *  the words back in the box. */
  onComment?: (text: string, threadId?: string) => Promise<boolean> | undefined;
  /** Which comment the review queue sent the reader here to read. */
  focusThreadId?: string;
  now: number;
}) {
  const { rowId, discussion, onComment, focusThreadId, now } = props;
  const streamRef = useRef<HTMLOListElement | null>(null);
  const rows = flattenComments(discussion.threads);
  useFill(streamRef as RefObject<HTMLElement>, () =>
    rows.map((row) => commentRow(row, focusThreadId, now)),
  );
  // One box, one verb, no target row above it. The destination is DERIVED
  // rather than picked, and the reader is not told about it — being told about
  // it is the threading UI that was asked to be removed.
  const target = composerTarget(discussion.threads, focusThreadId);
  return (
    <section class="hub-discussion">
      {discussion.loading && <p class="hub-discussion-loading">Loading the discussion…</p>}
      {!discussion.loading && discussion.threads.length === 0 && (
        <p class="hub-discussion-empty">No comments yet.</p>
      )}
      {rows.length > 0 && <ol ref={streamRef} class="hub-comment-stream" />}
      <ComposerForm
        className="hub-comment-form"
        placeholder="Add a comment…"
        submitLabel="Comment"
        submitClass="hub-btn"
        rows={2}
        emptyMessage="Write something first"
        // Keyed by row: a draft survives every repaint of this panel and never
        // follows the reader onto a different task.
        keepKey={`discussion:${rowId}`}
        onSubmit={(text) => onComment?.(text, target?.id)}
        // The comment route always reports a boolean, and a comment lost to a
        // dropped connection is worse than one that never sent — so anything
        // short of a `true` keeps the words.
        refused={(ok) => !ok}
      />
    </section>
  );
}
