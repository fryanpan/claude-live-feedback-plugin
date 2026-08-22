/**
 * Tiny presentation helpers shared by BOTH front-ends (markdown-app SPA and
 * the injectable widget). Keep this file dependency-free and DOM-free — the
 * widget's bundle-size constraint rides on it.
 */

/** Relative timestamp for comment rows: just now / 12m / 3h / 2d / Mar 4. */
export function formatTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Escape text for interpolation into an HTML string. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Undo an HTML escape a CALLER baked into a plain-text label.
 *
 * Titles are caller-supplied at bind/create time, and some callers hand over
 * strings they already HTML-escaped ("LF Workspace &amp; Tasks"). Every surface
 * that shows a title renders it via `textContent`, which is correct — so the
 * baked entity survives to the screen as literal text. Decoding at each
 * projection door fixes every row at once, including rows whose bad title is
 * already stored, instead of chasing every writer.
 *
 * ONE pass by construction: `replace` scans left to right and never re-reads
 * its own output, so `&amp;amp;` becomes the literal `&amp;` and stops — a
 * caller's double-escape is shown, not silently collapsed. A bare `&`, or an
 * unknown entity name, passes through untouched.
 *
 * LABELS ONLY. Prose — a comment, an ask — is the author's content, and a
 * literal `&amp;` inside a code span there is what they meant to write.
 */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * A color that is safe to interpolate into a quoted HTML `style="…"`.
 *
 * Author colors ride along with comments, and they are only constrained for
 * SHARE VISITORS (share/visitor-identity.ts pins those to `#rrggbb`). A
 * comment posted from the local surface — by an agent, or by anything else
 * that can reach the API — carries whatever string the caller sent. The
 * widget renders OTHER people's colors, so an unvalidated one there is an
 * attribute break rather than a bad swatch: a `"` ends the attribute and the
 * rest of the value becomes markup.
 *
 * Same shape as the SPA's `suggestColorStyle` check. The SPA otherwise
 * assigns colors via `element.style.background`, where the CSS parser simply
 * drops anything invalid — only string-built markup needs this.
 */
export function cssColor(color: string | undefined | null, fallback = '#888888'): string {
  return color && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : fallback;
}

/**
 * The one thread-status palette. The widget interpolates these into its
 * shadow-DOM styles; the SPA mirrors them as CSS custom properties in
 * styles.css (--green / --yellow / --orange) — change them together.
 */
export const STATUS_COLORS = {
  open: '#e36f1e',
  resolved: '#2da44e',
  orphan: '#bf8700',
} as const;
