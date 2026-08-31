/**
 * "Pull in last week's notes" — resolving material a meeting asked for.
 *
 * The capture pass hears the ask (see `meeting-task-capture.ts`); this module
 * decides WHAT it points at. Two ways in, in this order:
 *
 * 1. **By title.** The board's docs — huddles included, because a huddle IS a
 *    doc — and its task rows, through the same fuzzy matcher voice navigation
 *    uses (`resolveByTitle`). One matcher, one set of tuned thresholds.
 * 2. **By when.** "Last week", "yesterday", "Tuesday", "the last meeting" —
 *    a phrase that names no title at all, resolved against the docs that
 *    actually carry a past meeting, newest inside the window.
 *
 * WHY RECENCY IS ITS OWN PATH RATHER THAN MORE WORDS IN THE QUERY. A past
 * meeting has no title of its own: a `MeetingRecord` carries times, not a
 * subject, and the human-readable name of one is the DOC it was held on. So
 * "last week's notes" has nothing to fuzzy-match against — "notes" matches
 * every doc on the board and "week" is a stopword. Time is the only thing
 * spoken that identifies it, so time is what this resolves on.
 *
 * NOTHING IS A GUESS. An ambiguous title match resolves to no link rather
 * than to the better-scoring of two, and a recency window with no meeting in
 * it returns nothing. A wrong link is worse than no link — the same law the
 * capture guards are written to, for the same reason: a link in the notes
 * puts the board's authority behind a connection nobody made.
 */

import { type TitleCandidate, resolveByTitle } from './voice-resolve.ts';

/** A doc the lookup may resolve to, as its board describes it. */
export interface LookupDoc {
  docId: string;
  title: string;
  /**
   * When this doc last carried a meeting, if it ever has. Its presence is
   * what makes the doc reachable by a recency phrase — a doc nobody has ever
   * talked over is not "last week's meeting" however old it is.
   */
  meetingAt?: number;
}

/** A board row the lookup may fall back to, as the capture pass sees it. */
export interface LookupTask {
  id: string;
  title: string;
}

export type LookupHit =
  | { kind: 'doc'; docId: string; title: string; via: 'title' | 'recency'; meetingAt?: number }
  | { kind: 'task'; taskId: string; title: string; via: 'title' };

/** The window a spoken "when" names, and the words to say it back in. */
export interface RecencyWindow {
  from: number;
  to: number;
  /** How the notes may refer to it — the speaker's own frame, not a date. */
  label: string;
}

const DAY_MS = 86_400_000;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/** Midnight at the start of the local day `ts` falls in. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Midnight at the start of the local week (Monday) `ts` falls in. */
function startOfWeek(ts: number): number {
  const day = startOfDay(ts);
  // getDay(): 0 = Sunday. Monday-based, so Sunday is six days into its week.
  const dow = (new Date(day).getDay() + 6) % 7;
  return day - dow * DAY_MS;
}

function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The "when" in a spoken ask, if it has one.
 *
 * ORDER IS THE WHOLE IMPLEMENTATION. "Last week" has to be read before
 * "week", and "yesterday" before "day", or a longer phrase loses to a
 * fragment of itself. Everything here is a whole-word match so "todays" and
 * "sunday" cannot be found inside another word.
 *
 * Weekday names resolve to the most recent occurrence AT OR BEFORE today, so
 * "what we said Tuesday", spoken on a Tuesday, is this morning's meeting
 * rather than one seven days back. Nothing here reaches into the future: a
 * meeting that has not happened has no notes to pull in.
 */
