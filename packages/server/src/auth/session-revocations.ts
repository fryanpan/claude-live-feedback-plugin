/**
 * The revoked session ids — what makes a never-expiring cookie endable.
 *
 * A session cookie validates cryptographically forever (see `session.ts`);
 * logout works by writing the cookie's session id here, and the request path
 * checks membership before trusting any verified cookie. The store follows
 * the `agent-watches.ts` shape: one small JSON file in the data dir,
 * rewritten whole through write-temp-then-rename so a crash mid-write leaves
 * the previous file rather than half of one.
 *
 * **Why the file holds REVOKED ids, not active ones.** Three reasons, each
 * sufficient:
 *
 * - Validation today is purely cryptographic — no server record exists per
 *   session, and the still-valid 90-day cookies out in the world predate any
 *   file. An active-id allowlist would strand every one of them, which the
 *   migration constraint forbids; a denylist leaves anything unlisted alone.
 * - Writes track the rare event. Sessions are minted on every login AND on
 *   every device's daily sliding refresh; logout is the rare deliberate act.
 *   A denylist writes on logout only — an allowlist would turn read paths
 *   into disk writes.
 * - The list only grows by human logouts, so it stays tiny. Entries are kept
 *   forever: the sessions they name never expire, so there is no safe moment
 *   to prune one.
 *
 * **The failure mode is fail-CLOSED, healed by the watermark** (Bryan's
 * fail-closed decision plus the security review's refinement, both
 * 2026-08-28, superseding the original fails-open tradeoff). A file that
 * exists but cannot be read or parsed refuses EVERY session — `isRevoked`
 * answers true for any id, nothing writes to disk — because a revoked id
 * could be hiding in the unreadable bytes. The way out is not a human
 * editing files: the boot path ends every outstanding session through the
 * roster's `sessionsValidFrom` watermark and only then calls
 * `resetAfterWatermarkBump()`, which moves the broken file aside as
 * evidence and restarts the list empty. Everyone signs in again; nothing
 * revoked can resurrect, because nothing pre-bump validates at all.
 *
 * The file is also created eagerly on first boot, which is what makes its
 * ABSENCE meaningful afterwards: a denylist that vanishes at runtime reads
 * as failed (`failedClosed()`), never as empty. The residual gap is a file
 * deleted while the server is down — that boot is indistinguishable from a
 * data dir restored from scratch, and the watermark stays the manual big
 * hammer for it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILENAME = 'revoked-sessions.json';
const FORMAT_VERSION = 1;

interface FileShape {
  version: number;
  revoked: Record<string, { at: number }>;
}

export interface SessionRevocationsOptions {
  dataDir: string;
  now?: () => number;
}

export class SessionRevocations {
  private readonly path: string;
  private readonly now: () => number;
  private state: FileShape;
  /** Set when the file on disk exists but could not be read or parsed.
   *  Until `resetAfterWatermarkBump()`, the store fails CLOSED: every id
   *  reads as revoked and nothing is written to disk. */
  readonly loadError: string | null = null;
  /** True once the failed load has been healed — see resetAfterWatermarkBump. */
  private wasReset = false;

  constructor(opts: SessionRevocationsOptions) {
    this.path = join(opts.dataDir, FILENAME);
    this.now = opts.now ?? Date.now;
    this.state = { version: FORMAT_VERSION, revoked: {} };
    if (!existsSync(this.path)) {
      // Created eagerly so that from this moment the file's ABSENCE means
      // something: see failedClosed().
      this.save();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.revoked !== 'object') {
        throw new Error('missing "revoked" object');
      }
      for (const [sessionId, meta] of Object.entries(parsed.revoked ?? {})) {
        if (!sessionId || typeof meta !== 'object' || meta === null) continue;
        this.state.revoked[sessionId] = {
          at: typeof meta.at === 'number' ? meta.at : this.now(),
        };
      }
    } catch (err) {
      // Left exactly where it is on purpose: the file is both the evidence
      // of what went wrong and the signal that keeps the NEXT boot closed
      // too. Moving it aside would make a plain restart boot clean over an
      // empty list — the silent fail-open this store must not have. Deleting
      // or restoring it is a human decision, never a boot side effect.
      this.loadError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Whether the store must refuse every session: the file failed to load
   * (and has not been healed), or it has vanished since boot. The boot path
   * guarantees the file exists — eagerly created when absent — so absence
   * now means somebody deleted the denylist out from under a running
   * server, and serving without it could resurrect a revoked session.
   */
  failedClosed(): boolean {
    if (this.loadError !== null && !this.wasReset) return true;
    return !existsSync(this.path);
  }

  /**
   * Reopen after a failed load. Call ONLY after every outstanding session
   * has already been ended some other way — the roster's `sessionsValidFrom`
   * bump — because reopening forgets every id the unreadable file held.
   * Moves the broken file aside as evidence and restarts empty. Returns
   * false (still closed) only if the broken file cannot be moved.
   */
  resetAfterWatermarkBump(): boolean {
    if (this.loadError === null || this.wasReset) return true;
    const aside = `${this.path}.corrupt-${this.now()}`;
    try {
      renameSync(this.path, aside);
    } catch {
      return false;
    }
    this.wasReset = true;
    this.state = { version: FORMAT_VERSION, revoked: {} };
    this.save();
    return true;
  }

  /** End the session this id names. Idempotent — the first logout's
   *  timestamp is the honest one, so a repeat does not move it. */
  revoke(sessionId: string): void {
    // While failed-closed, never touch disk: a save would put a fresh
    // near-empty file where the broken (or deleted) one was, destroying the
    // evidence and silently reopening the store minus everything it forgot.
    // Nothing is lost by skipping — every session, this one included, is
    // already refused.
    if (this.failedClosed()) return;
    if (!sessionId || this.isRevoked(sessionId)) return;
    this.state.revoked[sessionId] = { at: this.now() };
    this.save();
  }

  isRevoked(sessionId: string): boolean {
    // Fail closed: with the denylist unreadable or gone, no session can
    // prove it was never revoked, so every one of them reads as revoked.
    if (this.failedClosed()) return true;
    // hasOwn, not `in`: ids come off attacker-writable cookies, and `in`
    // walks the prototype chain — "constructor" must not read as revoked.
    return Object.hasOwn(this.state.revoked, sessionId);
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
