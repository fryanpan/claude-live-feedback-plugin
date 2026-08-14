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
 * and line breaks.
 */

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
    const href = safeHref(rawUrl.replace(/&amp;/g, '&'));
    return href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : m;
  });
  return out;
}

export function renderCommentMarkdown(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let listOpen = false;
  let para: string[] = [];
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
  for (const line of lines) {
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
  flushPara();
  closeList();
  return html.join('');
}
