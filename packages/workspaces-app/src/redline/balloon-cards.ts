/**
 * The balloon cards themselves: a suggestion and a deletion, each in its
 * expanded and collapsed face, plus the collapse affordance they share.
 *
 * These build DOM and nothing else. The only thing they cannot do alone is
 * act on a suggestion, so accepting and rejecting arrives as a callback and
 * the margin keeps the network call. Nothing here reads the editor view, the
 * balloon column, or the margin's own state — which is what lets the same
 * builder render a card into the phone's bottom sheet.
 */
import { formatTime, suggestOps } from '@feedback/core';
import type { DeletionGroup } from './live-markup.ts';

/** How much text is long enough to clamp. Text-based so the decision is
 *  testable without layout; the CSS line-clamp does the visual truncation. */
const CLAMP_LINES = 6;
const CLAMP_CHARS = 480;

/** Long enough to clamp? */
function needsClamp(md: string): boolean {
  return md.split('\n').length > CLAMP_LINES || md.length > CLAMP_CHARS;
}

/** `authorColor` round-trips through an inline `style` attribute (the same
 *  guard suggest-marks.ts applies to the live-doc marks) — only a literal
 *  hex color is allowed through so an arbitrary string can't smuggle extra
 *  CSS declarations into the card. */
function suggestColorStyle(color: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? `--cw-suggest-color: ${color}` : '';
}

export interface BalloonCardDeps {
  /** Accept or reject a suggestion. The margin owns the request; a card only
   *  says which button was pressed. */
  resolveSuggestion: (sid: string, action: 'accept' | 'reject') => Promise<void>;
}

export interface BalloonCards {
  buildSuggestionBalloon: (s: suggestOps.SuggestionSummary) => HTMLElement;
  buildCollapsedSuggestion: (s: suggestOps.SuggestionSummary) => HTMLElement;
  buildDelBalloon: (group: DeletionGroup) => HTMLElement;
  buildCollapsedDel: (group: DeletionGroup) => HTMLElement;
  addCollapseButton: (el: HTMLElement) => void;
}

