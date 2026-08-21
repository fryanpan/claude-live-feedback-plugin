/**
 * Every composer is a markdown editor (approved design, review-flow-mock-v1,
 * design point 4). Recorded answers and comments RENDER markdown, so the box
 * they are typed into must say it speaks markdown and show what the words
 * will become — one function behind every composer, so the walkthrough's
 * answer box, the Tell me more ask, the task discussion, the panel's review
 * card and the doc thread's reply cannot drift apart.
 *
 * The anatomy is deliberately small: a quiet affordance row (a "Markdown"
 * badge and a monospace cheat sheet) and a preview that fills in BELOW as
 * you type. The preview is hidden while the box is empty, so an untouched
 * composer stays one control tall — the iPad's scarce axis is height, and
 * most composers on any screen are never typed into (the mock's answer to
 * its own open question 5).
 */

import { renderCommentMarkdown } from './comment-markdown.ts';

/**
 * Decorate a composer's textarea with the markdown affordance and a live
 * preview. The textarea is wrapped in a `.md-field` column (so the row
 * composers — field and Send side by side — keep their shape while the
 * preview stretches under the box, never beside it), and stays in its form:
 * attaching decorates, it never moves the control the caller wired up.
 *
 * Returns a refresh function for the one path `input` cannot see: a send
 * that empties the box programmatically (`ta.value = ''`) fires no event, so
 * the sender calls this right after — same for a restore that puts refused
 * words back.
 *
 * IDEMPOTENT, because not every composer is built fresh for its caller: the
 * doc's new-comment box is shell DOM that outlives each document, while
 * `mountReviewChrome` runs once per navigation. A second attach would wrap
 * the wrapper — a second affordance row and a second preview under one box,
 * with the live listener on the outer copy. Re-attaching returns a refresh
 * for the field that is already there.
 */
export function attachMarkdownField(ta: HTMLTextAreaElement): () => void {
  const already = ta.parentElement;
  if (already?.classList.contains('md-field')) {
    return makeRefresh(ta, already.querySelector<HTMLElement>('.md-preview'));
  }
  const field = document.createElement('div');
  field.className = 'md-field';

  const affordance = document.createElement('div');
  affordance.className = 'md-affordance';
  const badge = document.createElement('span');
  badge.className = 'md-badge';
  badge.textContent = 'Markdown';
  const hint = document.createElement('span');
  hint.className = 'md-hint';
  hint.textContent = '**bold** · *italic* · `code` · [link](url) · - list';
  affordance.append(badge, hint);

  const preview = document.createElement('div');
  preview.className = 'md-preview';
  preview.hidden = true;

  // Take the textarea's place in the form, then adopt it — the field is the
  // flex child now, the textarea just fills it.
  ta.replaceWith(field);
  field.append(ta, affordance, preview);

  const refresh = makeRefresh(ta, preview);
  ta.addEventListener('input', refresh);
  return refresh;
}

/** Fill the preview in from the box, or empty it. Shared by the attach path
 *  and the re-attach path so both spell "hidden while empty" once. */
function makeRefresh(ta: HTMLTextAreaElement, preview: HTMLElement | null): () => void {
  return () => {
    if (!preview) return;
    if (ta.value.trim() === '') {
      preview.hidden = true;
      preview.innerHTML = '';
      return;
    }
    preview.hidden = false;
    // The words are untrusted (anyone with the URL can type them);
    // `renderCommentMarkdown` escapes first and only re-adds known-safe tags.
    preview.innerHTML = renderCommentMarkdown(ta.value);
  };
}
