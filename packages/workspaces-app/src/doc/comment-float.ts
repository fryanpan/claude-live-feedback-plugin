import { floatDock } from '../float-dock.ts';

/**
 * "＋ Comment", pinned to the bottom of the editor pane.
 *
 * The doc had exactly one way to start a comment: select some text and hit
 * the pill that appears beside the selection. That is a fine gesture and a
 * poor affordance — it says nothing until you have already guessed it exists,
 * and on a doc with no comments yet there is nothing else on screen to
 * suggest commenting is what this surface is for.
 *
 * So the entry point becomes a control that is always where you can see it,
 * in the float dock the pane already pins (`float-dock.ts`), beside Make Plan
 * and Review when a huddle doc has them. The selection pill stays: it is
 * still the faster path once you have text selected, and this is the one you
 * can find without knowing it is there.
 *
 * No caption under it. The label and the ＋ say what it does, and the mock's
 * "Select any text to comment on it" hint was a sentence explaining a button
 * that is standing right there — the same note the owner has made about
 * explanatory text under controls.
 */
export interface CommentFloatOpts {
  /** The element the dock pins to — `#editor-pane` in practice. */
  anchor: Element;
  /** Start a comment on whatever the reader is looking at. */
  onComment: () => void;
  /** The caller's scoped listener, so the wiring dies with the mount. */
  listen: (target: EventTarget, type: string, fn: (ev: Event) => void) => void;
}

export function mountCommentFloat(opts: CommentFloatOpts): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'comment-float';
  // `plan-float` for the shape it shares with the other dock floats;
  // `comment-float` for its own, quieter face — this one is always present,
  // so it must not shout like a float that appears because something needs
  // doing.
  btn.className = 'plan-float comment-float';
  const label = document.createElement('span');
  label.className = 'plan-float-label';
  label.textContent = '＋ Comment';
  btn.append(label);
  // Mount order in the dock is mount order, and app.ts mounts plan, then
  // review, then this — so Comment sits at the end of the row rather than
  // between two controls that belong together.
  floatDock(opts.anchor).append(btn);
  // Focus would leave the prose, and the composer wants the selection the
  // reader has right now — the same reason the selection pill cancels its
  // own mousedown.
  opts.listen(btn, 'mousedown', (ev) => ev.preventDefault());
  opts.listen(btn, 'click', () => opts.onComment());
  return btn;
}
