/**
 * The file bindings: everything that keeps a live doc and a file on disk
 * saying the same thing. `attachFile` and its flat-text twins, the shared
 * mtime poll, the debounced write-back and the conflict reconcile that
 * arbitrates when both sides moved — plus the doc-home pin, which is only
 * ever a rule about which file a binding may write.
 *
 * It reaches the room lifecycle through `FileBindingHost` rather than
 * holding a `Rooms`. The seam is that shape because the bindings touch a
 * room on every path — its ydoc, its persist debounce, its event fan-out —
 * so a line-range extraction would have had to copy those, and a copy of a
 * persist timer is a second timer. Every entry below is a THUNK onto the
 * live thing: `room` is the rooms map, `schedulePersist` is the 200ms
 * `.ydoc` debounce, `noteTouched` writes the one residency clock the
 * eviction policy also reads. Nothing here owns state the lifecycle owns,
 * and nothing there owns the bindings' own timers.
 *
 * Timings, ordering and log lines are unchanged from when this lived in
 * `rooms.ts`: the write-back debounce, the read settle, the reconcile's
 * decision order and its backup-before-reassert rule are the contract the
 * bound-doc sync behaviour rests on, and this file moved them without
 * touching them.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type DocHome,
  type DocMeta,
  type WebhookPayload,
  contentKind,
  prose,
  suggestOps,
} from '@feedback/core';
import * as Y from 'yjs';
import {
  canonicalRepoRoot,
  normalizeDocHome,
  resolveHomeCheckout,
  verifyPathInHome,
} from './doc-home.ts';
import { isHubOwnedRoom } from './doc-ids.ts';
import { showFile } from './git-diff.ts';
import { gitConflictHint } from './git-provenance.ts';
import { ROOM_TIMINGS } from './room-timings.ts';
import type { DocRoom } from './rooms.ts';
import { isWithinRoot } from './safe-path.ts';
import { boundFiles } from './slow-fs.ts';

/**
 * Per-room binding to a markdown file on disk. Maintained by
 * `attachFile` — every prose change debounces a write of the
 * serialized fragment back to the file. First attach seeds from disk
 * if the fragment is empty.
 */
/**
 * What a caller can tell an attach that the files cannot.
 *
 * `liveWins`: the live doc holds content the file does not — an un-flushed
 * write-back the index row recorded at shutdown, or the very edit that
 * triggered this attach — so the at-rest arbitration reasserts the doc
 * (disk version backed up) instead of asking the clock. Without it a fresh
 * attach with no bookkeeping compares the file's mtime against the persisted
 * `.ydoc`'s, and EQUAL goes to disk. The two are routinely written inside one
 * file-timestamp tick (~4ms on a stock Linux kernel): an evict-flush right after
 * the bind, a `git worktree add` a few ms before the rebind's persist. Both
 * reverted a live edit with the file's stale copy — the doc-home-binding and
 * doc-eviction reds of 2026-08-31/09-01 — and read as a bare timeout.
 */
/**
 * A bound file's bytes, already read by somebody else.
 *
 * Hydration reads the file through `boundFiles` (off the main thread, under a
 * deadline) and hands the result down, so the attach itself performs no
 * blocking syscall on the path. `exists: false` covers both "not there" and
 * "would not answer" — the attach treats them the same way it has always
 * treated a missing file, which is why there is no third state here.
 */
export interface PrereadFile {
  exists: boolean;
  text?: string;
  mtimeMs?: number;
}

export interface AttachOpts {
  liveWins?: boolean;
  /** Bytes read ahead of the attach; see `PrereadFile`. */
  preread?: PrereadFile;
}

interface FileBinding {
  path: string;
  writeTimer?: ReturnType<typeof setTimeout> | null;
  readTimer?: ReturnType<typeof setTimeout> | null;
  /**
   * Whether this binding takes part in the shared mtime sweep (see
   * `armFileWatcher`). There is no per-binding interval any more: 4,228 of
   * them were the 2026-08-29 timer storm. The sweep stats every ARMED
   * binding whose doc is active, plus a rotating slice of the idle ones.
   */
  pollArmed?: boolean;
  /** A poll stat is on the thread pool right now — see `pollBinding`. */
  statInFlight?: boolean;
  /** A write-back is on the thread pool right now — see `writeBoundFileNow`. */
  writeInFlight?: boolean;
  /**
   * Which write is the current one. Bumped by every write that starts; a
   * pool write compares it on landing and records nothing if it lost — see
   * `writeBoundFileNow`.
   */
  writeSeq?: number;
  /**
   * Last file mtime (ms) we have actually READ, so the poll reacts only to
   * changes. Advanced when the reconcile's read lands, never when the stat
   * that spotted the change lands — see `applyPolledMtime`.
   */
  lastMtimeMs?: number;
  /** An mtime spotted by the stat whose reconcile read has not landed yet. */
  pendingMtimeMs?: number;
  /** The serialized markdown we last wrote or last read from disk.
   *  Both directions guard against this to break echo loops. */
  lastWritten?: string;
  /** Set when the most recent disk→doc reconcile failed (parse threw or
   *  produced zero blocks) or hit a conflict. Cleared on the next successful
   *  reconcile. Surfaced via getDoc AND on edit-tool responses so a wedged
   *  doc reports WHY it's stale instead of silently serving pre-edit
   *  content. */
  lastSyncError?: { message: string; at: number };
  /** The observeDeep callback wired by attachFile. Kept so a re-attach can
   *  unobserve it — without this, every re-attach (hydrate, re-run
   *  create_review_doc) stacked another write-back scheduler holding stale
   *  binding state. */
  observer?: Parameters<Y.XmlFragment['observeDeep']>[0];
  /** True when this flat binding writes doc edits back to the file (the
   *  editable File view). Absent/false = classic read-only code binding. */
  writeBack?: boolean;
  /** The content-Y.Text observer wired by attachFlatFile({writeBack:true}).
   *  Kept so a re-attach can unobserve it (same stacking hazard as
   *  `observer` above). */
  contentObserver?: (event: Y.YTextEvent, tr: Y.Transaction) => void;
}

/**
 * Decide what a disk→doc reconcile should do, given the file's current
 * content (`disk`), the markdown we last wrote/read (`lastWritten`), and the
 * live doc's current serialization (`currentSerialized`).
 *
 *   - `in-sync`   disk is byte-identical to our last write → nothing to do.
 *   - `catch-up`  disk differs from lastWritten but already equals the live
 *                 doc → just advance bookkeeping, don't touch the fragment.
 *   - `apply`     disk changed externally and the live doc is clean (still
 *                 equals lastWritten) → safe to pull disk into the doc.
 *   - `conflict`  disk changed externally AND the live doc has its own
 *                 un-flushed edits (diverged from lastWritten) → a blind
 *                 replace would clobber the human's in-progress work. The
 *                 caller keeps the live edits (the editor is the runtime
 *                 source of truth) and reasserts them to disk.
 *
 * Pure + exported so the policy is unit-tested without timing races.
 */
export function decideReconcile(args: {
  disk: string;
  lastWritten: string | undefined;
  currentSerialized: string;
}): 'in-sync' | 'catch-up' | 'apply' | 'conflict' {
  const { disk, lastWritten, currentSerialized } = args;
  if (disk === lastWritten) return 'in-sync';
  if (disk === currentSerialized) return 'catch-up';
  // disk diverges from BOTH our last write and the live doc.
  if (currentSerialized !== lastWritten) return 'conflict';
  return 'apply';
}

/** Yjs origin for the private-meta guard's own deletes, so it never

/** How often the shared mtime sweep runs — the cadence the old per-binding
 *  interval ran at, kept so external-edit latency is unchanged for a doc
 *  anyone is actually looking at. */
const FILE_POLL_MS = ROOM_TIMINGS.filePollMs;

/** Settle time before a changed file is read, so no half-written save is parsed. */
const READ_DEBOUNCE_MS = ROOM_TIMINGS.readDebounceMs;

/** Doc → disk: how long a prose change waits before the serialize+write. */
const WRITE_BACK_MS = ROOM_TIMINGS.writeBackMs;

/** How long after an access a bound doc counts as ACTIVE — stat'd on every
 *  tick. Long enough that a person reading, thinking and typing never falls
 *  out of it; short enough that a doc touched once by a bulk operation goes
 *  quiet again. */
const FILE_POLL_ACTIVE_MS = 60_000;

/**
 * How many IDLE bindings the sweep may stat per tick.
 *
 * This is the cap that turns an unbounded per-doc cost into a constant one.
 * Idle bindings are visited round-robin, so the syscall rate is
 * `IDLE_SWEEP_BUDGET / FILE_POLL_MS` (256/s) no matter how many bound docs
 * exist — what grows with the corpus is how long an UNWATCHED external edit
 * waits to be noticed, not how hard the server works. Below the budget
 * (every dev machine, every test) each idle binding is still visited on every
 * tick, so the old 500ms guarantee is unchanged there.
 */
const IDLE_SWEEP_BUDGET = 128;

/**
 * How many distinct activation tags to keep. Everything past the cap folds
 * into `other`, so a pathological caller cannot grow this map without bound.
 */
const ACTIVATION_TAG_CAP = 32;
/** How many to report. The question is "who is doing this", not a census. */
const ACTIVATION_TAGS_REPORTED = 8;

/**
 * Where the current `touchDoc` came from, as `packages/<path>:<line>`.
 *
 * Only ever called when a binding goes idle -> active, which in a healthy
 * server is rare and in the case this exists to catch is exactly the thing
 * worth paying for. Frames inside `rooms.ts` AND this file are skipped —
 * every touch passes through `get` / `getOrCreate` and then through
 * `FileBindings.touchDoc`, so the useful frame is the first one outside both.
 * Missing the second name would have made every activation read as
 * `file-binding.ts`, which names the mechanism instead of the caller.
 *
 * Deliberately relative to `packages/`: the absolute path is a host-machine
 * fact and this string is served by `GET /api/metrics`.
 */
function activationTag(): string {
  const stack = new Error().stack;
  if (!stack) return 'unknown';
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/[/\\]packages[/\\]([^\s)]+?):(\d+):\d+/);
    if (!m) continue;
    const where = m[1].replace(/\\/g, '/');
    if (where.endsWith('/rooms.ts') || where.endsWith('/file-binding.ts')) continue;
    return `packages/${where}:${m[2]}`;
  }
  return 'external';
}

/**
 * What the bindings need from the room lifecycle, and nothing more.
 *
 * Every member is a function onto the live thing rather than a copy of it:
 * the rooms map, the `.ydoc` persist debounce, the residency clock, the
 * room's event fan-out. That is the whole reason this interface exists —
 * the bindings mutate a room's ydoc and re-arm its persist timer on almost
 * every path, so handing them a snapshot of a room would give two owners to
 * one timer.
 */
