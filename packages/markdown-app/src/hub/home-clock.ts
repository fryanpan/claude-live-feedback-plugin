/**
 * Home's minute clock. Everything time-shaped on the Home page — a note
 * line's "4m", the `dark` flag on a task nobody has touched for 45 minutes —
 * is computed from `now` at paint time, and Home only repainted on a board
 * event. On a quiet board the ages froze and a task went dark without the
 * badge ever appearing. This ticks the repaint once a minute, only while
 * Home is the pane showing, and is stopped by the same beforeunload that
 * clears the presence tick (hub-app.ts).
 *
 * A minute, because the ages are minute-grained: a faster clock would repaint
 * to show the same string. Not a board wake — nothing is fetched; the pane
 * re-derives from the projection it already holds.
 */
export const HOME_CLOCK_MS = 60_000;

export function startHomeClock(
  showing: () => boolean,
  repaint: () => void,
  intervalMs: number = HOME_CLOCK_MS,
): () => void {
  const tick = setInterval(() => {
    if (showing()) repaint();
  }, intervalMs);
  return () => clearInterval(tick);
}
