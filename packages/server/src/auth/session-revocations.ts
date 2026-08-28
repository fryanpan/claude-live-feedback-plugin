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
 * **The failure mode is fail-CLOSED** (Bryan, 2026-08-28, superseding the
 * original fails-open tradeoff): a file that exists but cannot be read or
 * parsed refuses EVERY session — `isRevoked` answers true for any id — and
 * the broken file stays exactly where it is, untouched, so the next boot
 * refuses too. Nothing here writes while in that state; recovery is a human
 * reading the file, then restoring it or deleting it. The residual gap: a
 * file DELETED outright is indistinguishable from a first boot and loads
 * clean — for that, the roster's `sessionsValidFrom` watermark stays the
 * big hammer that ends everything an identity minted before a point in
 * time, with no file of ids involved.
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
   *  While set, the store fails CLOSED: every id reads as revoked and
   *  nothing is written to disk. */
  readonly loadError: string | null = null;

  constructor(opts: SessionRevocationsOptions) {
    this.path = join(opts.dataDir, FILENAME);
    this.now = opts.now ?? Date.now;
    this.state = { version: FORMAT_VERSION, revoked: {} };
    if (!existsSync(this.path)) return;
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

  /** End the session this id names. Idempotent — the first logout's
   *  timestamp is the honest one, so a repeat does not move it. */
  revoke(sessionId: string): void {
    // While failed-closed, never touch disk: a save would rename a fresh
    // file over the broken one, destroying the evidence and handing the next
    // boot a clean near-empty list. Nothing is lost by skipping — every
    // session, this one included, is already refused.
    if (this.loadError !== null) return;
    if (!sessionId || this.isRevoked(sessionId)) return;
    this.state.revoked[sessionId] = { at: this.now() };
    this.save();
  }

  isRevoked(sessionId: string): boolean {
    // Fail closed: with the denylist unreadable, no session can prove it was
    // never revoked, so every one of them reads as revoked.
    if (this.loadError !== null) return true;
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
