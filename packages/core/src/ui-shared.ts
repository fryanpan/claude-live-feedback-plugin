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
