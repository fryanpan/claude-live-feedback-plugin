/**
 * Which builder worktrees are currently working which tasks.
 *
 * The stall loop's clock reads board activity — transitions, edits, comments.
 * A dispatched builder works in a private git worktree the board cannot see,
 * so a task with a busy builder shows the exact silence the loop wakes the
 * lead over: measured 2026-08-28, 8 of 9 stall wakes were this false
 * positive. This registry is the missing witness. The lead registers a
 * dispatch {taskId, worktreePath} when it spawns a builder and closes it on
 * terminal (done or died); in between, a recursive fs.watch on the worktree
 * turns file churn into a lastActivityAt the stall pass can read.
 *
 * Shape decisions, each with its reason:
 *
 * - **One JSON file, `dispatches.json`, in the data dir**, rewritten whole on
 *   change via write-temp-then-rename — the agent-watches.ts pattern, for the
 *   same reasons (a handful of entries; a crash mid-write leaves the previous
 *   file). What persists is the SET of open dispatches, not the activity
 *   clock: activity arrives many times a second while a build runs, and a
 *   registry that flushed per keystroke would be its own load. After a
 *   restart a revived dispatch reads as no-signal until its next event —
 *   honest, and self-correcting within one write.
 * - **Activity is an event, never a poll.** The watcher records a timestamp
 *   when the OS says something changed; nothing walks the tree on a timer.
 *   rooms.ts avoids fs.watch for BOUND FILES because a file watch pins the
 *   inode an editor's rename-save replaces; a directory watch has no single
 *   inode to go stale on, and this consumer needs none of the file watch's
 *   precision — any event at all is the answer.
 * - **A watcher that fails degrades to no-signal, never crashes.** Arm
 *   failure and runtime error both land in `watching: false` with the
 *   dispatch kept open: the row simply stalls by the ordinary clock, which is
 *   the pre-feature behavior. This is the bound-docs posture (a broken
 *   watcher must not take the doc down) applied here — and it is also the
 *   Linux story, where Bun's recursive directory watch has measurably
 *   dropped events.
 * - **A worktree that no longer exists closes its dispatch on read** — the
 *   builder is gone and `git worktree remove` was its terminal statement.
 *   Prune-on-read rather than a sweeper, matching agent-watches: the readers
 *   (the stall pass, the REST list) are exactly the moments staleness would
 *   mislead. Dispatch records are coordination state, not user content, so
 *   hard-deleting a closed one is not a soft-delete concern.
 * - **A corrupt file is renamed aside, never overwritten** — losing the set
 *   is recoverable (the lead re-registers on its next dispatch); destroying
 *   the evidence of what went wrong is not.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILENAME = 'dispatches.json';
const FORMAT_VERSION = 1;

/** Same alphabet the durable watch keys allow — covers every opaque row id. */
const TASK_ID_RE = /^[a-zA-Z0-9_.:~\-]{1,104}$/;

export function isValidDispatchTaskId(id: unknown): id is string {
  return typeof id === 'string' && !id.startsWith('.') && TASK_ID_RE.test(id);
}

/**
 * The seam tests drive by hand. The default wraps `fs.watch(path,
 * {recursive: true})`; `onError` means the watcher is dead and the dispatch
 * should read as unwatched from now on.
 */
export type WatchFactory = (
  path: string,
  onEvent: () => void,
  onError: (err: unknown) => void,
) => { close: () => void };

const fsWatchFactory: WatchFactory = (path, onEvent, onError) => {
  const watcher = watch(path, { recursive: true }, onEvent);
  watcher.on('error', onError);
  // A registry full of worktree watchers must not keep the process alive.
  watcher.unref?.();
  return { close: () => watcher.close() };
};

export interface DispatchRecord {
  taskId: string;
  worktreePath: string;
  /** When the lead registered this dispatch (ms epoch). Survives restarts. */
  registeredAt: number;
  /** Newest watcher event (ms epoch). In-memory only — absent means no
   *  signal, including the stretch between a restart and the next event. */
  lastActivityAt?: number;
  /** False when the watcher failed to arm or died: activity cannot be seen,
   *  so the row falls back to the ordinary stall clock. */
  watching: boolean;
}

export type RegisterResult =
  | { ok: true; dispatch: DispatchRecord }
  | { ok: false; error: 'bad-task-id' | 'path-not-absolute' | 'no-such-path' };

interface Entry {
  worktreePath: string;
  registeredAt: number;
  lastActivityAt?: number;
  watcher: { close: () => void } | null;
}

interface FileShape {
  version: number;
  dispatches: Record<string, { worktreePath: string; registeredAt: number }>;
}

export interface DispatchRegistryOptions {
  dataDir: string;
  now?: () => number;
  watchFactory?: WatchFactory;
}

export class DispatchRegistry {
  private readonly path: string;
  private readonly now: () => number;
  private readonly watchFactory: WatchFactory;
  private readonly entries = new Map<string, Entry>();
  /** Set when the file on disk was unreadable and moved aside. */
  readonly loadError: string | null = null;

