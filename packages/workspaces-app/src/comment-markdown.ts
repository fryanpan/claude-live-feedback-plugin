/**
 * Render a comment's text as a SAFE, minimal markdown subset → HTML.
 *
 * Comments are untrusted input (anyone with the review URL can post), so the
 * rule is escape-first: every character is HTML-escaped before any markdown
 * transform runs, and transforms only ADD a fixed set of known-safe tags.
 * There is no raw-HTML passthrough, so a comment containing `<script>` is inert.
 *
 * Supported: **bold**, *italic* / _italic_, `code`, ~~strike~~,
 * [label](url) (http/https/mailto only), `-`/`*` bullet lists, `#` headings,
 * ``` / ~~~ fenced code (literal, escaped, no marks inside), and line breaks.
 *
 * Plus one convenience: a BARE workspace URL (a pasted board / task / doc /
 * mockup address — see `parseWorkspaceLink` in @feedback/core) becomes a link
 * whose text is the resource's title once `link-titles.ts` has resolved it,
 * and the raw URL until then — plus a STATUS CHIP when the target is a task
 * or goal. Display-only: the stored comment keeps the raw URL. An explicit
 * [label](url) keeps the author's text but a workspace target still earns the
 * chip (`data-ws-custom` is how hydration knows not to touch the words); and
 * non-workspace URLs stay plain text.
 */
import { parseWorkspaceLink } from '@feedback/core';
import {
  cachedLinkStatus,
  cachedLinkTitle,
  scheduleLinkTitleHydration,
  statusChipLabel,
} from './link-titles.ts';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === '&'
      ? '&amp;'
      : ch === '<'
        ? '&lt;'
        : ch === '>'
          ? '&gt;'
          : ch === '"'
            ? '&quot;'
            : '&#39;',
  );
}

function safeHref(url: string): string | null {
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
    const u = new URL(url, base);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:')
      return u.href;
  } catch {
    // not a parseable URL
  }
  return null;
}

/** Inline marks on an ALREADY-escaped string. Order matters: code first so
 *  its contents aren't re-marked, links last so labels can carry marks. */
function inline(escaped: string): string {
  let out = escaped;
  out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // single *italic* / _italic_ — the ** case is already consumed above.
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label: string, rawUrl: string) => {
    // The URL text was HTML-escaped; unescape &amp; for parsing, then re-escape.
    const url = rawUrl.replace(/&amp;/g, '&');
    const href = safeHref(url);
    if (!href) return m;
    const base = `href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"`;
    // A workspace target keeps the author's label but is still marked, so a
    // task/goal link can wear its status chip once hydration answers. Same
    // origin rule as the bare-URL pass — a foreign lookalike stays unmarked.
    if (!isSameOriginWorkspaceUrl(url) || !parseWorkspaceLink(url))
      return `<a ${base}>${label}</a>`;
    const status = cachedLinkStatus(url);
    if (status === undefined) scheduleLinkTitleHydration();
    const attrs =
      `${base} class="ws-link" data-ws-link="${escapeHtml(url)}" data-ws-custom=""` +
      `${status === undefined ? ' data-ws-pending=""' : ''}`;
    return `<a ${attrs}>${label}${status ? statusChipHtml(status) : ''}</a>`;
  });
  out = linkifyWorkspaceUrls(out);
  return out;
}

/**
 * A bare-URL candidate in ESCAPED text: an absolute http(s) URL, or a
 * root-relative path in one of the workspace shapes. Whitespace and parens
 * end a URL (raw `<>"'` cannot appear — they are entities by now).
 */