export function parseRecency(query: string, now: number): RecencyWindow | null {
  const q = query.toLowerCase();
  const has = (re: RegExp): boolean => re.test(q);

  // "The last one" — an open window whose answer is simply the newest
  // meeting. Named first because "the last meeting" also contains no date.
  if (has(/\b(?:last|previous|other|earlier)\s+(?:meeting|huddle|call|session|time|day)\b/)) {
    return { from: 0, to: now, label: 'the last meeting' };
  }
  if (has(/\blast time\b/)) return { from: 0, to: now, label: 'the last meeting' };

  if (has(/\blast week\b/)) {
    const thisWeek = startOfWeek(now);
    return { from: thisWeek - 7 * DAY_MS, to: thisWeek, label: 'last week' };
  }
  if (has(/\bthis week\b/)) return { from: startOfWeek(now), to: now, label: 'this week' };
  if (has(/\blast month\b/)) {
    const thisMonth = startOfMonth(now);
    return { from: startOfMonth(thisMonth - DAY_MS), to: thisMonth, label: 'last month' };
  }
  if (has(/\byesterday\b/)) {
    const today = startOfDay(now);
    return { from: today - DAY_MS, to: today, label: 'yesterday' };
  }
  if (has(/\bthis (?:morning|afternoon|evening)\b/) || has(/\btoday\b/)) {
    return { from: startOfDay(now), to: now, label: 'today' };
  }

  for (let i = 0; i < WEEKDAYS.length; i++) {
    const name = WEEKDAYS[i];
    if (name === undefined || !has(new RegExp(`\\b${name}\\b`))) continue;
    const today = startOfDay(now);
    const back = (new Date(today).getDay() - i + 7) % 7;
    const day = today - back * DAY_MS;
    return { from: day, to: day + DAY_MS, label: name[0]?.toUpperCase() + name.slice(1) };
  }
  return null;
}

/**
 * What a lookup ask points at, or nothing.
 *
 * Titles first, across docs AND rows in one pool, so the matcher's own
 * "the DOC about x" / "the TICKET about x" kind word can narrow it — that is
 * `spokenKind`, and it only works when both kinds are in the pool it sees.
 *
 * An AMBIGUOUS title match falls through to the recency path rather than
 * failing outright: two docs whose titles score alike are exactly the case a
 * spoken "last week" was there to separate, and the fall-through is the only
 * thing that lets it.
 */
export function resolveLookup(
  query: string,
  pool: { docs: readonly LookupDoc[]; tasks: readonly LookupTask[] },
  now: number,
): LookupHit | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const candidates: TitleCandidate[] = [
    ...pool.docs.map((d) => ({ id: d.docId, kind: 'doc' as const, title: d.title })),
    ...pool.tasks.map((t) => ({ id: t.id, kind: 'task' as const, title: t.title })),
  ];
  if (candidates.length > 0) {
    const res = resolveByTitle(trimmed, candidates);
    if (res.kind === 'hit') {
      const { id, kind, title } = res.match;
      if (kind === 'doc') {
        const doc = pool.docs.find((d) => d.docId === id);
        return {
          kind: 'doc',
          docId: id,
          title,
          via: 'title',
          ...(doc?.meetingAt !== undefined ? { meetingAt: doc.meetingAt } : {}),
        };
      }
      if (kind === 'task') return { kind: 'task', taskId: id, title, via: 'title' };
    }
  }

  const when = parseRecency(trimmed, now);
  if (!when) return null;
  let best: LookupDoc | undefined;
  for (const doc of pool.docs) {
    if (doc.meetingAt === undefined) continue;
    if (doc.meetingAt < when.from || doc.meetingAt >= when.to) continue;
    if (!best || doc.meetingAt > (best.meetingAt ?? 0)) best = doc;
  }
  if (!best) return null;
  return {
    kind: 'doc',
    docId: best.docId,
    title: best.title,
    via: 'recency',
    ...(best.meetingAt !== undefined ? { meetingAt: best.meetingAt } : {}),
  };
}

/**
 * The board deep link `parseWorkspaceLink` reads back as `kind: 'doc'` —
 * root-relative, the same shape and for the same reason as `taskCaptureUrl`:
 * it survives being read under any host the server has.
 */
export function docLookupUrl(workspaceId: string, docId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}`;
}

/**
 * How the notes may say WHEN a linked meeting was — the speaker's own frame
 * when they gave one ("last week"), and a plain date when the doc was found
 * by name instead. A doc that never carried a meeting says nothing: it is a
 * document, and dating it would invent a meeting.
 */
export function lookupWhen(hit: LookupHit, spoken: RecencyWindow | null): string | undefined {
  if (hit.kind !== 'doc' || hit.meetingAt === undefined) return undefined;
  if (hit.via === 'recency' && spoken) return spoken.label;
  const d = new Date(hit.meetingAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