export interface FileBindingHost {
  /** Where the corpus lives: `.ydoc` files, index rows, clobber backups. */
  dataDir(): string;
  /** Resolve an id (which may be an alias) to its room, hydrating if needed. */
  room(docId: string): DocRoom | undefined;
  /** Only what is already in memory — no hydrate, no access stamp. */
  residentRoom(docId: string): DocRoom | undefined;
  /** The doc's persisted `.ydoc` path, whose mtime the at-rest arbitration reads. */
  ydocPath(docId: string): string;
  /** Arm the debounced `.ydoc` persist (and the sidecar and index row with it). */
  schedulePersist(room: DocRoom): void;
  /** Persist the `.ydoc` now, synchronously. */
  persistNow(room: DocRoom): void;
  /** Drop `pendingFileWrite` from the doc's index row — the row belongs to
   *  the lifecycle, the flag's meaning belongs here. */
  clearPendingFileWrite(docId: string): void;
  /** The residency clock. One clock for the whole policy, so "recently
   *  touched" cannot mean two things a few lines apart. */
  now(): number;
  /** Read and write the access stamp the poll's fast lane and the eviction
   *  window share. */
  lastTouchedAt(docId: string): number | undefined;
  noteTouched(docId: string, at: number): void;
  /** Fan an event out to the room's sockets, SSE and webhooks. */
  broadcast(room: DocRoom, payload: WebhookPayload): void;
  /** Fill in `reviewUrl` and friends; the URL machinery stays in the server layer. */
  decorate(meta: DocMeta): DocMeta;
}

/**
 * One server's file bindings. Constructed by `Rooms`, which keeps the
 * lifecycle and the websocket fan-out and calls in here for everything that
 * touches a file.
 */
export class FileBindings {
  private bindings = new Map<string, FileBinding>();
  /**
   * Rate-limits the re-place probe for a home-pinned doc that has NO binding
   * (`maybeRebindHome`) — the probe is cheap, but not per-keystroke.
   */
  private homeRebindAttemptAt = new Map<string, number>();
  private pollTicker: ReturnType<typeof setInterval> | null = null;
  /** Where the idle rotation of the shared sweep left off. */
  private idleCursor = 0;
  /** Idle → active transitions since boot, by the caller that caused them. */
  private activations = new Map<string, number>();
  /**
   * Docs whose last write-back THREW. `writeBoundFileNow` swallows its own
   * errors, so nothing downstream could otherwise tell a failed write from a
   * finished one — and the doc index row is what tells the next boot to come
   * back for it.
   */
  private failedWrites = new Set<string>();

  constructor(private readonly p: FileBindingHost) {}

  /**
   * Bind a doc to a file path on disk. After attach:
   *   - if the doc's prose fragment is empty AND the file exists with
   *     content, the file is parsed and seeded into the fragment
   *   - every subsequent prose change debounces a write of the
   *     serialized markdown back to the file (default 800ms)
   *
   * File path is resolved relative to the server's process cwd if
   * relative. An absolute path is strongly recommended.
   *
   * Bidirectional sync:
   *   doc → disk — every prose change debounces an 800ms serialize+write
   *   disk → doc — fs.watch fires on external edits, debounced 300ms,
   *     reads the file, diffs against current serialized output, and if
   *     different applies the new markdown in one 'file-watch' transact.
   *   Echo loop is broken by `binding.lastWritten` on both sides — a
   *   write we initiated won't be re-applied, and a read that matches
   *   our cached content is silently ignored.
   */
  /**
   * Bind a file, reading it on the thread pool first.
   *
   * This is the door every REQUEST and TIMER path uses. `attachFile` itself
   * stays synchronous because hydration needs it to be, and its no-preread
   * fallback still opens the file on the main thread — safe only where
   * nothing is waiting, which after this is boot and nothing else. Anything
   * with a caller on the other end comes through here instead, so the one
   * blocking syscall is already done and handed over as a preread.
   *
   * A file that cannot be read is not an error here: the attach is refused,
   * the doc keeps its `.ydoc` content, and the caller sees `read-failed`.
   *
   * There is deliberately no `attachFlatFileAsync` beside this. Every flat
   * (code / diff-member) attach is reached from a synchronous caller — the
   * folder-bind loop in `bind-diff`, a workspace member open, hydration —
   * and an async door with no caller is worse than none, because it reads
   * like coverage the flat path does not have. What `attachFlatFile` does
   * have is the refusal guard, so a known-hostile path is never opened on
   * the main thread; a first read of a healthy-but-slow file still blocks
   * there. Giving those callers a real async door is its own change.
   */
  async attachFileAsync(
    docId: string,
    filePath: string,
    opts: AttachOpts = {},
  ): Promise<ReturnType<FileBindings['attachFile']>> {
    const ready = await this.withPreread(filePath, opts);
    if (ready === 'unreadable') return { ok: false, error: 'read-failed' };
    return this.attachFile(docId, filePath, ready);
  }

  /**
   * Fill in `opts.preread` from a pool read, unless the caller brought one.
   *
   * A read that fails or never answers returns `'unreadable'`, and the async
   * doors above refuse the attach on it. Falling through to the synchronous
   * read instead — which is what this did first — reopens the hazard the
   * whole change exists to close, and reopens it in its worst form: a file
   * that is present but unreadable (an un-materialized cloud file failing
   * with EDEADLK) is not quarantined, so the fallback read runs, and on the
   * prose path a throw inside the attach-time reconcile is logged and
   * swallowed. The doc binds with `.ydoc` content it never checked against
   * disk, and the next write-back overwrites the file. Refusing to bind is
   * what keeps the bytes on disk safe: the doc still comes back, from its
   * `.ydoc`, with writes parked.
   */
  private async withPreread<T extends AttachOpts>(
    filePath: string,
    opts: T,
  ): Promise<T | 'unreadable'> {
    if (opts.preread) return opts;
    if (!filePath || filePath.trim() === '') return opts;
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const res = await boundFiles.read(abs, { keep: false });
    if (res.status !== 'ok') return 'unreadable';
    return {
      ...opts,
      preread: res.exists
        ? { exists: true, text: res.text, mtimeMs: res.mtimeMs }
        : { exists: false },
    };
  }

  attachFile(
    docId: string,
    filePath: string,
    opts: AttachOpts = {},
  ): {
    ok: boolean;
    error?: 'not-found' | 'path-empty' | 'read-failed';
    seeded?: boolean;
    resolvedPath?: string;
  } {
    if (!filePath || filePath.trim() === '') return { ok: false, error: 'path-empty' };
    const room = this.p.room(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const fragment = prose.getProseFragment(room.ydoc);
    // Either the caller already read the file for us (hydration does, off the
    // main thread) or we read it here. Both branches go through these two so
    // no path below can reach the filesystem behind the preread's back.
    const pre = opts.preread;
    // No preread means the sync fallback below, and that is only safe on a
    // path that has not already proved hostile. A quarantined one is refused
    // outright rather than opened: `attachFileAsync` is the door every
    // request and timer path comes through, and it always brings a preread.
    //
    // `busy` is the same refusal one level up. It means some bound path is
    // holding pool threads and has not been identified yet, so THIS path is
    // not known-good either — and a `busy` verdict leaves no quarantine mark
    // behind, which is how a hostile file used to reach the blocking read
    // below anyway. Refusing costs a parked doc; not refusing costs the
    // process.
    if (!pre && (boundFiles.quarantined(abs) || boundFiles.busy())) {
      return { ok: false, error: 'read-failed' };
    }
    const fileExists = () => (pre ? pre.exists : existsSync(abs));
    const readFile = () => (pre ? (pre.text ?? '') : readFileSync(abs, 'utf8'));
    let seeded = false;
    if (fragment.length === 0 && fileExists()) {
      try {
        const md = readFile();
        const blocks = prose.parseMarkdownBlocks(md);
        if (blocks.length > 0) {
          room.ydoc.transact(() => fragment.push(blocks), 'file-seed');
          seeded = true;
        }
      } catch (err) {
        console.error(`[rooms] read failed for ${abs}:`, err);
        return { ok: false, error: 'read-failed' };
      }
    }
    const existing = this.bindings.get(docId);
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing) existing.pollArmed = false;
    // A re-attach must replace the write-back observer, not stack another —
    // each leaked observer is a duplicate scheduler holding a stale binding.
    if (existing?.observer) fragment.unobserveDeep(existing.observer);
    const binding: FileBinding = { path: abs, lastMtimeMs: existing?.lastMtimeMs };
    this.bindings.set(docId, binding);
    // sourceUrl records the bound path. It stays OUT of the CRDT (an absolute
    // host path is exactly what a share visitor must not sync) — the sidecar
    // is its home, and saveToDisk is what persists it.
    if (!room.meta.sourceUrl) {
      room.meta.sourceUrl = abs;
      this.p.schedulePersist(room);
    }

    // Attaching a NON-empty fragment (hydrate after a restart, or a re-run
    // create_review_doc): honor the sync contract's "the file is the source
    // of truth at rest". Without this, an edit made while the server was down
    // was never picked up — and the next flush overwrote it on disk.
    if (!seeded && fileExists()) {
      try {
        const md = readFile();
        const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
        const prior = existing?.lastWritten;
        if (md !== currentSerialized) {
          // NB: this byte-equality guard rarely spares the parse below —
          // most real files differ from the serializer's normal form, so
          // hydrate pays one parse+serialize per bound doc (~1ms for a
          // typical doc). Accepted: the alternative was rewriting ~every
          // never-edited bound file on each restart.
          const diskNormalized = prose.normalizeMarkdown(md);
          if (diskNormalized === currentSerialized) {
            // Pure normalization drift: disk parses to exactly the live
            // doc's content, the bytes just differ in formatting the
            // round-trip doesn't preserve. This is the steady state for
            // every bound-but-never-edited doc (binding stamps the .ydoc
            // after the .md, so mtime arbitration below would call the
            // live side newer and rewrite the file). Semantically equal
            // means in-sync — leave the file untouched.
            binding.lastWritten = currentSerialized;
          } else if (prior !== undefined && currentSerialized !== prior) {
            // The live doc has un-flushed edits relative to our last write —
            // we are NOT at rest, so don't pick a winner here. Keep the old
            // bookkeeping; if disk also moved, the poll's reconcile will
            // treat it as a conflict (backup + reassert). If disk did not
            // move, re-arm the flush this re-attach just cancelled. (The
            // conflict case reconciles NOW — armFileWatcher re-baselines the
            // mtime below, so the poll would never see the change.)
            binding.lastWritten = prior;
            // A disk that IS (or normalizes to) our last write hasn't
            // really changed — re-arm the flush this re-attach cancelled.
            // Without the normalized check, a doc whose drift was
            // suppressed at hydrate hit reconcile here and reported a
            // false conflict (backup + syncError) though disk never moved.
            if (md === prior || diskNormalized === prior) this.scheduleFileWrite(room, binding);
            else this.reconcileFromDisk(room, binding);
          } else if (
            prior === undefined &&
            (opts.liveWins || !this.diskNewerThanState(docId, abs, pre?.mtimeMs))
          ) {
            // Fresh attach with NO bookkeeping (post-restart hydrate) and the
            // .md is OLDER than the persisted .ydoc: the crash happened inside
            // the 800ms write-back window, so the hydrated doc is the newer
            // side. Applying disk here would revert the just-made edit on
            // startup (codex P1). Reassert the live doc to disk instead —
            // snapshotting the disk version first, symmetric with the apply
            // branch below (this is the one writer that replaces content the
            // server never wrote). `liveWins` reaches the same branch on the
            // caller's knowledge instead of the clock — see `AttachOpts`.
            this.backupExternalVersion(docId, md);
            binding.lastWritten = md;
            this.scheduleFileWrite(room, binding);
          } else if (prose.parseMarkdownBlocks(md).length > 0) {
            // At rest: pull disk in as a block diff so anchors on untouched
            // blocks keep resolving. On the no-bookkeeping path we can't
            // PROVE the fragment's extra state was ever flushed, so snapshot
            // it first — restarts are rare enough that a stray backup beats
            // an unrecoverable revert.
            if (prior === undefined) {
              this.backupExternalVersion(docId, currentSerialized, 'live');
            }
            room.ydoc.transact(() => {
              prose.applyMarkdownToFragment(fragment, md);
            }, 'file-watch');
            prose.normalizeHeadingLevels(room.ydoc);
          }
        }
      } catch (err) {
        console.error(`[rooms] attach-time reconcile failed for ${abs}:`, err);
      }
    }

    // doc → disk: every change schedules a debounced write.
    const observer: Parameters<Y.XmlFragment['observeDeep']>[0] = (_events, tr) => {
      // Don't echo our own seed-from-disk or file-watch apply back to disk.
      if (tr.origin === 'file-seed' || tr.origin === 'file-watch') return;
      this.scheduleFileWrite(room, binding);
    };
    binding.observer = observer;
    fragment.observeDeep(observer);
    // Bookkeeping lives in serializer-space: comparing raw disk bytes against
    // normalized serializer output made every applied external edit look like
    // permanent divergence, so the NEXT external edit was misjudged a
    // conflict and clobbered (2026-08-03 incident, RC1).
    if (binding.lastWritten === undefined) {
      binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    }

    // disk → doc: poll for external edits (see armFileWatcher).
    this.armFileWatcher(room, binding, pre);

    return { ok: true, seeded, resolvedPath: abs };
  }

