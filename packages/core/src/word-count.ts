/**
 * Words as a reader counts them: whitespace-separated tokens, runs collapsed,
 * and an empty or blank string is zero words rather than one.
 *
 * The one counter every word budget on either side reads — comment sizes on
 * the activity feed, the goal summary clip, the meeting summary budget, the
 * review-item length gaps, the long-thread modal threshold. Five copies of
 * this function existed before it; a budget measured by one and enforced by
 * another is how a limit gets to be off by one word.
 */
export function wordCount(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}
