/**
 * The master switch for external access.
 *
 * Revoking shares one at a time is the wrong tool when the question is "is
 * this server safe to expose at all?" — you have to enumerate them, you can
 * still mint new ones, and there is no single thing to look at to answer "is
 * anything reachable from outside right now?". This is that single thing.
 *
 * When it is off, EVERY non-local host is refused before authentication runs:
 * a valid share link, a live Access JWT and an unexpired session cookie all
 * get the same 403. Local callers (loopback, tailnet, LAN) are untouched, so
 * the agent's own MCP tools and Bryan's browser keep working — the point is
 * to close the outside door, not to stop work.
 *
 * Two ways to set it:
 *
 *   - At runtime, persisted: `POST /api/share/enabled {enabled:false}` or the
 *     `set_sharing_enabled` MCP tool. Survives restarts, because a switch that
 *     silently flips back on after a crash is worse than no switch.
 *   - `LF_SHARING_DISABLED=1` in the environment: off AND LOCKED — the runtime
 *     call refuses with `env_locked`. That is the one to use while a security
 *     review is in flight, because it cannot be undone by anything short of
 *     editing the service definition, including by this process's own API.
 *
 * Fails closed. A `sharing.json` we cannot parse means we do not know what
 * the operator intended, and for a gate that guards external reach, "don't
 * know" has to mean "no". (Contrast Shares.load, which starts clean on a
 * corrupt registry — losing shares is recoverable; serving them when you
 * meant not to is not.)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILENAME = 'sharing.json';

export type SetResult = { ok: true; enabled: boolean } | { ok: false; error: 'env_locked' };

export interface SharingGateOptions {
  dataDir: string;
  /** True when LF_SHARING_DISABLED is set — off and not runtime-changeable. */
  envLocked?: boolean;
}

export class SharingGate {
  private readonly path: string;
  private readonly envLocked: boolean;
  private enabled: boolean;
  /** Set when the state on disk was unreadable, so callers can say WHY it's
   *  off rather than leaving the operator to guess at a silent gate. */
  readonly loadError: string | null = null;

  constructor(opts: SharingGateOptions) {
    this.path = join(opts.dataDir, FILENAME);
    this.envLocked = opts.envLocked ?? false;
    if (this.envLocked) {
      this.enabled = false;
      return;
    }
    // Absent is not corrupt: a fresh install has never been configured, and
    // its default is the behaviour everything had before this existed.
    if (!existsSync(this.path)) {
      this.enabled = true;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (typeof parsed?.enabled !== 'boolean') throw new Error('missing "enabled" boolean');
      this.enabled = parsed.enabled;
    } catch (err) {
      this.enabled = false;
      this.loadError = err instanceof Error ? err.message : 'unreadable sharing.json';
    }
  }

  /** May external (share / link) hosts be served right now? */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** True when the environment pinned this off and the API cannot reopen it. */
  isLocked(): boolean {
    return this.envLocked;
  }

  /**
   * Flip the switch and persist. Returns the resulting state, or `env_locked`
   * when LF_SHARING_DISABLED is in force — a lock the process can talk itself
   * out of is not a lock.
   */
  setEnabled(enabled: boolean): SetResult {
    if (this.envLocked) return { ok: false, error: 'env_locked' };
    this.enabled = enabled;
    writeFileSync(this.path, `${JSON.stringify({ enabled }, null, 2)}\n`);
    return { ok: true, enabled };
  }

  /** Everything a status view needs, in one object. */
  status(): { enabled: boolean; locked: boolean; loadError?: string } {
    return {
      enabled: this.enabled,
      locked: this.envLocked,
      ...(this.loadError ? { loadError: this.loadError } : {}),
    };
  }
}