  /**
   * Bind a READ-ONLY source file (type='code') for review. The file's raw
   * text is seeded into the flat `content` Y.Text (no markdown parse), the
   * mtime poll is armed for disk→doc refresh, and — crucially — there is NO
   * doc→disk write-back: the browser never edits a code file (it only
   * comments), so the file is never rewritten by claude-workspaces. The agent
   * edits the source via its normal tools; the poll re-renders the view.
   */
  attachReadonlyFile(
    docId: string,
    filePath: string,
  ): { ok: boolean; error?: 'not-found' | 'path-empty' | 'read-failed'; resolvedPath?: string } {
    return this.attachFlatFile(docId, filePath);
  }

  /**
   * Bind a flat (code / working-tree diff) doc to a file. Disk→doc always
   * flows via the mtime poll; pass `writeBack: true` to also flow doc→disk
   * through the same debounced atomic writer prose docs use — that is what
   * makes the File view a live editor. Pinned diff docs must never pass
   * writeBack (their content is a commit, not a file).
   */
  attachFlatFile(
    docId: string,
    filePath: string,
    opts: AttachOpts & { writeBack?: boolean } = {},
  ): { ok: boolean; error?: 'not-found' | 'path-empty' | 'read-failed'; resolvedPath?: string } {
    if (!filePath || filePath.trim() === '') return { ok: false, error: 'path-empty' };
    const room = this.p.room(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const content = room.ydoc.getText('content');
    // See `attachFile`: hydration reads off the main thread and hands the
    // bytes down, so nothing below opens the bound path itself.
    const pre = opts.preread;
    // And the same refusal, for the same reason. This door is the one a
    // folder bind walks — `bind-diff` attaches every member of a repo in one
    // synchronous loop — so a single hostile file in a bound tree is exactly
    // the shape that parked the event loop. Read the note in `attachFile`.
    if (!pre && (boundFiles.quarantined(abs) || boundFiles.busy())) {
      return { ok: false, error: 'read-failed' };
    }
    const fileExists = () => (pre ? pre.exists : existsSync(abs));
    let text = '';
    if (fileExists()) {
      try {
        text = pre ? (pre.text ?? '') : readFileSync(abs, 'utf8');
      } catch (err) {
        console.error(`[rooms] read failed for ${abs}:`, err);
        return { ok: false, error: 'read-failed' };
      }
    }
    // Sync content to the file's CURRENT bytes when disk is the newer side.
    // For read-only docs disk is always authoritative (the live doc never
    // holds browser edits). For write-back docs the two can genuinely
    // diverge across a restart, in BOTH directions: a File-view edit whose
    // ~800ms flush the crash beat (doc newer — blindly seeding here silently
    // destroyed it), or an agent editing the working tree while the server
    // was down (disk newer — "doc always wins" would reassert pre-deploy
    // bytes over their work). Arbitrate by mtime via diskNewerThanState;
    // when the doc wins, back up the losing disk version and reassert below.
    // The 'file-watch' origin routes a disk apply through the same reanchor
    // sweep as a live edit.
    let reassertDoc = false;
    if (fileExists() && text !== content.toString()) {
      if (
        opts.writeBack &&
        content.length > 0 &&
        (opts.liveWins || !this.diskNewerThanState(docId, abs, pre?.mtimeMs))
      ) {
        this.backupExternalVersion(docId, text);
        reassertDoc = true;
      } else {
        const origin = content.length === 0 ? 'file-seed' : 'file-watch';
        room.ydoc.transact(() => {
          if (content.length > 0) content.delete(0, content.length);
          if (text.length > 0) content.insert(0, text);
        }, origin);
      }
    }
    const existing = this.bindings.get(docId);
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing) existing.pollArmed = false;
    if (existing?.contentObserver) content.unobserve(existing.contentObserver);
    // lastWritten is "what the FILE holds" — when the doc won the arbitration
    // the file still holds the stale disk text, and recording the doc text
    // instead would make the writer's no-op check skip the reassert.
    const binding: FileBinding = {
      path: abs,
      lastWritten: reassertDoc ? text : content.toString(),
    };
    this.bindings.set(docId, binding);
    if (!room.meta.sourceUrl) {
      // Sidecar, not CRDT — see attachFile above.
      room.meta.sourceUrl = abs;
      this.p.schedulePersist(room);
    }
    if (opts.writeBack) {
      // doc → disk: same origin-guarded debounced writer as prose docs —
      // our own seed/poll applies must not echo back out to the file.
      binding.writeBack = true;
      const observer = (_event: Y.YTextEvent, tr: Y.Transaction) => {
        if (tr.origin === 'file-seed' || tr.origin === 'file-watch') return;
        this.scheduleFileWrite(room, binding);
      };
      binding.contentObserver = observer;
      content.observe(observer);
    }
    this.armFileWatcher(room, binding, pre);
    // Doc won the attach-time arbitration above: push its state back out
    // through the normal debounced writer (which also stamps the poll
    // baseline so the reassert isn't misread as an external edit).
    if (reassertDoc) this.scheduleFileWrite(room, binding);
    return { ok: true, resolvedPath: abs };
  }

  /**
   * Pin a doc to its repo home: repo + branch + relPath (see `DocHome` in
   * core). From here on, the file the doc syncs with is "the declared
   * relPath in whichever worktree has the declared branch checked out" —
   * resolved at pin, at hydrate, and re-verified by `homeGuard` before every
   * flush and every disk→doc apply. A checkout that switches branches under
   * the binding is never written again; the binding follows the branch or
   * parks.
   *
   * Prose docs only: a home is for durable planning/discussion notes. Diff,
   * code and mockup docs follow their surface (the diff's repo, the running
   * server) and pinning them would fight those flows.
   */
  setDocHome(
    docId: string,
    input: unknown,
  ):
    | {
        ok: true;
        home: DocHome;
        placement: { placed: true; path: string } | { placed: false; reason: string };
      }
    | { ok: false; error: 'not-found' | 'invalid-home' | 'not-markdown'; detail?: string } {
    const room = this.p.room(docId);
    if (!room) return { ok: false, error: 'not-found' };
    if (isHubOwnedRoom(room.docId) || contentKind(room.meta.type) !== 'prose') {
      return {
        ok: false,
        error: 'not-markdown',
        detail: 'a repo home is for markdown docs; code/diff/mockup docs follow their surface',
      };
    }
    const norm = normalizeDocHome(input);
    if (!norm.ok) return { ok: false, error: 'invalid-home', detail: norm.error };
    // The repo must at least exist as a repo — a typo'd repoRoot pinned
    // as-is would park the doc forever with a message blaming the branch.
    // Store the MAIN checkout's root, not the caller's spelling: a home
    // declared from a linked worktree must survive that worktree's removal.
    const canonRoot = canonicalRepoRoot(norm.home.repoRoot);
    if (canonRoot === null) {
      return {
        ok: false,
        error: 'invalid-home',
        detail: `${norm.home.repoRoot} is not a git checkout`,
      };
    }
    const home: DocHome = { ...norm.home, repoRoot: canonRoot };
    room.meta.docHome = home;
    const placement = resolveHomeCheckout(home);
    if (placement.placed) {
      const binding = this.bindings.get(room.docId);
      // Already bound to an EXISTING copy of the home: nothing to move. A
      // missing file still retargets — the retarget is what exports it.
      if (binding?.path === placement.absPath && existsSync(placement.absPath)) {
        this.p.schedulePersist(room);
      } else {
        this.retargetHomeBinding(room, placement.absPath);
      }
      return { ok: true, home, placement: { placed: true, path: placement.absPath } };
    }
    // Unplaced is a legal pin: the doc stays durable in the .ydoc and the
    // guard parks every write until a checkout on the branch appears. An
    // existing binding to some other path is deliberately left in the map —
    // homeGuard is what stops it writing, and keeping it is what lets the
    // next flush attempt re-resolve and recover.
    this.p.schedulePersist(room);
    return { ok: true, home, placement: { placed: false, reason: placement.reason } };
  }