const BARE_URL = /(?:https?:\/\/[^\s()]+|(?<=^|[\s(])\/(?:workspaces|review|mockup)\/[^\s()]+)/g;

/**
 * Only a link to THIS page's own server may earn a trusted title. A foreign
 * origin whose path merely matches a workspace shape must stay raw text:
 * `https://attacker.example/review/<real-doc-id>` would otherwise render as
 * the real doc's title while navigating to the attacker — a trusted label on
 * a phishing href. Relative paths are same-origin by definition. The cost of
 * strictness is that a URL pasted under one advertised host (tailnet) and
 * read under another (localhost) stays raw — raw is the safe direction.
 */
function isSameOriginWorkspaceUrl(url: string): boolean {
  if (url.startsWith('/')) return true;
  if (typeof window === 'undefined') return false;
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** The chip a task/goal link wears, built for the escaped-HTML string path.
 *  The status is server data, not markup — escaped into both the class and
 *  the words. */
function statusChipHtml(status: string): string {
  return `<span class="ws-status-chip ws-chip-${escapeHtml(status)}">${escapeHtml(statusChipLabel(status))}</span>`;
}

/** Trailing characters that read as punctuation AFTER a pasted URL, entity
 *  spellings included — `see http://…/docs/x.` must not eat the period. */
function trimUrlTail(s: string): string {
  let out = s;
  for (;;) {
    const next = out.replace(/(?:&(?:lt|gt|quot|amp|#39);|[.,;:!?])$/, '');
    if (next === out) return out;
    out = next;
  }
}

/**
 * Turn bare workspace URLs in already-rendered inline HTML into title links.
 *
 * Runs AFTER the explicit-link pass, over a tag-split of the string: only
 * text outside every tag, outside `<a>` (an author-chosen label stays the
 * author's) and outside `<code>` (code is literal) is considered. The tags
 * present were all emitted by this module, so the split is over known-safe
 * markup, and the text segments are still escape-first.
 */
function linkifyWorkspaceUrls(html: string): string {
  if (!/https?:\/\/|\/(?:workspaces|review|mockup)\//.test(html)) return html;
  let anchorDepth = 0;
  let codeDepth = 0;
  let sawPending = false;
  const parts = html.split(/(<[^>]+>)/).map((seg) => {
    if (seg.startsWith('<')) {
      if (/^<a[\s>]/.test(seg)) anchorDepth++;
      else if (seg === '</a>') anchorDepth = Math.max(0, anchorDepth - 1);
      else if (/^<code[\s>]/.test(seg)) codeDepth++;
      else if (seg === '</code>') codeDepth = Math.max(0, codeDepth - 1);
      return seg;
    }
    if (anchorDepth > 0 || codeDepth > 0) return seg;
    return seg.replace(BARE_URL, (m) => {
      const trimmed = trimUrlTail(m);
      const tail = m.slice(trimmed.length);
      // The segment is escaped text; the URL itself needs `&` back to parse.
      const url = trimmed.replace(/&amp;/g, '&');
      if (!isSameOriginWorkspaceUrl(url) || !parseWorkspaceLink(url)) return m;
      const title = cachedLinkTitle(url);
      const status = cachedLinkStatus(url);
      if (title === undefined) sawPending = true;
      const attrs =
        `href="${escapeHtml(url)}" class="ws-link" data-ws-link="${escapeHtml(url)}"` +
        `${title === undefined ? ' data-ws-pending=""' : ''} target="_blank" rel="noopener noreferrer"`;
      // Title text via escapeHtml (server data is not markup); the raw-URL
      // fallback is `trimmed`, which is already escaped text.
      return `<a ${attrs}>${title ? escapeHtml(title) : trimmed}${status ? statusChipHtml(status) : ''}</a>${tail}`;
    });
  });
  if (sawPending) scheduleLinkTitleHydration();
  return parts.join('');
}

/**
 * The INLINE half alone — marks, code, links — with no block structure, for
 * text that lands inside somebody else's sentence (the answered record quotes
 * the answer's words inside “…”). Same escape-first rule as the block
 * renderer: the input is untrusted, and the output only ever ADDS the fixed
 * set of known-safe tags.
 */
export function renderCommentMarkdownInline(text: string): string {
  return inline(escapeHtml(absorbHardBreaks(text).replace(/\s+/g, ' ').trim()));
}

/**
 * Backslash-newline is markdown's own spelling of a hard line break, and it
 * is what tiptap-markdown's serializer emits — so stored comments carry it,
 * and rendered literally it reads as "line\" plus a lone "\" line. Absorb it
 * as the break it means: a plain newline, which this renderer already turns
 * into <br> (and a doubled one into a paragraph split).
 */
function absorbHardBreaks(text: string): string {
  return text.replace(/\\\r?\n/g, '\n');
}

/** A fence line: three backticks or tildes, an optional info string. The
 *  block's lines are literal — no prose rule runs on them — and escaped. */
const FENCE_LINE = /^\s{0,3}(```|~~~)/;

export function renderCommentMarkdown(text: string): string {
  const lines = absorbHardBreaks(text).replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let listOpen = false;
  let para: string[] = [];
  let fence: string[] | null = null;
  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      html.push('</ul>');
      listOpen = false;
    }
  };
  const closeFence = () => {
    if (fence) {
      html.push(`<pre class="cm-code"><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
      fence = null;
    }
  };
  for (const line of lines) {
    // Fenced code: a turn note is an end-of-turn message, and those carry
    // test output and diffs whose `#` and `-` lines are not headings and
    // bullets. An unterminated fence runs to the end.
    if (FENCE_LINE.test(line)) {
      if (fence) {
        closeFence();
      } else {
        flushPara();
        closeList();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    // ATX heading. Demoted by two so the body sits UNDER whatever card title
    // it was rendered into — a decision body's `## Question` is a section of
    // the card, never a peer of the card's own heading. A space after the
    // hashes is required, so `#4` stays an issue number.
    const head = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (head) {
      flushPara();
      closeList();
      const level = Math.min(6, (head[1] ?? '#').length + 2);
      html.push(`<h${level} class="cm-h">${inline(escapeHtml(head[2] ?? ''))}</h${level}>`);
    } else if (bullet) {
      flushPara();
      if (!listOpen) {
        html.push('<ul class="cm-list">');
        listOpen = true;
      }
      html.push(`<li>${inline(escapeHtml(bullet[1] ?? ''))}</li>`);
    } else if (line.trim() === '') {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(inline(escapeHtml(line)));
    }
  }
  closeFence();
  flushPara();
  closeList();
  return html.join('');
}
