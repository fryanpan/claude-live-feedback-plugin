/**
 * The rules a task spun off a line of talk is filed under — shared by the
 * pointer pill (markdown-app `spinoff-menu.ts`, a tap on a selection) and
 * the meeting assistant's capture pass (server `meeting-task-capture.ts`, a
 * request heard in the transcript).
 *
 * They live in core because the two are ONE path with two triggers. A row
 * the assistant files from speech must land in the same column, carrying
 * the same body, as the row the same words would have made under a finger —
 * otherwise "it lands on the board as a real row" means something different
 * depending on who noticed the ask. The first version had the capture pass
 * hand-build its own create options and the pill post its own body; the two
 * drifted (different bodies, a different readiness rule), and a spoken task
 * that "did nothing" turned out to be a capture path with its own set of
 * gates.
 */

/**
 * Whether a row's own words are enough to pick it up — To do if so, Triage
 * if not.
 *
 * A person's create normally lands in To do, and that is right when the
 * person WROTE the row. A spin-off is not written, it is selected — or
 * heard: the words are a fragment of somebody's sentence, and a reviewer's
 * pass filed rows called "Cloudflare" and "Access" this way. Nobody can act
 * on those, and a row nobody can act on sitting in To do is worse than the
 * same row in Triage, because To do is the list people work from.
 *
 * Three words is the line, and it is deliberately crude: it separates a
 * noun somebody happened to double-click from a phrase with something to do
 * in it, which is the whole distinction being drawn. The cost of getting it
 * wrong is one drag between two columns, in either direction.
 */
export function readyToWork(title: string): boolean {
  return title.trim().split(/\s+/).filter(Boolean).length >= 3;
}

/**
 * The body every spun-off row carries: where it came from, in words, since
 * the `origin` ref is machine-readable and a person reading the ticket a
 * week later is not. `heard` switches the first line from "a line of the
 * discussion" (a selection) to "heard in the meeting" (the transcript).
 */
export function spinoffBody(
  quote: string,
  docTitle: string | undefined,
  opts: { heard?: boolean; extra?: readonly string[] } = {},
): string {
  const where = docTitle ? ` "${docTitle}"` : '';
  const lead = opts.heard
    ? `Heard in the meeting${where} by the meeting assistant — the doc's transcript is the source record.`
    : `Spun off from a line of the discussion${where}.`;
  const extra = (opts.extra ?? []).filter((line) => line.trim().length > 0);
  const head = extra.length > 0 ? `${lead} ${extra.join(' ')}` : lead;
  const said = quote.trim().replace(/\s+/g, ' ');
  return said ? `${head}\n\n> ${said}` : head;
}