  /** Unpin: the doc keeps whatever binding it has and goes back to being an
   *  ordinary explicit-path doc. */
  clearDocHome(docId: string): { ok: boolean } {
    const room = this.p.room(docId);
    if (!room || !room.meta.docHome) return { ok: false };
    room.meta.docHome = undefined;
    this.p.schedulePersist(room);
    return { ok: true };
  }

  /** The pin plus where it resolves RIGHT NOW — for doc status surfaces. */
  docHomeStatus(docId: string):
    | {
        home: DocHome;
        placement: { placed: true; path: string } | { placed: false; reason: string };
        boundPath?: string;
      }
    | undefined {
    const room = this.p.room(docId);
    const home = room?.meta.docHome;
    if (!room || !home) return undefined;
    const placement = resolveHomeCheckout(home);
    const boundPath = this.bindings.get(room.docId)?.path;
    return {
      home,
      placement: placement.placed
        ? { placed: true, path: placement.absPath }
        : { placed: false, reason: placement.reason },
      ...(boundPath ? { boundPath } : {}),
    };
  }

  /**
   * Point a home-pinned doc's binding at `absPath` (the freshly-resolved
   * home) with a CLEAN attach. The old binding's bookkeeping is about the
   * old file — letting `attachFile` read its `lastWritten` as `prior` would
   * arbitrate the new checkout's file against another file's history — so it
   * is dropped whole and the attach runs the same mtime arbitration a
   * restart does (losing side backed up, never silently discarded).
   */
  retargetHomeBinding(room: DocRoom, absPath: string, opts: AttachOpts = {}): void {
    const docId = room.docId;
    const old = this.bindings.get(docId);
    if (old) {
      if (old.writeTimer) clearTimeout(old.writeTimer);
      if (old.readTimer) clearTimeout(old.readTimer);
      old.pollArmed = false;
      if (old.observer) prose.getProseFragment(room.ydoc).unobserveDeep(old.observer);
      this.bindings.delete(docId);
    }
    // A branch whose checkout holds no copy yet: the pin (or retarget) IS
    // the export. Write the doc's content first, atomically, so the attach
    // below finds an in-sync file instead of never creating one (attachFile
    // arms nothing for a missing path). A copy the checkout DOES hold is
    // arbitrated by the attach — by the caller's knowledge when it has any
    // (`opts.liveWins`), by mtime otherwise.
    // A preread already answered "is it there" off the main thread; asking
    // the filesystem again here would put the blocking call straight back.
    const absent = opts.preread ? !opts.preread.exists : !existsSync(absPath);
    let attachOpts = opts;
    if (absent) {
      const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
      try {
        mkdirSync(dirname(absPath), { recursive: true });
        const tmp = `${absPath}.cw-export~`;
        writeFileSync(tmp, md);
        renameSync(tmp, absPath);
        // The export just changed the answer the preread carried, and a
        // preread saying "not there" would leave the attach unbound and the
        // poll unarmed. Drop it: the path has answered a write, so the
        // attach's own read is not the syscall this guard exists for.
        attachOpts = { ...opts, preread: undefined };
      } catch (err) {
        console.error(`[rooms] ${docId}: could not export doc to its home ${absPath}:`, err);
      }
    }
    // attachFile only records sourceUrl when absent; a retarget must repoint.
    room.meta.sourceUrl = absPath;
    this.attachFile(docId, absPath, attachOpts);
    this.p.schedulePersist(room);
    console.log(`[rooms] ${docId}: home binding now at ${absPath}`);
  }

  /**
   * A home-pinned doc with NO binding tries to re-place its home. The state
   * exists when hydration found no checkout on the home branch: parking
   * there leaves nothing in `fileBindings`, and every recovery path below
   * this one — homeGuard, the poll sweep — hangs off a binding. Without this
   * hook the park message's promise ("check the branch out and the next
   * edit or reparse resumes syncing") held only for docs parked while LIVE;
   * a doc parked at hydrate stayed parked until a re-pin or restart. Called
   * from the room's update hook (throttled) and from reparseFromDisk
   * (forced). Bound docs return immediately — homeGuard owns them.
   */
  maybeRebindHome(room: DocRoom, opts?: { force?: boolean }): void {
    const home = room.meta.docHome;
    if (!home || this.bindings.has(room.docId)) return;
    if (isHubOwnedRoom(room.docId) || contentKind(room.meta.type) !== 'prose') return;
    const now = Date.now();
    if (!opts?.force && now - (this.homeRebindAttemptAt.get(room.docId) ?? 0) < 1000) return;
    this.homeRebindAttemptAt.set(room.docId, now);
    const placement = resolveHomeCheckout(home);
    if (!placement.placed) return;
    // Persist BEFORE attaching so the .ydoc the attach's at-rest arbitration
    // reads (diskNewerThanState) holds the current state, not the pre-edit
    // one. When the trigger is the edit itself that arbitration is not
    // trusted at all: the live doc is the newer side by construction, and
    // `liveWins` says so instead of letting a clock tie decide (see
    // `AttachOpts`). A forced rebind (reparse) is the caller declaring disk
    // the winner, and the reparse that follows reads disk in regardless.
    this.p.persistNow(room);
    this.retargetHomeBinding(room, placement.absPath, { liveWins: !opts?.force });
  }

  /**
   * The per-sync-direction gate for home-pinned docs, run before a flush
   * writes AND before a disk change is applied. Cheap (a handful of stat +
   * plumbing-file reads, no subprocess), because it has to run every time:
   * verifying only occasionally is how a triage doc once landed on another
   * session's feature branch — the checkout under the path had switched and
   * both directions kept treating its file as the doc's.
   *
   * 'ok'         the bound path is still the home; proceed.
   * 'retargeted' the home resolves elsewhere now; the binding was moved
   *              there (exporting the file if the new checkout has none)
   *              and a flush was re-armed. The caller must NOT touch the
   *              old binding it was handed.
   * 'parked'     the home resolves nowhere; nothing was read or written,
   *              and a syncError names why and how to resume.
   */
  private homeGuard(room: DocRoom, binding: FileBinding): 'ok' | 'retargeted' | 'parked' {
    const home = room.meta.docHome;
    if (!home) return 'ok';
    if (verifyPathInHome(binding.path, home) === 'ok') return 'ok';
    const placement = resolveHomeCheckout(home);
    if (placement.placed) {
      // Resolution landing on the very path the verify refused (a nested
      // repo under relPath can split the two): writing there is what the
      // home declares, so treat it as placed rather than retarget-looping.
      if (placement.absPath === binding.path) return 'ok';
      this.retargetHomeBinding(room, placement.absPath);
      const next = this.bindings.get(room.docId);
      // Re-arm a flush on the NEW binding: its no-op pass is what clears the
      // pending-write bookkeeping the flush this guard interrupted was
      // carrying.
      if (next) this.scheduleFileWrite(room, next);
      return 'retargeted';
    }
    const message =
      placement.reason === 'repo-missing'
        ? `doc home is unreachable: ${home.repoRoot} is not (or no longer) a git checkout. ` +
          'Writes are parked; the live doc stays the source of truth and its content is durable ' +
          'in the workspace. Re-pin the home at a valid checkout to resume.'
        : placement.reason === 'path-escapes-checkout'
          ? `doc home is unsafe: ${home.relPath} passes through a symlink that leaves the ` +
            'checkout, so writing it would land outside the repo. Writes are parked; the live ' +
            'doc stays the source of truth. Re-pin the home at a path contained in the checkout.'
          : `doc home is unplaced: no checkout of the repo has branch "${home.branch}" checked out. ` +
            'Writes are parked; the live doc stays the source of truth and its content is durable ' +
            'in the workspace. Check the branch out in some worktree (git worktree add <path> ' +
            `"${home.branch}") and the next edit or reparse resumes syncing there.`;
    if (binding.lastSyncError?.message !== message) {
      this.recordSyncError(room, binding, message);
    }
    return 'parked';
  }

  /**
   * Watch the bound file for external edits via an mtime poll.
   *
   * We deliberately do NOT use fs.watch. A file-level fs.watch is bound to
   * the inode present at watch-creation time (kqueue on macOS, inotify on
   * Linux). Editors — and Claude Code's own Edit tool — save via
   * write-temp-then-rename, which atomically replaces the file's inode, so
   * the watch goes stale and only the FIRST external edit ever reaches the
   * live doc (deterministic repro on Bun + Node). Watching the parent
   * directory dodges the inode problem on macOS but proved unreliable under
   * Bun-on-Linux. A stat-mtime poll is immune to all of it — inode
   * replacement, platform, and runtime — and ~1s latency matches the doc's
   * existing sync contract.
   *
   * What changed on 2026-08-29: the poll is no longer an interval PER
   * binding. Arming enrols the binding in one shared sweep (`sweepFilePolls`)
   * which visits active docs every tick and idle docs on a budget. Same
   * mechanism, same immunity, a constant number of timers.
   */
  private armFileWatcher(_room: DocRoom, binding: FileBinding, preread?: PrereadFile): void {
    binding.pollArmed = false;
    // A preread already paid for the stat on the thread pool. Re-stat'ing
    // here would put the blocking syscall back on the main thread and undo
    // the whole point of hydrating off it.
    if (preread) {
      if (!preread.exists) return;
      binding.lastMtimeMs = preread.mtimeMs;
      binding.pollArmed = true;
      this.ensureFilePollTicker();
      return;
    }
    // No preread means a startup attach: every request and timer path comes
    // through `attachFileAsync`, which always brings one. Nothing is waiting
    // on the server at boot, so this stat may block — and it must stay
    // synchronous, because arming is part of what `attachFile` PROMISES its
    // caller. Making it async moved `pollArmed` a tick later and broke every
    // test that counts armed bindings straight after an attach.
    if (boundFiles.quarantined(binding.path)) return;
    if (!existsSync(binding.path)) return;
    try {
      binding.lastMtimeMs = statSync(binding.path).mtimeMs;
    } catch {}
    // Armed, but deliberately not marked as ACCESSED. Hydration re-binds
    // every bound doc at boot; if arming warmed them, the first minute of
    // every restart would put the whole corpus in the fast lane — the storm
    // this change exists to remove. It joins the idle rotation instead, and
    // the first real `get` / `getOrCreate` promotes it.
    binding.pollArmed = true;
    this.ensureFilePollTicker();
  }

