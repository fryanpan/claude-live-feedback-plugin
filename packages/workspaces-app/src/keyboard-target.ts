/**
 * "Is this keystroke somebody else's?" — the guard every document-level
 * keyboard handler needs, written once.
 *
 * `ev.target` is RETARGETED at every shadow boundary: a keydown inside the
 * feedback widget's shadow root arrives at a `document` listener with `target`
 * set to the `<claude-feedback-widget>` HOST element. So `target.closest(
 * 'input, textarea')` matches nothing, and every global hotkey fires while the
 * user types. #116 put that widget on every hub, which turned two long-standing
 * latent bugs into daily ones: the board's j/k/o/s/a/? fired mid-sentence, and
 * a space typed into the feedback box started a voice recording.
 *
 * `composedPath()[0]` is the real inner target — the only view that sees
 * through the boundary. Callers pass the path, not the event, so this stays
 * testable without synthesizing events.
 */

/** Everything whose keystrokes belong to a text field, not to the page. */
const TEXT_ENTRY = 'input, textarea, select, [contenteditable]';

export function typingInPath(path: readonly (EventTarget | undefined)[]): boolean {
  const inner = path[0];
  if (!inner || typeof (inner as Element).closest !== 'function') return false;
  const el = inner as Element;
  // Anything that originated inside a shadow root belongs to some other
  // component. Our own DOM is entirely in the light document, so this can
  // never over-block us — and it covers embedded components we haven't
  // written yet without naming any of them.
  if (el.getRootNode() !== el.ownerDocument) return true;
  return el.closest(TEXT_ENTRY) !== null;
}

/** The path of an event, with a fallback for a synthesized event whose
 *  `composedPath()` is empty. An empty path must read as "not typing": the
 *  failure mode of over-blocking is a keyboard that does nothing. */
export function eventPath(ev: Event): readonly (EventTarget | undefined)[] {
  const path = ev.composedPath();
  if (path.length > 0) return path;
  const target = ev.target;
  return target ? [target] : [];
}
