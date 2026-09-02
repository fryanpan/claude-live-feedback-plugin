/**
 * Which comments this reader has already looked at, per doc.
 *
 * A comment that arrived since the reader last viewed gets a red dot — on its
 * glyph, on its highlight, and on the off-screen hint in its direction — and
 * the dot clears once the comment has sat in the viewport for a moment. That
 * needs a memory of what was seen, and it lives in `localStorage`: per
 * browser, which is the right scope, because "have I seen this" is a fact
 * about this reader on this device and nothing the doc should sync.
 *
 * The record is a map of thread id → the `lastActivity` that was on screen
 * when it was seen. A thread is new when the reader has been here before and
 * the record has no entry for it, or an older one — a reply landing on a
 * thread already seen makes it new again. The FIRST visit to a doc marks
 * nothing: everything is unseen then, and a page of red dots on arrival says
 * nothing a reader can act on. A thread that arrives live during that first
 * visit is still new, though — it is the one thing that changed while they
 * were looking.
 *
 * Every storage call is wrapped: private mode, cleared site data and the
 * thumbnail renderer all throw on the accessor, and the page has to render
 * exactly right with no memory at all.
 */

export interface SeenRecord {
  /** Thread id → `lastActivity` seen. */
  threads: Record<string, number>;
}

/** The subset of `Storage` this module touches — so tests can hand in a Map. */
export interface SeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SeenTracker {
  /** Has anything on this thread arrived since the reader last saw it? */
  isNew(t: { id: string; lastActivity: number }): boolean;
  /** Record the thread as seen at its current activity. Returns true when
   *  that changed its `isNew` answer, so callers know a repaint is due. */
  markSeen(t: { id: string; lastActivity: number }): boolean;
}

export function seenStorageKey(docId: string): string {
  return `lf:seen:${docId}`;
}

/**
 * The pure rule. `firstVisit` is whether this reader had ever been here when
 * the view started — it holds for the WHOLE view, so seeing one thread on a
 * first visit does not turn every other one red. `mountedAt` is when this
 * view started, so a thread born during a first visit still counts as new.
 */
export function isNewThread(
  record: SeenRecord,
  t: { id: string; lastActivity: number },
  view: { firstVisit: boolean; mountedAt: number },
): boolean {
  const seenAt = record.threads[t.id];
  if (seenAt !== undefined) return t.lastActivity > seenAt;
  return !view.firstVisit || t.lastActivity > view.mountedAt;
}

function readRecord(storage: SeenStorage | undefined, key: string): SeenRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const threads = (parsed as { threads?: unknown }).threads;
    if (!threads || typeof threads !== 'object') return null;
    const out: Record<string, number> = {};
    for (const [id, ts] of Object.entries(threads as Record<string, unknown>)) {
      if (typeof ts === 'number') out[id] = ts;
    }
    return { threads: out };
  } catch {
    return null;
  }
}

function writeRecord(storage: SeenStorage | undefined, key: string, record: SeenRecord): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(record));
  } catch {
    // Storage disabled or full — the in-memory record still drives this view.
  }
}

function defaultStorage(): SeenStorage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function createSeenTracker(opts: {
  docId: string;
  storage?: SeenStorage;
  now?: () => number;
}): SeenTracker {
  const storage = opts.storage ?? defaultStorage();
  const now = opts.now ?? Date.now;
  const key = seenStorageKey(opts.docId);
  const mountedAt = now();
  const loaded = readRecord(storage, key);
  const view = { firstVisit: loaded === null, mountedAt };
  const record: SeenRecord = loaded ?? { threads: {} };

  return {
    isNew(t) {
      const fresh = isNewThread(record, t, view);
      // A first visit shows no dots — but it has to WRITE what it saw, or
      // the next visit is a first visit too and nothing is ever new.
      if (view.firstVisit && !fresh && record.threads[t.id] === undefined) {
        record.threads[t.id] = t.lastActivity;
        writeRecord(storage, key, record);
      }
      return fresh;
    },
    markSeen(t) {
      const before = this.isNew(t);
      const prev = record.threads[t.id];
      if (prev !== undefined && prev >= t.lastActivity) return false;
      record.threads[t.id] = t.lastActivity;
      writeRecord(storage, key, record);
      return before;
    },
  };
}