  /**
   * Is somebody looking at this doc — i.e. does it belong in the fast lane,
   * stat'd on every 500ms tick rather than on the idle rotation?
   *
   * "Looking at" is one of three things, all of them pushed to us rather
   * than polled for:
   *   - a live websocket on the room (someone has the editor open),
   *   - a write-back or reconcile still inside its debounce window, or
   *   - an access within the last `FILE_POLL_ACTIVE_MS` — any `get` /
   *     `getOrCreate`, which is every REST read, every MCP edit tool, and the
   *     websocket upgrade itself.
   *
   * An IDLE binding is not unwatched — it is watched more slowly, on the
   * round-robin budget (see `IDLE_SWEEP_BUDGET`), and re-stat'd immediately
   * by `touchDoc` the moment anyone reaches for the doc. That matters
   * because a git checkout / stash / pull against a bound file nobody has
   * open must still reach the live doc: it is the documented behaviour and
   * `git-ops-vs-bound.test.ts` pins it. `reparseFromDisk` remains the
   * explicit force-pull.
   */
  private bindingIsActive(docId: string, binding: FileBinding, now: number): boolean {
    if (!binding.pollArmed) return false;
    if (binding.writeTimer || binding.readTimer) return true;
    const room = this.p.residentRoom(docId);
    if (room && room.conns.size > 0) return true;
    const touched = this.p.lastTouchedAt(docId);
    return touched !== undefined && now - touched < FILE_POLL_ACTIVE_MS;
  }

  /**
   * One stat of one bound file, and the reconcile it may schedule. Extracted
   * from the old per-binding interval body so the shared sweep and the
   * on-access edge check run byte-identical logic.
   */
  private pollBinding(docId: string, binding: FileBinding): void {
    if (!this.p.residentRoom(docId)) return;
    // One stat, and it runs on the thread pool. The sweep visits every bound
    // file, so a single path whose provider has stopped answering used to be
    // enough to park the event loop for the whole server — see slow-fs. A
    // stat still in flight is not re-issued: a stalled one never returns, and
    // re-issuing it every tick is how the overdue bound would be exhausted.
    if (binding.statInFlight) return;
    binding.statInFlight = true;
    void boundFiles
      .statMtime(binding.path)
      .then((res) => {
        if (res.status !== 'ok') return; // quarantined, busy, or never answered
        if (!res.exists) return; // the ordinary case: a deleted worktree
        this.applyPolledMtime(docId, binding, res.mtimeMs);
      })
      .finally(() => {
        binding.statInFlight = false;
      });
  }

  /**
   * The rest of `pollBinding`, once the stat has come back. Split out only so
   * the stat can be awaited; the decisions below are unchanged.
   */
  private applyPolledMtime(docId: string, binding: FileBinding, mtimeMs: number): void {
    const room = this.p.residentRoom(docId);
    if (!room) return;
    // Our own write-back is on the pool. Its rename has possibly landed and
    // its `lastMtimeMs` certainly has not — that is recorded in the callback
    // — so the mtime in hand can be OUR bytes reading as an external edit,
    // and the conflict arm would back up the user's own document as if a
    // stranger had written it. The write's callback records the mtime it
    // ended up with, and the next sweep then sees no change at all.
    if (binding.writeInFlight) return;
    if (this.bindings.get(docId) !== binding) return;
    if (mtimeMs === binding.lastMtimeMs) return;
    // A reconcile for this exact mtime is already on the debounce; re-arming
    // it on every tick would push the read further away the longer the file
    // sits changed.
    if (mtimeMs === binding.pendingMtimeMs && binding.readTimer) return;
    binding.pendingMtimeMs = mtimeMs;
    // An external write IS somebody reaching for the doc — the editor or the
    // git operation that made it is usually about to make another. Promote
    // the binding to the fast lane so the next few writes are seen in one
    // tick rather than one rotation, and let it decay like any other access.
    // `this.p.now()`, not `Date.now()`: residency runs on ONE clock, or an
    // externally edited doc ages against an epoch the policy never sees.
    this.p.noteTouched(docId, this.p.now());
    // Debounce so we don't read a half-written file mid-save.
    if (binding.readTimer) clearTimeout(binding.readTimer);
    binding.readTimer = setTimeout(() => {
      // Null it FIRST. `bindingIsActive` reads `readTimer` as "a reconcile is
      // still pending"; a handle left behind after the callback fired made
      // that permanently true, so one external edit pinned the binding in the
      // fast lane for the life of the process. `writeTimer` has always nulled
      // itself here for the same reason.
      binding.readTimer = null;
      // The read the reconcile needs also goes through the pool. This is the
      // syscall the outage actually wedged on (`openat`, not `stat`), so a
      // guarded stat above with a blocking read here would guard nothing.
      void boundFiles.read(binding.path).then((res) => {
        if (this.bindings.get(docId) !== binding) return;
        if (res.status !== 'ok') {
          // The read was refused or never answered. Forget that we spotted
          // this mtime so the next sweep tries again: committing it here
          // would make the change look already-handled and lose the external
          // edit for as long as nobody touched the file a second time.
          binding.pendingMtimeMs = undefined;
          return;
        }
        // Commit the mtime of the bytes we actually got, not the one the stat
        // reported — the file may have been written again in between, and
        // that write must still look like a change worth reading.
        binding.lastMtimeMs = res.exists ? res.mtimeMs : undefined;
        binding.pendingMtimeMs = undefined;
        this.reconcileFromDisk(room, binding, res);
      });
    }, READ_DEBOUNCE_MS);
  }

  /**
   * ONE interval for every bound file on the server, instead of one per
   * binding. The measured corpus had 4,228 bound docs; at 500ms each that was
   * thousands of stat syscalls a second, almost all of them for docs nobody
   * had open, plus 4,228 entries on the timer heap that never came off.
   */
  private ensureFilePollTicker(): void {
    if (this.pollTicker) return;
    const timer = setInterval(() => this.sweepFilePolls(), FILE_POLL_MS);
    // Don't let the poll keep the process (or a test runner) alive.
    timer.unref?.();
    this.pollTicker = timer;
  }

  /**
   * One pass over the bound files: every ACTIVE binding, plus a slice of the
   * idle ones.
   *
   * The two halves answer different questions. An active binding belongs to a
   * doc somebody is in, so it keeps the original 500ms latency. An idle one
   * belongs to a doc that is nonetheless allowed to change under us — a git
   * checkout, a branch switch, an editor save — so it must still be visited,
   * just not all of them every half-second. `idleCursor` walks the binding
   * map so each idle doc comes round in turn.
   */
  private sweepFilePolls(): void {
    const now = this.p.now();
    const idle: string[] = [];
    let armed = 0;
    for (const [docId, binding] of this.bindings) {
      if (!binding.pollArmed) continue;
      armed++;
      if (this.bindingIsActive(docId, binding, now)) this.pollBinding(docId, binding);
      else idle.push(docId);
    }
    if (armed === 0) {
      if (this.pollTicker) clearInterval(this.pollTicker);
      this.pollTicker = null;
      this.idleCursor = 0;
      return;
    }
    const take = Math.min(IDLE_SWEEP_BUDGET, idle.length);
    for (let i = 0; i < take; i++) {
      const docId = idle[(this.idleCursor + i) % idle.length];
      const binding = this.bindings.get(docId);
      if (binding) this.pollBinding(docId, binding);
    }
    this.idleCursor = idle.length === 0 ? 0 : (this.idleCursor + take) % idle.length;
  }

  /**
   * Record that somebody just reached for this doc, and — on the idle→active
   * edge — pull any external edit in before they read it.
   *
   * Called from `get` / `getOrCreate`, which every route, MCP tool and
   * websocket upgrade funnels through. The edge check is rate-limited to one
   * stat per `FILE_POLL_MS` per doc, so a burst of requests against one doc
   * costs no more syscalls than the old always-on poll did.
   */
  touchDoc(docId: string): void {
    const binding = this.bindings.get(docId);
    if (!binding?.pollArmed) {
      // Nothing to poll — but still remember the access, so a doc that is
      // bound later starts out warm rather than cold.
      this.p.noteTouched(docId, this.p.now());
      return;
    }
    const now = this.p.now();
    // Asked BEFORE the stamp moves: afterwards every touch looks active.
    const wasActive = this.bindingIsActive(docId, binding, now);
    const prev = this.p.lastTouchedAt(docId);
    this.p.noteTouched(docId, now);
    this.ensureFilePollTicker();
    if (!wasActive) this.noteActivation();
    if (prev === undefined || now - prev >= FILE_POLL_MS) this.pollBinding(docId, binding);
  }

  /** One idle -> active transition, filed under where it came from. */
  private noteActivation(): void {
    const tag = activationTag();
    const seen = this.activations.get(tag);
    if (seen !== undefined) {
      this.activations.set(tag, seen + 1);
      return;
    }
    if (this.activations.size >= ACTIVATION_TAG_CAP) {
      this.activations.set('other', (this.activations.get('other') ?? 0) + 1);
      return;
    }
    this.activations.set(tag, 1);
  }