export function createBalloonCards({ resolveSuggestion }: BalloonCardDeps): BalloonCards {
  function buildSuggestionBalloon(s: suggestOps.SuggestionSummary): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cw-balloon cw-balloon-suggestion';
    el.dataset.sid = s.sid;
    const style = suggestColorStyle(s.author.color);
    if (style) el.setAttribute('style', style);

    const header = document.createElement('div');
    header.className = 'cw-suggest-header';
    const swatch = document.createElement('span');
    swatch.className = 'cw-suggest-swatch';
    swatch.style.background = s.author.color;
    const authorEl = document.createElement('span');
    authorEl.className = 'cw-suggest-author';
    // Plain text, never HTML: an author name is untrusted (agent-supplied).
    authorEl.textContent = s.author.name;
    const ageEl = document.createElement('span');
    ageEl.className = 'cw-suggest-age';
    ageEl.textContent = formatTime(s.ts);
    header.append(swatch, authorEl, ageEl);
    el.appendChild(header);

    const preview = document.createElement('div');
    preview.className = 'cw-balloon-text cw-suggest-preview';
    // Old struck / new underlined — plain textContent on each span, never
    // innerHTML interpolation (both are untrusted doc/agent content).
    if (s.kind === 'delete' || s.kind === 'replace') {
      const oldEl = document.createElement('span');
      oldEl.className = 'cw-suggest-old';
      oldEl.textContent = s.deletedText;
      preview.appendChild(oldEl);
    }
    if (s.kind === 'insert' || s.kind === 'replace') {
      if (s.kind === 'replace') preview.appendChild(document.createTextNode(' → '));
      const newEl = document.createElement('span');
      newEl.className = 'cw-suggest-new';
      newEl.textContent = s.insertedText;
      preview.appendChild(newEl);
    }
    el.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'cw-suggest-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'cw-suggest-accept';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => void resolveSuggestion(s.sid, 'accept'));
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'cw-suggest-reject';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => void resolveSuggestion(s.sid, 'reject'));
    actions.append(acceptBtn, rejectBtn);
    el.appendChild(actions);
    return el;
  }

  /** Small "collapse back to one line" button, top-right of expanded cards. */
  function addCollapseButton(el: HTMLElement): void {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cw-balloon-collapse';
    b.setAttribute('aria-label', 'Collapse');
    b.title = 'Collapse';
    b.textContent = '−';
    el.appendChild(b);
  }

  /** Swatch + name prefix shared by every collapsed builder. */
  function collapsedIdentity(el: HTMLElement, name: string, color: string): void {
    const swatch = document.createElement('span');
    swatch.className = 'cw-collapsed-swatch';
    swatch.style.background = color;
    const nameEl = document.createElement('span');
    nameEl.className = 'cw-collapsed-name';
    // Plain text, never HTML: names are untrusted (agent-supplied).
    nameEl.textContent = name;
    el.append(swatch, nameEl);
  }

  function buildCollapsedSuggestion(s: suggestOps.SuggestionSummary): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cw-balloon cw-balloon-suggestion cw-balloon-collapsed';
    el.dataset.expandKey = `s:${s.sid}`;
    el.dataset.sid = s.sid;
    const style = suggestColorStyle(s.author.color);
    if (style) el.setAttribute('style', style);
    collapsedIdentity(el, s.author.name, s.author.color);
    const preview = document.createElement('span');
    preview.className = 'cw-collapsed-preview';
    // Same old-struck / new-underlined classes as the full card — plain
    // textContent on each span, never innerHTML (untrusted content).
    if (s.kind === 'delete' || s.kind === 'replace') {
      const oldEl = document.createElement('span');
      oldEl.className = 'cw-suggest-old';
      oldEl.textContent = s.deletedText;
      preview.appendChild(oldEl);
    }
    if (s.kind === 'insert' || s.kind === 'replace') {
      if (s.kind === 'replace') preview.appendChild(document.createTextNode(' → '));
      const newEl = document.createElement('span');
      newEl.className = 'cw-suggest-new';
      newEl.textContent = s.insertedText;
      preview.appendChild(newEl);
    }
    el.appendChild(preview);
    // Accept/Reject stay one click away without expanding — the compact ✓/✕
    // wire to the SAME resolveSuggestion the full card uses.
    const actions = document.createElement('span');
    actions.className = 'cw-collapsed-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'cw-suggest-accept';
    acceptBtn.textContent = '✓';
    acceptBtn.setAttribute('aria-label', 'Accept suggestion');
    acceptBtn.title = 'Accept';
    acceptBtn.addEventListener('click', () => void resolveSuggestion(s.sid, 'accept'));
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'cw-suggest-reject';
    rejectBtn.textContent = '✕';
    rejectBtn.setAttribute('aria-label', 'Reject suggestion');
    rejectBtn.title = 'Reject';
    rejectBtn.addEventListener('click', () => void resolveSuggestion(s.sid, 'reject'));
    actions.append(acceptBtn, rejectBtn);
    el.appendChild(actions);
    return el;
  }

  function buildCollapsedDel(group: DeletionGroup): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cw-balloon cw-balloon-del cw-balloon-collapsed';
    el.dataset.expandKey = `d:${group.blockKey}`;
    const label = document.createElement('span');
    label.className = 'cw-balloon-label';
    label.textContent = 'Deleted';
    const preview = document.createElement('span');
    preview.className = 'cw-collapsed-preview';
    // First non-empty line only; plain text (untrusted doc content). A
    // multi-line deletion (a whole table, a section) shows how much more is
    // behind the click — without it, a clamped first row reads as though
    // only that fragment was deleted.
    const lines = group.deletedMarkdown.split('\n').filter((l) => l.trim() !== '');
    preview.textContent = lines[0] ?? '';
    el.append(label, preview);
    if (lines.length > 1) {
      const count = document.createElement('span');
      count.className = 'cw-collapsed-count';
      count.textContent = `+${lines.length - 1}`;
      count.title = `${lines.length - 1} more line${lines.length === 2 ? '' : 's'}`;
      el.appendChild(count);
    }
    return el;
  }

  function buildDelBalloon(group: DeletionGroup): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cw-balloon cw-balloon-del';
    const label = document.createElement('div');
    label.className = 'cw-balloon-label';
    label.textContent = 'Deleted';
    el.appendChild(label);
    const text = document.createElement('div');
    text.className = 'cw-balloon-text';
    // Plain text, never HTML: deleted markdown is untrusted doc content.
    text.textContent = group.deletedMarkdown;
    el.appendChild(text);
    if (needsClamp(group.deletedMarkdown)) {
      text.classList.add('is-clamped');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'cw-balloon-expand';
      toggle.textContent = 'Show more';
      el.appendChild(toggle);
    }
    return el;
  }
  return {
    buildSuggestionBalloon,
    buildCollapsedSuggestion,
    buildDelBalloon,
    buildCollapsedDel,
    addCollapseButton,
  };
}