  constructor(opts: DispatchRegistryOptions) {
    this.path = join(opts.dataDir, FILENAME);
    this.now = opts.now ?? Date.now;
    this.watchFactory = opts.watchFactory ?? fsWatchFactory;
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.dispatches !== 'object') {
        throw new Error('missing "dispatches" object');
      }
      for (const [taskId, rec] of Object.entries(parsed.dispatches ?? {})) {
        if (!isValidDispatchTaskId(taskId)) continue;
        if (!rec || typeof rec.worktreePath !== 'string') continue;
        const entry: Entry = {
          worktreePath: rec.worktreePath,
          registeredAt: typeof rec.registeredAt === 'number' ? rec.registeredAt : this.now(),
          watcher: null,
        };
        this.entries.set(taskId, entry);
        // A path already gone stays until a read prunes it; arming would
        // throw ENOENT into the degraded branch for nothing.
        if (existsSync(rec.worktreePath)) this.arm(taskId, entry);
      }
    } catch (err) {
      const aside = `${this.path}.corrupt-${this.now()}`;
      try {
        renameSync(this.path, aside);
      } catch {
        // If even the rename fails the next save overwrites; loadError
        // still says what happened.
      }
      this.loadError = `${err instanceof Error ? err.message : String(err)} (moved to ${aside})`;
    }
  }

  register(taskId: string, worktreePath: string): RegisterResult {
    if (!isValidDispatchTaskId(taskId)) return { ok: false, error: 'bad-task-id' };
    if (!worktreePath.startsWith('/')) return { ok: false, error: 'path-not-absolute' };
    if (!existsSync(worktreePath)) return { ok: false, error: 'no-such-path' };
    // Re-registering replaces: the newest dispatch is the live one, and the
    // old worktree's activity must not vouch for the new worktree's silence.
    this.closeEntry(taskId);
    const entry: Entry = { worktreePath, registeredAt: this.now(), watcher: null };
    this.entries.set(taskId, entry);
    this.arm(taskId, entry);
    this.save();
    return { ok: true, dispatch: this.record(taskId, entry) };
  }

  close(taskId: string): { closed: boolean } {
    const closed = this.closeEntry(taskId);
    if (closed) this.save();
    return { closed };
  }

  /**
   * The stall pass's read: newest watcher event for this task's open
   * dispatch, or undefined when there is nothing trustworthy to say — no
   * dispatch, no event yet, a dead watcher, or a worktree that has vanished
   * (which also closes the dispatch, as its terminal statement).
   */
  activityFor(taskId: string): number | undefined {
    const entry = this.entries.get(taskId);
    if (!entry) return undefined;
    if (!existsSync(entry.worktreePath)) {
      this.closeEntry(taskId);
      this.save();
      return undefined;
    }
    return entry.lastActivityAt;
  }

  /** Every open dispatch, dead-worktree ones pruned by the read. */
  list(): DispatchRecord[] {
    let pruned = false;
    for (const [taskId, entry] of this.entries) {
      if (existsSync(entry.worktreePath)) continue;
      this.closeEntry(taskId);
      pruned = true;
    }
    if (pruned) this.save();
    return [...this.entries.entries()]
      .map(([taskId, entry]) => this.record(taskId, entry))
      .sort((a, b) => a.registeredAt - b.registeredAt || a.taskId.localeCompare(b.taskId));
  }

  /** Close every watcher without touching the persisted set — shutdown. */
  stop(): void {
    for (const entry of this.entries.values()) {
      try {
        entry.watcher?.close();
      } catch {}
      entry.watcher = null;
    }
  }

  private arm(taskId: string, entry: Entry): void {
    try {
      entry.watcher = this.watchFactory(
        entry.worktreePath,
        () => {
          entry.lastActivityAt = this.now();
        },
        (err) => {
          // Dead watcher: from here the dispatch reads as no-signal, which
          // the stall pass treats exactly as it did before this feature.
          console.error(`[dispatch] watcher failed for ${entry.worktreePath}:`, err);
          try {
            entry.watcher?.close();
          } catch {}
          entry.watcher = null;
          entry.lastActivityAt = undefined;
        },
      );
    } catch (err) {
      console.error(`[dispatch] could not watch ${entry.worktreePath}:`, err);
      entry.watcher = null;
    }
  }

  private closeEntry(taskId: string): boolean {
    const entry = this.entries.get(taskId);
    if (!entry) return false;
    try {
      entry.watcher?.close();
    } catch {}
    this.entries.delete(taskId);
    return true;
  }

  private record(taskId: string, entry: Entry): DispatchRecord {
    return {
      taskId,
      worktreePath: entry.worktreePath,
      registeredAt: entry.registeredAt,
      ...(entry.lastActivityAt !== undefined ? { lastActivityAt: entry.lastActivityAt } : {}),
      watching: entry.watcher !== null,
    };
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const dispatches: FileShape['dispatches'] = {};
    for (const [taskId, entry] of this.entries) {
      dispatches[taskId] = {
        worktreePath: entry.worktreePath,
        registeredAt: entry.registeredAt,
      };
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: FORMAT_VERSION, dispatches }, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