  /**
   * Force a re-parse of the bound file into the live doc, ignoring
   * the currentSerialized match and lastWritten guards. Useful when
   * the parser itself changed (e.g. after a fix) and the on-disk
   * content would parse differently now even though its bytes are
   * unchanged.
   */
  reparseFromDisk(docId: string): { ok: boolean; error?: 'not-found' | 'no-binding' | 'missing' } {
    const room = this.p.room(docId);
    if (!room) return { ok: false, error: 'not-found' };
    this.touchDoc(room.docId);
    // PINNED diff docs have no file binding — their content is pinned to a
    // commit. Recover by re-reading the file at the target hash from the
    // repo. (Working-tree diff docs have a live binding and fall through to
    // the normal flat-text path below.)
    if (room.meta.type === 'diff' && room.meta.diffTarget) {
      const { workspaceRoot, diffTarget, relPath, diffStatus } = room.meta;
      if (!workspaceRoot || !diffTarget || !relPath) return { ok: false, error: 'no-binding' };
      if (diffStatus === 'deleted') return { ok: true };
      const text = showFile(workspaceRoot, diffTarget, relPath);
      if (text === null) return { ok: false, error: 'missing' };
      const content = room.ydoc.getText('content');
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, text);
      }, 'file-watch');
      return { ok: true };
    }
    // A pinned doc re-resolves its home before the reparse reads anything.
    // The old path's checkout may have switched branches since the binding
    // was made — an unguarded read here would pull that branch's copy
    // straight into the live doc, the exact incident homeGuard closes on
    // the poll path — and a doc parked at hydrate has no binding at all,
    // with reparse documented as one of its two recovery verbs.
    if (
      room.meta.docHome &&
      !isHubOwnedRoom(room.docId) &&
      contentKind(room.meta.type) === 'prose'
    ) {
      const bound = this.bindings.get(docId);
      if (!bound) this.maybeRebindHome(room, { force: true });
      else if (this.homeGuard(room, bound) === 'parked') return { ok: false, error: 'missing' };
    }
    const binding = this.bindings.get(docId);
    if (!binding) return { ok: false, error: 'no-binding' };
    // A path that has already refused to answer is not force-readable either
    // — this read is synchronous and would park the whole server (slow-fs).
    if (boundFiles.quarantined(binding.path)) return { ok: false, error: 'missing' };
    if (!existsSync(binding.path)) return { ok: false, error: 'missing' };
    // The caller is declaring disk the winner. A pending write-back holds a
    // PRE-reparse serialization — letting it fire would rewrite the file the
    // caller just forced ("its stale in-memory copy flushed to disk and the
    // reparse pulled that back", 2026-08-03 incident).
    if (binding.writeTimer) {
      clearTimeout(binding.writeTimer);
      binding.writeTimer = null;
    }
    let md: string;
    try {
      md = readFileSync(binding.path, 'utf8');
    } catch {
      return { ok: false, error: 'missing' };
    }
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, md);
      }, 'file-watch');
      binding.lastWritten = md;
      binding.lastSyncError = undefined;
      return { ok: true };
    }
    if (prose.parseMarkdownBlocks(md).length === 0) return { ok: false, error: 'missing' };
    const fragment = prose.getProseFragment(room.ydoc);
    room.ydoc.transact(() => {
      // Block-level diff, not delete-all + push: blocks the rewrite didn't
      // touch keep their Y.XmlText identity, so their thread anchors keep
      // resolving instead of every thread in the doc orphaning.
      prose.applyMarkdownToFragment(fragment, md);
    }, 'file-watch');
    // The diff above keys blocks by their serialized markdown, so a block
    // whose only defect is an ATTRIBUTE (a legacy string heading level, which
    // serializes to the same `## …`) is correctly seen as unchanged and kept.
    // reparse is the documented recovery tool, so repair those here — without
    // it, force-pulling a legacy doc still left its headings rendering as h1.
    prose.normalizeHeadingLevels(room.ydoc);
    // Serializer-space, not raw disk bytes — see attachFile (RC1).
    binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    binding.lastSyncError = undefined;
    return { ok: true };
  }

  /**
   * External file changed — read it, compare to what we think is
   * canonical, and apply the delta to the live doc if different.
   * Applies in one transact origin='file-watch' so the doc→disk
   * observer knows not to re-flush (which would bounce back here).
   */
  private reconcileFromDisk(
    room: DocRoom,
    binding: FileBinding,
    preread?: PrereadFile,
  ): 'in-sync' | 'catch-up' | 'apply' | 'conflict' | 'missing' {
    // The disk→doc side of the home gate. Without it, `git checkout` under a
    // pinned doc's old path rewrites the file, the poll sees an mtime change,
    // and the OTHER branch's copy gets applied into the live doc — the read
    // half of the same incident the write half guards against.
    if (this.homeGuard(room, binding) !== 'ok') return 'missing';
    let md: string;
    if (preread) {
      if (!preread.exists) return 'missing';
      md = preread.text ?? '';
    } else {
      // No preread means a SYNCHRONOUS caller — a flush guard, an explicit
      // "sync now". Those still block, so they must not touch a path that has
      // already proved it will not answer (see slow-fs). Reporting 'missing'
      // is the same answer they get for a file that has gone, and the poll
      // retries once the backoff lapses.
      if (boundFiles.quarantined(binding.path)) return 'missing';
      if (!existsSync(binding.path)) return 'missing';
      try {
        md = readFileSync(binding.path, 'utf8');
      } catch (err) {
        console.error(`[rooms] read failed for ${binding.path}:`, err);
        return 'missing';
      }
    }
    // Code and working-tree diff docs are flat text — replace the whole
    // `content` Y.Text on change. Read-only bindings can't hold live edits,
    // so 'conflict' is impossible for them; editable (writeBack) bindings
    // get the same keep-live/backup/reassert arm the prose path has — a
    // blind replace here would eat the reviewer's in-flight keystrokes.
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      const current = content.toString();
      const decision = decideReconcile({
        disk: md,
        lastWritten: binding.lastWritten,
        currentSerialized: current,
      });
      if (decision === 'in-sync') return decision;
      if (decision === 'catch-up') {
        binding.lastWritten = md;
        return decision;
      }
      if (decision === 'conflict' && binding.writeBack) {
        this.recordConflictReassert(room, binding, md);
        return decision;
      }
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, md);
      }, 'file-watch');
      binding.lastWritten = md;
      binding.lastSyncError = undefined;
      return decision;
    }
    const fragment = prose.getProseFragment(room.ydoc);
    const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
    const decision = decideReconcile({
      disk: md,
      lastWritten: binding.lastWritten,
      currentSerialized,
    });
    // Same content as last round-trip → nothing to do.
    if (decision === 'in-sync') return decision;
    // The live doc already serializes to disk (up to serializer whitespace) —
    // just catch up bookkeeping, don't touch the fragment.
    if (decision === 'catch-up') {
      binding.lastWritten = md;
      return decision;
    }
    // decideReconcile compares BYTES. A formatting-only external save
    // (format-on-save, trailing-newline fixers) changes bytes but not
    // content — without these checks it classified as 'apply' (block
    // rewrite, broken anchors) or, with un-flushed live edits, 'conflict'
    // (backup + syncError + reassert over the human's formatting). Parse
    // cost is fine here: we only get this far on a detected mtime change.
    const diskNormalized = prose.normalizeMarkdown(md);
    if (diskNormalized === currentSerialized) {
      // Formatting-variant of the live content — semantically in-sync.
      // Leave the file as the external tool wrote it.
      binding.lastWritten = currentSerialized;
      return 'in-sync';
    }
    if (decision === 'conflict') {
      if (diskNormalized === binding.lastWritten) {
        // Disk holds a formatting-variant of our LAST write — no semantic
        // external change, so the un-flushed live edits are not in
        // conflict. Re-arm the flush; the pending write carries them out.
        this.scheduleFileWrite(room, binding);
        return 'catch-up';
      }
      // An external write collided with un-flushed live edits. A blind
      // delete+push here would clobber the human's in-progress work (the bug
      // a peer reported). The editor is the runtime source of truth, so keep
      // the live edits and reassert them to disk via the debounced writer.
      // BUT the reassert overwrites the external version on disk — so back it
      // up first, or "recoverable with reparse_from_disk" is a lie (disk
      // would already hold our reassert by the time anyone reparses).
      this.recordConflictReassert(room, binding, md);
      return decision;
    }
    // decision === 'apply' — disk changed externally and the live doc is clean.
    let blocks: Y.XmlElement[];
    try {
      blocks = prose.parseMarkdownBlocks(md);
    } catch (err) {
      // A parse throw used to vanish into the setTimeout callback, leaving
      // the doc silently serving pre-edit content. Record + log instead so
      // getDoc can report WHY it's stale. The fragment is left untouched
      // (we never started the transact), so the next edit retries cleanly.
      const message = err instanceof Error ? err.message : String(err);
      this.recordSyncError(room, binding, `parse failed: ${message}`);
      console.error(`[rooms] ${room.docId}: disk→doc parse failed for ${binding.path}:`, err);
      return decision;
    }
    if (blocks.length === 0) {
      // Don't wipe to empty on a parse that produced nothing — but DON'T
      // do it silently either (the old behavior). Surface it.
      this.recordSyncError(
        room,
        binding,
        'disk content parsed to zero blocks; live doc left unchanged',
      );
      console.warn(
        `[rooms] ${room.docId}: disk→doc reconcile yielded 0 blocks from ${binding.path}; keeping prior state`,
      );
      return decision;
    }
    // Apply as a block-level diff: only blocks whose markdown actually
    // changed are replaced, so anchors on untouched blocks keep resolving.
    // Anchors inside a rewritten block still break — auto-reanchor's
    // snippet-match sweep catches that case on the next tick.
    //
    // Suggestions ride the same block-granularity rule: marks in untouched
    // blocks survive (identity preserved), but an external rewrite of a
    // block CARRYING suggestions replaces the block and its proposals are
    // dropped — accepted-and-surfaced, not silently swallowed. Snapshot the
    // pending sids so the drop can be recorded below (syncError pattern; a
    // snippet-match re-anchor sweep for suggestions is out of scope for v1).
    const sidsBefore = new Set(suggestOps.scanSuggestions(fragment).keys());
    room.ydoc.transact(() => {
      prose.applyMarkdownToFragment(fragment, md);
    }, 'file-watch');
    const sidsAfter = new Set(suggestOps.scanSuggestions(fragment).keys());
    const droppedSids = [...sidsBefore].filter((sid) => !sidsAfter.has(sid));
    // Same as reparseFromDisk: a block whose only defect is a legacy string
    // heading level serializes identically, so the diff keeps it and the
    // attribute has to be repaired separately. Idempotent and cheap.
    prose.normalizeHeadingLevels(room.ydoc);
    // Serializer-space, NOT the raw disk bytes (RC1): parse→serialize is not
    // byte-identity, so storing `md` here left `currentSerialized ≠
    // lastWritten` forever after — and the NEXT external edit was misjudged
    // a conflict and clobbered by the reassert.
    binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    if (droppedSids.length > 0) {
      // Same recoverability philosophy as the conflict backups: the reconcile
      // SUCCEEDED, but pending proposals living in a rewritten block were
      // dropped — record which, so agents/UI can report the loss instead of
      // the suggestions just vanishing. Cleared by the next clean reconcile.
      this.recordSyncError(
        room,
        binding,
        `external edit dropped pending suggestion(s): ${droppedSids.join(', ')}`,
      );
      console.warn(
        `[rooms] ${room.docId}: external edit to ${binding.path} dropped suggestion(s) ${droppedSids.join(', ')}`,
      );
    } else {
      binding.lastSyncError = undefined;
    }
    console.log(
      `[rooms] ${room.docId}: applied external edit from ${binding.path} (${blocks.length} blocks)`,
    );
    return decision;
  }

  private scheduleFileWrite(room: DocRoom, binding: FileBinding): void {
    // A pending flush makes the binding active (see `bindingIsActive`), so the
    // sweep must be running to see it — it may have stopped itself while the
    // doc was idle.
    if (binding.pollArmed) this.ensureFilePollTicker();
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = setTimeout(() => {
      binding.writeTimer = null;
      this.writeBoundFileNow(room, binding);
    }, WRITE_BACK_MS);
  }

  /** The write-back body: what the ~800ms debounce runs when it fires, and
   *  what `flush()` runs synchronously on graceful shutdown. */
  /**
   * Serialize the doc and put it on disk.
   *
   * `how` decides which thread does the writing, and the two callers want
   * opposite things. The 800ms write-back timer fires on a LIVE server
   * against every bound doc, so its write goes on the pool: `writeFileSync`
   * to a provider that has stopped answering parks the event loop exactly the
   * way the hydrate read used to. Shutdown and eviction pass `'sync'`,
   * because `flush()` is the SIGTERM durability contract — it must have the
   * bytes on disk before the process exits, and it has no way to await. On
   * the way down a blocked write delays an exit; on a live server it would
   * stop the whole thing answering.
   */
  private writeBoundFileNow(
    room: DocRoom,
    binding: FileBinding,
    how: 'pool' | 'sync' = 'pool',
  ): void {
    try {
      // Home-pinned docs re-verify the destination before every write —
      // "persistence never writes to whatever checkout happens to be
      // current". A retarget already carried this flush's content out (the
      // export) or re-armed one on the new binding; parked means the bytes
      // stay in the live doc.
      if (this.homeGuard(room, binding) !== 'ok') return;
      // Guard (RC2a): the poll has already SEEN an external change and is
      // holding it behind the read debounce. It advanced `lastMtimeMs` the
      // instant it saw the change, so the mtime guard below now compares disk
      // against disk, reports "unchanged", and we write over bytes NOBODY HAS
      // READ — no backup, no syncError, which is the one outcome the conflict
      // arm exists to prevent. Reproduced under CPU load: a `git pull` landing
      // inside the read debounce was overwritten in complete silence.
      //
      // `readTimer` is exactly "a reconcile is pending" (`bindingIsActive`
      // reads it that way), so run that reconcile now rather than racing it.
      // Its conflict arm backs the external version up and re-arms this
      // flush; `flush()` sweeps until quiescent, so a shutdown still carries
      // the live edits out.
      if (binding.readTimer) {
        clearTimeout(binding.readTimer);
        binding.readTimer = null;
        // 'in-sync' means the bytes never actually changed — an mtime touch,
        // or a formatting-variant of our own last write. This flush's content
        // still has to reach disk, so fall through instead of dropping it.
        if (this.reconcileFromDisk(room, binding) !== 'in-sync') return;
      }
      // Guard (RC2b): if disk moved since we last read or wrote it, we'd be
      // overwriting bytes we have never seen — the poll just hasn't caught
      // up yet. Reconcile first; apply/conflict decides, and the conflict
      // path both backs up the external version and re-schedules our flush.
      if (
        binding.lastMtimeMs !== undefined &&
        !boundFiles.quarantined(binding.path) &&
        existsSync(binding.path)
      ) {
        try {
          const mtimeMs = statSync(binding.path).mtimeMs;
          if (mtimeMs !== binding.lastMtimeMs) {
            binding.lastMtimeMs = mtimeMs;
            this.reconcileFromDisk(room, binding);
            return;
          }
        } catch {}
      }
      const md =
        contentKind(room.meta.type) === 'flat'
          ? room.ydoc.getText('content').toString()
          : prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
      if (md === binding.lastWritten) {
        // Nothing to write means nothing to reassert after a restart either.
        this.failedWrites.delete(room.docId);
        this.p.clearPendingFileWrite(room.docId);
        return;
      }
      // Atomic: write-temp-then-rename, so a crash mid-write can't leave
      // the user's file truncated and a concurrent reader never sees half
      // a document. (Same save pattern editors use.) Rename onto the
      // REALPATH — renaming onto a symlink would replace the link with a
      // regular file instead of writing through it (codex P2).
      if (how === 'pool') {
        // One write at a time per binding. Two pool writes racing to the same
        // path would land in whichever order the pool chose, and the loser
        // would be the newer content. Re-arm instead: the debounce that
        // brought us here will bring us back with whatever the doc says then.
        if (binding.writeInFlight) {
          this.scheduleFileWrite(room, binding);
          return;
        }
        binding.writeInFlight = true;
        const seq = (binding.writeSeq = (binding.writeSeq ?? 0) + 1);
        // `lastWritten` and the pending flag are set when the bytes LAND, not
        // here: until then the doc genuinely is unsaved, and a restart in
        // between must still reassert it.
        void boundFiles
          .write(binding.path, md)
          .then((res) => {
            if (this.bindings.get(room.docId) !== binding) return;
            // A synchronous flush ran while this write was still on the pool.
            // Both renames target the same file and the order is the pool's
            // to choose, so disk may hold either version and we cannot say
            // which. Claiming `lastWritten` here would assert bytes we did
            // not verify, and clearing the pending flag would tell the next
            // boot there is nothing to reassert. Keep the doc marked instead:
            // the `.ydoc` holds the newer content either way, and a restart
            // puts it back on disk.
            if (binding.writeSeq !== seq) {
              this.failedWrites.add(room.docId);
              return;
            }
            if (res.status !== 'ok') {
              this.failedWrites.add(room.docId);
              return;
            }
            binding.lastWritten = md;
            // Record our own write's mtime so the poll doesn't treat the
            // write-back as an external edit and schedule a redundant reconcile.
            if (res.exists) binding.lastMtimeMs = res.mtimeMs;
            this.failedWrites.delete(room.docId);
            this.p.clearPendingFileWrite(room.docId);
          })
          .finally(() => {
            // Always reached, and the flag's correctness depends on it: a
            // binding stuck `writeInFlight` would never write again and would
            // hold the poll down with it. `boundFiles.write` awaits `race`,
            // which resolves on a `Promise.race` against a deadline timer, so
            // it settles within `boundReadDeadlineMs` even when the syscall
            // underneath never returns.
            binding.writeInFlight = false;
          });
        return;
      }
      // The sync path is shutdown and eviction, and it is unbounded by
      // nature — `writeFileSync` to a provider that has stopped answering
      // never returns, which would hang the very shutdown that exists to save
      // the edit. A path already known hostile is skipped instead: the flush
      // saves nothing there either way, and the `.ydoc` is the durable record
      // the doc comes back from. It stays a failed write, so a restart
      // reasserts it once the file answers again.
      //
      // `busy` is skipped for the same reason and matters more here than at
      // shutdown, because EVICTION runs this on a live server: a doc leaving
      // memory while the pool holds unreturned threads would put a blocking
      // write on the main thread of a process that is still serving. `busy`
      // is also the state that leaves no mark on the path, so the quarantine
      // check alone cannot see it — a merely slow file reaches the sync
      // write with nothing to stop it.
      if (boundFiles.quarantined(binding.path) || boundFiles.busy()) {
        this.failedWrites.add(room.docId);
        return;
      }
      // Take the generation before writing: a pool write already on the
      // thread must not report its own bytes as the file's content once this
      // one has landed on top of them.
      binding.writeSeq = (binding.writeSeq ?? 0) + 1;
      let target = binding.path;
      try {
        target = realpathSync(binding.path);
      } catch {}
      // A LANE of its own, never the pool writer's temp path. Both can be
      // live at the same moment — SIGTERM arriving while a write-back sits on
      // the thread pool is precisely the case this branch exists for — and
      // two writers filling one temp file interleave their bytes into it,
      // which the rename then publishes as the user's document.
      const tmp = `${target}.cw-flush~`;
      writeFileSync(tmp, md);
      renameSync(tmp, target);
      binding.lastWritten = md;
      // Record our own write's mtime so the poll doesn't treat the
      // write-back as an external edit and schedule a redundant reconcile.
      try {
        binding.lastMtimeMs = statSync(binding.path).mtimeMs;
      } catch {}
      // The edit is on disk now, so a restart has nothing to repair. Note
      // this is NOT in a `finally`: a write that THREW must keep the flag,
      // because that is exactly the doc a restart still has to reassert.
      this.failedWrites.delete(room.docId);
      this.p.clearPendingFileWrite(room.docId);
    } catch (err) {
      // Sticky, because the caller cannot see this: the throw is swallowed
      // here and the write timer is already cleared, so nothing downstream
      // can tell a failed write from a finished one.
      this.failedWrites.add(room.docId);
      console.error(`[rooms] file write failed for ${binding.path}:`, err);
    }
  }

  /**
   * The conflict arm of `reconcileFromDisk`, shared by the prose and flat
   * write-back bindings so the two cannot drift apart: back the external
   * version up, record a `syncError` explaining what happened and where the
   * overwritten bytes went, log it, and re-arm the flush that reasserts the
   * live doc onto disk.
   *
   * The message names GIT when the bytes we are about to overwrite are a blob
   * this repository already holds. The mtime poll cannot distinguish
   * `git checkout` / `git stash` / `git pull` from a person saving in an
   * editor — nothing on the file says which it was — so before this, a git
   * operation against a doc with un-flushed live edits was undone a second
   * later with the operator seeing only a clean `git` exit and, if they
   * happened to look, an unexplained dirty working tree. The provenance check
   * is advisory only: it never changes which side wins.
   */
  private recordConflictReassert(room: DocRoom, binding: FileBinding, external: string): void {
    const backupPath = this.backupExternalVersion(room.docId, external);
    const gitHint = gitConflictHint(binding.path, external);
    this.recordSyncError(
      room,
      binding,
      'external file change collided with un-flushed live edits; kept live edits and reasserted them to disk. ' +
        (backupPath
          ? `The external version was saved to ${backupPath} — restore it and reparse_from_disk to make it win.`
          : 'Backup of the external version FAILED — it survives only in your editor/git history.') +
        gitHint,
      backupPath,
    );
    console.warn(
      `[rooms] ${room.docId}: disk↔doc conflict for ${binding.path}; kept live edits, reasserting to disk` +
        (backupPath ? ` (external version backed up to ${backupPath})` : '') +
        (gitHint ? ' — the overwritten bytes came from git, not an editor save' : ''),
    );
    this.scheduleFileWrite(room, binding);
  }

  /**
   * Record a sync failure on a binding AND announce it on the doc's event
   * channels as a `doc.sync_error` broadcast.
   *
   * Every `lastSyncError` write funnels through here for the same reason
   * thread changes funnel through `fireEvent`: a fifth failure mode added
   * later gets the broadcast for free rather than silently going without.
   * Before this, the error was only readable via get_doc or a later edit
   * response — surfaces the party who just LOST content (whoever ran the
   * `git stash` whose bytes now exist only in clobber-backups/, or saved in
   * an editor) never touches. Watching sessions do, so the loss is announced
   * where the watchers already are (proposed on a board ticket, 2026-08).
   */
  private recordSyncError(
    room: DocRoom,
    binding: FileBinding,
    message: string,
    backupPath?: string | null,
  ): void {
    const at = Date.now();
    binding.lastSyncError = { message, at };
    room.seq++;
    const decorate = (m: DocMeta) => this.p.decorate(m);
    this.p.broadcast(room, {
      event: 'doc.sync_error',
      docId: room.docId,
      doc: decorate(room.meta),
      path: room.meta.relPath ?? binding.path,
      ...(backupPath ? { backupPath } : {}),
      message,
      at,
      seq: room.seq,
    });
  }

  /**
   * Snapshot an external file version we are about to overwrite into
   * `<dataDir>/clobber-backups/`, so a conflict reassert is recoverable
   * instead of destructive. Returns the backup path, or null on failure —
   * never throws (the reconcile must proceed either way).
   */
  private backupExternalVersion(docId: string, content: string, label = 'external'): string | null {
    try {
      const dir = join(this.p.dataDir(), 'clobber-backups');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const safeId = docId.replace(/[^A-Za-z0-9._-]/g, '_');
      const file = join(dir, `${safeId}-${label}-${Date.now()}.md`);
      writeFileSync(file, content);
      return file;
    } catch (err) {
      console.error(`[rooms] clobber backup failed for ${docId}:`, err);
      return null;
    }
  }

  /**
   * Is the bound .md at least as new as the persisted .ydoc? Decides who wins
   * a no-bookkeeping attach (post-restart): the .ydoc's mtime marks the live
   * doc's last change, so an older .md means the crash beat the write-back
   * debounce and disk is the STALE side. Errs toward disk (the documented
   * source of truth at rest) when either stat fails.
   */
  /**
   * Is the bound file at least as new as the persisted `.ydoc`?
   *
   * `knownMtimeMs` is the preread's, and passing it is what keeps this off
   * the main thread: the caller has already paid for that stat on the pool,
   * and re-taking it here used to put a blocking syscall back on the hostile
   * path even when the read had been prewarmed. The `.ydoc` is server-owned
   * local state and never on a sync folder, so its stat stays synchronous.
   */
  private diskNewerThanState(docId: string, filePath: string, knownMtimeMs?: number): boolean {
    try {
      const ydocPath = this.p.ydocPath(docId);
      if (!existsSync(ydocPath)) return true;
      const stateMtime = statSync(ydocPath).mtimeMs;
      if (knownMtimeMs !== undefined) return knownMtimeMs >= stateMtime;
      if (boundFiles.quarantined(filePath)) return true;
      return statSync(filePath).mtimeMs >= stateMtime;
    } catch {
      return true;
    }
  }

  /**
   * Run a disk→doc reconcile for a bound doc right now (instead of waiting
   * for the mtime poll) and report the decision. Used by tests to pin the
   * reconcile policy without timing races, and available to routes for an
   * explicit "sync now".
   */
  reconcileNow(
    docId: string,
  ): 'in-sync' | 'catch-up' | 'apply' | 'conflict' | 'no-binding' | 'missing' {
    const room = this.p.room(docId);
    // Every keyed lookup below takes the RESOLVED id: `docId` may be an
    // alias, which resolves to a room but keys no binding and no clock.
    const binding = room ? this.bindings.get(room.docId) : undefined;
    if (!room || !binding) return 'no-binding';
    this.touchDoc(room.docId);
    if (boundFiles.quarantined(binding.path)) return 'missing';
    if (!existsSync(binding.path)) return 'missing';
    // Advance the poll baseline the same way the poll itself would, so this
    // manual reconcile doesn't get replayed on the next tick.
    try {
      binding.lastMtimeMs = statSync(binding.path).mtimeMs;
    } catch {}
    if (binding.readTimer) {
      clearTimeout(binding.readTimer);
      binding.readTimer = null;
    }
    return this.reconcileFromDisk(room, binding);
  }

  /** The doc's pending sync trouble, if any — conflicts, parse failures. */
  getSyncError(docId: string): { message: string; at: number } | undefined {
    return this.bindings.get(docId)?.lastSyncError;
  }

  /**
   * Bound documents whose write-back flush has been scheduled and has not
   * fired yet — i.e. the live doc holds edits that disk does not.
   *
   * This is the window in which an external write to the same file LOSES:
   * the poll classifies it as a conflict, the live doc wins, and the file is
   * reasserted ~800ms later. A `git pull` is such a write, so a deploy asks
   * this before it fast-forwards anything.
   *
   * `root` limits the answer to files under one directory, because the
   * question is only ever about the tree that is about to be rewritten — a
   * document bound from some other repo has no bearing on it. Containment
   * goes through `isWithinRoot`, which realpaths both sides: this machine
   * reaches the same home directory through two paths, and a lexical prefix
   * test answers no for half of them.
   *
   * One consequence of `isWithinRoot` answering closed: a binding whose file
   * has been deleted is not reported. That is the right way round — the
   * caller uses this to decide whether to refuse, and a missing file is not
   * a reason to block a deploy.
   */
  pendingFileWrites(root?: string): { docId: string; path: string }[] {
    const out: { docId: string; path: string }[] = [];
    for (const [docId, binding] of this.bindings) {
      if (!binding.writeTimer && !binding.writeInFlight) continue;
      if (root !== undefined && !isWithinRoot(root, binding.path)) continue;
      out.push({ docId, path: binding.path });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // What the room lifecycle asks the bindings. Each of these replaces a
  // reach into the binding map from `rooms.ts`; the map itself never leaves
  // this file.
  // ---------------------------------------------------------------------

  /** Is this doc file-backed right now? */
  has(docId: string): boolean {
    return this.bindings.has(docId);
  }

  /** The file this doc is bound to, if any. */
  pathOf(docId: string): string | undefined {
    return this.bindings.get(docId)?.path;
  }

  /** The binding as a doc-status surface sees it: bound where, wedged how.
   *  A read-only view, so a status route cannot reach a live timer. */
  describe(
    docId: string,
  ): { path: string; syncError?: { message: string; at: number } } | undefined {
    const binding = this.bindings.get(docId);
    if (!binding) return undefined;
    return {
      path: binding.path,
      ...(binding.lastSyncError ? { syncError: binding.lastSyncError } : {}),
    };
  }

  /**
   * A write-back is outstanding — the live doc holds edits disk does not.
   * What `pendingFileWrite` on the index row records.
   *
   * A write on the thread pool counts. It has no timer (the timer is what
   * started it) and it has not landed, so answering "no" here is how a doc
   * mid-write became invisible to the shutdown sweep, to the deploy's
   * refusal check, and to the eviction guard, all at once.
   */
  hasPendingWrite(docId: string): boolean {
    const binding = this.bindings.get(docId);
    if (!binding) return false;
    return binding.writeTimer != null || binding.writeInFlight === true;
  }

  /** The last write-back threw; a restart still has to reassert this doc. */
  hasFailedWrite(docId: string): boolean {
    return this.failedWrites.has(docId);
  }

  /** The marker's job is done — the index row carries it now. */
  forgetFailedWrite(docId: string): void {
    this.failedWrites.delete(docId);
  }

  /** Docs with an armed write-back, for `flush()`'s sweep-until-quiescent. */
  pendingWriteDocIds(): string[] {
    const out: string[] = [];
    for (const [docId, binding] of this.bindings) {
      if (binding.writeTimer || binding.writeInFlight) out.push(docId);
    }
    return out;
  }

  /**
   * Run one doc's armed write-back NOW instead of waiting out the debounce —
   * the shutdown path. The timer is cleared whether or not the room is still
   * in memory: a timer left armed on an evicted room fires into nothing.
   */
  flushWrite(docId: string, room: DocRoom | undefined): void {
    const binding = this.bindings.get(docId);
    // An armed timer OR a write already on the pool. The second is the one
    // that used to be skipped: `flush()` has no way to await it, so the only
    // way to keep the SIGTERM contract is to write the current content
    // synchronously here and let the generation counter sort out what the
    // pool write may claim afterwards.
    if (!binding || (!binding.writeTimer && !binding.writeInFlight)) return;
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = null;
    if (room) this.writeBoundFileNow(room, binding, 'sync');
  }

  /**
   * The eviction flush: same order and same calls as `flush()`, so a doc
   * leaving memory is saved exactly the way a shutdown saves it. A throw is
   * loud and does NOT stop the eviction — the `.ydoc` is the durable record,
   * and refusing to evict here would pin a wedged doc in memory forever.
   */
  flushWriteBeforeEvict(room: DocRoom): void {
    const binding = this.bindings.get(room.docId);
    if (!binding || (!binding.writeTimer && !binding.writeInFlight)) return;
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = null;
    try {
      this.writeBoundFileNow(room, binding, 'sync');
    } catch (err) {
      console.error(`[rooms] evict ${room.docId}: write-back failed:`, err);
    }
  }

  /**
   * Let go of a doc's file: cancel both debounces, take it out of the shared
   * sweep, and drop the binding. Clearing `lastMtimeMs` with it is the
   * write-loss guard — a stale `lastWritten` should not be reachable at all.
   * A no-op for a doc that was never bound.
   */
  discard(docId: string): void {
    const binding = this.bindings.get(docId);
    if (!binding) return;
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = null;
    if (binding.readTimer) clearTimeout(binding.readTimer);
    binding.readTimer = null;
    binding.pollArmed = false;
    this.bindings.delete(docId);
  }

  /** Stop the shared mtime sweep — part of `Rooms.stop()`. */
  stopPolling(): void {
    if (this.pollTicker) clearInterval(this.pollTicker);
    this.pollTicker = null;
  }

  /**
   * What `Rooms.stats()` reports about the bindings: how many exist, how many
   * the sweep would stat on this tick, how many debounce timers they hold,
   * and who has been promoting them into the fast lane.
   */
  stats(now: number): {
    count: number;
    active: number;
    timers: number;
    /** The shared mtime sweep's own interval: 1 while it is running, else 0. */
    tickers: number;
    activations: { tag: string; count: number }[];
    activationsTotal: number;
  } {
    let active = 0;
    let timers = 0;
    for (const [docId, binding] of this.bindings) {
      if (this.bindingIsActive(docId, binding, now)) active++;
      if (binding.writeTimer) timers++;
      if (binding.readTimer) timers++;
    }
    return {
      count: this.bindings.size,
      active,
      timers,
      tickers: this.pollTicker ? 1 : 0,
      activations: [...this.activations.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, ACTIVATION_TAGS_REPORTED)
        .map(([tag, count]) => ({ tag, count })),
      activationsTotal: [...this.activations.values()].reduce((a, b) => a + b, 0),
    };
  }
}
